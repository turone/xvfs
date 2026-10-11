'use strict';

const path = require('node:path');
const v8 = require('node:v8');
const { Worker, MessageChannel } = require('node:worker_threads');
const { median } = require('../harness.js');
const engine = require('../../test/tree-engine.js');
const data = require('../../test/tree-data.js');
const { PlaceFiles } = require('../../lib/place.js');
const { FilesystemCache } = require('../../lib/cache.js');
const { bytecodeKey, compressedKey } = require('../../lib/companion.js');

// The tree engine (.work/stage1/SPEC.md, "Measurements") and, beside it,
// today's index of a place on the same data: the real PlaceFiles, the
// projection of lib/cache.js and the companion keys of lib/companion.js
// (until step B5 removes them). The engine is test/tree-engine.js's:
// TREE_ENGINE, else lib/tree.js.
//
//   node --expose-gc bench/run.js --only tree [--n 10000,100000]
//   node bench/ab.js <base> <new> --only tree [--n 10000]
//
// The data: a catalog /section-S/category-CC/sub-SSS/item-IIIIII.html of n
// files (20 a leaf directory, 20 leaves a category, 20 categories a
// section), 30 % with fs:br and fs:gzip, and two flat directories — /big,
// 1000 files, and /wide, 1023 files, the directory a replacement moves when
// the catalog has no 8000-file section. Sizes: n = 10⁴ and 10⁵, the memory
// of a replica at 10⁶ too; `--n` sets them all. Metrics are
// `tree.<section>.<n>.<what>`, and `…<n>.today.<what>` for today's index;
// a lookup is timed with a fresh key string per call, as a request's is. A
// random read takes its key from a stream of indices built beforehand from
// a seed — uniform, or Zipf (s = 1) over the shuffled keys — so that what a
// round reads does not depend on the number of iterations calibration
// picks: `i % R` was a cycle over the first n keys, or over all of them, by
// that number (Т22).
//
//   memory    a replica built in a fresh worker from a snapshot that came
//             by its port: the heap per file once the snapshot is dropped,
//             and while it is still in scope (as today's attach() keeps
//             it) — plain and with birthtime and directory attributes; the
//             snapshot's serialized size; boxed numbers (heap numbers of a
//             heap snapshot) per file and as a share, up to 10⁵
//   views     in a worker, fromSnapshot and apply with views made on
//             access and — TREE_VIEWS=eager, an implementer's flag the
//             engine may read — eagerly: the heap and a full GC once built,
//             after 10 % and after all representations are read; the first
//             and a repeated access to `data`
//   lookup    get, random — uniform and Zipf — and hot, and resolve;
//             Map.get and slice + get
//   miss      get over the module resolver's candidates, a hot set of them
//             and misses below a file; load on a live tree of client ids
//             with 1 % of the rows changed (new payloads, renames) — the
//             spec's "Misses"
//   policy    get, random and hot, on a tree of client ids with allow at 0,
//             1 and 3 own policies on the path and without allow; check by
//             id
//   listing   children() of a 20-entry and of a 1000-entry directory
//   move      apply of a move of 20 and of 8000 nodes and the deferred cost
//             of the lookups after; a file replacing a file, a directory of
//             8000 files (of 1023 when the catalog is smaller) replacing an
//             empty one, and the size of `retired`; today's index re-keys
//             what moved
//   attach    snapshot + structuredClone + fromSnapshot; today's snapshot,
//             clone and projection
//   delta     apply per replaced, per new and per removed file; the first
//             get of a new file
//   refusal   in a worker: a commit of 10⁴ writes, of 10³ moves, of the
//             removal of a 10⁴-node subtree, and a load of 10⁵ rows —
//             successful and refused at the last op or row; and the
//             successful ones again with TREE_JOURNAL=off, an implementer's
//             flag: the share of the rollback journal, if there is one
//   ids       in a worker, an FS replica's heap per node and its get before
//             and after a `number` tree takes an id of 2³¹ (or −2³¹−1),
//             beyond a small integer of this build, the first pass over the
//             replica's nodes after, and a replica built after
//   numbers   in a worker, with the subtree versions on: the heap per node
//             of a main tree and its replica before and after one file of a
//             size above 2³⁰ (or 2³¹) and one commit of a version above it,
//             the time of those commits and applies, the first pass after
//
// Not part of `npm test` or CI.

const WORKER = path.join(__dirname, '..', 'workers', 'tree-replica.js');
const SEP = path.sep;
const WIN = SEP === '\\';
const BACKSLASH = /\\/g;
const MOUNT = path.resolve('/xvfs-bench/site');
const FROM = MOUNT.length;
const NO_PINS = { retain: () => false };
const { KIND } = data;
const SEGMENT = 16 * 2 ** 20;
const BATCH = 5000; // ops per commit while a tree is built
const BIG = 1000;
const WIDE = 1023;
const HOT = 100;
const CHANGES = 1000; // files per delta
const SIZES = [1e4, 1e5];
const MEMORY_SIZES = [1e4, 1e5, 1e6];
const BOXED_MAX = 1e5; // a heap snapshot of a larger heap takes minutes

// --- Clock, strings, memory ----------------------------------------------------

// The kernel's publication version — one counter for every tree of the
// thread, so that `next` is never below a tree's version — and a commit's
// time.
const clock = {
  version: 0,
  next() {
    return ++this.version;
  },
  now() {
    return 1727900000000.5 + this.version;
  },
};

const label = (n) => n.toExponential().replace('+', '');

const flat = (strings) => JSON.parse(JSON.stringify(strings));

// Keys as requests bring them: a call slices `#key` to a string of its
// own, so no hash is cached and no cache matches it by its pointer. Flat
// beforehand: a template literal makes a cons string, which the first
// comparison would flatten inside a timed call.
const fresh = (keys) => flat(keys.map((key) => `#${key}`));

const shuffled = (array, seed) => data.rng(seed).shuffle(array);

// A stream of STREAM indices below `count`, from a seed, read at `i & MASK`
// by a timed call: uniform, or Zipf with s = 1 — the k-th index drawn in
// proportion to 1/k. What a round reads is then the same whatever the
// number of iterations calibration picks.
const STREAM = 2 ** 18;
const MASK = STREAM - 1;

