'use strict';

// async-worker — a worker performs a heavy async transformation and
// publishes the result itself; other workers learn of it only through
// publication events, and read a consistent set.
//
// A "generator" worker builds a report from a dataset — an async crypto
// hash and async zlib compression, several `await`s, no network, no
// dependency — then writes three related artifacts (report.html,
// report.json, render.js) as one atomic `writeFiles` call of its own: the
// write crosses this worker's RPC to the main thread, which checks,
// compiles (`fs.script.compile`, for render.js) and publishes the whole
// set in one commit before the generator's call resolves (README,
// "writeFiles" and "sab + virtual").
//
// Two "reader" workers never write. Each learns of a new report only
// through its own kernel's `'publish'` event (README, "Publication
// events") and then reads report.html, report.json and render.js as one
// set: every artifact carries the same version (README, "Versions"), and
// render.js — run from the V8 cached data `fs.script.compile` built —
// reproduces report.html exactly. A batch that cannot publish (round 3: a
// render.js that does not compile) leaves the whole previous set as it
// was — the readers' next read is round 2, in full, never a mix of round
// 2 and round 3.
//
// Run:
//   node examples/async-worker/run.js

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { VfsConfig, VfsKernel } = require('../..');

const APP_ROOT = __dirname;

// Deterministic datasets — no Math.random, no wall clock — so a run is
// reproducible; round 2's dataset differs from round 1's, so the report
// (and its hash) changes.
const dataset = (seed, n = 256) =>
  Array.from({ length: n }, (_, i) => ((i + 1) * seed + i * i) % 1000);
const DATASET_A = dataset(37);
const DATASET_B = dataset(53);
// Unbalanced parens: valid data, but fs.script.compile can never compile
// it — the same failure examples/mutation-rpc.test.js exercises directly.
const BAD_RENDER_SOURCE = '(((';

const config = new VfsConfig({
  defaults: {
    memory: { limit: '2 mib', segmentSize: '512 kib', maxFileSize: '128 kib' },
  },
  places: {
    // Application-written content, no preparer: the generator worker
    // writes final bytes straight through — an async preparer is not what
    // this example demonstrates, the heavy work stays in the worker.
    reports: {
      origin: 'virtual',
      fs: {
        writable: true,
        ext: ['html', 'json', 'js'],
        script: { ext: ['js'], compile: true },
      },
    },
  },
});

const kernel = new VfsKernel(config, { appRoot: APP_ROOT });

// Resolves with the next message of `worker` that matches `predicate`.
// Listeners go on before any postMessage that could cause the reply, so a
// fast one is never missed (as in the ssr and etag examples).
const nextFrom = (worker, predicate) =>
  new Promise((resolve, reject) => {
    const onError = reject;
    const onMessage = (msg) => {
      if (!predicate(msg)) return;
      worker.off('message', onMessage);
      worker.off('error', onError);
      resolve(msg);
    };
    worker.on('message', onMessage);
    worker.once('error', onError);
  });

const cacheLabel = (rejected) => (rejected ? 'rejected' : 'accepted');

(async () => {
  await kernel.initialize();
  const reports = kernel.fs('reports');

  const { vfs: genVfs, transferList: genTransfer } = kernel.link();
  const generator = new Worker(path.join(__dirname, 'generator.js'), {
    workerData: { vfs: genVfs },
    transferList: genTransfer,
  });

  const readers = [];
  for (let id = 1; id <= 2; id++) {
    const { vfs, transferList } = kernel.link();
    readers.push(
      new Worker(path.join(__dirname, 'reader.js'), {
        workerData: { vfs, id },
        transferList,
      }),
    );
  }

  // Round 1 and 2: the generator publishes, and both readers' own
  // 'publish' listener announces it — collected here by the round number
  // carried in the report itself.
  const runRound = async (round, data) => {
    const published = Promise.all(
      readers.map((reader) =>
        nextFrom(
          reader,
          (msg) => msg.kind === 'published' && msg.round === round,
        ),
      ),
    );
    const reply = nextFrom(generator, (msg) => msg.round === round);
    generator.postMessage({ cmd: 'generate', round, dataset: data });
    const gen = await reply;
    console.log(
      `generator round ${round}: published version=${gen.version} ` +
        `sha256=${gen.sha256.slice(0, 16)}… gzipBytes=${gen.gzipBytes}`,
    );
    for (const r of await published) {
      console.log(
        `reader ${r.worker} round ${round}: version=${r.version} ` +
          `versions-match=${r.versionsMatch} html-matches=${r.htmlMatches} ` +
          `sha256=${r.sha256.slice(0, 16)}… ` +
          `(cached data ${cacheLabel(r.cachedDataRejected)})`,
      );
    }
  };

  // Round 3: render.js cannot compile, so the whole set — report.html and
  // report.json included, though both are perfectly valid on their own —
  // is refused. Nothing publishes, so no reader gets a 'publish' event.
  const attemptBadRound = async (round, data) => {
    const reply = nextFrom(generator, (msg) => msg.round === round);
    generator.postMessage({
      cmd: 'generate',
      round,
      dataset: data,
      badRenderSource: BAD_RENDER_SOURCE,
    });
    const gen = await reply;
    // gen.message already names its code (ENOTSUP: operation not…).
    console.log(
      `generator round ${round}: writeFiles rejected: ${gen.message}`,
    );
  };

  // Ask both readers to read the current set on demand — proving that,
  // after the refused round 3, it is still round 2's set, whole.
  const peekReaders = async () => {
    const replies = Promise.all(
      readers.map((reader) => nextFrom(reader, (msg) => msg.kind === 'peek')),
    );
    for (const reader of readers) reader.postMessage({ cmd: 'peek' });
    for (const r of await replies) {
      console.log(
        `reader ${r.worker} after rejection: version=${r.version} ` +
          `versions-match=${r.versionsMatch} html-matches=${r.htmlMatches} ` +
          `sha256=${r.sha256.slice(0, 16)}… (unchanged)`,
      );
    }
  };

  await runRound(1, DATASET_A);
  await runRound(2, DATASET_B);
  await attemptBadRound(3, DATASET_B);
  await peekReaders();

  // The main thread too sees one shared version across the whole set —
  // the same guarantee readers checked, without needing a worker.
  console.log(
    `main thread reports.version: html=${reports.version('/report.html')} ` +
      `json=${reports.version('/report.json')} ` +
      `render.js=${reports.version('/render.js')}`,
  );

  await Promise.all([generator, ...readers].map((w) => w.terminate()));
  kernel.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
