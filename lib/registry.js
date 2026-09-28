'use strict';

const path = require('node:path');
const { INDEXED } = require('./config.js');

const WIN = process.platform === 'win32';

// A path that ends in a separator names a directory, as on POSIX — on every
// platform for what the VFS serves or stores; node:fs keeps its own rules.
const TRAILING = WIN ? /[\\/]$/ : /\/$/;
const namesDirectory = (filePath) => TRAILING.test(filePath);

const BACKSLASH = 92;
const COLON = 58;
const QUESTION = 63;

// Whether a resolved win32 path holds at `at` what path.win32.resolve
// makes of the NT prefix `\??\`: a rooted name `??`, which no file name
// can hold.
const ntPrefixed = (abs, at) =>
  abs.charCodeAt(at) === QUESTION &&
  abs.charCodeAt(at + 1) === QUESTION &&
  (abs.length === at + 2 || abs.charCodeAt(at + 2) === BACKSLASH);

// Whether a resolved win32 path is in a UNC or namespace form: two
// backslashes first — `\\server\share\…`, an admin share `\\localhost\C$\…`,
// `\\?\…`, `\\.\…`, as path.win32.resolve keeps them from any spelling with
// `/` or `\`, and a relative path through a cwd on a share — or the NT
// prefix `\??\`, which it resolves to a rooted `??`: `\??\…` where the cwd
// has no drive, `C:\??\…` where it has one, whoever resolved it (the module
// hooks resolve a specifier first). Such a path can name a file below
// appRoot in a spelling appRoot does not share; which file Windows makes
// of it is never asked.
const namespaced = (abs) => {
  if (abs.charCodeAt(0) === BACKSLASH) {
    return abs.charCodeAt(1) === BACKSLASH || ntPrefixed(abs, 1);
  }
  return abs.charCodeAt(1) === COLON && ntPrefixed(abs, 3);
};

// Whether a resolved win32 path holds NTFS stream syntax: a `:` past the
// colon of its drive — `a.txt::$DATA`, `dir::$INDEX_ALLOCATION\…`,
// `dir:$I30:$INDEX_ALLOCATION\…`, `x:stream`. No file name holds a `:`:
// Windows opens a stream of the file or directory the name before it
// names, and its main stream is that file itself — a spelling of it the
// strings do not show. A relative `x:stream` is no stream: path.resolve
// puts it on drive X.
const streamed = (abs) =>
  abs.indexOf(':', abs.charCodeAt(1) === COLON ? 2 : 0) !== -1;

// Whether a name has the form NTFS gives a short (8.3) name: a base of at
// most eight characters that ends in `~` and digits, then at most three
// after one dot — `PROGRA~1`, `INDEX~1.HTM`, `AB12CD~1` (the hashed form
// past four collisions), `~$DOC~1.DOC` — in any case. Such a name may stand
// for any long name of its directory, which only the disk knows; a long
// name of that form is taken for one too.
const SHORT_NAME = /^(?=[^.]{2,8}(?:\.[^.]{1,3})?$)[^.]*~\d+(?:\.|$)/;
const shortName = (name) => SHORT_NAME.test(name);

// Whether a resolved win32 path, or a part of one, holds such a name.
const hasShortName = (p) =>
  p.indexOf('~') !== -1 && p.split('\\').some(shortName);

// The names of a resolved win32 path on a drive, lower-cased as
// Containment compares them: what `departs` compares a path with.
const namesOf = (root) => root.replace(/\\$/, '').toLowerCase().split('\\');

// Whether abs, a resolved win32 path outside the root whose `names` these
// are, leaves the root's spelling at a name in short-name form — which may
// stand for the root's own name there, that is for the root or a directory
// above it. Past a name that differs from the root's, in any case, the path
// lies in a directory that is no ancestor of the root, where a short name
// names an entry of its own; on another drive the drive is that name. Past
// all of the root's names, as below it, any short name is one.
const departs = (names, abs) => {
  if (abs.indexOf('~') === -1) return false;
  const own = abs.split('\\');
  for (let i = 0; i < own.length; i++) {
    if (i === names.length) return own.slice(i).some(shortName);
    if (own[i].toLowerCase() !== names[i]) return shortName(own[i]);
  }
  return false;
};

