'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const engine = require('./tree-engine.js');
const data = require('./tree-data.js');

// Languages and pages of an id tree (doc/architecture.md, "Shared trees"):
// the cases the random test reaches too seldom to hold them — a node that
// becomes the root and leaves it again, every representation of a node
// moved in one commit, the rule of a page's version — and the delta of a
// tree of one language, which languages leave as it was.

const NO_PINS = { retain: () => false };

const idTree = (options = {}) => {
  const segments = data.createSegments(1);
  const extents = new data.Extents(segments);
  const tree = engine.createTree({
    ids: 'number',
    segments,
    retireIds: new data.RetireIds(),
    now: 1,
    ...options,
  });
  return { tree, segments, extents };
};

const payloadOf = (extents, kinds = [0]) => ({
  size: 8,
  mtimeMs: 1000,
  representations: kinds.map((kind) => [kind, extents.next(8)]),
});

const replicaOf = (tree, segments) =>
  engine.fromSnapshot(structuredClone(tree.snapshot()), segments);

describe('tree languages: the root', () => {
  it('a node that becomes the root is "" in every language; moved under a parent again it needs its names there', () => {
    const { tree, extents } = idTree({ languages: 2 });
    let v = 0;
    tree.commit(
      [
        ['put', 0, null, '', { class: 0 }],
        [
          'put',
          1,
          0,
          'a',
          {
            class: 0,
            translations: [[1, { name: 'a-uk', payload: payloadOf(extents) }]],
          },
        ],
        ['put', 2, 1, 'b', { class: 1, translations: [[1, { name: 'b-uk' }]] }],
      ],
      ++v,
      1,
    );
    assert.equal(tree.pathOf(tree.byId(2), 1), '/a-uk/b-uk');
    // The rows turn the tree over: 1 the root, 0 below it. 1 keeps its
    // translation and its payload there, named ''.
    tree.load(
      [
        { id: 1, parentId: null, name: '' },
        { id: 0, parentId: 1, name: 'r' },
        { id: 2, parentId: 1, name: 'b' },
      ],
      ++v,
      1,
    );
    const root = tree.byId(1);
    assert.equal(tree.get('/', null, 1), root);
    assert.equal(tree.nameOf(root, 1), '');
    assert.notEqual(tree.payloadOf(root, 1), null);
    assert.equal(tree.get('/b-uk', null, 1), tree.byId(2));
    assert.equal(tree.pathOf(tree.byId(0), 1), null);
    // Back under a parent: '' is no name there.
    const back = (fields) =>
      tree.load(
        [
          { id: 0, parentId: null, name: '' },
          { id: 1, parentId: 0, name: 'a', ...fields },
          { id: 2, parentId: 1, name: 'b' },
        ],
        ++v,
        1,
      );
    assert.throws(() => back({}), { code: 'ENOENT', index: 1, lang: 1 });
    assert.throws(() => back({ translations: [[1, {}]] }), {
      code: 'ENOENT',
      index: 1,
      lang: 1,
    });
    back({ translations: [[1, { name: 'again' }]] });
    assert.equal(tree.pathOf(tree.byId(2), 1), '/again/b-uk');
    assert.notEqual(tree.payloadOf(tree.byId(1), 1), null);
  });
});

describe('tree languages: compaction', () => {
  it('every representation of one node moves in one commit, as a compaction of the segment holding them moves them', () => {
    for (const languages of [1, 2]) {
      const { tree, extents } = idTree({ languages });
      const fields = { class: 1, payload: payloadOf(extents, [0, 3]) };
      if (languages > 1)
        fields.translations = [
          [1, { name: 'x-uk', payload: payloadOf(extents, [0, 3]) }],
        ];
      tree.commit(
        [
          ['put', 0, null, '', { class: 0 }],
          ['put', 1, 0, 'x', fields],
        ],
        1,
        1,
      );
      const ops = [
        ['relocate', 1, 0, extents.next(8)],
        ['relocate', 1, 3, extents.next(8)],
      ];
      if (languages > 1)
        ops.push(
          ['relocate', 1, 0, extents.next(8), 1],
          ['relocate', 1, 3, extents.next(8), 1],
        );
      const { retired, placed, version } = tree.commit(ops, 2, 1);
      assert.equal(version, 1, 'a relocation is no publication');
      assert.equal(retired.length, ops.length);
      assert.equal(placed.length, ops.length);
      assert.throws(
        () =>
          tree.commit(
            [
              ['relocate', 1, 3, extents.next(8)],
              ['relocate', 1, 3, extents.next(8), 0],
            ],
            2,
            1,
          ),
        { code: 'EINVAL', index: 1 },
      );
    }
  });
});

