'use strict';

const { Containment, namespaced, namesOf, departs } = require('./registry.js');

const COLON = 58;
const A = 65;
const Z = 90;

// Aliases — what the disk says about spellings of managed paths that the
// strings do not show, for a registry built for strict. Routing stays
// lexical; this is what it learns from the disk, each thing once, through
// `realpath` — realpath.native as disk.js captured it, which the kernel
// hands in:
//   - appRoot's real path, when the kernel is built. An appRoot spelled
//     through a link, a subst drive or 8.3 names has another spelling, its
//     real one: a path in or below it is an alias (covers), a directory
//     above it encloses the places (encloses), and on Windows a short name
//     where a path leaves it may stand for it (departs), as for appRoot —
//     a name of appRoot's own 8.3 spelling there is appRoot's, and a path
//     that mixes the two spellings is an alias.
//   - on Windows, what a drive letter other than appRoot's names, the first
//     time a path on it is asked about: a share (a mapped drive, whose root
//     resolves to a UNC path), or a directory on appRoot's line — appRoot,
//     one above it or below it (subst) — makes every path on it an alias.
//     A letter that names nothing is asked again; one that names something
//     keeps its answer, so an alias made later is not seen.
//   - where a native operation in the disk territory of a place really
//     lands (territory): realpath of its path, each time, and of the
//     place's directory, once — the place's own only off appRoot's real
//     line or at its own name there (misplaced).
// A failure of realpath other than a missing path leaves the answer
// unknown, which is an alias: strict refuses what it cannot place.
class Aliases {
  #P;
  #realpath;
  // Names compared as the platform compares them.
  #fold;
  // appRoot's real path, and as Containment compares it.
  #realRoot;
  #line;
  // The real path of each place's directory, by its path: a Containment,
  // or null where it is unknown or not the place's own (#owns).
  #places = new Map();
  // Whether that differs from appRoot as spelled: then it is an alias.
  #aliased;
  // Windows, the real path on a drive and aliased: its names (departs),
  // and appRoot's as given where they spell it name for name — an 8.3
  // spelling of it — so that a path along either leaves it alike.
  #names = null;
  #given = null;
  // Windows: appRoot's own drive letter (upper case), and what each other
  // letter names once asked: true for an alias.
  #drive = 0;
  #drives = null;

  constructor(appRoot, P, realpath) {
    this.#P = P;
    this.#realpath = realpath;
    const real = this.real(appRoot);
    this.#realRoot = real;
    this.#line = new Containment(P, real);
    const win32 = P.sep === '\\';
    this.#fold = win32 ? (s) => s.toLowerCase() : (s) => s;
    this.#aliased = this.#fold(real) !== this.#fold(appRoot);
    if (!win32) return;
    this.#drives = new Array(Z - A + 1);
    if (appRoot.charCodeAt(1) === COLON) {
      this.#drive = appRoot.charCodeAt(0) & ~0x20;
    }
    if (this.#aliased && real.charCodeAt(1) === COLON) {
      this.#names = namesOf(real);
      if (appRoot.charCodeAt(1) === COLON) {
        const given = namesOf(appRoot);
        if (given.length === this.#names.length) this.#given = given;
      }
    }
  }

  // `p` made absolute without folding `..`: realpath resolves `..` from the
  // real directory before it, past a symbolic link, as the OS does when it
  // opens the path — path.resolve would fold `d/link/../x` to `d/x` first,
  // hiding where `link` leads (a POSIX bypass of the disk proof). On Windows
  // node folds `..` lexically before the syscall, and realpath.native does
  // the same, so nothing there changes. A relative path takes the cwd, as
  // path.relative-based routing does.
  #absolute(p) {
    const P = this.#P;
    return P.isAbsolute(p) ? p : `${process.cwd()}${P.sep}${p}`;
  }

  // The real path of `p`, resolved as the OS resolves it (#absolute): realpath
  // of it or, where it does not exist, of its nearest existing ancestor with
  // the rest of `p` after it. Throws what realpath throws but a missing path.
  real(p) {
    const P = this.#P;
    let at = this.#absolute(p);
    const rest = [];
    for (;;) {
      try {
        const real = this.#realpath(at);
        return rest.length === 0 ? real : P.join(real, ...rest.reverse());
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
        const up = P.dirname(at);
        if (up === at) throw err;
        rest.push(P.basename(at));
        at = up;
      }
    }
  }

