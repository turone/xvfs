'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { finished } = require('node:stream/promises');
const { pathToFileURL } = require('node:url');
const fsPatch = require('../lib/adapters/fs-patch.js');
const {
  tmpDir,
  writeTree,
  rm,
  kernel,
  drain,
  diskCalls,
  within,
} = require('./helpers.js');

// The disk as it is, behind the patch: captured before any install.
const {
  existsSync: onDisk,
  readFileSync: readDisk,
  readdirSync: listDisk,
  writeFileSync: writeDisk,
  realpathSync: realpathDisk,
  realpath: realpathDiskCb,
  openAsBlob: openAsBlobDisk,
  openAsBlobSync: openAsBlobSyncDisk,
  rmdirSync: rmdirDisk,
  open: openDisk,
  read: readFd,
  close: closeFd,
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

// readFile opens the file with its flag first, so a flag that writes may
// create or truncate it. Routed as a read alone, readFileSync(p, { flag:
// 'w' }) truncated a file of a read-only place (and answered EBADF), and
// { flag: 'a+' } created a file in a virtual place's directory on disk. It
// is routed as open() with the same flag: a flag that only writes follows
// the mutation routing, one that can read meets no descriptor to a
// published entry and stays EACCES on a hidden path; what open() lets
// through is read natively.

// readFile in each form — sync, callback, promise — with `{ flag }`: the
// content read ('ok:…') or the error, per form; and the asynchronous disk
// calls the three made.
const readEach = async (file, flag) => {
  const options = { flag };
  const forms = [
    () => fs.readFileSync(file, options),
    () =>
      new Promise((resolve, reject) => {
        fs.readFile(file, options, (err, data) =>
          err ? reject(err) : resolve(data),
        );
      }),
    () => fs.promises.readFile(file, options),
  ];
  const calls = diskCalls();
  const outcomes = [];
  try {
    for (const form of forms) {
      try {
        outcomes.push(`ok:${await form()}`);
      } catch (err) {
        outcomes.push(err);
      }
    }
  } finally {
    calls.stop();
  }
  return { outcomes, calls: calls.count };
};

// Every form refuses each flag so, before any disk call.
const refusedReads = async (file, flags, expected) => {
  for (const flag of flags) {
    const { outcomes, calls } = await readEach(file, flag);
    for (const outcome of outcomes) {
      refused(outcome, { ...expected, file, args: [flag] });
    }
    assert.equal(calls, 0, `${file} [${flag}]: no disk call`);
  }
};

// What node:fs answers for a plain file outside appRoot with the same flag
// and content, and what the file holds afterwards: codes, or 'ok:…'.
const nativeRead = async (plain, content, flag) => {
  if (content === null) rm(plain);
  else writeDisk(plain, content);
  const { outcomes } = await readEach(plain, flag);
  const after = onDisk(plain) ? readDisk(plain, 'utf8') : null;
  return { outcomes: outcomes.map((o) => o.code ?? o), after };
};

describe('fs-patch: readFile with a flag that writes', () => {
  let root;
  let outside;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    outside = tmpDir('fspatch-readflag-out');
    root = writeTree(tmpDir('fspatch-readflag'), {
      'ro/a.txt': 'published',
      'ro/raw.bin': 'raw', // not cached: the disk territory
      'site/a.txt': 'published',
      'prep/a.txt': 'published', // prepared: served upper-case
      'drive/d.txt': 'disk',
    });
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

  it('a read-only place is EROFS: nothing created or truncated', async () => {
    for (const file of [
      at('ro', 'new.txt'),
      at('ro', 'raw.bin'),
      at('ro', 'a.txt'),
      at('drive', 'd.txt'),
      at('drive', 'new.txt'),
    ]) {
      const before = onDisk(file) ? readDisk(file, 'utf8') : null;
      await refusedReads(file, WRITE_ONLY_FLAGS, { code: 'EROFS' });
      const after = onDisk(file) ? readDisk(file, 'utf8') : null;
      assert.equal(after, before, file);
    }
    // What the read routing passes through is a mutation too.
    for (const file of [at('ro', 'raw.bin'), at('drive', 'd.txt')]) {
      await refusedReads(file, READ_WRITE_FLAGS, { code: 'EROFS' });
    }
    assert.equal(readDisk(at('ro', 'raw.bin'), 'utf8'), 'raw');
    assert.equal(readDisk(at('drive', 'd.txt'), 'utf8'), 'disk');
  });

  it('a virtual place is ENOTSUP: no stray file on disk, no entry', async () => {
    for (const file of [
      at('v', 'x.txt'),
      at('v', 'sub', 'x.txt'),
      at('m', 'x.txt'),
    ]) {
      await refusedReads(file, WRITE_FLAGS, {
        code: 'ENOTSUP',
        detail: 'virtual place',
      });
    }
    assert.deepEqual(listDisk(at('v'), { recursive: true }), ['sub']);
    assert.deepEqual(listDisk(at('m')), []);
    for (const name of ['v', 'm']) {
      await refusedReads(at(name, 'p.txt'), WRITE_FLAGS, {
        code: 'ENOTSUP',
        detail: 'virtual file',
      });
      const entries = k.fs(name).readdir('/', { recursive: true });
      assert.deepEqual(entries, ['p.txt'], name);
      assert.equal(k.fs(name).readFile('/p.txt', 'utf8'), 'virtual', name);
    }
  });

  it('a published disk-origin entry: a flag that can read is ENOTSUP', async () => {
    for (const file of [at('ro', 'a.txt'), at('site', 'a.txt')]) {
      await refusedReads(file, READ_WRITE_FLAGS, {
        code: 'ENOTSUP',
        detail: 'virtual file',
      });
      assert.equal(readDisk(file, 'utf8'), 'published', file);
    }
    // The raw file behind prepared content is not read either.
    await refusedReads(at('prep', 'a.txt'), READ_WRITE_FLAGS, {
      code: 'ENOTSUP',
      detail: 'virtual file',
    });
    assert.equal(readDisk(at('prep', 'a.txt'), 'utf8'), 'published');
    // A flag that only reads keeps the canonical content.
    for (const flag of READ_FLAGS) {
      const { outcomes } = await readEach(at('prep', 'a.txt'), flag);
      assert.deepEqual(outcomes, Array(3).fill('ok:PUBLISHED'), `${flag}`);
    }
  });

  it('a writable disk-origin place: what open() lets through, node:fs reads', async () => {
    const plain = path.join(outside, 'plain.txt');
    // A published entry opens with a flag that only writes: its raw file,
    // as node:fs opens a plain one.
    const file = at('site', 'a.txt');
    for (const flag of WRITE_ONLY_FLAGS) {
      writeDisk(file, 'published');
      const native = await nativeRead(plain, 'published', flag);
      const { outcomes } = await readEach(file, flag);
      assert.deepEqual(
        outcomes.map((o) => o.code ?? o),
        native.outcomes,
        `${flag}`,
      );
      assert.equal(readDisk(file, 'utf8'), native.after, `${flag}`);
    }
    // A new file, with any flag that writes.
    for (const flag of WRITE_FLAGS) {
      const fresh = at('site', 'fresh.txt');
      rm(fresh);
      const native = await nativeRead(plain, null, flag);
      const { outcomes } = await readEach(fresh, flag);
      assert.deepEqual(
        outcomes.map((o) => o.code ?? o),
        native.outcomes,
        `${flag}`,
      );
      const after = onDisk(fresh) ? readDisk(fresh, 'utf8') : null;
      assert.equal(after, native.after, `${flag}`);
    }
  });
});

describe('fs-patch under strict: readFile with a flag that writes', () => {
  let root;
  let outside;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    outside = tmpDir('fspatch-readflag-strict-out');
    root = writeTree(tmpDir('fspatch-readflag-strict'), {
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
    rm(outside);
  });

  it('a flag that can read a hidden path is EACCES', async () => {
    for (const file of [
      at('ro', 'new.txt'),
      at('up', 'new.txt'),
      at('m', 'x.txt'),
      at('stray', 's.txt'),
    ]) {
      await refusedReads(file, READ_WRITE_FLAGS, { code: 'EACCES' });
    }
    assert.equal(onDisk(at('ro', 'new.txt')), false);
    assert.equal(onDisk(at('up', 'new.txt')), false);
    assert.deepEqual(listDisk(at('m')), []);
    assert.equal(readDisk(at('stray', 's.txt'), 'utf8'), 'unmanaged');
  });

  it('a flag that only writes follows the mutation routing', async () => {
    await refusedReads(at('ro', 'new.txt'), WRITE_ONLY_FLAGS, {
      code: 'EROFS',
    });
    await refusedReads(at('ro', 'raw.bin'), WRITE_FLAGS, { code: 'EROFS' });
    await refusedReads(at('m', 'x.txt'), WRITE_ONLY_FLAGS, {
      code: 'ENOTSUP',
      detail: 'virtual place',
    });
    await refusedReads(at('stray', 's.txt'), WRITE_ONLY_FLAGS, {
      code: 'EACCES',
    });
    await refusedReads(at('stray', 'new.txt'), WRITE_ONLY_FLAGS, {
      code: 'EACCES',
    });
    assert.equal(onDisk(at('ro', 'new.txt')), false);
    assert.equal(readDisk(at('ro', 'raw.bin'), 'utf8'), 'raw');
    assert.deepEqual(listDisk(at('m')), []);
    assert.equal(readDisk(at('stray', 's.txt'), 'utf8'), 'unmanaged');
    assert.equal(onDisk(at('stray', 'new.txt')), false);
    // A writable disk-origin place: its raw file, created as node:fs
    // creates a plain one, and hidden until the watcher publishes it.
    const plain = path.join(outside, 'plain.txt');
    const file = at('up', 'new.txt');
    for (const flag of WRITE_ONLY_FLAGS) {
      rm(file);
      const native = await nativeRead(plain, null, flag);
      const { outcomes } = await readEach(file, flag);
      assert.deepEqual(
        outcomes.map((o) => o.code ?? o),
        native.outcomes,
        `${flag}`,
      );
      const after = onDisk(file) ? readDisk(file, 'utf8') : null;
      assert.equal(after, native.after, `${flag}`);
    }
    await refusedReads(at('up', 'a.txt'), READ_WRITE_FLAGS, {
      code: 'ENOTSUP',
      detail: 'virtual file',
    });
    assert.equal(readDisk(at('up', 'a.txt'), 'utf8'), 'published');
  });
});

// createReadStream opens the file with its `flags` too, and a published
// entry was streamed from the VFS whatever they were. It is routed as
// open() with them, as readFile is. The call returns a stream at once,
// whatever the routing says, and a refusal is emitted on it, as node:fs
// emits its own.

// The stream createReadStream returns for `{ flags }`, taken at once — a
// refusal never throws, nor is it emitted before the call returns — then
// read to its end: its content ('ok:…'), or the error it emits; and the
// asynchronous disk calls made meanwhile.
const streamOf = async (file, flags, options = {}) => {
  const calls = diskCalls();
  let stream = null;
  try {
    stream = fs.createReadStream(file, { ...options, flags });
    assert.equal(stream.destroyed, false, `${file} [${flags}]: after`);
    const chunks = [];
    try {
      await within(
        (async () => {
          for await (const chunk of stream) chunks.push(chunk);
        })(),
        `the stream of ${file} [${flags}]`,
      );
      return { outcome: `ok:${Buffer.concat(chunks)}`, calls: calls.count };
    } catch (err) {
      return { outcome: err, calls: calls.count };
    }
  } finally {
    calls.stop();
    stream?.destroy();
  }
};

// Every flag is refused so, on the stream, before any disk call.
const refusedStreams = async (file, flags, expected) => {
  for (const flag of flags) {
    const { outcome, calls } = await streamOf(file, flag);
    refused(outcome, { ...expected, file, args: [flag] });
    assert.equal(calls, 0, `${file} [${flag}]: no disk call`);
  }
};

// What node:fs streams of a plain file outside appRoot with the same flag
// and content, and what the file holds afterwards.
const nativeStream = async (plain, content, flag) => {
  if (content === null) rm(plain);
  else writeDisk(plain, content);
  const { outcome } = await streamOf(plain, flag);
  const after = onDisk(plain) ? readDisk(plain, 'utf8') : null;
  return { outcome: outcome.code ?? outcome, after };
};

describe('fs-patch: createReadStream with a flag that writes', () => {
  let root;
  let outside;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    outside = tmpDir('fspatch-streamflag-out');
    root = writeTree(tmpDir('fspatch-streamflag'), {
      'ro/a.txt': 'published',
      'ro/raw.bin': 'raw', // not cached: the disk territory
      'site/a.txt': 'published',
      'prep/a.txt': 'published', // prepared: served upper-case
      'drive/d.txt': 'disk',
    });
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

  it('a published entry: a flag that can read is ENOTSUP, one that only writes routed as a mutation', async () => {
    for (const file of [
      at('ro', 'a.txt'),
      at('site', 'a.txt'),
      at('prep', 'a.txt'),
    ]) {
      await refusedStreams(file, READ_WRITE_FLAGS, {
        code: 'ENOTSUP',
        detail: 'virtual file',
      });
      assert.equal(readDisk(file, 'utf8'), 'published', file);
    }
    await refusedStreams(at('ro', 'a.txt'), WRITE_ONLY_FLAGS, {
      code: 'EROFS',
    });
    for (const name of ['v', 'm']) {
      await refusedStreams(at(name, 'p.txt'), WRITE_FLAGS, {
        code: 'ENOTSUP',
        detail: 'virtual file',
      });
      assert.equal(k.fs(name).readFile('/p.txt', 'utf8'), 'virtual', name);
    }
    // A flag that only reads keeps the canonical content.
    for (const flag of READ_FLAGS) {
      const { outcome } = await streamOf(at('prep', 'a.txt'), flag);
      assert.equal(outcome, 'ok:PUBLISHED', `${flag}`);
    }
  });

  it('what open() lets through streams natively, as node:fs streams a plain file', async () => {
    const plain = path.join(outside, 'plain.txt');
    // The raw file of a published entry of a writable place.
    const file = at('site', 'a.txt');
    for (const flag of WRITE_ONLY_FLAGS) {
      writeDisk(file, 'published');
      const native = await nativeStream(plain, 'published', flag);
      const { outcome } = await streamOf(file, flag);
      assert.equal(outcome.code ?? outcome, native.outcome, `${flag}`);
      assert.equal(readDisk(file, 'utf8'), native.after, `${flag}`);
    }
    // A new file there, and one outside appRoot, with any flag that writes.
    for (const flag of WRITE_FLAGS) {
      const fresh = at('site', 'fresh.txt');
      rm(fresh);
      const native = await nativeStream(plain, null, flag);
      const { outcome } = await streamOf(fresh, flag);
      assert.equal(outcome.code ?? outcome, native.outcome, `${flag}`);
      const after = onDisk(fresh) ? readDisk(fresh, 'utf8') : null;
      assert.equal(after, native.after, `${flag}`);
    }
  });

  // The refusal comes before the stream opens anything, whatever `fs` it is
  // given: its own functions, which no routing sees, open nothing.
  it('a refusal opens nothing, whatever fs the stream is given', async () => {
    const opened = [];
    const own = {
      open: (...args) => {
        opened.push(String(args[0]));
        return openDisk(...args);
      },
      read: readFd,
      close: closeFd,
    };
    writeDisk(at('site', 'a.txt'), 'published');
    for (const [file, flags, code] of [
      [at('site', 'a.txt'), 'r+', 'ENOTSUP'],
      [at('prep', 'a.txt'), 'a+', 'ENOTSUP'],
      [at('ro', 'a.txt'), 'w', 'EROFS'],
      [at('v', 'p.txt'), 'w', 'ENOTSUP'],
    ]) {
      const { outcome } = await streamOf(file, flags, { fs: own });
      assert.equal(outcome.code ?? outcome, code, `${file} [${flags}]`);
      assert.equal(outcome.path, file);
    }
    assert.deepEqual(opened, [], 'nothing opened');
    assert.equal(readDisk(at('site', 'a.txt'), 'utf8'), 'published');
    assert.equal(readDisk(at('ro', 'a.txt'), 'utf8'), 'published');
    // What routing lets through opens with them.
    const stream = fs.createReadStream(path.join(outside, 'own.txt'), {
      flags: 'a+',
      fs: own,
    });
    assert.equal(await drain(stream).then(String), '');
    assert.deepEqual(opened, [path.join(outside, 'own.txt')]);
  });

  // A stream given a descriptor opens nothing: node:fs reads the
  // descriptor, whatever path names it and whatever its flags say.
  it('a descriptor given: node:fs reads it, the path only names it', async () => {
    const file = path.join(outside, 'fd.txt');
    writeDisk(file, 'descriptor');
    for (const flags of [undefined, 'r+', 'w']) {
      const fd = fs.openSync(file, 'r');
      const stream = fs.createReadStream(at('prep', 'a.txt'), { fd, flags });
      assert.equal(String(await drain(stream)), 'descriptor', `${flags}`);
    }
    const handle = await fs.promises.open(file, 'r');
    const viaHandle = fs.createReadStream(at('v', 'p.txt'), {
      fd: handle,
      flags: 'a+',
    });
    assert.equal(String(await drain(viaHandle)), 'descriptor');
    assert.equal(readDisk(at('prep', 'a.txt'), 'utf8'), 'published');
  });

  it('the disk territory, a disk place and a virtual place, as before', async () => {
    for (const file of [at('ro', 'raw.bin'), at('drive', 'd.txt')]) {
      const before = readDisk(file, 'utf8');
      await refusedStreams(file, WRITE_FLAGS, { code: 'EROFS' });
      assert.equal(readDisk(file, 'utf8'), before, file);
    }
    for (const file of [at('v', 'x.txt'), at('m', 'x.txt')]) {
      await refusedStreams(file, WRITE_FLAGS, {
        code: 'ENOTSUP',
        detail: 'virtual place',
      });
    }
    assert.deepEqual(listDisk(at('v'), { recursive: true }), ['sub']);
    assert.deepEqual(listDisk(at('m')), []);
  });
});

describe('fs-patch under strict: createReadStream with a flag that writes', () => {
  let root;
  let outside;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    outside = tmpDir('fspatch-streamflag-strict-out');
    root = writeTree(tmpDir('fspatch-streamflag-strict'), {
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
    rm(outside);
  });

  it('a flag that can read a hidden path is EACCES; one that only writes follows the mutation routing', async () => {
    for (const file of [
      at('ro', 'new.txt'),
      at('up', 'new.txt'),
      at('m', 'x.txt'),
      at('stray', 's.txt'),
    ]) {
      await refusedStreams(file, READ_WRITE_FLAGS, { code: 'EACCES' });
    }
    await refusedStreams(at('ro', 'new.txt'), WRITE_ONLY_FLAGS, {
      code: 'EROFS',
    });
    await refusedStreams(at('m', 'x.txt'), WRITE_ONLY_FLAGS, {
      code: 'ENOTSUP',
      detail: 'virtual place',
    });
    await refusedStreams(at('stray', 's.txt'), WRITE_ONLY_FLAGS, {
      code: 'EACCES',
    });
    await refusedStreams(at('up', 'a.txt'), READ_WRITE_FLAGS, {
      code: 'ENOTSUP',
      detail: 'virtual file',
    });
    assert.equal(onDisk(at('ro', 'new.txt')), false);
    assert.equal(onDisk(at('up', 'new.txt')), false);
    assert.deepEqual(listDisk(at('m')), []);
    assert.equal(readDisk(at('stray', 's.txt'), 'utf8'), 'unmanaged');
    assert.equal(readDisk(at('up', 'a.txt'), 'utf8'), 'published');
    // A writable disk-origin place: its raw file, as node:fs streams a
    // plain one, hidden until the watcher publishes it.
    const plain = path.join(outside, 'plain.txt');
    const file = at('up', 'new.txt');
    for (const flag of WRITE_ONLY_FLAGS) {
      rm(file);
      const native = await nativeStream(plain, null, flag);
      const { outcome } = await streamOf(file, flag);
      assert.equal(outcome.code ?? outcome, native.outcome, `${flag}`);
      const after = onDisk(file) ? readDisk(file, 'utf8') : null;
      assert.equal(after, native.after, `${flag}`);
    }
  });

  it('a descriptor given: node:fs reads it, whatever path names it', async () => {
    const file = path.join(outside, 'fd.txt');
    writeDisk(file, 'descriptor');
    const fd = fs.openSync(file, 'r');
    const stream = fs.createReadStream(at('stray', 's.txt'), {
      fd,
      flags: 'r+',
    });
    assert.equal(String(await drain(stream)), 'descriptor');
    assert.equal(readDisk(at('stray', 's.txt'), 'utf8'), 'unmanaged');
  });
});

// mkdtemp makes a directory named as its prefix and six characters, which
// node:fs names XXXXXX in its errors. Unpatched, it made one in read-only
// and virtual places and, under strict, anywhere under appRoot. That path
// takes the mutation routing, in every form.

// Each form of mkdtemp there is — sync, callback, promise and, from Node
// 24, the disposable sync and promise forms — over `prefix`: 'made' for a
// directory made next to the prefix (removed at once, through the remover
// of a disposable form), or the error; and the asynchronous disk calls of
// the forms that failed.
const mkdtempEach = async (prefix) => {
  // Each form: what it made, and how to remove it.
  const plain = (dir) => ({ dir, remove: () => rmdirDisk(dir) });
  const disposable = ({ path: dir, remove }) => ({ dir, remove });
  const forms = [
    () => plain(fs.mkdtempSync(prefix)),
    () =>
      new Promise((resolve, reject) => {
        fs.mkdtemp(prefix, (err, dir) => (err ? reject(err) : resolve(dir)));
      }).then(plain),
    async () => plain(await fs.promises.mkdtemp(prefix)),
  ];
  if (typeof fs.mkdtempDisposableSync === 'function') {
    forms.push(() => disposable(fs.mkdtempDisposableSync(prefix)));
  }
  if (typeof fs.promises.mkdtempDisposable === 'function') {
    forms.push(async () =>
      disposable(await fs.promises.mkdtempDisposable(prefix)),
    );
  }
  const outcomes = [];
  let calls = 0;
  for (const form of forms) {
    const count = diskCalls();
    let made = null;
    try {
      made = await form();
    } catch (err) {
      outcomes.push(err);
      calls += count.count;
      continue;
    } finally {
      count.stop();
    }
    const named = String(made.dir);
    const fits = named.startsWith(String(prefix)) && onDisk(named);
    outcomes.push(fits ? 'made' : `made ${named}`);
    await made.remove();
  }
  return { outcomes, calls };
};

// Every form refuses `prefix` so, before any disk call, and makes nothing.
const refusedMkdtemp = async (prefix, expected) => {
  const parent = path.dirname(`${prefix}XXXXXX`);
  const before = onDisk(parent) ? listDisk(parent) : null;
  const { outcomes, calls } = await mkdtempEach(prefix);
  const where = `${prefix}XXXXXX`;
  for (const err of outcomes) {
    const what = `${where}: ${err?.message ?? err}`;
    assert.ok(err instanceof Error, what);
    assert.equal(err.code, expected.code, what);
    assert.equal(err.syscall, 'mkdtemp', what);
    assert.equal(err.path, where, what);
    if (expected.detail) {
      assert.ok(err.message.includes(`(${expected.detail})`), what);
    }
  }
  assert.equal(calls, 0, `${where}: no disk call`);
  assert.deepEqual(onDisk(parent) ? listDisk(parent) : null, before, where);
};

// Every form makes its directory natively, and removes it.
const madeMkdtemp = async (prefix) => {
  const { outcomes } = await mkdtempEach(prefix);
  assert.deepEqual(
    outcomes.map((o) => o.code ?? o),
    Array(outcomes.length).fill('made'),
    prefix,
  );
};

describe('fs-patch: mkdtemp takes the mutation routing', () => {
  let root;
  let outside;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    outside = tmpDir('fspatch-mkdtemp-out');
    root = writeTree(tmpDir('fspatch-mkdtemp'), {
      'ro/a.txt': 'published',
      'site/a.txt': 'published',
      'drive/d.txt': 'disk',
    });
    // The directories of the virtual places exist on disk: node:fs would
    // make a directory there.
    fs.mkdirSync(at('v'));
    fs.mkdirSync(at('m'));
    k = await kernel(
      root,
      {
        ro: { fs: { ext: ['txt'] } },
        site: { fs: { ext: ['txt'], writable: true } },
        drive: { provider: 'disk', fs: true },
        v: { origin: 'virtual', fs: { writable: true } },
        m: { provider: 'map', origin: 'virtual', fs: { writable: true } },
      },
      { watchTimeout: 60000 },
    );
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(root);
    rm(outside);
  });

  it('a read-only place is EROFS', async () => {
    await refusedMkdtemp(at('ro', 'tmp-'), { code: 'EROFS' });
    await refusedMkdtemp(at('drive', 'tmp-'), { code: 'EROFS' });
    // A Buffer or a file URL names the same place.
    const forms = [
      () => fs.mkdtempSync(Buffer.from(at('ro', 'tmp-'))),
      () => fs.mkdtempSync(pathToFileURL(at('ro', 'tmp-'))),
    ];
    for (const form of forms) {
      assert.throws(form, {
        code: 'EROFS',
        syscall: 'mkdtemp',
        path: `${at('ro', 'tmp-')}XXXXXX`,
      });
    }
    assert.deepEqual(listDisk(at('ro')), ['a.txt']);
  });

  it('a virtual place is ENOTSUP: no directory on disk', async () => {
    for (const prefix of [
      at('v', 'tmp-'),
      at('m', 'tmp-'),
      `${at('v')}${path.sep}`, // v/XXXXXX: in the place's own directory
    ]) {
      await refusedMkdtemp(prefix, {
        code: 'ENOTSUP',
        detail: 'virtual place',
      });
    }
    assert.deepEqual(listDisk(at('v')), []);
    assert.deepEqual(listDisk(at('m')), []);
  });

  it('a writable disk-origin place, and what no place owns, make it natively', async () => {
    await madeMkdtemp(at('site', 'tmp-'));
    // Next to a place, not in it; and outside appRoot.
    await madeMkdtemp(at('ro'));
    await madeMkdtemp(path.join(outside, 'tmp-'));
    assert.deepEqual(listDisk(at('site')), ['a.txt']);
    assert.deepEqual(listDisk(outside), []);
  });
});

