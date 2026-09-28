'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Aliases } = require('../lib/aliases.js');
const { PlaceRegistry, FsRouter } = require('../lib/registry.js');

// What the disk says about spellings of appRoot the strings do not show —
// its real path, what a drive letter names — for both path flavors on any
// host: realpath is a table of the paths that exist, by their real path,
// and counts its calls. path-identity.test.js asks the real disk on
// Windows: junctions, subst drives, a drive mapped to a share.

const missing = (p) =>
  Object.assign(new Error(`ENOENT '${p}'`), { code: 'ENOENT' });

// realpath over `table`: path (in any case on win32) → real path, or the
// code of an error to throw.
const realpathOf = (P, table) => {
  const win32 = P.sep === '\\';
  const fold = (s) => (win32 ? s.toLowerCase() : s);
  const known = new Map(Object.entries(table).map(([k, v]) => [fold(k), v]));
  const calls = [];
  const realpath = (p) => {
    calls.push(p);
    const real = known.get(fold(p));
    if (real === undefined) throw missing(p);
    if (/^E[A-Z]+$/.test(real)) {
      throw Object.assign(new Error(`${real} '${p}'`), { code: real });
    }
    return real;
  };
  return Object.assign(realpath, { calls });
};

describe('Aliases: the real path of appRoot', () => {
  it('win32: appRoot through a subst drive or a link — its real spelling is an alias', () => {
    const realpath = realpathOf(path.win32, {
      'S:\\app': 'C:\\base\\app',
      'C:\\': 'C:\\',
    });
    const aliases = new Aliases('S:\\app', path.win32, realpath);
    for (const p of [
      'C:\\base\\app\\ro\\x',
      'c:\\BASE\\APP',
      'C:\\base\\app',
    ]) {
      assert.equal(aliases.covers(p), true, p);
    }
    assert.equal(aliases.covers('C:\\base\\other'), false);
    assert.equal(aliases.covers('C:\\base'), false);
    for (const p of ['C:\\base', 'C:\\', 'c:\\BASE\\app']) {
      assert.equal(aliases.encloses(p), true, p);
    }
    assert.equal(aliases.encloses('C:\\other'), false);
    assert.equal(aliases.encloses('C:\\base\\app\\ro'), false);
  });

  it('win32: appRoot in its real spelling, in any case, is no alias', () => {
    const realpath = realpathOf(path.win32, { 'C:\\app': 'C:\\App' });
    const aliases = new Aliases('C:\\app', path.win32, realpath);
    assert.equal(aliases.encloses('C:\\'), false);
    assert.equal(aliases.covers('C:\\App\\x'), false);
    assert.deepEqual(realpath.calls, ['C:\\app']);
  });

  it('a missing appRoot is the real path of its nearest ancestor, the rest after it', () => {
    const realpath = realpathOf(path.win32, { 'C:\\link': 'C:\\real' });
    const aliases = new Aliases('C:\\link\\app\\new', path.win32, realpath);
    assert.equal(aliases.covers('C:\\real\\app\\new\\ro\\x'), true);
    assert.equal(aliases.covers('C:\\real\\app\\other'), false);
    assert.deepEqual(realpath.calls, [
      'C:\\link\\app\\new',
      'C:\\link\\app',
      'C:\\link',
    ]);
    const posix = new Aliases(
      '/srv/current/app',
      path.posix,
      realpathOf(path.posix, { '/srv/current': '/srv/releases/7' }),
    );
    assert.equal(posix.covers('/srv/releases/7/app/ro/x'), true);
    assert.equal(posix.encloses('/srv/releases'), true);
    assert.equal(posix.covers('/srv/releases/6/app/x'), false);
    // Nothing exists: the root does, as itself.
    const none = new Aliases(
      '/x/y',
      path.posix,
      realpathOf(path.posix, { '/': '/' }),
    );
    assert.equal(none.encloses('/'), false);
  });

  it('a failure of realpath other than a missing path is thrown', () => {
    const realpath = realpathOf(path.posix, { '/app': 'EACCES' });
    assert.throws(() => new Aliases('/app', path.posix, realpath), {
      code: 'EACCES',
    });
  });

  it('win32: appRoot given with short names — a short name where a path leaves its long spelling', () => {
    const realpath = realpathOf(path.win32, {
      'C:\\Users\\RUNNER~1\\T\\app': 'C:\\Users\\runneradmin\\T\\app',
    });
    const aliases = new Aliases(
      'C:\\Users\\RUNNER~1\\T\\app',
      path.win32,
      realpath,
    );
    const covered = [
      'C:\\Users\\runneradmin\\T\\app\\ro\\x',
      'C:\\Users\\runneradmin\\T\\APP~1\\ro\\x',
      'C:\\Users\\runneradmin\\T~1\\app',
    ];
    for (const p of covered) assert.equal(aliases.covers(p), true, p);
    const other = [
      'C:\\Users\\Public\\x',
      'C:\\Users\\runneradmin\\T\\other\\SUB~1',
      'C:\\Users\\runneradmin\\T',
    ];
    for (const p of other) assert.equal(aliases.covers(p), false, p);
  });

  // appRoot given in 8.3 spelling on a runner: a path along that spelling
  // leaves it where it leaves appRoot as given, as one along the real
  // spelling does; a path that mixes the two is appRoot's line spelled so
  // that neither containment sees it.
  it('win32: a path along the 8.3 spelling of appRoot, or a mix of both', () => {
    const given = 'C:\\U\\RUNNER~1\\LOCALA~1\\APP~1';
    const realpath = realpathOf(path.win32, {
      [given]: 'C:\\U\\runneradmin\\localappdata\\application',
    });
    const aliases = new Aliases(given, path.win32, realpath);
    const siblings = [
      'C:\\U\\RUNNER~1\\LOCALA~1\\other\\x',
      'C:\\U\\RUNNER~1\\LOCALA~1\\other\\SUB~1\\x',
      'C:\\U\\runneradmin\\localappdata\\other\\x',
      'C:\\U\\RUNNER~1\\LOCALA~1',
      'C:\\U\\runneradmin\\localappdata',
      'C:\\U\\RUNNER~1\\LOCALA~1\\APP~1\\ro\\x',
    ];
    for (const p of siblings) assert.equal(aliases.covers(p), false, p);
    const aliased = [
      'C:\\U\\runneradmin\\localappdata\\application\\ro\\x',
      'C:\\U\\RUNNER~1\\LOCALA~1\\OTHER~1\\x',
      'C:\\U\\runneradmin\\LOCALA~1\\application\\ro\\x',
      'C:\\U\\RUNNER~1\\localappdata\\APP~1\\ro\\x',
      'C:\\U\\runneradmin\\LOCALA~1\\APP~1',
      'C:\\U\\runneradmin\\LOCALA~1',
      'C:\\U\\RUNNER~2\\x',
    ];
    for (const p of aliased) assert.equal(aliases.covers(p), true, p);
  });

  it('win32: a second spelling of another depth is no name-for-name one', () => {
    const realpath = realpathOf(path.win32, {
      'S:\\APP~1': 'C:\\base\\application',
      'S:\\': 'C:\\base',
    });
    const aliases = new Aliases('S:\\APP~1', path.win32, realpath);
    assert.equal(aliases.covers('C:\\base\\APP~1\\ro\\x'), true);
    assert.equal(aliases.covers('C:\\APP~1\\x'), true);
    assert.equal(aliases.covers('C:\\base\\other'), false);
  });
});

