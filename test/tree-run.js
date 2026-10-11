'use strict';

// The runner of the tree engine's differential test (SPEC.md, "Correctness"). Random commits
// go to the reference model (tree-model.js) and to the engine's main tree;
// every delta goes, through structuredClone, to replicas built from
// snapshots at random points. After each commit the main tree and every
// replica are held to the model: outcomes and error codes, the tree's
// numbers, retired lists, nodes, ids, payloads, representations and data
// views, children and their order, counters, subtree versions, lookups and
// misses, policies, walks and iterators, dead nodes, and the identity of
// Node, Payload and Representation objects.
//
//   TREE_SEEDS (40)  TREE_COMMITS (150)  TREE_SEED (one seed)
//   TREE_ONLY=fs,client,policy,walk,aggregates (sections to run)
//   TREE_ENGINE=<module> (default lib/tree.js)

const assert = require('node:assert/strict');
const engine = require('./tree-engine.js');
const { ModelTree, OTHERS, isKey, isName } = require('./tree-model.js');
const data = require('./tree-data.js');

const env = process.env;
const SEEDS = Number(env.TREE_SEEDS ?? 40);
const COMMITS = Number(env.TREE_COMMITS ?? 150);
const ONE = env.TREE_SEED === undefined ? null : Number(env.TREE_SEED);
const SECTIONS = new Set(
  (env.TREE_ONLY ?? 'fs,client,policy,walk,aggregates')
    .split(',')
    .map((s) => s.trim()),
);
const on = (section) => SECTIONS.has(section);

// --- threads: one engine tree and what the test knows of its objects ---------

class Thread {
  constructor(name, tree, segments, main) {
    this.name = name;
    this.tree = tree;
    this.segments = segments;
    this.main = main;
    this.nodes = new Map(); // model node uid → engine node
    this.nodeUid = new Map(); // engine node → model node uid
    this.payloads = new Map(); // model payload uid → engine Payload
    this.payloadUid = new Map();
    this.reps = new Map(); // model rep uid → engine Representation
    this.repUid = new Map();
    this.others = new Map(); // model others uid → engine others object
    this.dead = []; // [engine node, id]
    this.empty = null; // the one shared empty Buffer
    this.containers = null; // this thread's own rule (client trees)
    this.pinned = new Set(); // engine Representations this thread's readers hold
    this.formerReps = []; // retired Representations the test still holds
  }
}

const where = (ctx, thread, what) =>
  `seed ${ctx.seed} commit ${ctx.step} ${thread.name}: ${what}`;

// Map an engine object to a model uid, once and for good.
const bind = (forward, backward, uid, object, what) => {
  const known = forward.get(uid);
  if (known !== undefined) {
    assert.equal(object, known, `${what}: not the same object`);
    return;
  }
  const other = backward.get(object);
  assert.equal(
    other,
    undefined,
    `${what}: an object of another identity reused`,
  );
  forward.set(uid, object);
  backward.set(object, uid);
};

const noSab = (value, what, seen = new Set()) => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.ok(
    !(value instanceof SharedArrayBuffer),
    `${what}: holds a SharedArrayBuffer`,
  );
  if (ArrayBuffer.isView(value)) {
    assert.ok(
      !(value.buffer instanceof SharedArrayBuffer),
      `${what}: a view over a SharedArrayBuffer`,
    );
    return;
  }
  // structured clone carries the contents of collections too
  if (value instanceof Map) {
    for (const [k, v] of value) {
      noSab(k, what, seen);
      noSab(v, what, seen);
    }
  } else if (value instanceof Set) {
    for (const v of value) noSab(v, what, seen);
  }
  for (const key of Object.keys(value)) noSab(value[key], what, seen);
};

// --- the comparison of a thread with the model ------------------------------

const containersOf = (ctx, thread) =>
  ctx.model.fs ? [0] : (thread.containers ?? ctx.model.containers);

const checkRep = (ctx, thread, mrep, rep, what) => {
  assert.ok(
    rep !== null && typeof rep === 'object',
    `${what}: no representation`,
  );
  bind(thread.reps, thread.repUid, mrep.uid, rep, what);
  assert.equal(rep.kind, mrep.kind, `${what}: kind`);
  assert.equal(rep.segmentId, mrep.segmentId, `${what}: segmentId`);
  assert.equal(rep.offset, mrep.offset, `${what}: offset`);
  assert.equal(rep.length, mrep.length, `${what}: length`);
  const view = rep.data;
  assert.ok(Buffer.isBuffer(view), `${what}: data is not a Buffer`);
  assert.equal(view.length, mrep.length, `${what}: data length`);
  if (mrep.length === 0) {
    if (thread.empty === null) thread.empty = view;
    assert.equal(
      view,
      thread.empty,
      `${what}: not the one shared empty Buffer`,
    );
  } else {
    assert.equal(
      view.buffer,
      thread.segments.get(mrep.segmentId),
      `${what}: data over another segment`,
    );
    assert.equal(view.byteOffset, mrep.offset, `${what}: data offset`);
  }
};

const checkPayload = (ctx, thread, mp, p, what) => {
  if (mp === null) {
    assert.equal(p, null, `${what}: payload where the model has none`);
    return;
  }
  assert.ok(p !== null && typeof p === 'object', `${what}: no payload`);
  bind(thread.payloads, thread.payloadUid, mp.uid, p, `${what} payload`);
  assert.equal(p.version, mp.version, `${what}: version`);
  assert.equal(p.size, mp.size, `${what}: size`);
  assert.equal(p.mtimeMs, mp.mtimeMs, `${what}: mtimeMs`);
  if (ctx.model.birthtime)
    assert.equal(p.birthtimeMs, mp.birthtimeMs, `${what}: birthtimeMs`);
  else
    assert.equal(
      p.birthtimeMs,
      undefined,
      `${what}: birthtimeMs without birthtime`,
    );
  const src = mp.reps.get(0);
  if (src === undefined) assert.equal(p.source, null, `${what}: source`);
  else checkRep(ctx, thread, src, p.source, `${what} source`);
  if (mp.othersUid === null) {
    assert.equal(p.others, null, `${what}: others`);
  } else {
    assert.ok(
      p.others !== null && typeof p.others === 'object',
      `${what}: no others`,
    );
    bind(
      thread.others,
      new Map([...thread.others].map(([k, v]) => [v, k])),
      mp.othersUid,
      p.others,
      `${what} others`,
    );
    assert.deepEqual(Object.keys(p.others), OTHERS, `${what}: others shape`);
    OTHERS.forEach((field, i) => {
      const mrep = mp.reps.get(i + 1);
      if (mrep === undefined)
        assert.equal(p.others[field], null, `${what}: others.${field}`);
      else checkRep(ctx, thread, mrep, p.others[field], `${what} ${field}`);
    });
  }
  if (mp.extras === null) {
    assert.equal(p.extras, null, `${what}: extras`);
  } else {
    assert.ok(
      p.extras !== null && typeof p.extras === 'object',
      `${what}: no extras`,
    );
    if (thread.main) {
      assert.equal(p.extras.meta, mp.extras.meta, `${what}: meta not as given`);
      assert.equal(
        p.extras.scriptOptions,
        mp.extras.scriptOptions,
        `${what}: scriptOptions not as given`,
      );
    } else {
      assert.deepEqual(p.extras.meta, mp.extras.meta, `${what}: meta`);
      assert.deepEqual(
        p.extras.scriptOptions,
        mp.extras.scriptOptions,
        `${what}: scriptOptions`,
      );
    }
  }
};

const iterate = (iterable) => [...iterable];

// A retired representation the test still holds views its own extent on
// every access, however the node's bytes moved since.
const holdFormer = (thread, rep) => {
  thread.formerReps.push({
    rep,
    segmentId: rep.segmentId,
    offset: rep.offset,
    length: rep.length,
  });
  if (thread.formerReps.length > 12) thread.formerReps.shift();
};

const checkFormer = (ctx, thread) => {
  for (const { rep, segmentId, offset, length } of thread.formerReps) {
    const what = (s) => where(ctx, thread, `a retired representation: ${s}`);
    assert.equal(rep.segmentId, segmentId, what('segmentId changed'));
    assert.equal(rep.offset, offset, what('offset changed'));
    assert.equal(rep.length, length, what('length changed'));
    const view = rep.data;
    assert.equal(view.length, length, what('data length'));
    if (length > 0) {
      assert.equal(
        view.buffer,
        thread.segments.get(segmentId),
        what('data over another segment'),
      );
      assert.equal(view.byteOffset, offset, what('data offset'));
    }
  }
};

