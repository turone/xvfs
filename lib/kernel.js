'use strict';

const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { availableParallelism } = require('node:os');
const { MessageChannel } = require('node:worker_threads');
const { fileExt } = require('metautil');
// The disk past fs-patch (disk.js).
const {
  realpathSync,
  promises: { open },
} = require('./disk.js');
const { FilesystemCache } = require('./cache.js');
const { Compressor } = require('./compressor.js');
const { PlaceRegistry, FsRouter, namesDirectory } = require('./registry.js');
const { Aliases } = require('./aliases.js');
const { Place, PlaceFiles } = require('./place.js');
const { isCompanionKey } = require('./companion.js');
const { PlaceFs } = require('./place-fs.js');
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
const { Preparers } = require('./pipeline.js');
const {
  closedError,
  alive,
  inputOf,
  keptOnDisk,
  sharedPublish,
  sharedCopies,
} = require('./publication.js');
const { scan } = require('./scanner.js');
const { INDEXED, SHARED, deepFreeze } = require('./config.js');

// VfsKernel — orchestrator and consumer facade.
// Main thread: fills places from their origin (a disk scan, embedded SEA
// assets or application mutations of a virtual place) through one
// publication pipeline — raw input → the preparer of its extension →
// canonical content → bytecode and compressed companions (the SAB sink,
// publication.js) → one epoch, which the kernel commits — watches
// disk-origin places (watch-pipeline.js) and sends each epoch as one
// `vfs-update` to the linked workers. A version an update replaces or
// removes is retired (retirement.js): its bytes are freed only after every
// live worker ACKs the update and no thread still reads them. A commit
// that publishes something — not a relocation, not an empty epoch — takes
// the next number of the main kernel's publication counter (`version`):
// stamped into every entry it publishes, carried by its update and by
// every snapshot after it, the same in every thread. Each thread that
// applies a publication tells its 'publish' listeners what it changed,
// after the commit (#apply, #announce).
// Worker thread: `VfsKernel.fromSnapshot()` projects the same segments
// read-only, applies the deltas arriving on its link port, ACKs each with
// the retired versions it still reads, and sends mutations of shared
// virtual places back over the same port.
// States: new → initializing → ready → closed (final).
//
// Protocol (link port):
//   vfs-update  main → worker  { updateId, version, places: { <name>: {
//                              entries, removals, retired: [[key,
//                              retireId]] } }, newSegments }
//   vfs-ack     worker → main  { updateId, retained?: [retireId] }
//   vfs-release worker → main  { retireIds }
//   vfs-mutate / vfs-mutated   see mutation-rpc.js

const KERNEL = Symbol.for('shared-memory-fs');
// A native route whose path the disk places elsewhere (VfsKernel#proven).
const UNPROVEN = Object.freeze({ kind: 'deny', code: 'EACCES' });
const UPDATE = 'vfs-update';
const ACK = 'vfs-ack';
const RELEASE = 'vfs-release';
// Holder id of the main thread's own consumers of retired versions.
const MAIN = 'main';

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

// The keys of one place a publication changed, none of them.
const isEmpty = ({ created, replaced, removed }) =>
  created.length === 0 && replaced.length === 0 && removed.length === 0;

// Map a SEA asset key to a place key: `<name>/<rest>` → `/<rest>`.
const seaKeyOf = (assetKey, name) =>
  assetKey.startsWith(name + '/') && assetKey.length > name.length + 1
    ? assetKey.substring(name.length)
    : null;

