'use strict';

// Run with --allow-natives-syntax --expose-gc: field representations of the
// engine's objects after one large number (test/tree-shapes.test.js). A full
// GC comes right after the engine is loaded and before any tree exists, and
// once more after the first tree is made and before its first commit — each
// clears what nothing holds, as a scan or a big structured clone would in
// the kernel. Then objects with small numbers are made, then one with a
// large size, version, time, subtree version or id; if a field had kept a
// small-integer or double representation, the large value would give its
// objects a new map (and migrate the old ones): `%HaveSameMap` of an old
// and a new object says it. The objects of main and of a replica alike: a
// replica's numbers come from the columns of a snapshot or a delta, a
// Float64Array among them once a value is past a small integer. A time is
// an integer first and a double after, as fs.stat gives them; a
// representation's offset is small and at the end of a segment; `others`
// holds different sets of fields; ids of an id tree are past 2³¹, below
// −2³¹ and strings, beside the FS nodes. Prints one line of JSON:
// { cases: [{ name, same }] }.

const engine = require('../tree-engine.js');
const data = require('../tree-data.js');

const sameMap = new Function('a', 'b', 'return %HaveSameMap(a, b)');

global.gc();

const BIG = 2 ** 31 + 5;
const NEGATIVE = -(2 ** 31) - 7;
const NO_PINS = { retain: () => false };
const cases = [];
const check = (name, a, b) => cases.push({ name, same: sameMap(a, b) });

const mk = (options = {}) =>
  engine.createTree({
    sep: '/',
    segments: data.createSegments(1),
    retireIds: new data.RetireIds(),
    now: 1,
    ...options,
  });

// A file's input: an integer mtimeMs unless one is given, no
// representations unless given.
const file = (size, mtimeMs = 1, extra = {}) => ({
  size,
  mtimeMs,
  representations: [],
  ...extra,
});

const replicaOf = (tree, segments) =>
  engine.fromSnapshot(structuredClone(tree.snapshot()), segments);

const apply = (replica, result) =>
  replica.apply(structuredClone(result.delta), NO_PINS);

{
  // FS main: a GC after the tree is made and before its first commit; a
  // payload of a large size beside small ones; a commit of a large version
  // beside small ones; mtimeMs an integer first and a double after.
  const tree = mk();
  global.gc();
  tree.commit([['write', '/a', file(1)]], 1, 2);
  tree.commit([['write', '/b', file(BIG)]], 2, 3);
  const a = tree.payloadOf(tree.get('/a'));
  const b = tree.payloadOf(tree.get('/b'));
  check('payload: a size past 2^31', a, b);
  tree.commit([['write', '/c', file(2)]], BIG, 4);
  const c = tree.payloadOf(tree.get('/c'));
  check('payload: a version past 2^31', a, c);
  check('node: an FS node made after them', tree.get('/a'), tree.get('/c'));
  tree.commit([['write', '/d', file(3, 1.5)]], BIG + 1, 5);
  const d = tree.payloadOf(tree.get('/d'));
  check('payload: mtimeMs an integer, then a double', a, d);
  // An id tree's ids beside the FS nodes (the spec's rule: other trees'
  // ids must not turn the FS nodes' ids into doubles): past 2^31, below
  // -2^31, strings; a policy on a node beside one without.
  const client = mk({ ids: 'number' });
  client.commit(
    [
      ['put', 1, null, '', { class: 0 }],
      ['put', 2, 1, 'small', { class: 1 }],
    ],
    1,
    2,
  );
  client.commit([['put', BIG, 1, 'big', { class: 1 }]], 2, 3);
  check('id tree node: an id past 2^31', client.byId(2), client.byId(BIG));
  tree.commit([['write', '/e', file(4)]], BIG + 2, 6);
  check(
    "FS node: after an id tree's id past 2^31",
    tree.get('/a'),
    tree.get('/e'),
  );
  client.commit([['put', NEGATIVE, 1, 'negative', { class: 1 }]], 3, 4);
  check(
    'id tree node: an id below -2^31',
    client.byId(2),
    client.byId(NEGATIVE),
  );
  client.commit(
    [['put', 3, 1, 'guarded', { class: 1, policy: { level: 1 } }]],
    4,
    5,
  );
  check(
    'id tree node: with a policy beside one without',
    client.byId(2),
    client.byId(3),
  );
  const strings = mk({ ids: 'string' });
  strings.commit(
    [
      ['put', 'root', null, '', { class: 0 }],
      ['put', 'kid', 'root', 'x', { class: 1 }],
    ],
    1,
    2,
  );
  tree.commit([['write', '/f', file(5)]], BIG + 3, 7);
  check(
    'FS node: after a tree of string ids appeared',
    tree.get('/a'),
    tree.get('/f'),
  );
  client.commit([['put', 4, 1, 'later', { class: 1 }]], 5, 6);
  check(
    'id tree node: after a tree of string ids appeared',
    client.byId(2),
    client.byId(4),
  );
}

