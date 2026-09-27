'use strict';

const path = require('node:path');
const { availableParallelism } = require('node:os');
const { MessageChannel } = require('node:worker_threads');
const { fileExt } = require('metautil');
// The disk past fs-patch (disk.js).
const {
  loadRimraf,
  promises: { open },
} = require('./disk.js');
const { FilesystemCache } = require('./cache.js');
const { Compressor } = require('./compressor.js');
const { PlaceRegistry, FsRouter, namesDirectory } = require('./registry.js');
const { Place, PlaceFiles } = require('./place.js');
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
  CLOSED,
  alive,
  inputOf,
  sharedPublish,
  sharedCopies,
} = require('./publication.js');
const { scan } = require('./scanner.js');
const { INDEXED, SHARED } = require('./config.js');

// VfsKernel — orchestrator and consumer facade.
// Main thread: fills places from their origin (a disk scan, embedded SEA
// assets or application mutations of a virtual place) through one
// publication pipeline — raw input → the preparer of its extension →
// canonical content → bytecode and compressed companions (the SAB sink,
// publication.js) → one epoch, which the kernel commits — watches
// disk-origin places (watch-pipeline.js) and sends each epoch as one
// `vfs-update` to the linked workers. A version an update replaces or
// removes is retired (retirement.js): its bytes are freed only after every
// live worker ACKs the update and no thread still reads them.
// Worker thread: `VfsKernel.fromSnapshot()` projects the same segments
// read-only, applies the deltas arriving on its link port, ACKs each with
// the retired versions it still reads, and sends mutations of shared
// virtual places back over the same port.
// States: new → initializing → ready → closed (final).
//
// Protocol (link port):
//   vfs-update  main → worker  { updateId, places: { <name>: { entries,
//                              removals, retired: [[key, retireId]] } },
//                              newSegments }
//   vfs-ack     worker → main  { updateId, retained?: [retireId] }
//   vfs-release worker → main  { retireIds }
//   vfs-mutate / vfs-mutated   see mutation-rpc.js

const KERNEL = Symbol.for('shared-memory-fs');
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

// Map a SEA asset key to a place key: `<name>/<rest>` → `/<rest>`.
const seaKeyOf = (assetKey, name) =>
  assetKey.startsWith(name + '/') && assetKey.length > name.length + 1
    ? assetKey.substring(name.length)
    : null;

class VfsKernel {
  // The books of ACK-before-free: which retired version waits for whose
  // ACK, and who still holds it. The kernel frees the bytes (#settle).
  #retirement = new Retirement();

  // Live updates of the disk-origin places: watcher epochs, one at a time,
  // published through epochs the kernel opens for it (#epoch) and commits.
  // Created before the constructor below runs: it reads the kernel only
  // when called.
  #watchPipeline = new WatchPipeline(this, () => this.#epoch());

  // The kernel published by the bootstrap (`--import shared-memory-fs/register`).
  static get current() {
    return globalThis[KERNEL] || null;
  }

  static set current(kernel) {
    if (kernel) globalThis[KERNEL] = kernel;
    else delete globalThis[KERNEL];
  }

  constructor(config, options = {}) {
    this.config = config;
    this.appRoot = path.resolve(options.appRoot || process.cwd());
    this.console = options.console || globalThis.console;
    // Injected node:sea-compatible module, for tests.
    this.seaModule = options.seaModule || null;
    // Callbacks the domains' `prepare` names; never part of the config.
    this.preparers = new Preparers(options.preparers);
    this.state = 'new';

    this.registry = new PlaceRegistry(this.appRoot, path, config.global.strict);
    this.router = new FsRouter(this.registry, config.global.strict);
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

  #ensureReady(what) {
    if (this.state === 'ready') return;
    throw new Error(
      `[vfs] ${what} requires a ready kernel (state: ${this.state})`,
    );
  }

  // --- Lifecycle ---

