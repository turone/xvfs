'use strict';

const { tmpDir, writeTree, cleanup, kernel, memory } = require('../lib.js');

// PlaceFs reads over sab and map: owned copies, leases, stat, exists and a
// 100-entry listing; 1 KiB and 1 MiB files.

const PROVIDERS = ['sab', 'map'];
const SIZES = [
  ['1k', '/small.txt', 1024],
  ['1m', '/large.bin', 2 ** 20],
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
    memory(b, 'read', k);
  } finally {
    k.close();
    cleanup(root);
  }
};
