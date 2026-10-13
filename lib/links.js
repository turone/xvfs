'use strict';

const path = require('node:path');
const { PathTrie, foldName } = require('./rules.js');

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
// system compares them so (`caseless`: Windows, macOS; foldName folds a
// little more than they do, and a case-sensitive volume there compares
// less, which only refuses more). A link is an attribute of its path that
// holds down it, kept in a trie of names as a place's rules are
// (rules.js): a node for each known link and each directory above one, so
// a path whose prefix has no node is decided without looking further.
class LinkIndex {
  #P;
  #win32;
  #fold;
  #split;
  // The known links, by key: what list() hands a worker.
  #links = new Set();
  // Below its root, a node for each root of the file system (`/`, `c:\`, a
  // UNC share), then one for each name; `link`: a known link is there.
  #trie = new PathTrie(() => ({ children: null, link: false }));
  // The key of a directory every known link lies below (appRoot), with a
  // separator after it, or null: a path without `..` that begins with it
  // is read as one string (#plain); a link added elsewhere turns that off.
  #floor = null;
  // The names of the floor, and its node once a link below it is known.
  #floorNames = null;
  #floorNode = null;
  // How many links the index has come to know: it grows by one with each.
  #generation = 0;

  // `floor`: see #floor. `caseless`: compare without case.
  constructor(P = path, options = {}) {
    const { floor = null, caseless = P.sep === '\\' } = options;
    this.#P = P;
    const win32 = P.sep === '\\';
    this.#win32 = win32;
    this.#fold = caseless ? foldName : (s) => s;
    this.#split = win32 ? /[\\/]+/ : /\/+/;
    if (floor !== null) {
      const key = this.#key(floor);
      this.#floor = key.endsWith(P.sep) ? key : key + P.sep;
      this.#floorNames = this.#namesOf(key);
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
    return this.#trie.find(this.#namesOf(key)) !== null;
  }

  #key(p) {
    return this.#fold(this.#P.resolve(p));
  }

  // The names of a key in the trie: its root, then each name below it.
  #namesOf(key) {
    const root = this.#rootOf(key);
    const names = [root];
    if (key.length > root.length) {
      for (const name of key.slice(root.length).split(this.#P.sep)) {
        names.push(name);
      }
    }
    return names;
  }

  // Known from now on; its key when it was not known yet, else null.
  add(p) {
    const key = this.#key(p);
    if (this.#links.has(key)) return null;
    if (this.#floor !== null && !key.startsWith(this.#floor)) {
      this.#floor = null;
      this.#floorNode = null;
    }
    this.#links.add(key);
    this.#generation++;
    this.#trie.ensure(this.#namesOf(key)).link = true;
    if (this.#floor !== null && this.#floorNode === null) {
      this.#floorNode = this.#trie.find(this.#floorNames);
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
  // name by name, each name's node found below the one before it.
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
    const top = PathTrie.child(this.#trie.root, this.#fold(root));
    const nodes = []; // nodes[j]: the node of the path's first j + 1 names
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === '' || part === '.') continue;
      if (part === '..') {
        nodes.pop();
        continue;
      }
      const above = nodes.length === 0 ? top : nodes.at(-1);
      const node =
        above === null ? null : PathTrie.child(above, this.#fold(part));
      nodes.push(node);
      if (i === leaf) break;
      if (node?.link) return true;
      if (i > lastUp && node === null) return false;
    }
    return false;
  }

  // crosses for a path spelled from the floor down with no name that
  // starts with a dot (`.`, `..` among them), no doubled separator and, on
  // Windows, no trailing one (node:fs drops it): the whole path folded at
  // once, its names below the floor walked from the floor's node. null for
  // any other path.
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
    let node = this.#floorNode;
    if (node === null) return false;
    for (let start = prefix.length; start < key.length;) {
      const at = key.indexOf(sep, start);
      const last = at === -1;
      node = PathTrie.child(node, key.slice(start, last ? key.length : at));
      if (node === null) return false;
      if (node.link && !(own && last)) return true;
      if (last) return false;
      start = at + 1;
    }
    return false;
  }
}

module.exports = { LinkIndex };
