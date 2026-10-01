'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const vm = require('node:vm');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');
const { VfsConfig } = require('../lib/config.js');
const { VfsKernel } = require('../lib/kernel.js');
const fsPatch = require('../lib/adapters/fs-patch.js');
const moduleHook = require('../lib/adapters/module-hook.js');
const { bytecodeKey, compressedKey } = require('../lib/companion.js');
const {
  tmpDir,
  writeTree,
  rm,
  kernel,
  config,
  quiet,
  drain,
  tap,
  worker,
  nextMessage,
  until,
  within,
  turn,
  activeResources,
  activeSince,
} = require('./helpers.js');

// `prepare` is declared by one domain (fs, require, import) and prepares the
// file itself: one preparer per extension in a place, run once per
// publication attempt, one canonical content shared by every domain.

const places = (spec) => new VfsConfig({ places: spec }).places;
const placeOf = (spec) => places({ p: spec })[0];
const rejects = (spec, re) =>
  assert.throws(() => new VfsConfig({ places: { p: spec } }), re);

describe('prepare config: forms', () => {
  it('short forms cover the finite ext of their own domain', () => {
    assert.deepEqual(
      placeOf({ fs: { ext: ['js', 'cjs'], prepare: 'api' } }).prepare,
      {
        js: 'api',
        cjs: 'api',
      },
    );
    assert.deepEqual(
      placeOf({ require: { ext: ['js'], prepare: 'mod' } }).prepare,
      { js: 'mod' },
    );
    assert.deepEqual(
      placeOf({ import: { ext: ['mjs'], prepare: 'esm' } }).prepare,
      { mjs: 'esm' },
    );
    assert.deepEqual(
      placeOf({ require: { prepare: 'mod' } }).prepare,
      { js: 'mod', cjs: 'mod', json: 'mod' },
      'the effective (default) ext of the domain',
    );
  });

  it('object form routes several preparers, one of them to several ext', () => {
    const p = placeOf({
      fs: {
        ext: ['js', 'cjs', 'css', 'html', 'svg'],
        prepare: {
          api: ['js', 'cjs'],
          styles: ['css'],
          markup: ['html', 'SVG'],
        },
      },
    });
    assert.deepEqual(p.prepare, {
      js: 'api',
      cjs: 'api',
      css: 'styles',
      html: 'markup',
      svg: 'markup',
    });
  });

  it('an unrestricted fs takes the object form only', () => {
    rejects({ fs: { prepare: 'content' } }, /needs a finite ext list/);
    // `null` is not a way to say "every file": leave `ext` out.
    rejects(
      { fs: { ext: null, prepare: 'content' } },
      /fs\.ext must be a non-empty array of extensions/,
    );
    const p = placeOf({ fs: { prepare: { code: ['js'], styles: ['css'] } } });
    assert.deepEqual(p.prepare, { js: 'code', css: 'styles' });
    assert.equal(p.fs.ext, null, 'still every file');
    assert.equal(p.scanExt, null);
  });

  it('a short fs.prepare covers what fs.ext, fs.script.ext and fs.script.compile list', () => {
    const p = placeOf({
      fs: {
        ext: ['css'],
        prepare: 'styles',
        script: { ext: ['mjs'], compile: ['js'] },
      },
    });
    assert.deepEqual(p.prepare, { css: 'styles', mjs: 'styles', js: 'styles' });
    assert.deepEqual(p.fs.ext, ['css', 'js', 'mjs']);
    assert.deepEqual(
      placeOf({ fs: { prepare: 'api', script: { compile: ['js'] } } }).prepare,
      { js: 'api' },
    );
    assert.deepEqual(
      placeOf({ fs: { prepare: 'api', script: { ext: ['mjs'] } } }).prepare,
      { mjs: 'api' },
    );
    // No list names an extension: `script: true` is gone, and with it the
    // js and cjs it brought in.
    rejects(
      { fs: { prepare: 'api', script: true } },
      /fs\.script must be false or an object/,
    );
    rejects(
      { fs: { prepare: 'api', script: false } },
      /fs\.prepare: "api" needs a finite ext list/,
    );
  });

  it('prepare neither adds nor removes extensions', () => {
    const p = placeOf({
      fs: { ext: ['js', 'css'], prepare: { api: ['js'] } },
      require: { ext: ['js'] },
    });
    assert.deepEqual(p.fs.ext, ['js', 'css']);
    assert.deepEqual(p.require.ext, ['js']);
    assert.deepEqual(p.scanExt, ['js', 'css']);
    assert.equal(p.fs.prepare, undefined, 'the index lives on the place');
  });

  it('a domain without prepare shares the file prepared by another', () => {
    const p = placeOf({
      fs: { ext: ['js', 'json'] },
      require: { compile: ['js'], prepare: 'module' },
    });
    assert.deepEqual(p.prepare, { js: 'module' });
  });

  it('resolved config is frozen and cloneable', () => {
    const [p] = places({
      p: { fs: { prepare: 'api', script: { compile: ['js'] } } },
    });
    assert.ok(Object.isFrozen(p.prepare));
    assert.throws(() => {
      p.prepare.css = 'x';
    });
    assert.deepEqual(structuredClone(p).prepare, { js: 'api' });
  });
});

