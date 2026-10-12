'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { VfsKernel } = require('../lib/kernel.js');
const { Retirement } = require('../lib/retirement.js');
const { createTree } = require('../lib/tree.js');
const epoch = require('../lib/epoch.js');
const {
  tmpDir,
  writeTree,
  rm,
  kernel,
  config,
  quiet,
  tap,
  worker,
  until,
  within,
  turn,
  fileOf,
  leakedBytes,
} = require('./helpers.js');

// What a place's tree gives the FS layer (lib/tree.js, stage B): a node per
// file and per directory, its id the `ino` of its stats — in every thread
// for a shared place, a `map` place's tree being each thread's own — and
// kept by a move; the attributes a place keeps; a move that copies
// nothing; a worker whose view breaks when an update cannot be applied;
// and the two pure steps of an epoch (lib/epoch.js).

const VIRTUAL = { origin: 'virtual', fs: { writable: true, zeroCopy: true } };

describe('nodes: ids', () => {
  it('ino is the node id, the same in every thread of a shared place; dev the place; a move keeps both', async () => {
    const root = tmpDir('vfs-nodes');
    const k = await kernel(root, {
      v: VIRTUAL,
      m: { provider: 'map', ...VIRTUAL },
    });
    const w = worker(k);
    try {
      const v = k.fs('v');
      await v.writeFiles({ '/d/a.txt': 'a', '/b.txt': 'b' });
      const id = v.idOf('/d/a.txt');
      assert.equal(typeof id, 'number');
      assert.equal(v.stat('/d/a.txt').ino, id);
      assert.equal(v.stat('/d/a.txt', { bigint: true }).ino, BigInt(id));
      assert.equal(v.stat('/d').ino, v.idOf('/d'), 'a directory too');
      assert.equal(v.keyOf(id), '/d/a.txt');
      assert.equal(v.keyOf(v.idOf('')), '', 'the place itself');
      const dev = v.stat('/b.txt').dev;
      assert.equal(dev, 1, 'the first place of the config');
      assert.equal(k.fs('m').stat('').dev, 2);
      const wv = w.kernel.fs('v');
      // The worker has applied the updates once its version is main's.
      const caughtUp = () => until(() => w.kernel.version === k.version);
      assert.ok(await caughtUp());
      assert.equal(wv.idOf('/d/a.txt'), id, 'the same id in a worker');
      assert.equal(wv.stat('/d/a.txt').dev, dev);
      await v.mkdir('/e');
      await v.rename('/d', '/e/d');
      assert.ok(await caughtUp());
      for (const place of [v, wv]) {
        assert.equal(place.idOf('/e/d/a.txt'), id, 'kept by the move');
        assert.equal(place.keyOf(id), '/e/d/a.txt', 'the key after it');
        assert.equal(place.idOf('/d/a.txt'), null);
      }
      // A file removed and written again is another node.
      await v.unlink('/b.txt');
      const removed = v.idOf('/b.txt');
      assert.equal(removed, null);
      await v.writeFile('/b.txt', 'b2');
      assert.notEqual(v.idOf('/b.txt'), null);
      assert.equal(v.keyOf(9999), null, 'no node has it');
      assert.equal(v.keyOf('x'), null);
      assert.equal(v.idOf('/none'), null);
    } finally {
      w.kernel.close();
      k.close();
      rm(root);
    }
  });

  it('a file the fs domain does not see has no key; the disk territory no id', async () => {
    const root = writeTree(tmpDir('vfs-nodes'), {
      'site/a.js': 'module.exports = 1;',
      'site/img.png': 'png',
    });
    const k = await kernel(root, {
      site: { fs: { ext: ['txt'], fallback: 'disk' }, require: true },
    });
    try {
      const site = k.fs('site');
      const { tree } = k.registry.get('site');
      const id = tree.nodeId(tree.get('/a.js'));
      assert.equal(site.keyOf(id), null, 'require only');
      assert.equal(site.idOf('/a.js'), null);
      assert.equal(site.exists('/img.png'), true, 'the disk territory');
      assert.equal(site.idOf('/img.png'), null);
      assert.equal(site.stat('/img.png').ino, 0);
      assert.equal(site.stat('/img.png').dev, 0);
    } finally {
      k.close();
      rm(root);
    }
  });
});

