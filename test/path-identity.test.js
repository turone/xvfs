'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const fsPatch = require('../lib/adapters/fs-patch.js');
const moduleHook = require('../lib/adapters/module-hook.js');
const { tmpDir, writeTree, rm, kernel, drain } = require('./helpers.js');
const {
  refused,
  countNative,
  refusesEach,
  refusesPairs,
  FILE_READS,
  DIR_READS,
  FILE_MUTATIONS,
  DIR_MUTATIONS,
  PAIRS,
} = require('./fs-calls.js');

// The disk as it is, behind the patch: captured before any install.
const {
  existsSync: onDisk,
  readFileSync: readDisk,
  readdirSync: listDisk,
} = fs;

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

// Whether Node's loader itself — in a process without this library — loads
// CommonJS from `file` on a share. Node 26.10 does not: its lookup of the
// nearest package.json walks past the share's root and fails with
// ERR_INVALID_PACKAGE_CONFIG, whatever the module hooks do.
const loadsFromShare = (file) =>
  spawnSync(process.execPath, ['-e', `require(${JSON.stringify(file)})`])
    .status === 0;

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

// A server that does not exist: strict asks no network about it.
const NO_HOST = 'smfs-no-such-host.invalid';

// A path on a drive in the UNC and namespace spellings Windows takes for
// it: the NT prefix and the device namespace, with `\` or `/`; the root of
// the object namespace; an admin share by name and by address, with `\`
// or `/`, and behind either prefix; a server that does not exist.
const namespaceForms = (abs) => {
  const slashed = (s) => s.replace(/\\/g, '/');
  const share = `${abs[0]}$${abs.slice(2)}`;
  return [
    `\\\\?\\${abs}`,
    `//?/${slashed(abs)}`,
    `\\\\.\\${abs}`,
    `//./${slashed(abs)}`,
    `\\??\\${abs}`,
    `/??/${slashed(abs)}`,
    `\\\\?\\GLOBALROOT\\??\\${abs}`,
    `\\\\localhost\\${share}`,
    `//localhost/${slashed(share)}`,
    `\\\\127.0.0.1\\${share}`,
    `//127.0.0.1/${slashed(share)}`,
    `\\\\?\\UNC\\localhost\\${share}`,
    `\\\\.\\UNC\\localhost\\${share}`,
    `\\\\${NO_HOST}\\share${abs.slice(2)}`,
  ];
};

// Every family over every spelling of the targets: EACCES, the path as
// given.
const refusesAll = (families, targets) =>
  refusesEach(families, targets.flatMap(namespaceForms));

