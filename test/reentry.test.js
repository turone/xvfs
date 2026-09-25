'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const fsPatch = require('../lib/adapters/fs-patch.js');
const { tmpDir, writeTree, rm, kernel, drain } = require('./helpers.js');

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

describe("Node's rimraf, first loaded while the patch is installed", () => {
  it('removes whole trees: published, hidden and disk-only entries', () => {
    const script = path.join(__dirname, 'fixtures', 'rm-kept.cjs');
    const out = execFileSync(process.execPath, [script], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), {
      loadedBefore: false,
      failed: {},
      left: [],
    });
  });
});
