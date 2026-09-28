'use strict';

// Run by test/links.test.js in a node process started with
// --preserve-symlinks, where Node's resolver keeps the link in a module's
// path: under strict a module that a link in a node-default place takes
// into another place is not found — the load hook proves where the file
// really lies — while one of the place's own loads. The tree and its link
// are the test's (argv[2]). Prints one JSON line.

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fsPatch = require('../../lib/adapters/fs-patch.js');
const moduleHook = require('../../lib/adapters/module-hook.js');
const { kernel } = require('../helpers.js');

const [root] = process.argv.slice(2);

const PLACES = {
  nd: { provider: 'node-default', fs: true, require: { compile: false } },
  lib: { require: { prepare: 'mod' }, import: { ext: ['mjs'] } },
};
const preparers = {
  mod: (raw) => raw.toString().replace("'raw'", "'prepared'"),
};

const outcome = async (load) => {
  try {
    return { value: await load() };
  } catch (err) {
    return { code: err.code };
  }
};

const main = async () => {
  const k = await kernel(root, PLACES, { strict: true }, { preparers });
  fsPatch.install(k);
  moduleHook.install(k);
  try {
    const at = (...p) => path.join(root, ...p);
    const esm = pathToFileURL(at('nd', 'jlib', 'e.mjs')).href;
    const result = {
      linked: await outcome(() => require(at('nd', 'jlib', 'm.js'))),
      esm: await outcome(async () => (await import(esm)).default),
      own: await outcome(() => require(at('nd', 'own.js'))),
      ran: globalThis.__smfsLinked === true,
    };
    process.stdout.write(JSON.stringify(result));
  } finally {
    moduleHook.uninstall();
    fsPatch.uninstall();
    k.close();
  }
};

main();
