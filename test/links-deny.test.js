'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const disk = require('../lib/disk.js');
const fsPatch = require('../lib/adapters/fs-patch.js');
const { VfsConfig } = require('../lib/config.js');
const { VfsKernel } = require('../lib/kernel.js');
const {
  tmpDir,
  writeTree,
  rm,
  kernel,
  worker,
  nextMessage,
} = require('./helpers.js');
const { refused } = require('./fs-calls.js');

// Strict routing with `links: 'deny'` — the index of known links — beside
// 'verify', the proof of each call's real path: what each knows, when, and
// what it costs. The links are junctions on Windows, which take no
// privilege, and symbolic links elsewhere. The refusals themselves, in
// every family of calls: links.test.js.

// The disk as it is, behind the patch: captured before any install.
const { symlinkSync: linkDisk, unlinkSync: unlinkDisk, rmdirSync } = fs;
const linkDir = (target, at) => linkDisk(target, at, 'junction');
const unlinkDir = (at) => {
  try {
    unlinkDisk(at);
  } catch {
    rmdirSync(at);
  }
};

const PREPARERS = { up: (raw) => raw.toString().toUpperCase() };

const PLACES = {
  ro: { fs: { ext: ['txt'], fallback: 'deny', prepare: { up: ['txt'] } } },
  terr: { fs: { ext: ['txt'], fallback: 'disk', prepare: { up: ['txt'] } } },
  d: { provider: 'disk', fs: { writable: true } },
  dro: { provider: 'disk', fs: true },
};

const TREE = {
  'ro/a.txt': 'raw',
  'ro/h.bin': 'hidden',
  'terr/t.txt': 'raw',
  'terr/m.bin': 'media',
  'd/f.bin': 'f',
  'd/sub/s.bin': 's',
  'dro/r.bin': 'r',
};

// appRoot `app` and a directory `outside` beside it, under strict with
// `links` and `defaults` as given; `setup` makes links before the kernel
// is made. A watcher's epochs are emitted by hand (`watchTimeout` keeps
// its own from firing).
const opened = async (links, { defaults = {}, setup } = {}) => {
  const base = tmpDir('links-deny');
  const root = writeTree(path.join(base, 'app'), TREE);
  const outside = writeTree(path.join(base, 'outside'), { 'o.bin': 'o' });
  const at = (...p) => path.join(root, ...p);
  const made = [];
  const link = (target, p) => {
    linkDir(target, p);
    made.push(p);
  };
  setup?.({ at, outside, link });
  const options = { preparers: PREPARERS };
  const all = { strict: true, links, watchTimeout: 60000, ...defaults };
  const k = await kernel(root, PLACES, all, options);
  const close = () => {
    fsPatch.uninstall();
    k.close();
    for (const p of made) {
      try {
        unlinkDir(p);
      } catch {
        // gone already
      }
    }
    rm(base);
  };
  return { k, root, outside, at, link, close };
};

