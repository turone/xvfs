'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const moduleHook = require('../lib/adapters/module-hook.js');
const { bytecodeKey } = require('../lib/companion.js');
const { tmpDir, writeTree, rm, kernel } = require('./helpers.js');

// Spy on vm.Script to observe whether V8 accepted our cached data.
const scripts = [];
const RealScript = vm.Script;
const spyScripts = () => {
  vm.Script = class extends RealScript {
    constructor(code, options) {
      super(code, options);
      if (options?.cachedData)
        scripts.push({
          filename: options.filename,
          rejected: this.cachedDataRejected,
        });
    }
  };
};
const unspy = () => {
  vm.Script = RealScript;
};

describe('module-hook: CommonJS', () => {
  let root;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    root = writeTree(tmpDir('modhook'), {
      'lib/a.js':
        "exports.name = 'a'; exports.b = require('./b'); exports.loadedInside = module.loaded; exports.dir = __dirname; exports.file = __filename;",
      'lib/b.js': "exports.name = 'b'; exports.a = require('./a.js');",
      'lib/c.cjs': 'module.exports = "c";',
      'lib/data.json': '{"x": 1}',
      'lib/dir/index.js': 'module.exports = "dir-index";',
      'lib/pkg/package.json': '{"main": "src/entry"}',
      'lib/pkg/src/entry.js': 'module.exports = "pkg-main";',
      'lib/throws.js':
        'globalThis.__vfsThrows = (globalThis.__vfsThrows || 0) + 1; throw new Error("boom");',
      'lib/bare.js': "module.exports = require('node:path').sep;",
      'lib/damaged.js':
        'globalThis.__vfsDamaged = (globalThis.__vfsDamaged || 0) + 1; module.exports = "repaired";',
      'lib/noext': 'module.exports = "noext";',
      'lib/notes.md': '# not a module',
      'disk/d.js': 'module.exports = "disk";',
    });
    k = await kernel(root, {
      lib: { require: { ext: ['json'], compile: ['js', 'cjs'] } },
      mem: {
        provider: 'map',
        origin: 'virtual',
        fs: { writable: true },
        require: { ext: ['json'], compile: ['js', 'cjs'] },
      },
      disk: { provider: 'disk', require: true },
    });
    moduleHook.install(k);
    spyScripts();
  });

  after(() => {
    unspy();
    moduleHook.uninstall();
    k.close();
    rm(root);
  });

  it('resolves relative and absolute specifiers, circular deps, module.loaded', () => {
    const a = require(at('lib', 'a'));
    assert.equal(a.name, 'a');
    assert.equal(a.b.name, 'b');
    assert.equal(a.b.a, a, 'circular dependency returns the same module');
    assert.equal(a.loadedInside, false);
    assert.equal(a.dir, at('lib'));
    assert.equal(a.file, at('lib', 'a.js'));
    assert.equal(require.cache[at('lib', 'a.js')].loaded, true);
    assert.equal(require(at('lib', 'a.js')), a, 'cached by filename');
  });

  it('takes the cached-data path for sab modules', () => {
    // V8's per-isolate compilation cache already knows this source (the kernel
    // compiled it here), so acceptance itself is proven in the worker test.
    const used = scripts.filter((s) => s.filename === at('lib', 'a.js'));
    assert.equal(used.length, 1);
    assert.ok(k.bytecode(at('lib', 'a.js')));
  });

  it('LOAD_AS_FILE: exact, .js, .cjs, .json; LOAD_AS_DIRECTORY: package main, index', () => {
    assert.equal(require(at('lib', 'noext')), 'noext');
    assert.equal(require(at('lib', 'c')), 'c');
    assert.deepEqual(require(at('lib', 'data')), { x: 1 });
    assert.equal(require(at('lib', 'dir')), 'dir-index');
    assert.equal(require(at('lib', 'pkg')), 'pkg-main');
    assert.equal(
      k.bytecode(at('lib', 'data.json')),
      null,
      'json has no bytecode',
    );
  });

  it('a throwing module body executes exactly once and propagates', () => {
    assert.ok(
      k.bytecode(at('lib', 'throws.js')),
      'has bytecode, so the cached path is taken',
    );
    assert.throws(() => require(at('lib', 'throws.js')), /boom/);
    assert.equal(globalThis.__vfsThrows, 1);
    assert.throws(() => require(at('lib', 'throws.js')), /boom/);
    assert.equal(
      globalThis.__vfsThrows,
      2,
      'one execution per require, never a re-run fallback',
    );
    delete globalThis.__vfsThrows;
  });

  it('damaged cached data falls back to the normal compiler once', () => {
    const place = k.registry.get('lib');
    const key = bytecodeKey('/damaged.js');
    const good = place.files.get(key);
    place.files.set(key, {
      data: Buffer.from('garbage-not-bytecode'),
      stat: good.stat,
    });
    const before = scripts.length;
    assert.equal(require(at('lib', 'damaged.js')), 'repaired');
    assert.equal(globalThis.__vfsDamaged, 1, 'executed once');
    const attempts = scripts
      .slice(before)
      .filter((s) => s.filename === at('lib', 'damaged.js'));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].rejected, true);
    place.files.set(key, good);
    delete globalThis.__vfsDamaged;
  });

  it('bare and builtin specifiers use the default resolver', () => {
    assert.equal(require(at('lib', 'bare.js')), path.sep);
  });

  it('memory modules load without a disk file; require.cache eviction reloads', () => {
    const mem = k.fs('mem');
    mem.writeFile('/tool.js', 'module.exports = 1;');
    const file = at('mem', 'tool.js');
    assert.equal(require(file), 1);
    assert.equal(require(file), 1);
    mem.writeFile('/tool.js', 'module.exports = 2;');
    assert.equal(
      require(file),
      1,
      'Node module cache still holds the old instance',
    );
    delete require.cache[file];
    assert.equal(require(file), 2);
    const used = scripts.filter((s) => s.filename === file);
    assert.ok(used.length >= 1, 'memory bytecode path taken');
  });

  it('files outside the require ext and disk places are left to Node', () => {
    assert.throws(
      () => require(at('lib', 'notes.md')),
      /Unexpected token|SyntaxError|not a module|Cannot find/,
    );
    assert.equal(require(at('disk', 'd.js')), 'disk');
    assert.equal(
      scripts.filter((s) => s.filename === at('disk', 'd.js')).length,
      0,
    );
  });

  it('uninstall restores Module.prototype._compile and the resolver', () => {
    moduleHook.uninstall();
    assert.throws(() => require(at('mem', 'tool.js') + '.nope'), {
      code: 'MODULE_NOT_FOUND',
    });
    moduleHook.install(k);
  });
});

