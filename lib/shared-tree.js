'use strict';

const { brokenError } = require('./errors.js');
const { VfsReadStream, rangeOf, kernelClosed } = require('./views.js');
const { ENCODINGS } = require('./place.js');

// SharedTree — the public API of a shared tree, `kernel.tree(name)`, in
// every thread (doc/architecture.md, "Shared trees"): the tree
// this thread holds — the main tree on the main thread, its replica in a
// worker — its lookups and its nodes, the bytes of their payloads and
// pages copied or under a pin, the batches of the source, which go to the
// intake of the main thread, and the pages a thread renders. Nodes are
// opaque: the facade hands out the engine's and takes them back; a dead
// node answers as the engine says. A payload's Representations never
// leave it — their `data` is a view over shared memory without a pin,
// which a reader could hold past its free — so bytes come as a copy
// (read), a lease (view) or a stream, each pinned while it reads. A closed
// kernel refuses every call (ERR_VFS_CLOSED), a broken view of a worker
// with what broke it, as PlaceFs does.
//
// The tree speaks its main language; `lang(code)` is a view of one of its
// languages — what depends on the language: lookups, names, paths,
// children, payloads, pages — the main one's answering as the tree.
//
// `host` is the kernel's record of the tree: { name, config, tree, last };
// `write(kind, request)` takes `submit`, `load`, `cache` and `uncache` —
// to the intake on the main thread, over the link in a worker.

// A payload's representation of `kind`: the data, the page (kind 1, in
// `others` the field of `require` cached data, which a tree never has) or
// a compressed form of the page.
const DATA = 'source';
const RENDERED = 'requireBytecode';

// A stream's options: an object, or an encoding string.
const optionsOf = (options) =>
  typeof options === 'string' ? { encoding: options } : options;

const encodingsOf = (payload) => {
  const { others } = payload;
  if (others === null) return [];
  return ENCODINGS.filter((encoding) => others[encoding] !== null);
};

const repOf = (payload, kind) =>
  kind === DATA ? payload.source : (payload.others?.[kind] ?? null);

const zeroCopyOff = (name) =>
  Object.assign(new Error(`[vfs] tree "${name}": zeroCopy is off`), {
    code: 'ENOTSUP',
  });

const notConfigured = (name, encoding) =>
  Object.assign(
    new Error(`[vfs] tree "${name}": encoding "${encoding}" is not configured`),
    { code: 'ENOTSUP' },
  );

const noLanguage = (name, code) =>
  Object.assign(
    new Error(`[vfs] tree "${name}" has no language ${JSON.stringify(code)}`),
    { code: 'EINVAL' },
  );

// What a lookup, a payload, a page take of a language: the readers the
// tree and its views share — `lang` its index, 0 the main one.
class Readers {
  #host;
  #kernel;
  #write;

  constructor(host, kernel, write) {
    this.#host = host;
    this.#kernel = kernel;
    this.#write = write;
  }

  // The tree this thread holds; a closed kernel or a broken view refuses.
  reading() {
    const cause = this.#kernel.broken;
    if (cause) throw brokenError(cause);
    const { tree } = this.#host;
    if (this.#kernel.state === 'closed' || tree === null) throw kernelClosed();
    return tree;
  }

  get name() {
    return this.#host.name;
  }

  get zeroCopy() {
    return this.#host.config.zeroCopy;
  }

  get languages() {
    return this.#host.config.languages;
  }

  get last() {
    return this.#host.last;
  }

  // What a node's payload is in a language, without its bytes: { version,
  // size, mtimeMs, birthtimeMs?, meta, rendered } — `rendered` { size,
  // encodings } of its page, or null — frozen; or null.
  info(node, lang) {
    const payload = this.reading().payloadOf(node, lang);
    if (payload === null) return null;
    const { version, size, mtimeMs, extras } = payload;
    const info = { version, size, mtimeMs };
    if (payload.birthtimeMs !== undefined) {
      info.birthtimeMs = payload.birthtimeMs;
    }
    info.meta = extras?.meta ?? null;
    const page = payload.others?.[RENDERED] ?? null;
    info.rendered =
      page === null
        ? null
        : Object.freeze({
            size: page.length,
            encodings: Object.freeze(encodingsOf(payload)),
          });
    return Object.freeze(info);
  }

  // The representation `kind` of a node's payload in a language — its
  // data, its page, a compressed form of the page — and the payload, or
  // null.
  #found(node, lang, kind) {
    const payload = this.reading().payloadOf(node, lang);
    if (payload === null) return null;
    const rep = repOf(payload, kind);
    return rep ? { rep, payload } : null;
  }

