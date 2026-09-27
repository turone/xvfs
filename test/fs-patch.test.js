'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { finished } = require('node:stream/promises');
const fsPatch = require('../lib/adapters/fs-patch.js');
const { tmpDir, writeTree, rm, kernel, drain } = require('./helpers.js');

// The disk as it is, behind the patch: captured before any install.
const {
  existsSync: onDisk,
  readFileSync: readDisk,
  readdirSync: listDisk,
  writeFileSync: writeDisk,
  realpathSync: realpathDisk,
  realpath: realpathDiskCb,
  openAsBlob: openAsBlobDisk,
} = fs;

// fs-patch executes router decisions; these tests exercise node:fs itself
// while the patch is installed. Suites install/uninstall around themselves.

describe('fs-patch: reads over sab and memory places', () => {
  let root;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    root = writeTree(tmpDir('fspatch'), {
      'pub/index.html': '<h1>x</h1>',
      'pub/sub/a.txt': 'aaa',
      'pub/hidden.bin': 'bin',
      'pub/big.txt': 'B'.repeat(70 * 1024),
      'other/o.txt': 'outside any place',
    });
    k = await kernel(root, {
      pub: { fs: { ext: ['html', 'txt'], zeroCopy: true } },
      mem: { provider: 'map', origin: 'virtual', fs: { writable: true } },
    });
    fsPatch.install(k);
    fsPatch.install(k); // idempotent
  });

  after(() => {
    fsPatch.uninstall();
    fsPatch.uninstall();
    k.close();
    rm(root);
  });

  it('readFile: sync, callback, promises; owned copies; encodings', async () => {
    const file = at('pub', 'index.html');
    const buf = fs.readFileSync(file);
    assert.equal(buf.toString(), '<h1>x</h1>');
    assert.ok(!(buf.buffer instanceof SharedArrayBuffer));
    assert.equal(fs.readFileSync(file, 'utf8'), '<h1>x</h1>');
    assert.equal(fs.readFileSync(file, { encoding: 'utf8' }), '<h1>x</h1>');
    assert.equal(await fs.promises.readFile(file, 'utf8'), '<h1>x</h1>');
    const viaCb = await new Promise((resolve, reject) =>
      fs.readFile(file, 'utf8', (err, data) =>
        err ? reject(err) : resolve(data),
      ),
    );
    assert.equal(viaCb, '<h1>x</h1>');
    assert.equal(
      fs.readFileSync(new URL(`file:///${file.replace(/\\/g, '/')}`), 'utf8'),
      '<h1>x</h1>',
    );
    assert.equal(fs.readFileSync(Buffer.from(file), 'utf8'), '<h1>x</h1>');
  });

  it('an aborted signal stops an async read or write; *Sync forms take none', async () => {
    const file = at('mem', 'signal.txt');
    fs.writeFileSync(file, 'one');
    const signal = AbortSignal.abort();
    for (const run of [
      () => fs.promises.writeFile(file, 'two', { signal }),
      () => fs.promises.appendFile(file, '!', { signal }),
      () => fs.promises.readFile(file, { signal }),
      () => fs.promises.readFile(at('pub', 'index.html'), { signal }),
      () =>
        new Promise((resolve, reject) => {
          fs.writeFile(file, 'two', { signal }, (err) =>
            err ? reject(err) : resolve(),
          );
        }),
    ]) {
      await assert.rejects(run(), (err) => {
        assert.equal(err.name, 'AbortError');
        assert.equal(err.code, 'ABORT_ERR');
        assert.equal(err.cause, signal.reason);
        return true;
      });
    }
    assert.equal(fs.readFileSync(file, 'utf8'), 'one', 'nothing written');
    fs.writeFileSync(file, 'two', { signal });
    assert.equal(fs.readFileSync(file, { encoding: 'utf8', signal }), 'two');
    fs.unlinkSync(file);
  });

  it('passthrough: outside places, disk-backed entries, excluded ext (non-strict)', () => {
    assert.equal(
      fs.readFileSync(at('other', 'o.txt'), 'utf8'),
      'outside any place',
    );
    assert.equal(fs.readFileSync(at('pub', 'big.txt')).length, 70 * 1024);
    assert.equal(fs.readFileSync(at('pub', 'hidden.bin'), 'utf8'), 'bin');
    assert.equal(
      fs.readFileSync(__filename, 'utf8').slice(0, 12),
      "'use strict'",
    );
  });

  it('stat / lstat / existsSync / access / realpath', async () => {
    const file = at('pub', 'sub', 'a.txt');
    const s = fs.statSync(file);
    assert.equal(s.size, 3);
    assert.ok(s.isFile());
    assert.ok(fs.statSync(at('pub', 'sub')).isDirectory());
    assert.ok(fs.lstatSync(at('pub')).isDirectory());
    assert.equal(fs.statSync(file, { bigint: true }).size, 3n);
    assert.ok((await fs.promises.stat(file)).isFile());
    const cb = await new Promise((resolve, reject) =>
      fs.stat(file, (err, st) => (err ? reject(err) : resolve(st))),
    );
    assert.equal(cb.size, 3);
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.existsSync(at('pub', 'sub')), true);
    assert.equal(fs.existsSync(at('pub', 'nope')), false);
    assert.equal(fs.existsSync(at('other', 'o.txt')), true);
    fs.accessSync(file);
    fs.accessSync(file, fs.constants.F_OK);
    fs.accessSync(file, fs.constants.R_OK);
    fs.accessSync(file, fs.constants.F_OK | fs.constants.R_OK);
    assert.throws(() => fs.accessSync(file, fs.constants.W_OK), {
      code: 'EACCES',
    });
    assert.throws(() => fs.accessSync(file, fs.constants.X_OK), {
      code: 'EACCES',
    });
    assert.throws(
      () => fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK),
      { code: 'EACCES' },
    );
    assert.throws(
      () => fs.accessSync(file, fs.constants.R_OK | fs.constants.X_OK),
      { code: 'EACCES' },
    );
    await fs.promises.access(file);
    assert.equal(fs.realpathSync(file), file);
    assert.equal(await fs.promises.realpath(file), file);
    assert.equal(typeof fs.realpathSync.native, 'function');
    assert.throws(() => fs.statSync(at('pub', 'nope')), { code: 'ENOENT' });
    assert.equal(
      fs.statSync(at('pub', 'nope'), { throwIfNoEntry: false }),
      undefined,
    );
  });

  it('readdir: sync, callback, promises, options, ENOTDIR', async () => {
    // hidden.bin is outside fs.ext: listed as disk territory by the
    // non-strict default `fs.fallback: 'disk'`.
    assert.deepEqual(fs.readdirSync(at('pub')), [
      'big.txt',
      'hidden.bin',
      'index.html',
      'sub',
    ]);
    // A recursive listing names its entries with path.sep, as native
    // node:fs does (`sub\a.txt` on Windows), in every encoding; the facade
    // keeps the '/' of its keys.
    const nested = path.join('sub', 'a.txt');
    const recursive = ['big.txt', 'hidden.bin', 'index.html', 'sub', nested];
    assert.deepEqual(fs.readdirSync(at('pub'), { recursive: true }), recursive);
    assert.deepEqual(
      await fs.promises.readdir(at('pub'), { recursive: true }),
      recursive,
    );
    assert.deepEqual(
      fs.readdirSync(at('pub'), { recursive: true, encoding: 'buffer' }),
      recursive.map((name) => Buffer.from(name)),
    );
    assert.deepEqual(k.fs('pub').readdir('/', { recursive: true }), [
      'big.txt',
      'hidden.bin',
      'index.html',
      'sub',
      'sub/a.txt',
    ]);
    const dirents = fs.readdirSync(at('pub'), { withFileTypes: true });
    assert.deepEqual(
      dirents.map((d) => [d.name, d.isDirectory()]),
      [
        ['big.txt', false],
        ['hidden.bin', false],
        ['index.html', false],
        ['sub', true],
      ],
    );
    assert.deepEqual(await fs.promises.readdir(at('pub', 'sub')), ['a.txt']);
    const cb = await new Promise((resolve, reject) =>
      fs.readdir(at('pub', 'sub'), (err, list) =>
        err ? reject(err) : resolve(list),
      ),
    );
    assert.deepEqual(cb, ['a.txt']);
    assert.throws(() => fs.readdirSync(at('pub', 'index.html')), {
      code: 'ENOTDIR',
    });
    assert.throws(() => fs.readFileSync(at('pub', 'sub')), { code: 'EISDIR' });
  });

  it('createReadStream: owned chunks even in a zeroCopy place; errors are emitted', async () => {
    const stream = fs.createReadStream(at('pub', 'sub', 'a.txt'), { start: 1 });
    const data = await drain(stream);
    assert.equal(data.toString(), 'aa');
    const chunks = [];
    for await (const c of fs.createReadStream(at('pub', 'index.html')))
      chunks.push(c);
    // node:fs callers never release a lease: they always get copies.
    assert.ok(!(chunks[0].buffer instanceof SharedArrayBuffer));
    const text = [];
    for await (const s of fs.createReadStream(at('pub', 'index.html'), 'utf8'))
      text.push(s);
    assert.equal(text.join(''), '<h1>x</h1>', 'string options are encoding');
    const bad = fs.createReadStream(at('pub', 'sub'));
    await assert.rejects(drain(bad), { code: 'EISDIR' });
    const passthrough = await drain(fs.createReadStream(at('other', 'o.txt')));
    assert.equal(passthrough.toString(), 'outside any place');
  });

  it('open() has no descriptor for virtual entries', async () => {
    assert.throws(() => fs.openSync(at('pub', 'index.html'), 'r'), {
      code: 'ENOTSUP',
    });
    await assert.rejects(fs.promises.open(at('pub', 'index.html')), {
      code: 'ENOTSUP',
    });
    const fd = fs.openSync(at('other', 'o.txt'), 'r');
    fs.closeSync(fd);
  });

  it('read-only place: mutations fail with EROFS', async () => {
    assert.throws(() => fs.writeFileSync(at('pub', 'new.txt'), 'x'), {
      code: 'EROFS',
    });
    assert.throws(() => fs.unlinkSync(at('pub', 'index.html')), {
      code: 'EROFS',
    });
    assert.throws(() => fs.mkdirSync(at('pub', 'd')), { code: 'EROFS' });
    assert.throws(() => fs.rmSync(at('pub', 'sub'), { recursive: true }), {
      code: 'EROFS',
    });
    assert.throws(
      () => fs.renameSync(at('pub', 'index.html'), at('pub', 'i2.html')),
      { code: 'EROFS' },
    );
    await assert.rejects(fs.promises.appendFile(at('pub', 'index.html'), 'x'), {
      code: 'EROFS',
    });
    const err = await new Promise((resolve) =>
      fs.writeFile(at('pub', 'x'), 'x', resolve),
    );
    assert.equal(err.code, 'EROFS');
    assert.ok(fs.existsSync(at('pub', 'index.html')));
  });

  it('memory place: writeFile / appendFile / unlink / mkdir / rm / rename through node:fs', async () => {
    const mem = at('mem');
    fs.writeFileSync(path.join(mem, 'a.txt'), 'a');
    await fs.promises.appendFile(path.join(mem, 'a.txt'), 'b');
    await new Promise((resolve, reject) =>
      fs.writeFile(path.join(mem, 'dir', 'c.txt'), Buffer.from('c'), (err) =>
        err ? reject(err) : resolve(),
      ),
    );
    assert.equal(fs.readFileSync(path.join(mem, 'a.txt'), 'utf8'), 'ab');
    assert.deepEqual(fs.readdirSync(mem), ['a.txt', 'dir']);
    fs.mkdirSync(path.join(mem, 'whatever'), { recursive: true });
    fs.renameSync(path.join(mem, 'a.txt'), path.join(mem, 'dir', 'a2.txt'));
    assert.deepEqual(fs.readdirSync(path.join(mem, 'dir')), [
      'a2.txt',
      'c.txt',
    ]);
    fs.accessSync(path.join(mem, 'dir', 'c.txt'), fs.constants.W_OK);
    fs.unlinkSync(path.join(mem, 'dir', 'c.txt'));
    assert.throws(() => fs.unlinkSync(path.join(mem, 'dir', 'c.txt')), {
      code: 'ENOENT',
    });
    await fs.promises.rm(path.join(mem, 'dir'), { recursive: true });
    assert.deepEqual(fs.readdirSync(mem), []);
    assert.equal(k.fs('mem').exists('/dir/a2.txt'), false);
  });

  it('rename across places or into disk is EXDEV', () => {
    fs.writeFileSync(at('mem', 'x.txt'), 'x');
    assert.throws(
      () => fs.renameSync(at('mem', 'x.txt'), at('other', 'x.txt')),
      { code: 'EXDEV' },
    );
    assert.throws(
      () => fs.renameSync(at('other', 'o.txt'), at('mem', 'o.txt')),
      { code: 'EXDEV' },
    );
    fs.unlinkSync(at('mem', 'x.txt'));
  });

  it('uninstall restores node:fs', () => {
    fsPatch.uninstall();
    assert.throws(() => fs.readFileSync(at('mem', 'nothing.txt')), {
      code: 'ENOENT',
    });
    fsPatch.install(k);
  });
});

