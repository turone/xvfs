'use strict';

const { tmpDir, cleanup, kernel, emptySegments, memory } = require('../lib.js');

// Compaction: 1 MiB segments; segment 1 holds a 700 KiB file and 256 files
// of 1 KiB, segment 2 a 600 KiB file. Unlinking the big one leaves segment 1
// at 25 % — below the 0.3 threshold — so that unlink also relocates the 256
// small files into segment 2, publishes the moves, frees the old extents
// and returns segment 1 to the pool. `off` is the same unlink with
// compaction disabled.

const KIB = 1024;
const SMALL = 256;
const MEMORY = { limit: '8 mib', segmentSize: '1 mib', maxFileSize: '1 mib' };
const PLACES = { v: { origin: 'virtual', fs: { writable: true } } };

const fill = async (k) => {
  const v = k.fs('v');
  await v.writeFile('/big.bin', Buffer.alloc(700 * KIB, 1));
  const small = Buffer.alloc(KIB, 2);
  for (let i = 0; i < SMALL; i++) await v.writeFile(`/s/${i}.bin`, small);
  await v.writeFile('/fill.bin', Buffer.alloc(600 * KIB, 3));
  return v;
};

const run = async (b, name, threshold) => {
  const root = tmpDir('compact');
  const defaults = { memory: MEMORY, compaction: { threshold } };
  let last = null;
  try {
    await b.latency(
      `compact.${name}`,
      async (i, { k, v }) => {
        await v.unlink('/big.bin');
        const expected = threshold > 0 ? 1 : 0;
        if (emptySegments(k) !== expected) {
          throw new Error(`compaction: ${emptySegments(k)} empty segments`);
        }
      },
      {
        warmup: 3,
        samples: 20,
        setup: async () => {
          if (last) last.close();
          const k = await kernel(root, PLACES, defaults);
          last = k;
          return { k, v: await fill(k) };
        },
      },
    );
    if (threshold > 0) memory(b, 'compact', last);
  } finally {
    if (last) last.close();
    cleanup(root);
  }
};

module.exports = async (b) => {
  await run(b, 'on', 0.3);
  await run(b, 'off', 0);
};
