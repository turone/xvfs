'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { tmpDir, rm, kernel, until, within } = require('./helpers.js');

// Per-key mutation ordering on sab+virtual places: every scenario is a
// deterministic assertion, not a printed log.

const settle = (p) =>
  p.then(
    () => ({ ok: true }),
    (e) => ({ ok: false, code: e.code }),
  );

describe('mutation ordering: same key', () => {
  it('two writes: publication and settlement follow arrival order', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    try {
      const v = k.fs('v');
      const seen = [];
      const w1 = v.writeFile('/a.txt', 'one').then(() => seen.push('A'));
      const w2 = v.writeFile('/a.txt', 'two').then(() => seen.push('B'));
      await Promise.all([w1, w2]);
      assert.deepEqual(seen, ['A', 'B']);
      assert.equal(v.readFile('/a.txt', 'utf8'), 'two');
    } finally {
      k.close();
      rm(root);
    }
  });

  it('a slow publication of A holds the key: a ready B never overtakes it', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    try {
      const v = k.fs('v');
      const gateA = Promise.withResolvers();
      const original = k.publishVirtual.bind(k);
      let first = true;
      // Deterministically slow down only the *first* commit reaching the
      // allocator (A's), without touching the synchronous preparer contract:
      // the mutation queue itself must be what keeps B from overtaking it.
      k.publishVirtual = async (place, key, raw) => {
        if (first) {
          first = false;
          await gateA.promise;
        }
        return original(place, key, raw);
      };
      const order = [];
      const a = v.writeFile('/g.txt', 'A').then(() => order.push('A'));
      const b = v.writeFile('/g.txt', 'B').then(() => order.push('B'));
      // Give B every chance to race ahead before releasing A.
      await new Promise((r) => setImmediate(r));
      assert.equal(order.length, 0, 'neither has published yet');
      assert.equal(first, false, "A's publication is at its gate");
      gateA.resolve();
      await within(Promise.all([a, b]), 'A and B, the gate open');
      assert.deepEqual(order, ['A', 'B']);
      assert.equal(v.readFile('/g.txt', 'utf8'), 'B');
    } finally {
      k.close();
      rm(root);
    }
  });

  it('write then unlink: entry is gone', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    try {
      const v = k.fs('v');
      const [w, u] = await Promise.all([
        settle(v.writeFile('/b.txt', 'x')),
        settle(v.unlink('/b.txt')),
      ]);
      assert.equal(w.ok, true);
      assert.equal(u.ok, true);
      assert.equal(v.exists('/b.txt'), false);
    } finally {
      k.close();
      rm(root);
    }
  });

  it('unlink(ENOENT) then write: entry exists with the new content', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    try {
      const v = k.fs('v');
      const [u, w] = await Promise.all([
        settle(v.unlink('/c.txt')),
        settle(v.writeFile('/c.txt', 'c')),
      ]);
      assert.equal(u.ok, false);
      assert.equal(u.code, 'ENOENT');
      assert.equal(w.ok, true);
      assert.equal(v.readFile('/c.txt', 'utf8'), 'c');
    } finally {
      k.close();
      rm(root);
    }
  });

  it('a failed mutation does not block a following write of the same key', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    try {
      const v = k.fs('v');
      const [failed, wrote] = await Promise.all([
        settle(v.rename('/gone.txt', '/nope.txt')),
        settle(v.writeFile('/gone.txt', 'after failure')),
      ]);
      assert.equal(failed.ok, false);
      assert.equal(failed.code, 'ENOENT');
      assert.equal(wrote.ok, true);
      assert.equal(v.readFile('/gone.txt', 'utf8'), 'after failure');
      assert.equal(k.mutations.size, 0);
    } finally {
      k.close();
      rm(root);
    }
  });

  it("mkdir runs in its key's turn, after the mutations queued before it", async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    try {
      const v = k.fs('v');
      // The write is still publishing when mkdir is asked: in its turn, mkdir
      // finds the key the unlink left, not the file in flight.
      const results = await Promise.allSettled([
        v.writeFile('/c', 'c'),
        v.unlink('/c'),
        v.mkdir('/c'),
      ]);
      assert.deepEqual(
        results.map((r) => r.reason?.code ?? r.status),
        ['fulfilled', 'fulfilled', 'fulfilled'],
      );
      assert.ok(v.stat('/c').isDirectory(), 'the directory mkdir made');
      assert.equal(k.mutations.size, 0);
    } finally {
      k.close();
      rm(root);
    }
  });

  it('a write takes the bytes it is given when it is called', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
      m: { provider: 'map', origin: 'virtual', fs: { writable: true } },
    });
    try {
      for (const name of ['v', 'm']) {
        const place = k.fs(name);
        const bytes = Buffer.from('first');
        const written = place.writeFile('/b.txt', bytes);
        bytes.write('xxxxx');
        await written;
        assert.equal(place.readFile('/b.txt', 'utf8'), 'first', name);
        const tail = Buffer.from('+tail');
        const appended = place.appendFile('/b.txt', tail);
        tail.write('xxxxx');
        await appended;
        assert.equal(place.readFile('/b.txt', 'utf8'), 'first+tail', name);
      }
    } finally {
      k.close();
      rm(root);
    }
  });

  it('two workers writing the same key: order = arrival at main, one update each', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    let w1 = null;
    let w2 = null;
    try {
      const first = k.nextUpdateId;
      const WORKER = `
        const { parentPort } = require('node:worker_threads');
        const { attach } = require(${JSON.stringify(path.resolve(__dirname, '../index.js'))});
        const kernel = attach();
        parentPort.on('message', async (msg) => {
          try {
            await kernel.fs('v').writeFile(msg.key, msg.data);
            parentPort.postMessage({ ok: true });
          } catch (err) {
            parentPort.postMessage({ ok: false, code: err.code });
          }
        });
        parentPort.postMessage('ready');
      `;
      const spawn = () => {
        const { vfs, transferList } = k.link();
        return new Worker(WORKER, {
          eval: true,
          workerData: { vfs },
          transferList,
        });
      };
      const ready = (w) =>
        new Promise((resolve, reject) => {
          w.once('message', resolve);
          w.once('error', reject);
        });
      const ask = (w, msg) =>
        new Promise((resolve, reject) => {
          w.once('message', resolve);
          w.once('error', reject);
          w.postMessage(msg);
        });
      w1 = spawn();
      w2 = spawn();
      await within(Promise.all([ready(w1), ready(w2)]), 'both workers ready');
      const [r1, r2] = await within(
        Promise.all([
          ask(w1, { key: '/shared.txt', data: 'from-1' }),
          ask(w2, { key: '/shared.txt', data: 'from-2' }),
        ]),
        'both writes answered',
      );
      assert.equal(r1.ok, true);
      assert.equal(r2.ok, true);
      const v = k.fs('v');
      assert.ok(
        ['from-1', 'from-2'].includes(v.readFile('/shared.txt', 'utf8')),
      );
      assert.equal(
        k.nextUpdateId - first,
        2,
        'no coalescing: one update per accepted mutation',
      );
    } finally {
      await w1?.terminate();
      await w2?.terminate();
      k.close();
      rm(root);
    }
  });
});