describe('fs-patch: strict routing', () => {
  let root;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    root = writeTree(tmpDir('fspatch-strict'), {
      'pub/index.html': '<h1>x</h1>',
      'pub/hidden.bin': 'bin',
      'pub/big.txt': 'B'.repeat(70 * 1024),
      'lib/util.js': 'exports.x = 1;',
      'uploads/u.txt': 'u',
      'stray/s.txt': 's',
      'stray/sub/deep.txt': 'deep',
      'nd/n.txt': 'n',
      'root-level.txt': 'root level file',
      '..private/secret.txt': 'secret',
      '..cache/c.txt': 'c',
      '...data/d.txt': 'd',
      'pub/..private/p.txt': 'inside pub',
    });
    k = await kernel(
      root,
      {
        pub: { fs: { ext: ['html', 'txt'] } },
        lib: { require: true },
        uploads: { provider: 'disk', fs: { writable: true } },
        ro: { provider: 'disk', fs: true },
        nd: { provider: 'node-default', fs: true },
        mem: { provider: 'map', origin: 'virtual', fs: { writable: true } },
      },
      { strict: true },
    );
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(root);
  });

  it('published entries are served; unpublished paths inside indexed mounts are EACCES', () => {
    assert.equal(
      fs.readFileSync(at('pub', 'index.html'), 'utf8'),
      '<h1>x</h1>',
    );
    assert.throws(
      () => fs.readFileSync(at('pub', 'hidden.bin')),
      { code: 'EACCES' },
      'excluded ext',
    );
    assert.throws(() => fs.readFileSync(at('pub', 'missing.txt')), {
      code: 'EACCES',
    });
    assert.throws(() => fs.statSync(at('pub', 'missing.txt')), {
      code: 'EACCES',
    });
    assert.equal(fs.existsSync(at('pub', 'hidden.bin')), false);
    assert.throws(() => fs.readFileSync(at('mem', 'nope.txt')), {
      code: 'EACCES',
    });
  });

  it('explicit disk entries inside a SAB place are the only disk fallback', () => {
    assert.equal(fs.readFileSync(at('pub', 'big.txt')).length, 70 * 1024);
  });

  // Regression: before the guards these APIs reached libuv directly and
  // read, listed or modified denied paths behind the routing's back. Each now
  // refuses a denied path — opendir is implemented, the others are guarded
  // or refuse managed sources.
  it('path APIs the places do not serve cannot bypass strict routing', async () => {
    const secret = at('lib', 'util.js');
    const outside = path.join(os.tmpdir(), 'vfs-leak-probe.txt');
    assert.throws(() => fs.copyFileSync(secret, outside), { code: 'EACCES' });
    assert.throws(() => fs.cpSync(at('lib'), outside, { recursive: true }), {
      code: 'EACCES',
    });
    assert.throws(() => fs.opendirSync(at('lib')), { code: 'EACCES' });
    assert.throws(() => fs.readlinkSync(secret), { code: 'EACCES' });
    assert.throws(() => fs.statfsSync(at('lib')), { code: 'EACCES' });
    assert.throws(() => fs.rmdirSync(at('stray', 'sub')), { code: 'EACCES' });
    assert.throws(() => fs.truncateSync(secret, 0), { code: 'EACCES' });
    assert.throws(() => fs.utimesSync(secret, new Date(), new Date()), {
      code: 'EACCES',
    });
    assert.throws(() => fs.chmodSync(secret, 0o666), { code: 'EACCES' });
    assert.throws(() => fs.linkSync(secret, outside), { code: 'EACCES' });
    assert.throws(() => fs.symlinkSync(outside, at('stray', 'link')), {
      code: 'EACCES',
    });
    await assert.rejects(fs.promises.opendir(at('lib')), { code: 'EACCES' });
    await assert.rejects(fs.promises.copyFile(secret, outside), {
      code: 'EACCES',
    });
    const viaCb = await new Promise((resolve) =>
      fs.copyFile(secret, outside, resolve),
    );
    assert.equal(viaCb.code, 'EACCES');
    assert.equal(fs.existsSync(outside), false);
    const viaChown = await new Promise((resolve) =>
      fs.chown(secret, 0, 0, resolve),
    );
    assert.equal(viaChown.code, 'EACCES');
    await assert.rejects(fs.promises.chmod(secret, 0o666), { code: 'EACCES' });
    await assert.rejects(fs.promises.truncate(secret, 0), { code: 'EACCES' });
  });

  // glob walks natively here (the test runner loaded it before the patch):
  // a walk into the places is refused; the routed walk is test/glob.test.js.
  it('glob loaded before the patch never walks the places natively', async () => {
    const pattern = path.join(root, '*', '*').replace(/\\/g, '/');
    assert.throws(() => fs.globSync(pattern), {
      code: 'ENOTSUP',
      syscall: 'scandir',
      path: root,
    });
    const viaCb = await new Promise((resolve) => fs.glob(pattern, resolve));
    assert.equal(viaCb.code, 'ENOTSUP');
    await assert.rejects(fs.promises.glob(pattern).next(), {
      code: 'ENOTSUP',
    });
  });

  it('mutating APIs honour a read-only place even without strict', () => {
    assert.throws(() => fs.utimesSync(at('pub', 'index.html'), 1, 1), {
      code: 'EROFS',
    });
    assert.throws(() => fs.chmodSync(at('pub', 'index.html'), 0o666), {
      code: 'EROFS',
    });
    assert.throws(() => fs.rmdirSync(at('ro')), { code: 'EROFS' });
  });

  it('places without fs domain and unknown mounts under appRoot are EACCES', () => {
    assert.throws(() => fs.readFileSync(at('lib', 'util.js')), {
      code: 'EACCES',
    });
    assert.throws(() => fs.readFileSync(at('stray', 's.txt')), {
      code: 'EACCES',
    });
    assert.throws(() => fs.readdirSync(at('stray', 'sub')), { code: 'EACCES' });
    assert.throws(() => fs.writeFileSync(at('stray', 'w.txt'), 'w'), {
      code: 'EACCES',
    });
    assert.throws(() => fs.openSync(at('stray', 's.txt'), 'r'), {
      code: 'EACCES',
    });
    assert.equal(fs.existsSync(at('stray', 's.txt')), false);
  });

  // appRoot is the routing boundary: an unmanaged entry under it is denied at
  // every depth, whether it is a file or a directory. Previously only depth
  // >= 2 was routed, so an unmanaged first-level directory stayed listable and
  // `cp -r` copied its whole subtree out.
  describe('unmanaged paths under appRoot are denied at every depth', () => {
    const outside = () =>
      path.join(os.tmpdir(), `vfs-escape-${process.pid}-${Date.now()}`);

    it('readdir', () => {
      assert.throws(() => fs.readdirSync(at('stray')), { code: 'EACCES' });
      assert.throws(() => fs.readdirSync(at('stray', 'sub')), {
        code: 'EACCES',
      });
      assert.throws(() => fs.readdirSync(at('stray'), { recursive: true }), {
        code: 'EACCES',
      });
    });

    it('opendir', async () => {
      assert.throws(() => fs.opendirSync(at('stray')), { code: 'EACCES' });
      await assert.rejects(fs.promises.opendir(at('stray')), {
        code: 'EACCES',
      });
    });

    it('cp recursive', async () => {
      const dest = outside();
      assert.throws(() => fs.cpSync(at('stray'), dest, { recursive: true }), {
        code: 'EACCES',
      });
      await assert.rejects(
        fs.promises.cp(at('stray'), dest, { recursive: true }),
        { code: 'EACCES' },
      );
      assert.equal(fs.existsSync(dest), false, 'nothing escaped');
    });

    it('glob', () => {
      const pattern = path.join(root, 'stray', '**').replace(/\\/g, '/');
      assert.throws(() => fs.globSync(pattern), {
        code: 'EACCES',
        syscall: 'scandir',
        path: at('stray'),
      });
    });

    it('readFile', () => {
      assert.throws(() => fs.readFileSync(at('stray', 's.txt')), {
        code: 'EACCES',
      });
      assert.throws(() => fs.readFileSync(at('stray', 'sub', 'deep.txt')), {
        code: 'EACCES',
      });
    });

    it('mutation', () => {
      assert.throws(() => fs.writeFileSync(at('stray', 'new.txt'), 'x'), {
        code: 'EACCES',
      });
      assert.throws(() => fs.unlinkSync(at('stray', 's.txt')), {
        code: 'EACCES',
      });
      assert.throws(() => fs.mkdirSync(at('stray', 'sub2')), {
        code: 'EACCES',
      });
      assert.throws(() => fs.rmSync(at('stray'), { recursive: true }), {
        code: 'EACCES',
      });
      assert.ok(onDisk(path.join(root, 'stray', 's.txt')), 'nothing removed');
    });

    it('unmanaged root-level file', () => {
      assert.throws(() => fs.readFileSync(at('root-level.txt')), {
        code: 'EACCES',
      });
      assert.throws(() => fs.statSync(at('root-level.txt')), {
        code: 'EACCES',
      });
      assert.equal(fs.existsSync(at('root-level.txt')), false);
      assert.throws(() => fs.writeFileSync(at('root-level.txt'), 'x'), {
        code: 'EACCES',
      });
    });

    it('unmanaged root-level directory', () => {
      assert.throws(() => fs.statSync(at('stray')), { code: 'EACCES' });
      assert.equal(fs.existsSync(at('stray')), false);
      assert.throws(() => fs.rmdirSync(at('stray')), { code: 'EACCES' });
      assert.throws(() => fs.chmodSync(at('stray'), 0o777), {
        code: 'EACCES',
      });
    });

    it('watch and watchFile cannot probe denied paths', async () => {
      assert.throws(() => fs.watch(at('stray'), () => {}), { code: 'EACCES' });
      assert.throws(() => fs.watch(at('pub', 'missing.txt'), () => {}), {
        code: 'EACCES',
      });
      assert.throws(() => fs.watchFile(at('stray', 's.txt'), () => {}), {
        code: 'EACCES',
      });
      // As in node:fs, fs.promises.watch reports errors when iterated.
      await assert.rejects(fs.promises.watch(at('stray')).next(), {
        code: 'EACCES',
      });
    });

    // Regression: `..private` is a name, not a parent path. It used to be
    // taken for a path outside appRoot and passed through to the disk.
    it('dot-prefixed names under appRoot are unmanaged, not outside', async () => {
      const secret = at('..private', 'secret.txt');
      assert.throws(() => fs.readFileSync(secret), { code: 'EACCES' });
      await assert.rejects(fs.promises.readFile(secret), { code: 'EACCES' });
      assert.equal(fs.existsSync(secret), false);
      assert.throws(() => fs.writeFileSync(at('..private', 'w.txt'), 'x'), {
        code: 'EACCES',
      });
      assert.throws(() => fs.readdirSync(at('..private')), { code: 'EACCES' });
      assert.throws(() => fs.opendirSync(at('..private')), { code: 'EACCES' });
      const dest = outside();
      assert.throws(() => fs.copyFileSync(secret, dest), { code: 'EACCES' });
      assert.equal(fs.existsSync(dest), false);
      assert.throws(() => fs.readFileSync(at('..cache', 'c.txt')), {
        code: 'EACCES',
      });
      assert.throws(() => fs.readFileSync(at('...data', 'd.txt')), {
        code: 'EACCES',
      });
    });

    it('a dot-prefixed directory inside a place belongs to that place', () => {
      assert.equal(
        fs.readFileSync(at('pub', '..private', 'p.txt'), 'utf8'),
        'inside pub',
      );
      assert.deepEqual(fs.readdirSync(at('pub', '..private')), ['p.txt']);
      assert.throws(
        () => fs.writeFileSync(at('pub', '..private', 'w.txt'), ''),
        {
          code: 'EROFS',
        },
      );
    });

    it('paths outside appRoot keep ordinary Node semantics', async () => {
      const dest = outside();
      assert.ok(fs.readFileSync(__filename, 'utf8').length > 0);
      assert.ok(fs.readdirSync(__dirname).includes('fs-patch.test.js'));
      assert.ok(fs.statSync(__dirname).isDirectory());
      assert.equal(fs.existsSync(__filename), true);
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'a.txt'), 'a');
      fs.copyFileSync(path.join(dest, 'a.txt'), path.join(dest, 'b.txt'));
      assert.deepEqual(fs.readdirSync(dest).sort(), ['a.txt', 'b.txt']);
      const dir = fs.opendirSync(dest);
      dir.closeSync();
      const watcher = fs.watch(dest, () => {});
      watcher.close();
      await fs.promises.rm(dest, { recursive: true, force: true });
    });
  });

  it('disk places are managed passthrough with writable policy; node-default is plain', () => {
    assert.equal(fs.readFileSync(at('uploads', 'u.txt'), 'utf8'), 'u');
    fs.writeFileSync(at('uploads', 'w.txt'), 'w');
    assert.equal(fs.readFileSync(at('uploads', 'w.txt'), 'utf8'), 'w');
    assert.throws(
      () => fs.readFileSync(at('ro', 'x.txt')),
      { code: 'ENOENT' },
      'real disk error',
    );
    assert.throws(() => fs.writeFileSync(at('ro', 'x.txt'), 'x'), {
      code: 'EROFS',
    });
    assert.equal(fs.readFileSync(at('nd', 'n.txt'), 'utf8'), 'n');
    fs.writeFileSync(at('nd', 'n2.txt'), 'n2');
    assert.ok(fs.existsSync(at('nd', 'n2.txt')));
  });

  it('paths outside appRoot pass through', () => {
    assert.ok(fs.readFileSync(__filename, 'utf8').length > 0);
    assert.ok(fs.existsSync(__dirname));
  });
});

