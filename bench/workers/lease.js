'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { attach } = require('../../index.js');

// A worker that holds a lease on `key` of `place` across every update: on
// each vfs-update it takes a lease on the new version and releases the one
// on the replaced version — after the kernel's own listener ACKed the
// update with that version as retained, so the release is what frees it.
// With `hold: false` it only applies and ACKs updates, like attach.js.

const kernel = attach();
const { place, key, hold } = workerData;
if (hold) {
  const files = kernel.fs(place);
  let lease = files.readFileView(key);
  kernel.port.on('message', (msg) => {
    if (msg?.name !== 'vfs-update') return;
    const previous = lease;
    lease = files.readFileView(key);
    previous.release();
  });
}
parentPort.on('message', () => {});
parentPort.postMessage('ready');