describe('prepare config: errors', () => {
  it('an object-form extension must be in a finite domain ext', () => {
    rejects(
      { fs: { ext: ['js'], prepare: { styles: ['css'] } } },
      /fs\.prepare\.styles: extension "css" is not in the domain ext/,
    );
    rejects(
      { require: { ext: ['js'], prepare: { m: ['cjs'] } } },
      /require\.prepare\.m: extension "cjs"/,
    );
  });

  it('names and values are validated', () => {
    rejects({ fs: { ext: ['js'], prepare: '1bad' } }, /invalid preparer name/);
    rejects({ fs: { ext: ['js'], prepare: { 'a b': ['js'] } } }, /invalid/);
    rejects({ fs: { ext: ['js'], prepare: () => {} } }, /got a function/);
    rejects({ fs: { ext: ['js'], prepare: null } }, /preparer name or/);
    rejects({ fs: { ext: ['js'], prepare: {} } }, /preparer name or/);
    rejects({ fs: { ext: ['js'], prepare: { a: [] } } }, /non-empty array/);
    rejects({ fs: { ext: ['js'], prepare: { a: 'js' } } }, /non-empty array/);
    rejects({ fs: { ext: ['js'], prepare: { a: ['.js'] } } }, /without dots/);
  });

  it('an extension appears once in a domain', () => {
    rejects(
      { fs: { ext: ['js'], prepare: { a: ['js', 'JS'] } } },
      /fs\.prepare\.a: extension "js" is listed twice/,
    );
    rejects(
      { fs: { ext: ['js'], prepare: { a: ['js'], b: ['js'] } } },
      /fs\.prepare: extension "js" is assigned to both "a" and "b"/,
    );
  });

  // The error names every preparer the extension is assigned to, in
  // declaration order — not the first two — and the first such extension.
  it('an extension assigned to three or more preparers names them all', () => {
    rejects(
      { fs: { ext: ['js'], prepare: { a: ['js'], b: ['js'], c: ['js'] } } },
      /fs\.prepare: extension "js" is assigned to "a", "b" and "c"$/,
    );
    rejects(
      {
        require: {
          ext: ['js', 'cjs'],
          prepare: {
            a: ['js', 'cjs'],
            b: ['cjs'],
            c: ['JS'],
            d: ['cjs', 'js'],
          },
        },
      },
      /require\.prepare: extension "js" is assigned to "a", "c" and "d"$/,
    );
    rejects(
      {
        import: {
          ext: ['mjs'],
          prepare: { a: ['mjs'], b: ['mjs'], c: ['mjs'], d: ['mjs'] },
        },
      },
      /import\.prepare: extension "mjs" is assigned to "a", "b", "c" and "d"$/,
    );
  });

  it('an extension has one declaration in the whole place', () => {
    rejects(
      {
        fs: { ext: ['js'], prepare: 'code' },
        require: { ext: ['js'], prepare: 'code' },
      },
      new RegExp(
        'places\\.p: extension "js" has multiple preparer declarations: ' +
          'fs\\.prepare → "code", require\\.prepare → "code"',
      ),
    );
    rejects(
      {
        fs: { ext: ['js'], prepare: 'api' },
        require: { ext: ['js'], prepare: 'module' },
      },
      /fs\.prepare → "api", require\.prepare → "module"/,
    );
    rejects(
      {
        fs: { ext: ['js'], prepare: 'a' },
        require: { ext: ['js'], prepare: 'b' },
        import: { ext: ['js'], prepare: 'c' },
      },
      /fs\.prepare → "a", require\.prepare → "b", import\.prepare → "c"/,
    );
  });

  it('the old fs.script.prepare is gone', () => {
    rejects(
      { fs: { script: { prepare: 'wrap' } } },
      /fs\.script: unknown option "prepare"/,
    );
  });

  it('prepare needs an indexed provider and in-memory sources', () => {
    rejects(
      { provider: 'disk', fs: { ext: ['js'], prepare: 'x' } },
      /prepare requires provider sab, map or sea/,
    );
    rejects(
      {
        fs: {
          ext: ['js'],
          prepare: 'x',
          compress: { encodings: ['gzip'], retainRaw: false },
        },
        require: true,
      },
      /retainRaw: false is incompatible with prepare/,
    );
  });

  it('every preparer an enabled place names must be registered', async () => {
    const root = tmpDir('vfs-prep');
    const cfg = config({
      a: { fs: { ext: ['js'], prepare: 'missing' } },
      off: { enabled: false, fs: { ext: ['js'], prepare: 'nope' } },
    });
    const k = new VfsKernel(cfg, { appRoot: root, console: quiet });
    let ok = null;
    try {
      await assert.rejects(
        k.initialize(),
        /places\.a: preparer "missing" is not registered/,
      );
      assert.equal(k.state, 'closed');
      assert.throws(
        () => new VfsKernel(cfg, { preparers: { x: 'not a function' } }),
        /preparers\.x is not a function/,
      );
      // A disabled place names a preparer nobody registered: it is not needed.
      ok = new VfsKernel(
        config({
          a: { fs: { ext: ['js'], prepare: 'id' } },
          off: { enabled: false, fs: { ext: ['js'], prepare: 'nope' } },
        }),
        { appRoot: root, console: quiet, preparers: { id: (raw) => raw } },
      );
      await ok.initialize();
      assert.equal(ok.state, 'ready');
    } finally {
      k.close();
      ok?.close();
      rm(root);
    }
  });
});

// --- Pipeline ---

const RAW = 'module.exports = "RAW";';
const PREPARED = 'module.exports = "PREPARED";';
const code = (raw) => raw.toString().replace('RAW', 'PREPARED');

// Calls of a preparer, by key.
const counted = (fn) => {
  const calls = [];
  const wrapped = (raw, file) => {
    calls.push(file.key);
    return fn(raw, file);
  };
  return { fn: wrapped, calls };
};

// A disk-origin kernel whose epochs are emitted by hand and awaited: a long
// debounce keeps real fs.watch events out.
const disk = async (files, spec, preparers, options = {}, defaults = {}) => {
  const root = writeTree(tmpDir('vfs-prep'), files);
  const k = await kernel(
    root,
    spec,
    { watch: true, watchTimeout: 60000, ...defaults },
    { preparers, ...options },
  );
  const at = (...p) => path.join(root, ...p);
  const epoch = async (events) => {
    k.watcher.emit('epoch', new Map(events));
    await k.watchQueue.idle;
  };
  const done = () => {
    k.close();
    rm(root);
  };
  return { root, k, at, epoch, done };
};

