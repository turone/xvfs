'use strict';

// The node tree of a place (doc/architecture.md, "Node trees"): the main
// thread's tree
// takes commits, replicas in workers follow it by snapshot and deltas. An
// id tree may have several languages: the main one, index 0, makes the
// structure; a node's name and payload in another are its translation
// there, and a lookup there walks the children by those names.
//
// A commit is planned first (lib/tree-plan.js) against the tree as it is
// and an overlay of its own ops: every check passes or the commit throws
// with nothing changed. What passes is a log of primitive steps — create,
// attach, detach, kill, set a payload, a class, a policy, relocate — and
// the log is the delta: main applies it to itself with the very code a
// replica applies it with, so the two cannot drift apart. The steps are the
// points where the structure changes; the aggregates and the tree's numbers
// follow them there and nowhere else. Lookups walk: there is no cache of
// them to keep right.

const path = require('node:path');
const {
  SMALL,
  KINDS,
  PAGE_KINDS,
  MAX_LANGUAGES,
  OTHERS,
  column,
  Columns,
  I32,
  U8,
  NUM,
  Rep,
  Others,
  Extras,
  frozen,
  Payload,
  BirthPayload,
  Translation,
  kidsClass,
  nodeClass,
  repOf,
  primers,
} = require('./tree-node.js');
const {
  NEW,
  ATTACH,
  ROOT,
  DETACH,
  KILL,
  PAYLOAD,
  UNPUBLISH,
  CLASS,
  POLICY,
  RELOCATE,
  LNAME,
  LDROP,
  LPAYLOAD,
  LUNPUBLISH,
  LRELOCATE,
  RENDER,
  DIR,
  refusal,
  isClass,
  PayloadColumns,
  Log,
  FsPlan,
  IdPlan,
} = require('./tree-plan.js');

const MAX_ENTRIES = 2 ** 24; // as many as a V8 Map holds

// The tree's mark: unique in the process — random across threads, counted
// within one.
const MARK_BASE = Math.floor(Math.random() * 2 ** 20) * 2 ** 32;
let marks = 0;

const invalid = (message) => refusal('EINVAL', -1, message);
const stale = () =>
  refusal('ESTALE', -1, 'the structure changed under the iterator');

// A node whose policy refused: `decision` is what allow answered.
class Denied {
  constructor(node, decision) {
    this.node = node;
    this.decision = decision;
  }
}

// A miss of match(): the deepest node on the path and the rest of the key
// from the first missing name, with its leading '/'.
class NotFound {
  constructor(node, rest) {
    this.node = node;
    this.rest = rest;
  }
}

// Whether a commit or a load is asked for what it did to its nodes:
// `options` nothing, or `{ changes: boolean }`.
const changesOf = (options) => {
  if (options === undefined) return false;
  if (options === null || typeof options !== 'object') {
    throw invalid('options: an object');
  }
  const { changes = false } = options;
  if (typeof changes !== 'boolean') throw invalid('options.changes: a boolean');
  return changes;
};

const noChanges = () => ({ created: [], changed: [], moved: [], removed: [] });

// --- Columns ----------------------------------------------------------------

// A value of a column: one in the range of a small integer read from a
// Float64Array is made one, so that its field does not hold a boxed double.
const at = (col, i) => {
  const v = col[i];
  return typeof v === 'number' && v >= -SMALL && v < SMALL ? v | 0 : v;
};

// Strings of the tree's own: never slices of the caller's, which keep their
// whole parents alive. One JSON round trip copies the names of a commit.
const ownAll = (list) =>
  list.length === 0 ? list : JSON.parse(JSON.stringify(list));

// A short digest of a text, for the mark of the format (53 bits of cyrb53).
const digest = (text) => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
};

const bump = (counts, cls, n) => {
  for (let i = 0; i < counts.length; i += 2) {
    if (counts[i] === cls) {
      counts[i + 1] += n;
      return;
    }
  }
  counts.push(cls, n);
};

// --- Options ----------------------------------------------------------------

const isFlag = (value) => value === undefined || typeof value === 'boolean';

const containersOf = (list) => {
  if (!Array.isArray(list) || !list.every(isClass)) {
    throw invalid('containers: an array of classes');
  }
  if (new Set(list).size !== list.length) {
    throw invalid('containers: each class once');
  }
  return [...list];
};

const WALK_MODES = { include: 0, skip: 1, only: 2 };

// --- The tree ---------------------------------------------------------------

class Tree {
  // The objects that keep every numeric field tagged (see primers()):
  // held here, as long as the class lives, and read by no one.
  static primers = primers();

