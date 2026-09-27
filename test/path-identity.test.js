'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fsPatch = require('../lib/adapters/fs-patch.js');
const moduleHook = require('../lib/adapters/module-hook.js');
const { tmpDir, writeTree, rm, kernel, drain } = require('./helpers.js');

// The disk as it is, behind the patch: captured before any install.
const { existsSync: onDisk, readFileSync: readDisk } = fs;

// Windows file systems take one name in any case: appRoot and a place's
// name in another case route as their own spelling does — prepared
// content, read-only places, the fallback of the place — in either mode.
// The pure rules are tested for both path flavors in registry.test.js.

const WIN = process.platform === 'win32';
const WINDOWS_ONLY = WIN ? false : 'Windows: file names compare without case';

const PREPARERS = {
  up: (raw) => raw.toString().toUpperCase(),
  mark: (raw) => `<${raw}>`,
  mod: (raw) => raw.toString().replace("'raw'", "'prepared'"),
};

const PLACES = {
  ro: { fs: { ext: ['txt'], fallback: 'deny', prepare: { up: ['txt'] } } },
  terr: { fs: { ext: ['txt'], fallback: 'disk', prepare: { up: ['txt'] } } },
  rw: { provider: 'disk', fs: { writable: true } },
  rod: { provider: 'disk', fs: true },
  v: { origin: 'virtual', fs: { writable: true } },
  lib: { require: { prepare: 'mod' } },
};

const TREE = {
  'ro/a.txt': 'raw',
  'ro/h.bin': 'hidden',
  'terr/t.txt': 'raw',
  'terr/m.bin': 'media',
  'rw/w.txt': 'w',
  'rod/r.txt': 'r',
  'lib/m.js': "module.exports = 'raw';",
};

// The error of a refused call: its code, syscall and the path as given —
// and, for a call of two paths, the destination as given.
const refused = (code, syscall, given, dest) => (err) => {
  assert.equal(err.code, code, given);
  assert.equal(err.syscall, syscall, given);
  assert.equal(err.path, given);
  assert.equal(err.dest, dest, given);
  return true;
};

