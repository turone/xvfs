'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const {
  tmpDir,
  cleanup,
  kernel,
  immediate,
  retiredCount,
  memory,
} = require('../lib.js');

// Updates under active leases. A lease of the current version is local
// bookkeeping; when an update retires that version the thread binds the
// lease to its retireId (retain), and the last release frees the bytes —
// on the main thread directly, in a worker through the ACK's `retained`
// and one vfs-release. Measured, on the main thread: the latency of a
// write replacing a version held by 0, 1 and 1000 leases (retain is per
// version, not per lease) — with no lease the replaced version is also
// freed inside the timed write, since nothing holds it, while under
// leases it is freed by their release in the next setup: `update.0`
// carries the free and the compaction check (`release.retired` puts them
// at under a microsecond), the other two rows do not; the release that
// frees a retired version against the release of a current one. With
// real workers: one update → ACK → release → free round while every
// worker holds a lease on the replaced version (`held`), against the same
// round with nothing held (`free`, the ack scenario's round).

const LEASE = path.join(__dirname, '..', 'workers', 'lease.js');
const KEY = '/f.bin';
const DATA = [Buffer.alloc(64 * 1024, 1), Buffer.alloc(64 * 1024, 2)];
const PLACES = {
  v: { origin: 'virtual', fs: { writable: true, zeroCopy: true } },
};
const NO_HOOKS = { hooks: { fs: false, module: false } };

// A kernel with the key published, and a write that replaces it.
const setup = async () => {
  const root = tmpDir('retain');
  const k = await kernel(root, PLACES, NO_HOOKS);
  const v = k.fs('v');
  let n = 0;
  const write = () => v.writeFile(KEY, DATA[n++ & 1]);
  await write();
  return { root, k, v, write };
};

const main = async (b) => {
  const { root, k, v, write } = await setup();
  try {
    for (const count of [0, 1, 1000]) {
      let held = [];
      await b.latency(`retain.main.update.${count}`, write, {
        setup: () => {
          for (const lease of held) lease.release();
          held = [];
          for (let i = 0; i < count; i++) held.push(v.readFileView(KEY));
        },
      });
      for (const lease of held) lease.release();
    }
    const release = (i, lease) => lease.release();
    await b.latency('retain.main.release.retired', release, {
      setup: async () => {
        const lease = v.readFileView(KEY);
        await write();
        return lease;
      },
    });
    await b.latency('retain.main.release.current', release, {
      setup: () => v.readFileView(KEY),
    });
    memory(b, 'retain.main', k);
  } finally {
    k.close();
    cleanup(root);
  }
};

const spawn = (k, hold) =>
  new Promise((resolve, reject) => {
    const { vfs, transferList } = k.link();
    const workerData = { vfs, place: 'v', key: KEY, hold };
    const w = new Worker(LEASE, { workerData, transferList });
    w.once('message', () => resolve(w));
    w.once('error', reject);
  });

const workers = async (b, count, hold) => {
  const { root, k, write } = await setup();
  const threads = [];
  try {
    for (let i = 0; i < count; i++) threads.push(await spawn(k, hold));
    const round = async () => {
      await write();
      while (retiredCount(k) > 0) await immediate();
    };
    const id = `retain.worker.${count}.${hold ? 'held' : 'free'}`;
    await b.latency(id, round);
    if (hold && count === 4) memory(b, 'retain.worker', k);
  } finally {
    await Promise.all(threads.map((w) => w.terminate()));
    k.close();
    cleanup(root);
  }
};

module.exports = async (b) => {
  await main(b);
  for (const count of [1, 4]) {
    await workers(b, count, false);
    await workers(b, count, true);
  }
};
