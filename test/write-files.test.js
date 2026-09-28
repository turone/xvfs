'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bytecodeKey } = require('../lib/companion.js');
const {
  tmpDir,
  writeTree,
  rm,
  kernel,
  worker,
  nextMessage,
  leakedBytes,
} = require('./helpers.js');

// writeFiles: several files of a virtual place published as one. The set
// is checked whole before any file is prepared, each file is prepared
// once, and it is published in one commit — one update, one version, one
// event, one mtime — or not at all: nothing staged stays, nothing is
// seen half done.

const VIRTUAL = { v: { origin: 'virtual', fs: { writable: true } } };

// The 'publish' events of `k` from now on.
const record = (k) => {
  const events = [];
  k.on('publish', (event) => events.push(event));
  return events;
};

// The refusal of a set about `key`.
const refused = (place, code, key) => (err) => {
  assert.equal(err.code, code, err.message);
  assert.equal(err.syscall, 'writeFiles');
  assert.equal(err.path, place.pathOf(key));
  return true;
};

// `promise`, or a failure after `ms`: a test waiting at a gate its
// publication never reaches fails instead of hanging.
const within = (promise, what, ms = 5000) =>
  new Promise((resolve, reject) => {
    const late = setTimeout(() => {
      reject(new Error(`no ${what} within ${ms} ms`));
    }, ms);
    promise.finally(() => clearTimeout(late)).then(resolve, reject);
  });

// The queue drops the locks of a mutation a few microtasks after its
// promise settles: once every microtask queued so far has run.
const released = () => new Promise((resolve) => setImmediate(resolve));

// Date.now() one millisecond later at each call, for the length of `fn`:
// what reads it twice within one publication cannot hide it.
const ticking = async (fn) => {
  const now = Date.now;
  let time = now();
  Date.now = () => time++;
  try {
    return await fn();
  } finally {
    Date.now = now;
  }
};

