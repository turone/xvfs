'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { on } = require('node:events');
const { spawnSync } = require('node:child_process');
const { VfsKernel } = require('../lib/kernel.js');
const {
  tmpDir,
  writeTree,
  rm,
  kernel,
  config,
  quiet,
  tap,
  worker,
  nextEvent,
} = require('./helpers.js');

// Publication events: a kernel tells its 'publish' listeners what each
// publication it applies changed — after the commit, in every thread, one
// event per commit, in the order of the versions — and 'close' once, last.
// Nothing in an event refers to shared bytes.

const VIRTUAL = { v: { origin: 'virtual', fs: { writable: true } } };

// The events of `k` from now on, in the order they come.
const record = (k) => {
  const events = [];
  k.on('publish', (event) => events.push(event));
  return events;
};

const changes = (created = [], replaced = [], removed = []) => ({
  created,
  replaced,
  removed,
});

// Every microtask queued so far has run.
const drained = () => new Promise((resolve) => setImmediate(resolve));

// `promise`, or a failure after `ms`: a test waiting for what never comes
// fails instead of hanging. The timer holds the event loop meanwhile,
// which a link port — unref'd — does not.
const within = (promise, what, ms = 5000) =>
  new Promise((resolve, reject) => {
    const late = setTimeout(() => {
      reject(new Error(`no ${what} within ${ms} ms`));
    }, ms);
    promise.finally(() => clearTimeout(late)).then(resolve, reject);
  });

// The next `event` of `emitter`, within `ms`.
const next = (emitter, event, ms) =>
  within(
    new Promise((resolve) => emitter.once(event, resolve)),
    `'${event}'`,
    ms,
  );

const isDeepFrozen = (value) =>
  value === null ||
  typeof value !== 'object' ||
  (Object.isFrozen(value) && Object.values(value).every(isDeepFrozen));

