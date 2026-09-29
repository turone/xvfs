'use strict';

const { tmpDir, writeTree, cleanup, kernel, kernelOf } = require('../lib.js');

// Publication events: the cost `#apply` pays to build and deliver a
// 'publish' event, by how many listeners are subscribed — nothing is built
// with none (`listenerCount('publish') === 0`); with some, one frozen event
// object is built once and delivered to each.
//   events.publish.<n>: publish.sab.raw's own write (bench/scenarios/
// publish.js) — one writeFile of 1 KiB into a sab + virtual place, keys
// rotating over a 64-name pool so every write after the first round
// replaces and retires — with 0, 1 and 8 listeners on 'publish'.
//   events.init.<n>: init.js's own sab scan (bench/scenarios/init.js), with
// and without a 'publish' listener: initialize()'s own commit announces
// every scanned key as 'created', an array built only for a subscriber.

const KEYS = 64;
const RAW = Buffer.alloc(1024, 120);
const PLACES = { v: { origin: 'virtual', fs: { writable: true } } };
const NO_HOOKS = { hooks: { fs: false, module: false } };
const LISTENER_COUNTS = [0, 1, 8];
const INIT_COUNT = 2000;

const publishCounts = async (b) => {
  for (const count of LISTENER_COUNTS) {
    const root = tmpDir('events-publish');
    const k = await kernel(root, PLACES, NO_HOOKS);
    const noop = () => {};
    for (let i = 0; i < count; i++) k.on('publish', noop);
    const v = k.fs('v');
    try {
      await b.latency(
        `events.publish.${count}`,
        (i) => v.writeFile(`/f${i % KEYS}.bin`, RAW),
        { samples: 400 },
      );
    } finally {
      k.close();
      cleanup(root);
    }
  }
};

const initWithEvents = async (b) => {
  const files = {};
  const data = Buffer.alloc(1024, 121);
  for (let i = 0; i < INIT_COUNT; i++) {
    files[`sab/d${i % 20}/f${i}.txt`] = data;
  }
  const root = writeTree(tmpDir('events-init'), files);
  let last = null;
  const run = async (name, withListener) => {
    await b.latency(
      `events.init.${name}.${INIT_COUNT}`,
      async (i, k) => {
        await k.initialize();
      },
      {
        warmup: 2,
        samples: 5,
        setup: () => {
          if (last) last.close();
          last = kernelOf(root, { sab: { fs: true } });
          if (withListener) last.on('publish', () => {});
          return last;
        },
      },
    );
  };
  try {
    await run('listener', true);
    await run('none', false);
  } finally {
    if (last) last.close();
    cleanup(root);
  }
};

module.exports = async (b) => {
  await publishCounts(b);
  await initWithEvents(b);
};
