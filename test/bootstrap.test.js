'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { tmpDir, writeTree, rm } = require('./helpers.js');

// The bootstrap installs process-wide hooks, so it runs in child processes.

const REPO = path.resolve(__dirname, '..');
const FIXTURES = path.join(REPO, 'test', 'fixtures');
const REGISTER = pathToFileURL(
  path.join(REPO, 'lib', 'bootstrap', 'register.mjs'),
).href;

const runIn = (cwd, entry, ...vfsArgs) => {
  const r = spawnSync(
    process.execPath,
    ['--import', REGISTER, entry, '--', ...vfsArgs],
    { cwd, encoding: 'utf8', timeout: 30000 },
  );
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
};

const run = (entry, ...vfsArgs) => runIn(FIXTURES, entry, ...vfsArgs);

describe('bootstrap: --import xvfs/register', () => {
  it('ESM entry: kernel ready before entry, static imports served from VFS, worker attaches', () => {
    const r = run('app.mjs', '--vfs.config=vfs.config.cjs');
    assert.equal(r.code, 0, r.stderr);
    assert.match(
      r.stdout,
      /OK esm read=hello-from-bootstrap-fixture facade=hello-from-bootstrap-fixture greet=hello vfs cjs=42 worker=hello-from-bootstrap-fixture/,
    );
    assert.equal(r.stderr, '');
  });

  it('CommonJS entry: require() served from VFS, memory modules requirable', () => {
    const r = run('app.cjs', '--vfs.config=vfs.config.cjs');
    assert.equal(r.code, 0, r.stderr);
    assert.match(
      r.stdout,
      /OK cjs read=hello-from-bootstrap-fixture cjs=42 generated=generated nested=nested-memory/,
    );
  });

  it('CLI overrides reach the config', () => {
    const r = run(
      'app.cjs',
      '--vfs.config=vfs.config.cjs',
      '--vfs.defaults.watchTimeout=25',
    );
    assert.equal(r.code, 0, r.stderr);
  });

  // One config three ways — a JS file, a JSON file, the CLI alone — is one
  // resolved config, and the place serves alike: a template a module
  // requires by its full name, through its cached data; json without; no
  // extension added to a name without one.
  it('a JS file, a JSON file and the CLI alone give one config', () => {
    const raw = {
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
    const flags = [
      '--vfs.places.views.fs.ext=json',
      '--vfs.places.views.fs.script.ext=mjs',
      '--vfs.places.views.fs.script.compile=js,cjs,dhtml',
      '--vfs.places.views.require.ext=json',
      '--vfs.places.views.require.compile=js,cjs,dhtml',
    ];
    const index = JSON.stringify(path.join(REPO, 'index.js'));
    const dir = writeTree(tmpDir('xvfs-bootstrap-lists'), {
      'views/main.js': [
        "exports.view = require('./view.dhtml');",
        "exports.resolved = require.resolve('./view.dhtml');",
        "exports.data = require('./data.json');",
        "try { require('./view'); } catch (err) { exports.bare = err.code; }",
      ].join('\n'),
      'views/view.dhtml':
        "module.exports = (data) => '<p>' + data.name + '</p>';",
      'views/data.json': '{"name": "ann"}',
      'views/m.mjs': 'export default 1;',
      'configs/vfs.config.cjs': `module.exports = ${JSON.stringify(raw)};`,
      'configs/vfs.config.json': JSON.stringify(raw),
      'entry.cjs': [
        "const path = require('node:path');",
        `const { kernel } = require(${index});`,
        "const main = require('./views/main.js');",
        "const at = (key) => Boolean(kernel.bytecode(path.resolve('views', key)));",
        'console.log(JSON.stringify({',
        '  raw: kernel.config.raw,',
        '  global: kernel.config.global,',
        '  places: kernel.config.allPlaces,',
        "  view: main.view({ name: 'ann' }),",
        '  resolved: path.relative(process.cwd(), main.resolved),',
        '  data: main.data,',
        '  bare: main.bare,',
        "  bytecode: ['main.js', 'view.dhtml', 'data.json'].map(at),",
        "  mjs: kernel.fs('views').script('/m.mjs').cachedData == null,",
        '}));',
      ].join('\n'),
    });
    try {
      const outputs = [
        runIn(dir, 'entry.cjs', '--vfs.config=configs/vfs.config.cjs'),
        runIn(dir, 'entry.cjs', '--vfs.config=configs/vfs.config.json'),
        runIn(dir, 'entry.cjs', ...flags),
      ].map((r) => {
        assert.equal(r.code, 0, r.stderr);
        return JSON.parse(r.stdout);
      });
      const [js, json, cli] = outputs;
      assert.deepEqual(json, js);
      assert.deepEqual(cli, js);
      assert.deepEqual(js.raw, raw);
      assert.deepEqual(js.places[0].require, {
        ext: ['js', 'cjs', 'dhtml', 'json'],
        compile: ['js', 'cjs', 'dhtml'],
      });
      assert.equal(js.view, '<p>ann</p>');
      assert.equal(js.resolved, path.join('views', 'view.dhtml'));
      assert.deepEqual(js.data, { name: 'ann' });
      assert.equal(js.bare, 'MODULE_NOT_FOUND');
      assert.deepEqual(js.bytecode, [true, true, false]);
      assert.equal(js.mjs, true);
    } finally {
      rm(dir);
    }
  });

  // With strict: true appRoot is the routing boundary, so the entry point and
  // its package metadata live outside it — here the strict root
  // (fixtures/sandbox) holds only place directories and the entry is one
  // level up.
  it('strict: entry point outside appRoot runs; unmanaged paths are denied', () => {
    const r = runIn(
      path.join(FIXTURES, 'sandbox'),
      path.join(FIXTURES, 'strict-app.cjs'),
      `--vfs.config=${path.join(FIXTURES, 'vfs.strict.cjs')}`,
    );
    assert.equal(r.code, 0, r.stderr);
    assert.match(
      r.stdout,
      /OK strict read=hello-from-strict-sandbox denied=EACCES,EACCES,EACCES/,
    );
  });

  // A preload before the bootstrap binds the named exports of node:fs
  // before the patch is installed: install() makes them follow it.
  it('strict: a named import of node:fs bound before the bootstrap is routed', () => {
    const pre = pathToFileURL(path.join(FIXTURES, 'esm-pre.mjs')).href;
    const r = spawnSync(
      process.execPath,
      [
        '--import',
        pre,
        '--import',
        REGISTER,
        path.join(FIXTURES, 'esm-named.mjs'),
        '--',
        `--vfs.config=${path.join(FIXTURES, 'vfs.strict.cjs')}`,
      ],
      {
        cwd: path.join(FIXTURES, 'sandbox'),
        encoding: 'utf8',
        timeout: 30000,
      },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      named: 'EACCES',
      default: 'EACCES',
      promises: 'EACCES',
      patched: true,
    });
  });

  it('a missing config file aborts startup before the entry runs', () => {
    const r = run('app.cjs', '--vfs.config=no-such.cjs');
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /failed to load config/);
    assert.doesNotMatch(r.stdout, /OK/);
  });

  it('an invalid config aborts startup before the entry runs', () => {
    const r = run('app.cjs', '--vfs.config=vfs.bad.cjs');
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /\[vfs config\]/);
    assert.doesNotMatch(r.stdout, /OK/);
  });

  // Editors and Windows tools commonly save vfs.config.json with a leading
  // UTF-8 BOM (U+FEFF); JSON.parse treats it as invalid input, not
  // whitespace, so it must be stripped before parsing.
  it('a BOM at the start of vfs.config.json does not break loading', () => {
    const dir = tmpDir('smfs-sonnet-P3-bootstrap-bom');
    try {
      fs.writeFileSync(
        path.join(dir, 'vfs.config.json'),
        '﻿' + JSON.stringify({ defaults: { strict: false } }),
      );
      fs.writeFileSync(path.join(dir, 'entry.cjs'), "console.log('OK bom');");
      const r = runIn(
        dir,
        path.join(dir, 'entry.cjs'),
        `--vfs.config=${path.join(dir, 'vfs.config.json')}`,
      );
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /OK bom/);
      assert.doesNotMatch(r.stderr, /failed to load config/);
    } finally {
      rm(dir);
    }
  });

  it('attach() outside a worker explains itself', () => {
    const r = spawnSync(
      process.execPath,
      ['-e', "require('./index.js').attach()"],
      { cwd: REPO, encoding: 'utf8' },
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /attach\(\) is for worker threads/);
  });
});
