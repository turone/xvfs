'use strict';

const { Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { tmpDir, writeTree, cleanup, kernel, memory } = require('../lib.js');

// createReadStream throughput of an 8 MiB file piped to a discarding sink:
// borrowed SAB chunks (zero-copy) against owned copies.

const SIZE = 8 * 2 ** 20;

const sink = () =>
  new Writable({
    write(chunk, encoding, callback) {
      callback();
    },
  });

module.exports = async (b) => {
  const root = writeTree(tmpDir('stream'), {
    'site/big.bin': Buffer.alloc(SIZE, 98),
  });
  const k = await kernel(root, { site: { fs: { zeroCopy: true } } });
  const site = k.fs('site');
  const run = (zeroCopy) => async () => {
    const stream = site.createReadStream('/big.bin', { zeroCopy });
    try {
      await pipeline(stream, sink());
    } finally {
      stream.release();
    }
  };
  try {
    await b.throughput('stream.zerocopy', SIZE, run(true));
    await b.throughput('stream.owned', SIZE, run(false));
    memory(b, 'stream', k);
  } finally {
    k.close();
    cleanup(root);
  }
};