const NS_PLACES = {
  ro: PLACES.ro,
  rw: PLACES.rw,
  v: PLACES.v,
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
    let outside;
    let k;
    let native;
    const at = (...p) => path.join(root, ...p);

    before(async () => {
      root = writeTree(tmpDir('ns'), NS_TREE);
      outside = tmpDir('ns-outside');
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
      rm(outside);
      delete globalThis.__smfsSide;
    });

    it('reads, listings and watches in every form: EACCES, nothing reaches node:fs', async () => {
      native.calls.length = 0;
      const files = [
        at('ro', 'h.bin'),
        at('ro', 'a.txt'),
        at('lib', 'side.js'),
      ];
      // What lies outside appRoot is refused in such a form too.
      await refusesAll(FILE_READS, [...files, path.resolve(__filename)]);
      const dirs = [at('ro'), at('rw'), root, path.dirname(root)];
      await refusesAll(DIR_READS, dirs);
      for (const file of [...files, path.resolve(__filename)]) {
        for (const p of namespaceForms(file)) {
          assert.equal(fs.existsSync(p), false, p);
        }
      }
      assert.deepEqual(native.calls, []);
    });

    it('writes, removals and metadata in every form: EACCES, nothing changes', async () => {
      native.calls.length = 0;
      const files = [at('rw', 'w.txt'), at('rw', 'new.txt'), at('ro', 'a.txt')];
      await refusesAll(FILE_MUTATIONS, [...files, at('v', 'x.txt')]);
      await refusesAll(DIR_MUTATIONS, [at('rw', 'd'), at('rw'), root]);
      assert.deepEqual(native.calls, []);
      assert.equal(readDisk(at('rw', 'w.txt'), 'utf8'), 'w');
      assert.equal(readDisk(at('ro', 'a.txt'), 'utf8'), 'raw');
      assert.equal(onDisk(at('rw', 'new.txt')), false);
      assert.equal(onDisk(at('rw', 'd')), false);
      assert.deepEqual(k.fs('v').readdir('/'), []);
    });

    it('copies, renames and links from or to such a form: EACCES, nothing moves', async () => {
      native.calls.length = 0;
      const w = at('rw', 'w.txt');
      const plain = [
        [w, at('rw', 'z.txt')],
        [at('ro', 'a.txt'), path.join(outside, 'a.txt')],
        [__filename, path.join(outside, 'here.js')],
      ];
      for (const [from, to] of plain) {
        for (const form of namespaceForms(from)) {
          for (const [call, syscall, run] of PAIRS) {
            await assert.rejects(
              async () => run(form, to),
              refused('EACCES', syscall, form, to),
              `${call} ${form}`,
            );
          }
        }
      }
      for (const into of namespaceForms(at('rw', 'into.txt'))) {
        for (const [call, syscall, run] of PAIRS) {
          // A recursive copy of a place's disk is refused before its
          // destination is looked at: its walk would follow links.
          const code = call === 'cpSync recursive' ? 'ENOTSUP' : 'EACCES';
          await assert.rejects(
            async () => run(w, into),
            refused(code, syscall, w, into),
            `${call} to ${into}`,
          );
        }
      }
      assert.deepEqual(native.calls, []);
      assert.equal(readDisk(w, 'utf8'), 'w');
      for (const name of ['z.txt', 'into.txt']) {
        assert.equal(onDisk(at('rw', name)), false, name);
      }
      assert.deepEqual(fs.readdirSync(outside), []);
    });

    it('require and import: not found, never loaded', async () => {
      const side = at('lib', 'side.js');
      for (const form of namespaceForms(side)) {
        assert.throws(() => require(form), {
          code: 'MODULE_NOT_FOUND',
          message: /\(vfs: not published\)/,
        });
      }
      // An import names a form where a file: URL keeps it: an address, a
      // server that does not exist.
      let imported = 0;
      for (const form of namespaceForms(at('lib', 'e.mjs'))) {
        let url = null;
        try {
          url = pathToFileURL(form).href;
          if (fileURLToPath(url) !== form) continue;
        } catch {
          continue;
        }
        imported++;
        await assert.rejects(import(url), {
          code: 'ERR_MODULE_NOT_FOUND',
          message: /\(vfs: not published\)/,
        });
      }
      assert.ok(imported >= 2, `${imported} forms kept by a file: URL`);
      assert.equal(globalThis.__smfsSide, undefined);
      assert.equal(globalThis.__smfsEsm, undefined);
      assert.equal(require(side), 'prepared');
    });

    // The path in an error is the caller's, verbatim: not lower-cased, not
    // resolved, not the key of the entry it names.
    it('an error names the path as the caller spelled it', () => {
      const upper = path.join(root.toUpperCase(), 'RO');
      const read = (p) => fs.readFileSync(p);
      const cases = [
        ['EACCES', 'open', `\\\\?\\${path.join(upper, 'H.bin')}`, read],
        ['EACCES', 'open', adminShare(path.join(upper, 'a.TXT')), read],
        ['EACCES', 'open', `//?/${upper.replace(/\\/g, '/')}/a.TXT`, read],
        // A key in another case: strict and 'deny' refuse it.
        ['EACCES', 'open', at('ro', 'A.TXT'), read],
        [
          'EROFS',
          'open',
          path.join(upper, 'X.txt'),
          (p) => fs.writeFileSync(p, 'x'),
        ],
      ];
      const reason = {
        EACCES: 'permission denied',
        EROFS: 'read-only file system',
      };
      for (const [code, syscall, given, run] of cases) {
        assert.notEqual(given, given.toLowerCase());
        assert.throws(
          () => run(given),
          (err) => {
            assert.equal(err.code, code, given);
            assert.equal(err.path, given);
            const message = `${code}: ${reason[code]}, ${syscall} '${given}'`;
            assert.equal(err.message, message);
            return true;
          },
        );
      }
      const from = path.join(upper, 'a.TXT');
      const to = path.join(upper, 'B.txt');
      assert.throws(() => fs.renameSync(from, to), {
        code: 'EROFS',
        path: from,
        dest: to,
        message: `EROFS: read-only file system, rename '${from}' -> '${to}'`,
      });
      const spec = `\\\\?\\${path.join(root.toUpperCase(), 'LIB', 'Side.js')}`;
      assert.throws(
        () => require(spec),
        (err) => {
          assert.equal(err.code, 'MODULE_NOT_FOUND');
          const named = `Cannot find module '${spec}' imported from `;
          assert.ok(err.message.startsWith(named), err.message);
          assert.ok(err.message.endsWith(' (vfs: not published)'));
          return true;
        },
      );
    });

    it('a path on a drive outside appRoot is node:fs as before', () => {
      native.calls.length = 0;
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
        fs.rmSync(file, { force: true });
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
    // The disk as it answers without the patch, for any spelling but of a
    // server that does not exist.
    const reachable = (abs) =>
      namespaceForms(abs).filter((p) => !p.includes(NO_HOST));
    const outcome = (run) => {
      try {
        return { value: String(run()) };
      } catch (err) {
        return { code: err.code };
      }
    };

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
      delete globalThis.__smfsSide;
    });

    it('node:fs reads what the path names: a namespace is no routing boundary', () => {
      const hidden = at('ro', 'h.bin');
      assert.throws(() => fs.readFileSync(hidden), { code: 'EACCES' });
      for (const form of [
        `\\\\?\\${hidden}`,
        `//?/${hidden.replace(/\\/g, '/')}`,
        `\\\\?\\GLOBALROOT\\??\\${hidden}`,
      ]) {
        assert.equal(fs.readFileSync(form, 'utf8'), 'hidden', form);
      }
      assert.deepEqual(fs.readdirSync(`\\\\?\\${at('ro')}`), [
        'a.txt',
        'h.bin',
      ]);
    });

    it('every form answers as node:fs answers it without the patch', () => {
      for (const file of [at('ro', 'h.bin'), at('ro', 'a.txt')]) {
        for (const p of reachable(file)) {
          const read = (f) => f(p, 'utf8');
          assert.deepEqual(
            outcome(() => read(fs.readFileSync)),
            outcome(() => read(readDisk)),
            p,
          );
          assert.equal(fs.existsSync(p), onDisk(p), p);
        }
      }
      for (const p of reachable(at('ro'))) {
        assert.deepEqual(
          outcome(() => fs.readdirSync(p).join()),
          outcome(() => listDisk(p).join()),
          p,
        );
      }
    });

    it('a write in such a form lands where node:fs puts it', () => {
      fs.writeFileSync(`\\\\?\\${at('ro', 'stray.bin')}`, 'x');
      assert.equal(readDisk(at('ro', 'stray.bin'), 'utf8'), 'x');
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
      if (!loadsFromShare(share)) {
        t.skip("this Node's loader cannot load CommonJS from a share");
        return;
      }
      assert.equal(require(share), 'raw');
      assert.equal(require(side), 'prepared');
    });
  },
);