{
  // birthtimeMs: an integer first, a double after, then one past 2^31,
  // given and inherited by a replacement.
  const tree = mk({ birthtime: true });
  tree.commit([['write', '/a', file(1, 1, { birthtimeMs: 1 })]], 1, 2);
  tree.commit([['write', '/b', file(1, 1.5, { birthtimeMs: 2.5 })]], 2, 3);
  const a = tree.payloadOf(tree.get('/a'));
  check(
    'payload: birthtimeMs an integer, then a double',
    a,
    tree.payloadOf(tree.get('/b')),
  );
  tree.commit([['write', '/c', file(1, 1, { birthtimeMs: BIG })]], 3, 4);
  check('payload: birthtimeMs past 2^31', a, tree.payloadOf(tree.get('/c')));
  tree.commit([['write', '/c', file(2)]], 4, 5);
  check(
    'payload: birthtimeMs inherited past 2^31',
    a,
    tree.payloadOf(tree.get('/c')),
  );
}

{
  // A replica from a snapshot of small numbers, then deltas: a removal and
  // a creation, a size past 2^31, a version past 2^31 — from the columns of
  // the deltas — and the subtree versions (`ver`) that take it, in main and
  // in the replica; a replica from a snapshot that holds the big numbers.
  const segments = data.createSegments(1);
  const tree = mk({ segments, aggregates: { subtreeVersion: true } });
  tree.commit(
    [
      ['write', '/a', file(1)],
      ['write', '/b', file(2)],
    ],
    1,
    2,
  );
  const replica = replicaOf(tree, segments);
  global.gc(); // between the replica's birth and its first delta
  const ra = replica.get('/a');
  const rpa = replica.payloadOf(ra);
  apply(
    replica,
    tree.commit(
      [
        ['remove', '/b'],
        ['write', '/c', file(3)],
      ],
      2,
      3,
    ),
  );
  const rc = replica.get('/c');
  check('replica node: after a delta with a removal and a creation', ra, rc);
  check('replica payload: after that delta', rpa, replica.payloadOf(rc));
  apply(replica, tree.commit([['write', '/d', file(BIG)]], 3, 4));
  check(
    'replica payload: a size past 2^31 from a delta',
    rpa,
    replica.payloadOf(replica.get('/d')),
  );
  check('replica node: after the big size', ra, replica.get('/d'));
  apply(replica, tree.commit([['write', '/e', file(4)]], BIG, 5));
  check(
    'replica payload: a version past 2^31 from a delta',
    rpa,
    replica.payloadOf(replica.get('/e')),
  );
  check('replica node: a subtree version past 2^31', ra, replica.get('/e'));
  check(
    'main node: a subtree version past 2^31',
    tree.get('/a'),
    tree.get('/e'),
  );
  apply(replica, tree.commit([['write', '/f', file(5, 2.5)]], BIG + 1, 6));
  check(
    'replica payload: mtimeMs a double from a delta after integers',
    rpa,
    replica.payloadOf(replica.get('/f')),
  );
  const late = replicaOf(tree, segments);
  check(
    'late replica payload: a small size beside a big one',
    late.payloadOf(late.get('/a')),
    late.payloadOf(late.get('/d')),
  );
  check(
    'late replica node: a small subtree version beside a big one',
    late.get('/a'),
    late.get('/e'),
  );
}

{
  // Representations and others: an offset small and at the end of a
  // segment; a payload with `others` beside one without; `others` with
  // different fields set; after a relocation — in main and in a replica.
  const segments = data.createSegments(2, 1 << 20);
  const tree = mk({ segments });
  const rep = (offset, kind = 0) => [kind, { segmentId: 1, offset, length: 8 }];
  const input = (...reps) => ({ size: 8, mtimeMs: 1, representations: reps });
  tree.commit([['write', '/a', input(rep(0))]], 1, 2);
  tree.commit([['write', '/b', input(rep((1 << 20) - 8))]], 2, 3);
  tree.commit([['write', '/c', input(rep(8), rep(16, 2))]], 3, 4);
  tree.commit([['write', '/d', input(rep(24), rep(32, 5))]], 4, 5);
  const pa = tree.payloadOf(tree.get('/a'));
  const pc = tree.payloadOf(tree.get('/c'));
  const pd = tree.payloadOf(tree.get('/d'));
  check(
    'representation: an offset small and at the end of a segment',
    pa.source,
    tree.payloadOf(tree.get('/b')).source,
  );
  check('payload: with others beside one without', pa, pc);
  check('others: with scriptBytecode beside one with br', pc.others, pd.others);
  const replica = replicaOf(tree, segments);
  const ra = replica.payloadOf(replica.get('/a'));
  const rc = replica.payloadOf(replica.get('/c'));
  check(
    'replica representation: an offset small and at the end of a segment',
    ra.source,
    replica.payloadOf(replica.get('/b')).source,
  );
  check('replica payload: with others beside one without', ra, rc);
  check(
    'replica others: with scriptBytecode beside one with br',
    rc.others,
    replica.payloadOf(replica.get('/d')).others,
  );
  const id = tree.nodeId(tree.get('/c'));
  apply(
    replica,
    tree.commit(
      [['relocate', id, 2, { segmentId: 1, offset: 64, length: 8 }]],
      5,
      6,
    ),
  );
  check(
    'others: after a relocation',
    pd.others,
    tree.payloadOf(tree.get('/c')).others,
  );
  check('payload: after a relocation', pa, tree.payloadOf(tree.get('/c')));
  check(
    'replica others: after a relocation',
    replica.payloadOf(replica.get('/d')).others,
    replica.payloadOf(replica.get('/c')).others,
  );
  check(
    'replica payload: after a relocation',
    ra,
    replica.payloadOf(replica.get('/c')),
  );
}

process.stdout.write(JSON.stringify({ cases }));
