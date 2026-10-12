'use strict';

// url-tree — the pages of a site as a shared tree (README, "Page and route
// trees"): nodes with the ids the source gives them, payloads in the
// shared pool, the same tree in every thread.
//
// The source here is an array and a counter — what a database table and
// its change log would be. The main thread loads its state once; an
// "editor" worker submits a batch of the source and reads its own write
// the moment its promise resolves; a "reader" worker resolves URLs under
// the pages' policies and hears every publication; the main thread then
// gets what a log reader gets — a repeat of a batch, and a gap filled
// late.
//
// Run:
//   node examples/url-tree/run.js

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { VfsConfig, VfsKernel } = require('../..');

// The source's state at its change 3: the root, a docs section anyone
// reads, an admin section only admins do.
const SOURCE = {
  seq: 3,
  rows: [
    { id: 1, parentId: null, name: '', class: 0 },
    { id: 2, parentId: 1, name: 'docs', class: 0 },
    {
      id: 3,
      parentId: 2,
      name: 'intro',
      class: 1,
      payload: { data: '<h1>Intro</h1>' },
    },
    { id: 4, parentId: 1, name: 'admin', class: 0, policy: { role: 'admin' } },
    {
      id: 5,
      parentId: 4,
      name: 'stats',
      class: 1,
      payload: { data: '<h1>Stats</h1>' },
    },
  ],
};

const config = new VfsConfig({
  trees: {
    pages: {
      ids: 'number',
      containers: [0],
      intake: { window: 1, gapTimeout: 50 },
    },
  },
});

let gapTold = null;
const kernel = new VfsKernel(config, {
  appRoot: __dirname,
  trees: {
    pages: {
      onGap: ({ from, to }) => gapTold?.({ from, to }),
      onError: (err) => console.log(`main: refused ${err.code}`),
    },
  },
});

// Resolves with the next message of `worker` that matches `predicate`;
// listening before the message that causes the reply is sent.
const nextFrom = (worker, predicate) =>
  new Promise((resolve, reject) => {
    const onMessage = (msg) => {
      if (!predicate(msg)) return;
      worker.off('message', onMessage);
      resolve(msg);
    };
    worker.on('message', onMessage);
    worker.once('error', reject);
  });

const start = (file) => {
  const { vfs, transferList } = kernel.link();
  return new Worker(path.join(__dirname, file), {
    workerData: { vfs },
    transferList,
  });
};

const page = (id, parentId, name, html) => [
  'put',
  id,
  parentId,
  name,
  { class: 1, payload: { data: html } },
];

(async () => {
  await kernel.initialize();
  const pages = kernel.tree('pages');
  await pages.load(SOURCE.rows, SOURCE.seq);
  console.log(`main: loaded seq=${SOURCE.seq} last=${pages.last}`);

  const reader = start('reader.js');
  const editor = start('editor.js');
  const lookup = nextFrom(reader, (msg) => msg.kind === 'looked');
  reader.postMessage({ cmd: 'look' });
  for (const line of (await lookup).lines) console.log(`reader: ${line}`);

  // The editor's change 4, through its own worker's link.
  const heard4 = nextFrom(
    reader,
    (msg) => msg.kind === 'heard' && msg.to === 4,
  );
  const edited = nextFrom(editor, (msg) => msg.kind === 'submitted');
  editor.postMessage({
    seq: 4,
    ops: [page(10, 2, 'news', '<h1>News</h1>')],
  });
  const { status, read } = await edited;
  console.log(`editor: seq=4 ${status}; /docs/news reads ${read}`);
  const heard = await heard4;
  console.log(`reader: publish seq=${heard.from}..${heard.to} ${heard.page}`);

  // The same change read back from the source's log: a repeat.
  const again = await pages.submit({
    seq: 4,
    ops: [page(10, 2, 'news', '<h1>News</h1>')],
  });
  console.log(`main: seq=4 again ${again.status}`);

  // Change 6 arrives before change 5: it waits, the gap is told once.
  const gap = new Promise((resolve) => {
    gapTold = resolve;
  });
  const heard6 = nextFrom(
    reader,
    (msg) => msg.kind === 'heard' && msg.to === 6,
  );
  const six = pages.submit({
    seq: 6,
    ops: [page(12, 2, 'faq', '<h1>FAQ</h1>')],
  });
  const { from, to } = await gap;
  console.log(`main: gap ${from}..${to}`);
  const five = await pages.submit({
    seq: 5,
    ops: [page(11, 2, 'guide', '<h1>Guide</h1>')],
  });
  console.log(`main: seq=5 ${five.status}, seq=6 ${(await six).status}`);
  const late = await heard6;
  console.log(`reader: publish seq=${late.from}..${late.to} ${late.page}`);

  await Promise.all([reader.terminate(), editor.terminate()]);
  kernel.close();
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  kernel.close();
});
