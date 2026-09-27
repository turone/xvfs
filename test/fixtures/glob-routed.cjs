'use strict';

// Run by test/glob.test.js in a plain node process. Nothing has loaded glob
// before install() loads it under the patch, so it walks through the
// wrappers — the routed walk, the one an application gets. Lists a tree of
// places under strict and without, in every form, and prints one JSON line.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fsPatch = require('../../lib/adapters/fs-patch.js');
const { tmpDir, writeTree, rm, kernel } = require('../helpers.js');

const { writeFileSync: writeDisk, mkdirSync: mkdirDisk, unlinkSync } = fs;
const GLOB = 'NativeModule internal/fs/glob';

const slashed = (list) =>
  list.map((p) => String(p).split(path.sep).join('/')).sort();

const failure = async (fn) => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

const collect = async (iterator) => {
  const out = [];
  for await (const entry of iterator) out.push(entry);
  return out;
};

// The three forms agree, or the fixture fails.
const listing = async (pattern, options) => {
  const sync = slashed(fs.globSync(pattern, options));
  const called = slashed(
    await new Promise((resolve, reject) => {
      fs.glob(pattern, options, (err, m) => (err ? reject(err) : resolve(m)));
    }),
  );
  const promised = slashed(await collect(fs.promises.glob(pattern, options)));
  for (const other of [called, promised]) {
    if (JSON.stringify(other) !== JSON.stringify(sync)) {
      throw new Error(`forms differ for ${pattern}: ${sync} | ${other}`);
    }
  }
  return sync;
};

const main = async () => {
  const loadedBefore = process.moduleLoadList.includes(GLOB);
  const root = writeTree(tmpDir('vfs-glob-routed'), {
    'site/index.html': '<h1>',
    'site/logo.png': 'PNG',
    'site/media/clip.mp4': 'MP4',
    'site/sub/page.html': 'page',
    'closed/index.html': '<h1>',
    'closed/logo.png': 'PNG',
    'stray/x.png': 'stray',
  });
  const at = (...p) => path.join(root, ...p);
  // The virtual place's directory exists on disk, empty: a non-strict
  // appRoot lists natively, and enumerates only what is on disk.
  mkdirDisk(at('mem'));
  const relative = (list) =>
    slashed(list.map((p) => path.relative(root, String(p))));
  const results = { loadedBefore };
  // Cached extensions written after each scan: never published.
  const late = [at('site', 'late.html'), at('site', 'media', 'raw.html')];
  for (const strict of [true, false]) {
    const k = await kernel(
      root,
      {
        site: { fs: { ext: ['html'], fallback: 'disk' } },
        closed: { fs: { ext: ['html'], fallback: 'deny' } },
        mem: { provider: 'map', origin: 'virtual', fs: { writable: true } },
      },
      { strict },
    );
    for (const file of late) writeDisk(file, 'hidden');
    k.fs('mem').writeFile('/m.txt', 'm');
    k.fs('mem').writeFile('/dir/n.txt', 'n');
    fsPatch.install(k);
    try {
      const mode = {};
      mode.loadedAfterInstall = process.moduleLoadList.includes(GLOB);
      mode.all = await listing('**', { cwd: root });
      mode.top = await listing('*', { cwd: root });
      mode.site = await listing('**', { cwd: at('site') });
      mode.absolute = relative(
        fs.globSync(at('site', '**').split(path.sep).join('/')),
      );
      mode.url = await listing('mem/*', { cwd: pathToFileURL(root) });
      mode.typed = relative(
        fs
          .globSync('**/*.html', { cwd: root, withFileTypes: true })
          .map((d) => path.join(d.parentPath, d.name)),
      );
      const seen = new Set();
      mode.excluded = await listing('**', {
        cwd: root,
        exclude: (entry) => {
          seen.add(String(entry.name ?? entry));
          return false;
        },
      });
      mode.seenByExclude = [...seen].sort();
      mode.upward = await listing('../mem/*', { cwd: at('site') });
      mode.deniedCwd = await failure(() =>
        fs.globSync('*', { cwd: at('stray') }),
      );
      mode.deniedPrefix = await failure(() =>
        fs.globSync('closed/logo.png/**', { cwd: root }),
      );
      results[strict ? 'strict' : 'loose'] = mode;
    } finally {
      fsPatch.uninstall();
      k.close();
      for (const file of late) unlinkSync(file);
    }
  }
  rm(root);
  process.stdout.write(JSON.stringify(results) + '\n');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
