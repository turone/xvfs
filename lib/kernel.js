'use strict';

const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { availableParallelism } = require('node:os');
const { MessageChannel, receiveMessageOnPort } = require('node:worker_threads');
const { fileExt } = require('metautil');
// The disk past fs-patch (disk.js).
const {
  realpathSync,
  lstatSync,
  leafStats,
  isLink,
  readdirSyncBelow,
  promises: { open, lstat },
} = require('./disk.js');
const { LINKED, UNCHECKED, brokenError } = require('./errors.js');
const { FilesystemCache } = require('./cache.js');
const { Compressor } = require('./compressor.js');
const { PlaceRegistry, FsRouter, namesDirectory } = require('./registry.js');
const { Aliases } = require('./aliases.js');
const { LinkIndex } = require('./links.js');
const { Place, COMPRESSED, CASELESS } = require('./place.js');
const { createTree, fromSnapshot } = require('./tree.js');
const {
  INIT,
  WATCH,
  OPS,
  RELOCATION,
  DIR,
  FILE,
  GONE,
  PARENTS,
  newEpoch,
  placeEpoch,
  reconcile,
  CHANGES,
  eventsOf,
} = require('./epoch.js');
const { PlaceFs } = require('./place-fs.js');
const { SharedTree } = require('./shared-tree.js');
const { Intake, checkBatch, checkLoad } = require('./intake.js');
const { MapStore } = require('./map-store.js');
const { SabStore } = require('./sab-store.js');
const { MutationQueue } = require('./mutation-queue.js');
const { pool } = require('./pool.js');
const { Pins } = require('./pins.js');
const { Retirement } = require('./retirement.js');
const { WatchPipeline } = require('./watch-pipeline.js');
const {
  MUTATE,
  MutationClient,
  RemoteStore,
  serveMutation,
} = require('./mutation-rpc.js');
const { Preparers, opening } = require('./pipeline.js');
const {
  closedError,
  alive,
  inputOf,
  keptOnDisk,
  sharedPublish,
} = require('./publication.js');
const { scan, linksOf } = require('./scanner.js');
const { INDEXED, SHARED, deepFreeze, writesAnywhere } = require('./config.js');

// VfsKernel — orchestrator and consumer facade.
// Every indexed place has a node tree (lib/tree.js) in every thread: a
// directory is a node, a file's node holds its payload — attributes, the
// source and its derived representations, extents in the SAB pool.
// Main thread: fills places from their origin (a disk scan, embedded SEA
// assets or application mutations of a virtual place) through one
// publication pipeline — raw input → the preparer of its extension →
// canonical content → bytecode and compressed representations (the SAB
// sink, publication.js) → one epoch (epoch.js), which the kernel commits
// to the trees of the places it touches — watches disk-origin places
// (watch-pipeline.js) and sends each commit as one `vfs-update` to the
// linked workers. A representation a commit replaces or removes is retired
// (retirement.js): its bytes are freed only after every live worker ACKs
// the update and no thread still reads them. A commit that publishes
// something — not a relocation, not an empty epoch — takes the next number
// of the main kernel's publication counter (`version`): the version of
// every payload it makes, carried by its update and by every snapshot
// after it, the same in every thread. Each thread that applies a
// publication tells its 'publish' listeners what it changed, after the
// commit (#publish, #announce).
// Worker thread: `VfsKernel.fromSnapshot()` builds replicas of the trees
// over the same segments, applies the deltas arriving on its link port,
// ACKs each with the retired representations it still reads, and sends
// mutations of shared virtual places back over the same port. A `map`
// place has a tree of its own in each thread, its bytes in the thread's
// own buffers: no snapshot, delta or ACK.
// States: new → initializing → ready → closed (final).
//
// Protocol (link port):
//   vfs-snapshot main → worker { snapshot } — the first message of a link,
//                              taken by attach() before anything else
//   vfs-update  main → worker  { updateId, version, places: { <name>: {
//                              delta, created, replaced, removed, moved }
//                              }, trees: { <name>: { deltas, seq } },
//                              newSegments } — a place's tree delta and
//                              the keys of the files it changed; the
//                              deltas of a shared tree and the
//                              numbers of the batches they show ({ from,
//                              to, loaded }, null for a relocation)
//   vfs-ack     worker → main  { updateId, retained?: [retireId] }
//   vfs-release worker → main  { retireIds }
//   vfs-mutate / vfs-mutated   see mutation-rpc.js
//   vfs-links   main → worker  { add: [path], generation } links the watcher
//                              found, for the index of `links: 'deny'`
//                              (#learnLinks)

const KERNEL = Symbol.for('xvfs');
// A native route whose path the disk places elsewhere (VfsKernel#proven).
const UNPROVEN = Object.freeze({ kind: 'deny', code: 'EACCES' });
const SNAPSHOT = 'vfs-snapshot';
const UPDATE = 'vfs-update';
const ACK = 'vfs-ack';
const RELEASE = 'vfs-release';
const LINKS = 'vfs-links';
// Holder id of the main thread's own consumers of retired versions.
const MAIN = 'main';

// Whether the tree at `p` holds a link — `p` itself, or an entry of the
// directory it is at any depth, entering no link (disk.js); null when it
// cannot be read. Nothing there, or a path through a file, holds none: the
// call on it is left to fail natively.
const holdsLinkSync = (p) => {
  let stats;
  try {
    stats = lstatSync(p, { throwIfNoEntry: false });
  } catch (err) {
    return err.code === 'ENOTDIR' ? false : null;
  }
  if (stats === undefined || !(stats.isSymbolicLink() || stats.isDirectory())) {
    return false;
  }
  if (stats.isSymbolicLink()) return true;
  try {
    return readdirSyncBelow(p).some((entry) => entry.isSymbolicLink());
  } catch {
    return null;
  }
};

const sameSource = (stats, expected) =>
  stats.size === expected.size && stats.mtimeMs === expected.mtimeMs;

// Fill `view` with the file's bytes, refusing anything but a complete read
// of an unchanged file: stat before and after must match what the scanner
// saw, and a short read is an error, never a partially published entry.
const readInto = async (file, view) => {
  const fh = await open(file.path, 'r');
  try {
    if (!sameSource(await fh.stat(), file.stat)) {
      throw new Error(`source changed before read: ${file.path}`);
    }
    let done = 0;
    while (done < view.length) {
      const { bytesRead } = await fh.read(view, done, view.length - done, done);
      if (bytesRead === 0) throw new Error(`unexpected EOF: ${file.path}`);
      done += bytesRead;
    }
    if (!sameSource(await fh.stat(), file.stat)) {
      throw new Error(`source changed during read: ${file.path}`);
    }
  } finally {
    await fh.close();
  }
};

// Init publishes several files at a time, bounded by the libuv threadpool
// that serves both file reads and zlib: oversubscribing it only raises peak
// heap.
const initConcurrency = () => {
  const pool = Number(process.env.UV_THREADPOOL_SIZE) || 4;
  return Math.max(1, Math.min(pool, availableParallelism()));
};

// What a record of retirement names a representation of a shared tree by:
// its node's id — a node a commit kills has no key after it.
const treeKey = (id) => `#${id}`;

// The timers of an intake: the process's own.
const TIMERS = Object.freeze({
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  setImmediate: (fn) => setImmediate(fn),
});

// A counter of retireIds for a tree no books keep: a thread's own.
const counter = () => {
  let n = 0;
  return { next: () => ++n };
};

// What one publication gathers: by place and by tree what its update
// carries, its records of retirement and the representations they
// retire (rep, retireId, …), the segments its commits wrote into.
const outcome = () => ({
  places: {},
  trees: {},
  records: [],
  retired: [],
  segments: new Set(),
  empty() {
    return (
      Object.keys(this.places).length === 0 &&
      Object.keys(this.trees).length === 0
    );
  },
});

// The extent a representation lies in.
const extentOf = ({ segmentId, offset, length }) => ({
  segmentId,
  offset,
  length,
});

// The representations of a payload, the source first.
const repsOf = (payload) => {
  const reps = [];
  if (payload.source !== null) reps.push(payload.source);
  const { others } = payload;
  if (others === null) return reps;
  for (const field in others)
    if (others[field] !== null) reps.push(others[field]);
  return reps;
};

// The representation of `payload` at `offset` of segment `segmentId`, or
// null.
const repAt = (payload, segmentId, offset) => {
  if (payload === null) return null;
  for (const rep of repsOf(payload)) {
    if (rep.segmentId === segmentId && rep.offset === offset) return rep;
  }
  return null;
};

// Map a SEA asset key to a place key: `<name>/<rest>` → `/<rest>`.
const seaKeyOf = (assetKey, name) =>
  assetKey.startsWith(name + '/') && assetKey.length > name.length + 1
    ? assetKey.substring(name.length)
    : null;

// Events, in every thread: 'publish' ({ version, places: { <name>: {
// created, replaced, removed, moved } }, trees: [{ tree, seqFrom, seqTo,
// loaded }] }), once per publication this thread applies; 'close',
// once, last. Never 'error'.
class VfsKernel extends EventEmitter {
  // The books of ACK-before-free: which retired version waits for whose
  // ACK, and who still holds it. The kernel frees the bytes (#settle).
  #retirement = new Retirement();

  // Publications this thread has committed (main) or applied (worker): 0
  // before the first. Never a wall-clock time, never a retireId.
  #version = 0;

  // The main kernel that owns the pool, as every thread linked to it knows
  // it: `version` restarts with each process, so a token that has to hold
  // across a restart is `instance` and `version` together.
  #instance = randomBytes(6).toString('base64url');

  // The counter of retireIds the main thread's trees take one from for
  // every representation their commits retire: the books' own.
  #retireIds = { next: () => this.#retirement.next() };

  // A worker's view that broke — a delta it could not apply (#break): the
  // failure, the cause of every VFS call of the thread from then on; null
  // while it holds.
  #broken = null;

