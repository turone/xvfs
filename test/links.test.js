'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fsPatch = require('../lib/adapters/fs-patch.js');
const moduleHook = require('../lib/adapters/module-hook.js');
const { tmpDir, writeTree, rm, kernel } = require('./helpers.js');
const {
  refused,
  countNative,
  called,
  refusesEach,
  FILE_READS,
  DIR_READS,
  FILE_MUTATIONS,
  DIR_MUTATIONS,
  PAIRS,
} = require('./fs-calls.js');

const WIN = process.platform === 'win32';

// Under strict a native call on a place's disk — fs.fallback: 'disk', a
// disk or node-default place — goes only where the disk says its path
// really lies: in the place's directory, or off appRoot's line. A link out
// of the place into another place, appRoot or a directory above it is
// refused before any native I/O; one that stays in the place or leaves
// appRoot's line is followed. The links are junctions on Windows, which
// take no privilege, and symbolic links elsewhere. The rule itself, with a
// table for realpath: aliases.test.js.

// The disk as it is, behind the patch: captured before any install.
const {
  existsSync: onDisk,
  readFileSync: readDisk,
  readdirSync: listDisk,
  symlinkSync: linkDisk,
  unlinkSync: unlinkDisk,
  rmdirSync: rmdirDisk,
} = fs;

const linkDir = (target, at) => linkDisk(target, at, 'junction');
const unlinkDir = (at) => {
  try {
    unlinkDisk(at);
  } catch {
    rmdirDisk(at);
  }
};

const PREPARERS = {
  up: (raw) => raw.toString().toUpperCase(),
  mod: (raw) => raw.toString().replace("'raw'", "'prepared'"),
};

const PLACES = {
  ro: { fs: { ext: ['txt'], fallback: 'deny', prepare: { up: ['txt'] } } },
  terr: { fs: { ext: ['txt'], fallback: 'disk', prepare: { up: ['txt'] } } },
  d: { provider: 'disk', fs: { writable: true } },
  dro: { provider: 'disk', fs: true },
  nd: { provider: 'node-default', fs: true, require: { compile: false } },
  lib: { require: { prepare: 'mod' }, import: { ext: ['mjs'] } },
};

const TREE = {
  'ro/a.txt': 'raw',
  'ro/h.bin': 'hidden',
  'terr/t.txt': 'raw',
  'terr/m.bin': 'media',
  'terr/sub/s.bin': 's',
  'd/f.bin': 'f',
  'd/sub/s.bin': 's',
  'dro/r.bin': 'r',
  'nd/own.js': "module.exports = 'own';",
  'lib/m.js': "globalThis.__smfsLinked = true; module.exports = 'raw';",
  'lib/e.mjs': "export default 'raw';",
};

// appRoot `app` and a directory `outside` in a directory of their own,
// with links: out of a place into another place (`jro`, `jdro`, `jlib`)
// and, with `up`, above appRoot (`jup`, that directory — which a walk that
// entered links would never leave), within the place (`jin`), off
// appRoot's line (`jout`). Returns { root, outside, at, remove }.
const linkedTree = (prefix, up = true) => {
  const base = tmpDir(prefix);
  const root = writeTree(path.join(base, 'app'), TREE);
  const outside = writeTree(path.join(base, 'outside'), { 'o.bin': 'o' });
  const at = (...p) => path.join(root, ...p);
  const links = [
    [at('ro'), at('terr', 'jro')],
    [outside, at('terr', 'jout')],
    [at('terr', 'sub'), at('terr', 'jin')],
    [at('ro'), at('d', 'jro')],
    [at('dro'), at('d', 'jdro')],
    [outside, at('d', 'jout')],
    [at('d', 'sub'), at('d', 'jin')],
    [at('lib'), at('nd', 'jlib')],
  ];
  if (up) links.push([base, at('terr', 'jup')], [base, at('d', 'jup')]);
  for (const [target, link] of links) linkDir(target, link);
  const remove = () => {
    for (const [, link] of links) unlinkDir(link);
    rm(base);
  };
  return { root, outside, at, remove };
};

