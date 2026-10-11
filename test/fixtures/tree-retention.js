'use strict';

// The fixture of test/tree-retention.test.js: one check per process, run
// with --expose-gc; its figures go to stdout as one line of JSON, and the
// test holds them to its thresholds. The engine is test/tree-engine.js's.
//
//   node --expose-gc test/fixtures/tree-retention.js <check>
//
//   objects  a WeakRef on every object of the clone of a snapshot, of
//            deltas, of ops and of rows: alive after the call, one turn of
//            the event loop and one full GC
//   strings  the heap a replica frees per removed node whose 2000-char name
//            came from a snapshot, and from a delta
//   keys     the heap per node of trees committed and loaded from keys, ids
//            and names cut from 4 KiB strings, against flat ones
//   lookups  the heap per query of get, resolve and misses whose keys are
//            cut from 4 KiB strings
//   spoil    the answers of a tree after the input of fromSnapshot, apply,
//            commit and load is overwritten with garbage
//
// Two traps of measuring by GC shape the code. A WeakRef keeps its target
// until the job that made it ends, so the GC runs after a turn of the event
// loop. A suspended async function keeps the stale values of its registers
// — the last loop variable, an argument it passed on — so everything that
// touches an input runs in a synchronous function of its own, and the
// async functions hold only results.

const path = require('node:path');
const v8 = require('node:v8');
const {
  Worker,
  MessageChannel,
  isMainThread,
  parentPort,
  workerData,
  receiveMessageOnPort,
} = require('node:worker_threads');
const engine = require('../tree-engine.js');
const data = require('../tree-data.js');

const { KIND } = data;
const SEP = path.sep;
const NO_PINS = { retain: () => false };
const OTHERS = [
  'requireBytecode',
  'scriptBytecode',
  'gzip',
  'deflate',
  'br',
  'zstd',
];
// A value the tree keeps as given — meta, scriptOptions, a policy — carries
// this mark: the walks over an input leave it, and what it holds, alone.
const MARK = 'retentionValue';
const PAD = 'q'.repeat(4096);
const NAME = 2000; // the length of the names of `strings`
const SPOILED = Object.freeze({ spoiled: true });

// --- Measuring ---------------------------------------------------------------

let version = 0;
const next = () => ++version;
const now = () => 1.7e12 + version * 1000 + 0.5;

// The heap once everything dead is collected. A heap snapshot first: V8
// 14.6 (Node 26.10 on Windows) keeps a replica's former state alive past
// an apply until a later turn of the loop — gc() twice, or a major
// last-resort one, frees nothing of it (−2109 B per removed node where
// 24.20 frees 2535) — while the collection a heap snapshot makes frees it
// (.work/stage1/probe26/). The cause is V8's; the figures need the exact
// heap. Costs ~0.1–0.5 s a call. The WeakRef check does not use it: it
// holds to one full GC, as the spec has it.
const heap = () => {
  v8.getHeapSnapshot().destroy();
  global.gc();
  global.gc();
  return process.memoryUsage().heapUsed;
};

const turn = () => new Promise((resolve) => setImmediate(resolve));

// What a check measures for stays alive until the process ends: a tree
// collected together with the input it is checked against would hide what
// it kept.
const keep = [];

// --- Strings -------------------------------------------------------------------

// A flat string of its own, as a structured clone gives one.
const flat = (s) => JSON.parse(JSON.stringify(s));

// The same characters cut from a 4 KiB string of their own, as a key cut
// from a URL or a request path: from 13 chars on V8 makes it a slice that
// keeps the whole parent alive.
const cut = (s) => `${s}?${PAD}`.slice(0, s.length);

// --- Inputs ----------------------------------------------------------------------

const value = (fields) => ({ [MARK]: true, ...fields });

// The input with its meta and scriptOptions marked as values.
const marked = (input) => {
  if (input.meta !== undefined) input.meta = value(input.meta);
  if (input.scriptOptions !== undefined) {
    input.scriptOptions = value(input.scriptOptions);
  }
  return input;
};