describe('nodes: attributes', () => {
  it("birthtime: a virtual file keeps its first write's; a disk file has the disk's", async () => {
    const root = writeTree(tmpDir('vfs-nodes'), { 'site/a.txt': 'a' });
    const born = fs.statSync(path.join(root, 'site', 'a.txt')).birthtimeMs;
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    let k = null;
    try {
      k = await kernel(root, {
        site: { fs: true, stat: { birthtime: true } },
        v: { ...VIRTUAL, stat: { birthtime: true } },
        plain: VIRTUAL,
      });
      assert.equal(k.fs('site').stat('/a.txt').birthtimeMs, born);
      const v = k.fs('v');
      await v.writeFile('/f.txt', 'one');
      now += 5000;
      await v.writeFile('/f.txt', 'two');
      const st = v.stat('/f.txt');
      assert.equal(st.mtimeMs, 1_005_000);
      assert.equal(st.birthtimeMs, 1_000_000, "the first write's, kept");
      assert.equal(st.birthtime.getTime(), 1_000_000);
      assert.equal(st.ctimeMs, st.mtimeMs, 'ctime equals mtime');
      const plain = k.fs('plain');
      await plain.writeFile('/f.txt', 'x');
      const p = plain.stat('/f.txt');
      assert.equal(p.birthtimeMs, p.mtimeMs, 'not kept: mtime');
    } finally {
      Date.now = realNow;
      k?.close();
      rm(root);
    }
  });

  // The clock is the test's: a child added a few seconds later moves the
  // directory's mtime, and its birthtime only where the place keeps one.
  it('directories: a directory has the version and times of its last change; without, 0', async () => {
    const root = tmpDir('vfs-nodes');
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    let k = null;
    try {
      k = await kernel(root, {
        v: { ...VIRTUAL, stat: { directories: true, birthtime: true } },
        d: { ...VIRTUAL, stat: { directories: true } },
        plain: VIRTUAL,
      });
      const v = k.fs('v');
      await v.mkdir('/d');
      const made = v.stat('/d');
      assert.ok(made.isDirectory());
      assert.equal(made.mtimeMs, 1_000_000);
      assert.equal(made.birthtimeMs, 1_000_000);
      const { tree } = k.registry.get('v');
      const before = tree.payloadOf(tree.get('/d')).version;
      now += 5000;
      await v.writeFile('/d/a.txt', 'a');
      const after = tree.payloadOf(tree.get('/d')).version;
      assert.ok(after > before, 'a child added changes it');
      assert.equal(v.version('/d'), after, "version(): the directory's own");
      assert.equal(v.version('/d/a.txt'), after, 'the commit that changed it');
      const changed = v.stat('/d');
      assert.equal(changed.mtimeMs, 1_005_000, 'its mtime, with its children');
      assert.equal(changed.birthtimeMs, 1_000_000, 'its birthtime, kept');
      const d = k.fs('d');
      await d.mkdir('/d');
      now += 5000;
      await d.writeFile('/d/a.txt', 'a');
      const own = d.stat('/d');
      assert.equal(own.mtimeMs, 1_010_000);
      assert.equal(own.birthtimeMs, own.mtimeMs, 'no birthtime kept: mtime');
      const plain = k.fs('plain');
      await plain.mkdir('/d');
      assert.equal(plain.stat('/d').mtimeMs, 0);
      assert.equal(plain.version('/d'), null, 'no directory attributes');
      assert.equal(
        k.registry
          .get('plain')
          .tree.payloadOf(k.registry.get('plain').tree.get('/d')),
        null,
      );
    } finally {
      Date.now = realNow;
      k?.close();
      rm(root);
    }
  });
});