describe('strict: a link out of a place disk', () => {
  let tree;
  let k;
  let native;
  const at = (...p) => tree.at(...p);
  const up = () => path.basename(tree.root);

  before(async () => {
    tree = linkedTree('links');
    const options = { preparers: PREPARERS };
    k = await kernel(tree.root, PLACES, { strict: true }, options);
    native = countNative();
    fsPatch.install(k);
    moduleHook.install(k);
  });

  after(() => {
    moduleHook.uninstall();
    fsPatch.uninstall();
    native.restore();
    k.close();
    tree.remove();
    delete globalThis.__smfsLinked;
  });

  it('reads, listings and watches through it: EACCES, nothing reaches node:fs', async () => {
    native.calls.length = 0;
    const files = [
      at('terr', 'jro', 'h.bin'),
      at('terr', 'jup', up(), 'ro', 'h.bin'),
      at('d', 'jro', 'h.bin'),
      at('d', 'jup', up(), 'ro', 'h.bin'),
      at('d', 'jdro', 'r.bin'),
      at('nd', 'jlib', 'm.js'),
    ];
    await refusesEach(FILE_READS, files);
    const dirs = [
      at('terr', 'jro'),
      at('terr', 'jup'),
      at('d', 'jro'),
      at('d', 'jup'),
      at('nd', 'jlib'),
    ];
    await refusesEach(DIR_READS, dirs);
    for (const p of [...files, ...dirs]) {
      assert.equal(fs.existsSync(p), false, p);
    }
    const blob = at('d', 'jro', 'h.bin');
    await assert.rejects(fs.openAsBlob(blob), refused('EACCES', 'open', blob));
    assert.deepEqual(native.calls, []);
  });

  it('writes, removals and metadata through it: EACCES, nothing changes', async () => {
    native.calls.length = 0;
    const files = [
      at('d', 'jro', 'h.bin'),
      at('d', 'jro', 'n.txt'),
      at('d', 'jdro', 'r.bin'),
      at('d', 'jdro', 'n.bin'),
      at('d', 'jup', up(), 'ro', 'n.txt'),
      at('nd', 'jlib', 'n.js'),
    ];
    await refusesEach(FILE_MUTATIONS, files);
    const dirs = [
      at('d', 'jro', 'sub'),
      at('d', 'jdro', 'sub'),
      at('d', 'jro'),
    ];
    await refusesEach(DIR_MUTATIONS, dirs);
    assert.deepEqual(native.calls, []);
    assert.deepEqual(listDisk(at('ro')), ['a.txt', 'h.bin']);
    assert.deepEqual(listDisk(at('dro')), ['r.bin']);
    assert.equal(readDisk(at('ro', 'h.bin'), 'utf8'), 'hidden');
    assert.equal(readDisk(at('dro', 'r.bin'), 'utf8'), 'r');
    assert.deepEqual(listDisk(at('lib')), ['e.mjs', 'm.js']);
  });

  // mkdtemp makes its prefix and six characters, a mutation of the place's
  // disk like any other: proven where the directory would really lie, its
  // path named as node:fs names it (`XXXXXX`). Through a link that stays
  // in the place it is made.
  it('mkdtemp through it: EACCES, nothing made', async () => {
    const MKDTEMPS = [
      ['mkdtempSync', (p) => fs.mkdtempSync(p)],
      ['mkdtemp', (p) => called((cb) => fs.mkdtemp(p, cb))],
      ['promises.mkdtemp', (p) => fs.promises.mkdtemp(p)],
    ];
    if (typeof fs.mkdtempDisposableSync === 'function') {
      MKDTEMPS.push(
        ['mkdtempDisposableSync', (p) => fs.mkdtempDisposableSync(p)],
        ['promises.mkdtempDisposable', (p) => fs.promises.mkdtempDisposable(p)],
      );
    }
    native.calls.length = 0;
    const prefixes = [
      at('d', 'jro', 'tmp-'),
      at('d', 'jdro', 'tmp-'),
      at('d', 'jup', up(), 'ro', 'tmp-'),
      at('nd', 'jlib', 'tmp-'),
    ];
    for (const prefix of prefixes) {
      for (const [call, run] of MKDTEMPS) {
        await assert.rejects(
          async () => run(prefix),
          refused('EACCES', 'mkdtemp', `${prefix}XXXXXX`),
          `${call} ${prefix}`,
        );
      }
    }
    assert.deepEqual(native.calls, []);
    assert.deepEqual(listDisk(at('ro')), ['a.txt', 'h.bin']);
    assert.deepEqual(listDisk(at('dro')), ['r.bin']);
    assert.deepEqual(listDisk(at('lib')), ['e.mjs', 'm.js']);
    const made = fs.mkdtempSync(at('d', 'jin', 'tmp-'));
    try {
      assert.ok(onDisk(at('d', 'sub', path.basename(made))), made);
      assert.ok(native.calls.includes('mkdtempSync'));
    } finally {
      rmdirDisk(made);
    }
  });

  it('copies, renames and links through it: EACCES, nothing moves', async () => {
    native.calls.length = 0;
    const pairs = [
      [at('d', 'jro', 'h.bin'), path.join(tree.outside, 'h.bin')],
      [at('d', 'jro', 'h.bin'), at('d', 'h.bin')],
      [__filename, at('d', 'jro', 'x.txt')],
      [at('d', 'f.bin'), at('d', 'jdro', 'f.bin')],
    ];
    // A recursive copy of a place's disk is refused on its own (below);
    // from read-only, indexed terr only a copy leaves (a move is EROFS, a
    // hard link ENOTSUP).
    const single = PAIRS.filter(([call]) => call !== 'cpSync recursive');
    const copies = single.filter(([, syscall]) => /^c/.test(syscall));
    const from = at('terr', 'jro', 'h.bin');
    const cases = [
      ...pairs.map((pair) => [pair, single]),
      [[from, path.join(tree.outside, 'h2.bin')], copies],
    ];
    for (const [[source, target], families] of cases) {
      for (const [call, syscall, run] of families) {
        await assert.rejects(
          async () => run(source, target),
          refused('EACCES', syscall, source, target),
          `${call} ${source} -> ${target}`,
        );
      }
    }
    assert.deepEqual(native.calls, []);
    assert.deepEqual(listDisk(tree.outside), ['o.bin']);
    assert.deepEqual(listDisk(at('ro')), ['a.txt', 'h.bin']);
    assert.deepEqual(listDisk(at('dro')), ['r.bin']);
    assert.equal(readDisk(at('d', 'f.bin'), 'utf8'), 'f');
  });

  it('a link that stays in the place or leaves the line of appRoot is followed', () => {
    native.calls.length = 0;
    assert.equal(fs.readFileSync(at('terr', 'jin', 's.bin'), 'utf8'), 's');
    assert.equal(fs.readFileSync(at('terr', 'jout', 'o.bin'), 'utf8'), 'o');
    assert.equal(fs.readFileSync(at('d', 'jin', 's.bin'), 'utf8'), 's');
    assert.equal(fs.readFileSync(at('d', 'jout', 'o.bin'), 'utf8'), 'o');
    assert.deepEqual(fs.readdirSync(at('d', 'jout')), ['o.bin']);
    fs.writeFileSync(at('d', 'jin', 'w.bin'), 'w');
    assert.equal(readDisk(at('d', 'sub', 'w.bin'), 'utf8'), 'w');
    assert.equal(fs.readFileSync(at('d', 'f.bin'), 'utf8'), 'f');
    assert.ok(native.calls.includes('readFileSync'));
    assert.equal(k.fs('terr').readFile('/jout/o.bin', 'utf8'), 'o');
    assert.equal(k.fs('terr').readFile('/jin/s.bin', 'utf8'), 's');
    fs.unlinkSync(at('d', 'sub', 'w.bin'));
  });

  it('the facade serves nothing through it', () => {
    const terr = k.fs('terr');
    assert.equal(terr.readFile('/jro/h.bin'), null);
    assert.equal(terr.stat('/jro/h.bin'), null);
    assert.equal(terr.stat('/jup'), null);
    assert.equal(terr.exists('/jro'), false);
    assert.throws(() => terr.readdir('/jro'), { code: 'ENOENT' });
  });

  // Node's resolvers take a module's real path through the patched
  // realpath, which refuses the link; one that asks node:fs as it loaded
  // takes the real path, which lib routes: never the raw file past it.
  it('require and import through it: refused, or routed by the real path', async () => {
    const linked = at('nd', 'jlib', 'm.js');
    assert.throws(() => require(linked), { code: 'EACCES', syscall: 'lstat' });
    assert.equal(globalThis.__smfsLinked, undefined);
    assert.equal(require(at('nd', 'own.js')), 'own');
    const esm = pathToFileURL(at('nd', 'jlib', 'e.mjs')).href;
    const loaded = await import(esm).then(
      (ns) => ns.default,
      (err) => err.code,
    );
    assert.ok(['EACCES', 'raw'].includes(loaded), String(loaded));
  });

  it('with --preserve-symlinks: a module through it is not found', () => {
    const script = path.join(__dirname, 'fixtures', 'links-preserve.cjs');
    const out = execFileSync(
      process.execPath,
      ['--preserve-symlinks', script, tree.root],
      { encoding: 'utf8' },
    );
    assert.deepEqual(JSON.parse(out), {
      linked: { code: 'MODULE_NOT_FOUND' },
      esm: { code: 'ERR_MODULE_NOT_FOUND' },
      own: { value: 'own' },
      ran: false,
    });
  });
});