describe('mutation ordering: independent keys', () => {
  it('a slow key does not block a fast, unrelated key', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    try {
      const v = k.fs('v');
      const gateSlow = Promise.withResolvers();
      const original = k.publishVirtual.bind(k);
      let first = true;
      // Gate only the first publication reaching the allocator (slow.txt's,
      // issued first below), the same way as the same-key test above: the
      // queue itself, not a timer, must be what lets /fast.txt through.
      k.publishVirtual = async (place, key, raw) => {
        if (first) {
          first = false;
          await gateSlow.promise;
        }
        return original(place, key, raw);
      };
      const order = [];
      const slow = v
        .writeFile('/slow.txt', 'x'.repeat(64 * 1024))
        .then(() => order.push('slow'));
      const fast = v.writeFile('/fast.txt', 'y').then(() => order.push('fast'));

      // Prove /fast.txt is fully published and its Promise settled while
      // /slow.txt is still gated — not just that both eventually finish. A
      // queue that held /fast.txt behind it would not hang the test: fast
      // is waited for within a deadline.
      await within(fast, '/fast.txt, while /slow.txt is at its gate');
      assert.equal(first, false, "/slow.txt's publication is at its gate");
      assert.deepEqual(
        order,
        ['fast'],
        "fast published before slow's gate opened",
      );
      assert.equal(v.readFile('/fast.txt', 'utf8'), 'y');
      assert.equal(v.exists('/slow.txt'), false, 'slow is still unpublished');

      gateSlow.resolve();
      await within(slow, '/slow.txt, its gate open');
      assert.deepEqual(order, ['fast', 'slow']);
      assert.equal(v.readFile('/slow.txt', 'utf8').length, 64 * 1024);
    } finally {
      k.close();
      rm(root);
    }
  });
});