describe('nodes: the buffers of a map place', () => {
  const MAP = {
    provider: 'map',
    origin: 'virtual',
    fs: { writable: true, script: { compile: ['js'] } },
  };

  it('a set refused before its commit leaves no buffer behind', async () => {
    const root = tmpDir('vfs-nodes');
    const k = await kernel(root, { m: MAP });
    try {
      const m = k.fs('m');
      const { store } = k.registry.get('m');
      m.writeFile('/keep.js', 'module.exports = 1;');
      const held = store.segments.size;
      for (let i = 0; i < 20; i++) {
        assert.throws(
          () =>
            m.writeFiles([
              ['/ok.js', 'module.exports = 2;'],
              ['/bad.js', 'this is ( not a script'],
            ]),
          { code: 'ENOTSUP' },
        );
      }
      assert.equal(store.segments.size, held, 'nothing of the refused sets');
      assert.deepEqual(m.readdir('/'), ['keep.js']);
    } finally {
      k.close();
      rm(root);
    }
  });

  it("a small file keeps a buffer of its own, not a slab of Node's pool", async () => {
    const root = tmpDir('vfs-nodes');
    const k = await kernel(root, { m: MAP });
    try {
      const m = k.fs('m');
      const { store, tree } = k.registry.get('m');
      for (let i = 0; i < 50; i++) m.writeFile(`/f${i}.txt`, 'x'.repeat(100));
      for (let i = 0; i < 50; i++) {
        const { source } = tree.payloadOf(tree.get(`/f${i}.txt`));
        assert.equal(store.segments.get(source.segmentId).byteLength, 100);
      }
    } finally {
      k.close();
      rm(root);
    }
  });
});

describe('nodes: segments', () => {
  // A segment is the pool's for good, the same SAB: a snapshot carries
  // every one, an update the one it first publishes into — once.
  it('an update carries a segment once, the first that publishes into it; a snapshot carries every one', async () => {
    const root = tmpDir('vfs-nodes');
    const k = await kernel(
      root,
      { v: VIRTUAL },
      {
        memory: {
          limit: '1 mib',
          segmentSize: '64 kib',
          maxFileSize: '64 kib',
        },
      },
    );
    const w = worker(k);
    try {
      const first = tap(k);
      const v = k.fs('v');
      const segmentOf = (key) => fileOf(k, 'v', key).source.segmentId;
      await v.writeFile('/a.txt', 'a'.repeat(1024));
      await v.writeFile('/b.txt', 'b'.repeat(1024));
      await until(() => first.updates().length === 2);
      const [ua, ub] = first.updates();
      const one = segmentOf('/a.txt');
      assert.deepEqual(
        ua.newSegments.map((s) => s.id),
        [one],
      );
      assert.equal(segmentOf('/b.txt'), one, 'the same segment');
      assert.deepEqual(ub.newSegments, [], 'carried already');
      const second = tap(k);
      assert.ok(second.snapshot.segments.some((s) => s.id === one));
      await v.writeFile('/c.bin', Buffer.alloc(40 * 1024, 1));
      await v.writeFile('/d.bin', Buffer.alloc(40 * 1024, 2));
      const fresh = segmentOf('/d.bin');
      assert.notEqual(fresh, one, 'a new segment');
      await until(() => second.updates().length === 2);
      for (const t of [first, second]) {
        const carried = t
          .updates()
          .flatMap((u) => u.newSegments.map((s) => s.id));
        assert.equal(carried.filter((id) => id === fresh).length, 1, 'once');
      }
      await until(() => w.kernel.version === k.version);
      const files = w.kernel.fs('v');
      assert.deepEqual(files.readFile('/d.bin'), Buffer.alloc(40 * 1024, 2));
      assert.equal(files.readFile('/a.txt', 'utf8'), 'a'.repeat(1024));
    } finally {
      k.close();
      rm(root);
    }
  });
});

