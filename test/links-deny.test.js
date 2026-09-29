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
const { refused, called } = require('./fs-calls.js');

// Strict routing with `links: 'deny'` — the index of known links — beside
// 'verify', the proof of each call's real path: what each knows, when, and
// what it costs; and, in both, that the patch makes, removes and moves no
// link on a place's disk. The links are junctions on Windows, which take no
// privilege, and symbolic links elsewhere. The refusals of a path through
// a link, in every family of calls: links.test.js.

const MODES = ['deny', 'verify'];

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
const isLink = (p) =>
  disk.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;

const PREPARERS = { up: (raw) => raw.toString().toUpperCase() };

// `site` has no directory until a test makes one.
const PLACES = {
  ro: { fs: { ext: ['txt'], fallback: 'deny', prepare: { up: ['txt'] } } },
  terr: { fs: { ext: ['txt'], fallback: 'disk', prepare: { up: ['txt'] } } },
  d: { provider: 'disk', fs: { writable: true } },
  dro: { provider: 'disk', fs: true },
  site: { provider: 'disk', fs: { writable: true } },
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
  const outside = writeTree(path.join(base, 'outside'), {
    'o.bin': 'o',
    'sub/x.bin': 'x',
  });
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
      if (isLink(p)) unlinkDir(p);
    }
    rm(base);
  };
  return { k, root, outside, at, link, close, all, options };
};

