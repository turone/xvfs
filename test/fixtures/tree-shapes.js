'use strict';

// Run with --allow-natives-syntax --expose-gc: field representations of the
// engine's objects after one large number (test/tree-shapes.test.js). A full
// GC comes right after the engine is loaded and before any tree exists — it
// clears what nothing holds, as a scan or a big structured clone would in
// the kernel. Then objects with small numbers are made, then one with a
// large size, version or id; if a field had kept a small-integer or double
// representation, the large value would give its objects a new map (and
// migrate the old ones): `%HaveSameMap` of an old and a new object says it.
// Prints one line of JSON: { cases: [{ name, same }] }.

const engine = require('../tree-engine.js');
const data = require('../tree-data.js');

const sameMap = new Function('a', 'b', 'return %HaveSameMap(a, b)');

global.gc();

const BIG = 2 ** 31 + 5;
const cases = [];
const check = (name, a, b) => cases.push({ name, same: sameMap(a, b) });

const file = (size) => ({
  size,
  mtimeMs: 1.7e12 + 0.5,
  representations: [],
});

{
  // FS: a payload of a large size beside small ones; a commit of a large
  // version beside small ones.
  const tree = engine.createTree({
    sep: '/',
    segments: data.createSegments(1),
    retireIds: new data.RetireIds(),
    now: 1,
  });
  tree.commit([['write', '/a', file(1)]], 1, 2);
  tree.commit([['write', '/b', file(BIG)]], 2, 3);
  const a = tree.payloadOf(tree.get('/a'));
  const b = tree.payloadOf(tree.get('/b'));
  check('payload: a size past 2^31', a, b);
  tree.commit([['write', '/c', file(2)]], BIG, 4);
  const c = tree.payloadOf(tree.get('/c'));
  check('payload: a version past 2^31', a, c);
  check('node: an FS node made after them', tree.get('/a'), tree.get('/c'));
  // A client tree's large id beside the FS nodes (the spec's rule: other
  // trees' ids must not turn the FS nodes' ids into doubles).
  const client = engine.createTree({
    ids: 'number',
    segments: data.createSegments(1),
    retireIds: new data.RetireIds(),
    now: 1,
  });
  client.commit(
    [
      ['put', 1, null, '', { class: 0 }],
      ['put', 2, 1, 'small', { class: 1 }],
    ],
    1,
    2,
  );
  client.commit([['put', BIG, 1, 'big', { class: 1 }]], 2, 3);
  check('client node: an id past 2^31', client.byId(2), client.byId(BIG));
  tree.commit([['write', '/d', file(3)]], BIG, 5);
  check('FS node: after a client id past 2^31', tree.get('/a'), tree.get('/d'));
}

process.stdout.write(JSON.stringify({ cases }));