// Events, in every thread: 'publish' ({ version, places: { <name>: {
// created, replaced, removed } } }), once per publication this thread
// applies; 'close', once, last. Never 'error'.
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

  // Live updates of the disk-origin places: watcher epochs, one at a time,
  // published through epochs the kernel opens for it (#epoch) and commits.
  // Created before the constructor below runs: it reads the kernel only
  // when called.
  #watchPipeline = new WatchPipeline(this, () => this.#epoch());

  // Under strict, what the disk says of appRoot's other spellings and of
  // where a native call on a place's disk lands (aliases.js); else null.
  #aliases = null;

  // The kernel published by the bootstrap (`--import shared-memory-fs/register`).
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
    this.registry = new PlaceRegistry(this.appRoot, path, strict, aliases);
    this.router = new FsRouter(this.registry, strict);
    this.facades = new Map(); // name → PlaceFs

    this.cache = null;
    this.compressor = null;
    this.segmentsMap = new Map(); // segmentId → SAB
    // name → PlaceFiles<key, FileInput> (disk-origin): what a watcher event
    // may unpublish, its directories indexed.
    this.sources = new Map();

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

  // The refusal of `what` on a kernel that is not ready.
  #notReady(what) {
    return new Error(
      `[vfs] ${what} requires a ready kernel (state: ${this.state})`,
    );
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
      });
      this.compressor = new Compressor({ console: this.console });
      for (const pc of this.config.places) {
        const place = new Place(pc, this.appRoot);
        this.#homed(place);
        // Every preparer an enabled place names must exist before anything
        // is read.
        place.preparers = this.preparers.bind(place, true);
        place.store = this.#storeOf(place);
        // Shared places are in every snapshot, even while empty.
        if (SHARED.has(place.provider)) this.cache.index(place.name);
        this.registry.register(place);
      }
      const ep = this.#newEpoch();
      for (const place of this.registry.all()) {
        const files = await this.#originOf(place);
        if (files) await this.#publishAll(ep, place, files);
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

  // Final: stops watching, drops pending work, every projection and every
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
    this.sources.clear();
    this.facades.clear();
    for (const place of this.registry.all()) place.files.clear();
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

  // Raw inputs of a place's origin at init: a disk scan or the embedded SEA
  // assets. Virtual places start empty: their content arrives through fs
  // mutations; disk and node-default places are never indexed. The scan
  // stops at close().
  async #originOf(place) {
    const { provider } = place;
    if (provider === 'sea') return this.#seaAssets(place);
    if (!INDEXED.has(provider) || place.virtual) return null;
    const files = await scan(place.root, {
      ext: place.config.scanExt,
      followSymlinks: !this.config.global.strict,
      stopped: () => this.state === 'closed',
    });
    this.sources.set(place.name, new PlaceFiles());
    return files;
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
    return assets;
  }

  #loadSea() {
    try {
      const sea = require('node:sea');
      return sea.isSea() ? sea : null;
    } catch {
      return null;
    }
  }

  // Init: every file of one origin through the pipeline, largest first (it
  // packs segments better), a few at a time. The first failure stops the
  // rest and aborts initialize(), like any unreadable source.
  async #publishAll(ep, place, files) {
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
    facade = new PlaceFs(place, this.pins, this.#territory(place));
    this.facades.set(name, facade);
    return facade;
  }

  // { segments: [{ id, sab }], places: { name: { entries: [[key, entry]] } },
  //   version, instance }
  // Published entries only: a publication in progress is not part of it.
  snapshot() {
    this.#ensureReady('snapshot()');
    if (!this.cache) throw new Error('[vfs] snapshot() is main-thread only');
    const snapshot = this.cache.snapshot();
    snapshot.version = this.#version;
    snapshot.instance = this.#instance;
    return snapshot;
  }

  // Everything a worker needs, ready for `new Worker(file, { workerData:
  // { vfs }, transferList })`: snapshot, config, appRoot and a private
  // MessagePort. Deltas flow to the port, ACKs and releases come back, and
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
    const vfs = {
      snapshot,
      config: this.config.raw,
      appRoot: this.appRoot,
      port: port2,
    };
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
      preparation: { failures, places },
      queues: {
        watch: { epochs: this.watchQueue.size, rechecks: this.rechecks.size },
        mutations: {
          keys: this.mutations.size,
          barriers: this.mutations.barriers,
        },
      },
    });
  }

  // One walk of the index: the sources the shared places publish and what
  // their published versions — companions included — take of the pool;
  // the sources read from disk, and among them those the pool had no room
  // for when they were published: neither larger than their place's
  // maxFileSize nor kept on disk by `retainRaw: false`.
  #indexed() {
    const published = { files: 0, bytes: 0 };
    const disk = { files: 0, bytes: 0, fallback: { files: 0, bytes: 0 } };
    for (const [name, { entries }] of this.cache.indexes) {
      const place = this.registry.get(name);
      for (const [key, entry] of entries) {
        if (!isCompanionKey(key)) published.files++;
        if (entry.kind === 'shared') {
          published.bytes += entry.length;
          continue;
        }
        const { size } = entry.stat;
        disk.files++;
        disk.bytes += size;
        if (size > place.config.maxFileSize) continue;
        if (keptOnDisk(this, place, key)) continue;
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
      if (this.state !== 'ready') {
        const err = this.#notReady('mutations');
        if (this.state === 'closed') err.code = 'ERR_VFS_CLOSED';
        throw err;
      }
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
    const ep = this.#newEpoch();
    const stat = { size: raw.length, mtimeMs: Date.now() };
    await this.#publishEntry(ep, place, key, { data: raw, stat });
    this.#commit(ep);
  }

  // Publish a set of virtual files as one (writeFiles): one epoch, each
  // file through the pipeline in the order given — its preparer runs once
  // — under one mtime, then one commit: one `vfs-update`, one version, one
  // event. A file that fails abandons the set: the allocations of the
  // files before it go back to the pool, nothing is published. One at a
  // time: a failure stops the rest, and nothing can stage after it. What
  // the pipeline refuses about a key, `failOf(key)` — the set's — names.
  // Resolves with the version of the commit.
  async publishVirtualBatch(place, files, failOf) {
    const ep = this.#newEpoch();
    const mtimeMs = Date.now();
    try {
      for (const [key, raw] of files) {
        const file = { data: raw, stat: { size: raw.length, mtimeMs } };
        await this.#publishEntry(ep, place, key, file, failOf(key));
      }
      return this.#commit(ep);
    } catch (err) {
      this.#abandon(ep);
      throw err;
    }
  }

  // Retire sources and their companions in one message.
  unpublishVirtual(place, keys) {
    const ep = this.#newEpoch();
    for (const key of keys) this.#unstage(ep, place, key);
    this.#commit(ep);
  }

  // Move a (raw, unprepared) source: the old key and its companions go and
  // the new key is published through the pipeline — prepared when its
  // extension has a preparer — in the same message. The mtime is kept, like
  // a rename on disk. A failure publishes nothing; what the pipeline
  // refuses, `fail` — the rename's — names.
  async renameVirtual(place, from, to, fail) {
    const file = place.files.get(from);
    const data = Buffer.from(file.data);
    const ep = this.#newEpoch();
    this.#unstage(ep, place, from);
    const stat = { size: data.length, mtimeMs: file.stat.mtimeMs };
    await this.#publishEntry(ep, place, to, { data, stat }, fail);
    this.#commit(ep);
  }

  // Move a subtree whose sources move as they are (subtreeMoves): each
  // source and companion is copied with its stat and mtime under its new
  // key — nothing is prepared, compiled or compressed again — and the old
  // keys go, in one message. The old versions retire like any replaced
  // version; a failure (the pool is full, the kernel closed) publishes
  // nothing — the pool's refusal is `fail`, the rename's.
  async renameVirtualTree(place, moves, fail) {
    const changes = await sharedCopies(this, place, moves, fail);
    const ep = this.#newEpoch();
    for (const [key, entry] of changes) this.#stage(ep, place, key, entry);
    this.#commit(ep);
  }

  // --- Adapter API ---
  // Consumed by lib/adapters/*, not by application code: these return raw
  // routing decisions and borrowed views, without the ownership and ext
  // policies PlaceFs applies.

  routeRead(filePath) {
    return this.#proven(this.router.read(filePath), filePath);
  }

  routeMutation(filePath) {
    return this.#proven(this.router.mutate(filePath), filePath);
  }

  routeCopy(filePath, recursive) {
    return this.#proven(this.router.copy(filePath, recursive), filePath);
  }

  // The patch routes both paths as mutations first, which proves them.
  routeRename(fromPath, toPath) {
    return this.router.rename(fromPath, toPath);
  }

  routeLink(fromPath, toPath) {
    const route = this.router.link(fromPath, toPath);
    if (route.kind !== 'passthrough' || this.#aliases === null) return route;
    const source = this.routeRead(fromPath);
    if (source.kind === 'deny') return source;
    const target = this.routeMutation(toPath);
    return target.kind === 'deny' ? target : route;
  }

  // Under strict, whether a new link to this path — a symbolic link's
  // target as the OS resolves it — would name managed territory.
  linksInto(filePath) {
    return this.router.linksInto(filePath);
  }

  // Under strict a native route on a place's disk — node:fs on the path as
  // given — holds only where the disk says the path really lies: in the
  // place's directory, or off appRoot's line (Aliases.territory); and in
  // the disk territory of `fs.fallback: 'disk'` never on a file of an
  // extension the place caches, which a link names another way. Else it is
  // EACCES, before any native call.
  #proven(route, filePath) {
    if (this.#aliases === null || route.place === undefined) return route;
    if (route.kind !== 'passthrough' && route.kind !== 'disk') return route;
    const real = this.#aliases.territory(route.place.root, filePath);
    if (real === null) return UNPROVEN;
    const cached = route.place.cached(path.basename(real));
    return route.kind === 'disk' && cached ? UNPROVEN : route;
  }

  // Under strict, where a path on `place`'s disk really lies, when its
  // native calls may go there, else null (Aliases.territory) — for
  // PlaceFs; null without strict.
  #territory(place) {
    const aliases = this.#aliases;
    if (aliases === null) return null;
    return (filePath) => aliases.territory(place.root, filePath);
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

  // What a strict appRoot lists: the enabled places, sorted.
  rootEntries() {
    return this.registry
      .all()
      .map((place) => place.name)
      .sort();
  }

  // Module lookup for the require / import hooks.
  //   { place, key, file }  published source visible to `domain`
  //   { denied: true }      strict sandbox: nothing published for this path;
  //                         or, in any mode, a published source named with
  //                         a trailing separator — a directory, no module;
  //                         or, under strict, a module of a node-default or
  //                         disk place `loading` that really lies elsewhere
  //   null                  not ours — default Node loader
  // `loading`: the load hook asks, about the file Node's loader is to read.
  resolveModule(filePath, domain, loading = false) {
    const route = this.registry.route(filePath);
    if (!route) return null;
    const { place } = route;
    const denied = this.config.global.strict ? { denied: true } : null;
    if (!place) return denied;
    if (place.provider === 'node-default') {
      return this.#nodeLoads(place, filePath, loading);
    }
    if (!place.config[domain]) return denied;
    if (place.provider === 'disk') {
      return this.#nodeLoads(place, filePath, loading);
    }
    let { key } = route;
    let file = place.files.get(key);
    // Without strict Node's loader reads what the index misses from disk: a
    // published source named in another case, which a case-insensitive
    // disk would hand it raw, is that source (Place.spelling).
    if (!file && !denied) {
      key = place.spelling(key) ?? key;
      file = place.files.get(key);
    }
    if (!file || !place.visible(domain, key)) return denied;
    if (namesDirectory(filePath)) return { denied: true };
    if (file.data === null) return denied;
    return { place, key, file };
  }

  // Node's loader reads a module of a node-default or disk place from disk.
  // Its resolver resolves links first, but not with --preserve-symlinks, so
  // under strict the file it is about to read proves where it really lies,
  // as a read of that place's disk does (#proven).
  #nodeLoads(place, filePath, loading) {
    if (!loading || this.#aliases === null) return null;
    if (this.#aliases.territory(place.root, filePath) !== null) return null;
    return { denied: true };
  }

  // Borrowed SAB view of the V8 cached data for a CommonJS source, or null.
  // The compile hook hands it straight to `vm.Script` and drops it.
  bytecode(filePath) {
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

  // A disk-origin place that accepts writes must watch them back in: the
  // mutation lands on disk, the watcher republishes it.
  #watchRequired() {
    if (this.config.global.watch) return true;
    return this.config.places.some(
      (pc) => pc.origin === 'disk' && pc.fs?.writable,
    );
  }

  watch() {
    this.#ensureReady('watch()');
    this.#watchPipeline.start();
  }

  // --- Publication pipeline ---

  // `relocation`: the epoch of a compaction, which moves published bytes
  // and publishes nothing new — its commit takes no version.
  #newEpoch(relocation = false) {
    return {
      changes: new Map(), // place name → Map<key, entry | null>
      relocation,
    };
  }

  // An epoch of the watch pipeline, bound to one epoch of the kernel's: what
  // it publishes and unstages goes there, and flush() commits that epoch as
  // one vfs-update. The epoch's own state never leaves the kernel.
  #epoch() {
    const ep = this.#newEpoch();
    return {
      publish: (place, key, file) => this.#publishEntry(ep, place, key, file),
      unstage: (place, key) => this.#unstage(ep, place, key),
      flush: () => this.#flush(ep),
    };
  }

  // One source, whatever produced its raw input (scan, watcher, SEA asset,
  // virtual write): canonical input — the preparer of its extension runs
  // exactly once — then its sink: a Map place's store publishes at once,
  // the SAB sink (publication.js) places the source and its companions and
  // hands back the changes to stage into `ep`. Throws instead of warning,
  // so init and virtual mutations can fail; nothing partial is ever staged.
  // What fails once close() has come — a read it found in flight, in
  // inputOf() or in the sink's allocation — fails as the closed kernel.
  // `file` is the source record the watcher tracks; `fail`, the refusal of
  // a rename of a shared virtual place, else one of `open`.
  async #publishEntry(ep, place, key, file, fail) {
    try {
      const input = await inputOf(this, place, key, file);
      alive(this);
      if (place.provider === 'map') place.store.publish(key, input);
      else {
        const changes = await sharedPublish(this, place, key, input, fail);
        for (const [k, entry] of changes) this.#stage(ep, place, k, entry);
      }
    } catch (err) {
      alive(this);
      throw err;
    }
    this.sources.get(place.name)?.set(key, file);
  }

  // Record one change of `ep`: an entry to publish, or null to unpublish. A
  // provisional entry superseded within the same epoch was never visible to
  // anyone and is freed at once — after close() the pool is gone with it.
  #stage(ep, place, key, entry) {
    let changes = ep.changes.get(place.name);
    if (!changes) ep.changes.set(place.name, (changes = new Map()));
    const previous = changes.get(key);
    if (previous) this.cache?.free(previous);
    changes.set(key, entry);
  }

  // Give up `ep`: what it staged was never visible to anyone, and goes back
  // to the pool at once — after close(), the pool is gone with it.
  #abandon(ep) {
    if (this.cache) {
      for (const changes of ep.changes.values()) {
        for (const entry of changes.values()) this.cache.free(entry);
      }
    }
    ep.changes.clear();
  }

  // Stage the removal of a source and of every companion it may have.
  #unstage(ep, place, key) {
    this.#stage(ep, place, key, null);
    for (const companion of place.companions(key)) {
      this.#stage(ep, place, companion, null);
    }
  }

  // Commit `ep` in one step and tell every thread: the index takes the
  // changes, every shared version they replace or remove is retired under a
  // fresh retireId, and one `vfs-update` carries it all — source and
  // companions of a file never travel apart. A commit that publishes takes
  // the next version, stamped into each entry it publishes before the
  // index takes it — the entry is private until then; a relocation keeps
  // the version of every entry it moves, and the kernel's. Before
  // initialize() completes there is no link to tell; a closed kernel
  // publishes nothing. Returns the version after the commit — unchanged
  // when the epoch published nothing — or null when the kernel is closed:
  // what a caller that must not report a publication that never happened
  // checks (#commit).
  #flush(ep) {
    if (this.state === 'closed') return null;
    const version = ep.relocation ? this.#version : this.#version + 1;
    const places = {};
    const segments = new Set();
    const retired = [];
    const retiredAt = Date.now();
    for (const [name, changes] of ep.changes) {
      const entries = [];
      const removals = [];
      const retiring = [];
      for (const [key, entry] of changes) {
        // An entry makes the commit a publication: the version is taken.
        if (entry && !ep.relocation) entry.version = version;
        const old = entry
          ? this.cache.put(name, key, entry)
          : this.cache.remove(name, key);
        if (entry) {
          entries.push([key, entry]);
          if (entry.kind === 'shared' && entry.length > 0) {
            segments.add(entry.segmentId);
          }
        } else if (old) {
          removals.push(key);
        }
        if (old?.kind === 'shared' && old.length > 0) {
          const record = this.#retirement.retire(name, key, old, retiredAt);
          retiring.push([key, record.id]);
          retired.push(record);
        }
      }
      if (entries.length > 0 || removals.length > 0) {
        places[name] = { entries, removals, retired: retiring };
      }
    }
    if (Object.keys(places).length === 0) return this.#version;
    const updateId = ++this.nextUpdateId;
    this.#retirement.commit(updateId, retired);
    const newSegments = [];
    for (const id of segments) {
      newSegments.push({ id, sab: this.cache.getSegment(id).sab });
    }
    const msg = { name: UPDATE, updateId, version, places, newSegments };
    this.#retirement.hold(this.#apply(msg), MAIN);
    for (const port of this.links.values()) port.postMessage(msg);
    this.#settle(this.#retirement.track(updateId, retired, this.links));
    return version;
  }

  // The commit of an application's mutation, which settles as published or
  // refused: a kernel closed after the publication's last step and before
  // its commit — close() is synchronous, a publication is not — published
  // nothing, and the mutation rejects as the closed kernel, never resolves.
  #commit(ep) {
    const committed = this.#flush(ep);
    if (committed === null) throw closedError();
    return committed;
  }

  // Apply one update to this thread's projection — the main thread's in
  // #flush, a worker's for each update its port delivers, in order — and
  // take its version. Retired versions a local consumer still reads are
  // bound to their retireId before the projection drops them; returns
  // those ids. An update of a newer version is a publication: what it
  // created, replaced and removed — source keys only — is announced to
  // the 'publish' listeners, and built only when there are some. An update
  // without a version — of a main kernel that sends none — is applied,
  // announced to no one, and leaves the thread's version as it was.
  #apply({ places, newSegments, version }) {
    for (const { id, sab } of newSegments || []) this.segmentsMap.set(id, sab);
    const publication = version > this.#version;
    const changed =
      publication && this.listenerCount('publish') > 0 ? {} : null;
    const retained = [];
    for (const [name, { entries, removals, retired }] of Object.entries(
      places,
    )) {
      const place = this.registry.get(name);
      if (!place) continue;
      const { files } = place;
      const record = changed && { created: [], replaced: [], removed: [] };
      for (const [key, id] of retired || []) {
        if (this.pins.retain(files.get(key), id)) retained.push(id);
      }
      for (const [key, entry] of entries) {
        if (record && !isCompanionKey(key)) {
          (files.has(key) ? record.replaced : record.created).push(key);
        }
        files.set(key, FilesystemCache.projectEntry(entry, this.segmentsMap));
      }
      for (const key of removals) {
        if (record && !isCompanionKey(key)) record.removed.push(key);
        files.delete(key);
      }
      if (record && !isEmpty(record)) changed[name] = record;
    }
    this.#version = version ?? this.#version;
    if (changed) this.#announce(deepFreeze({ version, places: changed }));
    return retained;
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

  // A worker applied `updateId`. `retained` lists the retired versions it
  // still reads; they are held before its ACK can free anything.
  handleAck(updateId, linkId, retained) {
    this.#settle(this.#retirement.ack(updateId, linkId, retained));
  }

  // The last consumer of these retired versions in one thread is done.
  handleRelease(holder, retireIds) {
    this.#settle(this.#retirement.release(holder, retireIds));
  }

  // A worker is gone: it will neither ACK nor read anything any more.
  handleWorkerExit(linkId) {
    this.#settle(this.#retirement.exit(linkId));
  }

  // Free every record neither an ACK nor a consumer holds any more — the
  // only free of a retired version — then compact once. Nothing is ever
  // freed on a timeout. Most ACKs settle nothing: an empty list costs no
  // walk.
  #settle(records) {
    if (!this.cache || records.length === 0) return;
    let freed = false;
    for (const record of records) {
      if (!this.#retirement.take(record)) continue;
      this.cache.free(record.entry);
      freed = true;
    }
    if (freed) this.#compact();
  }

  // At most one relocation per free cycle: the moves are committed like any
  // change, and their old locations are retired like any replaced version —
  // a consumer still reading one keeps it. A relocation publishes nothing
  // new: every entry keeps its version, and so does the kernel.
  #compact() {
    const moves = this.cache.compact(this.config.global.compaction.threshold);
    if (!moves) return;
    const ep = this.#newEpoch(true);
    for (const { name, key, entry } of moves) {
      this.#stage(ep, this.registry.get(name), key, entry);
    }
    this.#flush(ep);
  }

  // --- Worker side ---

  // Worker projection of `snapshot`, at its version and with the instance
  // of the main kernel it was taken from. With `port` (the link end from
  // `link()`, wired by attach()) it applies deltas, ACKs them, releases
  // retired versions and sends mutations of shared virtual places. Only
  // local Map writes prepare in a worker: a preparer missing from
  // `options.preparers` fails such a write, never the projection.
  static fromSnapshot(snapshot, config, options = {}) {
    const kernel = new VfsKernel(config, options);
    for (const { id, sab } of snapshot?.segments || []) {
      kernel.segmentsMap.set(id, sab);
    }
    kernel.#version = snapshot?.version ?? 0;
    if (snapshot?.instance) kernel.#instance = snapshot.instance;
    if (options.port) kernel.#connect(options.port);
    for (const pc of config.places) {
      const place = new Place(pc, kernel.appRoot);
      place.preparers = kernel.preparers.bind(place, false);
      place.store = kernel.#storeOf(place);
      const index = SHARED.has(pc.provider)
        ? snapshot?.places?.[pc.name]
        : null;
      if (index) {
        FilesystemCache.project(index, kernel.segmentsMap, place.files);
      }
      kernel.registry.register(place);
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
  // which its ACK must carry.
  handleDelta(msg) {
    return msg?.name === UPDATE ? this.#apply(msg) : [];
  }
}

module.exports = { VfsKernel, KERNEL, readInto };
