'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHook } = require('node:async_hooks');
const { VfsConfig } = require('../lib/config.js');
const { VfsKernel } = require('../lib/kernel.js');

// Shared test helpers: temp trees, quiet kernels, small configs.

const quiet = { log() {}, warn() {}, error() {}, debug() {} };

const tmpDir = (prefix = 'vfs') =>
  fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));

// writeTree(root, { 'public/index.html': '<h1>', 'lib/a.js': '...' })
const writeTree = (root, files) => {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
};

const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SMALL_MEMORY = {
  limit: '4 mib',
  segmentSize: '256 kib',
  maxFileSize: '64 kib',
};

const config = (places, defaults = {}) =>
  new VfsConfig({ defaults: { memory: SMALL_MEMORY, ...defaults }, places });

const kernel = async (root, places, defaults = {}, options = {}) => {
  const k = new VfsKernel(config(places, defaults), {
    appRoot: root,
    console: quiet,
    ...options,
  });
  await k.initialize();
  return k;
};

// Collect a Readable into one Buffer.
const drain = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

// Wait until `predicate()` is true or `ms` elapsed.
const until = async (predicate, ms = 3000, step = 25) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(step);
  }
  return predicate();
};

// A worker stand-in on a real link(), in this thread: records every message
// the main kernel posts and, unless `ack: false`, ACKs each vfs-update like
// an attached worker that reads nothing. `id` is its link id on main.
const tap = (k, { ack = true } = {}) => {
  const { vfs } = k.link();
  const id = [...k.links.keys()].at(-1);
  const messages = [];
  vfs.port.on('message', (msg) => {
    messages.push(msg);
    if (ack && msg.name === 'vfs-update') {
      vfs.port.postMessage({ name: 'vfs-ack', updateId: msg.updateId });
    }
  });
  vfs.port.unref();
  const updates = () => messages.filter((m) => m.name === 'vfs-update');
  return { id, port: vfs.port, messages, updates };
};

// A worker kernel attached to a real link(), in this thread: it projects the
// snapshot, applies deltas and ACKs them through the port exactly like
// attach(), without spawning a thread.
const worker = (k, options = {}) => {
  const { vfs } = k.link();
  const id = [...k.links.keys()].at(-1);
  const w = VfsKernel.fromSnapshot(vfs.snapshot, new VfsConfig(vfs.config), {
    appRoot: vfs.appRoot,
    console: quiet,
    port: vfs.port,
    ...options,
  });
  return { id, kernel: w, port: vfs.port, main: k.links.get(id) };
};

// Resolves with the next `event` of `emitter`, after every listener
// registered before this call (the kernel's own come first). The kernel
// unrefs its link ports, and Node 22 ends an event loop that has nothing
// else to run before a port event arrives: a timer holds it meanwhile.
const nextEvent = (emitter, event) =>
  new Promise((resolve) => {
    const hold = setInterval(() => {}, 2 ** 30);
    emitter.once(event, (value) => {
      clearInterval(hold);
      resolve(value);
    });
  });

const nextMessage = (port) => nextEvent(port, 'message');

// The bytes of a main kernel's pool in allocations — published, retired or
// being published — whatever the segments they lie in: a leak of one
// allocation shows here, where the count of segments hides it.
const usedBytes = (k) => {
  let used = 0;
  for (const id of k.cache.pool.segments.keys()) {
    used += k.cache.registry.used(id);
  }
  return used;
};

// The asynchronous disk calls this process starts from now on — node:fs
// requests of every form, a file handle's close included: async_hooks sees
// each one, whatever function made it, captured at load (lib/disk.js) or
// public. `started(n)` settles once n have started, in the turn the n-th
// starts — before any of them can complete — or fails after `ms`; stop()
// ends the count.
const DISK_CALL = /^(?:FSREQ|FILEHANDLECLOSEREQ)/;

const diskCalls = (ms = 4000) => {
  let count = 0;
  const waits = [];
  const hook = createHook({
    init(asyncId, type) {
      if (!DISK_CALL.test(type)) return;
      count++;
      for (const wait of waits) if (count >= wait.n) wait.done();
    },
  }).enable();
  return {
    get count() {
      return count;
    },
    started(n) {
      if (count >= n) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const late = setTimeout(() => {
          reject(new Error(`${count} of ${n} disk calls started`));
        }, ms);
        const done = () => {
          clearTimeout(late);
          resolve();
        };
        waits.push({ n, done });
      });
    },
    stop: () => hook.disable(),
  };
};

module.exports = {
  quiet,
  tmpDir,
  writeTree,
  rm,
  config,
  kernel,
  drain,
  until,
  tap,
  worker,
  nextEvent,
  nextMessage,
  diskCalls,
  usedBytes,
  SMALL_MEMORY,
};
