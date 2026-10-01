'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { VfsKernel } = require('../lib/kernel.js');
const { bytecodeKey, compressedKey } = require('../lib/companion.js');
const {
  tmpDir,
  writeTree,
  rm,
  kernel,
  tap,
  worker,
  nextEvent,
  nextMessage,
} = require('./helpers.js');

// The version of a publication: one number per commit that publishes
// something, counted by the main kernel — stamped into every entry the
// commit publishes, carried by its update and by every snapshot after it,
// the same in every thread. A commit that changes nothing, and a
// relocation, take none. Map places and the disk territory publish no
// version.

const seaModule = (assets) => ({
  isSea: () => true,
  getAssetKeys: () => Object.keys(assets),
  getAsset: (key) => {
    const buf = Buffer.from(assets[key]);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  },
});

// Every entry the index holds, companions included: [place, key, entry].
const indexed = (k) => {
  const all = [];
  for (const [name, { entries }] of k.cache.indexes) {
    for (const [key, entry] of entries) all.push([name, key, entry]);
  }
  return all;
};

const VIRTUAL = { v: { origin: 'virtual', fs: { writable: true } } };

describe('version: init', () => {
  it('init is one publication: every entry of every shared place, companions included, is version 1', async () => {
    const root = writeTree(tmpDir('vfs-version'), {
      'site/a.js': 'module.exports = 1;',
      'site/b.css': 'b{}',
      'm/c.txt': 'c',
    });
    const k = await kernel(
      root,
      {
        site: {
          fs: { compress: { encodings: ['gzip'] } },
          require: { compile: ['js'] },
        },
        pub: { provider: 'sea', fs: true },
        m: { provider: 'map', fs: true },
        ...VIRTUAL,
      },
      {},
      { seaModule: seaModule({ 'pub/p.txt': 'p' }) },
    );
    try {
      assert.equal(k.version, 1);
      const entries = indexed(k);
      assert.deepEqual(
        entries.map(([name, key]) => `${name}:${key}`).sort(),
        [
          'pub:/p.txt',
          'site:/a.js',
          `site:${bytecodeKey('/a.js')}`,
          `site:${compressedKey('/a.js', 'gzip')}`,
          'site:/b.css',
          `site:${compressedKey('/b.css', 'gzip')}`,
        ].sort(),
      );
      for (const [name, key, entry] of entries) {
        assert.equal(entry.version, 1, `${name}:${key} in the index`);
        const projected = k.registry.get(name).files.get(key);
        assert.equal(projected.version, 1, `${name}:${key} projected`);
      }
      assert.equal(k.fs('site').version('/a.js'), 1);
      assert.equal(k.fs('pub').version('/p.txt'), 1);
      assert.equal(k.fs('m').version('/c.txt'), null, 'a map place');
      const snapshot = k.snapshot();
      assert.equal(snapshot.version, 1);
      assert.equal(snapshot.instance, k.instance);
      assert.match(k.instance, /^[\w-]{8}$/);
    } finally {
      k.close();
      rm(root);
    }
  });

  it('a kernel whose places start empty is at version 0', async () => {
    const root = tmpDir('vfs-version');
    const k = await kernel(root, VIRTUAL);
    try {
      assert.equal(k.version, 0);
      assert.equal(k.snapshot().version, 0);
      assert.equal(k.fs('v').version('/a.txt'), null, 'a missing key');
    } finally {
      k.close();
      rm(root);
    }
  });
});

