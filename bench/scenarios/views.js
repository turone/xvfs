'use strict';

const { tmpDir, writeTree, cleanup, kernel, memory } = require('../lib.js');

// The lease lifecycle of a zero-copy place: readFileView acquire and
// release as separate phases (N leases of one version, then their N
// releases), the no-update fast path (acquire + release with nothing
// retired in between: local bookkeeping, no message), access to the bytes
// through a lease view against an owned copy of the same size, and
// withFileView with a synchronous and an async callback — at 1 KiB and at
// 1 MiB, against the manual pair.

const N = 2e4; // leases per phase round

const now = () => process.hrtime.bigint();

// The phases keep N releases alive at once: a collection in between would
// land inside one of them.
const gc = () => global.gc?.();

// Every 64th byte: the cost of touching shared memory from JavaScript.
const stride = (buf) => {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 64) sum += buf[i];
  return sum;
};

module.exports = async (b) => {
  const root = writeTree(tmpDir('views'), {
    'site/small.txt': Buffer.alloc(1024, 97),
    'site/large.bin': Buffer.alloc(2 ** 20, 98),
  });
  const k = await kernel(root, { site: { fs: { zeroCopy: true } } });
  const site = k.fs('site');
  try {
    const leases = new Array(N);
    const acquire = [];
    const release = [];
    for (let r = 0; r <= b.repeats; r++) {
      gc();
      const t0 = now();
      for (let i = 0; i < N; i++) leases[i] = site.readFileView('/small.txt');
      const t1 = now();
      for (let i = 0; i < N; i++) leases[i].release();
      const t2 = now();
      if (r === 0) continue; // warm-up
      acquire.push(Number(t1 - t0) / N);
      release.push(Number(t2 - t1) / N);
    }
    b.rounds('views.acquire', 'ns/op', 'lower', acquire);
    b.rounds('views.release', 'ns/op', 'lower', release);
    gc();
    b.ops('views.acquireRelease', () =>
      site.readFileView('/small.txt').release(),
    );

    const owned = site.readFile('/large.bin');
    const other = Buffer.from(owned);
    const lease = site.readFileView('/large.bin');
    try {
      b.ops('views.access.1m.memcmp.view', () => lease.view.equals(other));
      b.ops('views.access.1m.memcmp.owned', () => owned.equals(other));
      b.ops('views.access.1m.js.view', () => stride(lease.view));
      b.ops('views.access.1m.js.owned', () => stride(owned));
    } finally {
      lease.release();
    }

    const length = (view) => view.length;
    const lengthAsync = async (view) => view.length;
    await b.opsAsync('views.withFileView.sync', () =>
      site.withFileView('/small.txt', length),
    );
    await b.opsAsync('views.withFileView.async', () =>
      site.withFileView('/small.txt', lengthAsync),
    );
    // The same, over the 1 MiB file: withFileView's own cost (a lease, the
    // callback, a release) does not scale with what it views.
    await b.opsAsync('views.withFileView.sync.1m', () =>
      site.withFileView('/large.bin', length),
    );
    await b.opsAsync('views.withFileView.async.1m', () =>
      site.withFileView('/large.bin', lengthAsync),
    );
    await b.opsAsync('views.manual.async', async () => {
      const l = site.readFileView('/small.txt');
      try {
        return l.view.length;
      } finally {
        l.release();
      }
    });
    memory(b, 'views', k);
  } finally {
    k.close();
    cleanup(root);
  }
};