// node:fs's own recursive readdir enters a link to a directory — on
// Windows a junction even with withFileTypes — and so would a native copy
// of the tree. The tree has no link above appRoot, where such a walk would
// never end: a regression fails here, it does not hang.
describe('strict: a recursive listing of a place disk', () => {
  let tree;
  let k;

  before(async () => {
    tree = linkedTree('links-walk', false);
    const options = { preparers: PREPARERS };
    k = await kernel(tree.root, PLACES, { strict: true }, options);
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    tree.remove();
  });

  const names = (list) => list.map(String).sort();
  const EXPECTED = [
    'f.bin',
    'jdro',
    'jin',
    'jout',
    'jro',
    'sub',
    path.join('sub', 's.bin'),
  ].sort();

  it('names a link, never enters it: every form', async () => {
    const d = tree.at('d');
    assert.deepEqual(names(fs.readdirSync(d, { recursive: true })), EXPECTED);
    const promised = await fs.promises.readdir(d, { recursive: true });
    assert.deepEqual(names(promised), EXPECTED);
    const buffers = fs.readdirSync(d, { recursive: true, encoding: 'buffer' });
    assert.ok(buffers.every((name) => Buffer.isBuffer(name)));
    assert.deepEqual(names(buffers), EXPECTED);
    const typed = fs.readdirSync(d, { recursive: true, withFileTypes: true });
    const rel = (e) =>
      path.relative(d, path.join(e.parentPath ?? e.path, e.name));
    assert.deepEqual(names(typed.map(rel)), EXPECTED);
    const jro = typed.find((e) => e.name === 'jro');
    assert.equal(jro.isDirectory(), false);
    const dir = fs.opendirSync(d, { recursive: true });
    const opened = [];
    for (let e = dir.readSync(); e !== null; e = dir.readSync()) {
      opened.push(rel(e));
    }
    dir.closeSync();
    assert.deepEqual(names(opened), EXPECTED);
  });

  it("the facade's listing of its disk territory and the strict appRoot's", () => {
    assert.deepEqual(k.fs('terr').readdir('/', { recursive: true }), [
      'm.bin',
      'sub',
      'sub/s.bin',
      't.txt',
    ]);
    const all = names(fs.readdirSync(tree.root, { recursive: true }));
    assert.ok(all.includes(path.join('d', 'jro')));
    assert.ok(all.includes(path.join('terr', 'sub', 's.bin')));
    const through = all.filter((name) =>
      /j(ro|out|in|dro|lib)[\\/]/.test(name),
    );
    assert.deepEqual(through, []);
  });

  it('a native copy of the tree is refused', () => {
    const d = tree.at('d');
    const into = path.join(tree.outside, 'copy');
    assert.throws(() => fs.cpSync(d, into, { recursive: true }), {
      code: 'ENOTSUP',
      syscall: 'cp',
      path: d,
      dest: into,
    });
    assert.equal(onDisk(into), false);
  });
});

