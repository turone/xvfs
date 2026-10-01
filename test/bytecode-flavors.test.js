'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const os = require('node:os');
const path = require('node:path');
const { bytecodeKey } = require('../lib/companion.js');
const {
  tmpDir,
  writeTree,
  rm,
  kernel,
  worker,
  leakedBytes,
  within,
} = require('./helpers.js');

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
  within(
    new Promise((resolve, reject) => {
      const worker = new Worker(code, { eval: true, workerData, transferList });
      worker.once('message', resolve);
      worker.once('error', reject);
    }),
    'the answer of the worker',
  );

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
            prepare: 'id',
            script: { compile: ['js', 'cjs'] },
          },
        },
      },
      {},
      { preparers: wrap },
    );
    try {
      await k.fs('v').writeFile('/h.js', '({ user }) => `hi ${user}`');
      const place = k.registry.get('v');
      assert.notEqual(place.bytecode('/h.js', 'script'), null);
      assert.equal(place.bytecode('/h.js', 'require'), null);
      assert.equal(place.files.has(bytecodeKey('/h.js', 'require')), false);
    } finally {
      k.close();
      rm(root);
    }
  });

  it('only require.compile is configured: only the require companion exists', async () => {
    const root = tmpDir('bc-require-only');
    const k = await kernel(root, {
      v: {
        origin: 'virtual',
        fs: { writable: true },
        require: true,
      },
    });
    try {
      await k.fs('v').writeFile('/h.js', 'module.exports = 1;');
      const place = k.registry.get('v');
      assert.equal(place.bytecode('/h.js', 'script'), null);
      assert.notEqual(place.bytecode('/h.js', 'require'), null);
      assert.equal(place.files.has(bytecodeKey('/h.js', 'script')), false);
    } finally {
      k.close();
      rm(root);
    }
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
            prepare: 'id',
            script: { compile: ['js', 'cjs'] },
          },
          require: true,
        },
      },
      {},
      { preparers: wrap },
    );
    try {
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
      const sourceKeys = [...place.files.keys()].filter(
        (key) => key === '/h.js',
      );
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
    } finally {
      k.close();
      rm(root);
    }
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

