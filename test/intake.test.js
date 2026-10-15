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

// `extra.compress`: the intake's compress, none by default.
const setup = (settings = {}, capacity, handlers = {}, extra = {}) => {
  const segments = new Map();
  const languages = settings.languages?.length ?? 0;
  const tree = createTree({
    ids: 'number',
    containers: [0],
    segments,
    ...(languages > 1 ? { languages } : {}),
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
    compress: extra.compress ?? (async () => []),
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

describe('intake: languages and pages', () => {
  const LANGS = { languages: ['en', 'uk', 'de'] };
  // The text of a node's data, or its page (kind 1), in a language.
  const textIn = (tree, id, lang = 0, kind = 'source') => {
    const node = tree.byId(id);
    const p = node === null ? null : tree.payloadOf(node, lang);
    const rep = kind === 'source' ? p?.source : p?.others?.requireBytecode;
    return rep ? Buffer.from(rep.data).toString() : null;
  };
  const pageIn = (tree, id, lang = 0) => textIn(tree, id, lang, 'page');
  // Every byte the tree publishes, in every language: what the pool holds.
  const held = (tree) => {
    let sum = 0;
    const count = Math.max(1, tree.languages);
    const root = tree.get('');
    if (root === null) return 0;
    const nodes = [root];
    for (const [n] of tree.walk(root)) nodes.push(n);
    for (const n of nodes) {
      for (let lang = 0; lang < count; lang++) {
        const p = tree.payloadOf(n, lang);
        if (p === null) continue;
        if (p.source) sum += p.source.length;
        for (const rep of Object.values(p.others ?? {})) {
          if (rep) sum += rep.length;
        }
      }
    }
    return sum;
  };
  const about = (fields) => ['put', 2, 1, 'about', { class: 1, ...fields }];
  const row = (id, name, data) => ({
    id,
    parentId: 1,
    name,
    class: 1,
    payload: { data },
  });

  it('a put states its languages: names, data and pages there; a page beside new data in its payload', async () => {
    const { tree, time, intake, pool } = setup(LANGS);
    await intake.load([ROOT], 0);
    const done = intake.submit({
      seq: 1,
      ops: [
        about({
          payload: { data: 'en-data' },
          rendered: '<en>',
          translations: {
            uk: { name: 'pro', payload: { data: 'uk-data' }, rendered: '<uk>' },
            de: { name: 'uber' },
          },
        }),
      ],
    });
    await time.advance(10);
    assert.deepEqual(await done, { seq: 1, status: 'committed' });
    const node = tree.byId(2);
    assert.deepEqual(tree.pathsOf(node), ['/about', '/pro', '/uber']);
    assert.equal(textIn(tree, 2), 'en-data');
    assert.equal(pageIn(tree, 2), '<en>');
    assert.equal(textIn(tree, 2, 1), 'uk-data');
    assert.equal(pageIn(tree, 2, 1), '<uk>');
    assert.equal(tree.payloadOf(node, 2), null, 'de: a name, no data');
    // One language's change carries its own bytes only; the others stay.
    const en = tree.payloadOf(node);
    const again = intake.submit({
      seq: 2,
      ops: [about({ translations: { uk: { payload: { data: 'uk-2' } } } })],
    });
    await time.advance(10);
    await again;
    assert.equal(tree.payloadOf(node), en, 'the main payload the same object');
    assert.equal(textIn(tree, 2, 1), 'uk-2');
    assert.equal(pageIn(tree, 2, 1), null, 'new data without its page');
    assert.equal(pool.used(), held(tree));
  });

  it("rendered alone renders again: the data the same object, the version the publication's; null and new data take the page away", async () => {
    const { tree, kernel, time, intake, pool } = setup();
    await intake.load([ROOT], 0);
    const step = async (seq, fields) => {
      const done = intake.submit({ seq, ops: [about(fields)] });
      await time.advance(10);
      return done;
    };
    await step(1, { payload: { data: 'data', mtimeMs: 7 } });
    const first = tree.payloadOf(tree.byId(2));
    await step(2, { rendered: '<p>one</p>' });
    const second = tree.payloadOf(tree.byId(2));
    assert.equal(second.source, first.source);
    assert.equal(second.mtimeMs, 7);
    assert.equal(second.version, kernel.v);
    assert.equal(pageIn(tree, 2), '<p>one</p>');
    await step(3, { rendered: null });
    assert.equal(pageIn(tree, 2), null);
    assert.equal(tree.payloadOf(tree.byId(2)).source, first.source);
    const version = kernel.v;
    await step(4, { rendered: null });
    assert.equal(kernel.v, version, 'no page where there was none: nothing');
    await step(5, { rendered: '<p>two</p>' });
    await step(6, { payload: { data: 'new' } });
    assert.equal(pageIn(tree, 2), null, 'new data without its page');
    assert.equal(textIn(tree, 2), 'new');
    assert.equal(pool.used(), held(tree));
  });

  it('compress takes the page, never the data; a form without room is left out', async () => {
    const seen = [];
    const compress = async (bytes) => {
      seen.push(Buffer.from(bytes).toString());
      return [
        [3, Buffer.from('gz')],
        [5, Buffer.alloc(1 << 20)],
      ];
    };
    const { tree, time, intake, pool } = setup({}, 1 << 16, {}, { compress });
    await intake.load([ROOT], 0);
    const done = intake.submit({
      seq: 1,
      ops: [about({ payload: { data: 'the data' }, rendered: '<page>' })],
    });
    await time.advance(10);
    await done;
    assert.deepEqual(seen, ['<page>']);
    const p = tree.payloadOf(tree.byId(2));
    assert.equal(Buffer.from(p.others.gzip.data).toString(), 'gz');
    assert.equal(p.others.br, null, 'no room for it');
    assert.equal(pool.used(), held(tree));
  });

  it('a row states its whole node: what it lacks is none', async () => {
    const { tree, intake, pool } = setup(LANGS);
    const full = {
      id: 2,
      parentId: 1,
      name: 'a',
      class: 1,
      payload: { data: 'a' },
      rendered: '<a>',
      policy: { p: 1 },
      translations: { uk: { name: 'a-uk', payload: { data: 'b' } } },
    };
    await intake.load([ROOT, full], 0);
    assert.equal(pageIn(tree, 2), '<a>');
    assert.equal(textIn(tree, 2, 1), 'b');
    await intake.load([ROOT, { id: 2, parentId: 1, name: 'a' }], 1);
    const node = tree.byId(2);
    assert.equal(tree.payloadOf(node), null);
    assert.equal(tree.policyOf(node), null);
    assert.equal(tree.nameOf(node, 1), null, 'no translation');
    assert.equal(tree.classOf(node), 1, 'its class kept');
    // A translation of a row has its name, but the root's.
    assert.throws(
      () =>
        intake.load(
          [ROOT, { ...full, translations: { uk: { payload: null } } }],
          2,
        ),
      { code: 'EINVAL', index: 1, id: 2, lang: 'uk' },
    );
    await intake.load(
      [{ ...ROOT, translations: { uk: { payload: { data: 'root' } } } }],
      3,
    );
    assert.equal(textIn(tree, 1, 1), 'root');
    assert.equal(pool.used(), held(tree));
  });

  it('refuses at once, with the language, a field no one reads, a language the tree has not, a name not one', async () => {
    const one = setup();
    const many = setup(LANGS);
    for (const [ctx, fields, lang] of [
      [one, { translations: { uk: { name: 'x' } } }, undefined],
      [one, { rendered: 7 }, undefined],
      [one, { payload: { data: 'x', scriptOptions: {} } }, undefined],
      [one, { page: [] }, undefined],
      [many, { payload: { data: 'x', meta: {}, extra: 1 } }, 'en'],
      [many, { translations: { en: { name: 'x' } } }, 'en'],
      [many, { translations: { fr: { name: 'x' } } }, 'fr'],
      [many, { translations: { uk: { name: 'a/b' } } }, 'uk'],
      [many, { translations: { uk: { title: 'x' } } }, 'uk'],
      [many, { translations: { uk: { rendered: 1 } } }, 'uk'],
      [many, { translations: [['uk', {}]] }, undefined],
      // A page beside no data: two things at once, in the put itself.
      [one, { payload: null, rendered: '<p>' }, undefined],
      [many, { payload: null, rendered: '<p>' }, 'en'],
      [
        many,
        { translations: { uk: { name: 'u', payload: null, rendered: '<p>' } } },
        'uk',
      ],
    ]) {
      assert.throws(
        () => ctx.intake.submit({ seq: 1, ops: [about(fields)] }),
        (err) =>
          err.code === 'EINVAL' &&
          err.index === 0 &&
          err.id === 2 &&
          err.lang === lang,
        JSON.stringify(fields),
      );
    }
    assert.throws(
      () =>
        many.intake.submit({
          seq: 1,
          ops: [['put', 1, null, '', { translations: { uk: { name: 'r' } } }]],
        }),
      { code: 'EINVAL', lang: 'uk' },
    );
    // A row states its node: a page without its data is no state.
    const row = { id: 2, parentId: 1, name: 'a', class: 1, rendered: '<p>' };
    assert.throws(() => one.intake.load([ROOT, row], 1), {
      code: 'EINVAL',
      index: 1,
      id: 2,
    });
    const uk = { name: 'u', rendered: '<p>' };
    assert.throws(
      () =>
        many.intake.load(
          [ROOT, { ...row, rendered: null, translations: { uk } }],
          1,
        ),
      { code: 'EINVAL', index: 1, lang: 'uk' },
    );
    // Rendered alone keeps the data: a final state's to refuse, not a form.
    const alone = one.intake.submit({
      seq: 9,
      ops: [about({ rendered: 'x' })],
    });
    alone.catch(() => {});
  });

  it('a page or data too large is EFBIG, a page without data ENOENT — with its language', async () => {
    const { time, intake, errors } = setup(LANGS);
    const bare = { id: 2, parentId: 1, name: 'a', class: 1 };
    await intake.load([ROOT, bare], 0);
    const big = 'x'.repeat(1001);
    const refused = intake.submit({
      seq: 1,
      ops: [
        [
          'put',
          2,
          1,
          'a',
          { translations: { de: { name: 'd', rendered: big } } },
        ],
      ],
    });
    refused.catch(() => {});
    await time.advance(10);
    await assert.rejects(refused, { code: 'EFBIG', seq: 1, lang: 'de' });
    await intake.load([ROOT, bare], 1);
    const orphan = intake.submit({
      seq: 2,
      ops: [['put', 2, 1, 'a', { rendered: '<p>' }]],
    });
    orphan.catch(() => {});
    await time.advance(10);
    await assert.rejects(orphan, { code: 'ENOENT', seq: 2, lang: 'en' });
    assert.deepEqual(
      errors.map((e) => [e.code, e.lang]),
      [
        ['EFBIG', 'de'],
        ['ENOENT', 'en'],
      ],
    );
  });

  it('cache: outside the numbering, alone, the version of its payload; the latest per node and language counts', async () => {
    const { tree, kernel, time, intake, pool, errors } = setup(LANGS);
    await intake.load(
      [
        ROOT,
        {
          id: 2,
          parentId: 1,
          name: 'a',
          class: 1,
          payload: { data: 'd' },
          translations: { uk: { name: 'a-uk', payload: { data: 'u' } } },
        },
      ],
      0,
    );
    const v = (lang) => tree.payloadOf(tree.byId(2), lang).version;
    const v0 = v(0);
    const cached = intake.cache({ id: 2, data: '<one>', version: v0 });
    const stale = intake.cache({ id: 2, lang: 'uk', data: '<u>', version: 99 });
    await time.advance(10);
    assert.deepEqual(await cached, { status: 'cached' });
    assert.deepEqual(await stale, { status: 'stale' });
    assert.deepEqual(kernel.published.at(-1), {
      from: null,
      to: null,
      loaded: false,
    });
    assert.equal(intake.last, 0, 'no number moved');
    assert.equal(pageIn(tree, 2), '<one>');
    assert.notEqual(v(0), v0, 'a page takes a version');
    // Two of one node and language: the earlier is stale at once.
    const early = intake.cache({ id: 2, data: '<two>', version: v(0) });
    const late = intake.cache({ id: 2, data: '<three>', version: v(0) });
    assert.deepEqual(await early, { status: 'stale' });
    await time.advance(10);
    assert.deepEqual(await late, { status: 'cached' });
    assert.equal(pageIn(tree, 2), '<three>');
    // An uncache after a cache takes its place, and a cache after an
    // uncache its.
    const before = intake.cache({
      id: 2,
      lang: 'uk',
      data: '<x>',
      version: v(1),
    });
    const drop = intake.uncache({ id: 2, lang: 'uk' });
    const takes = intake.uncache({ id: 2, lang: 'en' });
    const after = intake.cache({ id: 2, data: '<four>', version: v(0) });
    await time.advance(10);
    assert.deepEqual(await before, { status: 'stale' });
    assert.deepEqual(await drop, { dropped: 0 }, 'uk had no page');
    assert.deepEqual(await takes, { dropped: 0 });
    assert.deepEqual(await after, { status: 'cached' });
    assert.equal(pageIn(tree, 2), '<four>');
    // Nothing to drop: no publication.
    const count = kernel.published.length;
    const none = intake.uncache({ id: 2, lang: 'uk' });
    await time.advance(10);
    assert.deepEqual(await none, { dropped: 0 });
    assert.equal(kernel.published.length, count);
    // A page dropped: published.
    const dropped = intake.uncache({ id: 2 });
    await time.advance(10);
    assert.deepEqual(await dropped, { dropped: 1 });
    assert.equal(pageIn(tree, 2), null);
    assert.deepEqual(errors, [], 'no page op is told');
    assert.equal(pool.used(), held(tree));
  });

  it('page ops wait for no hold, no gap, no first load; for a load in flight they do', async () => {
    const { tree, time, intake, pool } = setup();
    // Before the first load the tree is empty: stale, dropped nothing.
    const early = intake.cache({ id: 2, data: '<p>', version: 0 });
    const none = intake.uncache({ id: 2 });
    await time.advance(10);
    assert.deepEqual(await early, { status: 'stale' });
    assert.deepEqual(await none, { dropped: 0 });
    await intake.load([ROOT, row(2, 'a', 'a')], 0);
    // A refusal holds the batches: pages go on.
    const refused = intake.submit({ seq: 1, ops: [put(3, 99, 'x', 'x')] });
    refused.catch(() => {});
    await time.advance(10);
    assert.equal(intake.held, true);
    const v = tree.payloadOf(tree.byId(2)).version;
    const whileHeld = intake.cache({ id: 2, data: '<held>', version: v });
    await time.advance(10);
    assert.deepEqual(await whileHeld, { status: 'cached' });
    // A load in flight: the page op waits for it and is checked after —
    // its data changed, so did the version.
    const loading = intake.load([ROOT, row(2, 'a', 'b')], 5);
    const after = intake.cache({
      id: 2,
      data: '<after>',
      version: tree.payloadOf(tree.byId(2)).version,
    });
    await time.advance(10);
    await loading;
    assert.deepEqual(await after, { status: 'stale' });
    assert.equal(pageIn(tree, 2), null, 'the load stated no page');
    assert.equal(pool.used(), held(tree));
  });

  it('page ops count in the limit of a part; an uncache of a subtree is one, in every language', async () => {
    const { tree, kernel, time, intake, pool } = setup({ ...LANGS, limit: 2 });
    const rows = [ROOT];
    for (const id of [2, 3, 4]) {
      rows.push({
        id,
        parentId: id === 4 ? 3 : 1,
        name: `n${id}`,
        class: 1,
        payload: { data: `d${id}` },
        rendered: `<${id}>`,
        translations: {
          uk: { name: `u${id}`, payload: { data: 'u' }, rendered: '<u>' },
        },
      });
    }
    await intake.load(rows, 0);
    const before = kernel.published.length;
    const batch = intake.submit({
      seq: 1,
      ops: [put(5, 1, 'x', 'x'), put(6, 1, 'y', 'y')],
    });
    const whole = intake.uncache({ id: 3, subtree: true });
    await time.advance(10);
    await batch;
    assert.deepEqual(await whole, { dropped: 4 }, '3 and 4, en and uk');
    assert.deepEqual(
      kernel.published.slice(before),
      [
        { from: 1, to: 1, loaded: false },
        { from: null, to: null, loaded: false },
      ],
      'the part was full: the pages published after it',
    );
    assert.equal(pageIn(tree, 4, 1), null);
    assert.equal(pageIn(tree, 2), '<2>', 'outside the subtree');
    assert.equal(pool.used(), held(tree));
  });

  it('close() rejects the page ops waiting; EFBIG at once, ENOSPC without waiting', async () => {
    const { tree, time, intake, pool } = setup({}, 64);
    await intake.load([ROOT, row(2, 'a', 'a')], 0);
    const v = tree.payloadOf(tree.byId(2)).version;
    await assert.rejects(
      intake.cache({ id: 2, data: 'x'.repeat(1001), version: v }),
      { code: 'EFBIG', id: 2 },
    );
    const full = intake.cache({ id: 2, data: 'x'.repeat(100), version: v });
    const noRoom = assert.rejects(full, { code: 'ENOSPC', id: 2 });
    await time.advance(10);
    await noRoom;
    // A language a tree of one has not: EINVAL at once.
    assert.throws(
      () => intake.cache({ id: 2, lang: 'uk', data: 'x', version: 1 }),
      { code: 'EINVAL' },
    );
    const waiting = intake.cache({ id: 2, data: '<p>', version: v });
    const dropping = intake.uncache({ id: 2 });
    const closed = Promise.all([
      assert.rejects(waiting, { code: 'ERR_VFS_CLOSED' }),
      assert.rejects(dropping, { code: 'ERR_VFS_CLOSED' }),
    ]);
    intake.close();
    await closed;
    await time.advance(10);
    assert.equal(pool.used(), held(tree));
  });
});

describe('intake: page ops at their edges', () => {
  const pageRow = (id, parentId, name, data, rendered) => ({
    id,
    parentId,
    name,
    class: 1,
    payload: { data },
    rendered,
  });
  const pageOf = (tree, id) => {
    const p = tree.payloadOf(tree.byId(id));
    const rep = p?.others?.requireBytecode;
    return rep ? Buffer.from(rep.data).toString() : null;
  };
  const held = (tree) => {
    let sum = 0;
    const root = tree.get('');
    const nodes = [root];
    for (const [n] of tree.walk(root)) nodes.push(n);
    for (const n of nodes) {
      const p = tree.payloadOf(n);
      if (p === null) continue;
      if (p.source) sum += p.source.length;
      for (const rep of Object.values(p.others ?? {}))
        if (rep) sum += rep.length;
    }
    return sum;
  };
  const outcome = (p) =>
    p.then(
      (v) => v,
      (e) => ({ error: e.code }),
    );

  it('a cache and an uncache of one page on two sides of the limit keep the order of their calls', async () => {
    const { tree, kernel, time, intake, pool } = setup({ limit: 3 });
    await intake.load([ROOT, pageRow(2, 1, 'a', 'a', '<old>')], 0);
    const before = kernel.published.length;
    const v = tree.payloadOf(tree.byId(2)).version;
    // The batch and the cache fill the part; the uncache goes after.
    const batch = intake.submit({
      seq: 1,
      ops: [put(3, 1, 'x', 'x'), put(4, 1, 'y', 'y')],
    });
    const cached = intake.cache({ id: 2, data: '<new>', version: v });
    const dropped = intake.uncache({ id: 2 });
    await time.advance(20);
    assert.deepEqual(await batch, { seq: 1, status: 'committed' });
    assert.deepEqual(await cached, { status: 'cached' });
    assert.deepEqual(await dropped, { dropped: 1 });
    assert.deepEqual(kernel.published.slice(before), [
      { from: 1, to: 1, loaded: false },
      { from: null, to: null, loaded: false },
    ]);
    assert.equal(pageOf(tree, 2), null, 'the later op counts');
    // The other order: the cache, later, counts.
    const v2 = tree.payloadOf(tree.byId(2)).version;
    const batch2 = intake.submit({
      seq: 2,
      ops: [put(5, 1, 'p', 'p'), put(6, 1, 'q', 'q')],
    });
    const dropped2 = intake.uncache({ id: 2 });
    const cached2 = intake.cache({ id: 2, data: '<again>', version: v2 });
    await time.advance(20);
    await batch2;
    assert.deepEqual(await dropped2, { dropped: 0 });
    assert.deepEqual(await cached2, { status: 'cached' });
    assert.equal(pageOf(tree, 2), '<again>');
    assert.equal(pool.used(), held(tree));
  });

  it('an uncache of a subtree and a cache of a node in it, in one window: the later counts for that node', async () => {
    const { tree, time, intake, pool } = setup();
    await intake.load(
      [
        ROOT,
        pageRow(2, 1, 'p', 'p', '<p>'),
        pageRow(3, 2, 'c', 'c', '<c>'),
        pageRow(4, 2, 'd', 'd', '<d>'),
      ],
      0,
    );
    const whole = intake.uncache({ id: 2, subtree: true });
    const child = intake.cache({
      id: 3,
      data: '<c2>',
      version: tree.payloadOf(tree.byId(3)).version,
    });
    await time.advance(20);
    assert.deepEqual(await whole, { dropped: 2 }, '2 and 4: 3 is the cache’s');
    assert.deepEqual(await child, { status: 'cached' });
    assert.deepEqual(
      [2, 3, 4].map((id) => pageOf(tree, id)),
      [null, '<c2>', null],
    );
    const again = intake.cache({
      id: 3,
      data: '<c3>',
      version: tree.payloadOf(tree.byId(3)).version,
    });
    const whole2 = intake.uncache({ id: 2, subtree: true });
    await time.advance(20);
    assert.deepEqual(
      await again,
      { status: 'stale' },
      'the uncache came later',
    );
    assert.deepEqual(await whole2, { dropped: 1 });
    assert.deepEqual(
      [2, 3, 4].map((id) => pageOf(tree, id)),
      [null, null, null],
    );
    assert.equal(pool.used(), held(tree));
  });

  it('close() while a page compresses rejects its ops and gives the pool back', async () => {
    let release = null;
    const gate = new Promise((resolve) => (release = resolve));
    const compress = async () => {
      await gate;
      return [[3, Buffer.from('gz')]];
    };
    const { tree, time, intake, pool } = setup({}, 1 << 16, {}, { compress });
    await intake.load([ROOT, pageRow(2, 1, 'a', 'a')], 0);
    const v = tree.payloadOf(tree.byId(2)).version;
    const cached = outcome(intake.cache({ id: 2, data: '<page>', version: v }));
    const dropping = outcome(intake.uncache({ id: 2 }));
    await time.advance(20); // the page placed, its compression waiting
    assert.ok(pool.used() > held(tree), 'the page is in the pool');
    intake.close();
    release();
    await time.advance(20);
    assert.deepEqual(await cached, { error: 'ERR_VFS_CLOSED' });
    assert.deepEqual(await dropping, { error: 'ERR_VFS_CLOSED' });
    assert.equal(pool.used(), held(tree));
  });

  it("an 'intake' mode load while a page compresses puts it back: checked after the load, stale; the next lands", async () => {
    let release = null;
    let calls = 0;
    const gate = new Promise((resolve) => (release = resolve));
    const compress = async () => {
      if (++calls === 1) await gate;
      return [[3, Buffer.from('gz')]];
    };
    const { tree, time, intake, pool } = setup(
      { seq: 'intake' },
      1 << 16,
      {},
      { compress },
    );
    await intake.load([ROOT, pageRow(2, 1, 'a', 'a')]);
    const v = tree.payloadOf(tree.byId(2)).version;
    const cached = outcome(intake.cache({ id: 2, data: '<page>', version: v }));
    await time.advance(20); // placed, compression waiting
    const loading = intake.load([ROOT, pageRow(2, 1, 'a', 'b')]); // cuts the run
    release();
    await time.advance(20);
    await loading;
    await time.advance(20);
    assert.deepEqual(await cached, { status: 'stale' }, 'its data changed');
    assert.equal(pool.used(), held(tree));
    const again = intake.cache({
      id: 2,
      data: '<page2>',
      version: tree.payloadOf(tree.byId(2)).version,
    });
    await time.advance(20);
    assert.deepEqual(await outcome(again), { status: 'cached' });
    assert.equal(pageOf(tree, 2), '<page2>');
    assert.equal(pool.used(), held(tree));
  });
});
