'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scan, keyOf, linksOf } = require('../lib/scanner.js');
const { tmpDir, writeTree, rm } = require('./helpers.js');

describe('scanner', () => {
  let root;
  let canSymlink = true;

  before(() => {
    root = writeTree(tmpDir('scan'), {
      'a.html': 'A',
      'sub/b.JS': 'B',
      'sub/deep/c.txt': 'C',
      noext: 'N',
    });
    try {
      fs.symlinkSync(
        path.join(root, 'a.html'),
        path.join(root, 'link.html'),
        'file',
      );
      fs.symlinkSync(
        path.join(root, 'sub'),
        path.join(root, 'linkdir'),
        'junction',
      );
    } catch {
      canSymlink = false;
    }
  });

  after(() => rm(root));

  it('keys are /-separated, relative, with leading slash', async () => {
    const files = await scan(root);
    const keys = [...files.keys()].sort();
    assert.deepEqual(
      keys.filter((k) => !k.startsWith('/link')),
      ['/a.html', '/noext', '/sub/b.JS', '/sub/deep/c.txt'],
    );
    const b = files.get('/sub/b.JS');
    assert.equal(b.path, path.join(root, 'sub', 'b.JS'));
    assert.deepEqual(Object.keys(b.stat).sort(), ['mtimeMs', 'size']);
    assert.equal(b.stat.size, 1);
    assert.equal(keyOf(path.join(root, 'x', 'y.z'), root), '/x/y.z');
  });

  it('filters by ext (case-insensitive, no dots)', async () => {
    const files = await scan(root, { ext: ['js'] });
    assert.deepEqual([...files.keys()], ['/sub/b.JS']);
  });

  it('startPath scans a subtree with keys relative to root', async () => {
    const files = await scan(root, {
      startPath: path.join(root, 'sub', 'deep'),
    });
    assert.deepEqual([...files.keys()], ['/sub/deep/c.txt']);
  });

  it('missing directory yields an empty map', async () => {
    const files = await scan(path.join(root, 'nope'));
    assert.equal(files.size, 0);
  });

  // The stats run several at a time and finish in any order; the result
  // keeps the order of the walk: each directory as readdir lists it, its
  // subdirectories depth first where they are listed.
  it('keeps the order of the walk, whatever order the stats finish in', async () => {
    const tree = {};
    for (let d = 0; d < 6; d++) {
      tree[`d${d}.txt`] = 'd';
      for (let f = 0; f < 40; f++) tree[`d${d}/s${f % 3}/f${f}.txt`] = 'f';
    }
    const base = writeTree(tmpDir('scan-order'), tree);
    try {
      const walk = (dir) =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) return walk(abs);
          return entry.isFile() ? [keyOf(abs, base)] : [];
        });
      const walked = walk(base);
      const files = await scan(base);
      assert.equal(files.size, Object.keys(tree).length);
      assert.deepEqual([...files.keys()], walked);
      // From a startPath: its subtree in the same order, keyed from the root.
      const sub = await scan(base, { startPath: path.join(base, 'd1') });
      assert.deepEqual(
        [...sub.keys()],
        walked.filter((key) => key.startsWith('/d1/')),
      );
    } finally {
      rm(base);
    }
  });

  // A filesystem that reports no entry types (simulated: the fs binding
  // reports each one unknown) makes readdir lstat every entry through the
  // public node:fs. Where that fails — refused past the patch, here by a
  // stand-in for it — the scanner types the names itself, through
  // lib/disk.js, and keeps the order of the walk.
  it('types entries through lib/disk.js when the public node:fs refuses', async (t) => {
    const binding = process.binding?.('fs');
    if (typeof binding?.readdir !== 'function') {
      t.skip('no fs binding to simulate the filesystem with');
      return;
    }
    const tree = {};
    for (let d = 0; d < 3; d++) {
      tree[`d${d}.txt`] = 'd';
      for (let f = 0; f < 20; f++) tree[`d${d}/s${f % 2}/f${f}.txt`] = 'f';
    }
    const base = writeTree(tmpDir('scan-dtype'), tree);
    const expected = [...(await scan(base)).keys()];
    const { readdir } = binding;
    const { lstat } = fs;
    const { lstat: lstatPromise } = fs.promises;
    const refused = (p) =>
      Object.assign(new Error(`EACCES: permission denied, lstat '${p}'`), {
        code: 'EACCES',
      });
    let asked = 0;
    try {
      binding.readdir = function (...args) {
        const result = readdir.apply(this, args);
        if (!args[2] || typeof result?.then !== 'function') return result;
        return result.then(([names, types]) => [names, types.map(() => 0)]);
      };
      fs.lstat = (p, ...args) => {
        asked++;
        process.nextTick(args.at(-1), refused(p));
      };
      fs.promises.lstat = async (p) => {
        asked++;
        throw refused(p);
      };
      const files = await scan(base);
      assert.ok(asked > 0, 'readdir asked the public node:fs');
      assert.deepEqual([...files.keys()], expected);
      assert.equal(files.size, Object.keys(tree).length);
    } finally {
      binding.readdir = readdir;
      fs.lstat = lstat;
      fs.promises.lstat = lstatPromise;
      rm(base);
    }
  });

  it('never traverses directory links; file links only with followSymlinks', async (t) => {
    if (!canSymlink) {
      t.skip('symlinks unavailable');
      return;
    }
    const strict = await scan(root);
    assert.ok(!strict.has('/link.html'));
    assert.ok(![...strict.keys()].some((k) => k.startsWith('/linkdir')));
    const loose = await scan(root, { followSymlinks: true });
    assert.ok(loose.has('/link.html'));
    assert.ok(![...loose.keys()].some((k) => k.startsWith('/linkdir')));
  });

  // Every link the walk meets, for the kernel's index of links: scan()
  // with `links`, and linksOf(), a walk that reads no stats. Junctions
  // take no privilege on Windows; each would loop, if entered.
  it('links: every link the walk meets, entering none', async () => {
    const base = writeTree(tmpDir('scan-links'), {
      'a/b/f.txt': 'f',
      'x.txt': 'x',
    });
    const j1 = path.join(base, 'a', 'j1');
    const j2 = path.join(base, 'a', 'b', 'j2');
    fs.symlinkSync(path.join(base, 'a'), j1, 'junction');
    fs.symlinkSync(base, j2, 'junction');
    try {
      const links = [];
      const files = await scan(base, { links });
      assert.deepEqual([...files.keys()].sort(), ['/a/b/f.txt', '/x.txt']);
      assert.deepEqual(links.sort(), [j1, j2].sort());
      assert.deepEqual((await linksOf(base)).sort(), [j1, j2].sort());
      const below = path.join(base, 'a', 'b');
      assert.deepEqual(await linksOf(base, { startPath: below }), [j2]);
      assert.deepEqual(await linksOf(path.join(base, 'none')), []);
    } finally {
      fs.unlinkSync(j1);
      fs.unlinkSync(j2);
      rm(base);
    }
  });
});