describe('writeFiles: one publication', () => {
  it('a set of a sab place: one update, one version, one event, one mtime', async () => {
    const root = tmpDir('vfs-batch');
    const k = await kernel(root, {
      v: {
        origin: 'virtual',
        fs: { writable: true },
        require: { compile: true },
      },
    });
    const w = worker(k);
    try {
      const v = k.fs('v');
      const events = record(k);
      const delivered = nextMessage(w.port);
      const version = await ticking(() =>
        v.writeFiles([
          ['/a.js', 'exports.a = 1;'],
          ['/lib/b.js', Buffer.from('exports.b = 2;')],
          ['c.txt', new Uint8Array([99])],
        ]),
      );
      const keys = ['/a.js', '/lib/b.js', '/c.txt'];
      assert.equal(version, 1);
      assert.equal(k.version, 1);
      assert.equal(k.nextUpdateId, 1, 'one update');
      const update = await delivered;
      assert.deepEqual(
        update.places.v.entries.map(([key]) => key),
        [
          '/a.js',
          bytecodeKey('/a.js'),
          '/lib/b.js',
          bytecodeKey('/lib/b.js'),
          '/c.txt',
        ],
        'every file and companion',
      );
      for (const key of keys) assert.equal(v.version(key), 1, key);
      const mtimes = new Set(keys.map((key) => v.stat(key).mtimeMs));
      assert.equal(mtimes.size, 1, 'one mtime');
      assert.equal(v.readFile('/c.txt', 'utf8'), 'c');
      const bundle = w.kernel.fs('v');
      assert.equal(bundle.readFile('/lib/b.js', 'utf8'), 'exports.b = 2;');
      assert.equal(bundle.version('/lib/b.js'), 1, 'the same in a worker');
      assert.deepEqual(events, [
        {
          version: 1,
          places: { v: { created: keys, replaced: [], removed: [] } },
        },
      ]);
      // An object, a Map; replaced and created keys in one set.
      assert.equal(
        await v.writeFiles({ '/a.js': 'exports.a = 3;', d: 'd' }),
        2,
      );
      assert.equal(await v.writeFiles(new Map([['/c.txt', 'C']])), 3);
      assert.deepEqual(
        events.slice(1).map((event) => event.places.v),
        [
          { created: ['/d'], replaced: ['/a.js'], removed: [] },
          { created: [], replaced: ['/c.txt'], removed: [] },
        ],
      );
      // The bytes are taken when it is called.
      const bytes = Buffer.from('first');
      const written = v.writeFiles([['/e.txt', bytes]], 'utf8');
      bytes.write('xxxxx');
      await written;
      assert.equal(v.readFile('/e.txt', 'utf8'), 'first');
      await released();
      assert.equal(k.mutations.size, 0);
      assert.equal(leakedBytes(k), 0);
    } finally {
      w.kernel.close();
      k.close();
      rm(root);
    }
  });

  it('its arguments are checked when it is called: nothing is queued', async () => {
    const root = tmpDir('vfs-batch');
    const k = await kernel(root, VIRTUAL);
    try {
      const v = k.fs('v');
      for (const [what, call] of [
        ['no file', () => v.writeFiles([])],
        ['an empty object', () => v.writeFiles({})],
        ['an empty Map', () => v.writeFiles(new Map())],
        ['a string', () => v.writeFiles('/a.txt')],
        ['null', () => v.writeFiles(null)],
        ['a pair that is none', () => v.writeFiles([42])],
        [
          'a key twice',
          () =>
            v.writeFiles([
              ['/a', 'a'],
              ['a', 'b'],
            ]),
        ],
        ['an invalid key', () => v.writeFiles([['/a/../b', 'a']])],
        ['a key that is no string', () => v.writeFiles([[42, 'a']])],
        ['a number as data', () => v.writeFiles([['/a', 42]])],
        ['a removal', () => v.writeFiles({ '/a': null })],
      ]) {
        assert.throws(call, TypeError, what);
        assert.equal(k.mutations.size, 0, what);
      }
      assert.throws(
        () =>
          v.writeFiles([
            ['/a', 'a'],
            ['/', 'x'],
          ]),
        refused(v, 'EISDIR', '/'),
      );
      assert.throws(
        () =>
          v.writeFiles([
            ['/a', 'a'],
            ['/d/', 'x'],
          ]),
        refused(v, 'EISDIR', '/d'),
      );
      assert.equal(k.mutations.size, 0);
      assert.equal(k.version, 0);
      assert.deepEqual(v.readdir('/'), []);
    } finally {
      k.close();
      rm(root);
    }
  });

  it('a read-only place is EROFS; a disk-origin place, and a flag that does not replace or create, ENOTSUP', async () => {
    const root = writeTree(tmpDir('vfs-batch'), {
      'ro/a.txt': 'a',
      'wd/a.txt': 'a',
    });
    const k = await kernel(root, {
      ro: { fs: true },
      wd: { fs: { writable: true } },
      ...VIRTUAL,
    });
    try {
      const files = [['/n.txt', 'n']];
      const ro = k.fs('ro');
      assert.throws(() => ro.writeFiles(files), {
        code: 'EROFS',
        syscall: 'writeFiles',
        path: ro.root,
      });
      const wd = k.fs('wd');
      assert.throws(() => wd.writeFiles(files), {
        code: 'ENOTSUP',
        syscall: 'writeFiles',
        path: wd.root,
        message: `ENOTSUP: operation not supported (disk-origin place), writeFiles '${wd.root}'`,
      });
      assert.equal(fs.existsSync(path.join(root, 'wd', 'n.txt')), false);
      const v = k.fs('v');
      for (const flag of ['a', 'a+', 'r', 'r+']) {
        assert.throws(() => v.writeFiles(files, { flag }), {
          code: 'ENOTSUP',
          syscall: 'writeFiles',
          path: v.root,
          message: `ENOTSUP: operation not supported (flag ${flag}), writeFiles '${v.root}'`,
        });
      }
      assert.equal(k.mutations.size, 0);
      assert.equal(k.version, 1, 'init');
      assert.equal(await v.writeFiles(files, { flag: 'w+' }), 2);
      await assert.rejects(
        v.writeFiles(files, { flag: 'xw' }),
        refused(v, 'EEXIST', '/n.txt'),
      );
    } finally {
      k.close();
      rm(root);
    }
  });
});

