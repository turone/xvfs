'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const disk = require('../lib/disk.js');
const fsPatch = require('../lib/adapters/fs-patch.js');
const {
  SURFACE,
  OPTIONAL,
  IMPLEMENTED,
  GUARDED,
  DELEGATED,
  PATH_FREE,
  exportsOf,
} = require('../lib/adapters/fs-surface.js');
const { tmpDir, writeTree, rm, kernel, within } = require('./helpers.js');

// The patch knows every export of node:fs and node:fs/promises
// (lib/adapters/fs-surface.js): implemented, guarded, delegated — its disk
// access goes through patched functions — or path-free. Under strict, a
// function it does not know is refused at every call, before it runs: a
// Node release may add one whose paths the routing never sees. Without
// strict it stays as Node made it.

const { existsSync: onDisk, readFileSync: readDisk } = fs;

// The descriptor of every export, by name.
const surfaceNow = () =>
  new Map(exportsOf(fs).map(({ name, descriptor }) => [name, descriptor]));

// A kernel over one place, `site`, and an unmanaged file under appRoot;
// the patch installed over it.
const withPatch = async (strict, fn) => {
  const root = writeTree(tmpDir('fs-surface'), {
    'site/a.txt': 'a',
    'stray/s.txt': 'unmanaged',
  });
  const outside = writeTree(tmpDir('fs-surface-out'), { 'o.txt': 'outside' });
  const k = await kernel(root, { site: { fs: { ext: ['txt'] } } }, { strict });
  try {
    fsPatch.install(k);
    await fn({
      k,
      at: (...p) => path.join(root, ...p),
      outside: path.join(outside, 'o.txt'),
    });
  } finally {
    fsPatch.uninstall();
    k.close();
    rm(root);
    rm(outside);
  }
};

// Functions no Node release exports, planted where a new one would appear:
// a function of node:fs — carrying one of its own, as realpath carries
// `.native` — and one of node:fs/promises, a class behind an accessor —
// carrying a static function — and a function carried by an export the
// patch replaces and by one it leaves alone. Each records its calls;
// unplant() removes them.
const plant = () => {
  const calls = [];
  const record = (where) =>
    function (...args) {
      calls.push([where, ...args]);
      return where;
    };
  class Planted {
    constructor(...args) {
      calls.push(['class', ...args]);
    }
  }
  Planted.helper = record('Planted.helper');
  const getter = () => Planted;
  const planted = {
    fs: record('fs'),
    native: record('fs.native'),
    promises: async (...args) => record('promises')(...args),
    readFile: record('readFile.planted'),
    fstat: record('fstat.planted'),
    getter,
    Planted,
  };
  planted.fs.native = planted.native;
  fs.planted = planted.fs;
  fs.promises.planted = planted.promises;
  Object.defineProperty(fs, 'Planted', {
    get: getter,
    configurable: true,
    enumerable: true,
  });
  fs.readFile.planted = planted.readFile;
  fs.fstat.planted = planted.fstat;
  const unplant = () => {
    delete fs.planted;
    delete fs.promises.planted;
    delete fs.Planted;
    delete fs.readFile.planted;
    delete fs.fstat.planted;
  };
  return { calls, planted, unplant };
};

describe('fs-surface: the exports the patch knows', () => {
  it('this Node exports what the table knows, and nothing else', () => {
    const names = [...surfaceNow().keys()];
    const unknown = names.filter((name) => !Object.hasOwn(SURFACE, name));
    assert.deepEqual(
      unknown,
      [],
      'exports of this Node the table does not know: classify each in ' +
        'lib/adapters/fs-surface.js',
    );
    const gone = Object.keys(SURFACE).filter(
      (name) => !names.includes(name) && !OPTIONAL.has(name),
    );
    assert.deepEqual(gone, [], 'exports the table requires, gone from Node');
    const kinds = new Set(Object.values(SURFACE));
    assert.deepEqual(
      [...kinds].sort(),
      [DELEGATED, GUARDED, IMPLEMENTED, PATH_FREE].sort(),
    );
  });

  it('install() replaces what is implemented or guarded, and nothing else; uninstall() restores it', async () => {
    const before = surfaceNow();
    await withPatch(false, () => {
      const now = surfaceNow();
      assert.deepEqual([...now.keys()].sort(), [...before.keys()].sort());
      for (const [name, descriptor] of before) {
        const kind = SURFACE[name];
        const replaced = now.get(name).value !== descriptor.value;
        const patchable = typeof descriptor.value === 'function';
        const expected =
          patchable && (kind === IMPLEMENTED || kind === GUARDED);
        assert.equal(replaced, expected, `${name} (${kind})`);
        if (descriptor.get) {
          assert.equal(
            now.get(name).get,
            descriptor.get,
            `${name}: its getter`,
          );
        }
      }
    });
    const restored = surfaceNow();
    for (const [name, descriptor] of before) {
      assert.deepEqual(restored.get(name), descriptor, `${name} restored`);
    }
  });
});