  // The segments an update has carried to the links. A segment stays in
  // the pool for good, the same SAB, and a snapshot carries every one: a
  // link made later has it from its snapshot, so an update carries a
  // segment once — the first that publishes into it — and never again.
  #sentSegments = new Set();

  // The books of the published extents of the shared places, by segment:
  // segmentId → place name → offset → the id of the node whose payload
  // holds it. Every commit keeps them (#book); a compaction reads its
  // segment's alone, never walking the trees. A move keeps a node's id,
  // and so the books. Main thread only.
  #books = new Map();

  // The waits for room in the pool (an intake's): told at the next free.
  #roomWaits = [];

  // Live updates of the disk-origin places: watcher epochs, one at a time,
  // published through epochs the kernel opens for it (#epoch) and commits.
  // Created before the constructor below runs: it reads the kernel only
  // when called.
  #watchPipeline = new WatchPipeline(this, (refused) => this.#epoch(refused));

  // Under strict, what the disk says of appRoot's other spellings and of
  // where a native call on a place's disk lands (aliases.js); else null.
  #aliases = null;

  // Under strict, the links known in the directories of the places with
  // `links: 'deny'` (links.js); null when there is none. The main kernel
  // fills it at initialize() and from its watcher; a worker's comes with
  // its snapshot, and grows with each `vfs-links` newer than what it holds
  // (#linksHeard: the main index's generation it has caught up with).
  #linkIndex = null;
  #linksHeard = 0;
  // Place → { key, generation, held }: the key of its directory in the
  // index and whether the index held a link below it at that generation
  // (#linkRoot).
  #linkRoots = new Map();

  // The kernel published by the bootstrap (`--import xvfs/register`).
  static get current() {
    return globalThis[KERNEL] || null;
  }

  static set current(kernel) {
    if (kernel) globalThis[KERNEL] = kernel;
    else delete globalThis[KERNEL];
  }