// A descriptor is the raw file. open() routes its path as a read for what
// the descriptor can read — a hidden path stays EACCES, an entry the place
// serves from the VFS has no descriptor to read, whatever else the flag
// does — and, for a flag that only writes, as a mutation, as writeFile
// does: a read-only place refuses, a virtual place has no raw file, a
// disk-origin place hands out its raw file, which the watcher republishes.
// Before, node:fs created the file in a read-only place and a stray one in
// a virtual place's directory on disk, which the place never shows; then
// every descriptor to a published entry was refused, while writeFileSync
// opened the same raw file.

const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;
// Flags that write and cannot read: no 'r', no '+', O_WRONLY without O_RDWR.
const WRITE_ONLY_FLAGS = [
  'w',
  'wx',
  'a',
  'ax',
  'as',
  O_WRONLY,
  O_WRONLY | O_TRUNC,
  O_WRONLY | O_CREAT | O_TRUNC,
];
// Flags that write and can read.
const READ_WRITE_FLAGS = [
  'w+',
  'a+',
  'r+',
  'rs+',
  O_RDWR,
  O_CREAT,
  O_TRUNC,
  O_APPEND,
];
const WRITE_FLAGS = [...WRITE_ONLY_FLAGS, ...READ_WRITE_FLAGS];
const READ_FLAGS = [undefined, 'r', 'rs', O_RDONLY];