describe('prepare pipeline: every way content arrives', () => {
  it('initial scan, watcher update, new file, new directory', async () => {
    const prep = counted(code);
    const { k, at, epoch, done } = await disk(
      { 'app/a.js': RAW, 'app/n.txt': 'plain' },
      { app: { fs: { ext: ['js', 'txt'], prepare: { code: ['js'] } } } },
      { code: prep.fn },
    );
    try {
      const app = k.fs('app');
      assert.equal(app.readFile('/a.js', 'utf8'), PREPARED);
      assert.equal(app.readFile('/n.txt', 'utf8'), 'plain', 'no preparer');
      assert.equal(fs.readFileSync(at('app', 'a.js'), 'utf8'), RAW, 'disk raw');
      fs.writeFileSync(at('app', 'a.js'), RAW + ' // v2');
      await epoch([[at('app', 'a.js'), 'change']]);
      assert.equal(app.readFile('/a.js', 'utf8'), PREPARED + ' // v2');
      fs.writeFileSync(at('app', 'b.js'), RAW);
      await epoch([[at('app', 'b.js'), 'change']]);
      assert.equal(app.readFile('/b.js', 'utf8'), PREPARED);
      fs.mkdirSync(at('app', 'd', 'e'), { recursive: true });
      fs.writeFileSync(at('app', 'd', 'e', 'c.js'), RAW);
      await epoch([[at('app', 'd'), 'scan']]);
      assert.equal(app.readFile('/d/e/c.js', 'utf8'), PREPARED);
      assert.deepEqual(prep.calls, ['/a.js', '/a.js', '/b.js', '/d/e/c.js']);
    } finally {
      done();
    }
  });

  it('sab + virtual: main thread and worker mutations', async () => {
    const root = tmpDir('vfs-prep');
    const prep = counted(code);
    const k = await kernel(
      root,
      {
        v: {
          origin: 'virtual',
          fs: { writable: true, ext: ['js'], prepare: 'code' },
        },
      },
      {},
      { preparers: { code: prep.fn } },
    );
    let w = null;
    try {
      await k.fs('v').writeFile('/a.js', RAW);
      assert.equal(k.fs('v').readFile('/a.js', 'utf8'), PREPARED);
      // The worker never prepares a shared place: the main kernel does, and
      // the update reaches the worker before the mutation's response.
      w = worker(k);
      await w.kernel.fs('v').writeFile('/b.js', RAW);
      assert.equal(k.fs('v').readFile('/b.js', 'utf8'), PREPARED);
      assert.equal(w.kernel.fs('v').readFile('/b.js', 'utf8'), PREPARED);
      assert.deepEqual(prep.calls, ['/a.js', '/b.js']);
    } finally {
      w?.kernel.close();
      k.close();
      rm(root);
    }
  });

  it('map + disk: init and watcher; map + virtual: local writes', async () => {
    const { k, at, epoch, done } = await disk(
      { 'm/a.js': RAW },
      {
        m: { provider: 'map', fs: { ext: ['js'], prepare: 'code' } },
        mv: {
          provider: 'map',
          origin: 'virtual',
          fs: { writable: true, ext: ['js'], prepare: 'code' },
        },
      },
      { code },
    );
    try {
      assert.equal(k.fs('m').readFile('/a.js', 'utf8'), PREPARED);
      fs.writeFileSync(at('m', 'a.js'), RAW + ' // v2');
      await epoch([[at('m', 'a.js'), 'change']]);
      assert.equal(k.fs('m').readFile('/a.js', 'utf8'), PREPARED + ' // v2');
      k.fs('mv').writeFile('/x.js', RAW);
      assert.equal(k.fs('mv').readFile('/x.js', 'utf8'), PREPARED);
    } finally {
      done();
    }
  });

  it('SEA assets are prepared once at init', async () => {
    const root = tmpDir('vfs-prep');
    const asset = Buffer.from(RAW);
    const seaModule = {
      isSea: () => true,
      getAssetKeys: () => ['pub/a.js'],
      getAsset: () =>
        asset.buffer.slice(asset.byteOffset, asset.byteOffset + asset.length),
    };
    const k = new VfsKernel(
      config({
        pub: { provider: 'sea', fs: { ext: ['js'], prepare: 'code' } },
      }),
      { appRoot: root, console: quiet, seaModule, preparers: { code } },
    );
    try {
      await k.initialize();
      assert.equal(k.fs('pub').readFile('/a.js', 'utf8'), PREPARED);
    } finally {
      k.close();
      rm(root);
    }
  });

  it('worker map + virtual prepares with attach({ preparers }) only', async () => {
    const root = tmpDir('vfs-prep');
    const spec = {
      m: {
        provider: 'map',
        origin: 'virtual',
        fs: { writable: true, ext: ['js', 'txt'], prepare: { code: ['js'] } },
      },
    };
    const k = await kernel(root, spec, {}, { preparers: { code } });
    let given = null;
    let bare = null;
    try {
      given = worker(k, { preparers: { code } });
      given.kernel.fs('m').writeFile('/a.js', RAW);
      assert.equal(given.kernel.fs('m').readFile('/a.js', 'utf8'), PREPARED);
      bare = worker(k);
      const m = bare.kernel.fs('m');
      m.writeFile('/n.txt', 'plain');
      assert.throws(() => m.writeFile('/a.js', RAW), {
        code: 'ENOTSUP',
        syscall: 'open',
        path: m.pathOf('/a.js'),
        message: /preparer "code" is not registered in this thread/,
      });
      assert.equal(m.exists('/a.js'), false);
      // A rename onto the extension needs the preparer too: the rename
      // refuses, naming its call, its source and its destination.
      assert.throws(() => m.rename('/n.txt', '/n.js'), {
        code: 'ENOTSUP',
        syscall: 'rename',
        path: m.pathOf('/n.txt'),
        dest: m.pathOf('/n.js'),
        message: /preparer "code" is not registered in this thread/,
      });
      assert.equal(m.readFile('/n.txt', 'utf8'), 'plain');
      assert.equal(m.exists('/n.js'), false);
    } finally {
      given?.kernel.close();
      bare?.kernel.close();
      k.close();
      rm(root);
    }
  });
});

