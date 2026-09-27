'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PlaceFiles, dirOf } = require('../lib/place.js');

// The directory index of a place projection must say exactly what a scan
// of its keys says, whatever sequence of sets and deletes built it.

const SEP = '\u0000';

// Deterministic pseudo-random numbers (a linear congruential generator).
const random = (seed) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

// What a scan of `files` says about directory `dir`.
const scan = (files, dir) => {
  const prefix = dir + '/';
  const below = new Map();
  for (const key of files.keys()) {
    if (key.includes(SEP) || !key.startsWith(prefix)) continue;
    const parts = key.slice(prefix.length).split('/');
    for (let i = 1; i <= parts.length; i++) {
      const path = prefix + parts.slice(0, i).join('/');
      // A key that is also a directory prefix of another key is both.
      if (i < parts.length) below.set(`${path}/`, true);
      else below.set(path, false);
    }
  }
  return below;
};

const indexed = (files, dir) => {
  const below = new Map();
  for (const [key, isDirectory] of files.below(dir)) {
    below.set(isDirectory ? `${key}/` : key, isDirectory);
  }
  return below;
};

const sorted = (map) => [...map].sort(([a], [b]) => (a < b ? -1 : 1));

describe('PlaceFiles: the directory index of a projection', () => {
  it('matches a scan after any sequence of sets and deletes', () => {
    const next = random(42);
    const pick = (list) => list[Math.floor(next() * list.length)];
    const names = ['a', 'b', 'c.txt', 'd.js'];
    const keyOf = () => {
      const depth = 1 + Math.floor(next() * 4);
      return '/' + Array.from({ length: depth }, () => pick(names)).join('/');
    };
    const files = new PlaceFiles();
    const dirs = ['', '/a', '/b', '/a/a', '/a/b', '/b/a', '/a/a/a', '/c.txt'];
    for (let step = 0; step < 3000; step++) {
      const key = keyOf();
      const roll = next();
      if (roll < 0.45) files.set(key, { step });
      else if (roll < 0.55) files.set(`${key}${SEP}fs:gzip`, { step });
      else if (roll < 0.95) files.delete(key);
      else if (roll < 0.96) files.clear();
      else files.set(key, { again: step }); // an update of a key it holds
      for (const dir of dirs) {
        const expected = scan(files, dir);
        assert.deepEqual(sorted(indexed(files, dir)), sorted(expected), dir);
        assert.equal(files.hasDirectory(dir), expected.size > 0, dir);
      }
    }
  });

  it('children lists what a directory holds directly', () => {
    const files = new PlaceFiles();
    for (const key of ['/a/x.txt', '/a/b/y.txt', '/a/b/z.txt', '/c.txt']) {
      files.set(key, {});
    }
    files.set(`/a/x.txt${SEP}fs:gzip`, {});
    assert.deepEqual(
      [...files.children('/a')],
      [
        ['/a/x.txt', false],
        ['/a/b', true],
      ],
    );
    assert.deepEqual(
      [...files.children('')],
      [
        ['/a', true],
        ['/c.txt', false],
      ],
    );
    files.delete('/a/b/y.txt');
    files.delete('/a/b/z.txt');
    assert.equal(files.hasDirectory('/a/b'), false, 'an emptied directory');
    assert.deepEqual([...files.children('/a')], [['/a/x.txt', false]]);
    files.delete('/a/x.txt');
    files.delete('/c.txt');
    assert.equal(files.hasDirectory(''), false);
    assert.equal(files.size, 1, 'only the companion is left');
  });

  // A case-insensitive disk holds one spelling of a name: so does the
  // projection built from it, and it finds that spelling from any other.
  it('caseless: a key the place does not hold finds its other spelling', () => {
    const files = new PlaceFiles(true);
    for (const key of ['/a.txt', '/Dir/Read.ME', '/b/C.TXT', '/\u00e4.txt']) {
      files.set(key, {});
    }
    files.set(`/a.txt${SEP}fs:gzip`, {});
    const spellings = [
      ['/A.TXT', '/a.txt'],
      ['/a.TxT', '/a.txt'],
      ['/dir/read.me', '/Dir/Read.ME'],
      ['/DIR/READ.ME', '/Dir/Read.ME'],
      ['/B/c.txt', '/b/C.TXT'],
      ['/\u00c4.TXT', '/\u00e4.txt'],
      ['/a.txt/x', null],
      ['/b.txt', null],
      [`/A.TXT${SEP}fs:gzip`, null],
    ];
    for (const [key, spelled] of spellings) {
      assert.equal(files.spelling(key), spelled, key);
    }
    files.delete('/Dir/Read.ME');
    files.delete('/a.txt');
    assert.equal(files.spelling('/dir/read.me'), null);
    assert.equal(files.spelling('/A.TXT'), null);
    assert.equal(files.spelling('/B/C.txt'), '/b/C.TXT');
    files.clear();
    assert.equal(files.spelling('/b/c.txt'), null);
  });

  // Lower-casing equates a few names NTFS keeps apart: İ and i̇, whose
  // lengths differ, the Kelvin sign and k. Such a name answers with the
  // published source, never with raw bytes (Place.spelling).
  it('caseless: spellings as lower-casing gives them, whatever the length', () => {
    const files = new PlaceFiles(true);
    files.set('/İ.txt', {});
    files.set('/k.txt', {});
    assert.equal(files.spelling('/i̇.txt'), '/İ.txt');
    assert.equal(files.spelling('/İ.TXT'), '/İ.txt');
    assert.equal(files.spelling('/I.txt'), null);
    assert.equal(files.spelling('/K.txt'), '/k.txt');
  });

  it('caseless: spellings follow any sequence of sets and deletes', () => {
    const next = random(7);
    const pick = (list) => list[Math.floor(next() * list.length)];
    const names = [
      ['a', 'A'],
      ['x.txt', 'X.TXT', 'x.TXT'],
      ['Dir', 'dir', 'DIR'],
    ];
    const spell = (name) => pick(names.find((n) => n.includes(name)));
    const files = new PlaceFiles(true);
    const held = new Map(); // lower-cased key → the spelling held
    const keyOf = () =>
      '/' +
      Array.from({ length: 1 + Math.floor(next() * 2) }, () =>
        pick(pick(names)),
      ).join('/');
    for (let step = 0; step < 2000; step++) {
      const key = keyOf();
      const lower = key.toLowerCase();
      if (next() < 0.6) {
        // As a disk does: another spelling of a name replaces the one held.
        if (held.has(lower)) files.delete(held.get(lower));
        files.set(key, {});
        held.set(lower, key);
      } else {
        files.delete(held.get(lower) ?? key);
        held.delete(lower);
      }
      const probe = key
        .split('/')
        .map((name) => name && spell(name))
        .join('/');
      const expected = held.get(probe.toLowerCase()) ?? null;
      const found = files.has(probe) ? null : files.spelling(probe);
      assert.equal(found, expected === probe ? null : expected, probe);
    }
  });

  it('a projection that is not caseless knows no other spelling', () => {
    const files = new PlaceFiles();
    files.set('/a.txt', {});
    files.set('/B.txt', {});
    assert.equal(files.spelling('/A.TXT'), null);
    assert.equal(files.spelling('/b.txt'), null);
  });

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
});
