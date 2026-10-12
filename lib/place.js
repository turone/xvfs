'use strict';

const path = require('node:path');
const { fileExt } = require('metautil');
const { NotFound } = require('./tree.js');
const { PlaceRules } = require('./rules.js');

// Whether the file systems here take a name in any case — Windows', and
// macOS's by default: a disk-origin place then knows its files by their
// other spellings too (Place.spelling), its rules compare names so
// (PlaceRules), and the index of links does (links.js). A case-sensitive
// volume of either is taken for one all the same, which only puts more
// paths under a rule or behind a link, and without strict serves a
// published file in another case.
const CASELESS = process.platform === 'win32' || process.platform === 'darwin';

// The representations of a file by kind, as the tree numbers them
// (lib/tree.js): the source, then the fields of a payload's `others`.
const SOURCE = 0;
const BYTECODE = { require: 1, script: 2 };
const ENCODINGS = ['gzip', 'deflate', 'br', 'zstd'];
const COMPRESSED = { gzip: 3, deflate: 4, br: 5, zstd: 6 };
// Their names outward (diagnostics, retirements()).
const KIND_NAMES = [
  'source',
  'require:bytecode',
  'script:bytecode',
  'fs:gzip',
  'fs:deflate',
  'fs:br',
  'fs:zstd',
];

// Whether a domain's settings — null where it is off — see the file at
// `key`: its extension in the domain's `ext`, or no `ext` at all.
const sees = (settings, key) =>
  Boolean(settings) && (!settings.ext || settings.ext.includes(fileExt(key)));

// The key of a directory: '' for the place root, else a leading slash and
// none at the end ('/a/b'), whatever form the caller used.
const dirOf = (key) => {
  const trimmed = key.replace(/\/+$/, '');
  if (trimmed === '' || trimmed.startsWith('/')) return trimmed;
  return '/' + trimmed;
};

// Place — one directory under appRoot, one provider, one origin, up to
// three domains. Internal: consumers get a PlaceFs facade through
// `kernel.fs(name)`.
//
// `tree` is the place's node tree in this thread (lib/tree.js), set by the
// kernel for an indexed provider — the main thread's own for `sab` and
// `sea`, a replica of it in a worker, a tree of the thread's own for `map`
// — and null for `disk` and `node-default`, and once the kernel closes. A
// directory is a node of its own; a file's node holds its payload: the
// attributes, the source and the derived representations (bytecode,
// compressed bytes), each a Representation a reader pins.

class Place {
  // `caseless` only: the keys of the files whose lower-casing differs from
  // them, by that lower-casing — an index; keys keep their spelling.
  #spellings;
  #scope;