// An extension of `require.compile` beyond js and cjs: a module that names
// it loads it as CommonJS through its cached data; one that leaves it out
// finds nothing — only js, cjs and json are tried, as in Node.
describe('module-hook: an extension of require.compile', () => {
  let root;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    root = writeTree(tmpDir('modhook-compile'), {
      'app/main.js':
        "exports.view = require('./view.dhtml'); exports.data = require('./data.json');",
      'app/bare.js': "module.exports = require('./view');",
      'app/view.dhtml': '<p>{{name}}</p>',
      'app/data.json': '{"name": "ann"}',
    });
    const view = (raw) =>
      `module.exports = (data) => ${JSON.stringify(raw.toString())}` +
      ".replace('{{name}}', data.name);";
    k = await kernel(
      root,
      {
        app: {
          require: {
            ext: ['json'],
            compile: ['js', 'cjs', 'dhtml'],
            prepare: { view: ['dhtml'] },
          },
        },
      },
      {},
      { preparers: { view } },
    );
    moduleHook.install(k);
    spyScripts();
  });

  after(() => {
    unspy();
    moduleHook.uninstall();
    k.close();
    rm(root);
  });

  it('require of the full name takes the cached-data path', () => {
    const main = require(at('app', 'main.js'));
    assert.equal(main.view({ name: 'ann' }), '<p>ann</p>');
    const file = at('app', 'view.dhtml');
    assert.ok(k.bytecode(file));
    assert.equal(scripts.filter((s) => s.filename === file).length, 1);
  });

  it('json loads without bytecode', () => {
    const file = at('app', 'data.json');
    assert.deepEqual(require(at('app', 'main.js')).data, { name: 'ann' });
    assert.equal(k.bytecode(file), null);
    assert.equal(scripts.filter((s) => s.filename === file).length, 0);
  });

  it('a specifier without the extension finds nothing', () => {
    assert.throws(() => require(at('app', 'bare.js')), {
      code: 'MODULE_NOT_FOUND',
    });
  });
});

