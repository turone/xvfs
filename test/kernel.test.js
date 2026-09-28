'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { availableParallelism, constants } = require('node:os');
const { Worker } = require('node:worker_threads');
const { VfsKernel } = require('../lib/kernel.js');
const { bytecodeKey } = require('../lib/companion.js');
const {
  tmpDir,
  writeTree,
  rm,
  kernel,
  config,
  quiet,
  until,
  tap,
  worker,
  nextEvent,
  diskCalls,
  leakedBytes,
  within,
} = require('./helpers.js');

describe('VfsKernel: lifecycle', () => {
  let root;
  before(() => {
    root = writeTree(tmpDir('kernel'), { 'site/a.txt': 'a' });
  });
  after(() => rm(root));

  it('goes new → initializing → ready; ready-only APIs guard themselves', async () => {
    const k = new VfsKernel(config({ site: { fs: true } }), {
      appRoot: root,
      console: quiet,
    });
    try {
      assert.equal(k.state, 'new');
      assert.ok(!k.ready);
      assert.throws(() => k.fs('site'), /requires a ready kernel/);
      assert.throws(() => k.snapshot(), /requires a ready kernel/);
      assert.throws(() => k.watch(), /requires a ready kernel/);
      const init = k.initialize();
      assert.equal(k.state, 'initializing');
      await init;
      assert.equal(k.state, 'ready');
      await assert.rejects(k.initialize(), /state "ready"/);
      k.close();
      assert.equal(k.state, 'closed');
      await assert.rejects(k.initialize(), /state "closed"/);
      assert.throws(() => k.fs('site'), /closed/);
      // The pool is unreachable after close, so its segments are collectable.
      assert.equal(k.cache, null);
      assert.equal(k.compressor, null);
      k.handleAck(1, 'w');
      k.handleWorkerExit('w');
    } finally {
      k.close();
    }
  });

  it('a failing initialize closes the kernel', async () => {
    const seaModule = {
      getAssetKeys: () => {
        throw new Error('boom');
      },
    };
    const k = new VfsKernel(config({ site: { provider: 'sea', fs: true } }), {
      appRoot: root,
      console: quiet,
      seaModule,
    });
    try {
      await assert.rejects(k.initialize(), /boom/);
      assert.equal(k.state, 'closed');
    } finally {
      k.close();
    }
  });

  // Init publishes a few files at a time — initConcurrency() of kernel.js:
  // the libuv threadpool, at most the cores — and the first source that
  // cannot be read aborts it. The reader exists once initialize() is
  // called: the scan before it reads nothing.
  it('an unreadable source aborts initialize(); a few reads start at most', async () => {
    const threads = Number(process.env.UV_THREADPOOL_SIZE) || 4;
    const limit = Math.max(1, Math.min(threads, availableParallelism()));
    const tree = {};
    for (let i = 0; i <= 2 * limit; i++) tree[`site/f${i}.txt`] = 'x';
    const big = writeTree(tmpDir('kernel-abort'), tree);
    const k = new VfsKernel(config({ site: { fs: true } }), {
      appRoot: big,
      console: quiet,
    });
    const gate = Promise.withResolvers();
    try {
      const init = k.initialize();
      let started = 0;
      // The first read fails; the others wait for the end of the test.
      k.cache.reader = async () => {
        if (++started === 1) throw new Error('unreadable');
        await gate.promise;
      };
      // An init still waiting for the reads held at the gate fails the test
      // after a deadline instead of hanging it.
      await assert.rejects(
        within(init, 'initialize(), its reads at the gate'),
        /unreadable/,
      );
      assert.equal(k.state, 'closed');
      assert.ok(started <= limit, `${started} reads started, limit ${limit}`);
    } finally {
      gate.resolve();
      k.close();
      rm(big);
    }
  });

  // A close() while initialize() runs is final: initialize() rejects with
  // the closed-kernel error — never a TypeError of the pool close() took
  // away, nor the failure of a read close() found in flight — runs no
  // preparer after it, and starts no disk call after it but the rest of
  // the reads it found in flight. Places whose sources the pipeline reads
  // itself (a map place, a prepared one) and one whose pool reads them (a
  // sab place). Closed at once, the scan is at its first readdir and stops;
  // once it stats the files, the publication of the first refuses before
  // it reads; while it reads them, the reads finish — or fail, the file
  // changed meanwhile — and nothing follows them.
  it('close() during initialize() rejects with the closed-kernel error', async () => {
    const tree = { 'a.txt': 'a', 'b.txt': 'b', 'sub/c.txt': 'c' };
    const places = {
      map: { provider: 'map', fs: true },
      prepared: { fs: { ext: ['txt'], prepare: 'upper' } },
      sab: { fs: true },
    };
    let closed = false;
    let prepared = 0; // preparer calls after close()
    const preparers = {
      upper: (raw) => {
        if (closed) prepared++;
        return raw.toString().toUpperCase();
      },
    };
    // Disk calls after initialize() returns: the readdir of the place is in
    // flight; then the one of sub/, a stat per file, the open of each read.
    // A read finishes with a stat, a read, a stat and a close.
    const moments = [
      ['at once', 0],
      ['once it stats the files', 2],
      ['while it reads them', 5, 'reads'],
      ['while it reads them, which then fail', 5, 'fail'],
    ];
    for (const [name, spec] of Object.entries(places)) {
      for (const [when, started, reading] of moments) {
        const failing = reading === 'fail';
        const what = `${name}, ${when}`;
        const files = {};
        for (const [rel, text] of Object.entries(tree)) {
          files[`${name}/${rel}`] = text;
        }
        const dir = writeTree(tmpDir('kernel-close-init'), files);
        const k = new VfsKernel(config({ [name]: spec }), {
          appRoot: dir,
          console: quiet,
          preparers,
        });
        closed = false;
        prepared = 0;
        let calls = null;
        try {
          const init = k.initialize();
          calls = diskCalls();
          // Each read, until it has made its last disk call.
          const reads = [];
          const real = k.cache.reader;
          k.cache.reader = async (file, view) => {
            const read = real(file, view);
            reads.push(read.catch(() => {}));
            await read;
            if (failing && k.state === 'closed') {
              throw new Error('source changed');
            }
          };
          await calls.started(started);
          closed = true;
          k.close();
          const atClose = calls.count;
          const inFlight = reads.length;
          await assert.rejects(
            within(init, `${what}: initialize()`),
            { message: '[vfs] kernel closed before publication' },
            what,
          );
          await Promise.all(reads);
          assert.equal(inFlight > 0, Boolean(reading), `${what}: reads`);
          assert.equal(reads.length, inFlight, `${what}: no read after`);
          assert.equal(
            calls.count - atClose,
            4 * inFlight,
            `${what}: no disk call but the rest of the reads`,
          );
          assert.equal(prepared, 0, `${what}: no preparer after close()`);
          assert.equal(k.state, 'closed');
          assert.equal(k.cache, null);
        } finally {
          calls?.stop();
          k.close();
          rm(dir);
        }
      }
    }
  });

  // SEA assets need no read: closed at once, the first publication refuses
  // before its preparer runs.
  it('close() during initialize() of a SEA place runs no preparer', async () => {
    const asset = Buffer.from('module.exports = 1;');
    const seaModule = {
      isSea: () => true,
      getAssetKeys: () => ['pub/a.js', 'pub/b.js'],
      getAsset: () =>
        asset.buffer.slice(asset.byteOffset, asset.byteOffset + asset.length),
    };
    let closed = false;
    let prepared = 0;
    const k = new VfsKernel(
      config({ pub: { provider: 'sea', fs: { ext: ['js'], prepare: 'id' } } }),
      {
        appRoot: root,
        console: quiet,
        seaModule,
        preparers: {
          id: (raw) => {
            if (closed) prepared++;
            return raw;
          },
        },
      },
    );
    try {
      const init = k.initialize();
      closed = true;
      k.close();
      await assert.rejects(init, {
        message: '[vfs] kernel closed before publication',
      });
      assert.equal(prepared, 0, 'no preparer after close()');
    } finally {
      k.close();
    }
  });

  // Virtual places read nothing at init: closed at once, the commit refuses.
  it('close() during initialize() of virtual places is final', async () => {
    const places = { v: { origin: 'virtual', fs: { writable: true } } };
    const k = new VfsKernel(config(places), { appRoot: root, console: quiet });
    try {
      const init = k.initialize();
      k.close();
      await assert.rejects(init, {
        message: '[vfs] kernel closed before publication',
      });
      assert.equal(k.state, 'closed');
      assert.equal(k.cache, null);
    } finally {
      k.close();
    }
  });

  it('fs() explains unknown places, missing fs domain and passthrough providers', async () => {
    const k = await kernel(root, {
      site: { require: { compile: false } },
      disk: { provider: 'disk', fs: true },
      nd: { provider: 'node-default', fs: true },
    });
    try {
      assert.throws(() => k.fs('nope'), /unknown place "nope"/);
      assert.throws(() => k.fs('site'), /no fs domain/);
      assert.throws(() => k.fs('disk'), /node:fs directly/);
      assert.throws(() => k.fs('nd'), /node:fs directly/);
    } finally {
      k.close();
    }
  });

  it('VfsKernel.current is the bootstrap slot', () => {
    assert.equal(VfsKernel.current, null);
    const marker = {};
    VfsKernel.current = marker;
    assert.equal(VfsKernel.current, marker);
    assert.equal(require('..').kernel, marker);
    VfsKernel.current = null;
    assert.equal(VfsKernel.current, null);
  });
});