  // `caseless`: whether the platform's file systems take a name in any
  // case (the host's, by default). A disk-origin place then knows its
  // files by their other spellings; a virtual place is a filesystem of its
  // own, with exact keys.
  constructor(config, appRoot, caseless = CASELESS) {
    this.name = config.name;
    this.config = config;
    this.provider = config.provider;
    this.origin = config.origin;
    this.root = path.join(appRoot, config.name);
    this.tree = null;
    // The place's number in its kernel's config, from 1, set by the kernel:
    // the `dev` of its stats, the same in every thread.
    this.dev = 0;
    this.#spellings = caseless && config.origin === 'disk' ? new Map() : null;
    // The rules of its subtrees (lib/rules.js), names compared as its keys
    // are — or null: its own settings hold at every key.
    this.rules = config.rules
      ? new PlaceRules(config, this.#spellings !== null)
      : null;
    // What scopeOf() answers for every key of a place without rules.
    this.#scope = Object.freeze({ settings: config, below: false });
    // Mutation engine, set by the kernel: MapStore (map places, also the
    // publication sink of a map+disk scan), SabStore (main thread,
    // sab+virtual) or RemoteStore (worker, sab+virtual). Null when writes
    // go to disk or the place is read-only.
    this.store = null;
    // Preparer callbacks of this thread, Map<ext, fn>, bound by the kernel:
    // all the place names on the main thread, those given to
    // attach({ preparers }) in a worker (local Map writes only).
    this.preparers = null;
    // Preparations of this place that failed in this thread (diagnostics).
    this.preparationFailures = 0;
  }

  // Content is created by the application; nothing backs it on disk.
  get virtual() {
    return this.origin === 'virtual';
  }

  // The kernel fills the place from its directory: a scan at init, the
  // watcher after it.
  get scanned() {
    return this.origin === 'disk';
  }

  // Whether the place knows its files by their other spellings too: a
  // disk-origin place on a case-insensitive platform.
  get caseless() {
    return this.#spellings !== null;
  }

  // --- The tree ---

  // The node at `key` — '' or '/' the root, a key with its leading slash or
  // the legacy form without it — or null.
  node(key) {
    const { tree } = this;
    if (tree === null || typeof key !== 'string') return null;
    if (key !== '' && key.charCodeAt(0) !== 47) return tree.get('/' + key);
    return tree.get(key);
  }

  // What a walk along `key` finds, keyed as for node(): the node, or the
  // one its path broke off at (Tree.match: NotFound { node, rest }) —
  // null without a tree.
  match(key) {
    const { tree } = this;
    if (tree === null || typeof key !== 'string') return null;
    if (key !== '' && key.charCodeAt(0) !== 47) return tree.match('/' + key);
    return tree.match(key);
  }

  // The payload of the file at `key`, or null: a directory, or nothing.
  file(key) {
    const node = this.node(key);
    if (node === null || this.tree.isDirectory(node)) return null;
    return this.tree.payloadOf(node);
  }

  // The node of the directory `key` names (dirOf), or null.
  directory(key) {
    const node = this.node(dirOf(key));
    return node !== null && this.tree.isDirectory(node) ? node : null;
  }

  isDirectory(key) {
    return this.directory(key) !== null;
  }

  // Whether a walk broke off (match(): NotFound) below a file the fs
  // domain sees — the node its path broke off at: no file and no
  // directory can be there, ENOTDIR, as node:fs answers a path through a
  // file. A file the domain does not see tells nothing.
  brokeAtFile(found) {
    if (!(found instanceof NotFound) || found.node === null) return false;
    const { tree } = this;
    if (tree.isDirectory(found.node)) return false;
    return this.visible('fs', tree.pathOf(found.node));
  }

  // Whether `key` lies below a file the fs domain sees (brokeAtFile).
  throughFile(key) {
    if (typeof key !== 'string' || key === '') return false;
    return this.brokeAtFile(this.match(key));
  }

  // Canonical form of a key that resolved through node().
  keyOf(key) {
    return key.charCodeAt(0) === 47 ? key : '/' + key;
  }

  // The V8 cached data of a source for a bytecode flavor, as a view, or
  // null.
  bytecode(key, domain = 'require') {
    const others = this.file(key)?.others;
    if (!others) return null;
    const rep =
      domain === 'require' ? others.requireBytecode : others.scriptBytecode;
    return rep === null ? null : rep.data;
  }

  // The Representation of a source's compressed bytes, or null.
  compressed(key, encoding) {
    const others = this.file(key)?.others;
    return others ? (others[encoding] ?? null) : null;
  }

  // True iff a source key gets the cached data of a bytecode flavor: its
  // extension is in `require.compile` ('require') or `fs.script.compile`
  // ('script').
  compiles(flavor, key) {
    const { require: req, fs } = this.config;
    const domain = flavor === 'require' ? req : fs?.script;
    if (!domain) return false;
    return domain.compile.includes(fileExt(key));
  }

  // True iff the place keeps compressed representations of a source key
  // (fs.compress): visible to its fs domain and, when `compress.ext` is
  // set, of one of its extensions. What the place publishes is the
  // place's: no rule changes it.
  compressible(key) {
    const compress = this.config.fs?.compress;
    if (!compress || !sees(this.config.fs, key)) return false;
    return !compress.ext || compress.ext.includes(fileExt(key));
  }

  // The settings in force at `key` while the place serves it — { fs,
  // require, import }, each null where the domain is off: its own, or what
  // its rules put there (PlaceRules).
  settingsAt(key) {
    return this.rules === null ? this.config : this.rules.at(key);
  }

  // The settings at `key` and whether a rule of the place lies below it —
  // where none does, every key below has those settings too
  // (PlaceRules.scope).
  scopeOf(key) {
    return this.rules === null ? this.#scope : this.rules.scope(key);
  }

  // True iff a source key is visible to `domain` where it lies: the domain
  // on there, the key's extension in its `ext`.
  visible(domain, key) {
    return sees(this.settingsAt(key)[domain], key);
  }

  // True iff the place takes writes at `key`: its fs domain on there and
  // writable.
  writableAt(key) {
    return Boolean(this.settingsAt(key).fs?.writable);
  }

  // Why a recursive mkdir of `key` may not make a directory it lacks above
  // `key` — one its rules hide (EACCES) or forbid writes in (EROFS) — or
  // null; `exists(dir)` says which it lacks. The rules alone are asked:
  // a directory there already is no write.
  makesParents(key, exists) {
    if (this.rules === null) return null;
    for (
      let at = key.indexOf('/', 1);
      at !== -1;
      at = key.indexOf('/', at + 1)
    ) {
      const dir = key.slice(0, at);
      const { fs } = this.rules.at(dir);
      if (fs?.writable || exists(dir)) continue;
      return fs === null ? 'EACCES' : 'EROFS';
    }
    return null;
  }

  // Why an operation on the whole subtree at `key` — a recursive removal,
  // a move of a directory — would act past a rule below it, or null
  // (PlaceRules.below): EACCES, EROFS.
  rulesBelow(key) {
    return this.rules === null ? null : this.rules.below(key);
  }

  // The file held in memory that a key the tree misses names in another
  // case, or null. Both lower-case alike — which equates whatever a
  // case-insensitive file system does, and a little more; the place holds
  // one spelling of a name, as such a disk does. A key that is lower-case
  // already, where no file has capitals, costs one lookup. A disk-backed
  // file is read from disk by the name given, so its other spellings stay
  // what the disk answers for them.
  spelling(key) {
    const spellings = this.#spellings;
    if (spellings === null) return null;
    const lower = key.toLowerCase();
    let same = null;
    if (lower !== key && this.file(lower) !== null) same = lower;
    else if (spellings.size > 0) same = spellings.get(lower) ?? null;
    if (same === null) return null;
    return this.file(same)?.source ? same : null;
  }

  // The files a commit created, removed and moved, by key, as a thread
  // learns them — the index of spellings follows. Moves never reach a
  // disk-origin place, whose watcher publishes what the disk holds; one is
  // followed all the same, a directory's files with it.
  spelled(created, removed, moved) {
    const spellings = this.#spellings;
    if (spellings === null) return;
    for (const key of removed) this.#unspell(key);
    for (const [from, to] of moved) {
      const below = from + '/';
      for (const key of [...spellings.values()]) {
        if (key !== from && !key.startsWith(below)) continue;
        this.#unspell(key);
        this.#spell(to + key.slice(from.length));
      }
    }
    for (const key of created) this.#spell(key);
  }

  #spell(key) {
    const lower = key.toLowerCase();
    if (lower !== key) this.#spellings.set(lower, key);
  }