const streamOf = (count, kind, seed) => {
  const random = data.rng(seed);
  const out = new Uint32Array(STREAM);
  if (kind === 'uniform') {
    for (let i = 0; i < STREAM; i++) out[i] = random.int(count);
    return out;
  }
  const weights = new Float64Array(count);
  let total = 0;
  for (let k = 0; k < count; k++) weights[k] = total += 1 / (k + 1);
  for (let i = 0; i < STREAM; i++) {
    const x = random() * total;
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (weights[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    out[i] = lo;
  }
  return out;
};

const absOf = (key) => MOUNT + key.split('/').join(SEP);

const hr = () => process.hrtime.bigint();
const msSince = (t0) => Number(hr() - t0) / 1e6;

// The heap after a collection; `exact` takes a heap snapshot first. V8
// 14.6 (Node 26.10 on Windows) keeps a tree's former state alive past a
// commit or an apply until a later turn of the loop, and gc() frees
// nothing of it, while the collection of a heap snapshot does
// (.work/stage1/probe26/; test/fixtures/tree-retention.js). A snapshot
// costs time and memory with the heap — seconds at 10⁵ files — so only the
// figures of the workers that commit, apply or read are exact; a replica
// just built from a snapshot measures alike on 24 and 26 without it.
const heap = (exact = false) => {
  if (exact) v8.getHeapSnapshot().destroy();
  global.gc();
  global.gc();
  return process.memoryUsage().heapUsed;
};

const turn = () => new Promise((resolve) => setImmediate(resolve));

// What a timed call returns lands here, so that it is never dead code.
let sink = null;
const use = (value) => {
  sink = value;
  return sink;
};

// One time through `keys` (fresh), ms.
const pass = (reader, keys) => {
  const t0 = hr();
  for (let i = 0; i < keys.length; i++) use(reader.get(keys[i].slice(1)));
  return msSince(t0);
};

// --- Data ----------------------------------------------------------------------

const pad = (n, width) => String(n).padStart(width, '0');

const catalogOf = (n) => {
  const keys = data.catalogKeys(n);
  for (let i = 0; i < BIG; i++) keys.push(`/big/x${pad(i, 4)}.html`);
  for (let i = 0; i < WIDE; i++) keys.push(`/wide/w${pad(i, 4)}.html`);
  return { keys, dirs: data.directoriesOf(keys) };
};

// The payload input of file `i`: a 2 KiB page, its source and, for 30 % of
// the files, fs:br and fs:gzip; mtimeMs a double, as fs.stat gives it.
const inputOf = (extents, i, size = 2048) => ({
  size,
  mtimeMs: 1727900000000.25 + i,
  representations: data
    .catalogKinds(i)
    .map((kind) => [kind, extents.next(kind === KIND.source ? 64 : 32)]),
});

// Room for every extent a run takes without reusing one.
const segmentsFor = (n) =>
  data.createSegments(Math.max(2, Math.ceil((n * 256) / SEGMENT) + 1), SEGMENT);

const commitAll = (tree, ops) => {
  for (let i = 0; i < ops.length; i += BATCH) {
    tree.commit(ops.slice(i, i + BATCH), clock.next(), clock.now());
  }
};

// The main tree of the catalog: mkdir of every directory, a write per file.
const buildTree = (options, ctx) => {
  const tree = engine.createTree({
    sep: SEP,
    segments: ctx.segments,
    retireIds: new data.RetireIds(),
    now: clock.now(),
    ...options,
  });
  const ops = ctx.dirs.map((dir) => ['mkdir', dir]);
  for (let i = 0; i < ctx.keys.length; i++) {
    ops.push(['write', ctx.keys[i], ctx.inputs[i]]);
  }
  commitAll(tree, ops);
  return tree;
};

// --- Today's index -------------------------------------------------------------

const ENCODINGS = { 3: 'gzip', 4: 'deflate', 5: 'br', 6: 'zstd' };
const COMPANIONS = [1, 2, 3, 4, 5, 6];

// The key a representation has in today's index.
const keyOfKind = (key, kind) => {
  if (kind === KIND.source) return key;
  if (kind === KIND.requireBytecode) return bytecodeKey(key, 'require');
  if (kind === KIND.scriptBytecode) return bytecodeKey(key, 'script');
  return compressedKey(key, ENCODINGS[kind]);
};

// The entries a file publishes today, as #flush stamps them: the source and
// each companion under its own key, a shared entry of lib/cache.js each.
const entriesOf = (key, input, version) =>
  input.representations.map(([kind, extent]) => {
    const { segmentId, offset, length } = extent;
    const { size, mtimeMs } = input;
    const encoding = ENCODINGS[kind];
    let stat = { size: length, mtimeMs };
    if (kind === KIND.source) stat = { size, mtimeMs };
    else if (encoding)
      stat = { size: length, sourceSize: size, encoding, mtimeMs };
    const entry = { kind: 'shared', segmentId, offset, length, stat, version };
    if (kind === KIND.source && input.meta) entry.meta = input.meta;
    return [keyOfKind(key, kind), entry];
  });

// The main thread's index of a place today: its published entries by key.
class TodayMain {
  constructor() {
    this.entries = new Map();
  }

  // What #flush sends for these files: their entries, under one version.
  publish(keys, inputs, version) {
    const update = { entries: [], removals: [], retired: [] };
    for (let i = 0; i < keys.length; i++) {
      for (const pair of entriesOf(keys[i], inputs[i], version)) {
        this.entries.set(pair[0], pair[1]);
        update.entries.push(pair);
      }
    }
    return update;
  }

  // A place's part of cache.snapshot().
  snapshot() {
    return { entries: [...this.entries] };
  }
}

// A thread's projection today: PlaceFiles over the projected entries, each
// with its Buffer view.
class TodayReplica {
  constructor(segments) {
    this.segments = segments;
    this.files = new PlaceFiles();
  }

  static fromSnapshot(snapshot, segments) {
    const replica = new TodayReplica(segments);
    FilesystemCache.project(snapshot, segments, replica.files);
    return replica;
  }

  get(key) {
    return this.files.get(key);
  }

  // What routing does past the mount: the rest of the path, '\' made '/'
  // on Windows, then the projection's Map.
  resolve(abs, from) {
    const rel = abs.slice(from);
    return this.files.get(WIN ? rel.replace(BACKSLASH, '/') : rel);
  }

  // What PlaceFs.readdir takes from the index: [name, isDirectory].
  children(dir) {
    const out = [];
    const cut = dir.length + 1;
    for (const [key, isDirectory] of this.files.children(dir)) {
      out.push([key.slice(cut), isDirectory]);
    }
    return out;
  }

  // #apply: bind the pinned retired versions, then set and delete.
  apply(update, pins) {
    const { files } = this;
    const retained = [];
    for (const [key, id] of update.retired) {
      const file = files.get(key);
      if (file && pins.retain(file, id)) retained.push(id);
    }
    for (const [key, entry] of update.entries) {
      files.set(key, FilesystemCache.projectEntry(entry, this.segments));
    }
    for (const key of update.removals) files.delete(key);
    return retained;
  }

  // A move as the flat index has to take it: every source below `from` and
  // its companions re-keyed under `to` — the same projected objects, one
  // delete and one set each. (Today's kernel also copies their bytes,
  // sharedCopies; that is not counted here.)
  move(from, to) {
    const moved = [];
    for (const [key, isDirectory] of this.files.below(from)) {
      if (isDirectory) continue;
      moved.push(key);
      for (const kind of COMPANIONS) {
        const companion = keyOfKind(key, kind);
        if (this.files.has(companion)) moved.push(companion);
      }
    }
    for (const key of moved) {
      const file = this.files.get(key);
      this.files.delete(key);
      this.files.set(to + key.slice(from.length), file);
    }
    return moved.length;
  }
}

// --- Contexts --------------------------------------------------------------------

const setup = (n) => {
  const segments = segmentsFor(n);
  const { keys, dirs } = catalogOf(n);
  const ctx = {
    n,
    nk: label(n),
    segments,
    extents: new data.Extents(segments),
    keys,
    dirs,
    files: keys.length,
    nodes: keys.length + dirs.length + 1,
    inputs: null,
    tree: null,
    today: null,
    replica: null,
    todayReplica: null,
    replicas: [],
    client: null,
  };
  ctx.inputs = keys.map((_, i) => inputOf(ctx.extents, i));
  ctx.tree = buildTree({}, ctx);
  ctx.today = new TodayMain();
  ctx.today.publish(keys, ctx.inputs, clock.next());
  return ctx;
};

// A replica of the main tree in this thread, kept current by publish().
const replicaOf = (ctx) => {
  const clone = structuredClone(ctx.tree.snapshot());
  const replica = engine.fromSnapshot(clone, ctx.segments);
  ctx.replicas.push(replica);
  return replica;
};

// One commit of the main tree, its delta applied by every replica — each
// its own clone, as every worker gets its own message. Returns the commit's
// result and the time of each replica's apply. `clean`: a full GC first,
// so that no pause of the garbage before lands in a timed apply.
const publish = (ctx, ops, clean = false) => {
  if (clean) global.gc();
  const result = ctx.tree.commit(ops, clock.next(), clock.now());
  const times = new Map();
  if (result.delta !== null) {
    for (const replica of ctx.replicas) {
      const clone = structuredClone(result.delta);
      const t0 = hr();
      replica.apply(clone, NO_PINS);
      times.set(replica, msSince(t0));
    }
  }
  return { ...result, times };
};

// Every key the replica must find: a wrong engine would be fast.
const expectAll = (reader, keys, what) => {
  for (const key of keys) {
    if (reader.get(key) === null) throw new Error(`${what}: no ${key}`);
  }
};

// --- Workers ---------------------------------------------------------------------

// A worker of bench/workers/tree-replica.js in `mode`; `messages` wait on
// its port before it starts, so it takes them synchronously, as attach()
// takes the snapshot, and nothing of a message event keeps them.
const inWorker = (mode, workerData = {}, messages = [], env = undefined) =>
  new Promise((resolve, reject) => {
    const { port1, port2 } = new MessageChannel();
    for (const message of messages) port1.postMessage(message);
    const worker = new Worker(WORKER, {
      workerData: { ...workerData, mode, port: port2 },
      transferList: [port2],
      env,
    });
    worker.once('error', reject);
    worker.once('message', (result) => {
      port1.close();
      worker.terminate().then(() => {
        if (result.error) reject(new Error(`worker ${mode}: ${result.error}`));
        else resolve(result);
      }, reject);
    });
  });

const eagerEnv = () => ({ ...process.env, TREE_VIEWS: 'eager' });
const noJournalEnv = () => ({ ...process.env, TREE_JOURNAL: 'off' });

// --- Memory --------------------------------------------------------------------------

const replicaMemory = async (side, snapshot, ctx) => {
  const bytes = v8.serialize(snapshot).length;
  const boxed = ctx.n <= BOXED_MAX;
  const message = { snapshot, segments: ctx.segments };
  const result = await inWorker('memory', { side, boxed }, [message]);
  return { ...result, bytes };
};

const memoryReport = (b, id, r, files) => {
  b.value(`${id}.replica`, 'B/file', 'lower', r.replica / files);
  b.value(`${id}.withSnapshot`, 'B/file', 'lower', r.withSnapshot / files);
  const kept = (r.withSnapshot - r.replica) / files;
  b.value(`${id}.snapshotInScope`, 'B/file', 'lower', kept);
  b.value(`${id}.snapshot`, 'B/file', 'lower', r.bytes / files);
  b.value(`${id}.build`, 'ms', 'lower', r.buildMs);
  if (r.boxed === null) return;
  b.value(`${id}.boxed`, 'B/file', 'lower', r.boxed.bytes / files);
  b.value(`${id}.boxedShare`, '%', 'lower', (100 * r.boxed.bytes) / r.replica);
  b.value(`${id}.slicedStrings`, 'count', 'lower', r.sliced);
};

const memory = async (b, ctx) => {
  const { nk, files } = ctx;
  const plain = await replicaMemory('engine', ctx.tree.snapshot(), ctx);
  memoryReport(b, `tree.memory.${nk}.plain`, plain, files);
  const attributes = { birthtime: true, directories: true };
  const snapshot = buildTree(attributes, ctx).snapshot();
  const attrs = await replicaMemory('engine', snapshot, ctx);
  memoryReport(b, `tree.memory.${nk}.attrs`, attrs, files);
  const today = await replicaMemory('today', ctx.today.snapshot(), ctx);
  memoryReport(b, `tree.memory.${nk}.today`, today, files);
};

// --- Views -----------------------------------------------------------------------------

const addOps = (ctx, dir, count = CHANGES) => {
  const ops = [];
  for (let i = 0; i < count; i++) {
    const input = inputOf(ctx.extents, i);
    ops.push(['write', `${dir}/f${pad(i, 4)}.html`, input, { parents: true }]);
  }
  return ops;
};

const views = async (b, ctx) => {
  const { nk, files } = ctx;
  for (const mode of ['lazy', 'eager']) {
    const snapshot = ctx.tree.snapshot();
    const dir = `/views-${mode}`;
    const { delta } = publish(ctx, addOps(ctx, dir));
    const messages = [{ snapshot, segments: ctx.segments }, { delta }];
    const env = mode === 'eager' ? eagerEnv() : undefined;
    const r = await inWorker('views', {}, messages, env);
    publish(ctx, [['remove', dir]]);
    const id = `tree.views.${nk}.${mode}`;
    b.value(`${id}.fromSnapshot`, 'ms', 'lower', r.buildMs);
    b.value(`${id}.apply`, 'us/file', 'lower', (1000 * r.applyMs) / CHANGES);
    for (const point of ['built', 'read10', 'readAll']) {
      const { heap: h, garbage, gcMs } = r.points[point];
      b.value(`${id}.heap.${point}`, 'B/file', 'lower', h / files);
      b.value(`${id}.garbage.${point}`, 'B/file', 'lower', garbage / files);
      b.value(`${id}.gc.${point}`, 'ms', 'lower', gcMs);
    }
    b.value(`${id}.access.first`, 'ns', 'lower', r.firstNs);
    b.value(`${id}.access.repeat`, 'ns', 'lower', r.repeatNs);
  }
};

// --- Lookups ---------------------------------------------------------------------------

const lookups = (b, ctx) => {
  const { nk, replica, todayReplica } = ctx;
  const files = ctx.keys.slice(0, ctx.n);
  expectAll(replica, files, 'the replica');
  // The hot set is drawn by a seed of its own, apart from the random order.
  const random = shuffled(files, 42);
  const hot = shuffled(files, 7).slice(0, HOT);
  const freshRandom = fresh(random);
  const freshHot = fresh(hot);
  const sameRandom = flat(random);
  const sameHot = flat(hot);
  const absRandom = fresh(random.map(absOf));
  const absHot = fresh(hot.map(absOf));
  const uniform = streamOf(random.length, 'uniform', 1);
  const zipf = streamOf(random.length, 'zipf', 2);
  const sides = [
    [`tree.lookup.${nk}`, replica],
    [`tree.lookup.${nk}.today`, todayReplica],
  ];
  for (const [id, r] of sides) {
    b.ops(`${id}.get.random`, (i) =>
      r.get(freshRandom[uniform[i & MASK]].slice(1)),
    );
    b.ops(`${id}.get.zipf`, (i) => r.get(freshRandom[zipf[i & MASK]].slice(1)));
    b.ops(`${id}.get.hot`, (i) => r.get(freshHot[i % HOT].slice(1)));
    b.ops(`${id}.get.random.same`, (i) => r.get(sameRandom[uniform[i & MASK]]));
    b.ops(`${id}.get.hot.same`, (i) => r.get(sameHot[i % HOT]));
    b.ops(`${id}.resolve.random`, (i) =>
      r.resolve(absRandom[uniform[i & MASK]].slice(1), FROM),
    );
    b.ops(`${id}.resolve.hot`, (i) =>
      r.resolve(absHot[i % HOT].slice(1), FROM),
    );
  }
};

// --- Listing -----------------------------------------------------------------------------

const listing = (b, ctx) => {
  const { nk, replica, todayReplica } = ctx;
  const leaves = shuffled(
    ctx.dirs.filter((dir) => dir.includes('/sub-')),
    3,
  ).slice(0, 200);
  const nodes = leaves.map((dir) => replica.get(dir));
  const big = replica.get('/big');
  if (replica.children(nodes[0]).length !== 20) throw new Error('children');
  if (replica.children(big).length !== BIG) throw new Error('children');
  const L = leaves.length;
  const id = `tree.listing.${nk}`;
  b.ops(`${id}.children20`, (i) => replica.children(nodes[i % L]));
  b.ops(`${id}.children1000`, () => replica.children(big));
  b.ops(`${id}.today.children20`, (i) => todayReplica.children(leaves[i % L]));
  b.ops(`${id}.today.children1000`, () => todayReplica.children('/big'));
};

// --- Misses ------------------------------------------------------------------------------

// What the module resolver asks for require('lodash') from `files`: for
// each directory up from the file's, node_modules/lodash, its extensions,
// its package.json and index files — nearly all misses.
const resolverCandidates = (files) => {
  const out = [];
  for (const file of files) {
    let dir = file.slice(0, file.lastIndexOf('/'));
    for (;;) {
      const base = `${dir}/node_modules/lodash`;
      out.push(base, `${base}.js`, `${base}.json`, `${base}.node`);
      out.push(`${base}/package.json`, `${base}/index.js`);
      out.push(`${base}/index.json`, `${base}/index.node`);
      if (dir === '') break;
      dir = dir.slice(0, dir.lastIndexOf('/'));
    }
  }
  return out;
};

// The candidates of 200 files, one of them a call by a uniform stream; a
// hot set of them; misses below a file.
const misses = (b, ctx) => {
  const { nk, replica, todayReplica } = ctx;
  const files = ctx.keys.slice(0, ctx.n);
  const candidates = fresh(
    resolverCandidates(shuffled(files, 5).slice(0, 200)),
  );
  const hotMisses = candidates.slice(0, HOT);
  const below = fresh(
    shuffled(files, 9)
      .slice(0, 1000)
      .map((k) => `${k}/x`),
  );
  const overCandidates = streamOf(candidates.length, 'uniform', 3);
  const overBelow = streamOf(below.length, 'uniform', 4);
  const id = `tree.miss.${nk}`;
  const sides = [
    [id, replica],
    [`${id}.today`, todayReplica],
  ];
  for (const [at, r] of sides) {
    b.ops(`${at}.resolver`, (i) =>
      r.get(candidates[overCandidates[i & MASK]].slice(1)),
    );
    b.ops(`${at}.hot`, (i) => r.get(hotMisses[i % HOT].slice(1)));
    b.ops(`${at}.belowFile`, (i) => r.get(below[overBelow[i & MASK]].slice(1)));
  }
};

// --- Moves ---------------------------------------------------------------------------------

// [nodes, the subtree, its files]: a catalog smaller than a subtree skips it.
const MOVES = [
  [20, '/section-0/category-00/sub-000', 20],
  [8000, '/section-0', 8000],
];

// The pass over `keys` warm, the first after a full GC — as the pass after
// a move is, which comes after the GC of publish().
const warmPass = (reader, keys) => {
  pass(reader, keys);
  global.gc();
  return pass(reader, keys);
};

// A move of `from` and back, `rounds` times: the apply of every replica and
// the deferred cost of the lookups after — one pass over what moved (at its
// new keys) and 10⁴ other keys, against the same pass warm before the move.
const moveRounds = (b, ctx, sides, from) => {
  const to = `${from}-moved`;
  const moved = ctx.keys.filter((key) => key.startsWith(`${from}/`));
  const others = shuffled(ctx.keys.slice(0, ctx.n), 11)
    .filter((key) => !key.startsWith(`${from}/`))
    .slice(0, 10000);
  const before = fresh([...moved, ...others]);
  const after = fresh([
    ...moved.map((key) => to + key.slice(from.length)),
    ...others,
  ]);
  const results = sides.map(() => ({ apply: [], deferred: [] }));
  const today = { apply: [], deferred: [] };
  for (let r = 0; r <= b.repeats; r++) {
    const warm = sides.map(([, replica]) => warmPass(replica, before));
    const { times } = publish(ctx, [['move', from, to]], true);
    sides.forEach(([, replica], i) => {
      const deferred = pass(replica, after) - warm[i];
      if (r === 0) return;
      results[i].apply.push(times.get(replica));
      results[i].deferred.push(deferred);
    });
    publish(ctx, [['move', to, from]]);
    const todayWarm = warmPass(ctx.todayReplica, before);
    global.gc();
    const t0 = hr();
    ctx.todayReplica.move(from, to);
    const apply = msSince(t0);
    const deferred = pass(ctx.todayReplica, after) - todayWarm;
    ctx.todayReplica.move(to, from);
    if (r === 0) continue;
    today.apply.push(apply);
    today.deferred.push(deferred);
  }
  return { results, today };
};

const moves = (b, ctx) => {
  const { nk } = ctx;
  const sides = [[`tree.move.${nk}`, ctx.replica]];
  for (const [size, from, count] of MOVES) {
    const prefix = `${from}/`;
    if (ctx.keys.filter((key) => key.startsWith(prefix)).length < count) {
      continue;
    }
    const { results, today } = moveRounds(b, ctx, sides, from);
    sides.forEach(([id], i) => {
      b.rounds(`${id}.${size}.apply`, 'ms', 'lower', results[i].apply);
      b.rounds(`${id}.${size}.deferred`, 'ms', 'lower', results[i].deferred);
    });
    b.rounds(`tree.move.${nk}.today.${size}.apply`, 'ms', 'lower', today.apply);
    const deferred = today.deferred;
    b.rounds(`tree.move.${nk}.today.${size}.deferred`, 'ms', 'lower', deferred);
  }
};

// A replacement — `[unlink to, move from to]`, `[rmdir to, move from to]` —
// and its undoing, `rounds` times: the apply, the deferred cost of the
// lookups of `keys` (what moved, at its new keys), the size of `retired`.
const replaceRounds = (b, ctx, replace, undo, before, after) => {
  const out = { apply: [], deferred: [], retired: 0 };
  for (let r = 0; r <= b.repeats; r++) {
    const warm = warmPass(ctx.replica, before);
    const { times, retired } = publish(ctx, replace(), true);
    const deferred = pass(ctx.replica, after) - warm;
    publish(ctx, undo());
    if (r === 0) continue;
    out.apply.push(times.get(ctx.replica));
    out.deferred.push(deferred);
    out.retired = retired.length;
  }
  return out;
};

const replacements = (b, ctx) => {
  const { nk } = ctx;
  const id = `tree.move.${nk}`;
  const report = (name, out) => {
    b.rounds(`${id}.${name}.apply`, 'ms', 'lower', out.apply);
    b.rounds(`${id}.${name}.deferred`, 'ms', 'lower', out.deferred);
    b.value(`${id}.${name}.retired`, 'count', 'lower', out.retired);
  };
  const source = '/big/x0000.html';
  const target = '/big/x0001.html';
  const rest = fresh(
    ctx.keys.filter(
      (k) => k.startsWith('/big/') && k !== source && k !== target,
    ),
  );
  const file = replaceRounds(
    b,
    ctx,
    () => [
      ['unlink', target],
      ['move', source, target],
    ],
    () => [
      ['move', target, source],
      ['write', target, inputOf(ctx.extents, 1)],
    ],
    rest,
    rest,
  );
  report('replaceFile', file);
  const [size, dir] = ctx.n >= 8000 ? [8000, '/section-0'] : [1024, '/wide'];
  const moved = ctx.keys.filter((key) => key.startsWith(`${dir}/`));
  publish(ctx, [['mkdir', '/empty']]);
  const directory = replaceRounds(
    b,
    ctx,
    () => [
      ['rmdir', '/empty'],
      ['move', dir, '/empty'],
    ],
    () => [
      ['move', '/empty', dir],
      ['mkdir', '/empty'],
    ],
    fresh(moved),
    fresh(moved.map((key) => `/empty${key.slice(dir.length)}`)),
  );
  report(`replaceDir${size}`, directory);
  publish(ctx, [['rmdir', '/empty']]);
};

// --- Attach --------------------------------------------------------------------------------

const attach = (b, ctx) => {
  const { nk, files } = ctx;
  const parts = { snapshot: [], clone: [], fromSnapshot: [], total: [] };
  const today = { snapshot: [], clone: [], project: [], total: [] };
  for (let r = 0; r <= b.repeats; r++) {
    global.gc();
    const t0 = hr();
    const snapshot = ctx.tree.snapshot();
    const t1 = hr();
    const clone = structuredClone(snapshot);
    const t2 = hr();
    use(engine.fromSnapshot(clone, ctx.segments));
    const t3 = hr();
    global.gc();
    const u0 = hr();
    const todaySnapshot = ctx.today.snapshot();
    const u1 = hr();
    const todayClone = structuredClone(todaySnapshot);
    const u2 = hr();
    use(TodayReplica.fromSnapshot(todayClone, ctx.segments));
    const u3 = hr();
    use(null);
    if (r === 0) continue;
    const ms = (a, z) => Number(z - a) / 1e6;
    parts.snapshot.push(ms(t0, t1));
    parts.clone.push(ms(t1, t2));
    parts.fromSnapshot.push(ms(t2, t3));
    parts.total.push(ms(t0, t3));
    today.snapshot.push(ms(u0, u1));
    today.clone.push(ms(u1, u2));
    today.project.push(ms(u2, u3));
    today.total.push(ms(u0, u3));
  }
  for (const [name, rounds] of Object.entries(parts)) {
    b.rounds(`tree.attach.${nk}.${name}`, 'ms', 'lower', rounds);
  }
  for (const [name, rounds] of Object.entries(today)) {
    b.rounds(`tree.attach.${nk}.today.${name}`, 'ms', 'lower', rounds);
  }
  const bytes = v8.serialize(ctx.tree.snapshot()).length;
  b.value(`tree.attach.${nk}.bytes`, 'B/file', 'lower', bytes / files);
  const todayBytes = v8.serialize(ctx.today.snapshot()).length;
  b.value(
    `tree.attach.${nk}.today.bytes`,
    'B/file',
    'lower',
    todayBytes / files,
  );
};

// --- Deltas --------------------------------------------------------------------------------

const timed = (fn) => {
  const t0 = hr();
  use(fn());
  return msSince(t0);
};

// Today's updates of a delta round: #flush's entries, removals and retired
// keys, the retireIds from today's own books.
const todayReplace = (keys, inputs, version, books) => {
  const update = { entries: [], removals: [], retired: [] };
  for (let i = 0; i < keys.length; i++) {
    update.entries.push(...entriesOf(keys[i], inputs[i], version));
    for (const [kind] of inputs[i].representations) {
      update.retired.push([keyOfKind(keys[i], kind), books.next++]);
    }
  }
  return update;
};

const todayAdd = (ops, version) => {
  const update = { entries: [], removals: [], retired: [] };
  for (const [, key, input] of ops) {
    update.entries.push(...entriesOf(key, input, version));
  }
  return update;
};

const todayRemove = (ops, books) => {
  const update = { entries: [], removals: [], retired: [] };
  for (const [, key, input] of ops) {
    for (const [kind] of input.representations) {
      update.removals.push(keyOfKind(key, kind));
      update.retired.push([keyOfKind(key, kind), books.next++]);
    }
  }
  return update;
};

const deltas = (b, ctx) => {
  const { nk, replica, todayReplica, extents } = ctx;
  const files = ctx.keys.slice(0, ctx.n);
  const indexOf = new Map(files.map((key, i) => [key, i]));
  const engineSide = { replace: [], add: [], addDeferred: [], remove: [] };
  const todaySide = { replace: [], add: [], addDeferred: [], remove: [] };
  const books = { next: 1e9 }; // today's retireIds, apart from the engine's
  const perFile = (ms) => (1000 * ms) / CHANGES;
  for (let r = 0; r <= b.repeats; r++) {
    const chosen = shuffled(files, 1000 + r).slice(0, CHANGES);
    const inputs = chosen.map((key) => inputOf(extents, indexOf.get(key)));
    const writes = chosen.map((key, i) => ['write', key, inputs[i]]);
    const replaced = publish(ctx, writes, true);
    const update = todayReplace(chosen, inputs, clock.version, books);
    global.gc();
    const replaceMs = timed(() =>
      todayReplica.apply(structuredClone(update), NO_PINS),
    );

    const dir = `/delta-${r}`;
    const ops = addOps(ctx, dir);
    const added = ops.map((op) => op[1]);
    const add = publish(ctx, ops, true);
    const addUpdate = todayAdd(ops, clock.version);
    global.gc();
    const addMs = timed(() =>
      todayReplica.apply(structuredClone(addUpdate), NO_PINS),
    );
    // The first get of each new file: work an apply may leave to the
    // lookups after it.
    const firstGets = fresh(added);
    const addDeferred = timed(() => pass(replica, firstGets));
    const todayAddDeferred = timed(() => pass(todayReplica, firstGets));

    const unlinks = added.map((key) => ['unlink', key]);
    const removed = publish(ctx, unlinks, true);
    const removeUpdate = todayRemove(ops, books);
    global.gc();
    const removeMs = timed(() =>
      todayReplica.apply(structuredClone(removeUpdate), NO_PINS),
    );
    publish(ctx, [['rmdir', dir]]);
    if (r === 0) continue;
    engineSide.replace.push(perFile(replaced.times.get(replica)));
    engineSide.add.push(perFile(add.times.get(replica)));
    engineSide.addDeferred.push(perFile(addDeferred));
    engineSide.remove.push(perFile(removed.times.get(replica)));
    todaySide.replace.push(perFile(replaceMs));
    todaySide.add.push(perFile(addMs));
    todaySide.addDeferred.push(perFile(todayAddDeferred));
    todaySide.remove.push(perFile(removeMs));
  }
  for (const [name, rounds] of Object.entries(engineSide)) {
    b.rounds(`tree.delta.${nk}.${name}`, 'us/file', 'lower', rounds);
  }
  for (const [name, rounds] of Object.entries(todaySide)) {
    b.rounds(`tree.delta.${nk}.today.${name}`, 'us/file', 'lower', rounds);
  }
};

// --- Trees with client ids: policies and load ---------------------------------------------

// The catalog as rows of a tree with number ids: the root, a container
// (class 0) per directory, a page (class 1, with a payload) per file.
const clientRowsOf = (keys, dirs, extents) => {
  const ids = new Map([['', 1]]);
  const rows = [{ id: 1, parentId: null, name: '', class: 0 }];
  const containers = [];
  let next = 2;
  for (const dir of dirs) {
    const at = dir.lastIndexOf('/');
    const row = {
      id: next++,
      parentId: ids.get(dir.slice(0, at)),
      name: dir.slice(at + 1),
      class: 0,
    };
    ids.set(dir, row.id);
    rows.push(row);
    containers.push({ row, depth: dir.split('/').length - 1 });
  }
  const pages = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const at = key.lastIndexOf('/');
    const row = {
      id: next++,
      parentId: ids.get(key.slice(0, at)),
      name: key.slice(at + 1),
      class: 1,
      payload: inputOf(extents, i),
    };
    rows.push(row);
    pages.push(row);
  }
  return { rows, containers, pages };
};

const clientSetup = (ctx) => {
  const keys = data.catalogKeys(ctx.n);
  const dirs = data.directoriesOf(keys);
  const client = clientRowsOf(keys, dirs, ctx.extents);
  client.keys = keys;
  client.tree = engine.createTree({
    ids: 'number',
    containers: [0],
    sep: SEP,
    segments: ctx.segments,
    retireIds: new data.RetireIds(),
    now: clock.now(),
  });
  client.tree.load(client.rows, clock.next(), clock.now());
  const clone = structuredClone(client.tree.snapshot());
  client.replica = engine.fromSnapshot(clone, ctx.segments);
  return client;
};

// The main tree's commit or load, its delta applied by the replica; the
// times of both.
const clientPublish = (client, run) => {
  const t0 = hr();
  const { delta } = run(client.tree);
  const main = msSince(t0);
  let apply = 0;
  if (delta !== null) {
    const clone = structuredClone(delta);
    const t1 = hr();
    client.replica.apply(clone, NO_PINS);
    apply = msSince(t1);
  }
  return { main, apply };
};

const clientCommit = (client, ops) =>
  clientPublish(client, (tree) => tree.commit(ops, clock.next(), clock.now()));

const clientLoad = (client, rows) =>
  clientPublish(client, (tree) => tree.load(rows, clock.next(), clock.now()));

// Own policies on the path of every page: none (0), on its section (1),
// on its section, category and leaf directory (3).
const setPolicies = (client, level) => {
  const ops = client.containers.map(({ row, depth }) => {
    const own = level === 3 || (level === 1 && depth === 1);
    const policy = own ? { role: 'reader', level: depth } : null;
    return ['put', row.id, row.parentId, row.name, { policy }];
  });
  clientCommit(client, ops);
};

const policies = (b, ctx) => {
  const { nk, client } = ctx;
  const { replica } = client;
  const allow = (policy, owner, context) => context.roles.has(policy.role);
  const context = { roles: new Set(['reader']) };
  const options = { allow, context };
  const random = fresh(shuffled(client.keys, 42));
  const hot = fresh(shuffled(client.keys, 7).slice(0, HOT));
  const ids = shuffled(
    client.pages.map((row) => row.id),
    13,
  );
  const uniform = streamOf(random.length, 'uniform', 5);
  const overIds = streamOf(ids.length, 'uniform', 6);
  const id = `tree.policy.${nk}`;
  b.ops(`${id}.get.random.none`, (i) =>
    replica.get(random[uniform[i & MASK]].slice(1)),
  );
  b.ops(`${id}.get.hot.none`, (i) => replica.get(hot[i % HOT].slice(1)));
  for (const level of [0, 1, 3]) {
    setPolicies(client, level);
    const node = replica.get(random[0].slice(1), options);
    if (node === null || node instanceof engine.Denied) {
      throw new Error(`policies at ${level}: ${random[0].slice(1)} refused`);
    }
    const p = `p${level}`;
    b.ops(`${id}.get.random.${p}`, (i) =>
      replica.get(random[uniform[i & MASK]].slice(1), options),
    );
    b.ops(`${id}.get.hot.${p}`, (i) =>
      replica.get(hot[i % HOT].slice(1), options),
    );
    b.ops(`${id}.check.${p}`, (i) =>
      replica.check(replica.byId(ids[overIds[i & MASK]]), allow, context),
    );
  }
  setPolicies(client, 0);
};

// load on a live tree, every row stated: 1 % of the pages with a new
// payload — the others without one, so they keep theirs — and 1 % renamed,
// then named back.
const liveLoad = (b, ctx) => {
  const { nk, client, extents } = ctx;
  const changed = Math.max(1, Math.round(client.pages.length / 100));
  const rowsWith = (change) =>
    client.rows.map((row, i) => {
      const out = { id: row.id, parentId: row.parentId, name: row.name };
      return row.class === 1 ? change(out, i) : out;
    });
  const out = { payload: [], payloadApply: [], rename: [], renameApply: [] };
  for (let r = 0; r <= b.repeats; r++) {
    const picked = new Set(
      shuffled(client.pages, 500 + r)
        .slice(0, changed)
        .map((row) => row.id),
    );
    const payloads = rowsWith((row, i) => {
      if (picked.has(row.id)) row.payload = inputOf(extents, i);
      return row;
    });
    const loaded = clientLoad(client, payloads);
    const renamed = rowsWith((row) => {
      if (picked.has(row.id)) row.name = `${row.name}-r`;
      return row;
    });
    const rename = clientLoad(client, renamed);
    clientLoad(
      client,
      rowsWith((row) => row),
    );
    if (r === 0) continue;
    out.payload.push(loaded.main);
    out.payloadApply.push(loaded.apply);
    out.rename.push(rename.main);
    out.renameApply.push(rename.apply);
  }
  const id = `tree.miss.${nk}.load`;
  b.rounds(`${id}.payload1pct`, 'ms', 'lower', out.payload);
  b.rounds(`${id}.payload1pct.apply`, 'ms', 'lower', out.payloadApply);
  b.rounds(`${id}.rename1pct`, 'ms', 'lower', out.rename);
  b.rounds(`${id}.rename1pct.apply`, 'ms', 'lower', out.renameApply);
};

// --- Refusal, id isolation, large numbers: workers --------------------------------------

const refusal = async (b, ctx, withLoad) => {
  const { nk } = ctx;
  const params = { n: ctx.n, repeats: b.repeats, load: withLoad };
  const full = await inWorker('refusal', { ...params, refused: true });
  const lean = await inWorker(
    'refusal',
    { ...params, refused: false },
    [],
    noJournalEnv(),
  );
  for (const [name, rounds] of Object.entries(full.results)) {
    const at = name.startsWith('load') ? 'tree.refusal' : `tree.refusal.${nk}`;
    b.rounds(`${at}.${name}`, 'ms', 'lower', rounds);
    const ok = name.endsWith('.ok') ? lean.results[name] : undefined;
    if (ok === undefined) continue;
    const base = name.slice(0, -'.ok'.length);
    const share = (100 * (median(rounds) - median(ok))) / median(rounds);
    b.value(`${at}.${base}.journal`, '%', 'lower', share);
  }
};

const isolation = async (b, ctx) => {
  const { nk } = ctx;
  for (const variant of ['positive', 'negative']) {
    const r = await inWorker('ids', { n: ctx.n, variant });
    const id = `tree.ids.${nk}.${variant}`;
    b.value(`${id}.before`, 'B/node', 'lower', r.before.heap / r.nodes);
    b.value(`${id}.after`, 'B/node', 'lower', r.after.heap / r.nodes);
    b.value(`${id}.built`, 'B/node', 'lower', r.built.heap / r.nodes);
    b.value(`${id}.get.before`, 'ns/op', 'lower', r.before.getNs);
    b.value(`${id}.get.after`, 'ns/op', 'lower', r.after.getNs);
    b.value(`${id}.get.built`, 'ns/op', 'lower', r.built.getNs);
    b.value(`${id}.pass.before`, 'ms', 'lower', r.before.passMs);
    b.value(`${id}.pass.first`, 'ms', 'lower', r.firstPassMs);
    b.value(`${id}.bigIds`, 'ms', 'lower', r.bigIdsMs);
  }
};

const numbers = async (b, ctx) => {
  const { nk } = ctx;
  for (const variant of ['above30', 'above31']) {
    const r = await inWorker('numbers', { n: ctx.n, variant });
    const id = `tree.numbers.${nk}.${variant}`;
    b.value(`${id}.before`, 'B/node', 'lower', r.before.heap / r.nodes);
    b.value(`${id}.after`, 'B/node', 'lower', r.after.heap / r.nodes);
    b.value(`${id}.size.commit`, 'ms', 'lower', r.size.commitMs);
    b.value(`${id}.size.apply`, 'ms', 'lower', r.size.applyMs);
    b.value(`${id}.version.commit`, 'ms', 'lower', r.version.commitMs);
    b.value(`${id}.version.apply`, 'ms', 'lower', r.version.applyMs);
    b.value(`${id}.pass.before`, 'ms', 'lower', r.before.passMs);
    b.value(`${id}.pass.first`, 'ms', 'lower', r.firstPassMs);
    b.value(`${id}.commit1000.before`, 'ms', 'lower', r.before.commitMs);
    b.value(`${id}.commit1000.after`, 'ms', 'lower', r.after.commitMs);
  }
};

// --- Run -------------------------------------------------------------------------------------

const inProcess = async (b, ctx, first) => {
  ctx.replica = replicaOf(ctx);
  const todayClone = structuredClone(ctx.today.snapshot());
  ctx.todayReplica = TodayReplica.fromSnapshot(todayClone, ctx.segments);
  attach(b, ctx);
  lookups(b, ctx);
  listing(b, ctx);
  misses(b, ctx);
  moves(b, ctx);
  replacements(b, ctx);
  deltas(b, ctx);
  ctx.client = clientSetup(ctx);
  policies(b, ctx);
  liveLoad(b, ctx);
  ctx.client = null;
  await views(b, ctx);
  await refusal(b, ctx, first);
  await isolation(b, ctx);
  await numbers(b, ctx);
};

module.exports = async (b, options = {}) => {
  if (typeof global.gc !== 'function') throw new Error('run with --expose-gc');
  const sizes = options.n ?? SIZES;
  const memorySizes = options.n ?? MEMORY_SIZES;
  const all = [...new Set([...memorySizes, ...sizes])].sort((x, y) => x - y);
  let first = true;
  for (const n of all) {
    process.stderr.write(`  n = ${n}\n`);
    let ctx = setup(n);
    if (memorySizes.includes(n)) await memory(b, ctx);
    ctx.inputs = null;
    if (sizes.includes(n)) {
      await inProcess(b, ctx, first);
      first = false;
    }
    ctx = null;
    await turn();
    global.gc();
  }
};

// For the worker (bench/workers/tree-replica.js): the same data, today's
// index and measuring.
module.exports.helpers = {
  engine,
  data,
  clock,
  SEP,
  NO_PINS,
  BATCH,
  catalogOf,
  inputOf,
  segmentsFor,
  commitAll,
  buildTree,
  TodayReplica,
  flat,
  fresh,
  shuffled,
  heap,
  turn,
  hr,
  msSince,
  use,
  pass,
};