describe('fs-patch: a function the table does not know', () => {
  it('under strict is refused at every call, before it runs; uninstall() restores it', async () => {
    const { calls, planted, unplant } = plant();
    let taken = null;
    try {
      await withPatch(true, async ({ at }) => {
        const hidden = at('stray', 's.txt');
        const refused = (name) => ({
          code: 'ENOTSUP',
          syscall: name,
          message: `ENOTSUP: operation not supported (not known to strict routing), ${name}`,
        });
        assert.throws(() => fs.planted(hidden), refused('fs.planted'));
        assert.throws(
          () => fs.planted.native(hidden),
          refused('fs.planted.native'),
        );
        await assert.rejects(
          fs.promises.planted(hidden),
          refused('fs.promises.planted'),
        );
        assert.throws(() => new fs.Planted(hidden), refused('fs.Planted'));
        // eslint-disable-next-line new-cap
        assert.throws(() => fs.Planted(hidden), refused('fs.Planted'));
        assert.equal(fs.Planted, fs.Planted, 'one wrapper per class');
        assert.throws(
          () => fs.Planted.helper(hidden),
          refused('fs.Planted.helper'),
        );
        assert.throws(
          () => fs.readFile.planted(hidden),
          refused('fs.readFile.planted'),
        );
        assert.throws(
          () => fs.fstat.planted(hidden),
          refused('fs.fstat.planted'),
        );
        assert.deepEqual(calls, [], 'nothing ran');
        // Node's own implementation calling it back, in the native section,
        // reaches it as it is.
        assert.equal(
          disk.native(() => fs.planted(hidden)),
          'fs',
        );
        assert.deepEqual(calls, [['fs', hidden]]);
        taken = fs.planted;
      });
      // Restored, and a reference taken meanwhile is the function again.
      assert.equal(fs.planted, planted.fs);
      assert.equal(fs.planted.native, planted.native);
      assert.equal(fs.promises.planted, planted.promises);
      assert.equal(
        Object.getOwnPropertyDescriptor(fs, 'Planted').get,
        planted.getter,
      );
      assert.equal(fs.readFile.planted, planted.readFile);
      assert.equal(fs.fstat.planted, planted.fstat);
      assert.equal(taken('x'), 'fs');
      assert.equal(new fs.Planted('y') instanceof planted.Planted, true);
    } finally {
      unplant();
    }
  });

  it('without strict stays as Node made it', async () => {
    const { calls, planted, unplant } = plant();
    try {
      await withPatch(false, async () => {
        assert.equal(fs.planted, planted.fs);
        assert.equal(fs.planted.native, planted.native);
        assert.equal(fs.promises.planted, planted.promises);
        assert.equal(
          Object.getOwnPropertyDescriptor(fs, 'Planted').get,
          planted.getter,
        );
        assert.equal(fs.readFile.planted, planted.readFile, 'carried over');
        assert.equal(fs.fstat.planted, planted.fstat);
        assert.equal(fs.planted('p'), 'fs');
        assert.equal(await fs.promises.planted('q'), 'promises');
        assert.ok(new fs.Planted('r') instanceof planted.Planted);
      });
      assert.deepEqual(calls, [
        ['fs', 'p'],
        ['promises', 'q'],
        ['class', 'r'],
      ]);
    } finally {
      unplant();
    }
  });

  it('under strict, one that cannot be replaced fails install() and leaves nothing installed', async () => {
    const original = fs.readFile;
    Object.defineProperty(fs, 'frozen', {
      value: () => 'frozen',
      writable: false,
      configurable: true,
      enumerable: true,
    });
    const root = writeTree(tmpDir('fs-surface-frozen'), { 'site/a.txt': 'a' });
    const k = await kernel(root, { site: { fs: true } }, { strict: true });
    try {
      assert.throws(() => fsPatch.install(k), {
        message:
          '[vfs] unknown node:fs surface fs.frozen: strict routing cannot hold it',
      });
      assert.equal(fs.readFile, original, 'nothing installed');
      delete fs.frozen;
      fsPatch.install(k);
      assert.notEqual(fs.readFile, original, 'it installs once it can');
    } finally {
      fsPatch.uninstall();
      delete fs.frozen;
      k.close();
      rm(root);
    }
  });

  // An object is a namespace of functions no table knows, as
  // node:fs/promises is one: strict cannot hold it, whether it is a value
  // or what an accessor gives, of node:fs or of node:fs/promises.
  it('under strict, an unknown object fails install(); without strict it stays', async () => {
    const calls = [];
    const namespace = () => ({
      readFileSync: (p) => calls.push(p),
    });
    const plants = [
      ['fs.ns', () => (fs.ns = namespace()), () => delete fs.ns],
      [
        'fs.promises.ns',
        () => (fs.promises.ns = namespace()),
        () => delete fs.promises.ns,
      ],
      [
        'fs.Ns',
        () =>
          Object.defineProperty(fs, 'Ns', {
            get: namespace,
            configurable: true,
            enumerable: true,
          }),
        () => delete fs.Ns,
      ],
    ];
    const root = writeTree(tmpDir('fs-surface-ns'), { 'site/a.txt': 'a' });
    const strict = await kernel(root, { site: { fs: true } }, { strict: true });
    const loose = await kernel(root, { site: { fs: true } });
    const original = fs.readFile;
    try {
      for (const [name, put, remove] of plants) {
        put();
        try {
          assert.throws(() => fsPatch.install(strict), {
            message: `[vfs] unknown node:fs surface ${name}: strict routing cannot hold it`,
          });
          assert.equal(fs.readFile, original, `${name}: nothing installed`);
          fsPatch.install(loose);
          assert.notEqual(fs.readFile, original, `${name}: installed`);
          fsPatch.uninstall();
        } finally {
          fsPatch.uninstall();
          remove();
        }
      }
      assert.deepEqual(calls, [], 'nothing ran');
    } finally {
      strict.close();
      loose.close();
      rm(root);
    }
  });
});