describe('VfsKernel: providers', () => {
  let root;
  before(() => {
    root = writeTree(tmpDir('kernel-prov'), {
      'site/index.html': '<h1>',
      'site/app.js': 'module.exports = 1;',
      'site/big.bin': 'B'.repeat(70 * 1024),
      'lib/util.js': 'exports.x = 1;',
      'lib/data.json': '{"a":1}',
      'lib/notes.md': '# no',
    });
  });
  after(() => rm(root));

  it('sab: scans by scanExt, oversize files stay on disk, bytecode for require', async () => {
    const k = await kernel(root, {
      site: { fs: true, require: true },
      lib: { require: true },
    });
    try {
      const site = k.fs('site');
      assert.deepEqual(site.readdir('/'), ['app.js', 'big.bin', 'index.html']);
      assert.equal(
        site.readFile('/big.bin').length,
        70 * 1024,
        'disk-backed entry reads from disk',
      );
      assert.deepEqual(site.storedEncodings('/big.bin'), []);
      assert.ok(k.bytecode(path.join(root, 'site', 'app.js')));
      assert.equal(k.bytecode(path.join(root, 'site', 'index.html')), null);
      const lib = k.registry.get('lib');
      assert.deepEqual(
        [...lib.files.keys()].filter((key) => !key.includes('\0')).sort(),
        ['/data.json', '/util.js'],
      );
      assert.ok(lib.files.has(bytecodeKey('/util.js')));
      assert.ok(!lib.files.has(bytecodeKey('/data.json')));
    } finally {
      k.close();
    }
  });

  it('resolveModule applies domain, ext and provider rules', async () => {
    const k = await kernel(root, {
      site: { fs: true, import: { ext: ['js'] } },
      lib: { require: { ext: ['js'], compile: false } },
      d: { provider: 'disk', require: { compile: false } },
      n: { provider: 'node-default', fs: true },
    });
    try {
      const at = (...p) => path.join(root, ...p);
      assert.equal(
        k.resolveModule(at('site', 'app.js'), 'import').key,
        '/app.js',
      );
      assert.equal(
        k.resolveModule(at('site', 'app.js'), 'require'),
        null,
        'domain off',
      );
      assert.equal(
        k.resolveModule(at('site', 'index.html'), 'import'),
        null,
        'ext',
      );
      assert.equal(
        k.resolveModule(at('lib', 'util.js'), 'require').file.data.toString(),
        'exports.x = 1;',
      );
      assert.equal(k.resolveModule(at('lib', 'data.json'), 'require'), null);
      assert.equal(k.resolveModule(at('d', 'x.js'), 'require'), null);
      assert.equal(k.resolveModule(at('n', 'x.js'), 'require'), null);
      assert.equal(k.resolveModule(at('elsewhere', 'x.js'), 'require'), null);
      assert.equal(k.resolveModule('/outside/x.js', 'require'), null);
    } finally {
      k.close();
    }
  });

  it('resolveModule denies under strict', async () => {
    const k = await kernel(
      root,
      {
        lib: { require: true },
        d: { provider: 'disk', require: { compile: false } },
      },
      { strict: true },
    );
    try {
      const at = (...p) => path.join(root, ...p);
      assert.deepEqual(k.resolveModule(at('lib', 'missing.js'), 'require'), {
        denied: true,
      });
      assert.deepEqual(k.resolveModule(at('lib', 'notes.md'), 'require'), {
        denied: true,
      });
      assert.deepEqual(
        k.resolveModule(at('lib', 'util.js'), 'import'),
        { denied: true },
        'domain off',
      );
      assert.deepEqual(k.resolveModule(at('unknown', 'x.js'), 'require'), {
        denied: true,
      });
      assert.equal(
        k.resolveModule(at('d', 'x.js'), 'require'),
        null,
        'disk is managed passthrough',
      );
      assert.equal(
        k.resolveModule(at('lib', 'util.js'), 'require').key,
        '/util.js',
      );
    } finally {
      k.close();
    }
  });

  it('memory places are empty, per-kernel and writable', async () => {
    const k1 = await kernel(root, {
      mem: { provider: 'map', origin: 'virtual', fs: { writable: true } },
    });
    let k2 = null;
    try {
      k2 = await kernel(root, {
        mem: { provider: 'map', origin: 'virtual', fs: { writable: true } },
      });
      k1.fs('mem').writeFile('/x', '1');
      assert.equal(k2.fs('mem').exists('/x'), false);
      assert.equal(k1.fs('mem').readFile('/x', 'utf8'), '1');
    } finally {
      k1.close();
      k2?.close();
    }
  });
});

