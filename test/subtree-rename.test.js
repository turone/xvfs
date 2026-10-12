'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  tmpDir,
  rm,
  kernel,
  tap,
  worker,
  nextMessage,
  until,
  leakedBytes,
} = require('./helpers.js');

// A directory rename inside one virtual place moves the directory's node,
// its subtree with it: every file keeps its node — its id and `ino` — its
// payload, every representation and its version, and shows under the new
// prefix, in one publication that names the move. Nothing is copied,
// prepared, compiled or compressed again, nothing retires, and the pool
// needs no room. One source that cannot move as it is — a prepared one,
// one with bytecode, one with path-dependent metadata — refuses the whole
// subtree, and so do collisions and nesting: nothing changes before the
// commit.

const PROVIDERS = {
  sab: { origin: 'virtual', fs: { writable: true } },
  map: { provider: 'map', origin: 'virtual', fs: { writable: true } },
};

const TREE = {
  '/d/a.txt': 'alpha',
  '/d/sub/b.css': 'b{}',
  '/d/sub/deep/c.txt': '',
};

const outcome = async (fn) => {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    return err;
  }
};

// Runs `fn` with a kernel over one place `v` (plus `other` of the same
// config), then closes it.
const withPlace = async (config, fn, options = {}, defaults = {}) => {
  const root = tmpDir('vfs-subtree');
  const k = await kernel(root, { v: config, other: config }, defaults, options);
  try {
    await fn(k, k.fs('v'), (key) => path.join(root, 'v', key));
  } finally {
    k.close();
    rm(root);
  }
};

// The files of a set, with the directories they need.
const write = async (v, files) => {
  await v.writeFiles(files);
};

// Every key a place's tree holds under a prefix, a directory's with a
// trailing slash.
const keysUnder = (k, name, prefix) => {
  const { tree } = k.registry.get(name);
  const keys = [];
  for (const [node] of tree.walk(tree.get(''))) {
    keys.push(tree.pathOf(node) + (tree.isDirectory(node) ? '/' : ''));
  }
  return keys.filter((key) => key.startsWith(prefix)).sort();
};

// Settles once the microtasks queued so far — lock releases included — ran.
const drained = () => new Promise(setImmediate);