describe('publish: mutations of a virtual place', () => {
  it('one frozen, cloneable event per mutation, delivered before its promise settles', async () => {
    const root = tmpDir('vfs-events');
    const k = await kernel(root, VIRTUAL);
    try {
      const v = k.fs('v');
      const events = record(k);
      await v.writeFile('/a.txt', 'a');
      assert.deepEqual(events, [
        { version: 1, places: { v: changes(['/a.txt']) } },
      ]);
      const [event] = events;
      assert.ok(isDeepFrozen(event), 'frozen, all the way down');
      assert.deepEqual(structuredClone(event), event);
      assert.deepEqual(JSON.parse(JSON.stringify(event)), event);
      await v.writeFile('/a.txt', 'A');
      await v.appendFile('/a.txt', '+');
      await v.writeFile('/b.txt', 'b');
      await v.rename('/b.txt', '/c.txt');
      await v.rename('/c.txt', '/a.txt');
      await v.unlink('/a.txt');
      assert.deepEqual(events.slice(1), [
        { version: 2, places: { v: changes([], ['/a.txt']) } },
        { version: 3, places: { v: changes([], ['/a.txt']) } },
        { version: 4, places: { v: changes(['/b.txt']) } },
        { version: 5, places: { v: changes(['/c.txt'], [], ['/b.txt']) } },
        { version: 6, places: { v: changes([], ['/a.txt'], ['/c.txt']) } },
        { version: 7, places: { v: changes([], [], ['/a.txt']) } },
      ]);
      assert.equal(k.version, 7);
    } finally {
      k.close();
      rm(root);
    }
  });

  it('a subtree: its move and its removal are one event each; companions are never named', async () => {
    const root = tmpDir('vfs-events');
    const k = await kernel(root, {
      v: {
        origin: 'virtual',
        fs: { writable: true, compress: { encodings: ['gzip'] } },
        require: { compile: true },
      },
    });
    try {
      const v = k.fs('v');
      await v.writeFile('/d/a.txt', 'a');
      await v.writeFile('/d/b.txt', 'b');
      await v.writeFile('/s.js', 'exports.s = 1;');
      const events = record(k);
      await v.rename('/d', '/e');
      await v.rm('/e', { recursive: true });
      await v.writeFile('/s.js', 'exports.s = 2;');
      assert.deepEqual(events, [
        {
          version: 4,
          places: {
            v: changes(['/e/a.txt', '/e/b.txt'], [], ['/d/a.txt', '/d/b.txt']),
          },
        },
        {
          version: 5,
          places: { v: changes([], [], ['/e/a.txt', '/e/b.txt']) },
        },
        { version: 6, places: { v: changes([], ['/s.js']) } },
      ]);
      const named = events.flatMap(({ places }) =>
        Object.values(places).flatMap((c) => Object.values(c).flat()),
      );
      assert.ok(
        named.every((key) => !key.includes('\0')),
        'no companion',
      );
    } finally {
      k.close();
      rm(root);
    }
  });

  it('what publishes nothing is not announced; a listener added later gets no replay', async () => {
    const root = tmpDir('vfs-events');
    const k = await kernel(root, VIRTUAL);
    try {
      const v = k.fs('v');
      await v.writeFile('/a.txt', 'a');
      await v.writeFile('/d/b.txt', 'b');
      const events = record(k);
      await v.rename('/a.txt', '/a.txt');
      await v.rename('/d', '/d');
      await v.mkdir('/n');
      await v.rm('/gone', { force: true });
      await drained();
      assert.deepEqual(events, []);
      await v.unlink('/a.txt');
      assert.deepEqual(events, [
        { version: 3, places: { v: changes([], [], ['/a.txt']) } },
      ]);
    } finally {
      k.close();
      rm(root);
    }
  });

  it('concurrent writes: one event each, in the order of their versions', async () => {
    const root = tmpDir('vfs-events');
    const k = await kernel(root, VIRTUAL);
    try {
      const v = k.fs('v');
      const events = record(k);
      await Promise.all([
        v.writeFile('/a.txt', 'a'),
        v.writeFile('/b.txt', 'b'),
        v.writeFile('/c.txt', 'c'),
      ]);
      assert.deepEqual(
        events.map((event) => event.version),
        [1, 2, 3],
      );
      assert.deepEqual(
        events.flatMap((event) => event.places.v.created).sort(),
        ['/a.txt', '/b.txt', '/c.txt'],
      );
    } finally {
      k.close();
      rm(root);
    }
  });
});