// Content without a disk file of its own never falls back to disk: what
// finds no room is refused as a real filesystem refuses such a write,
// named by the operation, whichever thread asked — a new key is not
// published, a replaced one keeps its version, and nothing is left behind.
// Two distinct refusals share that shape: ENOSPC when the pool merely has
// no room right now (this block), EFBIG when the content is larger than
// maxFileSize and could never fit whatever the pool's state (the next).
describe('VfsKernel: a full pool', () => {
  const MEMORY = { limit: '8 kib', segmentSize: '4 kib', maxFileSize: '4 kib' };

  const REASON = {
    ENOSPC: 'no space left on device',
    EFBIG: 'file too large',
  };

  // The refusal of `syscall` on `from` (and `to`); what did not fit is
  // its detail.
  const refusal = (code, syscall, from, to) => {
    const detail = 'canonical source does not fit in SAB';
    const ends = to === undefined ? `'${from}'` : `'${from}' -> '${to}'`;
    return {
      code,
      errno: -constants.errno[code],
      syscall,
      path: from,
      dest: to,
      message: `${code}: ${REASON[code]} (${detail}), ${syscall} ${ends}`,
    };
  };
  const noRoom = (syscall, from, to) => refusal('ENOSPC', syscall, from, to);
  const shape = (err) => ({
    code: err.code,
    errno: err.errno,
    syscall: err.syscall,
    path: err.path,
    dest: err.dest,
    message: err.message,
  });

  it('a virtual write or rename that does not fit is ENOSPC, in main and a worker', async () => {
    const root = tmpDir('kernel-full');
    const k = await kernel(
      root,
      { v: { origin: 'virtual', fs: { writable: true } } },
      { memory: MEMORY },
    );
    let w = null;
    try {
      const v = k.fs('v');
      await v.writeFile('/a', 'a'.repeat(4000));
      await v.writeFile('/b', 'b'.repeat(4000));
      w = worker(k);
      const updates = k.nextUpdateId;
      const version = k.cache.entry('v', '/a');
      const at = (key) => v.pathOf(key);
      for (const [label, place] of [
        ['main', v],
        ['worker', w.kernel.fs('v')],
      ]) {
        for (const [op, refused] of [
          [
            () => place.writeFile('/c', 'c'.repeat(2000)),
            noRoom('open', at('/c')),
          ],
          [
            () => place.writeFile('/a', 'A'.repeat(4000)),
            noRoom('open', at('/a')),
          ],
          [
            () => place.rename('/a', '/d'),
            noRoom('rename', at('/a'), at('/d')),
          ],
        ]) {
          await assert.rejects(op(), (err) => {
            assert.deepEqual(shape(err), refused, label);
            return true;
          });
        }
      }
      assert.equal(v.exists('/c'), false, 'not published');
      assert.equal(v.exists('/d'), false, 'not moved');
      assert.equal(k.cache.entry('v', '/a'), version, 'the version kept');
      assert.equal(v.readFile('/a', 'utf8'), 'a'.repeat(4000));
      assert.equal(w.kernel.fs('v').readFile('/a', 'utf8'), 'a'.repeat(4000));
      assert.equal(k.nextUpdateId, updates, 'nothing published');
      assert.equal(leakedBytes(k), 0, 'nothing left behind');
    } finally {
      w?.kernel.close();
      k.close();
      rm(root);
    }
  });

  // Three prepared sources, each 4000 bytes — well under maxFileSize (4096)
  // on its own — together need 12000 of the pool's 8192-byte limit: two
  // fit, the pool then has no room for the third. The scan's own order
  // (readdir, not sorted) decides which one — checked as membership, not a
  // fixed name — but the failure is always ENOSPC, never EFBIG.
  it('a prepared source fails initialize() with ENOSPC when the pool fills up', async () => {
    const root = writeTree(tmpDir('kernel-full-init'), {
      'app/a.txt': 'a',
      'app/b.txt': 'b',
      'app/c.txt': 'c',
    });
    try {
      const init = kernel(
        root,
        { app: { fs: { ext: ['txt'], prepare: 'grow' } } },
        { memory: MEMORY },
        { preparers: { grow: (raw) => raw.toString().repeat(4000) } },
      );
      const files = ['a.txt', 'b.txt', 'c.txt'].map((n) =>
        path.join(root, 'app', n),
      );
      await assert.rejects(init, (err) => {
        assert.ok(files.includes(err.path), `unexpected path ${err.path}`);
        assert.deepEqual(shape(err), noRoom('open', err.path));
        return true;
      });
    } finally {
      rm(root);
    }
  });
});