describe('Windows, strict: an appRoot on a share', { skip: NAMESPACES }, () => {
  it('routes the paths below it in any case, refuses its other UNC spellings', async (t) => {
    const local = writeTree(tmpDir('ns-share'), NS_TREE);
    // By address: a file: URL keeps it, which the module hooks need.
    const share = adminShare(local).replace('localhost', '127.0.0.1');
    if (!onDisk(share)) {
      rm(local);
      t.skip('the admin share is not available');
      return;
    }
    const options = { preparers: PREPARERS };
    const k = await kernel(share, NS_PLACES, { strict: true }, options);
    fsPatch.install(k);
    moduleHook.install(k);
    try {
      const a = path.join(share, 'ro', 'a.txt');
      const upper = path.join(share.toUpperCase(), 'RO', 'a.txt');
      const spellings = [a, upper, a.replace(/\\/g, '/')];
      for (const file of spellings) {
        assert.equal(fs.readFileSync(file, 'utf8'), 'RAW', file);
      }
      assert.deepEqual(fs.readdirSync(share), ['lib', 'ro', 'rw', 'v']);
      const hidden = path.join(share, 'ro', 'h.bin');
      assert.throws(
        () => fs.readFileSync(hidden),
        refused('EACCES', 'open', hidden),
      );
      const fresh = path.join(share, 'RO', 'x.txt');
      assert.throws(
        () => fs.writeFileSync(fresh, 'x'),
        refused('EROFS', 'open', fresh),
      );
      if (loadsFromShare(path.join(share, 'lib', 'side.js'))) {
        assert.equal(require(path.join(share, 'LIB', 'side.js')), 'prepared');
      } else {
        t.diagnostic("this Node's loader cannot load CommonJS from a share");
      }
      const others = [
        `\\\\?\\UNC${hidden.slice(1)}`,
        hidden.replace('\\\\127.0.0.1\\', '\\\\localhost\\'),
        `\\\\?\\${path.join(local, 'ro', 'a.txt')}`,
        path.join(share, '..', 'other', 'x'),
      ];
      for (const other of others) {
        assert.throws(
          () => fs.readFileSync(other),
          refused('EACCES', 'open', other),
        );
      }
      const module = adminShare(path.join(local, 'lib', 'side.js'));
      assert.throws(() => require(module), { code: 'MODULE_NOT_FOUND' });
    } finally {
      moduleHook.uninstall();
      fsPatch.uninstall();
      k.close();
      rm(local);
      delete globalThis.__smfsSide;
    }
  });
});

// NTFS takes a `:` past the drive for a stream of the file or directory
// before it: `…\a.txt::$DATA` is a.txt itself, `appRoot::$INDEX_ALLOCATION`
// appRoot. Under strict such a path is refused before any native I/O,
// below appRoot or not; without strict it passes through as before. The
// PlaceFs facade serves no disk-territory file behind a stream, in either
// mode: a cached extension is never read from disk through it.

const STREAM_PLACES = {
  ro: PLACES.ro,
  terr: PLACES.terr,
  rw: PLACES.rw,
  v: PLACES.v,
  lib: { require: { prepare: 'mod' }, import: { ext: ['mjs'] } },
};

