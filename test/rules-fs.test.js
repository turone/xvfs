'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { VfsConfig } = require('../lib/config.js');
const fsPatch = require('../lib/adapters/fs-patch.js');
const {
  tmpDir,
  writeTree,
  rm,
  kernel,
  worker,
  assertAtRest,
} = require('./helpers.js');

// The rules of a place's subtrees at its boundaries (doc/architecture.md,
// "Rules of subtrees"): what the facade, the patched node:fs, the module
// hooks and the store of a virtual place make of the settings in force at
// a key. The settings themselves: rules.test.js.

// Disk edits behind the VFS's back: captured before any patch is installed.
const { existsSync: onDisk } = fs;

const SITE_FILES = {
  'site/a.html': 'a',
  'site/private/secret.txt': 'secret',
  'site/private/public/open.txt': 'open',
  'site/static/page.html': 'page',
  'site/static/mod.js': 'module.exports = 1;',
  'site/system/conf.txt': 'conf',
  'site/data/f.txt': 'f',
  'site/data/locked/l.txt': 'l',
  'site/lib/m.js': 'module.exports = 2;',
};

const SITE = {
  fs: { ext: ['html', 'txt', 'js'], writable: true },
  require: true,
  rules: {
    '/private': { fs: false },
    '/private/public': { fs: {} },
    '/static': { fs: { ext: ['html'] }, require: false },
    '/system': { fs: { writable: false } },
    '/data/locked': { fs: { writable: false } },
  },
};

const code = (fn) => {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
};

const siteKernel = async (defaults = {}) => {
  const root = writeTree(tmpDir('vfs-rules'), SITE_FILES);
  const k = await kernel(root, { site: SITE }, defaults);
  return { root, k, at: (rel) => path.join(root, 'site', rel) };
};

describe('rules: config', () => {
  it('a rule narrows what its place declares, on a place with a tree', () => {
    const place = (rules, extra = {}) =>
      new VfsConfig({
        places: { site: { ...SITE, ...extra, rules } },
      }).places[0];
    assert.deepEqual(place({ '/s': { require: false } }).rules, {
      '/s': { require: false },
    });
    const refused = [
      [{ '/s': { fs: { ext: ['css'] } } }, /never more/],
      [{ s: { fs: false } }, /a key below the place/],
      [{ '/': { fs: false } }, /a key below the place/],
      [{ '/s/': { fs: false } }, /a key below the place/],
      [{ '/S': { fs: false }, '/s': { fs: false } }, /differ only in case/],
      [{ '/s': {} }, /sets fs, require or import/],
      [{ '/s': { import: false } }, /no import domain/],
      [{ '/s': { fs: { zeroCopy: true } } }, /unknown option "zeroCopy"/],
    ];
    for (const [rules, message] of refused) {
      assert.throws(() => place(rules), message, JSON.stringify(rules));
    }
    assert.throws(
      () =>
        new VfsConfig({
          places: {
            d: { provider: 'disk', fs: true, rules: { '/a': { fs: false } } },
          },
        }),
      /apply to providers sab, map and sea/,
    );
    assert.throws(
      () =>
        place(
          { '/s': { fs: { fallback: 'disk' } } },
          { origin: 'virtual', fs: { writable: true } },
        ),
      /applies to disk-origin places/,
    );
  });
});