describe('Aliases: what a drive letter names (win32)', () => {
  const APP = 'C:\\base\\app';
  const DRIVES = {
    [APP]: APP,
    'P:\\': APP, // subst P: <appRoot>
    'Q:\\': '\\\\localhost\\C$\\base\\app\\', // net use Q: <its share>
    'R:\\': 'R:\\', // a volume of its own
    'S:\\': 'C:\\other', // subst off the line
    'T:\\': 'C:\\', // a drive above appRoot
    'U:\\': 'C:\\base\\app\\ro', // a drive below it
    'W:\\': 'EACCES', // what it names is unknown
    'X:\\': 'E:\\', // a volume that answers by another letter
    'Y:\\': '\\\\?\\Volume{1}\\', // a volume without a letter
  };

  it('a share, a drive on the line or one unknown makes every path on it an alias', () => {
    const realpath = realpathOf(path.win32, DRIVES);
    const aliases = new Aliases(APP, path.win32, realpath);
    const alias = ['P:\\ro\\x', 'q:\\x', 'T:\\base', 'U:\\', 'W:\\x', 'Y:\\x'];
    for (const p of alias) assert.equal(aliases.covers(p), true, p);
    const plain = [
      'R:\\x',
      'S:\\x',
      'X:\\x',
      'V:\\x',
      'C:\\x',
      '\\\\srv\\s\\x',
    ];
    for (const p of plain) assert.equal(aliases.covers(p), false, p);
  });

  it('asks once a letter, never appRoot own; a letter that names nothing again', () => {
    const realpath = realpathOf(path.win32, DRIVES);
    const aliases = new Aliases(APP, path.win32, realpath);
    realpath.calls.length = 0;
    for (const p of ['P:\\a', 'p:\\b', 'S:\\a', 's:\\b', 'c:\\a', 'V:\\a']) {
      aliases.covers(p);
    }
    aliases.covers('V:\\b');
    assert.deepEqual(realpath.calls, ['P:\\', 'S:\\', 'V:\\', 'V:\\']);
  });

  it('posix: no drives', () => {
    const realpath = realpathOf(path.posix, { '/app': '/app' });
    const aliases = new Aliases('/app', path.posix, realpath);
    assert.equal(aliases.covers('/P:/x'), false);
    assert.deepEqual(realpath.calls, ['/app']);
  });
});