// Under strict the patch makes no link to managed territory: a symbolic
// link whose target — resolved from the link's directory, as the OS
// resolves it — lies below appRoot, is appRoot or a directory above it,
// and a hard link to a file below appRoot. A junction takes no privilege
// on Windows, so these are made or refused for real.
describe('strict: making a link to managed territory', () => {
  let tree;
  let k;
  let native;
  const at = (...p) => tree.at(...p);
  const SYMLINKS = [
    ['symlinkSync', (t, p) => fs.symlinkSync(t, p, 'junction')],
    ['symlink', (t, p) => called((cb) => fs.symlink(t, p, 'junction', cb))],
    ['promises.symlink', (t, p) => fs.promises.symlink(t, p, 'junction')],
  ];
  const LINKS = [
    ['linkSync', (a, b) => fs.linkSync(a, b)],
    ['link', (a, b) => called((cb) => fs.link(a, b, cb))],
    ['promises.link', (a, b) => fs.promises.link(a, b)],
  ];

  before(async () => {
    tree = linkedTree('links-make', false);
    const options = { preparers: PREPARERS };
    k = await kernel(tree.root, PLACES, { strict: true }, options);
    native = countNative();
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    native.restore();
    k.close();
    tree.remove();
  });

  it('a symbolic link to a place, appRoot or above it: EACCES, nothing made', async () => {
    native.calls.length = 0;
    const base = path.dirname(tree.root);
    const cases = [
      [at('ro'), path.join(tree.outside, 'j1')],
      [at('ro', 'h.bin'), path.join(tree.outside, 'j2')],
      [tree.root, path.join(tree.outside, 'j3')],
      [base, path.join(tree.outside, 'j4')],
      [path.join('..', 'app', 'ro'), path.join(tree.outside, 'j5')],
      [at('ro'), at('d', 'j6')],
      [at('d', 'sub'), at('d', 'j7')],
      [at('nobody'), path.join(tree.outside, 'j8')],
    ];
    for (const [target, link] of cases) {
      for (const [call, run] of SYMLINKS) {
        await assert.rejects(
          async () => run(target, link),
          refused('EACCES', 'symlink', target, link),
          `${call} ${target} -> ${link}`,
        );
        assert.equal(onDisk(link), false, link);
      }
    }
    assert.deepEqual(native.calls, []);
  });

  it('a hard link to a file below appRoot: EACCES, nothing made', async () => {
    native.calls.length = 0;
    const cases = [
      [at('d', 'f.bin'), path.join(tree.outside, 'f.bin')],
      [at('dro', 'r.bin'), at('d', 'r.bin')],
      [at('d', 'f.bin'), at('d', 'g.bin')],
    ];
    for (const [from, to] of cases) {
      for (const [call, run] of LINKS) {
        await assert.rejects(
          async () => run(from, to),
          refused('EACCES', 'link', from, to),
          `${call} ${from} -> ${to}`,
        );
        assert.equal(onDisk(to), false, to);
      }
    }
    assert.deepEqual(native.calls, []);
  });

  it('a link to a path off the line of appRoot is made', async () => {
    const junction = at('d', 'jnew');
    fs.symlinkSync(tree.outside, junction, 'junction');
    try {
      assert.equal(fs.readFileSync(path.join(junction, 'o.bin'), 'utf8'), 'o');
    } finally {
      unlinkDir(junction);
    }
    const hard = at('d', 'o.bin');
    fs.linkSync(path.join(tree.outside, 'o.bin'), hard);
    assert.equal(readDisk(hard, 'utf8'), 'o');
    unlinkDisk(hard);
  });
});