  // Where a native operation on `p`, in the disk territory of the place
  // whose directory is `root`, really lands, when strict lets it: the real
  // path of `p` — for a path to create, of its nearest existing ancestor
  // with the rest after it — in the real path of the place's directory, or
  // off appRoot's real line and on no share or namespace path; else null.
  // A link out of the place into another place, appRoot or a directory
  // above it is refused; one to elsewhere reaches what a path there
  // reaches anyway — but not, `placed`, for an operation on a whole tree,
  // which may go only where the place's directory really is. What realpath
  // cannot answer is refused.
  territory(root, p, placed = false) {
    let real;
    try {
      real = this.real(p);
    } catch {
      return null;
    }
    const own = this.#place(root);
    if (own !== null && own.belowAbsolute(real) !== null) return real;
    if (placed || namespaced(real)) return null;
    const off =
      this.#line.belowAbsolute(real) === null && !this.#line.encloses(real);
    return off ? real : null;
  }

  // The real path of the directory `root` of a place when it is not the
  // place's own (#owns) — a link to another place, to appRoot, above it —
  // else null. Throws what realpath throws but a missing path.
  misplaced(root) {
    const real = this.real(root);
    return this.#owns(root, real) ? null : real;
  }

  // The real path of a place's directory, once: null where realpath cannot
  // answer, or where it is not the place's own.
  #place(root) {
    let own = this.#places.get(root);
    if (own !== undefined) return own;
    own = null;
    try {
      const real = this.real(root);
      if (this.#owns(root, real)) own = new Containment(this.#P, real);
    } catch {
      // Unknown: only a path off appRoot's line is proven.
    }
    this.#places.set(root, own);
    return own;
  }

  // Whether `real`, the real path of the place directory `root`, is the
  // place's own: off appRoot's real line — a directory elsewhere, a link
  // out of appRoot — or appRoot's real path and the place's name. Anywhere
  // else on that line it is another place's disk, appRoot or a directory
  // above it, which would hold the others.
  #owns(root, real) {
    const line = this.#line;
    if (line.belowAbsolute(real) === null && !line.encloses(real)) return true;
    const own = this.#P.join(this.#realRoot, this.#P.basename(root));
    return this.#fold(real) === this.#fold(own);
  }

  // Whether appRoot's real path encloses `p` (a resolved one): appRoot
  // itself or a directory above it, in the real spelling.
  encloses(p) {
    return this.#aliased && this.#line.encloses(p);
  }

  // Whether `abs`, a resolved path outside appRoot as spelled, may name
  // appRoot's line in a spelling the disk knows: in or below the real
  // spelling, leaving it at a short name, or on a drive that names a share
  // or the line.
  covers(abs) {
    if (this.#aliased) {
      if (this.#line.belowAbsolute(abs) !== null) return true;
      const names = this.#names;
      if (names !== null && departs(names, abs, this.#given)) return true;
    }
    return this.#drives !== null && this.#onAlias(abs);
  }

  // Windows: whether `abs` lies on a drive letter that is an alias.
  #onAlias(abs) {
    if (abs.charCodeAt(1) !== COLON) return false;
    const letter = abs.charCodeAt(0) & ~0x20;
    if (letter === this.#drive || letter < A || letter > Z) return false;
    const known = this.#drives[letter - A];
    if (known !== undefined) return known;
    const alias = this.#classify(letter);
    if (alias !== null) this.#drives[letter - A] = alias;
    return alias === true;
  }

  // What drive `letter` names: true for a share or a directory on
  // appRoot's line, false for its own volume's root or a directory off the
  // line, null for no drive at all (asked again next time).
  #classify(letter) {
    const drive = `${String.fromCharCode(letter)}:\\`;
    let root;
    try {
      root = this.#realpath(drive);
    } catch (err) {
      return err.code === 'ENOENT' ? null : true;
    }
    if (namespaced(root)) return true;
    if (root.toLowerCase() === drive.toLowerCase()) return false;
    return this.#line.encloses(root) || this.#line.below(root) !== null;
  }
}

module.exports = { Aliases };