// The arguments after the path: each flag alone and with a mode after it —
// fs.open(p, 'w', 0o600, callback) included — and, to read, none at all.
const withMode = (flags) => flags.flatMap((flag) => [[flag], [flag, 0o600]]);
const WRITES = withMode(WRITE_FLAGS);
const WRITE_ONLY = withMode(WRITE_ONLY_FLAGS);
const READ_WRITES = withMode(READ_WRITE_FLAGS);
const READS = [[], ...withMode(READ_FLAGS)];

// open() in each form — sync, callback, promise — with `args` after the
// path, closing what it opens: 'ok' or the error, per form.
const openEach = async (file, args) => {
  const forms = [
    () => fs.closeSync(fs.openSync(file, ...args)),
    () =>
      new Promise((resolve, reject) => {
        fs.open(file, ...args, (err, fd) =>
          err ? reject(err) : resolve(fs.closeSync(fd)),
        );
      }),
    async () => (await fs.promises.open(file, ...args)).close(),
  ];
  const outcomes = [];
  for (const form of forms) {
    try {
      await form();
      outcomes.push('ok');
    } catch (err) {
      outcomes.push(err);
    }
  }
  return outcomes;
};

// An open() that failed: its code, syscall and path, no dest; `detail`
// tells the ENOTSUP of a virtual place from that of a virtual file.
const refused = (err, { code, file, detail, args }) => {
  const what = `${file} [${args.map(String)}]: ${err?.message ?? err}`;
  assert.ok(err instanceof Error, what);
  assert.equal(err.code, code, what);
  assert.equal(err.syscall, 'open', what);
  assert.equal(err.path, file, what);
  assert.equal(err.dest, undefined, what);
  if (detail) assert.ok(err.message.includes(`(${detail})`), what);
};

