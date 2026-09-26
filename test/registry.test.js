'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  PlaceRegistry,
  Containment,
  resolvedFor,
  listedNames,
} = require('../lib/registry.js');

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

  // path.resolve counted where the registry calls it, on node:path.
  it('a path in resolved form is not resolved again; the rest is', () => {
    const { resolve } = path;
    let calls = 0;
    path.resolve = (...args) => {
      calls++;
      return resolve(...args);
    };
    try {
      const x = { place: api, key: '/x.js' };
      assert.deepEqual(registry.route(at('api', 'x.js')), x);
      assert.deepEqual(registry.route(at('api')), { place: api, key: '' });
      assert.equal(registry.route(path.parse(appRoot).root), null);
      assert.equal(registry.encloses(appRoot), true);
      assert.equal(calls, 0);
      assert.deepEqual(
        registry.route(`${at('api')}${path.sep}.${path.sep}x.js`),
        x,
      );
      assert.deepEqual(registry.route(at('api', 'x.js') + path.sep), x);
      assert.equal(registry.encloses(appRoot + path.sep), true);
      assert.equal(calls, 3);
    } finally {
      path.resolve = resolve;
    }
    assert.throws(() => registry.route(Buffer.from(appRoot)), {
      code: 'ERR_INVALID_ARG_TYPE',
    });
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

  // The flavor with its relative and resolve counted.
  const counted = (P) => {
    const spy = { ...P, relatives: 0, resolves: 0 };
    spy.relative = (from, to) => {
      spy.relatives++;
      return P.relative(from, to);
    };
    spy.resolve = (...args) => {
      spy.resolves++;
      return P.resolve(...args);
    };
    return spy;
  };

  for (const flavor of ['win32', 'posix']) {
    it(`${flavor}: a plain path takes neither path.relative nor path.resolve`, () => {
      const P = path[flavor];
      const spy = counted(P);
      const root = P.resolve(ROOTS[flavor][0]);
      const app = new Containment(spy, root);
      const { sep } = P;
      const plain = [
        root,
        root + sep + 'site' + sep + 'a.txt',
        root.toUpperCase() + sep + 'site',
        root + 'x',
        root.slice(0, -1),
        P.dirname(root),
        P.parse(root).root,
        P.resolve(ROOTS[flavor][1]) + sep + 'x',
      ];
      const answers = plain.map((p) => [app.below(p), app.encloses(p)]);
      assert.deepEqual([spy.relatives, spy.resolves], [0, 0]);
      const slow = reference(P, root);
      assert.deepEqual(
        answers,
        plain.map((p) => [slow.below(p), slow.encloses(p)]),
      );
    });
  }
});

// A path the router takes as resolved skips path.resolve, so the check may
// only claim a path that path.resolve gives back unchanged: tested on a
// deterministic stream of paths built from heads (drives, roots, UNC,
// relative), names (dots, colons, spaces, Unicode) and separators (both
// kinds, doubled, trailing), for both flavors on any platform.

const HEADS = {
  win32: [
    ...['C:\\', 'C:\\', 'C:\\', 'c:\\', 'z:\\', 'C:/', 'C:', '1:\\', '\\'],
    ...['\\\\', '\\\\srv\\share\\', '\\\\?\\C:\\', '/', ''],
  ],
  posix: ['/', '/', '/', '/', '//', '', './', '\\', 'C:\\'],
};
const PARTS = [
  ...['a', 'B', 'site', 'x.txt', '.', '..', '...', '.a', 'a.', ' ', ':'],
  ...['C:', 'con', '\u0130', 'i\u0307', '\u212a', '\u00fc', 'a\\b'],
];
const SEPARATORS = {
  win32: ['\\', '\\', '\\', '/', '\\\\'],
  posix: ['/', '/', '/', '//', '\\'],
};

