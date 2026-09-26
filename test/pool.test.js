'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../lib/pool.js');

// pool() runs at most `limit` calls at a time. Every call waits for a gate
// the test opens, so what has started is decided by the gates alone.

// Settles once the microtasks queued so far ran.
const turn = () => new Promise((resolve) => setImmediate(resolve));

// How `promise` stands after one turn: `{ value }`, `{ error }` or pending.
const settled = (promise) =>
  Promise.race([
    promise.then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
    turn().then(() => 'pending'),
  ]);

// A pool function over `count` items: records each call and how many run
// at once, then waits for the item's gate.
const gated = (count) => {
  const gates = Array.from({ length: count }, () => Promise.withResolvers());
  const calls = [];
  const started = [];
  let running = 0;
  let peak = 0;
  const fn = async (item, index) => {
    calls.push([item, index]);
    started.push(index);
    peak = Math.max(peak, ++running);
    try {
      await gates[index].promise;
    } finally {
      running--;
    }
  };
  return { gates, calls, started, fn, peak: () => peak };
};

describe('pool', () => {
  it('starts `limit` calls at once, then one more as each settles', async () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const { gates, calls, started, fn, peak } = gated(items.length);
    const done = pool(items, 3, fn);
    assert.deepEqual(started, [0, 1, 2], 'started before pool() returned');
    gates[1].resolve();
    await turn();
    assert.deepEqual(started, [0, 1, 2, 3], 'one settled, one more started');
    gates[0].resolve();
    gates[3].resolve();
    await turn();
    assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
    for (const gate of gates) gate.resolve();
    await done;
    assert.equal(peak(), 3, 'never more than the limit');
    assert.deepEqual(
      calls,
      items.map((item, index) => [item, index]),
      'every item once, in order, with its index',
    );
  });

  it('rejects with the first failure at once and starts nothing after it', async () => {
    const { gates, started, fn } = gated(6);
    const done = pool([0, 1, 2, 3, 4, 5], 3, fn);
    assert.deepEqual(started, [0, 1, 2]);
    const failure = new Error('first');
    gates[1].reject(failure);
    // Like Promise.all: before the calls still running have settled.
    assert.deepEqual(await settled(done), { error: failure });
    assert.deepEqual(started, [0, 1, 2], 'nothing started after it');
    // The calls still running settle unobserved: one that succeeds starts
    // nothing, and a later failure is handled all the same.
    const unhandled = [];
    const record = (err) => unhandled.push(err);
    process.on('unhandledRejection', record);
    try {
      gates[0].resolve();
      gates[2].reject(new Error('second'));
      await turn();
      await turn();
    } finally {
      process.off('unhandledRejection', record);
    }
    assert.deepEqual(started, [0, 1, 2], 'nor after they settled');
    assert.deepEqual(unhandled, [], 'no unhandled rejection');
  });

  it('settles at once on an empty list, without a call', async () => {
    let calls = 0;
    await pool([], 4, () => calls++);
    assert.equal(calls, 0);
  });
});