describe('mutation ordering: rename and rm coordination', () => {
  // `require.compile` gives every .js source a bytecode representation,
  // compiled under its path: a rename publishes the file anew, with its own.
  const compiled = {
    v: {
      origin: 'virtual',
      fs: { writable: true },
      require: { compile: ['js'] },
    },
  };

  it('rename(src→dst) racing write(dst): deterministic result, the destination its own bytecode', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, compiled);
    try {
      const v = k.fs('v');
      await v.writeFile('/r1.js', 'src');
      // `v.rename(...)` registers the queue locks for both keys synchronously,
      // before the `v.writeFile(...)` argument next to it is even evaluated —
      // so the write is deterministically queued behind the whole rename.
      const [renamed, wrote] = await Promise.all([
        settle(v.rename('/r1.js', '/r2.js')),
        settle(v.writeFile('/r2.js', 'dst')),
      ]);
      assert.equal(renamed.ok, true);
      assert.equal(wrote.ok, true);
      assert.equal(
        v.readFile('/r2.js', 'utf8'),
        'dst',
        'write always follows the rename it raced',
      );
      assert.equal(v.exists('/r1.js'), false);
      assert.equal(k.registry.get('v').file('/r1.js'), null, 'nothing left');
      assert.notEqual(
        k.registry.get('v').bytecode('/r2.js', 'require'),
        null,
        'destination has its own bytecode',
      );
      assert.equal(k.mutations.size, 0);
    } finally {
      k.close();
      rm(root);
    }
  });

  it('two concurrent renames a→b and b→a: deterministic swap, no deadlock', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, compiled);
    try {
      const v = k.fs('v');
      await v.writeFile('/a.js', 'A');
      await v.writeFile('/b.js', 'B');
      // `rename('/a.js','/b.js')` locks both keys before `rename('/b.js','/a.js')`
      // is even evaluated, so it always runs first: /b.js is overwritten with
      // 'A', then the queued b→a moves that same content back onto /a.js.
      const [first, second] = await Promise.all([
        settle(v.rename('/a.js', '/b.js')),
        settle(v.rename('/b.js', '/a.js')),
      ]);
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.equal(v.exists('/a.js'), true);
      assert.equal(v.readFile('/a.js', 'utf8'), 'A');
      assert.equal(v.exists('/b.js'), false);
      const place = k.registry.get('v');
      assert.equal(place.file('/b.js'), null, 'nothing left on /b.js');
      assert.notEqual(place.bytecode('/a.js', 'require'), null);
      assert.equal(k.mutations.size, 0);
    } finally {
      k.close();
      rm(root);
    }
  });

  it('recursive rm(dir) racing write(dir/child.js): deterministic result, no resurrection', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, compiled);
    try {
      const v = k.fs('v');
      await v.mkdir('/d');
      await v.writeFile('/d/one.js', '1');
      // `rm(null, ...)` takes the exclusive place barrier synchronously before
      // `writeFile('/d/two.js', ...)` is evaluated, so the write is
      // deterministically queued behind the whole recursive removal — and
      // finds no directory any more.
      const [removed, wrote] = await Promise.all([
        settle(v.rm('/d', { recursive: true })),
        settle(v.writeFile('/d/two.js', '2')),
      ]);
      assert.equal(removed.ok, true);
      assert.deepEqual(wrote, { ok: false, code: 'ENOENT' });
      assert.equal(v.exists('/d'), false, 'the write always follows the rm');
      assert.equal(k.registry.get('v').file('/d/one.js'), null);
      assert.equal(k.mutations.size, 0);
    } finally {
      k.close();
      rm(root);
    }
  });

  it('a recursive rm waits for a write in flight below it: nothing comes back', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    try {
      const v = k.fs('v');
      await v.writeFiles({ '/d/one.txt': '1' });
      const gate = Promise.withResolvers();
      let atGate = false;
      const original = k.publishVirtual.bind(k);
      k.publishVirtual = async (place, key, raw) => {
        if (key === '/d/slow.txt') {
          atGate = true;
          await gate.promise;
        }
        return original(place, key, raw);
      };
      const slow = v.writeFile('/d/slow.txt', 'slow');
      const removed = v.rm('/d', { recursive: true });
      // Give the removal every chance to run while the write is at its gate.
      await new Promise((r) => setImmediate(r));
      assert.equal(atGate, true, 'the write is at its gate');
      gate.resolve();
      await within(Promise.all([slow, removed]), 'the write and the rm');
      assert.equal(v.exists('/d'), false, 'the write in flight went with it');
      assert.equal(k.mutations.size, 0);
    } finally {
      k.close();
      rm(root);
    }
  });

  it('a file gone before its rename runs stays ENOENT, though a directory took its name', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    try {
      const v = k.fs('v');
      await v.writeFile('/x', 'x');
      const gate = Promise.withResolvers();
      let atGate = false;
      const original = k.publishVirtual.bind(k);
      k.publishVirtual = async (place, key, raw) => {
        if (key === '/y') {
          atGate = true;
          await gate.promise;
        }
        return original(place, key, raw);
      };
      // Asked while /x is a file, the rename waits for the unlink of /x and
      // for the write that holds /y; meanwhile /x becomes a directory.
      const held = v.writeFile('/y', 'y');
      const gone = v.unlink('/x');
      const moved = v.rename('/x', '/y');
      await within(gone, 'the unlink of /x, with /y at its gate');
      await within(v.writeFiles({ '/x/a': 'a' }), 'the write of /x/a');
      assert.equal(atGate, true, 'the write of /y is at its gate');
      gate.resolve();
      await within(held, 'the write of /y, its gate open');
      const err = await within(
        moved.then(
          () => null,
          (error) => error,
        ),
        'the rename',
      );
      assert.equal(err?.code, 'ENOENT');
      assert.equal(err.syscall, 'rename');
      assert.equal(err.path, v.pathOf('/x'));
      assert.equal(err.dest, v.pathOf('/y'));
      assert.equal(v.readFile('/x/a', 'utf8'), 'a', 'the directory stays');
      assert.equal(v.readFile('/y', 'utf8'), 'y');
      assert.equal(k.mutations.size, 0);
    } finally {
      k.close();
      rm(root);
    }
  });

  it('an independent write outside the removed subtree is never lost', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    try {
      const v = k.fs('v');
      await v.writeFiles({ '/d/one.txt': '1' });
      await Promise.all([
        settle(v.rm('/d', { recursive: true })),
        settle(v.writeFiles({ '/other/file.js': 'kept' })),
      ]);
      assert.equal(v.readFile('/other/file.js', 'utf8'), 'kept');
    } finally {
      k.close();
      rm(root);
    }
  });
});