describe('strict: a symbolic link to a file out of a place disk', () => {
  it('reads and writes through it: EACCES, nothing reaches node:fs', async (t) => {
    const root = writeTree(tmpDir('file-links'), TREE);
    const link = path.join(root, 'd', 'h.bin');
    try {
      linkDisk(path.join(root, 'ro', 'h.bin'), link, 'file');
    } catch (err) {
      rm(root);
      return void t.skip(`no symbolic link to a file here (${err.code})`);
    }
    const k = await kernel(
      root,
      PLACES,
      { strict: true },
      { preparers: PREPARERS },
    );
    const native = countNative();
    fsPatch.install(k);
    try {
      await refusesEach(FILE_READS, [link]);
      await refusesEach(FILE_MUTATIONS.slice(0, 3), [link]);
      assert.deepEqual(native.calls, []);
      assert.equal(readDisk(path.join(root, 'ro', 'h.bin'), 'utf8'), 'hidden');
    } finally {
      fsPatch.uninstall();
      native.restore();
      k.close();
      unlinkDisk(link);
      rm(root);
    }
  });

  // The disk territory of `fs.fallback: 'disk'` never serves an extension
  // its place caches: a link in the place that names such a file another
  // way (t.bin -> t.txt) is refused, as the file itself is.
  it('in the disk territory, a link to a file of a cached extension serves nothing', async (t) => {
    const root = writeTree(tmpDir('file-links-cached'), TREE);
    const link = path.join(root, 'terr', 't.bin');
    try {
      linkDisk(path.join(root, 'terr', 't.txt'), link, 'file');
    } catch (err) {
      rm(root);
      return void t.skip(`no symbolic link to a file here (${err.code})`);
    }
    const options = { preparers: PREPARERS };
    const k = await kernel(root, PLACES, { strict: true }, options);
    const native = countNative();
    fsPatch.install(k);
    try {
      await refusesEach(FILE_READS.slice(0, 6), [link]);
      assert.equal(k.fs('terr').readFile('/t.bin'), null);
      assert.equal(k.fs('terr').stat('/t.bin'), null);
      assert.deepEqual(native.calls, []);
      const media = path.join(root, 'terr', 'm.bin');
      assert.equal(fs.readFileSync(media, 'utf8'), 'media');
      assert.equal(k.fs('terr').readFile('/t.txt', 'utf8'), 'RAW');
    } finally {
      fsPatch.uninstall();
      native.restore();
      k.close();
      unlinkDisk(link);
      rm(root);
    }
  });
});

describe('without strict: links answer as before', () => {
  it('node:fs follows them natively', async () => {
    const tree = linkedTree('links-open');
    const k = await kernel(tree.root, PLACES, {}, { preparers: PREPARERS });
    fsPatch.install(k);
    try {
      const hidden = tree.at('d', 'jro', 'h.bin');
      assert.equal(fs.readFileSync(hidden, 'utf8'), 'hidden');
      assert.deepEqual(fs.readdirSync(tree.at('d', 'jro')), ['a.txt', 'h.bin']);
      fs.writeFileSync(tree.at('d', 'jdro', 'n.bin'), 'n');
      assert.equal(readDisk(tree.at('dro', 'n.bin'), 'utf8'), 'n');
      const junction = path.join(tree.outside, 'j');
      fs.symlinkSync(tree.at('ro'), junction, 'junction');
      assert.equal(readDisk(path.join(junction, 'h.bin'), 'utf8'), 'hidden');
      unlinkDir(junction);
      // A hidden target is refused in either mode, resolved from the link's
      // directory as the OS resolves it.
      const target = path.join('..', 'app', 'ro', 'h.bin');
      const link = path.join(tree.outside, 'l');
      assert.throws(
        () => fs.symlinkSync(target, link, 'junction'),
        refused('EACCES', 'symlink', target, link),
      );
      assert.equal(onDisk(link), false);
    } finally {
      fsPatch.uninstall();
      k.close();
      tree.remove();
    }
  });
});