// Every object reachable from `root` but the marked values and the shared
// memory, each once, with its path: Map<object, path>.
const objectsOf = (root) => {
  const out = new Map();
  const stack = [[root, '$']];
  while (stack.length > 0) {
    const [item, at] = stack.pop();
    if (item === null || typeof item !== 'object' || out.has(item)) continue;
    if (item instanceof SharedArrayBuffer || item[MARK] === true) continue;
    out.set(item, at);
    if (ArrayBuffer.isView(item)) {
      stack.push([item.buffer, `${at}.buffer`]);
    } else if (item instanceof Map) {
      let i = 0;
      for (const [k, v] of item) {
        stack.push([k, `${at}.keys[${i}]`], [v, `${at}.values[${i}]`]);
        i++;
      }
    } else if (item instanceof Set) {
      let i = 0;
      for (const v of item) stack.push([v, `${at}.values[${i++}]`]);
    } else if (!(item instanceof ArrayBuffer)) {
      const array = Array.isArray(item);
      for (const key of Object.keys(item)) {
        stack.push([item[key], array ? `${at}[${key}]` : `${at}.${key}`]);
      }
    }
  }
  return out;
};

// WeakRefs on every object of `input`.
const watch = (input) => {
  const refs = [];
  for (const [object, at] of objectsOf(input)) {
    refs.push({ ref: new WeakRef(object), at });
  }
  return refs;
};

const aliveOf = (refs) =>
  refs.filter(({ ref }) => ref.deref() !== undefined).map(({ at }) => at);

// '$.nodes[3].payload.extras' and its kin as '$.nodes[*].payload.extras ×n'.
const patternsOf = (paths) => {
  const counts = new Map();
  for (const at of paths) {
    const pattern = at.replace(/\[\d+\]/g, '[*]');
    counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
  }
  return [...counts].map(([pattern, n]) => `${pattern} ×${n}`);
};

const garbage = (v) => {
  if (typeof v === 'number') return -7.5;
  if (typeof v === 'string') return 'spoiled/\\';
  if (typeof v === 'boolean') return !v;
  return SPOILED;
};

// Overwrites every array, typed array and object of `input` but the marked
// values: a tree that reads its input after the call answers from garbage.
const spoil = (input) => {
  for (const object of objectsOf(input).keys()) {
    if (ArrayBuffer.isView(object)) {
      const { buffer, byteOffset, byteLength } = object;
      new Uint8Array(buffer, byteOffset, byteLength).fill(0xa5);
    } else if (object instanceof ArrayBuffer) {
      new Uint8Array(object).fill(0xa5);
    } else if (object instanceof Map) {
      for (const k of [...object.keys()]) object.set(k, SPOILED);
    } else if (object instanceof Set) {
      object.clear();
    } else {
      for (const key of Object.keys(object)) {
        Reflect.set(object, key, garbage(object[key]));
      }
    }
  }
};

// --- Answers -----------------------------------------------------------------------

// What a tree answers, as one string: its numbers, every node top-down with
// its fields, payload and representations — their extents and where `data`
// lies — and the node of every key in `keys`.
const answers = (tree, segments, keys, aggregates) => {
  const rep = (r) => {
    if (r === null) return null;
    const view = r.data;
    const where =
      r.length === 0
        ? view.length
        : [
            view.length,
            view.byteOffset,
            view.buffer === segments.get(r.segmentId),
          ];
    return [r.kind, r.segmentId, r.offset, r.length, where];
  };
  const payload = (p) => {
    if (p === null) return null;
    const { others, extras } = p;
    return [
      p.version,
      p.size,
      p.mtimeMs,
      p.birthtimeMs ?? null,
      rep(p.source),
      others === null ? null : OTHERS.map((field) => rep(others[field])),
      extras === null
        ? null
        : [
            JSON.stringify(extras.meta ?? null),
            JSON.stringify(extras.scriptOptions ?? null),
          ],
    ];
  };
  const out = [tree.version, tree.structureVersion, tree.policyVersion];
  const visit = (node) => {
    out.push([
      tree.pathOf(node),
      tree.nodeId(node),
      tree.nameOf(node),
      tree.classOf(node),
      tree.isDirectory(node),
      tree.countOf(node),
      aggregates ? tree.subtreeVersionOf(node) : null,
      payload(tree.payloadOf(node)),
      JSON.stringify(tree.policyOf(node)),
      JSON.stringify(tree.children(node)),
    ]);
    for (const child of tree.childNodesOf(node)) visit(child);
  };
  const root = tree.get('');
  if (root !== null) visit(root);
  for (const key of keys) {
    const node = tree.get(key);
    out.push(node === null ? null : tree.nodeId(node));
  }
  return JSON.stringify(out);
};

