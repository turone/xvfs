'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  PlaceRegistry,
  FsRouter,
  Containment,
  namespaced,
  streamed,
  shortName,
  resolvedFor,
  listedNames,
} = require('../lib/registry.js');
const { Place } = require('../lib/place.js');
const { VfsConfig } = require('../lib/config.js');
const { VfsKernel } = require('../lib/kernel.js');
const { quiet } = require('./helpers.js');

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

  it('appRoot matches as path.relative does, a place as the platform compares names', () => {
    const win32 = process.platform === 'win32';
    const upper = path.join(appRoot.toUpperCase(), 'api', 'x.js');
    assert.deepEqual(
      registry.route(upper),
      win32 ? { place: api, key: '/x.js' } : null,
    );
    assert.deepEqual(
      registry.route(at('API', 'x.js')),
      win32 ? { place: api, key: '/x.js' } : { place: null, key: null },
    );
    assert.equal(registry.encloses(appRoot.toUpperCase()), win32);
    assert.equal(registry.encloses(path.dirname(appRoot)), true);
    assert.equal(registry.encloses(at('api')), false);
  });
});

// The mount names a place as the platform's file systems compare names, for
// either flavor of node:path on any platform: on POSIX exactly; on Windows
// without the case of ASCII letters — a place's name is ASCII, and NTFS
// equates no other character with an ASCII letter (the Kelvin sign is no
// `k` there, though lower-casing makes it one). The key keeps its case.
describe('PlaceRegistry.route: a place named as the platform compares names', () => {
  const nobody = { place: null, key: null };
  const registryOf = (P, root) => {
    const registry = new PlaceRegistry(root, P);
    const places = ['api', 'Mixed', 'keys', 'a.b-c_1', 'x'].map((name) => {
      const place = { name };
      registry.register(place);
      return place;
    });
    return { registry, places };
  };

  it('win32: any case of a place names it; the key keeps the case given', () => {
    const root = 'C:\\srv\\app';
    const { registry, places } = registryOf(path.win32, root);
    const [api, mixed, keys, dotted, x] = places;
    const at = (...parts) => path.win32.join(root, ...parts);
    const routes = [
      [at('API', 'Sub', 'X.js'), { place: api, key: '/Sub/X.js' }],
      ['c:\\SRV\\APP\\Api', { place: api, key: '' }],
      ['C:/srv/App/mIXED/a/', { place: mixed, key: '/a' }],
      [at('mixed'), { place: mixed, key: '' }],
      [at('Mixed', 'b'), { place: mixed, key: '/b' }],
      [at('KEYS', 'k'), { place: keys, key: '/k' }],
      [at('A.B-C_1', 'd'), { place: dotted, key: '/d' }],
      [at('X', 'y'), { place: x, key: '/y' }],
    ];
    for (const [p, route] of routes)
      assert.deepEqual(registry.route(p), route, p);
  });

  it('win32: no other character stands for an ASCII letter of a name', () => {
    const { registry } = registryOf(path.win32, 'C:\\srv\\app');
    const names = [
      '\u212aeys', // the Kelvin sign: `k` once lower-cased
      'ap\u0131', // the dotless i: `I` once upper-cased
      'ap\u0130', // the dotted capital I
      '\uff41pi', // a full-width `a`
      'a.b-c\u007f1', // `_` with the case bit set
      'a.b-c\u00df1',
      'api ',
      'ap',
      'apix',
      'other',
    ];
    for (const name of names) {
      const p = path.win32.join('C:\\srv\\app', name, 'x');
      assert.deepEqual(registry.route(p), nobody, name);
    }
  });

  it('win32: a place registered again is found by its new entry', () => {
    const { registry } = registryOf(path.win32, 'C:\\srv\\app');
    const again = { name: 'api' };
    registry.register(again);
    const route = registry.route('C:\\srv\\app\\API\\x');
    assert.equal(route.place, again, 'the entry itself, not the old one');
    assert.equal(route.key, '/x');
  });

  it('posix: a place by its exact name only', () => {
    const { registry, places } = registryOf(path.posix, '/srv/app');
    const [api, mixed] = places;
    assert.deepEqual(registry.route('/srv/app/API/x'), nobody);
    assert.deepEqual(registry.route('/srv/app/mixed/x'), nobody);
    assert.deepEqual(registry.route('/srv/app/api/X'), {
      place: api,
      key: '/X',
    });
    assert.deepEqual(registry.route('/srv/app/Mixed'), {
      place: mixed,
      key: '',
    });
    assert.equal(registry.route('/SRV/app/api/x'), null);
  });
});