// Under strict a native call on a place's disk goes where the disk says the
// path really lies: in the place's directory, or off appRoot's line and on
// no share. For a path to create, its nearest existing ancestor answers.
describe('Aliases: where a native call on a place disk lands', () => {
  const win32 = realpathOf(path.win32, {
    'C:\\app': 'C:\\app',
    'C:\\app\\d': 'C:\\app\\d',
    'C:\\app\\d\\x.txt': 'C:\\app\\d\\x.txt',
    'C:\\app\\d\\jin': 'C:\\app\\d\\sub',
    'C:\\app\\d\\jro': 'C:\\app\\ro',
    'C:\\app\\d\\jro\\h.bin': 'C:\\app\\ro\\h.bin',
    'C:\\app\\d\\jup': 'C:\\',
    'C:\\app\\d\\jout': 'D:\\data',
    'C:\\app\\d\\jshare': '\\\\srv\\s',
    'C:\\app\\d\\locked': 'EACCES',
    'C:\\app\\m': 'D:\\media',
    'C:\\app\\m\\jro': 'C:\\app\\ro',
    'C:\\app\\wide': 'C:\\',
    'C:\\app\\dj': 'C:\\app\\ro',
    'C:\\app\\dj\\h.bin': 'C:\\app\\ro\\h.bin',
    'C:\\app\\up': 'C:\\app',
    'C:\\app\\cs': 'C:\\app\\CS',
  });
  const aliases = new Aliases('C:\\app', path.win32, win32);
  const d = 'C:\\app\\d';

  it('in the place, or off the line of appRoot: its real path', () => {
    const proven = [
      ['C:\\app\\d', 'C:\\app\\d'],
      ['C:\\app\\d\\x.txt', 'C:\\app\\d\\x.txt'],
      ['c:\\APP\\D\\X.TXT', 'C:\\app\\d\\x.txt'],
      ['C:\\app\\d\\jin', 'C:\\app\\d\\sub'],
      ['C:\\app\\d\\jout\\a.bin', 'D:\\data\\a.bin'],
      ['C:\\app\\d\\new\\file.txt', 'C:\\app\\d\\new\\file.txt'],
      ['C:\\app\\d\\jout\\new\\b.bin', 'D:\\data\\new\\b.bin'],
    ];
    for (const [p, real] of proven) {
      assert.equal(aliases.territory(d, p), real, p);
    }
  });

  it('into another place, appRoot, above it, onto a share, or unknown: refused', () => {
    const refused = [
      'C:\\app\\d\\jro\\h.bin',
      'C:\\app\\d\\jro',
      'C:\\app\\d\\jro\\new.txt',
      'C:\\app\\d\\jup',
      'C:\\app\\d\\jup\\app\\ro\\h.bin',
      'C:\\app\\d\\jshare\\x',
      'C:\\app\\d\\locked\\x',
    ];
    for (const p of refused) assert.equal(aliases.territory(d, p), null, p);
  });

  it('a place whose directory is a link: its real directory is the place', () => {
    const m = 'C:\\app\\m';
    const png = aliases.territory(m, 'C:\\app\\m\\a.png');
    assert.equal(png, 'D:\\media\\a.png');
    assert.equal(aliases.territory(m, 'C:\\app\\m\\jro\\h.bin'), null);
    // One that encloses appRoot holds nothing of its own: only what lies
    // off appRoot's line is proven through it.
    const wide = 'C:\\app\\wide';
    const back = 'C:\\app\\wide\\app\\ro\\x';
    assert.equal(aliases.territory(wide, back), null);
    const other = aliases.territory(wide, 'C:\\app\\wide\\other');
    assert.equal(other, 'C:\\other');
  });

  // A place directory that is a link into managed territory — another
  // place, appRoot, above it — is none of the place's own: nothing is
  // proven through it but what lies off appRoot's line, and the kernel
  // refuses it at initialize() (misplaced).
  it("a place directory on appRoot's line, not at its own name, is not the place's", () => {
    const dj = 'C:\\app\\dj';
    assert.equal(aliases.territory(dj, 'C:\\app\\dj\\h.bin'), null);
    assert.equal(aliases.territory(dj, dj), null);
    const misplaced = [
      [dj, 'C:\\app\\ro'],
      ['C:\\app\\up', 'C:\\app'],
      ['C:\\app\\wide', 'C:\\'],
    ];
    for (const [root, real] of misplaced) {
      assert.equal(aliases.misplaced(root), real, root);
    }
    for (const root of [
      'C:\\app\\d',
      'C:\\app\\m',
      'C:\\app\\cs',
      'C:\\app\\no',
    ]) {
      assert.equal(aliases.misplaced(root), null, root);
    }
    const cs = aliases.territory('C:\\app\\cs', 'C:\\app\\cs\\new.txt');
    assert.equal(cs, 'C:\\app\\CS\\new.txt');
  });

  it("asks realpath for the place's directory once", () => {
    const realpath = realpathOf(path.posix, {
      '/app': '/app',
      '/app/d': '/app/d',
      '/app/d/a': '/app/d/a',
      '/app/d/j': '/app/ro',
      '/app/d/o': '/data',
    });
    const posix = new Aliases('/app', path.posix, realpath);
    realpath.calls.length = 0;
    assert.equal(posix.territory('/app/d', '/app/d/a'), '/app/d/a');
    assert.equal(posix.territory('/app/d', '/app/d/j/h.bin'), null);
    assert.equal(posix.territory('/app/d', '/app/d/o/x'), '/data/x');
    const places = realpath.calls.filter((p) => p === '/app/d');
    assert.equal(places.length, 1);
  });
});

