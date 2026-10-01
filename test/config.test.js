'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { VfsConfig } = require('../lib/config.js');

const make = (places, defaults) => new VfsConfig({ defaults, places });
const fails = (raw, re) => assert.throws(() => new VfsConfig(raw), re);

describe('VfsConfig: globals', () => {
  it('applies defaults', () => {
    const { global } = new VfsConfig();
    assert.equal(global.memory.limit, 1024 ** 3);
    assert.equal(global.memory.segmentSize, 64 * 1024 ** 2);
    assert.equal(global.compaction.threshold, 0.3);
    assert.deepEqual(global.hooks, { fs: true, module: true });
    assert.equal(global.watch, false);
    assert.equal(global.strict, false);
  });

  it('parses sizes as strings or numbers', () => {
    const { global } = make(
      {},
      { memory: { limit: 4096, segmentSize: '1 kib', maxFileSize: 512 } },
    );
    assert.equal(global.memory.limit, 4096);
    assert.equal(global.memory.segmentSize, 1024);
  });

  it('accepts every decimal and binary unit metautil.sizeToBytes knows', () => {
    // eb/zb/yb (decimal) and eib+ (binary) are omitted: their byte count
    // exceeds Number.isSafeInteger and is refused on that separate, already
    // covered ground ('rejects invalid numbers'), whatever the unit.
    for (const [size, bytes] of [
      ['1024', 1024],
      ['1kb', 1000],
      ['2 KB', 2000],
      ['1  mb', 1000000],
      ['1gb', 1000000000],
      ['1tb', 1000000000000],
      ['1pb', 1000000000000000],
      ['1kib', 1024],
      ['2 KiB', 2048],
      ['1mib', 1024 ** 2],
      ['1gib', 1024 ** 3],
      ['1tib', 1024 ** 4],
      ['1pib', 1024 ** 5],
    ]) {
      // All three fields get the same string: whatever it resolves to,
      // limit >= segmentSize >= maxFileSize holds trivially (equal).
      const { global } = make(
        {},
        { memory: { limit: size, segmentSize: size, maxFileSize: size } },
      );
      assert.equal(global.memory.limit, bytes, size);
    }
  });

  it('rejects size strings with an unrecognized unit', () => {
    // '1 gib ' (trailing space) is included: metautil.sizeToBytes reads the
    // unit off the string's last 2-3 characters, so trailing text after a
    // real unit shifts that window past it and silently parses as `1`.
    for (const size of ['1 xb', '1mbx', '1 mi', 'nope', '1 gib ']) {
      fails(
        { defaults: { memory: { limit: size } } },
        /defaults\.memory\.limit: invalid size unit/,
      );
    }
    // A recognized unit with a bad sign or magnitude is still the
    // pre-existing "positive integer" refusal, not "invalid size unit".
    fails(
      { defaults: { memory: { limit: '-1 kb' } } },
      /defaults\.memory\.limit must be a positive integer/,
    );
  });

  // An explicit `undefined` means "this key is not set": mergeDeep() must
  // not let it clobber the default it would otherwise merge over.
  it('treats an explicit undefined as absent, at every depth', () => {
    const defaults = new VfsConfig().global;
    for (const raw of [
      { defaults: { memory: undefined } },
      { defaults: { memory: { limit: undefined } } },
      { defaults: { compaction: undefined } },
      { defaults: { hooks: undefined } },
      {
        defaults: {
          memory: { limit: undefined, segmentSize: undefined },
          compaction: undefined,
          hooks: { fs: undefined, module: undefined },
        },
      },
    ]) {
      assert.deepEqual(
        new VfsConfig(raw).global,
        defaults,
        JSON.stringify(raw),
      );
    }
    // A sibling key given alongside stays effective.
    const { global } = make(
      {},
      { memory: { limit: undefined, segmentSize: '32 mib' } },
    );
    assert.equal(global.memory.limit, 1024 ** 3, 'default limit kept');
    assert.equal(global.memory.segmentSize, 32 * 1024 ** 2);
  });

  it('rejects invalid numbers', () => {
    fails({ defaults: { memory: { limit: 0 } } }, /limit/);
    fails({ defaults: { memory: { limit: -1 } } }, /limit/);
    fails({ defaults: { memory: { segmentSize: 1.5 } } }, /segmentSize/);
    fails({ defaults: { memory: { maxFileSize: NaN } } }, /maxFileSize/);
    fails({ defaults: { memory: { maxFileSize: Infinity } } }, /maxFileSize/);
    fails({ defaults: { compaction: { threshold: 2 } } }, /threshold/);
    fails({ defaults: { compaction: { threshold: '0.3' } } }, /threshold/);
    fails({ defaults: { watchTimeout: -5 } }, /watchTimeout/);
    fails({ defaults: { watchTimeout: 1.5 } }, /watchTimeout/);
  });

  it('requires real booleans', () => {
    fails({ defaults: { strict: 'false' } }, /strict must be a boolean/);
    fails({ defaults: { hooks: { fs: 'true' } } }, /hooks\.fs/);
    fails({ defaults: { watch: 1 } }, /watch must be a boolean/);
  });

  it('enforces limit >= segmentSize >= maxFileSize', () => {
    fails(
      { defaults: { memory: { limit: '1 kib', segmentSize: '2 kib' } } },
      /limit/,
    );
    fails(
      { defaults: { memory: { maxFileSize: '2 mib', segmentSize: '1 mib' } } },
      /maxFileSize/,
    );
  });

  it('rejects unknown keys everywhere', () => {
    fails({ mode: 'x' }, /unknown option "mode"/);
    fails({ defaults: { gc: {} } }, /unknown option "gc"/);
    fails(
      { places: { a: { fs: true, domains: ['fs'] } } },
      /unknown option "domains"/,
    );
    fails({ places: { a: { fs: true, dir: 'x' } } }, /unknown option "dir"/);
    fails(
      { places: { a: { fs: { ext: ['js'], writable: true, other: 1 } } } },
      /unknown option "other"/,
    );
  });

  // Every nested section of `defaults` rejects an unknown key exactly as
  // the top level does, so a typo (`limt` for `limit`) fails loudly instead
  // of being silently dropped by mergeDeep.
  it('rejects unknown keys in every nested defaults section', () => {
    fails(
      { defaults: { memory: { limt: '2 gib' } } },
      /defaults\.memory: unknown option "limt"/,
    );
    fails(
      { defaults: { compaction: { treshold: 0.5 } } },
      /defaults\.compaction: unknown option "treshold"/,
    );
    fails(
      { defaults: { hooks: { fss: false } } },
      /defaults\.hooks: unknown option "fss"/,
    );
    fails({ defaults: { memory: 'x' } }, /defaults\.memory must be an object/);
    fails(
      { defaults: { compaction: 1 } },
      /defaults\.compaction must be an object/,
    );
    fails({ defaults: { hooks: null } }, /defaults\.hooks must be an object/);
  });
});

