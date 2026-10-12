'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');

// Retention of the tree engine (doc/architecture.md, "Node trees",
// "Testing"): once fromSnapshot, apply, commit and load
// return, nothing of their input's encoding is reachable from the tree, and
// its strings are its own flat ones. Each check runs
// fixtures/tree-retention.js in a process of its own with --expose-gc, on
// the engine tree-engine.js loads (TREE_ENGINE, else lib/tree.js). The
// thresholds are an order of magnitude above the noise of the measurement
// — ±1 MiB per 10⁴ nodes, ~100 B a node — and below what a kept parent
// costs: a 4 KiB string, a 2000-char name.

const FIXTURE = path.join(__dirname, 'fixtures', 'tree-retention.js');
const NOISE = 100; // B per node
const LIMIT = 10 * NOISE; // B per node, or per query

// The child is stopped before the test's own timeout, so that a hung check
// says so.
const run = (check) =>
  new Promise((resolve, reject) => {
    const args = ['--expose-gc', FIXTURE, check];
    const options = { encoding: 'utf8', timeout: 55000, maxBuffer: 1 << 26 };
    execFile(process.execPath, args, options, (err, stdout, stderr) => {
      if (err) {
        const why = err.killed ? 'timed out' : `failed (${err.code})`;
        reject(new Error(`the fixture ${why} on "${check}":\n${stderr}`));
      } else {
        resolve(JSON.parse(stdout));
      }
    });
  });

const bytes = (x) => `${Math.round(x)} B`;

describe('tree retention', () => {
  // A WeakRef on every object of the input — arrays, typed arrays and their
  // buffers, nested objects; the values the tree keeps as given (meta,
  // scriptOptions, policies) are marked and not counted.
  it('objects: nothing of a snapshot, delta, ops or rows outlives the call', async () => {
    const { cases } = await run('objects');
    assert.ok(cases.length > 0);
    for (const { name, watched } of cases) {
      assert.ok(watched > 0, `${name}: nothing to watch`);
    }
    const kept = cases
      .filter(({ alive }) => alive > 0)
      .map((c) => `${c.name}: ${c.alive} of ${c.watched} alive — ${c.paths}`);
    assert.deepEqual(
      kept,
      [],
      `alive after one turn of the loop and one full GC:\n${kept.join('\n')}`,
    );
  });

  // Strings take no WeakRef: a replica of 10⁴ nodes with 2000-char names
  // loses every node but one, and its heap must drop by a name per node. A
  // name cut from one string of the snapshot or the delta keeps that string
  // through the node that stays.
  it('strings: a name from a snapshot or a delta dies with its node', async () => {
    const result = await run('strings');
    for (const born of ['snapshot', 'delta']) {
      const { freedPerNode, removed } = result[born];
      assert.ok(
        freedPerNode >= result.name,
        `names from a ${born}: ${bytes(freedPerNode)} freed per removed ` +
          `node (${removed} removed), less than one ${result.name}-char ` +
          'name: the names keep what they were cut from',
      );
    }
  });

  // Keys, string ids and names of every length — shorter than 13 chars
  // too — cut from 4 KiB strings, as a key cut from a URL is: a tree that
  // keeps one keeps the whole parent.
  it('keys: keys, ids and names cut from 4 KiB strings cost as flat ones', async () => {
    const { results } = await run('keys');
    assert.equal(results.length, 3);
    for (const { variant, nodes, flat, cut } of results) {
      assert.ok(
        cut - flat < LIMIT,
        `${variant}: ${bytes(cut)} per node from cut strings against ` +
          `${bytes(flat)} from flat ones (${nodes} nodes): the tree keeps ` +
          "the caller's strings",
      );
    }
  });

  // A lookup keeps nothing of its key: get, resolve with either separator,
  // misses of get and of match, 10⁴ of each with its key cut from a 4 KiB
  // string — the heap after them is as before, to the noise. A kept parent
  // costs 4 KiB a query, forty times the bound; an own flat copy of a key
  // (~100 B) lies within the noise and is not told from nothing.
  it('lookups: get, resolve and misses keep nothing of a key cut from 4 KiB', async () => {
    const { results } = await run('lookups');
    assert.equal(results.length, 5);
    for (const { variant, queries, perQuery } of results) {
      assert.ok(
        perQuery < LIMIT,
        `${variant}: ${bytes(perQuery)} per query (${queries} asked): the ` +
          "tree keeps the caller's key",
      );
    }
  });

  // Without a GC: the input of fromSnapshot, apply, commit and load is
  // overwritten with garbage after the call, and the tree must answer as
  // it did — whenever a GC would come, a tree that reads its input later
  // answers from garbage.
  it('spoil: the tree answers as before once its input is overwritten', async () => {
    const { results } = await run('spoil');
    assert.ok(results.length > 0);
    const changed = results
      .filter(({ same }) => !same)
      .map(({ name, error }) =>
        error ? `${name}: threw ${error.split('\n')[0]}` : name,
      );
    assert.deepEqual(
      changed,
      [],
      `the answers changed with the input:\n${changed.join('\n')}`,
    );
  });
});
