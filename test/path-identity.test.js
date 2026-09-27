'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const fsPatch = require('../lib/adapters/fs-patch.js');
const moduleHook = require('../lib/adapters/module-hook.js');
const { tmpDir, writeTree, rm, kernel, drain } = require('./helpers.js');

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

// node:fs itself, counted: set before the patch is installed, these are
// the originals it passes a call through to — for every family the tests
// below call, in its sync, callback and promise forms.
const FS_CALLS = [
  ...['readFile', 'stat', 'lstat', 'access', 'realpath', 'open', 'readlink'],
  ...['statfs', 'readdir', 'opendir', 'writeFile', 'appendFile', 'truncate'],
  ...['unlink', 'rm', 'rmdir', 'mkdir', 'utimes', 'lutimes', 'chmod'],
  ...['chown', 'lchown', 'symlink', 'rename', 'copyFile', 'cp', 'link'],
];
const countNative = () => {
  const calls = [];
  const targets = [
    ...FS_CALLS.flatMap((name) => [
      [fs, name, name],
      [fs, `${name}Sync`, `${name}Sync`],
      [fs.promises, name, `promises.${name}`],
    ]),
    ...['watch', 'watchFile', 'existsSync', 'createReadStream'].map((name) => [
      fs,
      name,
      name,
    ]),
    [fs.promises, 'watch', 'promises.watch'],
  ];
  const saved = [];
  for (const [target, name, label] of targets) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    const counted = (...args) => {
      calls.push(label);
      return original.apply(target, args);
    };
    if (original.native) counted.native = original.native;
    target[name] = counted;
    saved.push([target, name, original]);
  }
  const restore = () => {
    for (const [target, name, original] of saved) target[name] = original;
  };
  return { calls, restore };
};

// A callback call, settled as a promise.
const called = (call) =>
  new Promise((resolve, reject) => {
    call((err) => (err ? reject(err) : resolve()));
  });

// A watch not refused is stopped at once: a regression fails, it does not
// keep the process alive.
const watchOnce = (p, options) => fs.watch(p, options).close();
const watchFileOnce = (p) => {
  const listener = () => {};
  fs.watchFile(p, listener);
  fs.unwatchFile(p, listener);
};
const watchNext = (p) => {
  const aborted = new AbortController();
  const watcher = fs.promises.watch(p, { signal: aborted.signal });
  const next = watcher[Symbol.asyncIterator]().next();
  aborted.abort();
  return next;
};

// A write stream, ended: its error, or its finish.
const written = (stream) =>
  new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end('x', (err) => (err ? reject(err) : resolve()));
  });

