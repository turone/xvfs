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

const MIB = 2 ** 20;

const memory = (b, id, k) => {
  if (global.gc) global.gc();
  const { rss } = process.memoryUsage();
  b.value(`mem.${id}.rss`, 'MiB', 'lower', rss / MIB);
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
  poolUsage,
  emptySegments,
  epoch,
  muteWatcher,
  retiredCount,
  memory,
  MIB,
};