// EFBIG: the content is larger than maxFileSize and could never fit in one
// allocation, whatever the pool's state — distinct from ENOSPC, the pool
// merely having no room right now (the previous block). Same shape and the
// same "nothing published, nothing leaked" guarantees.
describe('VfsKernel: content larger than maxFileSize', () => {
  const MEMORY = { limit: '8 kib', segmentSize: '4 kib', maxFileSize: '4 kib' };

  const refusal = (syscall, from, to) => {
    const detail = 'canonical source does not fit in SAB';
    const ends = to === undefined ? `'${from}'` : `'${from}' -> '${to}'`;
    return {
      code: 'EFBIG',
      errno: -constants.errno.EFBIG,
      syscall,
      path: from,
      dest: to,
      message: `EFBIG: file too large (${detail}), ${syscall} ${ends}`,
    };
  };
  const shape = (err) => ({
    code: err.code,
    errno: err.errno,
    syscall: err.syscall,
    path: err.path,
    dest: err.dest,
    message: err.message,
  });

  it('a virtual write over maxFileSize is EFBIG, in main and a worker, with an empty pool', async () => {
    const root = tmpDir('kernel-toobig');
    const k = await kernel(
      root,
      { v: { origin: 'virtual', fs: { writable: true } } },
      { memory: MEMORY },
    );
    let w = null;
    try {
      const v = k.fs('v');
      w = worker(k);
      const updates = k.nextUpdateId;
      const at = (key) => v.pathOf(key);
      for (const [label, place] of [
        ['main', v],
        ['worker', w.kernel.fs('v')],
      ]) {
        await assert.rejects(
          place.writeFile('/big', 'x'.repeat(5000)),
          (err) => {
            assert.deepEqual(shape(err), refusal('open', at('/big')), label);
            return true;
          },
        );
      }
      assert.equal(v.exists('/big'), false, 'not published');
      assert.equal(k.nextUpdateId, updates, 'nothing published');
      assert.equal(leakedBytes(k), 0, 'nothing left behind');
    } finally {
      w?.kernel.close();
      k.close();
      rm(root);
    }
  });

  it('a prepared source over maxFileSize fails initialize() with EFBIG', async () => {
    const root = writeTree(tmpDir('kernel-toobig-init'), {
      'app/big.txt': 'x',
    });
    try {
      const init = kernel(
        root,
        { app: { fs: { ext: ['txt'], prepare: 'grow' } } },
        { memory: MEMORY },
        { preparers: { grow: () => 'x'.repeat(5000) } },
      );
      const file = path.join(root, 'app', 'big.txt');
      await assert.rejects(init, (err) => {
        assert.deepEqual(shape(err), refusal('open', file));
        return true;
      });
    } finally {
      rm(root);
    }
  });
});

