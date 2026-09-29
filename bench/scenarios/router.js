'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tmpDir, writeTree, cleanup, kernel } = require('../lib.js');

// Routing decisions on the hot path, through the adapter API
// (routeRead / routeMutation = FsRouter.read / mutate). Under strict a
// route on a place's disk is checked by the place's `links`: `strict.*`
// with 'deny', the default — against the links the kernel knows, which in
// place `dl` are LINKS (`linked`: a path beside them, `through`: one
// through one) — and `strict.verify.*` with 'verify', one realpath each;
// strict as it was where the library does not know `links` (a base of
// bench/ab.js before it).

const PLACES = {
  site: { fs: true },
  v: { origin: 'virtual', fs: { writable: true } },
  d: { provider: 'disk', fs: { writable: true } },
  dl: { provider: 'disk', fs: { writable: true } },
};

const LINKS = 10;

const MODES = {
  open: {},
  strict: { strict: true },
  'strict.verify': { strict: true, links: 'verify' },
};

const kernelOf = async (root, defaults) => {
  try {
    return await kernel(root, PLACES, defaults);
  } catch (err) {
    if (defaults.links === undefined || !/links/.test(err.message)) throw err;
    const before = { ...defaults };
    delete before.links;
    return kernel(root, PLACES, before);
  }
};

const routes = async (b, mode) => {
  const root = writeTree(tmpDir('router'), {
    'site/a.txt': 'a',
    'site/dir/b.txt': 'b',
    'dl/f.txt': 'f',
  });
  const out = writeTree(tmpDir('router-out'), { 'x.txt': 'x' });
  const at = (...p) => path.join(root, ...p);
  const links = [];
  fs.mkdirSync(at('dl', 'links'));
  for (let i = 0; i < LINKS; i++) {
    links.push(at('dl', 'links', `j${i}`));
    fs.symlinkSync(out, links.at(-1), 'junction');
  }
  const k = await kernelOf(root, MODES[mode]);
  const outside = path.join(os.tmpdir(), 'elsewhere', 'x.txt');
  try {
    const reads = {
      file: at('site', 'a.txt'),
      dir: at('site', 'dir'),
      miss: at('site', 'none.txt'),
      unmanaged: at('other', 'x.txt'),
      outside,
      linked: at('dl', 'f.txt'),
      through: at('dl', 'links', 'j0', 'x.txt'),
    };
    for (const [name, p] of Object.entries(reads)) {
      b.ops(`router.${mode}.read.${name}`, () => k.routeRead(p));
    }
    const mutations = {
      store: at('v', 'f.txt'),
      disk: at('d', 'f.txt'),
      outside,
      linked: at('dl', 'g.txt'),
    };
    for (const [name, p] of Object.entries(mutations)) {
      b.ops(`router.${mode}.mutate.${name}`, () => k.routeMutation(p));
    }
  } finally {
    k.close();
    for (const link of links) fs.unlinkSync(link);
    cleanup(root);
    cleanup(out);
  }
};

module.exports = async (b) => {
  for (const mode of Object.keys(MODES)) await routes(b, mode);
};
