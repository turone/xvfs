'use strict';

// Run by test/reentry.test.js in a plain node process. Unlike a
// `node --test` child, where test/helpers.js has already removed a tree,
// nothing has loaded Node's rimraf yet — the JavaScript walk of a recursive
// rmSync on Node 22 — so it first loads while the patch is installed and
// keeps the functions it finds on node:fs, as it would in an application.
// Each way to remove a tree removes one whose files the routed listing
// does not show (written after the scan: hidden under strict) and one that
// exists on disk only. Prints one JSON line.

const fs = require('node:fs');
const path = require('node:path');
const fsPatch = require('../../lib/adapters/fs-patch.js');
const { tmpDir, writeTree, rm, kernel } = require('../helpers.js');

const RIMRAF = 'NativeModule internal/fs/rimraf';

// name → remove(kernel, absolute path, place key), recursively.
const REMOVALS = {
  place: (k, abs, key) => k.fs('site').rm(key, { recursive: true }),
};

const main = async () => {
  const loadedBefore = process.moduleLoadList.includes(RIMRAF);
  const names = Object.keys(REMOVALS);
  const tree = {};
  for (const name of names) tree[`site/${name}/a.txt`] = 'a';
  const root = writeTree(tmpDir('vfs-rm-kept'), tree);
  const at = (...p) => path.join(root, 'site', ...p);
  const k = await kernel(
    root,
    { site: { fs: { ext: ['txt'], writable: true } } },
    { strict: true, watchTimeout: 600000 },
  );
  k.watcher.close();
  for (const name of names) {
    fs.writeFileSync(at(name, 'b.txt'), 'b');
    fs.writeFileSync(at(name, 'c.bin'), 'c');
    fs.mkdirSync(at(`${name}-only`));
    fs.writeFileSync(at(`${name}-only`, 'd.txt'), 'd');
  }
  fsPatch.install(k);
  const failed = {};
  for (const [name, remove] of Object.entries(REMOVALS)) {
    for (const dir of [name, `${name}-only`]) {
      try {
        await remove(k, at(dir), `/${dir}`);
      } catch (err) {
        failed[dir] = err.code;
      }
    }
  }
  fsPatch.uninstall();
  const left = fs.readdirSync(at()).sort();
  k.close();
  rm(root);
  process.stdout.write(JSON.stringify({ loadedBefore, failed, left }) + '\n');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
