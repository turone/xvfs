'use strict';

const os = require('node:os');
const path = require('node:path');
const { tmpDir, writeTree, cleanup, kernel } = require('../lib.js');

// Routing decisions on the hot path, through the adapter API
// (routeRead / routeMutation = FsRouter.read / mutate).

const PLACES = {
  site: { fs: true },
  v: { origin: 'virtual', fs: { writable: true } },
  d: { provider: 'disk', fs: { writable: true } },
};

const routes = async (b, strict) => {
  const root = writeTree(tmpDir('router'), {
    'site/a.txt': 'a',
    'site/dir/b.txt': 'b',
  });
  const k = await kernel(root, PLACES, { strict });
  const at = (...p) => path.join(root, ...p);
  const outside = path.join(os.tmpdir(), 'elsewhere', 'x.txt');
  const mode = strict ? 'strict' : 'open';
  try {
    const reads = {
      file: at('site', 'a.txt'),
      dir: at('site', 'dir'),
      miss: at('site', 'none.txt'),
      unmanaged: at('other', 'x.txt'),
      outside,
    };
    for (const [name, p] of Object.entries(reads)) {
      b.ops(`router.${mode}.read.${name}`, () => k.routeRead(p));
    }
    const mutations = {
      store: at('v', 'f.txt'),
      disk: at('d', 'f.txt'),
      outside,
    };
    for (const [name, p] of Object.entries(mutations)) {
      b.ops(`router.${mode}.mutate.${name}`, () => k.routeMutation(p));
    }
  } finally {
    k.close();
    cleanup(root);
  }
};

module.exports = async (b) => {
  await routes(b, false);
  await routes(b, true);
};