// --- Trees --------------------------------------------------------------------------

const retireIds = () => new data.RetireIds();

// An FS tree with every kind of content: directory attributes, birthtimes,
// every representation kind, empty and on-disk sources, extras.
const FS_OPTIONS = {
  directories: true,
  birthtime: true,
  aggregates: { classes: true, subtreeVersion: true },
};

const fsInput = (ctx) =>
  marked(
    data.payloadOf(ctx.random, ctx.extents, {
      birthtime: true,
      noSource: true,
    }),
  );

const fsTree = (files) => {
  const segments = data.createSegments(4);
  const ctx = {
    kind: 'fs',
    segments,
    extents: new data.Extents(segments),
    random: data.rng(7),
    keys: data.catalogKeys(files),
    tree: null,
    replica: null,
    aggregates: true,
  };
  ctx.tree = engine.createTree({
    sep: SEP,
    segments,
    retireIds: retireIds(),
    now: now(),
    ...FS_OPTIONS,
  });
  const ops = data.directoriesOf(ctx.keys).map((dir) => ['mkdir', dir]);
  for (const key of ctx.keys) ops.push(['write', key, fsInput(ctx)]);
  for (let i = 0; i < ops.length; i += 2000) {
    ctx.tree.commit(ops.slice(i, i + 2000), next(), now());
  }
  return ctx;
};

// /section-0/category-CC/sub-SSS/item-…: the catalog's file of a leaf.
const fileOf = (ctx, category, sub, item) =>
  ctx.keys[(category * 20 + sub) * 20 + item];

const pad3 = (n) => String(n).padStart(3, '0');

// The FS ops of round `r` (0…4): every op, each on a node of its own.
const fsChanges = (ctx, r) => {
  const base = `/round-${r}`;
  const ops = [
    ['mkdir', base],
    ['mkdir', `${base}/empty`],
    ['write', `${base}/a.html`, fsInput(ctx)],
    ['write', `${base}/deep/er/b.html`, fsInput(ctx), { parents: true }],
    ['write', fileOf(ctx, 0, 0, r), fsInput(ctx)],
    ['move', `/section-0/category-01/sub-${pad3(r)}`, `${base}/moved`],
    ['move', `${base}/a.html`, `${base}/renamed.html`],
    ['unlink', fileOf(ctx, 2, 0, r)],
    ['remove', `/section-0/category-03/sub-${pad3(r)}`],
  ];
  if (r > 0) ops.push(['rmdir', `/round-${r - 1}/empty`]);
  return ops;
};

// Relocations of sources and of derived representations, by id: both of a
// node in an FS tree; one op per id in a tree with client ids, as its
// commits take them — the source of every other node, fs:br of the rest.
const relocations = (ctx, ids) => {
  const { tree, extents } = ctx;
  const both = ctx.kind === 'fs';
  const ops = [];
  ids.forEach((id, i) => {
    const node = tree.byId(id);
    const p = node === null ? null : tree.payloadOf(node);
    if (p === null) return;
    const source = p.source !== null && p.source.length > 0;
    const br = p.others !== null && p.others.br !== null;
    const first = both || i % 2 === 0 || !br;
    if (source && first) {
      ops.push(['relocate', id, KIND.source, extents.next(16)]);
    }
    if (br && (both || !(source && first))) {
      ops.push(['relocate', id, KIND.br, extents.next(16)]);
    }
  });
  return ops;
};

const fsRelocations = (ctx) => {
  const ids = [];
  for (let item = 0; item < 20; item++) {
    ids.push(ctx.tree.nodeId(ctx.tree.get(fileOf(ctx, 4, 0, item))));
  }
  return relocations(ctx, ids);
};

const clientInput = (ctx) => marked(data.payloadOf(ctx.random, ctx.extents));