// On Windows a UNC or namespace path may name a file below appRoot in a
// spelling appRoot does not share — `\\?\C:\app\…`, `\\localhost\C$\app\…`.
// Below an appRoot in such a form itself it routes lexically; elsewhere a
// registry built for strict owns it to nobody, which strict refuses, and
// without strict nothing is asked: it passes through as before. Strings
// only, for both flavors on any platform; path-identity.test.js runs it
// through node:fs and the module hooks.
describe('PlaceRegistry: UNC and namespace paths', () => {
  const nobody = { place: null, key: null };
  const registryOf = (P, root, strict = true) => {
    const registry = new PlaceRegistry(root, P, strict);
    const ro = { name: 'ro' };
    registry.register(ro);
    return { registry, ro };
  };

  // The forms as path.win32.resolve gives them — the NT prefix in both of
  // its forms, where the cwd has a drive and where it has none.
  it('namespaced: a resolved path with two backslashes first, or a rooted ??', () => {
    const forms = [
      ...['\\\\?\\C:\\app\\x', '\\\\.\\C:\\x', '\\\\?\\UNC\\srv\\share\\x'],
      ...['\\\\.\\UNC\\srv\\share\\x', '\\\\?\\GLOBALROOT\\Device\\x'],
      ...['\\\\?\\Volume{1}\\x', '\\\\srv\\share\\x', '\\\\localhost\\C$\\x'],
      ...['\\\\127.0.0.1\\C$\\x', '\\\\.\\pipe\\x', '\\??\\C:\\x', '\\??'],
      ...['D:\\??\\C:\\x', 'C:\\??'],
    ];
    for (const abs of forms) assert.equal(namespaced(abs), true, abs);
    const plain = [
      ...['C:\\app\\x', 'C:\\', '\\app\\x', 'C:\\?x', 'D:\\?\\x', '\\?\\x'],
      ...['\\???\\x', 'C:\\???\\x', 'C:\\??x', 'D:\\a\\??\\x', '\\a\\??'],
    ];
    for (const abs of plain) assert.equal(namespaced(abs), false, abs);
  });

  it('win32 under strict, appRoot on a drive: every such path is owned by nobody', () => {
    const { registry, ro } = registryOf(path.win32, 'C:\\app');
    const forms = [
      ...['\\\\?\\C:\\app\\ro\\x', '//?/C:/app/ro/x', '\\\\?\\c:\\APP\\RO\\x'],
      ...['\\\\.\\C:\\app\\ro\\x', '\\??\\C:\\app\\ro\\x', '/??/C:/app/ro/x'],
      ...['\\\\localhost\\C$\\app\\ro\\x', '//localhost/C$/app/ro/x'],
      ...['\\\\?\\UNC\\localhost\\C$\\app\\ro\\x', '\\/127.0.0.1/C$/app'],
      ...['\\\\.\\UNC\\localhost\\C$\\app', '\\\\?\\GLOBALROOT\\Device\\x'],
      ...['\\\\srv\\share\\x', '\\\\srv\\share', '\\\\?\\D:\\x', '//C:/app'],
      ...['\\\\?\\GLOBALROOT\\??\\C:\\app\\ro\\x', '//./C:/app/ro/x'],
      // What the module hooks make of `\??\C:\…`: no name holds a `?`.
      ...['D:\\??\\C:\\app\\ro\\x', 'C:/??/x'],
      // A server named like a drive, below appRoot to path.relative.
      ...['\\\\C:\\app\\ro\\x', '//C:/app/x'],
    ];
    for (const p of forms) assert.deepEqual(registry.route(p), nobody, p);
    assert.deepEqual(registry.route('C:\\app\\ro\\x'), {
      place: ro,
      key: '/x',
    });
    assert.deepEqual(registry.route('c:/APP/ro'), { place: ro, key: '' });
    // What path.win32.resolve puts on a drive: outside appRoot, native.
    const plain = [
      ...['D:\\other\\x', 'C:\\other', 'C:\\?x', 'D:\\?\\x', 'x', '\\\\\\x'],
      ...['\\\\srv', '\\\\?\\', '\\\\'],
    ];
    for (const p of plain) assert.equal(registry.route(p), null, p);
  });

  it('win32 without strict: nothing outside appRoot is classified', () => {
    const { registry } = registryOf(path.win32, 'C:\\app', false);
    const forms = [
      ...['\\\\?\\C:\\app\\ro\\x', '\\??\\C:\\app\\ro\\x', 'D:\\??\\C:\\x'],
      ...['\\\\localhost\\C$\\app\\ro\\x', '\\\\srv\\share\\x', '//C:/app'],
    ];
    for (const p of forms) assert.equal(registry.route(p), null, p);
    // Below appRoot to path.relative, it is still no path there.
    assert.deepEqual(registry.route('\\\\C:\\app\\ro\\x'), nobody);
  });

  it('win32, appRoot on a share: below it in any case, other UNC paths owned by nobody', () => {
    const { registry, ro } = registryOf(path.win32, '\\\\srv\\share\\app');
    const below = [
      '\\\\srv\\share\\app\\ro\\x',
      '\\\\SRV\\Share\\APP\\RO\\x',
      '//srv/share/app/ro/x',
    ];
    for (const p of below) {
      assert.deepEqual(registry.route(p), { place: ro, key: '/x' }, p);
    }
    assert.deepEqual(registry.route('\\\\srv\\share\\app\\x'), nobody);
    assert.deepEqual(registry.route('\\\\srv\\share\\app'), {
      place: null,
      key: null,
      root: true,
    });
    const others = [
      ...['\\\\?\\UNC\\srv\\share\\app\\ro\\x', '\\\\srv\\share\\other\\x'],
      ...['\\\\srv\\share', '\\\\srv2\\share\\app\\ro\\x'],
      ...['\\\\.\\UNC\\srv\\share\\app\\ro\\x', '\\??\\UNC\\srv\\share\\app'],
    ];
    for (const p of others) assert.deepEqual(registry.route(p), nobody, p);
    assert.equal(registry.route('C:\\app\\ro\\x'), null);
  });

  // path.win32 resolves a relative path against process.cwd() on any host.
  it('win32 under strict: a relative path is what the cwd makes of it', () => {
    const { registry, ro } = registryOf(path.win32, 'C:\\app');
    const { cwd } = process;
    const through = (at) => {
      process.cwd = () => at;
      try {
        return ['x', '\\x', 'ro\\x'].map((p) => registry.route(p));
      } finally {
        process.cwd = cwd;
      }
    };
    const all = (answer) => [answer, answer, answer];
    assert.deepEqual(through('\\\\srv\\share\\dir'), all(nobody));
    assert.deepEqual(through('\\\\?\\C:\\dir'), all(nobody));
    assert.deepEqual(through('D:\\dir'), all(null));
    assert.deepEqual(through('C:\\app'), [
      nobody,
      null,
      { place: ro, key: '/x' },
    ]);
  });

  it('win32, a namespaced appRoot: below it, lexically', () => {
    const { registry, ro } = registryOf(path.win32, '\\\\?\\C:\\app');
    assert.deepEqual(registry.route('\\\\?\\c:\\APP\\ro\\x'), {
      place: ro,
      key: '/x',
    });
    assert.deepEqual(registry.route('\\\\.\\C:\\app\\ro\\x'), nobody);
  });

  it('posix: no namespace, and `//` is the root', () => {
    const { registry, ro } = registryOf(path.posix, '/app');
    assert.deepEqual(registry.route('//app/ro/x'), { place: ro, key: '/x' });
    assert.equal(registry.route('/??/x'), null);
    assert.equal(registry.route('//srv/share/x'), null);
  });

  it('strict refuses such a path; without strict it passes', () => {
    const p = '\\\\?\\C:\\app\\ro\\x';
    const q = '\\\\localhost\\C$\\app\\ro\\y';
    const strict = new FsRouter(
      registryOf(path.win32, 'C:\\app').registry,
      true,
    );
    const eacces = { kind: 'deny', code: 'EACCES' };
    assert.deepEqual(strict.read(p), eacces);
    assert.deepEqual(strict.mutate(p), eacces);
    assert.deepEqual(strict.copy(p, false), eacces);
    assert.deepEqual(strict.copy(p, true), eacces);
    assert.deepEqual(strict.rename(p, q), eacces);
    assert.deepEqual(strict.link(p, q), eacces);
    assert.deepEqual(strict.read('D:\\x'), { kind: 'passthrough' });
    const loose = registryOf(path.win32, 'C:\\app', false).registry;
    const open = new FsRouter(loose, false);
    assert.equal(open.read(p).kind, 'passthrough');
    assert.equal(open.mutate(q).kind, 'passthrough');
  });

  // The module hooks' lookup, on a registry of the win32 flavor.
  it('module lookup: strict refuses such a path, without strict Node takes it', () => {
    for (const strict of [true, false]) {
      const config = new VfsConfig({
        defaults: { strict },
        places: { lib: { require: true } },
      });
      const k = new VfsKernel(config, { appRoot: 'C:\\app', console: quiet });
      k.registry = new PlaceRegistry('C:\\app', path.win32, strict);
      try {
        const found = k.resolveModule('\\\\?\\C:\\app\\lib\\m.js', 'require');
        assert.deepEqual(found, strict ? { denied: true } : null);
        assert.equal(k.resolveModule('D:\\lib\\m.js', 'require'), null);
      } finally {
        k.close();
      }
    }
  });
});

