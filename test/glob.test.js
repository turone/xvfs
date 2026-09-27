'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fsPatch = require('../lib/adapters/fs-patch.js');
const { tmpDir, writeTree, rm, kernel } = require('./helpers.js');

// glob walks with the node:fs functions it captured when Node loaded it. A
// `node --test` child loads it before any test runs, so here it walks
// natively — a walk install() cannot route: over managed territory it is
// refused, elsewhere it stays native. The routed walk — glob loaded by
// install(), as in an application — runs in a plain node process
// (fixtures/glob-routed.cjs), in both modes: it lists what the places list.

const GLOB = 'NativeModule internal/fs/glob';

// UNC and namespace spellings exist on Windows, of a path on a drive.
const WIN = process.platform === 'win32';
const ON_DRIVE = /^[A-Za-z]:\\/.test(os.tmpdir());
const NAMESPACES = !WIN
  ? 'Windows: UNC and namespace spellings'
  : !ON_DRIVE && 'the temporary directory is not on a drive';

const slashed = (list) =>
  list.map((p) => String(p).split(path.sep).join('/')).sort();

// The refusal of a glob: its code, the operation and where the walk would
// have started.
const refused = (err, code, start, detail) => {
  assert.equal(err?.code, code, err?.message ?? String(err));
  assert.equal(err.syscall, 'scandir');
  assert.equal(err.path, start);
  assert.equal(err.dest, undefined);
  if (detail) assert.ok(err.message.includes(`(${detail})`), err.message);
};

// Every form of glob with `pattern` and `options` fails so.
const refusedEach = async (pattern, options, code, start, detail) => {
  assert.throws(
    () => fs.globSync(pattern, options),
    (err) => refused(err, code, start, detail) ?? true,
  );
  const viaCallback = await new Promise((resolve) => {
    fs.glob(pattern, options, (err) => resolve(err));
  });
  refused(viaCallback, code, start, detail);
  await assert.rejects(
    fs.promises.glob(pattern, options).next(),
    (err) => refused(err, code, start, detail) ?? true,
  );
};

describe('glob loaded before the patch: a native walk', () => {
  let base;
  let root;
  let other;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    assert.ok(
      process.moduleLoadList.includes(GLOB),
      'the test runner loads glob before any test: it walks natively here',
    );
    base = writeTree(tmpDir('vfs-glob-native'), {
      'app/site/index.html': '<h1>',
      'app/site/logo.png': 'PNG',
      'app/closed/index.html': '<h1>',
      'app/stray/x.png': 'stray',
      'other/o.txt': 'o',
      'other/sub/p.txt': 'p',
    });
    root = path.join(base, 'app');
    other = path.join(base, 'other');
    k = await kernel(
      root,
      {
        site: { fs: { ext: ['html'], fallback: 'disk' } },
        closed: { fs: { ext: ['html'], fallback: 'deny' } },
        mem: { provider: 'map', origin: 'virtual', fs: { writable: true } },
      },
      { strict: true },
    );
    k.fs('mem').writeFile('/m.txt', 'm');
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(base);
  });

  it('a walk that starts in or above managed territory is ENOTSUP, in every form', async () => {
    const posix = (p) => p.split(path.sep).join('/');
    for (const [pattern, options, start] of [
      ['**', { cwd: root }, root],
      ['*', { cwd: pathToFileURL(root) }, root],
      ['site/**', { cwd: root }, at('site')],
      ['./site/*.html', { cwd: root }, at('site')],
      ['**', { cwd: at('site') }, at('site')],
      ['**', { cwd: at('mem') }, at('mem')],
      ['*.html', { cwd: at('closed') }, at('closed')],
      ['**', { cwd: base }, base],
      ['app/site/*.html', { cwd: base }, at('site')],
      ['../app/mem/*', { cwd: other }, at('mem')],
      [posix(at('site', '**')), undefined, at('site')],
      [posix(at('site', 'index.html')), undefined, at('site', 'index.html')],
      [['other/*', 'app/**'], { cwd: base }, root],
    ]) {
      await refusedEach(
        pattern,
        options,
        'ENOTSUP',
        start,
        'native walk into places',
      );
    }
  });

  it('a start the routing denies is EACCES before any walk', async () => {
    for (const [pattern, options, start] of [
      ['*', { cwd: at('stray') }, at('stray')],
      ['stray/**', { cwd: root }, at('stray')],
      ['app/stray/*', { cwd: base }, at('stray')],
      ['site/late.html', { cwd: root }, at('site', 'late.html')],
      ['closed/logo.png/**', { cwd: root }, at('closed', 'logo.png')],
    ]) {
      await refusedEach(pattern, options, 'EACCES', start);
    }
  });

  // Under strict a UNC or namespace spelling of the start — `\\?\…`,
  // `\\.\…`, with `/` too, an admin share by name or address, a server
  // that does not exist — is refused as the routing refuses it, before the
  // walk that would have asked the disk, or the network, about it.
  it(
    'a UNC or namespace cwd or pattern is EACCES before any walk',
    { skip: NAMESPACES },
    async () => {
      const site = at('site');
      const share = `${site[0]}$${site.slice(2)}`;
      const posix = (p) => p.replace(/\\/g, '/');
      const spellings = [
        `\\\\?\\${site}`,
        `//?/${posix(site)}`,
        `\\\\.\\${site}`,
        `\\\\localhost\\${share}`,
        `//127.0.0.1/${posix(share)}`,
        `\\\\?\\UNC\\localhost\\${share}`,
        `\\\\smfs-no-such-host.invalid\\share${site.slice(2)}`,
      ];
      for (const cwd of spellings) {
        await refusedEach('**', { cwd }, 'EACCES', path.resolve(cwd));
      }
      // In a pattern `?` is a wildcard: `\\?\` names no namespace there,
      // and such a walk starts at the root of the drive, outside appRoot.
      for (const cwd of spellings.filter((s) => !s.includes('?'))) {
        const pattern = `${posix(cwd)}/*.html`;
        await refusedEach(pattern, undefined, 'EACCES', path.resolve(cwd));
      }
    },
  );

  it('elsewhere it stays native', async () => {
    const expected = ['.', 'o.txt', 'sub', 'sub/p.txt'];
    assert.deepEqual(slashed(fs.globSync('**', { cwd: other })), expected);
    const viaCallback = await new Promise((resolve, reject) => {
      fs.glob('**', { cwd: other }, (err, m) =>
        err ? reject(err) : resolve(m),
      );
    });
    assert.deepEqual(slashed(viaCallback), expected);
    const collected = [];
    for await (const entry of fs.promises.glob('**', { cwd: other })) {
      collected.push(entry);
    }
    assert.deepEqual(slashed(collected), expected);
    assert.deepEqual(
      fs.globSync(path.join(other, '*.txt').split(path.sep).join('/')),
      [path.join(other, 'o.txt')],
    );
    // A pattern array: refused as a whole when one walk starts in a place.
    assert.deepEqual(slashed(fs.globSync(['sub/*', 'o.*'], { cwd: other })), [
      'o.txt',
      'sub/p.txt',
    ]);
  });

  it('without strict the same native walk into the places is refused', async () => {
    const loose = await kernel(root, {
      site: { fs: { ext: ['html'], fallback: 'disk' } },
    });
    fsPatch.uninstall();
    fsPatch.install(loose);
    try {
      await refusedEach(
        '**',
        { cwd: root },
        'ENOTSUP',
        root,
        'native walk into places',
      );
      await refusedEach(
        'site/*',
        { cwd: root },
        'ENOTSUP',
        at('site'),
        'native walk into places',
      );
      // An unmanaged directory under appRoot is native territory here.
      assert.deepEqual(fs.globSync('*', { cwd: at('stray') }), ['x.png']);
    } finally {
      fsPatch.uninstall();
      fsPatch.install(k);
      loose.close();
    }
  });
});

