'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { VfsKernel } = require('../lib/kernel.js');
const fsPatch = require('../lib/adapters/fs-patch.js');
const {
  tmpDir,
  writeTree,
  rm,
  config,
  kernel,
  quiet,
  worker,
  assertAtRest,
  activeResources,
  closeAtRest,
  until,
  within,
} = require('./helpers.js');

// A failure, and a refusal, leave nothing behind: no allocation, no queued
// mutation or barrier, no key in flight, no unanswered request of a worker,
// and — once the kernel is closed — no open port and no handle. Every
// refusal and failure the mutations of a virtual place meet, in the main
// thread and in a worker, through their facades and through node:fs; a
// failed initialize(); a failed watcher publication.

const INDEX = path.resolve(__dirname, '../index.js');

const PREPARERS = {
  // Throws for 'boom', with a code that crosses to a worker.
  up: (raw) => {
    const text = raw.toString();
    if (text === 'boom') {
      throw Object.assign(new Error('preparer failed'), { code: 'EBOOM' });
    }
    return text.toUpperCase();
  },
  // Bytes the SAB sink places at once, then extras no preparer may return:
  // the placed bytes are rolled back.
  placed: (raw) => ({
    source: new Uint8Array(raw.length).fill(7),
    scriptOptions: { cachedData: true },
  }),
};

const PLACES = {
  v: { origin: 'virtual', fs: { writable: true } },
  p: { origin: 'virtual', fs: { writable: true, ext: ['txt'], prepare: 'up' } },
  s: { origin: 'virtual', fs: { writable: true, script: { compile: ['js'] } } },
  u: {
    origin: 'virtual',
    fs: { writable: true, ext: ['bin'], prepare: 'placed' },
  },
};

// What is published before the failures, in each place.
const CONTENT = {
  v: { '/f': 'f', '/d/x': 'x', '/e/y': 'y' },
  p: { '/a.txt': 'a' },
  s: { '/ok.js': 'module.exports = 1;' },
};

const BIG = Buffer.alloc(70 * 1024, 1); // above maxFileSize: too large for SAB

// [what, place, run over its PlaceFs, the code it fails with]
const FAILURES = [
  ['a write under a file', 'v', (f) => f.writeFile('/f/x', 'x'), 'ENOTDIR'],
  ['a write onto a directory', 'v', (f) => f.writeFile('/d', 'x'), 'EISDIR'],
  [
    'an exclusive write onto a file',
    'v',
    (f) => f.writeFile('/f', 'x', { flag: 'wx' }),
    'EEXIST',
  ],
  ['a write too large for SAB', 'v', (f) => f.writeFile('/big', BIG), 'EFBIG'],
  [
    'a write its preparer fails',
    'p',
    (f) => f.writeFile('/b.txt', 'boom'),
    'EBOOM',
  ],
  [
    'a write whose prepared bytes are placed, then refused',
    'u',
    (f) => f.writeFile('/x.bin', 'x'.repeat(100)),
    'scriptOptions.cachedData is reserved',
  ],
  [
    'a write that does not compile',
    's',
    (f) => f.writeFile('/bad.js', 'function ('),
    'ENOTSUP',
  ],
  [
    'an append to a prepared source',
    'p',
    (f) => f.appendFile('/a.txt', '!'),
    'ENOTSUP',
  ],
  ['an append too large for SAB', 'v', (f) => f.appendFile('/f', BIG), 'EFBIG'],
  ['a rename of nothing', 'v', (f) => f.rename('/none', '/n2'), 'ENOENT'],
  [
    'a rename of a prepared source',
    'p',
    (f) => f.rename('/a.txt', '/c.txt'),
    'ENOTSUP',
  ],
  [
    'a directory renamed into itself',
    'v',
    (f) => f.rename('/d', '/d/in'),
    'EINVAL',
  ],
  [
    'a directory renamed onto another',
    'v',
    (f) => f.rename('/d', '/e'),
    'ENOTEMPTY',
  ],
  ['an rm of nothing', 'v', (f) => f.rm('/none'), 'ENOENT'],
  ['an rm of a directory', 'v', (f) => f.rm('/d'), 'ERR_FS_EISDIR'],
  ['an unlink of a directory', 'v', (f) => f.unlink('/d'), 'EISDIR'],
  ['a mkdir of a file', 'v', (f) => f.mkdir('/f'), 'EEXIST'],
  ['a mkdir under a file', 'v', (f) => f.mkdir('/f/g'), 'ENOTDIR'],
  // Sets of writeFiles, refused whole: a file of the set before the one
  // refused is never published, and nothing of it stays.
  [
    'a set with a key under another of it',
    'v',
    (f) =>
      f.writeFiles([
        ['/n', 'n'],
        ['/n/x', 'x'],
      ]),
    'ENOTDIR',
  ],
  [
    'a set with a key under a file',
    'v',
    (f) =>
      f.writeFiles([
        ['/g', 'g'],
        ['/f/x', 'x'],
      ]),
    'ENOTDIR',
  ],
  [
    'a set with a key onto a directory',
    'v',
    (f) =>
      f.writeFiles([
        ['/g', 'g'],
        ['/d', 'x'],
      ]),
    'EISDIR',
  ],
  [
    'an exclusive set with a key onto a file',
    'v',
    (f) =>
      f.writeFiles(
        [
          ['/g', 'g'],
          ['/f', 'x'],
        ],
        { flag: 'wx' },
      ),
    'EEXIST',
  ],
  [
    'a set with a file too large for SAB',
    'v',
    (f) =>
      f.writeFiles([
        ['/g', 'g'],
        ['/big', BIG],
      ]),
    'EFBIG',
  ],
  [
    'a set whose preparer fails on its last file',
    'p',
    (f) =>
      f.writeFiles([
        ['/c.txt', 'c'],
        ['/b.txt', 'boom'],
      ]),
    'EBOOM',
  ],
  [
    'a set whose prepared bytes are placed, then refused',
    'u',
    (f) => f.writeFiles([['/y.bin', 'y'.repeat(100)]]),
    'scriptOptions.cachedData is reserved',
  ],
  [
    'a set with a file that does not compile',
    's',
    (f) =>
      f.writeFiles([
        ['/ok2.js', 'x = 1;'],
        ['/bad.js', 'function ('],
      ]),
    'ENOTSUP',
  ],
];

