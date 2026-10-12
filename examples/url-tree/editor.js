'use strict';

// The editor worker of url-tree: it submits a change of the source — after
// the source committed it, with the source's number — and reads its own
// write the moment the promise resolves: the main thread answers after it
// posted the update, which the port delivers first (README, "Page and
// route trees").

const { parentPort } = require('node:worker_threads');
const { attach } = require('../..');

const pages = attach().tree('pages');

parentPort.on('message', async (batch) => {
  const { status } = await pages.submit(batch);
  const node = pages.get('/docs/news');
  const read = node === null ? null : pages.read(node, 'utf8');
  parentPort.postMessage({ kind: 'submitted', status, read });
});