// require.resolve() names the file require() loads, on every Node version
// — Node's own asks the resolve hooks only from 24.20 on — for files that
// exist in memory alone: from a module compiled with cached data (the
// hook's require), from one Node compiled, and from outside the places.
// Install touches no `require.extensions`; uninstall puts back what it
// replaced.
describe('module-hook: require.resolve names what require() loads', () => {
  let root;
  let k;
  let native;
  const at = (...p) => path.join(root, ...p);
  const PROBE =
    'const named = (id) => { try { return require.resolve(id); } ' +
    'catch (err) { return err.code; } };\n' +
    "module.exports = { view: named('./view.dhtml'), " +
    "data: named('./data.json'), bare: named('./view'), " +
    "loaded: require('./view.dhtml') };";

  before(async () => {
    native = {
      compile: Module.prototype._compile,
      resolveFilename: Module._resolveFilename,
      extensions: Object.keys(require.extensions),
    };
    root = tmpDir('modhook-resolve');
    k = await kernel(root, {
      mem: {
        provider: 'map',
        origin: 'virtual',
        fs: { writable: true },
        require: { ext: ['json', 'cjs'], compile: ['js', 'dhtml'] },
      },
    });
    const mem = k.fs('mem');
    mem.writeFile('/compiled.js', PROBE);
    mem.writeFile('/plain.cjs', PROBE);
    mem.writeFile('/view.dhtml', "module.exports = 'view';");
    mem.writeFile('/data.json', '{"a": 1}');
    moduleHook.install(k);
    spyScripts();
  });

  after(() => {
    unspy();
    moduleHook.uninstall();
    k.close();
    rm(root);
  });

  it('from a module compiled with cached data and from one Node compiled', () => {
    const expected = {
      view: at('mem', 'view.dhtml'),
      data: at('mem', 'data.json'),
      bare: 'MODULE_NOT_FOUND',
      loaded: 'view',
    };
    assert.deepEqual(require(at('mem', 'compiled.js')), expected);
    assert.deepEqual(require(at('mem', 'plain.cjs')), expected);
    const compiled = at('mem', 'compiled.js');
    assert.ok(k.bytecode(compiled));
    assert.equal(scripts.filter((s) => s.filename === compiled).length, 1);
    assert.equal(k.bytecode(at('mem', 'plain.cjs')), null);
  });

  it('from outside the places', () => {
    assert.equal(
      require.resolve(at('mem', 'view.dhtml')),
      at('mem', 'view.dhtml'),
    );
    assert.throws(() => require.resolve(at('mem', 'view')), {
      code: 'MODULE_NOT_FOUND',
    });
  });

  it('install adds no require.extensions entry', () => {
    assert.deepEqual(Object.keys(require.extensions), native.extensions);
    assert.equal(require.extensions['.dhtml'], undefined);
  });

  it('uninstall restores _compile and _resolveFilename', () => {
    assert.notEqual(Module.prototype._compile, native.compile);
    assert.notEqual(Module._resolveFilename, native.resolveFilename);
    moduleHook.uninstall();
    try {
      assert.equal(Module.prototype._compile, native.compile);
      assert.equal(Module._resolveFilename, native.resolveFilename);
      assert.deepEqual(Object.keys(require.extensions), native.extensions);
      assert.throws(() => require.resolve(at('mem', 'view.dhtml')), {
        code: 'MODULE_NOT_FOUND',
      });
    } finally {
      moduleHook.install(k);
    }
    assert.equal(
      require.resolve(at('mem', 'view.dhtml')),
      at('mem', 'view.dhtml'),
    );
  });
});