describe('fs-patch under strict: mkdtemp takes the mutation routing', () => {
  let root;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    root = writeTree(tmpDir('fspatch-mkdtemp-strict'), {
      'ro/a.txt': 'published',
      'up/a.txt': 'published',
      'stray/s.txt': 'unmanaged',
    });
    fs.mkdirSync(at('m'));
    k = await kernel(
      root,
      {
        ro: { fs: { ext: ['txt'] } },
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

  it('what no place owns under appRoot is EACCES; appRoot itself too', async () => {
    for (const prefix of [
      at('tmp-'),
      at('stray', 'tmp-'),
      at('ro'), // roXXXXXX: next to the place, not in it
      `${root}${path.sep}`,
    ]) {
      await refusedMkdtemp(prefix, { code: 'EACCES' });
    }
    assert.deepEqual(listDisk(root).sort(), ['m', 'ro', 'stray', 'up']);
    assert.deepEqual(listDisk(at('stray')), ['s.txt']);
  });

  it("a read-only 'deny' place is EROFS, a virtual one ENOTSUP", async () => {
    await refusedMkdtemp(at('ro', 'tmp-'), { code: 'EROFS' });
    await refusedMkdtemp(at('m', 'tmp-'), {
      code: 'ENOTSUP',
      detail: 'virtual place',
    });
    assert.deepEqual(listDisk(at('ro')), ['a.txt']);
    assert.deepEqual(listDisk(at('m')), []);
  });

  it('a writable disk-origin place makes it natively; outside appRoot too', async () => {
    await madeMkdtemp(at('up', 'tmp-'));
    assert.deepEqual(listDisk(at('up')), ['a.txt']);
    // appRoot as the prefix names a sibling of it.
    await madeMkdtemp(root);
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

  // fs.openAsBlobSync (Node 26.10), the same read through the same binding:
  // routed the same way, the Blob returned, what the patch refuses thrown.
  const SYNC =
    typeof openAsBlobSyncDisk === 'function'
      ? {}
      : { skip: 'no fs.openAsBlobSync before Node 26.10' };

  describe('openAsBlobSync', SYNC, () => {
    it('a hidden path is EACCES, thrown', () => {
      for (const file of [
        at('pub', 'late.txt'),
        at('stray', 's.txt'),
        at('mem', 'nope.txt'),
      ]) {
        assert.throws(
          () => fs.openAsBlobSync(file),
          (err) => {
            refused(err, { code: 'EACCES', file, args: [] });
            return true;
          },
        );
      }
    });

    it('a published entry is a Blob over its canonical content', async () => {
      const blob = fs.openAsBlobSync(at('pub', 'a.txt'), {
        type: 'text/plain',
      });
      assert.ok(blob instanceof Blob);
      assert.equal(await blob.text(), 'PREPARED', 'prepared, not the raw file');
      assert.equal(blob.size, 8);
      assert.equal(blob.type, 'text/plain');
      assert.equal(fs.openAsBlobSync(at('pub', 'a.txt')).type, '');
      k.fs('mem').writeFile('/m.txt', 'virtual');
      const virtual = fs.openAsBlobSync(at('mem', 'm.txt'));
      // A Blob is a copy: a later write does not change it.
      k.fs('mem').writeFile('/m.txt', 'changed');
      assert.equal(await virtual.text(), 'virtual');
      const again = fs.openAsBlobSync(Buffer.from(at('mem', 'm.txt')));
      assert.equal(await again.text(), 'changed');
    });

    it('a directory is EISDIR, thrown; the disk territory and the outside stay native', async () => {
      for (const dir of [at('pub'), at('mem'), root]) {
        assert.throws(() => fs.openAsBlobSync(dir), {
          code: 'EISDIR',
          syscall: 'read',
        });
      }
      const territory = fs.openAsBlobSync(at('pub', 'raw.bin'));
      assert.equal(await territory.text(), 'territory');
      const out = fs.openAsBlobSync(path.join(outside, 'o.txt'));
      assert.equal(await out.text(), 'outside');
      // node:fs's own refusal of a missing file, as node:fs throws it.
      const missingFile = path.join(outside, 'missing.txt');
      const native = await failure(() => openAsBlobSyncDisk(missingFile));
      assert.ok(native, 'node:fs refuses a missing file');
      assert.throws(() => fs.openAsBlobSync(missingFile), {
        code: native.code,
        message: native.message,
      });
    });

    it('options are checked as node:fs checks them', () => {
      for (const file of [
        at('pub', 'a.txt'),
        at('mem', 'm.txt'),
        path.join(outside, 'o.txt'),
      ]) {
        assert.throws(() => fs.openAsBlobSync(file, 'text/plain'), {
          code: 'ERR_INVALID_ARG_TYPE',
        });
        assert.throws(() => fs.openAsBlobSync(file, { type: 5 }), {
          code: 'ERR_INVALID_ARG_TYPE',
        });
      }
    });
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

// A place's own directory is its mount: the patch removes none that PlaceFs
// keeps — an indexed place's, and under strict any place's — as PlaceFs
// answers, before any native call: `rm`, recursive or not, and `rmdir` are
// ENOTSUP, an `unlink` EISDIR. Without strict a `disk` place's directory is
// node:fs territory.
describe("fs-patch: a place's own directory stays", () => {
  const TREE = { 'w/a.txt': 'a', 'd/b.bin': 'b', 'e/c.bin': 'c' };
  const PLACES = {
    w: { fs: { writable: true } },
    d: { provider: 'disk', fs: { writable: true } },
    e: { provider: 'disk', fs: { writable: true } },
  };

  for (const strict of [false, true]) {
    it(
      strict ? 'under strict: every place' : 'without strict: an indexed place',
      async () => {
        const root = writeTree(tmpDir('patch-root'), TREE);
        const at = (...p) => path.join(root, ...p);
        const k = await kernel(root, PLACES, { strict, watchTimeout: 60000 });
        fsPatch.install(k);
        try {
          for (const dir of strict ? [at('w'), at('d')] : [at('w')]) {
            for (const p of [dir, `${dir}${path.sep}`]) {
              const kept = (code, syscall) => ({ code, syscall, path: p });
              const mount = { ...kept('ENOTSUP', 'rm'), message: /place root/ };
              assert.throws(() => fs.rmSync(p, { recursive: true }), mount);
              assert.throws(() => fs.rmSync(p), mount);
              await assert.rejects(
                fs.promises.rm(p, { recursive: true }),
                mount,
              );
              assert.throws(() => fs.rmdirSync(p), kept('ENOTSUP', 'rmdir'));
              assert.throws(() => fs.unlinkSync(p), kept('EISDIR', 'unlink'));
            }
          }
          assert.equal(readDisk(at('w', 'a.txt'), 'utf8'), 'a');
          assert.equal(readDisk(at('d', 'b.bin'), 'utf8'), 'b');
          if (!strict) {
            fs.rmSync(at('e'), { recursive: true });
            assert.equal(onDisk(at('e')), false);
          }
        } finally {
          fsPatch.uninstall();
          k.close();
          rm(root);
        }
      },
    );
  }
});
