'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createTree } = require('../lib/tree.js');
const { Intake } = require('../lib/intake.js');

// The intake of a shared tree (lib/intake.js) over a real tree of
// the engine, with a kernel, a pool, a clock and timers of the test's own:
// every timer runs when the test moves the clock, every immediate when it
// lets the queue drain — nothing waits for real time.

// A clock and timers moved by hand.
const clockOf = () => {
  let now = 1000;
  let order = 0;
  const timers = new Map(); // handle → { at, fn, order }
  let immediates = [];
  return {
    clock: { now: () => now },
    timers: {
      setTimeout(fn, ms) {
        const handle = { id: ++order };
        timers.set(handle, { at: now + ms, fn, order });
        return handle;
      },
      clearTimeout(handle) {
        timers.delete(handle);
      },
      setImmediate(fn) {
        immediates.push(fn);
      },
    },
    // Promise continuations and immediates, until none is left.
    async drain() {
      for (let i = 0; i < 50; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        const due = immediates;
        immediates = [];
        for (const fn of due) fn();
        if (due.length === 0 && i > 3) {
          await new Promise((resolve) => setImmediate(resolve));
          if (immediates.length === 0) return;
        }
      }
    },
    // The clock `ms` on: every timer due by then runs, in its order.
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        await this.drain();
        let next = null;
        for (const [handle, t] of timers) {
          if (t.at > until) continue;
          if (
            next === null ||
            t.at < next[1].at ||
            (t.at === next[1].at && t.order < next[1].order)
          ) {
            next = [handle, t];
          }
        }
        if (next === null) break;
        timers.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].fn();
      }
      now = until;
      await this.drain();
    },
  };
};

// A pool of `capacity` bytes over one segment: what it holds, by extent.
const poolOf = (segments, capacity = 1 << 16) => {
  const sab = new SharedArrayBuffer(capacity);
  segments.set(1, sab);
  let tail = 0;
  const free = []; // [{ offset, length }]
  const held = new Map(); // offset → length
  let waiters = [];
  const pool = {
    used: () => [...held.values()].reduce((a, b) => a + b, 0),
    place: async (bytes) => {
      if (bytes.length === 0) return { segmentId: 0, offset: 0, length: 0 };
      let offset = -1;
      for (let i = 0; i < free.length; i++) {
        if (free[i].length >= bytes.length) {
          offset = free[i].offset;
          free[i] = {
            offset: offset + bytes.length,
            length: free[i].length - bytes.length,
          };
          break;
        }
      }
      if (offset === -1) {
        if (tail + bytes.length > capacity) return null;
        offset = tail;
        tail += bytes.length;
      }
      new Uint8Array(sab, offset, bytes.length).set(bytes);
      held.set(offset, bytes.length);
      return { segmentId: 1, offset, length: bytes.length };
    },
    free: (extent) => {
      if (extent.length === 0) return;
      assert.equal(
        held.get(extent.offset),
        extent.length,
        'freed what it holds',
      );
      held.delete(extent.offset);
      free.push({ offset: extent.offset, length: extent.length });
      const now = waiters;
      waiters = [];
      for (const resolve of now) resolve();
    },
    room: () => new Promise((resolve) => waiters.push(resolve)),
  };
  return pool;
};

// A kernel that publishes at once: its version takes the commits', what
// they dropped or retired goes back to the pool — no reader holds it.
const kernelOf = (pool) => {
  const kernel = {
    v: 0,
    published: [],
    fatals: [],
    version: () => kernel.v,
    publish(results, seq) {
      for (const r of results) {
        for (const e of r.dropped) pool.free(e);
        for (const { rep } of r.retired) {
          pool.free({
            segmentId: rep.segmentId,
            offset: rep.offset,
            length: rep.length,
          });
        }
        if (r.delta !== null && r.version > kernel.v) kernel.v = r.version;
      }
      kernel.published.push(seq);
    },
  };
  kernel.fatal = (err) => kernel.fatals.push(err);
  return kernel;
};

