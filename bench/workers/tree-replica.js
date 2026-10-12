'use strict';

const v8 = require('node:v8');
const {
  parentPort,
  workerData,
  receiveMessageOnPort,
} = require('node:worker_threads');
const { helpers } = require('../scenarios/tree.js');

// The worker side of bench/scenarios/tree.js: one measurement in a fresh
// isolate, by `workerData.mode`. What it needs waits on `workerData.port`
// and is taken synchronously, as attach() takes a snapshot — no message
// event is left to keep it; the figures go back in one message.
//   memory   a replica from the snapshot: heap
//            with the snapshot in scope and dropped; boxed numbers
//   views    the same replica: heap and a full GC as its views are read;
//            the first and a repeated access to `data`; an apply
//   refusal  large commits and loads, successful and refused at the last
//            op or row, in a main tree of this thread
//   ids      an FS replica before and after a `number` tree takes ids
//            beyond a small integer
//   numbers  a main tree and its replica before and after a size and a
//            version above 2³⁰ (or 2³¹)

const {
  engine,
  data,
  clock,
  SEP,
  NO_PINS,
  catalogOf,
  inputOf,
  segmentsFor,
  commitAll,
  buildTree,
  fresh,
  shuffled,
  heap,
  turn,
  hr,
  msSince,
  use,
  pass,
} = helpers;

const OTHERS = [
  'requireBytecode',
  'scriptBytecode',
  'gzip',
  'deflate',
  'br',
  'zstd',
];

const take = () => {
  const received = receiveMessageOnPort(workerData.port);
  if (received === undefined) throw new Error('no message on the port');
  return received.message;
};

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
};

// The objects of this isolate's heap by node type — 'number' is a heap
// number, a boxed double — counted from a heap snapshot as it streams: the
// snapshot of a large heap does not fit in one string.
const countTypes = () =>
  new Promise((resolve, reject) => {
    const stream = v8.getHeapSnapshot();
    const counts = new Map();
    let head = '';
    let types = null;
    let fields = 0;
    let typeAt = 0;
    let sizeAt = 0;
    let field = 0;
    let value = 0;
    let digits = false;
    let type = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      stream.destroy();
      resolve(counts);
    };
    // The integers of the nodes array, field by field, up to its ']'.
    const feed = (text) => {
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c >= 48 && c <= 57) {
          value = value * 10 + c - 48;
          digits = true;
          continue;
        }
        if (digits) {
          if (field === typeAt) type = value;
          else if (field === sizeAt) {
            const name = types[type];
            const entry = counts.get(name) ?? { count: 0, bytes: 0 };
            entry.count++;
            entry.bytes += value;
            counts.set(name, entry);
          }
          field = (field + 1) % fields;
          value = 0;
          digits = false;
        }
        if (c === 93) return true;
      }
      return false;
    };
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      if (done) return;
      if (types === null) {
        head += chunk;
        const at = head.indexOf('"nodes":[');
        if (at === -1) return;
        const json = `${head.slice(0, head.lastIndexOf(',', at))}}`;
        const { meta } = JSON.parse(json).snapshot;
        fields = meta.node_fields.length;
        typeAt = meta.node_fields.indexOf('type');
        sizeAt = meta.node_fields.indexOf('self_size');
        types = meta.node_types[0];
        const rest = head.slice(at + '"nodes":['.length);
        head = '';
        if (feed(rest)) finish();
      } else if (feed(chunk)) {
        finish();
      }
    });
    stream.on('error', reject);
    stream.on('end', finish);
  });

const grown = (before, after, type) => {
  const a = before.get(type) ?? { count: 0, bytes: 0 };
  const z = after.get(type) ?? { count: 0, bytes: 0 };
  return { count: z.count - a.count, bytes: z.bytes - a.bytes };
};

// The replica of the snapshot waiting on the port, and the heap while the
// snapshot is still in scope. In a function of its own, so that nothing
// of the message outlives it.
const build = () => {
  const message = take();
  const { snapshot, segments } = message;
  const t0 = hr();
  const replica = engine.fromSnapshot(snapshot, segments);
  const ms = msSince(t0);
  const withSnapshot = heap();
  use(message);
  use(null);
  return { replica, ms, withSnapshot };
};

// --- memory --------------------------------------------------------------------------

const memory = async () => {
  const { boxed } = workerData;
  const before = boxed ? await countTypes() : null;
  const base = heap();
  const built = build();
  await turn();
  const after = heap();
  const types = boxed ? await countTypes() : null;
  use(built.replica);
  return {
    buildMs: built.ms,
    withSnapshot: built.withSnapshot - base,
    replica: after - base,
    boxed: boxed ? grown(before, types, 'number') : null,
    sliced: boxed ? grown(before, types, 'sliced string').count : null,
  };
};

