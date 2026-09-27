'use strict';

const {
  tmpDir,
  cleanup,
  kernel,
  poolUsage,
  retiredBytes,
  usage,
  settledUsage,
  MIB,
} = require('../lib.js');

// The memory of shared bytes through their lifetime, in MiB: RSS, heap,
// arrayBuffers (SAB segments and owned Buffers alike), bytes of readFile()
// copies kept, the pool (bytes in use, segments reserved), bytes pinned by
// leases and bytes retired but not freed. A `sab + virtual` place with
// `zeroCopy` takes 128 files of 512 KiB (64 MiB), then:
//   published  the files are in the pool
//   leased     a lease on every file
//   copies     an owned readFile() copy of every file kept as well
//   dropped    the copies dropped, collected
//   updated    every file rewritten while the leases hold the old versions
//   released   every lease released: the old versions are freed
//   settled    the same after a pause and another collection
//   closed     kernel.close(): the segments are collectable
// A figure right after gc() still counts the Buffers and segments the
// collection found dead: their backing stores go to the OS later, off the
// collecting thread. So every phase waits until RSS stops moving — except
// `released`, taken right after its gc() to show that lag against
// `settled`.

const COUNT = 128;
const SIZE = 512 * 1024;

// In their own frames: a suspended async function keeps the last value a
// loop of its own touched in a dead register, which would hold one lease's
// view — and its whole segment — past close().
const acquire = (v, keys) => keys.map((key) => v.readFileView(key));
const releaseAll = (leases) => {
  for (const lease of leases) lease.release();
  leases.length = 0;
};
const PLACES = {
  v: { origin: 'virtual', fs: { writable: true, zeroCopy: true } },
};
const NO_HOOKS = { hooks: { fs: false, module: false } };

module.exports = async (b) => {
  const root = tmpDir('memory');
  const k = await kernel(root, PLACES, NO_HOOKS);
  const v = k.fs('v');
  const keys = Array.from({ length: COUNT }, (_, i) => `/f${i}.bin`);
  let pinned = 0; // bytes under a lease
  let owned = 0; // bytes of readFile() copies kept
  const phase = (name, u, kernelOpen = true) => {
    b.value(`memory.${name}.rss`, 'MiB', 'lower', u.rss);
    b.value(`memory.${name}.heap`, 'MiB', 'lower', u.heapUsed);
    b.value(`memory.${name}.owned`, 'MiB', 'lower', owned / MIB);
    b.value(`memory.${name}.arrayBuffers`, 'MiB', 'lower', u.arrayBuffers);
    const pool = kernelOpen ? poolUsage(k) : { used: 0, reserved: 0 };
    b.value(`memory.${name}.pool.used`, 'MiB', 'lower', pool.used / MIB);
    b.value(
      `memory.${name}.pool.reserved`,
      'MiB',
      'lower',
      pool.reserved / MIB,
    );
    b.value(`memory.${name}.pinned`, 'MiB', 'lower', pinned / MIB);
    const retired = kernelOpen ? retiredBytes(k) : 0;
    b.value(`memory.${name}.retired`, 'MiB', 'lower', retired / MIB);
  };
  const write = async (fill) => {
    for (const key of keys) await v.writeFile(key, Buffer.alloc(SIZE, fill));
  };
  try {
    phase('start', await settledUsage());
    await write(1);
    phase('published', await settledUsage());

    const leases = acquire(v, keys);
    pinned = COUNT * SIZE;
    phase('leased', await settledUsage());

    let copies = keys.map((key) => v.readFile(key));
    owned = copies.reduce((sum, copy) => sum + copy.length, 0);
    phase('copies', await settledUsage());
    copies = null;
    owned = 0;
    phase('dropped', await settledUsage());

    await write(2);
    phase('updated', await settledUsage());

    releaseAll(leases);
    pinned = 0;
    phase('released', usage());
    phase('settled', await settledUsage());

    k.close();
    phase('closed', await settledUsage(), false);
  } finally {
    k.close();
    cleanup(root);
  }
};