const SETTINGS = {
  ids: 'number',
  seq: 'source',
  window: 10,
  limit: 100,
  gapTimeout: 50,
  spaceTimeout: 30,
  maxFileSize: 1000,
};

const setup = (settings = {}, capacity, handlers = {}) => {
  const segments = new Map();
  const tree = createTree({
    ids: 'number',
    containers: [0],
    segments,
    retireIds: {
      next: (() => {
        let n = 0;
        return () => ++n;
      })(),
    },
  });
  const pool = poolOf(segments, capacity);
  const kernel = kernelOf(pool);
  const time = clockOf();
  const gaps = [];
  const errors = [];
  const intake = new Intake({
    tree,
    kernel,
    pool,
    compress: async () => [],
    clock: time.clock,
    timers: time.timers,
    onGap: (gap) => gaps.push(gap),
    onError: handlers.onError ?? ((err) => errors.push(err)),
    settings: { ...SETTINGS, ...settings },
  });
  // The bytes the tree publishes: what the pool holds, no more.
  const published = () => {
    let sum = 0;
    for (const [node] of tree.walk(tree.get(''), {})) {
      const p = tree.payloadOf(node);
      if (p?.source) sum += p.source.length;
    }
    const root = tree.get('');
    if (root && tree.payloadOf(root)?.source)
      sum += tree.payloadOf(root).source.length;
    return sum;
  };
  return { tree, pool, kernel, time, gaps, errors, intake, published };
};

const put = (id, parentId, name, data, cls = 1) => [
  'put',
  id,
  parentId,
  name,
  data === undefined ? { class: cls } : { class: cls, payload: { data } },
];
const ROOT = { id: 1, parentId: null, name: '', class: 0 };
const text = (tree, id) => {
  const node = tree.byId(id);
  return node ? Buffer.from(tree.payloadOf(node).source.data).toString() : null;
};

describe('intake: numbers, window, parts', () => {
  it('holds before the first load; a load and the batches after it publish', async () => {
    const { tree, kernel, time, intake, pool, published } = setup();
    const early = intake.submit({ seq: 6, ops: [put(10, 1, 'a', 'six')] });
    await time.advance(100);
    assert.equal(kernel.published.length, 0, 'nothing before a load');
    assert.equal(intake.held, true);
    const loaded = intake.load([ROOT], 5);
    await time.advance(0);
    assert.deepEqual(await loaded, { seq: 5 });
    assert.deepEqual(await early, { seq: 6, status: 'committed' });
    assert.deepEqual(kernel.published, [{ from: 5, to: 6, loaded: true }]);
    assert.equal(text(tree, 10), 'six');
    const a = intake.submit({ seq: 7, ops: [put(11, 1, 'b', 'seven')] });
    const b = intake.submit({ seq: 8, ops: [put(10, 1, 'a', 'eight')] });
    await time.advance(9);
    assert.equal(kernel.published.length, 1, 'the window is still open');
    await time.advance(1);
    assert.deepEqual(await a, { seq: 7, status: 'committed' });
    assert.deepEqual(await b, { seq: 8, status: 'committed' });
    assert.deepEqual(kernel.published[1], { from: 7, to: 8, loaded: false });
    assert.equal(text(tree, 10), 'eight');
    assert.equal(intake.last, 8);
    assert.equal(pool.used(), published(), 'the pool holds what is published');
  });

  it('a repeat: of a batch applied at once, of one waiting with it', async () => {
    const { time, intake } = setup();
    await intake.load([ROOT], 0);
    const first = intake.submit({ seq: 1, ops: [put(2, 1, 'a', 'x')] });
    const again = intake.submit({ seq: 1, ops: [put(2, 1, 'a', 'x')] });
    await time.advance(10);
    assert.deepEqual(await first, { seq: 1, status: 'committed' });
    assert.deepEqual(await again, { seq: 1, status: 'duplicate' });
    assert.deepEqual(await intake.submit({ seq: 1, ops: [] }), {
      seq: 1,
      status: 'duplicate',
    });
  });

  it('a part takes as many batches as the limit; a larger batch goes alone', async () => {
    const { kernel, time, intake } = setup({ limit: 3 });
    await intake.load([ROOT], 0);
    const two = (seq, id) => ({
      seq,
      ops: [put(id, 1, `n${id}`, 'x'), put(id + 1, 1, `n${id + 1}`, 'y')],
    });
    const done = [
      intake.submit(two(1, 10)),
      intake.submit(two(2, 20)),
      intake.submit({ seq: 3, ops: [put(30, 1, 'c', 'z')] }),
      intake.submit({
        seq: 4,
        ops: [1, 2, 3, 4, 5].map((i) => put(40 + i, 1, `m${i}`, 'w')),
      }),
    ];
    await time.advance(10);
    await Promise.all(done);
    assert.deepEqual(kernel.published.slice(1), [
      { from: 1, to: 1, loaded: false },
      { from: 2, to: 3, loaded: false },
      { from: 4, to: 4, loaded: false },
    ]);
  });
});