const STREAM_TREE = {
  'ro/a.txt': 'raw',
  'ro/h.bin': 'hidden',
  'terr/t.txt': 'raw',
  'terr/m.bin': 'media',
  'rw/w.txt': 'w',
  'lib/side.js': NS_TREE['lib/side.js'],
  'lib/e.mjs': NS_TREE['lib/e.mjs'],
};

// A file's streams: its main one, a named one, typed; a directory's index
// as a name, and the paths through it.
const fileStreams = (f) => [`${f}::$DATA`, `${f}:s`, `${f}:s:$DATA`];
const dirStreams = (d) => [
  `${d}::$INDEX_ALLOCATION`,
  `${d}:$I30:$INDEX_ALLOCATION`,
];
const through = (d, ...rest) => dirStreams(d).map((s) => path.join(s, ...rest));

describe('Windows, strict: NTFS stream spellings', { skip: NAMESPACES }, () => {
  let root;
  let outside;
  let k;
  let native;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    root = writeTree(tmpDir('streams'), STREAM_TREE);
    outside = writeTree(tmpDir('streams-outside'), { 'o.txt': 'o' });
    const options = { preparers: PREPARERS };
    k = await kernel(root, STREAM_PLACES, { strict: true }, options);
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
    rm(outside);
    delete globalThis.__smfsSide;
    delete globalThis.__smfsEsm;
  });

  it('reads, listings and watches: EACCES, nothing reaches node:fs', async () => {
    native.calls.length = 0;
    const files = [
      at('ro', 'h.bin'),
      at('terr', 't.txt'),
      at('terr', 'm.bin'),
      at('lib', 'side.js'),
      path.join(outside, 'o.txt'),
    ];
    const spellings = [
      ...files.flatMap(fileStreams),
      ...through(root, 'ro', 'h.bin'),
      ...through(at('terr'), 't.txt'),
      ...through(path.dirname(root), path.basename(root), 'ro', 'h.bin'),
      at('ro', 'x:stream'),
    ];
    await refusesEach(FILE_READS, spellings);
    const dirs = [
      ...dirStreams(root),
      ...dirStreams(at('ro')),
      ...dirStreams(at('terr')),
      ...dirStreams(path.dirname(root)),
      ...through(root, 'rw'),
    ];
    await refusesEach(DIR_READS, dirs);
    for (const p of [...spellings, ...dirs]) {
      assert.equal(fs.existsSync(p), false, p);
    }
    assert.deepEqual(native.calls, []);
  });

  it('writes, removals and metadata: EACCES, nothing changes', async () => {
    native.calls.length = 0;
    const files = [
      ...fileStreams(at('rw', 'w.txt')),
      ...fileStreams(at('ro', 'a.txt')),
      ...fileStreams(at('v', 'x.txt')),
      ...through(root, 'rw', 'n.txt'),
      at('rw', 'x:stream'),
      `${path.join(outside, 'o.txt')}:s`,
    ];
    await refusesEach(FILE_MUTATIONS, files);
    const dirs = [
      ...dirStreams(at('rw')),
      ...through(root, 'rw', 'd'),
      ...dirStreams(root),
    ];
    await refusesEach(DIR_MUTATIONS, dirs);
    assert.deepEqual(native.calls, []);
    assert.equal(readDisk(at('rw', 'w.txt'), 'utf8'), 'w');
    assert.equal(readDisk(at('ro', 'a.txt'), 'utf8'), 'raw');
    assert.deepEqual(listDisk(at('rw')), ['w.txt']);
    assert.equal(onDisk(`${at('rw', 'w.txt')}:s`), false);
    assert.equal(onDisk(`${path.join(outside, 'o.txt')}:s`), false);
    assert.deepEqual(k.fs('v').readdir('/'), []);
  });

  it('copies, renames and links from or to a stream: EACCES, nothing moves', async () => {
    native.calls.length = 0;
    const w = at('rw', 'w.txt');
    await refusesPairs([
      [`${w}::$DATA`, at('rw', 'z.txt')],
      [path.join(`${root}::$INDEX_ALLOCATION`, 'ro', 'h.bin'), outside],
      [`${at('terr', 't.txt')}::$DATA`, path.join(outside, 't.txt')],
      [`${path.join(outside, 'o.txt')}::$DATA`, path.join(outside, 'p.txt')],
      [__filename, `${w}:s`],
      [__filename, path.join(`${root}::$INDEX_ALLOCATION`, 'rw', 'i.txt')],
    ]);
    assert.deepEqual(native.calls, []);
    assert.equal(readDisk(w, 'utf8'), 'w');
    assert.deepEqual(listDisk(at('rw')), ['w.txt']);
    assert.deepEqual(listDisk(outside), ['o.txt']);
  });

  it('require and import: not found, never loaded', async () => {
    const side = at('lib', 'side.js');
    const sides = [...fileStreams(side), ...through(root, 'lib', 'side.js')];
    for (const form of sides) {
      assert.throws(() => require(form), {
        code: 'MODULE_NOT_FOUND',
        message: /\(vfs: not published\)/,
      });
    }
    const esm = at('lib', 'e.mjs');
    for (const form of [`${esm}::$DATA`, ...through(root, 'lib', 'e.mjs')]) {
      await assert.rejects(import(pathToFileURL(form).href), {
        code: 'ERR_MODULE_NOT_FOUND',
        message: /\(vfs: not published\)/,
      });
    }
    assert.equal(globalThis.__smfsSide, undefined);
    assert.equal(globalThis.__smfsEsm, undefined);
    assert.equal(require(side), 'prepared');
  });

  it('a relative stream, through the cwd, is refused too', () => {
    native.calls.length = 0;
    const cwd = process.cwd();
    process.chdir(at('terr'));
    try {
      for (const p of ['t.txt::$DATA', 'm.bin:s', '..\\ro\\h.bin::$DATA']) {
        assert.throws(() => fs.readFileSync(p), refused('EACCES', 'open', p));
      }
    } finally {
      process.chdir(cwd);
    }
    assert.deepEqual(native.calls, []);
  });

  it('the facade serves no disk-territory file behind a stream', () => {
    const terr = k.fs('terr');
    for (const key of ['/t.txt::$DATA', '/m.bin::$DATA', '/m.bin:s']) {
      assert.equal(terr.readFile(key), null, key);
      assert.equal(terr.stat(key), null, key);
      assert.equal(terr.exists(key), false, key);
    }
    assert.equal(terr.readFile('/m.bin', 'utf8'), 'media');
  });
});

