'use strict';

// etag — ETag computed once by a `prepare` preparer, shared by every worker
// through `meta`.
//
// The `etag` preparer hashes each file's canonical content and returns a
// quoted strong ETag (RFC 9110) in `meta`; it never touches the content
// itself. `pages` is a `sab + virtual` place, so a main-thread `writeFile`
// is published to every worker before its Promise resolves — every worker
// reads the same `meta.etag` for the same version of a file, through
// `files.meta(key)`. The HTTP layer is plain `node:http`, no framework: 304
// when the request's `If-None-Match` already matches, 200 with the `ETag`
// header otherwise.
//
// Run:
//   node examples/etag/server.js
// then, in another terminal:
//   curl -i http://127.0.0.1:3000/hello.txt
//   curl -i -H 'If-None-Match: "<etag from above>"' http://127.0.0.1:3000/hello.txt
//   curl -i http://127.0.0.1:3001/hello.txt   # another worker, same ETag
//
// About a second in, the server rewrites /hello.txt once: the next GET from
// either worker returns a new ETag, and the old If-None-Match no longer
// matches.

const crypto = require('node:crypto');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { VfsConfig, VfsKernel } = require('../..');

const APP_ROOT = __dirname;
const WORKERS = Number(process.env.WORKERS || 2);
const PORT = Number(process.env.PORT || 3000);

// Canonical content is the raw bytes, unchanged; meta carries their ETag.
const etag = (raw) => ({
  source: raw,
  meta: {
    etag: `"${crypto.createHash('sha256').update(raw).digest('base64url')}"`,
  },
});

const config = new VfsConfig({
  defaults: {
    memory: { limit: '2 mib', segmentSize: '512 kib', maxFileSize: '128 kib' },
  },
  places: {
    // Application-written content — here, seeded and later updated by this
    // process itself, standing in for whatever publishes pages in a real
    // app (a build step, a CMS webhook, …).
    pages: {
      origin: 'virtual',
      fs: { writable: true, ext: ['txt'], prepare: 'etag' },
    },
  },
});

const kernel = new VfsKernel(config, {
  appRoot: APP_ROOT,
  preparers: { etag },
});
const workers = [];
let updateTimer = null;

const shutdown = async () => {
  clearTimeout(updateTimer);
  await Promise.all(workers.map((worker) => worker.terminate()));
  kernel.close();
  process.exit(0);
};

(async () => {
  await kernel.initialize();
  const pages = kernel.fs('pages');
  await pages.writeFile('/hello.txt', 'hello, world\n');
  await pages.writeFile('/about.txt', 'etag example\n');

  for (let id = 1; id <= WORKERS; id++) {
    // One link per worker: snapshot, config and a private port for updates.
    const { vfs, transferList } = kernel.link();
    const port = PORT === 0 ? 0 : PORT + id - 1;
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { vfs, id, port },
      transferList,
    });
    worker.on('message', (url) => {
      console.log(`worker ${id} listening on ${url}`);
    });
    worker.on('error', (err) => {
      console.error(`worker ${id}:`, err);
      process.exitCode = 1;
    });
    workers.push(worker);
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // Demo: a live update. Every worker sees the new content and ETag at once.
  updateTimer = setTimeout(() => {
    pages
      .writeFile('/hello.txt', 'hello, world — updated\n')
      .then(() => console.log('[demo] updated /hello.txt'))
      .catch((err) => console.error('[demo] update failed:', err));
  }, 1000);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