describe('intake: gaps, refusals, room', () => {
  it('a gap is told once, after its timeout; the missing batch fills it', async () => {
    const { tree, kernel, time, intake, gaps } = setup();
    await intake.load([ROOT], 0);
    const later = intake.submit({ seq: 3, ops: [put(3, 1, 'c', 'c')] });
    await time.advance(49);
    assert.deepEqual(gaps, []);
    await time.advance(100);
    assert.deepEqual(gaps, [{ from: 1, to: 2 }], 'once');
    const one = intake.submit({
      seq: 1,
      ops: [put(1, null, '', undefined, 0)],
    });
    const two = intake.submit({ seq: 2, ops: [put(2, 1, 'b', 'b')] });
    await time.advance(10);
    await Promise.all([one, two, later]);
    assert.equal(text(tree, 3), 'c');
    assert.deepEqual(kernel.published.at(-1), {
      from: 1,
      to: 3,
      loaded: false,
    });
  });

  it('a refused batch is told and held with everything after it, until a load', async () => {
    const { tree, kernel, time, intake, errors, pool, published } = setup();
    await intake.load([ROOT], 0);
    const good = intake.submit({ seq: 1, ops: [put(2, 1, 'a', 'a')] });
    const bad = intake.submit({ seq: 2, ops: [put(3, 99, 'b', 'b')] });
    const after = intake.submit({ seq: 3, ops: [put(4, 1, 'c', 'c')] });
    bad.catch(() => {});
    await time.advance(10);
    assert.deepEqual(await good, { seq: 1, status: 'committed' });
    await assert.rejects(bad, (err) => err.code === 'ENOENT' && err.seq === 2);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].seq, 2);
    assert.equal(errors[0].index, 0);
    assert.equal(errors[0].id, 3);
    assert.equal(intake.held, true);
    assert.equal(tree.byId(4), null, 'held');
    assert.equal(pool.used(), published(), 'what it placed went back');
    await intake.load([ROOT, { id: 2, parentId: 1, name: 'a', class: 1 }], 3);
    assert.deepEqual(await after, { seq: 3, status: 'superseded' });
    assert.deepEqual(kernel.published.at(-1), { from: 3, to: 3, loaded: true });
  });

  it('a payload too large is EFBIG; a pool without room waits, then ENOSPC', async () => {
    const { time, intake, errors, pool } = setup({}, 100);
    await intake.load([ROOT], 0);
    const big = intake.submit({
      seq: 1,
      ops: [put(2, 1, 'a', 'x'.repeat(1001))],
    });
    big.catch(() => {});
    await time.advance(10);
    await assert.rejects(big, { code: 'EFBIG' });
    assert.equal(errors.at(-1).code, 'EFBIG');
    await intake.load([ROOT], 1);
    const fill = intake.submit({
      seq: 2,
      ops: [put(2, 1, 'a', 'y'.repeat(80))],
    });
    await time.advance(10);
    await fill;
    // 80 of 100 held: 40 more wait for room. Freed by someone else in
    // time, it comes; else the batch is ENOSPC — what would free the room
    // is a later batch, and order is kept.
    const other = await pool.place(Buffer.alloc(20));
    const comes = intake.submit({
      seq: 3,
      ops: [put(3, 1, 'b', 'z'.repeat(20))],
    });
    await time.advance(10);
    await time.advance(10);
    pool.free(other);
    await time.advance(0);
    assert.deepEqual(await comes, { seq: 3, status: 'committed' });
    const waits = intake.submit({
      seq: 4,
      ops: [put(4, 1, 'c', 'w'.repeat(40))],
    });
    const frees = intake.submit({ seq: 5, ops: [['remove', 2]] });
    const refused = assert.rejects(waits, { code: 'ENOSPC' });
    frees.catch(() => {});
    await time.advance(10);
    await time.advance(40);
    await refused;
    assert.equal(errors.at(-1).code, 'ENOSPC');
    assert.equal(errors.at(-1).seq, 4);
    assert.ok(pool.used() <= 100);
  });
});