// The Module._resolveFilename patch over its life, against kernels that
// note what they are asked: install() twice wraps once; uninstall() puts
// back what was there; a patch kept past uninstall() — or past a later
// install() — goes to the function it replaced, never to a kernel; what no
// place serves is Node's own answer.
describe('module-hook: the _resolveFilename patch over its life', () => {
  let native;
  const noting = (name) => {
    const own = path.join(__dirname, 'xvfs-unmounted', name, 'view.dhtml');
    const asked = [];
    return {
      own,
      asked,
      resolveModule: (candidate) => {
        asked.push(candidate);
        return candidate === own ? { file: { data: Buffer.from('') } } : null;
      },
      bytecode: () => null,
    };
  };
  // What `resolve` answers for `request` from this file: a path, or the
  // code of its error.
  const answer = (resolve, request, options) => {
    try {
      return resolve.call(Module, request, module, false, options);
    } catch (err) {
      return err.code;
    }
  };

  before(() => {
    native = Module._resolveFilename;
  });

  it('install() twice wraps once; uninstall() puts back what was there', () => {
    const a = noting('a');
    moduleHook.install(a);
    const patch = Module._resolveFilename;
    try {
      moduleHook.install(noting('b'));
      assert.equal(Module._resolveFilename, patch, 'no second wrapper');
      assert.equal(answer(Module._resolveFilename, a.own), a.own);
    } finally {
      moduleHook.uninstall();
    }
    assert.equal(Module._resolveFilename, native);
    // Another patch found there is what comes back.
    const theirs = (...args) => native.apply(Module, args);
    Module._resolveFilename = theirs;
    try {
      moduleHook.install(a);
      assert.notEqual(Module._resolveFilename, theirs);
      moduleHook.uninstall();
      assert.equal(Module._resolveFilename, theirs);
    } finally {
      Module._resolveFilename = native;
    }
  });

  it('a patch kept past uninstall() goes to what it replaced, never to a kernel', () => {
    const a = noting('a');
    moduleHook.install(a);
    const kept = Module._resolveFilename;
    moduleHook.uninstall();
    a.asked.length = 0;
    for (const request of [a.own, './nope', 'node:fs', 'metautil']) {
      assert.equal(answer(kept, request), answer(native, request), request);
    }
    assert.deepEqual(a.asked, [], 'the kernel is never asked');
  });

  it('kernels one after another: only the current install looks, in its own kernel', () => {
    const a = noting('a');
    const b = noting('b');
    moduleHook.install(a);
    const first = Module._resolveFilename;
    moduleHook.uninstall();
    moduleHook.install(b);
    try {
      a.asked.length = 0;
      assert.equal(answer(Module._resolveFilename, b.own), b.own);
      assert.equal(answer(Module._resolveFilename, a.own), 'MODULE_NOT_FOUND');
      assert.deepEqual(a.asked, [], 'the earlier kernel is never asked');
      b.asked.length = 0;
      assert.equal(answer(first, b.own), 'MODULE_NOT_FOUND');
      assert.deepEqual(b.asked, [], 'the earlier patch asks no kernel');
    } finally {
      moduleHook.uninstall();
    }
    assert.equal(Module._resolveFilename, native);
  });

  it("what no place serves is Node's own answer", () => {
    moduleHook.install(noting('a'));
    try {
      for (const request of [
        'node:fs',
        'fs',
        'metautil',
        './helpers.js',
        '../package.json',
        './nope',
        'xvfs-no-such-package',
      ]) {
        assert.equal(
          answer(Module._resolveFilename, request),
          answer(native, request),
          request,
        );
      }
      const paths = { paths: [__dirname] };
      assert.equal(
        answer(Module._resolveFilename, './helpers.js', paths),
        answer(native, './helpers.js', paths),
      );
      assert.equal(
        require.resolve('./helpers.js'),
        path.join(__dirname, 'helpers.js'),
      );
    } finally {
      moduleHook.uninstall();
    }
  });
});