// Every form of open(), with each of `argsList`, fails so.
const refusedEach = async (file, argsList, expected) => {
  for (const args of argsList) {
    for (const outcome of await openEach(file, args)) {
      refused(outcome, { ...expected, file, args });
    }
  }
};

describe('fs-patch: open with a flag that writes', () => {
  let root;
  let outside;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    outside = writeTree(tmpDir('fspatch-open-out'), { 'a.txt': 'published' });
    root = writeTree(tmpDir('fspatch-open'), {
      'ro/a.txt': 'published',
      'ro/raw.bin': 'raw', // not cached: the disk territory
      'ro/big.txt': 'B'.repeat(70 * 1024), // over maxFileSize: a disk entry
      'site/a.txt': 'published',
      'site/b.txt': 'published',
      'prep/a.txt': 'published', // prepared: served upper-case
      'drive/d.txt': 'disk',
    });
    // The directories of the virtual places exist on disk, without a file;
    // v/sub is a directory the place does not have.
    fs.mkdirSync(at('v', 'sub'), { recursive: true });
    fs.mkdirSync(at('m'));
    k = await kernel(
      root,
      {
        ro: { fs: { ext: ['txt'] } },
        site: { fs: { ext: ['txt'], writable: true } },
        prep: { fs: { ext: ['txt'], writable: true, prepare: 'upper' } },
        drive: { provider: 'disk', fs: true },
        v: { origin: 'virtual', fs: { writable: true } },
        m: { provider: 'map', origin: 'virtual', fs: { writable: true } },
      },
      { watchTimeout: 60000 },
      { preparers: { upper: (raw) => raw.toString().toUpperCase() } },
    );
    k.fs('m').writeFile('/p.txt', 'virtual');
    await k.fs('v').writeFile('/p.txt', 'virtual');
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(root);
    rm(outside);
  });

  it('a read-only place is EROFS, without strict: nothing created or changed', async () => {
    for (const file of [at('ro', 'new.txt'), at('drive', 'new.txt')]) {
      await refusedEach(file, WRITES, { code: 'EROFS' });
      assert.equal(onDisk(file), false, file);
    }
    // Its disk territory, its disk entry, and a read-only disk place.
    for (const file of [
      at('ro', 'raw.bin'),
      at('ro', 'big.txt'),
      at('drive', 'd.txt'),
    ]) {
      const bytes = readDisk(file, 'utf8');
      await refusedEach(file, WRITES, { code: 'EROFS' });
      assert.equal(readDisk(file, 'utf8'), bytes, file);
    }
  });

  it('a flag that reads stays native: a descriptor, or the error of the disk', async () => {
    for (const file of [
      at('ro', 'raw.bin'),
      at('ro', 'big.txt'),
      at('drive', 'd.txt'),
    ]) {
      for (const args of READS) {
        assert.deepEqual(await openEach(file, args), ['ok', 'ok', 'ok']);
      }
    }
    const fd = fs.openSync(at('ro', 'big.txt'), 'r');
    assert.equal(fs.fstatSync(fd).size, 70 * 1024);
    fs.closeSync(fd);
    // A missing file is node:fs's own ENOENT, in a virtual place too.
    for (const file of [at('ro', 'missing.txt'), at('m', 'missing.txt')]) {
      await refusedEach(file, READS, { code: 'ENOENT' });
    }
  });

  it('a virtual place is ENOTSUP: no stray file in its directory on disk', async () => {
    for (const file of [
      at('v', 'x.txt'),
      at('v', 'sub', 'x.txt'),
      at('m', 'x.txt'),
    ]) {
      await refusedEach(file, WRITES, {
        code: 'ENOTSUP',
        detail: 'virtual place',
      });
    }
    assert.deepEqual(listDisk(at('v'), { recursive: true }), ['sub']);
    assert.deepEqual(listDisk(at('m')), []);
    for (const name of ['v', 'm']) {
      const entries = k.fs(name).readdir('/', { recursive: true });
      assert.deepEqual(entries, ['p.txt'], name);
    }
  });

  it('a published virtual entry is ENOTSUP whatever the flag, as before', async () => {
    const expected = { code: 'ENOTSUP', detail: 'virtual file' };
    for (const name of ['v', 'm']) {
      await refusedEach(at(name, 'p.txt'), [...READS, ...WRITES], expected);
      assert.equal(k.fs(name).readFile('/p.txt', 'utf8'), 'virtual', name);
    }
  });

  // The watcher publishes what the descriptor wrote: one epoch by hand.
  const republish = async (file) => {
    k.watcher.emit('epoch', new Map([[file, 'change']]));
    await k.watchQueue.idle;
  };

  it('a published disk-origin entry: no descriptor reads it, one that only writes is its raw file', async () => {
    const content = { code: 'ENOTSUP', detail: 'virtual file' };
    // A flag that can read — `r`, `+`, `O_RDWR`, `O_CREAT` / `O_TRUNC` /
    // `O_APPEND` without `O_WRONLY` — meets no descriptor, whether it
    // writes too: the raw file is not the canonical content.
    for (const file of [at('ro', 'a.txt'), at('site', 'a.txt')]) {
      await refusedEach(file, [...READS, ...READ_WRITES], content);
      assert.equal(readDisk(file, 'utf8'), 'published', file);
    }
    // Read-only place: its raw file is not writable either.
    await refusedEach(at('ro', 'a.txt'), WRITE_ONLY, { code: 'EROFS' });
    assert.equal(readDisk(at('ro', 'a.txt'), 'utf8'), 'published');
    // Writable place: the raw file, opened as node:fs opens a plain file
    // with the same flag — an exclusive flag meets it (EEXIST), a flag the
    // platform refuses is refused the same way.
    const file = at('site', 'a.txt');
    const plain = path.join(outside, 'a.txt');
    const codes = (outcomes) => outcomes.map((o) => o.code ?? o);
    for (const args of WRITE_ONLY) {
      writeDisk(file, 'published');
      writeDisk(plain, 'published');
      const native = codes(await openEach(plain, args));
      assert.deepEqual(codes(await openEach(file, args)), native, args);
      assert.equal(readDisk(file, 'utf8'), readDisk(plain, 'utf8'), args);
    }
    // Written through the descriptor, the raw file changes at once; the
    // published content follows when the watcher republishes it.
    writeDisk(file, 'published');
    const fd = fs.openSync(file, 'w');
    fs.writeSync(fd, 'edited');
    fs.closeSync(fd);
    assert.equal(readDisk(file, 'utf8'), 'edited');
    assert.equal(fs.readFileSync(file, 'utf8'), 'published');
    await republish(file);
    assert.equal(fs.readFileSync(file, 'utf8'), 'edited');
    const stream = fs.createWriteStream(file);
    stream.end('streamed');
    await finished(stream);
    assert.equal(readDisk(file, 'utf8'), 'streamed');
    await republish(file);
    assert.equal(fs.readFileSync(file, 'utf8'), 'streamed');
  });

  it('no descriptor reads the raw file behind prepared content; one that only writes replaces it', async () => {
    const file = at('prep', 'a.txt');
    assert.equal(fs.readFileSync(file, 'utf8'), 'PUBLISHED');
    // `r+`, `a+`, `w+`, `O_RDWR`… would read the raw file where readFile
    // gives the prepared content: no descriptor, nothing changed.
    await refusedEach(file, [...READS, ...READ_WRITES], {
      code: 'ENOTSUP',
      detail: 'virtual file',
    });
    assert.equal(readDisk(file, 'utf8'), 'published', 'the raw file');
    assert.equal(fs.readFileSync(file, 'utf8'), 'PUBLISHED');
    // A flag that only writes replaces the raw input; the watcher prepares
    // it again.
    const handle = await fs.promises.open(file, 'w');
    await handle.write('changed');
    await handle.close();
    assert.equal(readDisk(file, 'utf8'), 'changed');
    assert.equal(fs.readFileSync(file, 'utf8'), 'PUBLISHED', 'not yet');
    await republish(file);
    assert.equal(fs.readFileSync(file, 'utf8'), 'CHANGED', 'prepared again');
  });

  it('a writable disk-origin place: a new file is created, as before', async () => {
    const file = at('site', 'new.txt');
    assert.deepEqual(await openEach(file, ['a']), ['ok', 'ok', 'ok']);
    const fd = fs.openSync(file, 'w');
    fs.writeSync(fd, 'new');
    fs.closeSync(fd);
    assert.equal(readDisk(file, 'utf8'), 'new');
    // Written through the descriptor of the other forms, and of a number.
    const viaCallback = await new Promise((resolve, reject) => {
      fs.open(at('site', 'callback.txt'), 'w', 0o600, (err, opened) =>
        err ? reject(err) : resolve(opened),
      );
    });
    fs.writeSync(viaCallback, 'callback');
    fs.closeSync(viaCallback);
    const handle = await fs.promises.open(at('site', 'promises.txt'), 'w');
    await handle.write('promises');
    await handle.close();
    const numeric = O_WRONLY | O_CREAT | O_TRUNC;
    const viaNumber = fs.openSync(at('site', 'numeric.txt'), numeric);
    fs.writeSync(viaNumber, 'numeric');
    fs.closeSync(viaNumber);
    for (const name of ['callback', 'promises', 'numeric']) {
      assert.equal(readDisk(at('site', `${name}.txt`), 'utf8'), name);
    }
    // Its disk territory.
    fs.closeSync(fs.openSync(at('site', 'new.bin'), 'w'));
    assert.equal(onDisk(at('site', 'new.bin')), true);
    const stream = fs.createWriteStream(at('site', 'stream.txt'));
    stream.end('streamed');
    await finished(stream);
    assert.equal(readDisk(at('site', 'stream.txt'), 'utf8'), 'streamed');
  });

  // Node's own open inside these runs in the native section, unrouted.
  it('writeFileSync / appendFileSync / truncateSync of a published file pass, as before', () => {
    fs.writeFileSync(at('site', 'b.txt'), Buffer.from('two'));
    fs.appendFileSync(at('site', 'b.txt'), Buffer.from('+3'));
    assert.equal(readDisk(at('site', 'b.txt'), 'utf8'), 'two+3');
    fs.truncateSync(at('site', 'b.txt'), 3);
    assert.equal(readDisk(at('site', 'b.txt'), 'utf8'), 'two');
  });

  it('createWriteStream: the refusal is emitted on the stream', async () => {
    const place = { code: 'ENOTSUP', detail: 'virtual place' };
    const file = { code: 'ENOTSUP', detail: 'virtual file' };
    const published = readDisk(at('site', 'a.txt'), 'utf8');
    for (const [target, flags, expected] of [
      [at('ro', 'ws.txt'), 'w', { code: 'EROFS' }],
      [at('ro', 'raw.bin'), 'r+', { code: 'EROFS' }],
      [at('ro', 'a.txt'), 'w', { code: 'EROFS' }],
      [at('ro', 'a.txt'), 'a+', file],
      [at('drive', 'd.txt'), 'a', { code: 'EROFS' }],
      [at('site', 'a.txt'), 'r+', file],
      [at('site', 'a.txt'), 'a+', file],
      [at('v', 'ws.txt'), 'w', place],
      [at('v', 'sub', 'ws.txt'), 'w', place],
      [at('m', 'ws.txt'), 'w', place],
      [at('v', 'p.txt'), 'w', file],
      [at('m', 'p.txt'), 'r+', file],
    ]) {
      // An 'error' instead of an 'open' rejects; an opened stream is closed.
      const stream = fs.createWriteStream(target, { flags });
      try {
        await assert.rejects(once(stream, 'open'), (err) => {
          refused(err, { ...expected, file: target, args: [flags] });
          return true;
        });
      } finally {
        stream.destroy();
      }
    }
    assert.equal(onDisk(at('ro', 'ws.txt')), false);
    assert.equal(readDisk(at('ro', 'raw.bin'), 'utf8'), 'raw');
    assert.equal(readDisk(at('ro', 'a.txt'), 'utf8'), 'published');
    assert.equal(readDisk(at('site', 'a.txt'), 'utf8'), published);
    assert.equal(readDisk(at('drive', 'd.txt'), 'utf8'), 'disk');
    assert.deepEqual(listDisk(at('v'), { recursive: true }), ['sub']);
    assert.deepEqual(listDisk(at('m')), []);
    assert.equal(k.fs('v').readFile('/p.txt', 'utf8'), 'virtual');
  });
});

