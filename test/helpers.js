'use strict';

const assert = require('node:assert/strict');
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

// Wait until `predicate()` is true or `ms` elapsed — on a monotonic clock,
// whatever a test does to Date.now().
const until = async (predicate, ms = 3000, step = 25) => {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
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

// The bytes of a main kernel's pool in allocations that neither a published
// entry nor a retired version accounts for: what a failed publication left
// behind. 0 whenever no publication is in flight, whatever the ACKs still
// pending; the count of segments hides such a leak inside a segment.
const leakedBytes = (k) => {
  let used = 0;
  for (const id of k.cache.pool.segments.keys()) {
    used += k.cache.registry.used(id);
  }
  for (const { entries } of k.cache.indexes.values()) {
    for (const entry of entries.values()) {
      if (entry.kind === 'shared') used -= entry.length;
    }
  }
  for (const record of k.retired.values()) used -= record.entry.length;
  return used;
};

// One turn of the event loop: every promise settled so far has run its
// continuations — the bookkeeping a mutation queue does once a task
// settles included.
const turn = () => new Promise((resolve) => setImmediate(resolve));

// What a failure or a refusal leaves of a main kernel: bytes in allocations
// nothing accounts for (leakedBytes), the work queued — watcher epochs and
// rechecks, mutations holding a key or a place (diagnostics().queues) —
// the keys of virtual places still in flight (SabStore.creating), and the
// requests of `workers` (worker kernels on its links) not answered yet.
const restOf = (k, workers = []) => {
  let inFlight = 0;
  for (const place of k.registry.all()) {
    inFlight += place.store?.creating?.size ?? 0;
  }
  let requests = 0;
  for (const w of workers) requests += w.mutationClient?.pending ?? 0;
  const { queues } = k.diagnostics();
  return { leakedBytes: leakedBytes(k), queues, inFlight, requests };
};

// Asserts a ready main kernel at rest once what it runs has settled:
// nothing of restOf() left — but for the rechecks a failed watcher
// publication schedules, once each.
const assertAtRest = async (k, { workers = [], rechecks = 0 } = {}) => {
  await turn();
  assert.deepEqual(restOf(k, workers), {
    leakedBytes: 0,
    queues: {
      watch: { epochs: 0, rechecks },
      mutations: { keys: 0, barriers: 0 },
    },
    inFlight: 0,
    requests: 0,
  });
};

// The types of the resources that keep the event loop alive, counted —
// what `activeSince` compares with.
const activeResources = () => {
  const counts = {};
  for (const type of process.getActiveResourcesInfo()) {
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
};

// The resources alive now beyond `baseline` (activeResources()), by type.
const activeSince = (baseline) => {
  const beyond = {};
  for (const [type, count] of Object.entries(activeResources())) {
    const more = count - (baseline[type] ?? 0);
    if (more > 0) beyond[type] = more;
  }
  return beyond;
};

// Closes `k`, then the worker kernels on its links, and asserts that
// nothing they opened stays open: `k`'s close() closes each link port,
// both ends see it within a deadline (whose timer holds the event loop
// meanwhile: the ports are unref'd); no recheck and no watcher left, no
// worker request left unsettled; and — a closed handle may be released on
// a later turn — no resource that keeps the event loop alive beyond
// `baseline`, taken before the kernel was made.
const closeAtRest = async (k, { workers = [], baseline }) => {
  const ports = [...k.links.values()];
  for (const w of workers) if (w.port) ports.push(w.port);
  const closed = Promise.all(
    ports.map((port) => new Promise((resolve) => port.once('close', resolve))),
  );
  let late = null;
  const deadline = new Promise((resolve) => {
    late = setTimeout(resolve, 3000, 'deadline');
  });
  k.close();
  const settled = await Promise.race([closed, deadline]);
  clearTimeout(late);
  assert.notEqual(settled, 'deadline', 'every link port closed');
  for (const w of workers) {
    w.close();
    assert.equal(w.mutationClient?.pending ?? 0, 0, 'no request left');
  }
  assert.equal(k.links.size, 0);
  assert.equal(k.rechecks.size, 0, 'no recheck left');
  assert.equal(k.watcher, null, 'no watcher left');
  await until(() => Object.keys(activeSince(baseline)).length === 0, 3000);
  assert.deepEqual(activeSince(baseline), {}, 'no resource left alive');
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
  leakedBytes,
  turn,
  restOf,
  assertAtRest,
  activeResources,
  activeSince,
  closeAtRest,
  SMALL_MEMORY,
};