// The Module.prototype._compile patch over its life, as the
// _resolveFilename patch's: a patch kept past uninstall() compiles with the
// function it replaced and asks no kernel, not even after another kernel
// installs; install() twice wraps once; uninstall() puts back a patch
// found there; require() goes on as before.
describe('module-hook: the _compile patch over its life', () => {
  let native;
  const base = path.join(__dirname, 'xvfs-unmounted');
  // A kernel that notes the files it is asked cached data for and serves
  // none; once closed, a question is an error.
  const noting = () => {
    let closed = false;
    const asked = [];
    return {
      resolveModule: () => null,
      bytecode: (filename) => {
        if (!filename.startsWith(base)) return null;
        asked.push(filename);
        if (closed) throw new Error('a closed kernel was asked');
        return Buffer.from('not cached data');
      },
      asked,
      close: () => {
        closed = true;
      },
    };
  };
  // `content` compiled by `patch` as Node calls Module.prototype._compile:
  // on a module of `name`.
  const compileWith = (patch, name, content) => {
    const filename = path.join(base, name);
    const mod = new Module(filename, module);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(base);
    patch.call(mod, content, filename);
    return mod.exports;
  };

  before(() => {
    native = Module.prototype._compile;
  });

  it('a patch kept past uninstall() compiles with what it replaced and asks no kernel', () => {
    const replaced = [];
    const theirs = function compile(content, filename, ...rest) {
      replaced.push(path.basename(filename));
      // eslint-disable-next-line no-invalid-this
      return native.call(this, content, filename, ...rest);
    };
    Module.prototype._compile = theirs;
    try {
      const a = noting();
      moduleHook.install(a);
      const kept = Module.prototype._compile;
      moduleHook.uninstall();
      a.close();
      assert.equal(compileWith(kept, 'k.js', 'module.exports = 42;'), 42);
      assert.deepEqual(replaced, ['k.js'], 'the function it replaced');
      assert.deepEqual(a.asked, [], 'the kernel is never asked');
    } finally {
      Module.prototype._compile = native;
    }
  });

  it('kernels one after another: a kept patch is not sent to the new kernel', () => {
    const a = noting();
    const b = noting();
    moduleHook.install(a);
    const first = Module.prototype._compile;
    moduleHook.uninstall();
    a.close();
    moduleHook.install(b);
    try {
      assert.equal(compileWith(first, 'first.js', 'module.exports = 1;'), 1);
      assert.deepEqual(
        b.asked,
        [],
        'the earlier patch asks the new kernel nothing',
      );
      const current = Module.prototype._compile;
      assert.equal(
        compileWith(current, 'current.js', 'module.exports = 2;'),
        2,
      );
      assert.deepEqual(b.asked, [path.join(base, 'current.js')]);
      assert.deepEqual(a.asked, []);
    } finally {
      moduleHook.uninstall();
    }
    assert.equal(Module.prototype._compile, native);
  });

  it('install() twice wraps once', () => {
    const a = noting();
    moduleHook.install(a);
    const patch = Module.prototype._compile;
    try {
      moduleHook.install(noting());
      assert.equal(Module.prototype._compile, patch, 'no second wrapper');
      assert.equal(compileWith(patch, 'once.js', 'module.exports = 3;'), 3);
      assert.deepEqual(a.asked, [path.join(base, 'once.js')]);
    } finally {
      moduleHook.uninstall();
    }
    assert.equal(Module.prototype._compile, native, 'nothing left over');
  });

  it('uninstall() puts back a patch that was there before install()', () => {
    const theirs = function compile(...args) {
      // eslint-disable-next-line no-invalid-this
      return native.apply(this, args);
    };
    Module.prototype._compile = theirs;
    try {
      moduleHook.install(noting());
      assert.notEqual(Module.prototype._compile, theirs);
      moduleHook.uninstall();
      assert.equal(Module.prototype._compile, theirs);
    } finally {
      Module.prototype._compile = native;
    }
  });

  it('require() goes on as before: cached data while installed, Node after', async () => {
    const root = writeTree(tmpDir('modhook-compile-life'), {
      'lib/a.js': 'module.exports = "a";',
      'lib/b.js': 'module.exports = "b";',
      'lib/c.js': 'module.exports = "c";',
    });
    const k = await kernel(root, { lib: { require: { compile: ['js'] } } });
    const at = (name) => path.join(root, 'lib', name);
    const cached = (name) =>
      scripts.filter((s) => s.filename === at(name)).length;
    spyScripts();
    try {
      moduleHook.install(k);
      assert.equal(require(at('a.js')), 'a');
      assert.equal(cached('a.js'), 1, 'through its cached data');
      moduleHook.uninstall();
      assert.equal(Module.prototype._compile, native);
      assert.equal(require(at('b.js')), 'b', 'from disk, by Node');
      assert.equal(cached('b.js'), 0);
      moduleHook.install(k);
      assert.equal(require(at('c.js')), 'c');
      assert.equal(cached('c.js'), 1, 'installed again: cached data again');
    } finally {
      unspy();
      moduleHook.uninstall();
      k.close();
      rm(root);
    }
  });
});

