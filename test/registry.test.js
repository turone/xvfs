'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PlaceRegistry, Containment } = require('../lib/registry.js');

// Lexical containment: only a real `..` component leaves appRoot. Names that
// merely start with dots are ordinary names routed by the usual Place rules.

describe('PlaceRegistry.route: appRoot containment', () => {
  const appRoot = path.resolve('/srv/app');
  const registry = new PlaceRegistry(appRoot);
  const api = { name: 'api' };
  registry.register(api);
  const at = (...parts) => path.join(appRoot, ...parts);

  it('dot-prefixed names are inside appRoot, not parent traversal', () => {
    for (const name of ['..private', '..cache', '...data', 'file..js']) {
      assert.deepEqual(
        registry.route(at(name, 'secret.js')),
        { place: null, key: null },
        name,
      );
      assert.deepEqual(registry.route(at(name)), { place: null, key: null });
    }
  });

  it('the first component names the Place, dotted names below it are keys', () => {
    assert.deepEqual(registry.route(at('api', '..private', 'file.js')), {
      place: api,
      key: '/..private/file.js',
    });
    assert.deepEqual(registry.route(at('api', 'file..js')), {
      place: api,
      key: '/file..js',
    });
    assert.deepEqual(registry.route(at('api')), { place: api, key: '' });
    assert.deepEqual(registry.route(at('api', 'x.js')), {
      place: api,
      key: '/x.js',
    });
  });

  it('real parent paths stay outside appRoot', () => {
    assert.equal(registry.route(path.join(appRoot, '..', 'secret')), null);
    assert.equal(registry.route(path.join(appRoot, '..')), null);
    assert.equal(
      registry.route(path.join(path.dirname(appRoot), 'app-sibling', 'x')),
      null,
    );
    assert.equal(registry.route(at('api', '..', '..', 'secret')), null);
  });

  it('appRoot itself is the boundary, not the root of a Place', () => {
    assert.deepEqual(registry.route(appRoot), {
      place: null,
      key: null,
      root: true,
    });
    assert.deepEqual(
      registry.route(appRoot + path.sep),
      registry.route(appRoot),
    );
  });

  it('a path on another drive is outside appRoot', (t) => {
    if (process.platform !== 'win32') {
      t.skip('windows only');
      return;
    }
    const drive = appRoot[0].toUpperCase() === 'Z' ? 'Y:' : 'Z:';
    assert.equal(registry.route(`${drive}\\srv\\app\\api\\x.js`), null);
  });

  it('appRoot matches as path.relative does, a place by its exact name', () => {
    const win32 = process.platform === 'win32';
    const upper = path.join(appRoot.toUpperCase(), 'api', 'x.js');
    assert.deepEqual(
      registry.route(upper),
      win32 ? { place: api, key: '/x.js' } : null,
    );
    assert.deepEqual(registry.route(at('API', 'x.js')), {
      place: null,
      key: null,
    });
    assert.equal(registry.encloses(appRoot.toUpperCase()), win32);
    assert.equal(registry.encloses(path.dirname(appRoot)), true);
    assert.equal(registry.encloses(at('api')), false);
  });
});

// Containment as path.relative computes it, for both flavors of node:path
// on any platform: new Containment(P, root) against what the router asked
// P.relative before, over the paths it may be handed — root and its
// ancestors in every spelling (case; Unicode whose lower-casing changes a
// length, crosses blocks or depends on context; a leading `\\` or `\\?\`;
// forward slashes), names below them (`..`, `.`, empty, `..private`, a
// drive, spaces), siblings, relative paths; on win32 also what resolves to
// a bare `\\?\` or `\\.\`, which path.resolve does not keep when it
// resolves it again, against roots in those namespaces. What path.relative
// resolves against the cwd depends on the host — path.win32 on a posix
// host has a cwd off any drive — so the reference is always this host's.

const reference = (P, root) => {
  const parent = '..' + P.sep;
  const outside = (rel) =>
    rel === '..' || rel.startsWith(parent) || P.isAbsolute(rel);
  return {
    below: (p) => {
      const rel = P.relative(root, P.resolve(p));
      return outside(rel) ? null : rel;
    },
    encloses: (p) => {
      const rel = P.relative(P.resolve(p), root);
      return rel === '' || !outside(rel);
    },
  };
};