describe('intake: what a part and a load go through', () => {
  it('a refused payload stops its part there: the batches before it publish', async () => {
    const { tree, kernel, time, intake, errors } = setup();
    await intake.load([ROOT], 0);
    const one = intake.submit({ seq: 1, ops: [put(2, 1, 'a', 'a')] });
    const big = intake.submit({
      seq: 2,
      ops: [put(3, 1, 'b', 'x'.repeat(1001))],
    });
    const three = intake.submit({ seq: 3, ops: [put(4, 1, 'c', 'c')] });
    const refused = assert.rejects(big, (err) => {
      return err.code === 'EFBIG' && err.seq === 2 && err.index === 0;
    });
    await time.advance(10);
    assert.deepEqual(await one, { seq: 1, status: 'committed' });
    await refused;
    assert.equal(errors.length, 1);
    assert.equal(errors[0].name, 'Error', 'a refusal names no node by name');
    assert.equal(errors[0].id, 3);
    assert.equal(text(tree, 2), 'a');
    assert.deepEqual(kernel.published.at(-1), {
      from: 1,
      to: 1,
      loaded: false,
    });
    assert.equal(intake.held, true);
    await intake.load([ROOT], 3);
    assert.deepEqual(await three, { seq: 3, status: 'superseded' });
  });

  it('a batch that finds no room waits until the batches before it published', async () => {
    const { tree, kernel, time, intake } = setup({}, 100);
    const a = { id: 2, parentId: 1, name: 'a', class: 1 };
    await intake.load([ROOT, { ...a, payload: { data: 'a'.repeat(40) } }], 0);
    // 40 of 100 held: the new /a takes 40 more, and /b finds no room until
    // the old /a, which the batch of /a retires, is given back.
    const one = intake.submit({
      seq: 1,
      ops: [put(2, 1, 'a', 'b'.repeat(40))],
    });
    const two = intake.submit({
      seq: 2,
      ops: [put(3, 1, 'b', 'c'.repeat(40))],
    });
    await time.advance(10);
    assert.deepEqual(await one, { seq: 1, status: 'committed' });
    assert.deepEqual(await two, { seq: 2, status: 'committed' });
    assert.equal(text(tree, 3), 'c'.repeat(40));
    assert.deepEqual(kernel.published.slice(1), [
      { from: 1, to: 1, loaded: false },
      { from: 2, to: 2, loaded: false },
    ]);
  });

  it('a batch a load leaves behind while it waits for room is superseded', async () => {
    const { tree, time, intake, pool } = setup({}, 100);
    const other = await pool.place(Buffer.alloc(80));
    const a = { id: 2, parentId: 1, name: 'a', class: 1 };
    const loaded = intake.load(
      [ROOT, { ...a, payload: { data: 'a'.repeat(40) } }],
      5,
    );
    await time.advance(5);
    const three = intake.submit({ seq: 3, ops: [put(3, 1, 'c', 'c')] });
    const six = intake.submit({ seq: 6, ops: [put(6, 1, 'f', 'f')] });
    pool.free(other);
    await time.advance(10);
    assert.deepEqual(await loaded, { seq: 5 });
    assert.deepEqual(await three, { seq: 3, status: 'superseded' });
    assert.deepEqual(await six, { seq: 6, status: 'committed' });
    assert.equal(tree.byId(3), null);
    assert.equal(text(tree, 6), 'f');
  });

  it("a load that fails leaves the tree as it was; in 'source' mode the batches go on", async () => {
    const { tree, time, intake } = setup();
    await intake.load([ROOT], 0);
    const one = intake.submit({ seq: 1, ops: [put(2, 1, 'a', 'a')] });
    const big = { id: 9, parentId: 1, name: 'z', class: 1 };
    big.payload = { data: 'x'.repeat(1001) };
    await assert.rejects(intake.load([ROOT, big], 5), (err) => {
      return (
        err.code === 'EFBIG' && err.seq === 5 && err.index === 1 && err.id === 9
      );
    });
    await time.advance(10);
    assert.deepEqual(await one, { seq: 1, status: 'committed' });
    assert.equal(text(tree, 2), 'a');
    assert.equal(intake.held, false);
  });
});

