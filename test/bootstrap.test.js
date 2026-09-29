'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { tmpDir, rm } = require('./helpers.js');

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