for (const strict of [false, true]) {
  describe(
    `Windows: appRoot and a place named in another case (strict: ${strict})`,
    { skip: WINDOWS_ONLY },
    () => {
      let root;
      let k;
      // Every spelling of appRoot and of a place's name that Windows takes.
      const spellings = (name) => {
        const roots = [root, root.toUpperCase(), root.toLowerCase()];
        const names = [
          name,
          name.toUpperCase(),
          name[0].toUpperCase() + name.slice(1),
        ];
        return roots.flatMap((r) => names.map((n) => path.join(r, n)));
      };

      before(async () => {
        root = writeTree(tmpDir('case'), TREE);
        k = await kernel(root, PLACES, { strict }, { preparers: PREPARERS });
        fsPatch.install(k);
        moduleHook.install(k);
      });

      after(() => {
        moduleHook.uninstall();
        fsPatch.uninstall();
        k.close();
        rm(root);
      });

      it('reads: the prepared content, never the raw file', () => {
        for (const dir of spellings('ro')) {
          const file = path.join(dir, 'a.txt');
          assert.equal(fs.readFileSync(file, 'utf8'), 'RAW', file);
          assert.equal(fs.statSync(file).size, 3, file);
          assert.equal(fs.existsSync(file), true, file);
          assert.deepEqual(fs.readdirSync(dir), ['a.txt'], dir);
        }
      });

      it("fs.fallback: 'deny' hides a file under any spelling", () => {
        for (const dir of spellings('ro')) {
          const file = path.join(dir, 'h.bin');
          assert.throws(
            () => fs.readFileSync(file),
            refused('EACCES', 'open', file),
          );
          assert.throws(
            () => fs.statSync(file),
            refused('EACCES', 'stat', file),
          );
          assert.throws(
            () => fs.openSync(file, 'r'),
            refused('EACCES', 'open', file),
          );
          assert.equal(fs.existsSync(file), false, file);
        }
        assert.equal(
          readDisk(path.join(root, 'ro', 'h.bin'), 'utf8'),
          'hidden',
        );
      });

      it("fs.fallback: 'disk' serves its disk territory, never a cached extension raw", () => {
        for (const dir of spellings('terr')) {
          assert.equal(fs.readFileSync(path.join(dir, 't.txt'), 'utf8'), 'RAW');
          assert.equal(
            fs.readFileSync(path.join(dir, 'm.bin'), 'utf8'),
            'media',
          );
        }
      });

      it('a read-only place refuses every mutation: EROFS, nothing changed', () => {
        const cases = [
          ...spellings('ro').map((dir) => [dir, 'a.txt']),
          ...spellings('rod').map((dir) => [dir, 'r.txt']),
        ];
        for (const [dir, name] of cases) {
          const file = path.join(dir, name);
          const fresh = path.join(dir, 'x.txt');
          const d = path.join(dir, 'd');
          const erofs = (syscall, p, dest) =>
            refused('EROFS', syscall, p, dest);
          assert.throws(
            () => fs.writeFileSync(fresh, 'x'),
            erofs('open', fresh),
          );
          assert.throws(
            () => fs.appendFileSync(file, 'x'),
            erofs('open', file),
          );
          assert.throws(() => fs.unlinkSync(file), erofs('unlink', file));
          assert.throws(() => fs.mkdirSync(d), erofs('mkdir', d));
          assert.throws(() => fs.rmSync(file), erofs('rm', file));
          assert.throws(
            () => fs.renameSync(file, fresh),
            erofs('rename', file, fresh),
          );
          assert.throws(
            () => fs.copyFileSync(__filename, fresh),
            erofs('copyfile', __filename, fresh),
          );
          assert.throws(
            () => fs.linkSync(__filename, fresh),
            erofs('link', __filename, fresh),
          );
          assert.throws(() => fs.utimesSync(file, 1, 1), erofs('utime', file));
        }
        for (const place of ['ro', 'rod']) {
          assert.equal(onDisk(path.join(root, place, 'x.txt')), false, place);
          assert.equal(onDisk(path.join(root, place, 'd')), false, place);
        }
        assert.equal(readDisk(path.join(root, 'ro', 'a.txt'), 'utf8'), 'raw');
        assert.equal(readDisk(path.join(root, 'rod', 'r.txt'), 'utf8'), 'r');
      });

      it('a writable place takes the write in its own directory', () => {
        let i = 0;
        for (const dir of spellings('rw')) {
          const name = `n${i++}.txt`;
          fs.writeFileSync(path.join(dir, name), name);
          assert.equal(readDisk(path.join(root, 'rw', name), 'utf8'), name);
        }
      });

      it('a virtual place stores the write: no file on disk', async () => {
        let i = 0;
        for (const dir of spellings('v')) {
          const name = `n${i++}.txt`;
          await fs.promises.writeFile(path.join(dir, name), name);
          assert.equal(k.fs('v').readFile(`/${name}`, 'utf8'), name);
          assert.equal(
            fs.readFileSync(path.join(root, 'V', name), 'utf8'),
            name,
          );
          assert.equal(onDisk(path.join(root, 'v', name)), false);
        }
      });

      it('require loads the published module, prepared', () => {
        for (const dir of spellings('lib')) {
          const file = path.join(dir, 'm.js');
          assert.equal(require(file), 'prepared', file);
        }
      });

      it('an unrelated path outside appRoot stays native, in any case', () => {
        const here = __filename.toUpperCase();
        assert.equal(
          fs.readFileSync(here, 'utf8'),
          readDisk(__filename, 'utf8'),
        );
        assert.equal(fs.existsSync(here), true);
        const parent = path.dirname(root).toUpperCase();
        assert.ok(fs.readdirSync(parent).includes(path.basename(root)));
      });
    },
  );
}

// A key keeps its case in the index, while the disk takes it in any. Where
// the disk would answer a miss — the non-strict `fs.fallback: 'disk'`,
// Node's own module loader without strict — a published source held in
// memory, named in another case, answers as its own spelling does: never
// its raw file. Strict refuses it as any unpublished path; 'deny' refuses
// it always. A directory in another case is no published directory, and a
// virtual place keeps exact keys.

const KEY_PLACES = {
  pub: { fs: { ext: ['txt'], fallback: 'disk', prepare: { mark: ['txt'] } } },
  lock: { fs: { ext: ['txt'], fallback: 'deny', prepare: { mark: ['txt'] } } },
  mods: {
    require: { ext: ['js'], prepare: 'mod' },
    import: { ext: ['mjs'], prepare: 'mod' },
  },
  vmod: {
    provider: 'map',
    origin: 'virtual',
    fs: { writable: true },
    require: true,
  },
};