describe('VfsConfig: place names', () => {
  it('accepts ASCII names with . _ - and keeps case', () => {
    const c = make({ 'My.Place_1-x': { fs: true } });
    assert.equal(c.places[0].name, 'My.Place_1-x');
  });

  it('rejects invalid names', () => {
    for (const name of [
      '',
      '.',
      '..',
      'a/b',
      'a\\b',
      '-a',
      '.hidden',
      'a.',
      'a\u0000',
      'a b',
      'кир',
    ]) {
      fails({ places: { [name]: { fs: true } } }, /invalid place name/);
    }
  });

  it('rejects Windows reserved names case-insensitively', () => {
    for (const name of ['con', 'CON', 'Nul', 'com1', 'LPT9', 'aux.txt']) {
      fails({ places: { [name]: { fs: true } } }, /reserved/);
    }
  });

  it('rejects names that collide when lowercased', () => {
    fails(
      { places: { Static: { fs: true }, static: { fs: true } } },
      /differ only in case/,
    );
  });
});

describe('VfsConfig: domains', () => {
  it('fs: true enables defaults', () => {
    const [p] = make({ a: { fs: true } }).places;
    assert.deepEqual(p.fs, {
      ext: null,
      writable: false,
      zeroCopy: false,
      compress: null,
      script: null,
      fallback: 'disk',
    });
    assert.equal(p.require, null);
    assert.equal(p.import, null);
    assert.equal(p.scanExt, null);
  });

  it('require: true takes js, cjs and json and compiles nothing', () => {
    const [p] = make({ a: { require: true } }).places;
    assert.deepEqual(p.require, { ext: ['js', 'cjs', 'json'], compile: [] });
    assert.deepEqual(p.scanExt, ['js', 'cjs', 'json']);
  });

  it('import: true uses default ext', () => {
    const [p] = make({ a: { import: true } }).places;
    assert.deepEqual(p.import, { ext: ['js', 'mjs', 'json'] });
  });

  it('domain ext replaces defaults and is lower-cased', () => {
    const [p] = make({
      a: { require: { ext: ['JS', 'Cjs'] } },
    }).places;
    assert.deepEqual(p.require, { ext: ['js', 'cjs'], compile: [] });
  });

  it('scanExt is the ordered union fs → require → import', () => {
    const [p] = make({
      a: { fs: { ext: ['html', 'css', 'js'] }, require: true, import: true },
    }).places;
    assert.deepEqual(p.scanExt, ['html', 'css', 'js', 'cjs', 'json', 'mjs']);
  });

  it('fs without ext makes scanExt null even with other domains', () => {
    const [p] = make({ a: { fs: true, require: true } }).places;
    assert.equal(p.scanExt, null);
  });

  it('false / absent disables; other types are rejected', () => {
    const [p] = make({ a: { fs: true, require: false } }).places;
    assert.equal(p.require, null);
    fails({ places: { a: { fs: 'yes' } } }, /must be true, false or an object/);
    fails(
      { places: { a: { fs: { ext: 'js' } } } },
      /ext must be a non-empty array/,
    );
    fails({ places: { a: { fs: { ext: ['.js'] } } } }, /without dots/);
  });

  it('rejects unknown keys in require, import and fs.script', () => {
    fails(
      { places: { a: { require: { ext: ['js'], compiled: true } } } },
      /unknown option "compiled"/,
    );
    fails(
      { places: { a: { import: { ext: ['js'], compile: true } } } },
      /unknown option "compile"/,
    );
    fails(
      { places: { a: { fs: { script: { ext: ['js'], compiled: true } } } } },
      /unknown option "compiled"/,
    );
  });

  it('requires at least one domain', () => {
    fails({ places: { a: { provider: 'sab' } } }, /at least one domain/);
  });
});