describe(
  'Windows, without strict: stream spellings pass through as before',
  { skip: NAMESPACES },
  () => {
    let root;
    let k;
    const at = (...p) => path.join(root, ...p);

    before(async () => {
      root = writeTree(tmpDir('streams-open'), STREAM_TREE);
      k = await kernel(root, STREAM_PLACES, {}, { preparers: PREPARERS });
      fsPatch.install(k);
    });

    after(() => {
      fsPatch.uninstall();
      k.close();
      rm(root);
    });

    it('node:fs reads what the path names: the raw file behind a stream', (t) => {
      const main = `${at('terr', 't.txt')}::$DATA`;
      if (!onDisk(main)) {
        t.skip('the temporary directory keeps no NTFS streams');
        return;
      }
      assert.equal(fs.readFileSync(main, 'utf8'), 'raw');
      const hidden = path.join(`${root}::$INDEX_ALLOCATION`, 'ro', 'h.bin');
      assert.equal(fs.readFileSync(hidden, 'utf8'), 'hidden');
      assert.throws(() => fs.readFileSync(at('ro', 'h.bin')), {
        code: 'EACCES',
      });
    });

    it('the facade serves no disk-territory file behind a stream', () => {
      const terr = k.fs('terr');
      for (const key of ['/t.txt::$DATA', '/m.bin::$DATA']) {
        assert.equal(terr.readFile(key), null, key);
        assert.equal(terr.stat(key), null, key);
      }
      assert.equal(terr.readFile('/t.txt', 'utf8'), 'RAW');
    });
  },
);

// A short (8.3) name may stand for any long name of its directory. Under
// strict a name of that form below appRoot, or where a path leaves
// appRoot's spelling, is refused before any native I/O; an appRoot given
// with short names routes the paths spelled as it is. The names are the
// volume's own, as cmd gives them (`%~s`); where the volume of the
// temporary directory generates none, the tests skip.

// The 8.3 spelling Windows gives an existing path, or null without one.
const shortPath = (p) => {
  const { stdout } = spawnSync(
    'cmd',
    ['/d', '/c', `for %I in ("${p}") do @echo %~sI`],
    { windowsVerbatimArguments: true, encoding: 'utf8' },
  );
  const short = stdout.trim();
  return short && short.toLowerCase() !== p.toLowerCase() ? short : null;
};
const NO_SHORT_NAMES =
  'the volume of the temporary directory makes no 8.3 names';

const SHORT_PLACES = {
  ro: PLACES.ro,
  terr: {
    fs: { ext: ['html'], fallback: 'disk', prepare: { mark: ['html'] } },
  },
  rw: PLACES.rw,
  v: PLACES.v,
  lib: { require: { prepare: 'mod' }, import: { ext: ['mjs'] } },
};

const SHORT_TREE = {
  'ro/a.txt': 'raw',
  'ro/h.bin': 'hidden',
  'terr/index.html': 'raw',
  'terr/subdirectory/m.bin': 'media',
  'rw/w.txt': 'w',
  'lib/side.js': NS_TREE['lib/side.js'],
  'lib/e.mjs': NS_TREE['lib/e.mjs'],
  'lib/long-module-name.js': "module.exports = 'raw';",
};