// NTFS takes a `:` past the drive for a stream of the file or directory
// before it: `a.txt::$DATA` is a.txt itself, `C:\app::$INDEX_ALLOCATION` the
// directory C:\app. A registry built for strict owns every such path to
// nobody, below appRoot or not, which strict refuses; without strict nothing
// is asked. Strings only, for both flavors on any platform;
// path-identity.test.js runs it through node:fs and the module hooks.
describe('PlaceRegistry: NTFS stream spellings', () => {
  const nobody = { place: null, key: null };
  const registryOf = (P, root, strict = true) => {
    const registry = new PlaceRegistry(root, P, strict);
    const ro = { name: 'ro' };
    registry.register(ro);
    return { registry, ro };
  };

  it('streamed: a colon past the drive of a resolved path', () => {
    const streams = [
      ...['C:\\app\\a.txt::$DATA', 'C:\\app\\a.txt:s', 'C:\\app:s'],
      ...['C:\\app::$INDEX_ALLOCATION\\x', 'c:\\a:$I30:$INDEX_ALLOCATION'],
      ...['x:\\a:', 'C:\\:', '\\a:b'],
    ];
    for (const abs of streams) assert.equal(streamed(abs), true, abs);
    const plain = ['C:\\app\\a.txt', 'C:\\', 'x:\\stream', '\\app\\x'];
    for (const abs of plain) assert.equal(streamed(abs), false, abs);
  });

  it('win32 under strict: a stream below appRoot, of it or above it is owned by nobody', () => {
    const { registry, ro } = registryOf(path.win32, 'C:\\app');
    const forms = [
      ...['C:\\app\\ro\\a.txt::$DATA', 'C:\\app\\ro\\a.txt:s:$DATA'],
      ...['C:\\app\\ro\\x:stream', 'c:/APP/RO/A.TXT::$data', 'C:\\app\\ro:s'],
      ...['C:\\app\\ro\\sub::$INDEX_ALLOCATION\\x', 'C:\\app\\x:y'],
      ...['C:\\app::$INDEX_ALLOCATION', 'C:\\app::$INDEX_ALLOCATION\\ro\\x'],
      ...['C:\\app:$I30:$INDEX_ALLOCATION\\ro\\x', 'C:/app::$DATA/ro/x'],
      ...['C:\\::$INDEX_ALLOCATION\\app\\ro\\x', 'C:\\app\\ro\\a.txt:'],
      // Outside appRoot too: which file it names is not asked.
      ...['D:\\other\\x.txt:Zone.Identifier', 'C:\\other\\x::$DATA'],
    ];
    for (const p of forms) assert.deepEqual(registry.route(p), nobody, p);
    assert.deepEqual(registry.route('C:\\app\\ro\\a.txt'), {
      place: ro,
      key: '/a.txt',
    });
    // A relative `x:stream` is a path on drive X, no stream.
    assert.equal(registry.route('x:\\stream'), null);
    assert.equal(registry.route('D:\\other\\x.txt'), null);
  });

  // path.win32 resolves a relative path against process.cwd() on any host.
  it('win32 under strict: a relative stream is what the cwd makes of it', () => {
    const { registry } = registryOf(path.win32, 'C:\\app');
    const { cwd } = process;
    const through = (at, p) => {
      process.cwd = () => at;
      try {
        return registry.route(p);
      } finally {
        process.cwd = cwd;
      }
    };
    assert.deepEqual(through('C:\\app\\ro', 'a.txt::$DATA'), nobody);
    assert.deepEqual(through('C:\\other', 'x.txt:s'), nobody);
    assert.deepEqual(through('C:\\app', '..\\app::$INDEX_ALLOCATION'), nobody);
  });

  it('win32 without strict: the name as given, nothing asked outside', () => {
    const { registry, ro } = registryOf(path.win32, 'C:\\app', false);
    assert.deepEqual(registry.route('C:\\app\\ro\\a.txt::$DATA'), {
      place: ro,
      key: '/a.txt::$DATA',
    });
    assert.equal(registry.route('C:\\app::$INDEX_ALLOCATION\\ro\\x'), null);
    assert.equal(registry.route('D:\\other\\x.txt:s'), null);
  });

  it('win32 under strict, appRoot on a share or in a namespace: below it too', () => {
    const share = registryOf(path.win32, '\\\\srv\\share\\app');
    assert.deepEqual(
      share.registry.route('\\\\srv\\share\\app\\ro\\a.txt::$DATA'),
      nobody,
    );
    assert.deepEqual(share.registry.route('\\\\srv\\share\\app\\ro\\a'), {
      place: share.ro,
      key: '/a',
    });
    const ns = registryOf(path.win32, '\\\\?\\C:\\app');
    assert.deepEqual(ns.registry.route('\\\\?\\C:\\app\\ro\\a:s'), nobody);
    assert.deepEqual(ns.registry.route('\\\\?\\c:\\APP\\ro\\a'), {
      place: ns.ro,
      key: '/a',
    });
  });

  it('posix: a colon is a character of the name', () => {
    const { registry, ro } = registryOf(path.posix, '/app');
    assert.deepEqual(registry.route('/app/ro/a.txt::$DATA'), {
      place: ro,
      key: '/a.txt::$DATA',
    });
    assert.equal(registry.route('/app::$INDEX_ALLOCATION/ro/x'), null);
  });

  it('strict refuses a stream in every routing decision', () => {
    const strict = new FsRouter(
      registryOf(path.win32, 'C:\\app').registry,
      true,
    );
    const eacces = { kind: 'deny', code: 'EACCES' };
    const plain = 'C:\\app\\ro\\x';
    for (const p of ['C:\\app\\ro\\a.txt::$DATA', 'C:\\app::$DATA\\ro\\x']) {
      assert.deepEqual(strict.read(p), eacces, p);
      assert.deepEqual(strict.mutate(p), eacces, p);
      assert.deepEqual(strict.copy(p, false), eacces, p);
      assert.deepEqual(strict.copy(p, true), eacces, p);
      assert.deepEqual(strict.rename(p, plain), eacces, p);
      assert.deepEqual(strict.link(p, plain), eacces, p);
      assert.deepEqual(strict.link('D:\\x', p), eacces, p);
    }
  });

  it('module lookup: strict refuses a stream', () => {
    const config = new VfsConfig({
      defaults: { strict: true },
      places: { lib: { require: true } },
    });
    const k = new VfsKernel(config, { appRoot: 'C:\\app', console: quiet });
    k.registry = new PlaceRegistry('C:\\app', path.win32, true);
    try {
      for (const p of ['C:\\app\\lib\\m.js::$DATA', 'C:\\app::$DATA\\m.js']) {
        assert.deepEqual(k.resolveModule(p, 'require'), { denied: true }, p);
      }
    } finally {
      k.close();
    }
  });
});

