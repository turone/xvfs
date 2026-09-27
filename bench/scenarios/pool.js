'use strict';

const path = require('node:path');
const { fork } = require('node:child_process');
// Captured before any scenario installs the fs patch.
const { readFileSync, writeFileSync } = require('node:fs');
const { Worker } = require('node:worker_threads');
const {
  tmpDir,
  writeTree,
  cleanup,
  kernelOf,
  kernel,
  immediate,
  epoch,
  muteWatcher,
  retiredCount,
  settledUsage,
  MIB,
} = require('../lib.js');

// Worker pools of 1, 2, 4 and 8 threads serving one file set — 200 text
// files, 4 KiB to 1 MiB, 20 MiB in all — three ways (bench/workers/pool.js):
//   sab    one copy in shared memory, a lease per request
//   cache  every worker reads the whole set into its own Buffers at start
//   fs     no cache, fs.promises.readFile per request
// Per pool: the time until every worker is ready (startup); the memory of
// a fresh process running that pool — RSS, and the arrayBuffers and heap
// of its workers — once settled (a process that ran other pools before
// would report their allocator slack too, so each pool's memory comes
// from a child process of its own); requests per second over the pool
// and the latency of a request (p50 / p95 / p99 of every request of every
// worker); and the cost of an update of one 32 KiB file until every worker
// serves the new version — for `sab` a watcher epoch (stat, read, place,
// publish, ACKs), for `cache` the file read once and posted to every
// worker (a copy each). `fs` serves the disk as it is. With gzip: `sab`
// serves the representation built at publication, the others compress
// per request (4 threads). `pool.sab.init` is initialize() over the set,
// with and without gzip; `pool.cache.load` the read of the set into
// Buffers, what one cache worker does at start; `pool.none.rss` a fresh
// process with no pool at all.

const POOL = path.join(__dirname, '..', 'workers', 'pool.js');
const KIB = 1024;
const SET = [
  [100, 4 * KIB],
  [60, 32 * KIB],
  [30, 256 * KIB],
  [10, MIB],
];
const EXT = ['js', 'css', 'html', 'json'];
const MODES = ['sab', 'cache', 'fs'];
const COUNTS = [1, 2, 4, 8];
const RUN_MS = 250;
const UPDATE_KEY = '/d0/f100.js'; // the first 32 KiB file
const NO_HOOKS = { hooks: { fs: false, module: false } };
const WATCH = { ...NO_HOOKS, watch: true, watchTimeout: 600000 };

const WORDS = (
  'the quick brown fox jumps over a lazy dog while const let function ' +
  'return class extends import export default async await static new ' +
  'this super null true false typeof instanceof yield delete void'
).split(' ');

// One block of pseudo-text, deterministic; every file is a slice of it
// under its own first line.
const block = (size) => {
  let state = 12345;
  const parts = [];
  let length = 0;
  while (length < size) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const word = WORDS[state % WORDS.length];
    parts.push(word);
    length += word.length + 1;
  }
  return Buffer.from(parts.join(' '));
};

const fileSet = () => {
  const text = block(MIB);
  const files = [];
  let i = 0;
  for (const [count, size] of SET) {
    for (let n = 0; n < count; n++, i++) {
      const key = `/d${i % 10}/f${i}.${EXT[i % EXT.length]}`;
      const head = Buffer.from(`// file ${i}\n`);
      const body = text.subarray(0, size - head.length);
      files.push({ key, size, content: Buffer.concat([head, body]) });
    }
  }
  return files;
};

const placeOf = (gzip) => ({
  fs: {
    ext: EXT,
    zeroCopy: true,
    ...(gzip ? { compress: { encodings: ['gzip'] } } : {}),
  },
});

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

// One worker, asked one thing at a time; ready once it said so.
const spawn = (workerData, transferList) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(POOL, { workerData, transferList });
    const waiting = [];
    worker.on('message', (msg) => waiting.shift()?.(msg));
    worker.on('error', (err) => {
      reject(err);
      for (const done of waiting.splice(0)) done(Promise.reject(err));
    });
    const client = {
      ask: (msg, transfer) =>
        new Promise((done) => {
          waiting.push(done);
          worker.postMessage(msg, transfer);
        }),
      terminate: () => worker.terminate(),
    };
    waiting.push(() => resolve(client));
  });

// A pool: its kernel (sab) and `count` ready workers, timed.
const spawnPool = async (k, count, workerData) => {
  const t0 = process.hrtime.bigint();
  const pending = [];
  for (let i = 0; i < count; i++) {
    if (k) {
      const { vfs, transferList } = k.link();
      pending.push(spawn({ ...workerData, vfs }, transferList));
    } else pending.push(spawn(workerData));
  }
  const clients = await Promise.all(pending);
  return { clients, startup: ms(t0) };
};

const terminateAll = (clients) =>
  Promise.all(clients.map((c) => c.terminate()));

const kernelFor = async (root, mode, gzip) => {
  if (mode !== 'sab') return null;
  const k = await kernel(root, { site: placeOf(gzip) }, WATCH);
  muteWatcher(k);
  return k;
};

// The memory of one pool in this (fresh) process: spawned, warmed up,
// collected in every thread, settled.
const memoryOf = async ({ root, list, mode, count, gzip }) => {
  const k = await kernelFor(root, mode, gzip);
  const workerData = { mode, gzip, files: list, place: 'site' };
  const { clients } = await spawnPool(k, count, workerData);
  try {
    const ask = (msg) => Promise.all(clients.map((c) => c.ask(msg)));
    await ask({ cmd: 'run', ms: 100, seed: 1 });
    const usages = await ask({ cmd: 'mem' });
    const { rss } = await settledUsage();
    const sum = (field) => usages.reduce((s, u) => s + u[field], 0) / MIB;
    return { rss, arrayBuffers: sum('arrayBuffers'), heap: sum('heapUsed') };
  } finally {
    await terminateAll(clients);
    if (k) k.close();
  }
};