const fuzz = function* (flavor, count, seed) {
  let state = seed;
  const next = (n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 2 ** 32) * n);
  };
  const pick = (list) => list[next(list.length)];
  for (let i = 0; i < count; i++) {
    let p = pick(HEADS[flavor]);
    for (let n = 1 + next(4), j = 0; j < n; j++) {
      if (j > 0) p += pick(SEPARATORS[flavor]);
      p += pick(PARTS) + (next(4) === 0 ? pick(PARTS) : '');
    }
    yield next(8) === 0 ? p + pick(SEPARATORS[flavor]) : p;
  }
};

describe('resolvedFor: a path that path.resolve gives back', () => {
  for (const flavor of ['win32', 'posix']) {
    it(`${flavor}: never claims one that path.resolve changes`, () => {
      const P = path[flavor];
      const resolved = resolvedFor(P);
      const wrong = [];
      let claimed = 0;
      for (const p of fuzz(flavor, 200000, 1)) {
        if (!resolved(p)) continue;
        claimed++;
        if (P.resolve(p) !== p) wrong.push(p);
      }
      assert.deepEqual(wrong.slice(0, 5), []);
      assert.ok(claimed > 20000, `${claimed} claimed`);
    });

    // path.resolve's own answers, on a drive on win32: none goes through
    // path.resolve again.
    it(`${flavor}: claims every path path.resolve gives on a drive`, () => {
      const P = path[flavor];
      const resolved = resolvedFor(P);
      const onDrive = flavor === 'win32' ? /^[A-Za-z]:\\/ : /^\//;
      const missed = [];
      let given = 0;
      for (const p of fuzz(flavor, 50000, 3)) {
        const abs = P.resolve(p);
        if (!onDrive.test(abs)) continue;
        given++;
        if (!resolved(abs)) missed.push(abs);
      }
      assert.deepEqual(missed.slice(0, 5), []);
      assert.ok(given > 20000, `${given} resolved`);
    });

    it(`${flavor}: routing over the same paths agrees with path.relative`, () => {
      const P = path[flavor];
      const roots = flavor === 'win32' ? ['C:\\a', 'c:\\B\\site'] : ['/a'];
      const wrong = [];
      for (const root of roots) {
        const fast = new Containment(P, root);
        const slow = reference(P, root);
        for (const p of fuzz(flavor, 30000, 2)) {
          const below = fast.below(p);
          const encloses = fast.encloses(p);
          if (below !== slow.below(p) || encloses !== slow.encloses(p)) {
            wrong.push({ root, p, below, encloses });
          }
        }
      }
      assert.deepEqual(wrong.slice(0, 5), []);
    });
  }

  // Not a string: a String object, one whose toString gives a path.
  const pathLike = (p) => ({ toString: () => p });

  it('takes the paths the router is handed, and no other', () => {
    const win32 = resolvedFor(path.win32);
    const drives = ['C:\\a', 'z:\\x\\y.txt', 'C:\\..private\\...', 'C:\\ '];
    for (const p of [...drives, 'C:\\', 'z:\\']) {
      assert.equal(win32(p), true, p);
    }
    const unresolved = [
      ...['C:', 'C:x', 'C:/', 'C:/a', 'C:\\a/b', 'C:\\a\\', 'C:\\\\'],
      ...['C:\\a\\\\b', 'C:\\.\\a', 'C:\\a\\..', 'C:\\.', '\\\\srv\\share\\a'],
      ...['\\a', '1:\\a', '', null, undefined, 1, pathLike('C:\\a')],
    ];
    for (const p of unresolved) assert.equal(win32(p), false, String(p));
    const posix = resolvedFor(path.posix);
    for (const p of ['/a', '/a\\b/c', '/...', '/ ', '/']) {
      assert.equal(posix(p), true, p);
    }
    const posixUnresolved = [
      ...['//', '//a', '/a/', '/a/./b', '/a/../b', '/.', 'a/b', ''],
      ...[null, pathLike('/a')],
    ];
    for (const p of posixUnresolved) assert.equal(posix(p), false, String(p));
  });

  it('leaves what is not a string to path.resolve and its error', () => {
    for (const P of [path.win32, path.posix]) {
      const app = new Containment(P, P.resolve('/srv/app'));
      const like = pathLike(P.resolve('/srv/app/x'));
      for (const p of [null, undefined, 1, like]) {
        const invalid = { code: 'ERR_INVALID_ARG_TYPE' };
        assert.throws(() => app.below(p), invalid);
        assert.throws(() => app.encloses(p), invalid);
      }
    }
  });
});