// An NTFS short (8.3) name may stand for any long name of its directory,
// which only the disk knows: `C:\Users\ME~1\…\APP~1\place\hidden` is a path
// below appRoot. A registry built for strict owns to nobody a name in that
// form below appRoot, and one where a path leaves appRoot's spelling — past
// a name that differs from appRoot's the path lies in a directory that is
// no ancestor of appRoot, and on another drive none stands for it. Strings
// only; path-identity.test.js runs it through node:fs where the volume
// generates 8.3 names.
describe('PlaceRegistry: short (8.3) names', () => {
  const nobody = { place: null, key: null };
  const APP = 'C:\\Users\\me\\AppData\\Local\\Temp\\case-x';
  const registryOf = (P, root, strict = true) => {
    const registry = new PlaceRegistry(root, P, strict);
    const ro = { name: 'ro' };
    registry.register(ro);
    return { registry, ro };
  };

  it('shortName: the form of an 8.3 name, in any case', () => {
    const short = [
      ...['PROGRA~1', 'progra~1', 'LONG-F~1.TXT', 'A~1.HTM', 'AB12CD~1'],
      ...['~1', 'ABCDE~10', 'A~123456', '~$DOC~1.DOC', 'NETV4~1.5CL'],
      ...['1DS_TE~2.DB-', 'SES~1', 'index~1.htm', 'ÄBC~1'],
    ];
    for (const name of short) assert.equal(shortName(name), true, name);
    const long = [
      ...['PROGRAM~', 'a~b', 'file~', 'ABCDEFG~1', 'A~1.HTML', 'a.b~1'],
      ...['a~1.', '~', 'a~1b', 'x.y.z~1', 'Program Files', 'A~1.B.C', ''],
      ...['node_modules', 'a~1 .txt'],
    ];
    for (const name of long) assert.equal(shortName(name), false, name);
  });

  it('win32 under strict: below appRoot, every name of that form', () => {
    const { registry, ro } = registryOf(path.win32, APP);
    const at = (...parts) => path.win32.join(APP, ...parts);
    const forms = [
      ...[at('ro', 'INDEX~1.HTM'), at('ro', 'SUBDIR~1', 'a.bin')],
      ...[at('ro', 'index~1.htm'), at('RO~1', 'x'), at('ro', 'x', 'Y~2')],
    ];
    for (const p of forms) assert.deepEqual(registry.route(p), nobody, p);
    const keys = [
      [at('ro', 'file~'), '/file~'],
      [at('ro', 'a~b', 'x'), '/a~b/x'],
      [at('ro', 'LONGNAME~1'), '/LONGNAME~1'],
    ];
    for (const [p, key] of keys) {
      assert.deepEqual(registry.route(p), { place: ro, key }, p);
    }
  });

  it('win32 under strict: where a path leaves the spelling of appRoot', () => {
    const { registry } = registryOf(path.win32, APP);
    const forms = [
      'C:\\Users\\me\\AppData\\Local\\Temp\\CASE-X~1\\ro\\x',
      'c:\\users\\ME\\appdata\\local\\temp\\case-x~1',
      'C:\\Users\\me\\APPDAT~1\\Local\\Temp\\case-x\\ro\\x',
      'C:\\Users\\ME~1\\AppData\\Local\\Temp\\case-x\\ro\\x',
      'C:\\Users\\me\\APPDAT~1',
      'C:\\USERS~1\\x',
      'C:\\PROGRA~1\\nodejs\\node.exe',
      'C:/Users/me/AppData/LOCAL~1/Temp/case-x/ro/x',
    ];
    for (const p of forms) assert.deepEqual(registry.route(p), nobody, p);
    // Past a name of its own, a short name names an entry of that
    // directory; another drive holds none of appRoot's.
    const outside = [
      'C:\\Users\\me\\Documents\\LONGNA~1\\x',
      'C:\\Windows\\SYSTEM~1\\x',
      'C:\\Users\\me\\AppData\\Local\\Temp\\other\\SUB~1\\x',
      'D:\\Users\\me\\AppData\\Local\\Temp\\CASE-X~1\\ro\\x',
      'D:\\PROGRA~1\\x',
      'C:\\Users\\me\\AppData\\Local\\Temp',
      'C:\\',
    ];
    for (const p of outside) assert.equal(registry.route(p), null, p);
  });

  it('win32 under strict: an appRoot given with short names routes as given', () => {
    const short = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\case-x';
    const { registry, ro } = registryOf(path.win32, short);
    for (const root of [short, short.toLowerCase()]) {
      assert.deepEqual(registry.route(path.win32.join(root, 'ro', 'x')), {
        place: ro,
        key: '/x',
      });
    }
    const other = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\other\\x';
    assert.equal(registry.route(other), null);
    assert.deepEqual(registry.route('C:\\Users\\RUNNER~2\\x'), nobody);
  });

  // path.win32 resolves a relative path against process.cwd() on any host.
  it('win32 under strict: a relative short name is what the cwd makes of it', () => {
    const { registry } = registryOf(path.win32, APP);
    const { cwd } = process;
    process.cwd = () => 'C:\\Users\\me\\AppData\\Local\\Temp';
    try {
      assert.deepEqual(registry.route('CASE-X~1\\ro\\x'), nobody);
      assert.deepEqual(registry.route('case-x\\ro\\INDEX~1.HTM'), nobody);
      assert.equal(registry.route('other\\SUB~1'), null);
    } finally {
      process.cwd = cwd;
    }
  });

  it('win32 without strict, and posix: names like any other', () => {
    const loose = registryOf(path.win32, APP, false);
    const at = (...parts) => path.win32.join(APP, ...parts);
    assert.equal(
      loose.registry.route('C:\\Users\\me\\AppData\\Local\\Temp\\CASE-X~1'),
      null,
    );
    assert.deepEqual(loose.registry.route(at('ro', 'INDEX~1.HTM')), {
      place: loose.ro,
      key: '/INDEX~1.HTM',
    });
    const posix = registryOf(path.posix, '/app');
    assert.deepEqual(posix.registry.route('/app/ro/INDEX~1.HTM'), {
      place: posix.ro,
      key: '/INDEX~1.HTM',
    });
    assert.equal(posix.registry.route('/APP~1/ro/x'), null);
  });

  it('strict refuses a short name in every routing decision', () => {
    const strict = new FsRouter(registryOf(path.win32, APP).registry, true);
    const eacces = { kind: 'deny', code: 'EACCES' };
    const plain = path.win32.join(APP, 'ro', 'x');
    const forms = [
      path.win32.join(APP, 'ro', 'INDEX~1.HTM'),
      'C:\\Users\\me\\AppData\\Local\\Temp\\CASE-X~1\\ro\\x',
    ];
    for (const p of forms) {
      assert.deepEqual(strict.read(p), eacces, p);
      assert.deepEqual(strict.mutate(p), eacces, p);
      assert.deepEqual(strict.copy(p, false), eacces, p);
      assert.deepEqual(strict.copy(p, true), eacces, p);
      assert.deepEqual(strict.rename(p, plain), eacces, p);
      assert.deepEqual(strict.link(p, plain), eacces, p);
      assert.deepEqual(strict.link('D:\\x', p), eacces, p);
    }
  });

  it('module lookup: strict refuses a short name', () => {
    const config = new VfsConfig({
      defaults: { strict: true },
      places: { lib: { require: true } },
    });
    const k = new VfsKernel(config, { appRoot: APP, console: quiet });
    k.registry = new PlaceRegistry(APP, path.win32, true);
    try {
      const forms = [
        'C:\\Users\\me\\AppData\\Local\\Temp\\CASE-X~1\\lib\\m.js',
        path.win32.join(APP, 'lib', 'LONG-M~1.JS'),
      ];
      for (const p of forms) {
        assert.deepEqual(k.resolveModule(p, 'require'), { denied: true }, p);
      }
    } finally {
      k.close();
    }
  });
});