// `require` and `fs.script` list the extensions that get V8 cached data in
// `compile`, the rest in `ext`; a domain lists an extension once, and only
// what `compile` lists gets cached data.
describe('VfsConfig: compile lists', () => {
  const placeOf = (spec) => make({ a: spec }).places[0];
  const PLAIN = { ext: ['js', 'cjs', 'json'], compile: [] };

  it('nothing is compiled unless compile lists it', () => {
    for (const domain of [true, {}, { prepare: 'm' }]) {
      assert.deepEqual(placeOf({ require: domain }).require, PLAIN);
    }
    assert.deepEqual(placeOf({ require: { ext: ['json'] } }).require, {
      ext: ['json'],
      compile: [],
    });
    const mjs = placeOf({ fs: { script: { ext: ['mjs'] } } });
    assert.deepEqual(mjs.fs.script, { ext: ['mjs'], compile: [] });
    assert.deepEqual(mjs.fs.ext, ['mjs']);
  });

  it('a list given replaces the default ext of require', () => {
    assert.deepEqual(placeOf({ require: { compile: ['js'] } }).require, {
      ext: ['js'],
      compile: ['js'],
    });
    const tmpl = placeOf({ fs: { script: { compile: ['tmpl'] } } });
    assert.deepEqual(tmpl.fs.script, { ext: ['tmpl'], compile: ['tmpl'] });
    assert.deepEqual(tmpl.fs.ext, ['tmpl']);
  });

  it('fs.script is an object of lists, never true or empty', () => {
    for (const script of [true, null, 'js', ['js'], 1]) {
      fails(
        { places: { a: { fs: { script } } } },
        /places\.a\.fs\.script must be false or an object \{ ext, compile \}$/,
      );
    }
    fails(
      { places: { a: { fs: { script: {} } } } },
      /places\.a\.fs\.script lists its sources: give ext, compile or both$/,
    );
    assert.equal(placeOf({ fs: { script: false } }).fs.script, null);
  });

  it('compile adds its extensions to the domain, before those of ext', () => {
    const p = placeOf({
      fs: {
        ext: ['json'],
        script: { ext: ['mjs'], compile: ['js', 'cjs', 'dhtml'] },
      },
      require: { ext: ['json'], compile: ['js', 'cjs', 'dhtml'] },
    });
    assert.deepEqual(p.fs.script, {
      ext: ['js', 'cjs', 'dhtml', 'mjs'],
      compile: ['js', 'cjs', 'dhtml'],
    });
    assert.deepEqual(p.fs.ext, ['json', 'js', 'cjs', 'dhtml', 'mjs']);
    assert.deepEqual(p.require, {
      ext: ['js', 'cjs', 'dhtml', 'json'],
      compile: ['js', 'cjs', 'dhtml'],
    });
    assert.deepEqual(p.scanExt, ['json', 'js', 'cjs', 'dhtml', 'mjs']);
  });

  it('lists are lower-cased; a repeat within one list is refused', () => {
    const p = placeOf({
      fs: { script: { compile: ['Tmpl'] } },
      require: { ext: ['JSON'], compile: ['JS', 'Cjs'] },
    });
    assert.deepEqual(p.fs.script, { ext: ['tmpl'], compile: ['tmpl'] });
    assert.deepEqual(p.require, {
      ext: ['js', 'cjs', 'json'],
      compile: ['js', 'cjs'],
    });
    for (const [spec, where] of [
      [{ fs: { ext: ['css', 'CSS'] } }, 'fs\\.ext'],
      [{ fs: { script: { ext: ['mjs', 'mjs'] } } }, 'fs\\.script\\.ext'],
      [
        { fs: { script: { compile: ['Tmpl', 'tmpl'] } } },
        'fs\\.script\\.compile',
      ],
      [{ require: { ext: ['json', 'JSON'] } }, 'require\\.ext'],
      [{ require: { compile: ['js', 'Js'] } }, 'require\\.compile'],
      [{ import: { ext: ['mjs', 'MJS'] } }, 'import\\.ext'],
      [
        { fs: { compress: { encodings: ['gzip'], ext: ['css', 'css'] } } },
        'fs\\.compress\\.ext',
      ],
    ]) {
      fails(
        { places: { a: spec } },
        new RegExp(`places\\.a\\.${where}: extension "\\w+" is listed twice$`),
      );
    }
  });

  it('compile is a list of extensions: no boolean, no empty list', () => {
    for (const compile of [true, false, [], 'js', null]) {
      fails(
        { places: { a: { require: { compile } } } },
        /places\.a\.require\.compile must be a non-empty array of extensions$/,
      );
      fails(
        { places: { a: { fs: { script: { compile } } } } },
        /places\.a\.fs\.script\.compile must be a non-empty array of extensions$/,
      );
    }
    fails(
      { places: { a: { require: { compile: ['.dhtml'] } } } },
      /places\.a\.require\.compile items must be alphanumeric/,
    );
  });

  it('a domain lists an extension once', () => {
    fails(
      { places: { a: { require: { ext: ['json', 'js'], compile: ['JS'] } } } },
      /places\.a\.require: extension "js" is listed in both ext and compile$/,
    );
    fails(
      { places: { a: { fs: { script: { ext: ['js'], compile: ['js'] } } } } },
      /places\.a\.fs\.script: extension "js" is listed in both ext and compile$/,
    );
    fails(
      { places: { a: { fs: { ext: ['js'], script: { compile: ['js'] } } } } },
      /places\.a\.fs: extension "js" is listed in both ext and script\.compile$/,
    );
    fails(
      { places: { a: { fs: { ext: ['mjs'], script: { ext: ['MJS'] } } } } },
      /places\.a\.fs: extension "mjs" is listed in both ext and script\.ext$/,
    );
  });

  it('json and mjs get no cached data: they belong in ext', () => {
    for (const ext of ['json', 'mjs', 'JSON']) {
      const name = ext.toLowerCase();
      fails(
        { places: { a: { require: { compile: ['js', ext] } } } },
        new RegExp(
          `places\\.a\\.require\\.compile: extension "${name}" gets no ` +
            'cached data — list it in places\\.a\\.require\\.ext$',
        ),
      );
      fails(
        { places: { a: { fs: { script: { compile: [ext] } } } } },
        new RegExp(
          `places\\.a\\.fs\\.script\\.compile: extension "${name}" gets ` +
            'no cached data — list it in places\\.a\\.fs\\.script\\.ext$',
        ),
      );
    }
    const p = placeOf({
      fs: { script: { ext: ['mjs'] } },
      require: { ext: ['json', 'mjs'] },
    });
    assert.deepEqual(p.fs.script, { ext: ['mjs'], compile: [] });
    assert.deepEqual(p.require, { ext: ['json', 'mjs'], compile: [] });
  });
});