// On POSIX the kernel resolves `..` from the real directory before it, past
// a symbolic link, so a path with `..` after a link into a place reaches
// what the link's target holds. The disk proof (aliases) is asked the path
// the OS opens — not path.resolve's folded form — and the router owns to
// nobody a path that leaves appRoot through `..` after a name inside it.
// Windows node:fs folds `..` before the OS, so it never reaches past the
// link there; these are real symbolic links, so the describe is skipped.
describe(
  'POSIX strict: `..` past a symbolic link into a place',
  { skip: WIN ? 'POSIX: node:fs folds `..` before the OS on Windows' : false },
  () => {
    let root;
    let outside;
    let k;
    let native;
    const at = (...p) => path.join(root, ...p);
    // Built with literal `..`, which path.join would fold away.
    const hidden = () => `${at('d', 'jro')}/../ro/h.bin`; // folds inside `d`
    const hiddenDir = () => `${at('d', 'jro')}/../ro`;
    const climb = () => `${at('d', 'jdeep')}/../../../h.bin`; // folds outside
    const climbDir = () => `${at('d', 'jdeep')}/../../..`;

    before(async () => {
      const base = tmpDir('dotdot');
      root = writeTree(path.join(base, 'app'), {
        'ro/h.bin': 'hidden',
        'ro/a/b/c/x.bin': 'x',
        'd/f.bin': 'f',
      });
      outside = writeTree(path.join(base, 'outside'), { 'o.bin': 'o' });
      linkDir(at('ro'), at('d', 'jro')); // into another place
      linkDir(at('ro', 'a', 'b', 'c'), at('d', 'jdeep')); // deep into it
      k = await kernel(
        root,
        { ro: PLACES.ro, d: PLACES.d },
        { strict: true },
        { preparers: PREPARERS },
      );
      native = countNative();
      fsPatch.install(k);
    });

    after(() => {
      fsPatch.uninstall();
      native.restore();
      k.close();
      rm(path.dirname(root));
    });

    it('reads and lists the hidden through it: EACCES, nothing reaches node:fs', async () => {
      native.calls.length = 0;
      // Folds to /app/d/ro inside place `d`; the OS opens /app/ro (hidden).
      await refusesEach(FILE_READS, [hidden()]);
      await refusesEach(DIR_READS, [hiddenDir()]);
      // Folds outside appRoot; the OS climbs back into ro through the link.
      await refusesEach(FILE_READS, [climb()]);
      await refusesEach(DIR_READS, [climbDir()]);
      assert.deepEqual(native.calls, []);
      assert.equal(readDisk(at('ro', 'h.bin'), 'utf8'), 'hidden');
    });

    it('writes to a read-only place through it: EACCES, nothing written', async () => {
      native.calls.length = 0;
      await refusesEach(FILE_MUTATIONS, [`${at('d', 'jro')}/../ro/new.bin`]);
      assert.deepEqual(native.calls, []);
      assert.deepEqual(listDisk(at('ro')).sort(), ['a', 'h.bin']);
    });

    it('mkdtemp through it: EACCES, nothing made', async () => {
      native.calls.length = 0;
      const prefix = `${at('d', 'jro')}/../ro/tmp-`;
      await assert.rejects(
        async () => fs.mkdtempSync(prefix),
        refused('EACCES', 'mkdtemp', `${prefix}XXXXXX`),
      );
      assert.deepEqual(native.calls, []);
      assert.deepEqual(listDisk(at('ro')).sort(), ['a', 'h.bin']);
    });

    it('a symlink whose target climbs into a place through it: EACCES, nothing made', async () => {
      native.calls.length = 0;
      // A target resolved from the link's directory: an absolute one that
      // folds outside appRoot (the OS climbs back in), and a relative one
      // (outside/.. then into the place, past the fold).
      const app = path.basename(root);
      const cases = [
        [climb(), path.join(outside, 's1')],
        [`../${app}/d/jro/../ro/h.bin`, path.join(outside, 's2')],
      ];
      for (const [target, link] of cases) {
        await assert.rejects(
          async () => fs.symlinkSync(target, link),
          refused('EACCES', 'symlink', target, link),
          `${target} -> ${link}`,
        );
        assert.equal(onDisk(link), false, link);
      }
      assert.deepEqual(native.calls, []);
    });

    it('a hard link whose source climbs into a place through it: EACCES, nothing made', async () => {
      native.calls.length = 0;
      // The OS names the inode of the source physically: `..` past the link
      // reaches the hidden file, folded inside `d` or climbed outside.
      const froms = [hidden(), climb()];
      for (const from of froms) {
        const to = path.join(outside, 'hard');
        await assert.rejects(
          async () => fs.linkSync(from, to),
          refused('EACCES', 'link', from, to),
          from,
        );
        assert.equal(onDisk(to), false, to);
      }
      assert.deepEqual(native.calls, []);
    });
  },
);