describe('publish: init, the watcher, compaction', () => {
  it('init is one event, for a listener there before initialize()', async () => {
    const root = writeTree(tmpDir('vfs-events'), {
      'site/a.js': 'module.exports = 1;',
      'site/sub/b.css': 'b{}',
    });
    const asset = Buffer.from('p');
    const k = new VfsKernel(
      config({
        site: { fs: { compress: { encodings: ['gzip'] } }, require: true },
        pub: { provider: 'sea', fs: true },
        ...VIRTUAL,
      }),
      {
        appRoot: root,
        console: quiet,
        seaModule: {
          isSea: () => true,
          getAssetKeys: () => ['pub/p.txt'],
          getAsset: () =>
            asset.buffer.slice(
              asset.byteOffset,
              asset.byteOffset + asset.length,
            ),
        },
      },
    );
    try {
      const events = record(k);
      await k.initialize();
      assert.equal(events.length, 1, 'before initialize() returned');
      const [{ version, places }] = events;
      assert.equal(version, 1);
      assert.deepEqual(Object.keys(places).sort(), ['pub', 'site']);
      assert.deepEqual(places.site.created.slice().sort(), [
        '/a.js',
        '/sub/b.css',
      ]);
      assert.deepEqual(places.pub, changes(['/p.txt']));
    } finally {
      k.close();
      rm(root);
    }
  });

  it('a watcher epoch — a change, a deletion, a rescan — is one event; a recheck another', async () => {
    const root = writeTree(tmpDir('vfs-events'), {
      'site/a.txt': 'a',
      'site/b.txt': 'b',
    });
    const k = await kernel(
      root,
      { site: { fs: true } },
      { watch: true, watchTimeout: 50 },
    );
    try {
      k.watcher.close();
      const at = (...p) => path.join(root, 'site', ...p);
      fs.writeFileSync(at('a.txt'), 'A');
      fs.unlinkSync(at('b.txt'));
      writeTree(path.join(root, 'site'), { 'n/x.txt': 'x' });
      const events = record(k);
      k.watcher.emit(
        'epoch',
        new Map([
          [at('a.txt'), 'change'],
          [at('b.txt'), 'delete'],
          [at('n'), 'scan'],
        ]),
      );
      await k.watchQueue.idle;
      assert.deepEqual(events, [
        {
          version: 2,
          places: { site: changes(['/n/x.txt'], ['/a.txt'], ['/b.txt']) },
        },
      ]);
      // A read that fails keeps the version and schedules one recheck,
      // which publishes it.
      const real = k.cache.reader;
      let reads = 0;
      k.cache.reader = async (file, view) => {
        if (++reads === 1) throw new Error('source changed during read');
        return real(file, view);
      };
      fs.writeFileSync(at('a.txt'), 'AA');
      const rechecked = next(k, 'publish');
      k.watcher.emit('epoch', new Map([[at('a.txt'), 'change']]));
      await k.watchQueue.idle;
      assert.equal(events.length, 1, 'the failed read published nothing');
      assert.equal(k.rechecks.size, 1);
      await rechecked;
      assert.equal(reads, 2);
      assert.deepEqual(events.at(-1), {
        version: 3,
        places: { site: changes([], ['/a.txt']) },
      });
      assert.equal(k.fs('site').readFile('/a.txt', 'utf8'), 'AA');
    } finally {
      k.close();
      rm(root);
    }
  });

  // The scenario of kernel.test.js "worker exit during compaction".
  it('a compaction is not announced', async () => {
    const KB = 1024;
    const root = tmpDir('vfs-events');
    const k = await kernel(root, VIRTUAL, {
      memory: { limit: '16 kib', segmentSize: '4 kib', maxFileSize: '4 kib' },
      compaction: { threshold: 0.5 },
    });
    try {
      const v = k.fs('v');
      await v.writeFile('/a', Buffer.alloc(2 * KB, 'a'));
      await v.writeFile('/b', Buffer.alloc(2 * KB, 'b'));
      await v.writeFile('/c', Buffer.alloc(200, 'c'));
      const w = tap(k, { ack: false });
      const events = record(k);
      await v.unlink('/a');
      const updates = k.nextUpdateId;
      const closed = nextEvent(k.links.get(w.id), 'close');
      w.port.close();
      await closed;
      await drained();
      assert.equal(k.nextUpdateId, updates + 1, 'the relocation');
      assert.equal(k.cache.entry('v', '/c').segmentId, 1);
      assert.deepEqual(events, [
        { version: 4, places: { v: changes([], [], ['/a']) } },
      ]);
    } finally {
      k.close();
      rm(root);
    }
  });
});

describe('publish: workers', () => {
  it('a worker announces each publication it applies, as the main thread does; its ACK does not wait', async () => {
    const root = tmpDir('vfs-events');
    const k = await kernel(root, VIRTUAL);
    const w = worker(k);
    try {
      const onMain = next(k, 'publish');
      const inWorker = next(w.kernel, 'publish');
      const acked = next(w.main, 'message');
      await k.fs('v').writeFile('/a.txt', 'a');
      const [main, applied, ack] = await Promise.all([onMain, inWorker, acked]);
      assert.deepEqual(applied, main);
      assert.deepEqual(applied, {
        version: 1,
        places: { v: changes(['/a.txt']) },
      });
      assert.equal(ack.name, 'vfs-ack');
      // A worker's own write: the update comes before the response, and its
      // listeners run before its promise settles.
      let seen = null;
      w.kernel.on('publish', (event) => {
        seen = event;
      });
      await w.kernel.fs('v').writeFile('/b.txt', 'b');
      assert.deepEqual(seen, {
        version: 2,
        places: { v: changes(['/b.txt']) },
      });
    } finally {
      w.kernel.close();
      k.close();
      rm(root);
    }
  });
});

