'use strict';

// The tree engine's differential test (doc/architecture.md, "Testing"): random commits
// against the reference model, replicas fed every delta; the runner is
// tree-run.js.
//
//   TREE_SEEDS (40)  TREE_COMMITS (150)  TREE_SEED (one seed)
//   TREE_ONLY=fs,client,policy,walk,aggregates (sections to run)
//   TREE_ENGINE=<module> (default lib/tree.js)

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('./tree-engine.js');
const { runSeed, SECTIONS, COMMITS, SEEDS, ONE } = require('./tree-run.js');

const seeds =
  ONE !== null ? [ONE] : Array.from({ length: SEEDS }, (_, i) => i + 1);

test(`tree engine against the model — ${seeds.length} seed(s) × ${COMMITS} commits [${[...SECTIONS].join(',')}]`, () => {
  for (const seed of seeds) runSeed(seed);
});

test('the engine exports what the spec names', () => {
  assert.equal(typeof engine.createTree, 'function');
  assert.equal(typeof engine.fromSnapshot, 'function');
  assert.equal(typeof engine.Denied, 'function');
  assert.equal(typeof engine.NotFound, 'function');
});
