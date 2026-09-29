'use strict';

const path = require('node:path');
// Captured before any scenario installs the fs patch.
const { createReadStream } = require('node:fs');
const { Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { tmpDir, writeTree, cleanup, kernel, memory } = require('../lib.js');

// createReadStream throughput piped to a discarding sink: borrowed SAB
// chunks (zero-copy) against owned copies, for 64 KiB, 1 MiB and 8 MiB
// files and a highWaterMark of 16 KiB, 64 KiB (the default) and 256 KiB;
// `disk` is node:fs createReadStream of the same file, the page cache
// warm. `stream.zerocopy` / `stream.owned` are the 8 MiB file at the
// default highWaterMark, as measured before the matrix existed.

const KIB = 1024;
const SIZES = [
  ['64k', '/medium.bin', 64 * KIB],
  ['1m', '/large.bin', 2 ** 20],
  ['8m', '/big.bin', 8 * 2 ** 20],
];
const MARKS = [
  ['16k', 16 * KIB],
  ['64k', 64 * KIB],
  ['256k', 256 * KIB],
];

const sink = () =>
  new Writable({
    write(chunk, encoding, callback) {
      callback();
    },
  });

module.exports = async (b) => {
  const files = {};
  for (const [, key, size] of SIZES)
    files['site' + key] = Buffer.alloc(size, 98);
  const root = writeTree(tmpDir('stream'), files);
  const k = await kernel(root, { site: { fs: { zeroCopy: true } } });
  const site = k.fs('site');
  // A node:fs stream has no release(): pipeline destroyed it already.
  const drain = async (stream) => {
    try {
      await pipeline(stream, sink());
    } finally {
      if (stream.release) stream.release();
    }
  };
  const shared = (key, zeroCopy, highWaterMark) => () =>
    drain(site.createReadStream(key, { zeroCopy, highWaterMark }));
  const disk = (key, highWaterMark) => () =>
    drain(createReadStream(path.join(root, 'site', key), { highWaterMark }));
  try {
    const big = SIZES[2][1];
    await b.throughput('stream.zerocopy', SIZES[2][2], shared(big, true));
    await b.throughput('stream.owned', SIZES[2][2], shared(big, false));
    for (const [size, key, bytes] of SIZES) {
      for (const [mark, highWaterMark] of MARKS) {
        const suffix = `${size}.hwm${mark}`;
        await b.throughput(
          `stream.zerocopy.${suffix}`,
          bytes,
          shared(key, true, highWaterMark),
        );
        await b.throughput(
          `stream.owned.${suffix}`,
          bytes,
          shared(key, false, highWaterMark),
        );
        await b.throughput(
          `stream.disk.${suffix}`,
          bytes,
          disk(key, highWaterMark),
        );
      }
    }
    memory(b, 'stream', k);
  } finally {
    k.close();
    cleanup(root);
  }
};