  constructor(config, options = {}) {
    super();
    this.config = config;
    this.appRoot = path.resolve(options.appRoot || process.cwd());
    this.console = options.console || globalThis.console;
    // Injected node:sea-compatible module, for tests.
    this.seaModule = options.seaModule || null;
    // Callbacks the domains' `prepare` names; never part of the config.
    this.preparers = new Preparers(options.preparers);
    this.state = 'new';

    const { strict } = config.global;
    // Under strict, the spellings of appRoot only the disk knows: its real
    // path, learned here, and what the other drive letters name; and where
    // a native call on a place's disk really lands (aliases.js).
    const aliases = strict
      ? new Aliases(this.appRoot, path, realpathSync.native)
      : null;
    this.#aliases = aliases;
    // Places with `links: 'deny'` refuse a native call through a known link
    // (links.js); their links are found at initialize().
    if (strict && config.places.some((pc) => pc.links === 'deny')) {
      this.#linkIndex = new LinkIndex(path, {
        floor: this.appRoot,
        caseless: CASELESS,
      });
    }
    this.registry = new PlaceRegistry(this.appRoot, path, strict, aliases);
    this.router = new FsRouter(this.registry, strict);
    this.facades = new Map(); // name → PlaceFs
    // The shared trees, by name: { name, config, tree, last,
    // intake } — `intake` on the main thread only — and their facades.
    this.trees = new Map();
    this.treeFacades = new Map(); // name → SharedTree
    // The handlers of their intakes, by tree: { onGap, onError } — the
    // main thread's.
    this.treeOptions = options.trees ?? {};

    this.cache = null;
    this.compressor = null;
    // segmentId → SAB: every segment of the pool, as the main thread makes
    // them; a worker's, as its snapshot and its updates bring them. The
    // trees of the shared places read their representations through it.
    this.segmentsMap = new Map();

    this.links = new Map(); // linkId → MessagePort (workers created via link())
    this.nextLinkId = 0;
    this.nextUpdateId = 0;
    // Direct consumers of shared bytes in this thread (streams, leases);
    // their releases reach handleRelease on this object, as a worker's do.
    this.pins = new Pins((ids) => this.handleRelease(MAIN, ids));
    // Per-(place, key) ordering of virtual mutations.
    this.mutations = new MutationQueue();
    // Worker side of the link; null on the main thread.
    this.port = null;
    this.mutationClient = null;
  }

  get ready() {
    return this.state === 'ready';
  }

  // The version of the last publication this thread committed or applied.
  get version() {
    return this.#version;
  }

  get instance() {
    return this.#instance;
  }

  // What broke this worker's view (#break), or null.
  get broken() {
    return this.#broken;
  }

  // The refusal of `what` on a kernel that is not ready.
  // A call a kernel not ready refuses: a closed kernel with the code of
  // every refusal close() causes, ERR_VFS_CLOSED — a broken view with what
  // broke it as the cause (#break).
  #notReady(what) {
    if (this.#broken !== null) return brokenError(this.#broken);
    const err = new Error(
      `[vfs] ${what} requires a ready kernel (state: ${this.state})`,
    );
    if (this.state === 'closed') err.code = 'ERR_VFS_CLOSED';
    return err;
  }

  #ensureReady(what) {
    if (this.state !== 'ready') throw this.#notReady(what);
  }

  // --- Lifecycle ---

  async initialize() {
    if (this.state !== 'new') {
      throw new Error(`[vfs] initialize() called in state "${this.state}"`);
    }
    this.state = 'initializing';
    try {
      const { memory } = this.config.global;
      this.cache = new FilesystemCache({
        limit: memory.limit,
        segmentSize: memory.segmentSize,
        maxFileSize: memory.maxFileSize,
        reader: readInto,
        segments: this.segmentsMap,
        onFree: () => this.#freed(),
      });
      this.compressor = new Compressor({ console: this.console });
      for (const [index, pc] of this.config.places.entries()) {
        const place = new Place(pc, this.appRoot);
        place.dev = index + 1;
        this.#homed(place);
        // Every preparer an enabled place names must exist before anything
        // is read.
        place.preparers = this.preparers.bind(place, true);
        place.store = this.#storeOf(place);
        // Shared places are in every snapshot, even while empty.
        this.#plant(place);
        this.registry.register(place);
      }
      for (const tc of this.config.trees) {
        this.trees.set(tc.name, this.#treeHost(tc));
      }
      if (this.#linkIndex !== null) await this.#indexLinks();
      const ep = newEpoch(INIT);
      for (const place of this.registry.all()) {
        const origin = await this.#originOf(place);
        if (origin) await this.#publishAll(ep, place, origin);
      }
      alive(this);
      this.#flush(ep);
      this.state = 'ready';
    } catch (err) {
      this.close();
      throw err;
    }
    if (this.#watchRequired()) this.watch();
  }

  // Final: stops watching, drops pending work, every tree and every
  // active stream. Nothing reaches the pool afterwards, so the caches go
  // too and the SAB segments become collectable. No 'publish' listener is
  // called once it returns; the first call emits 'close' in a microtask,
  // then drops every listener.
  close() {
    const first = this.state !== 'closed';
    this.state = 'closed';
    this.#watchPipeline.close();
    for (const port of this.links.values()) port.close();
    this.links.clear();
    // Queued mutations reject on the closed kernel; workers learn through
    // the closed port.
    this.mutations.clear();
    // Nothing guards shared bytes any more: active streams stop.
    this.pins.close();
    if (this.mutationClient) this.mutationClient.close(closedError);
    // A worker's closed link reads as its exit on the main thread.
    if (this.port) this.port.close();
    this.#retirement.clear();
    this.segmentsMap.clear();
    this.facades.clear();
    this.#books.clear();
    for (const place of this.registry.all()) place.tree = null;
    for (const host of this.trees.values()) {
      host.intake?.close();
      host.tree = null;
    }
    this.treeFacades.clear();
    this.#freed();
    this.cache = null;
    this.compressor = null;
    if (!first) return;
    queueMicrotask(() => {
      try {
        this.emit('close');
      } finally {
        this.removeAllListeners();
      }
    });
  }

  // Under strict, a place with a directory on disk whose real path lies in
  // the territory the kernel manages but is not its own — a link to
  // another place, to appRoot, above it (Aliases.misplaced) — is a
  // configuration error: its scan, its watcher and its native calls would
  // serve that territory under the place's name and policy. A directory
  // elsewhere, a link out of appRoot, is the place's own.
  #homed(place) {
    if (this.#aliases === null || place.virtual) return;
    if (place.provider === 'sea') return;
    const real = this.#aliases.misplaced(place.root);
    if (real === null) return;
    throw new Error(
      `[vfs config] places.${place.name}: under strict its directory ` +
        `resolves to ${real}, in the territory appRoot manages`,
    );
  }

  // Under strict, the links in the directory of every place with `links:
  // 'deny'`, found before anything is served: the scan of a disk-origin
  // place meets them (#originOf); a `disk` or `node-default` place, which
  // no scan walks, is walked here — readdir only, entering no link
  // (scanner.js, linksOf). A place's own directory may be a link out of
  // appRoot (#homed); only what lies below it is indexed.
  async #indexLinks() {
    const index = this.#linkIndex;
    const stopped = () => this.state === 'closed';
    const places = this.registry
      .all()
      .filter(
        (place) =>
          place.config.links === 'deny' && !INDEXED.has(place.provider),
      );
    await Promise.all(
      places.map(async (place) => {
        for (const link of await linksOf(place.root, { stopped })) {
          index.add(link);
        }
      }),
    );
  }

  // What the watcher learns of a path in a place with `links: 'deny'`: a
  // link there is known from now on, and so are the links inside a
  // directory there (a move-in) — `found`, when the job's rescan met them,
  // else a walk. The place's own directory is never indexed — it may be a
  // link out of appRoot (#homed) — but what lies below it is. Nothing is
  // dropped: a link removed stays refused until the kernel restarts.
  async noteLinks(place, filePath, found = null) {
    const index = this.#linkIndex;
    if (index === null || place.config.links !== 'deny') return;
    const root = index.key(filePath) === this.#linkRoot(place).key;
    const stats = await lstat(filePath).catch(() => null);
    if (!stats) return;
    if (!root && stats.isSymbolicLink()) {
      return void this.#learnLinks([filePath]);
    }
    if (!root && !stats.isDirectory()) return;
    const stopped = () => this.state === 'closed';
    this.#learnLinks(
      found ?? (await linksOf(place.root, { startPath: filePath, stopped })),
    );
  }

  // Links the main kernel found: known from now on, and sent to every
  // linked worker with the index's generation — a worker linked later has
  // them in its snapshot.
  #learnLinks(links) {
    const index = this.#linkIndex;
    const add = [];
    for (const link of links) {
      const key = index.add(link);
      if (key !== null) add.push(key);
    }
    if (add.length === 0) return;
    const msg = { name: LINKS, add, generation: index.generation };
    for (const port of this.links.values()) port.postMessage(msg);
  }

  // A worker's `vfs-links` from the main kernel; one no newer than what
  // this thread holds — its snapshot, an earlier message — changes nothing.
  #heardLinks(msg) {
    const index = this.#linkIndex;
    if (index === null || !Array.isArray(msg.add)) return;
    if (!(msg.generation > this.#linksHeard)) return;
    for (const key of msg.add) index.add(key);
    this.#linksHeard = msg.generation;
  }

  // Whether a native call on `filePath` in `place` (`links: 'deny'`) passes
  // through a link the index knows (#proven). A path with no `..` names
  // only the place's directory and what lies below it: where the index
  // knows no link there, it is answered at once.
  #crosses(place, filePath, own = false) {
    const index = this.#linkIndex;
    if (!filePath.includes('..') && !this.#linkRoot(place).held) {
      return false;
    }
    return index.crosses(filePath, own);
  }

  // A place's directory in the index: its key, once per place, and whether
  // a known link lies below it — asked again once the index knows more.
  #linkRoot(place) {
    const index = this.#linkIndex;
    let root = this.#linkRoots.get(place);
    if (root === undefined) {
      root = { key: index.key(place.root), generation: -1, held: false };
      this.#linkRoots.set(place, root);
    }
    if (root.generation !== index.generation) {
      root.held = index.holds(root.key);
      root.generation = index.generation;
    }
    return root;
  }

  // --- Providers ---

  // The mutation engine of a place in this thread: a per-thread Map, the
  // main kernel's allocator (sab + virtual) or the link to it (worker).
  // Null when writes go to disk or the place is read-only.
  #storeOf(place) {
    if (place.provider === 'map') return new MapStore(place);
    if (place.provider !== 'sab' || !place.virtual) return null;
    if (this.cache) return new SabStore(place, this);
    return this.mutationClient
      ? new RemoteStore(place, this.mutationClient)
      : null;
  }

  // The tree of an indexed place in this thread, empty: the main kernel's
  // own for a shared place, which every worker replicates; a `map`
  // place's own in every thread, its bytes in its store's buffers. In a
  // worker, `snapshot` is the replica's — what the main tree's snapshot
  // carries for the place — and null where it carries none; a caseless
  // place learns the spellings of what the replica holds. The place's
  // `stat` attributes decide what payloads hold (config.js).
  #plant(place, snapshot = undefined) {
    if (!INDEXED.has(place.provider)) return;
    if (snapshot) {
      const tree = fromSnapshot(snapshot, this.segmentsMap);
      place.tree = tree;
      if (!place.caseless) return;
      const keys = [];
      for (const [node] of tree.walk(tree.get(''), { containers: 'skip' })) {
        keys.push(tree.pathOf(node));
      }
      place.spelled(keys, [], []);
      return;
    }
    const { birthtime, directories } = place.config.stat;
    const store = place.provider === 'map' ? place.store : null;
    const local = store !== null || snapshot === null;
    place.tree = createTree({
      sep: path.sep,
      segments: local ? (store?.segments ?? new Map()) : this.segmentsMap,
      retireIds: local ? (store?.retireIds ?? counter()) : this.#retireIds,
      birthtime,
      directories,
      now: Date.now(),
    });
  }

  // A shared tree on the main thread (doc/architecture.md, "Shared trees"):
  // the main tree over the pool, the intake of its batches
  // with the handlers the kernel was given for it, and the number of the
  // last batch its publications showed. Its root comes with the source's
  // first put of one.
  #treeHost(config) {
    const { name } = config;
    const handlers = this.treeOptions[name];
    const { onGap, onError } = handlers ?? {};
    if (typeof onGap !== 'function' || typeof onError !== 'function') {
      throw new Error(
        `[vfs] trees.${name}: the kernel option trees.${name} needs ` +
          'onGap and onError on the main thread',
      );
    }
    const tree = createTree({
      ids: config.ids,
      containers: config.containers,
      birthtime: config.birthtime,
      aggregates: config.aggregates,
      maxNodes: config.maxNodes,
      sep: '/',
      segments: this.segmentsMap,
      retireIds: this.#retireIds,
    });
    const host = { name, config, tree, last: null, intake: null };
    host.intake = new Intake({
      tree,
      kernel: {
        version: () => this.#version,
        publish: (results, seq) => this.#publishTree(host, results, seq),
        fatal: (err) => this.#fatal(name, err),
      },
      pool: {
        place: (bytes) => this.#placeBytes(bytes),
        free: (extent) => this.cache?.free(extent),
        room: () => new Promise((resolve) => this.#roomWaits.push(resolve)),
      },
      compress: (bytes, nodeName) => this.#compressed(config, bytes, nodeName),
      clock: { now: () => Date.now() },
      timers: TIMERS,
      onGap,
      onError,
      settings: {
        ...config.intake,
        ids: config.ids,
        maxFileSize: config.maxFileSize,
      },
    });
    return host;
  }

  // An extent of a payload's bytes in the pool, or null while it has no
  // room: the intake's own cap (maxFileSize of the tree) is checked before.
  async #placeBytes(bytes) {
    if (this.cache === null) return null;
    const file = { data: bytes, stat: { size: bytes.length } };
    return this.cache.allocate(file, { maxFileSize: Infinity });
  }

  // The compressed representations of a tree's payload, by kind: the
  // codecs of its `compress` — for a node whose name's extension it
  // lists, when it lists any.
  async #compressed(config, bytes, nodeName) {
    const { compress } = config;
    if (!compress || this.compressor === null) return [];
    if (compress.ext && !compress.ext.includes(fileExt(nodeName))) return [];
    const owner = `tree "${config.name}"`;
    const built = await this.compressor.encode(
      compress.codecs,
      bytes,
      owner,
      nodeName,
    );
    const out = [];
    for (const { encoding, data } of built) {
      if (data) out.push([COMPRESSED[encoding], data]);
    }
    return out;
  }

  // The pool freed something: the waits for room try again.
  #freed() {
    if (this.#roomWaits.length === 0) return;
    const waits = this.#roomWaits;
    this.#roomWaits = [];
    for (const resolve of waits) resolve();
  }

  // What the tree `name` threw in its intake's run that is no refusal — an
  // engine bug — or a publication of it the kernel could not make: the
  // tree is ahead of the other threads, or cannot be trusted, and the
  // kernel closes, as a commit of a place does (#commitPlace). A kernel
  // closed already has nothing to tell.
  #fatal(name, err) {
    if (this.state === 'closed') return;
    this.console.error(`[vfs] tree "${name}": ${err?.message ?? err}`);
    this.close();
  }

  // The public API of a shared tree, in every thread (SharedTree).
  tree(name) {
    this.#ensureReady('tree()');
    let facade = this.treeFacades.get(name);
    if (facade) return facade;
    const host = this.trees.get(name);
    if (!host) throw new Error(`[vfs] unknown tree "${name}"`);
    facade = new SharedTree(host, this, this.#writer(host));
    this.treeFacades.set(name, facade);
    return facade;
  }

  // Where a tree's batches and loads go: its intake on the main thread;
  // in a worker, the link — checked and taken here first, as the intake
  // does, so that a wrong one is refused at once in every thread, and what
  // crosses is the worker's own copy, transferred.
  #writer(host) {
    if (host.intake !== null) {
      return (kind, request) => this.writeTree(host.name, kind, request);
    }
    const settings = { ...host.config.intake, ids: host.config.ids };
    return (kind, request) => {
      const owned =
        kind === 'submit'
          ? checkBatch(settings, request)
          : {
              seq: request.seq,
              rows: checkLoad(settings, request.rows, request.seq),
            };
      if (this.mutationClient === null) {
        return Promise.reject(closedError());
      }
      return this.mutationClient.sendTree(host.name, kind, owned);
    };
  }

  // A batch or a load of a tree's source, on the main thread: the facade's,
  // or a worker's (mutation-rpc.js) — what its intake resolves. `copy`:
  // false for a worker's, whose bytes came transferred (Intake.submit).
  writeTree(name, kind, request, copy = true) {
    const host = this.trees.get(name);
    if (!host?.intake) throw new Error(`[vfs] unknown tree "${name}"`);
    if (kind === 'submit') {
      return host.intake.submit({ seq: request.seq, ops: request.ops }, copy);
    }
    if (kind === 'load') {
      return host.intake.load(request.rows, request.seq, copy);
    }
    throw new Error(`[vfs] a tree takes submit and load, not "${kind}"`);
  }

  // Raw inputs of a place's origin at init, `{ files, dirs }`: a disk scan
  // — every directory, every file — or the embedded SEA assets. Virtual
  // places start empty: their content arrives through fs mutations; disk
  // and node-default places are never indexed. The scan stops at close().
  async #originOf(place) {
    const { provider } = place;
    if (provider === 'sea') return this.#seaAssets(place);
    if (!INDEXED.has(provider) || place.virtual) return null;
    const links = place.config.links === 'deny' ? [] : null;
    const dirs = [];
    const files = await scan(place.root, {
      ext: place.config.scanExt,
      followSymlinks: !this.config.global.strict,
      stopped: () => this.state === 'closed',
      links,
      dirs,
    });
    for (const link of links ?? []) this.#linkIndex.add(link);
    return { files, dirs };
  }

  // SEA assets named `<place>/<key>` go through the pipeline once, at init;
  // the place then behaves exactly like a sab place (snapshot, zero-copy,
  // no watcher).
  #seaAssets(place) {
    const sea = this.seaModule || this.#loadSea();
    if (!sea) {
      this.console.warn(
        `[vfs] place "${place.name}": node:sea unavailable; place is empty`,
      );
      return null;
    }
    const assets = new Map();
    const mtimeMs = Date.now();
    const { scanExt } = place.config;
    for (const assetKey of sea.getAssetKeys()) {
      const key = seaKeyOf(assetKey, place.name);
      if (key === null) continue;
      if (scanExt && !scanExt.includes(fileExt(key))) continue;
      const data = Buffer.from(sea.getAsset(assetKey));
      assets.set(key, { data, stat: { size: data.length, mtimeMs } });
    }
    return { files: assets, dirs: [] };
  }

  #loadSea() {
    try {
      const sea = require('node:sea');
      return sea.isSea() ? sea : null;
    } catch {
      return null;
    }
  }

  // Init: every directory of one origin, then every file through the
  // pipeline, largest first (it packs segments better), a few at a time.
  // The first failure stops the rest and aborts initialize(), like any
  // unreadable source.
  async #publishAll(ep, place, { files, dirs }) {
    for (const key of dirs) this.#directory(ep, place, key);
    const queue = [...files].sort((a, b) => b[1].stat.size - a[1].stat.size);
    await pool(queue, initConcurrency(), ([key, file]) =>
      this.#publishEntry(ep, place, key, file),
    );
  }

  // --- Consumer API ---

  // Per-Place file API; only for places with an fs domain on an indexed
  // provider — disk and node-default places are plain node:fs territory.
  fs(name) {
    this.#ensureReady('fs()');
    let facade = this.facades.get(name);
    if (facade) return facade;
    const place = this.registry.get(name);
    if (!place) throw new Error(`[vfs] unknown place "${name}"`);
    if (!place.config.fs)
      throw new Error(`[vfs] place "${name}" has no fs domain`);
    if (!INDEXED.has(place.provider)) {
      throw new Error(
        `[vfs] place "${name}" (${place.provider}) is served by node:fs directly`,
      );
    }
    facade = new PlaceFs(place, this.pins, this, this.#territory(place));
    this.facades.set(name, facade);
    return facade;
  }

  // { segments: [{ id, sab }], places: { name: tree snapshot }, trees: {
  //   name: { snapshot, last } }, version, instance, links? }
  // Every shared place's tree as it is published: a publication in
  // progress is not part of it. `links`, with a place of `links: 'deny'`:
  // { known: [path], generation } — the index, and how many links it has
  // come to know (#learnLinks).
  snapshot() {
    this.#ensureReady('snapshot()');
    if (!this.cache) throw new Error('[vfs] snapshot() is main-thread only');
    const places = {};
    for (const place of this.registry.all()) {
      if (SHARED.has(place.provider))
        places[place.name] = place.tree.snapshot();
    }
    const trees = {};
    for (const host of this.trees.values()) {
      trees[host.name] = { snapshot: host.tree.snapshot(), last: host.last };
    }
    const snapshot = {
      segments: this.cache.snapshot(),
      places,
      trees,
      version: this.#version,
      instance: this.#instance,
    };
    if (this.#linkIndex !== null) {
      snapshot.links = {
        known: this.#linkIndex.list(),
        generation: this.#linkIndex.generation,
      };
    }
    return snapshot;
  }

  // Everything a worker needs, ready for `new Worker(file, { workerData:
  // { vfs }, transferList })`: config, appRoot and a private MessagePort
  // whose first message is the snapshot — taken and posted in the step that
  // connects the port, so every update after it follows it in order. The
  // `vfs` object carries no snapshot: workerData lives as long as the
  // worker, and the snapshot would with it; attach() takes it off the port
  // and drops it. Deltas flow to the port, ACKs and releases come back, and
  // the worker's exit closes the port.
  link() {
    const snapshot = this.snapshot();
    const { port1, port2 } = new MessageChannel();
    const id = `link:${++this.nextLinkId}`;
    port1.on('message', (msg) => {
      if (msg?.name === ACK) this.handleAck(msg.updateId, id, msg.retained);
      else if (msg?.name === RELEASE) this.handleRelease(id, msg.retireIds);
      else if (msg?.name === MUTATE) serveMutation(this, id, port1, msg);
    });
    port1.on('close', () => {
      this.links.delete(id);
      this.handleWorkerExit(id);
    });
    port1.unref();
    this.links.set(id, port1);
    port1.postMessage({ name: SNAPSHOT, snapshot });
    const vfs = { config: this.config.raw, appRoot: this.appRoot, port: port2 };
    return { vfs, transferList: [port2] };
  }

  // Retired versions not yet freed, for diagnostics: which representation
  // is held, by whom, how large, for how long, and whether it still waits
  // for worker ACKs or only for consumers to release it.
  retirements() {
    return this.#retirement.list();
  }

  // What the shared memory holds and why, as of the call (README,
  // Diagnostics): the pool's usage and fragmentation; what the published
  // versions take of it; the retired representations and what they wait
  // for; what the main thread's streams and leases still hold; for each
  // linked worker, the updates it has not ACKed — the age of the oldest
  // shows a worker that is stuck — and what it holds; the sources read
  // from disk, the pool having had no room for them; the preparations that
  // failed, by place; and the work queued — watcher epochs and rechecks,
  // mutations and barriers of virtual places. Taken from the pool, the
  // books, the links, the index and the queues when asked — nothing is
  // counted on a read or a publication but a failed preparation — and
  // read-only: it frees, settles and compacts nothing. A frozen plain
  // object; main thread only.
  diagnostics() {
    this.#ensureReady('diagnostics()');
    if (!this.cache) {
      throw new Error('[vfs] diagnostics() is main-thread only');
    }
    const now = Date.now();
    const books = this.#retirement;
    const { published, disk } = this.#indexed();
    const places = {};
    let failures = 0;
    for (const place of this.registry.all()) {
      if (!place.config.prepare) continue;
      places[place.name] = place.preparationFailures;
      failures += place.preparationFailures;
    }
    return deepFreeze({
      pool: this.cache.usage(),
      published,
      retired: books.summary(now),
      main: { held: books.heldBy(MAIN, now) },
      links: [...this.links.keys()].map((id) => ({
        id,
        pending: books.pendingOf(id, now),
        held: books.heldBy(id, now),
      })),
      disk,
      trees: this.#treesState(),
      preparation: { failures, places },
      strict: this.#strictState(),
      queues: {
        watch: { epochs: this.watchQueue.size, rechecks: this.rechecks.size },
        mutations: {
          keys: this.mutations.size,
          barriers: this.mutations.barriers,
        },
      },
    });
  }

  // Each shared tree as diagnostics() shows it: its live nodes, the
  // payloads among them and what their representations take of the pool,
  // the number of the last batch it shows; whether its intake holds the
  // batches, and how many wait in it.
  #treesState() {
    const trees = {};
    for (const host of this.trees.values()) {
      const { tree, intake } = host;
      let nodes = 0;
      let payloads = 0;
      let bytes = 0;
      const count = (node) => {
        nodes++;
        const payload = tree.payloadOf(node);
        if (payload === null) return;
        payloads++;
        for (const rep of repsOf(payload)) bytes += rep.length;
      };
      const root = tree.get('');
      if (root !== null) {
        count(root);
        for (const [node] of tree.walk(root)) count(node);
      }
      trees[host.name] = {
        nodes,
        payloads,
        bytes,
        last: host.last,
        held: intake.held,
        waiting: intake.waiting,
      };
    }
    return trees;
  }

  // Strict routing as diagnostics() shows it: each place's `links` — 'deny'
  // or 'verify', for a place with a directory on disk — and how many links
  // the index knows; null without strict.
  #strictState() {
    if (!this.config.global.strict) return null;
    const links = {};
    for (const place of this.registry.all()) {
      if (place.config.links !== null) links[place.name] = place.config.links;
    }
    return { links, known: this.#linkIndex?.size ?? 0 };
  }

  // One walk of the trees: the files the shared places publish and what
  // their representations take of the pool; the files read from disk, and
  // among them those the pool had no room for when they were published:
  // neither larger than their place's maxFileSize nor kept on disk by
  // `retainRaw: false`.
  #indexed() {
    const published = { files: 0, bytes: 0 };
    const disk = { files: 0, bytes: 0, fallback: { files: 0, bytes: 0 } };
    for (const place of this.registry.all()) {
      if (!SHARED.has(place.provider)) continue;
      const { tree } = place;
      for (const [node] of tree.walk(tree.get(''), { containers: 'skip' })) {
        const payload = tree.payloadOf(node);
        published.files++;
        for (const rep of repsOf(payload)) published.bytes += rep.length;
        if (payload.source !== null) continue;
        const { size } = payload;
        disk.files++;
        disk.bytes += size;
        if (size > place.config.maxFileSize) continue;
        if (keptOnDisk(this, place, '/' + tree.nameOf(node))) continue;
        disk.fallback.files++;
        disk.fallback.bytes += size;
      }
    }
    return { published, disk };
  }

  // --- Virtual places ---

  // Order one mutation against the others: per-key FIFO in arrival order,
  // or an exclusive place barrier when `keys` is null (subtree operations).
  // Worker requests and main-thread writes share the queue, so the state a
  // store validates against is the state its publication is applied to.
  // A mutation still queued when the kernel closes is refused in the words
  // of any call that needs a ready kernel, as the closed kernel
  // (ERR_VFS_CLOSED).
  enqueueMutation(place, keys, fn) {
    return this.mutations.run(place.name, keys, () => {
      if (this.state !== 'ready') throw this.#notReady('mutations');
      return fn();
    });
  }

  // Publish one canonical version of a virtual key through the pipeline, as
  // one `vfs-update`. Rejects without publishing anything when a required
  // step fails — or the kernel closes before the commit (#commit); no
  // debounce or coalescing — one accepted mutation, one update.
  // Publications of different keys may overlap: allocations stay private
  // until #flush commits them.
  async publishVirtual(place, key, raw) {
    const ep = newEpoch(OPS);
    const stat = { size: raw.length, mtimeMs: Date.now() };
    await this.#publishEntry(ep, place, key, { data: raw, stat });
    this.#commit(ep, opening(place, key));
  }

  // Publish a set of virtual files as one (writeFiles): one epoch, each
  // file through the pipeline in the order given — its preparer runs once
  // — under one mtime, then one commit, which makes the directories they
  // lack: one `vfs-update`, one version, one event. A file that fails
  // abandons the set: the allocations of the files before it go back to
  // the pool, nothing is published. One at a time: a failure stops the
  // rest, and nothing can stage after it. What the pipeline refuses about a
  // key, `failOf(key)` — the set's — names. Resolves with the version of
  // the commit. A set names each key once: a key twice is a caller's
  // error, refused before anything is placed, prepared or committed, as
  // PlaceFs.writeFiles refuses it — what a set publishes must not hang
  // on the order of its files.
  async publishVirtualBatch(place, files, failOf) {
    const keys = new Set();
    for (const [key] of files) {
      if (keys.has(key)) {
        const named = JSON.stringify(key);
        throw new TypeError(`[vfs] publishVirtualBatch: ${named} twice`);
      }
      keys.add(key);
    }
    const ep = newEpoch(OPS);
    const mtimeMs = Date.now();
    try {
      for (const [key, raw] of files) {
        const file = { data: raw, stat: { size: raw.length, mtimeMs } };
        await this.#publishEntry(ep, place, key, file, failOf(key), PARENTS);
      }
    } catch (err) {
      this.#abandon(ep);
      throw err;
    }
    const first = files[0][0];
    return this.#commit(ep, (code, detail, key) =>
      failOf(key ?? first)(code, detail),
    );
  }

  // Ops of a virtual place's tree that change its structure only —
  // `mkdir`, `unlink`, `remove`, `rmdir`, `move` — committed at once, in
  // the step its store checked them in, as one `vfs-update`; returns the
  // version of the commit. A refusal of the tree, which the store's checks
  // leave none of, is `fail`'s.
  changeVirtual(place, ops, fail) {
    const ep = newEpoch(OPS);
    placeEpoch(ep, place).ops.push(...ops);
    return this.#commit(ep, fail);
  }

  // A file moved under a key whose pipeline makes something else of it
  // (VirtualStore, movesAsIs): `ops` — the replaced destination's removal,
  // the move — then a write of its raw bytes, `raw`, under its new key `to`
  // through the pipeline, prepared when that extension has a preparer,
  // keeping `mtimeMs`, like a rename on disk — in one commit: the node, its
  // id and `ino` move, its payload is new. A failure publishes nothing;
  // what the pipeline refuses, `fail` — the rename's — names.
  async moveVirtual(place, ops, to, raw, mtimeMs, fail) {
    const ep = newEpoch(OPS);
    placeEpoch(ep, place).ops.push(...ops);
    const stat = { size: raw.length, mtimeMs };
    await this.#publishEntry(ep, place, to, { data: raw, stat }, fail);
    this.#commit(ep, fail);
  }

  // --- Adapter API ---
  // Consumed by lib/adapters/*, not by application code: these return raw
  // routing decisions and borrowed views, without the ownership and ext
  // policies PlaceFs applies.

  // `own`: an operation on the path's last name itself, which it does not
  // follow — lstat, readlink, unlink, rmdir, rm, rename, the l* forms
  // (#proven).
  routeRead(filePath, own = false) {
    this.#live(filePath);
    return this.#proven(this.router.read(filePath), filePath, own);
  }

  routeMutation(filePath, own = false) {
    this.#live(filePath);
    return this.#proven(this.router.mutate(filePath), filePath, own);
  }

  routeCopy(filePath, recursive) {
    this.#live(filePath);
    return this.#proven(this.router.copy(filePath, recursive), filePath);
  }

  // The patch routes both paths as mutations first, which proves them.
  routeRename(fromPath, toPath) {
    this.#live(fromPath);
    this.#live(toPath);
    return this.router.rename(fromPath, toPath);
  }

  routeLink(fromPath, toPath) {
    this.#live(fromPath);
    this.#live(toPath);
    const route = this.router.link(fromPath, toPath);
    if (route.kind !== 'passthrough' || this.#aliases === null) return route;
    const source = this.routeRead(fromPath);
    if (source.kind === 'deny') return source;
    const target = this.routeMutation(toPath);
    return target.kind === 'deny' ? target : route;
  }

  // Under strict the patch makes, removes and moves no link on a place's
  // disk — a place with a directory there, `links` 'deny' or 'verify'
  // alike: a call that would is ENOTSUP before any native call. Nor does
  // it remove or move a directory through one: a tree goes, or moves,
  // only where the place's directory really is — past a link out of it the
  // tree is another's, and one moved out would take its own links along.
  // What the patch asks, each once its routing has passed:
  //   makesLink(p)       `symlink` or `link` at `p`, a `cp` of a link to it:
  //                      whether `p` lies on such a disk;
  //   touchesLink(p, tree)  `unlink`, `rmdir`, `rm` of `p`: whether `p` is a
  //                      link there (the lstat of the entry it names: one
  //                      the watcher has not reported yet included) or,
  //                      for a recursive one of a directory, whether the
  //                      index knows a link below it ('deny') or its real
  //                      path leaves the place's directory (#inPlace);
  //   movesLink(from, to)   `rename`: why it would move a link there, or
  //                      null — `from` or a link below it the index knows,
  //                      a directory `from` whose real path, or that of
  //                      `to`, leaves the place's directory, a link at `to`
  //                      it would replace (LINKED), or a tree from outside
  //                      appRoot that holds one (a walk of `from`), or
  //                      cannot be read (UNCHECKED).
  // The PlaceFs facade asks the same of its disk mutations. What they know
  // is a link's lstat, a directory's real path and, with 'deny', the index:
  // a link another process swaps in between the answer and the call is not
  // seen. Without strict, and elsewhere, the answer is always no.
  makesLink(filePath) {
    return this.#onPlaceDisk(filePath) !== null;
  }

  touchesLink(filePath, tree = false) {
    const place = this.#onPlaceDisk(filePath);
    if (place === null) return false;
    const stats = leafStats(filePath);
    if (stats?.isSymbolicLink()) return true;
    if (!tree || !stats?.isDirectory()) return false;
    return this.#holdsLinks(place, filePath) || !this.#inPlace(place, filePath);
  }

  movesLink(from, to) {
    const source = this.#onPlaceDisk(from);
    if (source !== null) {
      const stats = leafStats(from);
      if (stats?.isSymbolicLink() || this.#holdsLinks(source, from)) {
        return LINKED;
      }
      if (
        stats?.isDirectory() &&
        !(this.#inPlace(source, from) && this.#inPlace(source, to))
      ) {
        return LINKED;
      }
    }
    if (this.#onPlaceDisk(to) === null) return null;
    if (isLink(to)) return LINKED;
    if (this.registry.route(from) !== null) return null;
    const holds = holdsLinkSync(from);
    if (holds === null) return UNCHECKED;
    return holds ? LINKED : null;
  }

  // Under strict, the place whose disk `filePath` lies on — a place with a
  // directory there, its own directory included — else null.
  #onPlaceDisk(filePath) {
    if (this.#aliases === null) return null;
    const place = this.registry.route(filePath)?.place;
    return place && place.config.links !== null ? place : null;
  }

  // Whether the index knows a link at `filePath` or below it, in `place`
  // with `links: 'deny'`.
  #holdsLinks(place, filePath) {
    if (place.config.links !== 'deny') return false;
    return this.#linkIndex.holds(this.#linkIndex.key(filePath));
  }

  // Whether `filePath` really lies in `place`'s directory, whatever its
  // `links`: a tree removed or moved there takes nothing from elsewhere,
  // and one moved there leaves nothing of the place elsewhere — a realpath
  // (Aliases.territory, `placed`).
  #inPlace(place, filePath) {
    return this.#aliases.territory(place.root, filePath, true) !== null;
  }

  // Under strict, whether a new link to this path — a symbolic link's
  // target as the OS resolves it — would name managed territory. `..` past
  // a symbolic link is caught where the target is routed (the disk proof,
  // and the router's climb-out rule on POSIX), not here: the target is
  // handed on unfolded.
  linksInto(filePath) {
    return this.router.linksInto(filePath);
  }

  // Under strict a native route on a place's disk — node:fs on the path as
  // given — follows the place's `links`:
  //   'deny'    it holds unless the path passes through a link the kernel
  //             knows (LinkIndex.crosses; its last name excepted for an
  //             operation on it, `own`) — no disk call for an ordinary path;
  //   'verify'  it holds only where the disk says the path really lies: in
  //             the place's directory, or off appRoot's line
  //             (Aliases.territory, one realpath); and in the disk
  //             territory of `fs.fallback: 'disk'` never on a file of an
  //             extension the place caches, which a link names another way.
  // Else it is EACCES, before any native call.
  #proven(route, filePath, own = false) {
    if (this.#aliases === null || route.place === undefined) return route;
    if (route.kind !== 'passthrough' && route.kind !== 'disk') return route;
    if (route.place.config.links === 'deny') {
      return this.#crosses(route.place, filePath, own) ? UNPROVEN : route;
    }
    const real = this.#aliases.territory(route.place.root, filePath);
    if (real === null) return UNPROVEN;
    const cached = route.place.cached(path.basename(real));
    return route.kind === 'disk' && cached ? UNPROVEN : route;
  }

  // Under strict, where a path on `place`'s disk lies, when its native
  // calls may go there, else null — as #proven decides it — for PlaceFs;
  // null without strict.
  #territory(place) {
    const aliases = this.#aliases;
    if (aliases === null) return null;
    if (place.config.links === 'deny') {
      return (filePath, own = false) =>
        this.#crosses(place, filePath, own) ? null : filePath;
    }
    return (filePath) => aliases.territory(place.root, filePath);
  }

  // Once this worker's view broke (#break), a path an indexed place owns
  // is the closed kernel's, with the failure as its cause; the rest of the
  // disk stays node:fs.
  #live(filePath) {
    if (this.#broken === null) return;
    const place = this.registry.route(filePath)?.place;
    if (place && INDEXED.has(place.provider)) throw brokenError(this.#broken);
  }

  // A node:fs function the patch does not know: refused under strict.
  routeUnknown() {
    return this.router.unknown();
  }

  // appRoot or a directory above it: a native walk from there enters the
  // places past their routing.
  enclosesPlaces(filePath) {
    return this.registry.encloses(filePath);
  }

  // A place's own directory, which the patch's `unlink`, `rmdir` and `rm`
  // never remove: an indexed place's mount, as PlaceFs keeps it, and under
  // strict any place's. (A rename moves no directory across a place's
  // boundary — FsRouter.rename — but a disk place's directory may be
  // renamed into place from outside, a tree without links.)
  keepsRoot(filePath) {
    const route = this.registry.route(filePath);
    if (!route?.place || route.key !== '') return false;
    return INDEXED.has(route.place.provider) || this.config.global.strict;
  }

  // Why a native operation on the whole tree at a path — a recursive rm or
  // rmdir — would act past a rule below it in its place: EACCES, EROFS, or
  // null (FsRouter.below).
  rulesBelow(filePath) {
    return this.router.below(filePath)?.code ?? null;
  }

  // Why a native recursive mkdir of a path would make a directory above it
  // that the rules of its place refuse: EACCES under strict, EROFS, or null
  // — the disk says which directories are there already
  // (Place.makesParents).
  makesParents(filePath) {
    const route = this.registry.route(filePath);
    const place = route?.place;
    if (!place || place.rules === null) return null;
    const exists = (dir) =>
      lstatSync(place.pathOf(dir), { throwIfNoEntry: false }) !== undefined;
    return place.makesParents(route.key, exists, this.config.global.strict);
  }

  // What a strict appRoot lists: the enabled places, sorted.
  rootEntries() {
    return this.registry
      .all()
      .map((place) => place.name)
      .sort();
  }

  // Module lookup for the require / import hooks.
  //   { place, key, payload }  published source visible to `domain`, held
  //                         in memory
  //   { denied: true }      strict routing: nothing published for this path;
  //                         or, in any mode, a published source named with
  //                         a trailing separator — a directory, no module;
  //                         or, under strict, a module of a node-default or
  //                         disk place `loading` behind a known link
  //                         (`links: 'deny'`) or that really lies
  //                         elsewhere ('verify')
  //   null                  not ours — default Node loader
  // `loading`: the load hook asks, about the file Node's loader is to read.
  resolveModule(filePath, domain, loading = false) {
    this.#live(filePath);
    const route = this.registry.route(filePath);
    if (!route) return null;
    const { place } = route;
    const denied = this.config.global.strict ? { denied: true } : null;
    if (!place) return denied;
    if (place.provider === 'node-default') {
      return this.#nodeLoads(place, filePath, loading);
    }
    if (!place.settingsAt(route.key)[domain]) return denied;
    if (place.provider === 'disk') {
      return this.#nodeLoads(place, filePath, loading);
    }
    let { key } = route;
    let payload = place.file(key);
    // Without strict Node's loader reads what the tree misses from disk: a
    // published source named in another case, which a case-insensitive
    // disk would hand it raw, is that source (Place.spelling).
    if (!payload && !denied) {
      key = place.spelling(key) ?? key;
      payload = place.file(key);
    }
    if (!payload || !place.visible(domain, key)) return denied;
    if (namesDirectory(filePath)) return { denied: true };
    if (payload.source === null) return denied;
    return { place, key, payload };
  }

  // Node's loader reads a module of a node-default or disk place from disk.
  // Its resolver resolves links first, but not with --preserve-symlinks, so
  // under strict the file it is about to read is checked as a read of that
  // place's disk is (#proven).
  #nodeLoads(place, filePath, loading) {
    if (!loading || this.#aliases === null) return null;
    if (place.config.links === 'deny') {
      return this.#crosses(place, filePath) ? { denied: true } : null;
    }
    if (this.#aliases.territory(place.root, filePath) !== null) return null;
    return { denied: true };
  }

  // Borrowed SAB view of the V8 cached data for a CommonJS source, or null.
  // The compile hook hands it straight to `vm.Script` and drops it.
  bytecode(filePath) {
    this.#live(filePath);
    const route = this.registry.route(filePath);
    return route?.place ? route.place.bytecode(route.key) : null;
  }

  // --- Watch ---

  // Observation points (tests, benchmarks): see watch-pipeline.js.
  get watcher() {
    return this.#watchPipeline.watcher;
  }

  get watchQueue() {
    return this.#watchPipeline.queue;
  }

  get rechecks() {
    return this.#watchPipeline.rechecks;
  }

  // A disk-origin place that accepts writes — anywhere, its rules' too —
  // must watch them back in: the mutation lands on disk, the watcher
  // republishes it.
  #watchRequired() {
    if (this.config.global.watch) return true;
    return this.config.places.some(
      (pc) => pc.origin === 'disk' && writesAnywhere(pc),
    );
  }

  watch() {
    this.#ensureReady('watch()');
    this.#watchPipeline.start();
  }

  // --- Publication pipeline ---

  // An epoch of the watch pipeline, bound to one epoch of the kernel's: what
  // it publishes, the directories it finds and what it finds gone go
  // there, and flush() commits it as one vfs-update. `refused(place, key)`
  // learns of a key whose op its place's tree refused: its intent is
  // dropped, the rest committed (#commitPlace). The epoch's own state
  // never leaves the kernel.
  #epoch(refused = null) {
    const ep = newEpoch(WATCH);
    ep.refused = refused;
    return {
      publish: (place, key, file) => this.#publishEntry(ep, place, key, file),
      directory: (place, key) => this.#directory(ep, place, key),
      remove: (place, key) => this.#gone(ep, place, key),
      flush: () => this.#flush(ep),
    };
  }

  // One source, whatever produced its raw input (scan, watcher, SEA asset,
  // virtual write): canonical input — the preparer of its extension runs
  // exactly once — then its sink: a Map place's store publishes at once,
  // the SAB sink (publication.js) places the source and its derived
  // representations and hands back the payload input to stage into `ep`.
  // Throws instead of warning, so init and virtual mutations can fail;
  // nothing partial is ever staged. What fails once close() has come — a
  // read it found in flight, in inputOf() or in the sink's allocation —
  // fails as the closed kernel. `file` is the raw input the watcher
  // tracks; `fail`, the refusal of a rename of a shared virtual place,
  // else one of `open`; `options`, the write's (PARENTS for a set).
  async #publishEntry(ep, place, key, file, fail, options) {
    try {
      const input = await inputOf(this, place, key, file);
      alive(this);
      const { birthtimeMs } = file;
      if (place.provider === 'map')
        place.store.publish(key, input, birthtimeMs);
      else {
        const shared = await sharedPublish(
          this,
          place,
          key,
          input,
          fail,
          birthtimeMs,
        );
        this.#stage(ep, place, key, shared, options);
      }
    } catch (err) {
      alive(this);
      throw err;
    }
  }

  // Record the write of `key` in `ep`: an op of a mutation, in order, or
  // the intent of a scan or a watcher epoch, which supersedes the key's
  // earlier one — a payload never visible to anyone, freed at once (after
  // close() the pool is gone with it).
  #stage(ep, place, key, { input, extents }, options) {
    const pe = placeEpoch(ep, place);
    if (ep.mode === OPS) {
      const op = ['write', key, input];
      if (options) op.push(options);
      pe.ops.push(op);
      pe.extents.push(...extents);
      return;
    }
    this.#intend(pe, key, { type: FILE, input, extents });
  }

  // A directory a scan or the watcher found: the tree holds it, and every
  // directory above it, once `ep` commits — a Map place's at once.
  #directory(ep, place, key) {
    if (place.provider === 'map') place.store.directory(key);
    else this.#intend(placeEpoch(ep, place), key, { type: DIR });
  }

  // A key the watcher found gone from disk: the tree loses it — a file, or
  // a directory with what lies below it — once `ep` commits; a Map place's
  // at once.
  #gone(ep, place, key) {
    if (place.provider === 'map') place.store.removeKey(key);
    else this.#intend(placeEpoch(ep, place), key, { type: GONE });
  }

  #intend(pe, key, intent) {
    const before = pe.intents.get(key);
    if (before?.extents) this.#free(before.extents);
    pe.intents.set(key, intent);
  }

  #free(extents) {
    if (this.cache) for (const extent of extents) this.cache.free(extent);
  }

  // Give up `ep`: what it placed was never visible to anyone, and goes back
  // to the pool at once — after close(), the pool is gone with it.
  #abandon(ep) {
    for (const pe of ep.places.values()) this.#free(pe.placed());
    ep.places.clear();
  }

  // Commit `ep` in one step and tell every thread: each place's tree takes
  // its ops — one commit per tree (#commitPlace) — every representation
  // they replace or remove is retired under the retireId its tree gave it,
  // what a commit wrote and took back itself (`dropped`: written over or
  // removed in it) goes back to the pool at once, and one `vfs-update`
  // carries it all: each tree's delta, the keys of the files it changed,
  // the segments new to the workers — a dropped extent's among them, as
  // the delta names it. A commit that
  // publishes takes the next version, the version of every payload it
  // makes; a relocation keeps the version of every payload it moves, and
  // the kernel's. Before initialize() completes there is no link to tell;
  // a closed kernel publishes nothing. Returns the version after the commit
  // — unchanged when the epoch published nothing — or null when the kernel
  // is closed: what a caller that must not report a publication that never
  // happened checks (#commit).
  #flush(ep, trees = null) {
    if (this.state === 'closed') return null;
    const relocation = ep.mode === RELOCATION;
    const next = relocation ? this.#version : this.#version + 1;
    const now = Date.now();
    const out = outcome();
    let published = false;
    for (const pe of ep.places.values()) {
      const done = this.#commitPlace(ep, pe, next, now);
      if (done === null) continue;
      const { place, result, changes } = done;
      const { tree } = place;
      const keyOf = (id) => {
        if (changes.keys.has(id)) return changes.keys.get(id);
        const node = tree.byId(id);
        return node ? tree.pathOf(node) : '';
      };
      this.#account(place.name, result, keyOf, out, now);
      const { created, replaced, removed, moved } = changes;
      const { delta } = result;
      out.places[place.name] = { delta, created, replaced, removed, moved };
      place.spelled(created, removed, moved);
      if (!relocation && result.version === next) published = true;
    }
    // The relocations of shared trees a compaction committed.
    for (const [host, result] of trees ?? []) {
      this.#account(host.name, result, treeKey, out, now);
      out.trees[host.name] = { deltas: [result.delta], seq: null };
    }
    if (out.empty()) return this.#version;
    this.#post(out, published ? next : this.#version, published);
    return this.#version;
  }

  // A publication of a shared tree: the commits of one part of its
  // intake's run, every one with the next version — `seq`, the numbers of
  // the batches it shows — in one `vfs-update`. Commits that changed
  // nothing publish nothing: their update, of no version and no delta,
  // only moves `last` in every thread — the tree shows those batches too.
  #publishTree(host, results, seq) {
    if (this.state === 'closed') throw closedError();
    const now = Date.now();
    const next = this.#version + 1;
    const out = outcome();
    const deltas = [];
    let published = false;
    for (const result of results) {
      if (result.delta === null) continue;
      this.#account(host.name, result, treeKey, out, now);
      deltas.push(result.delta);
      if (result.version === next) published = true;
    }
    host.last = seq.to;
    out.trees[host.name] = { deltas, seq };
    this.#post(out, published ? next : this.#version, published);
  }

  // One commit of the tree of `name` — a place or a shared tree —
  // in `out`: what it placed is committed (a segment compaction closed
  // meanwhile reopens) and its segments go to the workers; so do those
  // of what it took back (`dropped`), which its delta still names, back
  // to the pool at once; what it retired is retired under its retireIds,
  // `keyOf(id)` naming a record; the books follow.
  #account(name, result, keyOf, out, now) {
    for (const { extent } of result.placed) {
      this.cache.committed(extent);
      out.segments.add(extent.segmentId);
    }
    for (const extent of result.dropped) {
      out.segments.add(extent.segmentId);
      this.cache.free(extent);
    }
    for (const { id, kind, retireId, rep } of result.retired) {
      const extent = extentOf(rep);
      out.records.push(
        this.#retirement.retire(retireId, name, keyOf(id), kind, extent, now),
      );
      out.retired.push(rep, retireId);
    }
    this.#book(name, result);
  }

  // The update of what `out` committed, to every link, at `version`; the
  // 'publish' event when it published; the books of its retirement — what
  // a consumer of this thread still reads of the retired is held.
  #post(out, version, published) {
    this.#version = version;
    const updateId = ++this.nextUpdateId;
    this.#retirement.commit(updateId, out.records);
    const held = [];
    for (let i = 0; i < out.retired.length; i += 2) {
      const retireId = out.retired[i + 1];
      if (this.pins.retain(out.retired[i], retireId)) held.push(retireId);
    }
    this.#retirement.hold(held, MAIN);
    const newSegments = [];
    for (const id of out.segments) {
      if (this.#sentSegments.has(id)) continue;
      this.#sentSegments.add(id);
      newSegments.push({ id, sab: this.segmentsMap.get(id) });
    }
    const { places, trees } = out;
    const msg = { name: UPDATE, updateId, version, places, trees, newSegments };
    for (const port of this.links.values()) port.postMessage(msg);
    if (published) this.#publish(version, places, trees);
    this.#settle(this.#retirement.track(updateId, out.records, this.links));
  }

  // The books after a commit of the tree of place `name`: what it retired
  // leaves them; what it placed joins them under the id of the node that
  // holds it after the commit (the tree's `placed`) — whatever keys its
  // ops named, a node written and moved in one commit included. What it
  // took back (`dropped`) never joins them.
  #book(name, { retired, placed }) {
    for (const { rep } of retired) this.#disowns(name, rep);
    for (const { id, extent } of placed) this.#owns(name, extent, id);
  }

  #owns(name, extent, id) {
    if (extent.length === 0) return;
    let places = this.#books.get(extent.segmentId);
    if (!places) this.#books.set(extent.segmentId, (places = new Map()));
    let offsets = places.get(name);
    if (!offsets) places.set(name, (offsets = new Map()));
    offsets.set(extent.offset, id);
  }

  #disowns(name, extent) {
    if (extent.length === 0) return;
    this.#books.get(extent.segmentId)?.get(name)?.delete(extent.offset);
  }

  // The commit of one place's part of `ep` to its tree: `{ place, result,
  // changes, ops }` — what the tree returned, what it changed in files
  // (epoch.js, eventsOf) and the ops — or null when there was nothing to
  // commit. The ops of a scan or a watcher epoch are made of its intents
  // against the tree as it is (reconcile). A refusal of the tree — an op
  // its checks reject: `index` ≥ 0 — is the source's (doc/architecture.md,
  // "Publication"): a watcher epoch drops the intent of the refused op,
  // frees its bytes,
  // tells `ep.refused` and commits the rest; a compaction frees the place's
  // copies and reopens its segment; init and a mutation throw it, their
  // caller's, the refused op with it (`op`). Anything else — a refusal of
  // the arguments or the version (`index` −1), an engine bug — leaves the
  // tree unusable: the kernel closes, and it throws.
  #commitPlace(ep, pe, next, now) {
    const { place } = pe;
    const reconciled = ep.mode === INIT || ep.mode === WATCH;
    for (;;) {
      const { ops, owners } = reconciled
        ? reconcile(place.tree, pe.intents)
        : { ops: pe.ops, owners: null };
      if (ops.length === 0) return null;
      let result;
      try {
        result = place.tree.commit(ops, next, now, CHANGES);
      } catch (err) {
        if (!Number.isInteger(err.index) || err.index < 0) {
          this.close();
          throw err;
        }
        if (ep.mode === WATCH) {
          this.#refuse(ep, pe, owners[err.index], err);
          continue;
        }
        if (ep.mode === RELOCATION) {
          this.#free(pe.extents);
          this.cache.reopen(ep.target);
          return null;
        }
        err.op = ops[err.index];
        throw err;
      }
      if (result.delta === null) return null;
      const changes = eventsOf(place.tree, result.changes);
      return { place, result, changes };
    }
  }

  // The intent a place's tree refused, in a watcher epoch: dropped, its
  // bytes freed, its key rechecked (ep.refused) — the rest of the epoch is
  // committed without it.
  #refuse(ep, pe, key, err) {
    const intent = pe.intents.get(key);
    pe.intents.delete(key);
    if (intent?.extents) this.#free(intent.extents);
    this.console.warn(
      `[vfs] place "${pe.place.name}": "${key}" not published — ${err.message}`,
    );
    ep.refused?.(pe.place, key);
  }

  // The commit of an application's mutation, which settles as published or
  // refused: a kernel closed after the publication's last step and before
  // its commit — close() is synchronous, a publication is not — published
  // nothing, and the mutation rejects as the closed kernel, never resolves.
  // A refusal of the tree is the mutation's: `fail(code, detail, key)`
  // names it, `key` the refused op's; its bytes go back to the pool.
  #commit(ep, fail) {
    let committed;
    try {
      committed = this.#flush(ep);
    } catch (err) {
      this.#abandon(ep);
      if (!err.op) throw err;
      throw fail(err.code, undefined, err.op[1]);
    }
    if (committed === null) throw closedError();
    return committed;
  }

  // The 'publish' event of a publication this thread committed or applied:
  // what it changed in each place — the keys of the files it created,
  // replaced and removed, the pairs of what it moved — built only when
  // there is a listener.
  #publish(version, places, trees = {}) {
    if (this.listenerCount('publish') === 0) return;
    const changed = {};
    for (const [name, change] of Object.entries(places)) {
      const { created, replaced, removed, moved } = change;
      changed[name] = { created, replaced, removed, moved };
    }
    // A tree, by the numbers of the batches it shows now; a relocation
    // (seq null) tells nothing.
    const told = [];
    for (const [tree, { seq }] of Object.entries(trees)) {
      if (seq === null) continue;
      const { from: seqFrom, to: seqTo, loaded } = seq;
      told.push({ tree, seqFrom, seqTo, loaded });
    }
    this.#announce(deepFreeze({ version, places: changed, trees: told }));
  }

  // The listeners of 'publish' run in a microtask of their own: after the
  // commit, never inside it — nor inside initialize(), which is ready by
  // then — and before the promise of the mutation that published settles,
  // which resolves later in the same queue. An event close() comes before
  // is never delivered. What a listener throws is its own: an uncaught
  // exception, as from any emitter; the commit, the ACK and the writer are
  // done already.
  #announce(event) {
    queueMicrotask(() => {
      if (this.state !== 'closed') this.emit('publish', event);
    });
  }

  // --- Retirement: ACK-before-free ---
  // The books are retirement.js's; each change of them hands back the
  // records it may have left unheld, and #settle frees their bytes.

  // Observation points (tests, diagnostics).
  get acks() {
    return this.#retirement.acks;
  }

  get retired() {
    return this.#retirement.retired;
  }

  get nextRetireId() {
    return this.#retirement.nextRetireId;
  }

  // A worker applied `updateId`. `retained` lists the retired
  // representations it still reads; they are held before its ACK can free
  // anything.
  handleAck(updateId, linkId, retained) {
    this.#settle(this.#retirement.ack(updateId, linkId, retained));
  }

  // The last consumer of these retired representations in one thread is
  // done.
  handleRelease(holder, retireIds) {
    this.#settle(this.#retirement.release(holder, retireIds));
  }

  // A worker is gone: it will neither ACK nor read anything any more.
  handleWorkerExit(linkId) {
    this.#settle(this.#retirement.exit(linkId));
  }

  // Free every record neither an ACK nor a consumer holds any more — the
  // only free of a retired representation — then compact once. Nothing is
  // ever freed on a timeout. Most ACKs settle nothing: an empty list costs
  // no walk.
  #settle(records) {
    if (!this.cache || records.length === 0) return;
    let freed = false;
    for (const record of records) {
      if (!this.#retirement.take(record)) continue;
      this.cache.free(record.extent);
      freed = true;
    }
    if (freed) this.#compact();
  }

  // At most one relocation per free cycle: the published representations
  // of the segment the pool would empty, found in its books — the cost of
  // that segment, not of the places — and named by the id of their node —
  // a move between the plan and the commit would change a key, never an
  // id — are copied out and committed like any change, and their old
  // extents are retired like any replaced representation — a consumer
  // still reading one keeps it. A relocation publishes nothing new: every
  // payload keeps its version, and so does the kernel.
  #compact() {
    const { threshold } = this.config.global.compaction;
    const target = this.cache.compactTarget(threshold);
    if (target === null) return;
    const owners = [];
    for (const [name, offsets] of this.#books.get(target) ?? []) {
      const place = this.registry.get(name);
      const host = place ? null : this.trees.get(name);
      const tree = place ? place.tree : host.tree;
      for (const [offset, id] of offsets) {
        const node = tree.byId(id);
        const rep = node && repAt(tree.payloadOf(node), target, offset);
        if (rep) owners.push({ place, host, id, kind: rep.kind, rep });
      }
    }
    if (owners.length === 0) return;
    const reps = owners.map(({ rep }) => rep);
    const moved = this.cache.relocate(target, reps);
    if (!moved) return;
    const ep = newEpoch(RELOCATION);
    ep.target = target;
    const byTree = new Map(); // host → { ops, extents }
    for (let i = 0; i < owners.length; i++) {
      const { place, host, id, kind } = owners[i];
      const op = ['relocate', id, kind, moved[i]];
      if (place) {
        const pe = placeEpoch(ep, place);
        pe.ops.push(op);
        pe.extents.push(moved[i]);
        continue;
      }
      let mine = byTree.get(host);
      if (!mine) byTree.set(host, (mine = { ops: [], extents: [] }));
      mine.ops.push(op);
      mine.extents.push(moved[i]);
    }
    // Run from an ACK, a release or a worker's exit: what fails here — an
    // engine bug, which closes the kernel (#commitPlace) — is told, never
    // thrown into a port's handler.
    try {
      const trees = this.#relocateTrees(byTree, target);
      this.#flush(ep, trees);
    } catch (err) {
      this.console.error(`[vfs] compaction: ${err.message}`);
    }
  }

  // The relocations of a compaction in shared trees: one commit of
  // each, by id, keeping its version. What a tree refuses is dropped as a
  // place's relocation is (#commitPlace) — its copies back to the pool,
  // the segment open again; anything else it throws is an engine bug,
  // which closes the kernel.
  #relocateTrees(byTree, target) {
    const done = [];
    for (const [host, { ops, extents }] of byTree) {
      let result;
      try {
        result = host.tree.commit(ops, this.#version, Date.now());
      } catch (err) {
        if (!Number.isInteger(err.index) || err.index < 0) {
          this.close();
          throw err;
        }
        this.#free(extents);
        this.cache.reopen(target);
        continue;
      }
      if (result.delta !== null) done.push([host, result]);
    }
    return done;
  }

  // --- Worker side ---

  // A worker kernel over `snapshot`: replicas of the shared places' trees
  // at its version and with the instance of the main kernel it was taken
  // from, a tree of its own for each `map` place. With `port` (the link
  // end from `link()`, wired by attach()) it applies deltas, ACKs them,
  // releases retired representations and sends mutations of shared virtual
  // places. Only local Map writes prepare in a worker: a preparer missing
  // from `options.preparers` fails such a write, never the replicas.
  static fromSnapshot(snapshot, config, options = {}) {
    const kernel = new VfsKernel(config, options);
    for (const { id, sab } of snapshot?.segments || []) {
      kernel.segmentsMap.set(id, sab);
    }
    kernel.#version = snapshot?.version ?? 0;
    if (snapshot?.instance) kernel.#instance = snapshot.instance;
    // The links main knew, as of its index's generation (#heardLinks).
    const links = snapshot?.links;
    if (kernel.#linkIndex !== null && links) {
      for (const key of links.known) kernel.#linkIndex.add(key);
      kernel.#linksHeard = links.generation ?? 0;
    }
    if (options.port) kernel.#connect(options.port);
    for (const [index, pc] of config.places.entries()) {
      const place = new Place(pc, kernel.appRoot);
      place.dev = index + 1;
      place.preparers = kernel.preparers.bind(place, false);
      place.store = kernel.#storeOf(place);
      const replica = SHARED.has(pc.provider)
        ? (snapshot?.places?.[pc.name] ?? null)
        : undefined;
      kernel.#plant(place, replica);
      kernel.registry.register(place);
    }
    for (const tc of config.trees) {
      const held = snapshot?.trees?.[tc.name];
      if (!held) {
        throw new Error(
          `[vfs] attach(): the snapshot holds no tree "${tc.name}" — ` +
            "the main kernel's config is another",
        );
      }
      kernel.trees.set(tc.name, {
        name: tc.name,
        config: tc,
        tree: fromSnapshot(held.snapshot, kernel.segmentsMap),
        last: held.last,
        intake: null,
      });
    }
    kernel.state = 'ready';
    return kernel;
  }

  #connect(port) {
    this.port = port;
    this.mutationClient = new MutationClient(port);
    this.pins = new Pins((retireIds) =>
      port.postMessage({ name: RELEASE, retireIds }),
    );
    port.on('message', (msg) => {
      if (this.#broken !== null) return;
      if (msg?.name === LINKS) return void this.#heardLinks(msg);
      if (msg?.name !== UPDATE) return void this.mutationClient.handle(msg);
      const retained = this.handleDelta(msg);
      const ack = { name: ACK, updateId: msg.updateId };
      if (retained.length > 0) ack.retained = retained;
      port.postMessage(ack);
    });
    // The main kernel is gone: nothing can be published any more.
    port.on('close', () => this.mutationClient.close());
    port.unref();
  }

  // Apply a `vfs-update`; returns the retireIds this thread still reads,
  // which its ACK must carry. A delta that fails to apply breaks the view
  // (#break) and throws.
  handleDelta(msg) {
    if (msg?.name !== UPDATE) return [];
    try {
      return this.#applyUpdate(msg);
    } catch (err) {
      this.#break(err);
      throw err;
    }
  }

  // One update, in one step: its segments join the map, each place's tree
  // applies its delta — a representation it retires that a consumer here
  // still reads is bound to its retireId first (Pins.retain), and those ids
  // are returned — and the thread takes its version. An update of a newer
  // version is a publication, announced to the 'publish' listeners; an
  // update without a version — of a main kernel that sends none — is
  // applied, announced to no one, and leaves the thread's version as it
  // was.
  #applyUpdate({ places, trees = {}, newSegments, version }) {
    for (const { id, sab } of newSegments || []) this.segmentsMap.set(id, sab);
    const retained = [];
    const applied = [];
    for (const [name, change] of Object.entries(places)) {
      const place = this.registry.get(name);
      if (!place?.tree) continue;
      for (const id of place.tree.apply(change.delta, this.pins)) {
        retained.push(id);
      }
      applied.push([place, change]);
    }
    // A shared tree: its deltas in order, in this same step.
    for (const [name, { deltas, seq }] of Object.entries(trees)) {
      const host = this.trees.get(name);
      if (!host?.tree) continue;
      for (const delta of deltas) {
        for (const id of host.tree.apply(delta, this.pins)) retained.push(id);
      }
      if (seq !== null) host.last = seq.to;
    }
    for (const [place, { created, removed, moved }] of applied) {
      place.spelled(created, removed, moved);
    }
    const publication = version > this.#version;
    this.#version = version ?? this.#version;
    if (publication) this.#publish(version, places, trees);
    return retained;
  }

  // A delta this worker could not apply: part of the update may be in its
  // trees, and no later delta, made from the state after the refused one,
  // can follow (doc/architecture.md, "Virtual places and worker
  // mutations"). In the same step
  // the view closes: every VFS call of the thread fails as the closed
  // kernel, with `cause` (#live, PlaceFs), and so does every mutation
  // pending; no ACK of this update or any later; streams stop, and the
  // port stays open while a lease or a borrowed chunk is still held — the
  // main kernel keeps their bytes until the port closes, then frees all
  // the link held — and closes with the last of them; 'close' carries the
  // failure. There is no recovery: a new view is a new worker with a new
  // `link()`.
  #break(cause) {
    if (this.#broken !== null) return;
    this.#broken = cause;
    const first = this.state !== 'closed';
    this.state = 'closed';
    this.mutationClient?.close(() => brokenError(cause));
    for (const place of this.registry.all()) place.tree = null;
    for (const host of this.trees.values()) host.tree = null;
    const { port } = this;
    this.pins.break(() => port?.close());
    if (!first) return;
    queueMicrotask(() => {
      try {
        this.emit('close', cause);
      } finally {
        this.removeAllListeners();
      }
    });
  }
}

// The snapshot `link()` put first on its port, taken synchronously; it
// throws when the port holds none — a link is one worker's, attached once.
const takeSnapshot = (port) => {
  const msg = port ? receiveMessageOnPort(port)?.message : undefined;
  if (msg?.name === SNAPSHOT) return msg.snapshot;
  const held = msg === undefined ? 'nothing' : (msg?.name ?? typeof msg);
  throw new Error(
    `[vfs] attach(): the link holds no snapshot (its next message: ${held},` +
      ' taken now) — every worker needs a kernel.link() of its own, attached once',
  );
};

module.exports = { VfsKernel, KERNEL, readInto, takeSnapshot };