// --- views ---------------------------------------------------------------------------

// Every Representation of the tree, in a shuffled order.
const representationsOf = (tree) => {
  const out = [];
  const root = tree.get('');
  for (const [node] of tree.walk(root, { depth: Infinity })) {
    const p = tree.payloadOf(node);
    if (p === null) continue;
    if (p.source !== null) out.push(p.source);
    if (p.others === null) continue;
    for (const field of OTHERS) {
      if (p.others[field] !== null) out.push(p.others[field]);
    }
  }
  return shuffled(out, 17);
};

// The time of one full GC, the heap before it and the exact heap after.
const gcPoint = (base) => {
  const before = process.memoryUsage().heapUsed;
  const t0 = hr();
  global.gc();
  const gcMs = msSince(t0);
  const after = heap(true);
  return { heap: after - base, garbage: before - after, gcMs };
};

// ns of reading `data` of reps[from…to).
const access = (reps, from, to) => {
  let bytes = 0;
  const t0 = hr();
  for (let i = from; i < to; i++) bytes += reps[i].data.length;
  const ns = Number(hr() - t0);
  use(bytes);
  return ns;
};

const views = async () => {
  const base = heap(true);
  const built = build();
  await turn();
  const { replica } = built;
  const reps = representationsOf(replica);
  const tenth = Math.floor(reps.length / 10);
  const points = { built: gcPoint(base) };
  const firstTenth = access(reps, 0, tenth);
  points.read10 = gcPoint(base);
  const firstRest = access(reps, tenth, reps.length);
  points.readAll = gcPoint(base);
  const repeat = access(reps, 0, reps.length);
  const { delta } = take();
  const t0 = hr();
  replica.apply(delta, NO_PINS);
  const applyMs = msSince(t0);
  use(replica);
  return {
    buildMs: built.ms,
    applyMs,
    points,
    firstNs: (firstTenth + firstRest) / reps.length,
    repeatNs: repeat / reps.length,
  };
};

// --- refusal -------------------------------------------------------------------------

const mainTree = (n, options = {}) => {
  const segments = segmentsFor(n);
  const ctx = { segments, extents: new data.Extents(segments) };
  Object.assign(ctx, catalogOf(n));
  ctx.inputs = ctx.keys.map((_, i) => inputOf(ctx.extents, i));
  ctx.tree = buildTree(options, ctx);
  ctx.inputs = null;
  return ctx;
};

const commit = (tree, ops) => tree.commit(ops, clock.next(), clock.now());

// ms of a commit that must be refused at its last op.
const refusedMs = (run, last) => {
  const t0 = hr();
  try {
    run();
  } catch (err) {
    const ms = msSince(t0);
    if (err.index !== last) throw err;
    return ms;
  }
  throw new Error('a commit to refuse passed');
};

const okMs = (run) => {
  const t0 = hr();
  use(run());
  return msSince(t0);
};

// An op refused in every tree of the catalog: the directory exists.
const BAD = ['mkdir', '/section-0'];

const WRITES = 10000;
const MOVED = 1000;
const DOOMED_DIRS = 100;
const DOOMED_FILES = 99; // a subtree of 10⁴ nodes and its root
const LOAD_ROWS = 1e5;

const writesOf = (ctx, r) => {
  const ops = [];
  for (let i = 0; i < WRITES; i++) {
    const key = `/batch-${r}/d${i % 100}/f${i}.html`;
    ops.push(['write', key, inputOf(ctx.extents, i), { parents: true }]);
  }
  return ops;
};

const doomedOps = (ctx) => {
  const ops = [['mkdir', '/doomed']];
  for (let d = 0; d < DOOMED_DIRS; d++) {
    ops.push(['mkdir', `/doomed/d${d}`]);
    for (let f = 0; f < DOOMED_FILES; f++) {
      ops.push(['write', `/doomed/d${d}/f${f}.html`, inputOf(ctx.extents, f)]);
    }
  }
  return ops;
};