describe('nodes: what a commit takes back', () => {
  // A payload a commit writes and writes over in itself was published to no
  // one: its bytes go back with the commit (the tree's `dropped`) — never
  // retired, never left in the pool. No caller of the kernel writes a key
  // twice in one commit: a set names each key once, as writeFiles does.
  const failOf = () => (code) => Object.assign(new Error(code), { code });

  it('a batch that names a key twice is refused before anything changes', async () => {
    const root = tmpDir('vfs-nodes');
    const k = await kernel(root, { v: VIRTUAL });
    try {
      const v = k.fs('v');
      await v.writeFile('/a.txt', 'zero');
      const version = k.version;
      const update = k.nextUpdateId;
      const files = [
        ['/a.txt', Buffer.from('one')],
        ['/n/b.txt', Buffer.from('three')],
        ['/a.txt', Buffer.from('two')],
      ];
      await assert.rejects(
        k.publishVirtualBatch(k.registry.get('v'), files, failOf),
        (err) =>
          err instanceof TypeError && /"\/a\.txt" twice/.test(err.message),
      );
      assert.equal(v.readFile('/a.txt', 'utf8'), 'zero');
      assert.equal(v.exists('/n'), false, 'no directory made');
      assert.equal(k.version, version, 'no version');
      assert.equal(k.nextUpdateId, update, 'no update');
      assert.equal(leakedBytes(k), 0, 'nothing placed');
    } finally {
      k.close();
      rm(root);
    }
  });

  // Through the kernel's own seam, with extents of its pool: a commit that
  // writes a key twice and writes and unlinks another.
  it('a commit that takes back what it wrote frees it at once; a worker reads what stays', async () => {
    const root = tmpDir('vfs-nodes');
    const k = await kernel(root, { v: VIRTUAL });
    const w = worker(k);
    try {
      const v = k.fs('v');
      await v.writeFile('/a.txt', 'zero');
      const input = (text) => {
        const data = Buffer.from(text);
        const stat = { size: data.length, mtimeMs: 1 };
        const extent = k.cache.allocateSync({ data, stat });
        return { ...stat, representations: [[0, extent]] };
      };
      const fail = (code) => Object.assign(new Error(code), { code });
      const ops = [
        ['write', '/a.txt', input('one')],
        ['write', '/a.txt', input('two')],
        ['write', '/b.txt', input('three')],
        ['unlink', '/b.txt'],
      ];
      await k.changeVirtual(k.registry.get('v'), ops, fail);
      assert.equal(leakedBytes(k), 0, 'nothing of what it took back');
      assert.equal(v.readFile('/a.txt', 'utf8'), 'two');
      assert.equal(v.exists('/b.txt'), false);
      const keys = [...k.retired.values()].map((r) => r.key);
      assert.ok(
        keys.every((key) => key === '/a.txt'),
        'the published one alone retires',
      );
      await until(() => w.kernel.version === k.version);
      assert.equal(w.kernel.fs('v').readFile('/a.txt', 'utf8'), 'two');
      await until(() => k.retired.size === 0);
      assert.equal(leakedBytes(k), 0);
    } finally {
      k.close();
      rm(root);
    }
  });

  it('a map place keeps no buffer of what a commit wrote over in itself', async () => {
    const root = tmpDir('vfs-nodes');
    const k = await kernel(root, {
      m: { provider: 'map', origin: 'virtual', fs: { writable: true } },
    });
    try {
      const { store } = k.registry.get('m');
      store.publishBatch(
        [
          ['/a.txt', Buffer.from('one')],
          ['/a.txt', Buffer.from('two')],
        ],
        failOf,
      );
      assert.equal(k.fs('m').readFile('/a.txt', 'utf8'), 'two');
      assert.equal(store.segments.size, 1, 'the buffer of the second alone');
    } finally {
      k.close();
      rm(root);
    }
  });
});