// memoryOf() in a child process of its own.
const memoryInChild = (args) =>
  new Promise((resolve, reject) => {
    const child = fork(__filename, ['--memory', JSON.stringify(args)], {
      execArgv: ['--expose-gc'],
    });
    let result = null;
    child.on('message', (msg) => {
      result = msg;
    });
    child.on('exit', (code) => {
      if (result?.error) reject(new Error(result.error));
      else if (result) resolve(result);
      else reject(new Error(`memory child exited with ${code}`));
    });
  });

module.exports = async (b) => {
  const files = fileSet();
  const tree = {};
  for (const { key, content } of files) tree['site' + key] = content;
  const root = writeTree(tmpDir('pool'), tree);
  const dir = path.join(root, 'site');
  const list = files.map(({ key, size }) => ({
    key,
    size,
    path: path.join(dir, key),
  }));
  const updatePath = path.join(dir, UPDATE_KEY);
  const original = readFileSync(updatePath);
  const rounds = Math.min(b.repeats, 3);

  // --- what a pool costs before it serves (the first round warms up) ---
  const before = async () => {
    for (const gzip of [false, true]) {
      const times = [];
      for (let r = 0; r <= rounds; r++) {
        const k = kernelOf(root, { site: placeOf(gzip) }, NO_HOOKS);
        const t0 = process.hrtime.bigint();
        await k.initialize();
        if (r > 0) times.push(ms(t0));
        k.close();
      }
      const id = gzip ? 'pool.sab.init.gzip' : 'pool.sab.init';
      b.rounds(id, 'ms', 'lower', times);
    }
    const times = [];
    let loaded = null;
    for (let r = 0; r <= rounds; r++) {
      const t0 = process.hrtime.bigint();
      loaded = list.map(({ path: p }) => readFileSync(p));
      if (r > 0) times.push(ms(t0));
    }
    loaded.length = 0;
    b.rounds('pool.cache.load', 'ms', 'lower', times);
    const { rss } = await memoryInChild({ root, list, mode: 'fs', count: 0 });
    b.value('pool.none.rss', 'MiB', 'lower', rss);
  };

  // --- one pool ---
  const measure = async (mode, count, gzip) => {
    const tag = `pool.${mode}.${count}${gzip ? '.gzip' : ''}`;
    const memory = await memoryInChild({ root, list, mode, count, gzip });
    b.value(`${tag}.rss`, 'MiB', 'lower', memory.rss);
    const ab = memory.arrayBuffers;
    b.value(`${tag}.workers.arrayBuffers`, 'MiB', 'lower', ab);
    b.value(`${tag}.workers.heap`, 'MiB', 'lower', memory.heap);

    const k = await kernelFor(root, mode, gzip);
    const workerData = { mode, gzip, files: list, place: 'site' };
    let clients = [];
    try {
      const startups = [];
      for (let r = 0; r < rounds; r++) {
        await terminateAll(clients);
        ({ clients, startup: startups[r] } = await spawnPool(
          k,
          count,
          workerData,
        ));
      }
      b.rounds(`${tag}.startup`, 'ms', 'lower', startups);

      const ask = (msg) => Promise.all(clients.map((c) => c.ask(msg)));
      await ask({ cmd: 'run', ms: 100, seed: 1 }); // warm-up
      const rps = [];
      const latencies = [];
      for (let r = 0; r < b.repeats; r++) {
        const results = await ask({ cmd: 'run', ms: RUN_MS, seed: r + 2 });
        const served = results.reduce((s, x) => s + x.count, 0);
        const longest = Math.max(...results.map((x) => x.ns));
        rps.push(served / (longest / 1e9));
        let total = 0;
        for (const x of results) total += x.samples.length;
        const merged = new Float64Array(total);
        let at = 0;
        for (const x of results) {
          merged.set(x.samples, at);
          at += x.samples.length;
        }
        latencies.push(merged.sort());
      }
      b.rounds(`${tag}.rps`, 'req/s', 'higher', rps);
      b.percentiles(`${tag}.latency`, latencies);

      if (mode !== 'fs') {
        let n = 0;
        const rewrite = () => {
          const fill = n++ & 1 ? 'x' : 'y';
          writeFileSync(updatePath, Buffer.from(original).fill(fill, 0, 16));
        };
        const events = new Map([[updatePath, 'change']]);
        const update =
          mode === 'sab'
            ? async () => {
                await epoch(k, new Map(events));
                while (retiredCount(k) > 0) await immediate();
              }
            : async () => {
                const data = readFileSync(updatePath);
                await ask({ cmd: 'update', key: UPDATE_KEY, data });
              };
        await b.latency(`${tag}.update`, update, {
          warmup: 3,
          samples: 30,
          setup: rewrite,
        });
      }
    } finally {
      await terminateAll(clients);
      if (k) k.close();
      writeFileSync(updatePath, original);
    }
  };

  try {
    await before();
    for (const mode of MODES) {
      for (const count of COUNTS) await measure(mode, count, false);
    }
    for (const mode of MODES) await measure(mode, 4, true);
  } finally {
    cleanup(root);
  }
};

// The memory child: `node pool.js --memory <json>` posts memoryOf(json).
if (require.main === module) {
  const at = process.argv.indexOf('--memory');
  if (at !== -1) {
    memoryOf(JSON.parse(process.argv[at + 1]))
      .then((result) => process.send(result, () => process.exit(0)))
      .catch((err) => {
        process.send({ error: err.stack || String(err) }, () =>
          process.exit(1),
        );
      });
  }
}
