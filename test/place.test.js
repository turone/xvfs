'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Place, dirOf } = require('../lib/place.js');
const { createTree } = require('../lib/tree.js');
const { CHANGES, eventsOf } = require('../lib/epoch.js');
const { VfsConfig } = require('../lib/config.js');

// A place's spellings: on a case-insensitive disk a disk-origin place
// finds a file it holds from any other spelling of its key (Place.spelling),
// its index following the files every commit creates and removes
// (Place.spelled, as the kernel calls it with what eventsOf() tells).

// Deterministic pseudo-random numbers (a linear congruential generator).
const random = (seed) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const SAB = new SharedArrayBuffer(16);

// A place of its own tree, `caseless` or not, and a commit of ops to it as
// the kernel's: the tree's changes, eventsOf() and Place.spelled() after.
const placeOf = (caseless = true, origin = 'disk') => {
  const config = new VfsConfig({
    places: {
      p: origin === 'disk' ? { fs: true } : { origin, fs: { writable: true } },
    },
  });
  const place = new Place(config.places[0], path.resolve('app'), caseless);
  place.tree = createTree({
    segments: new Map([[1, SAB]]),
    retireIds: { next: () => 1 },
  });
  let version = 0;
  const commit = (...ops) => {
    const result = place.tree.commit(ops, ++version, 0, CHANGES);
    const changes = eventsOf(place.tree, result.changes);
    place.spelled(changes.created, changes.removed, changes.moved);
  };
  return { place, commit };
};

const file = {
  size: 1,
  mtimeMs: 0,
  representations: [[0, { segmentId: 1, offset: 0, length: 1 }]],
};
const write = (key) => ['write', key, file, { parents: true }];

describe('Place: spellings', () => {
  // A case-insensitive disk holds one spelling of a name: so does the
  // tree built from it, and the place finds that spelling from any other.
  it('caseless: a key the place does not hold finds its other spelling', () => {
    const { place, commit } = placeOf();
    commit(...['/a.txt', '/Dir/Read.ME', '/b/C.TXT', '/ä.txt'].map(write));
    const spellings = [
      ['/A.TXT', '/a.txt'],
      ['/a.TxT', '/a.txt'],
      ['/dir/read.me', '/Dir/Read.ME'],
      ['/DIR/READ.ME', '/Dir/Read.ME'],
      ['/B/c.txt', '/b/C.TXT'],
      ['/Ä.TXT', '/ä.txt'],
      ['/a.txt/x', null],
      ['/b.txt', null],
      ['/DIR', null],
    ];
    for (const [key, spelled] of spellings) {
      assert.equal(place.spelling(key), spelled, key);
    }
    commit(['unlink', '/Dir/Read.ME'], ['unlink', '/a.txt']);
    assert.equal(place.spelling('/dir/read.me'), null);
    assert.equal(place.spelling('/A.TXT'), null);
    assert.equal(place.spelling('/B/C.txt'), '/b/C.TXT');
    commit(['remove', '/b']);
    assert.equal(
      place.spelling('/b/c.txt'),
      null,
      'removed with its directory',
    );
  });

  // Lower-casing equates a few names NTFS keeps apart: İ and i̇, whose
  // lengths differ, the Kelvin sign and k. Such a name answers with the
  // published source, never with raw bytes (Place.spelling).
  it('caseless: spellings as lower-casing gives them, whatever the length', () => {
    const { place, commit } = placeOf();
    commit(write('/İ.txt'), write('/k.txt'));
    assert.equal(place.spelling('/i̇.txt'), '/İ.txt');
    assert.equal(place.spelling('/İ.TXT'), '/İ.txt');
    assert.equal(place.spelling('/I.txt'), null);
    assert.equal(place.spelling('/K.txt'), '/k.txt');
  });

  it('caseless: a file read from disk has no other spelling', () => {
    const { place, commit } = placeOf();
    const onDisk = { size: 9, mtimeMs: 0, representations: [] };
    commit(['write', '/Big.bin', onDisk]);
    assert.equal(place.spelling('/big.bin'), null);
  });

  it('caseless: spellings follow any sequence of writes and removals', () => {
    const next = random(7);
    const pick = (list) => list[Math.floor(next() * list.length)];
    const names = [
      ['a', 'A'],
      ['x.txt', 'X.TXT', 'x.TXT'],
    ];
    const spell = (name) => pick(names.find((n) => n.includes(name)));
    const { place, commit } = placeOf();
    const held = new Map(); // lower-cased key → the spelling held
    for (let step = 0; step < 2000; step++) {
      const key = '/' + pick(pick(names));
      const lower = key.toLowerCase();
      if (next() < 0.6) {
        // As a disk does: another spelling of a name replaces the one held.
        const ops = [];
        if (held.has(lower)) ops.push(['unlink', held.get(lower)]);
        ops.push(write(key));
        commit(...ops);
        held.set(lower, key);
      } else if (held.has(lower)) {
        commit(['unlink', held.get(lower)]);
        held.delete(lower);
      }
      const probe = '/' + spell(key.slice(1));
      const expected = held.get(probe.toLowerCase()) ?? null;
      const found = place.file(probe) ? null : place.spelling(probe);
      assert.equal(found, expected === probe ? null : expected, probe);
    }
  });

  it('caseless: a move takes the spellings below it along', () => {
    const { place, commit } = placeOf();
    commit(write('/Dir/A.txt'), write('/Dir/sub/B.txt'));
    commit(['mkdir', '/to'], ['move', '/Dir', '/to/Moved']);
    assert.equal(place.spelling('/dir/a.txt'), null);
    assert.equal(place.spelling('/to/moved/a.txt'), '/to/Moved/A.txt');
    assert.equal(place.spelling('/TO/MOVED/SUB/b.txt'), '/to/Moved/sub/B.txt');
  });

  it('a place that is not caseless knows no other spelling', () => {
    for (const [caseless, origin] of [
      [false, 'disk'],
      [true, 'virtual'],
    ]) {
      const { place, commit } = placeOf(caseless, origin);
      commit(write('/a.txt'), write('/B.txt'));
      assert.equal(place.spelling('/A.TXT'), null);
      assert.equal(place.spelling('/b.txt'), null);
    }
  });
});

describe('Place: keys', () => {
  it('directory keys have one form', () => {
    for (const [key, dir] of [
      ['', ''],
      ['/', ''],
      ['//', ''],
      ['a', '/a'],
      ['a/', '/a'],
      ['/a/b/', '/a/b'],
      ['/a/b', '/a/b'],
    ]) {
      assert.equal(dirOf(key), dir, JSON.stringify(key));
    }
  });

  it('a key finds its node with its leading slash or without', () => {
    const { place, commit } = placeOf(false);
    commit(write('/d/a.txt'));
    const node = place.node('/d/a.txt');
    assert.ok(node);
    assert.equal(place.node('d/a.txt'), node);
    assert.equal(place.file('d/a.txt'), place.tree.payloadOf(node));
    assert.equal(place.file('/d'), null, 'a directory is no file');
    assert.ok(place.isDirectory('d/'));
    assert.ok(place.isDirectory(''));
    assert.equal(place.node(42), null);
    place.tree = null;
    assert.equal(place.node('/d'), null, 'a closed place holds nothing');
    assert.equal(place.isDirectory(''), false);
  });
});