// `a` and `b`, of one length, equal but for the case of ASCII letters: how
// a Windows file system compares a name with a place's, which is ASCII. It
// equates no other character with an ASCII letter — lower-casing would
// take the Kelvin sign for `k`.
const asciiCaseless = (a, b) => {
  for (let i = 0; i < a.length; i++) {
    const x = a.charCodeAt(i);
    if (x === b.charCodeAt(i)) continue;
    const lower = x | 0x20;
    if (lower < 97 || lower > 122 || lower !== (b.charCodeAt(i) | 0x20)) {
      return false;
    }
  }
  return true;
};

// Whether P.resolve(p) gives p back, for sure: an absolute path in the
// form it returns — a drive letter, ':' and '\' on win32 (no UNC), '/' on
// posix — alone, or then names, each after one separator, none of them '.'
// or '..' and none holding a separator of the flavor (on win32 '/' is one
// too), so neither an empty name nor a trailing separator. Most paths the
// router is handed come from path.join or path.resolve and take no
// P.resolve again.
const RESOLVED_WIN32 = /^[A-Za-z]:(?:\\|(?:\\(?!\.\.?(?:\\|$))[^\\/]+)+)$/;
const RESOLVED_POSIX = /^(?:\/|(?:\/(?!\.\.?(?:\/|$))[^/]+)+)$/;
const resolvedWin32 = (p) => typeof p === 'string' && RESOLVED_WIN32.test(p);
const resolvedPosix = (p) => typeof p === 'string' && RESOLVED_POSIX.test(p);
const resolvedFor = (P) => (P.sep === '\\' ? resolvedWin32 : resolvedPosix);

// Lexical containment in `root`, a resolved path: what P.relative(root,
// P.resolve(p)) says of p, computed from the strings — P is path.win32 or
// path.posix, on any platform, so both are tested everywhere.
// Only a real `..` component leaves root: `..private`, `...data` or
// `file..js` are ordinary names routed by the Place rules. `root + sep` is
// a prefix, compared on win32 after the lower-casing path.win32.relative
// applies to both paths; the part below is cut from p as given, so the
// registry matches a place's name by its own rule. What path.relative
// treats apart it answers itself: a lower-casing that changes a length (it
// compares segment by segment then) and, on win32, a path off a drive
// (see #onDrive). A class, not closures: one shape for every instance
// keeps the hot path as fast in a process that holds several kernels.
class Containment {
  #P;
  #win32;
  #resolved;
  #root;
  #prefix;
  #parent;
  #folded;
  #foldedPrefix;
  #exact;

  constructor(P, root) {
    this.#P = P;
    this.#win32 = P.sep === '\\';
    this.#resolved = resolvedFor(P);
    this.#root = root;
    this.#prefix = root.endsWith(P.sep) ? root : root + P.sep;
    this.#parent = '..' + P.sep;
    this.#folded = this.#fold(root);
    this.#foldedPrefix = this.#fold(this.#prefix);
    // A root whose lower-casing changes its length, or off a drive:
    // path.relative only.
    this.#exact = this.#folded.length === root.length && this.#onDrive(root);
  }

  // p as P.resolve gives it: p itself when in that form already.
  absolute(p) {
    return this.#resolved(p) ? p : this.#P.resolve(p);
  }

  // The part of p below root, '' for root itself, null outside.
  below(p) {
    return this.belowAbsolute(this.absolute(p));
  }

  // below(p) for abs = absolute(p), which the caller may need as well.
  // Only the head of `abs`, as long as root and a separator, is folded;
  // `abs` is cut where it ends: right while folding keeps the head's
  // length — path.relative gives the same answer segment by segment when
  // the rest changes length.
  belowAbsolute(abs) {
    if (this.#exact && this.#onDrive(abs)) {
      const n = this.#prefix.length;
      const deeper = abs.length > n;
      const head = this.#fold(deeper ? abs.slice(0, n) : abs);
      if (head.length === (deeper ? n : abs.length)) {
        if (!deeper) return head === this.#folded ? '' : null;
        return head === this.#foldedPrefix ? this.#inside(abs.slice(n)) : null;
      }
    }
    return this.#inside(this.#P.relative(this.#root, abs));
  }