describe('Windows, strict: short (8.3) names', { skip: NAMESPACES }, () => {
  let root;
  let short; // root by its 8.3 name
  let names; // 8.3 names inside the places
  let outside;
  let k;
  let native;
  const at = (...p) => path.join(root, ...p);
  const briefly = (...p) => path.join(short, ...p);
  const shortName = (...p) => {
    const spelled = shortPath(at(...p));
    return spelled && path.basename(spelled);
  };

  before(async () => {
    root = writeTree(tmpDir('short-names'), SHORT_TREE);
    outside = tmpDir('short-names-outside');
    short = shortPath(root);
    names = {
      index: shortName('terr', 'index.html'),
      subdirectory: shortName('terr', 'subdirectory'),
      module: shortName('lib', 'long-module-name.js'),
    };
    const options = { preparers: PREPARERS };
    k = await kernel(root, SHORT_PLACES, { strict: true }, options);
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
    rm(outside);
    delete globalThis.__smfsSide;
    delete globalThis.__smfsEsm;
  });

  it('reads, listings and watches: EACCES, nothing reaches node:fs', async (t) => {
    if (!short || Object.values(names).includes(null)) {
      return void t.skip(NO_SHORT_NAMES);
    }
    native.calls.length = 0;
    const files = [
      briefly('ro', 'h.bin'),
      briefly('ro', 'a.txt'),
      briefly('terr', 'subdirectory', 'm.bin'),
      shortPath(at('ro', 'h.bin')),
      at('terr', names.index),
      at('terr', names.subdirectory, 'm.bin'),
    ];
    await refusesEach(FILE_READS, files);
    const dirs = [short, briefly('ro'), at('terr', names.subdirectory)];
    await refusesEach(DIR_READS, dirs);
    for (const p of [...files, ...dirs]) {
      assert.equal(fs.existsSync(p), false, p);
    }
    assert.deepEqual(native.calls, []);
  });

  it('writes, removals and metadata: EACCES, nothing changes', async (t) => {
    if (!short) return void t.skip(NO_SHORT_NAMES);
    native.calls.length = 0;
    const files = [
      briefly('rw', 'w.txt'),
      briefly('rw', 'n.txt'),
      briefly('ro', 'a.txt'),
      briefly('v', 'x.txt'),
    ];
    if (names.index) files.push(at('terr', names.index));
    await refusesEach(FILE_MUTATIONS, files);
    await refusesEach(DIR_MUTATIONS, [
      briefly('rw', 'd'),
      briefly('rw'),
      short,
    ]);
    assert.deepEqual(native.calls, []);
    assert.equal(readDisk(at('rw', 'w.txt'), 'utf8'), 'w');
    assert.equal(readDisk(at('ro', 'a.txt'), 'utf8'), 'raw');
    assert.deepEqual(listDisk(at('rw')), ['w.txt']);
    assert.deepEqual(k.fs('v').readdir('/'), []);
  });

  it('copies, renames and links in 8.3 spelling: EACCES, nothing moves', async (t) => {
    if (!short) return void t.skip(NO_SHORT_NAMES);
    native.calls.length = 0;
    const pairs = [
      [briefly('rw', 'w.txt'), at('rw', 'z.txt')],
      [briefly('ro', 'h.bin'), path.join(outside, 'h.bin')],
      [__filename, briefly('rw', 'i.txt')],
    ];
    if (names.index) {
      pairs.push([at('terr', names.index), path.join(outside, 'i.html')]);
    }
    await refusesPairs(pairs);
    assert.deepEqual(native.calls, []);
    assert.deepEqual(listDisk(at('rw')), ['w.txt']);
    assert.deepEqual(listDisk(outside), []);
  });

  it('require and import: not found, never loaded', async (t) => {
    if (!short) return void t.skip(NO_SHORT_NAMES);
    const modules = [briefly('lib', 'side.js')];
    if (names.module) modules.push(at('lib', names.module));
    for (const form of modules) {
      assert.throws(() => require(form), {
        code: 'MODULE_NOT_FOUND',
        message: /\(vfs: not published\)/,
      });
    }
    await assert.rejects(import(pathToFileURL(briefly('lib', 'e.mjs')).href), {
      code: 'ERR_MODULE_NOT_FOUND',
      message: /\(vfs: not published\)/,
    });
    assert.equal(globalThis.__smfsSide, undefined);
    assert.equal(globalThis.__smfsEsm, undefined);
  });

  it('the facade serves no disk-territory file by a short name', (t) => {
    if (!names.index) return void t.skip(NO_SHORT_NAMES);
    const terr = k.fs('terr');
    assert.equal(terr.readFile(`/${names.index}`), null);
    assert.equal(terr.stat(`/${names.index}`), null);
    assert.equal(terr.readFile('/index.html', 'utf8'), '<raw>');
    const media = `/${names.subdirectory}/m.bin`;
    assert.equal(terr.readFile(media, 'utf8'), 'media');
  });

  it('an appRoot given by its short name routes its own spelling', async (t) => {
    if (!short) return void t.skip(NO_SHORT_NAMES);
    moduleHook.uninstall();
    fsPatch.uninstall();
    const options = { preparers: PREPARERS };
    const brief = await kernel(short, SHORT_PLACES, { strict: true }, options);
    fsPatch.install(brief);
    try {
      assert.equal(fs.readFileSync(briefly('ro', 'a.txt'), 'utf8'), 'RAW');
      assert.equal(
        fs.readFileSync(briefly('TERR', 'index.html'), 'utf8'),
        '<raw>',
      );
      assert.deepEqual(fs.readdirSync(short), ['lib', 'ro', 'rw', 'terr', 'v']);
      const hidden = briefly('ro', 'h.bin');
      assert.throws(
        () => fs.readFileSync(hidden),
        refused('EACCES', 'open', hidden),
      );
      fs.writeFileSync(briefly('rw', 'n.txt'), 'n');
      assert.equal(readDisk(at('rw', 'n.txt'), 'utf8'), 'n');
      if (names.index) {
        const index = briefly('terr', names.index);
        assert.throws(
          () => fs.readFileSync(index),
          refused('EACCES', 'open', index),
        );
      }
      // The long spelling is appRoot's real path: another name for it.
      for (const p of [
        at('ro', 'h.bin'),
        at('ro', 'a.txt'),
        at('rw', 'w.txt'),
      ]) {
        assert.throws(() => fs.readFileSync(p), refused('EACCES', 'open', p));
      }
      assert.throws(
        () => fs.readdirSync(path.dirname(root), { recursive: true }),
        {
          code: 'ENOTSUP',
        },
      );
    } finally {
      fsPatch.uninstall();
      brief.close();
      fsPatch.install(k);
      moduleHook.install(k);
    }
  });
});