describe('rules: the facade', () => {
  it('a path its rules hide is not there; one they give again is', async () => {
    const { root, k } = await siteKernel();
    try {
      const site = k.fs('site');
      assert.equal(site.exists('/private'), false);
      assert.equal(site.exists('/private/secret.txt'), false);
      assert.equal(site.readFile('/private/secret.txt'), null);
      assert.equal(site.stat('/private'), null);
      assert.equal(site.idOf('/private'), null);
      assert.equal(site.readFile('/private/public/open.txt', 'utf8'), 'open');
      const open = site.idOf('/private/public/open.txt');
      assert.equal(site.keyOf(open), '/private/public/open.txt');
      const hidden = k.registry.get('site').node('/private');
      assert.equal(
        site.keyOf(k.registry.get('site').tree.nodeId(hidden)),
        null,
      );
      assert.throws(() => site.readdir('/private'), { code: 'ENOENT' });
      assert.deepEqual(site.readdir('/private/public'), ['open.txt']);
      assert.deepEqual(site.readdir('/static'), ['page.html']);
      assert.equal(site.readFile('/static/mod.js'), null, 'fewer extensions');
      assert.deepEqual(site.readdir('/'), [
        'a.html',
        'data',
        'lib',
        'static',
        'system',
      ]);
      const all = site.readdir('/', { recursive: true });
      assert.equal(
        all.some((name) => name.startsWith('private')),
        false,
        'a listing enters no hidden directory',
      );
      assert.ok(all.includes('static/page.html'));
      assert.ok(!all.includes('static/mod.js'));
    } finally {
      k.close();
      rm(root);
    }
  });

  it('a write is refused where a rule hides or keeps from writes, before any change', async () => {
    const { root, k, at } = await siteKernel();
    try {
      const site = k.fs('site');
      assert.equal(site.writable, true, "the place's own");
      assert.equal(site.writableAt('/system/conf.txt'), false);
      assert.equal(site.writableAt('/a.html'), true);
      assert.equal(
        code(() => site.writeFile('/system/n.txt', 'n')),
        'EROFS',
      );
      assert.equal(
        code(() => site.writeFile('/private/n.txt', 'n')),
        'EACCES',
      );
      assert.equal(
        code(() => site.unlink('/system/conf.txt')),
        'EROFS',
      );
      assert.equal(
        code(() => site.mkdir('/system/d')),
        'EROFS',
      );
      assert.equal(
        code(() => site.rename('/a.html', '/system/a.html')),
        'EROFS',
      );
      // A tree with a rule below that forbids writes: neither removed nor
      // moved — nor a hidden one.
      assert.equal(
        code(() => site.rm('/data', { recursive: true })),
        'EROFS',
      );
      assert.equal(
        code(() => site.rename('/data', '/moved')),
        'EROFS',
      );
      assert.ok(onDisk(at('data/locked/l.txt')));
      site.writeFile('/private/public/n.txt', 'n');
      assert.ok(onDisk(at('private/public/n.txt')), 'given again: writable');
      site.writeFile('/data/f2.txt', 'f2');
      assert.ok(onDisk(at('data/f2.txt')));
    } finally {
      k.close();
      rm(root);
    }
  });
});

