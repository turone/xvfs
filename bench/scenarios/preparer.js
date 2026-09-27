'use strict';

const { tmpDir, cleanup, kernel, memory } = require('../lib.js');

// Publication of a preparer's result into a `sab + virtual` place, by what
// the preparer returns and how large it is: latency of one writeFile until
// its version is published, for 64 KiB, 1 MiB and 8 MiB. A virtual write
// copies its input before anything runs (VirtualStore.write); the kinds
// differ in what follows:
//   raw     null — the raw input is placed as it is: one more copy, into
//           SAB
//   same    the raw Buffer itself: the same
//   buffer  a Buffer of its own, made once: copied into an owned Buffer,
//           then into SAB — one copy more than raw
//   uint8   a Uint8Array of its own, made once: the same
//   string  a string of that length: encoded into an owned Buffer, then
//           copied into SAB
// The difference between `raw` and `uint8` is what writing a Uint8Array
// result straight into its SAB allocation could save.

const KIB = 1024;
const SIZES = [
  ['64k', 64 * KIB],
  ['1m', 1024 * KIB],
  ['8m', 8 * 1024 * KIB],
];
const KINDS = ['raw', 'same', 'buffer', 'uint8', 'string'];
const NO_HOOKS = { hooks: { fs: false, module: false } };

module.exports = async (b) => {
  const root = tmpDir('preparer');
  let kind = 'raw';
  let results = null; // { buffer, uint8, string } of the size under test
  const preparers = {
    // What it returns depends on the kind under test, never on the input.
    result: (raw) => {
      if (kind === 'raw') return null;
      if (kind === 'same') return raw;
      return results[kind];
    },
  };
  const k = await kernel(
    root,
    {
      v: {
        origin: 'virtual',
        fs: { writable: true, prepare: { result: ['bin'] } },
      },
    },
    NO_HOOKS,
    { preparers },
  );
  const v = k.fs('v');
  try {
    for (const [name, size] of SIZES) {
      const buffer = Buffer.alloc(size, 65);
      results = {
        buffer,
        uint8: new Uint8Array(buffer.buffer.slice(0), 0, size),
        string: buffer.toString('latin1'),
      };
      const raw = Buffer.alloc(size, 66);
      const samples = size >= 8 * 1024 * KIB ? 30 : 100;
      for (const next of KINDS) {
        kind = next;
        await b.latency(
          `preparer.${kind}.${name}`,
          () => v.writeFile('/f.bin', raw),
          { warmup: 5, samples },
        );
      }
    }
    memory(b, 'preparer', k);
  } finally {
    k.close();
    cleanup(root);
  }
};