// The families of node:fs over one path: [call, syscall, run].
const FILE_READS = [
  ['readFileSync', 'open', (p) => fs.readFileSync(p)],
  ['readFile', 'open', (p) => called((cb) => fs.readFile(p, cb))],
  ['promises.readFile', 'open', (p) => fs.promises.readFile(p)],
  ['statSync', 'stat', (p) => fs.statSync(p)],
  ['stat', 'stat', (p) => called((cb) => fs.stat(p, cb))],
  ['promises.stat', 'stat', (p) => fs.promises.stat(p)],
  ['lstatSync', 'lstat', (p) => fs.lstatSync(p)],
  ['promises.lstat', 'lstat', (p) => fs.promises.lstat(p)],
  ['accessSync', 'access', (p) => fs.accessSync(p)],
  ['promises.access', 'access', (p) => fs.promises.access(p)],
  ['realpathSync', 'lstat', (p) => fs.realpathSync(p)],
  ['realpath', 'lstat', (p) => called((cb) => fs.realpath(p, cb))],
  ['promises.realpath', 'lstat', (p) => fs.promises.realpath(p)],
  ['openSync', 'open', (p) => fs.openSync(p)],
  ['open', 'open', (p) => called((cb) => fs.open(p, cb))],
  ['promises.open', 'open', (p) => fs.promises.open(p)],
  ['createReadStream', 'open', (p) => drain(fs.createReadStream(p))],
  ['readlinkSync', 'readlink', (p) => fs.readlinkSync(p)],
  ['promises.readlink', 'readlink', (p) => fs.promises.readlink(p)],
  ['statfsSync', 'statfs', (p) => fs.statfsSync(p)],
  ['watch', 'watch', (p) => watchOnce(p)],
  ['watchFile', 'watch', (p) => watchFileOnce(p)],
  ['promises.watch', 'watch', (p) => watchNext(p)],
];
const DIR_READS = [
  ['readdirSync', 'scandir', (p) => fs.readdirSync(p)],
  [
    'readdirSync recursive',
    'scandir',
    (p) => fs.readdirSync(p, { recursive: true }),
  ],
  ['readdir', 'scandir', (p) => called((cb) => fs.readdir(p, cb))],
  ['promises.readdir', 'scandir', (p) => fs.promises.readdir(p)],
  ['opendirSync', 'opendir', (p) => fs.opendirSync(p)],
  ['promises.opendir', 'opendir', (p) => fs.promises.opendir(p)],
  ['watch recursive', 'watch', (p) => watchOnce(p, { recursive: true })],
];
const FILE_MUTATIONS = [
  ['writeFileSync', 'open', (p) => fs.writeFileSync(p, 'x')],
  ['writeFile', 'open', (p) => called((cb) => fs.writeFile(p, 'x', cb))],
  ['promises.writeFile', 'open', (p) => fs.promises.writeFile(p, 'x')],
  ['appendFileSync', 'open', (p) => fs.appendFileSync(p, 'x')],
  ['promises.appendFile', 'open', (p) => fs.promises.appendFile(p, 'x')],
  ['openSync w', 'open', (p) => fs.openSync(p, 'w')],
  ['promises.open w', 'open', (p) => fs.promises.open(p, 'w')],
  ['createWriteStream', 'open', (p) => written(fs.createWriteStream(p))],
  ['truncateSync', 'open', (p) => fs.truncateSync(p)],
  ['promises.truncate', 'open', (p) => fs.promises.truncate(p)],
  ['unlinkSync', 'unlink', (p) => fs.unlinkSync(p)],
  ['unlink', 'unlink', (p) => called((cb) => fs.unlink(p, cb))],
  ['promises.unlink', 'unlink', (p) => fs.promises.unlink(p)],
  ['rmSync', 'rm', (p) => fs.rmSync(p)],
  ['promises.rm', 'rm', (p) => fs.promises.rm(p)],
  ['utimesSync', 'utime', (p) => fs.utimesSync(p, 1, 1)],
  ['lutimesSync', 'lutime', (p) => fs.lutimesSync(p, 1, 1)],
  ['promises.utimes', 'utime', (p) => fs.promises.utimes(p, 1, 1)],
  ['chmodSync', 'chmod', (p) => fs.chmodSync(p, 0o644)],
  ['promises.chmod', 'chmod', (p) => fs.promises.chmod(p, 0o644)],
  ['chownSync', 'chown', (p) => fs.chownSync(p, 0, 0)],
  ['lchownSync', 'chown', (p) => fs.lchownSync(p, 0, 0)],
  ['symlinkSync', 'symlink', (p) => fs.symlinkSync(__filename, p)],
];
const DIR_MUTATIONS = [
  ['mkdirSync', 'mkdir', (p) => fs.mkdirSync(p)],
  ['mkdirSync recursive', 'mkdir', (p) => fs.mkdirSync(p, { recursive: true })],
  ['promises.mkdir', 'mkdir', (p) => fs.promises.mkdir(p)],
  ['rmdirSync', 'rmdir', (p) => fs.rmdirSync(p)],
  ['promises.rmdir', 'rmdir', (p) => fs.promises.rmdir(p)],
  [
    'rmSync recursive',
    'rm',
    (p) => fs.rmSync(p, { recursive: true, force: true }),
  ],
];
// Over two paths: [call, syscall, run(from, to)].
const PAIRS = [
  ['renameSync', 'rename', (a, b) => fs.renameSync(a, b)],
  ['rename', 'rename', (a, b) => called((cb) => fs.rename(a, b, cb))],
  ['promises.rename', 'rename', (a, b) => fs.promises.rename(a, b)],
  ['copyFileSync', 'copyfile', (a, b) => fs.copyFileSync(a, b)],
  ['promises.copyFile', 'copyfile', (a, b) => fs.promises.copyFile(a, b)],
  ['cpSync', 'cp', (a, b) => fs.cpSync(a, b)],
  ['cpSync recursive', 'cp', (a, b) => fs.cpSync(a, b, { recursive: true })],
  ['promises.cp', 'cp', (a, b) => fs.promises.cp(a, b)],
  ['linkSync', 'link', (a, b) => fs.linkSync(a, b)],
  ['promises.link', 'link', (a, b) => fs.promises.link(a, b)],
];

// Every family over every spelling of the targets: EACCES, the path and
// the destination as given.
const refusesAll = async (families, targets) => {
  for (const target of targets) {
    for (const p of namespaceForms(target)) {
      for (const [call, syscall, run] of families) {
        await assert.rejects(
          async () => run(p),
          refused('EACCES', syscall, p),
          `${call} ${p}`,
        );
      }
    }
  }
};

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
          await assert.rejects(
            async () => run(w, into),
            refused('EACCES', syscall, w, into),
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
      assert.equal(require(path.join(share, 'LIB', 'side.js')), 'prepared');
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