describe('rules: the patched node:fs under strict', () => {
  it('reads, listings, writes and trees follow the settings at each path', async () => {
    const { root, k, at } = await siteKernel({ strict: true });
    fsPatch.install(k);
    try {
      assert.equal(
        code(() => fs.readFileSync(at('private/secret.txt'))),
        'EACCES',
      );
      assert.equal(
        code(() => fs.statSync(at('private'))),
        'EACCES',
      );
      assert.equal(
        code(() => fs.readdirSync(at('private'))),
        'EACCES',
      );
      assert.equal(
        fs.readFileSync(at('private/public/open.txt'), 'utf8'),
        'open',
      );
      assert.deepEqual(fs.readdirSync(at('')).sort(), [
        'a.html',
        'data',
        'lib',
        'static',
        'system',
      ]);
      assert.equal(
        code(() => fs.readFileSync(at('static/mod.js'))),
        'EACCES',
      );
      assert.equal(
        code(() => fs.writeFileSync(at('system/n.txt'), 'n')),
        'EROFS',
      );
      assert.equal(
        code(() => fs.writeFileSync(at('private/n.txt'), 'n')),
        'EACCES',
      );
      assert.equal(
        code(() => fs.accessSync(at('system/conf.txt'), fs.constants.W_OK)),
        'EACCES',
      );
      fs.accessSync(at('a.html'), fs.constants.W_OK);
      assert.equal(
        code(() => fs.rmSync(at('data'), { recursive: true })),
        'EROFS',
      );
      assert.equal(
        code(() => fs.renameSync(at('data'), at('moved'))),
        'EROFS',
      );
      assert.equal(
        code(() => fs.renameSync(at('lib'), at('system/lib'))),
        'EROFS',
      );
      assert.equal(
        code(() => fs.mkdirSync(at('system/x/y'), { recursive: true })),
        'EROFS',
      );
      assert.ok(onDisk(at('data/locked/l.txt')));
      assert.ok(!onDisk(at('system/x')));
    } finally {
      fsPatch.uninstall();
      k.close();
      rm(root);
    }
  });

  it("without strict a recursive mkdir under a hidden directory is node:fs's; under a read-only one EROFS", async () => {
    const root = writeTree(tmpDir('vfs-rules'), { 'w/a.txt': 'a' });
    const k = await kernel(root, {
      w: {
        fs: { ext: ['txt'], writable: true },
        rules: {
          '/hidden': { fs: false },
          '/ro': { fs: { writable: false } },
          '/ro/rw': { fs: { writable: true } },
        },
      },
    });
    fsPatch.install(k);
    const at = (rel) => path.join(root, 'w', rel);
    try {
      fs.mkdirSync(at('hidden/x/y'), { recursive: true });
      assert.ok(onDisk(at('hidden/x/y')));
      assert.equal(
        code(() => fs.mkdirSync(at('ro/rw/x'), { recursive: true })),
        'EROFS',
      );
    } finally {
      fsPatch.uninstall();
      k.close();
      rm(root);
    }
  });

  it('a recursive mkdir makes no directory its rules refuse above the path', async () => {
    const root = writeTree(tmpDir('vfs-rules'), { 'w/a.txt': 'a' });
    const k = await kernel(
      root,
      {
        w: {
          fs: { ext: ['txt'], writable: true },
          rules: {
            '/ro': { fs: { writable: false } },
            '/ro/rw': { fs: { writable: true } },
          },
        },
      },
      { strict: true },
    );
    fsPatch.install(k);
    const at = (rel) => path.join(root, 'w', rel);
    try {
      assert.equal(
        code(() => fs.mkdirSync(at('ro/rw/x'), { recursive: true })),
        'EROFS',
        '/ro would be made',
      );
      assert.ok(!onDisk(at('ro')));
      fsPatch.uninstall();
      fs.mkdirSync(at('ro/rw'), { recursive: true });
      fsPatch.install(k);
      fs.mkdirSync(at('ro/rw/x/y'), { recursive: true });
      assert.ok(onDisk(at('ro/rw/x/y')), '/ro is there: nothing made in it');
    } finally {
      fsPatch.uninstall();
      k.close();
      rm(root);
    }
  });
});

describe('rules: the module hooks', () => {
  it('a domain off where a module lies does not load it', async () => {
    for (const strict of [true, false]) {
      const { root, k, at } = await siteKernel({ strict });
      try {
        const lib = k.resolveModule(at('lib/m.js'), 'require');
        assert.equal(lib.key, '/lib/m.js');
        const off = k.resolveModule(at('static/mod.js'), 'require');
        assert.deepEqual(off, strict ? { denied: true } : null);
      } finally {
        k.close();
        rm(root);
      }
    }
  });
});

