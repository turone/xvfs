'use strict';

const os = require('node:os');
const path = require('node:path');
// Captured before any scenario installs the fs patch.
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { VfsConfig } = require('../lib/config.js');
const { VfsKernel } = require('../lib/kernel.js');

// Shared scenario helpers. Everything that reaches into kernel internals is
// here, so a refactoring adapts one file, never the scenarios.

const quiet = { log() {}, warn() {}, error() {}, debug() {} };

const tmpDir = (prefix) =>
  mkdtempSync(path.join(os.tmpdir(), `smfs-${prefix}-`));

// writeTree(root, { 'a/b.txt': content }) → root
const writeTree = (root, files) => {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
};

const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

const MEMORY = {
  limit: '512 mib',
  segmentSize: '32 mib',
  maxFileSize: '16 mib',
};

const kernelOf = (root, places, defaults = {}, options = {}) =>
  new VfsKernel(
    new VfsConfig({ defaults: { memory: MEMORY, ...defaults }, places }),
    { appRoot: root, console: quiet, ...options },
  );

const kernel = async (root, places, defaults, options) => {
  const k = kernelOf(root, places, defaults, options);
  await k.initialize();
  return k;
};

const immediate = () => new Promise((resolve) => setImmediate(resolve));

// --- Internals (observation points) ---

// Bytes the pool reserved (segments) and bytes in use inside them.
const poolUsage = (k) => {
  const cache = k.cache;
  if (!cache) return { reserved: 0, used: 0 };
  let used = 0;
  for (const id of cache.pool.segments.keys()) used += cache.registry.used(id);
  return { reserved: cache.pool.totalUsed, used };
};

// Segments kept empty for reuse.
const emptySegments = (k) => k.cache.pool.emptySegmentIds.size;

// One watcher epoch, as the directory watcher delivers it, awaited.
const epoch = async (k, events) => {
  k.watcher.emit('epoch', events);
  await k.watchQueue.idle;
};

// Stops the native fs.watch handles; hand-made epochs still reach the kernel.
const muteWatcher = (k) => k.watcher.close();

// Retired versions not freed yet.
const retiredCount = (k) => k.retirements().length;

// Bytes of the retired versions not freed yet.
const retiredBytes = (k) =>
  k.retirements().reduce((sum, record) => sum + record.bytes, 0);

const MIB = 2 ** 20;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Process memory right after a collection, in MiB.
const usage = () => {
  if (global.gc) global.gc();
  const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
  return {
    rss: rss / MIB,
    heapUsed: heapUsed / MIB,
    external: external / MIB,
    arrayBuffers: arrayBuffers / MIB,
  };
};

// The same once it has settled: right after gc() the figures still count
// the Buffers and segments the collection found dead — their backing
// stores reach the OS later, and a segment can take one more cycle than
// the views over it. Sampled again after a pause and a collection, at
// least three times, until two samples agree (RSS within 1 MiB,
// arrayBuffers within 0.5 MiB); twelve cycles at most.
const settledUsage = async () => {
  let last = usage();
  for (let i = 0; i < 12; i++) {
    await pause(100);
    const next = usage();
    const stable =
      Math.abs(next.rss - last.rss) < 1 &&
      Math.abs(next.arrayBuffers - last.arrayBuffers) < 0.5;
    last = next;
    if (stable && i >= 2) break;
  }
  return last;
};

const memory = (b, id, k) => {
  const { rss } = usage();
  b.value(`mem.${id}.rss`, 'MiB', 'lower', rss);
  if (k) b.value(`mem.${id}.pool`, 'MiB', 'lower', poolUsage(k).used / MIB);
};

module.exports = {
  quiet,
  tmpDir,
  writeTree,
  cleanup,
  kernelOf,
  kernel,
  immediate,
  pause,
  poolUsage,
  emptySegments,
  epoch,
  muteWatcher,
  retiredCount,
  retiredBytes,
  usage,
  settledUsage,
  memory,
  MIB,
};