describe('nodes: moves', () => {
  it('a file onto a file replaces it in one commit: moved, the replaced one removed', async () => {
    const root = tmpDir('vfs-nodes');
    const k = await kernel(root, { v: VIRTUAL });
    try {
      const v = k.fs('v');
      await v.writeFile('/a.txt', 'a');
      await v.writeFile('/b.txt', 'b');
      const id = v.idOf('/a.txt');
      const version = v.version('/a.txt');
      const events = [];
      k.on('publish', (event) => events.push(event));
      await v.rename('/a.txt', '/b.txt');
      assert.equal(v.readFile('/b.txt', 'utf8'), 'a');
      assert.equal(v.idOf('/b.txt'), id);
      assert.equal(v.version('/b.txt'), version, 'its own version');
      assert.equal(v.exists('/a.txt'), false);
      await turn();
      assert.deepEqual(
        events.map((e) => e.places.v),
        [
          {
            created: [],
            replaced: [],
            removed: ['/b.txt'],
            moved: [['/a.txt', '/b.txt']],
          },
        ],
      );
      // The replaced file's bytes retire; the moved file's stay.
      assert.deepEqual(
        k.retirements().map((r) => r.key),
        [],
        'no link, no reader: freed at once',
      );
      assert.equal(leakedBytes(k), 0);
    } finally {
      k.close();
      rm(root);
    }
  });

  it('a file renamed into another pipeline is published anew in the commit of its move', async () => {
    const root = tmpDir('vfs-nodes');
    const k = await kernel(root, {
      v: { ...VIRTUAL, require: { compile: ['js'] } },
    });
    try {
      const v = k.fs('v');
      await v.writeFile('/m.txt', 'module.exports = 7;');
      const id = v.idOf('/m.txt');
      const version = v.version('/m.txt');
      const mtime = v.stat('/m.txt').mtimeMs;
      const events = [];
      k.on('publish', (event) => events.push(event));
      await v.rename('/m.txt', '/m.js');
      assert.equal(v.idOf('/m.js'), id, 'the node moved');
      assert.ok(v.version('/m.js') > version, 'a new payload');
      assert.equal(v.stat('/m.js').mtimeMs, mtime, 'its mtime kept');
      assert.ok(fileOf(k, 'v', '/m.js').others.requireBytecode);
      await turn();
      assert.deepEqual(
        events.map((e) => e.places.v),
        [
          {
            created: [],
            replaced: ['/m.js'],
            removed: [],
            moved: [['/m.txt', '/m.js']],
          },
        ],
      );
    } finally {
      k.close();
      rm(root);
    }
  });

  it('a directory moves as one node: one pair in the event, its files under the new key in every thread', async () => {
    const root = tmpDir('vfs-nodes');
    const k = await kernel(root, { v: VIRTUAL });
    const w = worker(k);
    try {
      const v = k.fs('v');
      await v.writeFiles({ '/d/a.txt': 'a', '/d/s/b.txt': 'b' });
      assert.ok(await until(() => w.kernel.version === k.version));
      const events = [];
      w.kernel.on('publish', (event) => events.push(event));
      await v.rename('/d', '/e');
      assert.ok(await until(() => w.kernel.version === k.version));
      await turn();
      assert.deepEqual(
        events.map((e) => e.places.v.moved),
        [[['/d', '/e']]],
      );
      const wv = w.kernel.fs('v');
      assert.deepEqual(wv.readdir('/e', { recursive: true }), [
        'a.txt',
        's',
        's/b.txt',
      ]);
      assert.equal(wv.readFile('/e/s/b.txt', 'utf8'), 'b');
    } finally {
      w.kernel.close();
      k.close();
      rm(root);
    }
  });
});