describe('writeFiles: all or nothing', () => {
  it('the set keeps the hierarchy — of the place and within itself — or nothing is published', async () => {
    const root = tmpDir('vfs-batch');
    const k = await kernel(root, VIRTUAL);
    try {
      const v = k.fs('v');
      await v.writeFile('/f', 'file');
      await v.writeFile('/dir/x', 'x');
      const version = k.version;
      const events = record(k);
      for (const [files, options, code, key] of [
        [
          [
            ['/a', 'a'],
            ['/a/b', 'b'],
          ],
          {},
          'ENOTDIR',
          '/a/b',
        ],
        [
          [
            ['/a/b', 'b'],
            ['/a', 'a'],
          ],
          {},
          'ENOTDIR',
          '/a/b',
        ],
        [
          [
            ['/a/b/c', 'c'],
            ['/a', 'a'],
          ],
          {},
          'ENOTDIR',
          '/a/b/c',
        ],
        [
          [
            ['/n', 'n'],
            ['/f/y', 'y'],
          ],
          {},
          'ENOTDIR',
          '/f/y',
        ],
        [
          [
            ['/n', 'n'],
            ['/dir', 'd'],
          ],
          {},
          'EISDIR',
          '/dir',
        ],
        [
          [
            ['/n', 'n'],
            ['/m', 'm'],
            ['/f', 'F'],
          ],
          { flag: 'wx' },
          'EEXIST',
          '/f',
        ],
        [
          [
            ['/n', 'n'],
            ['/dir', 'd'],
          ],
          { flag: 'wx' },
          'EEXIST',
          '/dir',
        ],
      ]) {
        await assert.rejects(
          v.writeFiles(files, options),
          refused(v, code, key),
          `${code} ${key}`,
        );
      }
      assert.deepEqual(v.readdir('/', { recursive: true }), [
        'dir',
        'dir/x',
        'f',
      ]);
      assert.equal(v.readFile('/f', 'utf8'), 'file');
      assert.equal(k.version, version);
      assert.deepEqual(events, []);
      assert.equal(leakedBytes(k), 0);
      await released();
      assert.equal(k.mutations.size, 0);
    } finally {
      k.close();
      rm(root);
    }
  });

  it('each preparer runs once; one that throws refuses the set with its error, and nothing stays', async () => {
    const root = tmpDir('vfs-batch');
    let calls = 0;
    let failing = null;
    // Bytes, which the SAB sink places as the preparer returns them, or a
    // string, which the publication places.
    const upper = (raw, file) => {
      calls++;
      if (file.key === failing) throw new Error(`cannot prepare ${file.key}`);
      const text = raw.toString().toUpperCase();
      return file.key === '/a.txt' ? new Uint8Array(Buffer.from(text)) : text;
    };
    const k = await kernel(
      root,
      {
        v: {
          origin: 'virtual',
          fs: { writable: true, ext: ['txt'], prepare: 'upper' },
        },
      },
      {},
      { preparers: { upper } },
    );
    try {
      const v = k.fs('v');
      const place = k.registry.get('v');
      const files = [
        ['/a.txt', 'a'],
        ['/b.txt', 'b'],
        ['/c.txt', 'c'],
      ];
      assert.equal(await v.writeFiles(files), 1);
      assert.equal(calls, 3, 'once per file');
      assert.equal(v.readFile('/a.txt', 'utf8'), 'A');
      assert.equal(v.readFile('/c.txt', 'utf8'), 'C');
      const events = record(k);
      calls = 0;
      // Refused by the hierarchy: before any preparer runs.
      await assert.rejects(
        v.writeFiles([
          ['/x.txt', 'x'],
          ['/x.txt/y.txt', 'y'],
        ]),
        refused(v, 'ENOTDIR', '/x.txt/y.txt'),
      );
      assert.equal(calls, 0, 'nothing prepared');
      failing = '/f.txt';
      await assert.rejects(
        v.writeFiles([
          ['/a.txt', 'x'],
          ['/d.txt', 'd'],
          ['/f.txt', 'f'],
          ['/g.txt', 'g'],
        ]),
        { message: 'cannot prepare /f.txt' },
      );
      assert.equal(calls, 3, 'the files before it, and it');
      assert.equal(place.preparationFailures, 1);
      assert.equal(v.readFile('/a.txt', 'utf8'), 'A', 'the version kept');
      assert.equal(v.exists('/d.txt'), false);
      assert.equal(k.version, 1);
      assert.deepEqual(events, []);
      assert.equal(leakedBytes(k), 0, 'what the files before it placed');
      await released();
      assert.equal(k.mutations.size, 0);
    } finally {
      k.close();
      rm(root);
    }
  });

  it('a pool without room for a file, or a file too large, refuses the set: ENOSPC or EFBIG about it, nothing left', async () => {
    const root = tmpDir('vfs-batch');
    const k = await kernel(root, VIRTUAL, {
      memory: { limit: '8 kib', segmentSize: '4 kib', maxFileSize: '4 kib' },
    });
    try {
      const v = k.fs('v');
      const big = (c) => Buffer.alloc(3000, c);
      for (const [code, files, key] of [
        ['ENOSPC', [['/c', big('c')]], '/c'],
        ['EFBIG', [['/d', Buffer.alloc(5000, 'd')]], '/d'],
      ]) {
        await assert.rejects(
          v.writeFiles([['/a', big('a')], ['/b', big('b')], ...files]),
          (err) => {
            refused(v, code, key)(err);
            assert.match(err.message, /canonical source does not fit in SAB/);
            return true;
          },
          code,
        );
      }
      assert.equal(v.exists('/a'), false);
      assert.equal(k.version, 0);
      assert.equal(leakedBytes(k), 0);
      assert.equal(k.cache.usage().used, 0, 'the pool is empty again');
      assert.equal(
        await v.writeFiles([
          ['/a', big('a')],
          ['/b', big('b')],
        ]),
        1,
      );
    } finally {
      k.close();
      rm(root);
    }
  });

  it('a script source that does not compile refuses the set: ENOTSUP about it', async () => {
    const root = tmpDir('vfs-batch');
    const script = { writable: true, script: { ext: ['js'] } };
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: script },
      m: { provider: 'map', origin: 'virtual', fs: script },
    });
    try {
      const files = [
        ['/ok.js', 'x = 1;'],
        ['/bad.js', '((('],
      ];
      const v = k.fs('v');
      await assert.rejects(v.writeFiles(files), (err) => {
        refused(v, 'ENOTSUP', '/bad.js')(err);
        assert.match(
          err.message,
          /fs\.script\.compile: source does not compile/,
        );
        return true;
      });
      assert.equal(v.exists('/ok.js'), false);
      assert.equal(leakedBytes(k), 0);
      const m = k.fs('m');
      assert.throws(
        () => m.writeFiles(files),
        refused(m, 'ENOTSUP', '/bad.js'),
      );
      assert.equal(m.exists('/ok.js'), false);
      assert.equal(k.version, 0);
    } finally {
      k.close();
      rm(root);
    }
  });
});