// Where the disk would answer a path the index misses — the non-strict
// `fs.fallback: 'disk'` and Node's own module loader — a published source
// held in memory, named in another case, is served as that source, never
// raw from a case-insensitive disk (Place.spelling); strict refuses it as
// any unpublished path, and 'deny' always does. A disk-backed entry is
// read from disk by the name given, and a virtual place keeps exact keys.
// The places are built for a case-insensitive platform, so this holds on
// any host; path-identity.test.js runs it through node:fs on Windows.
describe('a published source named in another case, where the disk would answer', () => {
  const root = path.resolve('/srv/app');
  const at = (...parts) => path.join(root, ...parts);
  const file = (text) => ({
    data: Buffer.from(text),
    stat: { size: text.length, mtimeMs: 0 },
  });
  // A kernel never initialized, its places projected by hand, each as a
  // case-insensitive platform builds it.
  const kernelOf = (strict) => {
    const config = new VfsConfig({
      defaults: { strict },
      places: {
        site: { fs: { ext: ['txt'], fallback: 'disk', prepare: 'up' } },
        locked: { fs: { ext: ['txt'], fallback: 'deny' } },
        v: { origin: 'virtual', fs: { writable: true }, require: true },
        lib: { require: true },
      },
    });
    const k = new VfsKernel(config, { appRoot: root, console: quiet });
    for (const pc of config.places) {
      k.registry.register(new Place(pc, root, true));
    }
    const files = (name) => k.registry.get(name).files;
    files('site').set('/a.txt', file('A'));
    files('site').set('/Sub/B.txt', file('B'));
    const big = { size: 1, mtimeMs: 0 };
    files('site').set('/big.txt', { data: null, path: at('big'), stat: big });
    files('locked').set('/a.txt', file('A'));
    files('v').set('/a.txt', file('A'));
    files('v').set('/a.js', file('module.exports = 1;'));
    files('lib').set('/m.js', file('module.exports = 1;'));
    return k;
  };

  it('without strict: the source, never the raw file', () => {
    const k = kernelOf(false);
    const site = k.registry.get('site');
    const lib = k.registry.get('lib');
    try {
      const routes = [
        [at('site', 'A.TXT'), { kind: 'file', place: site, key: '/a.txt' }],
        [at('site', 'a.Txt'), { kind: 'file', place: site, key: '/a.txt' }],
        [
          at('site', 'sub', 'b.TXT'),
          { kind: 'file', place: site, key: '/Sub/B.txt' },
        ],
        [at('site', 'A.TXT') + '/', { kind: 'deny', code: 'ENOTDIR' }],
        // Disk-backed: the disk answers for the name given, as before.
        [at('site', 'BIG.txt'), { kind: 'disk', place: site, key: '/BIG.txt' }],
        [at('site', 'big.txt'), { kind: 'passthrough' }],
        // What the place does not publish is its disk's to answer.
        [
          at('site', 'none.txt'),
          { kind: 'disk', place: site, key: '/none.txt' },
        ],
        [at('site', 'm.BIN'), { kind: 'disk', place: site, key: '/m.BIN' }],
        // A directory in another case is no published directory.
        [at('site', 'SUB'), { kind: 'disk', place: site, key: '/SUB' }],
        // No disk answers: 'deny' refuses, a virtual place keeps exact keys.
        [at('locked', 'A.TXT'), { kind: 'deny', code: 'EACCES' }],
        [at('v', 'A.TXT'), { kind: 'passthrough' }],
      ];
      for (const [p, route] of routes) {
        assert.deepEqual(k.routeRead(p), route, p);
      }
      const found = k.resolveModule(at('lib', 'M.JS'), 'require');
      assert.deepEqual([found.place, found.key], [lib, '/m.js']);
      assert.equal(k.resolveModule(at('lib', 'n.js'), 'require'), null);
      assert.equal(k.resolveModule(at('v', 'A.JS'), 'require'), null);
      assert.equal(k.resolveModule(at('v', 'a.js'), 'require').key, '/a.js');
    } finally {
      k.close();
    }
  });

  it('under strict: refused as any unpublished path', () => {
    const k = kernelOf(true);
    const site = k.registry.get('site');
    try {
      const refused = { kind: 'deny', code: 'EACCES' };
      assert.deepEqual(k.routeRead(at('site', 'A.TXT')), refused);
      assert.deepEqual(k.routeRead(at('site', 'sub', 'b.txt')), refused);
      assert.deepEqual(k.routeRead(at('site', 'a.txt')), {
        kind: 'file',
        place: site,
        key: '/a.txt',
      });
      assert.deepEqual(k.resolveModule(at('lib', 'M.JS'), 'require'), {
        denied: true,
      });
    } finally {
      k.close();
    }
  });

  it('a disk-origin place knows other spellings; a virtual one exact keys', () => {
    const config = new VfsConfig({
      places: {
        site: { fs: true },
        v: { origin: 'virtual', fs: { writable: true } },
      },
    });
    const places = (caseless) =>
      config.places.map((pc) => new Place(pc, root, caseless));
    const [site, v] = places(true);
    site.files.set('/a.txt', file('A'));
    v.files.set('/a.txt', file('A'));
    assert.equal(site.spelling('/A.TXT'), '/a.txt');
    assert.equal(v.spelling('/A.TXT'), null);
    const [exact] = places(false);
    exact.files.set('/a.txt', file('A'));
    assert.equal(exact.spelling('/A.TXT'), null);
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
