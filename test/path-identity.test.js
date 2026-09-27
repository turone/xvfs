'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fsPatch = require('../lib/adapters/fs-patch.js');
const moduleHook = require('../lib/adapters/module-hook.js');
const { tmpDir, writeTree, rm, kernel } = require('./helpers.js');

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
