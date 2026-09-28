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
