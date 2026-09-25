'use strict';

const { tmpDir, cleanup, kernel, memory } = require('../lib.js');

// Latency of one writeFile until its version is published: sab + virtual
// (a Promise that settles after the epoch commits) and map + virtual
// (synchronous), raw bytes and a prepared .js source with require bytecode.
// Keys rotate over 64 names, so every write after the first round replaces
// a version (and, for sab, retires it).

const KEYS = 64;
const RAW = Buffer.alloc(1024, 100);
const BODY = 'function f(a, b) { return a * b + 1; }\n'.repeat(48);

// A distinct source every time: V8's compilation cache never answers.
const source = (i) => `// ${i}\n${BODY}module.exports = f;\n`;

const prepare = (raw, file) => ({
  source: `'use strict';\n${raw.toString()}`,
  meta: { key: file.key },
});

const place = (provider, prepared) => ({
  provider,
  origin: 'virtual',
  fs: prepared
    ? { writable: true, prepare: { wrap: ['js'] } }
    : { writable: true },
  require: prepared ? { ext: ['js'], compile: true } : false,
});

module.exports = async (b) => {
  const root = tmpDir('publish');
  const k = await kernel(
    root,
    {
      sraw: place('sab', false),
      sprep: place('sab', true),
      mraw: place('map', false),
      mprep: place('map', true),
    },
    {},
    { preparers: { wrap: prepare } },
  );
  const run = (name, ext, data) => {
    const files = k.fs(name);
    return (i) => files.writeFile(`/f${i % KEYS}.${ext}`, data(i));
  };
  try {
    const raw = () => RAW;
    await b.latency('publish.sab.raw', run('sraw', 'txt', raw), {
      samples: 400,
    });
    await b.latency('publish.sab.prepared', run('sprep', 'js', source));
    await b.latency('publish.map.raw', run('mraw', 'txt', raw), {
      samples: 400,
    });
    await b.latency('publish.map.prepared', run('mprep', 'js', source));
    memory(b, 'publish', k);
  } finally {
    k.close();
    cleanup(root);
  }
};