describe('writeFiles: among other mutations', () => {
  it('its keys are locked together: a write of one of them waits, or is waited for', async () => {
    const root = tmpDir('vfs-batch');
    const k = await kernel(root, VIRTUAL);
    try {
      const v = k.fs('v');
      const [batch] = await Promise.all([
        v.writeFiles([
          ['/a', '1'],
          ['/b', '1'],
        ]),
        v.writeFile('/b', '2'),
      ]);
      assert.equal(batch, 1);
      assert.equal(v.readFile('/b', 'utf8'), '2', 'the write came after');
      assert.equal(v.version('/a'), 1);
      assert.equal(v.version('/b'), 2);
      const [, after] = await Promise.all([
        v.writeFile('/a', '3'),
        v.writeFiles([
          ['/a', '4'],
          ['/c', '4'],
        ]),
      ]);
      assert.equal(after, 4);
      assert.equal(v.readFile('/a', 'utf8'), '4', 'the set came after');
      await released();
      assert.equal(k.mutations.size, 0);
    } finally {
      k.close();
      rm(root);
    }
  });

  it('a key in flight is a file: below a write in flight a set is refused, and a write below a set in flight', async () => {
    const root = tmpDir('vfs-batch');
    const k = await kernel(root, VIRTUAL);
    try {
      const v = k.fs('v');
      const gate = Promise.withResolvers();
      const original = k.publishVirtual.bind(k);
      k.publishVirtual = async (place, key, raw) => {
        if (key === '/d/x') await gate.promise;
        return original(place, key, raw);
      };
      const held = v.writeFile('/d/x', 'x');
      await assert.rejects(
        v.writeFiles([
          ['/e', 'e'],
          ['/d', 'd'],
        ]),
        refused(v, 'EISDIR', '/d'),
      );
      gate.resolve();
      await held;
      assert.equal(v.readFile('/d/x', 'utf8'), 'x');
      assert.equal(v.exists('/e'), false);
      // A set in flight: its first allocation waits at a gate; nothing
      // else does.
      const allocated = Promise.withResolvers();
      const open = Promise.withResolvers();
      const allocate = k.cache.allocate.bind(k.cache);
      let gated = true;
      k.cache.allocate = async (file, options) => {
        if (gated) {
          gated = false;
          allocated.resolve();
          await open.promise;
        }
        return allocate(file, options);
      };
      const set = v.writeFiles([
        ['/s', 's'],
        ['/t', 't'],
      ]);
      await within(allocated.promise, 'the allocation of the set');
      await assert.rejects(v.writeFile('/s/y', 'y'), {
        code: 'ENOTDIR',
        syscall: 'open',
        path: v.pathOf('/s/y'),
      });
      await assert.rejects(v.writeFile('/t/z/y', 'y'), {
        code: 'ENOTDIR',
        syscall: 'open',
        path: v.pathOf('/t/z/y'),
      });
      open.resolve();
      assert.equal(await set, 2);
      assert.equal(v.exists('/s/y'), false);
      await released();
      assert.equal(k.mutations.size, 0);
    } finally {
      k.close();
      rm(root);
    }
  });

  it('a set under a directory a recursive rm is removing comes after it', async () => {
    const root = tmpDir('vfs-batch');
    const k = await kernel(root, VIRTUAL);
    try {
      const v = k.fs('v');
      await v.writeFile('/d/one', '1');
      const [, version] = await Promise.all([
        v.rm('/d', { recursive: true }),
        v.writeFiles([
          ['/d/two', '2'],
          ['/d/three', '3'],
        ]),
      ]);
      assert.equal(version, 3);
      assert.deepEqual(v.readdir('/d'), ['three', 'two']);
      await released();
      assert.equal(k.mutations.size, 0);
    } finally {
      k.close();
      rm(root);
    }
  });

  it('no thread sees part of a set: the projection, a snapshot and a new link wait for its commit', async () => {
    const root = tmpDir('vfs-batch');
    const k = await kernel(root, VIRTUAL);
    const w = worker(k);
    let late = null;
    try {
      const v = k.fs('v');
      const reached = Promise.withResolvers();
      const gate = Promise.withResolvers();
      const allocate = k.cache.allocate.bind(k.cache);
      let calls = 0;
      k.cache.allocate = async (file, options) => {
        if (++calls === 2) {
          reached.resolve();
          await gate.promise;
        }
        return allocate(file, options);
      };
      const pending = v.writeFiles([
        ['/a', 'a'],
        ['/b', 'b'],
      ]);
      await within(reached.promise, 'the allocation of /b');
      assert.equal(v.exists('/a'), false, '/a is staged, not published');
      assert.deepEqual(k.snapshot().places.v.entries, []);
      late = worker(k);
      assert.equal(late.kernel.fs('v').exists('/a'), false, 'a link made now');
      assert.equal(w.kernel.fs('v').exists('/a'), false);
      const applied = nextMessage(late.port);
      gate.resolve();
      assert.equal(await pending, 1);
      const update = await applied;
      assert.deepEqual(
        update.places.v.entries.map(([key]) => key),
        ['/a', '/b'],
      );
      assert.equal(k.nextUpdateId, 1, 'one update');
      assert.equal(late.kernel.fs('v').readFile('/b', 'utf8'), 'b');
    } finally {
      late?.kernel.close();
      w.kernel.close();
      k.close();
      rm(root);
    }
  });
});