describe('strict, links: deny: the index of known links', () => {
  // `known` counts what the index holds: a link moved away stays known
  // under its old name — a path through it finds nothing there and passes
  // — until a directory or a file takes that name.
  it("diagnostics show each place's links and how many are known", async () => {
    const { k, at, outside, close } = await opened('deny');
    try {
      assert.deepEqual(k.diagnostics().strict, {
        links: { ro: 'deny', terr: 'deny', d: 'deny', dro: 'deny' },
        known: 0,
      });
      fsPatch.install(k);
      const j = at('d', 'j');
      fs.symlinkSync(outside, j, 'junction');
      assert.equal(k.diagnostics().strict.known, 1);
      fs.renameSync(j, at('d', 'k'));
      assert.equal(k.diagnostics().strict.known, 2);
      assert.throws(
        () => fs.readFileSync(path.join(j, 'o.bin')),
        { code: 'ENOENT' },
        'j is gone: nothing there',
      );
      assert.equal(k.diagnostics().strict.known, 2);
      fs.mkdirSync(j);
      fs.writeFileSync(path.join(j, 'n.bin'), 'n');
      assert.equal(k.diagnostics().strict.known, 1, 'a directory took j');
      assert.equal(fs.readFileSync(path.join(j, 'n.bin'), 'utf8'), 'n');
      fs.unlinkSync(at('d', 'k'));
    } finally {
      close();
    }
    const mixed = await kernel(
      writeTree(tmpDir('links-mixed'), TREE),
      {
        ...PLACES,
        v: { provider: 'map', origin: 'virtual', fs: { writable: true } },
      },
      { strict: true, links: 'verify' },
      { preparers: PREPARERS },
    );
    try {
      assert.deepEqual(mixed.diagnostics().strict, {
        links: { ro: 'verify', terr: 'verify', d: 'verify', dro: 'verify' },
        known: 0,
      });
    } finally {
      mixed.close();
    }
    const open = await kernel(
      writeTree(tmpDir('links-open'), TREE),
      PLACES,
      {},
      {
        preparers: PREPARERS,
      },
    );
    try {
      assert.equal(open.diagnostics().strict, null);
    } finally {
      open.close();
    }
  });

  it('initialize() finds the links below each place, entering none', async () => {
    const base = tmpDir('links-init');
    const root = writeTree(path.join(base, 'app'), TREE);
    const at = (...p) => path.join(root, ...p);
    linkDir(at('ro'), at('d', 'sub', 'j1'));
    linkDir(at('d'), at('terr', 'j2')); // a walk that entered it would find j1 twice
    const k = await kernel(
      root,
      PLACES,
      { strict: true },
      { preparers: PREPARERS },
    );
    fsPatch.install(k);
    try {
      assert.equal(k.diagnostics().strict.known, 2);
      const through = at('d', 'sub', 'j1', 'h.bin');
      assert.throws(
        () => fs.readFileSync(through),
        refused('EACCES', 'open', through),
      );
      assert.equal(fs.readFileSync(at('d', 'sub', 's.bin'), 'utf8'), 's');
    } finally {
      fsPatch.uninstall();
      k.close();
      unlinkDir(at('d', 'sub', 'j1'));
      unlinkDir(at('terr', 'j2'));
      rm(base);
    }
  });

  // A link another process makes is known once the watcher reports it:
  // until then a native call through it reaches node:fs. That window is
  // outside what 'deny' guarantees (README, Strict routing); 'verify' has
  // none (below). A path an event names gone keeps what was known there —
  // the patch may be making it again — and a directory there drops it.
  it('the watcher adds a link made outside the patch, and drops one a directory replaced', async () => {
    const { k, at, outside, link, close } = await opened('deny', {
      defaults: { watch: true },
    });
    fsPatch.install(k);
    try {
      const epoch = async (events) => {
        k.watcher.emit('epoch', new Map(events));
        await k.watchQueue.idle;
      };
      const j = at('terr', 'j');
      const through = path.join(j, 'o.bin');
      link(outside, j);
      // Not guaranteed: the watcher has not reported it yet.
      assert.equal(fs.readFileSync(through, 'utf8'), 'o');
      await epoch([[j, 'scan']]);
      assert.equal(k.diagnostics().strict.known, 1);
      assert.throws(
        () => fs.readFileSync(through),
        refused('EACCES', 'open', through),
      );
      assert.equal(k.fs('terr').readFile('/j/o.bin'), null);
      // A directory moved in brings its links along.
      const brought = writeTree(path.join(outside, 'box'), { 'x.bin': 'x' });
      link(at('ro'), path.join(brought, 'jb'));
      disk.renameSync(brought, at('terr', 'box'));
      await epoch([[at('terr', 'box'), 'scan']]);
      assert.equal(k.diagnostics().strict.known, 2);
      const hidden = at('terr', 'box', 'jb', 'h.bin');
      assert.throws(
        () => fs.readFileSync(hidden),
        refused('EACCES', 'open', hidden),
      );
      unlinkDir(j);
      await epoch([[j, 'delete']]);
      assert.equal(k.diagnostics().strict.known, 2, 'j gone: kept');
      disk.mkdirSync(j);
      await epoch([[j, 'scan']]);
      assert.equal(k.diagnostics().strict.known, 1, 'a directory took j');
      unlinkDir(at('terr', 'box', 'jb'));
      disk.mkdirSync(at('terr', 'box', 'jb'));
      await epoch([[at('terr', 'box'), 'scan']]);
      assert.equal(k.diagnostics().strict.known, 1, 'a rescan adds, drops not');
      await epoch([[at('terr', 'box', 'jb'), 'scan']]);
      assert.equal(k.diagnostics().strict.known, 0);
      // The place's own directory is never a known link.
      await epoch([[at('terr'), 'scan']]);
      assert.equal(k.diagnostics().strict.known, 0);
    } finally {
      close();
    }
  });

  it('an ordinary path never asks realpath.native', async () => {
    const real = disk.realpathSync.native;
    for (const links of ['deny', 'verify']) {
      let calls = 0;
      disk.realpathSync.native = (...args) => {
        calls++;
        return real(...args);
      };
      let ctx;
      try {
        ctx = await opened(links);
        const { k, at } = ctx;
        fsPatch.install(k);
        calls = 0;
        assert.equal(fs.readFileSync(at('d', 'f.bin'), 'utf8'), 'f');
        assert.equal(fs.statSync(at('d', 'sub', 's.bin')).size, 1);
        assert.ok(fs.existsSync(at('dro', 'r.bin')));
        assert.deepEqual(fs.readdirSync(at('d')).sort(), ['f.bin', 'sub']);
        fs.writeFileSync(at('d', 'n.bin'), 'n');
        fs.unlinkSync(at('d', 'n.bin'));
        assert.equal(fs.readFileSync(at('terr', 'm.bin'), 'utf8'), 'media');
        assert.equal(await fs.promises.readFile(at('d', 'f.bin'), 'utf8'), 'f');
        assert.equal(k.fs('terr').readFile('/m.bin', 'utf8'), 'media');
        if (links === 'deny') assert.equal(calls, 0, links);
        else assert.ok(calls > 0, `${links}: the spy is asked`);
      } finally {
        disk.realpathSync.native = real;
        ctx?.close();
      }
    }
  });

  // Read-only places, prepared sources and fs.fallback route as they did:
  // `links` decides only where a native call on a place's disk may go.
  for (const links of ['deny', 'verify']) {
    it(`links: ${links}: read-only, prepared and fallback routing hold`, async () => {
      const { k, at, close } = await opened(links);
      fsPatch.install(k);
      try {
        assert.equal(fs.readFileSync(at('ro', 'a.txt'), 'utf8'), 'RAW');
        assert.equal(fs.readFileSync(at('terr', 't.txt'), 'utf8'), 'RAW');
        assert.equal(fs.readFileSync(at('terr', 'm.bin'), 'utf8'), 'media');
        const hidden = at('ro', 'h.bin');
        assert.throws(
          () => fs.readFileSync(hidden),
          refused('EACCES', 'open', hidden),
        );
        for (const p of [at('ro', 'n.txt'), at('dro', 'n.bin')]) {
          assert.throws(() => fs.writeFileSync(p, 'n'), { code: 'EROFS' }, p);
        }
        fs.writeFileSync(at('d', 'w.bin'), 'w');
        assert.equal(fs.readFileSync(at('d', 'w.bin'), 'utf8'), 'w');
        assert.equal(k.fs('ro').readFile('/a.txt', 'utf8'), 'RAW');
        assert.equal(k.fs('ro').readFile('/h.bin'), null);
      } finally {
        close();
      }
    });
  }
});