describe('tree pages', () => {
  it('a page takes the version and leaves the data — its object, its attributes; a relocation takes no version', () => {
    const { tree, extents, segments } = idTree();
    const replica = (() => {
      tree.commit([['put', 0, null, '', { class: 0 }]], 1, 1);
      return replicaOf(tree, segments);
    })();
    const step = (ops, next) => {
      const result = tree.commit(ops, next, 1);
      if (result.delta !== null)
        replica.apply(structuredClone(result.delta), NO_PINS);
      return result;
    };
    step(
      [['put', 1, 0, 'p', { class: 1, payload: payloadOf(extents, [0, 2]) }]],
      2,
    );
    const data0 = tree.payloadOf(tree.byId(1));
    const page = [
      [1, extents.next(8)],
      [3, extents.next(8)],
    ];
    const first = step([['render', 1, 0, page]], 3);
    const p1 = tree.payloadOf(tree.byId(1));
    assert.equal(p1.version, 3);
    assert.equal(p1.source, data0.source, 'the data is the same object');
    assert.equal(p1.others.scriptBytecode, data0.others.scriptBytecode);
    assert.equal(p1.mtimeMs, data0.mtimeMs);
    assert.equal(p1.size, data0.size);
    assert.equal(p1.others.requireBytecode.offset, page[0][1].offset);
    assert.equal(p1.others.gzip.offset, page[1][1].offset);
    assert.deepEqual(first.retired, []);
    // Another page: the former one's forms retire, the data stays.
    const second = step(
      [['put', 1, 0, 'p', { page: [[1, extents.next(8)]] }]],
      4,
    );
    const p2 = tree.payloadOf(tree.byId(1));
    assert.equal(p2.version, 4);
    assert.equal(p2.source, data0.source);
    assert.equal(p2.others.gzip, null);
    assert.deepEqual(second.retired.map((r) => r.kind).sort(), [1, 3]);
    // A relocation of the page: the version stays.
    step([['relocate', 1, 1, extents.next(8)]], 5);
    assert.equal(tree.payloadOf(tree.byId(1)).version, 4);
    // No page: one step; none where there is none: nothing.
    const third = step([['render', 1, 0, []]], 5);
    const p3 = tree.payloadOf(tree.byId(1));
    assert.equal(p3.version, 5);
    assert.equal(p3.others.requireBytecode, null);
    assert.equal(p3.others.scriptBytecode, data0.others.scriptBytecode);
    assert.equal(third.retired.length, 1);
    const none = step([['render', 1, 0, []]], 6);
    assert.equal(none.delta, null);
    assert.equal(tree.version, 5);
    // A page without the data it renders: ENOENT.
    step([['put', 2, 0, 'q', { class: 1 }]], 6);
    assert.throws(() => step([['render', 2, 0, [[1, extents.next(8)]]]], 7), {
      code: 'ENOENT',
      index: 0,
    });
    assert.throws(
      () => step([['put', 2, 0, 'q', { page: [[1, extents.next(8)]] }]], 7),
      { code: 'ENOENT', index: 0 },
    );
    // A page beside data: EINVAL — the page of new data is among its
    // representations.
    assert.throws(
      () =>
        step(
          [['put', 1, 0, 'p', { payload: payloadOf(extents), page: [] }]],
          7,
        ),
      { code: 'EINVAL', index: 0 },
    );
    // The replica followed every step.
    for (const id of [1, 2]) {
      const mine = tree.payloadOf(tree.byId(id));
      const theirs = replica.payloadOf(replica.byId(id));
      assert.equal(theirs?.version, mine?.version);
      assert.equal(theirs?.others?.gzip?.offset, mine?.others?.gzip?.offset);
    }
  });
});

describe('tree languages: one language', () => {
  it('a tree of one language makes the delta and the retired list it made before languages', () => {
    const { tree, extents } = idTree();
    tree.commit(
      [
        ['put', 0, null, '', { class: 0 }],
        ['put', 1, 0, 'x', { class: 1, payload: payloadOf(extents) }],
      ],
      1,
      1,
    );
    const { delta, retired, placed } = tree.commit(
      [['put', 1, 0, 'x', { payload: payloadOf(extents) }]],
      2,
      1,
    );
    assert.equal('lname' in delta, false);
    assert.equal('lang' in delta.retired, false);
    assert.equal('lang' in retired[0], false);
    assert.equal('lang' in placed[0], false);
    const snapshot = tree.snapshot();
    assert.equal(snapshot.languages, 1);
    assert.equal(snapshot.tnode, null);
    assert.equal(snapshot.plang, null);
    assert.throws(() => tree.get('/x', null, 1), { code: 'EINVAL' });
    assert.throws(
      () => tree.commit([['put', 1, 0, 'x', { translations: [] }]], 3, 1),
      { code: 'EINVAL', index: 0 },
    );
  });

  it('languages: from 1 to 255, of an id tree', () => {
    const fs = { segments: new Map(), retireIds: new data.RetireIds() };
    assert.throws(() => engine.createTree({ ...fs, languages: 2 }), {
      code: 'EINVAL',
    });
    for (const languages of [0, 256, 1.5, '2'])
      assert.throws(() => idTree({ languages }), { code: 'EINVAL' });
    assert.equal(idTree({ languages: 255 }).tree.languages, 255);
  });
});