// Under strict a rename that leaves a place moves a regular file only: a
// directory holding a link out of the place, or a link itself, would turn
// it into a link into appRoot from outside, which no proof sees; a place's
// own directory never leaves either.
describe('strict: what a rename takes out of a place', () => {
  const RENAMES = PAIRS.filter(([, syscall]) => syscall === 'rename');
  const MOVE_PLACES = {
    ro: PLACES.ro,
    d: PLACES.d,
    d2: { provider: 'disk', fs: { writable: true } },
  };
  const moving = () => {
    const base = tmpDir('links-move');
    const root = writeTree(path.join(base, 'app'), {
      'ro/h.bin': 'hidden',
      'd/f.bin': 'f',
      'd/sub/deeper/g.bin': 'g',
      'd/in/s.bin': 's',
      'd2/x.bin': 'x',
    });
    const outside = writeTree(path.join(base, 'outside'), { 'o.bin': 'o' });
    const at = (...p) => path.join(root, ...p);
    linkDir(at('ro'), at('d', 'sub', 'deeper', 'jro'));
    linkDir(at('d', 'in'), at('d', 'jin'));
    return { base, root, outside, at };
  };

  it('a directory or a link: ENOTSUP, nothing moves; a file moves', async () => {
    const { base, root, outside, at } = moving();
    const options = { preparers: PREPARERS };
    const k = await kernel(root, MOVE_PLACES, { strict: true }, options);
    const native = countNative();
    fsPatch.install(k);
    try {
      const refusals = [
        [at('d', 'sub'), path.join(outside, 'sub')],
        [at('d'), path.join(outside, 'd')],
        [at('d', 'jin'), path.join(outside, 'jin')],
        [at('d', 'sub'), at('d2', 'sub')],
      ];
      for (const [from, to] of refusals) {
        for (const [call, syscall, run] of RENAMES) {
          await assert.rejects(
            async () => run(from, to),
            refused('ENOTSUP', syscall, from, to),
            `${call} ${from} -> ${to}`,
          );
        }
      }
      assert.deepEqual(native.calls, []);
      assert.deepEqual(listDisk(outside), ['o.bin']);
      assert.ok(onDisk(at('d', 'sub', 'deeper', 'jro', 'h.bin')));
      fs.renameSync(at('d', 'f.bin'), path.join(outside, 'f.bin'));
      assert.equal(readDisk(path.join(outside, 'f.bin'), 'utf8'), 'f');
      fs.renameSync(at('d', 'sub'), at('d', 'moved'));
      assert.ok(onDisk(at('d', 'moved', 'deeper', 'g.bin')));
      const into = writeTree(path.join(outside, 'into'), { 'i.bin': 'i' });
      fs.renameSync(into, at('d', 'into'));
      assert.equal(readDisk(at('d', 'into', 'i.bin'), 'utf8'), 'i');
    } finally {
      fsPatch.uninstall();
      native.restore();
      k.close();
      rm(base);
    }
  });

  it('without strict: as before', async () => {
    const { base, root, outside, at } = moving();
    const k = await kernel(root, MOVE_PLACES, {}, { preparers: PREPARERS });
    fsPatch.install(k);
    try {
      fs.renameSync(at('d', 'sub'), path.join(outside, 'sub'));
      const moved = path.join(outside, 'sub', 'deeper', 'jro', 'h.bin');
      assert.equal(readDisk(moved, 'utf8'), 'hidden');
    } finally {
      fsPatch.uninstall();
      k.close();
      rm(base);
    }
  });
});

// A place's directory may itself be a link. Out of appRoot — a media store
// elsewhere — it is the place's own disk. Into the territory appRoot
// manages — another place, appRoot, a directory above it — its scan,
// watcher and native calls would serve that territory under the place's
// name and policy: under strict initialize() refuses it, before anything
// is read.
describe('strict: a place whose directory is a link', () => {
  const HOME = {
    ro: PLACES.ro,
    dj: { provider: 'disk', fs: { writable: true } },
    tj: { fs: { ext: ['txt'], fallback: 'disk', prepare: { up: ['txt'] } } },
  };
  const homed = (prefix) => {
    const base = tmpDir(prefix);
    const root = writeTree(path.join(base, 'app'), {
      'ro/a.txt': 'raw',
      'ro/h.bin': 'hidden',
    });
    const outside = writeTree(path.join(base, 'outside'), { 'o.bin': 'o' });
    return { base, root, outside, at: (...p) => path.join(root, ...p) };
  };

  it('into another place, appRoot or above it: initialize() refuses it', async () => {
    for (const name of ['dj', 'tj']) {
      const { base, root, at } = homed(`links-home-${name}`);
      const targets = [at('ro'), root, base];
      try {
        for (const target of targets) {
          linkDir(target, at(name));
          try {
            const places = { ro: HOME.ro, [name]: HOME[name] };
            const options = { preparers: PREPARERS };
            await assert.rejects(
              kernel(root, places, { strict: true }, options),
              (err) => {
                assert.match(err.message, /^\[vfs config\] places\./);
                assert.ok(err.message.includes(`places.${name}:`));
                return true;
              },
              `${name} -> ${target}`,
            );
          } finally {
            unlinkDir(at(name));
          }
        }
        assert.deepEqual(listDisk(at('ro')), ['a.txt', 'h.bin']);
      } finally {
        rm(base);
      }
    }
  });

  it('out of appRoot: the place serves it, and nothing through it', async () => {
    const { base, root, outside, at } = homed('links-home-out');
    linkDir(outside, at('dj'));
    linkDir(at('ro'), path.join(outside, 'jro'));
    const places = { ro: HOME.ro, dj: HOME.dj };
    const k = await kernel(
      root,
      places,
      { strict: true },
      { preparers: PREPARERS },
    );
    fsPatch.install(k);
    try {
      assert.equal(fs.readFileSync(at('dj', 'o.bin'), 'utf8'), 'o');
      fs.writeFileSync(at('dj', 'w.bin'), 'w');
      assert.equal(readDisk(path.join(outside, 'w.bin'), 'utf8'), 'w');
      const hidden = at('dj', 'jro', 'h.bin');
      assert.throws(
        () => fs.readFileSync(hidden),
        refused('EACCES', 'open', hidden),
      );
    } finally {
      fsPatch.uninstall();
      k.close();
      unlinkDir(path.join(outside, 'jro'));
      unlinkDir(at('dj'));
      rm(base);
    }
  });

  it('without strict: as before', async () => {
    const { base, root, at } = homed('links-home-open');
    linkDir(at('ro'), at('dj'));
    const places = { ro: HOME.ro, dj: HOME.dj };
    const k = await kernel(root, places, {}, { preparers: PREPARERS });
    fsPatch.install(k);
    try {
      assert.equal(fs.readFileSync(at('dj', 'h.bin'), 'utf8'), 'hidden');
    } finally {
      fsPatch.uninstall();
      k.close();
      unlinkDir(at('dj'));
      rm(base);
    }
  });
});

