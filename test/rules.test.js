'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PlaceRules, PathTrie, foldName } = require('../lib/rules.js');

// The rules of a place on their own (lib/rules.js): the settings in force
// at a key, and what the rules below a key restrict. Their effect on the
// places: rules-fs.test.js.

const FS = Object.freeze({
  ext: ['html', 'css', 'js'],
  writable: true,
  zeroCopy: false,
  compress: null,
  script: null,
  fallback: null,
});
const REQUIRE = Object.freeze({ ext: ['js'], compile: [] });
const placeOf = (rules, fs = FS) => ({
  fs,
  require: REQUIRE,
  import: null,
  rules,
});

describe('PlaceRules: the settings at a key', () => {
  const rules = new PlaceRules(
    placeOf({
      '/private': { fs: false },
      '/private/public': { fs: {} },
      '/static': { fs: { ext: ['html', 'css'] }, require: false },
      '/system': { fs: { writable: false } },
      '/system/tmp': { fs: { writable: true } },
      '/deep/a/b': { require: false },
    }),
  );

  it("a key no rule holds has the place's own", () => {
    for (const key of [
      '',
      '/',
      '/a.js',
      '/systemx/a',
      '/deep/a',
      '/deep/x/b',
    ]) {
      const at = rules.at(key);
      assert.equal(at.fs, FS, key);
      assert.equal(at.require, REQUIRE, key);
      assert.equal(at.import, null, key);
    }
  });

  it('a rule holds at its path and below it, the deepest last', () => {
    assert.equal(rules.at('/private').fs, null);
    assert.equal(rules.at('/private/x.html').fs, null);
    assert.equal(rules.at('/private/x.html').require, REQUIRE);
    assert.deepEqual(rules.at('/static/a.html').fs.ext, ['html', 'css']);
    assert.equal(rules.at('/static/a.js').require, null);
    assert.equal(rules.at('/system/a').fs.writable, false);
    assert.equal(rules.at('/system/tmp/a').fs.writable, true);
    assert.equal(rules.at('/deep/a/b/c.js').require, null);
    assert.equal(rules.at('/deep/a/b/c.js').fs, FS);
  });

  it('a domain given again below a rule that turned it off is on from what it had', () => {
    const at = rules.at('/private/public/a.html').fs;
    assert.deepEqual(at.ext, FS.ext);
    assert.equal(at.writable, true);
    const kept = new PlaceRules(
      placeOf({
        '/a': { fs: { writable: false } },
        '/a/b': { fs: false },
        '/a/b/c': { fs: {} },
      }),
    );
    assert.equal(kept.at('/a/b/x').fs, null);
    assert.equal(kept.at('/a/b/c/x').fs.writable, false, "/a's own");
  });

  it('a key in either form; a trailing separator names the same path', () => {
    assert.equal(rules.at('private/x').fs, null);
    assert.equal(rules.at('/system/').fs.writable, false);
    assert.equal(rules.below('/system/'), rules.below('/system'));
  });

  it('names compare exactly, or without case where the place does', () => {
    assert.equal(rules.at('/PRIVATE/x').fs, FS, 'exact');
    const caseless = new PlaceRules(
      placeOf({ '/Private': { fs: false } }),
      true,
    );
    assert.equal(caseless.at('/PRIVATE/x').fs, null);
    assert.equal(caseless.at('/private').fs, null);
    assert.equal(caseless.at('/privatex').fs, FS);
    assert.equal(caseless.below('/'), 'EACCES');
  });
});

describe('PlaceRules: the scope of a key', () => {
  it('the settings at a key, and whether a rule lies below it', () => {
    const rules = new PlaceRules(
      placeOf({ '/a/b': { fs: false }, '/c': { fs: { writable: false } } }),
    );
    const of = (key) => {
      const { settings, below } = rules.scope(key);
      return [settings === rules.at(key), below];
    };
    assert.deepEqual(of(''), [true, true]);
    assert.deepEqual(of('/'), [true, true]);
    assert.deepEqual(of('/a'), [true, true]);
    assert.deepEqual(of('/a/'), [true, true]);
    assert.deepEqual(of('/a/b'), [true, false]);
    assert.deepEqual(of('/a/b/x'), [true, false]);
    assert.deepEqual(of('/a/x'), [true, false]);
    assert.deepEqual(of('/c'), [true, false]);
    assert.deepEqual(of('/d'), [true, false]);
    assert.equal(rules.scope('/c/x').settings.fs.writable, false);
  });
});