const KEY_TREE = {
  'pub/a.txt': 'raw',
  'pub/Sub/Mixed.TXT': 'raw',
  'pub/Sub/pic.png': 'pic',
  'pub/m.bin': 'media',
  'lock/a.txt': 'raw',
  'lock/Sub/b.txt': 'raw',
  'mods/m.js': "module.exports = 'raw';",
  'mods/e.mjs': "export default 'raw';",
};

for (const strict of [false, true]) {
  describe(
    `Windows: a key in another case (strict: ${strict})`,
    { skip: WINDOWS_ONLY },
    () => {
      let root;
      let k;
      const at = (...p) => path.join(root, ...p);

      before(async () => {
        root = writeTree(tmpDir('case-keys'), KEY_TREE);
        const options = { preparers: PREPARERS };
        k = await kernel(root, KEY_PLACES, { strict }, options);
        fsPatch.install(k);
        moduleHook.install(k);
      });

      after(() => {
        moduleHook.uninstall();
        fsPatch.uninstall();
        k.close();
        rm(root);
      });

      it("fs.fallback: 'disk' serves the published source, or refuses it", async () => {
        const variants = [
          at('pub', 'A.TXT'),
          at('pub', 'a.Txt'),
          at('pub', 'sub', 'mixed.txt'),
          at('PUB', 'SUB', 'MIXED.TXT'),
        ];
        for (const file of variants) {
          if (strict) {
            assert.throws(
              () => fs.readFileSync(file),
              refused('EACCES', 'open', file),
            );
            assert.throws(() => fs.statSync(file), { code: 'EACCES' });
            assert.equal(fs.existsSync(file), false, file);
            continue;
          }
          assert.equal(fs.readFileSync(file, 'utf8'), '<raw>', file);
          assert.equal(fs.statSync(file).size, 5, file);
          assert.equal(fs.existsSync(file), true, file);
          assert.equal(String(await drain(fs.createReadStream(file))), '<raw>');
          // No descriptor to the raw file: as its own spelling, ENOTSUP.
          assert.throws(() => fs.openSync(file), {
            code: 'ENOTSUP',
            syscall: 'open',
            path: file,
          });
        }
        // Its own spelling; the disk territory in any case.
        assert.equal(fs.readFileSync(at('pub', 'a.txt'), 'utf8'), '<raw>');
        assert.equal(fs.readFileSync(at('pub', 'M.BIN'), 'utf8'), 'media');
      });

      it("fs.fallback: 'deny' refuses it", () => {
        const file = at('lock', 'A.TXT');
        assert.throws(
          () => fs.readFileSync(file),
          refused('EACCES', 'open', file),
        );
        assert.equal(fs.readFileSync(at('lock', 'a.txt'), 'utf8'), '<raw>');
      });

      // As before: 'disk' lists what its disk territory holds there — the
      // published files only under their own spelling — and 'deny' refuses.
      it('a directory in another case is no published directory', () => {
        assert.deepEqual(fs.readdirSync(at('pub', 'Sub')), [
          'Mixed.TXT',
          'pic.png',
        ]);
        assert.deepEqual(fs.readdirSync(at('pub', 'SUB')), ['pic.png']);
        const locked = at('lock', 'SUB');
        assert.throws(
          () => fs.readdirSync(locked),
          refused('EACCES', 'scandir', locked),
        );
        assert.deepEqual(fs.readdirSync(at('lock', 'Sub')), ['b.txt']);
      });

      it('require and import load the published module, or none', async () => {
        const cjs = at('mods', 'M.JS');
        const esm = pathToFileURL(at('mods', 'E.MJS')).href;
        if (strict) {
          assert.throws(() => require(cjs), { code: 'MODULE_NOT_FOUND' });
          await assert.rejects(import(esm), { code: 'ERR_MODULE_NOT_FOUND' });
        } else {
          assert.equal(require(cjs), 'prepared');
          assert.equal((await import(esm)).default, 'prepared');
        }
        assert.equal(require(at('mods', 'm.js')), 'prepared');
        // V8 cached data is looked up by the key as spelled.
        assert.ok(k.bytecode(at('mods', 'm.js')));
        assert.equal(k.bytecode(cjs), null);
      });

      it('a virtual place keeps exact keys', () => {
        k.fs('vmod').writeFile('/a.js', "module.exports = 'virtual';");
        assert.equal(require(at('vmod', 'a.js')), 'virtual');
        const other = at('vmod', 'A.JS');
        assert.throws(() => require(other), { code: 'MODULE_NOT_FOUND' });
        assert.equal(fs.existsSync(other), false);
        const code = strict ? 'EACCES' : 'ENOENT';
        assert.throws(() => fs.readFileSync(other), { code, path: other });
      });
    },
  );
}