// 'verify' asks the disk where each call lands: a link another process
// makes is refused at once, with no event; for a path yet to be made, its
// nearest existing directory is what is proven.
describe('strict, links: verify: a link made outside the patch', () => {
  it('is refused before any event, and so is a new file through it', async () => {
    const { k, at, link, close } = await opened('verify');
    fsPatch.install(k);
    try {
      const j = at('d', 'j');
      link(at('ro'), j);
      const through = path.join(j, 'h.bin');
      assert.throws(
        () => fs.readFileSync(through),
        refused('EACCES', 'open', through),
      );
      const created = path.join(j, 'new.bin');
      assert.throws(
        () => fs.writeFileSync(created, 'x'),
        refused('EACCES', 'open', created),
      );
      const deep = path.join(j, 'x', 'y', 'new.bin');
      assert.throws(
        () => fs.mkdirSync(path.dirname(deep), { recursive: true }),
        refused('EACCES', 'mkdir', path.dirname(deep)),
      );
      assert.deepEqual(fs.readdirSync(at('d')).sort(), ['f.bin', 'j', 'sub']);
      assert.deepEqual(disk.readdirSync(at('ro')).sort(), ['a.txt', 'h.bin']);
    } finally {
      close();
    }
  });
});

// Every thread keeps an index of its own. A worker's comes with its
// snapshot; a link one thread makes through the patch reaches the others
// as a message — and until it has, they ask the disk for the names below
// the place's directory, so no thread goes through it meanwhile. Worker
// kernels here are attached in this thread (helpers.worker).
describe('strict, links: deny: every thread knows the links', () => {
  // The patch calls linkMade / linkMoved before the native call; here the
  // kernels are called as it calls them, the links made natively after.
  // `stray` is a link no thread made, which only the disk knows: refused
  // while a thread asks the disk, passed once it is told (outside the
  // guarantee, as a link another process makes).
  it('from the snapshot, and from the thread that made one, at once', async () => {
    const { k, at, outside, link, close } = await opened('deny', {
      setup: ({ at: to, link: make }) => make(to('ro'), to('d', 'j0')),
    });
    const w1 = worker(k);
    const w2 = worker(k);
    const through = (p) => path.join(p, 'x.bin');
    const denied = (kernel, p) => kernel.routeRead(through(p)).kind === 'deny';
    const stray = at('d', 'stray');
    try {
      assert.equal(denied(w1.kernel, at('d', 'j0')), true, 'snapshot');
      assert.equal(w1.kernel.routeRead(at('d', 'f.bin')).kind, 'passthrough');
      link(outside, stray);
      assert.equal(denied(w1.kernel, stray), false, 'no thread made it');

      // Main makes one: the workers refuse it before the message comes.
      let told = Promise.all([nextMessage(w1.port), nextMessage(w2.port)]);
      k.linkMade(at('d', 'jm'));
      link(outside, at('d', 'jm'));
      assert.equal(denied(w1.kernel, at('d', 'jm')), true, 'worker, at once');
      assert.equal(denied(w1.kernel, stray), true, 'worker, asks the disk');
      assert.equal(w1.kernel.routeRead(at('d', 'f.bin')).kind, 'passthrough');
      await told;
      assert.equal(denied(w1.kernel, at('d', 'jm')), true, 'worker, told');
      assert.equal(denied(w2.kernel, at('d', 'jm')), true, 'other, told');
      assert.equal(denied(w1.kernel, stray), false, 'worker, told: index');

      // A worker makes one: main at once, the other worker once main
      // passes it on.
      told = Promise.all([nextMessage(w1.main), nextMessage(w2.port)]);
      w1.kernel.linkMade(at('d', 'jw'));
      link(outside, at('d', 'jw'));
      assert.equal(denied(k, at('d', 'jw')), true, 'main, at once');
      assert.equal(denied(w2.kernel, at('d', 'jw')), true, 'other, at once');
      await told;
      assert.equal(denied(k, at('d', 'jw')), true, 'main, told');
      assert.equal(denied(w2.kernel, at('d', 'jw')), true, 'other, told');
      assert.equal(denied(k, stray), false, 'main, told: index');
      assert.equal(denied(w2.kernel, stray), false, 'other, told: index');
      assert.equal(denied(w1.kernel, stray), false, 'maker: no echo');
      assert.equal(k.diagnostics().strict.known, 3);

      // A directory renamed in a worker takes its links along everywhere.
      fs.mkdirSync(at('d', 'box'));
      told = Promise.all([nextMessage(w2.main), nextMessage(w1.port)]);
      w2.kernel.linkMade(at('d', 'box', 'jb'));
      link(outside, at('d', 'box', 'jb'));
      await told;
      told = Promise.all([nextMessage(w1.main), nextMessage(w2.port)]);
      w1.kernel.linkMoved(at('d', 'box'), at('d', 'moved'));
      disk.renameSync(at('d', 'box'), at('d', 'moved'));
      assert.equal(denied(k, at('d', 'moved', 'jb')), true, 'moved, at once');
      await told;
      assert.equal(denied(k, at('d', 'moved', 'jb')), true, 'moved, told');
      assert.equal(denied(w2.kernel, at('d', 'moved', 'jb')), true);

      // A new worker takes what main knows by then.
      const w3 = worker(k);
      assert.equal(denied(w3.kernel, at('d', 'jw')), true, 'late snapshot');
      assert.equal(denied(w3.kernel, at('d', 'moved', 'jb')), true);
      assert.equal(denied(w3.kernel, stray), false, 'late snapshot: index');
      w3.kernel.close();
    } finally {
      w1.kernel.close();
      w2.kernel.close();
      unlinkDir(at('d', 'moved', 'jb'));
      close();
    }
  });
});