describe('FsRouter under strict: the disk of a place names the place', () => {
  const { Place } = require('../lib/place.js');
  const { VfsConfig } = require('../lib/config.js');
  const routerOf = (strict) => {
    const config = new VfsConfig({
      defaults: { strict },
      places: {
        d: { provider: 'disk', fs: { writable: true } },
        nd: { provider: 'node-default', fs: true },
        site: { fs: { ext: ['txt'], fallback: 'disk', writable: true } },
      },
    });
    const registry = new PlaceRegistry('/app', path.posix, strict);
    const places = {};
    for (const pc of config.places) {
      places[pc.name] = new Place(pc, '/app', false);
      registry.register(places[pc.name]);
    }
    const stat = { size: 1, mtimeMs: 0 };
    places.site.files.set('/big.txt', { data: null, path: '/b', stat });
    places.site.files.set('/a.txt', { data: Buffer.from('a'), stat });
    return { router: new FsRouter(registry, strict), places };
  };

  it('strict: read, mutate and copy of a place disk carry the place', () => {
    const { router, places } = routerOf(true);
    const on = (place) => ({ kind: 'passthrough', place });
    assert.deepEqual(router.read('/app/d/x'), on(places.d));
    assert.deepEqual(router.read('/app/nd/x'), on(places.nd));
    assert.deepEqual(router.read('/app/site/big.txt'), on(places.site));
    assert.deepEqual(router.mutate('/app/d/x'), on(places.d));
    assert.deepEqual(router.mutate('/app/nd/x'), on(places.nd));
    assert.deepEqual(router.mutate('/app/site/x.bin'), on(places.site));
    assert.deepEqual(router.copy('/app/d/x', false), on(places.d));
    assert.deepEqual(router.copy('/app/site/a.txt', false), on(places.site));
    assert.deepEqual(router.copy('/app/site/m.bin', false), on(places.site));
    assert.equal(router.read('/app/d/x'), router.read('/app/d/y'));
    assert.deepEqual(router.read('/elsewhere/x'), { kind: 'passthrough' });
    // A walk of a place's disk would follow a link out of it.
    const unsupported = { kind: 'unsupported' };
    for (const p of ['/app/d', '/app/nd/x', '/app/site/sub']) {
      assert.deepEqual(router.copy(p, true), unsupported, p);
    }
    assert.deepEqual(router.copy('/elsewhere', true), { kind: 'passthrough' });
  });

  it('without strict: passthrough as before', () => {
    const { router } = routerOf(false);
    const passthrough = { kind: 'passthrough' };
    for (const p of ['/app/d/x', '/app/nd/x', '/app/site/big.txt']) {
      assert.deepEqual(router.read(p), passthrough, p);
    }
    assert.deepEqual(router.mutate('/app/d/x'), passthrough);
    assert.deepEqual(router.copy('/app/d', true), passthrough);
  });

  // A rename that leaves any place — or enters an indexed one — crosses
  // under strict, and then moves a regular file only: a directory or a
  // link would take a link of the place's disk out of it.
  it('strict: a rename that leaves a place crosses, a regular file only', () => {
    const { router } = routerOf(true);
    const crossing = { kind: 'crossing', file: true };
    const leaving = [
      ['/app/d/sub', '/elsewhere/sub'],
      ['/app/d', '/elsewhere/d'],
      ['/app/d/a', '/app/nd/a'],
      ['/app/site/x.bin', '/elsewhere/x.bin'],
      ['/elsewhere/x', '/app/site/x.txt'],
    ];
    for (const [from, to] of leaving) {
      assert.deepEqual(router.rename(from, to), crossing, `${from} ${to}`);
    }
    const passthrough = { kind: 'passthrough' };
    const staying = [
      ['/app/d/a', '/app/d/b'],
      ['/elsewhere/x', '/app/d/x'],
      ['/elsewhere/x', '/elsewhere/y'],
    ];
    for (const [from, to] of staying) {
      assert.deepEqual(router.rename(from, to), passthrough, `${from} ${to}`);
    }
    const { router: loose } = routerOf(false);
    assert.deepEqual(loose.rename('/app/d/sub', '/elsewhere/sub'), passthrough);
    assert.deepEqual(loose.rename('/app/site/x.bin', '/elsewhere/x.bin'), {
      kind: 'crossing',
    });
  });

  // No new link names managed territory under strict: a symbolic link's
  // target, a hard link's file.
  it('strict: a link to managed territory is refused', () => {
    const { router } = routerOf(true);
    const managed = ['/app/d/x', '/app/nd', '/app/site/a.txt', '/app', '/'];
    for (const p of [...managed, '/app/other/x']) {
      assert.equal(router.linksInto(p), true, p);
    }
    assert.equal(router.linksInto('/elsewhere/x'), false);
    assert.equal(router.linksInto('/ap'), false);
    const eacces = { kind: 'deny', code: 'EACCES' };
    assert.deepEqual(router.link('/app/d/f', '/elsewhere/f'), eacces);
    assert.deepEqual(router.link('/app/d/f', '/app/d/g'), eacces);
    assert.deepEqual(router.link('/elsewhere/f', '/app/d/f'), {
      kind: 'passthrough',
    });
    const { router: loose } = routerOf(false);
    assert.equal(loose.linksInto('/app/d/x'), false);
    assert.deepEqual(loose.link('/app/d/f', '/elsewhere/f'), {
      kind: 'passthrough',
    });
  });
});