// Under strict a UNC or namespace path — `\\?\…`, `\\.\…`, `\??\…`,
// `\\server\share\…`, an admin share `\\localhost\C$\…`, with `/` or `\` —
// may name a file below appRoot in a spelling appRoot does not share: it
// is refused before any native I/O, whatever it names and whether the
// share exists. Without strict it passes through, as before. The paths
// are spelled from the test's own root, on its drive.

const ON_DRIVE = /^[A-Za-z]:\\/.test(os.tmpdir());
const NAMESPACES = !WIN
  ? 'Windows: UNC and namespace paths'
  : !ON_DRIVE && 'the temporary directory is not on a drive';

// The admin share of a path on a drive: `\\localhost\C$\…`.
const adminShare = (abs) => `\\\\localhost\\${abs[0]}$${abs.slice(2)}`;

// A path on a drive, spelled through a namespace or a share — the last
// through a server that does not exist.
const namespaceForms = (abs) => {
  const slashed = abs.replace(/\\/g, '/');
  const share = adminShare(abs).slice('\\\\localhost\\'.length);
  return [
    `\\\\?\\${abs}`,
    `//?/${slashed}`,
    `\\\\.\\${abs}`,
    `\\??\\${abs}`,
    `/??/${slashed}`,
    adminShare(abs),
    `//127.0.0.1/${share.replace(/\\/g, '/')}`,
    `\\\\?\\UNC\\localhost\\${share}`,
    `\\\\smfs-no-such-host.invalid\\share${abs.slice(2)}`,
  ];
};

// node:fs itself, counted: set before the patch is installed, these are
// the originals it passes a call through to.
const NATIVE = [
  ...['readFileSync', 'readFile', 'statSync', 'lstatSync', 'accessSync'],
  ...['existsSync', 'realpathSync', 'readdirSync', 'opendirSync'],
  ...['openSync', 'createReadStream', 'watch', 'writeFileSync', 'mkdirSync'],
  ...['appendFileSync', 'unlinkSync', 'rmSync', 'renameSync', 'linkSync'],
  ...['copyFileSync', 'cpSync'],
];
const countNative = () => {
  const calls = [];
  const saved = NATIVE.map((name) => [fs, name, fs[name]]);
  saved.push([fs.promises, 'readFile', fs.promises.readFile]);
  for (const [target, name, original] of saved) {
    const counted = (...args) => {
      calls.push(name);
      return original.apply(target, args);
    };
    if (original.native) counted.native = original.native;
    target[name] = counted;
  }
  const restore = () => {
    for (const [target, name, original] of saved) target[name] = original;
  };
  return { calls, restore };
};

const NS_PLACES = {
  ro: PLACES.ro,
  rw: PLACES.rw,
  lib: { require: { prepare: 'mod' }, import: { ext: ['mjs'] } },
};

const NS_TREE = {
  'ro/a.txt': 'raw',
  'ro/h.bin': 'hidden',
  'rw/w.txt': 'w',
  'lib/side.js':
    "globalThis.__smfsSide = (globalThis.__smfsSide ?? 0) + 1; module.exports = 'raw';",
  'lib/e.mjs': "globalThis.__smfsEsm = true; export default 'e';",
};

