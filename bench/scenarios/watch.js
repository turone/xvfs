'use strict';

const path = require('node:path');
const {
  tmpDir,
  writeTree,
  cleanup,
  kernel,
  epoch,
  muteWatcher,
  memory,
} = require('../lib.js');

// One watcher epoch of N changed files, emitted by hand (no fs.watch): each
// file is stat'ed, read, placed in SAB and published in one vfs-update; the
// versions it replaces retire and, with no worker linked, are freed.

const run = async (b, count, samples) => {
  const files = {};
  const data = Buffer.alloc(1024, 102);
  for (let i = 0; i < count; i++) files[`site/d${i % 20}/f${i}.txt`] = data;
  const root = writeTree(tmpDir('watch'), files);
  const k = await kernel(
    root,
    { site: { fs: true } },
    {
      watch: true,
      watchTimeout: 600000,
    },
  );
  muteWatcher(k);
  const events = new Map();
  for (const rel of Object.keys(files)) {
    events.set(path.join(root, rel), 'change');
  }
  try {
    await b.latency(`watch.epoch.${count}`, () => epoch(k, new Map(events)), {
      warmup: 2,
      samples,
    });
    if (count === 1000) memory(b, 'watch', k);
  } finally {
    k.close();
    cleanup(root);
  }
};

module.exports = async (b) => {
  await run(b, 100, 20);
  await run(b, 1000, 5);
};