// A tree with client ids: a root, containers under it (classes 0) and
// leaves under them (classes 1 and 2, 2 a container class too), payloads
// on leaves and on some containers, policies on every seventh node.
const clientTree = (ids, count) => {
  const segments = data.createSegments(4);
  const ctx = {
    kind: ids,
    segments,
    extents: new data.Extents(segments),
    random: data.rng(ids === 'number' ? 21 : 22),
    id: ids === 'number' ? (i) => i : (i) => `id-${i}`,
    count,
    sections: Math.ceil(count / 50),
    tree: null,
    replica: null,
    keys: [],
    aggregates: true,
  };
  ctx.tree = engine.createTree({
    ids,
    containers: [0, 2],
    sep: SEP,
    segments,
    retireIds: retireIds(),
    now: now(),
    aggregates: { classes: true, subtreeVersion: true },
  });
  const { id, sections } = ctx;
  const rows = [
    { id: id(0), parentId: null, name: '', class: 0, policy: value({}) },
  ];
  for (let i = 1; i <= count; i++) {
    const container = i <= sections;
    const row = {
      id: id(i),
      parentId: id(container ? 0 : 1 + (i % sections)),
      name: data.nameOf(ctx.random, i),
      class: container ? 0 : 1 + (i % 2),
    };
    if (!container || i % 3 === 0) row.payload = clientInput(ctx);
    if (i % 7 === 0) row.policy = value({ role: `r${i % 3}` });
    rows.push(row);
  }
  ctx.tree.load(rows, next(), now());
  const root = ctx.tree.get('');
  let i = 0;
  for (const [node] of ctx.tree.walk(root, { depth: Infinity })) {
    if (i++ % 37 === 0) ctx.keys.push(ctx.tree.pathOf(node));
  }
  return ctx;
};

// The parent's id and the name of a live node: what a put that keeps them
// states.
const placeOf = (ctx, i) => {
  const { tree } = ctx;
  const node = tree.byId(ctx.id(i));
  return [tree.nodeId(tree.parentOf(node)), tree.nameOf(node)];
};

// The puts and removes of round `r` (0…2): a creation, one under a node the
// same commit creates, a new payload, an unpublication, a move, a rename, a
// change of class, a policy set and one cleared, a container moved with its
// subtree, a container removed with its subtree.
const clientChanges = (ctx, r) => {
  const { tree, id, count, sections } = ctx;
  const fresh = count + 1 + r * 10;
  const k = sections + 1 + r * 10;
  const node = (i) => tree.byId(id(i));
  return [
    [
      'put',
      id(fresh),
      id(1),
      `new-${r}`,
      { class: 1, payload: clientInput(ctx), policy: value({ role: 'new' }) },
    ],
    ['put', id(fresh + 1), id(fresh), `child-${r}`, { class: 2 }],
    ['put', id(k), ...placeOf(ctx, k), { payload: clientInput(ctx) }],
    ['put', id(k + 1), ...placeOf(ctx, k + 1), { payload: null }],
    ['put', id(k + 2), id(2 + r), tree.nameOf(node(k + 2)), {}],
    ['put', id(k + 3), placeOf(ctx, k + 3)[0], `renamed-${r}`, {}],
    [
      'put',
      id(k + 4),
      ...placeOf(ctx, k + 4),
      { class: tree.classOf(node(k + 4)) === 1 ? 2 : 1 },
    ],
    [
      'put',
      id(k + 5),
      ...placeOf(ctx, k + 5),
      { policy: value({ role: `p${r}` }) },
    ],
    ['put', id(7 * (r + 1)), ...placeOf(ctx, 7 * (r + 1)), { policy: null }],
    ['put', id(5 + r), id(20 + r), tree.nameOf(node(5 + r)), {}],
    ['remove', id(sections - r)],
  ];
};

const clientRelocations = (ctx) => {
  const ids = [];
  for (let i = ctx.sections + 40; i < ctx.sections + 80; i++) ids.push(i);
  return relocations(ctx, ids.map(ctx.id)).slice(0, 12);
};

