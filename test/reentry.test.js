'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const disk = require('../lib/disk.js');
const { VfsKernel } = require('../lib/kernel.js');
const fsPatch = require('../lib/adapters/fs-patch.js');
const {
  tmpDir,
  writeTree,
  rm,
  config,
  kernel,
  drain,
  quiet,
} = require('./helpers.js');

// The disk as it is, behind the patch: captured before any install.
const {
  readFileSync: readDisk,
  writeFileSync: writeDisk,
  existsSync: onDisk,
  mkdirSync: mkdirDisk,
} = fs;

// Node's own implementations call the public node:fs back: readFileSync and
// writeFileSync of a Buffer open the file through fs.openSync, rmSync lstats
// its path through fs.lstatSync — on Node 22 its rimraf walks the whole tree
// that way. Routed, those inner calls found a published file ENOTSUP, a
// hidden one EACCES, a listing without the files the place hides. The
// library's own disk I/O runs them in the native section of lib/disk.js,
// where every wrapper of the patch is its original.

const PREPARERS = { upper: (raw) => raw.toString().toUpperCase() };

// Settles as `fn(callback)` calls back.
const viaCallback = (fn) =>
  new Promise((resolve, reject) => {
    fn((err) => (err ? reject(err) : resolve()));
  });

// The code a sync read of `filePath` fails with, or 'read'.
const readCode = (filePath) => {
  try {
    fs.readFileSync(filePath);
    return 'read';
  } catch (err) {
    return err.code;
  }
};

// A kernel.routeRead that records the paths it routes.
const spyRouteRead = (k) => {
  const routed = [];
  const routeRead = k.routeRead;
  k.routeRead = function (filePath) {
    routed.push(filePath);
    return routeRead.call(this, filePath);
  };
  return routed;
};