describe('VfsConfig: providers', () => {
  it('defaults to sab and validates provider names', () => {
    assert.equal(make({ a: { fs: true } }).places[0].provider, 'sab');
    fails(
      { places: { a: { provider: 'redis', fs: true } } },
      /unknown provider/,
    );
  });

  it('sea is read-only', () => {
    fails(
      { places: { a: { provider: 'sea', fs: { writable: true } } } },
      /read-only/,
    );
    make({ a: { provider: 'sea', fs: true, require: true } });
  });

  it('disk and node-default cannot compile', () => {
    const hint = /cannot store bytecode; list its extensions in require\.ext$/;
    for (const provider of ['disk', 'node-default']) {
      for (const compile of [['js'], ['dhtml']]) {
        fails({ places: { a: { provider, require: { compile } } } }, hint);
      }
      const [p] = make({ a: { provider, require: true } }).places;
      assert.deepEqual(p.require, { ext: ['js', 'cjs', 'json'], compile: [] });
    }
  });

  it('zeroCopy and compress need in-memory providers', () => {
    fails(
      { places: { a: { provider: 'disk', fs: { zeroCopy: true } } } },
      /zeroCopy/,
    );
    fails(
      {
        places: {
          a: { provider: 'map', fs: { compress: { encodings: ['gzip'] } } },
        },
      },
      /compress/,
    );
    fails(
      { places: { a: { provider: 'node-default', fs: { writable: true } } } },
      /not applicable/,
    );
    make({ a: { provider: 'map', fs: { zeroCopy: true, writable: true } } });
  });

  it('caps place maxFileSize by segmentSize for shared providers', () => {
    fails(
      {
        defaults: { memory: { segmentSize: '1 mib' } },
        places: { a: { fs: true, maxFileSize: '2 mib' } },
      },
      /maxFileSize/,
    );
  });

  // Only sab and sea store files in the SAB pool, so a cap anywhere else
  // would be silently ignored at runtime.
  it('rejects maxFileSize on providers that never use it', () => {
    for (const provider of ['map', 'disk', 'node-default']) {
      fails(
        { places: { a: { provider, fs: true, maxFileSize: '1 kib' } } },
        /maxFileSize applies to providers/,
      );
    }
    make({ a: { provider: 'sea', fs: true, maxFileSize: '1 kib' } });
  });
});