describe('fs-patch under strict: what the table calls path-free or delegated', () => {
  it('path-free functions work on a descriptor, a handle, a class', async () => {
    const before = surfaceNow();
    await withPatch(true, async ({ outside }) => {
      for (const [name, descriptor] of before) {
        if (SURFACE[name] !== PATH_FREE) continue;
        assert.deepEqual(surfaceNow().get(name), descriptor, `${name} as is`);
      }
      const fd = fs.openSync(outside, 'r');
      try {
        assert.equal(fs.fstatSync(fd).size, 7);
        const buffer = Buffer.alloc(7);
        assert.equal(fs.readSync(fd, buffer, 0, 7, 0), 7);
        assert.equal(buffer.toString(), 'outside');
        const stats = await new Promise((resolve, reject) => {
          fs.fstat(fd, (err, s) => (err ? reject(err) : resolve(s)));
        });
        assert.ok(stats instanceof fs.Stats);
      } finally {
        fs.closeSync(fd);
      }
      const handle = await fs.promises.open(outside, 'r');
      try {
        assert.equal((await handle.stat()).size, 7);
        assert.equal(await handle.readFile('utf8'), 'outside');
      } finally {
        await handle.close();
      }
    });
  });

  // Their disk access goes through patched functions of the public
  // node:fs: a hidden path is refused as it is there. On a Node that made
  // one open natively, this test fails and the table is revised.
  it('delegated exports reach the disk only through the patch', async () => {
    await withPatch(true, async ({ at }) => {
      const hidden = at('stray', 's.txt');
      const exists = await within(
        new Promise((resolve) => fs.exists(hidden, resolve)),
        'fs.exists',
      );
      assert.equal(exists, false, 'fs.exists asks fs.access');
      const refusedOpen = async (stream, what) => {
        const err = await within(
          new Promise((resolve) => stream.once('error', resolve)),
          what,
        );
        stream.destroy();
        assert.equal(err.code, 'EACCES', what);
        assert.equal(err.syscall, 'open', what);
        assert.equal(err.path, hidden, what);
      };
      await refusedOpen(fs.createWriteStream(hidden), 'createWriteStream');
      await refusedOpen(new fs.WriteStream(hidden), 'new WriteStream');
      await refusedOpen(new fs.ReadStream(hidden), 'new ReadStream');
      assert.equal(fs.FileReadStream, fs.ReadStream);
      assert.equal(fs.FileWriteStream, fs.WriteStream);
      if (typeof fs.Utf8Stream === 'function') {
        assert.throws(() => new fs.Utf8Stream({ dest: hidden, sync: true }), {
          code: 'EACCES',
          syscall: 'open',
        });
      }
      assert.equal(fs.unwatchFile(hidden), undefined, 'no disk access');
      assert.equal(readDisk(hidden, 'utf8'), 'unmanaged', 'nothing written');
      assert.equal(onDisk(hidden), true);
    });
  });
});