describe('lib/disk.js', () => {
  it('native() keeps the section open until it returns: nested, or by a throw', () => {
    assert.equal(disk.inNative(), false);
    const seen = disk.native(() => [
      disk.inNative(),
      disk.native(() => disk.inNative()),
      disk.inNative(),
    ]);
    assert.deepEqual(seen, [true, true, true]);
    assert.equal(disk.inNative(), false);
    assert.throws(
      () =>
        disk.native(() => {
          throw new Error('boom');
        }),
      /boom/,
    );
    assert.equal(disk.inNative(), false, 'closed by the throw');
  });

  it('sectioned() opens it for a call, outside() closes it for one; both keep the receiver', () => {
    const target = {};
    const probe = function (...args) {
      // eslint-disable-next-line no-invalid-this
      return [this === target, args, disk.inNative()];
    };
    target.inside = disk.sectioned(probe);
    target.outside = disk.outside(probe);
    target.fail = disk.outside(() => {
      throw new Error('boom');
    });
    assert.deepEqual(target.inside(1, 2), [true, [1, 2], true]);
    assert.equal(disk.inNative(), false);
    const seen = disk.native(() => {
      const before = disk.inNative();
      const call = target.outside(3);
      assert.throws(() => target.fail(), /boom/);
      return [before, call, disk.inNative()];
    });
    assert.deepEqual(seen, [true, [true, [3], false], true]);
    assert.equal(disk.inNative(), false);
  });

  // A copy of the module over stand-ins for the node:fs functions it
  // captures: called with MARK, each reports whether it ran in the native
  // section. (readdirSync calls node:fs back only on a filesystem that does
  // not report entry types.)
  it('what calls node:fs back runs in the native section', () => {
    const file = require.resolve('../lib/disk.js');
    const loaded = require.cache[file];
    const names = ['readFileSync', 'writeFileSync', 'rmSync', 'readdirSync'];
    const originals = names.map((name) => fs[name]);
    const MARK = '\0section';
    const inSection = {};
    let copy = null;
    try {
      delete require.cache[file];
      names.forEach((name, i) => {
        fs[name] = function (...args) {
          if (args[0] === MARK) {
            inSection[name] = copy.inNative();
            return MARK;
          }
          return originals[i].apply(this, args);
        };
      });
      copy = require(file);
    } finally {
      names.forEach((name, i) => {
        fs[name] = originals[i];
      });
      require.cache[file] = loaded;
    }
    for (const name of names) copy[name](MARK);
    assert.deepEqual(inSection, {
      readFileSync: true,
      writeFileSync: true,
      rmSync: true,
      readdirSync: true,
    });
    assert.equal(copy.inNative(), false);
  });

  it('no module loads node:fs but disk.js and the patch that replaces it', () => {
    const lib = path.join(__dirname, '..', 'lib');
    const loads =
      /(?:require\(|import\(|\bfrom)\s*['"](?:node:)?fs(?:\/promises)?['"]/;
    const found = fs
      .readdirSync(lib, { recursive: true })
      .filter((file) => /\.[cm]?js$/.test(file))
      .filter((file) => loads.test(readDisk(path.join(lib, file), 'utf8')))
      .map((file) => file.split(path.sep).join('/'))
      .sort();
    assert.deepEqual(found, ['adapters/fs-patch.js', 'disk.js']);
  });
});

describe('PlaceFs: disk entries and disk-origin mutations past the patch', () => {
  let root;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    root = writeTree(tmpDir('vfs-reentry'), {
      'site/a.txt': 'a',
      'site/b.txt': 'b',
      'site/big.txt': 'B'.repeat(70 * 1024), // over maxFileSize: a disk entry
      'site/t.bin': 'territory', // not cached: the disk territory
      'prep/p.txt': 'raw',
    });
    k = await kernel(
      root,
      {
        site: { fs: { ext: ['txt'], writable: true } },
        prep: { fs: { ext: ['txt'], prepare: 'upper' } },
        mem: { provider: 'map', origin: 'virtual', fs: { writable: true } },
      },
      { watchTimeout: 60000 },
      { preparers: PREPARERS },
    );
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(root);
  });

  it('writeFile / appendFile of a published file, string or Buffer', () => {
    const site = k.fs('site');
    site.writeFile('/a.txt', 'one');
    assert.equal(readDisk(at('site', 'a.txt'), 'utf8'), 'one');
    site.writeFile('/a.txt', Buffer.from('two'));
    site.appendFile('/a.txt', '+3');
    site.appendFile('/a.txt', Buffer.from('+4'));
    assert.equal(readDisk(at('site', 'a.txt'), 'utf8'), 'two+3+4');
  });

  it('reads and streams of disk entries never reach the router', async () => {
    const routed = spyRouteRead(k);
    try {
      const site = k.fs('site');
      assert.equal(site.readFile('/big.txt').length, 70 * 1024);
      assert.equal(site.readFile('/t.bin', 'utf8'), 'territory');
      const big = await drain(site.createReadStream('/big.txt'));
      assert.equal(big.length, 70 * 1024);
      const territory = await drain(site.createReadStream('/t.bin'));
      assert.equal(territory.toString(), 'territory');
      assert.deepEqual(routed, []);
    } finally {
      delete k.routeRead;
    }
  });

  it('copyFileSync of a published disk-origin file into map + virtual: its raw bytes', () => {
    assert.equal(fs.readFileSync(at('prep', 'p.txt'), 'utf8'), 'RAW');
    fs.copyFileSync(at('prep', 'p.txt'), at('mem', 'p.txt'));
    assert.equal(k.fs('mem').readFile('/p.txt', 'utf8'), 'raw');
    assert.equal(onDisk(at('mem', 'p.txt')), false, 'no shadow file');
  });

  it('copyFileSync of a virtual entry over a published disk-origin file', () => {
    k.fs('mem').writeFile('/v.txt', 'virtual');
    fs.copyFileSync(at('mem', 'v.txt'), at('site', 'b.txt'));
    assert.equal(readDisk(at('site', 'b.txt'), 'utf8'), 'virtual');
  });
});

describe('PlaceFs under strict: the place writes and removes what it hides', () => {
  let root;
  let k;
  const at = (...p) => path.join(root, 'site', ...p);

  before(async () => {
    root = writeTree(tmpDir('vfs-reentry-strict'), {
      'site/a.txt': 'a',
      'site/dir/c.txt': 'c',
    });
    k = await kernel(
      root,
      { site: { fs: { ext: ['txt'], writable: true } } },
      { strict: true, watchTimeout: 60000 },
    );
    // Written after the scan: on disk only, hidden from routed reads.
    writeDisk(at('late.txt'), 'late');
    writeDisk(at('hidden.txt'), 'hidden');
    mkdirDisk(at('only'));
    writeDisk(at('only', 'x.txt'), 'x');
    writeDisk(at('only', 'y.bin'), 'y');
    writeDisk(at('dir', 'late.txt'), 'late');
    writeDisk(at('dir', 'u.bin'), 'uncached');
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(root);
  });

  it('writes a new file, which routing still hides until published', () => {
    k.fs('site').writeFile('/new.txt', 'new');
    assert.equal(readDisk(at('new.txt'), 'utf8'), 'new');
    assert.throws(() => fs.readFileSync(at('new.txt')), { code: 'EACCES' });
  });

  it('removes an unpublished file and a disk-only directory', () => {
    const site = k.fs('site');
    site.rm('/late.txt');
    assert.equal(onDisk(at('late.txt')), false);
    site.rm('/only', { recursive: true });
    assert.equal(onDisk(at('only')), false);
    assert.equal(readDisk(at('a.txt'), 'utf8'), 'a', 'nothing else removed');
  });

  it('removes a directory of published, unpublished and uncached files', () => {
    assert.deepEqual(fs.readdirSync(at('dir')), ['c.txt'], 'routed listing');
    k.fs('site').rm('/dir', { recursive: true });
    assert.equal(onDisk(at('dir')), false);
  });

  it('a call that throws inside the section leaves routing in force', () => {
    assert.throws(() => k.fs('site').rm('/missing.txt'), {
      code: 'ENOENT',
      path: at('missing.txt'),
    });
    assert.throws(() => fs.readFileSync(at('hidden.txt')), {
      code: 'EACCES',
    });
  });
});

describe('copies under strict: the destination disk past the patch', () => {
  let root;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    root = writeTree(tmpDir('vfs-reentry-copy'), { 'site/a.txt': 'a' });
    k = await kernel(
      root,
      {
        site: { fs: { ext: ['txt'], writable: true } },
        mem: { provider: 'map', origin: 'virtual', fs: { writable: true } },
      },
      { strict: true, watchTimeout: 60000 },
    );
    k.fs('mem').writeFile('/x.txt', 'x');
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(root);
  });

  it('cpSync of a virtual entry creates the directories it lacks, then the file', () => {
    const to = at('site', 'deep', 'er', 'x.txt');
    fs.cpSync(at('mem', 'x.txt'), to);
    assert.equal(readDisk(to, 'utf8'), 'x');
  });

  it('the asynchronous copies write the disk the same way', async () => {
    await fs.promises.copyFile(at('mem', 'x.txt'), at('site', 'p.txt'));
    assert.equal(readDisk(at('site', 'p.txt'), 'utf8'), 'x');
    const nested = at('site', 'nested', 'q.txt');
    await fs.promises.cp(at('mem', 'x.txt'), nested);
    assert.equal(readDisk(nested, 'utf8'), 'x');
  });
});

