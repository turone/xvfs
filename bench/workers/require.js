'use strict';

const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');

// Requires `count` modules m0.js … from `dir` and posts the nanoseconds the
// loop took. With `vfs` it first attaches to the link, whose config
// installs the module hooks; without, Node loads them from disk.

const { dir, count, vfs } = workerData;
if (vfs) require('../../index.js').attach();

const t0 = process.hrtime.bigint();
for (let i = 0; i < count; i++) require(path.join(dir, `m${i}.js`));
parentPort.postMessage(Number(process.hrtime.bigint() - t0));