// `compile` lists the extensions that get a flavor, `ext` the ones that do
// not: a template extension gets both flavors as js and cjs do, prepared
// once; mjs is a script source without cached data; json gets none.
describe('bytecode flavors: compile lists', () => {
  const lists = {
    writable: true,
    ext: ['json'],
    prepare: { view: ['dhtml'] },
    script: { ext: ['mjs'], compile: ['js', 'cjs', 'dhtml'] },
  };
  const places = {
    v: {
      origin: 'virtual',
      fs: lists,
      require: { ext: ['json'], compile: ['js', 'cjs', 'dhtml'] },
    },
    m: {
      provider: 'map',
      origin: 'virtual',
      fs: lists,
      require: { ext: ['json'], compile: ['js', 'cjs', 'dhtml'] },
    },
  };
  const FILES = {
    '/a.js': 'module.exports = 1;',
    '/b.cjs': 'module.exports = 2;',
    '/view.dhtml': '<p>{{name}}</p>',
    '/m.mjs': 'export default 3;',
    '/d.json': '{"x": 1}',
  };

  it('js, cjs and dhtml get both flavors, mjs a bundle without cached data, json none', async () => {
    const root = tmpDir('bc-lists');
    const prepared = [];
    const view = (raw, file) => {
      prepared.push(`${file.place}:${file.key}`);
      const html = JSON.stringify(raw.toString());
      return `module.exports = (data) => ${html}.replace('{{name}}', data.name);`;
    };
    const k = await kernel(root, places, {}, { preparers: { view } });
    try {
      for (const name of ['v', 'm']) {
        const files = k.fs(name);
        await files.writeFiles(FILES);
        assert.deepEqual(prepared, [`${name}:/view.dhtml`], 'prepared once');
        prepared.length = 0;
        const place = k.registry.get(name);
        const companions = [...place.files.keys()].filter((key) =>
          key.includes('\0'),
        );
        const compiled = ['/a.js', '/b.cjs', '/view.dhtml'];
        assert.deepEqual(
          companions.sort(),
          compiled
            .flatMap((key) => [
              bytecodeKey(key, 'require'),
              bytecodeKey(key, 'script'),
            ])
            .sort(),
        );
        for (const key of compiled) {
          assert.ok(files.script(key).cachedData, `${name} ${key}`);
        }
        const mjs = files.script('/m.mjs');
        assert.equal(mjs.source, FILES['/m.mjs']);
        assert.equal(mjs.cachedData, null);
        assert.equal(files.script('/d.json'), null, 'json is no script');
        assert.equal(files.readFile('/d.json', 'utf8'), FILES['/d.json']);
      }
    } finally {
      k.close();
      rm(root);
    }
  });
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
            prepare: 'id',
            script: { compile: ['js', 'cjs'] },
          },
          require: true,
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
    try {
      await k.fs('v').writeFile('/h.js', 'anything');
      const place = k.registry.get('v');
      assert.notEqual(place.bytecode('/h.js', 'script'), null);
      assert.equal(place.bytecode('/h.js', 'require'), null);
      assert.equal(k.fs('v').readFile('/h.js', 'utf8'), 'let exports = 1;');
    } finally {
      k.close();
      rm(root);
    }
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
            prepare: 'id',
            script: { compile: ['js', 'cjs'] },
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
      const v = k.fs('v');
      await v.writeFile('/h.js', '({ user }) => `hi ${user}`');
      broken = true;
      await assert.rejects(v.writeFile('/h.js', 'x => x'));
      // The bytes in allocations, which the count of segments would hide.
      assert.equal(
        leakedBytes(k),
        0,
        'no leaked allocation from the failed attempt',
      );
      assert.equal(
        v.readFile('/h.js', 'utf8'),
        '(({ user }) => `hi ${user}`)',
        'previous version still served',
      );
      // The queue recovers: a following good write succeeds.
      broken = false;
      await v.writeFile('/h.js', 'x => x * 2');
      assert.equal(v.readFile('/h.js', 'utf8'), '(x => x * 2)');
    } finally {
      k.close();
      rm(root);
    }
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
      prepare: 'id',
      script: { compile: ['js'] },
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
      assert.equal(leakedBytes(k), 0, 'nothing allocated');
    } finally {
      w.kernel.close();
      k.close();
      rm(root);
    }
  });

  // A script flavor that finds no room in the pool refuses the whole
  // publication, as one that does not compile does — never published
  // without it — as a full disk refuses it: ENOSPC, named by the operation
  // (a write's `open` of the source, a rename's call and ends), whichever
  // thread asked. What the attempt placed before it, the source and the
  // require flavor, goes back to the pool. The pool is found full by the
  // third allocation of the attempt, the script flavor's.
  it('fs.script.compile flavor that does not fit: refused, and what was placed is freed', async () => {
    const root = tmpDir('bc-script-full');
    const k = await kernel(root, {
      v: {
        origin: 'virtual',
        fs: {
          writable: true,
          ext: ['txt'],
          script: { compile: ['js'] },
        },
        require: true,
      },
    });
    const w = worker(k);
    try {
      const v = k.fs('v');
      await v.writeFile('/h.js', 'module.exports = 1;');
      await v.writeFile('/r.txt', 'module.exports = 2;');
      const { files } = k.registry.get('v');
      const version = () =>
        [
          '/h.js',
          bytecodeKey('/h.js'),
          bytecodeKey('/h.js', 'script'),
          '/r.txt',
        ].map((key) => files.get(key));
      const before = version();
      assert.ok(before.every(Boolean), 'the sources and both flavors');
      const { cache } = k;
      const { allocate } = cache;
      const allocated = [];
      cache.allocate = async function (file, options) {
        allocated.push(file.data.length);
        if (allocated.length === 3) return null;
        return allocate.call(this, file, options);
      };
      const updates = k.nextUpdateId;
      const at = (key) => path.join(root, 'v', key);
      const reason = 'fs.script.compile: source does not fit in SAB';
      for (const [label, place] of [
        ['main', v],
        ['worker', w.kernel.fs('v')],
      ]) {
        for (const [op, syscall, from, to] of [
          [
            () => place.writeFile('/h.js', 'module.exports = 3;'),
            'open',
            '/h.js',
          ],
          [() => place.rename('/r.txt', '/r.js'), 'rename', '/r.txt', '/r.js'],
        ]) {
          allocated.length = 0;
          const ends = to ? `'${at(from)}' -> '${at(to)}'` : `'${at(from)}'`;
          await assert.rejects(op(), (err) => {
            assert.deepEqual(
              shape(err),
              {
                code: 'ENOSPC',
                errno: -os.constants.errno.ENOSPC,
                syscall,
                path: at(from),
                dest: to && at(to),
                message:
                  `ENOSPC: no space left on device (${reason}), ` +
                  `${syscall} ${ends}`,
              },
              `${label}: ${syscall}`,
            );
            return true;
          });
          assert.equal(allocated.length, 3, 'the source, then both flavors');
        }
      }
      assert.deepEqual(version(), before, 'the published version stays');
      assert.equal(files.has('/r.js'), false, 'nothing moved');
      assert.equal(k.nextUpdateId, updates, 'nothing published');
      assert.equal(leakedBytes(k), 0, 'the source and require flavor freed');
    } finally {
      w.kernel.close();
      k.close();
      rm(root);
    }
  });

  // Distinct from the case above (a mocked, transient "pool is full"): a
  // companion that is larger than one segment can never fit, whatever the
  // pool's state — EFBIG, not ENOSPC. A segment of 64 bytes forces this
  // for any real script: even the smallest source's V8 cached data is a
  // few hundred bytes (fixed format overhead), no oversized source needed.
  // The canonical source itself (well under 64 bytes) always fits, so its
  // allocation never explains the refusal.
  it('fs.script.compile flavor larger than one segment is EFBIG, not ENOSPC', async () => {
    const root = tmpDir('bc-script-toobig');
    const k = await kernel(
      root,
      {
        v: {
          origin: 'virtual',
          fs: {
            writable: true,
            ext: ['txt'],
            script: { compile: ['js'] },
          },
        },
      },
      { memory: { limit: '8 kib', segmentSize: 64, maxFileSize: 64 } },
    );
    const w = worker(k);
    try {
      const v = k.fs('v');
      await v.writeFile('/r.txt', 'module.exports = 2;');
      const updates = k.nextUpdateId;
      const at = (key) => path.join(root, 'v', key);
      const reason = 'fs.script.compile: source does not fit in SAB';
      const refusal = (syscall, from, to) => {
        const ends = to ? `'${at(from)}' -> '${at(to)}'` : `'${at(from)}'`;
        return {
          code: 'EFBIG',
          errno: -os.constants.errno.EFBIG,
          syscall,
          path: at(from),
          dest: to && at(to),
          message: `EFBIG: file too large (${reason}), ${syscall} ${ends}`,
        };
      };
      for (const [label, place] of [
        ['main', v],
        ['worker', w.kernel.fs('v')],
      ]) {
        await assert.rejects(
          place.writeFile('/h.js', 'module.exports = 1;'),
          (err) => {
            assert.deepEqual(shape(err), refusal('open', '/h.js'), label);
            return true;
          },
        );
        assert.equal(v.exists('/h.js'), false, `${label}: write not published`);
        await assert.rejects(place.rename('/r.txt', '/r.js'), (err) => {
          assert.deepEqual(
            shape(err),
            refusal('rename', '/r.txt', '/r.js'),
            label,
          );
          return true;
        });
        assert.equal(
          v.exists('/r.js'),
          false,
          `${label}: rename not published`,
        );
        assert.equal(
          v.readFile('/r.txt', 'utf8'),
          'module.exports = 2;',
          `${label}: source stays`,
        );
      }
      assert.equal(k.nextUpdateId, updates, 'nothing published');
      assert.equal(leakedBytes(k), 0, 'the source freed');
    } finally {
      w.kernel.close();
      k.close();
      rm(root);
    }
  });

  // A rename onto an extension whose script flavor does not compile is
  // refused as the rename: its call, its source and its destination, like
  // every other refusal of a rename — and nothing changes.
  it('fs.script.compile failure of a rename: the rename refuses, in sab, map and a worker', async () => {
    const root = tmpDir('bc-script-rename');
    const scripts = {
      writable: true,
      ext: ['txt'],
      script: { compile: ['js'] },
    };
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: scripts },
      m: { provider: 'map', origin: 'virtual', fs: scripts },
    });
    const w = worker(k);
    try {
      const broken = '{ not valid js (((';
      await k.fs('v').writeFile('/a.txt', broken);
      k.fs('m').writeFile('/a.txt', broken);
      const updates = k.nextUpdateId;
      const retires = k.nextRetireId;
      for (const [label, name, place] of [
        ['sab', 'v', k.fs('v')],
        ['map', 'm', k.fs('m')],
        ['worker', 'v', w.kernel.fs('v')],
      ]) {
        const { files } = k.registry.get(name);
        const version = files.get('/a.txt');
        let err = null;
        try {
          await place.rename('/a.txt', '/a.js');
        } catch (error) {
          err = error;
        }
        const from = path.join(root, name, 'a.txt');
        const to = path.join(root, name, 'a.js');
        const reason = 'fs.script.compile: source does not compile';
        assert.deepEqual(
          shape(err ?? {}),
          {
            code: 'ENOTSUP',
            errno: -os.constants.errno.ENOTSUP,
            syscall: 'rename',
            path: from,
            dest: to,
            message:
              `ENOTSUP: operation not supported (${reason}), ` +
              `rename '${from}' -> '${to}'`,
          },
          label,
        );
        assert.equal(files.get('/a.txt'), version, `${label}: the source`);
        assert.equal(files.has('/a.js'), false, `${label}: no destination`);
      }
      assert.equal(w.kernel.fs('v').exists('/a.js'), false, 'worker');
      assert.equal(k.nextUpdateId, updates, 'nothing published');
      assert.equal(k.nextRetireId, retires, 'nothing retired');
      assert.equal(leakedBytes(k), 0, 'nothing allocated');
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
        app: { fs: { script: true } },
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
            prepare: 'id',
            script: { compile: ['js'] },
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