describe('VfsConfig: compress', () => {
  const c = (compress) =>
    make({ a: { fs: { compress } } }).places[0].fs.compress;

  it('resolves codecs in order with native defaults', () => {
    const r = c({ encodings: ['br', 'gzip'] });
    assert.deepEqual(r.codecs, [
      { encoding: 'br', options: null },
      { encoding: 'gzip', options: null },
    ]);
    assert.equal(r.ext, null);
    assert.equal(r.retainRaw, true);
  });

  it('validates levels per codec', () => {
    assert.deepEqual(
      c({ encodings: ['br'], options: { br: { level: 5 } } }).codecs[0].options,
      { level: 5 },
    );
    fails(
      {
        places: {
          a: {
            fs: {
              compress: {
                encodings: ['gzip'],
                options: { gzip: { level: 10 } },
              },
            },
          },
        },
      },
      /0\.\.9/,
    );
    fails(
      {
        places: {
          a: {
            fs: {
              compress: {
                encodings: ['zstd'],
                options: { zstd: { level: 0 } },
              },
            },
          },
        },
      },
      /1\.\.22/,
    );
    fails(
      {
        places: {
          a: {
            fs: {
              compress: { encodings: ['br'], options: { br: { level: 12 } } },
            },
          },
        },
      },
      /0\.\.11/,
    );
    fails(
      {
        places: {
          a: {
            fs: {
              compress: { encodings: ['br'], options: { br: { quality: 5 } } },
            },
          },
        },
      },
      /unknown option/,
    );
  });

  it('rejects duplicates, unknown and unselected encodings', () => {
    fails(
      { places: { a: { fs: { compress: { encodings: ['gzip', 'gzip'] } } } } },
      /duplicate/,
    );
    fails(
      { places: { a: { fs: { compress: { encodings: ['lz4'] } } } } },
      /unknown encoding/,
    );
    fails(
      {
        places: {
          a: { fs: { compress: { encodings: ['gzip'], options: { br: {} } } } },
        },
      },
      /not in encodings/,
    );
    fails(
      { places: { a: { fs: { compress: { encodings: [] } } } } },
      /non-empty/,
    );
    fails(
      {
        places: {
          a: { fs: { compress: { encodings: ['gzip'], quality: 5 } } },
        },
      },
      /unknown option "quality"/,
    );
  });

  it('expands ext: compressible', () => {
    const r = c({ encodings: ['gzip'], ext: 'compressible' });
    assert.ok(
      r.ext.includes('html') &&
        r.ext.includes('wasm') &&
        !r.ext.includes('png'),
    );
  });

  it('retainRaw: false needs sab and no compile', () => {
    fails(
      {
        places: {
          a: {
            provider: 'sea',
            fs: { compress: { encodings: ['gzip'], retainRaw: false } },
          },
        },
      },
      /retainRaw/,
    );
    for (const compile of [['js'], ['dhtml']]) {
      fails(
        {
          places: {
            a: {
              fs: { compress: { encodings: ['gzip'], retainRaw: false } },
              require: { compile },
            },
          },
        },
        /retainRaw: false is incompatible with require\.compile/,
      );
    }
    for (const domain of [true, { ext: ['js', 'cjs', 'json'] }]) {
      make({
        a: {
          fs: { compress: { encodings: ['gzip'], retainRaw: false } },
          require: domain,
        },
      });
    }
  });
});