describe('mutation lifecycle and cleanup', () => {
  it('kernel close rejects a still-queued mutation as the closed kernel and frees the lock', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    try {
      const v = k.fs('v');
      await v.writeFiles({ '/a.txt': 'a', '/d/b.txt': 'b' });
      // Every kind of turn: a key, several keys, the place's barrier.
      const queued = [
        ['writeFile', v.writeFile('/late.txt', 'late')],
        [
          'writeFiles',
          v.writeFiles([
            ['/x.txt', 'x'],
            ['/y.txt', 'y'],
          ]),
        ],
        ['unlink', v.unlink('/a.txt')],
        ['mkdir', v.mkdir('/n')],
        ['rmdir', v.rmdir('/d')],
        ['rename', v.rename('/a.txt', '/c.txt')],
        ['rm', v.rm('/d', { recursive: true })],
      ];
      k.close();
      for (const [what, pending] of queued) {
        await assert.rejects(
          pending,
          {
            code: 'ERR_VFS_CLOSED',
            message: '[vfs] mutations requires a ready kernel (state: closed)',
          },
          what,
        );
      }
      assert.equal(k.mutations.size, 0, 'no lock record survives close()');
      assert.equal(k.links.size, 0);
      assert.equal(k.acks.size, 0);
      assert.equal(k.retired.size, 0);
    } finally {
      k.close();
      rm(root);
    }
  });

  // A mutation whose kernel closes after its publication's last step and
  // before the commit published nothing: it rejects as the closed kernel,
  // never resolves. The seam: the compressor's last question about the
  // key, asked in the publication's last step but one (publication.js,
  // compress) — its second, or its only one where the key compiles and
  // nothing asks it first; two microtasks later the publication has
  // returned and its write is staged, and the kernel closes then — before
  // the commit, which finds it closed (#commit). A rename that publishes
  // the file anew (into a compiled extension) has the same seam; one that
  // moves it as it is commits in the turn its checks pass.
  it('a mutation whose kernel closes before its commit rejects as the closed kernel', async () => {
    const mutations = [
      ['writeFile', (v) => v.writeFile('/b.txt', 'b'), 2],
      ['appendFile', (v) => v.appendFile('/a.txt', '+'), 2],
      ['rename', (v) => v.rename('/a.txt', '/c.js'), 1],
    ];
    const compiled = {
      v: {
        origin: 'virtual',
        fs: { writable: true },
        require: { compile: ['js'] },
      },
    };
    for (const [what, mutate, last] of mutations) {
      const root = tmpDir('vfs-order');
      const k = await kernel(root, compiled);
      try {
        const v = k.fs('v');
        await v.writeFile('/a.txt', 'a');
        const updates = k.nextUpdateId;
        let closed = 0;
        let asked = 0;
        k.compressor.compressible = () => {
          if (++asked === last) {
            queueMicrotask(() =>
              queueMicrotask(() => {
                closed++;
                k.close();
              }),
            );
          }
          return false;
        };
        await assert.rejects(
          mutate(v),
          {
            code: 'ERR_VFS_CLOSED',
            message: '[vfs] kernel closed before publication',
          },
          what,
        );
        assert.equal(closed, 1, `${what}: closed before its commit`);
        assert.equal(k.nextUpdateId, updates, `${what}: nothing published`);
        assert.equal(k.mutations.size, 0);
      } finally {
        k.close();
        rm(root);
      }
    }
  });

  // A subtree moves as it is: nothing is copied, and the move is
  // committed in the turn its checks pass — no await for a close to come
  // in (Т23).
  it('a subtree rename copies nothing and commits in its turn', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    try {
      const v = k.fs('v');
      await v.writeFiles({ '/d/a.txt': 'a', '/d/b.txt': 'b' });
      const updates = k.nextUpdateId;
      let copies = 0;
      const allocate = k.cache.allocate.bind(k.cache);
      k.cache.allocate = (file, options) => {
        copies++;
        return allocate(file, options);
      };
      const moved = v.rename('/d', '/e');
      await new Promise((r) => setImmediate(r));
      k.close();
      await moved;
      assert.equal(copies, 0, 'nothing copied');
      assert.equal(k.nextUpdateId, updates + 1, 'published before the close');
      assert.equal(k.mutations.size, 0);
    } finally {
      k.close();
      rm(root);
    }
  });

  // Regression: the link port is unref'd, so a worker with nothing else to
  // do used to exit before its own write settled.
  it('a pending worker mutation keeps the worker alive until it settles', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    let worker = null;
    try {
      const WORKER = `
        const { parentPort } = require('node:worker_threads');
        const { attach } = require(${JSON.stringify(path.resolve(__dirname, '../index.js'))});
        attach()
          .fs('v')
          .writeFile('/alive.txt', 'x')
          .then(() => parentPort.postMessage('settled'));
      `;
      const { vfs, transferList } = k.link();
      worker = new Worker(WORKER, {
        eval: true,
        workerData: { vfs },
        transferList,
      });
      const messages = [];
      worker.on('message', (m) => messages.push(m));
      await within(
        new Promise((resolve, reject) => {
          worker.once('exit', resolve);
          worker.once('error', reject);
        }),
        'the exit of the worker',
      );
      assert.deepEqual(
        messages,
        ['settled'],
        'settled before the worker exited',
      );
      assert.equal(k.fs('v').readFile('/alive.txt', 'utf8'), 'x');
    } finally {
      await worker?.terminate();
      k.close();
      rm(root);
    }
  });

  it('worker exit with a pending request leaves no dangling state on main', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    let worker = null;
    try {
      const WORKER = `
        const { parentPort } = require('node:worker_threads');
        const { attach } = require(${JSON.stringify(path.resolve(__dirname, '../index.js'))});
        const kernel = attach();
        parentPort.on('message', () => {
          // Fire the mutation and exit immediately, before any response.
          kernel.fs('v').writeFile('/from-worker.txt', 'x').catch(() => {});
          process.exit(0);
        });
        parentPort.postMessage('ready');
      `;
      const { vfs, transferList } = k.link();
      worker = new Worker(WORKER, {
        eval: true,
        workerData: { vfs },
        transferList,
      });
      await within(
        new Promise((resolve, reject) => {
          worker.once('message', resolve);
          worker.once('error', reject);
        }),
        'the worker ready',
      );
      worker.postMessage('go');
      await within(
        new Promise((resolve) => worker.once('exit', resolve)),
        'the exit of the worker',
      );
      // Give the closed port's 'close' handler a turn to run handleWorkerExit,
      // and the request itself a turn to finish publishing on main.
      await until(() => k.links.size === 0 && k.mutations.size === 0, 2000);
      // The request's Promise settled (main actually published it) rather than
      // being left to hang forever once the worker that awaited it is gone.
      assert.equal(k.fs('v').exists('/from-worker.txt'), true);
      assert.equal(k.mutations.size, 0, 'no pending-request lock record left');
      assert.equal(k.links.size, 0, "the exited worker's link is gone");
      assert.equal(k.acks.size, 0, 'no ACK bookkeeping left for it');
      assert.equal(k.retired.size, 0, 'nothing retired waits for it');
      assert.equal(
        k.rechecks.size,
        0,
        'no leaked recheck timer (active handle)',
      );
    } finally {
      await worker?.terminate();
      k.close();
      rm(root);
    }
  });
});