  // The mark of this copy of the encoding, the same in every thread that
  // loads this copy: the format's version, and a digest of the code that
  // writes and reads snapshots and deltas and of where it was loaded from
  // — another copy, or other code at the same path, makes another mark.
  // No mark of one module instance can serve: every worker loads its own
  // instance and takes main's snapshots. The path stays out of snapshots.
  static #format = `xvfs-tree/1 ${digest(
    [__filename, Tree, PayloadColumns, Log, column, at].join('\n'),
  )}`;

  #main;
  #mark;
  #fs;
  #mode;
  #sep;
  #segments;
  #directories;
  #birthtime;
  #classes; // the class counters
  #versions; // the subtree versions
  #languages;
  #maxNodes;
  #retireIds;
  #ids = { next: 1, wrapped: false }; // the main FS tree's counter
  #Node;
  #Kids;
  #containers; // Set<class>
  #containerList;
  #root = null;
  #byId = new Map();
  #version = 0;
  #structureVersion = 0;
  #policyVersion = 0;
  #revision = 0;
  #epoch = 0; // +1 with every change of structure: the iterators' mark

  constructor(config) {
    this.#main = config.main;
    this.#mark = config.mark;
    this.#mode = config.mode;
    this.#fs = config.mode === 'engine';
    this.#sep = config.sep;
    this.#segments = config.segments;
    this.#directories = config.directories;
    this.#birthtime = config.birthtime;
    this.#classes = config.classes;
    this.#versions = config.versions;
    this.#languages = config.languages;
    this.#maxNodes = config.maxNodes;
    this.#retireIds = config.retireIds;
    this.#Node = nodeClass(!this.#fs, this.#versions, this.#languages);
    this.#Kids = kidsClass(this.#classes, this.#languages);
    this.#containerList = this.#fs ? [DIR] : config.containers;
    this.#containers = new Set(this.#containerList);
  }

  static create(options = {}) {
    if (options === null || typeof options !== 'object') {
      throw invalid('options');
    }
    const mode = options.ids ?? 'engine';
    if (mode !== 'engine' && mode !== 'number' && mode !== 'string') {
      throw invalid(`ids: ${mode}`);
    }
    const fs = mode === 'engine';
    const { directories, birthtime, aggregates = {}, retireIds } = options;
    if (!isFlag(directories) || !isFlag(birthtime)) throw invalid('flags');
    if (directories === true && !fs) {
      throw invalid('directory attributes in an id tree');
    }
    if (aggregates === null || typeof aggregates !== 'object') {
      throw invalid('aggregates');
    }
    if (!isFlag(aggregates.classes) || !isFlag(aggregates.subtreeVersion)) {
      throw invalid('aggregates');
    }
    let containers = [];
    const rule = options.containers;
    if (fs) {
      const fixed = Array.isArray(rule) && rule.length === 1 && rule[0] === DIR;
      if (rule !== undefined && !fixed) {
        throw invalid('an FS tree has its own rule of containers');
      }
    } else if (rule !== undefined) {
      containers = containersOf(rule);
    }
    const languages = options.languages ?? 1;
    if (fs && options.languages !== undefined) {
      throw invalid('languages in an FS tree');
    }
    const counted = Number.isInteger(languages) && languages >= 1;
    if (!counted || languages > MAX_LANGUAGES) {
      throw invalid(`languages: from 1 to ${MAX_LANGUAGES}`);
    }
    const sep = options.sep ?? path.sep;
    if (sep !== '/' && sep !== '\\') throw invalid(`sep: ${sep}`);
    const segments = options.segments ?? new Map();
    if (!(segments instanceof Map)) throw invalid('segments: a Map');
    const maxNodes = options.maxNodes ?? MAX_ENTRIES;
    const bound = Number.isInteger(maxNodes) && maxNodes >= 1;
    if (!bound || maxNodes > MAX_ENTRIES) throw invalid('maxNodes');
    const now = options.now ?? 0;
    if (typeof now !== 'number' || !Number.isFinite(now)) throw invalid('now');
    if (retireIds === null || typeof retireIds?.next !== 'function') {
      throw invalid('retireIds: { next() }');
    }
    const tree = new Tree({
      main: true,
      mark: MARK_BASE + ++marks,
      mode,
      sep,
      segments,
      containers,
      directories: directories === true,
      birthtime: birthtime === true,
      classes: aggregates.classes === true,
      versions: aggregates.subtreeVersion === true,
      languages,
      maxNodes,
      retireIds,
    });
    if (fs) tree.#plant(now);
    return tree;
  }

  // An FS tree's root: the directory with id 0, attributes from `now`.
  #plant(now) {
    const root = new this.#Node(0, DIR);
    root.name = '';
    if (this.#directories) root.payload = this.#dirPayload(0, now, now);
    this.#root = root;
    this.#byId.set(0, root);
  }

  static fromSnapshot(snapshot, segments) {
    if (
      snapshot === null ||
      typeof snapshot !== 'object' ||
      snapshot.format !== Tree.#format
    ) {
      throw invalid('not a snapshot of this engine');
    }
    if (!(segments instanceof Map)) throw invalid('segments: a Map');
    const s = snapshot;
    const tree = new Tree({
      main: false,
      mark: s.mark,
      mode: s.ids,
      sep: s.sep,
      segments,
      containers: [...s.containers],
      directories: s.directories,
      birthtime: s.birthtime,
      classes: s.classes,
      versions: s.versions,
      languages: s.languages,
      maxNodes: s.maxNodes,
      retireIds: null,
    });
    tree.#revision = s.revision;
    tree.#version = s.version;
    tree.#structureVersion = s.structureVersion;
    tree.#policyVersion = s.policyVersion;
    tree.#grow(s);
    return tree;
  }

  // --- The numbers --------------------------------------------------------

  get version() {
    return this.#version;
  }

  get structureVersion() {
    return this.#structureVersion;
  }

  get policyVersion() {
    return this.#policyVersion;
  }

  get languages() {
    return this.#languages;
  }

  // The reading rule: which classes are containers. In this thread only,
  // without a commit; an FS tree's is fixed.
  get containers() {
    return [...this.#containerList];
  }

  set containers(list) {
    if (this.#fs) throw invalid('an FS tree has its own rule of containers');
    this.#containerList = containersOf(list);
    this.#containers = new Set(this.#containerList);
  }

  // --- Lookups ------------------------------------------------------------

  // There is no cache of lookups (doc/architecture.md, "Node trees"): a
  // lookup is the walk, a Map of
  // children a level. A cache saved ~0.1 µs on a hit, lost to the walk with
  // more keys than its bound, and needed its entries dropped at every change
  // of structure — the most fragile code of both engines of step A.
  // `lang`: the index of a language but the main one, to look up by the
  // names there.
  get(key, options, lang) {
    if (lang > 0) return this.#lookupIn(key, options, lang, false);
    if (options != null && options.allow != null) {
      return this.#allowed(key, 0, false, options, false);
    }
    return this.#walk(key, 0, false, false, null, undefined);
  }

  match(key, options, lang) {
    if (lang > 0) return this.#lookupIn(key, options, lang, true);
    if (options != null && options.allow != null) {
      return this.#allowed(key, 0, false, options, true);
    }
    return this.#walk(key, 0, false, true, null, undefined);
  }

  // `abs.slice(from)`: '' or the path past the mount, '/' between names and
  // '\' too when the tree's sep is '\'. Walked in `abs` itself from `from`:
  // no key is cut or built, and a '\' path is not respelled.
  resolve(abs, from, options) {
    if (typeof abs !== 'string') throw invalid('resolve: a path');
    const both = this.#sep === '\\' && abs.indexOf('\\', from) !== -1;
    if (options != null && options.allow != null) {
      return this.#allowed(abs, from, both, options, false);
    }
    return this.#walk(abs, from, both, false, null, undefined);
  }

  // With `allow`: an FS tree has no policies, and allow is never called
  // there.
  #allowed(key, from, both, options, match) {
    const { allow, context } = options;
    if (typeof allow !== 'function') throw invalid('allow: a function');
    if (this.#fs) return this.#walk(key, from, both, match, null, undefined);
    return this.#walk(key, from, both, match, allow, context);
  }

  // The walk name by name from the root along `key` from `from` — a
  // separator ('\' too with `both`) or the end — passing each own policy as
  // it reaches it. `allow` null: none.
  #walk(key, from, both, match, allow, context) {
    if (typeof key !== 'string') throw invalid('a key: a string');
    const root = this.#root;
    const n = key.length;
    const first = key.charCodeAt(from); // NaN past the end
    const sep = first === 47 || (both && first === 92);
    // '' and a separator alone are the root
    if (n <= from || (sep && n === from + 1)) {
      if (root === null) return match ? new NotFound(null, '/') : null;
      return allow === null ? root : this.#pass(root, allow, context);
    }
    if (!sep) throw invalid(`not a key: ${key}`);
    if (root === null) return match ? new NotFound(null, key) : null;
    let node = root;
    let i = from + 1;
    for (;;) {
      if (allow !== null && node.policy !== null) {
        const decision = allow(node.policy, node, context);
        if (decision !== true) return new Denied(node, decision);
      }
      if (i > n) break; // past the last name
      let end = key.indexOf('/', i);
      if (both) {
        const back = key.indexOf('\\', i);
        if (back !== -1 && (end === -1 || back < end)) end = back;
      }
      if (end === -1) end = n;
      const { kids } = node;
      const child = kids === null ? undefined : kids.get(key.slice(i, end));
      if (child === undefined) {
        return match ? new NotFound(node, key.slice(i - 1)) : null;
      }
      node = child;
      i = end + 1;
    }
    return node;
  }

  #lookupIn(key, options, lang, match) {
    this.#language(lang);
    if (options == null || options.allow == null) {
      return this.#walkIn(key, match, null, undefined, lang);
    }
    const { allow, context } = options;
    if (typeof allow !== 'function') throw invalid('allow: a function');
    return this.#walkIn(key, match, allow, context, lang);
  }

  // #walk in language `lang` (from 1), by the names there: a node without
  // one is not there, nor what lies below it. The root is in every
  // language. Keys of '/' alone: an id tree's.
  #walkIn(key, match, allow, context, lang) {
    if (typeof key !== 'string') throw invalid('a key: a string');
    const root = this.#root;
    const n = key.length;
    const sep = key.charCodeAt(0) === 47;
    if (n === 0 || (sep && n === 1)) {
      if (root === null) return match ? new NotFound(null, '/') : null;
      return allow === null ? root : this.#pass(root, allow, context);
    }
    if (!sep) throw invalid(`not a key: ${key}`);
    if (root === null) return match ? new NotFound(null, key) : null;
    const slot = lang - 1;
    let node = root;
    let i = 1;
    for (;;) {
      if (allow !== null && node.policy !== null) {
        const decision = allow(node.policy, node, context);
        if (decision !== true) return new Denied(node, decision);
      }
      if (i > n) break; // past the last name
      let end = key.indexOf('/', i);
      if (end === -1) end = n;
      const { kids } = node;
      const names = kids === null || kids.alt === null ? null : kids.alt[slot];
      const child = names === null ? undefined : names.get(key.slice(i, end));
      if (child === undefined) {
        return match ? new NotFound(node, key.slice(i - 1)) : null;
      }
      node = child;
      i = end + 1;
    }
    return node;
  }

  // A language but the main one, by its index: EINVAL for another.
  #language(lang) {
    if (!Number.isInteger(lang) || lang >= this.#languages) {
      throw invalid(`not a language of the tree: ${lang}`);
    }
  }

  // The own policies from the root down to `node`: `node` when all let it
  // through, else the upper refusal.
  #pass(node, allow, context) {
    let owners = null;
    for (let n = node; n !== null; n = n.parent) {
      if (n.policy !== null) (owners ??= []).push(n);
    }
    if (owners === null) return node;
    for (let i = owners.length - 1; i >= 0; i--) {
      const owner = owners[i];
      const decision = allow(owner.policy, owner, context);
      if (decision !== true) return new Denied(owner, decision);
    }
    return node;
  }

  check(node, allow, context) {
    if (typeof allow !== 'function') throw invalid('allow: a function');
    if (node.name === null) return null;
    if (this.#fs) return node;
    return this.#pass(node, allow, context);
  }

  byId(id) {
    return this.#byId.get(id) ?? null;
  }

  // --- Nodes ----------------------------------------------------------------

  nodeId(node) {
    return node.id;
  }

  // `lang` in what follows: the index of a language but the main one, for
  // what the node is there. A node without a translation there has no
  // name, path or payload there; the root's name is ''.
  nameOf(node, lang) {
    if (!(lang > 0) || node.name === null) return node.name;
    this.#language(lang);
    if (node.parent === null) return '';
    const t = node.tr === null ? null : node.tr[lang - 1];
    return t === null ? null : t.name;
  }

  parentOf(node) {
    return node.parent;
  }

  payloadOf(node, lang) {
    if (!(lang > 0)) return node.payload;
    this.#language(lang);
    const t = node.tr === null ? null : node.tr[lang - 1];
    return t === null ? null : t.payload;
  }

  policyOf(node) {
    return this.#fs ? null : node.policy;
  }

  classOf(node) {
    return node.name === null ? null : node.cls;
  }

  isDirectory(node) {
    if (node.name === null) return false;
    return this.#fs ? node.cls === DIR : this.#containers.has(node.cls);
  }

  pathOf(node, lang) {
    if (node.name === null) return null;
    if (node.parent === null) return '';
    if (lang > 0) {
      this.#language(lang);
      return this.#pathIn(node, lang);
    }
    const names = [];
    for (let n = node; n.parent !== null; n = n.parent) names.push(n.name);
    return '/' + names.reverse().join('/');
  }

  #pathIn(node, lang) {
    const names = [];
    for (let n = node; n.parent !== null; n = n.parent) {
      const t = n.tr === null ? null : n.tr[lang - 1];
      if (t === null) return null;
      names.push(t.name);
    }
    return '/' + names.reverse().join('/');
  }

  // The paths of a live node in every language, by index: one climb.
  pathsOf(node) {
    if (node.name === null) return null;
    const count = this.#languages;
    const paths = new Array(count).fill('');
    if (node.parent === null) return paths;
    const trail = [];
    for (let n = node; n.parent !== null; n = n.parent) trail.push(n);
    trail.reverse();
    const names = [];
    for (const n of trail) names.push(n.name);
    paths[0] = '/' + names.join('/');
    for (let lang = 1; lang < count; lang++) {
      names.length = 0;
      for (const n of trail) {
        const t = n.tr === null ? null : n.tr[lang - 1];
        if (t === null) break;
        names.push(t.name);
      }
      paths[lang] = names.length < trail.length ? null : '/' + names.join('/');
    }
    return paths;
  }

  trailOf(node) {
    if (node.name === null) return null;
    const trail = [];
    for (let n = node; n !== null; n = n.parent) trail.push(n);
    return trail.reverse();
  }

  childOf(node, name, lang) {
    const { kids } = node;
    if (lang > 0) {
      const names = this.#namesOf(kids, lang);
      return names === null ? null : (names.get(name) ?? null);
    }
    if (kids === null) return null;
    return kids.get(name) ?? null;
  }

  countOf(node, lang) {
    const { kids } = node;
    if (lang > 0) {
      const names = this.#namesOf(kids, lang);
      return names === null ? 0 : names.size;
    }
    return kids === null ? 0 : kids.size;
  }

  // The children of `kids` by their names in language `lang`, or null.
  #namesOf(kids, lang) {
    this.#language(lang);
    if (kids === null || kids.alt === null) return null;
    return kids.alt[lang - 1];
  }

  // In a language: the children that have a name there, in their order.
  children(node, lang) {
    if (node.name === null) return null;
    if (this.#fs && node.cls !== DIR) return null;
    if (lang > 0) this.#language(lang);
    const out = [];
    const { kids } = node;
    if (kids === null) return out;
    if (lang > 0) {
      const containers = this.#containers;
      for (const child of kids.values()) {
        const t = child.tr === null ? null : child.tr[lang - 1];
        if (t !== null) out.push([t.name, containers.has(child.cls)]);
      }
    } else if (this.#fs) {
      for (const child of kids.values()) {
        out.push([child.name, child.cls === DIR]);
      }
    } else {
      const containers = this.#containers;
      for (const child of kids.values()) {
        out.push([child.name, containers.has(child.cls)]);
      }
    }
    return out;
  }

  classCountOf(node, cls) {
    if (!this.#classes) throw invalid('the class counters are off');
    const { kids } = node;
    if (kids === null) return 0;
    const { counts } = kids;
    for (let i = 0; i < counts.length; i += 2) {
      if (counts[i] === cls) return counts[i + 1];
    }
    return 0;
  }

  leafCountOf(node) {
    if (!this.#classes) throw invalid('the class counters are off');
    const { kids } = node;
    if (kids === null) return 0;
    const { counts } = kids;
    let sum = 0;
    for (let i = 0; i < counts.length; i += 2) {
      if (!this.#isContainerClass(counts[i])) sum += counts[i + 1];
    }
    return sum;
  }

  #isContainerClass(cls) {
    return this.#fs ? cls === DIR : this.#containers.has(cls);
  }

  subtreeVersionOf(node) {
    if (!this.#versions) throw invalid('the subtree versions are off');
    return node.name === null ? null : node.ver;
  }

  // The representation of a live node that starts at `offset` of segment
  // `segmentId`, in any language: { lang, kind, rep }, or null — how a
  // compaction names what it moves.
  repAt(node, segmentId, offset) {
    if (node.name === null) return null;
    const count = this.#fs ? 1 : this.#languages;
    for (let lang = 0; lang < count; lang++) {
      let payload = node.payload;
      if (lang > 0) {
        const t = node.tr === null ? null : node.tr[lang - 1];
        payload = t === null ? null : t.payload;
      }
      if (payload === null) continue;
      for (let kind = 0; kind < KINDS; kind++) {
        const rep = repOf(payload, kind);
        if (rep === null || rep.length === 0) continue;
        if (rep.segmentId === segmentId && rep.offset === offset) {
          return { lang, kind, rep };
        }
      }
    }
    return null;
  }

  // --- Traversal --------------------------------------------------------------

  // Lazy, copying nothing: a step after a change of structure is ESTALE.
  childNodesOf(node) {
    return this.#childNodes(node.kids, this.#epoch);
  }

  *#childNodes(kids, epoch) {
    if (kids === null) return;
    for (const child of kids.values()) {
      if (this.#epoch !== epoch) throw stale();
      yield child;
    }
    if (this.#epoch !== epoch) throw stale();
  }

  walk(nodes, options = {}) {
    if (options === null || typeof options !== 'object') {
      throw invalid('walk options');
    }
    const { depth = Infinity, containers = 'include', classes } = options;
    const { filter, descend } = options;
    const finite = Number.isInteger(depth) && depth >= 1;
    if (typeof depth !== 'number' || !(depth === Infinity || finite)) {
      throw invalid('walk: depth from 1');
    }
    const mode = WALK_MODES[containers];
    if (mode === undefined) throw invalid(`walk: containers ${containers}`);
    if (classes !== undefined && classes !== null && !Array.isArray(classes)) {
      throw invalid('walk: classes');
    }
    if (filter !== undefined && typeof filter !== 'function') {
      throw invalid('walk: filter');
    }
    if (descend !== undefined && typeof descend !== 'function') {
      throw invalid('walk: descend');
    }
    const starts = Array.isArray(nodes) ? nodes : [nodes];
    const only = classes == null ? null : new Set(classes);
    const epoch = this.#epoch;
    return this.#walkFrom(starts, depth, mode, only, filter, descend, epoch);
  }

  *#walkFrom(starts, depth, mode, classes, filter, descend, epoch) {
    for (let s = 0; s < starts.length; s++) {
      if (this.#epoch !== epoch) throw stale();
      const start = starts[s];
      if (start === null || typeof start !== 'object') continue;
      if (start.name === null || start.kids === null) continue;
      const stack = [start.kids.values()];
      while (stack.length > 0) {
        if (this.#epoch !== epoch) throw stale();
        const next = stack[stack.length - 1].next();
        if (next.done) {
          stack.pop();
          continue;
        }
        const node = next.value;
        const level = stack.length;
        let selected = true;
        if (mode !== 0) {
          const container = this.#isContainerClass(node.cls);
          selected = mode === 1 ? !container : container;
        }
        if (selected && classes !== null) selected = classes.has(node.cls);
        if (selected && filter !== undefined) selected = filter(node) === true;
        if (selected) yield [node, level];
        if (node.kids === null || level >= depth) continue;
        if (descend !== undefined && descend(node) !== true) continue;
        if (this.#epoch !== epoch) throw stale();
        stack.push(node.kids.values());
      }
    }
    if (this.#epoch !== epoch) throw stale();
  }

  // --- Commits ----------------------------------------------------------------

  #arguments(next, now) {
    if (!Number.isSafeInteger(next) || next < this.#version) {
      throw invalid(`next ${next}: a safe integer from ${this.#version}`);
    }
    if (typeof now !== 'number' || !Number.isFinite(now)) {
      throw invalid('now: a finite number');
    }
  }

  #view() {
    return {
      root: this.#root,
      byId: this.#byId,
      maxNodes: this.#maxNodes,
      segments: this.#segments,
      birthtime: this.#birthtime,
      mode: this.#mode,
      languages: this.#languages,
    };
  }

  // `options`: `{ changes: true }` for what the commit did to its nodes
  // (#publish).
  commit(ops, next, now, options) {
    if (!this.#main) throw invalid('a replica takes no commit');
    if (!Array.isArray(ops)) throw invalid('ops: an array');
    this.#arguments(next, now);
    const changes = changesOf(options);
    const plan = this.#fs
      ? new FsPlan(this.#view(), this.#ids).run(ops)
      : new IdPlan(this.#view()).commit(ops);
    return this.#publish(plan, next, now, changes);
  }

  load(rows, next, now, options) {
    if (!this.#main) throw invalid('a replica takes no load');
    if (!Array.isArray(rows)) throw invalid('rows: an array');
    this.#arguments(next, now);
    const changes = changesOf(options);
    if (this.#fs) throw invalid('an FS tree takes no load');
    const plan = new IdPlan(this.#view()).load(rows);
    return this.#publish(plan, next, now, changes);
  }

  // The retireIds, the last thing that may refuse; then the delta, applied
  // here as every replica applies it. What the commit did to its nodes,
  // when asked, is taken before: a node that dies or moves is keyed as the
  // tree stood.
  #publish(plan, next, now, wantChanges) {
    const { log } = plan;
    if (log.op.length === 0) {
      const version = this.#version;
      const changes = wantChanges ? noChanges() : null;
      return {
        delta: null,
        retired: [],
        dropped: [],
        placed: [],
        changes,
        version,
      };
    }
    const retired = [];
    for (const { id, kind, rep, lang } of plan.retired) {
      const retireId = this.#retireIds.next();
      if (lang === undefined) retired.push({ id, kind, retireId, rep });
      else retired.push({ id, kind, retireId, rep, lang });
    }
    const version = log.changed ? next : this.#version;
    const delta = this.#encode(log, retired, version, now);
    const changes = wantChanges ? plan.changes((n) => this.pathOf(n)) : null;
    this.#run(delta);
    const { dropped } = plan;
    const placed = plan.placed();
    return {
      delta,
      retired,
      dropped,
      placed,
      changes,
      version: this.#version,
    };
  }

  // A delta's numeric columns are views over one buffer (Columns); ids
  // are numbers by the rule of a numeric column, or strings as the tree's
  // own. A tree of several languages adds the names of LNAME and the
  // language of each retired representation; one of one language has the
  // delta it had before languages.
  #encode(log, retired, version, now) {
    const langs = this.#languages > 1;
    const rid = [];
    const rkind = [];
    const rret = [];
    const rlang = [];
    for (const r of retired) {
      rid.push(r.id);
      rkind.push(r.kind);
      rret.push(r.retireId);
      if (langs) rlang.push(r.lang);
    }
    const strings = this.#mode === 'string';
    const set = new Columns();
    const op = set.add(U8, log.op);
    const id = strings ? -1 : set.add(NUM, log.id);
    const parent = strings ? -1 : set.add(NUM, log.parent);
    const rids = strings ? -1 : set.add(NUM, rid);
    const int = set.add(I32, log.int);
    const rkinds = set.add(U8, rkind);
    const rrets = set.add(NUM, rret);
    const rlangs = langs ? set.add(U8, rlang) : -1;
    const pay = log.payloads.gather(set);
    const c = set.made();
    const delta = {
      mark: this.#mark,
      from: this.#revision,
      version,
      now,
      op: c[op],
      id: strings ? ownAll(log.id) : c[id],
      parent: strings ? ownAll(log.parent) : c[parent],
      name: ownAll(log.name),
      int: c[int],
      size: c[pay.size],
      mtime: c[pay.mtime],
      birth: pay.birth < 0 ? null : c[pay.birth],
      kinds: c[pay.kinds],
      seg: c[pay.seg],
      off: c[pay.off],
      len: c[pay.len],
      xi: c[pay.xi],
      meta: pay.meta,
      script: pay.script,
      policy: log.policy,
      retired: {
        id: strings ? rid : c[rids],
        kind: c[rkinds],
        retireId: c[rrets],
      },
    };
    if (langs) {
      delta.lname = ownAll(log.lname);
      delta.retired.lang = c[rlangs];
    }
    return delta;
  }

  // --- Replicas ---------------------------------------------------------------

  // Every retired representation goes to pins.retain before the first
  // change: what it throws leaves the replica as it was. Past that the
  // delta is trusted — the main tree of this engine made it.
  apply(delta, pins) {
    if (this.#main) throw invalid('a main tree takes no delta');
    if (delta === null || typeof delta !== 'object') throw invalid('a delta');
    if (delta.mark !== this.#mark) throw invalid('a delta of another tree');
    if (delta.from !== this.#revision) {
      const revisions = `${delta.from} to a replica at ${this.#revision}`;
      throw refusal('ESTALE', -1, `a delta from revision ${revisions}`);
    }
    this.#segmentsOf(delta);
    const { id, kind, retireId, lang = null } = delta.retired;
    const retained = [];
    for (let i = 0; i < kind.length; i++) {
      const node = this.#byId.get(at(id, i));
      const li = lang === null ? 0 : lang[i];
      const payload = li === 0 ? node.payload : node.tr[li - 1].payload;
      const rep = repOf(payload, kind[i]);
      const n = at(retireId, i);
      if (pins.retain(rep, n) === true) retained.push(n);
    }
    this.#run(delta);
    return retained;
  }

  // The steps of a delta, in order.
  #run(delta) {
    const { op, id, parent, name, int, policy, lname } = delta;
    const byId = this.#byId;
    const step = {
      version: delta.version,
      now: delta.now,
      changed: false,
      structure: false,
      policy: false,
      touched: null, // directories whose children changed
      created: null, // directories made
      payload: 0, // the cursors of the payload columns
      rep: 0,
      extras: 0,
    };
    let p = 0; // the cursor of parent and name
    let c = 0; // of int
    let k = 0; // of policy
    let l = 0; // of lname
    for (let i = 0; i < op.length; i++) {
      switch (op[i]) {
        case NEW: {
          const node = new this.#Node(at(id, i), int[c++]);
          byId.set(node.id, node);
          if (this.#versions) node.ver = step.version;
          if (this.#directories && node.cls === DIR) {
            (step.created ??= new Set()).add(node);
          }
          step.changed = true;
          step.structure = true;
          break;
        }
        case ATTACH: {
          const node = byId.get(at(id, i));
          this.#attach(node, byId.get(at(parent, p)), name[p], step);
          p++;
          break;
        }
        case ROOT: {
          const node = byId.get(at(id, i));
          node.name = '';
          node.parent = null;
          this.#root = node;
          step.changed = true;
          step.structure = true;
          break;
        }
        case DETACH:
          this.#detach(byId.get(at(id, i)), step);
          break;
        case KILL:
          this.#kill(byId.get(at(id, i)), step);
          break;
        case PAYLOAD: {
          const node = byId.get(at(id, i));
          node.payload = this.#payloadOf(delta, step);
          this.#changed(node, step);
          break;
        }
        case UNPUBLISH: {
          const node = byId.get(at(id, i));
          node.payload = null;
          this.#changed(node, step);
          break;
        }
        case CLASS: {
          const node = byId.get(at(id, i));
          const cls = int[c++];
          if (this.#classes) {
            for (let a = node.parent; a !== null; a = a.parent) {
              bump(a.kids.counts, node.cls, -1);
              bump(a.kids.counts, cls, 1);
            }
          }
          node.cls = cls;
          this.#changed(node, step);
          break;
        }
        case POLICY: {
          const node = byId.get(at(id, i));
          node.policy = frozen(policy[k++]);
          step.policy = true;
          this.#changed(node, step);
          break;
        }
        case RELOCATE: {
          const node = byId.get(at(id, i));
          node.payload = this.#relocated(node.payload, int[c++], delta, step);
          break;
        }
        case LNAME: {
          const node = byId.get(at(id, i));
          this.#rename(node, int[c++], lname[l++], step);
          break;
        }
        case LDROP:
          this.#untranslate(byId.get(at(id, i)), int[c++], step);
          break;
        case LPAYLOAD: {
          const node = byId.get(at(id, i));
          const t = node.tr[int[c++] - 1];
          t.payload = this.#payloadOf(delta, step);
          this.#changed(node, step);
          break;
        }
        case LUNPUBLISH: {
          const node = byId.get(at(id, i));
          node.tr[int[c++] - 1].payload = null;
          this.#changed(node, step);
          break;
        }
        case LRELOCATE: {
          const node = byId.get(at(id, i));
          const t = node.tr[int[c++] - 1];
          t.payload = this.#relocated(t.payload, int[c++], delta, step);
          break;
        }
        case RENDER: {
          const node = byId.get(at(id, i));
          const lang = int[c++];
          const mask = int[c++];
          if (lang === 0) {
            node.payload = this.#rendered(node.payload, mask, delta, step);
          } else {
            const t = node.tr[lang - 1];
            t.payload = this.#rendered(t.payload, mask, delta, step);
          }
          this.#changed(node, step);
          break;
        }
        default:
          throw new Error(`lib/tree.js: an unknown step ${op[i]}`);
      }
    }
    const { version } = step;
    if (step.touched !== null || step.created !== null) {
      this.#directoryPayloads(step);
    }
    if (step.changed) {
      this.#version = version;
      if (step.structure) this.#structureVersion = version;
      if (step.policy) this.#policyVersion = version;
    }
    if (step.structure) this.#epoch++;
    this.#revision++;
  }

  // A change of the node itself: its subtree version and the ancestors'.
  #changed(node, step) {
    if (this.#versions) this.#stamp(node, step.version);
    step.changed = true;
  }

  // Ancestors carry a subtree version no lower than their descendants':
  // the climb stops at the first that has this one already.
  #stamp(from, version) {
    for (let a = from; a !== null && a.ver !== version; a = a.parent) {
      a.ver = version;
    }
  }

  // The class counters of `node`'s subtree, itself included, added to
  // `from` and every ancestor above it (sign 1) or taken from them (−1).
  #count(from, node, sign) {
    const own = node.cls;
    const below = node.kids === null ? null : node.kids.counts;
    for (let a = from; a !== null; a = a.parent) {
      const { counts } = a.kids;
      bump(counts, own, sign);
      if (below === null) continue;
      for (let i = 0; i < below.length; i += 2) {
        if (below[i + 1] !== 0) bump(counts, below[i], sign * below[i + 1]);
      }
    }
  }

  #attach(node, parent, name, step) {
    node.parent = parent;
    node.name = name;
    let { kids } = parent;
    if (kids === null) {
      kids = new this.#Kids();
      parent.kids = kids;
    }
    kids.set(name, node);
    if (this.#languages > 1 && node.tr !== null) this.#listAll(parent, node);
    if (this.#classes) this.#count(parent, node, 1);
    if (this.#versions) this.#stamp(parent, step.version);
    if (this.#directories) (step.touched ??= new Set()).add(parent);
    step.changed = true;
    step.structure = true;
  }

  #detach(node, step) {
    const { parent } = node;
    step.changed = true;
    step.structure = true;
    if (parent === null) {
      // The root, which a load moves under another.
      this.#root = null;
      return;
    }
    if (this.#classes) this.#count(parent, node, -1);
    const { kids } = parent;
    kids.delete(node.name);
    if (this.#languages > 1 && node.tr !== null) this.#unlistAll(parent, node);
    if (kids.size === 0) parent.kids = null;
    if (this.#versions) this.#stamp(parent, step.version);
    if (this.#directories) (step.touched ??= new Set()).add(parent);
    node.parent = null;
  }

  // A node's names in the other languages, in its parent's lists of
  // children there: `alt` and a list made with the first, dropped with the
  // last. A name a later step of the same delta takes over is the new
  // holder's; the earlier one's removal leaves it (#unlist).
  #list(parent, lang, name, node) {
    const { kids } = parent;
    if (kids.alt === null) kids.alt = new Array(this.#languages - 1).fill(null);
    let names = kids.alt[lang - 1];
    if (names === null) {
      names = new Map();
      kids.alt[lang - 1] = names;
    }
    names.set(name, node);
  }

  #unlist(parent, lang, name, node) {
    const { alt } = parent.kids;
    const names = alt === null ? null : alt[lang - 1];
    if (names === null || names.get(name) !== node) return;
    names.delete(name);
    if (names.size === 0) alt[lang - 1] = null;
  }

  #listAll(parent, node) {
    const { tr } = node;
    for (let i = 0; i < tr.length; i++) {
      if (tr[i] !== null) this.#list(parent, i + 1, tr[i].name, node);
    }
  }

  #unlistAll(parent, node) {
    const { tr } = node;
    for (let i = 0; i < tr.length; i++) {
      if (tr[i] !== null) this.#unlist(parent, i + 1, tr[i].name, node);
    }
  }

  // A node's name in language `lang` (from 1): its translation made with
  // it, or renamed. A change of the node itself, as its payload's, and of
  // the structure: a lookup there finds another node.
  #rename(node, lang, name, step) {
    let { tr } = node;
    if (tr === null) {
      tr = new Array(this.#languages - 1).fill(null);
      node.tr = tr;
    }
    const t = tr[lang - 1];
    const { parent } = node;
    if (t === null) {
      tr[lang - 1] = new Translation(name, null);
    } else {
      if (parent !== null) this.#unlist(parent, lang, t.name, node);
      t.name = name;
    }
    if (parent !== null) this.#list(parent, lang, name, node);
    this.#changed(node, step);
    step.structure = true;
  }

  // A node's translation gone, its name and payload: `tr` dropped with the
  // last.
  #untranslate(node, lang, step) {
    const { tr } = node;
    const { parent } = node;
    if (parent !== null) this.#unlist(parent, lang, tr[lang - 1].name, node);
    tr[lang - 1] = null;
    let left = false;
    for (let i = 0; i < tr.length && !left; i++) left = tr[i] !== null;
    if (!left) node.tr = null;
    this.#changed(node, step);
    step.structure = true;
  }

  // A node and its subtree die: out of byId, every field that leads
  // anywhere let go — a dead node answers as a missing one.
  #kill(node, step) {
    step.changed = true;
    step.structure = true;
    const { parent } = node;
    if (node === this.#root) {
      this.#root = null;
    } else if (parent !== null) {
      if (this.#classes) this.#count(parent, node, -1);
      const { kids } = parent;
      kids.delete(node.name);
      if (this.#languages > 1 && node.tr !== null) {
        this.#unlistAll(parent, node);
      }
      if (kids.size === 0) parent.kids = null;
      if (this.#versions) this.#stamp(parent, step.version);
      if (this.#directories) (step.touched ??= new Set()).add(parent);
    }
    const byId = this.#byId;
    const policies = !this.#fs;
    const langs = this.#languages > 1;
    const stack = [node];
    while (stack.length > 0) {
      const n = stack.pop();
      if (n.kids !== null)
        for (const child of n.kids.values()) stack.push(child);
      byId.delete(n.id);
      if (policies && n.policy !== null) {
        step.policy = true;
        n.policy = null;
      }
      n.name = null;
      n.parent = null;
      n.kids = null;
      n.payload = null;
      if (langs) n.tr = null;
    }
  }

  // --- Payloads ---------------------------------------------------------------

  // A Representation takes its SAB when made: a segment the thread's map
  // does not hold yet is refused here — at fromSnapshot, which makes them
  // all, and before apply's first change (#segmentsOf) — not left to a
  // TypeError of a read long after.
  #rep(kind, segmentId, offset, length) {
    if (length === 0) return new Rep(kind, segmentId, offset, length, null);
    const sab = this.#segments.get(segmentId);
    if (sab === undefined) throw this.#noSegment(segmentId);
    return new Rep(kind, segmentId, offset, length, sab);
  }

  #noSegment(segmentId) {
    return invalid(`segment ${segmentId} is not in this thread's map`);
  }

  // Every non-empty extent of a delta lies in a segment of the map.
  #segmentsOf(delta) {
    const { seg, len } = delta;
    const segments = this.#segments;
    for (let r = 0; r < len.length; r++) {
      if (len[r] !== 0 && !segments.has(at(seg, r))) {
        throw this.#noSegment(at(seg, r));
      }
    }
  }

  #payload(version, size, mtime, birth, source, others, extras) {
    if (!this.#birthtime) {
      return new Payload(version, size, mtime, source, others, extras);
    }
    return new BirthPayload(
      version,
      size,
      mtime,
      birth,
      source,
      others,
      extras,
    );
  }

  // The payload at the cursors of the payload columns of a delta or a
  // snapshot.
  #payloadOf(columns, step) {
    const q = step.payload++;
    const mask = columns.kinds[q];
    let source = null;
    let others = null;
    if (mask !== 0) {
      const { seg, off, len } = columns;
      const slots = [null, null, null, null, null, null, null];
      for (let kind = 0; kind < KINDS; kind++) {
        if ((mask & (1 << kind)) === 0) continue;
        const r = step.rep++;
        slots[kind] = this.#rep(kind, at(seg, r), at(off, r), at(len, r));
      }
      source = slots[0];
      if (mask > 1) {
        others = new Others(
          slots[1],
          slots[2],
          slots[3],
          slots[4],
          slots[5],
          slots[6],
        );
      }
    }
    let extras = null;
    const x = step.extras;
    if (x < columns.xi.length && columns.xi[x] === q) {
      extras = new Extras(frozen(columns.meta[x]), frozen(columns.script[x]));
      step.extras++;
    }
    const size = at(columns.size, q);
    const birth = this.#birthtime ? columns.birth[q] : 0;
    const { version } = step;
    return this.#payload(
      version,
      size,
      columns.mtime[q],
      birth,
      source,
      others,
      extras,
    );
  }

  // A new payload with one representation's extent replaced: the same
  // attributes and extras, the other Representation objects as they are; a
  // relocated source keeps `others`, a derived one gets a new `others`.
  #relocated(payload, kind, delta, step) {
    const r = step.rep++;
    const { seg, off, len } = delta;
    const rep = this.#rep(kind, at(seg, r), at(off, r), at(len, r));
    let { source, others } = payload;
    if (kind === 0) {
      source = rep;
    } else {
      const slots = [];
      for (const field of OTHERS) slots.push(others[field]);
      slots[kind - 1] = rep;
      others = new Others(...slots);
    }
    const { version, size, mtimeMs, birthtimeMs, extras } = payload;
    return this.#payload(
      version,
      size,
      mtimeMs,
      birthtimeMs,
      source,
      others,
      extras,
    );
  }

  // A new payload with its page replaced (RENDER): the page's kinds of
  // `mask` from the delta, its other kinds gone, the rest — the source
  // object among them — as they were, and the delta's version: what the
  // payload holds changed. The attributes stay those of the data.
  #rendered(payload, mask, delta, step) {
    const { seg, off, len } = delta;
    const { others } = payload;
    const slots = [null, null, null, null, null, null];
    let any = false;
    for (let kind = 1; kind < KINDS; kind++) {
      let rep = null;
      if ((mask & (1 << kind)) !== 0) {
        const r = step.rep++;
        rep = this.#rep(kind, at(seg, r), at(off, r), at(len, r));
      } else if ((PAGE_KINDS & (1 << kind)) === 0 && others !== null) {
        rep = others[OTHERS[kind - 1]];
      }
      slots[kind - 1] = rep;
      if (rep !== null) any = true;
    }
    const { size, mtimeMs, birthtimeMs, extras } = payload;
    return this.#payload(
      step.version,
      size,
      mtimeMs,
      birthtimeMs,
      payload.source,
      any ? new Others(...slots) : null,
      extras,
    );
  }

  #dirPayload(version, mtime, birth) {
    return this.#payload(version, 0, mtime, birth, null, null, null);
  }

  // One new payload for each directory the delta made or whose children it
  // changed, however many of its steps did.
  #directoryPayloads(step) {
    const { version, now, created } = step;
    const dirs = step.touched ?? new Set();
    if (created !== null) for (const dir of created) dirs.add(dir);
    for (const dir of dirs) {
      if (dir.name === null) continue;
      const fresh = created !== null && created.has(dir);
      const before = dir.payload;
      const birth = fresh || before === null ? now : before.birthtimeMs;
      dir.payload = this.#dirPayload(version, now, birth);
    }
  }

  // --- Snapshots --------------------------------------------------------------

  // The tree in pre-order, children in their order, as columns. With
  // several languages: the translations by node, language and name, and
  // the language of each payload.
  snapshot() {
    const id = [];
    const up = [];
    const names = [];
    const cls = [];
    const ver = [];
    const pay = new PayloadColumns(this.#birthtime, true);
    const pnode = [];
    const plang = [];
    const qnode = [];
    const qvalue = [];
    const tnode = [];
    const tlang = [];
    const tname = [];
    const langs = this.#languages > 1;
    const root = this.#root;
    if (root !== null) {
      const versions = this.#versions;
      const policies = !this.#fs;
      const levels = [];
      const parents = [];
      let node = root;
      let parentIndex = -1;
      for (;;) {
        const index = id.length;
        id.push(node.id);
        up.push(parentIndex);
        names.push(node.name);
        cls.push(node.cls);
        if (versions) ver.push(node.ver);
        if (node.payload !== null) {
          pnode.push(index);
          if (langs) plang.push(0);
          pay.payload(node.payload);
        }
        if (langs && node.tr !== null) {
          const { tr } = node;
          for (let i = 0; i < tr.length; i++) {
            const t = tr[i];
            if (t === null) continue;
            tnode.push(index);
            tlang.push(i + 1);
            tname.push(t.name);
            if (t.payload === null) continue;
            pnode.push(index);
            plang.push(i + 1);
            pay.payload(t.payload);
          }
        }
        if (policies && node.policy !== null) {
          qnode.push(index);
          qvalue.push(node.policy);
        }
        if (node.kids !== null) {
          levels.push(node.kids.values());
          parents.push(index);
        }
        let next = null;
        while (levels.length > 0) {
          const item = levels[levels.length - 1].next();
          if (!item.done) {
            next = item.value;
            break;
          }
          levels.pop();
          parents.pop();
        }
        if (next === null) break;
        node = next;
        parentIndex = parents[parents.length - 1];
      }
    }
    const small = cls.every((c) => c < 256);
    return {
      format: Tree.#format,
      mark: this.#mark,
      revision: this.#revision,
      version: this.#version,
      structureVersion: this.#structureVersion,
      policyVersion: this.#policyVersion,
      ids: this.#mode,
      sep: this.#sep,
      containers: [...this.#containerList],
      directories: this.#directories,
      birthtime: this.#birthtime,
      classes: this.#classes,
      versions: this.#versions,
      languages: this.#languages,
      maxNodes: this.#maxNodes,
      id: this.#mode === 'string' ? id : column(id),
      up: new Int32Array(up),
      name: names,
      cls: small ? new Uint8Array(cls) : new Int32Array(cls),
      ver: this.#versions ? column(ver) : null,
      pnode: new Int32Array(pnode),
      plang: langs ? new Uint8Array(plang) : null,
      ...pay.columns(),
      qnode: new Int32Array(qnode),
      qvalue,
      tnode: langs ? new Int32Array(tnode) : null,
      tlang: langs ? new Uint8Array(tlang) : null,
      tname: langs ? tname : null,
    };
  }

  // A replica's nodes from the columns of a snapshot. Plain loops: no
  // closure holds a column past the return.
  #grow(s) {
    const count = s.up.length;
    const nodes = new Array(count);
    const byId = this.#byId;
    const Node = this.#Node;
    const Kids = this.#Kids;
    const { up, name, cls } = s;
    for (let i = 0; i < count; i++) {
      const node = new Node(at(s.id, i), cls[i]);
      node.name = name[i];
      const p = up[i];
      if (p === -1) {
        this.#root = node;
      } else {
        const parent = nodes[p];
        node.parent = parent;
        if (parent.kids === null) parent.kids = new Kids();
        parent.kids.set(node.name, node);
      }
      byId.set(node.id, node);
      nodes[i] = node;
    }
    if (this.#versions) {
      for (let i = 0; i < count; i++) nodes[i].ver = at(s.ver, i);
    }
    if (this.#languages > 1) {
      const { tnode, tlang, tname } = s;
      for (let j = 0; j < tnode.length; j++) {
        const node = nodes[tnode[j]];
        node.tr ??= new Array(this.#languages - 1).fill(null);
        const lang = tlang[j];
        node.tr[lang - 1] = new Translation(tname[j], null);
        if (node.parent !== null) this.#list(node.parent, lang, tname[j], node);
      }
    }
    const step = { version: 0, payload: 0, rep: 0, extras: 0 };
    const { pnode, pver, plang } = s;
    for (let q = 0; q < pnode.length; q++) {
      step.version = at(pver, q);
      const payload = this.#payloadOf(s, step);
      const node = nodes[pnode[q]];
      const lang = plang === null ? 0 : plang[q];
      if (lang === 0) node.payload = payload;
      else node.tr[lang - 1].payload = payload;
    }
    const { qnode, qvalue } = s;
    for (let j = 0; j < qnode.length; j++) {
      nodes[qnode[j]].policy = frozen(qvalue[j]);
    }
    if (this.#classes) {
      // Bottom-up: a node's counters are whole before its parent takes them.
      for (let i = count - 1; i > 0; i--) {
        const node = nodes[i];
        const { counts } = node.parent.kids;
        bump(counts, node.cls, 1);
        if (node.kids === null) continue;
        const below = node.kids.counts;
        for (let j = 0; j < below.length; j += 2) {
          bump(counts, below[j], below[j + 1]);
        }
      }
    }
  }
}

const createTree = (options) => Tree.create(options);
const fromSnapshot = (snapshot, segments, options) =>
  Tree.fromSnapshot(snapshot, segments, options);

module.exports = { createTree, fromSnapshot, Denied, NotFound };
