'use strict';

// Run by test/reentry.test.js in a plain node process, one mode per run.
// Code that ran before the library wrapped node:fs first:
//   defer    fs.rm defers each call a turn, as a tracer or a mock may;
//   lstat    fs.lstat is wrapped;
//   capture  fs.rm takes the fs.lstat it finds when it is called — the
//            stand-in of loadRimraf(), when it is the one to call it — and
//            uses it again later.
// Then the library loads (disk.js takes node:fs as it finds it), a strict
// kernel over a writable disk-origin place is installed, and the
// asynchronous forms remove trees holding files the routed listing does
// not show. Prints one JSON line.

const fs = require('node:fs');
const path = require('node:path');

const mode = process.argv[2];
const RIMRAF = 'NativeModule internal/fs/rimraf';
const loaded = () => process.moduleLoadList.includes(RIMRAF);

let foreignLstat = null;
let captured = null;
if (mode === 'defer') {
  const { rm } = fs;
  fs.rm = function (...args) {
    setImmediate(() => rm.apply(fs, args));
  };
} else if (mode === 'lstat') {
  const { lstat } = fs;
  foreignLstat = function (...args) {
    // eslint-disable-next-line no-invalid-this
    return lstat.apply(this, args);
  };
  fs.lstat = foreignLstat;
} else if (mode === 'capture') {
  const { rm } = fs;
  fs.rm = function (...args) {
    captured ??= fs.lstat;
    return rm.apply(fs, args);
  };
}

// Only now the library.
const fsPatch = require('../../lib/adapters/fs-patch.js');
const {
  tmpDir,
  writeTree,
  rm: rmTree,
  kernel,
  quiet,
} = require('../helpers.js');

// Settles as `promise` does, or with 'hung' after `ms`.
const bounded = (promise, ms = 5000) => {
  let late = null;
  const hung = new Promise((resolve) => {
    late = setTimeout(resolve, ms, 'hung');
  });
  return Promise.race([promise, hung]).finally(() => clearTimeout(late));
};

// What an lstat answers for a file: 'file', its error code, or 'hung'.
const answerOf = (lstat, file) =>
  bounded(
    new Promise((resolve) => {
      lstat(file, (err, stats) =>
        resolve(err ? err.code : stats.isFile() && 'file'),
      );
    }),
  );

const REMOVALS = {
  rm: (abs) =>
    new Promise((resolve, reject) => {
      fs.rm(abs, { recursive: true }, (err) => (err ? reject(err) : resolve()));
    }),
  promises: (abs) => fs.promises.rm(abs, { recursive: true }),
};

const main = async () => {
  const report = { mode };
  const root = writeTree(tmpDir('vfs-rm-wrapped'), {
    'site/rm/a.txt': 'a',
    'site/promises/a.txt': 'a',
  });
  const at = (...p) => path.join(root, 'site', ...p);
  const warnings = [];
  const k = await kernel(
    root,
    { site: { fs: { ext: ['txt'], writable: true } } },
    { strict: true, watchTimeout: 600000 },
    { console: { ...quiet, warn: (m) => warnings.push(m) } },
  );
  k.watcher.close();
  for (const name of Object.keys(REMOVALS)) {
    fs.writeFileSync(at(name, 'b.txt'), 'b');
    fs.writeFileSync(at(name, 'c.bin'), 'c');
    fs.mkdirSync(at(`${name}-only`));
    fs.writeFileSync(at(`${name}-only`, 'd.txt'), 'd');
  }
  report.loadedBefore = loaded();
  fsPatch.install(k);
  report.loadedAtInstall = loaded();
  report.warnings = warnings.length;
  if (mode === 'capture') {
    report.captured = captured !== null;
    if (captured) report.answers = await answerOf(captured, at('rm', 'a.txt'));
  }
  const failed = {};
  for (const [name, remove] of Object.entries(REMOVALS)) {
    for (const dir of [name, `${name}-only`]) {
      try {
        const outcome = await bounded(remove(at(dir)));
        if (outcome === 'hung') failed[dir] = 'hung';
      } catch (err) {
        failed[dir] = err.code;
      }
    }
  }
  report.failed = failed;
  fsPatch.uninstall();
  if (mode === 'lstat') report.lstatRestored = fs.lstat === foreignLstat;
  report.left = fs.readdirSync(at()).sort();
  k.close();
  rmTree(root);
  process.stdout.write(JSON.stringify(report) + '\n');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
