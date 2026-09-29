'use strict';

// The generator worker of async-worker: the heavy lifting — building a
// report from a dataset with async crypto and zlib — happens here, then
// this worker publishes the result itself. `writeFiles` crosses this
// worker's own RPC to the main thread, which checks, prepares (there is no
// preparer for this place) and compiles (`fs.script.compile`, for
// render.js) and publishes the whole set in one commit before this
// worker's call resolves (README, "writeFiles" and "sab + virtual").

const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { webcrypto } = require('node:crypto');
const { parentPort } = require('node:worker_threads');
const { attach } = require('../..');

const gzip = promisify(zlib.gzip);
const kernel = attach();
const reports = kernel.fs('reports');

// A plain function, never eval'd: its own `toString()` is what render.js
// publishes, wrapped in parens so running that text with `vm.Script`
// yields the function itself — a bare function declaration has no
// completion value, a parenthesized function expression does (as in the
// ssr and prepared-scripts examples).
function render(report) {
  return (
    '<!doctype html><html><body>' +
    `<h1>Report #${report.round}</h1>` +
    `<p>count=${report.count} sum=${report.sum} avg=${report.avg.toFixed(2)}</p>` +
    `<p>sha256=${report.sha256}</p>` +
    `<p>gzip=${report.gzipBytes}b</p>` +
    '</body></html>\n'
  );
}
const RENDER_SOURCE = `(${render.toString()})`;

// The heavy async transformation: no network, no dependency — Web Crypto
// (genuinely async) for the hash, zlib's callback API (promisified) for
// the compression, several `await`s in between.
const buildReport = async (round, dataset) => {
  const input = Buffer.from(JSON.stringify(dataset));
  const digest = await webcrypto.subtle.digest('SHA-256', input);
  const gzipped = await gzip(input);
  const sum = dataset.reduce((a, b) => a + b, 0);
  return {
    round,
    count: dataset.length,
    sum,
    avg: sum / dataset.length,
    min: Math.min(...dataset),
    max: Math.max(...dataset),
    sha256: Buffer.from(digest).toString('hex'),
    gzipBytes: gzipped.length,
  };
};

parentPort.on('message', async ({ cmd, round, dataset, badRenderSource }) => {
  if (cmd !== 'generate') return;
  try {
    const report = await buildReport(round, dataset);
    // Several related artifacts, one atomic publication: either all three
    // are published together, in one commit, or none of them are.
    const version = await reports.writeFiles([
      ['/report.html', render(report)],
      ['/report.json', `${JSON.stringify(report, null, 2)}\n`],
      ['/render.js', badRenderSource || RENDER_SOURCE],
    ]);
    parentPort.postMessage({
      round,
      ok: true,
      version,
      sha256: report.sha256,
      gzipBytes: report.gzipBytes,
    });
  } catch (err) {
    parentPort.postMessage({
      round,
      ok: false,
      code: err.code,
      message: err.message,
    });
  }
});