const ROOTS = {
  win32: [
    'C:\\app',
    'C:\\App\\Root',
    'c:\\',
    'C:\\x y\\\u00fc',
    '\\\\srv\\share\\app',
    '\\\\srv\\share',
    'D:\\a..b\\c',
    '\\\\?\\C:\\app',
    '\\\\.\\C:\\app',
    'C:\\x\\i\u0307', // decomposed: its lower-casing keeps the length
    'C:\\\u0130x', // İ: lower-cased, one character becomes two
    'C:\\\u0130\\x..',
    'C:\\\u0391\u03a3', // a final sigma
    'C:\\\u212a', // the Kelvin sign lower-cases to 'k'
    'C:\\app\\C:\\x',
    // In a namespace, and UNC servers named like a drive: the cwd's too
    // (on Windows; a posix host's cwd gives none).
    '\\\\?\\UNC\\srv\\share\\app',
    '\\\\?\\Volume{1}\\app',
    '\\\\.\\pipe\\x',
    '\\\\.\\UNC\\srv\\share\\app',
    '\\\\?\\C:\\',
    '\\\\C:\\app',
    '\\\\' + path.win32.resolve('\\\\.\\').slice(0, 2) + '\\share',
  ],
  posix: [
    '/app',
    '/App/Root',
    '/',
    '/x y/\u00fc',
    '/a..b/c',
    '/\u0130x',
    '/a\\b',
  ],
};

const NAMES = [
  ...['a', 'A', 'site', 'SITE', '..', '.', '', 'a..b', '..x', '..private'],
  ...['x..', '\u00fc', '\u00dc', '\u0130', 'i\u0307', 'I', '\u00df'],
  ...['\u212a', 'k', '\u03a3', '\u03c3', 'con', 'C:', 'C:x', 'x.txt', ' '],
  'a b',
];
const SHORT = ['a', 'SITE', '..', '.', '', '\u0130', 'C:', 'x y'];
// What resolves to a bare `\\?\` or `\\.\`.
const BARE = [
  ...['\\\\?\\', '\\\\.\\', '\\\\?\\x\\..', '\\\\.\\x\\..', '\\\\?\\C:\\..'],
  ...['\\\\?\\C:\\app\\..\\..', '\\\\.\\x\\..\\..\\..', '//?/x/..'],
  ...['\\\\?\\x\\..\\', '\\\\.\\C:\\..'],
];

const ancestors = (P, p) => {
  const all = [p];
  for (let d = P.dirname(p); d !== all.at(-1); d = P.dirname(d)) all.push(d);
  return all;
};

const spellings = (P, base) => {
  const all = new Set([
    base,
    base.toUpperCase(),
    base.toLowerCase(),
    base.replace(/\u0130/g, 'i\u0307'),
    base.replace(/i\u0307/g, '\u0130'),
    base.replace(/\u212a/g, 'k'),
    base.replace(/k/g, '\u212a'),
    base.replace(/\u03a3/g, '\u03c3'),
  ]);
  if (P === path.win32) {
    for (const spelled of [...all]) {
      all.add('\\\\' + spelled);
      all.add('\\\\?\\' + spelled);
      all.add(spelled.replace(/\\/g, '/'));
    }
  }
  return all;
};

const corpus = (P, root) => {
  const { sep } = P;
  const bases = spellings(P, root);
  for (const above of ancestors(P, root).slice(1)) {
    bases.add(above).add(above.toUpperCase());
    if (P === path.win32) bases.add('\\\\' + above);
  }
  const paths = new Set();
  for (const base of bases) {
    paths.add(base).add(base + sep);
    for (const a of NAMES) {
      paths
        .add(base + a)
        .add(base + sep + a)
        .add(base + sep + sep + a);
      for (const b of SHORT) {
        paths.add(base + sep + a + sep + b);
        paths.add(base + sep + a + sep + b + sep);
      }
    }
  }
  for (const a of NAMES) for (const b of SHORT) paths.add(a + sep + b);
  if (P === path.win32) for (const bare of BARE) paths.add(bare);
  return paths;
};