describe('prepare pipeline: every consumer sees the canonical content', () => {
  const files = {
    'app/a.js': RAW,
    'app/s.css': 'a{}',
    'esm/m.mjs': 'export default "RAW";',
  };
  const spec = {
    app: {
      fs: {
        ext: ['css'],
        zeroCopy: true,
        prepare: { code: ['js'], styles: ['css'] },
        script: { compile: ['js'] },
        compress: { encodings: ['gzip'] },
      },
      require: { compile: ['js'] },
    },
    esm: { import: { ext: ['mjs'], prepare: 'code' } },
  };
  const scriptOptions = { filename: 'prepared.js', lineOffset: 0 };
  const preparers = {
    code: (raw, file) => ({
      source: code(raw),
      scriptOptions,
      meta: { key: file.key, nested: { ext: file.ext } },
    }),
    styles: (raw) => '/*p*/' + raw,
  };

  it('reads, views, streams, compression and PlaceFs.script()', async () => {
    const { k, done } = await disk(files, spec, preparers);
    try {
      const app = k.fs('app');
      assert.equal(app.readFile('/a.js', 'utf8'), PREPARED);
      assert.equal(app.readFile('/s.css', 'utf8'), '/*p*/a{}');
      const lease = app.readFileView('/a.js');
      assert.equal(lease.view.toString(), PREPARED);
      lease.release();
      const stream = app.createReadStream('/a.js');
      assert.equal((await drain(stream)).toString(), PREPARED);
      stream.release();
      const zlib = require('node:zlib');
      const gz = app.readFileCompressed('/a.js', 'gzip');
      assert.equal(zlib.gunzipSync(gz).toString(), PREPARED);
      const bundle = app.script('/a.js');
      assert.equal(bundle.source, PREPARED);
      assert.ok(Buffer.isBuffer(bundle.cachedData));
      assert.deepEqual(bundle.scriptOptions, scriptOptions);
      assert.deepEqual(bundle.meta, { key: '/a.js', nested: { ext: 'js' } });
      assert.ok(Object.isFrozen(bundle.meta.nested), 'meta is deep-frozen');
      assert.equal(app.meta('/a.js'), bundle.meta);
      assert.equal(app.script('/s.css'), null, 'not a script source');
      assert.deepEqual(app.readdir('/'), ['a.js', 's.css'], 'no companions');
    } finally {
      done();
    }
  });

  it('patched node:fs, require and import', async () => {
    const { k, at, done } = await disk(files, spec, preparers);
    fsPatch.install(k);
    moduleHook.install(k);
    try {
      assert.equal(fs.readFileSync(at('app', 'a.js'), 'utf8'), PREPARED);
      assert.equal(require(at('app', 'a.js')), 'PREPARED');
      assert.ok(k.bytecode(at('app', 'a.js')), 'require.compile companion');
      const mod = await import(pathToFileURL(at('esm', 'm.mjs')).href);
      assert.equal(mod.default, 'PREPARED');
    } finally {
      moduleHook.uninstall();
      fsPatch.uninstall();
      done();
    }
  });

  it('require.compile cached data matches the prepared source (worker)', async () => {
    const { k, at, done } = await disk(files, spec, preparers);
    let thread = null;
    try {
      const { vfs, transferList } = k.link();
      const index = JSON.stringify(path.resolve(__dirname, '../index.js'));
      thread = new Worker(
        `
        const vm = require('node:vm');
        const { parentPort } = require('node:worker_threads');
        const seen = [];
        const Real = vm.Script;
        vm.Script = class extends Real {
          constructor(code, options) {
            super(code, options);
            if (options?.cachedData) seen.push(this.cachedDataRejected);
          }
        };
        require(${index}).attach();
        const value = require(${JSON.stringify(at('app', 'a.js'))});
        parentPort.postMessage({ value, seen });
        `,
        { eval: true, workerData: { vfs }, transferList },
      );
      const [message] = await within(
        once(thread, 'message'),
        'the answer of the worker',
      );
      assert.deepEqual(message, { value: 'PREPARED', seen: [false] });
    } finally {
      await thread?.terminate();
      done();
    }
  });

  it('runs once per publication, never on read, for every domain', async () => {
    const prep = counted(code);
    const { k, at, done } = await disk(
      { 'all/a.js': RAW },
      {
        all: {
          fs: { prepare: 'code', script: { compile: ['js'] } },
          require: { compile: ['js'] },
          import: { ext: ['js'] },
        },
      },
      { code: prep.fn },
    );
    try {
      assert.deepEqual(prep.calls, ['/a.js']);
      const all = k.fs('all');
      all.readFile('/a.js');
      all.script('/a.js');
      k.resolveModule(at('all', 'a.js'), 'require');
      k.resolveModule(at('all', 'a.js'), 'import');
      assert.deepEqual(prep.calls, ['/a.js'], 'reads never prepare');
      const place = k.registry.get('all');
      assert.ok(place.bytecode('/a.js', 'script'));
      assert.ok(place.bytecode('/a.js', 'require'));
    } finally {
      done();
    }
  });

  it('a preparer declared in require prepares fs reads and fs.script', async () => {
    const { k, done } = await disk(
      { 'lib/a.js': RAW },
      {
        lib: {
          fs: { ext: ['json'], script: { compile: ['js'] } },
          require: { compile: ['js'], prepare: 'code' },
        },
      },
      {
        code: (raw) => ({
          source: code(raw),
          scriptOptions: { lineOffset: 1 },
        }),
      },
    );
    try {
      const lib = k.fs('lib');
      assert.equal(lib.readFile('/a.js', 'utf8'), PREPARED);
      const bundle = lib.script('/a.js');
      assert.equal(bundle.source, PREPARED);
      assert.deepEqual(bundle.scriptOptions, { lineOffset: 1 });
      assert.ok(bundle.cachedData);
    } finally {
      done();
    }
  });

  it('an unrestricted fs prepares only the listed extensions', async () => {
    const { k, done } = await disk(
      { 'u/a.js': RAW, 'u/b.txt': 'RAW' },
      { u: { fs: { prepare: { code: ['js'] } } } },
      { code },
    );
    try {
      assert.equal(k.fs('u').readFile('/a.js', 'utf8'), PREPARED);
      assert.equal(k.fs('u').readFile('/b.txt', 'utf8'), 'RAW');
    } finally {
      done();
    }
  });
});