  #views() {
    if (!this.zeroCopy) throw zeroCopyOff(this.name);
  }

  // An encoding the tree's `compress` makes, or ENOTSUP — as PlaceFs: no
  // other name reaches a payload's representations.
  codec(encoding) {
    this.reading();
    const codecs = this.#host.config.compress?.codecs ?? [];
    if (codecs.some((codec) => codec.encoding === encoding)) return;
    throw notConfigured(this.name, encoding);
  }

  #lease(rep, version) {
    const release = this.#kernel.pins.acquire(rep);
    return Object.freeze({
      view: rep.data,
      version,
      release,
      [Symbol.dispose]: release,
    });
  }

  #stream(rep, options) {
    const borrowed = this.#borrowed(options) && !options.encoding;
    const range = rangeOf(options, rep.length);
    let stream = null;
    const release = this.#kernel.pins.acquire(rep, () =>
      stream?.destroy(kernelClosed()),
    );
    try {
      stream = new VfsReadStream(rep.data, range, options, borrowed, release);
    } catch (err) {
      release();
      throw err;
    }
    return stream;
  }

  // Borrowed chunks: the tree's `zeroCopy` by default, per call with
  // `{ zeroCopy }` — true needs it on.
  #borrowed(options) {
    if (options.zeroCopy === undefined) return this.zeroCopy;
    if (options.zeroCopy) this.#views();
    return Boolean(options.zeroCopy);
  }

  // An owned copy — a string with `encoding` — or null.
  read(node, lang, kind, encoding) {
    const found = this.#found(node, lang, kind);
    if (found === null) return null;
    const data = Buffer.from(found.rep.data);
    return encoding ? data.toString(encoding) : data;
  }

  // A lease — { view, version, release, [Symbol.dispose] }, `view` stable
  // until release() — or null; needs `zeroCopy`.
  view(node, lang, kind) {
    this.reading();
    this.#views();
    const found = this.#found(node, lang, kind);
    return found === null
      ? null
      : this.#lease(found.rep, found.payload.version);
  }

  // Options: { start, end (inclusive), encoding, highWaterMark, signal,
  // zeroCopy }, or an encoding string — as PlaceFs takes them.
  stream(node, lang, kind, options = {}) {
    const found = this.#found(node, lang, kind);
    return found === null ? null : this.#stream(found.rep, optionsOf(options));
  }

  // The page of a node's payload in a language, rendered from the payload
  // of `version` — its code, or none for the main one: { status: 'cached'
  // | 'stale' } once published and in this thread.
  cache(node, code, bytes, version) {
    const nodeId = this.reading().nodeId(node);
    return this.#write('cache', { nodeId, lang: code, data: bytes, version });
  }

  // No page of a node — its subtree too with `{ subtree: true }` — in a
  // language, or in all for `code` null: { dropped } once published.
  uncache(node, code, options) {
    const nodeId = this.reading().nodeId(node);
    const subtree = options?.subtree ?? false;
    return this.#write('uncache', { nodeId, lang: code, subtree });
  }

  submit(batch) {
    this.reading();
    return this.#write('submit', batch);
  }

  load(rows, seq) {
    this.reading();
    return this.#write('load', { rows, seq });
  }
}

// A language of a shared tree, `tree.lang(code)`: what depends on it.
class TreeLanguage {
  #of;
  #code;
  #lang;

