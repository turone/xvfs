'use strict';

const { parentPort } = require('node:worker_threads');
const { attach } = require('../../index.js');

// A worker that attaches to the link in workerData.vfs and only applies and
// ACKs updates. parentPort keeps it alive until the benchmark terminates it.

attach();
parentPort.on('message', () => {});
parentPort.postMessage('ready');