describe('Containment: path.relative, computed from the strings', () => {
  for (const flavor of ['win32', 'posix']) {
    it(`${flavor}: route and encloses agree with path.relative`, () => {
      const P = path[flavor];
      const wrong = [];
      let checked = 0;
      for (const root of ROOTS[flavor].map((r) => P.resolve(r))) {
        const fast = new Containment(P, root);
        const slow = reference(P, root);
        for (const p of corpus(P, root)) {
          const below = fast.below(p);
          const encloses = fast.encloses(p);
          if (below !== slow.below(p) || encloses !== slow.encloses(p)) {
            wrong.push({ root, p, below, encloses });
          }
          checked++;
        }
      }
      assert.deepEqual(wrong.slice(0, 5), []);
      assert.ok(checked > 10000, `${checked} paths`);
    });
  }

  it('win32: case-insensitive past appRoot, the rest as given', () => {
    const app = new Containment(path.win32, 'C:\\srv\\app');
    assert.equal(app.below('c:\\SRV\\APP\\Site\\A.txt'), 'Site\\A.txt');
    assert.equal(app.below('C:/srv/app/site/'), 'site');
    assert.equal(app.below('C:\\srv\\App'), '');
    assert.equal(app.below('C:\\srv\\app\\..private\\x'), '..private\\x');
    assert.equal(app.below('C:\\srv\\app\\site\\..\\..\\x'), null);
    assert.equal(app.below('C:\\srv\\apple\\x'), null);
    assert.equal(app.below('D:\\srv\\app\\x'), null);
    assert.equal(app.below('C:\\srv\\app\\C:\\x'), null, 'an absolute rest');
    assert.equal(app.encloses('C:\\'), true);
    assert.equal(app.encloses('c:\\SRV'), true);
    assert.equal(app.encloses('C:\\sr'), false);
    assert.equal(app.encloses('C:\\srv\\app\\site'), false);
  });

  it('win32: what path.relative treats apart is its own answer', () => {
    // A lower-casing that changes a length: segment by segment.
    const decomposed = new Containment(path.win32, 'C:\\x\\i\u0307');
    assert.equal(decomposed.below('C:\\x\\\u0130\\site\\a.txt'), 'site\\a.txt');
    assert.equal(decomposed.below('C:\\x\\\u0130'), '');
    const composed = new Containment(path.win32, 'C:\\\u0130x');
    assert.equal(composed.below('C:\\i\u0307x\\site'), 'site');
    // A leading `\\` on one side only is trimmed.
    const drive = new Containment(path.win32, 'C:\\app\\sub');
    assert.equal(drive.below('\\\\C:\\app\\sub\\x'), 'x');
    assert.equal(drive.encloses('\\\\C:\\app'), true);
    const server = new Containment(path.win32, '\\\\C:\\app\\');
    assert.equal(server.below('C:\\app\\x'), 'x');
    // A bare `\\?\` or `\\.\` is resolved again against the cwd: on Windows
    // to a drive, which is no ancestor of a root in its namespace. On a
    // posix host path.win32 finds no drive in the cwd and answers otherwise;
    // so does containment, as path.relative there.
    const bare = [
      ['\\\\?\\UNC\\srv\\share\\app', '\\\\?\\C:\\..'],
      ['\\\\?\\Volume{1}\\app', '\\\\?\\'],
      ['\\\\.\\pipe\\x', '\\\\.\\x\\..\\..\\..'],
    ];
    for (const [root, p] of bare) {
      const encloses = new Containment(path.win32, root).encloses(p);
      assert.equal(encloses, reference(path.win32, root).encloses(p), p);
      if (process.platform === 'win32') assert.equal(encloses, false, p);
    }
    const unc = new Containment(path.win32, '\\\\?\\UNC\\srv\\share\\app');
    assert.equal(unc.below('\\\\?\\UNC\\srv\\share\\app\\x'), 'x');
    const pipe = new Containment(path.win32, '\\\\.\\pipe\\x');
    assert.equal(pipe.encloses('\\\\.\\pipe'), true);
  });

  it('posix: case-sensitive, a backslash is a name', () => {
    const app = new Containment(path.posix, '/srv/app');
    assert.equal(app.below('/srv/app/a\\b/c'), 'a\\b/c');
    assert.equal(app.below('/srv/App/a'), null);
    assert.equal(app.below('//srv//app/./a/'), 'a');
    assert.equal(app.encloses('/'), true);
    assert.equal(app.encloses('/SRV'), false);
    assert.equal(new Containment(path.posix, '/').below('/x'), 'x');
  });
});
