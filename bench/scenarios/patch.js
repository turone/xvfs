'use strict';

const fs = require('node:fs');
const path = require('node:path');
const fsPatch = require('../../lib/adapters/fs-patch.js');
const { tmpDir, writeTree, cleanup, kernel, memory } = require('../lib.js');

// The patched node:fs: readFileSync, statSync, existsSync and readdirSync
// over a VFS place, over paths outside the places (outside appRoot) and
// over the disk territory of `fs.fallback: 'disk'` — the cost of routing.
// `native` is the same call on the outside paths before the patch.
// `strict.*` is the same under strict, and over a `disk` place: with
// `links: 'deny'`, the default, a native call on a place's disk is checked
// against the links the kernel knows; `strict.verify.*` proves where its
// path really lies first (one realpath) — strict as it was where the
// library does not know `links` (a base of bench/ab.js before it).
// `*.w.*` are mutations of a writable `disk` place — a file written and
// removed, a file renamed and back, a directory made and removed with
// `recursive`, a directory renamed and back — where under strict a
// removal or a rename also asks whether its path is a link (one lstat
// each), and a recursive removal or a directory's rename where it really
// lies (one realpath).

const OPS = {
  readFileSync: (p) => fs.readFileSync(p.file),
  statSync: (p) => fs.statSync(p.file),
  existsSync: (p) => fs.existsSync(p.file),
  readdirSync: (p) => fs.readdirSync(p.dir),
};

const MUTATIONS = {
  writeUnlink: (p) => {
    fs.writeFileSync(p.fresh, 'x');
    fs.unlinkSync(p.fresh);
  },
  renameBack: (p) => {
    fs.renameSync(p.file, p.moved);
    fs.renameSync(p.moved, p.file);
  },
  mkdirRmTree: (p) => {
    fs.mkdirSync(p.tree);
    fs.rmSync(p.tree, { recursive: true });
  },
  renameDirBack: (p) => {
    fs.renameSync(p.dir, p.movedDir);
    fs.renameSync(p.movedDir, p.dir);
  },
};

const dirOf = (prefix, ext) => {
  const files = {};
  for (let i = 0; i < 100; i++) files[`${prefix}/dir/f${i}.${ext}`] = 'x';
  return files;
};

const PLACES = {
  vfs: { fs: true },
  terr: { fs: { ext: ['txt'], fallback: 'disk' } },
  d: { provider: 'disk', fs: true },
  w: { provider: 'disk', fs: { writable: true } },
};

// Every target of `targets` under the patch installed with `k`: the reads,
// and the mutations of `w`.
const measure = (b, prefix, k, targets) => {
  fsPatch.install(k);
  try {
    for (const [where, p] of Object.entries(targets)) {
      const ops = where === 'w' ? MUTATIONS : OPS;
      for (const [name, op] of Object.entries(ops)) {
        b.ops(`${prefix}.${where}.${name}`, () => op(p));
      }
    }
  } finally {
    fsPatch.uninstall();
  }
};

// A strict kernel with `links: 'verify'`, or strict as it was.
const verifying = async (root) => {
  try {
    return await kernel(root, PLACES, { strict: true, links: 'verify' });
  } catch (err) {
    if (!/links/.test(err.message)) throw err;
    return kernel(root, PLACES, { strict: true });
  }
};

module.exports = async (b) => {
  const one = Buffer.alloc(1024, 99);
  const root = writeTree(tmpDir('patch'), {
    'vfs/a.txt': one,
    ...dirOf('vfs', 'txt'),
    'terr/a.bin': one,
    ...dirOf('terr', 'bin'),
    'd/a.bin': one,
    ...dirOf('d', 'bin'),
    'w/a.bin': one,
    'w/dir/a.bin': one,
  });
  const outside = writeTree(tmpDir('patch-out'), {
    'a.txt': one,
    ...dirOf('', 'txt'),
  });
  const k = await kernel(root, PLACES);
  const strict = await kernel(root, PLACES, { strict: true });
  const verify = await verifying(root);
  const at = (place) => ({
    file: path.join(root, place, place === 'vfs' ? 'a.txt' : 'a.bin'),
    dir: path.join(root, place, 'dir'),
    fresh: path.join(root, place, 'n.bin'),
    moved: path.join(root, place, 'b.bin'),
    tree: path.join(root, place, 't'),
    movedDir: path.join(root, place, 'dir2'),
  });
  const targets = {
    vfs: at('vfs'),
    outside: {
      file: path.join(outside, 'a.txt'),
      dir: path.join(outside, 'dir'),
    },
    territory: at('terr'),
  };
  const w = at('w');
  try {
    for (const [name, op] of Object.entries(OPS)) {
      b.ops(`patch.native.${name}`, () => op(targets.outside));
    }
    measure(b, 'patch', k, { ...targets, w });
    measure(b, 'patch.strict', strict, { ...targets, disk: at('d'), w });
    const { territory } = targets;
    const onDisk = { territory, disk: at('d'), w };
    measure(b, 'patch.strict.verify', verify, onDisk);
    memory(b, 'patch', k);
  } finally {
    k.close();
    strict.close();
    verify.close();
    cleanup(root);
    cleanup(outside);
  }
};