  async initialize() {
    if (this.state !== 'new') {
      throw new Error(`[vfs] initialize() called in state "${this.state}"`);
    }
    this.state = 'initializing';
    // WORKAROUND (disk.js): Node's rimraf loads before the patch does.
    const rimraf = loadRimraf();
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
      await rimraf;
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
  // too and the SAB segments become collectable.
  close() {
    this.state = 'closed';
    this.#watchPipeline.close();
    for (const port of this.links.values()) port.close();
    this.links.clear();
    // Queued mutations reject on the closed kernel; workers learn through
    // the closed port.
    this.mutations.clear();
    // Nothing guards shared bytes any more: active streams stop.
    this.pins.close();
    if (this.mutationClient) this.mutationClient.close(CLOSED);
    // A worker's closed link reads as its exit on the main thread.
    if (this.port) this.port.close();
    this.#retirement.clear();
    this.segmentsMap.clear();
    this.sources.clear();
    this.facades.clear();
    for (const place of this.registry.all()) place.files.clear();
    this.cache = null;
    this.compressor = null;
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
    facade = new PlaceFs(place, this.pins);
    this.facades.set(name, facade);
    return facade;
  }

  // { segments: [{ id, sab }], places: { name: { entries: [[key, entry]] } } }
  // Published entries only: a publication in progress is not part of it.
  snapshot() {
    this.#ensureReady('snapshot()');
    if (!this.cache) throw new Error('[vfs] snapshot() is main-thread only');
    return this.cache.snapshot();
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

  // --- Virtual places ---

  // Order one mutation against the others: per-key FIFO in arrival order,
  // or an exclusive place barrier when `keys` is null (subtree operations).
  // Worker requests and main-thread writes share the queue, so the state a
  // store validates against is the state its publication is applied to.
  enqueueMutation(place, keys, fn) {
    return this.mutations.run(place.name, keys, () => {
      this.#ensureReady('mutations');
      return fn();
    });
  }

  // Publish one canonical version of a virtual key through the pipeline, as
  // one `vfs-update`. Rejects without publishing anything when a required
  // step fails; no debounce or coalescing — one accepted mutation, one
  // update. Publications of different keys may overlap: allocations stay
  // private until #flush commits them.
  async publishVirtual(place, key, raw) {
    const ep = this.#newEpoch();
    const stat = { size: raw.length, mtimeMs: Date.now() };
    await this.#publishEntry(ep, place, key, { data: raw, stat });
    this.#flush(ep);
  }

  // Retire sources and their companions in one message.
  unpublishVirtual(place, keys) {
    const ep = this.#newEpoch();
    for (const key of keys) this.#unstage(ep, place, key);
    this.#flush(ep);
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
    this.#flush(ep);
  }

  // Move a subtree whose sources move as they are (subtreeMoves): each
  // source and companion is copied with its stat and mtime under its new
  // key — nothing is prepared, compiled or compressed again — and the old
  // keys go, in one message. The old versions retire like any replaced
  // version; a failure (the pool is full, the kernel closed) publishes
  // nothing.
  async renameVirtualTree(place, moves) {
    const changes = await sharedCopies(this, place, moves);
    const ep = this.#newEpoch();
    for (const [key, entry] of changes) this.#stage(ep, place, key, entry);
    this.#flush(ep);
  }

  // --- Adapter API ---
  // Consumed by lib/adapters/*, not by application code: these return raw
  // routing decisions and borrowed views, without the ownership and ext
  // policies PlaceFs applies.

  routeRead(filePath) {
    return this.router.read(filePath);
  }

  routeMutation(filePath) {
    return this.router.mutate(filePath);
  }

  routeCopy(filePath, recursive) {
    return this.router.copy(filePath, recursive);
  }

  routeRename(fromPath, toPath) {
    return this.router.rename(fromPath, toPath);
  }

  routeLink(fromPath, toPath) {
    return this.router.link(fromPath, toPath);
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
  //                         a trailing separator — a directory, no module
  //   null                  not ours — default Node loader
  resolveModule(filePath, domain) {
    const route = this.registry.route(filePath);
    if (!route) return null;
    const { place } = route;
    const denied = this.config.global.strict ? { denied: true } : null;
    if (!place) return denied;
    if (place.provider === 'node-default') return null;
    if (!place.config[domain]) return denied;
    if (place.provider === 'disk') return null;
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

  #newEpoch() {
    return {
      changes: new Map(), // place name → Map<key, entry | null>
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
  // anyone and is freed at once.
  #stage(ep, place, key, entry) {
    let changes = ep.changes.get(place.name);
    if (!changes) ep.changes.set(place.name, (changes = new Map()));
    const previous = changes.get(key);
    if (previous) this.cache.free(previous);
    changes.set(key, entry);
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
  // companions of a file never travel apart. Before initialize() completes
  // there is no link to tell; a closed kernel publishes nothing.
  #flush(ep) {
    if (this.state === 'closed') return;
    const places = {};
    const segments = new Set();
    const retired = [];
    const retiredAt = Date.now();
    for (const [name, changes] of ep.changes) {
      const entries = [];
      const removals = [];
      const retiring = [];
      for (const [key, entry] of changes) {
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
    if (Object.keys(places).length === 0) return;
    const updateId = ++this.nextUpdateId;
    this.#retirement.commit(updateId, retired);
    const newSegments = [];
    for (const id of segments) {
      newSegments.push({ id, sab: this.cache.getSegment(id).sab });
    }
    const msg = { name: UPDATE, updateId, places, newSegments };
    this.#retirement.hold(this.#apply(msg), MAIN);
    for (const port of this.links.values()) port.postMessage(msg);
    this.#settle(this.#retirement.track(updateId, retired, this.links));
  }

  // Apply one update to this thread's projection. Retired versions a local
  // consumer still reads are bound to their retireId before the projection
  // drops them; returns those ids.
  #apply({ places, newSegments }) {
    for (const { id, sab } of newSegments || []) this.segmentsMap.set(id, sab);
    const retained = [];
    for (const [name, { entries, removals, retired }] of Object.entries(
      places,
    )) {
      const place = this.registry.get(name);
      if (!place) continue;
      const { files } = place;
      for (const [key, id] of retired || []) {
        if (this.pins.retain(files.get(key), id)) retained.push(id);
      }
      for (const [key, entry] of entries) {
        files.set(key, FilesystemCache.projectEntry(entry, this.segmentsMap));
      }
      for (const key of removals) files.delete(key);
    }
    return retained;
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

  // At most one relocation per free cycle: the moves are published like any
  // change, and their old locations are retired like any replaced version —
  // a consumer still reading one keeps it.
  #compact() {
    const moves = this.cache.compact(this.config.global.compaction.threshold);
    if (!moves) return;
    const ep = this.#newEpoch();
    for (const { name, key, entry } of moves) {
      this.#stage(ep, this.registry.get(name), key, entry);
    }
    this.#flush(ep);
  }

  // --- Worker side ---

  // Worker projection of `snapshot`. With `port` (the link end from
  // `link()`, wired by attach()) it applies deltas, ACKs them, releases
  // retired versions and sends mutations of shared virtual places. Only
  // local Map writes prepare in a worker: a preparer missing from
  // `options.preparers` fails such a write, never the projection.
  static fromSnapshot(snapshot, config, options = {}) {
    const kernel = new VfsKernel(config, options);
    for (const { id, sab } of snapshot?.segments || []) {
      kernel.segmentsMap.set(id, sab);
    }
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