describe('module-hook: cached data across isolates', () => {
  it('a worker attached to the snapshot compiles with cached data V8 does not reject', async () => {
    const { Worker } = require('node:worker_threads');
    const { until, within } = require('./helpers.js');
    const root = writeTree(tmpDir('modhook-worker'), {
      'lib/m.js': 'module.exports = [1, 2, 3].map((x) => x * 2);',
    });
    const k = await kernel(root, {
      lib: { require: { ext: ['json'], compile: ['js', 'cjs'] } },
    });
    let worker = null;
    try {
      const { vfs, transferList } = k.link();
      const script = `
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
        require(${JSON.stringify(path.resolve(__dirname, '..'))}).attach();
        const result = require(${JSON.stringify(path.join(root, 'lib', 'm.js'))});
        parentPort.postMessage({ result, seen });
      `;
      worker = new Worker(script, {
        eval: true,
        workerData: { vfs },
        transferList,
      });
      const exited = new Promise((resolve) => worker.on('exit', resolve));
      let message = null;
      const errors = [];
      worker.on('message', (m) => (message = m));
      worker.on('error', (e) => errors.push(e));
      await until(() => message || errors.length);
      assert.deepEqual(errors, []);
      assert.deepEqual(message, { result: [2, 4, 6], seen: [false] });
      await within(exited, 'the exit of the worker');
    } finally {
      await worker?.terminate();
      k.close();
      rm(root);
    }
  });

  // Cached data one thread's V8 rejects is that thread's alone: the module
  // compiles from its source there, once, with nothing published again;
  // the file, its companion and the version stay, and another thread still
  // runs the cached data.
  it('cached data a worker rejects: the source runs there, once; the file and the version stay', async () => {
    const { Worker } = require('node:worker_threads');
    const { within } = require('./helpers.js');
    const root = writeTree(tmpDir('modhook-reject'), {
      'lib/m.js':
        'globalThis.__vfsRuns = (globalThis.__vfsRuns || 0) + 1;\n' +
        'module.exports = [1, 2, 3].map((x) => x * 2);',
    });
    const k = await kernel(root, { lib: { require: { compile: ['js'] } } });
    const run = async (damage) => {
      const { vfs, transferList } = k.link();
      const worker = new Worker(
        `
        const vm = require('node:vm');
        const { parentPort, workerData } = require('node:worker_threads');
        const { bytecodeKey } = require(${JSON.stringify(path.resolve(__dirname, '../lib/companion.js'))});
        const seen = [];
        const Real = vm.Script;
        vm.Script = class extends Real {
          constructor(code, options) {
            super(code, options);
            if (options?.cachedData) seen.push(this.cachedDataRejected);
          }
        };
        const kernel = require(${JSON.stringify(path.resolve(__dirname, '..'))}).attach();
        if (workerData.damage) {
          // This thread's own projection of the companion, nothing shared.
          const { files } = kernel.registry.get('lib');
          const key = bytecodeKey('/m.js');
          files.set(key, { ...files.get(key), data: Buffer.from('not cached data') });
        }
        const result = require(workerData.file);
        parentPort.postMessage({ result, seen, runs: globalThis.__vfsRuns });
        `,
        {
          eval: true,
          workerData: { vfs, damage, file: path.join(root, 'lib', 'm.js') },
          transferList,
        },
      );
      try {
        return await within(
          new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
          }),
          'the answer of the worker',
        );
      } finally {
        await worker.terminate();
      }
    };
    try {
      const place = k.registry.get('lib');
      const source = place.files.get('/m.js');
      const companion = place.files.get(bytecodeKey('/m.js'));
      const version = k.version;
      let published = 0;
      k.on('publish', () => published++);
      assert.deepEqual(await run(true), {
        result: [2, 4, 6],
        seen: [true],
        runs: 1,
      });
      assert.deepEqual(await run(false), {
        result: [2, 4, 6],
        seen: [false],
        runs: 1,
      });
      assert.equal(k.version, version);
      assert.equal(published, 0, 'nothing published again');
      assert.equal(place.files.get('/m.js'), source);
      assert.equal(place.files.get(bytecodeKey('/m.js')), companion);
    } finally {
      k.close();
      rm(root);
    }
  });
});

describe('module-hook: strict', () => {
  it('missing or unpublished modules in indexed mounts are MODULE_NOT_FOUND, never read from disk', async () => {
    const root = writeTree(tmpDir('modhook-strict'), {
      'lib/a.js': 'module.exports = "a";',
    });
    const k = await kernel(root, { lib: { require: true } }, { strict: true });
    let k2 = null;
    try {
      moduleHook.install(k);
      // Created after init: on disk, but not published (no watcher).
      fs.writeFileSync(
        path.join(root, 'lib', 'late.js'),
        'module.exports = "late";',
      );
      assert.equal(require(path.join(root, 'lib', 'a.js')), 'a');
      assert.throws(() => require(path.join(root, 'lib', 'late.js')), {
        code: 'MODULE_NOT_FOUND',
      });
      // require.resolve() refuses what require() refuses, on every Node
      // version, though Node's own resolver would find the file on disk.
      assert.equal(
        require.resolve(path.join(root, 'lib', 'a.js')),
        path.join(root, 'lib', 'a.js'),
      );
      assert.throws(() => require.resolve(path.join(root, 'lib', 'late.js')), {
        code: 'MODULE_NOT_FOUND',
      });
      assert.throws(() => require(path.join(root, 'lib', 'nope')), {
        code: 'MODULE_NOT_FOUND',
      });
      assert.throws(() => require(path.join(root, 'stray', 'x.js')), {
        code: 'MODULE_NOT_FOUND',
      });
      // `..private` is a name under appRoot, not a parent path: unmanaged.
      writeTree(root, {
        '..private/leak.js': 'module.exports = "leak";',
        '..private/leak.mjs': 'export default "leak";',
      });
      assert.throws(() => require(path.join(root, '..private', 'leak.js')), {
        code: 'MODULE_NOT_FOUND',
      });
      await assert.rejects(
        import(pathToFileURL(path.join(root, '..private', 'leak.mjs')).href),
        { code: 'ERR_MODULE_NOT_FOUND' },
      );
      moduleHook.uninstall();
      // Without strict the same late file loads from disk through Node.
      k2 = await kernel(root, { lib: { require: true } });
      moduleHook.install(k2);
      delete require.cache[path.join(root, 'lib', 'late.js')];
      assert.equal(require(path.join(root, 'lib', 'late.js')), 'late');
    } finally {
      moduleHook.uninstall();
      k.close();
      k2?.close();
      rm(root);
    }
  });
});