// `links` — how strict routing proves a native call on a place's disk:
// 'deny' (the index of known links, the default) or 'verify' (the real
// path of each call); per place over `defaults.links`, for a place with a
// directory on disk, under strict only.
describe('VfsConfig: links', () => {
  const DISKFUL = {
    s: { fs: { ext: ['txt'], fallback: 'disk' } },
    m: { provider: 'map', fs: true },
    d: { provider: 'disk', fs: true },
    n: { provider: 'node-default', fs: true },
  };
  const DISKLESS = {
    v: { origin: 'virtual', fs: { writable: true } },
    mv: { provider: 'map', origin: 'virtual', fs: { writable: true } },
    e: { provider: 'sea', fs: true },
  };
  const linksOf = (c) =>
    Object.fromEntries(c.allPlaces.map((p) => [p.name, p.links]));

  it("strict: 'deny' by default on every place with a directory on disk", () => {
    const c = make({ ...DISKFUL, ...DISKLESS }, { strict: true });
    assert.equal(c.global.links, 'deny');
    assert.deepEqual(linksOf(c), {
      s: 'deny',
      m: 'deny',
      d: 'deny',
      n: 'deny',
      v: null,
      mv: null,
      e: null,
    });
  });

  it("defaults.links and a place's own, which wins", () => {
    const places = { ...DISKFUL, d: { ...DISKFUL.d, links: 'deny' } };
    const c = make(places, { strict: true, links: 'verify' });
    assert.equal(c.global.links, 'verify');
    assert.deepEqual(linksOf(c), {
      s: 'verify',
      m: 'verify',
      d: 'deny',
      n: 'verify',
    });
    const one = make(
      { ...DISKFUL, n: { ...DISKFUL.n, links: 'verify' } },
      {
        strict: true,
      },
    );
    assert.equal(one.place('n').links, 'verify');
    assert.equal(one.place('d').links, 'deny');
  });

  it('without strict: null, and a value is refused', () => {
    const c = make(DISKFUL);
    assert.equal(c.global.links, null);
    assert.ok(c.allPlaces.every((p) => p.links === null));
    fails(
      { defaults: { links: 'deny' }, places: DISKFUL },
      /defaults\.links applies under strict routing only/,
    );
    fails(
      { places: { d: { ...DISKFUL.d, links: 'verify' } } },
      /places\.d\.links applies under strict routing only/,
    );
  });

  it("only 'deny' or 'verify'; no place without a directory on disk", () => {
    for (const value of ['allow', 'indexed', true, 1, '']) {
      fails(
        { defaults: { strict: true, links: value }, places: DISKFUL },
        /defaults\.links must be "deny" or "verify"/,
      );
      fails(
        {
          defaults: { strict: true },
          places: { d: { ...DISKFUL.d, links: value } },
        },
        /places\.d\.links must be "deny" or "verify"/,
      );
    }
    for (const [name, place] of Object.entries(DISKLESS)) {
      fails(
        {
          defaults: { strict: true },
          places: { [name]: { ...place, links: 'deny' } },
        },
        new RegExp(
          `places\\.${name}\\.links applies to places with a directory on disk`,
        ),
      );
    }
  });

  it('the CLI sets it', () => {
    const cli = VfsConfig.fromArgv(
      [
        'node',
        'app.js',
        '--',
        '--vfs.defaults.strict=true',
        '--vfs.places.d.links=verify',
      ],
      { places: DISKFUL },
    );
    assert.equal(cli.place('d').links, 'verify');
    assert.equal(cli.place('s').links, 'deny');
  });
});

describe('VfsConfig: immutability', () => {
  it('is deeply frozen and does not mutate input', () => {
    const input = {
      defaults: { strict: true },
      places: { a: { fs: { ext: ['js'] } } },
    };
    const copy = structuredClone(input);
    const c = new VfsConfig(input);
    assert.deepEqual(input, copy);
    assert.ok(Object.isFrozen(c.global.memory));
    assert.ok(Object.isFrozen(c.places[0].fs.ext));
    assert.ok(Object.isFrozen(c.raw.places.a));
    assert.throws(() => c.places[0].fs.ext.push('x'));
  });

  it('exposes raw for workers and place()/allPlaces()', () => {
    const c = make({ a: { fs: true }, b: { fs: true, enabled: false } });
    assert.deepEqual(c.raw.places.a, { fs: true });
    assert.equal(c.places.length, 1);
    assert.equal(c.allPlaces.length, 2);
    assert.equal(c.place('b').enabled, false);
    assert.equal(c.place('zzz'), null);
  });
});