describe('fs-patch: a passthrough is node:fs to the end', () => {
  let root;
  let out;
  let k;
  const at = (...p) => path.join(root, 'site', ...p);

  before(async () => {
    root = writeTree(tmpDir('vfs-reentry-patch'), {
      'site/a.txt': 'a',
      'site/b.txt': 'b',
      'site/c.txt': 'cc',
      'site/d.txt': 'dd',
      'site/e.txt': 'e',
    });
    out = writeTree(tmpDir('vfs-reentry-out'), { 'o.txt': 'outside' });
    k = await kernel(
      root,
      { site: { fs: { ext: ['txt'], writable: true } } },
      { watchTimeout: 60000 },
    );
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(root);
    rm(out);
  });

  it('writeFileSync / appendFileSync of a published file, with a Buffer', () => {
    fs.writeFileSync(at('a.txt'), Buffer.from('one'));
    fs.appendFileSync(at('a.txt'), Buffer.from('+2'));
    assert.equal(readDisk(at('a.txt'), 'utf8'), 'one+2');
  });

  it('writeFile / appendFile with a Buffer and a callback', async () => {
    await viaCallback((cb) => fs.writeFile(at('b.txt'), Buffer.from('3'), cb));
    await viaCallback((cb) => fs.appendFile(at('b.txt'), Buffer.from('4'), cb));
    assert.equal(readDisk(at('b.txt'), 'utf8'), '34');
  });

  it('truncateSync / truncate of a published file', async () => {
    fs.truncateSync(at('c.txt'), 1);
    await viaCallback((cb) => fs.truncate(at('d.txt'), 1, cb));
    assert.equal(readDisk(at('c.txt'), 'utf8'), 'c');
    assert.equal(readDisk(at('d.txt'), 'utf8'), 'd');
  });

  it('the promise forms of writeFile / appendFile / truncate of a published file', async () => {
    await fs.promises.writeFile(at('e.txt'), Buffer.from('five'));
    await fs.promises.appendFile(at('e.txt'), Buffer.from('+6'));
    assert.equal(readDisk(at('e.txt'), 'utf8'), 'five+6');
    await fs.promises.truncate(at('e.txt'), 4);
    assert.equal(readDisk(at('e.txt'), 'utf8'), 'five');
  });

  it('routes a passthrough once', () => {
    const routed = spyRouteRead(k);
    try {
      // A Buffer read: node:fs opens the file through fs.openSync.
      const file = path.join(out, 'o.txt');
      assert.equal(fs.readFileSync(file).toString(), 'outside');
      assert.deepEqual(routed, [file]);
    } finally {
      delete k.routeRead;
    }
  });
});

