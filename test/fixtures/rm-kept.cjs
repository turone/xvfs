'use strict';

// Run by test/reentry.test.js in a plain node process. Unlike a
// `node --test` child, where test/helpers.js has already removed a tree,
// nothing has loaded Node's rimraf yet — the JavaScript walk of fs.rm and
// fs.promises.rm, and of a recursive rmSync on Node 22 — which keeps the
// functions it finds on node:fs when it first loads. initialize() loads it
// before the patch is installed. Each way to remove a tree removes one
// whose files the routed listing does not show (written after the scan:
// hidden under strict) and one that exists on disk only. Prints one JSON
// line.

const fs = require('node:fs');
const path = require('node:path');
const fsPatch = require('../../lib/adapters/fs-patch.js');
const { tmpDir, writeTree, rm, kernel } = require('../helpers.js');

const RIMRAF = 'NativeModule internal/fs/rimraf';
const loaded = () => process.moduleLoadList.includes(RIMRAF);

// name → remove(kernel, absolute path, place key), recursively.
const REMOVALS = {
  place: (k, abs, key) => k.fs('site').rm(key, { recursive: true }),
  rmSync: (k, abs) => fs.rmSync(abs, { recursive: true }),
  rm: (k, abs) =>
    new Promise((resolve, reject) => {
      fs.rm(abs, { recursive: true }, (err) => (err ? reject(err) : resolve()));
    }),
  promises: (k, abs) => fs.promises.rm(abs, { recursive: true }),
};

const main = async () => {
  const loadedBefore = loaded();
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
  const loadedAtInstall = loaded();
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
  const result = { loadedBefore, loadedAtInstall, failed, left };
  process.stdout.write(JSON.stringify(result) + '\n');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
