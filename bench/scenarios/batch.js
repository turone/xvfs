'use strict';

const { worker } = require('../../test/helpers.js');
const {
  tmpDir,
  cleanup,
  kernel,
  poolUsage,
  settledUsage,
  MIB,
} = require('../lib.js');

// writeFiles of n keys against a series of n independent writeFile calls, in
// a sab + virtual place: the latency of one call until its version is
// published. Every n keeps its own n keys: an untimed call primes them
// (creates), so every timed call — the warm-up included — replaces and
// retires. Measured with 0 links and with 1 in-thread link that ACKs
// (test/helpers.js `worker`, the same fake link bench/scenarios/ack.js
// uses): the ACK is never awaited, only received, so the timed latency is
// the call's own, from the write to its commit, not the round to the free.
// How many `vfs-update` messages one call costs (the kernel's own
// `nextUpdateId`) is recorded once, from the priming call: one for
// writeFiles whatever n is, one per key for the series.
//   batch.rollback.<n>: a preparer that throws while preparing the last key
// of the set — the latency of the rejection. Nothing is ever published, so
// no link is involved.
//   batch.memory.*: RSS and the pool, settled, after 1000 batches of 64
// files against 64 000 single writeFile calls of the same total files and
// bytes — batching should leave nothing of its own behind.

const N_VALUES = [1, 8, 64, 512];
const DATA = Buffer.alloc(1024, 111);
const NO_HOOKS = { hooks: { fs: false, module: false } };
const PLACES = { v: { origin: 'virtual', fs: { writable: true } } };

// Fewer samples for the larger batches: a similar wall-clock budget per n.
const TUNING = {
  1: { warmup: 20, samples: 200 },
  8: { warmup: 20, samples: 200 },
  64: { warmup: 10, samples: 100 },
  512: { warmup: 5, samples: 30 },
};

const keysOf = (prefix, n) =>
  Array.from({ length: n }, (_, i) => `/${prefix}${i}.bin`);

const linksOf = (k, linked) => (linked ? [worker(k)] : []);

const closeLinks = (links) => {
  for (const { kernel: w } of links) w.close();
};

const writeFilesLatency = async (b, linked) => {
  for (const n of N_VALUES) {
    const root = tmpDir('batch-wf');
    const k = await kernel(root, PLACES, NO_HOOKS);
    const links = linksOf(k, linked);
    const v = k.fs('v');
    const pairs = keysOf('w', n).map((key) => [key, DATA]);
    try {
      const before = k.nextUpdateId;
      await v.writeFiles(pairs); // primes: every timed call below replaces.
      if (!linked) {
        b.value(
          `batch.writeFiles.${n}.updates`,
          'count',
          'lower',
          k.nextUpdateId - before,
        );
      }
      const id = linked
        ? `batch.writeFiles.linked.${n}`
        : `batch.writeFiles.${n}`;
      await b.latency(id, () => v.writeFiles(pairs), TUNING[n]);
    } finally {
      closeLinks(links);
      k.close();
      cleanup(root);
    }
  }
};

const seriesLatency = async (b, linked) => {
  for (const n of N_VALUES) {
    const root = tmpDir('batch-sr');
    const k = await kernel(root, PLACES, NO_HOOKS);
    const links = linksOf(k, linked);
    const v = k.fs('v');
    const keys = keysOf('s', n);
    const writeAll = () =>
      Promise.all(keys.map((key) => v.writeFile(key, DATA)));
    try {
      const before = k.nextUpdateId;
      await writeAll(); // primes: every timed call below replaces.
      if (!linked) {
        b.value(
          `batch.series.${n}.updates`,
          'count',
          'lower',
          k.nextUpdateId - before,
        );
      }
      const id = linked ? `batch.series.linked.${n}` : `batch.series.${n}`;
      await b.latency(id, writeAll, TUNING[n]);
    } finally {
      closeLinks(links);
      k.close();
      cleanup(root);
    }
  }
};

const rollback = async (b) => {
  for (const n of N_VALUES) {
    const root = tmpDir('batch-rb');
    let failing = null;
    const preparers = {
      passthrough: (raw, file) => {
        if (file.key === failing) throw new Error('rollback');
        return raw;
      },
    };
    const k = await kernel(
      root,
      {
        v: {
          origin: 'virtual',
          fs: { writable: true, prepare: { passthrough: ['bin'] } },
        },
      },
      NO_HOOKS,
      { preparers },
    );
    const v = k.fs('v');
    const keys = keysOf('r', n);
    failing = keys[n - 1];
    const pairs = keys.map((key) => [key, DATA]);
    try {
      await b.latency(
        `batch.rollback.${n}`,
        () =>
          v.writeFiles(pairs).then(
            () => {
              throw new Error(`batch.rollback.${n}: writeFiles resolved`);
            },
            () => {},
          ),
        TUNING[n],
      );
    } finally {
      k.close();
      cleanup(root);
    }
  }
};

const memoryPhase = async (b, id, k) => {
  const { rss, arrayBuffers } = await settledUsage();
  const pool = poolUsage(k);
  b.value(`${id}.rss`, 'MiB', 'lower', rss);
  b.value(`${id}.arrayBuffers`, 'MiB', 'lower', arrayBuffers);
  b.value(`${id}.pool.used`, 'MiB', 'lower', pool.used / MIB);
  b.value(`${id}.pool.reserved`, 'MiB', 'lower', pool.reserved / MIB);
};

const ROUNDS = 1000;
const BATCH_SIZE = 64;
const MEMORY_FILE = Buffer.alloc(256, 88);

const settledMemory = async (b) => {
  const rootBatched = tmpDir('batch-mem-b');
  const kBatched = await kernel(rootBatched, PLACES, NO_HOOKS);
  try {
    const v = kBatched.fs('v');
    for (let round = 0; round < ROUNDS; round++) {
      const pairs = Array.from({ length: BATCH_SIZE }, (_, i) => [
        `/m${round}-${i}.bin`,
        MEMORY_FILE,
      ]);
      await v.writeFiles(pairs);
    }
    await memoryPhase(b, 'batch.memory.batched', kBatched);
  } finally {
    kBatched.close();
    cleanup(rootBatched);
  }

  const rootSingles = tmpDir('batch-mem-s');
  const kSingles = await kernel(rootSingles, PLACES, NO_HOOKS);
  try {
    const v = kSingles.fs('v');
    for (let i = 0; i < ROUNDS * BATCH_SIZE; i++) {
      await v.writeFile(`/m${i}.bin`, MEMORY_FILE);
    }
    await memoryPhase(b, 'batch.memory.singles', kSingles);
  } finally {
    kSingles.close();
    cleanup(rootSingles);
  }
};

module.exports = async (b) => {
  await writeFilesLatency(b, false);
  await writeFilesLatency(b, true);
  await seriesLatency(b, false);
  await seriesLatency(b, true);
  await rollback(b);
  await settledMemory(b);
};