describe(
  'Windows, without strict: short names pass through as before',
  { skip: NAMESPACES },
  () => {
    it('node:fs reads what the path names; the facade no raw cached file', async (t) => {
      const root = writeTree(tmpDir('short-names-open'), SHORT_TREE);
      const k = await kernel(root, SHORT_PLACES, {}, { preparers: PREPARERS });
      fsPatch.install(k);
      try {
        const short = shortPath(root);
        const index = shortPath(path.join(root, 'terr', 'index.html'));
        if (!short || !index) return void t.skip(NO_SHORT_NAMES);
        const hidden = path.join(short, 'ro', 'h.bin');
        assert.equal(fs.readFileSync(hidden, 'utf8'), 'hidden');
        assert.equal(k.fs('terr').readFile(`/${path.basename(index)}`), null);
      } finally {
        fsPatch.uninstall();
        k.close();
        rm(root);
      }
    });
  },
);

// A drive letter may name appRoot, a directory above it or below it
// (`subst`), or its share (`net use`), and appRoot itself may be spelled
// through a junction or a subst drive, its real path then another name for
// it. Under strict every path on such a drive, and the real spelling of
// appRoot, is refused before any native I/O; a drive off appRoot's line
// stays native. The drives are made here and removed in `finally`; where
// Windows makes none, the tests skip.

// A drive letter with nothing behind it.
const freeLetter = () =>
  [...'MNOPQRSTUVWXY'].find((c) => !onDisk(`${c}:\\`)) ?? null;
const subst = (target) => {
  const letter = freeLetter();
  if (letter === null) return null;
  const made = spawnSync('subst', [`${letter}:`, target]).status === 0;
  return made ? letter : null;
};
const unsubst = (letter) => spawnSync('subst', [`${letter}:`, '/D']);
const netUse = (share) => {
  const letter = freeLetter();
  if (letter === null) return null;
  const args = ['use', `${letter}:`, share, '/persistent:no'];
  return spawnSync('net', args).status === 0 ? letter : null;
};
const netDrop = (letter) =>
  spawnSync('net', ['use', `${letter}:`, '/delete', '/y']);

// The native junction maker, captured before any install.
const { symlinkSync: linkDisk, rmdirSync: unlinkDir } = fs;