describe("intake: 'intake' numbers, close, format", () => {
  it('the batches submitted after a load wait for it, and go after it', async () => {
    const { tree, kernel, time, intake } = setup({ seq: 'intake' });
    const a = intake.submit({ ops: [put(1, null, '', undefined, 0)] });
    const b = intake.submit({ ops: [put(2, 1, 'a', 'a')] });
    await time.advance(10);
    await Promise.all([a, b]);
    const node = { id: 2, parentId: 1, name: 'a', class: 1 };
    const loaded = intake.load([ROOT, node]);
    const e = intake.submit({ ops: [put(5, 1, 'e', 'e')] });
    await time.advance(10);
    assert.deepEqual(await loaded, { seq: 0 });
    assert.deepEqual(await e, { seq: 1, status: 'committed' });
    assert.equal(text(tree, 5), 'e');
    assert.deepEqual(kernel.published.at(-1), {
      from: 0,
      to: 1,
      loaded: true,
    });
  });

  it('of two loads, each takes the batches submitted after it', async () => {
    const { tree, kernel, time, intake } = setup({ seq: 'intake' });
    await intake.load([ROOT]);
    const a = { id: 2, parentId: 1, name: 'a', class: 1 };
    const b = { id: 4, parentId: 1, name: 'b', class: 1 };
    const first = intake.load([ROOT, a]);
    const x = intake.submit({ ops: [put(3, 1, 'x', 'x')] });
    const second = intake.load([ROOT, b]);
    const y = intake.submit({ ops: [put(5, 1, 'y', 'y')] });
    await time.advance(10);
    await Promise.all([first, second]);
    assert.deepEqual(await x, { seq: 1, status: 'superseded' });
    assert.deepEqual(await y, { seq: 1, status: 'committed' });
    assert.equal(tree.byId(2), null, 'the second load is the state');
    assert.equal(tree.byId(3), null);
    assert.ok(tree.byId(4));
    assert.equal(text(tree, 5), 'y');
    assert.deepEqual(kernel.published.slice(-2), [
      { from: 0, to: 0, loaded: true },
      { from: 0, to: 1, loaded: true },
    ]);
  });

  it("a load that fails in 'intake' mode holds the batches after it until a load", async () => {
    const { tree, kernel, time, intake } = setup({ seq: 'intake' });
    await intake.load([ROOT]);
    const big = { id: 9, parentId: 1, name: 'z', class: 1 };
    big.payload = { data: 'x'.repeat(1001) };
    const failed = intake.load([ROOT, big]);
    const x = intake.submit({ ops: [put(3, 1, 'x', 'x')] });
    await assert.rejects(failed, { code: 'EFBIG' });
    await time.advance(10);
    const published = kernel.published.length;
    assert.equal(intake.held, true);
    assert.equal(tree.byId(3), null);
    await intake.load([ROOT]);
    assert.deepEqual(await x, { seq: 1, status: 'superseded' });
    assert.equal(kernel.published.length, published + 1);
  });

  it('close() rejects the batches a load not run yet took for its own', async () => {
    const { intake, pool } = setup({ seq: 'intake' });
    const a = intake.submit({ ops: [put(1, null, '', 'r', 0)] });
    const loaded = intake.load([ROOT]);
    intake.close();
    await assert.rejects(a, { code: 'ERR_VFS_CLOSED' });
    await assert.rejects(loaded, { code: 'ERR_VFS_CLOSED' });
    assert.equal(pool.used(), 0);
  });

  it('numbers its batches as they come; a load starts them again', async () => {
    const { kernel, time, intake } = setup({ seq: 'intake' });
    assert.equal(intake.held, false);
    const a = intake.submit({ ops: [put(1, null, '', undefined, 0)] });
    const b = intake.submit({ ops: [put(2, 1, 'a', 'a')] });
    await time.advance(10);
    assert.deepEqual(await a, { seq: 1, status: 'committed' });
    assert.deepEqual(await b, { seq: 2, status: 'committed' });
    const c = intake.submit({ ops: [put(3, 1, 'b', 'b')] });
    const loaded = intake.load([ROOT]);
    await time.advance(10);
    assert.deepEqual(await loaded, { seq: 0 });
    assert.deepEqual(await c, { seq: 3, status: 'superseded' });
    const d = intake.submit({ ops: [put(4, 1, 'd', 'd')] });
    await time.advance(10);
    assert.deepEqual(await d, { seq: 1, status: 'committed' });
    assert.deepEqual(kernel.published.at(-1), {
      from: 1,
      to: 1,
      loaded: false,
    });
    assert.throws(() => intake.submit({ seq: 5, ops: [] }), { code: 'EINVAL' });
  });

  it('close() rejects what waits and gives back what it placed', async () => {
    const { time, intake, pool } = setup();
    await intake.load([ROOT], 0);
    const waiting = intake.submit({ seq: 2, ops: [put(3, 1, 'c', 'c')] });
    intake.close();
    await assert.rejects(waiting, { code: 'ERR_VFS_CLOSED' });
    await assert.rejects(intake.submit({ seq: 3, ops: [] }), {
      code: 'ERR_VFS_CLOSED',
    });
    await time.advance(100);
    assert.equal(pool.used(), 0);
  });

  it('refuses a batch of a wrong form at once; a load older than the tree is ESTALE', async () => {
    const { intake } = setup();
    for (const batch of [
      null,
      { seq: -1, ops: [] },
      { seq: 1.5, ops: [] },
      { seq: 1, ops: 'x' },
      { seq: 1, ops: [['move', 1]] },
      { seq: 1, ops: [put('1', null, '', undefined)] },
      { seq: 1, ops: [put(1, null, 'x', undefined)] },
      {
        seq: 1,
        ops: [
          ['remove', 1],
          ['remove', 1],
        ],
      },
      { seq: 1, ops: [['put', 2, 1, 'a', { payload: { data: 1 } }]] },
    ]) {
      assert.throws(
        () => intake.submit(batch),
        { code: 'EINVAL' },
        JSON.stringify(batch),
      );
    }
    await intake.load([ROOT], 5);
    await assert.rejects(intake.load([ROOT], 4), { code: 'ESTALE' });
  });
});