// What the review of 'deny' found: a link the patch is making, checked
// before the call makes it; spellings node:fs resolves before the OS opens
// them; a place's own directory; rmdir of a link; a name a file or a
// failed link takes; a closed or unlinked worker.
describe('strict, links: deny: edges', () => {
  // The patch adds a link before its call makes it: a check in between
  // finds nothing there and passes, and the link stays known.
  it('a link made or moved by an asynchronous call is known once it is there', async () => {
    const { k, at, outside, close } = await opened('deny');
    fsPatch.install(k);
    const quietly = (p) => {
      try {
        fs.readFileSync(p);
      } catch {
        // nothing there yet, or refused already
      }
    };
    try {
      const j = at('d', 'j');
      const through = path.join(j, 'o.bin');
      const making = fs.promises.symlink(outside, j, 'junction');
      quietly(through);
      await making;
      assert.throws(
        () => fs.readFileSync(through),
        refused('EACCES', 'open', through),
      );
      const moved = at('d', 'j2');
      const after = path.join(moved, 'o.bin');
      const moving = fs.promises.rename(j, moved);
      quietly(after);
      await moving;
      assert.throws(
        () => fs.readFileSync(after),
        refused('EACCES', 'open', after),
      );
      fs.unlinkSync(moved);
    } finally {
      close();
    }
  });

  it(
    'Windows: a drive-relative or root-relative spelling of a path through a link',
    { skip: process.platform !== 'win32' },
    async () => {
      const { k, root, close } = await opened('deny', {
        setup: ({ at, link }) => link(at('ro'), at('d', 'jro')),
      });
      fsPatch.install(k);
      const cwd = process.cwd();
      try {
        process.chdir(root);
        const spellings = [
          `${root.slice(0, 2)}d\\jro\\h.bin`,
          `${root.slice(2)}\\d\\jro\\h.bin`,
          'd\\jro\\h.bin',
        ];
        for (const p of spellings) {
          assert.throws(
            () => fs.readFileSync(p),
            refused('EACCES', 'open', p),
            p,
          );
        }
      } finally {
        process.chdir(cwd);
        close();
      }
    },
  );

  // A place's directory may be a link out of appRoot (a media store): it is
  // the place's own disk, never a known link — not when the watcher names
  // it, nor when the patch makes it.
  it("a place's own directory is never a known link", async () => {
    const base = tmpDir('links-root');
    const root = writeTree(path.join(base, 'app'), { 'ro/h.bin': 'hidden' });
    const outside = writeTree(path.join(base, 'outside'), { 'o.bin': 'o' });
    const store = writeTree(path.join(base, 'store'), { 's.bin': 's' });
    const at = (...p) => path.join(root, ...p);
    linkDir(outside, at('media'));
    const places = {
      ro: PLACES.ro,
      media: { fs: { ext: ['txt'], fallback: 'disk' } },
      later: { provider: 'disk', fs: { writable: true } },
    };
    const defaults = { strict: true, watch: true, watchTimeout: 60000 };
    const k = await kernel(root, places, defaults, { preparers: PREPARERS });
    fsPatch.install(k);
    try {
      assert.equal(fs.readFileSync(at('media', 'o.bin'), 'utf8'), 'o');
      k.watcher.emit('epoch', new Map([[at('media'), 'scan']]));
      await k.watchQueue.idle;
      assert.equal(k.diagnostics().strict.known, 0);
      assert.equal(fs.readFileSync(at('media', 'o.bin'), 'utf8'), 'o');
      fs.symlinkSync(store, at('later'), 'junction');
      assert.equal(k.diagnostics().strict.known, 0);
      assert.equal(fs.readFileSync(at('later', 's.bin'), 'utf8'), 's');
    } finally {
      fsPatch.uninstall();
      k.close();
      unlinkDir(at('media'));
      if (disk.existsSync(at('later'))) unlinkDir(at('later'));
      rm(base);
    }
  });

  // A release renamed into place — a directory onto a place's own path —
  // brings the links it holds into the index; the directory is no link.
  it("a directory renamed onto a place's own directory brings its links", async () => {
    const base = tmpDir('links-deploy');
    const root = writeTree(path.join(base, 'app'), { 'ro/h.bin': 'hidden' });
    const build = writeTree(path.join(base, 'build'), { 'x.bin': 'x' });
    const at = (...p) => path.join(root, ...p);
    linkDir(at('ro'), path.join(build, 'jro'));
    const places = {
      ro: PLACES.ro,
      site: { provider: 'disk', fs: { writable: true } },
    };
    const k = await kernel(
      root,
      places,
      { strict: true },
      {
        preparers: PREPARERS,
      },
    );
    fsPatch.install(k);
    try {
      fs.renameSync(build, at('site'));
      assert.equal(fs.readFileSync(at('site', 'x.bin'), 'utf8'), 'x');
      const hidden = at('site', 'jro', 'h.bin');
      assert.throws(
        () => fs.readFileSync(hidden),
        refused('EACCES', 'open', hidden),
      );
      assert.equal(k.diagnostics().strict.known, 1);
    } finally {
      fsPatch.uninstall();
      k.close();
      for (const j of [at('site', 'jro'), path.join(build, 'jro')]) {
        if (disk.existsSync(j)) unlinkDir(j);
      }
      rm(base);
    }
  });

  // rmdir does not follow its last name: a link there is removed on
  // Windows, ENOTDIR on POSIX — never EACCES.
  it('rmdir of the link itself is not refused', async () => {
    const { k, at, outside, close } = await opened('deny');
    fsPatch.install(k);
    try {
      const j = at('d', 'j');
      fs.symlinkSync(outside, j, 'junction');
      try {
        fs.rmdirSync(j);
      } catch (err) {
        assert.equal(err.code, 'ENOTDIR');
        fs.unlinkSync(j);
      }
      assert.equal(disk.existsSync(j), false);
      assert.deepEqual(disk.readdirSync(outside), ['o.bin']);
    } finally {
      close();
    }
  });

  // A file renamed over a known link's name, and a directory made where a
  // link failed to be made: the name holds no link, and nothing is refused.
  it('a file or a directory where a link was known is served', async () => {
    const { k, at, outside, close } = await opened('deny');
    fsPatch.install(k);
    try {
      const j = at('d', 'j');
      fs.symlinkSync(outside, j, 'junction');
      fs.writeFileSync(at('d', 'n.bin'), 'n');
      fs.unlinkSync(j);
      fs.renameSync(at('d', 'n.bin'), j);
      assert.equal(fs.readFileSync(j, 'utf8'), 'n');
      const failed = at('d', 'none', 'j');
      assert.throws(() => fs.symlinkSync(outside, failed, 'junction'), {
        code: 'ENOENT',
      });
      fs.mkdirSync(failed, { recursive: true });
      fs.writeFileSync(path.join(failed, 'f.bin'), 'f');
      assert.equal(fs.readFileSync(path.join(failed, 'f.bin'), 'utf8'), 'f');
    } finally {
      close();
    }
  });

  // A closed worker, or one not linked to the main kernel, counts no link:
  // the other threads stay settled — they answer from their index, and a
  // link only the disk knows is not asked of it.
  it('a closed or unlinked worker leaves the other threads settled', async () => {
    const { k, at, outside, link, close } = await opened('deny');
    const stray = at('d', 'stray');
    link(outside, stray);
    const through = path.join(stray, 'x.bin');
    const denied = (kernel) => kernel.routeRead(through).kind === 'deny';
    const w = worker(k);
    const { vfs } = k.link();
    const config = new VfsConfig(vfs.config);
    const alone = VfsKernel.fromSnapshot(vfs.snapshot, config, {
      appRoot: vfs.appRoot,
    });
    try {
      assert.equal(denied(k), false);
      w.kernel.close();
      w.kernel.linkMade(at('d', 'jw'));
      alone.linkMade(at('d', 'ja'));
      assert.equal(denied(k), false, 'main: settled');
      assert.equal(denied(alone), false, 'unlinked: settled');
      k.linkMade(at('d', 'jm'));
      assert.equal(denied(alone), false, 'unlinked: hears of nothing');
    } finally {
      alone.close();
      vfs.port.close();
      close();
    }
  });
});
