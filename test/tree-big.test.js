'use strict';

// The tree engine on large trees (SPEC.md, "Correctness"): a catalog built in
// compound commits and a replica fed from the very first delta; moves of
// subtrees above and below the move threshold after the caches are warm,
// and the former keys below them; a large batch refused at its last op; both
// separators; in a tree with client ids, a large load and loads with a few
// rows changed. The model and the comparison are the model test's.
//
//   TREE_SEEDS (1 in npm test, 6 for the gate)  TREE_BIG (files, 1500)
//   TREE_ENGINE=<module>

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('./tree-engine.js');
const { ModelTree } = require('./tree-model.js');
const data = require('./tree-data.js');
const {
  compare,
  fingerprint,
  checkLookups,
  Thread,
  noSab,
  where,
} = require('./tree-run.js');

const SEEDS = Number(process.env.TREE_SEEDS ?? 1);
const FILES = Number(process.env.TREE_BIG ?? 1500);

const run = (seed) => {
  const random = data.rng(1000 + seed);
  const fs = seed % 2 === 1;
  const segments = data.createSegments(4, 1 << 20);
  const extents = new data.Extents(segments);
  const retire = new data.RetireIds();
  const options = {
    ids: fs ? 'engine' : 'number',
    segments,
    sep: seed % 3 === 0 ? '\\' : '/',
    directories: fs && random.chance(0.5),
    birthtime: random.chance(0.5),
    aggregates: {
      classes: random.chance(0.5),
      subtreeVersion: random.chance(0.5),
    },
    cache: {
      size: random.pick([0, 64, 1 << 16]),
      misses: random.pick([false, { size: 4096 }]),
      moveThreshold: random.pick([0, 1, 1024]),
    },
    retireIds: retire,
    now: 1000,
  };
  if (!fs) options.containers = [0, 1, 2];
  const model = new ModelTree(options);
  const main = new Thread('main', engine.createTree(options), segments, true);
  const ctx = {
    seed: 1000 + seed,
    step: 0,
    random,
    model,
    extents,
    retire,
    segments,
    sep: options.sep,
    now: 1000,
    counter: 1,
    ids: new Map(),
    idOwner: new Map(),
    former: new Set(),
    deadIds: [],
  };
  // A replica from the first delta, and one from a snapshot taken later.
  const first = new Thread(
    'first',
    engine.fromSnapshot(structuredClone(main.tree.snapshot()), segments),
    segments,
    false,
  );
  const threads = [main, first];
  let next = 0;
  const commit = (ops, isLoad = false) => {
    ctx.step++;
    ctx.now += 3;
    next += 1;
    const m = isLoad
      ? model.load(ops, next, ctx.now)
      : model.commit(ops, next, ctx.now);
    const r = isLoad
      ? main.tree.load(ops, next, ctx.now)
      : main.tree.commit(ops, next, ctx.now);
    assert.equal(r.version, model.version, where(ctx, main, 'version'));
    // retired as a multiset of (id, kind, extent), as the model test has it
    const want = m.retired.map((x) => `${x.id}|${x.kind}|${x.extent}`).sort();
    const got = r.retired
      .map(
        (x) =>
          `${x.id}|${x.kind}|${x.rep.segmentId}:${x.rep.offset}:${x.rep.length}`,
      )
      .sort();
    assert.deepEqual(got, want, where(ctx, main, 'retired'));
    if (r.delta !== null) {
      noSab(r.delta, where(ctx, main, 'delta'));
      for (const th of threads.slice(1))
        th.tree.apply(structuredClone(r.delta), { retain: () => false });
    }
    return m;
  };
  const refused = (ops, code, isLoad = false) => {
    const fp = fingerprint(ctx, main);
    let index = null;
    assert.throws(
      () =>
        isLoad
          ? model.load(ops, next + 1, ctx.now)
          : model.commit(ops, next + 1, ctx.now),
      (e) => {
        index = e.index;
        return e.code === code && Number.isInteger(e.index);
      },
      where(ctx, main, 'the model should refuse'),
    );
    assert.throws(
      () =>
        isLoad
          ? main.tree.load(ops, next + 1, ctx.now)
          : main.tree.commit(ops, next + 1, ctx.now),
      (e) => e.code === code && e.index === index,
      where(ctx, main, `a refused large batch (${code} at ${index})`),
    );
    assert.equal(
      fingerprint(ctx, main),
      fp,
      where(ctx, main, 'a refused large batch changed the tree'),
    );
  };
  const all = () => {
    for (const th of threads) compare(ctx, th);
  };
  if (fs) {
    // The catalog, in compound commits.
    const keys = data.catalogKeys(FILES);
    for (const batch of data.catalogBatches(keys, extents, 700)) commit(batch);
    threads.push(
      new Thread(
        'later',
        engine.fromSnapshot(structuredClone(main.tree.snapshot()), segments),
        segments,
        false,
      ),
    );
    all();
    // Warm the caches, then move subtrees of every size; the former keys miss.
    const subtree = (key) =>
      [...model.nodes()]
        .map((n) => model.pathOf(n))
        .filter((k) => k === key || k.startsWith(key + '/'));
    const moves = [
      ['/section-0/category-00/sub-000', '/section-0/category-00/moved-a'], // 21 nodes
      ['/section-0/category-01', '/section-0/moved-b'], // ~420 nodes
      ['/section-0', '/moved-c'], // the whole catalog of the first section
    ];
    for (const [from, to] of moves) {
      if (model.find(from) === null) continue;
      const before = subtree(from);
      for (const th of threads) for (const k of before) th.tree.get(k);
      for (const th of threads)
        for (const k of before.slice(0, 50)) th.tree.resolve(`/mnt${k}`, 4);
      commit([['move', from, to]]);
      for (const th of threads) {
        for (const k of before)
          assert.equal(
            th.tree.get(k),
            null,
            where(ctx, th, `a former key ${k} after a move`),
          );
        const now = before.map((k) => to + k.slice(from.length));
        for (const k of now)
          assert.notEqual(
            th.tree.get(k),
            null,
            where(ctx, th, `a new key ${k} after a move`),
          );
      }
      all();
    }
    // Misses below created and moved nodes: miss first, then create.
    for (const th of threads) th.tree.get('/moved-c/new-dir/x');
    commit([
      ['mkdir', '/moved-c/new-dir'],
      ['write', '/moved-c/new-dir/x', data.payloadOf(random, extents)],
    ]);
    for (const th of threads)
      assert.notEqual(
        th.tree.get('/moved-c/new-dir/x'),
        null,
        where(ctx, th, 'a miss cached before a creation'),
      );
    // A large batch refused at its last op.
    const big = [];
    for (let i = 0; i < 1000; i++)
      big.push([
        'write',
        `/moved-c/new-dir/f${i}`,
        data.payloadOf(random, extents),
      ]);
    big.push(['rmdir', '/moved-c']);
    refused(big, 'ENOTEMPTY');
    // A removal of a large subtree, and its former keys.
    const gone = subtree('/moved-c');
    commit([['remove', '/moved-c']]);
    for (const th of threads)
      for (const k of gone.slice(0, 300))
        assert.equal(
          th.tree.get(k),
          null,
          where(ctx, th, `a former key ${k} after a removal`),
        );
    checkLookups(ctx, main);
    all();
  } else {
    // A large load, then loads with a few rows changed, then moves by put.
    const rows = [{ id: 0, parentId: null, name: '', class: 0 }];
    let id = 1;
    const sections = [];
    for (let s = 0; s < 5; s++) {
      const sid = id++;
      sections.push(sid);
      rows.push({ id: sid, parentId: 0, name: `section-${s}`, class: 0 });
      for (let c = 0; c < 10; c++) {
        const cid = id++;
        rows.push({ id: cid, parentId: sid, name: `category-${c}`, class: 1 });
        for (let i = 0; i < Math.ceil(FILES / 50); i++) {
          rows.push({
            id: id++,
            parentId: cid,
            name: data.nameOf(random, id),
            class: 2,
            payload: data.payloadOf(random, extents),
          });
        }
      }
    }
    commit(random.shuffle(rows), true);
    threads.push(
      new Thread(
        'later',
        engine.fromSnapshot(structuredClone(main.tree.snapshot()), segments),
        segments,
        false,
      ),
    );
    all();
    for (let round = 0; round < 3; round++) {
      const live = [...model.nodes()];
      const again = live
        .map((n) => {
          const row = {
            id: n.id,
            parentId: n.parent === null ? null : n.parent.id,
            name: n.name,
          };
          if (random.chance(0.01))
            row.payload = data.payloadOf(random, extents);
          return row;
        })
        .filter((row) => row.parentId === null || random.chance(0.995));
      try {
        model.clone().load(again, next + 1, ctx.now);
        commit(again, true);
      } catch (err) {
        refused(again, err.code, true);
      }
      all();
    }
    // A move of a large subtree by one put, and the former keys.
    const sec = model.byId.get(sections[1]);
    if (sec) {
      const before = [...model.nodes()]
        .map((n) => model.pathOf(n))
        .filter((k) => k.startsWith('/section-1/') || k === '/section-1');
      for (const th of threads) for (const k of before) th.tree.get(k);
      commit([['put', sections[1], sections[0], 'moved', {}]]);
      for (const th of threads)
        for (const k of before.slice(0, 300))
          assert.equal(
            th.tree.get(k),
            null,
            where(ctx, th, `a former key ${k}`),
          );
      all();
    }
    // A load refused at its last row (a cycle).
    const live = [...model.nodes()].filter((n) => n.parent !== null);
    if (live.length > 2) {
      const rowsBad = [...model.nodes()].map((n) => ({
        id: n.id,
        parentId: n.parent === null ? null : n.parent.id,
        name: n.name,
      }));
      const a = rowsBad.find((r) => r.id === sections[0]);
      const b = rowsBad.find((r) => r.parentId === sections[0]);
      if (a && b) {
        a.parentId = b.id;
        refused(rowsBad, 'EINVAL', true);
      }
    }
  }
};

test(`tree engine on large trees — ${SEEDS} seed(s), ${FILES} files`, () => {
  for (let seed = 1; seed <= SEEDS; seed++) run(seed);
});
