'use strict';

const path = require('node:path');
// Captured before any scenario installs the fs patch.
const { readFileSync } = require('node:fs');
const { tmpDir, writeTree, cleanup, kernel, memory } = require('../lib.js');

// PlaceFs reads over sab and map: owned copies, leases, stat, exists and a
// 100-entry listing; 1 KiB, 64 KiB, 1 MiB and 8 MiB files. `disk` is
// readFileSync of the same file through node:fs, the OS page cache warm.

const PROVIDERS = ['sab', 'map'];
const SIZES = [
  ['1k', '/small.txt', 1024],
  ['64k', '/medium.txt', 64 * 1024],
  ['1m', '/large.bin', 2 ** 20],
  ['8m', '/huge.bin', 8 * 2 ** 20],
];

module.exports = async (b) => {
  const files = {};
  for (const name of PROVIDERS) {
    for (const [, key, size] of SIZES)
      files[name + key] = Buffer.alloc(size, 97);
    for (let i = 0; i < 100; i++) files[`${name}/dir/f${i}.txt`] = 'x';
  }
  const root = writeTree(tmpDir('read'), files);
  const k = await kernel(root, {
    sab: { fs: { zeroCopy: true } },
    map: { provider: 'map', fs: { zeroCopy: true } },
  });
  try {
    for (const name of PROVIDERS) {
      const place = k.fs(name);
      for (const [size, key] of SIZES) {
        b.ops(`read.${name}.${size}.readFile`, () => place.readFile(key));
        b.ops(`read.${name}.${size}.view`, () =>
          place.readFileView(key).release(),
        );
      }
      b.ops(`read.${name}.stat`, () => place.stat('/small.txt'));
      b.ops(`read.${name}.exists`, () => place.exists('/small.txt'));
      b.ops(`read.${name}.readdir100`, () => place.readdir('/dir'));
    }
    for (const [size, key] of SIZES) {
      const file = path.join(root, 'sab', key);
      b.ops(`read.disk.${size}.readFileSync`, () => readFileSync(file));
    }
    memory(b, 'read', k);
  } finally {
    k.close();
    cleanup(root);
  }
};