describe('intake: what the client gives it, and what fails after a commit', () => {
  it('a batch is its own once taken: copied, cloned, frozen; what does not clone is EINVAL at once', async () => {
    const { tree, time, intake, pool, published } = setup();
    await intake.load([ROOT], 0);
    const policy = { role: 'admin', tags: ['a'] };
    const meta = { title: 'A' };
    const data = Buffer.from('aaaa');
    const fields = { class: 1, policy, payload: { data, meta } };
    const ops = [['put', 2, 1, 'a', fields]];
    const done = intake.submit({ seq: 1, ops });
    // What the client does to its own after changes nothing.
    data.fill(0x7a);
    policy.role = 'guest';
    policy.tags.push('b');
    meta.title = 'B';
    fields.payload = null;
    ops.push(['nonsense']);
    await time.advance(10);
    assert.deepEqual(await done, { seq: 1, status: 'committed' });
    const node = tree.byId(2);
    assert.equal(text(tree, 2), 'aaaa');
    const kept = tree.policyOf(node);
    assert.deepEqual(kept, { role: 'admin', tags: ['a'] });
    assert.ok(Object.isFrozen(kept) && Object.isFrozen(kept.tags));
    assert.deepEqual(tree.payloadOf(node).extras.meta, { title: 'A' });
    assert.ok(Object.isFrozen(tree.payloadOf(node).extras.meta));
    const wrong = [
      { class: 1, policy: () => true },
      { class: 1, payload: { data: 'x', meta: { f() {} } } },
      { class: 1, payload: { data: 'x', scriptOptions: { s: Symbol('s') } } },
    ];
    for (const bad of wrong) {
      assert.throws(
        () => intake.submit({ seq: 2, ops: [['put', 3, 1, 'b', bad]] }),
        (err) => err.code === 'EINVAL' && err.index === 0 && err.id === 3,
      );
    }
    const row = { id: 3, parentId: 1, name: 'b', class: 1, policy: () => 1 };
    assert.throws(() => intake.load([ROOT, row], 5), {
      code: 'EINVAL',
      index: 1,
      id: 3,
    });
    assert.equal(intake.waiting, 0);
    assert.equal(pool.used(), published());
  });

  it('a refusal of a load is told, with its number and the id of its row', async () => {
    const { intake, errors } = setup();
    await intake.load([ROOT], 0);
    const big = { id: 9, parentId: 1, name: 'z', class: 1 };
    big.payload = { data: 'x'.repeat(1001) };
    await assert.rejects(intake.load([ROOT, big], 5), { code: 'EFBIG' });
    const orphan = { id: 4, parentId: 77, name: 'o', class: 1 };
    await assert.rejects(intake.load([ROOT, orphan], 6), { code: 'ENOENT' });
    await intake.load([ROOT], 10);
    await assert.rejects(intake.load([ROOT], 8), { code: 'ESTALE' });
    assert.deepEqual(
      errors.map(({ code, seq, index, id }) => ({ code, seq, index, id })),
      [
        { code: 'EFBIG', seq: 5, index: 1, id: 9 },
        { code: 'ENOENT', seq: 6, index: 1, id: 4 },
        { code: 'ESTALE', seq: 8, index: undefined, id: undefined },
      ],
    );
  });

  it('a refused batch is told once the batches before it published', async () => {
    const told = [];
    const ctx = setup({}, undefined, {
      onError: (err) => told.push([err.seq, ctx.kernel.published.length]),
    });
    await ctx.intake.load([ROOT], 0);
    const one = ctx.intake.submit({ seq: 1, ops: [put(2, 1, 'a', 'a')] });
    const bad = ctx.intake.submit({ seq: 2, ops: [put(3, 99, 'b', 'b')] });
    bad.catch(() => {});
    await ctx.time.advance(10);
    await one;
    assert.deepEqual(told, [[2, 2]], 'the load and batch 1 published first');
  });

  it('a publication the kernel cannot make rejects every batch of it; the kernel hears it', async () => {
    const { kernel, time, intake } = setup({ seq: 'intake' });
    await intake.load([ROOT]);
    const cannot = new Error('no publication');
    kernel.publish = () => {
      throw cannot;
    };
    const a = intake.submit({ ops: [put(2, 1, 'a', 'a')] });
    const b = intake.submit({ ops: [put(3, 1, 'b', 'b')] });
    const rejected = Promise.all([
      assert.rejects(a, (err) => err === cannot),
      assert.rejects(b, (err) => err === cannot),
    ]);
    await time.advance(10);
    await rejected;
    assert.deepEqual(kernel.fatals, [cannot]);
    const waiting = intake.submit({ ops: [put(4, 1, 'c', 'c')] });
    const loading = intake.load([ROOT]);
    await assert.rejects(loading, (err) => err === cannot);
    await assert.rejects(waiting, (err) => err === cannot);
    assert.equal(kernel.fatals.length, 2);
  });
});
