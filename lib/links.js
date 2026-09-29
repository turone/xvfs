'use strict';

const path = require('node:path');

const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const COLON = 0x3a;

// LinkIndex — the links known inside the places' directories, for strict
// routing with `links: 'deny'`: every entry node:fs reports as a symbolic
// link (a junction and a directory symlink on Windows included), found by a
// walk of each such place at initialize() (scanner.js, linksOf), kept by the
// watcher where one runs, and by the patched node:fs as it makes a link or
// moves one. A native operation on a place's disk whose path passes through
// a known link is refused (crosses); an ordinary path costs a few lookups in
// memory and never a disk call.
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
// which only refuses more). A known link is dropped the first time a path
// through it finds a directory or a file in its place: its lstat is the
// only disk call, and only on a path that would be refused. A name that
// holds nothing keeps it — the patch may be making it still.
class LinkIndex {
  #P;
  #win32;
  #fold;
  #split;
  #lstat;
  // Known links, and for each directory above one the number below it: a
  // path whose prefix has none below is decided without looking further.
  #links = new Set();
  #above = new Map();
  // The key of a directory every known link lies below (appRoot), with a
  // separator after it, or null: a path without `..` that begins with it
  // is read as one string (#plain); a link added elsewhere turns that off.
  #floor = null;

  // `lstat`: the disk's, to check a known link; none in unit use.
  // `floor`: see #floor. `caseless`: compare without case.
  constructor(P = path, options = {}) {
    const { lstat = null, floor = null, caseless = P.sep === '\\' } = options;
    this.#P = P;
    const win32 = P.sep === '\\';
    this.#win32 = win32;
    this.#fold = caseless ? (s) => s.toLowerCase() : (s) => s;
    this.#split = win32 ? /[\\/]+/ : /\/+/;
    this.#lstat = lstat;
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

  // Every directory above `key`, nearest first, down to the root.
  *#ancestors(key) {
    const P = this.#P;
    for (let dir = P.dirname(key); ; dir = P.dirname(dir)) {
      yield dir;
      if (P.dirname(dir) === dir) return;
    }
  }