// The names of a recursive listing, read from the strings, against the
// path.relative(base, path.join(parent, name)) listings computed per entry:
// bases in the form path.resolve returns and not (a trailing separator, a
// drive or a UNC root, relative, `..` inside, İ against a decomposed i̇);
// parents that are the base, below it (plain, doubled separators, dots,
// the other slash, another case, a reserved name with a colon) or
// elsewhere; the names a listing holds. Parents change and come back, as
// they do in a listing that walks several directories.

const BASES = {
  win32: [
    ...['C:\\a', 'c:\\A\\b c', 'C:\\x\\i\u0307', 'C:\\\u0130', 'C:\\a\\'],
    ...['C:\\', 'C:', 'C:x', '.', '..\\up', '', '\\\\srv\\share\\a'],
    ...['\\\\srv\\share', '\\\\srv', 'C:\\a\\..\\b', 'C:/a'],
  ],
  posix: ['/a', '/a/b c', '/\u0130', '/a/', '/', '.', '../up', '', '//a', 'a'],
};
const TAILS = [
  ...['x', 'x\\y', 'X', '..private', '.a', 'x\\\\y', 'x\\.\\y', 'x\\..\\y'],
  ...['x/y', '\u0130', 'i\u0307', 'con:x', ' ', 'a\\b\\c\\d', '..', '.'],
];
const LISTED = {
  win32: ['n', 'N.txt', '..private', '.a', 'a b', '\u0130', 'con:x', '...'],
  posix: ['n', 'N.txt', '..private', '.a', 'a b', '\u0130', 'a\\b', '...'],
};

describe('listedNames: listing names read from the strings', () => {
  for (const flavor of ['win32', 'posix']) {
    it(`${flavor}: agree with path.relative for every entry`, () => {
      const P = path[flavor];
      const { sep } = P;
      const tails = TAILS.map((t) => (sep === '/' ? t.replace(/\\/g, sep) : t));
      const wrong = [];
      for (const base of BASES[flavor]) {
        const parents = [
          base,
          ...tails.map((tail) => base + sep + tail),
          base.toUpperCase() + sep + 'x',
          base + 'x',
          P.resolve(base),
          P.resolve(base) + sep + 'x',
          P.dirname(P.resolve(base)),
          'x' + sep + 'y',
        ];
        const nameOf = listedNames(P, base);
        for (const pass of [parents, [...parents].reverse(), parents]) {
          for (const parent of pass) {
            for (const name of LISTED[flavor]) {
              const got = nameOf(parent, name);
              const rel = P.relative(base, P.join(parent, name));
              const want = rel.split(sep).join('/');
              if (got !== want) wrong.push({ base, parent, name, got, want });
            }
          }
        }
      }
      assert.deepEqual(wrong.slice(0, 5), []);
    });
  }

  it('reads a base and the directories below it without path.relative', () => {
    const win32 = listedNames(path.win32, 'C:\\srv\\site');
    assert.equal(win32('C:\\srv\\site', 'a.png'), 'a.png');
    assert.equal(win32('C:\\srv\\site\\x\\Y', 'b'), 'x/Y/b');
    assert.equal(win32('C:\\srv\\site\\..private', '.a'), '..private/.a');
    const posix = listedNames(path.posix, '/srv/site');
    assert.equal(posix('/srv/site/x\\y', 'b'), 'x\\y/b');
    // path.relative for what is not below the base in plain form:
    assert.equal(win32('C:\\srv\\site\\x\\..\\y', 'b'), 'y/b');
    assert.equal(win32('C:\\srv\\other', 'b'), '../other/b');
  });
});
