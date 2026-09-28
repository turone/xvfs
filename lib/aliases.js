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
//     where a path leaves it may stand for it (departs), as for appRoot.
//   - on Windows, what a drive letter other than appRoot's names, the first
//     time a path on it is asked about: a share (a mapped drive, whose root
//     resolves to a UNC path), or a directory on appRoot's line — appRoot,
//     one above it or below it (subst) — makes every path on it an alias.
//     A letter that names nothing is asked again; one that names something
//     keeps its answer, so an alias made later is not seen.
// A failure of realpath other than a missing path leaves the answer
// unknown, which is an alias: strict refuses what it cannot place.
class Aliases {
  #P;
  #realpath;
  // appRoot's real path, as Containment compares it.
  #line;
  // Whether that differs from appRoot as spelled: then it is an alias.
  #aliased;
  // Windows, the real path on a drive and aliased: its names (departs).
  #names = null;
  // Windows: appRoot's own drive letter (upper case), and what each other
  // letter names once asked: true for an alias.
  #drive = 0;
  #drives = null;

  constructor(appRoot, P, realpath) {
    this.#P = P;
    this.#realpath = realpath;
    const real = this.real(appRoot);
    this.#line = new Containment(P, real);
    const win32 = P.sep === '\\';
    const fold = (s) => (win32 ? s.toLowerCase() : s);
    this.#aliased = fold(real) !== fold(appRoot);
    if (!win32) return;
    this.#drives = new Array(Z - A + 1);
    if (appRoot.charCodeAt(1) === COLON) {
      this.#drive = appRoot.charCodeAt(0) & ~0x20;
    }
    if (this.#aliased && real.charCodeAt(1) === COLON) {
      this.#names = namesOf(real);
    }
  }

  // The real path of `p`, resolved: realpath of it or, where it does not
  // exist, of its nearest existing ancestor with the rest of `p` after it.
  // Throws what realpath throws but a missing path.
  real(p) {
    const P = this.#P;
    let at = P.resolve(p);
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
      if (this.#names !== null && departs(this.#names, abs)) return true;
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