describe('writeFiles: map places', () => {
  it('a map place publishes a set at once, all or nothing, in its own thread', async () => {
    const root = tmpDir('vfs-batch');
    let failing = null;
    const preparers = {
      upper: (raw, file) => {
        if (file.key === failing) throw new Error(`cannot prepare ${file.key}`);
        return raw.toString().toUpperCase();
      },
    };
    const k = await kernel(
      root,
      {
        m: {
          provider: 'map',
          origin: 'virtual',
          fs: { writable: true, prepare: { upper: ['txt'] } },
          require: { compile: true },
        },
      },
      {},
      { preparers },
    );
    const w = worker(k, { preparers });
    const bare = worker(k);
    try {
      const m = k.fs('m');
      const place = k.registry.get('m');
      const keys = ['/a.txt', '/b.js'];
      const result = await ticking(() =>
        m.writeFiles([
          ['/a.txt', 'a'],
          ['/b.js', 'exports.b = 1;'],
        ]),
      );
      assert.equal(result, undefined, 'at once');
      assert.equal(m.readFile('/a.txt', 'utf8'), 'A');
      assert.ok(place.bytecode('/b.js', 'require'), 'its bytecode');
      const mtimes = new Set(keys.map((key) => m.stat(key).mtimeMs));
      assert.equal(mtimes.size, 1, 'one mtime');
      assert.equal(m.version('/a.txt'), null, 'no version');
      assert.equal(k.version, 0);
      failing = '/d.txt';
      assert.throws(
        () =>
          m.writeFiles([
            ['/b.js', 'exports.b = 2;'],
            ['/c.txt', 'c'],
            ['/d.txt', 'd'],
          ]),
        { message: 'cannot prepare /d.txt' },
      );
      assert.equal(m.exists('/c.txt'), false);
      assert.equal(m.readFile('/b.js', 'utf8'), 'exports.b = 1;');
      assert.throws(
        () =>
          m.writeFiles([
            ['/x', 'x'],
            ['/x/y', 'y'],
          ]),
        refused(m, 'ENOTDIR', '/x/y'),
      );
      // A worker's own map place: its preparers, its thread.
      const own = w.kernel.fs('m');
      assert.equal(own.writeFiles({ '/w.txt': 'w' }), undefined);
      assert.equal(own.readFile('/w.txt', 'utf8'), 'W');
      assert.equal(m.exists('/w.txt'), false, 'per thread');
      // Without the preparer, a worker refuses the set as the set.
      const none = bare.kernel.fs('m');
      assert.throws(
        () =>
          none.writeFiles([
            ['/n.js', 'n'],
            ['/p.txt', 'p'],
          ]),
        refused(none, 'ENOTSUP', '/p.txt'),
      );
      assert.equal(none.exists('/n.js'), false);
    } finally {
      bare.kernel.close();
      w.kernel.close();
      k.close();
      rm(root);
    }
  });
});