describe('PlaceRules: what the rules below a key restrict', () => {
  it('EACCES where a rule hides, else EROFS where one forbids writes, else nothing', () => {
    const rules = new PlaceRules(
      placeOf({
        '/a/private': { fs: false },
        '/b/locked': { fs: { writable: false } },
        '/c/open': { fs: { writable: true } },
        '/d/fewer': { fs: { ext: ['html'] } },
        '/e/norequire': { require: false },
      }),
    );
    assert.equal(rules.below('/'), 'EACCES');
    assert.equal(rules.below('/a'), 'EACCES');
    assert.equal(rules.below('/b'), 'EROFS');
    assert.equal(rules.below('/c'), null, 'a rule that lets more through');
    assert.equal(rules.below('/d'), 'EACCES', 'fewer extensions');
    assert.equal(rules.below('/e'), 'EACCES', 'a domain off');
    assert.equal(rules.below('/a/private'), null, 'below it, not itself');
    assert.equal(rules.below('/x'), null);
    assert.equal(rules.below('/a/private/deeper'), null);
  });

  it('relative to the settings above the rule', () => {
    const rules = new PlaceRules(
      placeOf({
        '/ro': { fs: { writable: false } },
        '/ro/still': { fs: { writable: false } },
        '/hidden': { fs: false },
        '/hidden/again': { fs: false },
      }),
    );
    assert.equal(rules.below('/ro'), null, 'read-only under read-only');
    assert.equal(rules.below('/hidden'), null, 'off under off');
    const any = new PlaceRules(
      placeOf({ '/s': { fs: { ext: ['html'] } } }, { ...FS, ext: null }),
    );
    assert.equal(any.below('/'), 'EACCES', 'a list under every extension');
    const fallback = new PlaceRules(
      placeOf(
        { '/t': { fs: { fallback: 'deny' } } },
        { ...FS, fallback: 'disk' },
      ),
    );
    assert.equal(fallback.below('/'), 'EACCES', 'the disk territory refused');
    assert.equal(fallback.at('/t/x').fs.fallback, 'deny');
  });
});

describe('PathTrie, foldName', () => {
  it('finds what it holds, makes what it lacks', () => {
    const trie = new PathTrie(() => ({ children: null, mark: 0 }));
    trie.ensure(['a', 'b']).mark = 1;
    assert.equal(trie.find(['a', 'b']).mark, 1);
    assert.equal(trie.find(['a']).mark, 0);
    assert.equal(trie.find(['a', 'c']), null);
    assert.equal(PathTrie.child(trie.root, 'a'), trie.find(['a']));
    assert.equal(PathTrie.child(trie.find(['a', 'b']), 'x'), null);
  });

  it('folds case, a final sigma as a sigma, and one normalization form', () => {
    assert.equal(foldName('ΛΟΓΟΣ'), foldName('λογοσ'));
    assert.equal(foldName('λογος'), 'λογοσ');
    assert.equal(foldName('CAFÉ'), 'café');
    assert.equal(foldName('café'), foldName('café'));
  });

  it("a place whose disk takes names in any case folds its rules' names", () => {
    const { Place } = require('../lib/place.js');
    const config = { ...placeOf({ '/Private': { fs: false } }) };
    config.name = 'site';
    config.origin = 'disk';
    const caseless = new Place(config, '/app', true);
    assert.equal(caseless.settingsAt('/PRIVATE/x.html').fs, null);
    assert.equal(caseless.settingsAt('/private/x.html').fs, null);
    const exact = new Place(config, '/app', false);
    assert.equal(exact.settingsAt('/PRIVATE/x.html').fs, FS);
    const virtual = new Place({ ...config, origin: 'virtual' }, '/app', true);
    assert.equal(virtual.settingsAt('/PRIVATE/x.html').fs, FS, 'exact keys');
  });
});