describe(
  'Windows, strict: drive letters and the real path of appRoot',
  { skip: NAMESPACES },
  () => {
    let root;
    let outside;
    let native;
    const at = (...p) => path.join(root, ...p);

    before(() => {
      root = writeTree(tmpDir('drives'), NS_TREE);
      outside = writeTree(tmpDir('drives-outside'), { 'o.txt': 'o' });
      native = countNative();
    });

    after(() => {
      native.restore();
      rm(root);
      rm(outside);
      delete globalThis.__smfsSide;
    });

    // A strict kernel over `appRoot`, patched in for `run`.
    const strictly = async (appRoot, run) => {
      const options = { preparers: PREPARERS };
      const k = await kernel(appRoot, NS_PLACES, { strict: true }, options);
      fsPatch.install(k);
      moduleHook.install(k);
      try {
        native.calls.length = 0;
        await run(k);
      } finally {
        moduleHook.uninstall();
        fsPatch.uninstall();
        k.close();
      }
    };

    // Everything below `base`, which names appRoot: refused, nothing done.
    const refusedBelow = async (base) => {
      await refusesEach(FILE_READS, [
        path.join(base, 'ro', 'h.bin'),
        path.join(base, 'ro', 'a.txt'),
      ]);
      await refusesEach(DIR_READS, [base, path.join(base, 'rw')]);
      await refusesEach(FILE_MUTATIONS, [path.join(base, 'rw', 'w.txt')]);
      await refusesEach(DIR_MUTATIONS, [path.join(base, 'rw', 'd')]);
      await refusesPairs([
        [path.join(base, 'ro', 'h.bin'), path.join(outside, 'h.bin')],
        [__filename, path.join(base, 'rw', 'n.txt')],
      ]);
      const side = path.join(base, 'lib', 'side.js');
      assert.throws(() => require(side), { code: 'MODULE_NOT_FOUND' });
      assert.equal(globalThis.__smfsSide, undefined);
      assert.deepEqual(native.calls, []);
      assert.equal(readDisk(at('rw', 'w.txt'), 'utf8'), 'w');
      assert.deepEqual(listDisk(at('rw')), ['w.txt']);
      assert.equal(onDisk(path.join(outside, 'h.bin')), false);
    };

    // A subst drive onto `target`, and what lies below `rest` on it names
    // appRoot (null: nothing does, the drive lies below appRoot).
    const substituted = async (t, target, rest) => {
      const letter = subst(target);
      if (letter === null) return void t.skip('subst makes no drive here');
      try {
        await strictly(root, async () => {
          const drive = `${letter}:\\`;
          if (rest !== null) await refusedBelow(path.join(drive, rest));
          await refusesEach(FILE_READS.slice(0, 3), [`${drive}h.bin`]);
          await refusesEach(DIR_READS.slice(0, 1), [drive]);
          assert.deepEqual(native.calls, []);
        });
      } finally {
        unsubst(letter);
      }
    };

    it('a subst drive onto appRoot: EACCES, nothing reaches node:fs', (t) =>
      substituted(t, root, ''));

    it('a subst drive above appRoot: EACCES, nothing reaches node:fs', (t) =>
      substituted(t, path.dirname(root), path.basename(root)));

    it('a subst drive below appRoot: EACCES, nothing reaches node:fs', (t) =>
      substituted(t, at('ro'), null));

    it('a subst drive off the line of appRoot stays native', async (t) => {
      const letter = subst(outside);
      if (letter === null) return void t.skip('subst makes no drive here');
      try {
        await strictly(root, () => {
          assert.equal(fs.readFileSync(`${letter}:\\o.txt`, 'utf8'), 'o');
          assert.deepEqual(fs.readdirSync(`${letter}:\\`), ['o.txt']);
          assert.ok(native.calls.includes('readFileSync'));
        });
      } finally {
        unsubst(letter);
      }
    });

    it('a drive mapped to the share of appRoot: EACCES, nothing reaches node:fs', async (t) => {
      const share = adminShare(root);
      const letter = onDisk(share) ? netUse(share) : null;
      if (letter === null) {
        return void t.skip('no drive maps to the admin share here');
      }
      try {
        await strictly(root, () => refusedBelow(`${letter}:\\`));
      } finally {
        netDrop(letter);
      }
    });

    it('appRoot through a junction: its real path is refused, its spelling routes', async () => {
      const junction = path.join(outside, 'j');
      linkDisk(path.dirname(root), junction, 'junction');
      try {
        const spelled = path.join(junction, path.basename(root));
        await strictly(spelled, async () => {
          assert.equal(
            fs.readFileSync(path.join(spelled, 'ro', 'a.txt'), 'utf8'),
            'RAW',
          );
          await refusedBelow(root);
          assert.throws(
            () => fs.readdirSync(path.dirname(root), { recursive: true }),
            { code: 'ENOTSUP', syscall: 'scandir' },
          );
        });
      } finally {
        unlinkDir(junction);
      }
    });

    it('appRoot on a subst drive: its real path is refused, its spelling routes', async (t) => {
      const letter = subst(path.dirname(root));
      if (letter === null) return void t.skip('subst makes no drive here');
      try {
        const spelled = `${letter}:\\${path.basename(root)}`;
        await strictly(spelled, async () => {
          assert.equal(
            fs.readFileSync(path.join(spelled, 'ro', 'a.txt'), 'utf8'),
            'RAW',
          );
          assert.equal(
            require(path.join(spelled, 'lib', 'side.js')),
            'prepared',
          );
          delete globalThis.__smfsSide;
          native.calls.length = 0;
          await refusedBelow(root);
        });
      } finally {
        unsubst(letter);
      }
    });
  },
);