// The tree's state as rows, with changes: new payloads, a rename, a new
// policy, a new row; a leaf left out is removed.
const clientRows = (ctx, r) => {
  const { tree, id } = ctx;
  const root = tree.get('');
  const nodes = [root];
  for (const [node] of tree.walk(root, { depth: Infinity })) nodes.push(node);
  const rows = [];
  let dropped = false;
  let changed = 0;
  for (const node of nodes) {
    const parent = tree.parentOf(node);
    const row = {
      id: tree.nodeId(node),
      parentId: parent === null ? null : tree.nodeId(parent),
      name: tree.nameOf(node),
      class: tree.classOf(node),
    };
    const leaf = row.class !== 0 && tree.countOf(node) === 0;
    if (leaf && !dropped && rows.length > 100 + r) {
      dropped = true;
      continue;
    }
    if (leaf && rows.length % 97 === r) {
      changed++;
      if (changed === 1) row.name = `reloaded-${r}`;
      else if (changed === 2) row.policy = value({ role: `l${r}` });
      else row.payload = clientInput(ctx);
    }
    rows.push(row);
  }
  rows.push({
    id: id(ctx.count + 500 + r),
    parentId: id(1),
    name: `loaded-${r}`,
    class: 1,
    payload: clientInput(ctx),
  });
  return rows;
};

// --- 1. objects ------------------------------------------------------------------------

const snapshotCase = (ctx) => {
  const clone = structuredClone(ctx.tree.snapshot());
  const refs = watch(clone);
  ctx.replica = engine.fromSnapshot(clone, ctx.segments);
  keep.push(ctx.replica);
  return refs;
};

// The delta of `make`'s commit (or load), cloned as a port would, watched
// and applied.
const deltaCase = (ctx, make, load = false) => {
  const { tree } = ctx;
  const input = make();
  const { delta } = load
    ? tree.load(input, next(), now())
    : tree.commit(input, next(), now());
  const clone = structuredClone(delta);
  const refs = watch(clone);
  ctx.replica.apply(clone, NO_PINS);
  return refs;
};

// The ops (or rows) of `make`, watched and committed (or loaded); the
// replica follows.
const inputCase = (ctx, make, load = false) => {
  const { tree } = ctx;
  const input = make();
  const refs = watch(input);
  const { delta } = load
    ? tree.load(input, next(), now())
    : tree.commit(input, next(), now());
  if (delta !== null) ctx.replica.apply(structuredClone(delta), NO_PINS);
  return refs;
};

const objects = async () => {
  const cases = [];
  // After the turn and one full GC, as a worker would be by its next task.
  const record = async (name, refs) => {
    await turn();
    global.gc();
    const alive = aliveOf(refs);
    cases.push({
      name,
      watched: refs.length,
      alive: alive.length,
      paths: patternsOf(alive),
    });
  };
  const fs = fsTree(3000);
  keep.push(fs.tree);
  await record('fs: snapshot after fromSnapshot', snapshotCase(fs));
  for (let r = 0; r < 3; r++) {
    await record(
      `fs: delta ${r} after apply`,
      deltaCase(fs, () => fsChanges(fs, r)),
    );
  }
  await record(
    'fs: relocation delta after apply',
    deltaCase(fs, () => fsRelocations(fs)),
  );
  for (let r = 3; r < 5; r++) {
    await record(
      `fs: ops ${r} after commit`,
      inputCase(fs, () => fsChanges(fs, r)),
    );
  }
  for (const ids of ['number', 'string']) {
    const c = clientTree(ids, 2000);
    keep.push(c.tree);
    await record(`${ids}: snapshot after fromSnapshot`, snapshotCase(c));
    for (let r = 0; r < 2; r++) {
      await record(
        `${ids}: delta ${r} after apply`,
        deltaCase(c, () => clientChanges(c, r)),
      );
    }
    await record(
      `${ids}: relocation delta after apply`,
      deltaCase(c, () => clientRelocations(c)),
    );
    await record(
      `${ids}: load delta after apply`,
      deltaCase(c, () => clientRows(c, 0), true),
    );
    await record(
      `${ids}: ops after commit`,
      inputCase(c, () => clientChanges(c, 2)),
    );
    await record(
      `${ids}: rows after load`,
      inputCase(c, () => clientRows(c, 1), true),
    );
  }
  return { check: 'objects', cases };
};

// --- 2. strings ------------------------------------------------------------------------

const STRING_FILES = 10000;
const STRING_DIRS = 100;

// Unique in the first chars, so that comparing two names is short.
const longName = (i) => `${String(i).padStart(6, '0')}${'n'.repeat(NAME - 6)}`;