// The scan at initialize() never enters a link to a directory, and under
// strict takes no link to a file; the watcher's epochs keep to the same. A
// link made later in a disk-origin place publishes nothing of its target,
// in either mode; under strict a link at a watched key is no source. The
// epochs are emitted by hand, a new file beside the link the gate that
// they ran.
describe('the watcher publishes no link the scan would not', () => {
  const opened = async (strict) => {
    const base = tmpDir('watch-links');
    const root = writeTree(path.join(base, 'app'), { 'site/a.txt': 'a' });
    const other = writeTree(path.join(base, 'other'), { 'secret.txt': 's' });
    const places = { site: { fs: { ext: ['txt'] } } };
    const defaults = { strict, watch: true, watchTimeout: 60000 };
    const k = await kernel(root, places, defaults);
    const at = (...p) => path.join(root, 'site', ...p);
    const epoch = async (events) => {
      k.watcher.emit('epoch', new Map(events));
      await k.watchQueue.idle;
    };
    return { base, other, k, at, epoch };
  };

  for (const strict of [false, true]) {
    it(`a link to a directory made after initialize() (strict: ${strict})`, async () => {
      const { base, other, k, at, epoch } = await opened(strict);
      const junction = at('j');
      linkDir(other, junction);
      try {
        writeTree(at(), { 'n.txt': 'n' });
        await epoch([
          [junction, 'scan'],
          [at('n.txt'), 'change'],
        ]);
        const site = k.fs('site');
        assert.equal(site.readFile('/n.txt', 'utf8'), 'n');
        assert.equal(site.exists('/j/secret.txt'), false);
        assert.deepEqual(site.readdir('/'), ['a.txt', 'n.txt']);
      } finally {
        k.close();
        unlinkDir(junction);
        rm(base);
      }
    });
  }

  // A published file replaced by a link goes as if it were gone — a
  // junction here, which Windows makes without a privilege.
  it('strict: a published key replaced by a link goes', async () => {
    const { base, other, k, at, epoch } = await opened(true);
    try {
      unlinkDisk(at('a.txt'));
      linkDir(other, at('a.txt'));
      writeTree(at(), { 'n.txt': 'n' });
      await epoch([
        [at('a.txt'), 'change'],
        [at('n.txt'), 'change'],
      ]);
      const site = k.fs('site');
      assert.equal(site.readFile('/n.txt', 'utf8'), 'n');
      assert.equal(site.exists('/a.txt'), false);
    } finally {
      k.close();
      unlinkDir(at('a.txt'));
      rm(base);
    }
  });

  it('strict: a link to a file at a watched key is no source', async (t) => {
    const { base, other, k, at, epoch } = await opened(true);
    try {
      try {
        linkDisk(path.join(other, 'secret.txt'), at('l.txt'), 'file');
      } catch (err) {
        return void t.skip(`no symbolic link to a file here (${err.code})`);
      }
      writeTree(at(), { 'n.txt': 'n' });
      await epoch([
        [at('l.txt'), 'change'],
        [at('n.txt'), 'change'],
      ]);
      const site = k.fs('site');
      assert.equal(site.readFile('/n.txt', 'utf8'), 'n');
      assert.equal(site.exists('/l.txt'), false);
    } finally {
      k.close();
      rm(base);
    }
  });
});