describe('VfsConfig.fromArgv', () => {
  const app = {
    places: {
      a: { fs: true },
      b: { fs: true },
      c: { fs: true, maxFileSize: '1 kib' },
    },
  };
  const argv = (...args) => ['node', 'app.js', '--', ...args];

  it('overrides defaults with typed values', () => {
    const c = VfsConfig.fromArgv(
      argv(
        '--vfs.defaults.memory.limit=2mib',
        '--vfs.defaults.memory.segmentSize=1mib',
        '--vfs.defaults.memory.maxFileSize=100kib',
        '--vfs.defaults.strict=true',
        '--vfs.defaults.watchTimeout=50',
      ),
      app,
    );
    assert.equal(c.global.memory.limit, 2 * 1024 ** 2);
    assert.equal(c.global.strict, true);
    assert.equal(c.global.watchTimeout, 50);
  });

  // The CLI overrides examples README ("API" → VfsConfig) and
  // doc/integration.md ("CLI overrides") show verbatim: every `--vfs.*`
  // key must be one parseArgv() actually accepts.
  it('parses the CLI examples shown in README and doc/integration.md', () => {
    const docApp = {
      places: { tools: { fs: true }, workspace: { fs: true, require: true } },
    };
    const fromIntegrationDoc = VfsConfig.fromArgv(
      argv(
        '--vfs.defaults.memory.limit=512mib',
        '--vfs.defaults.strict=true',
        '--vfs.defaults.hooks.fs=false',
        '--vfs.enable=tools,workspace',
        '--vfs.disable=static',
      ),
      { ...docApp, places: { ...docApp.places, static: { fs: true } } },
    );
    assert.equal(fromIntegrationDoc.global.memory.limit, 512 * 1024 ** 2);
    assert.equal(fromIntegrationDoc.global.strict, true);
    assert.equal(fromIntegrationDoc.global.hooks.fs, false);
    assert.deepEqual(
      fromIntegrationDoc.places.map((p) => p.name),
      ['tools', 'workspace'],
    );

    const fromReadme = VfsConfig.fromArgv(
      argv(
        '--vfs.defaults.memory.limit=512mib',
        '--vfs.defaults.strict=true',
        '--vfs.enable=static,lib',
        '--vfs.disable=scratch',
      ),
      {
        places: {
          static: { fs: true },
          lib: { fs: true },
          scratch: { fs: true },
        },
      },
    );
    assert.deepEqual(
      fromReadme.places.map((p) => p.name),
      ['static', 'lib'],
    );
  });

  it('overrides place options and toggles places', () => {
    const c = VfsConfig.fromArgv(
      argv('--vfs.places.c.maxFileSize=2kib', '--vfs.enable=a,c'),
      app,
    );
    assert.equal(c.place('c').maxFileSize, 2048);
    assert.deepEqual(
      c.places.map((p) => p.name),
      ['a', 'c'],
    );
    const d = VfsConfig.fromArgv(argv('--vfs.disable=b'), app);
    assert.deepEqual(
      d.places.map((p) => p.name),
      ['a', 'c'],
    );
  });

  it('ignores args before -- and --vfs.config, rejects unknown/unsafe keys', () => {
    const c = VfsConfig.fromArgv(
      ['node', '--vfs.defaults.strict=true', 'x', '--', '--vfs.config=./c.js'],
      app,
    );
    assert.equal(c.global.strict, false);
    assert.throws(
      () => VfsConfig.fromArgv(argv('--vfs.strict=true'), app),
      /unknown CLI key/,
    );
    assert.throws(
      () => VfsConfig.fromArgv(argv('--vfs.defaults.__proto__.x=1'), app),
      /unsafe/,
    );
    assert.throws(
      () => VfsConfig.fromArgv(argv('--vfs.enable=nope'), app),
      /unknown place/,
    );
    assert.equal(Object.prototype.x, undefined);
  });

  it('enable selects places; disable subtracts from the current set', () => {
    const onlyA = VfsConfig.fromArgv(argv('--vfs.enable=a'), app);
    assert.deepEqual(
      onlyA.places.map((p) => p.name),
      ['a'],
    );
    const dropped = VfsConfig.fromArgv(
      argv('--vfs.enable=a,b', '--vfs.disable=a'),
      app,
    );
    assert.deepEqual(
      dropped.places.map((p) => p.name),
      ['b'],
    );
    assert.throws(
      () => VfsConfig.fromArgv(argv('--vfs.disable=nope'), app),
      /unknown place/,
    );
  });
});