// The code a call fails with — or, for an error without one, the end of
// its message — or 'ok'.
const codeOf = async (fn) => {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    return err.code ?? err.message.split(': ').at(-1);
  }
};

// The keys each place publishes, sorted.
const published = (k) =>
  Object.fromEntries(
    k.registry
      .all()
      .map((place) => [place.name, [...place.files.keys()].sort()]),
  );

// A kernel over PLACES with CONTENT published and the patch installed;
// `baseline` is what kept the event loop alive before it.
const setup = async (defaults = {}) => {
  const baseline = activeResources();
  const root = tmpDir('vfs-rest');
  const outside = writeTree(tmpDir('vfs-rest-out'), { 'o.txt': 'outside' });
  fs.writeFileSync(path.join(outside, 'big'), BIG);
  const k = await kernel(root, PLACES, defaults, { preparers: PREPARERS });
  for (const [name, files] of Object.entries(CONTENT)) {
    for (const [key, text] of Object.entries(files)) {
      await k.fs(name).writeFile(key, text);
    }
  }
  const at = (...p) => path.join(root, ...p);
  const done = () => {
    fsPatch.uninstall();
    k.close();
    rm(root);
    rm(outside);
  };
  return { k, at, outside, baseline, done };
};

describe('a kernel at rest after failures', () => {
  it('each failed mutation, in the main thread and a worker, leaves nothing', async () => {
    const { k, baseline, done } = await setup();
    const w = worker(k);
    try {
      const before = published(k);
      const updates = k.nextUpdateId;
      for (const [label, fsOf] of [
        ['main', (name) => k.fs(name)],
        ['worker', (name) => w.kernel.fs(name)],
      ]) {
        for (const [what, name, run, code] of FAILURES) {
          const got = await codeOf(() => run(fsOf(name)));
          assert.equal(got, code, `${label}: ${what}`);
          await assertAtRest(k, { workers: [w.kernel] });
        }
      }
      assert.equal(k.nextUpdateId, updates, 'nothing published');
      assert.deepEqual(published(k), before, 'nothing changed');
      await closeAtRest(k, { workers: [w.kernel], baseline });
    } finally {
      w.kernel.close();
      done();
    }
  });

  // Two segments of 4 KiB, 6000 bytes in them: no room for a copy of the
  // subtree, nor for 3 KiB more, though no file is too large for SAB.
  it('a write and a subtree rename the pool has no room for leave nothing', async () => {
    const baseline = activeResources();
    const root = tmpDir('vfs-rest-full');
    const memory = {
      limit: '8 kib',
      segmentSize: '4 kib',
      maxFileSize: '4 kib',
    };
    const k = await kernel(root, { v: PLACES.v }, { memory });
    const w = worker(k);
    try {
      for (const key of ['/d/a', '/d/b', '/d/c']) {
        await k.fs('v').writeFile(key, key.repeat(500));
      }
      for (const place of [k.fs('v'), w.kernel.fs('v')]) {
        assert.equal(await codeOf(() => place.rename('/d', '/e')), 'ENOSPC');
        await assertAtRest(k, { workers: [w.kernel] });
        const more = Buffer.alloc(3 * 1024, 1);
        assert.equal(await codeOf(() => place.writeFile('/m', more)), 'ENOSPC');
        await assertAtRest(k, { workers: [w.kernel] });
      }
      await closeAtRest(k, { workers: [w.kernel], baseline });
    } finally {
      w.kernel.close();
      k.close();
      rm(root);
    }
  });

  it('each failed copy through node:fs leaves nothing', async () => {
    const { k, at, outside, baseline, done } = await setup();
    fsPatch.install(k);
    try {
      const from = path.join(outside, 'o.txt');
      const { COPYFILE_EXCL } = fs.constants;
      for (const [what, run, code] of [
        [
          'onto a file, exclusively',
          () => fs.promises.copyFile(from, at('v', 'f'), COPYFILE_EXCL),
          'EEXIST',
        ],
        [
          'onto a file, erroring on it',
          () =>
            fs.promises.cp(from, at('v', 'f'), {
              force: false,
              errorOnExist: true,
            }),
          'ERR_FS_CP_EEXIST',
        ],
        [
          'under a file',
          () => fs.promises.copyFile(from, at('v', 'f', 'x')),
          'ENOTDIR',
        ],
        [
          'of a prepared source',
          () => fs.promises.copyFile(at('p', 'a.txt'), at('v', 'c.txt')),
          'ENOTSUP',
        ],
        [
          'too large for SAB',
          () => fs.promises.copyFile(path.join(outside, 'big'), at('v', 'big')),
          'EFBIG',
        ],
        [
          'its preparer fails',
          async () => {
            fs.writeFileSync(from, 'boom');
            await fs.promises.copyFile(from, at('p', 'b.txt'));
          },
          'EBOOM',
        ],
        [
          'synchronous, into a place that cannot block',
          () => fs.copyFileSync(from, at('v', 'z')),
          'ENOTSUP',
        ],
      ]) {
        assert.equal(await codeOf(run), code, what);
        await assertAtRest(k);
      }
      fsPatch.uninstall();
      await closeAtRest(k, { baseline });
    } finally {
      done();
    }
  });

  // A worker thread fails the same mutations through its own node:fs: they
  // travel to the main kernel as requests, and each is answered.
  it('failed node:fs calls in a worker thread leave nothing on either side', async () => {
    const { k, outside, baseline, done } = await setup();
    const WORKER = `
      const { parentPort, workerData } = require('node:worker_threads');
      const fs = require('node:fs');
      const path = require('node:path');
      const kernel = require(${JSON.stringify(INDEX)}).attach();
      const at = (...p) => path.join(kernel.appRoot, ...p);
      const { COPYFILE_EXCL } = fs.constants;
      const calls = [
        () => fs.promises.writeFile(at('v', 'f', 'x'), 'x'),
        () => fs.promises.writeFile(at('v', 'big'), Buffer.alloc(70 * 1024)),
        () => fs.promises.writeFile(at('p', 'b.txt'), 'boom'),
        () => fs.promises.appendFile(at('p', 'a.txt'), '!'),
        () => fs.promises.copyFile(workerData.from, at('v', 'f'), COPYFILE_EXCL),
        () => fs.promises.copyFile(at('p', 'a.txt'), at('v', 'c.txt')),
        () => fs.promises.rename(at('v', 'none'), at('v', 'n2')),
        () => fs.promises.rename(at('v', 'd'), at('v', 'e')),
        () => fs.promises.rm(at('v', 'd')),
        () => fs.promises.unlink(at('v', 'd')),
        () => fs.promises.mkdir(at('v', 'f')),
      ];
      (async () => {
        const codes = [];
        for (const call of calls) {
          try {
            await call();
            codes.push('ok');
          } catch (err) {
            codes.push(err.code ?? err.message);
          }
        }
        parentPort.postMessage({ codes, pending: kernel.mutationClient.pending });
      })();
    `;
    let thread = null;
    try {
      const before = published(k);
      const { vfs, transferList } = k.link();
      thread = new Worker(WORKER, {
        eval: true,
        workerData: { vfs, from: path.join(outside, 'o.txt') },
        transferList,
      });
      const report = await within(
        new Promise((resolve, reject) => {
          thread.once('message', resolve);
          thread.once('error', reject);
          thread.once('exit', (code) => reject(new Error(`exit ${code}`)));
        }),
        'the report of the worker',
      );
      assert.deepEqual(report, {
        codes: [
          'ENOTDIR',
          'EFBIG',
          'EBOOM',
          'ENOTSUP',
          'EEXIST',
          'ENOTSUP',
          'ENOENT',
          'ENOTEMPTY',
          'ERR_FS_EISDIR',
          'EISDIR',
          'EEXIST',
        ],
        pending: 0,
      });
      await assertAtRest(k);
      assert.deepEqual(published(k), before, 'nothing changed');
      await thread.terminate();
      thread = null;
      await closeAtRest(k, { baseline });
    } finally {
      await thread?.terminate();
      done();
    }
  });

  // initialize() fails: the kernel closes, and what it opened with it.
  for (const [what, prepare, content, message] of [
    ['an unreadable source', null, 'a', /unreadable/],
    ['a preparer that fails', 'up', 'boom', /preparer failed/],
    ['a prepared source too large for SAB', 'big', 'a', /EFBIG/],
  ]) {
    it(`a failed initialize(), ${what}, leaves nothing open`, async () => {
      const baseline = activeResources();
      const root = writeTree(tmpDir('vfs-rest-init'), {
        'site/a.txt': content,
        'site/b.txt': 'b',
      });
      const preparers = { ...PREPARERS, big: () => BIG };
      const site = prepare
        ? { fs: { ext: ['txt'], prepare, writable: true } }
        : { fs: { ext: ['txt'], writable: true } };
      const k = new VfsKernel(config({ site }), {
        appRoot: root,
        console: quiet,
        preparers,
      });
      try {
        const init = k.initialize();
        if (!prepare) {
          k.cache.reader = async () => {
            throw new Error('unreadable');
          };
        }
        await assert.rejects(init, message);
        assert.equal(k.state, 'closed');
        assert.equal(k.cache, null, 'the pool is gone');
        assert.equal(k.mutations.size, 0);
        assert.equal(k.watcher, null, 'no watcher started');
        await closeAtRest(k, { baseline });
      } finally {
        k.close();
        rm(root);
      }
    });
  }

  // A watcher publication its preparer fails keeps the previous version and
  // schedules its one recheck; close() drops it.
  it('a failed watcher publication leaves its recheck only, until close()', async () => {
    const baseline = activeResources();
    const root = writeTree(tmpDir('vfs-rest-watch'), { 'site/a.txt': 'a' });
    const k = await kernel(
      root,
      { site: { fs: { ext: ['txt'], prepare: 'up' } } },
      { watch: true, watchTimeout: 60000 },
      { preparers: PREPARERS },
    );
    try {
      const file = path.join(root, 'site', 'a.txt');
      fs.writeFileSync(file, 'boom');
      k.watcher.emit('epoch', new Map([[file, 'change']]));
      await k.watchQueue.idle;
      assert.equal(k.fs('site').readFile('/a.txt', 'utf8'), 'A', 'kept');
      await assertAtRest(k, { rechecks: 1 });
      await closeAtRest(k, { baseline });
      assert.ok(
        await until(() => k.watchQueue.size === 0, 1000),
        'no epoch left',
      );
    } finally {
      k.close();
      rm(root);
    }
  });
});