describe('fs-patch under strict: the native section and the caller', () => {
  let root;
  let out;
  let k;
  let hidden;

  before(async () => {
    root = writeTree(tmpDir('vfs-reentry-caller'), {
      'site/a.txt': 'a',
      'stray/s.txt': 'unmanaged',
    });
    out = writeTree(tmpDir('vfs-reentry-caller-out'), { 'o.txt': 'outside' });
    hidden = path.join(root, 'stray', 's.txt');
    k = await kernel(
      root,
      { site: { fs: { ext: ['txt'] } } },
      { strict: true },
    );
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(root);
    rm(out);
  });

  it('inside the section a wrapper is its original; past it, routed again', () => {
    assert.equal(readCode(hidden), 'EACCES');
    assert.equal(fs.existsSync(hidden), false);
    assert.equal(
      disk.native(() => fs.readFileSync(hidden, 'utf8')),
      'unmanaged',
    );
    assert.equal(
      disk.native(() => fs.existsSync(hidden)),
      true,
    );
    assert.equal(readCode(hidden), 'EACCES');
    assert.equal(fs.existsSync(hidden), false);
  });

  it('a callback runs after the passthrough returned: routed', async () => {
    const code = await new Promise((resolve, reject) => {
      fs.writeFile(path.join(out, 'w.txt'), Buffer.from('w'), (err) =>
        err ? reject(err) : resolve(readCode(hidden)),
      );
    });
    assert.equal(code, 'EACCES');
  });

  it('a callback node:fs calls before returning (an aborted signal): routed', () => {
    let code = null;
    const signal = AbortSignal.abort();
    fs.readFile(path.join(out, 'o.txt'), { signal }, (err) => {
      assert.equal(err.name, 'AbortError');
      code = readCode(hidden);
    });
    assert.equal(code, 'EACCES', 'called back before readFile returned');
  });

  it('a passthrough that throws leaves routing in force', () => {
    const missing = path.join(out, 'none', 'x.txt');
    assert.throws(() => fs.writeFileSync(missing, Buffer.from('x')), {
      code: 'ENOENT',
    });
    assert.equal(readCode(hidden), 'EACCES');
  });

  it("cp's filter, the caller's code, runs outside the section", async () => {
    const codes = [];
    const filter = () => {
      codes.push(readCode(hidden));
      return false;
    };
    const from = path.join(out, 'o.txt');
    const to = path.join(out, 'copy.txt');
    fs.cpSync(from, to, { filter });
    await viaCallback((cb) => fs.cp(from, to, { filter }, cb));
    await fs.promises.cp(from, to, { filter });
    assert.deepEqual(codes, ['EACCES', 'EACCES', 'EACCES']);
    assert.equal(onDisk(to), false, 'filtered out');
  });
});

describe("Node's rimraf keeps the node:fs it first loads with", () => {
  const script = path.join(__dirname, 'fixtures', 'rm-kept.cjs');
  const run = (mode) =>
    JSON.parse(
      execFileSync(process.execPath, [script, mode], { encoding: 'utf8' }),
    );

  it('loaded by initialize() before the patch: every form removes whole trees', () => {
    assert.deepEqual(run('native'), {
      mode: 'native',
      loadedBefore: false,
      loadedAtInstall: true,
      loadedAtRemoval: true,
      failed: {},
      left: [],
    });
  });

  it('loaded under the patch, as in a worker: the synchronous forms still do', () => {
    assert.deepEqual(run('patched'), {
      mode: 'patched',
      loadedBefore: false,
      loadedAtInstall: false,
      loadedAtRemoval: true,
      failed: {},
      left: [],
    });
  });

  it('a close() while initialize() waits for it is final', async () => {
    const root = tmpDir('vfs-reentry-close');
    const places = { v: { origin: 'virtual', fs: { writable: true } } };
    const k = new VfsKernel(config(places), { appRoot: root, console: quiet });
    const init = k.initialize();
    k.close();
    await assert.rejects(init, /kernel closed before publication/);
    assert.equal(k.state, 'closed');
    assert.equal(k.cache, null);
    rm(root);
  });
});
