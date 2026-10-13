'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { FilesystemCache, EMPTY } = require('../lib/cache.js');

const KB = 1024;
const make = (options = {}) =>
  new FilesystemCache({
    limit: 16 * KB,
    segmentSize: 4 * KB,
    maxFileSize: 2 * KB,
    ...options,
  });

const buf = (size, fill = 'a') => Buffer.alloc(size, fill);
const input = (size, fill) => ({
  data: buf(size, fill),
  stat: { size, mtimeMs: 1 },
});

const bytes = (cache, extent) =>
  Buffer.from(
    cache.getSegment(extent.segmentId).sab,
    extent.offset,
    extent.length,
  );

describe('FilesystemCache: allocate', () => {
  it('places bytes in a segment the kernel map gets too', async () => {
    const segments = new Map();
    const cache = make({ segments });
    const extent = await cache.allocate(input(100));
    assert.deepEqual(extent, { segmentId: 1, offset: 0, length: 100 });
    assert.equal(bytes(cache, extent).toString(), 'a'.repeat(100));
    assert.equal(segments.get(1), cache.getSegment(1).sab);
  });

  it('a file above maxFileSize finds no room: null', async () => {
    const cache = make();
    assert.equal(await cache.allocate(input(3 * KB)), null);
    const file = { path: '/tmp/big', stat: { size: 3 * KB, mtimeMs: 1 } };
    assert.equal(await cache.allocate(file), null);
    assert.equal(cache.pool.segments.size, 0);
  });

  it('honours per-call maxFileSize', async () => {
    const cache = make();
    const extent = await cache.allocate(input(3 * KB), { maxFileSize: 4 * KB });
    assert.equal(extent.length, 3 * KB);
  });

  it('an empty file is the empty extent, in no segment', async () => {
    const cache = make();
    assert.equal(await cache.allocate(input(0)), EMPTY);
    assert.deepEqual(EMPTY, { segmentId: 0, offset: 0, length: 0 });
    assert.equal(cache.pool.segments.size, 0);
    cache.free(EMPTY);
  });

  it('uses the injected reader and rolls the extent back when it throws', async () => {
    let calls = 0;
    const reader = async (file, view) => {
      calls++;
      if (file.path === '/bad') throw new Error('changed');
      view.fill(0x42);
    };
    const cache = make({ reader });
    const good = { path: '/good', stat: { size: 100, mtimeMs: 1 } };
    const bad = { path: '/bad', stat: { size: 100, mtimeMs: 1 } };
    const extent = await cache.allocate(good);
    assert.equal(bytes(cache, extent).toString(), 'B'.repeat(100));
    await assert.rejects(cache.allocate(bad), /changed/);
    assert.equal(calls, 2);
    // The failed extent was released: the next allocation reuses its offset.
    const next = await cache.allocate(good);
    assert.equal(next.offset, 100);
  });

  it('rejects buffers whose length disagrees with stat.size', async () => {
    const cache = make();
    await assert.rejects(
      cache.allocate({ data: buf(10), stat: { size: 11 } }),
      /size mismatch/,
    );
  });

  it('without reader, a path input finds no room', async () => {
    const cache = make();
    assert.equal(
      await cache.allocate({ path: '/tmp/x', stat: { size: 5 } }),
      null,
    );
  });

  it('refuses sizes above one segment even with maxFileSize: Infinity', async () => {
    const cache = make();
    const extent = await cache.allocate(input(5 * KB), {
      maxFileSize: Infinity,
    });
    assert.equal(extent, null);
    assert.throws(() => cache.registry.allocate(0), RangeError);
    assert.throws(() => cache.registry.allocate(1.5), RangeError);
  });

  it('respects the pool limit', async () => {
    const cache = make({ limit: 4 * KB });
    await cache.allocate(input(2 * KB));
    await cache.allocate(input(2 * KB));
    assert.equal(await cache.allocate(input(1 * KB)), null);
  });

  it('allocateSync places in-memory bytes at once, or finds no room', () => {
    const cache = make();
    const extent = cache.allocateSync(input(10, 's'));
    assert.equal(bytes(cache, extent).toString(), 's'.repeat(10));
    assert.equal(cache.allocateSync(input(3 * KB)), null);
    assert.throws(
      () => cache.allocateSync({ path: '/x', stat: { size: 1 } }),
      /in-memory data only/,
    );
    const lying = { length: 5, 0: 1 };
    Object.defineProperty(lying, 1, {
      get() {
        throw new Error('lies');
      },
    });
    assert.throws(
      () => cache.allocateSync({ data: lying, stat: { size: 5 } }),
      /lies/,
    );
    const again = cache.allocateSync(input(5));
    assert.equal(again.offset, 10, 'the refused copy left nothing allocated');
  });
});

describe('FilesystemCache: free', () => {
  it('free() reuses extents best-fit and merges neighbours', async () => {
    const cache = make();
    const a = await cache.allocate(input(500));
    const b = await cache.allocate(input(300));
    const c = await cache.allocate(input(200));
    cache.free(a);
    cache.free(c);
    assert.deepEqual(cache.registry.free.get(1), [
      { offset: 0, length: 500 },
      { offset: 800, length: 200 },
    ]);
    const d = await cache.allocate(input(200));
    assert.equal(d.offset, 800);
    cache.free(b);
    assert.deepEqual(cache.registry.free.get(1), [{ offset: 0, length: 800 }]);
    cache.free(null);
  });

  it('fully freed segments are kept for reuse, never released', async () => {
    const cache = make();
    const a = await cache.allocate(input(100));
    cache.free(a);
    assert.ok(cache.pool.emptySegmentIds.has(1));
    assert.equal(cache.pool.segments.size, 1);
    const b = await cache.allocate(input(100));
    assert.equal(b.segmentId, 1);
    assert.equal(cache.pool.segments.size, 1);
  });
});