describe('nodes: compaction under leases', () => {
  // The representation a compaction moves out of a segment is retired like
  // a replaced one: a lease on it in the main thread and in a worker keeps
  // its old bytes until it is released, and a new lease reads the new
  // extent.
  it('a lease on a relocated representation keeps its bytes until it is released, in every thread', async () => {
    const KB = 1024;
    const root = tmpDir('vfs-nodes');
    const k = await kernel(
      root,
      { v: VIRTUAL },
      {
        memory: { limit: '16 kib', segmentSize: '4 kib', maxFileSize: '4 kib' },
        compaction: { threshold: 0.5 },
      },
    );
    const w = worker(k);
    try {
      const v = k.fs('v');
      await v.writeFile('/a', Buffer.alloc(2 * KB, 'a'));
      await v.writeFile('/b', Buffer.alloc(2 * KB, 'b'));
      await v.writeFile('/c', Buffer.alloc(200, 'c'));
      assert.equal(fileOf(k, 'v', '/c').source.segmentId, 2);
      const wv = w.kernel.fs('v');
      await until(() => wv.exists('/c'));
      const mainLease = v.readFileView('/c');
      const workerLease = wv.readFileView('/c');
      const version = v.version('/c');
      // Freeing /a makes segment 2 the target: /c moves to segment 1.
      await v.unlink('/a');
      assert.ok(
        await until(() => fileOf(k, 'v', '/c').source.segmentId === 1),
        '/c relocated',
      );
      assert.equal(v.version('/c'), version, 'its version kept');
      const fresh = v.readFileView('/c');
      assert.equal(fresh.view.toString(), 'c'.repeat(200));
      fresh.release();
      await until(() => k.retirements().some((r) => r.key === '/c'));
      const held = k.retirements().find((r) => r.key === '/c');
      assert.ok(held, 'the old extent is retired, held');
      assert.equal(mainLease.view.toString(), 'c'.repeat(200));
      assert.equal(workerLease.view.toString(), 'c'.repeat(200));
      mainLease.release();
      workerLease.release();
      assert.ok(
        await until(() => k.retirements().length === 0),
        'freed once both are released',
      );
      assert.equal(leakedBytes(k), 0);
    } finally {
      w.kernel.close();
      k.close();
      rm(root);
    }
  });

  // The books of compaction name the node that holds a representation after
  // the commit (the tree's `placed`), not the key a write named: through the
  // kernel's own seam, with an extent of its pool, a file written under one
  // key and moved to another in one commit.
  it('a node written and moved in one commit is booked as itself: compaction relocates it', async () => {
    const KB = 1024;
    const root = tmpDir('vfs-nodes');
    const k = await kernel(
      root,
      { v: VIRTUAL },
      {
        memory: { limit: '16 kib', segmentSize: '4 kib', maxFileSize: '4 kib' },
        compaction: { threshold: 0.5 },
      },
    );
    try {
      const v = k.fs('v');
      await v.writeFile('/a', Buffer.alloc(2 * KB, 'a'));
      await v.writeFile('/b', Buffer.alloc(2 * KB, 'b'));
      const data = Buffer.alloc(200, 'c');
      const stat = { size: data.length, mtimeMs: 1 };
      const extent = k.cache.allocateSync({ data, stat });
      assert.equal(extent.segmentId, 2);
      const fail = (code) => Object.assign(new Error(code), { code });
      const ops = [
        ['write', '/c0', { ...stat, representations: [[0, extent]] }],
        ['move', '/c0', '/c'],
      ];
      await k.changeVirtual(k.registry.get('v'), ops, fail);
      assert.equal(fileOf(k, 'v', '/c').source.segmentId, 2);
      // Freeing /a makes segment 2 the target: /c moves to segment 1.
      await v.unlink('/a');
      assert.ok(
        await until(() => fileOf(k, 'v', '/c').source.segmentId === 1),
        '/c relocated',
      );
      assert.equal(v.readFile('/c', 'utf8'), 'c'.repeat(200));
      assert.ok(await until(() => k.retirements().length === 0));
      assert.equal(leakedBytes(k), 0);
    } finally {
      k.close();
      rm(root);
    }
  });
});

describe('nodes: a path through a file', () => {
  // The node a path broke off at (Tree.match): past a file the fs domain
  // sees, the patched node:fs answers ENOTDIR, as node:fs does, and so does
  // readdir; past a file it does not see, strict refuses as for any path
  // the place does not serve.
  it('is ENOTDIR past a file the fs domain sees, as node:fs answers', async () => {
    const root = writeTree(tmpDir('vfs-nodes'), {
      'lib/a.txt': 'a',
      'lib/m.js': 'module.exports = 1;',
    });
    const k = await kernel(
      root,
      {
        v: VIRTUAL,
        lib: { fs: { ext: ['txt'] }, require: { ext: ['js'] } },
      },
      { strict: true },
    );
    const fsPatch = require('../lib/adapters/fs-patch.js');
    try {
      await k.fs('v').writeFile('/a.txt', 'a');
      fsPatch.install(k);
      for (const under of [
        path.join(root, 'v', 'a.txt', 'x'),
        path.join(root, 'lib', 'a.txt', 'x', 'y'),
      ]) {
        for (const call of [
          () => fs.statSync(under),
          () => fs.readFileSync(under),
          () => fs.readdirSync(under),
        ]) {
          assert.throws(call, { code: 'ENOTDIR' }, under);
        }
        assert.equal(fs.existsSync(under), false);
      }
      assert.throws(() => k.fs('v').readdir('/a.txt/sub'), {
        code: 'ENOTDIR',
      });
      const hidden = path.join(root, 'lib', 'm.js', 'x');
      assert.throws(() => fs.statSync(hidden), { code: 'EACCES' });
    } finally {
      fsPatch.uninstall();
      k.close();
      rm(root);
    }
  });
});