describe('VfsKernel: snapshot, workers, ACK', () => {
  let root;
  before(() => {
    root = writeTree(tmpDir('kernel-snap'), {
      'site/a.txt': 'aaa',
      'site/b.js': 'module.exports = 2;',
    });
  });
  after(() => rm(root));

  const places = {
    site: { fs: true, require: true },
    mem: { provider: 'map', origin: 'virtual', fs: { writable: true } },
    d: { provider: 'disk', fs: true },
  };

  it('snapshot is keyed by place and fromSnapshot projects it read-only', async () => {
    const k = await kernel(root, places);
    let w = null;
    let empty = null;
    try {
      const snap = k.snapshot();
      assert.deepEqual(Object.keys(snap.places), ['site']);
      assert.ok(snap.segments.length >= 1);
      w = VfsKernel.fromSnapshot(snap, config(places), { appRoot: root });
      assert.equal(w.state, 'ready');
      assert.equal(w.fs('site').readFile('/a.txt', 'utf8'), 'aaa');
      assert.ok(w.bytecode(path.join(root, 'site', 'b.js')));
      assert.throws(() => w.fs('site').readFileView('/a.txt'), {
        code: 'ENOTSUP',
      });
      assert.throws(() => w.snapshot(), /main-thread only/);
      assert.throws(() => w.fs('site').writeFile('/x', 'y'), { code: 'EROFS' });
      w.fs('mem').writeFile('/m', 'm');
      assert.equal(w.fs('mem').readFile('/m', 'utf8'), 'm');
      assert.equal(k.fs('mem').exists('/m'), false);
      empty = VfsKernel.fromSnapshot(null, config(places), {
        appRoot: root,
      });
      assert.equal(empty.fs('site').exists('/a.txt'), false);
    } finally {
      k.close();
      w?.close();
      empty?.close();
    }
  });

  it('handleDelta applies vfs-update entries and removals', async () => {
    const k = await kernel(root, places);
    let w = null;
    try {
      w = VfsKernel.fromSnapshot(k.snapshot(), config(places), {
        appRoot: root,
      });
      const entry = await k.cache.allocate({
        data: Buffer.from('new'),
        stat: { size: 3, mtimeMs: 1 },
      });
      const { sab } = k.cache.getSegment(entry.segmentId);
      w.handleDelta({
        name: 'vfs-update',
        updateId: 1,
        places: {
          site: { entries: [['/new.txt', entry]], removals: ['/a.txt'] },
        },
        newSegments: [{ id: entry.segmentId, sab }],
      });
      assert.equal(w.fs('site').readFile('/new.txt', 'utf8'), 'new');
      assert.equal(w.fs('site').exists('/a.txt'), false);
      assert.deepEqual(w.handleDelta({ name: 'other' }), []);
    } finally {
      k.close();
      w?.close();
    }
  });

  it('frees only after every worker ACKed or exited; repeated ACKs are harmless', async () => {
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    try {
      const w1 = tap(k, { ack: false });
      const w2 = tap(k, { ack: false });
      let freed = 0;
      const originalFree = k.cache.free.bind(k.cache);
      k.cache.free = (entry) => {
        freed++;
        originalFree(entry);
      };
      const v = k.fs('v');
      await v.writeFile('/a.txt', 'one');
      await v.writeFile('/a.txt', 'two');
      const updateId = k.nextUpdateId;
      assert.deepEqual([...k.acks.get(updateId).pending], [w1.id, w2.id]);
      assert.equal(k.retired.size, 1);
      k.handleAck(updateId, w1.id);
      assert.equal(freed, 0);
      k.handleAck(updateId, w1.id);
      assert.equal(freed, 0);
      k.handleWorkerExit(w2.id);
      assert.equal(freed, 1);
      k.handleAck(updateId, w2.id);
      k.handleAck(99, w1.id);
      assert.equal(freed, 1, 'nothing is freed twice');
      assert.equal(k.acks.size, 0);
      assert.equal(k.retired.size, 0);
    } finally {
      k.close();
    }
  });

  it('worker exit during compaction frees relocated bytes', async () => {
    const KB = 1024;
    const empty = writeTree(tmpDir('kernel-compact'), {});
    const k = await kernel(
      empty,
      { v: { origin: 'virtual', fs: { writable: true } } },
      {
        memory: {
          limit: '16 kib',
          segmentSize: '4 kib',
          maxFileSize: '4 kib',
        },
        compaction: { threshold: 0.5 },
      },
    );
    try {
      const v = k.fs('v');
      await v.writeFile('/a', Buffer.alloc(2 * KB, 'a'));
      await v.writeFile('/b', Buffer.alloc(2 * KB, 'b'));
      await v.writeFile('/c', Buffer.alloc(200, 'c'));
      assert.equal(k.cache.entry('v', '/b').segmentId, 1);
      assert.equal(k.cache.entry('v', '/c').segmentId, 2);
      const w = tap(k, { ack: false });
      await v.unlink('/a');
      assert.equal(k.retired.size, 1, '/a waits for the ACK');
      const port = k.links.get(w.id);
      const closed = nextEvent(port, 'close');
      w.port.close();
      await closed;
      assert.equal(k.cache.entry('v', '/c').segmentId, 1, '/c was relocated');
      assert.equal(v.readFile('/c', 'utf8'), 'c'.repeat(200));
      assert.equal(
        k.acks.size,
        0,
        'the exited worker is not waited on for the compaction ACK',
      );
      assert.equal(k.retired.size, 0);
    } finally {
      k.close();
      rm(empty);
    }
  });

  it('link() + attach(): a worker gets the projection, deltas and ACKs them', async () => {
    const k = await kernel(root, places, { watchTimeout: 50, watch: true });
    let worker = null;
    try {
      const { vfs, transferList } = k.link();
      assert.equal(k.links.size, 1);
      const script = `
        const { parentPort } = require('node:worker_threads');
        const { attach, kernel: before } = require(${JSON.stringify(path.resolve(__dirname, '..'))});
        const kernel = attach();
        const { kernel: after } = require(${JSON.stringify(path.resolve(__dirname, '..'))});
        const site = kernel.fs('site');
        parentPort.on('message', (m) => {
          if (m === 'read') parentPort.postMessage(site.readFile('/a.txt', 'utf8'));
          if (m === 'exit') process.exit(0);
        });
        parentPort.postMessage([before, after === kernel, site.readFile('/a.txt', 'utf8')]);
      `;
      worker = new Worker(script, {
        eval: true,
        workerData: { vfs },
        transferList,
      });
      const messages = [];
      worker.on('message', (m) => messages.push(m));
      const acks = [];
      const port = [...k.links.values()][0];
      port.on('message', (m) => acks.push(m));
      const errors = [];
      worker.on('error', (e) => errors.push(e));
      await until(() => messages.length === 1 || errors.length > 0);
      assert.deepEqual(errors, []);
      assert.deepEqual(messages, [[null, true, 'aaa']]);
      // Anything that is not a delta must not produce an ACK. The port keeps
      // order: the ping reaches the worker before the delta below, so an ACK
      // for it would arrive first and break the "exactly one ACK" check.
      port.postMessage({ name: 'ping' });
      // Change the file: the delta must reach the worker and be ACKed.
      require('node:fs').writeFileSync(
        path.join(root, 'site', 'a.txt'),
        'AAAA',
      );
      await until(() => k.fs('site').readFile('/a.txt', 'utf8') === 'AAAA');
      await until(() => k.acks.size === 0, 3000);
      assert.equal(k.acks.size, 0, 'worker ACKed the update');
      assert.deepEqual(
        acks.map((m) => m.name),
        ['vfs-ack'],
        'exactly one ACK, only for the delta',
      );
      worker.postMessage('read');
      await until(() => messages.length === 2);
      assert.equal(messages[1], 'AAAA');
      worker.postMessage('exit');
      await until(() => k.links.size === 0);
      assert.equal(k.links.size, 0, 'worker exit closed the link');
    } finally {
      await worker?.terminate();
      k.close();
    }
  });
});
