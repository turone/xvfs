'use strict';

// Run by test/reentry.test.js in a plain node process. Unlike a
// `node --test` child, where test/helpers.js may have removed a tree
// already, nothing has loaded Node's rimraf yet — the JavaScript walk of
// fs.rm and fs.promises.rm, and of a recursive rmSync on Node 22 — which
// keeps the functions it finds on node:fs when it first loads. install()
// loads it first, synchronously, over node:fs itself, whatever made the
// kernel it routes to — one mode per run:
//   initialized  initialize(), as the bootstrap does;
//   projected    a projection and no initialize(), as a worker's attach().
// In each, every form removes a tree holding files the routed listing does
// not show — written after the scan, or never published — and one that
// exists on disk only. Prints one JSON line.

const fs = require('node:fs');
const path = require('node:path');
const { VfsKernel } = require('../../lib/kernel.js');
const fsPatch = require('../../lib/adapters/fs-patch.js');
const {
  tmpDir,
  writeTree,
  rm,
  config,
  kernel,
  quiet,
} = require('../helpers.js');

const RIMRAF = 'NativeModule internal/fs/rimraf';
const loaded = () => process.moduleLoadList.includes(RIMRAF);

const PLACES = { site: { fs: { ext: ['txt'], writable: true } } };

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

// mode → its kernel over `root`
const MODES = {
  initialized: async (root) => {
    const k = await kernel(root, PLACES, {
      strict: true,
      watchTimeout: 600000,
    });
    k.watcher.close();
    return k;
  },
  projected: async (root) =>
    VfsKernel.fromSnapshot({ segments: [], places: {} }, config(PLACES), {
      appRoot: root,
      console: quiet,
    }),
};

const main = async (mode) => {
  const forms = Object.keys(REMOVALS);
  const loadedBefore = loaded();
  const tree = {};
  for (const name of forms) tree[`site/${name}/a.txt`] = 'a';
  const root = writeTree(tmpDir('vfs-rm-kept'), tree);
  const at = (...p) => path.join(root, 'site', ...p);
  const k = await MODES[mode](root);
  // Written after the scan: on disk, not published.
  for (const name of forms) {
    fs.writeFileSync(at(name, 'b.txt'), 'b');
    fs.writeFileSync(at(name, 'c.bin'), 'c');
    fs.mkdirSync(at(`${name}-only`));
    fs.writeFileSync(at(`${name}-only`, 'd.txt'), 'd');
  }
  const loadedAtInstall = loaded();
  fsPatch.install(k);
  const loadedAfterInstall = loaded();
  const failed = {};
  for (const name of forms) {
    for (const dir of [name, `${name}-only`]) {
      try {
        await REMOVALS[name](k, at(dir), `/${dir}`);
      } catch (err) {
        failed[dir] = err.code;
      }
    }
  }
  fsPatch.uninstall();
  const left = fs.readdirSync(at()).sort();
  k.close();
  rm(root);
  const result = {
    mode,
    loadedBefore,
    loadedAtInstall,
    loadedAfterInstall,
    failed,
    left,
  };
  process.stdout.write(JSON.stringify(result) + '\n');
};

main(process.argv[2] || 'initialized').catch((err) => {
  console.error(err);
  process.exit(1);
});