describe('PlaceRegistry with aliases: owned by nobody, refused under strict', () => {
  const nobody = { place: null, key: null };

  it('routes, walks and every routing decision', () => {
    const realpath = realpathOf(path.win32, {
      'S:\\app': 'C:\\base\\app',
      'C:\\': 'C:\\',
      'P:\\': 'C:\\base',
    });
    const aliases = new Aliases('S:\\app', path.win32, realpath);
    const registry = new PlaceRegistry('S:\\app', path.win32, true, aliases);
    const ro = { name: 'ro' };
    registry.register(ro);
    assert.deepEqual(registry.route('S:\\app\\ro\\x'), {
      place: ro,
      key: '/x',
    });
    const covered = [
      'C:\\base\\app\\ro\\x',
      'P:\\app\\ro\\x',
      'P:\\',
      'C:\\base\\APP~1\\ro\\x',
    ];
    for (const p of covered) assert.deepEqual(registry.route(p), nobody, p);
    assert.equal(registry.route('C:\\base\\other'), null);
    assert.equal(registry.route('S:\\other'), null);
    assert.equal(registry.encloses('C:\\base'), true);
    assert.equal(registry.encloses('S:\\'), true);
    assert.equal(registry.encloses('C:\\base\\other'), false);
    const router = new FsRouter(registry, true);
    const eacces = { kind: 'deny', code: 'EACCES' };
    const plain = 'S:\\app\\ro\\y';
    for (const p of covered) {
      assert.deepEqual(router.read(p), eacces, p);
      assert.deepEqual(router.mutate(p), eacces, p);
      assert.deepEqual(router.copy(p, false), eacces, p);
      assert.deepEqual(router.rename(p, plain), eacces, p);
      assert.deepEqual(router.link(p, plain), eacces, p);
    }
    // A walk from above the real spelling enters the places.
    assert.deepEqual(router.copy('C:\\base', true), { kind: 'unsupported' });
    assert.deepEqual(router.rename('C:\\base', 'C:\\moved'), {
      kind: 'unsupported',
    });
  });

  it('posix: appRoot through a symbolic link', () => {
    const realpath = realpathOf(path.posix, { '/srv/current': '/srv/r7' });
    const aliases = new Aliases('/srv/current', path.posix, realpath);
    const registry = new PlaceRegistry(
      '/srv/current',
      path.posix,
      true,
      aliases,
    );
    registry.register({ name: 'ro' });
    assert.deepEqual(registry.route('/srv/r7/ro/x'), nobody);
    assert.equal(registry.route('/srv/r6/ro/x'), null);
    assert.equal(registry.encloses('/srv'), true);
  });
});