  constructor(of, code, lang) {
    this.#of = of;
    this.#code = code;
    this.#lang = lang;
  }

  get code() {
    return this.#code;
  }

  get(key, options) {
    return this.#of.reading().get(key, options, this.#lang);
  }

  match(key, options) {
    return this.#of.reading().match(key, options, this.#lang);
  }

  nameOf(node) {
    return this.#of.reading().nameOf(node, this.#lang);
  }

  pathOf(node) {
    return this.#of.reading().pathOf(node, this.#lang);
  }

  childOf(node, name) {
    return this.#of.reading().childOf(node, name, this.#lang);
  }

  children(node) {
    return this.#of.reading().children(node, this.#lang);
  }

  countOf(node) {
    return this.#of.reading().countOf(node, this.#lang);
  }

  payloadOf(node) {
    return this.#of.info(node, this.#lang);
  }

  read(node, encoding) {
    return this.#of.read(node, this.#lang, DATA, encoding);
  }

  view(node) {
    return this.#of.view(node, this.#lang, DATA);
  }

  createReadStream(node, options) {
    return this.#of.stream(node, this.#lang, DATA, options);
  }

  readRendered(node, encoding) {
    return this.#of.read(node, this.#lang, RENDERED, encoding);
  }

  viewRendered(node) {
    return this.#of.view(node, this.#lang, RENDERED);
  }

  createRenderedStream(node, options) {
    return this.#of.stream(node, this.#lang, RENDERED, options);
  }

  readCompressed(node, encoding) {
    this.#of.codec(encoding);
    return this.#of.read(node, this.#lang, encoding);
  }

  viewCompressed(node, encoding) {
    this.#of.codec(encoding);
    return this.#of.view(node, this.#lang, encoding);
  }

  createReadStreamCompressed(node, encoding, options) {
    this.#of.codec(encoding);
    return this.#of.stream(node, this.#lang, encoding, options);
  }

  cache(node, bytes, version) {
    return this.#of.cache(node, this.#code, bytes, version);
  }

  uncache(node, options) {
    return this.#of.uncache(node, this.#code, options);
  }
}

class SharedTree {
  #of;
  #views = new Map(); // code → TreeLanguage

  constructor(host, kernel, write) {
    this.#of = new Readers(host, kernel, write);
  }

  get name() {
    return this.#of.name;
  }

  get zeroCopy() {
    return this.#of.zeroCopy;
  }

  // The codes of its languages, the main one first, as configured; [] for
  // one language without a code.
  get languages() {
    return this.#of.languages;
  }