describe('FilesystemCache: compaction', () => {
  // seg 1: a + b fill it exactly; seg 2: c alone.
  const fill = async (cache, sizes = [2 * KB, 2 * KB, 200]) => {
    const a = await cache.allocate(input(sizes[0]));
    const b = await cache.allocate(input(sizes[1]));
    const c = await cache.allocate(input(sizes[2], 'c'));
    assert.equal(b.segmentId, 1);
    assert.equal(c.segmentId, 2);
    return { a, b, c };
  };

  it('the target is the emptiest segment open to allocation, below the threshold', async () => {
    const cache = make({ maxFileSize: 4 * KB });
    const { a } = await fill(cache);
    assert.equal(cache.compactTarget(0.5), 2);
    cache.free(a);
    assert.equal(cache.compactTarget(0.5), 2, 'seg 1 at 50 %, seg 2 at 5 %');
    assert.equal(cache.compactTarget(0), null, 'threshold 0 disables');
    assert.equal(cache.compactTarget(0.01), null, 'nothing below 1 %');
  });

  it('one segment in use is never a target', async () => {
    const cache = make();
    await cache.allocate(input(10));
    assert.equal(cache.compactTarget(0.9), null);
  });

  it('relocate copies the extents out and closes the target', async () => {
    const cache = make({ maxFileSize: 4 * KB });
    const { a, c } = await fill(cache);
    cache.free(a);
    const [moved] = cache.relocate(2, [c]);
    assert.deepEqual(moved, { segmentId: 1, offset: 0, length: 200 });
    assert.equal(bytes(cache, moved).toString(), 'c'.repeat(200));
    assert.equal(bytes(cache, c).toString(), 'c'.repeat(200), 'old intact');
    assert.ok(cache.registry.closed.has(2));
    const e = await cache.allocate(input(100));
    assert.notEqual(e.segmentId, 2, 'no allocation lands in a closed one');
  });

  it('rolls back when the move does not fit without growing', async () => {
    const cache = make({ maxFileSize: 4 * KB });
    const { a, c } = await fill(cache, [1 * KB, 3 * KB, 1536]);
    cache.free(a);
    // seg 2 (c, 37 %) is the candidate but 1536 bytes do not fit into the
    // 1 KiB hole of seg 1 and the pool must not grow.
    const before = JSON.stringify([
      [...cache.registry.free],
      [...cache.registry.tail],
    ]);
    assert.equal(cache.relocate(2, [c]), null);
    assert.equal(
      JSON.stringify([[...cache.registry.free], [...cache.registry.tail]]),
      before,
    );
    assert.equal(cache.registry.closed.size, 0);
  });

  it('the emptied segment stays closed until retired bytes are freed', async () => {
    const cache = make({ maxFileSize: 4 * KB });
    const { a, c } = await fill(cache);
    // d shares seg 2 with c, retired: its bytes wait for an ACK.
    const d = await cache.allocate(input(300, 'd'));
    cache.free(a);
    cache.relocate(2, [c]);
    assert.ok(cache.registry.closed.has(2), 'seg 2 closed, not recycled');
    cache.free(c);
    assert.ok(cache.registry.closed.has(2), 'still holds d');
    assert.equal(bytes(cache, d).toString(), 'd'.repeat(300));
    cache.free(d);
    assert.ok(!cache.registry.closed.has(2));
    assert.ok(cache.pool.emptySegmentIds.has(2), 'now reusable');
  });

  it('an extent committed into a closed segment reopens it', async () => {
    const cache = make({ maxFileSize: 4 * KB });
    const { a, c } = await fill(cache);
    // A publication in progress holds an extent in seg 2.
    const pending = await cache.allocate(input(100, 'p'));
    assert.equal(pending.segmentId, 2);
    cache.free(a);
    cache.relocate(2, [c]);
    assert.ok(cache.registry.closed.has(2));
    cache.committed(EMPTY);
    assert.ok(cache.registry.closed.has(2), 'the empty extent is in none');
    cache.committed(pending);
    assert.ok(!cache.registry.closed.has(2), 'a live extent keeps it open');
    cache.registry.closed.add(2);
    cache.reopen(2);
    assert.ok(!cache.registry.closed.has(2));
  });
});

describe('FilesystemCache: snapshot / stats', () => {
  it('snapshot lists every segment of the pool', async () => {
    const cache = make();
    await cache.allocate(input(10));
    await cache.allocate(input(0));
    const segments = cache.snapshot();
    assert.equal(segments.length, 1);
    assert.equal(segments[0].id, 1);
    assert.ok(segments[0].sab instanceof SharedArrayBuffer);
  });

  it('stats() summarises segments', async () => {
    const cache = make();
    await cache.allocate(input(1024));
    const s = cache.stats();
    assert.equal(s.segmentCount, 1);
    assert.equal(s.totalUsed, 4 * KB);
    assert.match(s.lines[0], /25\.0%/);
  });
});
