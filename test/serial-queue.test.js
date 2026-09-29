'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SerialQueue } = require('../lib/serial-queue.js');
const { within } = require('./helpers.js');

// SerialQueue orders the watcher's epochs: one task at a time, in arrival
// order; a failing task rejects only its own run() and never holds up the
// tasks queued behind it.

const turn = () => new Promise((resolve) => setImmediate(resolve));

describe('SerialQueue', () => {
  it('runs one task at a time, in arrival order', async () => {
    const queue = new SerialQueue();
    const log = [];
    let open;
    const gate = new Promise((resolve) => {
      open = resolve;
    });
    const first = queue.run(async () => {
      log.push('a:start');
      await gate;
      log.push('a:end');
      return 'a';
    });
    const second = queue.run(() => {
      log.push('b');
      return 'b';
    });
    assert.equal(queue.size, 2);
    await turn();
    assert.deepEqual(log, ['a:start'], 'b waits for a');
    open();
    const both = within(Promise.all([first, second]), 'a and b, the gate open');
    assert.deepEqual(await both, ['a', 'b']);
    assert.deepEqual(log, ['a:start', 'a:end', 'b']);
    assert.equal(queue.size, 0);
  });

  it('a failing task rejects its own run and does not hold up the next', async () => {
    const queue = new SerialQueue();
    const thrown = queue.run(() => {
      throw new Error('thrown');
    });
    const rejected = queue.run(async () => {
      throw new Error('rejected');
    });
    const next = queue.run(() => 'next');
    await assert.rejects(within(thrown, 'the throwing task'), /thrown/);
    await assert.rejects(within(rejected, 'the rejecting task'), /rejected/);
    assert.equal(await within(next, 'the task behind them'), 'next');
    await within(queue.idle, 'the queue idle');
    assert.equal(queue.size, 0);
  });

  it('idle settles once every queued task has finished, failed ones too', async () => {
    const queue = new SerialQueue();
    let finished = false;
    queue.run(() => Promise.reject(new Error('x'))).catch(() => {});
    queue.run(async () => {
      await turn();
      finished = true;
    });
    await within(queue.idle, 'the queue idle');
    assert.equal(finished, true);
    assert.equal(queue.size, 0);
    await within(queue.idle, 'an idle queue, at once');
  });
});
