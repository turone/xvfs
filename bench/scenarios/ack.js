'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { worker } = require('../../test/helpers.js');
const {
  tmpDir,
  cleanup,
  kernel,
  immediate,
  retiredCount,
  memory,
} = require('../lib.js');

// One update → ACK → free round: a sab + virtual write replaces a key, every
// linked worker applies the vfs-update and ACKs it, the retired version
// returns to the pool. Timed from the write until nothing is retired, with
// in-thread links (test/helpers.js `worker`) and real Worker threads.

const ATTACH = path.join(__dirname, '..', 'workers', 'attach.js');
const DATA = Buffer.alloc(1024, 101);

const PLACES = { v: { origin: 'virtual', fs: { writable: true } } };
const NO_HOOKS = { hooks: { fs: false, module: false } };

const spawn = (k) =>
  new Promise((resolve, reject) => {
    const { vfs, transferList } = k.link();
    const w = new Worker(ATTACH, { workerData: { vfs }, transferList });
    w.once('message', () => resolve(w));
    w.once('error', reject);
  });

const round = async (k, place) => {
  await place.writeFile('/f.txt', DATA);
  while (retiredCount(k) > 0) await immediate();
};

const run = async (b, kind, count) => {
  const root = tmpDir('ack');
  const k = await kernel(root, PLACES, NO_HOOKS);
  const threads = [];
  const links = [];
  try {
    for (let i = 0; i < count; i++) {
      if (kind === 'worker') threads.push(await spawn(k));
      else links.push(worker(k));
    }
    const place = k.fs('v');
    await place.writeFile('/f.txt', DATA);
    await b.latency(`ack.${kind}.${count}`, () => round(k, place), {
      samples: 200,
    });
    if (count === 4) memory(b, `ack.${kind}`, k);
  } finally {
    await Promise.all(threads.map((w) => w.terminate()));
    for (const { kernel: w } of links) w.close();
    k.close();
    cleanup(root);
  }
};

module.exports = async (b) => {
  await run(b, 'inthread', 1);
  await run(b, 'inthread', 4);
  await run(b, 'worker', 1);
  await run(b, 'worker', 4);
};