describe('rules: a virtual place', () => {
  const places = {
    v: {
      origin: 'virtual',
      fs: { ext: ['txt', 'js'], writable: true },
      require: true,
      rules: {
        '/ro': { fs: { writable: false } },
        '/hidden': { fs: false },
        '/tree/hidden': { fs: false },
        '/js': { require: false },
      },
    },
  };

  it('its store refuses what the rules refuse, from any thread, before any change', async () => {
    const root = tmpDir('vfs-rules');
    const k = await kernel(root, places);
    const w = worker(k);
    try {
      const v = k.fs('v');
      await v.writeFiles({
        '/tree/f.txt': 'f',
        '/js/a.js': 'module.exports = 3;',
      });
      for (const facade of [v, w.kernel.fs('v')]) {
        await assert.rejects(async () => facade.writeFile('/ro/x.txt', 'x'), {
          code: 'EROFS',
        });
        await assert.rejects(
          async () => facade.writeFile('/hidden/x.txt', 'x'),
          { code: 'EACCES' },
        );
        await assert.rejects(
          async () => facade.writeFiles({ '/ro/a/b.txt': 'b' }),
          { code: 'EROFS' },
        );
        await assert.rejects(
          async () => facade.mkdir('/ro/a', { recursive: true }),
          { code: 'EROFS' },
        );
        await assert.rejects(
          async () => facade.rm('/tree', { recursive: true }),
          { code: 'EACCES' },
        );
        await assert.rejects(async () => facade.rename('/tree', '/moved'), {
          code: 'EACCES',
        });
      }
      // The store checks again, whoever routed the mutation: the main
      // thread's end of a worker's request goes straight to it.
      const { store } = k.registry.get('v');
      await assert.rejects(
        async () => store.write('/ro/x.txt', Buffer.from('x')),
        { code: 'EROFS', path: v.pathOf('/ro/x.txt') },
      );
      await assert.rejects(async () => store.rm('/tree', { recursive: true }), {
        code: 'EACCES',
      });
      assert.equal(v.readFile('/tree/f.txt', 'utf8'), 'f');
      assert.deepEqual(v.readdir('/js'), ['a.js']);
      assert.equal(
        k.resolveModule(path.join(root, 'v', 'js', 'a.js'), 'require'),
        null,
      );
      await assertAtRest(k, { workers: [w.kernel] });
    } finally {
      w.kernel.close();
      k.close();
      rm(root);
    }
  });
});

// The 8.3 spelling Windows gives an existing path, or null without one
// (path-identity.test.js).
const shortPath = (p) => {
  const { stdout } = spawnSync(
    'cmd',
    ['/d', '/c', `for %I in ("${p}") do @echo %~sI`],
    { windowsVerbatimArguments: true, encoding: 'utf8' },
  );
  const short = stdout.trim();
  return short && short.toLowerCase() !== p.toLowerCase() ? short : null;
};

describe('rules: other spellings of a hidden path', () => {
  const files = {
    'site/a.html': 'a',
    'site/confidential/secret.md': 'secret',
    'site/open/notes.md': 'notes',
  };
  const place = {
    fs: { ext: ['html'], fallback: 'disk' },
    rules: { '/confidential': { fs: false } },
  };

  it(
    'the disk territory takes no 8.3 name anywhere in a key, in either mode',
    { skip: process.platform !== 'win32' },
    async (t) => {
      for (const strict of [false, true]) {
        const root = writeTree(tmpDir('vfs-rules-83'), files);
        const k = await kernel(root, { site: place }, { strict });
        try {
          const short = shortPath(path.join(root, 'site', 'confidential'));
          if (short === null) {
            return void t.skip('the volume makes no 8.3 names');
          }
          const brief = path.basename(short);
          const site = k.fs('site');
          assert.equal(site.readFile('/open/notes.md', 'utf8'), 'notes');
          assert.equal(site.readFile(`/${brief}/secret.md`), null);
          assert.equal(site.exists(`/${brief}`), false);
          assert.equal(site.stat(`/${brief}/secret.md`), null);
          assert.throws(() => site.readdir(`/${brief}`), { code: 'ENOENT' });
          assert.ok(
            !site
              .readdir('/', { recursive: true })
              .includes('confidential/secret.md'),
          );
        } finally {
          k.close();
          rm(root);
        }
      }
    },
  );

  it('another case of a hidden path is hidden where the disk takes it for one', async () => {
    const root = writeTree(tmpDir('vfs-rules-case'), files);
    const k = await kernel(root, { site: place });
    try {
      const site = k.fs('site');
      assert.equal(site.readFile('/CONFIDENTIAL/secret.md'), null);
      assert.equal(site.exists('/Confidential'), false);
    } finally {
      k.close();
      rm(root);
    }
  });
});