const compare = (ctx, thread) => {
  const { model } = ctx;
  const t = thread.tree;
  const what = (s) => where(ctx, thread, s);
  checkFormer(ctx, thread);
  assert.equal(t.version, model.version, what('version'));
  assert.equal(
    t.structureVersion,
    model.structureVersion,
    what('structureVersion'),
  );
  assert.equal(t.policyVersion, model.policyVersion, what('policyVersion'));
  const containers = containersOf(ctx, thread);
  const classes = new Set();
  for (const n of model.nodes()) classes.add(n.cls);
  // Newly dead nodes.
  for (const [uid, node] of thread.nodes) {
    if (model.byUid.has(uid)) continue;
    thread.nodes.delete(uid);
    thread.nodeUid.delete(node);
    thread.dead.push([node, ctx.ids.get(uid)]);
    if (thread.main) {
      ctx.deadIds.push(ctx.ids.get(uid));
      if (ctx.deadIds.length > 20) ctx.deadIds.shift();
    }
  }
  if (thread.dead.length > 60) thread.dead.splice(0, thread.dead.length - 60);
  for (const n of model.nodes()) {
    const key = model.pathOf(n);
    const node = t.get(key);
    assert.ok(
      node !== null && !(node instanceof engine.Denied),
      what(`get(${JSON.stringify(key)}) found nothing`),
    );
    bind(thread.nodes, thread.nodeUid, n.uid, node, what(`node ${key}`));
    // ids: the client's, or the engine's — the same in every thread, unique
    // among the live, never given to another node within a run.
    const id = t.nodeId(node);
    if (model.fs) {
      const known = ctx.ids.get(n.uid);
      if (known === undefined) {
        assert.ok(thread.main, what(`a replica shows node ${key} before main`));
        assert.ok(
          Number.isInteger(id) && id >= 0,
          what(`id ${id} not an integer >= 0`),
        );
        assert.ok(!ctx.idOwner.has(id), what(`id ${id} given again`));
        ctx.ids.set(n.uid, id);
        ctx.idOwner.set(id, n.uid);
      } else {
        assert.equal(id, known, what(`id of ${key}`));
      }
    } else {
      assert.equal(id, n.id, what(`id of ${key}`));
      ctx.ids.set(n.uid, n.id);
    }
    assert.equal(t.byId(id), node, what(`byId(${id})`));
    assert.equal(t.nameOf(node), n.name, what(`nameOf ${key}`));
    assert.equal(t.pathOf(node), key, what(`pathOf ${key}`));
    assert.equal(t.classOf(node), n.cls, what(`classOf ${key}`));
    assert.equal(
      t.isDirectory(node),
      model.isContainer(n, containers),
      what(`isDirectory ${key}`),
    );
    const parent = t.parentOf(node);
    if (n.parent === null) assert.equal(parent, null, what('parentOf root'));
    else
      assert.equal(
        parent,
        thread.nodes.get(n.parent.uid),
        what(`parentOf ${key}`),
      );
    if (thread.main)
      assert.equal(t.policyOf(node), n.policy, what(`policyOf ${key}`));
    else assert.deepEqual(t.policyOf(node), n.policy, what(`policyOf ${key}`));
    checkPayload(ctx, thread, n.payload, t.payloadOf(node), what(key));
    const kids = t.children(node);
    const expected = model.children(n, containers);
    if (expected === null)
      assert.equal(kids, null, what(`children of file ${key}`));
    else {
      const sort = (list) =>
        [...list].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      assert.deepEqual(sort(kids), sort(expected), what(`children of ${key}`));
    }
    assert.equal(t.countOf(node), n.kids.length, what(`countOf ${key}`));
    if (model.aggregates.classes) {
      for (const cls of classes)
        assert.equal(
          t.classCountOf(node, cls),
          model.classCount(n, cls),
          what(`classCountOf(${key}, ${cls})`),
        );
      assert.equal(
        t.leafCountOf(node),
        model.leafCount(n, containers),
        what(`leafCountOf ${key}`),
      );
    }
    if (model.aggregates.subtreeVersion)
      assert.equal(
        t.subtreeVersionOf(node),
        n.subVer,
        what(`subtreeVersionOf ${key}`),
      );
  }
  // An FS tree's ids are the engine's: the model takes them, so that the
  // ops by id the generators make name the same nodes in both.
  if (model.fs && thread.main) model.rekey(ctx.ids);
  // The order of children and the trails, once every node is bound.
  for (const n of model.nodes()) {
    const node = thread.nodes.get(n.uid);
    const key = model.pathOf(n);
    const order = iterate(t.childNodesOf(node)).map(
      (k) => thread.nodeUid.get(k) ?? -1,
    );
    assert.deepEqual(
      order,
      n.kids.map((k) => k.uid),
      what(`childNodesOf order of ${JSON.stringify(key)}`),
    );
    // childOf: every child by its name, and a name no child has.
    for (const k of n.kids)
      assert.equal(
        t.childOf(node, k.name),
        thread.nodes.get(k.uid),
        what(`childOf(${JSON.stringify(key)}, ${JSON.stringify(k.name)})`),
      );
    assert.equal(
      t.childOf(node, 'no such child'),
      null,
      what(`childOf(${JSON.stringify(key)}) of a name no child has`),
    );
    if (ctx.random.chance(0.2)) {
      const trail = t.trailOf(node).map((x) => thread.nodeUid.get(x));
      assert.deepEqual(
        trail,
        model.trailOf(n).map((x) => x.uid),
        what(`trailOf ${key}`),
      );
    }
  }
  if (model.root !== null) {
    const root = thread.nodes.get(model.root.uid);
    assert.equal(t.get('/'), root, what("get('/') is the root"));
    if (model.aggregates.classes)
      assert.equal(
        t.classCountOf(root, 99),
        0,
        what('classCountOf a class no node has'),
      );
    assert.equal(t.match('/'), root, what("match('/') is the root"));
    if (!model.aggregates.classes) {
      assert.throws(
        () => t.classCountOf(root, 0),
        { code: 'EINVAL' },
        what('classCountOf when off'),
      );
      assert.throws(
        () => t.leafCountOf(root),
        { code: 'EINVAL' },
        what('leafCountOf when off'),
      );
    }
    if (!model.aggregates.subtreeVersion)
      assert.throws(
        () => t.subtreeVersionOf(root),
        { code: 'EINVAL' },
        what('subtreeVersionOf when off'),
      );
  }
  // Dead nodes answer as missing ones.
  for (const [node, id] of thread.dead.slice(-8)) {
    assert.equal(t.nodeId(node), id, what('nodeId of a dead node'));
    assert.notEqual(t.byId(id), node, what('byId gives a dead node'));
    for (const op of [
      'nameOf',
      'parentOf',
      'pathOf',
      'payloadOf',
      'policyOf',
      'trailOf',
      'children',
      'classOf',
    ]) {
      assert.equal(t[op](node), null, what(`${op} of a dead node`));
    }
    assert.equal(
      t.isDirectory(node),
      false,
      what('isDirectory of a dead node'),
    );
    assert.equal(t.countOf(node), 0, what('countOf of a dead node'));
    if (model.aggregates.classes) {
      assert.equal(
        t.classCountOf(node, 0),
        0,
        what('classCountOf of a dead node'),
      );
      assert.equal(t.leafCountOf(node), 0, what('leafCountOf of a dead node'));
    }
    if (model.aggregates.subtreeVersion)
      assert.equal(
        t.subtreeVersionOf(node),
        null,
        what('subtreeVersionOf of a dead node'),
      );
    assert.equal(
      t.check(node, () => true, null),
      null,
      what('check of a dead node'),
    );
    assert.equal(t.childOf(node, 'x'), null, what('childOf of a dead node'));
    assert.deepEqual(
      iterate(t.childNodesOf(node)),
      [],
      what('childNodesOf of a dead node'),
    );
    assert.deepEqual(iterate(t.walk(node)), [], what('walk from a dead node'));
  }
};

// A fingerprint of everything a thread shows, for "nothing changed".
const fingerprint = (ctx, thread) => {
  const t = thread.tree;
  const tags = new Map();
  const tag = (o) => {
    if (o === null || o === undefined) return String(o);
    if (!tags.has(o)) tags.set(o, tags.size);
    return `#${tags.get(o)}`;
  };
  const out = [t.version, t.structureVersion, t.policyVersion];
  const root = t.get('');
  if (root === null) return out.join('|');
  const stack = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    const p = t.payloadOf(n);
    out.push(
      [
        tag(n),
        t.nodeId(n),
        t.nameOf(n),
        t.classOf(n),
        t.isDirectory(n),
        tag(p),
        p && p.version,
        tag(p && p.source),
        tag(t.policyOf(n)),
        t.countOf(n),
      ].join(','),
    );
    if (ctx.model.aggregates.classes) out.push(t.leafCountOf(n));
    if (ctx.model.aggregates.subtreeVersion) out.push(t.subtreeVersionOf(n));
    const kids = iterate(t.childNodesOf(n));
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out.join('|');
};

// The keys a commit names, by the model as it is: an FS op's keys as
// given; a client put's or row's place (its parent's key and its name) and
// the node of a put or a removal.
const keysOfOps = (ctx, ops, isLoad) => {
  const { model } = ctx;
  const keys = [];
  if (!Array.isArray(ops)) return keys;
  const place = (id, parentId, name) => {
    const n = model.byId.get(id);
    if (n !== undefined) keys.push(model.pathOf(n));
    const p = model.byId.get(parentId);
    if (p !== undefined && isName(name))
      keys.push(`${model.pathOf(p)}/${name}`);
  };
  for (const op of ops) {
    if (isLoad) {
      if (op !== null && typeof op === 'object')
        place(op.id, op.parentId, op.name);
    } else if (!Array.isArray(op)) {
      continue;
    } else if (model.fs) {
      if (isKey(op[1])) keys.push(op[1]);
      if (op[0] === 'move' && isKey(op[2])) keys.push(op[2]);
    } else if (op[0] === 'put') {
      place(op[1], op[2], op[3]);
    } else if (op[0] === 'remove') {
      place(op[1], undefined, undefined);
    }
  }
  return keys;
};