describe('glob loaded by install(): the routed walk', () => {
  // What the routed walk lists over the fixture's tree, in either mode:
  // published entries, virtual entries, the disk territory (uncached
  // files, disk directories), never a cached extension left unpublished
  // (late.html, raw.html), nothing of a `fallback: 'deny'` place but its
  // published entries.
  const MANAGED = [
    '.',
    'closed',
    'closed/index.html',
    'mem',
    'mem/dir',
    'mem/dir/n.txt',
    'mem/m.txt',
    'site',
    'site/index.html',
    'site/logo.png',
    'site/media',
    'site/media/clip.mp4',
    'site/sub',
    'site/sub/page.html',
  ];
  const SITE = [
    '.',
    'index.html',
    'logo.png',
    'media',
    'media/clip.mp4',
    'sub',
    'sub/page.html',
  ];

  it('lists what the places list, in both modes and every form', () => {
    const script = path.join(__dirname, 'fixtures', 'glob-routed.cjs');
    const out = JSON.parse(
      execFileSync(process.execPath, [script], { encoding: 'utf8' }),
    );
    assert.equal(out.loadedBefore, false);
    const { strict, loose } = out;
    for (const mode of [strict, loose]) {
      assert.equal(mode.loadedAfterInstall, true, 'install() loads glob');
      assert.deepEqual(mode.site, SITE);
      assert.deepEqual(
        mode.absolute,
        SITE.map((rel) => (rel === '.' ? 'site' : `site/${rel}`)),
      );
      assert.deepEqual(mode.url, ['mem/dir', 'mem/m.txt']);
      assert.deepEqual(mode.typed, [
        'closed/index.html',
        'site/index.html',
        'site/sub/page.html',
      ]);
      assert.deepEqual(mode.excluded, mode.all);
      assert.deepEqual(mode.upward, ['../mem/dir', '../mem/m.txt']);
      assert.equal(mode.deniedPrefix, 'EACCES');
      // The caller's exclude sees listed names only, never a hidden one.
      for (const hidden of ['late.html', 'raw.html', 'logo.png/closed']) {
        assert.ok(!mode.seenByExclude.includes(hidden), hidden);
      }
    }
    assert.deepEqual(strict.all, MANAGED);
    assert.deepEqual(strict.top, ['closed', 'mem', 'site']);
    assert.equal(strict.deniedCwd, 'EACCES');
    assert.ok(!strict.seenByExclude.includes('x.png'));
    assert.ok(!strict.seenByExclude.includes('stray'));
    // Without strict an unmanaged directory is native territory.
    assert.deepEqual(loose.all, [...MANAGED, 'stray', 'stray/x.png'].sort());
    assert.deepEqual(loose.top, ['closed', 'mem', 'site', 'stray']);
    assert.equal(loose.deniedCwd, null);
  });
});
