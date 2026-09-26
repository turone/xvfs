'use strict';

// Run by test/reentry.test.js in a plain node process. Unlike a
// `node --test` child, where test/helpers.js has already removed a tree,
// nothing has loaded Node's rimraf yet — the JavaScript walk of fs.rm and
// fs.promises.rm, and of a recursive rmSync on Node 22 — which keeps the
// functions it finds on node:fs when it first loads. One mode per run:
//   native   initialize() loads rimraf before the patch is installed:
//            every form removes the trees, sync or not.
//   patched  as in a worker, the patch is installed with no initialize()
//            and rimraf first loads under it: the synchronous forms still
//            remove the trees — in the native section the functions it
//            kept are the originals — while its asynchronous walk runs past
//            any section (doc/architecture.md), so no such form runs here.
// Each form removes a tree holding files the routed listing does not show
// — written after the scan, or never published — and one that exists on
// disk only. Prints one JSON line.

const fs = require('node:fs');
const os = require('node:os');
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

// mode → { forms it runs, its kernel over `root` }
const MODES = {
  native: {
    forms: Object.keys(REMOVALS),
    open: async (root) => {
      const k = await kernel(root, PLACES, {
        strict: true,
        watchTimeout: 600000,
      });
      k.watcher.close();
      return k;
    },
  },
  patched: {
    forms: ['place', 'rmSync'],
    open: async (root) =>
      VfsKernel.fromSnapshot({ segments: [], places: {} }, config(PLACES), {
        appRoot: root,
        console: quiet,
      }),
  },
};

const main = async (mode) => {
  const { forms, open } = MODES[mode];
  const loadedBefore = loaded();
  const tree = {};
  for (const name of forms) tree[`site/${name}/a.txt`] = 'a';
  const root = writeTree(tmpDir('vfs-rm-kept'), tree);
  const at = (...p) => path.join(root, 'site', ...p);
  const k = await open(root);
  // Written after the scan: on disk, not published.
  for (const name of forms) {
    fs.writeFileSync(at(name, 'b.txt'), 'b');
    fs.writeFileSync(at(name, 'c.bin'), 'c');
    fs.mkdirSync(at(`${name}-only`));
    fs.writeFileSync(at(`${name}-only`, 'd.txt'), 'd');
  }
  const loadedAtInstall = loaded();
  fsPatch.install(k);
  // A path outside appRoot passes through: a rimraf not loaded yet loads
  // now, under the patch.
  const missing = path.join(os.tmpdir(), `vfs-rm-kept-${process.pid}-none`);
  await new Promise((resolve) => {
    fs.rm(missing, { recursive: true, force: true }, resolve);
  });
  const loadedAtRemoval = loaded();
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
    loadedAtRemoval,
    failed,
    left,
  };
  process.stdout.write(JSON.stringify(result) + '\n');
};

main(process.argv[2] || 'native').catch((err) => {
  console.error(err);
  process.exit(1);
});
