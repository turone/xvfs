'use strict';

const fs = require('node:fs');
const path = require('node:path');
const fsPatch = require('../../lib/adapters/fs-patch.js');
const { tmpDir, writeTree, cleanup, kernel, memory } = require('../lib.js');

// The patched node:fs: readFileSync, statSync, existsSync and readdirSync
// over a VFS place, over paths outside the places (outside appRoot) and
// over the disk territory of `fs.fallback: 'disk'` — the cost of routing.
// `native` is the same call on the outside paths before the patch.

const OPS = {
  readFileSync: (p) => fs.readFileSync(p.file),
  statSync: (p) => fs.statSync(p.file),
  existsSync: (p) => fs.existsSync(p.file),
  readdirSync: (p) => fs.readdirSync(p.dir),
};

const dirOf = (prefix, ext) => {
  const files = {};
  for (let i = 0; i < 100; i++) files[`${prefix}/dir/f${i}.${ext}`] = 'x';
  return files;
};

module.exports = async (b) => {
  const one = Buffer.alloc(1024, 99);
  const root = writeTree(tmpDir('patch'), {
    'vfs/a.txt': one,
    ...dirOf('vfs', 'txt'),
    'terr/a.bin': one,
    ...dirOf('terr', 'bin'),
  });
  const outside = writeTree(tmpDir('patch-out'), {
    'a.txt': one,
    ...dirOf('', 'txt'),
  });
  const k = await kernel(root, {
    vfs: { fs: true },
    terr: { fs: { ext: ['txt'], fallback: 'disk' } },
  });
  const targets = {
    vfs: {
      file: path.join(root, 'vfs', 'a.txt'),
      dir: path.join(root, 'vfs', 'dir'),
    },
    outside: {
      file: path.join(outside, 'a.txt'),
      dir: path.join(outside, 'dir'),
    },
    territory: {
      file: path.join(root, 'terr', 'a.bin'),
      dir: path.join(root, 'terr', 'dir'),
    },
  };
  try {
    for (const [name, op] of Object.entries(OPS)) {
      b.ops(`patch.native.${name}`, () => op(targets.outside));
    }
    fsPatch.install(k);
    try {
      for (const [where, p] of Object.entries(targets)) {
        for (const [name, op] of Object.entries(OPS)) {
          b.ops(`patch.${where}.${name}`, () => op(p));
        }
      }
    } finally {
      fsPatch.uninstall();
    }
    memory(b, 'patch', k);
  } finally {
    k.close();
    cleanup(root);
    cleanup(outside);
  }
};
