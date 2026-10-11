'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const engine = require('./tree-engine.js');
const data = require('./tree-data.js');

// Shapes the random tests never reach — a chain 50 000 deep, a parent with
// 10⁵ children, a load of a long chain — and the costs that must not grow
// with them (.work/stage1/SPEC.md, "Correctness"; the reviews of step A
// found each of them broken in one engine). Nothing may recurse by depth: a
// RangeError is no refusal but an engine's bug. A cost is held to a ratio,
// not to a time, so that a slow machine passes and a path that grows with
// the children or with rows × depth does not.

const DEPTH = 50000;
const WIDE = 100000;
const ROWS = 8000;
const RATIO = 25;
const ROUNDS = 21;

const fsTree = () => {
  const segments = data.createSegments(1);
  const tree = engine.createTree({
    sep: '/',
    segments,
    retireIds: new data.RetireIds(),
    now: 1,
  });
  return { tree, segments };
};

const clientTree = (options = {}) =>
  engine.createTree({
    ids: 'number',
    segments: data.createSegments(1),
    retireIds: new data.RetireIds(),
    now: 1,
    ...options,
  });

const file = () => ({ size: 1, mtimeMs: 1, representations: [] });

const replicaOf = (tree, segments) =>
  engine.fromSnapshot(structuredClone(tree.snapshot()), segments);

const NO_PINS = { retain: () => false };

const count = (iterable) => {
  const it = iterable[Symbol.iterator]();
  let n = 0;
  while (!it.next().done) n++;
  return n;
};

const median = (list) => {
  const s = [...list].sort((a, b) => a - b);
  return s[s.length >> 1];
};

// The median time of `run(i)` over ROUNDS rounds, in ms.
const timeOf = (run) => {
  const times = [];
  for (let i = 0; i < ROUNDS; i++) {
    const t0 = process.hrtime.bigint();
    run(i);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return median(times);
};

describe('tree engine on deep and wide trees', () => {
  it(`an FS chain ${DEPTH} deep: lookups, walk, trail, snapshot, removal`, () => {
    const { tree, segments } = fsTree();
    const key = '/a'.repeat(DEPTH) + '/f';
    let version = 0;
    tree.commit([['write', key, file(), { parents: true }]], ++version, 2);
    const leaf = tree.get(key);
    assert.ok(leaf !== null, 'get of the deepest file');
    assert.equal(tree.pathOf(leaf), key, 'pathOf of the deepest file');
    assert.equal(tree.trailOf(leaf).length, DEPTH + 2, 'trailOf');
    assert.equal(count(tree.walk(tree.get(''))), DEPTH + 1, 'walk');
    assert.equal(
      tree.check(leaf, () => true, null),
      leaf,
      'check',
    );
    const replica = replicaOf(tree, segments);
    assert.ok(replica.get(key) !== null, 'the replica from a snapshot');
    const { delta } = tree.commit([['remove', '/a']], ++version, 3);
    replica.apply(structuredClone(delta), NO_PINS);
    for (const t of [tree, replica]) {
      assert.equal(t.get(key), null, 'the chain is removed');
      assert.equal(t.countOf(t.get('')), 0, 'the root has no children');
    }
  });

  it(`a client chain ${DEPTH} deep: load, policies on the way, check, removal`, () => {
    const tree = clientTree();
    const rows = [{ id: 0, parentId: null, name: '', class: 0 }];
    for (let id = 1; id <= DEPTH; id++) {
      const row = { id, parentId: id - 1, name: 'n', class: 0 };
      if (id % 1000 === 0) row.policy = { level: id };
      rows.push(row);
    }
    let version = 0;
    tree.load(rows, ++version, 2);
    const key = '/n'.repeat(DEPTH);
    const deepest = tree.byId(DEPTH);
    const calls = [];
    const allow = (policy) => {
      calls.push(policy.level);
      return true;
    };
    assert.equal(tree.get(key, { allow }), deepest, 'get with allow');
    assert.equal(calls.length, DEPTH / 1000, 'allow at every own policy');
    assert.equal(tree.check(deepest, allow, null), deepest, 'check');
    assert.equal(count(tree.walk(tree.byId(0))), DEPTH, 'walk');
    // The same rows again: a load of a live chain changes nothing.
    tree.load(rows, ++version, 3);
    assert.equal(tree.byId(DEPTH), deepest, 'the chain kept');
    tree.commit([['remove', 1]], ++version, 4);
    assert.equal(tree.get(key), null, 'the chain is removed');
    assert.equal(tree.byId(DEPTH), null, 'byId of a removed node');
  });

  it(`an insertion under a parent of ${WIDE} children costs about what it does under a narrow one`, () => {
    const { tree } = fsTree();
    let version = 0;
    tree.commit(
      [
        ['mkdir', '/w'],
        ['mkdir', '/n'],
      ],
      ++version,
      2,
    );
    for (let at = 0; at < WIDE; at += 10000) {
      const ops = [];
      for (let i = at; i < at + 10000; i++)
        ops.push(['write', `/w/f${i}`, file()]);
      tree.commit(ops, ++version, 3);
    }
    for (let i = 0; i < 10; i++) {
      tree.commit([['write', `/n/f${i}`, file()]], ++version, 4);
    }
    const wide = timeOf((i) =>
      tree.commit([['write', `/w/new${i}`, file()]], ++version, 5),
    );
    const narrow = timeOf((i) =>
      tree.commit([['write', `/n/new${i}`, file()]], ++version, 6),
    );
    assert.ok(
      wide < RATIO * Math.max(narrow, 0.01),
      `a write under ${WIDE} children: ${wide.toFixed(3)} ms, under 10: ${narrow.toFixed(3)} ms`,
    );
    const client = clientTree();
    const rows = [{ id: 0, parentId: null, name: '', class: 0 }];
    rows.push({ id: 1, parentId: 0, name: 'narrow', class: 0 });
    for (let id = 2; id < WIDE + 2; id++)
      rows.push({ id, parentId: 0, name: `c${id}`, class: 1 });
    client.load(rows, ++version, 7);
    let next = WIDE + 10;
    const cwide = timeOf(() =>
      client.commit(
        [['put', next++, 0, `p${next}`, { class: 1 }]],
        ++version,
        8,
      ),
    );
    const cnarrow = timeOf(() =>
      client.commit(
        [['put', next++, 1, `p${next}`, { class: 1 }]],
        ++version,
        9,
      ),
    );
    assert.ok(
      cwide < RATIO * Math.max(cnarrow, 0.01),
      `a put under ${WIDE} children: ${cwide.toFixed(3)} ms, under few: ${cnarrow.toFixed(3)} ms`,
    );
  });

  it(`a load of a chain of ${ROWS} rows costs about what a flat load does`, () => {
    const chain = [{ id: 0, parentId: null, name: '', class: 0 }];
    const flat = [{ id: 0, parentId: null, name: '', class: 0 }];
    for (let id = 1; id <= ROWS; id++) {
      chain.push({ id, parentId: id - 1, name: 'n', class: 0 });
      flat.push({ id, parentId: 0, name: `n${id}`, class: 0 });
    }
    const loadOf = (rows) => {
      const times = [];
      for (let i = 0; i < 5; i++) {
        const tree = clientTree();
        const t0 = process.hrtime.bigint();
        tree.load(rows, 1, 2);
        times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
      return median(times);
    };
    const c = loadOf(chain);
    const f = loadOf(flat);
    assert.ok(
      c < RATIO * Math.max(f, 0.01),
      `a load of a chain: ${c.toFixed(2)} ms, of a flat tree: ${f.toFixed(2)} ms`,
    );
  });
});
