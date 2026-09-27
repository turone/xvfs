'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The exports the type declarations promise exist at runtime: every value
// a declaration file exports — `class`, `function`, `const` — is an export
// of the module it describes, for require() and for import, and every
// declaration file ships in the package. One exception, documented in the
// README: `kernel` is a getter of the CommonJS entry, which the ES module
// loader does not see as a named export; it is `kernel` of the default
// import there. The package is reached by its own name: `exports` resolves
// it, as it does for a consumer.

const ROOT = path.resolve(__dirname, '..');
const NAME = 'shared-memory-fs';
const { exports: subpaths, types } = require('../package.json');

// Values a declaration file exports; `export * from` follows the
// declarations of the module re-exported.
const declaredValues = (file, values = new Set(), seen = new Set()) => {
  if (seen.has(file)) return values;
  seen.add(file);
  const text = fs.readFileSync(file, 'utf8');
  for (const [, name] of text.matchAll(
    /^export (?:declare )?(?:class|function|const) ([\w$]+)/gm,
  )) {
    values.add(name);
  }
  for (const [, from] of text.matchAll(/^export \* from '(.+)';$/gm)) {
    const declaration = from
      .replace(/\.js$/, '.d.ts')
      .replace(/\.mjs$/, '.d.mts');
    declaredValues(path.resolve(path.dirname(file), declaration), values, seen);
  }
  return values;
};

// The declaration file of a package subpath, absolute.
const declarationOf = (subpath) => path.join(ROOT, subpaths[subpath].types);

const missing = (declared, actual) =>
  [...declared].filter((name) => !actual.includes(name));

describe('package exports', () => {
  it('index: every declared value is a require() export; kernel', () => {
    const declared = declaredValues(declarationOf('.'));
    assert.ok(declared.has('VfsKernel') && declared.has('kernel'));
    const mod = require(NAME);
    assert.deepEqual(missing(declared, Object.keys(mod)), []);
    const kernel = Object.getOwnPropertyDescriptor(mod, 'kernel');
    assert.equal(typeof kernel.get, 'function', 'a getter, live');
    assert.equal(mod.kernel, mod.VfsKernel.current);
  });

  it('index: an ES module gets every value; kernel on default', async () => {
    const declared = declaredValues(declarationOf('.'));
    declared.delete('kernel');
    const ns = await import(NAME);
    assert.deepEqual(missing(declared, Object.keys(ns)), []);
    // Node's CommonJS lexer does not see a getter in the exports literal:
    // the README sends ES modules to `VfsKernel.current` or the default
    // import. Should a Node release start to see it, the note is stale.
    assert.equal('kernel' in ns, false, 'README: no named ESM export');
    assert.equal(ns.default.kernel, ns.VfsKernel.current);
  });

  it('subpaths: adapters export what they declare; register', async () => {
    for (const subpath of ['./adapters/fs-patch', './adapters/module-hook']) {
      const declared = declaredValues(declarationOf(subpath));
      assert.deepEqual([...declared].sort(), ['install', 'uninstall']);
      const specifier = NAME + subpath.slice(1);
      assert.deepEqual(missing(declared, Object.keys(require(specifier))), []);
      const ns = await import(specifier);
      assert.deepEqual(missing(declared, Object.keys(ns)), []);
    }
    // A side effect only: never imported here, it bootstraps a kernel.
    assert.deepEqual([...declaredValues(declarationOf('./register'))], []);
    const register = require.resolve(NAME + '/register');
    assert.equal(register, path.join(ROOT, subpaths['./register'].default));
  });

  it('packaging: every declaration file ships', () => {
    const declarations = new Set([path.join(ROOT, types)]);
    for (const subpath of Object.keys(subpaths)) {
      declarations.add(declarationOf(subpath));
    }
    const seen = new Set();
    for (const file of [...declarations]) declaredValues(file, new Set(), seen);
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const pack = spawnSync(
      npm,
      ['pack', '--dry-run', '--json', '--ignore-scripts'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      },
    );
    assert.equal(pack.status, 0, pack.stderr);
    const [{ files }] = JSON.parse(pack.stdout);
    const packed = new Set(files.map((file) => file.path));
    const unpacked = [...seen]
      .map((file) => path.relative(ROOT, file).split(path.sep).join('/'))
      .filter((file) => !packed.has(file));
    assert.deepEqual(unpacked, []);
    assert.ok(![...packed].some((file) => file.startsWith('test-types/')));
  });
});