describe('module-hook: dot-prefixed directories inside a place', () => {
  it('belong to the place for require and import', async () => {
    const root = writeTree(tmpDir('modhook-dots'), {
      'lib/..private/cjs.js': 'module.exports = "inside";',
      'lib/..private/esm.mjs': 'export default "inside-esm";',
    });
    const k = await kernel(
      root,
      { lib: { require: { compile: ['js'] }, import: { ext: ['mjs'] } } },
      { strict: true },
    );
    moduleHook.install(k);
    try {
      assert.equal(
        require(path.join(root, 'lib', '..private', 'cjs.js')),
        'inside',
      );
      const mod = await import(
        pathToFileURL(path.join(root, 'lib', '..private', 'esm.mjs')).href
      );
      assert.equal(mod.default, 'inside-esm');
    } finally {
      moduleHook.uninstall();
      k.close();
      rm(root);
    }
  });
});

describe('module-hook: a specifier that names a directory', () => {
  // Memory modules: Node's own resolver finds none of them on disk, so
  // every answer below is the hook's.
  it('resolves as a directory only, as Node does, on every platform', async () => {
    const root = tmpDir('modhook-dirs');
    const k = await kernel(root, {
      mem: {
        provider: 'map',
        origin: 'virtual',
        fs: { writable: true },
        require: true,
        import: { ext: ['mjs'] },
      },
    });
    const mem = k.fs('mem');
    mem.writeFile('/pick.js', "module.exports = 'pick.js';");
    mem.writeFile('/pick/index.js', "module.exports = 'pick/index.js';");
    mem.writeFile(
      '/pick/probe.js',
      "module.exports = [require('.'), require('./'), require('../pick/')," +
        " require('../pick')];",
    );
    mem.writeFile('/x.js', "module.exports = 'x.js';");
    mem.writeFile('/x.mjs', "export default 'x.mjs';");
    mem.writeFile(
      '/probe.mjs',
      "export default await import('./x.mjs/').then(() => 'x.mjs', " +
        '(err) => err.code);',
    );
    const at = (...p) => path.join(root, 'mem', ...p);
    moduleHook.install(k);
    try {
      assert.equal(require(at('pick') + '/'), 'pick/index.js');
      assert.equal(require(at('pick')), 'pick.js');
      assert.deepEqual(require(at('pick', 'probe.js')), [
        'pick/index.js',
        'pick/index.js',
        'pick/index.js',
        'pick.js',
      ]);
      assert.throws(() => require(at('x.js') + '/'), {
        code: 'MODULE_NOT_FOUND',
      });
      const url = pathToFileURL(at('x.mjs')).href;
      await assert.rejects(import(url + '/'), { code: 'ERR_MODULE_NOT_FOUND' });
      const probe = await import(pathToFileURL(at('probe.mjs')).href);
      assert.equal(probe.default, 'ERR_MODULE_NOT_FOUND');
      assert.equal((await import(url)).default, 'x.mjs');
    } finally {
      moduleHook.uninstall();
      k.close();
      rm(root);
    }
  });
});

