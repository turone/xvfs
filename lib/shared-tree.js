'use strict';

const { brokenError } = require('./errors.js');
const { VfsReadStream, rangeOf, kernelClosed } = require('./views.js');
const { ENCODINGS } = require('./place.js');

// SharedTree — the public API of a shared tree, `kernel.tree(name)`, in
// every thread (doc/architecture.md, "Shared trees"): the tree
// this thread holds — the main tree on the main thread, its replica in a
// worker — its lookups and its nodes, the bytes of their payloads copied or
// under a pin, and the batches of the source, which go to the intake of the
// main thread. Nodes are opaque: the facade hands out the engine's and
// takes them back; a dead node answers as the engine says. A payload's
// Representations never leave it — their `data` is a view over shared
// memory without a pin, which a reader could hold past its free — so bytes
// come as a copy (read), a lease (view) or a stream, each pinned while it
// reads. A closed kernel refuses every call (ERR_VFS_CLOSED), a broken
// view of a worker with what broke it, as PlaceFs does.
//
// `host` is the kernel's record of the tree: { name, config, tree, last };
// `write(kind, request)` takes `submit` and `load` — to the intake on the
// main thread, over the link in a worker.

// A stream's options: an object, or an encoding string.
const optionsOf = (options) =>
  typeof options === 'string' ? { encoding: options } : options;

const encodingsOf = (payload) => {
  const { others } = payload;
  if (others === null) return [];
  return ENCODINGS.filter((encoding) => others[encoding] !== null);
};

const zeroCopyOff = (name) =>
  Object.assign(new Error(`[vfs] tree "${name}": zeroCopy is off`), {
    code: 'ENOTSUP',
  });

const notConfigured = (name, encoding) =>
  Object.assign(
    new Error(`[vfs] tree "${name}": encoding "${encoding}" is not configured`),
    { code: 'ENOTSUP' },
  );

class SharedTree {
  #host;
  #kernel;
  #write;

  constructor(host, kernel, write) {
    this.#host = host;
    this.#kernel = kernel;
    this.#write = write;
  }

  // The tree this thread holds; a closed kernel or a broken view refuses.
  #reading() {
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

  // --- The numbers and the rule ---

  get version() {
    return this.#reading().version;
  }

  get structureVersion() {
    return this.#reading().structureVersion;
  }

  get policyVersion() {
    return this.#reading().policyVersion;
  }

  // The number of the last batch of the source this thread's tree shows —
  // the `seqTo` of the last publication it applied — or null before one.
  get last() {
    this.#reading();
    return this.#host.last;
  }

  // The classes this thread takes for containers; set without a commit, in
  // this thread alone.
  get containers() {
    return this.#reading().containers;
  }

  set containers(list) {
    this.#reading().containers = list;
  }

  get root() {
    return this.#reading().get('');
  }

  // --- Lookups ---

  get(key, options) {
    return this.#reading().get(key, options);
  }

  match(key, options) {
    return this.#reading().match(key, options);
  }

  // The node, the upper refusal of the policies from the root down to it
  // (Denied), or null for a dead node: `{ allow, context }`.
  check(node, options) {
    const tree = this.#reading();
    const { allow, context } = options ?? {};
    return tree.check(node, allow, context);
  }

  byId(id) {
    return this.#reading().byId(id);
  }

  // --- Nodes ---

  nodeId(node) {
    return this.#reading().nodeId(node);
  }

  nameOf(node) {
    return this.#reading().nameOf(node);
  }

  parentOf(node) {
    return this.#reading().parentOf(node);
  }

  pathOf(node) {
    return this.#reading().pathOf(node);
  }

  trailOf(node) {
    return this.#reading().trailOf(node);
  }

  classOf(node) {
    return this.#reading().classOf(node);
  }

  policyOf(node) {
    return this.#reading().policyOf(node);
  }

  isContainer(node) {
    return this.#reading().isDirectory(node);
  }

  childOf(node, name) {
    return this.#reading().childOf(node, name);
  }

