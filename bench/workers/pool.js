'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');
const { parentPort, workerData } = require('node:worker_threads');

// A worker of the pool scenario: it serves requests over one file set in
// one of three ways and times each one. A request resolves a key, gets
// the bytes and copies them into a response buffer — the socket write —
// so the modes differ only in how the bytes are obtained:
//   sab    attach() to the main kernel; a lease (readFileView) around the
//          copy, released at once
//   cache  every file read into a Map of owned Buffers at start — the
//          per-worker cache; a request copies the Buffer
//   fs     no cache: fs.promises.readFile per request
// With `gzip` a request serves the compressed representation: `sab` takes
// readFileCompressedView(key, 'gzip'), the others compress per request
// with zlib.gzipSync, as a server without a compressed cache does.
//
// Messages, answered one at a time:
//   { cmd: 'run', ms, seed }     → { count, ns, samples: Float64Array }
//   { cmd: 'update', key, data } → { updated: key }   (cache only)
//   { cmd: 'mem' }               → process.memoryUsage() after gc()

const { mode, gzip, files, vfs, place } = workerData;
const KEEP = 100000; // samples kept per run: a reservoir past that

const paths = files.map((file) => file.path);
const keys = files.map((file) => file.key);
const largest = Math.max(...files.map((file) => file.size));
const response = Buffer.allocUnsafe(gzip ? largest + 1024 : largest);

let serve;
if (mode === 'sab') {
  const kernel = require('../../index.js').attach({ link: vfs });
  const site = kernel.fs(place);
  serve = gzip
    ? (i) => {
        const lease = site.readFileCompressedView(keys[i], 'gzip');
        const length = lease.view.copy(response);
        lease.release();
        return length;
      }
    : (i) => {
        const lease = site.readFileView(keys[i]);
        const length = lease.view.copy(response);
        lease.release();
        return length;
      };
} else if (mode === 'cache') {
  const cache = paths.map((p) => fs.readFileSync(p));
  serve = gzip
    ? (i) => zlib.gzipSync(cache[i]).copy(response)
    : (i) => cache[i].copy(response);
  parentPort.on('message', (msg) => {
    if (msg.cmd !== 'update') return;
    const { data } = msg;
    cache[keys.indexOf(msg.key)] = Buffer.from(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
    parentPort.postMessage({ updated: msg.key });
  });
} else {
  const { readFile } = fs.promises;
  serve = gzip
    ? async (i) => zlib.gzipSync(await readFile(paths[i])).copy(response)
    : async (i) => (await readFile(paths[i])).copy(response);
}

const run = async ({ ms, seed }) => {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const samples = new Float64Array(KEEP);
  let count = 0;
  const start = process.hrtime.bigint();
  const deadline = start + BigInt(ms) * 1000000n;
  let t = start;
  while (t < deadline) {
    const t0 = t;
    await serve(next() % files.length);
    t = process.hrtime.bigint();
    const dt = Number(t - t0);
    if (count < KEEP) samples[count] = dt;
    else {
      const j = next() % (count + 1);
      if (j < KEEP) samples[j] = dt;
    }
    count++;
  }
  const kept = samples.subarray(0, Math.min(count, KEEP));
  parentPort.postMessage({ count, ns: Number(t - start), samples: kept }, [
    samples.buffer,
  ]);
};

parentPort.on('message', (msg) => {
  if (msg.cmd === 'run') run(msg);
  else if (msg.cmd === 'mem') {
    if (global.gc) global.gc();
    parentPort.postMessage(process.memoryUsage());
  }
});
parentPort.postMessage('ready');