// The main tree, made and dropped here: its snapshot and deltas wait on the
// port as the messages a worker takes. `born`: the long names come in the
// snapshot, or in a delta after it. Then a delta removes every file but
// one. Returns how many it removes.
const stringMessages = (born, port) => {
  const segments = data.createSegments(1);
  const tree = engine.createTree({
    sep: SEP,
    segments,
    retireIds: retireIds(),
    now: now(),
  });
  const dirs = [];
  for (let d = 0; d < STRING_DIRS; d++) dirs.push(['mkdir', `/d${d}`]);
  const files = [];
  for (let i = 0; i < STRING_FILES; i++) {
    files.push(`/d${i % STRING_DIRS}/${longName(i)}`);
  }
  const writes = files.map((key) => [
    'write',
    key,
    { size: 1, mtimeMs: 1.7e12, representations: [] },
  ]);
  const first = born === 'snapshot' ? [...dirs, ...writes] : dirs;
  tree.commit(first, next(), now());
  port.postMessage({ snapshot: tree.snapshot(), segments });
  if (born === 'delta') {
    port.postMessage({ delta: tree.commit(writes, next(), now()).delta });
  }
  const unlinks = files.slice(1).map((key) => ['unlink', key]);
  port.postMessage({ delta: tree.commit(unlinks, next(), now()).delta });
  return files.length - 1;
};

const stringCase = (born) => {
  const { port1, port2 } = new MessageChannel();
  const removed = stringMessages(born, port1);
  const plan =
    born === 'snapshot'
      ? ['build', 'measure', 'apply', 'measure']
      : ['build', 'apply', 'measure', 'apply', 'measure'];
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: { check: 'strings', port: port2, plan },
      transferList: [port2],
    });
    worker.once('error', reject);
    worker.once('message', (marks) => {
      port1.close();
      worker.terminate().then(() => {
        if (marks.error) return void reject(new Error(marks.error));
        const [before, after] = marks;
        const freed = before - after;
        resolve({ removed, before, after, freedPerNode: freed / removed });
      }, reject);
    });
  });
};

const strings = async () => ({
  check: 'strings',
  name: NAME,
  snapshot: await stringCase('snapshot'),
  delta: await stringCase('delta'),
});

// The worker side: the replica in a heap of its own, so that the main
// tree's names do not count.
const holder = { replica: null };

const takeSnapshot = (port) => {
  const { snapshot, segments } = receiveMessageOnPort(port).message;
  holder.replica = engine.fromSnapshot(snapshot, segments);
};

const takeDelta = (port) => {
  holder.replica.apply(receiveMessageOnPort(port).message.delta, NO_PINS);
};

const stringsWorker = async () => {
  const { port, plan } = workerData;
  const base = heap();
  const marks = [];
  for (const step of plan) {
    if (step === 'build') takeSnapshot(port);
    else if (step === 'apply') takeDelta(port);
    else {
      await turn();
      marks.push(heap() - base);
    }
  }
  keep.push(holder.replica);
  parentPort.postMessage(marks);
};

// --- 3. keys ---------------------------------------------------------------------------

const KEY_NODES = 10000;

// Ids of every length too, unique by their head.
const idOf = (i) => `${i}:${'i'.repeat(i % 24)}`;

// A tree of KEY_NODES nodes from `variant`'s input, every key, id and name
// made by `make` (flat, or cut from a 4 KiB string of its own); the input
// is gone once this returns. Half the nodes are directories (containers),
// half are files (leaves), each under one of its own.
const keyTree = (variant, make) => {
  const random = data.rng(5);
  const segments = data.createSegments(1);
  const extents = new data.Extents(segments);
  const input = () => ({
    size: 1,
    mtimeMs: 1.7e12,
    representations: [[KIND.source, extents.next(8)]],
  });
  const half = KEY_NODES / 2;
  const options = { sep: SEP, segments, retireIds: retireIds(), now: now() };
  if (variant === 'fs commit') {
    const tree = engine.createTree(options);
    const ops = [];
    for (let i = 0; i < half; i++) {
      const dir = `/${data.nameOf(random, i)}`;
      const file = `${dir}/${data.nameOf(random, half + i)}`;
      ops.push(['mkdir', make(dir)], ['write', make(file), input()]);
    }
    tree.commit(ops, next(), now());
    return { tree, nodes: KEY_NODES };
  }
  const tree = engine.createTree({
    ...options,
    ids: 'string',
    containers: [0],
  });
  const rows = [{ id: make('root'), parentId: null, name: '', class: 0 }];
  for (let i = 1; i < half; i++) {
    rows.push({
      id: make(idOf(i)),
      parentId: make('root'),
      name: make(data.nameOf(random, i)),
      class: 0,
    });
    rows.push({
      id: make(idOf(half + i)),
      parentId: make(idOf(i)),
      name: make(data.nameOf(random, half + i)),
      class: 1,
      payload: input(),
    });
  }
  if (variant === 'string load') tree.load(rows, next(), now());
  else {
    const ops = rows.map((row) => {
      const fields = { class: row.class };
      if (row.payload !== undefined) fields.payload = row.payload;
      return ['put', row.id, row.parentId, row.name, fields];
    });
    tree.commit(ops, next(), now());
  }
  return { tree, nodes: rows.length };
};