describe('writeFiles: close()', () => {
  const closed = {
    code: 'ERR_VFS_CLOSED',
    message: '[vfs] kernel closed before publication',
  };

  it('a preparer that closes the kernel: the set is refused as closed, what it placed goes with the pool', async () => {
    const root = tmpDir('vfs-batch');
    let k = null;
    const p = (raw, file) => {
      if (file.key === '/b.txt') k.close();
      return new Uint8Array(raw);
    };
    k = await kernel(
      root,
      {
        v: {
          origin: 'virtual',
          fs: { writable: true, ext: ['txt'], prepare: 'p' },
        },
      },
      {},
      { preparers: { p } },
    );
    try {
      const v = k.fs('v');
      await assert.rejects(
        v.writeFiles([
          ['/a.txt', 'a'],
          ['/b.txt', 'b'],
          ['/c.txt', 'c'],
        ]),
        closed,
      );
      assert.equal(k.cache, null);
      assert.equal(k.version, 0, 'nothing published');
      assert.equal(k.mutations.size, 0);
    } finally {
      k.close();
      rm(root);
    }
  });

  // The seam of the mutations' test (mutation-order.test.js): the record of
  // a staged source closes the kernel, after the last file of the set and
  // before its commit.
  it('a kernel closed after the last file and before the commit: the set is refused as closed', async () => {
    const root = tmpDir('vfs-batch');
    const k = await kernel(root, VIRTUAL);
    try {
      const v = k.fs('v');
      const events = record(k);
      k.sources.set('v', {
        set: (key) => {
          if (key === '/b') k.close();
        },
      });
      await assert.rejects(
        v.writeFiles([
          ['/a', 'a'],
          ['/b', 'b'],
        ]),
        closed,
      );
      assert.equal(k.version, 0, 'nothing published');
      assert.equal(k.nextUpdateId, 0);
      assert.deepEqual(events, []);
    } finally {
      k.close();
      rm(root);
    }
  });
});