describe(
  'Windows, strict: UNC and namespace paths',
  { skip: NAMESPACES },
  () => {
    let root;
    let k;
    let native;
    const at = (...p) => path.join(root, ...p);

    before(async () => {
      root = writeTree(tmpDir('ns'), NS_TREE);
      const options = { preparers: PREPARERS };
      k = await kernel(root, NS_PLACES, { strict: true }, options);
      native = countNative();
      fsPatch.install(k);
      moduleHook.install(k);
    });

    after(() => {
      moduleHook.uninstall();
      fsPatch.uninstall();
      native.restore();
      k.close();
      rm(root);
    });

    it('reads and listings: EACCES, the path as given, nothing reaches node:fs', async () => {
      native.calls.length = 0;
      const outside = namespaceForms(path.resolve(__filename));
      for (const file of [
        ...namespaceForms(at('ro', 'h.bin')),
        ...namespaceForms(at('ro', 'a.txt')),
        ...outside,
      ]) {
        const eacces = (syscall) => refused('EACCES', syscall, file);
        assert.throws(() => fs.readFileSync(file), eacces('open'));
        assert.throws(() => fs.statSync(file), eacces('stat'));
        assert.throws(() => fs.lstatSync(file), eacces('lstat'));
        assert.throws(() => fs.accessSync(file), eacces('access'));
        assert.throws(() => fs.realpathSync(file), eacces('lstat'));
        assert.throws(() => fs.openSync(file), eacces('open'));
        assert.equal(fs.existsSync(file), false, file);
        await assert.rejects(fs.promises.readFile(file), eacces('open'));
        await assert.rejects(
          new Promise((resolve, reject) =>
            fs.readFile(file, (err) => (err ? reject(err) : resolve())),
          ),
          eacces('open'),
        );
        await assert.rejects(drain(fs.createReadStream(file)), eacces('open'));
      }
      for (const dir of namespaceForms(at('ro'))) {
        const eacces = (syscall) => refused('EACCES', syscall, dir);
        assert.throws(() => fs.readdirSync(dir), eacces('scandir'));
        assert.throws(() => fs.opendirSync(dir), eacces('opendir'));
        assert.throws(() => fs.watch(dir), eacces('watch'));
      }
      assert.deepEqual(native.calls, []);
    });

    it('writes: EACCES, nothing reaches node:fs, nothing changes', () => {
      native.calls.length = 0;
      const plain = (name) => at('rw', name);
      for (const [i, form] of namespaceForms(at('rw', 'new.txt')).entries()) {
        const eacces = (syscall) => refused('EACCES', syscall, form);
        assert.throws(() => fs.writeFileSync(form, 'x'), eacces('open'));
        assert.throws(() => fs.openSync(form, 'w'), eacces('open'));
        const w = namespaceForms(plain('w.txt'))[i];
        const wEacces = (syscall) => refused('EACCES', syscall, w);
        assert.throws(() => fs.appendFileSync(w, 'x'), wEacces('open'));
        assert.throws(() => fs.unlinkSync(w), wEacces('unlink'));
        assert.throws(() => fs.rmSync(w), wEacces('rm'));
        const d = namespaceForms(plain('d'))[i];
        assert.throws(() => fs.mkdirSync(d), refused('EACCES', 'mkdir', d));
        const pairs = [
          ['renameSync', 'rename', w, plain('z.txt')],
          ['renameSync', 'rename', plain('w.txt'), form],
          ['copyFileSync', 'copyfile', at('ro', 'a.txt'), form],
          ['copyFileSync', 'copyfile', w, plain('c.txt')],
          ['cpSync', 'cp', w, plain('c.txt')],
          ['linkSync', 'link', w, plain('l.txt')],
        ];
        for (const [call, syscall, from, to] of pairs) {
          assert.throws(
            () => fs[call](from, to),
            refused('EACCES', syscall, from, to),
          );
        }
      }
      assert.deepEqual(native.calls, []);
      assert.equal(readDisk(at('rw', 'w.txt'), 'utf8'), 'w');
      for (const name of ['new.txt', 'd', 'z.txt', 'c.txt', 'l.txt']) {
        assert.equal(onDisk(at('rw', name)), false, name);
      }
    });

    it('require and import: not found, never loaded', async () => {
      const side = at('lib', 'side.js');
      for (const form of namespaceForms(side)) {
        assert.throws(() => require(form), { code: 'MODULE_NOT_FOUND' });
      }
      const url = `file://127.0.0.1/${root[0]}$${at('lib', 'e.mjs')
        .slice(2)
        .replace(/\\/g, '/')}`;
      await assert.rejects(import(url), { code: 'ERR_MODULE_NOT_FOUND' });
      assert.equal(globalThis.__smfsSide, undefined);
      assert.equal(globalThis.__smfsEsm, undefined);
      assert.equal(require(side), 'prepared');
    });

    it('a path on a drive outside appRoot is node:fs as before', () => {
      native.calls.length = 0;
      const outside = tmpDir('ns-outside');
      const file = path.join(outside, 'o.txt');
      try {
        fs.writeFileSync(file, 'o');
        assert.equal(fs.readFileSync(file, 'utf8'), 'o');
        assert.ok(fs.statSync(outside).isDirectory());
        assert.deepEqual(fs.readdirSync(outside), ['o.txt']);
        const relative = path.relative(process.cwd(), file);
        assert.equal(fs.readFileSync(relative, 'utf8'), 'o');
        assert.ok(fs.readFileSync(__filename).length > 0);
        assert.ok(native.calls.includes('writeFileSync'));
        assert.ok(native.calls.includes('readFileSync'));
      } finally {
        rm(outside);
      }
    });

    it('a relative path, through a cwd on a share, is refused too', (t) => {
      const share = adminShare(root);
      if (!onDisk(share)) {
        t.skip('the admin share is not available');
        return;
      }
      const cwd = process.cwd();
      process.chdir(share);
      try {
        const file = path.join('ro', 'a.txt');
        assert.throws(
          () => fs.readFileSync(file),
          refused('EACCES', 'open', file),
        );
        assert.throws(() => fs.writeFileSync('x.txt', 'x'), { code: 'EACCES' });
      } finally {
        process.chdir(cwd);
      }
      assert.equal(onDisk(at('x.txt')), false);
    });
  },
);