  // [name, isContainer] of each child, or null for a leaf.
  children(node) {
    return this.#reading().children(node);
  }

  childNodesOf(node) {
    return this.#reading().childNodesOf(node);
  }

  countOf(node) {
    return this.#reading().countOf(node);
  }

  walk(nodes, options) {
    return this.#reading().walk(nodes, options);
  }

  classCountOf(node, cls) {
    return this.#reading().classCountOf(node, cls);
  }

  leafCountOf(node) {
    return this.#reading().leafCountOf(node);
  }

  subtreeVersionOf(node) {
    return this.#reading().subtreeVersionOf(node);
  }

  // --- Payloads ---

  // What a node's payload is, without its bytes: { version, size,
  // mtimeMs, birthtimeMs?, meta, scriptOptions, encodings } — frozen — or
  // null.
  payloadOf(node) {
    const payload = this.#reading().payloadOf(node);
    if (payload === null) return null;
    const { version, size, mtimeMs, extras } = payload;
    const info = { version, size, mtimeMs };
    if (payload.birthtimeMs !== undefined)
      info.birthtimeMs = payload.birthtimeMs;
    info.meta = extras?.meta ?? null;
    info.scriptOptions = extras?.scriptOptions ?? null;
    info.encodings = Object.freeze(encodingsOf(payload));
    return Object.freeze(info);
  }

  // The representation `encoding` names of a node's payload — its source
  // without one — and the payload, or null.
  #rep(node, encoding) {
    const payload = this.#reading().payloadOf(node);
    if (payload === null) return null;
    const rep =
      encoding === undefined ? payload.source : payload.others?.[encoding];
    return rep ? { rep, payload } : null;
  }

  #views() {
    if (!this.zeroCopy) throw zeroCopyOff(this.name);
  }

  // An encoding the tree's `compress` makes, or ENOTSUP — as PlaceFs: no
  // other name reaches a payload's representations.
  #codec(encoding) {
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

  // An owned copy of a node's source — a string with `encoding` — or null.
  read(node, encoding) {
    const found = this.#rep(node);
    if (found === null) return null;
    const data = Buffer.from(found.rep.data);
    return encoding ? data.toString(encoding) : data;
  }

  // A lease over a node's source — { view, version, release,
  // [Symbol.dispose] }, `view` stable until release() — or null; needs
  // `zeroCopy`.
  view(node) {
    this.#reading();
    this.#views();
    const found = this.#rep(node);
    return found === null
      ? null
      : this.#lease(found.rep, found.payload.version);
  }

  readCompressed(node, encoding) {
    this.#reading();
    this.#codec(encoding);
    const found = this.#rep(node, encoding);
    return found === null ? null : Buffer.from(found.rep.data);
  }

  viewCompressed(node, encoding) {
    this.#reading();
    this.#views();
    this.#codec(encoding);
    const found = this.#rep(node, encoding);
    return found === null
      ? null
      : this.#lease(found.rep, found.payload.version);
  }

  // Options: { start, end (inclusive), encoding, highWaterMark, signal,
  // zeroCopy }, or an encoding string — as PlaceFs takes them.
  createReadStream(node, options = {}) {
    const found = this.#rep(node);
    return found === null ? null : this.#stream(found.rep, optionsOf(options));
  }

  createReadStreamCompressed(node, encoding, options = {}) {
    this.#reading();
    this.#codec(encoding);
    const found = this.#rep(node, encoding);
    return found === null ? null : this.#stream(found.rep, optionsOf(options));
  }

  // --- The batches of the source ---

  // { seq, ops } — resolves { seq, status } once the batch is published
  // and this thread's tree shows it (lib/intake.js).
  submit(batch) {
    this.#reading();
    return this.#write('submit', batch);
  }

  // The source's state at `seq` (without one in 'intake' mode): resolves
  // { seq } once it is published and this thread's tree shows it.
  load(rows, seq) {
    this.#reading();
    return this.#write('load', { rows, seq });
  }
}

module.exports = { SharedTree };