describe('publish: listeners', () => {
  // A listener that throws in a plain node process: its error is uncaught,
  // as from any emitter, and the commit, done before it ran, stands.
  it('a listener that throws: an uncaught exception, after the commit; the write resolves', () => {
    const root = tmpDir('vfs-events');
    try {
      const fixture = path.join(__dirname, 'fixtures', 'publish-throws.cjs');
      const run = (mode) => {
        const r = spawnSync(process.execPath, [fixture, mode, root], {
          encoding: 'utf8',
          timeout: 30000,
        });
        const lines = r.stdout.trim().split('\n').filter(Boolean);
        return { ...r, reports: lines.map((line) => JSON.parse(line)) };
      };
      const crashed = run('crash');
      assert.notEqual(crashed.status, 0, 'the process died of it');
      assert.match(crashed.stderr, /Error: listener failed/);
      assert.deepEqual(crashed.reports, [{ listener: 1, read: 'a' }]);
      const handled = run('handled');
      assert.equal(handled.status, 0, handled.stderr);
      assert.deepEqual(handled.reports, [
        { listener: 1, read: 'a' },
        { uncaught: 'listener failed' },
        { write: 'resolved', version: 1 },
      ]);
    } finally {
      rm(root);
    }
  });
});

describe('close', () => {
  it("'close' comes once, last, and drops every listener", async () => {
    const root = tmpDir('vfs-events');
    const k = await kernel(root, VIRTUAL);
    try {
      const events = record(k);
      const closes = [];
      k.on('close', () => closes.push(k.state));
      k.close();
      k.close();
      assert.deepEqual(closes, [], 'not inside close()');
      await drained();
      assert.deepEqual(closes, ['closed']);
      assert.equal(k.listenerCount('publish'), 0);
      assert.equal(k.listenerCount('close'), 0);
      assert.deepEqual(events, []);
      // A later close() closes nothing: no second 'close'.
      k.on('close', () => closes.push('again'));
      k.close();
      await drained();
      assert.deepEqual(closes, ['closed']);
    } finally {
      k.close();
      rm(root);
    }
  });

  // The seam: a link whose update closes the kernel, in #flush after the
  // commit and before the event's microtask runs.
  it('an event whose commit came before close() is not delivered after it', async () => {
    const root = tmpDir('vfs-events');
    const k = await kernel(root, VIRTUAL);
    try {
      const events = record(k);
      let closes = 0;
      k.on('close', () => closes++);
      k.links.set('closing', { postMessage: () => k.close(), close() {} });
      await k.fs('v').writeFile('/a.txt', 'a');
      await drained();
      assert.equal(k.version, 1, 'committed');
      assert.equal(closes, 1);
      assert.deepEqual(events, []);
    } finally {
      k.close();
      rm(root);
    }
  });

  it("events.on: 'close' ends the iteration, an AbortSignal stops it", async () => {
    const root = tmpDir('vfs-events');
    const k = await kernel(root, VIRTUAL);
    try {
      const v = k.fs('v');
      const controller = new AbortController();
      const first = Promise.withResolvers();
      const aborted = (async () => {
        const seen = [];
        try {
          const options = { signal: controller.signal };
          for await (const [event] of on(k, 'publish', options)) {
            seen.push(event.version);
            controller.abort();
            first.resolve();
          }
        } catch (err) {
          return { seen, err };
        }
        return { seen };
      })();
      let ended = null;
      (async () => {
        const seen = [];
        const options = { close: ['close'] };
        for await (const [event] of on(k, 'publish', options)) {
          seen.push(event.version);
        }
        ended = seen;
      })();
      await v.writeFile('/a.txt', 'a');
      await within(first.promise, 'first event');
      await v.writeFile('/b.txt', 'b');
      const { seen, err } = await within(aborted, 'abort');
      assert.deepEqual(seen, [1]);
      assert.equal(err?.name, 'AbortError');
      k.close();
      await drained();
      assert.deepEqual(ended, [1, 2], "ended by 'close'");
      assert.equal(k.listenerCount('publish'), 0);
    } finally {
      k.close();
      rm(root);
    }
  });
});