  // True for root and every directory above it. Here root is cut, where
  // the folded `abs` ends; path.relative, segment by segment, gives the
  // same answer when folding changes the length of `abs`.
  encloses(p) {
    const abs = this.absolute(p);
    if (this.#exact && this.#onDrive(abs)) {
      const head = this.#fold(abs);
      if (head === this.#folded) return true;
      const above = abs.endsWith(this.#P.sep) ? head : head + this.#P.sep;
      if (!this.#folded.startsWith(above)) return false;
      return this.#inside(this.#root.slice(above.length)) !== null;
    }
    return this.#inside(this.#P.relative(abs, this.#root)) !== null;
  }

  #fold(s) {
    return this.#win32 ? s.toLowerCase() : s;
  }

  // Whether path.relative compares a resolved path as it is: every one on
  // posix, on win32 one on a drive (X:\…). path.win32.relative resolves
  // both paths again, which a UNC or namespace path may not survive
  // (\\?\C:\app\..\.. resolves to \\?\, that to D:\?), and trims their
  // leading separators (\\C:\app\x is x under C:\app).
  #onDrive(s) {
    if (!this.#win32) return true;
    return s.charCodeAt(1) === COLON && s.charCodeAt(2) === BACKSLASH;
  }

  #inside(rel) {
    const outside =
      rel === '..' || rel.startsWith(this.#parent) || this.#P.isAbsolute(rel);
    return outside ? null : rel;
  }
}

// The '/'-separated names a recursive listing of `base` gives: for the
// entry `name` of directory `parent`, what P.relative(base, P.join(parent,
// name)) says with '/' for P.sep, read from the strings — `name` itself in
// base; below it, the rest of parent past base and a separator, then
// `name`. That is its answer where parent is in the form P.resolve returns
// (resolvedFor) and lies in or below what P.resolve makes of base, itself
// in that form — so any spelling of base will do — and names are what
// listings hold (no separator, never '.' or '..'); anything else asks
// path.relative. Each directory's parent is taken apart once.
const listedNames = (P, base) => {
  const resolved = resolvedFor(P);
  const home = resolved(base) ? base : P.resolve(base);
  const plain = resolved(home);
  const under = home.endsWith(P.sep) ? home : home + P.sep;
  let parent;
  let prefix = null; // of `parent`: '' in base, 'a/b/' below it
  return (at, name) => {
    if (at !== parent) {
      parent = at;
      prefix = null;
      if (plain && at === home) prefix = '';
      else if (plain && resolved(at) && at.startsWith(under)) {
        prefix = at.slice(under.length).split(P.sep).join('/') + '/';
      }
    }
    if (prefix !== null) return prefix + name;
    return P.relative(base, P.join(at, name)).split(P.sep).join('/');
  };
};

// A place's key from the rest of a path past its mount: '/'-separated.
const keyWin32 = (rel) => rel.replace(/\\/g, '/');
const keyPosix = (rel) => rel;

// appRoot itself: the boundary, never the root of a place.
const APP_ROOT = Object.freeze({ place: null, key: null, root: true });
// What no place owns below appRoot (route).
const NOBODY = Object.freeze({ place: null, key: null });

// PlaceRegistry — owns places and maps absolute paths to (place, key).
// The first path segment under appRoot is the mount and names the place,
// compared as the platform's file systems compare names — P, path.win32 or
// path.posix, says which, once: on POSIX exactly; on Windows without the
// case of ASCII letters, as appRoot is (Containment), so `appRoot\RO` is
// place `ro` and no spelling of a place routes past it. Place names are
// unique in any case (config.js). A key keeps the case it is given.
// Built for strict, on Windows it owns to nobody a UNC or namespace path
// outside appRoot (namespaced) — only an appRoot given in such a form
// itself has paths of that form below it — a path with NTFS stream syntax
// (streamed), below appRoot or not, and a name in short-name form
// (shortName) below appRoot or where a path leaves appRoot's spelling
// (departs). With `aliases` (aliases.js) — what the disk says, which the
// kernel builds for strict — it owns to nobody what they cover too: the
// real spelling of appRoot, a drive that names its line or a share.

class PlaceRegistry {
  #containment;
  #sep;
  #toKey;
  // Windows under strict: whether a spelling the strings may not tell
  // apart — a UNC or namespace form outside appRoot, a stream anywhere, a
  // short name that may stand for appRoot or a name below it — is owned by
  // nobody.
  #foreign;
  // Windows, appRoot on a drive: a UNC path below it is path.relative's.
  #driveRoot;
  // Windows under strict, appRoot on a drive: its names (departs).
  #names = null;
  // Windows: the places by the length of their names, for #named.
  #byLength = null;
  // Aliases the disk knows of, or null.
  #aliases;

  constructor(appRoot, P = path, strict = false, aliases = null) {
    this.appRoot = P.resolve(appRoot);
    this.places = new Map(); // name → Place
    this.#containment = new Containment(P, this.appRoot);
    this.#sep = P.sep;
    const win32 = P.sep === '\\';
    this.#toKey = win32 ? keyWin32 : keyPosix;
    this.#foreign = win32 && strict;
    this.#driveRoot = win32 && this.appRoot.charCodeAt(1) === COLON;
    if (win32) this.#byLength = [];
    if (this.#foreign && this.#driveRoot) this.#names = namesOf(this.appRoot);
    this.#aliases = aliases;
  }

  register(place) {
    this.places.set(place.name, place);
    if (this.#byLength === null) return;
    const { length } = place.name;
    const same = [...this.places.values()].filter(
      (p) => p.name.length === length,
    );
    this.#byLength[length] = same;
  }

  get(name) {
    return this.places.get(name) || null;
  }

  all() {
    return [...this.places.values()];
  }

  // Absolute path → routing decision, without touching the disk:
  //   null                     outside appRoot — ordinary Node
  //   { place: null, key: null, root: true }  appRoot itself
  //   { place, key }           owned by a place; key is '/'-separated with a
  //                            leading '/', '' for the mount root itself
  //   { place: null, key: null }  under appRoot but owned by nobody; and,
  //                            under strict, what aliases cover outside
  //                            it — on Windows also a UNC or namespace
  //                            path outside it, a path with NTFS stream
  //                            syntax anywhere, a short name below it or
  //                            where a path leaves its spelling
  // The third case is a managed denial at every depth: appRoot is the strict
  // routing boundary, so an unmanaged root-level file is as unroutable as a
  // file deep inside an unmanaged directory. Files the process legitimately
  // needs (entry point, package metadata) belong outside appRoot or in an
  // explicit node-default / disk place. A UNC or namespace path may name a
  // file below appRoot in another spelling (`\\?\C:\app\…`,
  // `\\localhost\C$\app\…`), and so may a stream (`C:\app::$INDEX_ALLOCATION\
  // …`, `…\a.txt::$DATA`), a short name (`C:\APP~1\…`, `…\INDEX~1.HTM`), the
  // real path of an appRoot spelled through a link or a drive that names it
  // (aliases), so strict denies them the same way; the checks read the path
  // as resolved, or the part below appRoot, and without strict nothing is
  // asked. The mount is cut at the first separator — a resolved path, and
  // path.relative's answer, have no other — and only a place's key is
  // converted. The exact name is looked up first: another case costs only a
  // path no place owns by its own name.
  route(filePath) {
    const abs = this.#containment.absolute(filePath);
    const rel = this.#containment.belowAbsolute(abs);
    if (rel === null) {
      if (this.#foreign && this.#foreignForm(abs)) return NOBODY;
      return this.#aliases?.covers(abs) ? NOBODY : null;
    }
    // A UNC server named like a drive: path.relative trims the leading
    // separators, so `\\C:\app\x` is below `C:\app` to it. It is no path
    // there, and no place owns it.
    if (this.#driveRoot && abs.charCodeAt(0) === BACKSLASH) return NOBODY;
    if (this.#foreign && (rel.indexOf(':') !== -1 || hasShortName(rel))) {
      return NOBODY;
    }
    if (rel === '') return APP_ROOT;
    const slash = rel.indexOf(this.#sep);
    const mount = slash === -1 ? rel : rel.slice(0, slash);
    const place = this.places.get(mount) ?? this.#named(mount);
    if (!place) return NOBODY;
    return { place, key: slash === -1 ? '' : this.#toKey(rel.slice(slash)) };
  }

  // Windows under strict: whether abs, a path outside appRoot, is in a form
  // that may name a path below it: a UNC or namespace path, a stream, a
  // short name where it leaves appRoot's spelling.
  #foreignForm(abs) {
    if (namespaced(abs) || streamed(abs)) return true;
    return this.#names !== null && departs(this.#names, abs);
  }

  // Windows: the place `mount` names in another case (asciiCaseless).
  #named(mount) {
    const same = this.#byLength?.[mount.length];
    if (same === undefined) return null;
    return same.find((place) => asciiCaseless(mount, place.name)) ?? null;
  }

  // True for appRoot and every directory above it — in its real spelling
  // too, where aliases know one: a walk from there enters the places.
  encloses(filePath) {
    if (this.#containment.encloses(filePath)) return true;
    return this.#aliases?.encloses(filePath) ?? false;
  }
}

const deny = (code) => ({ kind: 'deny', code });
const PASSTHROUGH = Object.freeze({ kind: 'passthrough' });
const ROOT = Object.freeze({ kind: 'root' });
const UNSUPPORTED = Object.freeze({ kind: 'unsupported' });
const CROSSING = Object.freeze({ kind: 'crossing' });
const CROSSING_FILE = Object.freeze({ kind: 'crossing', file: true });
const NOT_A_DIRECTORY = Object.freeze({ kind: 'deny', code: 'ENOTDIR' });

// FsRouter — turns an absolute path into one routing decision so adapters
// never interpret config themselves.
//
// read(absPath) →
//   { kind: 'file', place, key }   published source visible to the fs domain
//   { kind: 'dir',  place, key }   implicit directory of an indexed place
//   { kind: 'root' }               appRoot under strict: a managed root that
//                                  lists the enabled places and nothing else
//   { kind: 'disk', place, key }   disk territory of `fs.fallback: 'disk'`:
//                                  original node:fs, except that a listing
//                                  comes from the place, which never lists a
//                                  raw file of an extension it caches
//   { kind: 'passthrough' }        original node:fs handles it; under
//                                  strict, on the disk of a place — a disk
//                                  or node-default place, a disk-backed
//                                  entry — with `place`: the kernel proves
//                                  where the path really lies first
//   { kind: 'deny', code }         EACCES under strict or `fs.fallback`;
//                                  ENOTDIR for a served file named with a
//                                  trailing separator
//
// mutate(absPath) →
//   { kind: 'store', place, key }  mutation owned by the place's store: a
//                                  per-thread Map, or the main kernel for a
//                                  shared virtual place (asynchronous, see
//                                  `place.store.sync`); a path named with a
//                                  trailing separator keeps it as a slash
//                                  on its key: a directory (see PlaceFs)
//   { kind: 'passthrough' }        disk write (disk-origin, disk, node-default),
//                                  under strict with `place`
//   { kind: 'deny', code }         EACCES (strict, appRoot itself included) /
//                                  EROFS (read-only place)
//
// copy(absPath, recursive) → where the raw input of a copy's source lives:
//   { kind: 'passthrough' }        on disk at that path — outside appRoot,
//                                  a passthrough place, a disk-origin place
//                                  (its raw source of truth, prepared or
//                                  not) or its disk territory — under strict
//                                  with `place` where a place holds it
//   { kind: 'canonical', place, key }  in the VFS: an unprepared virtual or
//                                  SEA entry, whose canonical bytes are its
//                                  raw input
//   { kind: 'deny', code }         refused as a read
//   { kind: 'unsupported' }        no raw input to hand on — a prepared
//                                  virtual or SEA entry, a directory of the
//                                  places — and, for a recursive copy, a
//                                  managed path: a native walk reads and
//                                  writes raw files past the routing; under
//                                  strict any place's, whose walk would
//                                  follow a link out of it
//
// rename(fromPath, toPath) → a native rename, both paths having passed the
// mutation routing; it moves the raw file:
//   { kind: 'passthrough' }        node:fs renames it within its territory:
//                                  one indexed place, or none
//   { kind: 'crossing' }           it enters or leaves an indexed place:
//                                  node:fs moves a file, the raw source of
//                                  truth, into the destination's policy; a
//                                  directory, whose descendants would all
//                                  change policy at once, is unsupported
//   { kind: 'crossing', file: true }  under strict, it leaves any place or
//                                  enters an indexed one: a regular file
//                                  only — a directory or a link would take
//                                  a link of the place's disk out of it,
//                                  a link into appRoot from outside
//   { kind: 'deny', code }         the source is hidden: moving it would
//                                  make it readable
//   { kind: 'unsupported' }        a tree that holds places
//
// link(fromPath, toPath) → a hard link names one physical file twice, while
// a place gives every name its own canonical content and companions:
//   { kind: 'passthrough' }        node:fs links it
//   { kind: 'deny', code }         a hidden source, a refused destination;
//                                  under strict any source in managed
//                                  territory (linksInto)
//   { kind: 'unsupported' }        either name in an indexed place
//
// linksInto(path) → under strict, whether a new link to the path would
// name managed territory past the routing (a symbolic link's target, a
// hard link's file)
//
// unknown() → a node:fs function the patch does not know (fs-surface.js),
// whatever its arguments, which may name paths no routing ever sees:
//   { kind: 'passthrough' }        node:fs runs it, as it always did
//   { kind: 'unsupported' }        under strict: refused before it runs

class FsRouter {
  // Under strict, the passthrough of each place's disk (#disk).
  #native = new WeakMap();

  constructor(registry, strict) {
    this.registry = registry;
    this.strict = strict;
  }

  // node:fs itself, on the disk of `place`: without strict a passthrough
  // like any other; under strict one that names the place, whose directory
  // the kernel proves the path really lies in before any native call.
  #disk(place) {
    if (!this.strict) return PASSTHROUGH;
    let route = this.#native.get(place);
    if (route === undefined) {
      route = Object.freeze({ kind: 'passthrough', place });
      this.#native.set(place, route);
    }
    return route;
  }

  read(filePath) {
    const route = this.registry.route(filePath);
    if (!route) return PASSTHROUGH;
    if (route.root) return this.strict ? ROOT : PASSTHROUGH;
    const { place, key } = route;
    if (!place) return this.strict ? deny('EACCES') : PASSTHROUGH;
    if (!place.config.fs) return this.strict ? deny('EACCES') : PASSTHROUGH;
    if (!INDEXED.has(place.provider)) return this.#disk(place);
    const served = this.#served(place, key, filePath);
    if (served !== null) return served;
    if (place.isDirectory(key)) return { kind: 'dir', place, key };
    return this.#miss(place, key, filePath);
  }

  // The route of `key` when it is a published source the fs domain sees,
  // else null.
  #served(place, key, filePath) {
    const file = place.files.get(key);
    if (!file || !place.visible('fs', key)) return null;
    if (namesDirectory(filePath)) return NOT_A_DIRECTORY;
    // Disk-backed entries (oversize, retainRaw:false) are read from disk.
    if (file.data === null) return this.#disk(place);
    return { kind: 'file', place, key };
  }

  // A path an indexed place does not serve. A disk-origin place decides by
  // `fs.fallback`: 'deny' refuses it; 'disk' serves it from disk — under
  // strict only outside the extensions the place caches, which stay
  // VFS-only so a raw file never stands in for its canonical (prepared)
  // content; the non-strict default stays permissive, except that a path
  // naming a published source held in memory in another case, which a
  // case-insensitive disk would serve raw, is served as that source
  // (Place.spelling). A place with no directory behind it (virtual, sea)
  // follows the mode.
  #miss(place, key, filePath) {
    const { fallback } = place.config.fs;
    if (fallback === 'deny') return deny('EACCES');
    if (fallback === 'disk' && !this.strict) {
      const same = place.spelling(key);
      const served = same === null ? null : this.#served(place, same, filePath);
      return served ?? { kind: 'disk', place, key };
    }
    if (fallback === 'disk' && !place.cached(key)) {
      return { kind: 'disk', place, key };
    }
    return this.strict ? deny('EACCES') : PASSTHROUGH;
  }

  mutate(filePath) {
    const route = this.registry.route(filePath);
    if (!route) return PASSTHROUGH;
    if (route.root) return this.strict ? deny('EACCES') : PASSTHROUGH;
    const { place, key } = route;
    if (!place) return this.strict ? deny('EACCES') : PASSTHROUGH;
    const { fs, provider } = place.config;
    if (!fs) return this.strict ? deny('EACCES') : PASSTHROUGH;
    if (provider === 'node-default') return this.#disk(place);
    if (!fs.writable) return deny('EROFS');
    // Disk-origin writes land on disk; the watcher republishes them.
    if (place.virtual) {
      const slash = key && namesDirectory(filePath) ? '/' : '';
      return { kind: 'store', place, key: key + slash };
    }
    return this.#disk(place);
  }

  copy(filePath, recursive) {
    const route = this.read(filePath);
    if (route.kind === 'deny') return route;
    if (recursive) {
      const managed =
        this.#indexed(filePath) ||
        this.registry.encloses(filePath) ||
        (this.strict && route.place !== undefined);
      return managed ? UNSUPPORTED : PASSTHROUGH;
    }
    if (route.kind === 'dir' || route.kind === 'root') return UNSUPPORTED;
    if (route.kind === 'disk') return this.#disk(route.place);
    if (route.kind !== 'file') return route;
    const { place, key } = route;
    if (!place.virtual && place.provider !== 'sea') return this.#disk(place);
    if (place.prepared(key)) return UNSUPPORTED;
    return { kind: 'canonical', place, key };
  }

  rename(fromPath, toPath) {
    const src = this.read(fromPath);
    if (src.kind === 'deny') return src;
    if (this.registry.encloses(fromPath)) return UNSUPPORTED;
    if (!this.strict) {
      const stays = this.#indexed(fromPath) === this.#indexed(toPath);
      return stays ? PASSTHROUGH : CROSSING;
    }
    const from = this.registry.route(fromPath)?.place ?? null;
    const stays =
      from === null
        ? this.#indexed(toPath) === null
        : from === (this.registry.route(toPath)?.place ?? null);
    return stays ? PASSTHROUGH : CROSSING_FILE;
  }

  link(fromPath, toPath) {
    const src = this.read(fromPath);
    if (src.kind === 'deny') return src;
    const dst = this.mutate(toPath);
    if (dst.kind === 'deny') return dst;
    const managed = this.#indexed(fromPath) || this.#indexed(toPath);
    if (managed || src.kind !== 'passthrough') return UNSUPPORTED;
    return this.linksInto(fromPath) ? deny('EACCES') : PASSTHROUGH;
  }

  // Under strict, whether a new link to this path — a symbolic link's
  // target as the OS resolves it, a hard link's existing file — would name
  // managed territory past the routing: a path below appRoot, appRoot
  // itself or a directory above it, in any spelling the registry knows.
  // A read through such a link reaches the places natively; a second name
  // for a place's file escapes its place (a writable name for a read-only
  // place's raw file).
  linksInto(filePath) {
    if (!this.strict) return false;
    const route = this.registry.route(filePath);
    return route !== null || this.registry.encloses(filePath);
  }

  unknown() {
    return this.strict ? UNSUPPORTED : PASSTHROUGH;
  }

  // The indexed place that owns a path, or null.
  #indexed(filePath) {
    const place = this.registry.route(filePath)?.place;
    return INDEXED.has(place?.provider) ? place : null;
  }
}

module.exports = {
  PlaceRegistry,
  FsRouter,
  Containment,
  namesDirectory,
  namespaced,
  streamed,
  shortName,
  namesOf,
  departs,
  resolvedFor,
  listedNames,
};