describe('version: mutations', () => {
  it('each publication takes the next version, companions and every key of it alike', async () => {
    const root = tmpDir('vfs-version');
    const k = await kernel(root, {
      v: {
        origin: 'virtual',
        fs: { writable: true, compress: { encodings: ['gzip'] } },
        require: { compile: ['js'] },
      },
    });
    try {
      const v = k.fs('v');
      const place = k.registry.get('v');
      const at = (key) => place.files.get(key)?.version ?? null;
      assert.equal(await v.writeFile('/a.js', 'exports.a = 1;'), undefined);
      assert.equal(k.version, 1);
      assert.equal(v.version('/a.js'), 1);
      assert.equal(at(bytecodeKey('/a.js')), 1, 'its bytecode');
      assert.equal(at(compressedKey('/a.js', 'gzip')), 1, 'its gzip');
      await v.writeFile('/b.js', 'exports.b = 1;');
      assert.equal(v.version('/b.js'), 2);
      assert.equal(v.version('/a.js'), 1, 'a key keeps its own');
      // The same bytes again: a publication, as a write to disk is.
      await v.writeFile('/b.js', 'exports.b = 1;');
      assert.equal(v.version('/b.js'), 3);
      await v.unlink('/a.js');
      assert.equal(k.version, 4, 'a removal is a publication');
      assert.equal(v.version('/a.js'), null);
      await v.rename('/b.js', '/c.js');
      assert.equal(k.version, 5, 'a rename is one publication');
      assert.equal(v.version('/c.js'), 5);
      assert.equal(at(bytecodeKey('/c.js')), 5);
      assert.equal(v.version('/b.js'), null);
      await v.writeFile('/d/x.txt', 'x');
      await v.writeFile('/d/y.txt', 'y');
      await v.rename('/d', '/e');
      assert.equal(k.version, 8, 'a subtree move is one publication');
      assert.equal(v.version('/e/x.txt'), 8);
      assert.equal(v.version('/e/y.txt'), 8);
      assert.equal(at(compressedKey('/e/x.txt', 'gzip')), 8);
      await v.rm('/e', { recursive: true });
      assert.equal(k.version, 9, 'a subtree removal is one publication');
      await v.writeFile('/empty.txt', '');
      assert.equal(v.version('/empty.txt'), 10, 'an empty file');
      // A version is not the retireId of anything: each replaced file here
      // retired its source and its companions under ids of their own.
      assert.ok(k.nextRetireId > k.version, `${k.nextRetireId}`);
    } finally {
      k.close();
      rm(root);
    }
  });

  it('what publishes nothing takes no version: no-op mutations, an empty watcher epoch', async () => {
    const root = writeTree(tmpDir('vfs-version'), { 'site/a.txt': 'a' });
    const k = await kernel(
      root,
      { site: { fs: true }, ...VIRTUAL },
      { watch: true, watchTimeout: 60000 },
    );
    try {
      // Epochs by hand only.
      k.watcher.close();
      const v = k.fs('v');
      await v.writeFile('/a.txt', 'a');
      await v.writeFile('/d/b.txt', 'b');
      const version = k.version;
      const updates = k.nextUpdateId;
      await v.rename('/a.txt', '/a.txt');
      await v.rename('/d', '/d');
      await v.mkdir('/n');
      await v.mkdir('/d', { recursive: true });
      await v.rm('/gone', { force: true });
      // A change of a file that is gone and was never published, and a
      // rescan that finds nothing new.
      k.watcher.emit(
        'epoch',
        new Map([
          [path.join(root, 'site', 'gone.txt'), 'change'],
          [path.join(root, 'site'), 'scan'],
        ]),
      );
      assert.equal(k.watchQueue.size, 1, 'the epoch runs');
      await k.watchQueue.idle;
      assert.equal(k.version, version, 'no version taken');
      assert.equal(k.nextUpdateId, updates, 'no update sent');
      assert.equal(v.version('/a.txt'), version - 1);
    } finally {
      k.close();
      rm(root);
    }
  });

  // The scenario of kernel.test.js "worker exit during compaction": the
  // exit frees /a, and the compaction that follows relocates /c into the
  // first segment — an update, but no publication.
  it('a relocation takes no version: a moved entry keeps its own', async () => {
    const KB = 1024;
    const root = tmpDir('vfs-version');
    const k = await kernel(root, VIRTUAL, {
      memory: { limit: '16 kib', segmentSize: '4 kib', maxFileSize: '4 kib' },
      compaction: { threshold: 0.5 },
    });
    try {
      const v = k.fs('v');
      await v.writeFile('/a', Buffer.alloc(2 * KB, 'a'));
      await v.writeFile('/b', Buffer.alloc(2 * KB, 'b'));
      await v.writeFile('/c', Buffer.alloc(200, 'c'));
      assert.equal(k.cache.entry('v', '/c').segmentId, 2);
      const moved = v.version('/c');
      const w = tap(k, { ack: false });
      await v.unlink('/a');
      const version = k.version;
      const updates = k.nextUpdateId;
      const closed = nextEvent(k.links.get(w.id), 'close');
      w.port.close();
      await closed;
      assert.equal(k.cache.entry('v', '/c').segmentId, 1, '/c relocated');
      assert.equal(k.nextUpdateId, updates + 1, 'one update: the relocation');
      assert.equal(k.version, version, 'the kernel keeps its version');
      assert.equal(v.version('/c'), moved, 'the entry keeps its version');
      assert.equal(k.cache.entry('v', '/c').version, moved);
      assert.equal(v.version('/b'), 2);
      // Updates and versions part here: a snapshot, and a worker made from
      // one, carry the version.
      assert.notEqual(k.nextUpdateId, version);
      assert.equal(k.snapshot().version, version, 'the snapshot');
      const later = worker(k);
      try {
        assert.equal(later.kernel.version, version, 'a worker linked now');
        assert.equal(later.kernel.fs('v').version('/c'), moved);
      } finally {
        later.kernel.close();
      }
    } finally {
      k.close();
      rm(root);
    }
  });
});