// 10⁵ rows of a catalog as a tree with number ids, and a last row whose
// parent no row names: refused by the final state, at that row.
const loadRows = (extents) => {
  const keys = data.catalogKeys(LOAD_ROWS - 5001);
  const dirs = data.directoriesOf(keys);
  const ids = new Map([['', 1]]);
  const rows = [{ id: 1, parentId: null, name: '', class: 0 }];
  let id = 2;
  for (const dir of dirs) {
    const at = dir.lastIndexOf('/');
    ids.set(dir, id);
    rows.push({
      id: id++,
      parentId: ids.get(dir.slice(0, at)),
      name: dir.slice(at + 1),
      class: 0,
    });
  }
  keys.forEach((key, i) => {
    const at = key.lastIndexOf('/');
    rows.push({
      id: id++,
      parentId: ids.get(key.slice(0, at)),
      name: key.slice(at + 1),
      class: 1,
      payload: inputOf(extents, i),
    });
  });
  const orphan = { id: id++, parentId: id + 1e6, name: 'orphan', class: 1 };
  return { rows, orphan };
};

// The successful rounds first, the same in both runs — with the journal
// and with TREE_JOURNAL=off, where a refusal could not be rolled back — so
// that their times compare; the refused rounds after, in the first run
// only.
const refusal = async () => {
  const { n, repeats, load, refused } = workerData;
  const ctx = mainTree(n);
  const { tree } = ctx;
  const results = {};
  const record = (name, r, ms) => {
    if (r === 0) return;
    (results[name] ??= []).push(ms);
  };
  const files = ctx.keys.slice(0, MOVED);
  const there = files.map((key) => ['move', key, `${key}.m`]);
  const back = files.map((key) => ['move', `${key}.m`, key]);
  const removal = [['remove', '/doomed']];
  const rows = load ? loadRows(ctx.extents) : null;
  const idTree = () =>
    engine.createTree({
      ids: 'number',
      containers: [0],
      sep: SEP,
      segments: ctx.segments,
      retireIds: new data.RetireIds(),
      now: clock.now(),
    });
  const loads = Math.min(repeats, 3);
  for (let r = 0; r <= repeats; r++) {
    const ops = writesOf(ctx, r);
    record(
      'writes.ok',
      r,
      okMs(() => commit(tree, ops)),
    );
    commit(tree, [['remove', `/batch-${r}`]]);
    record(
      'moves.ok',
      r,
      okMs(() => commit(tree, there)),
    );
    commit(tree, back);
    commitAll(tree, doomedOps(ctx));
    record(
      'removal.ok',
      r,
      okMs(() => commit(tree, removal)),
    );
    if (rows === null || r > loads) continue;
    const target = idTree();
    const run = () => target.load(rows.rows, clock.next(), clock.now());
    record('load1e5.ok', r, okMs(run));
  }
  if (!refused) return { results };
  commitAll(tree, doomedOps(ctx));
  for (let r = 0; r <= repeats; r++) {
    const ops = [...writesOf(ctx, r), BAD];
    const writes = () => commit(tree, ops);
    record('writes.refused', r, refusedMs(writes, ops.length - 1));
    const moves = () => commit(tree, [...there, BAD]);
    record('moves.refused', r, refusedMs(moves, there.length));
    const remove = () => commit(tree, [...removal, BAD]);
    record('removal.refused', r, refusedMs(remove, removal.length));
    if (rows === null || r > loads) continue;
    const empty = idTree();
    const all = [...rows.rows, rows.orphan];
    const run = () => empty.load(all, clock.next(), clock.now());
    record('load1e5.refused', r, refusedMs(run, rows.rows.length));
  }
  return { results };
};

// --- ids -----------------------------------------------------------------------------

// One pass over every node: its id and its payload's fields — what a lazy
// migration of the node objects would make slow.
const touch = (tree) => {
  const t0 = hr();
  const root = tree.get('');
  let sum = 0;
  for (const [node] of tree.walk(root, { depth: Infinity })) {
    sum += Number(tree.nodeId(node));
    const p = tree.payloadOf(node);
    if (p !== null) sum += p.size + p.version;
  }
  use(sum);
  return msSince(t0);
};

// ns per get, the median of rounds over `keys` (fresh).
const getNs = (tree, keys) => {
  const rounds = [];
  for (let r = 0; r <= 5; r++) {
    const ms = pass(tree, keys);
    if (r > 0) rounds.push((ms * 1e6) / keys.length);
  }
  return median(rounds);
};

// A replica of `tree`, its gets and the heap it takes once its snapshot is
// dropped and every node was read — by a get and by a pass: what an engine
// makes lazily, or a cache keeps, is counted alike before and after — and
// the heap before it.
const replicaHeap = async (tree, segments, keys) => {
  const base = heap(true);
  const replica = engine.fromSnapshot(
    structuredClone(tree.snapshot()),
    segments,
  );
  await turn();
  const ns = getNs(replica, keys);
  const passMs = touch(replica);
  return { replica, base, heap: heap(true) - base, getNs: ns, passMs };
};

