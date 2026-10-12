'use strict';

const { bytecodeDomains } = require('./pipeline.js');
const { fsError, isDirectoryError } = require('./errors.js');

// VirtualStore — the node:fs semantics of a virtual place's mutations,
// written once: which checks run, in which order, and what each refusal is,
// against the place's tree (lib/tree.js), where a directory is a node of
// its own. Keys are canonical; errors are node:fs-shaped. A store executes
// them through seven hooks:
//
//   run(keys, fn)        runs fn — every check and the change it decides —
//                        in the turn of `keys`, or for null under a barrier
//                        of the whole place; returns what fn returns
//   create(key, publish) publishes a new version of `key` through publish(),
//                        called in the turn its hierarchy check passed; a
//                        publication that outlives the call keeps `key` in
//                        `creating` until it settles
//   createAll(keys, publish)
//                        the same for the keys of a set, published as one
//   publishRaw(key, raw) publishes raw input, prepared by the preparer of
//                        the key's extension
//   publishBatch(files, failOf)
//                        publishes the raw input of every [key, raw] of a
//                        set, each prepared once, with the directories it
//                        lacks, as one publication or none; a refusal about
//                        `key` is failOf(key)(code, detail), the set's
//   commit(ops, fail)    commits ops of the tree that change the structure
//                        only — mkdir, unlink, remove, rmdir, move — as one
//                        publication, at once; a refusal is fail(code)
//   move(ops, to, raw, mtimeMs, fail)
//                        commits `ops` and a write of `raw` under `to`
//                        through the pipeline, keeping `mtimeMs`, as one
//                        publication; a refusal of its publication is
//                        fail(code, detail), the rename's
//
// MapStore executes at once, on the thread's own tree; SabStore in the
// key's turn of the kernel's mutation queue, publishing through the kernel.
//
// `{ directory }`: a key was named with a trailing separator, so the
// operation takes a directory only — a file is ENOTDIR, as on POSIX —
// checked when it runs, never against a file written meanwhile.

// The keys whose publication has begun and not committed yet, with the
// directories above them, each by the number of such keys below it: a key
// in flight at, above or below a key is found in the depth of that key,
// never in the number of keys in flight — a set of thousands in flight
// costs the checks of other mutations nothing.
class KeysInFlight {
  #keys = new Set();
  #dirs = new Map(); // dir → keys in flight below it

  get size() {
    return this.#keys.size;
  }

  has(key) {
    return this.#keys.has(key);
  }

  // True iff a key in flight lies below the directory `dir`.
  below(dir) {
    return this.#dirs.has(dir);
  }