describe('version: threads', () => {
  it('a worker has the version and instance of the main kernel, update by update', async () => {
    const root = writeTree(tmpDir('vfs-version'), { 'site/a.txt': 'a' });
    const k = await kernel(root, { site: { fs: true }, ...VIRTUAL });
    let w = null;
    let other = null;
    try {
      const v = k.fs('v');
      await v.writeFile('/a.txt', 'a');
      const { vfs } = k.link();
      assert.equal(vfs.snapshot.version, 2);
      assert.equal(vfs.snapshot.instance, k.instance);
      vfs.port.close();
      w = worker(k);
      assert.equal(w.kernel.version, 2, 'from the snapshot');
      assert.equal(w.kernel.instance, k.instance);
      assert.equal(w.kernel.fs('v').version('/a.txt'), 2);
      assert.equal(w.kernel.fs('site').version('/a.txt'), 1);
      const applied = nextMessage(w.port);
      await v.writeFile('/b.txt', 'b');
      await applied;
      assert.equal(w.kernel.version, 3, 'from the update');
      assert.equal(w.kernel.fs('v').version('/b.txt'), 3);
      // A worker's own write: the version its update brings.
      await w.kernel.fs('v').writeFile('/c.txt', 'c');
      assert.equal(w.kernel.version, 4);
      assert.equal(k.version, 4);
      assert.equal(w.kernel.fs('v').version('/c.txt'), 4);
      assert.equal(v.version('/c.txt'), 4);
      other = await kernel(root, { site: { fs: true } });
      assert.notEqual(other.instance, k.instance, 'one per main kernel');
      const empty = VfsKernel.fromSnapshot(null, k.config, { appRoot: root });
      assert.equal(empty.version, 0);
      empty.close();
    } finally {
      w?.kernel.close();
      other?.close();
      k.close();
      rm(root);
    }
  });
});

describe('version: reads', () => {
  it('leases, compressed leases and script bundles carry their file version; map, disk territory and missing keys have none', async () => {
    const root = writeTree(tmpDir('vfs-version'), {
      'site/a.css': 'a{}',
      'site/h.js': 'x = 1;',
      'site/img.png': 'png',
      'm/c.txt': 'c',
    });
    const k = await kernel(root, {
      site: {
        fs: {
          ext: ['css'],
          zeroCopy: true,
          fallback: 'disk',
          compress: { encodings: ['gzip'], ext: ['css'] },
          script: { compile: ['js'] },
        },
      },
      m: { provider: 'map', fs: true },
      mv: { provider: 'map', origin: 'virtual', fs: { writable: true } },
    });
    try {
      const site = k.fs('site');
      assert.equal(site.version('/a.css'), 1);
      const lease = site.readFileView('/a.css');
      assert.equal(lease.version, 1);
      lease.release();
      const gzip = site.readFileCompressedView('/a.css', 'gzip');
      assert.equal(gzip.version, 1);
      gzip.release();
      assert.equal(site.script('/h.js').version, 1);
      assert.equal(site.exists('/img.png'), true);
      assert.equal(site.version('/img.png'), null, 'the disk territory');
      assert.equal(site.version('/nope.css'), null, 'a missing key');
      assert.equal(k.fs('m').version('/c.txt'), null, 'map + disk');
      const mv = k.fs('mv');
      mv.writeFile('/x.txt', 'x');
      assert.equal(mv.version('/x.txt'), null, 'map + virtual');
      assert.equal(k.version, 1, 'a map write takes no version');
    } finally {
      k.close();
      rm(root);
    }
  });

  // An entry kept on disk — larger than maxFileSize, or the source of
  // `retainRaw: false` — is published all the same, unlike the disk
  // territory: it has its version. A key the fs domain does not see has
  // none, as it does not exist for fs.
  it('a published entry kept on disk has its version; a key fs does not see has none', async () => {
    const root = writeTree(tmpDir('vfs-version'), {
      'big/large.bin': 'L'.repeat(2048),
      'big/small.bin': 's',
      'gz/a.css': 'a{}',
      'mix/r.js': 'module.exports = 1;',
      'mix/s.css': 's{}',
    });
    const k = await kernel(root, {
      big: { maxFileSize: '1 kib', fs: true },
      gz: {
        fs: {
          ext: ['css'],
          compress: { encodings: ['gzip'], retainRaw: false },
        },
      },
      mix: { fs: { ext: ['css'] }, require: { ext: ['js'] } },
    });
    try {
      const big = k.fs('big');
      assert.equal(k.cache.entry('big', '/large.bin').kind, 'disk');
      assert.equal(big.version('/large.bin'), 1, 'larger than maxFileSize');
      assert.equal(big.version('/small.bin'), 1);
      assert.equal(k.cache.entry('gz', '/a.css').kind, 'disk');
      assert.equal(k.fs('gz').version('/a.css'), 1, 'retainRaw: false');
      const mix = k.fs('mix');
      assert.equal(k.cache.entry('mix', '/r.js').version, 1, 'for require');
      assert.equal(mix.exists('/r.js'), false);
      assert.equal(mix.version('/r.js'), null, 'not for fs');
      assert.equal(mix.version('/s.css'), 1);
    } finally {
      k.close();
      rm(root);
    }
  });
});