describe('strict, links: deny: the index of known links', () => {
  it("diagnostics show each place's links and how many are known", async () => {
    const { k, close } = await opened('deny', {
      setup: ({ at, outside, link }) => link(outside, at('d', 'j')),
    });
    try {
      assert.deepEqual(k.diagnostics().strict, {
        links: {
          ro: 'deny',
          terr: 'deny',
          d: 'deny',
          dro: 'deny',
          site: 'deny',
        },
        known: 1,
      });
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
        links: {
          ro: 'verify',
          terr: 'verify',
          d: 'verify',
          dro: 'verify',
          site: 'verify',
        },
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
      {
        preparers: PREPARERS,
      },
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
  // none (below). The index only grows: a link removed, or replaced by a
  // directory, stays refused until the kernel restarts. A place's own
  // directory is never a known link.
  it('the watcher adds a link made outside the patch; nothing leaves the index until a restart', async () => {
    const { k, at, outside, link, close, all, options } = await opened('deny', {
      defaults: { watch: true },
    });
    fsPatch.install(k);
    let again = null;
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
      // A directory moved in by another process brings its links along.
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
      // Removed and replaced by a directory: still refused.
      unlinkDir(j);
      disk.mkdirSync(j);
      disk.writeFileSync(path.join(j, 'o.bin'), 'n');
      await epoch([
        [j, 'delete'],
        [j, 'scan'],
      ]);
      assert.equal(k.diagnostics().strict.known, 2);
      assert.throws(
        () => fs.readFileSync(through),
        refused('EACCES', 'open', through),
      );
      await epoch([[at('terr'), 'scan']]);
      assert.equal(k.diagnostics().strict.known, 2, 'no root');
      // A kernel started now knows what is on disk.
      fsPatch.uninstall();
      again = await kernel(path.dirname(at('terr')), PLACES, all, options);
      fsPatch.install(again);
      assert.equal(again.diagnostics().strict.known, 1);
      assert.equal(fs.readFileSync(through, 'utf8'), 'n');
    } finally {
      again?.close();
      if (isLink(at('terr', 'box', 'jb'))) unlinkDir(at('terr', 'box', 'jb'));
      close();
    }
  });

  it('an ordinary path never asks realpath.native', async () => {
    const real = disk.realpathSync.native;
    for (const links of MODES) {
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
        fs.renameSync(at('d', 'n.bin'), at('d', 'm.bin'));
        fs.unlinkSync(at('d', 'm.bin'));
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
  for (const links of MODES) {
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

// Under strict the patch makes, removes and moves no link on a place's
// disk, in either mode: every such call is ENOTSUP before any native call,
// and the disk is as it was. `jk` is a link the index knows ('deny'), `ju`
// one made after initialize() that no watcher reported — its lstat tells.
// Both lead out of appRoot, so 'verify' lets a path through them be proven
// and it is the link rule that refuses.
const SYMLINKS = [
  ['symlinkSync', (t, p) => fs.symlinkSync(t, p, 'junction')],
  ['symlink', (t, p) => called((cb) => fs.symlink(t, p, 'junction', cb))],
  ['promises.symlink', (t, p) => fs.promises.symlink(t, p, 'junction')],
];
const HARD_LINKS = [
  ['linkSync', (a, b) => fs.linkSync(a, b)],
  ['link', (a, b) => called((cb) => fs.link(a, b, cb))],
  ['promises.link', (a, b) => fs.promises.link(a, b)],
];
const CPS = [
  ['cpSync', (a, b) => fs.cpSync(a, b)],
  ['cp', (a, b) => called((cb) => fs.cp(a, b, cb))],
  ['promises.cp', (a, b) => fs.promises.cp(a, b)],
];
const REMOVALS = [
  ['unlinkSync', 'unlink', (p) => fs.unlinkSync(p)],
  ['unlink', 'unlink', (p) => called((cb) => fs.unlink(p, cb))],
  ['promises.unlink', 'unlink', (p) => fs.promises.unlink(p)],
  ['rmdirSync', 'rmdir', (p) => fs.rmdirSync(p)],
  ['promises.rmdir', 'rmdir', (p) => fs.promises.rmdir(p)],
  ['rmSync', 'rm', (p) => fs.rmSync(p)],
  ['rmSync recursive', 'rm', (p) => fs.rmSync(p, { recursive: true })],
  ['promises.rm', 'rm', (p) => fs.promises.rm(p, { recursive: true })],
];
const RENAMES = [
  ['renameSync', (a, b) => fs.renameSync(a, b)],
  ['rename', (a, b) => called((cb) => fs.rename(a, b, cb))],
  ['promises.rename', (a, b) => fs.promises.rename(a, b)],
];

// Every call of `families` with `args`, refused as `code` names it.
const refusesAll = async (families, args, expected) => {
  for (const [call, run] of families) {
    await assert.rejects(async () => run(...args), expected, call);
  }
};

for (const links of MODES) {
  describe(`strict, links: ${links}: the patch changes no link on a place's disk`, () => {
    const setup = ({ at, outside, link }) => {
      link(outside, at('d', 'jk'));
      disk.mkdirSync(at('d', 'tree'));
      link(outside, at('d', 'tree', 'jt'));
    };

    it('no link is made: symlink, link, cp of a link', async () => {
      const { k, at, outside, link, close } = await opened(links, { setup });
      const jo = path.join(outside, 'jo');
      link(path.join(outside, 'sub'), jo);
      fsPatch.install(k);
      try {
        const before = disk.readdirSync(at('d')).sort();
        const made = at('d', 'jn');
        await refusesAll(
          SYMLINKS,
          [outside, made],
          refused('ENOTSUP', 'symlink', outside, made),
        );
        const file = path.join(outside, 'o.bin');
        await refusesAll(
          HARD_LINKS,
          [file, made],
          refused('ENOTSUP', 'link', file, made),
        );
        await refusesAll(CPS, [jo, made], refused('ENOTSUP', 'cp', jo, made));
        // At a place's own path too, the place having no directory yet.
        const site = at('site');
        await refusesAll(
          SYMLINKS.slice(0, 1),
          [outside, site],
          refused('ENOTSUP', 'symlink', outside, site),
        );
        assert.deepEqual(disk.readdirSync(at('d')).sort(), before);
        assert.equal(disk.existsSync(site), false);
        // A copy of a file, and a link off every place, are made.
        fs.cpSync(file, at('d', 'copied.bin'));
        assert.equal(disk.readFileSync(at('d', 'copied.bin'), 'utf8'), 'o');
        const off = path.join(outside, 'jx');
        fs.symlinkSync(outside, off, 'junction');
        assert.ok(isLink(off));
        unlinkDir(off);
      } finally {
        close();
      }
    });

    it('no link is removed or moved: unlink, rmdir, rm, rename, known or not', async () => {
      const { k, at, outside, link, close } = await opened(links, { setup });
      const ju = at('d', 'ju');
      link(outside, ju);
      fsPatch.install(k);
      try {
        for (const p of [at('d', 'jk'), ju]) {
          for (const [call, syscall, run] of REMOVALS) {
            await assert.rejects(
              async () => run(p),
              refused('ENOTSUP', syscall, p),
              `${call} ${p}`,
            );
          }
          const to = at('d', 'moved');
          await refusesAll(
            RENAMES,
            [p, to],
            refused('ENOTSUP', 'rename', p, to),
          );
          const onto = at('d', 'f.bin');
          await refusesAll(
            RENAMES.slice(0, 1),
            [onto, p],
            refused('ENOTSUP', 'rename', onto, p),
          );
          assert.ok(isLink(p), p);
          // The link itself is looked at.
          assert.ok(fs.lstatSync(p).isSymbolicLink());
          assert.match(fs.readlinkSync(p), /outside[\\/]?$/);
        }
        assert.equal(disk.existsSync(at('d', 'moved')), false);
        assert.equal(disk.readFileSync(at('d', 'f.bin'), 'utf8'), 'f');
      } finally {
        close();
      }
    });

    // With 'deny' the index knows the link under `tree`: renaming the
    // directory would move it past the index, removing it would remove
    // it. With 'verify' each call proves its path, and both go on.
    it(`a directory holding a link: ${links === 'deny' ? 'neither renamed nor removed' : 'renamed and removed'}`, async () => {
      const { k, at, close } = await opened(links, { setup });
      fsPatch.install(k);
      try {
        const tree = at('d', 'tree');
        const to = at('d', 'tree2');
        if (links === 'deny') {
          await refusesAll(
            RENAMES,
            [tree, to],
            refused('ENOTSUP', 'rename', tree, to),
          );
          await assert.rejects(
            async () => fs.rmSync(tree, { recursive: true }),
            refused('ENOTSUP', 'rm', tree),
          );
          assert.ok(isLink(at('d', 'tree', 'jt')));
          return;
        }
        fs.renameSync(tree, to);
        assert.equal(
          fs.readFileSync(path.join(to, 'jt', 'o.bin'), 'utf8'),
          'o',
        );
        fs.rmSync(to, { recursive: true });
        assert.equal(disk.existsSync(to), false);
      } finally {
        close();
      }
    });

    // A tree moved into a place from outside appRoot would bring its links:
    // refused when it holds one, into a place's directory or onto a
    // place's own path; one that holds none moves in.
    it('a tree from outside moves in only without links', async () => {
      const { k, at, outside, link, close } = await opened(links, { setup });
      const box = writeTree(path.join(outside, 'box'), { 'b.bin': 'b' });
      link(path.join(outside, 'sub'), path.join(box, 'deep-link'));
      const plain = writeTree(path.join(outside, 'plain'), { 'p.bin': 'p' });
      fsPatch.install(k);
      try {
        for (const to of [at('d', 'box'), at('site')]) {
          await refusesAll(
            RENAMES,
            [box, to],
            refused('ENOTSUP', 'rename', box, to),
          );
        }
        assert.ok(isLink(path.join(box, 'deep-link')));
        fs.renameSync(plain, at('site'));
        assert.equal(fs.readFileSync(at('site', 'p.bin'), 'utf8'), 'p');
      } finally {
        close();
      }
    });
  });
}

describe('without strict: links in a place are made and removed natively', () => {
  it('symlink, rename, unlink', async () => {
    const base = tmpDir('links-free');
    const root = writeTree(path.join(base, 'app'), TREE);
    const outside = writeTree(path.join(base, 'outside'), { 'o.bin': 'o' });
    const at = (...p) => path.join(root, ...p);
    const k = await kernel(root, PLACES, {}, { preparers: PREPARERS });
    fsPatch.install(k);
    try {
      fs.symlinkSync(outside, at('d', 'j'), 'junction');
      assert.equal(fs.readFileSync(at('d', 'j', 'o.bin'), 'utf8'), 'o');
      fs.renameSync(at('d', 'j'), at('d', 'k'));
      fs.unlinkSync(at('d', 'k'));
      assert.deepEqual(disk.readdirSync(at('d')).sort(), ['f.bin', 'sub']);
    } finally {
      fsPatch.uninstall();
      k.close();
      rm(base);
    }
  });
});

// Every thread keeps an index of its own. A worker's comes with its
// snapshot; a link main's watcher finds reaches the workers linked then as
// a `vfs-links` message, one way, with the generation of main's index: a
// message no newer than what a worker holds changes nothing. Worker kernels
// here are attached in this thread (helpers.worker).
describe('strict, links: deny: every thread knows the links', () => {
  it('from the snapshot, and from what the watcher finds', async () => {
    const { k, at, outside, link, close } = await opened('deny', {
      defaults: { watch: true },
      setup: ({ at: to, link: make }) => make(to('ro'), to('terr', 'j0')),
    });
    const w1 = worker(k);
    const through = (p) => path.join(p, 'x.bin');
    const denied = (kernel, p) => kernel.routeRead(through(p)).kind === 'deny';
    const unlinked = () => {
      const { vfs } = k.link();
      const config = new VfsConfig(vfs.config);
      const alone = VfsKernel.fromSnapshot(vfs.snapshot, config, {
        appRoot: vfs.appRoot,
      });
      vfs.port.close();
      return alone;
    };
    let w2 = null;
    let alone = null;
    try {
      assert.equal(denied(w1.kernel, at('terr', 'j0')), true, 'snapshot');
      assert.equal(w1.kernel.routeRead(at('terr', 'm.bin')).kind, 'disk');
      const jw = at('terr', 'jw');
      link(outside, jw);
      assert.equal(denied(w1.kernel, jw), false, 'not reported yet');
      const told = nextMessage(w1.port);
      k.watcher.emit('epoch', new Map([[jw, 'scan']]));
      await k.watchQueue.idle;
      const msg = await told;
      assert.equal(msg.name, 'vfs-links');
      assert.equal(msg.generation, 2);
      assert.equal(denied(k, jw), true, 'main');
      assert.equal(denied(w1.kernel, jw), true, 'worker, told');
      // A worker linked now has it in its snapshot; an old message adds
      // nothing to it, a newer one does.
      w2 = worker(k);
      alone = unlinked();
      assert.equal(denied(w2.kernel, jw), true, 'late snapshot');
      assert.equal(denied(alone, jw), true, 'unlinked worker: snapshot');
      const stray = at('terr', 'stray');
      const stale = nextMessage(w2.port);
      w2.main.postMessage({ name: 'vfs-links', add: [stray], generation: 2 });
      await stale;
      assert.equal(denied(w2.kernel, stray), false, 'stale: ignored');
      const fresh = nextMessage(w2.port);
      w2.main.postMessage({ name: 'vfs-links', add: [stray], generation: 3 });
      await fresh;
      assert.equal(denied(w2.kernel, stray), true, 'newer: added');
    } finally {
      alone?.close();
      w2?.kernel.close();
      w1.kernel.close();
      close();
    }
  });
});

// Edges: spellings node:fs resolves before the OS opens them; a place's
// own directory.
describe('strict, links: deny: edges', () => {
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
  // the place's own disk, never a known link, whatever the watcher says.
  it("a place's own directory is never a known link", async () => {
    const base = tmpDir('links-root');
    const root = writeTree(path.join(base, 'app'), { 'ro/h.bin': 'hidden' });
    const outside = writeTree(path.join(base, 'outside'), { 'o.bin': 'o' });
    const at = (...p) => path.join(root, ...p);
    linkDir(outside, at('media'));
    const places = {
      ro: PLACES.ro,
      media: { fs: { ext: ['txt'], fallback: 'disk' } },
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
    } finally {
      fsPatch.uninstall();
      k.close();
      unlinkDir(at('media'));
      rm(base);
    }
  });
});