describe('module-hook: relative specifiers, as Node reads them', () => {
  // Memory modules again: only the hook can find them.
  it('require takes ..name and, on Windows, .\\name; import neither', async () => {
    const root = tmpDir('modhook-relative');
    const k = await kernel(root, {
      mem: {
        provider: 'map',
        origin: 'virtual',
        fs: { writable: true },
        require: true,
        import: { ext: ['mjs'] },
      },
    });
    const mem = k.fs('mem');
    mem.writeFile('/lib/x.js', "module.exports = 'x.js';");
    mem.writeFile('/lib/..private.js', "module.exports = '..private.js';");
    mem.writeFile('/lib/.hidden.js', "module.exports = '.hidden.js';");
    mem.writeFile('/lib/x.mjs', "export default 'x.mjs';");
    mem.writeFile('/lib/..private.mjs', "export default '..private.mjs';");
    mem.writeFile(
      '/lib/probe.js',
      'const t = (s) => { try { return require(s); } catch (err) ' +
        '{ return err.code; } };' +
        "module.exports = [t('.\\\\x.js'), t('..private'), t('.hidden')];",
    );
    mem.writeFile(
      '/lib/probe.mjs',
      'const t = async (s) => { try { return (await import(s)).default; } ' +
        'catch (err) { return err.code; } };' +
        "export default [await t('.\\\\x.mjs'), await t('..private.mjs')];",
    );
    const at = (...p) => path.join(root, 'mem', 'lib', ...p);
    moduleHook.install(k);
    try {
      const win = process.platform === 'win32';
      assert.deepEqual(require(at('probe.js')), [
        win ? 'x.js' : 'MODULE_NOT_FOUND',
        '..private.js',
        'MODULE_NOT_FOUND',
      ]);
      const esm = await import(pathToFileURL(at('probe.mjs')).href);
      assert.deepEqual(esm.default, [
        'ERR_INVALID_MODULE_SPECIFIER',
        'ERR_INVALID_MODULE_SPECIFIER',
      ]);
    } finally {
      moduleHook.uninstall();
      k.close();
      rm(root);
    }
  });
});

describe('module-hook: ESM', () => {
  let root;
  let k;
  const url = (...p) => pathToFileURL(path.join(root, ...p)).href;

  before(async () => {
    root = writeTree(tmpDir('modhook-esm'), {
      'esm/a.mjs':
        "import { b } from './b.js'; export const a = 'a' + b; export const url = import.meta.url; export { default as data } from './data.json' with { type: 'json' };",
      'esm/b.js': "import { c } from './sub/c.mjs'; export const b = 'b' + c;",
      'esm/sub/c.mjs':
        "export const c = 'c'; globalThis.__vfsEsmRuns = (globalThis.__vfsEsmRuns || 0) + 1;",
      'esm/data.json': '{"ok": true}',
      'esm/bad-attr.mjs':
        "import data from './data.json'; export default data;",
      'esm/weird name #1.mjs': 'export const w = 1;',
      'esm/cjs.cjs': 'module.exports = { fromCjs: true };',
      'esm/uses-cjs.mjs':
        "import cjs from './cjs.cjs'; export const ok = cjs.fromCjs;",
      'disk/d.mjs': 'export const d = 1;',
    });
    k = await kernel(root, {
      esm: { import: { ext: ['js', 'mjs', 'json', 'cjs'] } },
      disk: { provider: 'disk', import: true },
    });
    moduleHook.install(k);
  });

  after(() => {
    moduleHook.uninstall();
    k.close();
    rm(root);
  });

  it('imports a chain of SAB modules with plain file: URLs', async () => {
    const mod = await import(url('esm', 'a.mjs'));
    assert.equal(mod.a, 'abc');
    assert.equal(mod.url, url('esm', 'a.mjs'));
    assert.deepEqual(mod.data, { ok: true });
    assert.equal(globalThis.__vfsEsmRuns, 1);
    await import(url('esm', 'a.mjs'));
    await import(url('esm', 'sub', 'c.mjs'));
    assert.equal(globalThis.__vfsEsmRuns, 1, 'evaluated once per URL');
    delete globalThis.__vfsEsmRuns;
  });

  it('.js in the import domain is ESM; .cjs stays CommonJS', async () => {
    const mod = await import(url('esm', 'uses-cjs.mjs'));
    assert.equal(mod.ok, true);
  });

  it('json needs the import attribute', async () => {
    await assert.rejects(import(url('esm', 'bad-attr.mjs')), {
      code: 'ERR_IMPORT_ATTRIBUTE_MISSING',
    });
  });

  it('special characters in paths round-trip', async () => {
    const mod = await import(url('esm', 'weird name #1.mjs'));
    assert.equal(mod.w, 1);
  });

  it('missing modules and missing extensions are ERR_MODULE_NOT_FOUND', async () => {
    await assert.rejects(import(url('esm', 'nope.mjs')), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    await assert.rejects(import(url('esm', 'b')), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
  });

  it('disk places and bare specifiers go through Node', async () => {
    const mod = await import(url('disk', 'd.mjs'));
    assert.equal(mod.d, 1);
    const p = await import('node:path');
    assert.equal(p.sep, path.sep);
  });
});
