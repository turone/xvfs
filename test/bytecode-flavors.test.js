'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const os = require('node:os');
const path = require('node:path');
const { bytecodeKey } = require('../lib/companion.js');
const { tmpDir, writeTree, rm, kernel, worker } = require('./helpers.js');

// Bytecode flavors: fs.script.compile (bare vm.Script, PlaceFs.script()) and
// require.compile (Module.wrap flavor, consumed by the _compile hook) are
// two independent companions of the same canonical source
// (doc/architecture.md, "Preparation").

const wrap = {
  id: (raw, file) => ({
    source: `(${raw.toString().trim()})`,
    scriptOptions: { filename: file.path },
  }),
};

const runInWorker = (code, workerData, transferList) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true, workerData, transferList });
    worker.once('message', resolve);
    worker.once('error', reject);
  });

describe('bytecode flavors: coexistence', () => {
  it('only fs.script.compile is configured: only the script companion exists', async () => {
    const root = tmpDir('bc-script-only');
    const k = await kernel(
      root,
      {
        v: {
          origin: 'virtual',
          fs: {
            writable: true,
            ext: ['js', 'cjs'],
            prepare: 'id',
            script: { compile: true },
          },
        },
      },
      {},
      { preparers: wrap },
    );
    await k.fs('v').writeFile('/h.js', '({ user }) => `hi ${user}`');
    const place = k.registry.get('v');
    assert.notEqual(place.bytecode('/h.js', 'script'), null);
    assert.equal(place.bytecode('/h.js', 'require'), null);
    assert.equal(place.files.has(bytecodeKey('/h.js', 'require')), false);
    k.close();
    rm(root);
  });

  it('only require.compile is configured: only the require companion exists', async () => {
    const root = tmpDir('bc-require-only');
    const k = await kernel(root, {
      v: {
        origin: 'virtual',
        fs: { writable: true },
        require: { compile: true },
      },
    });
    await k.fs('v').writeFile('/h.js', 'module.exports = 1;');
    const place = k.registry.get('v');
    assert.equal(place.bytecode('/h.js', 'script'), null);
    assert.notEqual(place.bytecode('/h.js', 'require'), null);
    assert.equal(place.files.has(bytecodeKey('/h.js', 'script')), false);
    k.close();
    rm(root);
  });

  it('both flags on one prepared source: two distinct companions, one canonical entry', async () => {
    const root = tmpDir('bc-both');
    const k = await kernel(
      root,
      {
        v: {
          origin: 'virtual',
          fs: {
            writable: true,
            ext: ['js', 'cjs'],
            prepare: 'id',
            script: { compile: true },
          },
          require: { compile: true },
        },
      },
      {},
      { preparers: wrap },
    );
    await k.fs('v').writeFile('/h.js', '({ user }) => `hi ${user}`');
    const place = k.registry.get('v');
    const scriptCode = place.bytecode('/h.js', 'script');
    const requireCode = place.bytecode('/h.js', 'require');
    assert.notEqual(scriptCode, null);
    assert.notEqual(requireCode, null);
    assert.equal(
      Buffer.from(scriptCode).equals(Buffer.from(requireCode)),
      false,
      'script and require bytecode are different bytes',
    );
    const sourceKeys = [...place.files.keys()].filter((key) => key === '/h.js');
    assert.equal(sourceKeys.length, 1, 'canonical source stored once');

    // Both cached data are accepted by their own consumer in another isolate.
    const bundle = k.fs('v').script('/h.js');
    const scriptResult = await runInWorker(
      `
      const vm = require('node:vm');
      const { parentPort, workerData } = require('node:worker_threads');
      const s = new vm.Script(workerData.source, { ...workerData.scriptOptions, cachedData: workerData.cachedData });
      parentPort.postMessage({ rejected: s.cachedDataRejected, result: s.runInThisContext()({ user: 'ann' }) });
      `,
      {
        source: bundle.source,
        scriptOptions: bundle.scriptOptions,
        cachedData: bundle.cachedData,
      },
    );
    assert.equal(scriptResult.rejected, false);
    assert.equal(scriptResult.result, 'hi ann');

    const { vfs, transferList } = k.link();
    const requireResult = await runInWorker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const { attach } = require(${JSON.stringify(path.resolve(__dirname, '../index.js'))});
      const kern = attach();
      const Module = require('node:module');
      const vm = require('node:vm');
      const filePath = kern.fs('v').pathOf('/h.js');
      const src = kern.fs('v').readFile('/h.js', 'utf8');
      const s = new vm.Script(Module.wrap(src), { filename: filePath, cachedData: kern.bytecode(filePath) });
      parentPort.postMessage({ rejected: s.cachedDataRejected });
      `,
      { vfs },
      transferList,
    );
    assert.equal(
      requireResult.rejected,
      false,
      'cachedDataRejected === false for the require flavor',
    );

    k.close();
    rm(root);
  });

  // No cross-feed assertion on purpose. In a clean isolate V8 *does* reject
  // cached data built from a differently wrapped source — but only because
  // the wrapper changes the source length, which is the heuristic
  // test/script.test.js ("V8 cached data facts") pins down: acceptance is
  // not a content check, and it is masked entirely once the same isolate has
  // already compiled the source. Such a test would therefore assert V8's
  // behaviour, not the library's. The real guard is structural: the flavors
  // are separate companions (`\0script:bytecode` / `\0require:bytecode`) and
  // `PlaceFs.script()` / the `_compile` hook each read only their own,
  // proven above ("only … exists", "both flags").
});

describe('bytecode flavors: failure and rollback', () => {
  it('require.compile failure leaves a valid fs.script bundle published', async () => {
    const root = tmpDir('bc-require-fail');
    const k = await kernel(
      root,
      {
        v: {
          origin: 'virtual',
          fs: {
            writable: true,
            ext: ['js', 'cjs'],
            prepare: 'id',
            script: { compile: true },
          },
          require: { compile: true },
        },
      },
      {},
      {
        preparers: {
          // `let exports` redeclares the CommonJS wrapper's own `exports`
          // parameter (Module.wrap embeds the source in a function whose
          // first parameter is `exports`) — a SyntaxError only once wrapped.
          // As a bare vm.Script (fs.script, no wrapper) it compiles fine.
          id: () => 'let exports = 1;',
        },
      },
    );
    await k.fs('v').writeFile('/h.js', 'anything');
    const place = k.registry.get('v');
    assert.notEqual(place.bytecode('/h.js', 'script'), null);
    assert.equal(place.bytecode('/h.js', 'require'), null);
    assert.equal(k.fs('v').readFile('/h.js', 'utf8'), 'let exports = 1;');
    k.close();
    rm(root);
  });

  it('fs.script.compile failure rejects the whole publication and keeps the previous version', async () => {
    const root = tmpDir('bc-script-fail');
    let broken = false;
    const k = await kernel(
      root,
      {
        v: {
          origin: 'virtual',
          fs: {
            writable: true,
            ext: ['js', 'cjs'],
            prepare: 'id',
            script: { compile: true },
          },
        },
      },
      {},
      {
        preparers: {
          id: (raw) =>
            broken ? '{ not valid js (((' : `(${raw.toString().trim()})`,
        },
      },
    );
    const v = k.fs('v');
    await v.writeFile('/h.js', '({ user }) => `hi ${user}`');
    const before = k.cache.stats().totalUsed;
    broken = true;
    await assert.rejects(v.writeFile('/h.js', 'x => x'));
    const after = k.cache.stats().totalUsed;
    assert.equal(after, before, 'no leaked allocation from the failed attempt');
    assert.equal(
      v.readFile('/h.js', 'utf8'),
      '(({ user }) => `hi ${user}`)',
      'previous version still served',
    );
    // The queue recovers: a following good write succeeds.
    broken = false;
    await v.writeFile('/h.js', 'x => x * 2');
    assert.equal(v.readFile('/h.js', 'utf8'), '(x => x * 2)');
    k.close();
    rm(root);
  });

  // The fields of a refusal, and its message.
  const shape = (err) => ({
    code: err.code,
    errno: err.errno,
    syscall: err.syscall,
    path: err.path,
    dest: err.dest,
    message: err.message,
  });

  // One error, whichever sink publishes the source it names.
  const doesNotCompile = (file) => ({
    code: 'ENOTSUP',
    errno: -os.constants.errno.ENOTSUP,
    syscall: 'open',
    path: file,
    dest: undefined,
    message:
      'ENOTSUP: operation not supported ' +
      `(fs.script.compile: source does not compile), open '${file}'`,
  });

  it('fs.script.compile failure: one ENOTSUP in sab, map and a worker', async () => {
    const root = tmpDir('bc-script-error');
    let broken = false;
    const scripts = {
      writable: true,
      ext: ['js'],
      prepare: 'id',
      script: { compile: true },
    };
    const k = await kernel(
      root,
      {
        v: { origin: 'virtual', fs: scripts },
        m: { provider: 'map', origin: 'virtual', fs: scripts },
      },
      {},
      {
        preparers: {
          id: (raw) =>
            broken ? '{ not valid js (((' : `(${raw.toString().trim()})`,
        },
      },
    );
    // What a reader of the place gets: the source and its cached data.
    const bundle = (place) => {
      const { source, cachedData } = place.script('/h.js');
      return { source, cachedData: Buffer.from(cachedData) };
    };
    // The published version: the entries of the source and its companion.
    const version = (name) => {
      const { files } = k.registry.get(name);
      return [files.get('/h.js'), files.get(bytecodeKey('/h.js', 'script'))];
    };
    await k.fs('v').writeFile('/h.js', 'x => x');
    k.fs('m').writeFile('/h.js', 'x => x');
    const w = worker(k);
    try {
      const before = { v: bundle(k.fs('v')), m: bundle(k.fs('m')) };
      const versions = { v: version('v'), m: version('m') };
      const updates = k.nextUpdateId;
      const retires = k.nextRetireId;
      const used = k.cache.stats().totalUsed;
      broken = true;
      for (const [label, name, place] of [
        ['sab', 'v', k.fs('v')],
        ['map', 'm', k.fs('m')],
        ['worker', 'v', w.kernel.fs('v')],
      ]) {
        let err = null;
        try {
          await place.writeFile('/h.js', 'y => y');
        } catch (error) {
          err = error;
        }
        const file = path.join(root, name, 'h.js');
        assert.deepEqual(shape(err ?? {}), doesNotCompile(file), label);
        assert.deepEqual(bundle(k.fs(name)), before[name], label);
        const [source, companion] = version(name);
        assert.equal(source, versions[name][0], `${label}: the same version`);
        assert.equal(companion, versions[name][1], `${label}: its companion`);
      }
      assert.deepEqual(bundle(w.kernel.fs('v')), before.v, 'worker projection');
      assert.equal(k.nextUpdateId, updates, 'nothing published');
      assert.equal(k.nextRetireId, retires, 'nothing retired');
      assert.equal(k.cache.stats().totalUsed, used, 'nothing allocated');
    } finally {
      w.kernel.close();
      k.close();
      rm(root);
    }
  });

  it('fs.script.compile failure of a disk source: initialize() fails with it', async () => {
    const root = writeTree(tmpDir('bc-script-init'), {
      'app/ok.js': 'x => x',
      'app/bad.js': '{ not valid js (((',
    });
    try {
      const init = kernel(root, {
        app: { fs: { ext: ['js'], script: { compile: true } } },
      });
      await assert.rejects(init, (err) => {
        const file = path.join(root, 'app', 'bad.js');
        assert.deepEqual(shape(err), doesNotCompile(file));
        return true;
      });
    } finally {
      rm(root);
    }
  });

  it('map: a fs.script.compile failure keeps the previous version too', async () => {
    const root = tmpDir('bc-script-fail-map');
    let broken = false;
    const k = await kernel(
      root,
      {
        m: {
          provider: 'map',
          origin: 'virtual',
          fs: {
            writable: true,
            ext: ['js'],
            prepare: 'id',
            script: { compile: true },
          },
        },
      },
      {},
      {
        preparers: {
          id: (raw) =>
            broken ? '{ not valid js (((' : `(${raw.toString().trim()})`,
        },
      },
    );
    try {
      const m = k.fs('m');
      m.writeFile('/h.js', 'x => x');
      const before = m.script('/h.js');
      broken = true;
      assert.throws(() => m.writeFile('/h.js', 'y => y'));
      assert.equal(m.readFile('/h.js', 'utf8'), '(x => x)', 'previous version');
      assert.deepEqual(m.script('/h.js').cachedData, before.cachedData);
      broken = false;
      m.writeFile('/h.js', 'x => x * 2');
      assert.equal(m.readFile('/h.js', 'utf8'), '(x => x * 2)');
    } finally {
      k.close();
      rm(root);
    }
  });
});