describe('nodes: a broken view', () => {
  // A delta a worker cannot apply breaks its view in the same step
  // (kernel.js, #break): every VFS call of the thread is the closed kernel
  // with the failure as its cause, pending mutations reject the same way,
  // no ACK goes, 'close' carries the failure — and the port stays open
  // while a lease is held, closing with the last.
  it('every call is ERR_VFS_CLOSED with the cause; the port closes with the last lease', async () => {
    const root = tmpDir('vfs-nodes');
    const k = await kernel(root, { v: VIRTUAL });
    let w = null;
    try {
      const v = k.fs('v');
      await v.writeFile('/a.txt', 'a');
      const { vfs } = k.link();
      const { takeSnapshot } = require('../lib/kernel.js');
      w = VfsKernel.fromSnapshot(
        takeSnapshot(vfs.port),
        config({ v: VIRTUAL }),
        {
          appRoot: root,
          console: quiet,
          port: vfs.port,
        },
      );
      const wv = w.fs('v');
      const lease = wv.readFileView('/a.txt');
      const closed = new Promise((resolve) => w.once('close', resolve));
      // An update whose delta was made from another revision of the tree.
      const t = tap(k);
      await v.writeFile('/b.txt', 'b');
      await until(() => t.updates().length === 1);
      const [update] = t.updates();
      const stale = structuredClone(update);
      stale.places.v.delta.from += 7;
      assert.throws(() => w.handleDelta(stale), { code: 'ESTALE' });
      const cause = await within(closed, "the worker's 'close'");
      assert.equal(cause.code, 'ESTALE');
      assert.equal(w.broken, cause);
      for (const call of [
        () => wv.readFile('/a.txt'),
        () => wv.stat('/a.txt'),
        () => wv.readdir(''),
        () => wv.writeFile('/c.txt', 'c'),
      ]) {
        assert.throws(call, (err) => {
          assert.equal(err.code, 'ERR_VFS_CLOSED');
          assert.equal(err.cause, cause);
          return true;
        });
      }
      assert.throws(
        () => w.fs('v'),
        (err) => {
          assert.equal(err.code, 'ERR_VFS_CLOSED');
          assert.equal(err.cause, cause, 'fs() of the broken view too');
          return true;
        },
      );
      assert.throws(() => w.routeRead(path.join(root, 'v', 'a.txt')), {
        code: 'ERR_VFS_CLOSED',
      });
      assert.equal(w.routeRead(path.join(root, '..', 'x')).kind, 'passthrough');
      // The lease reads on; the port waits for it.
      assert.equal(lease.view.toString(), 'a');
      const portClosed = new Promise((resolve) =>
        vfs.port.once('close', resolve),
      );
      lease.release();
      await within(portClosed, 'the port, once the lease is released');
      assert.ok(await until(() => k.links.size === 1), 'only the tap is left');
    } finally {
      w?.close();
      k.close();
      rm(root);
    }
  });

  // A closed kernel answers fs() and the reads of a facade it gave with the
  // code of every refusal close() causes, never "no file"; a link taken
  // twice says what its port held instead of its snapshot.
  it('a closed kernel refuses fs() and every read; a link taken twice names what it held', async () => {
    const root = tmpDir('vfs-nodes');
    const k = await kernel(root, { v: VIRTUAL });
    try {
      const v = k.fs('v');
      await v.writeFile('/a.txt', 'a');
      const { vfs } = k.link();
      const { takeSnapshot } = require('../lib/kernel.js');
      takeSnapshot(vfs.port);
      await v.writeFile('/b.txt', 'b');
      assert.throws(
        () => takeSnapshot(vfs.port),
        /its next message: vfs-update/,
      );
      vfs.port.close();
      k.close();
      for (const call of [
        () => k.fs('v'),
        () => v.readFile('/a.txt'),
        () => v.stat('/a.txt'),
        () => v.exists('/a.txt'),
        () => v.version('/a.txt'),
        () => v.readdir(''),
      ]) {
        assert.throws(call, { code: 'ERR_VFS_CLOSED' });
      }
    } finally {
      k.close();
      rm(root);
    }
  });
});

