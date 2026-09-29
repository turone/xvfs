'use strict';

const path = require('node:path');

const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const COLON = 0x3a;

// LinkIndex — the links known inside the places' directories, for strict
// routing with `links: 'deny'`: every entry node:fs reports as a symbolic
// link (a junction and a directory symlink on Windows included), met by
// the scan of each such place at initialize() or found by a walk
// (scanner.js), and added by the watcher where one runs. A native call on
// a place's disk whose path passes through a known link is refused
// (crosses); an ordinary path costs a few lookups in memory and never a
// disk call. Under strict xvfs makes, removes and moves no link it can see
// on a place's disk, so nothing in the process changes what the index knows:
// it only grows, and a link another process removes stays refused until
// the kernel restarts.
//
// What it does not know it does not refuse: a link another process makes
// between two watcher events — or at any time in a place no watcher runs
// for — is outside what this mode guarantees, the environment owner's
// responsibility. `links: 'verify'` proves the real path of each call
// instead (aliases.js), at the cost of a realpath each.
//
// Paths are absolute and normalized — on Windows as node:fs resolves them
// before the OS opens them — and compared without case where the file
// system compares them so (`caseless`: Windows, macOS; toLowerCase folds
// more than they do, and a case-sensitive volume there compares less,
// which only refuses more).
class LinkIndex {
  #P;
  #win32;
  #fold;
  #split;
  // Known links, and every directory above one: a path whose prefix has no
  // link below is decided without looking further.
  #links = new Set();
  #above = new Set();
  // The key of a directory every known link lies below (appRoot), with a
  // separator after it, or null: a path without `..` that begins with it
  // is read as one string (#plain); a link added elsewhere turns that off.
  #floor = null;
  // How many links the index has come to know: it grows by one with each.
  #generation = 0;

  // `floor`: see #floor. `caseless`: compare without case.
  constructor(P = path, options = {}) {
    const { floor = null, caseless = P.sep === '\\' } = options;
    this.#P = P;
    const win32 = P.sep === '\\';
    this.#win32 = win32;
    this.#fold = caseless ? (s) => s.toLowerCase() : (s) => s;
    this.#split = win32 ? /[\\/]+/ : /\/+/;
    if (floor !== null) {
      const key = this.#key(floor);
      this.#floor = key.endsWith(P.sep) ? key : key + P.sep;
    }
  }

  // `p` absolute, as the OS opens it: on Windows node:fs resolves a path
  // before the call — a drive-relative (`C:x`), root-relative (`\x`) or
  // UNC one included — which keeps no `..`; on POSIX the kernel resolves
  // `..` past a link, so it stays, from the cwd for a relative path.
  #absolute(p) {
    const P = this.#P;
    if (!this.#win32) return P.isAbsolute(p) ? p : `${process.cwd()}/${p}`;
    const c = p.charCodeAt(2);
    if (p.charCodeAt(1) === COLON && (c === BACKSLASH || c === SLASH)) {
      return p;
    }
    return P.resolve(p);
  }

  // The root of an absolute path — `/`, `C:\`, a UNC share — as given.
  #rootOf(abs) {
    if (!this.#win32) {
      return abs.charCodeAt(0) === SLASH ? '/' : this.#P.parse(abs).root;
    }
    const c = abs.charCodeAt(2);
    if (abs.charCodeAt(1) === COLON && (c === BACKSLASH || c === SLASH)) {
      return abs.slice(0, 3);
    }
    return this.#P.parse(abs).root;
  }

  get size() {
    return this.#links.size;
  }

  get generation() {
    return this.#generation;
  }

  // The known links, as they are kept: what a snapshot hands a worker.
  list() {
    return [...this.#links];
  }

  // A path as the index keeps it: resolved, and on Windows without case.
  key(p) {
    return this.#key(p);
  }

  // Whether a known link lies at `key` (as key() gives it) or below it.
  holds(key) {
    return this.#above.has(key) || this.#links.has(key);
  }

  #key(p) {
    return this.#fold(this.#P.resolve(p));
  }

  // Known from now on; its key when it was not known yet, else null.
  add(p) {
    const key = this.#key(p);
    if (this.#links.has(key)) return null;
    if (this.#floor !== null && !key.startsWith(this.#floor)) {
      this.#floor = null;
    }
    this.#links.add(key);
    this.#generation++;
    const P = this.#P;
    for (let dir = P.dirname(key); !this.#above.has(dir);) {
      this.#above.add(dir);
      const up = P.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return key;
  }

  // Whether an operation on `p` — as the OS opens it (#absolute) — passes
  // through a known link: any name of it that is a known link, but its last
  // one with `own` (lstat, readlink, the l* forms: an operation on the link
  // itself). Each name is checked before a `..` after it applies, so
  // `link/..` counts as through the link, as the OS resolves it on POSIX; a
  // trailing separator, `.` or `..` follows the name before it.
  //
  // A plain path below the floor is read as one string (#plain); any other
  // name by name, each name's key extending the one before it.
  crosses(p, own = false) {
    if (this.#links.size === 0) return false;
    const P = this.#P;
    const abs = this.#absolute(p);
    if (this.#floor !== null) {
      const plain = this.#plain(abs, own);
      if (plain !== null) return plain;
    }
    // On Windows node:fs folds `..` and drops a trailing separator before
    // the OS: the path it opens is resolved.
    const opened = this.#win32 ? P.resolve(abs) : abs;
    const given = this.#rootOf(opened);
    const parts = opened.slice(given.length).split(this.#split);
    const root = this.#win32 ? given.replace(/\//g, '\\') : given;
    // The last name the operation does not follow, and the last `..`: past
    // it, a prefix with no known link below ends the check.
    let leaf = -1;
    let lastUp = -1;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '..') lastUp = i;
    }
    const tail = parts.at(-1);
    if (own && tail !== '' && tail !== '.' && tail !== '..') {
      leaf = parts.length - 1;
    }
    const keys = []; // keys[j]: the key of the path's first j + 1 names
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === '' || part === '.') continue;
      if (part === '..') {
        keys.pop();
        continue;
      }
      const key =
        keys.length === 0
          ? this.#fold(root + part)
          : keys.at(-1) + P.sep + this.#fold(part);
      keys.push(key);
      if (i === leaf) break;
      if (this.#links.has(key)) return true;
      if (i > lastUp && !this.#above.has(key)) return false;
    }
    return false;
  }

  // crosses for a path spelled from the floor down with no name that
  // starts with a dot (`.`, `..` among them), no doubled separator and, on
  // Windows, no trailing one (node:fs drops it): its key is the whole path
  // folded, and the key of each name is the part of it before the
  // separator after that name. null for any other path.
  #plain(abs, own) {
    let key = this.#fold(abs);
    const sep = this.#P.sep;
    if (this.#win32 && key.includes('/')) key = key.replaceAll('/', sep);
    const prefix = this.#floor;
    if (!key.startsWith(prefix)) return null;
    const from = prefix.length - 1;
    if (key.includes(`${sep}.`, from) || key.includes(sep + sep, from)) {
      return null;
    }
    if (this.#win32 && key.endsWith(sep)) return null;
    let at = key.indexOf(sep, prefix.length);
    for (;;) {
      const name = key.slice(0, at === -1 ? key.length : at);
      if (!(own && at === -1) && this.#links.has(name)) return true;
      if (at === -1 || at === key.length - 1) return false;
      if (!this.#above.has(name)) return false;
      at = key.indexOf(sep, at + 1);
    }
  }
}

module.exports = { LinkIndex };