describe('prepare pipeline: the preparer contract', () => {
  const virtual = async (fn, extra = {}) => {
    const root = tmpDir('vfs-prep');
    const k = await kernel(
      root,
      {
        v: {
          origin: 'virtual',
          fs: { writable: true, ext: ['js', 'txt'], prepare: { p: ['js'] } },
          ...extra,
        },
      },
      {},
      { preparers: { p: (...args) => fn(...args) } },
    );
    const done = () => {
      k.close();
      rm(root);
    };
    return { k, v: k.fs('v'), done };
  };

  it('passes the raw Buffer and a frozen file description', async () => {
    const seen = [];
    const { k, v, done } = await virtual((raw, file) => {
      seen.push({ raw, file });
      return null;
    });
    try {
      const before = Date.now();
      await v.writeFile('/d/a.js', 'raw bytes');
      const [{ raw, file }] = seen;
      assert.ok(Buffer.isBuffer(raw));
      assert.equal(raw.toString(), 'raw bytes');
      assert.ok(Object.isFrozen(file) && Object.isFrozen(file.stat));
      assert.equal(file.place, 'v');
      assert.equal(file.key, '/d/a.js');
      assert.equal(file.path, path.join(k.appRoot, 'v', 'd', 'a.js'));
      assert.equal(file.ext, 'js');
      assert.equal(file.stat.size, 9);
      assert.ok(file.stat.mtimeMs >= before);
      assert.equal(v.readFile('/d/a.js', 'utf8'), 'raw bytes', 'null → raw');
    } finally {
      done();
    }
  });

  it('accepts strings, Buffers and Uint8Arrays, empty ones too, and copies bytes', async () => {
    let result = null;
    const { v, done } = await virtual(() => result);
    try {
      result = 'text';
      await v.writeFile('/a.js', 'x');
      assert.equal(v.readFile('/a.js', 'utf8'), 'text');
      const reused = Buffer.from('buffer');
      result = reused;
      await v.writeFile('/a.js', 'x');
      reused.write('BUFFER');
      assert.equal(v.readFile('/a.js', 'utf8'), 'buffer', 'published a copy');
      result = { source: new Uint8Array([0x75, 0x38]) };
      await v.writeFile('/a.js', 'x');
      assert.equal(v.readFile('/a.js', 'utf8'), 'u8');
      result = '';
      await v.writeFile('/a.js', 'x');
      assert.equal(v.readFile('/a.js').length, 0);
      result = { source: Buffer.alloc(0) };
      await v.writeFile('/a.js', 'x');
      assert.equal(v.stat('/a.js').size, 0);
    } finally {
      done();
    }
  });

  // Bytes in use inside the pool's segments.
  const poolUsed = (k) => {
    let used = 0;
    for (const id of k.cache.pool.segments.keys()) {
      used += k.cache.registry.used(id);
    }
    return used;
  };

  it('a Uint8Array result is placed at once: a reused buffer never reaches another key', async () => {
    // One scratch buffer for every call, as a bundler reusing its output
    // buffer would: the bytes of a result must be taken before the next
    // call overwrites them — two writes in one turn run their preparers
    // back to back, before either publication goes on.
    const scratch = new Uint8Array(4096);
    let result = null; // a fixed result instead of the scratch one
    const { k, v, done } = await virtual((raw, file) => {
      if (result) return result;
      scratch.fill(0);
      scratch.set(Buffer.from(`${file.key}: ${raw}`));
      return scratch.subarray(0, file.key.length + 2 + raw.length);
    });
    try {
      const used = poolUsed(k);
      await Promise.all([
        v.writeFile('/a.js', 'AAA'),
        v.writeFile('/b.js', 'B'),
      ]);
      assert.equal(v.readFile('/a.js', 'utf8'), '/a.js: AAA');
      assert.equal(v.readFile('/b.js', 'utf8'), '/b.js: B');
      assert.equal(poolUsed(k), used + 10 + 8, 'each version once in the pool');
      // The result with its extras, from the same placement.
      const meta = { built: 1 };
      result = { source: new Uint8Array([0x6d]), meta };
      await v.writeFile('/m.js', 'x');
      assert.equal(v.readFile('/m.js', 'utf8'), 'm');
      assert.deepEqual(v.meta('/m.js'), meta);
      assert.ok(Object.isFrozen(v.meta('/m.js')));
      // A result that cannot live in SAB is refused as before, nothing kept.
      const before = poolUsed(k);
      result = { source: new Uint8Array(256 * 1024) };
      await assert.rejects(v.writeFile('/big.js', 'x'), /does not fit in SAB/);
      assert.equal(v.readFile('/big.js'), null);
      assert.equal(poolUsed(k), before);
    } finally {
      done();
    }
  });

  it('the bytes are taken before meta and scriptOptions are cloned', async () => {
    // A getter of `meta` runs inside structuredClone — after the copy, so
    // what it does to the result's buffer changes nothing.
    const scratch = Buffer.from('AAAA');
    let result = {
      source: new Uint8Array(scratch.buffer, scratch.byteOffset, 4),
      get meta() {
        scratch.fill('Z');
        return { seen: true };
      },
    };
    const { k, v, done } = await virtual(() => result);
    try {
      await v.writeFile('/a.js', 'x');
      assert.equal(v.readFile('/a.js', 'utf8'), 'AAAA');
      assert.deepEqual(v.meta('/a.js'), { seen: true });
      // Extras that cannot be cloned fail the write after the placement,
      // which goes back to the pool.
      const used = poolUsed(k);
      result = { source: new Uint8Array(3000), meta: { fn() {} } };
      await assert.rejects(v.writeFile('/b.js', 'x'), /could not be cloned/);
      assert.equal(v.readFile('/b.js'), null);
      assert.equal(poolUsed(k), used, 'the placed bytes went back to the pool');
      result = {
        source: new Uint8Array(3000),
        scriptOptions: { cachedData: 1 },
      };
      await assert.rejects(v.writeFile('/b.js', 'x'), /reserved/);
      assert.equal(poolUsed(k), used);
    } finally {
      done();
    }
  });

  it('a copy that throws leaves nothing allocated', async () => {
    // Results that pass `instanceof Uint8Array` but cannot be copied: a
    // Proxy that throws on its elements, and a subclass whose `length`
    // lies, so the copy runs past the extent reserved for it.
    const poisoned = new Proxy(new Uint8Array(4000), {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          throw new Error('poisoned element');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    class Short extends Uint8Array {
      get length() {
        return 10;
      }
    }
    let result = 'good';
    const { k, v, done } = await virtual(() => result);
    try {
      await v.writeFile('/a.js', 'x');
      const used = poolUsed(k);
      for (const bad of [poisoned, new Short(4000), { source: poisoned }]) {
        result = bad;
        await assert.rejects(v.writeFile('/a.js', 'x'));
        assert.equal(v.readFile('/a.js', 'utf8'), 'good');
        assert.equal(poolUsed(k), used, 'nothing stayed allocated');
      }
      assert.equal(k.retired.size, 0);
    } finally {
      done();
    }
  });

  it('a preparer that closes the kernel: the write is refused as closed', async () => {
    let kernel = null;
    const { k, v, done } = await virtual(() => {
      kernel.close();
      return new Uint8Array([1, 2, 3]);
    });
    try {
      kernel = k;
      await assert.rejects(v.writeFile('/a.js', 'x'), {
        code: 'ERR_VFS_CLOSED',
        message: '[vfs] kernel closed before publication',
      });
      assert.equal(k.state, 'closed');
    } finally {
      done();
    }
  });

  it('a Uint8Array result placed before a failure is freed with it', async () => {
    let bad = false;
    const { k, v, done } = await virtual(
      (raw) => new Uint8Array(Buffer.from(bad ? '(((' : raw.toString())),
      {
        fs: {
          writable: true,
          prepare: { p: ['js'] },
          script: { compile: ['js'] },
        },
      },
    );
    try {
      await v.writeFile('/a.js', 'module.exports = 1;');
      const used = poolUsed(k);
      const source = v.script('/a.js');
      bad = true;
      await assert.rejects(v.writeFile('/a.js', 'x'), /does not compile/);
      assert.equal(poolUsed(k), used, 'the placed bytes went back to the pool');
      assert.equal(v.readFile('/a.js', 'utf8'), 'module.exports = 1;');
      assert.deepEqual(v.script('/a.js'), source);
      assert.equal(k.retired.size, 0);
    } finally {
      done();
    }
  });

  it('rejects async preparers and malformed results, keeping the old version', async () => {
    let result = 'good';
    const { k, v, done } = await virtual(() => result);
    try {
      await v.writeFile('/a.js', 'x');
      const unhandled = [];
      const onUnhandled = (err) => unhandled.push(err);
      process.on('unhandledRejection', onUnhandled);
      const bad = [
        [Promise.reject(new Error('async')), /must be synchronous/],
        [{ then() {} }, /must be synchronous/],
        [42, /result must be a string, a Uint8Array or \{ source \}/],
        [{ source: 42 }, /source must be a string or Uint8Array/],
        [{}, /source must be a string or Uint8Array/],
        [{ source: 'x', meta: 'm' }, /meta must be an object/],
        [{ source: 'x', scriptOptions: { cachedData: 1 } }, /reserved/],
      ];
      for (const [value, re] of bad) {
        result = value;
        await assert.rejects(v.writeFile('/a.js', 'x'), re);
        assert.equal(v.readFile('/a.js', 'utf8'), 'good');
      }
      await new Promise((resolve) => setImmediate(resolve));
      process.off('unhandledRejection', onUnhandled);
      assert.deepEqual(unhandled, [], 'no unhandled rejection');
      assert.equal(k.retired.size, 0);
    } finally {
      done();
    }
  });

  it('a throwing preparer keeps the previous version and its companions', async () => {
    let fail = false;
    const { k, v, done } = await virtual(
      (raw) => {
        if (fail) throw new Error('bad input');
        return raw.toString();
      },
      { require: { compile: ['js'] } },
    );
    try {
      await v.writeFile('/a.js', 'module.exports = 1;');
      const place = k.registry.get('v');
      const bytecode = place.bytecode('/a.js');
      fail = true;
      await assert.rejects(v.writeFile('/a.js', 'module.exports = 2;'), /bad/);
      assert.equal(v.readFile('/a.js', 'utf8'), 'module.exports = 1;');
      assert.equal(place.bytecode('/a.js'), bytecode);
    } finally {
      done();
    }
  });

  // The preparer of the smallest file throws; the larger ones, published
  // first (#publishAll: largest first), have staged their sources and
  // companions by then. initialize() rejects with that very error and
  // closes the kernel: nothing is committed, published or versioned, every
  // projection is empty, and the kernel keeps no runtime reference — the
  // pool goes whole with what the failed attempt allocated in it. Last, as
  // an extra check, V8 collects that pool.
  it('a preparer that throws in initialize(): rejected, closed, nothing kept', async () => {
    const spec = {
      sab: {
        fs: {
          prepare: { p: ['js'] },
          script: { compile: ['js'] },
          compress: { encodings: ['gzip'], ext: ['js'] },
        },
        require: { compile: ['js'] },
      },
      map: {
        provider: 'map',
        fs: { prepare: { p: ['js'] }, script: { compile: ['js'] } },
        require: { compile: ['js'] },
      },
    };
    for (const [provider, place] of Object.entries(spec)) {
      const files = { 'app/bad.js': 'bad' };
      for (let i = 0; i < 6; i++) {
        files[`app/ok${i}.js`] = `module.exports = ${i}; // ${'x'.repeat(200)}`;
      }
      const root = writeTree(tmpDir('vfs-prep-init'), files);
      const baseline = activeResources();
      const boom = new Error('bad input');
      let pool = null; // the kernel's pool, as its preparer saw it
      let closed = false;
      let late = 0; // preparer calls once initialize() rejected
      const k = new VfsKernel(config({ app: place }, { watch: true }), {
        appRoot: root,
        console: quiet,
        preparers: {
          p: (raw) => {
            pool ??= k.cache;
            if (closed) late++;
            if (raw.toString() === 'bad') throw boom;
            return raw;
          },
        },
      });
      const events = [];
      k.on('publish', () => events.push('publish'));
      k.on('close', () => events.push('close'));
      try {
        await assert.rejects(k.initialize(), (err) => {
          assert.equal(err, boom, provider);
          return true;
        });
        closed = true;
        // Closed.
        assert.equal(k.state, 'closed', provider);
        assert.equal(k.ready, false, provider);
        assert.equal(k.registry.get('app').preparationFailures, 1, provider);
        await turn();
        assert.deepEqual(events, ['close'], `${provider}: no publish`);
        // No commit, no version: the larger files allocated in the pool,
        // none of it reached its index.
        let used = 0;
        for (const id of pool.pool.segments.keys()) {
          used += pool.registry.used(id);
        }
        if (provider === 'sab') assert.ok(used > 0, 'staged, then left');
        const index = pool.indexes.get('app')?.entries ?? new Map();
        assert.deepEqual([...index], [], `${provider}: nothing committed`);
        assert.equal(k.version, 0, `${provider}: no version`);
        assert.equal(k.nextUpdateId, 0, `${provider}: no vfs-update`);
        // Empty projections.
        assert.equal(k.registry.get('app').files.size, 0, provider);
        assert.equal(k.sources.size, 0, provider);
        // No runtime reference: no pool, no watcher, no work left.
        assert.equal(k.cache, null, provider);
        assert.equal(k.compressor, null, provider);
        assert.equal(k.segmentsMap.size, 0, provider);
        assert.equal(k.retired.size, 0, provider);
        assert.equal(k.links.size, 0, provider);
        assert.equal(k.watcher, null, `${provider}: no watcher`);
        assert.equal(k.rechecks.size, 0, provider);
        assert.equal(late, 0, `${provider}: no preparer after the rejection`);
        await until(() => Object.keys(activeSince(baseline)).length === 0);
        assert.deepEqual(activeSince(baseline), {}, provider);
        // Extra: once the test lets it go, nothing holds the pool.
        v8.setFlagsFromString('--expose-gc');
        const gc = vm.runInNewContext('gc');
        const weak = new WeakRef(pool);
        pool = null;
        let collected = false;
        for (let i = 0; i < 10 && !collected; i++) {
          await turn();
          gc();
          collected = weak.deref() === undefined;
        }
        assert.ok(collected, `${provider}: the pool is collected`);
      } finally {
        k.close();
        rm(root);
      }
    }
  });

  it('a watcher-side failure keeps the previous version', async () => {
    const warnings = [];
    let fail = false;
    const { k, at, epoch, done } = await disk(
      { 'app/a.js': RAW },
      {
        app: {
          fs: { prepare: 'code', script: { compile: ['js'] } },
        },
      },
      {
        code: (raw) => (fail ? '(((' : code(raw)),
      },
      { console: { ...quiet, warn: (m) => warnings.push(m) } },
    );
    try {
      fail = true;
      fs.writeFileSync(at('app', 'a.js'), RAW + ' // v2');
      await epoch([[at('app', 'a.js'), 'change']]);
      assert.equal(k.fs('app').readFile('/a.js', 'utf8'), PREPARED);
      assert.equal(k.fs('app').script('/a.js').source, PREPARED);
      const refusal =
        'not published — ENOTSUP: operation not supported ' +
        `(fs.script.compile: source does not compile), open '${at('app', 'a.js')}'`;
      assert.ok(warnings.some((w) => w.endsWith(refusal)));
    } finally {
      done();
    }
  });

  it('prepare and scriptOptions never turn fs.script on', async () => {
    const root = tmpDir('vfs-prep-noscript');
    const k = await kernel(
      root,
      {
        v: {
          origin: 'virtual',
          fs: { writable: true, ext: ['js'], prepare: 'wrap' },
        },
      },
      {},
      {
        preparers: {
          wrap: (raw, file) => ({
            source: `(${raw.toString().trim()})`,
            scriptOptions: { filename: file.path },
          }),
        },
      },
    );
    try {
      const v = k.fs('v');
      await v.writeFile('/a.js', 'x => x');
      assert.equal(v.readFile('/a.js', 'utf8'), '(x => x)');
      assert.ok(!k.cache.entry('v', bytecodeKey('/a.js', 'script')));
      assert.throws(() => v.script('/a.js'), { code: 'ENOTSUP' });
    } finally {
      k.close();
      rm(root);
    }
  });
});

describe('prepare pipeline: publication', () => {
  it('source and companions travel in one update; raw bytes never stay', async () => {
    const { k, at, epoch, done } = await disk(
      { 'app/a.js': RAW },
      {
        app: {
          fs: {
            prepare: 'code',
            script: { compile: ['js'] },
            compress: { encodings: ['gzip'] },
          },
          require: { compile: ['js'] },
        },
      },
      { code },
    );
    try {
      // The pool holds exactly the published entries: no raw copy anywhere.
      const pooled = () => {
        let published = 0;
        for (const entry of k.cache.index('app').entries.values()) {
          published += entry.length;
        }
        let used = 0;
        for (const id of k.cache.pool.segments.keys()) {
          used += k.cache.registry.used(id);
        }
        return [used, published];
      };
      const [used, published] = pooled();
      assert.equal(used, published);
      const t = tap(k);
      const acked = nextMessage(k.links.get(t.id));
      fs.writeFileSync(at('app', 'a.js'), RAW + ' // v2');
      await epoch([[at('app', 'a.js'), 'change']]);
      await acked;
      const [msg] = t.updates();
      assert.deepEqual(
        msg.places.app.entries.map(([key]) => key).sort(),
        [
          '/a.js',
          bytecodeKey('/a.js', 'require'),
          bytecodeKey('/a.js', 'script'),
          compressedKey('/a.js', 'gzip'),
        ].sort(),
      );
      assert.equal(k.retired.size, 0, 'the old version went with the ACK');
      const [usedAfter, publishedAfter] = pooled();
      assert.equal(usedAfter, publishedAfter);
    } finally {
      done();
    }
  });

  // The files of a new directory reach the pipeline through a rescan of
  // it: each gets its prepared source and the bytecode built from it — every
  // file and every companion in the one vfs-update of the epoch.
  it('new files in a new directory: prepared sources and bytecode in one update', async () => {
    const prep = counted(code);
    const { k, at, epoch, done } = await disk(
      { 'app/a.js': RAW },
      {
        app: {
          fs: { prepare: 'code', script: { compile: ['js'] } },
          require: { compile: ['js'] },
        },
      },
      { code: prep.fn },
    );
    try {
      const t = tap(k);
      fs.mkdirSync(at('app', 'new', 'deep'), { recursive: true });
      fs.writeFileSync(at('app', 'new', 'b.js'), RAW);
      fs.writeFileSync(at('app', 'new', 'deep', 'c.js'), RAW);
      const delivered = nextMessage(t.port);
      await epoch([[at('app', 'new'), 'scan']]);
      await delivered;
      const [update, ...more] = t.updates();
      assert.deepEqual(more, [], 'one update');
      const published = ['/new/b.js', '/new/deep/c.js'];
      assert.deepEqual(
        update.places.app.entries.map(([key]) => key).sort(),
        published
          .flatMap((key) => [
            key,
            bytecodeKey(key, 'require'),
            bytecodeKey(key, 'script'),
          ])
          .sort(),
      );
      assert.deepEqual(prep.calls.slice(1).sort(), published, 'prepared once');
      const app = k.fs('app');
      for (const key of published) {
        assert.equal(app.readFile(key, 'utf8'), PREPARED, key);
        const bundle = app.script(key);
        assert.equal(bundle.source, PREPARED, key);
        assert.ok(bundle.cachedData?.length > 0, `${key}: its bytecode`);
      }
    } finally {
      done();
    }
  });

  // Compaction moves published versions as they are: a prepared source and
  // its companions leave the emptied segment together, in the one
  // vfs-update of the compaction, their bytes unchanged and nothing
  // prepared, compiled or compressed again. Forced: the file that filled the
  // segment is deleted, and its free — once the link ACKs its removal —
  // leaves the segment below the threshold.
  it('compaction moves a prepared source and its companions together', async () => {
    const prep = counted(code);
    const { k, at, epoch, done } = await disk(
      {
        'app/a.js': RAW,
        'app/fill1.bin': Buffer.alloc(41000, 1),
        'app/fill2.bin': Buffer.alloc(40000, 2),
      },
      {
        app: {
          fs: {
            ext: ['bin'],
            prepare: { code: ['js'] },
            script: { compile: ['js'] },
            compress: { encodings: ['gzip'], ext: ['js'] },
          },
          require: { compile: ['js'] },
        },
      },
      { code: prep.fn },
      {},
      {
        memory: {
          limit: '256 kib',
          segmentSize: '64 kib',
          maxFileSize: '64 kib',
        },
        compaction: { threshold: 0.5 },
      },
    );
    try {
      const keys = [
        '/a.js',
        bytecodeKey('/a.js', 'require'),
        bytecodeKey('/a.js', 'script'),
        compressedKey('/a.js', 'gzip'),
      ];
      const entries = () => keys.map((key) => k.cache.entry('app', key));
      // Largest first: fill1 opens the first segment, fill2 the second, and
      // the prepared source and its companions join fill1.
      const segment = k.cache.entry('app', '/fill1.bin').segmentId;
      assert.notEqual(k.cache.entry('app', '/fill2.bin').segmentId, segment);
      const before = entries();
      assert.ok(before.every((entry) => entry?.segmentId === segment));
      const bytes = keys.map((key) =>
        Buffer.from(k.registry.get('app').files.get(key).data),
      );
      const t = tap(k);
      fs.unlinkSync(at('app', 'fill1.bin'));
      await epoch([[at('app', 'fill1.bin'), 'delete']]);
      assert.ok(await until(() => t.updates().length === 2, 4000), 'moved');
      const [removal, moved] = t.updates();
      assert.deepEqual(removal.places.app.removals, ['/fill1.bin']);
      assert.deepEqual(
        moved.places.app.entries.map(([key]) => key).sort(),
        [...keys].sort(),
        'the source and its companions, in one update',
      );
      const after = entries();
      assert.ok(after.every((entry) => entry.segmentId !== segment));
      const { files } = k.registry.get('app');
      keys.forEach((key, i) => {
        assert.deepEqual(Buffer.from(files.get(key).data), bytes[i], key);
      });
      const app = k.fs('app');
      assert.equal(app.readFile('/a.js', 'utf8'), PREPARED);
      assert.equal(app.script('/a.js').source, PREPARED);
      const gzip = app.readFileCompressed('/a.js', 'gzip');
      assert.equal(require('node:zlib').gunzipSync(gzip).toString(), PREPARED);
      assert.deepEqual(prep.calls, ['/a.js'], 'prepared once, at init');
    } finally {
      done();
    }
  });

  it('appendFile and moves of prepared keys are refused; others re-prepare', async () => {
    const root = tmpDir('vfs-prep');
    const k = await kernel(
      root,
      {
        v: {
          origin: 'virtual',
          fs: { writable: true, ext: ['js', 'txt'], prepare: { code: ['js'] } },
        },
        m: {
          provider: 'map',
          origin: 'virtual',
          fs: { writable: true, ext: ['js', 'txt'], prepare: { code: ['js'] } },
        },
      },
      {},
      { preparers: { code } },
    );
    try {
      for (const name of ['v', 'm']) {
        const place = k.fs(name);
        await place.writeFile('/a.js', RAW);
        await assert.rejects(async () => place.appendFile('/a.js', 'x'), {
          code: 'ENOTSUP',
        });
        await assert.rejects(async () => place.rename('/a.js', '/a.txt'), {
          code: 'ENOTSUP',
        });
        await assert.rejects(async () => place.rename('/a.js', '/b.js'), {
          code: 'ENOTSUP',
        });
        assert.equal(place.readFile('/a.js', 'utf8'), PREPARED, name);
        await place.writeFile('/r.txt', RAW);
        await place.rename('/r.txt', '/r.js');
        assert.equal(
          place.readFile('/r.js', 'utf8'),
          PREPARED,
          'new ext rules',
        );
        assert.equal(place.exists('/r.txt'), false);
        await place.writeFile('/t.txt', 'plain');
        await place.appendFile('/t.txt', '+');
        assert.equal(place.readFile('/t.txt', 'utf8'), 'plain+');
      }
    } finally {
      k.close();
      rm(root);
    }
  });
});