  #unspell(key) {
    const lower = key.toLowerCase();
    if (this.#spellings.get(lower) === key) this.#spellings.delete(lower);
  }

  // True iff the place caches files of this key's extension (its scan
  // filter). The rest is disk territory, which a place with
  // `fs.fallback: 'disk'` serves from disk.
  cached(key) {
    const { scanExt } = this.config;
    return !scanExt || scanExt.includes(fileExt(key));
  }

  // True iff the fs.script pipeline applies to a source key.
  scripted(key) {
    const script = this.config.fs?.script;
    if (!script) return false;
    return script.ext.includes(fileExt(key));
  }

  // Name of the preparer that owns the content of a source key, or null.
  // Its raw input is not retained, so appends and moves cannot be honoured.
  prepared(key) {
    const { prepare } = this.config;
    if (!prepare) return null;
    const ext = fileExt(key);
    return Object.hasOwn(prepare, ext) ? prepare[ext] : null;
  }

  // The preparer callback for a source key in this thread, or null.
  preparerOf(key) {
    if (!this.preparers) return null;
    return this.preparers.get(fileExt(key)) || null;
  }

  // Absolute OS path of a key ('' or '/' is the place directory itself).
  pathOf(key) {
    if (key === '' || key === '/') return this.root;
    return path.join(this.root, key);
  }
}

// Canonical source key for mutations: a leading '/', then names — no
// empty, '.' or '..' segment, no NUL, forward slashes only; the leading
// slash is all it adds. Throws on anything else: such a key names nothing a
// path can reach.
const canonicalKey = (key) => {
  const invalid = () => new TypeError(`invalid key: ${JSON.stringify(key)}`);
  if (typeof key !== 'string') throw invalid();
  if (key.includes('\u0000') || key.includes('\\')) throw invalid();
  const canonical = key.startsWith('/') ? key : '/' + key;
  for (const name of canonical.slice(1).split('/')) {
    if (name === '' || name === '.' || name === '..') throw invalid();
  }
  return canonical;
};

module.exports = {
  Place,
  canonicalKey,
  dirOf,
  SOURCE,
  BYTECODE,
  ENCODINGS,
  COMPRESSED,
  KIND_NAMES,
  CASELESS,
  sees,
};