describe('fs-patch under strict: open with a flag that writes', () => {
  let root;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    root = writeTree(tmpDir('fspatch-open-strict'), {
      'ro/raw.bin': 'raw', // not cached: the disk territory
      'up/a.txt': 'published',
      'stray/s.txt': 'unmanaged',
    });
    fs.mkdirSync(at('m'));
    k = await kernel(
      root,
      {
        ro: { fs: { ext: ['txt'], fallback: 'disk' } },
        up: { fs: { ext: ['txt'], writable: true } },
        m: { provider: 'map', origin: 'virtual', fs: { writable: true } },
      },
      { strict: true, watchTimeout: 60000 },
    );
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(root);
  });

  it('a descriptor that can read a hidden path is EACCES', async () => {
    for (const file of [
      at('ro', 'new.txt'), // a cached extension, unpublished
      at('up', 'new.txt'), // the same, in a writable place
      at('m', 'x.txt'),
      at('stray', 's.txt'),
    ]) {
      await refusedEach(file, [...READS, ...READ_WRITES], { code: 'EACCES' });
    }
    assert.equal(onDisk(at('ro', 'new.txt')), false);
    assert.equal(onDisk(at('up', 'new.txt')), false);
    assert.deepEqual(listDisk(at('m')), []);
    assert.equal(readDisk(at('stray', 's.txt'), 'utf8'), 'unmanaged');
  });

  // A flag that only writes can read nothing: it is writeFile with a
  // descriptor, and the mutation routing alone answers it.
  it('a descriptor that only writes follows the mutation routing, as writeFile does', async () => {
    await refusedEach(at('ro', 'new.txt'), WRITE_ONLY, { code: 'EROFS' });
    await refusedEach(at('m', 'x.txt'), WRITE_ONLY, {
      code: 'ENOTSUP',
      detail: 'virtual place',
    });
    await refusedEach(at('stray', 's.txt'), WRITE_ONLY, { code: 'EACCES' });
    assert.equal(onDisk(at('ro', 'new.txt')), false);
    assert.deepEqual(listDisk(at('m')), []);
    assert.equal(readDisk(at('stray', 's.txt'), 'utf8'), 'unmanaged');
    // A writable disk-origin place: the raw file is created, as
    // writeFileSync creates it, and hidden until the watcher publishes it.
    const file = at('up', 'new.txt');
    for (const args of withMode(['w', 'a', O_WRONLY | O_CREAT | O_TRUNC])) {
      assert.deepEqual(await openEach(file, args), ['ok', 'ok', 'ok'], args);
    }
    const fd = fs.openSync(file, 'w');
    fs.writeSync(fd, 'new');
    fs.closeSync(fd);
    assert.equal(readDisk(file, 'utf8'), 'new');
    assert.throws(() => fs.readFileSync(file), { code: 'EACCES' });
    k.watcher.emit('epoch', new Map([[file, 'change']]));
    await k.watchQueue.idle;
    assert.equal(fs.readFileSync(file, 'utf8'), 'new');
    // Once published it is a published entry: its raw file for a flag that
    // only writes, no descriptor for one that can read.
    for (const args of withMode(['a', 'w'])) {
      assert.deepEqual(await openEach(file, args), ['ok', 'ok', 'ok'], args);
    }
    for (const entry of [file, at('up', 'a.txt')]) {
      await refusedEach(entry, [...READS, ...READ_WRITES], {
        code: 'ENOTSUP',
        detail: 'virtual file',
      });
    }
    assert.equal(readDisk(at('up', 'a.txt'), 'utf8'), 'published');
  });

  it('what it passes through is routed as a mutation: EROFS', async () => {
    const file = at('ro', 'raw.bin');
    await refusedEach(file, WRITES, { code: 'EROFS' });
    assert.equal(readDisk(file, 'utf8'), 'raw');
    for (const args of READS) {
      assert.deepEqual(await openEach(file, args), ['ok', 'ok', 'ok']);
    }
  });
});

