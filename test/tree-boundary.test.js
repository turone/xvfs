'use strict';

// The engine's boundary (doc/architecture.md, "Node trees"): the engine
// imports nothing from the kernel. In a clean process, loading the engine —
// lib/tree.js, or TREE_ENGINE — and the model test's runner pulls in no module
// of lib/ but lib/tree.js and its own lib/tree-*.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', 'lib');

test('the engine and the model test load no kernel module', () => {
  const script = `
    require(${JSON.stringify(path.join(__dirname, 'tree-engine.js'))});
    require(${JSON.stringify(path.join(__dirname, 'tree-run.js'))});
    process.stdout.write(JSON.stringify(Object.keys(require.cache)));
  `;
  const r = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: process.env,
  });
  assert.equal(r.status, 0, r.stderr);
  const loaded = JSON.parse(r.stdout);
  const kernel = loaded.filter((file) => {
    const rel = path.relative(LIB, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    return !/^tree(-[\w-]+)?\.js$/.test(rel);
  });
  assert.deepEqual(
    kernel,
    [],
    `modules of lib/ loaded with the engine: ${kernel.join(', ')}`,
  );
});