describe('virtual subtree rename', () => {
  for (const [name, config] of Object.entries(PROVIDERS)) {
    it(`${name}: a nested subtree moves whole: ids, versions, stat and mtime kept`, async () => {
      await withPlace(config, async (k, v, at) => {
        await write(v, TREE);
        const before = Object.keys(TREE).map((key) => v.stat(key));
        const versions = Object.keys(TREE).map((key) => v.version(key));
        const ids = Object.keys(TREE).map((key) => v.idOf(key));
        // The destination's directory must be there, as on Linux.
        const err = await outcome(() => v.rename('/d', '/e/f'));
        assert.equal(err.code, 'ENOENT');
        assert.equal(err.dest, at('/e/f'));
        await v.mkdir('/e');
        const realNow = Date.now;
        // However late the move, the entries keep the time of their write.
        Date.now = () => realNow() + 60_000;
        try {
          await v.rename('/d', '/e/f');
        } finally {
          Date.now = realNow;
        }
        for (const [i, [key, content]] of Object.entries(TREE).entries()) {
          const moved = key.replace('/d/', '/e/f/');
          assert.equal(v.readFile(moved, 'utf8'), content, moved);
          assert.equal(v.stat(moved).mtimeMs, before[i].mtimeMs, moved);
          assert.equal(v.stat(moved).size, before[i].size, moved);
          assert.equal(v.stat(moved).ino, before[i].ino, moved);
          assert.equal(v.idOf(moved), ids[i], moved);
          assert.equal(v.version(moved), versions[i], moved);
          assert.equal(v.exists(key), false, key);
        }
        assert.equal(v.exists('/d'), false);
        assert.deepEqual(v.readdir('/e/f', { recursive: true }), [
          'a.txt',
          'sub',
          'sub/b.css',
          'sub/deep',
          'sub/deep/c.txt',
        ]);
        // Renaming a directory onto itself changes nothing.
        await v.rename('/e/f', '/e/f');
        assert.equal(v.readFile('/e/f/a.txt', 'utf8'), 'alpha');
      });
    });

    it(`${name}: one source that cannot move refuses the whole subtree`, async () => {
      const unsupported = {
        prepare: {
          ...config,
          fs: { ...config.fs, prepare: { wrap: ['js'] } },
        },
        'fs.script.compile': {
          ...config,
          fs: { ...config.fs, script: { compile: ['js'] } },
        },
        'require.compile': { ...config, require: { compile: ['js'] } },
      };
      const preparers = { wrap: (raw) => `(${raw})` };
      for (const [what, placeConfig] of Object.entries(unsupported)) {
        await withPlace(
          placeConfig,
          async (k, v, at) => {
            await write(v, { ...TREE, '/d/sub/deep/x.js': 'module.x = 1;' });
            const keys = keysUnder(k, 'v', '/');
            const err = await outcome(() => v.rename('/d', '/e'));
            assert.equal(err.code, 'ENOTSUP', what);
            assert.equal(err.syscall, 'rename');
            assert.equal(err.path, at('/d'));
            assert.equal(err.dest, at('/e'));
            assert.match(err.message, /\/d\/sub\/deep\/x\.js/);
            assert.deepEqual(keysUnder(k, 'v', '/'), keys, `${what}: intact`);
          },
          { preparers },
        );
      }
    });

    it(`${name}: collisions and nesting are refused before anything changes`, async () => {
      await withPlace(config, async (k, v, at) => {
        await write(v, { ...TREE, '/taken/t.txt': 't', '/file.txt': 'f' });
        const keys = keysUnder(k, 'v', '/');
        for (const [from, to, code] of [
          ['/d', '/taken', 'ENOTEMPTY'],
          ['/d', '/file.txt', 'ENOTDIR'],
          ['/d', '/d/sub/inner', 'EINVAL'],
          ['/d/sub', '/d', 'ENOTEMPTY'],
          ['/nothing', '/else', 'ENOENT'],
          ['/d', '/none/else', 'ENOENT'],
        ]) {
          const err = await outcome(() => v.rename(from, to));
          assert.equal(err.code, code, `${from} -> ${to}`);
          assert.equal(err.path, at(from));
          assert.equal(err.dest, at(to));
        }
        const err = await outcome(() => v.rename('/', '/x'));
        assert.equal(err.code, 'ENOTSUP', 'the place root');
        assert.deepEqual(keysUnder(k, 'v', '/'), keys, 'nothing changed');
        // An empty directory it replaces, as on Linux.
        await v.mkdir('/empty');
        await v.rename('/d', '/empty');
        assert.equal(v.readFile('/empty/a.txt', 'utf8'), 'alpha');
        assert.equal(v.exists('/d'), false);
      });
    });
  }

  it('sab: one vfs-update naming the move; a worker never sees half of it', async () => {
    await withPlace(PROVIDERS.sab, async (k, v) => {
      await write(v, TREE);
      const t = tap(k);
      const w = worker(k);
      try {
        const updates = t.updates().length;
        const retires = k.nextRetireId;
        const next = nextMessage(t.port);
        const applied = nextMessage(w.port);
        await v.rename('/d', '/e');
        const msg = await next;
        await applied;
        assert.equal(msg.name, 'vfs-update');
        assert.equal(t.updates().length, updates + 1, 'one update');
        const { delta, ...files } = msg.places.v;
        assert.ok(delta);
        assert.deepEqual(files, {
          created: [],
          replaced: [],
          removed: [],
          moved: [['/d', '/e']],
        });
        assert.deepEqual(msg.newSegments, [], 'no byte moved');
        assert.equal(k.nextRetireId, retires, 'nothing retired');
        const wv = w.kernel.fs('v');
        assert.equal(wv.idOf('/e/a.txt'), v.idOf('/e/a.txt'));
        assert.equal(wv.readFile('/e/sub/b.css', 'utf8'), 'b{}');
        assert.equal(wv.exists('/d'), false);
      } finally {
        w.kernel.close();
      }
    });
  });

  it('sab: compressed representations move with their source, never recompressed', async () => {
    const config = {
      origin: 'virtual',
      fs: { writable: true, compress: { encodings: ['gzip'], ext: ['css'] } },
    };
    await withPlace(config, async (k, v) => {
      await write(v, { ...TREE, '/d/sub/big.css': 'x{}'.repeat(200) });
      const gzip = v.readFileCompressed('/d/sub/big.css', 'gzip');
      assert.ok(gzip.length > 0);
      let compressed = 0;
      const { compress } = k.compressor;
      k.compressor.compress = (...args) => {
        compressed++;
        return compress.apply(k.compressor, args);
      };
      await v.rename('/d', '/e');
      assert.equal(compressed, 0, 'no codec ran');
      assert.deepEqual(v.readFileCompressed('/e/sub/big.css', 'gzip'), gzip);
      assert.deepEqual(v.storedEncodings('/e/sub/big.css'), ['raw', 'gzip']);
      assert.deepEqual(v.storedEncodings('/d/sub/big.css'), []);
      assert.deepEqual(v.storedEncodings('/e/a.txt'), ['raw'], 'mixed tree');
      assert.deepEqual(keysUnder(k, 'v', '/d'), [], 'nothing stays');
    });
  });

  // A subtree moves as it is: a pool with no room left moves it all the
  // same, from any thread — nothing is copied.
  it('sab: a full pool moves a subtree all the same', async () => {
    const config = { origin: 'virtual', fs: { writable: true } };
    const memory = {
      limit: '8 kib',
      segmentSize: '4 kib',
      maxFileSize: '4 kib',
    };
    const tree = {
      '/d/a': 'a'.repeat(2000),
      '/d/b': 'b'.repeat(2000),
      '/d/c': 'c'.repeat(2000),
    };
    await withPlace(
      config,
      async (k, v) => {
        await write(v, tree);
        const used = k.cache.usage().used;
        const w = worker(k);
        try {
          for (const [label, place, from, to] of [
            ['main', v, '/d', '/e'],
            ['worker', w.kernel.fs('v'), '/e', '/d'],
          ]) {
            await place.rename(from, to);
            for (const [key, text] of Object.entries(tree)) {
              const moved = to + key.slice(2);
              assert.equal(v.readFile(moved, 'utf8'), text, `${label}: ${key}`);
            }
            assert.equal(v.exists(from), false, label);
          }
          assert.equal(k.cache.usage().used, used, 'nothing copied');
          assert.equal(leakedBytes(k), 0);
        } finally {
          w.kernel.close();
        }
      },
      {},
      { memory },
    );
  });

  // A lease taken before the move reads the very bytes the moved file
  // shows: nothing retires, and its release frees nothing.
  it('sab: a lease taken before a move reads on; nothing retires', async () => {
    const config = {
      origin: 'virtual',
      fs: { writable: true, zeroCopy: true },
    };
    await withPlace(config, async (k, v) => {
      await write(v, TREE);
      const lease = v.readFileView('/d/a.txt');
      await v.rename('/d', '/e');
      assert.deepEqual(k.retirements(), []);
      assert.equal(lease.view.toString(), 'alpha');
      lease.release();
      assert.equal(k.retired.size, 0);
      assert.equal(v.readFile('/e/a.txt', 'utf8'), 'alpha');
      assert.equal(leakedBytes(k), 0);
    });
  });

  it('sab: the place barrier orders the move and is released after failure and close', async () => {
    const config = {
      origin: 'virtual',
      fs: { writable: true, compress: { encodings: ['gzip'], ext: ['css'] } },
    };
    await withPlace(config, async (k, v) => {
      await write(v, TREE);
      // A write issued after the move lands after it: its directory is
      // gone by then.
      const moved = v.rename('/d', '/e');
      const written = outcome(() => v.writeFile('/d/late.txt', 'late'));
      await moved;
      assert.equal((await written).code, 'ENOENT');
      assert.equal(v.readFile('/e/a.txt', 'utf8'), 'alpha');
      await v.writeFiles({ '/d/late.txt': 'late' });
      // A refused move holds nothing up.
      await v.writeFile('/e/p.css', 'p{}');
      await v.rename('/e', '/f');
      const refused = await outcome(() => v.rename('/f', '/d'));
      assert.equal(refused.code, 'ENOTEMPTY');
      await v.writeFile('/f/after.txt', 'after');
      await drained();
      assert.equal(k.mutations.size, 0);
    });
    await withPlace(config, async (k, v) => {
      await write(v, TREE);
      // A move queued behind a write in flight when the kernel closes: the
      // write waits in its compression until then. The compressor is taken
      // before close(), which drops the kernel's.
      const gate = Promise.withResolvers();
      let compressing = false;
      const { compressor } = k;
      const { compress } = compressor;
      compressor.compress = async (...args) => {
        compressing = true;
        await gate.promise;
        return compress.apply(compressor, args);
      };
      const slow = v.writeFile('/d/slow.css', 's{}');
      const move = v.rename('/d', '/e');
      try {
        assert.ok(await until(() => compressing), 'the write is in flight');
        k.close();
      } finally {
        gate.resolve();
      }
      assert.match((await outcome(() => slow)).message, /closed/);
      assert.match((await outcome(() => move)).message, /ready kernel/);
      assert.equal(k.mutations.size, 0);
    });
  });
});