// --- lookups, policies, walks ----------------------------------------------------

const missKeys = (ctx) => {
  const { model, random } = ctx;
  const keys = [];
  const live = [...model.nodes()];
  for (let i = 0; i < 6 && live.length > 0; i++) {
    const n = random.pick(live);
    const base = model.pathOf(n);
    keys.push(`${base}/miss-${random.int(5)}`);
    keys.push(`${base}/miss-${random.int(5)}/deeper`);
  }
  for (const key of random.shuffle([...ctx.former]).slice(0, 10))
    keys.push(key);
  return keys;
};

// One key: get, match and resolve as the model answers them.
const checkKey = (ctx, thread, key) => {
  const { model, random } = ctx;
  const t = thread.tree;
  const what = (s) => where(ctx, thread, s);
  const m = model.get(key);
  const got = t.get(key);
  if (m.node === null)
    assert.equal(got, null, what(`get(${JSON.stringify(key)}) should miss`));
  else
    assert.equal(
      got,
      thread.nodes.get(m.node.uid),
      what(`get(${JSON.stringify(key)})`),
    );
  if (model.root === null) return;
  const mm = model.match(key);
  const gm = t.match(key);
  if (mm.node)
    assert.equal(
      gm,
      thread.nodes.get(mm.node.uid),
      what(`match(${JSON.stringify(key)}) node`),
    );
  else {
    assert.ok(
      gm instanceof engine.NotFound,
      what(`match(${JSON.stringify(key)}) not a NotFound`),
    );
    assert.equal(
      gm.node,
      thread.nodes.get(mm.notFound.node.uid),
      what(`match(${JSON.stringify(key)}).node`),
    );
    assert.equal(
      gm.rest,
      mm.notFound.rest,
      what(`match(${JSON.stringify(key)}).rest`),
    );
  }
  // resolve() with the tree's separators, from a mount ('/' is no path
  // past a mount: the root there is '').
  if (key === '/') return;
  const mount = ctx.sep === '\\' ? 'C:\\app\\place' : '/app/place';
  const rel =
    ctx.sep === '\\' && random.chance(0.5)
      ? key.replace(/\//g, random.chance(0.5) ? '\\' : '/')
      : key;
  const abs = mount + rel;
  const mr = model.resolve(abs, mount.length, ctx.sep);
  const gr = t.resolve(abs, mount.length);
  if (mr.node === null)
    assert.equal(gr, null, what(`resolve(${JSON.stringify(abs)}) should miss`));
  else
    assert.equal(
      gr,
      thread.nodes.get(mr.node.uid),
      what(`resolve(${JSON.stringify(abs)})`),
    );
};

const checkLookups = (ctx, thread) => {
  const { model, random } = ctx;
  const keys = missKeys(ctx);
  for (const n of random.shuffle([...model.nodes()]).slice(0, 6))
    keys.push(model.pathOf(n));
  if (random.chance(0.3)) keys.push('/'); // the root, as ''
  for (const key of keys) checkKey(ctx, thread, key);
  // A key without its leading '/' is no key: EINVAL (QA В41). A sample of
  // two: a refusal costs a stack trace.
  for (const key of random
    .shuffle(keys.filter((k) => k.length > 1))
    .slice(0, 2)) {
    const bad = key.slice(1);
    for (const op of ['get', 'match'])
      assert.throws(
        () => thread.tree[op](bad),
        { code: 'EINVAL' },
        where(ctx, thread, `${op}(${JSON.stringify(bad)}) is no key`),
      );
  }
};

// allow(policy, owner, context): true unless the policy says no — a deny
// policy refuses with a fresh decision object, a redirect policy with
// another; a planned throw on one policy value. `log` gets every call, and
// `log.decisions` every refusal's decision, in order.
const newLog = () => {
  const log = [];
  log.decisions = [];
  return log;
};

const makeAllow =
  (log, throwOn = null) =>
  (policy, owner, context) => {
    log.push([policy, owner, context]);
    if (throwOn !== null && policy === throwOn)
      throw new Error('allow: a planned failure');
    let decision = true;
    // only true lets through: a truthy primitive is a decision too
    if (policy && policy.prim !== undefined) decision = policy.prim;
    else if (policy && policy.deny) decision = { status: 403, tag: policy.tag };
    else if (policy && policy.redirect)
      decision = { redirect: '/elsewhere', tag: policy.tag };
    if (decision !== true) log.decisions.push(decision);
    return decision;
  };

const checkPolicies = (ctx, thread) => {
  const { model, random } = ctx;
  const t = thread.tree;
  const what = (s) => where(ctx, thread, s);
  const keys = missKeys(ctx);
  for (const n of random.shuffle([...model.nodes()]).slice(0, 8))
    keys.push(model.pathOf(n));
  const context = { user: random.int(10) };
  // main keeps the policy values as given; a replica's are clones
  const same = (a, b) =>
    thread.main ? a === b : JSON.stringify(a) === JSON.stringify(b);
  const sameLog = (got, want, s) => {
    assert.equal(
      got.length,
      want.length,
      what(`${s}: allow called ${got.length} times, the model ${want.length}`),
    );
    want.forEach(([policy, owner, ctxv], i) => {
      assert.ok(same(got[i][0], policy), what(`${s}: call ${i} policy`));
      assert.equal(
        got[i][1],
        thread.nodes.get(owner.uid),
        what(`${s}: call ${i} owner`),
      );
      assert.equal(
        got[i][2],
        ctxv,
        what(`${s}: call ${i} context, not as given`),
      );
    });
  };
  const sameAnswer = (got, m, glog, s) => {
    if (m.denied) {
      assert.ok(got instanceof engine.Denied, what(`${s}: not Denied`));
      assert.equal(
        got.node,
        thread.nodes.get(m.denied.owner.uid),
        what(`${s}: Denied.node, the upper refusing node`),
      );
      assert.equal(
        got.decision,
        glog.decisions[glog.decisions.length - 1],
        what(`${s}: Denied.decision is not the object allow returned`),
      );
    } else if (m.notFound) {
      assert.ok(got instanceof engine.NotFound, what(`${s}: not NotFound`));
      assert.equal(
        got.node,
        thread.nodes.get(m.notFound.node.uid),
        what(`${s}: NotFound.node`),
      );
      assert.equal(got.rest, m.notFound.rest, what(`${s}: NotFound.rest`));
    } else if (m.node === null || m.node === undefined) {
      assert.equal(got, null, what(`${s}: should be null`));
    } else {
      assert.equal(got, thread.nodes.get(m.node.uid), what(`${s}: node`));
    }
  };
  for (const key of keys) {
    const k = JSON.stringify(key);
    {
      const mlog = newLog();
      const glog = newLog();
      const m = model.get(key, { allow: makeAllow(mlog), context });
      const got = t.get(key, { allow: makeAllow(glog), context });
      sameLog(glog, mlog, `get(${k}) with allow`);
      sameAnswer(got, m, glog, `get(${k}) with allow`);
    }
    if (model.root !== null) {
      const mlog = newLog();
      const glog = newLog();
      const m = model.match(key, { allow: makeAllow(mlog), context });
      const got = t.match(key, { allow: makeAllow(glog), context });
      sameLog(glog, mlog, `match(${k}) with allow`);
      sameAnswer(got, m, glog, `match(${k}) with allow`);
    }
    {
      // resolve with allow: as get, from a mount.
      const mount = ctx.sep === '\\' ? 'C:\\app\\place' : '/app/place';
      const abs = mount + key;
      const mlog = newLog();
      const glog = newLog();
      const m = model.resolve(abs, mount.length, ctx.sep, {
        allow: makeAllow(mlog),
        context,
      });
      const got = t.resolve(abs, mount.length, {
        allow: makeAllow(glog),
        context,
      });
      sameLog(glog, mlog, `resolve(${JSON.stringify(abs)}) with allow`);
      sameAnswer(got, m, glog, `resolve(${JSON.stringify(abs)}) with allow`);
    }
    {
      // Without allow: two outcomes and no call.
      const m = model.get(key);
      const got = t.get(key);
      sameAnswer(got, m, newLog(), `get(${k}) without allow`);
    }
  }
  // check(node, allow, context) on live nodes: as get(pathOf(node)).
  for (const n of random.shuffle([...model.nodes()]).slice(0, 4)) {
    const mlog = newLog();
    const glog = newLog();
    const m = model.check(n, makeAllow(mlog), context);
    const got = t.check(thread.nodes.get(n.uid), makeAllow(glog), context);
    sameLog(glog, mlog, `check(${model.pathOf(n)})`);
    sameAnswer(got, m, glog, `check(${model.pathOf(n)})`);
  }
  // An exception from allow goes to the caller and poisons nothing.
  const owners = [...model.nodes()].filter(
    (n) => n.policy !== null && n.policy !== undefined,
  );
  if (owners.length > 0) {
    const owner = random.pick(owners);
    const key = model.pathOf(owner);
    const policy = t.policyOf(thread.nodes.get(owner.uid));
    const mlog = newLog();
    const m = model.get(key, { allow: makeAllow(mlog), context });
    const reaches = mlog.some(([p]) => p === owner.policy);
    let thrown = null;
    try {
      t.get(key, { allow: makeAllow(newLog(), policy), context });
    } catch (err) {
      thrown = err;
    }
    if (reaches)
      assert.ok(
        thrown !== null && thrown.message === 'allow: a planned failure',
        what('an exception from allow did not reach the caller'),
      );
    const glog = newLog();
    const again = t.get(key, { allow: makeAllow(glog), context });
    sameAnswer(
      again,
      m,
      glog,
      `get(${JSON.stringify(key)}) after an exception from allow`,
    );
  }
};

const checkWalks = (ctx, thread) => {
  const { model, random } = ctx;
  const t = thread.tree;
  const what = (s) => where(ctx, thread, s);
  const live = [...model.nodes()];
  if (live.length === 0) return;
  const containers = containersOf(ctx, thread);
  for (let i = 0; i < 3; i++) {
    const startsM = [];
    const count = random.chance(0.5) ? 1 : 1 + random.int(3);
    for (let k = 0; k < count; k++)
      startsM.push(random.chance(0.8) ? random.pick(live) : null);
    const deadOrRoot = () =>
      thread.dead.length > 0
        ? random.pick(thread.dead)[0]
        : thread.nodes.get(model.root.uid);
    const startsE = startsM.map((n) =>
      n === null ? deadOrRoot() : thread.nodes.get(n.uid),
    );
    for (let k = 0; k < startsM.length; k++)
      if (
        startsM[k] === null &&
        startsE[k] === thread.nodes.get(model.root.uid)
      )
        startsM[k] = model.root;
    const opts = {};
    if (random.chance(0.5)) opts.depth = 1 + random.int(4);
    if (random.chance(0.5))
      opts.containers = random.pick(['include', 'skip', 'only']);
    if (random.chance(0.3)) opts.classes = [random.int(3), random.int(3)];
    const salt = random.int(1000);
    const pick = (uid, s) => ((uid * 2654435761 + salt + s) >>> 0) % 4 !== 0;
    const mlog = [];
    const glog = [];
    const mopts = { ...opts };
    const gopts = { ...opts };
    if (random.chance(0.5)) {
      mopts.filter = (n) => pick(n.uid, 1);
      gopts.filter = (n) => {
        glog.push(['filter', thread.nodeUid.get(n)]);
        return pick(thread.nodeUid.get(n), 1);
      };
    }
    if (random.chance(0.5)) {
      mopts.descend = (n) => pick(n.uid, 2);
      gopts.descend = (n) => {
        glog.push(['descend', thread.nodeUid.get(n)]);
        return pick(thread.nodeUid.get(n), 2);
      };
    }
    const want = model
      .walk(startsM, mopts, containers, mlog)
      .map(([n, d]) => [n.uid, d]);
    const arg =
      startsE.length === 1 && random.chance(0.5) ? startsE[0] : startsE;
    const got = iterate(t.walk(arg, gopts)).map(([n, d]) => [
      thread.nodeUid.get(n),
      d,
    ]);
    assert.deepEqual(got, want, what(`walk(${JSON.stringify(opts)})`));
    assert.deepEqual(
      glog,
      mlog.map(([k, n]) => [k, n.uid]),
      what('walk: the order of filter and descend calls'),
    );
  }
};

// --- generators --------------------------------------------------------------------

// Names a key may hold beyond ASCII letters: two-byte ones, a surrogate
// pair, lone surrogates, spaces and dots, and the names of Object.prototype
// (a dictionary keyed by names must not see them).
const ODD_NAMES = [
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'toString',
  'категория',
  '目录',
  'emoji-\u{1F600}',
  'lone-\uD800',
  '\uDFFF-lone',
  'x\uD83Dy',
  '\uDC00',
  ' spaced name ',
  '...',
  'a.b',
];

// The names of a seed in the tight mode (every fourth seed): three, and an
// odd one now and then — a key is taken, freed and taken again by another
// node, within a commit and across commits, and a create often meets one
// taken (the fuzzer of the review of step A).
const TIGHT = ['a', 'b', 'c'];

const nameAt = (ctx) => {
  const { random } = ctx;
  const i = ctx.counter++;
  if (ctx.tight)
    return random.chance(0.05) ? random.pick(ODD_NAMES) : random.pick(TIGHT);
  if (!random.chance(0.1)) return data.nameOf(random, i);
  const odd = random.pick(ODD_NAMES);
  return random.chance(0.5) ? odd : `${odd}${i}`;
};

// A client's number id: mostly small, now and then beyond a small integer of
// any build or negative — the numeric columns of snapshots and deltas take
// doubles then.
const numberId = (ctx) => {
  const n = ctx.counter++;
  switch (ctx.random.int(24)) {
    case 0:
      return 2 ** 30 + n;
    case 1:
      return -(2 ** 30) - n;
    case 2:
      return -n;
    case 3:
      return Number.MAX_SAFE_INTEGER - n;
    default:
      return n;
  }
};

// A payload input, now and then with a size past a small integer.
const sized = (ctx, input) => {
  if (input !== undefined && ctx.random.chance(0.04))
    input.size = 2 ** 31 + ctx.random.int(1e6);
  return input;
};

// An extent that is not one: no such segment, past the segment's end,
// negative, not an integer.
const badExtent = (ctx) => {
  const ok = { segmentId: 1, offset: 0, length: 8 };
  return ctx.random.pick([
    { ...ok, segmentId: 9 },
    { ...ok, offset: (1 << 18) - 4 },
    { ...ok, offset: -8 },
    { ...ok, length: 1.5 },
    { ...ok, segmentId: '1' },
  ]);
};

// A refused FS op of every kind of check: the format first, then each op's
// own, the root as '' and as '/'. Mistakes about a parent are about the
// direct one only: a file deeper up the path is the spec's open question.
const badFsOp = (ctx, m) => {
  const { random, extents } = ctx;
  const all = [...m.nodes()];
  const dirs = all.filter((n) => n.cls === 0);
  const files = all.filter((n) => n.cls === 1);
  const nonRoot = all.filter((n) => n.parent !== null);
  const keyOf = (n) => m.pathOf(n);
  const payload = () =>
    data.payloadOf(random, extents, { birthtime: m.birthtime, noSource: true });
  const missing = () => `/missing-${random.int(9)}`;
  const fresh = () => `/x-${ctx.counter++}`;
  const reps = (list) => ({ size: 8, mtimeMs: 1.7e12, representations: list });
  const format = [
    ['mkdir', '//x'],
    ['frob', '/x'],
    ['move', '', '/x'],
    ['mkdir', '/a/./b'],
    ['relocate', 'not-an-id', 0, extents.next(8)],
    ['relocate', -1, 0, extents.next(8)],
    ['relocate', 999999, 99, extents.next(8)],
    ['relocate', 999999, 0, badExtent(ctx)],
    ['write', fresh(), { size: -1, mtimeMs: 1, representations: [] }],
    ['write', fresh(), { size: 1.5, mtimeMs: 1, representations: [] }],
    ['write', fresh(), { size: 1, mtimeMs: NaN, representations: [] }],
    ['write', fresh(), reps([[0, badExtent(ctx)]])],
    ['write', fresh(), reps([[99, extents.next(8)]])],
    [
      'write',
      fresh(),
      reps([
        [0, extents.next(8)],
        [0, extents.next(8)],
      ]),
    ],
  ];
  if (m.birthtime)
    format.push([
      'write',
      fresh(),
      { size: 1, mtimeMs: 1, birthtimeMs: Infinity, representations: [] },
    ]);
  const bad = [
    ['mkdir', ''],
    ['mkdir', '/'],
    ['write', '', payload()],
    ['write', '/', payload()],
    ['unlink', ''],
    ['unlink', '/'],
    ['rmdir', '/'],
    ['remove', '/'],
    ['move', '/', '/x'],
    ['remove', missing()],
    ['unlink', missing()],
    ['mkdir', `${missing()}/x`],
    ['write', `${missing()}/x`, payload()],
    ['relocate', 999999, 0, extents.next(8)],
    ['relocate', dirs[0].id, 0, extents.next(8)],
    [
      'rmdir',
      dirs.length > 1
        ? keyOf(
            random.pick(
              dirs.filter((d) => d.parent !== null).concat(dirs.slice(0, 1)),
            ),
          )
        : '/x',
    ],
    ['unlink', dirs.length > 1 ? keyOf(dirs[dirs.length - 1]) : '/x'],
  ];
  if (ctx.deadIds.length > 0)
    bad.push(['relocate', random.pick(ctx.deadIds), 0, extents.next(8)]);
  if (files.length > 0) {
    const file = keyOf(random.pick(files));
    bad.push(['mkdir', `${file}/sub`], ['write', `${file}/x`, payload()]);
    if (nonRoot.length > 0)
      bad.push(['move', keyOf(random.pick(nonRoot)), `${file}/x`]);
    // a file higher up the path than the direct parent: ENOTDIR (QA В41)
    bad.push(
      ['mkdir', `${file}/a/b`],
      ['write', `${file}/a/b`, payload()],
      ['write', `${file}/a/b`, payload(), { parents: true }],
    );
    if (nonRoot.length > 0)
      bad.push(['move', keyOf(random.pick(nonRoot)), `${file}/a/b`]);
    // a kind the file has not: ENOENT
    const known = files.filter(
      (f) => f.payload !== null && ctx.ids.get(f.uid) === f.id,
    );
    if (known.length > 0) {
      const f = random.pick(known);
      const lacks = [0, 1, 2, 3, 4].filter((k) => !f.payload.reps.has(k));
      if (lacks.length > 0)
        bad.push(['relocate', f.id, random.pick(lacks), extents.next(8)]);
    }
  }
  if (nonRoot.length > 0) {
    const n = keyOf(random.pick(nonRoot));
    bad.push(
      ['move', n, `${missing()}/x`],
      ['move', n, '/'],
      ['mkdir', n], // EEXIST
    );
  }
  // errors of meaning twice as often: there are more kinds of them
  return random.chance(0.33) ? random.pick(format) : random.pick(bad);
};

// An FS op the format refuses: an unknown name, a key that is not one.
const formatBadOp = (ctx) =>
  ctx.random.pick([
    ['frob', '/x'],
    ['mkdir', '//x'],
    ['mkdir', '/a/./b'],
    ['unlink', 'no-slash'],
    ['remove', '/a/'],
    ['move', '/a', '/b/..'],
    ['write', '/a\b', { size: 1, mtimeMs: 1, representations: [] }],
    'not an op',
  ]);

const fsOp = (ctx, m) => {
  const { random, extents } = ctx;
  const all = [...m.nodes()];
  const dirs = all.filter((n) => n.cls === 0);
  const files = all.filter((n) => n.cls === 1);
  const nonRoot = all.filter((n) => n.parent !== null);
  const keyOf = (n) => m.pathOf(n);
  const child = (d) => `${keyOf(d)}/${nameAt(ctx)}`;
  const payload = () =>
    sized(
      ctx,
      data.payloadOf(random, extents, {
        birthtime: m.birthtime,
        noSource: true,
      }),
    );
  switch (random.int(16)) {
    case 0:
    case 1:
      return ['mkdir', child(random.pick(dirs))];
    case 2:
    case 3:
    case 4:
      return ['write', child(random.pick(dirs)), payload()];
    case 5:
      return files.length > 0
        ? ['write', keyOf(random.pick(files)), payload()]
        : null;
    case 6:
      return [
        'write',
        `${keyOf(random.pick(dirs))}/p${ctx.counter++}/q${ctx.counter++}/f.js`,
        payload(),
        { parents: true },
      ];
    case 7:
    case 8: {
      if (nonRoot.length === 0) return null;
      const n = random.pick(nonRoot);
      const to = random.chance(0.15)
        ? keyOf(random.pick(nonRoot))
        : child(random.pick(dirs));
      return ['move', keyOf(n), random.chance(0.05) ? keyOf(n) : to];
    }
    case 9:
      return files.length > 0 ? ['unlink', keyOf(random.pick(files))] : null;
    case 10:
      return nonRoot.length > 0
        ? ['remove', keyOf(random.pick(nonRoot))]
        : null;
    case 11: {
      const empty = dirs.filter(
        (d) => d.parent !== null && d.kids.length === 0,
      );
      return empty.length > 0 ? ['rmdir', keyOf(random.pick(empty))] : null;
    }
    case 12: {
      // only a node that existed before this commit: its id is the engine's
      // (a node this commit made has a provisional id in the model)
      const withReps = files.filter(
        (f) =>
          f.payload !== null &&
          f.payload.reps.size > 0 &&
          ctx.ids.get(f.uid) === f.id,
      );
      if (withReps.length === 0) return null;
      const f = random.pick(withReps);
      const kind = random.pick([...f.payload.reps.keys()]);
      return ['relocate', f.id, kind, extents.next(8)];
    }
    case 13: {
      // A replacement as the FS layer builds one: unlink or rmdir of the
      // destination, by the source's kind, then the move — appended as two ops.
      if (nonRoot.length < 2) return null;
      const from = random.pick(nonRoot);
      const to = random.pick(nonRoot.filter((n) => n !== from));
      ctx.pending = ['move', keyOf(from), keyOf(to)];
      return [from.cls === 1 ? 'unlink' : 'rmdir', keyOf(to)];
    }
    case 14:
      return badFsOp(ctx, m);
    default:
      return ['write', child(random.pick(dirs)), payload()];
  }
};

// An FS commit: ops tried one by one on a scratch copy of the model, so that
// later ops see earlier ones; mostly valid, now and then refused.
const fsOps = (ctx) => {
  const { random } = ctx;
  const scratch = ctx.model.clone();
  // Now and then a refusal after removals and moves from one parent: the
  // rollback must restore the order of its children too.
  if (random.chance(0.08)) {
    const crowded = [...scratch.nodes()].filter(
      (n) => n.cls === 0 && n.kids.length >= 3,
    );
    if (crowded.length > 0) {
      const d = random.pick(crowded);
      const key = (n) => scratch.pathOf(n);
      const [a, b, c] = d.kids;
      const target = [...scratch.nodes()].find(
        (n) =>
          n.cls === 0 && n !== d && !key(n).startsWith(key(d) + '/') && n !== b,
      );
      const ops = [['remove', key(a)]];
      if (target)
        ops.push(['move', key(b), `${key(target)}/moved-${ctx.counter++}`]);
      ops.push(['move', key(c), `${key(d)}/renamed-${ctx.counter++}`]);
      ops.push(['rmdir', `/missing-${ctx.counter++}`]);
      return ops;
    }
  }
  const ops = [];
  const count = 1 + random.int(ctx.tight ? 10 : 6);
  for (let i = 0; i < count; i++) {
    const op = fsOp(ctx, scratch);
    if (op === null) continue;
    try {
      scratch.commit([op], scratch.version + 1, ctx.now);
      ops.push(op);
      // Now and then a removed node's key is taken again in the same commit,
      // by a new node: no lookup and no replica may give the former one.
      if (
        (op[0] === 'remove' || op[0] === 'unlink' || op[0] === 'rmdir') &&
        random.chance(0.3)
      ) {
        const again = random.chance(0.5)
          ? ['mkdir', op[1]]
          : [
              'write',
              op[1],
              sized(
                ctx,
                data.payloadOf(random, ctx.extents, {
                  birthtime: scratch.birthtime,
                  noSource: true,
                }),
              ),
            ];
        try {
          scratch.commit([again], scratch.version + 1, ctx.now);
          ops.push(again);
        } catch {
          // refused (no room under maxNodes): not kept
        }
      }
      // Now and then the node goes back in the same commit — directly or
      // through a third name — and is sometimes removed after: its former
      // slot under the parent is taken again within one commit.
      if (op[0] === 'move' && op[1] !== op[2] && random.chance(0.3)) {
        const from = op[1];
        const via = `${from.slice(0, from.lastIndexOf('/'))}/via-${ctx.counter++}`;
        const back = random.chance(0.5)
          ? [['move', op[2], from]]
          : [
              ['move', op[2], via],
              ['move', via, from],
            ];
        if (random.chance(0.3)) back.push(['remove', from]);
        for (const b of back) {
          try {
            scratch.commit([b], scratch.version + 1, ctx.now);
            ops.push(b);
          } catch {
            break;
          }
        }
      }
    } catch {
      // In the tight mode most refusals are of a name taken: the commit goes
      // on past one, mostly.
      if (ctx.tight && random.chance(0.6)) continue;
      if (random.chance(0.4)) {
        ops.push(op); // a refused op, kept now and then
        // and a second refused one after it, of format or of meaning: the
        // refusal is the first one's either way
        if (random.chance(0.6))
          ops.push(
            random.chance(0.6) ? formatBadOp(ctx) : badFsOp(ctx, scratch),
          );
      }
      break;
    }
  }
  return ops;
};

// A policy of a node of a tree with client ids: deny, redirect, or one whose
// allow answers a primitive — only true lets through; null for none.
const policyOf = (ctx) => {
  const { random } = ctx;
  if (!on('policy') || !random.chance(0.2)) return null;
  if (random.chance(0.15))
    return {
      prim: random.pick([1, 'ok', 0, '', false, null, true]),
      tag: random.int(100),
    };
  return {
    deny: random.chance(0.4),
    redirect: random.chance(0.1),
    tag: random.int(100),
  };
};

// A commit of a tree with client ids: puts and removes, one per id; patterns
// of the final state; now and then refused.
const clientOps = (ctx) => {
  const { model, random, extents } = ctx;
  const all = [...model.nodes()];
  const ops = [];
  const named = new Set();
  const newId = () =>
    model.mode === 'number'
      ? numberId(ctx)
      : `id-${ctx.counter++}${random.chance(0.3) ? '-'.repeat(14) : ''}`;
  const payload = () =>
    random.chance(0.6)
      ? sized(ctx, data.payloadOf(random, extents, { noSource: true }))
      : undefined;
  const fields = (create) => {
    const f = {};
    if (create || random.chance(0.2)) f.class = random.int(5);
    const p = payload();
    if (p !== undefined) f.payload = p;
    else if (!create && random.chance(0.1)) f.payload = null;
    const pol = policyOf(ctx);
    if (pol !== null) f.policy = pol;
    else if (!create && random.chance(0.05)) f.policy = null;
    return f;
  };
  if (model.root === null) {
    const id = newId();
    ops.push(['put', id, null, '', fields(true)]);
    for (let i = 0; i < 3; i++)
      ops.push(['put', newId(), id, nameAt(ctx), fields(true)]);
    return ops;
  }
  const nonRoot = all.filter((n) => n.parent !== null);
  const count = 1 + random.int(5);
  for (let i = 0; i < count; i++) {
    const choice = random.int(12);
    if (choice <= 3 || nonRoot.length === 0) {
      const parent = random.pick(all);
      ops.push(['put', newId(), parent.id, nameAt(ctx), fields(true)]);
      continue;
    }
    const n = random.pick(nonRoot);
    if (named.has(n.id)) continue;
    named.add(n.id);
    if (choice <= 5) {
      // a move or rename, sometimes under its own descendant (a cycle)
      const parent = random.pick(all);
      const name = random.chance(0.5) ? n.name : nameAt(ctx);
      ops.push(['put', n.id, parent.id, name, fields(false)]);
    } else if (choice <= 7) {
      ops.push(['put', n.id, n.parent.id, n.name, fields(false)]);
    } else if (choice <= 9) {
      ops.push(['remove', n.id]);
    } else if (choice === 10) {
      // remove a node and create another with its name
      ops.push(['remove', n.id]);
      ops.push(['put', newId(), n.parent.id, n.name, fields(true)]);
    } else {
      // swap the names of two siblings
      const sib = n.parent.kids.find((k) => k !== n && !named.has(k.id));
      if (sib) {
        named.add(sib.id);
        ops.push(['put', n.id, n.parent.id, sib.name, {}]);
        ops.push(['put', sib.id, sib.parent.id, n.name, {}]);
      }
    }
  }
  if (random.chance(0.12)) {
    // a refused op of the first group; an id of the other kind is one that
    // would convert to a live id
    const otherKind =
      model.mode === 'number' ? String(model.root.id) : ctx.counter++;
    const bad = random.pick([
      ['put', newId(), model.root.id, '', { class: 1 }],
      ['put', newId(), model.root.id, 'x', {}],
      ['put', newId(), null, '', { class: 1 }],
      ['remove', model.root.id],
      [
        'put',
        model.root.id,
        nonRoot.length > 0 ? nonRoot[0].id : model.root.id,
        'r',
        {},
      ],
      ['put', newId(), model.root.id, 'a/b', { class: 1 }],
      ['put', newId(), model.root.id, 'ok', { class: -1 }],
      ['put', newId(), otherKind, 'pk', { class: 1 }],
      ['put', otherKind, model.root.id, 'ik', { class: 1 }],
      ['remove', otherKind],
      [
        'put',
        newId(),
        model.root.id,
        'bp',
        { class: 1, payload: { size: -1, mtimeMs: 1, representations: [] } },
      ],
      [
        'put',
        newId(),
        model.root.id,
        'be',
        {
          class: 1,
          payload: {
            size: 1,
            mtimeMs: 1,
            representations: [[0, badExtent(ctx)]],
          },
        },
      ],
      ['frob', 1],
      ops.length > 0 ? ops[0] : ['remove', model.root.id],
    ]);
    ops.splice(random.int(ops.length + 1), 0, bad);
  }
  return random.shuffle(ops);
};

// Compaction of a tree with client ids: one relocation, mostly; now and then
// one the first group refuses — the id named twice, a put or a remove
// beside it, an id of another kind, an unknown kind, an extent that is not
// one — or one the node refuses: an id no live node has, a kind it has not.
const clientRelocations = (ctx) => {
  const { model, random, extents } = ctx;
  const all = [...model.nodes()];
  const withReps = all.filter(
    (n) => n.payload !== null && n.payload.reps.size > 0,
  );
  if (withReps.length === 0) return null;
  const n = random.pick(withReps);
  const kinds = [...n.payload.reps.keys()];
  const op = ['relocate', n.id, random.pick(kinds), extents.next(8)];
  const others = all.filter((x) => x !== n && x.parent !== null);
  const otherKind = model.mode === 'number' ? String(n.id) : ctx.counter++;
  const dead = ctx.deadIds.filter((id) => !model.byId.has(id));
  switch (random.int(16)) {
    case 0:
      return [op, ['relocate', n.id, random.pick(kinds), extents.next(8)]];
    case 1: {
      if (others.length === 0) return [op];
      const x = random.pick(others);
      const beside = random.chance(0.5)
        ? ['put', x.id, x.parent.id, x.name, {}]
        : ['remove', x.id];
      return random.chance(0.5) ? [op, beside] : [beside, op];
    }
    case 2:
      return [['relocate', otherKind, 0, extents.next(8)]];
    case 3:
      return [['relocate', n.id, 99, extents.next(8)]];
    case 4:
      return [['relocate', n.id, kinds[0], badExtent(ctx)]];
    case 5:
      return [
        [
          'relocate',
          model.mode === 'number' ? 9e15 : 'no-such-id',
          0,
          extents.next(8),
        ],
      ];
    case 6:
      return dead.length > 0
        ? [['relocate', random.pick(dead), 0, extents.next(8)]]
        : [op];
    case 7: {
      const lacks = [0, 1, 2, 3, 4].filter((k) => !n.payload.reps.has(k));
      return lacks.length > 0
        ? [['relocate', n.id, random.pick(lacks), extents.next(8)]]
        : [op];
    }
    default:
      return [op];
  }
};

const loadRows = (ctx) => {
  const { model, random, extents } = ctx;
  if (random.chance(0.1)) return [];
  const rows = [];
  const keep = [...model.nodes()].filter(
    (n) => n.parent === null || random.chance(0.85),
  );
  const kept = new Set(keep.map((n) => n.id));
  for (const n of keep) {
    // a kept node whose parent is dropped would be a refused load — keep the
    // chain, mostly; now and then let it fail
    const parent = n.parent;
    if (parent !== null && !kept.has(parent.id) && random.chance(0.8)) continue;
    const row = {
      id: n.id,
      parentId: parent === null ? null : parent.id,
      name: n.name,
    };
    if (random.chance(0.2)) row.class = random.int(5);
    if (random.chance(0.2))
      row.payload = random.chance(0.8)
        ? sized(ctx, data.payloadOf(random, extents, { noSource: true }))
        : null;
    if (random.chance(0.1)) row.policy = policyOf(ctx);
    rows.push(row);
  }
  // Now and then two siblings swap their names: a final state that no order
  // of single renames reaches without a third name.
  if (random.chance(0.2)) {
    const byParent = new Map();
    for (const r of rows) {
      if (r.parentId === null) continue;
      const list = byParent.get(r.parentId) ?? [];
      list.push(r);
      byParent.set(r.parentId, list);
    }
    const pairs = [...byParent.values()].filter((l) => l.length >= 2);
    if (pairs.length > 0) {
      const [a, b] = random.shuffle(random.pick(pairs));
      [a.name, b.name] = [b.name, a.name];
    }
  }
  const ids = rows.map((r) => r.id);
  for (let i = 0; i < 3 && ids.length > 0; i++) {
    const id = model.mode === 'number' ? numberId(ctx) : `id-${ctx.counter++}`;
    const row = {
      id,
      parentId: random.pick(ids),
      name: nameAt(ctx),
      class: random.int(5),
    };
    const pol = policyOf(ctx);
    if (pol !== null) row.policy = pol;
    rows.push(row);
  }
  const newId = () =>
    model.mode === 'number' ? numberId(ctx) : `id-${ctx.counter++}`;
  const rootRow = rows.find((r) => r.parentId === null);
  // At most one case of these per load, so that no refusal hides another.
  const special = random.int(100);
  if (rootRow !== undefined && special < 12) {
    // The root changes: a new row without a parent, the former root's row
    // under it (QA В41) — the keys of the whole tree change.
    const id = newId();
    rows.push({ id, parentId: null, name: '', class: random.int(5) });
    rootRow.parentId = id;
    rootRow.name = nameAt(ctx);
  } else if (rows.length > 0 && special < 20) {
    // a second row without a parent: EEXIST (QA В42)
    rows.push({ id: newId(), parentId: null, name: '', class: random.int(5) });
  } else if (ids.length > 0 && special < 28) {
    // two new rows that close a cycle: EINVAL (QA В42)
    const a = newId();
    const b = newId();
    rows.push(
      { id: a, parentId: b, name: nameAt(ctx), class: random.int(5) },
      { id: b, parentId: a, name: nameAt(ctx), class: random.int(5) },
    );
  } else if (rows.length > 0 && special < 46) {
    // A row the format refuses: an id twice, a new row without a class, a
    // row that is not an object.
    const bad = random.pick([
      { ...random.pick(rows) },
      {
        id: model.mode === 'number' ? numberId(ctx) : `id-${ctx.counter++}`,
        parentId: random.pick(ids),
        name: nameAt(ctx),
      },
      null,
      7,
    ]);
    rows.push(bad);
  }
  return random.shuffle(rows);
};

// --- one seed --------------------------------------------------------------------------

const runSeed = (seed) => {
  const random = data.rng(seed);
  const modes = [];
  if (on('fs')) modes.push('engine');
  if (on('client')) modes.push('number', 'string');
  if (modes.length === 0) modes.push('engine');
  const mode = modes[seed % modes.length];
  const segments = data.createSegments(2, 1 << 18);
  const extents = new data.Extents(segments);
  const retire = new data.RetireIds();
  const fs = mode === 'engine';
  const options = {
    ids: mode,
    segments,
    sep: random.chance(0.3) ? '\\' : '/',
    directories: fs && random.chance(0.4),
    birthtime: random.chance(0.4),
    aggregates: on('aggregates')
      ? { classes: random.chance(0.6), subtreeVersion: random.chance(0.6) }
      : {},
    retireIds: retire,
    now: 1000,
  };
  if (!fs)
    options.containers = random
      .shuffle([0, 1, 2, 3, 4])
      .slice(0, random.int(4));
  if (random.chance(0.12)) options.maxNodes = 12 + random.int(30);
  const model = new ModelTree(options);
  const main = new Thread('main', engine.createTree(options), segments, true);
  const ctx = {
    seed,
    step: 0,
    random,
    model,
    extents,
    retire,
    segments,
    sep: options.sep,
    now: 1000,
    counter: 1,
    tight: seed % 4 === 3, // names of three letters: see nameAt
    ids: new Map(),
    idOwner: new Map(),
    former: new Set(),
    pending: null,
    deadIds: [], // ids of nodes main saw die, for ops by a dead id
  };
  const threads = [main];
  const replicaOf = (name) => {
    const snapshot = main.tree.snapshot();
    noSab(snapshot, where(ctx, main, 'snapshot'));
    const r = new Thread(
      name,
      engine.fromSnapshot(structuredClone(snapshot), segments),
      segments,
      false,
    );
    // the snapshot carries main's rule as it is now, its own until it sets one
    r.containers = main.containers;
    return r;
  };
  // A delta of another tree at the same revision is EINVAL.
  {
    const early = replicaOf('early');
    const other = engine.createTree({
      ...options,
      retireIds: new data.RetireIds(),
    });
    const ops = fs
      ? [['mkdir', '/other']]
      : [
          [
            'put',
            mode === 'number' ? 1e9 : 'other-root',
            null,
            '',
            { class: 0 },
          ],
        ];
    const od = other.commit(ops, 1, 1001);
    const before = fingerprint(ctx, early);
    assert.throws(
      () =>
        early.tree.apply(structuredClone(od.delta), { retain: () => false }),
      { code: 'EINVAL' },
      where(ctx, early, 'a delta of another tree'),
    );
    assert.equal(
      fingerprint(ctx, early),
      before,
      where(ctx, early, 'a refused delta changed the replica'),
    );
    // The tree's role: a replica takes no commit or load, a main tree no
    // delta — EINVAL, index -1.
    assert.throws(
      () => early.tree.commit([], 1, 1001),
      (e) => e.code === 'EINVAL' && e.index === -1,
      where(ctx, early, 'commit on a replica'),
    );
    if (!fs) {
      assert.throws(
        () => early.tree.load([], 1, 1001),
        (e) => e.code === 'EINVAL' && e.index === -1,
        where(ctx, early, 'load on a replica'),
      );
    }
    assert.throws(
      () => main.tree.apply(structuredClone(od.delta), { retain: () => false }),
      { code: 'EINVAL' },
      where(ctx, main, 'apply on a main tree'),
    );
    threads.push(early);
    // The arguments: `ops` (`rows`) an array, `next` a safe integer, `now` a
    // finite number — EINVAL, index -1, nothing changed.
    const fpArgs = fingerprint(ctx, main);
    const badArgs = (f, s) =>
      assert.throws(
        f,
        (e) => e.code === 'EINVAL' && e.index === -1,
        where(ctx, main, s),
      );
    badArgs(() => main.tree.commit('ops', 1, 1001), 'ops not an array');
    badArgs(() => main.tree.commit([], 1.5, 1001), 'next not an integer');
    badArgs(() => main.tree.commit([], 2 ** 53, 1001), 'next not safe');
    badArgs(() => main.tree.commit([], 1, NaN), 'now not a finite number');
    badArgs(() => main.tree.commit([], 1, Infinity), 'now not finite');
    if (!fs) badArgs(() => main.tree.load({}, 1, 1001), 'rows not an array');
    // Not a snapshot of this engine — no format mark — and options the spec
    // forbids: EINVAL.
    for (const junk of [null, 42, 'snapshot', {}, { nodes: [] }])
      assert.throws(
        () => engine.fromSnapshot(junk, segments),
        { code: 'EINVAL' },
        where(ctx, main, `fromSnapshot(${JSON.stringify(junk)})`),
      );
    for (const bad of [
      { ids: 'number', directories: true },
      { ids: 'string', directories: true },
    ])
      assert.throws(
        () => engine.createTree({ ...options, ...bad }),
        { code: 'EINVAL' },
        where(ctx, main, `createTree(${JSON.stringify(bad)})`),
      );
    assert.equal(
      fingerprint(ctx, main),
      fpArgs,
      where(ctx, main, 'a refusal of the arguments changed the tree'),
    );
  }
  compare(ctx, main);
  let held = null; // a delta held back to test ESTALE
  for (let step = 1; step <= COMMITS; step++) {
    ctx.step = step;
    ctx.now += 1 + random.int(5);
    // Replicas come and go.
    if (threads.length < 3 && random.chance(0.06)) {
      const r = replicaOf(`replica${step}`);
      if (!fs && random.chance(0.4)) {
        r.containers = random.shuffle([0, 1, 2, 3, 4]).slice(0, random.int(4));
        r.tree.containers = r.containers;
      }
      threads.push(r);
      compare(ctx, r);
    }
    if (!fs && random.chance(0.05)) {
      main.containers = random.shuffle([0, 1, 2, 3, 4]).slice(0, random.int(4));
      main.tree.containers = main.containers;
    }
    // The commit.
    let ops;
    let isLoad = false;
    if (fs) {
      ops = fsOps(ctx);
      if (ctx.pending) {
        ops.push(ctx.pending);
        ctx.pending = null;
      }
    } else if (random.chance(0.06) && model.root !== null) {
      ops = loadRows(ctx);
      isLoad = true;
    } else if (random.chance(0.08)) {
      ops = clientRelocations(ctx) ?? clientOps(ctx);
    } else {
      ops = clientOps(ctx);
    }
    // The version: mostly the next one, now and then equal (the intake's
    // window), now and then below (EINVAL -1).
    let next = model.version + 1 + random.int(3);
    if (random.chance(0.08)) next = model.version;
    if (model.version > 0 && random.chance(0.04)) next = model.version - 1;
    // A planned throw of retireIds.next() now and then.
    if (random.chance(0.05)) retire.failAt = retire.calls + 1;
    // Iterators made before the commit, stepped once.
    const iters = [];
    for (const th of threads) {
      if (
        model.root === null ||
        !on('walk') ||
        (held !== null && held.th === th)
      )
        continue;
      const root = th.tree.get('');
      if (root === null) continue;
      const it = th.tree.childNodesOf(root)[Symbol.iterator]();
      const first = it.next();
      iters.push({
        th,
        it,
        rest: model.root.kids.slice(first.done ? 0 : 1).map((k) => k.uid),
        done: first.done,
        sv: th.tree.structureVersion,
      });
      // A walk's iterator too: its pairs are [node, depth].
      const walker = th.tree.walk(root)[Symbol.iterator]();
      const step = walker.next();
      const all = model
        .walk([model.root], {}, containersOf(ctx, th))
        .map(([n]) => n.uid);
      iters.push({
        th,
        it: {
          next: () => {
            const r = walker.next();
            return r.done ? r : { done: false, value: r.value[0] };
          },
        },
        rest: all.slice(step.done ? 0 : 1),
        done: step.done,
        sv: th.tree.structureVersion,
      });
    }
    // The rule of containers changes in a thread while its iterators live:
    // they go on (the rule is no structure).
    if (!fs && random.chance(0.06)) {
      const heldTh = held === null ? null : held.th;
      const th = random.pick(threads.filter((x) => x !== heldTh));
      th.containers = random.shuffle([0, 1, 2, 3, 4]).slice(0, random.int(4));
      th.tree.containers = th.containers;
    }
    const saved = model.save();
    let mres = null;
    let merr = null;
    try {
      mres = isLoad
        ? model.load(ops, next, ctx.now)
        : model.commit(ops, next, ctx.now);
    } catch (err) {
      // a refusal has a code and an index; anything else is the model's own
      // failure, and an engine throwing anything must not match it
      if (typeof err.code !== 'string' || !Number.isInteger(err.index))
        throw err;
      merr = err;
    }
    const fpBefore =
      merr !== null || retire.failAt !== 0 ? fingerprint(ctx, main) : null;
    let eres = null;
    let eerr = null;
    const lastBefore = retire.last;
    try {
      eres = isLoad
        ? main.tree.load(ops, next, ctx.now)
        : main.tree.commit(ops, next, ctx.now);
    } catch (err) {
      eerr = err;
    }
    const failAt = retire.failAt;
    retire.failAt = 0;
    const what = (s) => where(ctx, main, s);
    if (merr !== null) {
      assert.ok(
        eerr !== null,
        what(
          `the model refused ${merr.code} at ${merr.index}, the engine did not (${JSON.stringify(ops).slice(0, 300)})`,
        ),
      );
      assert.equal(
        eerr.code,
        merr.code,
        what(`code (${JSON.stringify(ops).slice(0, 300)})`),
      );
      assert.equal(eerr.index, merr.index, what(`index of ${merr.code}`));
      if (merr.other !== undefined)
        assert.equal(eerr.other, merr.other, what('other'));
      assert.equal(
        fingerprint(ctx, main),
        fpBefore,
        what('a refused commit changed the tree'),
      );
      // The keys it named: the lookups answer as before it.
      for (const key of keysOfOps(ctx, ops, isLoad)) checkKey(ctx, main, key);
    } else if (
      eerr !== null &&
      retire.error !== null &&
      eerr === retire.error
    ) {
      // retireIds threw: the commit throws the same and changes nothing.
      assert.ok(
        mres.retired.length > 0,
        what('retireIds was called with nothing to retire'),
      );
      retire.error = null;
      model.restore(saved);
      assert.equal(
        fingerprint(ctx, main),
        fpBefore,
        what('a throw of retireIds changed the tree'),
      );
      for (const th of threads)
        if (held === null || held.th !== th) compare(ctx, th);
      continue;
    } else {
      if (eerr !== null)
        throw new assert.AssertionError({
          message: what(
            `the engine threw ${eerr.code ?? eerr.message} where the model passed (${JSON.stringify(ops).slice(0, 300)})`,
          ),
        });
      if (failAt !== 0 && mres.retired.length > 0 && retire.calls >= failAt)
        assert.fail(what('retireIds threw and the commit passed'));
      assert.equal(eres.version, model.version, what('version returned'));
      assert.equal(
        eres.delta === null,
        !mres.delta,
        what(
          `delta ${eres.delta === null ? 'null' : 'given'}, the model says ${mres.delta}`,
        ),
      );
      // retired: as a multiset of (id, kind, extent), each rep the main
      // tree's own object, each retireId one the counter gave.
      const want = mres.retired
        .map((r) => `${r.id}|${r.kind}|${r.extent}`)
        .sort();
      const got = eres.retired
        .map(
          (r) =>
            `${r.id}|${r.kind}|${r.rep ? `${r.rep.segmentId}:${r.rep.offset}:${r.rep.length}` : '?'}`,
        )
        .sort();
      assert.deepEqual(got, want, what('retired'));
      const ids = new Set();
      for (const r of eres.retired) {
        assert.ok(
          r.retireId > lastBefore &&
            r.retireId <= retire.last &&
            !ids.has(r.retireId),
          what(
            `retireId ${r.retireId} is not one the counter gave this commit`,
          ),
        );
        ids.add(r.retireId);
        const m = mres.retired.find((x) => x.id === r.id && x.kind === r.kind);
        assert.equal(
          r.rep,
          main.reps.get(m.uid),
          what("retired rep is not the main tree's object"),
        );
        // The former representation, while it is held, views its own extent:
        // now and on later steps.
        holdFormer(main, r.rep);
        const view = r.rep.data;
        assert.equal(
          view.length,
          r.rep.length,
          what('a retired representation: data length'),
        );
        if (r.rep.length > 0) {
          assert.equal(
            view.buffer,
            segments.get(r.rep.segmentId),
            what('a retired representation: data over another segment'),
          );
          assert.equal(
            view.byteOffset,
            r.rep.offset,
            what('a retired representation: data offset'),
          );
        }
      }
      if (eres.delta !== null) {
        noSab(eres.delta, what('delta'));
        const clone = structuredClone(eres.delta);
        // Replicas: ESTALE for a repeat and a reorder, a throwing pins, then
        // the delta itself.
        for (const th of threads.slice(1)) {
          if (held !== null && held.th === th) continue;
          if (
            held === null &&
            threads.length > 2 &&
            th === threads[threads.length - 1] &&
            random.chance(0.05)
          ) {
            // hold this delta back: the next one must be ESTALE, then both apply
            held = { th, deltas: [clone] };
            continue;
          }
          const pins = {
            calls: [],
            retain(rep, retireId) {
              pins.calls.push([rep, retireId]);
              return th.pinned.has(rep);
            },
          };
          if (mres.retired.length > 0 && random.chance(0.08)) {
            const fp = fingerprint(ctx, th);
            const boom = new Error('pins: a planned failure');
            assert.throws(
              () =>
                th.tree.apply(structuredClone(clone), {
                  retain() {
                    throw boom;
                  },
                }),
              (e) => e === boom,
              where(ctx, th, 'a throw of pins.retain'),
            );
            assert.equal(
              fingerprint(ctx, th),
              fp,
              where(ctx, th, 'a throw of pins.retain changed the replica'),
            );
          }
          for (const r of mres.retired)
            if (random.chance(0.3) && th.reps.has(r.uid))
              th.pinned.add(th.reps.get(r.uid));
          const retained = th.tree.apply(structuredClone(clone), pins);
          for (const [rep] of pins.calls) holdFormer(th, rep);
          const wantRetain = mres.retired
            .map((r) => th.reps.get(r.uid))
            .filter(Boolean);
          assert.equal(
            pins.calls.length,
            mres.retired.length,
            where(ctx, th, 'pins.retain calls'),
          );
          for (const [rep, retireId] of pins.calls) {
            assert.ok(
              wantRetain.includes(rep),
              where(
                ctx,
                th,
                "pins.retain with a representation not the replica's own",
              ),
            );
            assert.ok(
              ids.has(retireId),
              where(ctx, th, `pins.retain with retireId ${retireId}`),
            );
          }
          const expectRetained = pins.calls
            .filter(([rep]) => th.pinned.has(rep))
            .map(([, id]) => id)
            .sort((a, b) => a - b);
          assert.deepEqual(
            [...retained].sort((a, b) => a - b),
            expectRetained,
            where(ctx, th, 'retainedIds'),
          );
          if (random.chance(0.06)) {
            const fp = fingerprint(ctx, th);
            assert.throws(
              () =>
                th.tree.apply(structuredClone(clone), { retain: () => false }),
              { code: 'ESTALE' },
              where(ctx, th, 'a repeated delta'),
            );
            assert.equal(
              fingerprint(ctx, th),
              fp,
              where(ctx, th, 'a repeated delta changed the replica'),
            );
          }
        }
        // A held replica: skip a delta, expect ESTALE on the next, then catch up.
        if (held !== null && held.deltas[0] !== clone) {
          const th = held.th;
          const deltas = held.deltas;
          deltas.push(clone);
          const fp = fingerprint(ctx, th);
          assert.throws(
            () =>
              th.tree.apply(structuredClone(deltas[1]), {
                retain: () => false,
              }),
            { code: 'ESTALE' },
            where(ctx, th, 'a delta past a skipped one'),
          );
          assert.equal(
            fingerprint(ctx, th),
            fp,
            where(ctx, th, 'a skipped delta changed the replica'),
          );
          for (const d of deltas)
            th.tree.apply(structuredClone(d), { retain: () => false });
          held = null;
        }
      }
    }
    // Iterators: alive unless the structure of their tree changed — a change
    // of structureVersion, or a commit of the same publication (an equal
    // version) that changed it and leaves the number as it was: an iterator
    // never yields a dead node.
    const structural = mres !== null && mres.structure === true;
    for (const { th, it, rest, done, sv } of iters) {
      if (done) continue;
      const applied = th.main || held === null || held.th !== th;
      if (th.tree.structureVersion !== sv || (structural && applied)) {
        assert.throws(
          () => it.next(),
          { code: 'ESTALE' },
          where(ctx, th, 'an iterator after a change of structure'),
        );
      } else {
        const got = [];
        for (let r = it.next(); !r.done; r = it.next())
          got.push(th.nodeUid.get(r.value));
        assert.deepEqual(
          got,
          rest,
          where(ctx, th, 'an iterator after a commit that kept the structure'),
        );
      }
    }
    for (const n of model.nodes()) ctx.former.add(model.pathOf(n));
    if (ctx.former.size > 300)
      ctx.former = new Set([...ctx.former].slice(-200));
    for (const th of threads) {
      if (held !== null && held.th === th) continue; // a delta behind, on purpose
      compare(ctx, th);
      checkLookups(ctx, th);
      // an FS tree has no policies: allow is never called there
      if (on('policy')) checkPolicies(ctx, th);
      if (on('walk')) checkWalks(ctx, th);
    }
  }
  // A replica of the final state from a snapshot: everything the run made
  // goes through the snapshot's encoding once more.
  const late = replicaOf('late');
  compare(ctx, late);
  checkLookups(ctx, late);
};

module.exports = {
  runSeed,
  compare,
  fingerprint,
  checkLookups,
  checkWalks,
  checkPolicies,
  Thread,
  noSab,
  where,
  on,
  SECTIONS,
  COMMITS,
  SEEDS,
  ONE,
};
