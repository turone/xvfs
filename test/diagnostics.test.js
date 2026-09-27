'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  tmpDir,
  writeTree,
  rm,
  kernel,
  until,
  tap,
  worker,
  nextMessage,
  quiet,
} = require('./helpers.js');

// kernel.diagnostics(): what the shared memory holds and why, as of the
// call — the pool, what the published versions take of it, the retired
// representations, what the main thread and each linked worker still
// read, a worker's pending ACKs, the sources read from disk for want of
// room, the preparations that failed, the work queued. Read-only: it
// frees, settles and compacts nothing.

const VIRTUAL = { v: { origin: 'virtual', fs: { writable: true } } };

// A clock the test moves: the kernel dates retired versions with Date.now().
const clock = () => {
  const real = Date.now;
  let now = real();
  Date.now = () => now;
  return {
    advance: (ms) => {
      now += ms;
    },
    restore: () => {
      Date.now = real;
    },
  };
};

describe('VfsKernel: diagnostics', () => {
  it('shows a worker that does not ACK, and frees or changes nothing', async () => {
    const root = tmpDir('vfs-diag');
    const time = clock();
    const k = await kernel(root, VIRTUAL);
    try {
      const v = k.fs('v');
      const healthy = tap(k);
      const stuck = tap(k, { ack: false });
      // Two updates that retire a version each: 100 and 40 bytes.
      await v.writeFile('/a.txt', 'A'.repeat(100));
      await v.writeFile('/a.txt', 'B'.repeat(100));
      time.advance(1000);
      await v.writeFile('/b.txt', 'b'.repeat(40));
      await v.writeFile('/b.txt', 'c'.repeat(40));
      const owes = (id) =>
        [...k.acks.values()].some((ack) => ack.pending.has(id));
      assert.ok(await until(() => !owes(healthy.id)), 'the healthy ACKs');
      assert.ok(owes(stuck.id));
      time.advance(60_000);
      // Nothing may be freed, settled or compacted by looking.
      const touched = [];
      for (const name of ['free', 'compact', 'put', 'remove']) {
        const original = k.cache[name];
        k.cache[name] = function (...args) {
          touched.push(name);
          return original.apply(this, args);
        };
      }
      const books = () => [
        k.retirements(),
        [...k.acks.keys()],
        k.nextUpdateId,
        k.cache.stats(),
      ];
      const before = books();
      const d = k.diagnostics();
      assert.deepEqual(d.retired, {
        representations: 2,
        bytes: 140,
        oldestMs: 61_000,
        waitingAck: { representations: 2, bytes: 140 },
        waitingRelease: { representations: 0, bytes: 0 },
      });
      const none = { representations: 0, bytes: 0, oldestMs: 0 };
      assert.deepEqual(d.main, { held: none });
      assert.deepEqual(d.links, [
        { id: healthy.id, pending: { updates: 0, oldestMs: 0 }, held: none },
        { id: stuck.id, pending: { updates: 2, oldestMs: 61_000 }, held: none },
      ]);
      // The published versions and the retired ones are all the pool holds.
      assert.deepEqual(d.published, { files: 2, bytes: 100 + 40 });
      assert.equal(d.pool.used, d.published.bytes + d.retired.bytes);
      assert.deepEqual(d.preparation, { failures: 0, places: {} });
      assert.deepEqual(d.queues, {
        watch: { epochs: 0, rechecks: 0 },
        mutations: { keys: 0, barriers: 0 },
      });
      assert.deepEqual(k.diagnostics(), d, 'the same picture again');
      assert.deepEqual(books(), before, 'nothing changed');
      assert.deepEqual(touched, [], 'nothing freed, compacted or published');
      assert.ok(Object.isFrozen(d) && Object.isFrozen(d.links[1].pending));
      assert.throws(() => {
        d.retired.bytes = 0;
      }, TypeError);
      // Once the worker ACKs, the versions it kept waiting are freed.
      for (const updateId of [...k.acks.keys()]) {
        k.handleAck(updateId, stuck.id);
      }
      const after = k.diagnostics();
      assert.equal(after.retired.representations, 0);
      assert.equal(after.links[1].pending.updates, 0);
      assert.equal(after.pool.used, 100 + 40);
    } finally {
      time.restore();
      k.close();
      rm(root);
    }
  });

  // A worker reads two retired representations, retired 5 and 3 seconds
  // ago; a lease of the main thread one, retired 2 seconds ago. Each link
  // ACKs every update: they wait for their holders only.
  it('shows what a worker and the main thread still read', async () => {
    const root = tmpDir('vfs-diag');
    const time = clock();
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true, zeroCopy: true } },
    });
    let w = null;
    try {
      const v = k.fs('v');
      await v.writeFile('/a.txt', 'A'.repeat(64));
      await v.writeFile('/b.txt', 'B'.repeat(32));
      await v.writeFile('/c.txt', 'C'.repeat(16));
      w = worker(k);
      const other = tap(k);
      const update = async (key, text) => {
        const acked = [nextMessage(w.main), nextMessage(k.links.get(other.id))];
        await v.writeFile(key, text);
        await Promise.all(acked);
      };
      const wv = w.kernel.fs('v');
      const streams = [wv.createReadStream('/a.txt')];
      streams.push(wv.createReadStream('/b.txt'));
      const lease = v.readFileView('/c.txt');
      await update('/a.txt', 'a'.repeat(64));
      time.advance(2000);
      await update('/b.txt', 'b'.repeat(32));
      time.advance(1000);
      await update('/c.txt', 'c'.repeat(16));
      time.advance(2000);
      const d = k.diagnostics();
      assert.deepEqual(d.retired, {
        representations: 3,
        bytes: 64 + 32 + 16,
        oldestMs: 5000,
        waitingAck: { representations: 0, bytes: 0 },
        waitingRelease: { representations: 3, bytes: 64 + 32 + 16 },
      });
      const none = { representations: 0, bytes: 0, oldestMs: 0 };
      const acking = { updates: 0, oldestMs: 0 };
      assert.deepEqual(d.links, [
        {
          id: w.id,
          pending: acking,
          held: { representations: 2, bytes: 64 + 32, oldestMs: 5000 },
        },
        { id: other.id, pending: acking, held: none },
      ]);
      assert.deepEqual(d.main, {
        held: { representations: 1, bytes: 16, oldestMs: 2000 },
      });
      for (const stream of streams) {
        const released = nextMessage(w.main);
        stream.release();
        await released;
      }
      lease.release();
      const after = k.diagnostics();
      assert.deepEqual(after.links[0].held, none);
      assert.deepEqual(after.main, { held: none });
      assert.equal(after.retired.representations, 0);
    } finally {
      time.restore();
      w?.kernel.close();
      k.close();
      rm(root);
    }
  });

  // One 4 KiB segment: /a, /b and /c take 1000 bytes each. Removed, /b
  // leaves a hole of 1000 bytes before the 1096 left at the tail; /c then
  // widens it to 2000. A segment emptied is kept for reuse: whole, it is the
  // largest free extent.
  it('pool usage and fragmentation', async () => {
    const root = tmpDir('vfs-diag');
    const k = await kernel(root, VIRTUAL, {
      memory: { limit: '16 kib', segmentSize: '4 kib', maxFileSize: '4 kib' },
      compaction: { threshold: 0 },
    });
    try {
      const v = k.fs('v');
      const segment = { limit: 16384, segmentSize: 4096 };
      for (const key of ['/a', '/b', '/c']) {
        await v.writeFile(key, Buffer.alloc(1000, key));
      }
      await v.unlink('/b');
      assert.deepEqual(k.diagnostics().pool, {
        ...segment,
        segments: 1,
        reserved: 4096,
        used: 2000,
        free: 2096,
        largestFree: 1096,
        fragmentation: 1 - 1096 / 2096,
      });
      await v.unlink('/c');
      assert.deepEqual(k.diagnostics().pool, {
        ...segment,
        segments: 1,
        reserved: 4096,
        used: 1000,
        free: 3096,
        largestFree: 2000,
        fragmentation: 1 - 2000 / 3096,
      });
      await v.writeFile('/big', Buffer.alloc(4000, 'b'));
      await v.unlink('/big');
      assert.deepEqual(k.diagnostics().pool, {
        ...segment,
        segments: 2,
        reserved: 8192,
        used: 1000,
        free: 7192,
        largestFree: 4096,
        fragmentation: 1 - 4096 / 7192,
      });
    } finally {
      k.close();
      rm(root);
    }
  });

  // A segment compaction is emptying takes no allocation: its free bytes
  // count as free, never as room. /c moves out of segment 2 into the hole
  // /a left; the retired /d, still read, keeps segment 2 closed.
  it('a segment being emptied offers no room', async () => {
    const root = tmpDir('vfs-diag');
    const k = await kernel(
      root,
      { v: { origin: 'virtual', fs: { writable: true, zeroCopy: true } } },
      {
        memory: { limit: '16 kib', segmentSize: '4 kib', maxFileSize: '4 kib' },
        compaction: { threshold: 0.5 },
      },
    );
    try {
      const v = k.fs('v');
      await v.writeFile('/a', Buffer.alloc(2048, 'a'));
      await v.writeFile('/b', Buffer.alloc(2048, 'b'));
      await v.writeFile('/c', Buffer.alloc(200, 'c'));
      await v.writeFile('/d', Buffer.alloc(100, 'd'));
      const lease = v.readFileView('/d');
      await v.unlink('/d');
      await v.unlink('/a');
      assert.equal(k.cache.entry('v', '/c').segmentId, 1, 'relocated');
      assert.ok(k.cache.registry.closed.has(2));
      // Segment 1: /b and /c, a hole of 1848. Segment 2: the retired /d,
      // the 200 bytes /c left and a tail of 3796, none of it for anyone.
      assert.deepEqual(k.diagnostics().pool, {
        limit: 16384,
        segmentSize: 4096,
        segments: 2,
        reserved: 8192,
        used: 2048 + 200 + 100,
        free: 8192 - 2348,
        largestFree: 1848,
        fragmentation: 1 - 1848 / (8192 - 2348),
      });
      lease.release();
    } finally {
      k.close();
      rm(root);
    }
  });

  // Of the sources read from disk, a fallback is one the pool had no room
  // for: neither larger than maxFileSize nor kept on disk by `retainRaw:
  // false`. Two segments hold four files of 1500 bytes; two more fall back.
  it('disk fallbacks and failed preparations', async () => {
    const files = {
      'zip/p.txt': 'p'.repeat(100),
      'site/big.bin': Buffer.alloc(3000, 'B'),
      'code/a.js': 'module.exports = 1;',
    };
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
      files[`site/${name}.bin`] = Buffer.alloc(1500, name);
    }
    const root = writeTree(tmpDir('vfs-diag'), files);
    const preparers = {
      code: (raw) => {
        if (raw.includes('THROW')) throw new Error('cannot prepare');
        return raw;
      },
    };
    const k = await kernel(
      root,
      {
        zip: {
          fs: {
            ext: ['txt'],
            compress: { encodings: ['gzip'], retainRaw: false },
          },
        },
        site: { fs: { ext: ['bin'] } },
        code: { fs: { ext: ['js'], prepare: 'code' } },
        mem: {
          provider: 'map',
          origin: 'virtual',
          fs: { writable: true, ext: ['js'], prepare: 'code' },
        },
      },
      {
        memory: { limit: '8 kib', segmentSize: '4 kib', maxFileSize: '2 kib' },
        watch: true,
        watchTimeout: 60000,
      },
      { preparers, console: quiet },
    );
    try {
      k.watcher.close();
      const d = k.diagnostics();
      assert.deepEqual(d.disk, {
        files: 4,
        bytes: 100 + 3000 + 2 * 1500,
        fallback: { files: 2, bytes: 3000 },
      });
      // Sources: p.txt, the seven of site, a.js — in the pool or not.
      assert.equal(d.published.files, 9);
      assert.equal(d.pool.used, d.published.bytes + d.retired.bytes);
      assert.deepEqual(d.preparation, {
        failures: 0,
        places: { code: 0, mem: 0 },
      });
      // A change the watcher cannot prepare, and a local write.
      const at = path.join(root, 'code', 'a.js');
      fs.writeFileSync(at, 'THROW');
      k.watcher.emit('epoch', new Map([[at, 'change']]));
      await k.watchQueue.idle;
      assert.throws(() => k.fs('mem').writeFile('/x.js', 'THROW'), {
        message: 'cannot prepare',
      });
      assert.deepEqual(k.diagnostics().preparation, {
        failures: 2,
        places: { code: 1, mem: 1 },
      });
    } finally {
      k.close();
      rm(root);
    }
  });

  // The work queued: watcher epochs — one running, one behind it — and the
  // recheck a failed read left; mutations of a virtual place by key, and a
  // barrier, which takes over the keys queued before it. The first read
  // and the first publication wait at a gate.
  it('queues: epochs and rechecks, mutation keys and barriers', async () => {
    const root = writeTree(tmpDir('vfs-diag'), { 'site/a.txt': 'a' });
    const k = await kernel(
      root,
      { site: { fs: true }, v: { origin: 'virtual', fs: { writable: true } } },
      { watch: true, watchTimeout: 60000 },
    );
    const gate = Promise.withResolvers();
    try {
      k.watcher.close();
      const queues = () => k.diagnostics().queues;
      assert.deepEqual(queues(), {
        watch: { epochs: 0, rechecks: 0 },
        mutations: { keys: 0, barriers: 0 },
      });
      const real = k.cache.reader;
      let reads = 0;
      k.cache.reader = async (file, view) => {
        if (++reads > 1) return real(file, view);
        await gate.promise;
        throw new Error('source changed during read');
      };
      const publish = k.publishVirtual.bind(k);
      k.publishVirtual = async (...args) => {
        await gate.promise;
        return publish(...args);
      };
      const at = path.join(root, 'site', 'a.txt');
      k.watcher.emit('epoch', new Map([[at, 'change']]));
      k.watcher.emit('epoch', new Map([[at, 'change']]));
      const v = k.fs('v');
      const mutations = [
        v.writeFile('/a', '1'),
        v.writeFile('/a', '2'),
        v.writeFile('/b', '3'),
      ];
      assert.deepEqual(queues(), {
        watch: { epochs: 2, rechecks: 0 },
        mutations: { keys: 2, barriers: 0 },
      });
      mutations.push(v.rm('/d', { recursive: true, force: true }));
      assert.deepEqual(queues().mutations, { keys: 0, barriers: 1 });
      gate.resolve();
      await Promise.all(mutations);
      await k.watchQueue.idle;
      // Each lock goes once the task it stands for has settled.
      await new Promise(setImmediate);
      assert.deepEqual(queues(), {
        watch: { epochs: 0, rechecks: 1 },
        mutations: { keys: 0, barriers: 0 },
      });
    } finally {
      gate.resolve();
      k.close();
      rm(root);
    }
  });

  it('asks a ready main kernel', async () => {
    const root = tmpDir('vfs-diag');
    const k = await kernel(root, VIRTUAL);
    let w = null;
    try {
      w = worker(k);
      assert.throws(() => w.kernel.diagnostics(), /main-thread only/);
      k.close();
      assert.throws(() => k.diagnostics(), /requires a ready kernel/);
    } finally {
      w?.kernel.close();
      k.close();
      rm(root);
    }
  });
});