  // Known from now on; its key.
  add(p) {
    const key = this.#key(p);
    if (this.#links.has(key)) return key;
    if (this.#floor !== null && !key.startsWith(this.#floor)) {
      this.#floor = null;
    }
    this.#links.add(key);
    for (const dir of this.#ancestors(key)) {
      this.#above.set(dir, (this.#above.get(dir) || 0) + 1);
    }
    return key;
  }

  // No longer a link: a directory or a file took its name.
  delete(p) {
    this.#forget(this.#key(p));
  }

  #forget(key) {
    if (!this.#links.delete(key)) return;
    for (const dir of this.#ancestors(key)) {
      const count = this.#above.get(dir) - 1;
      if (count > 0) this.#above.set(dir, count);
      else this.#above.delete(dir);
    }
  }

  // A rename from `from` to `to`: every link at or below `from` — known, or
  // among `found` there on disk — is known under `to` too, `to` itself but
  // with `self` false (a place's own directory); their keys. The old ones
  // stay until a directory or a file takes their names (#still).
  moved(from, to, found = [], self = true) {
    const P = this.#P;
    const key = this.#key(from);
    const prefix = key.endsWith(P.sep) ? key : key + P.sep;
    const target = P.resolve(to);
    const links = new Set(this.#links);
    for (const link of found) links.add(this.#key(link));
    const added = [];
    for (const link of links) {
      if (link === key) {
        if (self) added.push(this.add(target));
      } else if (link.startsWith(prefix)) {
        added.push(this.add(P.join(target, link.slice(prefix.length))));
      }
    }
    return added;
  }

  // Whether an operation on `p` — as the OS opens it (#absolute) — passes
  // through a known link: any name of it that is a known link and a link
  // there now, but its last one with `own` (lstat, unlink, rename: an
  // operation on the link itself). Each name is checked before a `..`
  // after it applies, so `link/..` counts as through the link, as the OS
  // resolves it on POSIX; a trailing separator, `.` or `..` follows the
  // name before it.
  //
  // With `below`, a directory, each name strictly below it is asked of the
  // disk instead (lstat): for when a link may be missing from the index —
  // one another thread made, its message not here yet (kernel.js). An lstat
  // that fails but for a name that is not there counts as a link.
  //
  // A plain path below the floor is read as one string (#plain); any other
  // name by name, each name's key extending the one before it.
  crosses(p, own = false, below = null) {
    if (this.#links.size === 0 && below === null) return false;
    const P = this.#P;
    const abs = this.#absolute(p);
    if (below === null && this.#floor !== null) {
      const plain = this.#plain(abs, own);
      if (plain !== null) return plain;
    }
    // On Windows node:fs folds `..` and drops a trailing separator before
    // the OS: the path it opens is resolved.
    const opened = this.#win32 ? P.resolve(abs) : abs;
    const given = this.#rootOf(opened);
    const parts = opened.slice(given.length).split(this.#split);
    const root = this.#win32 ? given.replace(/\//g, '\\') : given;
    let under = null;
    if (below !== null) {
      under = this.#key(below);
      if (!under.endsWith(P.sep)) under += P.sep;
    }
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
    const names = [];
    const keys = []; // keys[j]: the key of names[0..j]
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === '' || part === '.') continue;
      if (part === '..') {
        names.pop();
        keys.pop();
        continue;
      }
      const key =
        keys.length === 0
          ? this.#fold(root + part)
          : keys.at(-1) + P.sep + this.#fold(part);
      names.push(part);
      keys.push(key);
      if (i === leaf) break;
      if (under !== null) {
        if (!key.startsWith(under)) continue;
        const stats = this.#stats(root + names.join(P.sep));
        if (stats === null || stats?.isSymbolicLink()) return true;
        if (stats === undefined && i > lastUp) return false;
        continue;
      }
      if (this.#links.has(key)) {
        if (this.#still(key, root + names.join(P.sep))) return true;
      }
      if (i > lastUp && !this.#above.has(key)) return false;
    }
    return false;
  }

  // crosses for a path spelled from the floor down with no name that
  // starts with a dot (`.`, `..` among them) and no doubled separator: its
  // key is the whole path folded, and the key of each name is the part of
  // it before the separator after that name. null for any other path, and
  // where folding changes the length (the caller's spelling of a name is
  // then no slice of the path).
  #plain(abs, own) {
    let key = this.#fold(abs);
    if (key.length !== abs.length) return null;
    const sep = this.#P.sep;
    if (this.#win32 && key.includes('/')) key = key.replaceAll('/', sep);
    const prefix = this.#floor;
    if (!key.startsWith(prefix)) return null;
    const from = prefix.length - 1;
    if (key.includes(`${sep}.`, from) || key.includes(sep + sep, from)) {
      return null;
    }
    // node:fs drops a trailing separator on Windows: the general path does.
    if (this.#win32 && key.endsWith(sep)) return null;
    let at = key.indexOf(sep, prefix.length);
    for (;;) {
      const end = at === -1 ? key.length : at;
      const name = key.slice(0, end);
      const followed = !(own && at === -1);
      if (followed && this.#links.has(name)) {
        if (this.#still(name, abs.slice(0, end))) return true;
      }
      if (at === -1 || at === key.length - 1) return false;
      if (!this.#above.has(name)) return false;
      at = key.indexOf(sep, at + 1);
    }
  }

  // The lstat of `p`: undefined when nothing is there, null when it fails.
  #stats(p) {
    try {
      return this.#lstat(p, { throwIfNoEntry: false });
    } catch {
      return null;
    }
  }

  // Whether a known link, as the caller spells it, is a link there now. A
  // directory or a file in its place drops it; nothing there keeps it, and
  // nothing is crossed — the patch adds a link before its call makes it,
  // so one checked in between would be lost for good. Without an lstat
  // (unit use) a known link stays one.
  #still(key, spelled) {
    if (this.#lstat === null) return true;
    const stats = this.#stats(spelled);
    if (stats === null || stats?.isSymbolicLink()) return true;
    if (stats !== undefined) this.#forget(key);
    return false;
  }
}

module.exports = { LinkIndex };