const perNode = async (variant, make) => {
  const base = heap();
  const built = keyTree(variant, make);
  await turn();
  const after = heap();
  keep.push(built.tree);
  return { nodes: built.nodes, perNode: (after - base) / built.nodes };
};

const keys = async () => {
  const results = [];
  for (const variant of ['fs commit', 'string commit', 'string load']) {
    const own = await perNode(variant, flat);
    const sliced = await perNode(variant, cut);
    results.push({
      variant,
      nodes: own.nodes,
      flat: own.perNode,
      cut: sliced.perNode,
    });
  }
  return { check: 'keys', results };
};

// --- 4. lookups ------------------------------------------------------------------------

const LOOKUP_FILES = 10000;

// A replica, and the queries of `variant` as flat strings (made before the
// measurement starts): the catalog's keys for `get`, its paths below a
// mount for `resolve` with either separator, misses — under a directory,
// below a file, at the root — for `miss` and `match`.
const lookupSetup = (variant) => {
  const sep = variant === 'resolve \\' ? '\\' : '/';
  const segments = data.createSegments(2);
  const extents = new data.Extents(segments);
  const main = engine.createTree({
    sep,
    segments,
    retireIds: retireIds(),
    now: now(),
  });
  const files = data.catalogKeys(LOOKUP_FILES);
  for (const batch of data.catalogBatches(files, extents)) {
    main.commit(batch, next(), now());
  }
  const replica = engine.fromSnapshot(
    structuredClone(main.snapshot()),
    segments,
  );
  const mount = sep === '/' ? '/mnt/site' : 'X:\\mnt\\site';
  let queries = files;
  if (variant.startsWith('resolve')) {
    queries = files.map((key) => mount + key.split('/').join(sep));
  } else if (variant === 'miss' || variant === 'match') {
    queries = files.map((key, i) => {
      const dir = key.slice(0, key.lastIndexOf('/'));
      if (i % 3 === 0) return `${dir}/none-${i}.html`;
      if (i % 3 === 1) return `${key}/below-${i}`;
      return `/nope-${i}/a/b`;
    });
  }
  return { replica, queries: flat(queries), from: mount.length };
};

// Every query cut from a 4 KiB string of its own, asked once; the strings
// are gone once this returns.
const ask = (ctx, variant) => {
  const { replica, queries, from } = ctx;
  for (const query of queries) {
    const s = cut(query);
    let answer;
    if (variant === 'get' || variant === 'miss') answer = replica.get(s);
    else if (variant === 'match') answer = replica.match(s);
    else answer = replica.resolve(s, from);
    const hit = variant === 'get' || variant.startsWith('resolve');
    const wrong =
      variant === 'match'
        ? !(answer instanceof engine.NotFound)
        : (answer === null) === hit;
    if (wrong) throw new Error(`${variant} ${query}: a wrong answer`);
  }
  return queries.length;
};

const perQuery = async (variant) => {
  const ctx = lookupSetup(variant);
  keep.push(ctx.replica);
  const base = heap();
  const queries = ask(ctx, variant);
  await turn();
  const after = heap();
  return { variant, queries, perQuery: (after - base) / queries };
};

const lookups = async () => {
  const results = [];
  for (const variant of ['get', 'resolve /', 'resolve \\', 'miss', 'match']) {
    results.push(await perQuery(variant));
  }
  return { check: 'lookups', results };
};

// --- 5. spoil --------------------------------------------------------------------------

