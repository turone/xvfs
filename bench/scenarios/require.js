'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { median } = require('../harness.js');
const { tmpDir, writeTree, cleanup, kernel, memory } = require('../lib.js');

// require() of 200 CommonJS modules (~8 KiB each) in a fresh Worker — a new
// isolate, so V8's compilation cache never answers: from the VFS with V8
// cached data (require.compile), from the VFS without it, and from disk
// without the library. The worker times its own require loop; its startup
// stays out of the figure. One round = the median of SAMPLES workers.

const COUNT = 200;
const SAMPLES = 6;
const REQUIRE = path.join(__dirname, '..', 'workers', 'require.js');

const moduleSource = (i) => {
  const fns = [];
  for (let f = 0; f < 40; f++) {
    fns.push(
      `function f${f}(list, factor) {\n` +
        '  const out = [];\n' +
        '  for (const item of list) {\n' +
        `    if (item % ${f + 2} === 0) out.push(item * factor + ${i});\n` +
        "    else out.push(String(item).padStart(4, '0'));\n" +
        '  }\n' +
        '  return out;\n' +
        '}\n',
    );
  }
  const names = Array.from({ length: 40 }, (_, f) => `f${f}`).join(', ');
  return `'use strict';\n${fns.join('')}module.exports = { ${names} };\n`;
};

// Milliseconds the worker spent in its require loop.
const inWorker = (workerData, transferList = []) =>
  new Promise((resolve, reject) => {
    const w = new Worker(REQUIRE, { workerData, transferList });
    w.once('message', (ns) => resolve(ns / 1e6));
    w.once('error', reject);
  });

module.exports = async (b) => {
  const vfsFiles = {};
  const diskFiles = {};
  for (let i = 0; i < COUNT; i++) {
    const source = moduleSource(i);
    vfsFiles[`cached/m${i}.js`] = source;
    vfsFiles[`plain/m${i}.js`] = source;
    diskFiles[`m${i}.js`] = source;
  }
  const root = writeTree(tmpDir('require'), vfsFiles);
  const disk = writeTree(tmpDir('require-disk'), diskFiles);
  const k = await kernel(
    root,
    {
      cached: { fs: true, require: { compile: ['js'] } },
      plain: { fs: true, require: { ext: ['js'] } },
    },
    { hooks: { fs: false, module: true } },
  );
  const fromVfs = (name) => () => {
    const { vfs, transferList } = k.link();
    const dir = path.join(root, name);
    return inWorker({ dir, count: COUNT, vfs }, transferList);
  };
  const variants = {
    'require.vfs.cached': fromVfs('cached'),
    'require.vfs.plain': fromVfs('plain'),
    'require.disk': () => inWorker({ dir: disk, count: COUNT, vfs: null }),
  };
  try {
    for (const [id, run] of Object.entries(variants)) {
      for (let w = 0; w < 2; w++) await run();
      const rounds = [];
      for (let r = 0; r < b.repeats; r++) {
        const samples = [];
        for (let s = 0; s < SAMPLES; s++) samples.push(await run());
        rounds.push(median(samples));
      }
      b.rounds(id, 'ms', 'lower', rounds);
    }
    memory(b, 'require', k);
  } finally {
    k.close();
    cleanup(root);
    cleanup(disk);
  }
};
