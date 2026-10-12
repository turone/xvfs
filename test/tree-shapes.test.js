'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');

// Field representations of the engine's objects after one large number:
// a size or a version past 2^31, an id tree's id past 2^31 beside FS nodes
// (doc/architecture.md, "Node trees"; both
// engines of step A had fields that a full GC before the first object left
// unprotected — the bench saw it, no test did). In a child process with
// --allow-natives-syntax: fixtures/tree-shapes.js.

const FIXTURE = path.join(__dirname, 'fixtures', 'tree-shapes.js');

const run = () =>
  new Promise((resolve, reject) => {
    const args = ['--allow-natives-syntax', '--expose-gc', FIXTURE];
    const options = { encoding: 'utf8', timeout: 55000 };
    execFile(process.execPath, args, options, (err, stdout, stderr) => {
      if (err)
        reject(new Error(`the fixture failed (${err.code}):\n${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  });

describe('tree field representations', () => {
  it('a large size, version or id gives no object a new map', async () => {
    const { cases } = await run();
    assert.ok(cases.length > 0);
    const changed = cases.filter((c) => !c.same).map((c) => c.name);
    assert.deepEqual(changed, [], 'objects whose map changed');
  });
});