// A sample of keys to ask: the catalog's, the round's, misses.
const askedOf = (ctx) => {
  const asked = ['/', '/nope', '/round-0/renamed.html', '/round-1/moved'];
  // A client tree's keys are a sample already.
  const step = ctx.kind === 'fs' ? 37 : 1;
  for (let i = 0; i < ctx.keys.length; i += step) asked.push(ctx.keys[i]);
  return asked;
};

// `expected` against `actual`, each a function giving the answers; a throw
// counts as a difference.
const compare = (name, expected, actual) => {
  try {
    return { name, same: expected() === actual() };
  } catch (err) {
    return { name, same: false, error: String(err.stack || err) };
  }
};

const answersOf = (ctx, tree) => () =>
  answers(tree, ctx.segments, askedOf(ctx), ctx.aggregates);

// A replica of the main tree as it is, from an input no one spoils: each
// case starts from one, so a replica a case spoiled spoils no other case.
const freshReplica = (ctx) => {
  const snapshot = structuredClone(ctx.tree.snapshot());
  ctx.replica = engine.fromSnapshot(snapshot, ctx.segments);
  keep.push(ctx.replica);
};

const spoilSnapshot = (ctx) => {
  const clone = structuredClone(ctx.tree.snapshot());
  const replica = engine.fromSnapshot(clone, ctx.segments);
  keep.push(replica);
  spoil(clone);
  return compare(
    `${ctx.kind}: fromSnapshot`,
    answersOf(ctx, ctx.tree),
    answersOf(ctx, replica),
  );
};

const spoilDelta = (ctx, name, make, load = false) => {
  freshReplica(ctx);
  const input = make();
  const { delta } = load
    ? ctx.tree.load(input, next(), now())
    : ctx.tree.commit(input, next(), now());
  const clone = structuredClone(delta);
  ctx.replica.apply(clone, NO_PINS);
  spoil(clone);
  return compare(
    `${ctx.kind}: apply of ${name}`,
    answersOf(ctx, ctx.tree),
    answersOf(ctx, ctx.replica),
  );
};

// The replica took the delta before the input was spoiled: it answers as
// the main tree did then.
const spoilInput = (ctx, name, make, load = false) => {
  freshReplica(ctx);
  const input = make();
  const { delta } = load
    ? ctx.tree.load(input, next(), now())
    : ctx.tree.commit(input, next(), now());
  if (delta !== null) ctx.replica.apply(structuredClone(delta), NO_PINS);
  spoil(input);
  return compare(
    `${ctx.kind}: ${name}`,
    answersOf(ctx, ctx.replica),
    answersOf(ctx, ctx.tree),
  );
};

const spoilCheck = () => {
  const results = [];
  const fs = fsTree(3000);
  keep.push(fs.tree);
  results.push(spoilSnapshot(fs));
  results.push(spoilDelta(fs, 'a delta', () => fsChanges(fs, 0)));
  results.push(spoilDelta(fs, 'a relocation', () => fsRelocations(fs)));
  results.push(spoilInput(fs, 'commit', () => fsChanges(fs, 1)));
  for (const ids of ['number', 'string']) {
    const c = clientTree(ids, 2000);
    keep.push(c.tree);
    results.push(spoilSnapshot(c));
    results.push(spoilDelta(c, 'a delta', () => clientChanges(c, 0)));
    results.push(spoilDelta(c, 'a relocation', () => clientRelocations(c)));
    results.push(spoilDelta(c, 'a load', () => clientRows(c, 0), true));
    results.push(spoilInput(c, 'commit', () => clientChanges(c, 1)));
    results.push(spoilInput(c, 'load', () => clientRows(c, 1), true));
  }
  return { check: 'spoil', results };
};

// --- Main --------------------------------------------------------------------------------

const CHECKS = { objects, strings, keys, lookups, spoil: spoilCheck };

const fail = (err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
};

if (isMainThread) {
  const check = CHECKS[process.argv[2]];
  if (check === undefined || typeof global.gc !== 'function') {
    process.stderr.write(
      'usage: node --expose-gc test/fixtures/tree-retention.js ' +
        `<${Object.keys(CHECKS).join('|')}>\n`,
    );
    process.exitCode = 2;
  } else {
    Promise.resolve()
      .then(check)
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch(fail);
  }
} else if (workerData.check === 'strings') {
  stringsWorker().catch((err) => {
    parentPort.postMessage({ error: String(err.stack || err) });
  });
}