// fs.openAsBlob reads through a native binding, past every node:fs function
// the patch replaces. Unrouted, it read what the places hide and the raw file
// behind a prepared entry. It is routed as readFile is.

describe('fs-patch: openAsBlob', () => {
  let root;
  let outside;
  let k;
  const at = (...p) => path.join(root, ...p);
  const upper = (raw) => raw.toString().toUpperCase();

  before(async () => {
    root = writeTree(tmpDir('fspatch-blob'), {
      'pub/a.txt': 'prepared',
      'pub/raw.bin': 'territory',
      'stray/s.txt': 'unmanaged',
    });
    outside = writeTree(tmpDir('fspatch-blob-out'), { 'o.txt': 'outside' });
    k = await kernel(
      root,
      {
        pub: { fs: { ext: ['txt'], fallback: 'disk', prepare: 'upper' } },
        mem: { provider: 'map', origin: 'virtual', fs: { writable: true } },
      },
      { strict: true },
      { preparers: { upper } },
    );
    // A cached extension written after the scan: hidden under strict.
    writeDisk(at('pub', 'late.txt'), 'late');
    k.fs('mem').writeFile('/m.txt', 'virtual');
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(root);
    rm(outside);
  });

  // The error of a call, whether it rejects or — as node:fs does for its
  // own refusals of this call today — throws before the promise.
  const failure = async (fn) => {
    try {
      await fn();
      return null;
    } catch (err) {
      return err;
    }
  };

  it('a hidden path is refused before anything is read', async () => {
    for (const file of [
      at('pub', 'late.txt'),
      at('stray', 's.txt'),
      at('mem', 'nope.txt'),
    ]) {
      await assert.rejects(fs.openAsBlob(file), (err) => {
        refused(err, { code: 'EACCES', file, args: [] });
        return true;
      });
    }
  });

  it('a published entry is a Blob over its canonical content', async () => {
    const blob = await fs.openAsBlob(at('pub', 'a.txt'), {
      type: 'text/plain',
    });
    assert.equal(await blob.text(), 'PREPARED', 'prepared, not the raw file');
    assert.equal(blob.size, 8);
    assert.equal(blob.type, 'text/plain');
    assert.equal((await fs.openAsBlob(at('pub', 'a.txt'))).type, '');
    const virtual = await fs.openAsBlob(at('mem', 'm.txt'));
    assert.equal(await virtual.text(), 'virtual');
    // A Blob is a copy: a later write does not change it.
    k.fs('mem').writeFile('/m.txt', 'changed');
    assert.equal(await virtual.text(), 'virtual');
    assert.equal(
      await (await fs.openAsBlob(Buffer.from(at('mem', 'm.txt')))).text(),
      'changed',
    );
  });

  it('a directory is EISDIR; the disk territory and the outside stay native', async () => {
    for (const dir of [at('pub'), at('mem'), root]) {
      await assert.rejects(fs.openAsBlob(dir), {
        code: 'EISDIR',
        syscall: 'read',
      });
    }
    assert.equal(
      await (await fs.openAsBlob(at('pub', 'raw.bin'))).text(),
      'territory',
    );
    assert.equal(
      await (await fs.openAsBlob(path.join(outside, 'o.txt'))).text(),
      'outside',
    );
    // node:fs's own refusal of a missing file, in its own form — which
    // changes with the version: ERR_INVALID_ARG_VALUE, ENOENT from 26.10.
    const missingFile = path.join(outside, 'missing.txt');
    const missing = await failure(() => fs.openAsBlob(missingFile));
    const native = await failure(() => openAsBlobDisk(missingFile));
    assert.ok(native, 'node:fs refuses a missing file');
    assert.equal(missing?.code, native.code);
    assert.equal(missing.message, native.message);
  });

  it('options are checked as node:fs checks them', async () => {
    for (const file of [at('pub', 'a.txt'), at('mem', 'm.txt')]) {
      await assert.rejects(fs.openAsBlob(file, 'text/plain'), {
        code: 'ERR_INVALID_ARG_TYPE',
      });
      await assert.rejects(fs.openAsBlob(file, { type: 5 }), {
        code: 'ERR_INVALID_ARG_TYPE',
      });
    }
    const native = await failure(() =>
      fs.openAsBlob(path.join(outside, 'o.txt'), 'text/plain'),
    );
    assert.equal(native?.code, 'ERR_INVALID_ARG_TYPE');
  });
});