  add(key) {
    if (this.#keys.has(key)) return;
    this.#keys.add(key);
    this.#count(key, 1);
  }

  delete(key) {
    if (!this.#keys.delete(key)) return false;
    this.#count(key, -1);
    return true;
  }

  [Symbol.iterator]() {
    return this.#keys.values();
  }

  // Add `delta` to the count of every directory above `key`; a directory
  // no key in flight is below any more leaves the index.
  #count(key, delta) {
    let at = key.lastIndexOf('/');
    while (at > 0) {
      const dir = key.slice(0, at);
      const count = (this.#dirs.get(dir) ?? 0) + delta;
      if (count === 0) this.#dirs.delete(dir);
      else this.#dirs.set(dir, count);
      at = key.lastIndexOf('/', at - 1);
    }
  }
}

const NONE = new KeysInFlight();

// True iff an ancestor of `key` is one of `keys`.
const ancestorIn = (key, keys) => {
  let at = key.lastIndexOf('/');
  while (at > 0) {
    if (keys.has(key.slice(0, at))) return true;
    at = key.lastIndexOf('/', at - 1);
  }
  return false;
};

// What `key` names in the place's tree: a file, a directory, or nothing.
const NOTHING = 0;
const A_FILE = 1;
const A_DIRECTORY = 2;
const kindOf = (place, key) => {
  const node = place.node(key);
  if (node === null) return NOTHING;
  return place.tree.isDirectory(node) ? A_DIRECTORY : A_FILE;
};

// A path is a file or a directory, never both, and a file lives in a
// directory. Before a file is created at `key` — written, copied or renamed
// into a virtual place — the first name above it that is not an existing
// directory decides, as on Linux: a file, published or being created
// (`creating`, KeysInFlight: a key whose publication has begun but not
// committed counts as a file already, so two concurrent mutations cannot
// both pass), is ENOTDIR; a missing one ENOENT — unless `parents`, which a
// set of files makes in its own commit. `key` itself may not be a
// directory, nor have keys in flight below it (EISDIR).
const checkHierarchy = (place, key, fail, creating, parents = false) => {
  const { tree } = place;
  let node = tree.get('');
  let at = 0;
  for (
    let next = key.indexOf('/', 1);
    next !== -1;
    next = key.indexOf('/', at + 1)
  ) {
    if (creating.has(key.slice(0, next))) throw fail('ENOTDIR');
    const child =
      node === null ? null : tree.childOf(node, key.slice(at + 1, next));
    if (child === null) {
      if (!parents) throw fail('ENOENT');
    } else if (!tree.isDirectory(child)) {
      throw fail('ENOTDIR');
    }
    node = child;
    at = next;
  }
  const own = node === null ? null : tree.childOf(node, key.slice(at + 1));
  if (own !== null && tree.isDirectory(own)) throw fail('EISDIR');
  if (own === null && creating.below(key)) throw fail('EISDIR');
};

// An exclusive write ('x' flag) creates `key` only: a file or a directory
// there is EEXIST.
const checkExclusive = (place, key, fail) => {
  if (place.node(key) !== null) throw fail('EEXIST');
};

// Why a removal finds no file at `key`: the one there is named as a
// directory, with a trailing separator — ENOTDIR, as on POSIX, which `force`
// ignores as it does ENOENT — or there is none.
const absentCode = (place, key) =>
  kindOf(place, key) === A_FILE ? 'ENOTDIR' : 'ENOENT';

// The ops of a mkdir: one directory, its parent there already — with
// `recursive`, every missing one down to it, and a directory there already
// is no error. A file at the key, published or being created, is EEXIST, a
// file above it ENOTDIR, a missing parent without `recursive` ENOENT, an
// existing directory without it EEXIST.
const mkdirOps = (place, key, recursive, fail, creating) => {
  if (creating.has(key)) throw fail('EEXIST');
  const { tree } = place;
  const ops = [];
  let node = tree.get('');
  let at = 0;
  for (;;) {
    const next = key.indexOf('/', at + 1);
    const last = next === -1;
    const part = last ? key : key.slice(0, next);
    if (!last && creating.has(part)) throw fail('ENOTDIR');
    const name = key.slice(at + 1, last ? key.length : next);
    const child = node === null ? null : tree.childOf(node, name);
    if (child !== null && !tree.isDirectory(child)) {
      throw fail(last ? 'EEXIST' : 'ENOTDIR');
    }
    if (child === null) {
      if (!last && !recursive) throw fail('ENOENT');
      ops.push(['mkdir', part]);
    } else if (last && !recursive) {
      throw fail('EEXIST');
    }
    if (last) return ops;
    node = child;
    at = next;
  }
};

// Why a published source cannot move under another key as it is — its
// payload unchanged — or null: a prepared source keeps no raw input, and
// bytecode, scriptOptions and meta may name the old path. A compressed
// representation depends on the content alone, so it moves along.
const immovable = (place, key, payload) => {
  if (place.prepared(key)) return 'prepared source';
  if (bytecodeDomains(place, key).length > 0) return 'compiled source';
  if (payload?.extras) return 'path-dependent metadata';
  return null;
};

// Whether a file moves to `to` as it is: what the pipeline makes of it
// there is what it holds — no preparer of `to`'s extension (a raw file
// renamed into one is prepared), the same bytecode flavors and no
// `require` among them (its cached data is compiled under the file's
// path), the same compression. Else the rename publishes it anew under
// `to` (VirtualStore.rename). `from`'s own preparer refuses the rename
// before this is asked.
const movesAsIs = (place, from, to) => {
  if (place.prepared(to)) return false;
  const flavors = bytecodeDomains(place, from);
  const there = bytecodeDomains(place, to);
  if (flavors.includes('require') || there.includes('require')) return false;
  if (flavors.join() !== there.join()) return false;
  return place.compressible(from) === place.compressible(to);
};

class VirtualStore {
  constructor(place) {
    this.place = place;
  }

  // Keys whose publication has begun and not committed yet: none, where
  // every publication is done before its mutation returns.
  get creating() {
    return NONE;
  }

  #fail(syscall, key) {
    return (code, detail) =>
      fsError(code, syscall, this.place.pathOf(key), detail);
  }

  // The copy a mutation takes of the bytes it is given, when it is called:
  // a Buffer of Node's pool, which the publication copies on (SabStore);
  // a store that keeps the copy has one of its own (MapStore).
  own(data) {
    return Buffer.from(data);
  }

  // A write keeps the hierarchy (checkHierarchy): its directory there, no
  // file above its key, no directory at it. `{ exclusive }` creates the
  // key only.
  write(key, data, options = {}) {
    const raw = this.own(data);
    return this.run([key], () => {
      const { place } = this;
      const fail = this.#fail('open', key);
      if (options.exclusive) checkExclusive(place, key, fail);
      checkHierarchy(place, key, fail, this.creating);
      return this.create(key, () => this.publishRaw(key, raw));
    });
  }

  // Several files as one publication (PlaceFs.writeFiles), the directories
  // they lack made in the same commit. The whole set is checked in the turn
  // of all its keys, taken in one step, before any of them is prepared: a
  // file of the set above another of its keys refuses that key (ENOTDIR),
  // and each key keeps the hierarchy against the place and the keys of the
  // mutations in flight, as a write does but for a missing directory —
  // `{ exclusive }` creates every key only. The keys then count as files
  // in flight until the set is published or refused. A refusal names the
  // key it is about, as `writeFiles` refuses it.
  writeFiles(files, options = {}) {
    const batch = files.map(([key, data]) => [key, this.own(data)]);
    const keys = batch.map(([key]) => key);
    return this.run(keys, () => {
      const { place } = this;
      const failOf = (key) => (code, detail) =>
        fsError(code, 'writeFiles', place.pathOf(key), detail);
      const set = new Set(keys);
      for (const key of keys) {
        const fail = failOf(key);
        if (ancestorIn(key, set)) throw fail('ENOTDIR');
        if (options.exclusive) checkExclusive(place, key, fail);
        checkHierarchy(place, key, fail, this.creating, true);
      }
      return this.createAll(keys, () => this.publishBatch(batch, failOf));
    });
  }

  // The raw input of a prepared file is not retained, so there is nothing
  // to append to.
  append(key, data) {
    const chunk = this.own(data);
    return this.run([key], () => {
      const { place } = this;
      if (place.prepared(key)) {
        throw fsError('ENOTSUP', 'open', place.pathOf(key), 'prepared source');
      }
      checkHierarchy(place, key, this.#fail('open', key), this.creating);
      const current = place.file(key);
      const raw = current ? Buffer.concat([current.source.data, chunk]) : chunk;
      return this.create(key, () => this.publishRaw(key, raw));
    });
  }

  unlink(key, options = {}) {
    return this.run([key], () => {
      const { place } = this;
      const kind = kindOf(place, key);
      if (kind === A_FILE && !options.directory) {
        this.commit([['unlink', key]], this.#fail('unlink', key));
        return undefined;
      }
      const code = kind === A_DIRECTORY ? 'EISDIR' : absentCode(place, key);
      throw fsError(code, 'unlink', place.pathOf(key));
    });
  }

  // A directory is a node of the tree: mkdir makes it — `recursive`, every
  // one missing down to it (mkdirOps) — checked against the hierarchy, keys
  // in flight included.
  mkdir(key, options) {
    const fail = this.#fail('mkdir', key);
    return this.run([key], () => {
      const ops = mkdirOps(
        this.place,
        key,
        options?.recursive,
        fail,
        this.creating,
      );
      if (ops.length > 0) this.commit(ops, fail);
      return undefined;
    });
  }

  // An empty directory goes: a file is ENOTDIR, a directory with children —
  // or keys in flight below it — ENOTEMPTY.
  rmdir(key) {
    const fail = this.#fail('rmdir', key);
    return this.run([key], () => {
      const { place } = this;
      const node = place.node(key);
      if (node === null) throw fail('ENOENT');
      if (!place.tree.isDirectory(node)) throw fail('ENOTDIR');
      if (place.tree.countOf(node) > 0 || this.creating.below(key)) {
        throw fail('ENOTEMPTY');
      }
      this.commit([['rmdir', key]], fail);
      return undefined;
    });
  }

  // The key may name a subtree, whose children must not be written while
  // it goes: the barrier of the place. A directory goes whole with
  // `recursive`, an empty one too, and is ERR_FS_EISDIR without it.
  rm(key, options = {}) {
    return this.run(null, () => {
      const { place } = this;
      const kind = kindOf(place, key);
      const fail = this.#fail('rm', key);
      if (kind === A_FILE && !options.directory) {
        this.commit([['unlink', key]], fail);
        return undefined;
      }
      if (kind === A_DIRECTORY) {
        if (!options.recursive) throw isDirectoryError('rm', place.pathOf(key));
        this.commit([['remove', key]], fail);
        return undefined;
      }
      // Forced over nothing, it has nothing to remove.
      if (!options.force) {
        throw fsError(absentCode(place, key), 'rm', place.pathOf(key));
      }
      return undefined;
    });
  }

  // A rename works as on Linux, in one commit (doc/architecture.md,
  // "Virtual places and worker mutations"): a file onto a
  // file replaces it, onto a directory is EISDIR; a directory onto a file
  // is ENOTDIR, onto an empty directory replaces it, onto one with children
  // is ENOTEMPTY, into its own subtree EINVAL; onto itself, once its checks
  // pass, nothing changes, as in node:fs; the destination's directory must
  // exist. The node moves — its id and `ino`, its payload and every
  // representation, its version — and nothing is copied. A file whose
  // pipeline would make something else of it under the new key (movesAsIs)
  // is published anew there in the same commit — prepared when its new
  // extension has a preparer — keeping its mtime, like a rename on disk;
  // what that pipeline refuses — a script flavor that does not compile, a
  // preparer this thread lacks, a pool with no room — the rename refuses,
  // with its call, source and destination. A prepared source keeps no raw
  // input and its bundle may embed the old key (scriptOptions.filename,
  // meta), so it cannot move (ENOTSUP), and a directory moves only when
  // every file below it can move as it is (immovable). A file locks both
  // keys; anything else may name a subtree and takes the place barrier, so
  // nothing under it changes while it moves. A file removed before its turn
  // stays ENOENT, even if a directory took its name meanwhile. Named as a
  // directory, only a directory moves: it never locks as a file.
  rename(from, to, options = {}) {
    const { place } = this;
    const { directory } = options;
    const keys =
      !directory && kindOf(place, from) === A_FILE ? [from, to] : null;
    const fail = (code, detail) =>
      fsError(code, 'rename', place.pathOf(from), detail, place.pathOf(to));
    return this.run(keys, () => {
      const kind = kindOf(place, from);
      if (kind === A_DIRECTORY && !keys) {
        return this.#moveDirectory(from, to, fail);
      }
      if (kind === A_FILE && directory) throw fail('ENOTDIR');
      if (place.prepared(from)) throw fail('ENOTSUP', 'prepared source');
      if (kind !== A_FILE) throw fail('ENOENT');
      return this.#moveFile(from, to, fail);
    });
  }

  #moveFile(from, to, fail) {
    checkHierarchy(this.place, to, fail, this.creating);
    return from === to ? undefined : this.#move(from, to, fail);
  }

  // `from` under `to`, a file there unlinked first: moved as it is where
  // its pipeline makes the same of it there (movesAsIs), else published
  // anew under `to` in the same commit, its mtime kept.
  #move(from, to, fail) {
    const { place } = this;
    const ops = [];
    if (kindOf(place, to) === A_FILE) ops.push(['unlink', to]);
    ops.push(['move', from, to]);
    const asIs = movesAsIs(place, from, to);
    if (asIs) this.commit(ops, fail);
    return asIs ? undefined : this.#republish(ops, from, to, fail);
  }

  #republish(ops, from, to, fail) {
    const payload = this.place.file(from);
    const raw = Buffer.from(payload.source.data);
    return this.create(to, () =>
      this.move(ops, to, raw, payload.mtimeMs, fail),
    );
  }

  #moveDirectory(from, to, fail) {
    const { place } = this;
    const { tree } = place;
    if (to === from) return undefined;
    if (to.startsWith(from + '/')) {
      throw fail('EINVAL', 'a directory into itself');
    }
    const ops = [];
    const target = place.node(to);
    if (target === null) {
      checkHierarchy(place, to, fail, this.creating);
    } else if (!tree.isDirectory(target)) {
      throw fail('ENOTDIR');
    } else if (tree.countOf(target) > 0 || this.creating.below(to)) {
      throw fail('ENOTEMPTY');
    } else {
      ops.push(['rmdir', to]);
    }
    const node = place.node(from);
    for (const [file] of tree.walk(node, { containers: 'skip' })) {
      const key = tree.pathOf(file);
      const reason = immovable(place, key, tree.payloadOf(file));
      if (reason) throw fail('ENOTSUP', `${reason} ${key}`);
    }
    ops.push(['move', from, to]);
    this.commit(ops, fail);
    return undefined;
  }
}

module.exports = { VirtualStore, KeysInFlight };