// A setting that takes a list takes a comma-separated one on the CLI, so the
// CLI says what a JS or JSON config says, and is validated the same way.
describe('VfsConfig.fromArgv: lists', () => {
  const argv = (...args) => ['node', 'app.js', '--', ...args];
  const cli = (args, app) => VfsConfig.fromArgv(argv(...args), app);
  const isPlain = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  // A raw config as CLI flags: a leaf per flag, a list as its items.
  const flagsOf = (raw, at = 'vfs') =>
    Object.entries(raw).flatMap(([key, value]) => {
      const path = `${at}.${key}`;
      if (isPlain(value)) return flagsOf(value, path);
      const text = Array.isArray(value) ? value.join(',') : String(value);
      return [`--${path}=${text}`];
    });
  const same = (actual, expected) => {
    assert.deepEqual(actual.raw, expected.raw);
    assert.deepEqual(actual.global, expected.global);
    assert.deepEqual(actual.allPlaces, expected.allPlaces);
  };

  const ACCEPTED = {
    places: {
      views: {
        fs: {
          ext: ['json'],
          script: { ext: ['mjs'], compile: ['js', 'cjs', 'dhtml'] },
        },
        require: { ext: ['json'], compile: ['js', 'cjs', 'dhtml'] },
      },
    },
  };

  it('the accepted form: the CLI alone, a JS object and JSON resolve alike', () => {
    const js = new VfsConfig(ACCEPTED);
    same(new VfsConfig(JSON.parse(JSON.stringify(ACCEPTED))), js);
    const flags = [
      '--vfs.places.views.fs.ext=json',
      '--vfs.places.views.fs.script.ext=mjs',
      '--vfs.places.views.fs.script.compile=js,cjs,dhtml',
      '--vfs.places.views.require.ext=json',
      '--vfs.places.views.require.compile=js,cjs,dhtml',
    ];
    assert.deepEqual(flagsOf(ACCEPTED), flags);
    same(cli(flags), js);
    assert.deepEqual(js.place('views').require, {
      ext: ['js', 'cjs', 'dhtml', 'json'],
      compile: ['js', 'cjs', 'dhtml'],
    });
  });

  it('every list setting, its keyword and the scalars round-trip', () => {
    const raw = {
      defaults: {
        memory: { limit: '2 mib', segmentSize: '1 mib', maxFileSize: 65536 },
        strict: true,
      },
      places: {
        site: {
          fs: {
            ext: ['html', 'css', 'mp3'],
            compress: {
              encodings: ['br', 'gzip'],
              options: { br: { level: 5 } },
              ext: ['css', 'html'],
            },
            prepare: { styles: ['css'], markup: ['html'] },
            fallback: 'deny',
          },
          links: 'verify',
        },
        zip: {
          fs: {
            ext: ['txt'],
            compress: { encodings: ['gzip'], ext: 'compressible' },
          },
        },
        views: ACCEPTED.places.views,
        lib: {
          require: { ext: ['json'], compile: ['js'], prepare: 'mod' },
          import: { ext: ['mjs'], prepare: { esm: ['mjs'] } },
        },
        mem: {
          provider: 'map',
          origin: 'virtual',
          fs: { writable: true, script: { compile: ['tmpl'] } },
        },
      },
    };
    same(cli(flagsOf(raw)), new VfsConfig(raw));
  });

  it('a list given replaces the list of the config file', () => {
    const file = {
      places: {
        views: {
          fs: { script: { ext: ['mjs'] } },
          require: { ext: ['json'], compile: ['js'] },
        },
      },
    };
    const c = cli(
      [
        '--vfs.places.views.fs.ext=json',
        '--vfs.places.views.fs.script.compile=js,cjs,dhtml',
        '--vfs.places.views.require.compile=js,cjs,dhtml',
      ],
      file,
    );
    same(c, new VfsConfig(ACCEPTED));
    assert.throws(
      () => cli(['--vfs.places.views.require.ext=js,json'], file),
      /places\.views\.require: extension "js" is listed in both ext and compile$/,
    );
  });

  it('one item is a list; items stay strings as written, trimmed', () => {
    const c = cli([
      '--vfs.places.p.fs.ext=css',
      '--vfs.places.p.require.ext=3, mp3',
      '--vfs.places.p.fs.prepare.styles=css',
    ]);
    assert.deepEqual(c.raw.places.p, {
      fs: { ext: ['css'], prepare: { styles: ['css'] } },
      require: { ext: ['3', 'mp3'] },
    });
    assert.deepEqual(c.place('p').prepare, { css: 'styles' });
    assert.equal(
      cli(['--vfs.places.p.fs.prepare=up', '--vfs.places.p.fs.ext=txt']).place(
        'p',
      ).prepare.txt,
      'up',
    );
    assert.throws(
      () => cli(['--vfs.places.p.fs.ext=js,,css']),
      /places\.p\.fs\.ext items must be alphanumeric extensions without dots$/,
    );
    assert.throws(
      () => cli(['--vfs.places.p.fs.ext=css,CSS']),
      /places\.p\.fs\.ext: extension "css" is listed twice$/,
    );
  });

  it('no boolean compile and no script: true here either', () => {
    for (const [flag, refusal] of [
      [
        'places.p.require.compile=true',
        /require\.compile must be a non-empty array/,
      ],
      [
        'places.p.require.compile=false',
        /require\.compile must be a non-empty array/,
      ],
      [
        'places.p.fs.script.compile=true',
        /script\.compile must be a non-empty array/,
      ],
      ['places.p.fs.script=true', /fs\.script must be false or an object/],
    ]) {
      assert.throws(() => cli([`--vfs.${flag}`]), refusal, flag);
    }
    const file = { places: { p: { fs: { script: { compile: ['js'] } } } } };
    const off = cli(['--vfs.places.p.fs.script=false'], file);
    assert.equal(off.place('p').fs.script, null, 'false is off, as in a file');
  });

  it('a place name with dots is the longest one the config file has', () => {
    const file = { places: { 'my.app': { require: true }, my: { fs: true } } };
    const c = cli(
      ['--vfs.places.my.app.require.compile=js', '--vfs.places.my.fs.ext=txt'],
      file,
    );
    assert.deepEqual(c.place('my.app').require, {
      ext: ['js'],
      compile: ['js'],
    });
    assert.deepEqual(c.place('my').fs.ext, ['txt']);
    assert.throws(
      () => cli(['--vfs.places.my.app.__proto__.x=1'], file),
      /unsafe CLI key "places\.my\.app\.__proto__\.x"/,
    );
  });
});