// fs.realpathSync.native and fs.realpath.native were copied onto the
// patched functions unrouted: under strict they told a hidden path (a real
// path) from a missing one (ENOENT). They are routed as realpath is.

describe('fs-patch: realpath.native', () => {
  let root;
  let outside;
  let k;
  let natives; // calls of the native variants, counted before the patch
  const at = (...p) => path.join(root, ...p);
  const nativeCb = (p) =>
    new Promise((resolve, reject) => {
      fs.realpath.native(p, (err, real) => (err ? reject(err) : resolve(real)));
    });

  before(async () => {
    root = writeTree(tmpDir('fspatch-realpath'), {
      'ro/a.txt': 'published',
      'ro/h.bin': 'hidden', // an uncached extension behind fallback 'deny'
      'stray/s.txt': 'unmanaged',
    });
    outside = writeTree(tmpDir('fspatch-realpath-out'), { 'o.txt': 'o' });
    k = await kernel(
      root,
      { ro: { fs: { ext: ['txt'], fallback: 'deny' } } },
      { strict: true },
    );
    // Count the native variants themselves: set before the patch is
    // installed, they are what it routes to.
    natives = [];
    const { native: syncNative } = realpathDisk;
    const { native: cbNative } = realpathDiskCb;
    realpathDisk.native = function (...args) {
      natives.push('sync');
      return syncNative.apply(this, args);
    };
    realpathDiskCb.native = function (...args) {
      natives.push('callback');
      return cbNative.apply(this, args);
    };
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(root);
    rm(outside);
  });

  it('under strict a hidden and a missing path get the answer of realpath: EACCES, unasked', async () => {
    for (const file of [
      at('ro', 'h.bin'),
      at('ro', 'nope.bin'),
      at('ro', 'nope.txt'),
      at('stray', 's.txt'),
      at('stray', 'nope.txt'),
    ]) {
      const expected = { code: 'EACCES', syscall: 'lstat', path: file };
      assert.throws(() => fs.realpathSync(file), expected);
      assert.throws(() => fs.realpathSync.native(file), expected);
      await assert.rejects(nativeCb(file), expected);
    }
    assert.deepEqual(natives, [], 'no native call for a managed path');
  });

  it('a published entry resolves as realpath resolves it, unasked', async () => {
    const file = at('ro', 'a.txt');
    assert.equal(fs.realpathSync.native(file), fs.realpathSync(file));
    assert.equal(fs.realpathSync.native(file), path.resolve(file));
    assert.equal(await nativeCb(file), path.resolve(file));
    assert.deepEqual(natives, []);
  });

  it('outside appRoot the native variants answer, and are restored by uninstall()', async () => {
    const file = path.join(outside, 'o.txt');
    const real = realpathDisk(file);
    assert.equal(fs.realpathSync.native(file), real);
    assert.equal(await nativeCb(file), real);
    assert.deepEqual(natives, ['sync', 'callback']);
    assert.notEqual(fs.realpathSync.native, realpathDisk.native);
    fsPatch.uninstall();
    try {
      assert.equal(fs.realpathSync, realpathDisk);
      assert.equal(fs.realpathSync.native, realpathDisk.native);
      assert.equal(fs.realpath.native, realpathDiskCb.native);
    } finally {
      fsPatch.install(k);
    }
  });

  it('without strict the disk territory keeps its native answer', async () => {
    const loose = await kernel(root, { ro: { fs: { ext: ['txt'] } } });
    fsPatch.uninstall();
    fsPatch.install(loose);
    natives.length = 0;
    try {
      const hidden = at('ro', 'h.bin');
      assert.equal(fs.realpathSync.native(hidden), realpathDisk(hidden));
      await assert.rejects(nativeCb(at('ro', 'nope.bin')), { code: 'ENOENT' });
      assert.deepEqual(natives, ['sync', 'callback']);
      // A published entry is still the place's, unasked.
      assert.equal(
        fs.realpathSync.native(at('ro', 'a.txt')),
        path.resolve(at('ro', 'a.txt')),
      );
      assert.deepEqual(natives, ['sync', 'callback']);
    } finally {
      fsPatch.uninstall();
      fsPatch.install(k);
      loose.close();
    }
  });
});