  // The view of one of its languages, one per code; EINVAL for a code the
  // tree has not.
  lang(code) {
    let view = this.#views.get(code);
    if (view !== undefined) return view;
    const lang = this.languages.indexOf(code);
    if (lang === -1) throw noLanguage(this.name, code);
    view = new TreeLanguage(this.#of, code, lang);
    this.#views.set(code, view);
    return view;
  }

  // --- The numbers and the rule ---

  get version() {
    return this.#of.reading().version;
  }

  get structureVersion() {
    return this.#of.reading().structureVersion;
  }

  get policyVersion() {
    return this.#of.reading().policyVersion;
  }

  // The number of the last batch of the source this thread's tree shows —
  // the `seqTo` of the last publication it applied — or null before one.
  get last() {
    this.#of.reading();
    return this.#of.last;
  }

  // The classes this thread takes for containers; set without a commit, in
  // this thread alone.
  get containers() {
    return this.#of.reading().containers;
  }

  set containers(list) {
    this.#of.reading().containers = list;
  }

  get root() {
    return this.#of.reading().get('');
  }

  // --- Lookups ---

  get(key, options) {
    return this.#of.reading().get(key, options);
  }

  match(key, options) {
    return this.#of.reading().match(key, options);
  }

  // The node, the upper refusal of the policies from the root down to it
  // (Denied), or null for a dead node: `{ allow, context }`.
  check(node, options) {
    const tree = this.#of.reading();
    const { allow, context } = options ?? {};
    return tree.check(node, allow, context);
  }

  byId(id) {
    return this.#of.reading().byId(id);
  }

  // --- Nodes ---

  nodeId(node) {
    return this.#of.reading().nodeId(node);
  }

  nameOf(node) {
    return this.#of.reading().nameOf(node);
  }

  parentOf(node) {
    return this.#of.reading().parentOf(node);
  }

  pathOf(node) {
    return this.#of.reading().pathOf(node);
  }

  // Its path in every language — { code: path | null } — or null for a
  // dead node: one climb.
  pathsOf(node) {
    const paths = this.#of.reading().pathsOf(node);
    if (paths === null) return null;
    const out = {};
    const { languages } = this;
    for (let i = 0; i < languages.length; i++) out[languages[i]] = paths[i];
    return Object.freeze(out);
  }

  trailOf(node) {
    return this.#of.reading().trailOf(node);
  }

  classOf(node) {
    return this.#of.reading().classOf(node);
  }

  policyOf(node) {
    return this.#of.reading().policyOf(node);
  }

  isContainer(node) {
    return this.#of.reading().isDirectory(node);
  }

  childOf(node, name) {
    return this.#of.reading().childOf(node, name);
  }

  // [name, isContainer] of each child, or null for a leaf.
  children(node) {
    return this.#of.reading().children(node);
  }

  childNodesOf(node) {
    return this.#of.reading().childNodesOf(node);
  }

  countOf(node) {
    return this.#of.reading().countOf(node);
  }

  walk(nodes, options) {
    return this.#of.reading().walk(nodes, options);
  }

  classCountOf(node, cls) {
    return this.#of.reading().classCountOf(node, cls);
  }

  leafCountOf(node) {
    return this.#of.reading().leafCountOf(node);
  }

  subtreeVersionOf(node) {
    return this.#of.reading().subtreeVersionOf(node);
  }

  // --- Payloads and pages, of the main language ---

  payloadOf(node) {
    return this.#of.info(node, 0);
  }

  // An owned copy of a node's data — a string with `encoding` — or null.
  read(node, encoding) {
    return this.#of.read(node, 0, DATA, encoding);
  }

  // A lease over a node's data, or null; needs `zeroCopy`.
  view(node) {
    return this.#of.view(node, 0, DATA);
  }

  createReadStream(node, options) {
    return this.#of.stream(node, 0, DATA, options);
  }

  // Its page: what goes to a client.
  readRendered(node, encoding) {
    return this.#of.read(node, 0, RENDERED, encoding);
  }

  viewRendered(node) {
    return this.#of.view(node, 0, RENDERED);
  }

  createRenderedStream(node, options) {
    return this.#of.stream(node, 0, RENDERED, options);
  }

  // A compressed form of its page.
  readCompressed(node, encoding) {
    this.#of.codec(encoding);
    return this.#of.read(node, 0, encoding);
  }

  viewCompressed(node, encoding) {
    this.#of.codec(encoding);
    return this.#of.view(node, 0, encoding);
  }

  createReadStreamCompressed(node, encoding, options) {
    this.#of.codec(encoding);
    return this.#of.stream(node, 0, encoding, options);
  }

  // A page in the main language; uncache: in every language.
  cache(node, bytes, version) {
    return this.#of.cache(node, this.languages[0], bytes, version);
  }

  uncache(node, options) {
    return this.#of.uncache(node, null, options);
  }

  // --- The batches of the source ---

  // { seq, ops } — resolves { seq, status } once the batch is published
  // and this thread's tree shows it (lib/intake.js).
  submit(batch) {
    return this.#of.submit(batch);
  }

  // The source's state at `seq` (without one in 'intake' mode): resolves
  // { seq } once it is published and this thread's tree shows it.
  load(rows, seq) {
    return this.#of.load(rows, seq);
  }
}

module.exports = { SharedTree, TreeLanguage };