const ids = async () => {
  const { n, variant } = workerData;
  const big = variant === 'positive' ? 2 ** 31 : -(2 ** 31) - 1;
  const ctx = mainTree(n);
  const keys = fresh(shuffled(ctx.keys, 3).slice(0, 10000));
  const nodes = ctx.keys.length + ctx.dirs.length + 1;
  const a = await replicaHeap(ctx.tree, ctx.segments, keys);
  const before = { heap: a.heap, getNs: a.getNs, passMs: touch(a.replica) };
  const t0 = hr();
  const other = engine.createTree({
    ids: 'number',
    containers: [0],
    sep: SEP,
    segments: ctx.segments,
    retireIds: new data.RetireIds(),
    now: clock.now(),
  });
  const child = variant === 'positive' ? big + 1 : big - 1;
  commit(other, [
    ['put', big, null, '', { class: 0 }],
    ['put', child, big, 'child', { class: 1 }],
  ]);
  const otherReplica = engine.fromSnapshot(
    structuredClone(other.snapshot()),
    ctx.segments,
  );
  const bigIdsMs = msSince(t0);
  const firstPassMs = touch(a.replica);
  const getAfter = getNs(a.replica, keys);
  // The two nodes of the `number` tree and its replica count here too.
  const after = { heap: heap(true) - a.base, getNs: getAfter };
  const b = await replicaHeap(ctx.tree, ctx.segments, keys);
  const built = { heap: b.heap, getNs: b.getNs };
  use([other, otherReplica, a.replica, b.replica]);
  return { nodes, before, after, built, firstPassMs, bigIdsMs };
};

// --- numbers -------------------------------------------------------------------------

const BULK = 1000;

// ms of a commit of BULK new files; they are removed after, untimed.
const bulk = (main, replica, extents, r) => {
  const ops = [];
  for (let i = 0; i < BULK; i++) {
    ops.push([
      'write',
      `/bulk-${r}/f${i}.html`,
      inputOf(extents, i),
      { parents: true },
    ]);
  }
  const t0 = hr();
  const { delta } = commit(main, ops);
  const ms = msSince(t0);
  replica.apply(structuredClone(delta), NO_PINS);
  const removal = commit(main, [['remove', `/bulk-${r}`]]);
  replica.apply(structuredClone(removal.delta), NO_PINS);
  return ms;
};

const numbers = async () => {
  const { n, variant } = workerData;
  const big = variant === 'above30' ? 2 ** 30 + 1 : 2 ** 31 + 1;
  const options = {
    birthtime: true,
    directories: true,
    aggregates: { classes: true, subtreeVersion: true },
  };
  const base = heap(true);
  const ctx = mainTree(n, options);
  const main = ctx.tree;
  const replica = engine.fromSnapshot(
    structuredClone(main.snapshot()),
    ctx.segments,
  );
  await turn();
  const nodes = 2 * (ctx.keys.length + ctx.dirs.length + 1);
  // Every node read and a bulk commit made before each heap figure: what an
  // engine makes lazily counts alike before and after.
  touch(main);
  touch(replica);
  const before = {
    passMs: touch(main) + touch(replica),
    commitMs: bulk(main, replica, ctx.extents, 0),
  };
  before.heap = heap(true) - base;
  const input = (size) => ({
    size,
    mtimeMs: clock.now(),
    representations: [[data.KIND.source, ctx.extents.next(64)]],
  });
  let t0 = hr();
  const sized = commit(main, [['write', '/big-size.html', input(big)]]);
  const size = { commitMs: msSince(t0) };
  t0 = hr();
  replica.apply(structuredClone(sized.delta), NO_PINS);
  size.applyMs = msSince(t0);
  clock.version = Math.max(clock.version, big - 1);
  t0 = hr();
  const versioned = commit(main, [['write', '/big-version.html', input(1)]]);
  const version = { commitMs: msSince(t0) };
  t0 = hr();
  replica.apply(structuredClone(versioned.delta), NO_PINS);
  version.applyMs = msSince(t0);
  if (main.version !== big) throw new Error(`the version is ${main.version}`);
  const firstPassMs = touch(main) + touch(replica);
  const after = { commitMs: bulk(main, replica, ctx.extents, 1) };
  after.heap = heap(true) - base;
  use(replica);
  return { nodes, before, after, size, version, firstPassMs };
};

// --- Main ----------------------------------------------------------------------------

const MODES = { memory, views, refusal, ids, numbers };

MODES[workerData.mode]().then(
  (result) => parentPort.postMessage(result),
  (err) => parentPort.postMessage({ error: String(err.stack || err) }),
);
