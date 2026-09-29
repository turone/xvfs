'use strict';

const { tmpDir, writeTree, cleanup, kernelOf, memory } = require('../lib.js');

// initialize() over a tree of 2000 files of 1 KiB in 20 directories: scan,
// stable reads, placement and one epoch — into SAB and into a per-thread
// Map. Each sample is a new kernel; the OS page cache is warm after the
// warm-up.

const COUNT = 2000;

module.exports = async (b) => {
  const files = {};
  const data = Buffer.alloc(1024, 103);
  for (let i = 0; i < COUNT; i++) {
    files[`sab/d${i % 20}/f${i}.txt`] = data;
    files[`map/d${i % 20}/f${i}.txt`] = data;
  }
  const root = writeTree(tmpDir('init'), files);
  let last = null;
  const run = async (name, place) => {
    await b.latency(
      `init.${name}.${COUNT}`,
      async (i, k) => {
        await k.initialize();
      },
      {
        warmup: 2,
        samples: 5,
        setup: () => {
          if (last) last.close();
          last = kernelOf(root, { [name]: place });
          return last;
        },
      },
    );
  };
  try {
    await run('sab', { fs: true });
    memory(b, 'init.sab', last);
    await run('map', { provider: 'map', fs: true });
    memory(b, 'init.map', last);
  } finally {
    if (last) last.close();
    cleanup(root);
  }
};
