'use strict';

const path = require('node:path');
const { INDEXED } = require('./config.js');

const WIN = process.platform === 'win32';
const toKey = WIN ? (rel) => rel.replace(/\\/g, '/') : (rel) => rel;

// A path that ends in a separator names a directory, as on POSIX — on every
// platform for what the VFS serves or stores; node:fs keeps its own rules.
const TRAILING = WIN ? /[\\/]$/ : /\/$/;
const namesDirectory = (filePath) => TRAILING.test(filePath);

const BACKSLASH = 92;
const COLON = 58;

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
// applies to both paths; the part below is cut from p as given, so a
// place's name still matches case-sensitively. What path.relative treats
// apart it answers itself: a lower-casing that changes a length (it
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

  // The part of p below root, '' for root itself, null outside. Only the
  // head of `abs`, as long as root and a separator, is folded; `abs` is cut
  // where it ends: right while folding keeps the head's length —
  // path.relative gives the same answer segment by segment when the rest
  // changes length.
  below(p) {
    const abs = this.#absolute(p);
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
    const abs = this.#absolute(p);
    if (this.#exact && this.#onDrive(abs)) {
      const head = this.#fold(abs);
      if (head === this.#folded) return true;
      const above = abs.endsWith(this.#P.sep) ? head : head + this.#P.sep;
      if (!this.#folded.startsWith(above)) return false;
      return this.#inside(this.#root.slice(above.length)) !== null;
    }
    return this.#inside(this.#P.relative(abs, this.#root)) !== null;
  }

  #absolute(p) {
    return this.#resolved(p) ? p : this.#P.resolve(p);
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
// `name`. That is its answer where base and parent are in the form
// P.resolve returns (resolvedFor) and names are what listings hold (no
// separator, never '.' or '..'); anything else asks path.relative. Each
// directory's parent is taken apart once.
const listedNames = (P, base) => {
  const resolved = resolvedFor(P);
  const plain = resolved(base);
  const under = base + P.sep;
  let parent;
  let prefix = null; // of `parent`: '' in base, 'a/b/' below it
  return (at, name) => {
    if (at !== parent) {
      parent = at;
      prefix = null;
      if (plain && at === base) prefix = '';
      else if (plain && resolved(at) && at.startsWith(under)) {
        prefix = at.slice(under.length).split(P.sep).join('/') + '/';
      }
    }
    if (prefix !== null) return prefix + name;
    return P.relative(base, P.join(at, name)).split(P.sep).join('/');
  };
};

// appRoot itself: the boundary, never the root of a place.
const APP_ROOT = Object.freeze({ place: null, key: null, root: true });

// PlaceRegistry — owns places and maps absolute paths to (place, key).
// The first path segment under appRoot is the mount and equals the place name.

class PlaceRegistry {
  #containment;

  constructor(appRoot) {
    this.appRoot = path.resolve(appRoot);
    this.places = new Map(); // name → Place
    this.#containment = new Containment(path, this.appRoot);
  }

  register(place) {
    this.places.set(place.name, place);
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
  //   { place: null, key: null }  under appRoot but owned by nobody
  // The third case is a managed denial at every depth: appRoot is the strict
  // routing boundary, so an unmanaged root-level file is as unroutable as a
  // file deep inside an unmanaged directory. Files the process legitimately
  // needs (entry point, package metadata) belong outside appRoot or in an
  // explicit node-default / disk place. The mount is cut at the first
  // separator — a resolved path, and path.relative's answer, have no other
  // — and only a place's key is converted.
  route(filePath) {
    const rel = this.#containment.below(filePath);
    if (rel === null) return null;
    if (rel === '') return APP_ROOT;
    const slash = rel.indexOf(path.sep);
    const mount = slash === -1 ? rel : rel.slice(0, slash);
    const place = this.places.get(mount);
    if (!place) return { place: null, key: null };
    return { place, key: slash === -1 ? '' : toKey(rel.slice(slash)) };
  }

  // True for appRoot and every directory above it: a walk from there
  // enters the places.
  encloses(filePath) {
    return this.#containment.encloses(filePath);
  }
}

const deny = (code) => ({ kind: 'deny', code });
const PASSTHROUGH = Object.freeze({ kind: 'passthrough' });
const ROOT = Object.freeze({ kind: 'root' });
const UNSUPPORTED = Object.freeze({ kind: 'unsupported' });
const CROSSING = Object.freeze({ kind: 'crossing' });
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
//   { kind: 'passthrough' }        original node:fs handles it
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
//   { kind: 'passthrough' }        disk write (disk-origin, disk, node-default)
//   { kind: 'deny', code }         EACCES (strict, appRoot itself included) /
//                                  EROFS (read-only place)
//
// copy(absPath, recursive) → where the raw input of a copy's source lives:
//   { kind: 'passthrough' }        on disk at that path — outside appRoot,
//                                  a passthrough place, a disk-origin place
//                                  (its raw source of truth, prepared or
//                                  not) or its disk territory
//   { kind: 'canonical', place, key }  in the VFS: an unprepared virtual or
//                                  SEA entry, whose canonical bytes are its
//                                  raw input
//   { kind: 'deny', code }         refused as a read
//   { kind: 'unsupported' }        no raw input to hand on — a prepared
//                                  virtual or SEA entry, a directory of the
//                                  places — and, for a recursive copy, a
//                                  managed path: a native walk reads and
//                                  writes raw files past the routing
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
//   { kind: 'deny', code }         the source is hidden: moving it would
//                                  make it readable
//   { kind: 'unsupported' }        a tree that holds places
//
// link(fromPath, toPath) → a hard link names one physical file twice, while
// a place gives every name its own canonical content and companions:
//   { kind: 'passthrough' }        node:fs links it
//   { kind: 'deny', code }         a hidden source, a refused destination
//   { kind: 'unsupported' }        either name in an indexed place

class FsRouter {
  constructor(registry, strict) {
    this.registry = registry;
    this.strict = strict;
  }

  read(filePath) {
    const route = this.registry.route(filePath);
    if (!route) return PASSTHROUGH;
    if (route.root) return this.strict ? ROOT : PASSTHROUGH;
    const { place, key } = route;
    if (!place) return this.strict ? deny('EACCES') : PASSTHROUGH;
    if (!place.config.fs) return this.strict ? deny('EACCES') : PASSTHROUGH;
    if (!INDEXED.has(place.provider)) return PASSTHROUGH;
    const file = place.files.get(key);
    if (file && place.visible('fs', key)) {
      if (namesDirectory(filePath)) return NOT_A_DIRECTORY;
      // Disk-backed entries (oversize, retainRaw:false) are read from disk.
      if (file.data === null) return PASSTHROUGH;
      return { kind: 'file', place, key };
    }
    if (place.isDirectory(key)) return { kind: 'dir', place, key };
    return this.#miss(place, key);
  }

  // A path an indexed place does not serve. A disk-origin place decides by
  // `fs.fallback`: 'deny' refuses it; 'disk' serves it from disk — under
  // strict only outside the extensions the place caches, which stay
  // VFS-only so a raw file never stands in for its canonical (prepared)
  // content; the non-strict default stays permissive. A place with no
  // directory behind it (virtual, sea) follows the mode.
  #miss(place, key) {
    const { fallback } = place.config.fs;
    if (fallback === 'deny') return deny('EACCES');
    if (fallback === 'disk' && (!this.strict || !place.cached(key))) {
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
    if (provider === 'node-default') return PASSTHROUGH;
    if (!fs.writable) return deny('EROFS');
    // Disk-origin writes land on disk; the watcher republishes them.
    if (place.virtual) {
      const slash = key && namesDirectory(filePath) ? '/' : '';
      return { kind: 'store', place, key: key + slash };
    }
    return PASSTHROUGH;
  }

  copy(filePath, recursive) {
    const route = this.read(filePath);
    if (route.kind === 'deny') return route;
    if (recursive) {
      const managed =
        this.#indexed(filePath) || this.registry.encloses(filePath);
      return managed ? UNSUPPORTED : PASSTHROUGH;
    }
    if (route.kind === 'dir' || route.kind === 'root') return UNSUPPORTED;
    if (route.kind !== 'file') return PASSTHROUGH;
    const { place, key } = route;
    if (!place.virtual && place.provider !== 'sea') return PASSTHROUGH;
    if (place.prepared(key)) return UNSUPPORTED;
    return { kind: 'canonical', place, key };
  }

  rename(fromPath, toPath) {
    const src = this.read(fromPath);
    if (src.kind === 'deny') return src;
    if (this.registry.encloses(fromPath)) return UNSUPPORTED;
    const stays = this.#indexed(fromPath) === this.#indexed(toPath);
    return stays ? PASSTHROUGH : CROSSING;
  }

  link(fromPath, toPath) {
    const src = this.read(fromPath);
    if (src.kind === 'deny') return src;
    const dst = this.mutate(toPath);
    if (dst.kind === 'deny') return dst;
    const managed = this.#indexed(fromPath) || this.#indexed(toPath);
    return managed || src.kind !== 'passthrough' ? UNSUPPORTED : PASSTHROUGH;
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
  resolvedFor,
  listedNames,
};