describe('epoch: reconcile and survey', () => {
  const SAB = new SharedArrayBuffer(16);
  const treeOf = () =>
    createTree({ segments: new Map([[1, SAB]]), retireIds: { next: () => 1 } });
  const input = {
    size: 1,
    mtimeMs: 0,
    representations: [[0, { segmentId: 1, offset: 0, length: 1 }]],
  };
  const intents = (entries) => new Map(entries);

  it('removals first, each once; then directories down to the key; then files, a directory in the way removed', () => {
    const tree = treeOf();
    tree.commit(
      [
        ['mkdir', '/a'],
        ['write', '/a/x', input],
        ['mkdir', '/b'],
        ['write', '/f', input],
        ['mkdir', '/was'],
      ],
      1,
      0,
    );
    const { ops, owners } = epoch.reconcile(
      tree,
      intents([
        ['/a/x', { type: epoch.GONE }],
        ['/a', { type: epoch.GONE }],
        ['/none', { type: epoch.GONE }],
        ['/f/g/h', { type: epoch.DIR }],
        ['/n/m', { type: epoch.DIR }],
        ['/b', { type: epoch.DIR }],
        ['/was', { type: epoch.FILE, input }],
        ['/n/m/k', { type: epoch.FILE, input }],
      ]),
    );
    assert.deepEqual(
      ops.map((op) => op.slice(0, 2)),
      [
        ['remove', '/a'],
        ['unlink', '/f'],
        ['mkdir', '/f'],
        ['mkdir', '/f/g'],
        ['mkdir', '/f/g/h'],
        ['mkdir', '/n'],
        ['mkdir', '/n/m'],
        ['remove', '/was'],
        ['write', '/was'],
        ['write', '/n/m/k'],
      ],
    );
    assert.deepEqual(owners, [
      '/a',
      '/f/g/h',
      '/f/g/h',
      '/f/g/h',
      '/f/g/h',
      '/n/m',
      '/n/m',
      '/was',
      '/was',
      '/n/m/k',
    ]);
    tree.commit(ops, 2, 0);
    assert.equal(tree.get('/a'), null);
    assert.ok(tree.isDirectory(tree.get('/f/g/h')));
    assert.ok(!tree.isDirectory(tree.get('/was')));
  });

  it('the root gone takes every child of it', () => {
    const tree = treeOf();
    tree.commit(
      [
        ['mkdir', '/a'],
        ['write', '/b', input],
      ],
      1,
      0,
    );
    const { ops } = epoch.reconcile(
      tree,
      intents([['', { type: epoch.GONE }]]),
    );
    assert.deepEqual(ops, [
      ['remove', '/a'],
      ['remove', '/b'],
    ]);
  });

  it('survey names the files a commit changes, and the keys of the nodes it kills', () => {
    const tree = treeOf();
    tree.commit(
      [
        ['mkdir', '/d'],
        ['write', '/d/x', input],
        ['write', '/d/y', input],
        ['write', '/f', input],
        ['write', '/g', input],
      ],
      1,
      0,
    );
    const id = (key) => tree.nodeId(tree.get(key));
    const changes = epoch.survey(tree, [
      ['write', '/f', input],
      ['write', '/new', input],
      ['unlink', '/g'],
      ['move', '/f', '/h'],
      ['write', '/h', input],
      ['remove', '/d'],
    ]);
    assert.deepEqual(changes.created, ['/new']);
    assert.deepEqual(changes.replaced, ['/f', '/h']);
    assert.deepEqual(changes.removed, ['/g', '/d/x', '/d/y']);
    assert.deepEqual(changes.moved, [['/f', '/h']]);
    assert.deepEqual(
      [...changes.keys].sort(),
      [
        [id('/g'), '/g'],
        [id('/d/x'), '/d/x'],
        [id('/d/y'), '/d/y'],
      ].sort(),
    );
  });
});

describe('retirement: ids', () => {
  const record = (books, id) =>
    books.retire(id, 'p', '/k', 0, { length: 1 }, 0);

  it('from 1, past the ids still on the books', () => {
    const books = new Retirement();
    assert.equal(books.next(), 1);
    assert.equal(books.next(), 2);
    books.commit(1, [record(books, 3)]);
    assert.equal(books.next(), 4, '3 is on the books');
    assert.equal(books.nextRetireId, 4);
  });

  it('around at 2³⁰ − 1, to 1, past what is still held', () => {
    const max = 2 ** 30 - 1;
    const books = new Retirement(max - 2);
    books.commit(1, [record(books, 1), record(books, max)]);
    assert.equal(books.next(), max - 1);
    assert.equal(books.next(), 2, 'past the held max, around, past 1');
    const held = books.retired.get(1);
    books.take(held);
    assert.equal(books.next(), 3);
  });
});