describe(
  'Windows, without strict: UNC and namespace paths pass through',
  {
    skip: NAMESPACES,
  },
  () => {
    let root;
    let k;
    const at = (...p) => path.join(root, ...p);

    before(async () => {
      root = writeTree(tmpDir('ns-open'), NS_TREE);
      k = await kernel(root, NS_PLACES, {}, { preparers: PREPARERS });
      fsPatch.install(k);
      moduleHook.install(k);
    });

    after(() => {
      moduleHook.uninstall();
      fsPatch.uninstall();
      k.close();
      rm(root);
    });

    it('node:fs reads what the path names: a namespace is no routing boundary', () => {
      const hidden = at('ro', 'h.bin');
      assert.throws(() => fs.readFileSync(hidden), { code: 'EACCES' });
      for (const form of [
        `\\\\?\\${hidden}`,
        `//?/${hidden.replace(/\\/g, '/')}`,
      ]) {
        assert.equal(fs.readFileSync(form, 'utf8'), 'hidden', form);
      }
    });

    it('through an admin share too', (t) => {
      const form = adminShare(at('ro', 'h.bin'));
      if (!onDisk(form)) {
        t.skip('the admin share is not available');
        return;
      }
      assert.equal(fs.readFileSync(form, 'utf8'), 'hidden');
    });

    // Node's loader takes a share by its address — not `\\?\`, which its
    // realpath fails, nor `localhost`, which a file: URL drops.
    it("require loads what Node's loader finds there", (t) => {
      const side = at('lib', 'side.js');
      const share = adminShare(side).replace('localhost', '127.0.0.1');
      if (!onDisk(share)) {
        t.skip('the admin share is not available');
        return;
      }
      assert.equal(require(share), 'raw');
      assert.equal(require(side), 'prepared');
      delete globalThis.__smfsSide;
    });
  },
);

describe('Windows, strict: an appRoot on a share', { skip: NAMESPACES }, () => {
  it('routes the paths below it in any case, refuses its other UNC spellings', async (t) => {
    const local = writeTree(tmpDir('ns-share'), NS_TREE);
    const share = adminShare(local);
    if (!onDisk(share)) {
      rm(local);
      t.skip('the admin share is not available');
      return;
    }
    const options = { preparers: PREPARERS };
    const k = await kernel(share, NS_PLACES, { strict: true }, options);
    fsPatch.install(k);
    try {
      const a = path.join(share, 'ro', 'a.txt');
      const upper = path.join(share.toUpperCase(), 'RO', 'a.txt');
      const spellings = [a, upper, a.replace(/\\/g, '/')];
      for (const file of spellings) {
        assert.equal(fs.readFileSync(file, 'utf8'), 'RAW', file);
      }
      const hidden = path.join(share, 'ro', 'h.bin');
      assert.throws(
        () => fs.readFileSync(hidden),
        refused('EACCES', 'open', hidden),
      );
      const others = [
        `\\\\?\\UNC${hidden.slice(1)}`,
        hidden.replace('\\\\localhost\\', '\\\\127.0.0.1\\'),
        `\\\\?\\${path.join(local, 'ro', 'a.txt')}`,
      ];
      for (const other of others) {
        assert.throws(
          () => fs.readFileSync(other),
          refused('EACCES', 'open', other),
        );
      }
    } finally {
      fsPatch.uninstall();
      k.close();
      rm(local);
    }
  });
});
