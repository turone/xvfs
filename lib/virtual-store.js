'use strict';

const { bytecodeDomains } = require('./pipeline.js');
const { fsError, isDirectoryError } = require('./errors.js');

// VirtualStore — the node:fs semantics of a virtual place's mutations,
// written once: which checks run, in which order, and what each refusal is.
// Keys are canonical; errors are node:fs-shaped. A store executes them
// through six hooks:
//
//   run(keys, fn)        runs fn — every check and the change it decides —
//                        in the turn of `keys`, or for null under a barrier
//                        of the whole place; returns what fn returns
//   create(key, publish) publishes a new version of `key` through publish(),
//                        called in the turn its hierarchy check passed; a
//                        publication that outlives the call keeps `key` in
//                        `creating` until it settles
//   publishRaw(key, raw) publishes raw input, prepared by the preparer of
//                        the key's extension
//   unpublish(keys)      removes sources and every companion they have
//   moveEntry(from, to)  republishes a raw source under another key,
//                        keeping its mtime
//   moveTree(moves)      re-keys a subtree subtreeMoves() planned, in one
//                        step
//
// MapStore executes at once, on the thread's own Map; SabStore in the key's
// turn of the kernel's mutation queue, publishing through the kernel.
//
// `{ directory }`: a key was named with a trailing separator, so the
// operation takes a directory only — a file is ENOTDIR, as on POSIX —
// checked when it runs, never against a file written meanwhile.

const NONE = new Set();

// True iff an ancestor of `key` is a file, published or being created.
const fileAbove = (place, key, creating) => {
  let at = key.lastIndexOf('/');
  while (at > 0) {
    const parent = key.slice(0, at);
    if (place.files.has(parent) || creating.has(parent)) return true;
    at = key.lastIndexOf('/', at - 1);
  }
  return false;
};

// A path is a file or a directory, never both. Before a primary key is
// created — written, copied or renamed into a virtual place — no ancestor
// may be a file (ENOTDIR) and the key itself may not be a directory
// (EISDIR). `creating` holds the keys whose publication has begun but not
// committed: they count as files already, so two concurrent mutations
// cannot both pass. Companions are no part of the hierarchy.
const checkHierarchy = (place, key, fail, creating) => {
  if (fileAbove(place, key, creating)) throw fail('ENOTDIR');
  if (place.files.has(key)) return;
  if (place.isDirectory(key)) throw fail('EISDIR');
  const prefix = key + '/';
  for (const other of creating) {
    if (other.startsWith(prefix)) throw fail('EISDIR');
  }
};

// An exclusive write ('x' flag) creates `key` only: a file or a directory
// there is EEXIST. A file above it leaves nothing there, and
// checkHierarchy answers ENOTDIR.
const checkExclusive = (place, key, fail) => {
  if (place.files.has(key) || place.isDirectory(key)) throw fail('EEXIST');
};

// Why a removal finds no file at `key`: the one there is named as a
// directory, with a trailing separator — ENOTDIR, as on POSIX, which `force`
// ignores as it does ENOENT — or there is none.
const absentCode = (place, key) =>
  place.files.has(key) ? 'ENOTDIR' : 'ENOENT';

// mkdir in a virtual place creates no entry, yet answers as a filesystem
// does: a file at the key is EEXIST, a file above it ENOTDIR, an existing
// directory EEXIST unless `recursive`.
const checkMkdir = (place, key, recursive, fail, creating) => {
  if (place.files.has(key) || creating.has(key)) throw fail('EEXIST');
  if (fileAbove(place, key, creating)) throw fail('ENOTDIR');
  if (!recursive && place.isDirectory(key)) throw fail('EEXIST');
};

// Why a published source cannot move under another key as it is — bytes,
// stat and mtime unchanged — or null: a prepared source keeps no raw input,
// and bytecode, scriptOptions and meta may name the old path. A compressed
// representation depends on the content alone, so it moves along.
const immovable = (place, key) => {
  if (place.prepared(key)) return 'prepared source';
  if (bytecodeDomains(place, key).length > 0) return 'compiled source';
  const file = place.files.get(key);
  if (file?.scriptOptions || file?.meta) return 'path-dependent metadata';
  return null;
};

// A directory rename inside one virtual place, planned before anything
// changes: every source under `from`, with the companions it has, re-keyed
// under `to` — `[[key, newKey]]`. The whole subtree moves or nothing does:
// one source that cannot move refuses it all (ENOTSUP).
const subtreeMoves = (place, from, to, creating) => {
  const fail = (code, detail) =>
    fsError(code, 'rename', place.pathOf(from), detail, place.pathOf(to));
  const sources = place.keysUnder(from);
  if (sources.length === 0) throw fail('ENOENT');
  if (to === from) return [];
  if (to.startsWith(from + '/')) {
    throw fail('EINVAL', 'a directory into itself');
  }
  if (place.files.has(to)) throw fail('ENOTDIR');
  if (place.isDirectory(to)) throw fail('ENOTEMPTY');
  checkHierarchy(place, to, fail, creating);
  const moves = [];
  for (const key of sources) {
    const reason = immovable(place, key);
    if (reason) throw fail('ENOTSUP', `${reason} ${key}`);
    const newKey = to + key.slice(from.length);
    moves.push([key, newKey]);
    for (const companion of place.companions(key)) {
      if (!place.files.has(companion)) continue;
      moves.push([companion, newKey + companion.slice(key.length)]);
    }
  }
  return moves;
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
    return (code) => fsError(code, syscall, this.place.pathOf(key));
  }

  // A write keeps the hierarchy (checkHierarchy): no file above its key,
  // no directory at it. `{ exclusive }` creates the key only.
  write(key, data, options = {}) {
    const raw = Buffer.from(data);
    return this.run([key], () => {
      const { place } = this;
      const fail = this.#fail('open', key);
      if (options.exclusive) checkExclusive(place, key, fail);
      checkHierarchy(place, key, fail, this.creating);
      return this.create(key, () => this.publishRaw(key, raw));
    });
  }

  // The raw input of a prepared file is not retained, so there is nothing
  // to append to.
  append(key, data) {
    const chunk = Buffer.from(data);
    return this.run([key], () => {
      const { place } = this;
      if (place.prepared(key)) {
        throw fsError('ENOTSUP', 'open', place.pathOf(key), 'prepared source');
      }
      checkHierarchy(place, key, this.#fail('open', key), this.creating);
      const current = place.files.get(key);
      const raw = current ? Buffer.concat([current.data, chunk]) : chunk;
      return this.create(key, () => this.publishRaw(key, raw));
    });
  }

  unlink(key, options = {}) {
    return this.run([key], () => {
      const { place } = this;
      if (!options.directory && place.files.has(key)) {
        return this.unpublish([key]);
      }
      const code = place.isDirectory(key) ? 'EISDIR' : absentCode(place, key);
      throw fsError(code, 'unlink', place.pathOf(key));
    });
  }

  // Directories are implicit: mkdir creates no entry, but is ordered with
  // the key's mutations and checked against the hierarchy they leave, keys
  // in flight included (checkMkdir).
  mkdir(key, options) {
    const fail = this.#fail('mkdir', key);
    return this.run([key], () =>
      checkMkdir(this.place, key, options?.recursive, fail, this.creating),
    );
  }

  // The key may name a subtree, whose children must not be written while
  // it is being collected: the barrier of the place.
  rm(key, options = {}) {
    return this.run(null, () => {
      const { place } = this;
      if (!options.directory && place.files.has(key)) {
        return this.unpublish([key]);
      }
      const children = place.keysUnder(key);
      const found = children.length > 0;
      if (!found && !options.force) {
        throw fsError(absentCode(place, key), 'rm', place.pathOf(key));
      }
      if (found && !options.recursive) {
        throw isDirectoryError('rm', place.pathOf(key));
      }
      // Forced over nothing, it has nothing to remove.
      return found ? this.unpublish(children) : undefined;
    });
  }

  // A prepared source keeps no raw input and its bundle may embed the old
  // key (scriptOptions.filename, meta), so it cannot move. Any other source
  // is raw content, republished under the new key through the pipeline —
  // prepared when the new extension has a preparer — keeping its mtime,
  // like a rename on disk; onto itself, once its checks pass, it changes
  // nothing, as in node:fs. A file locks both keys; anything else may name
  // a subtree and takes the place barrier, so nothing under it changes
  // while it moves — when every source under it can move as it is
  // (subtreeMoves). A file removed before its turn stays ENOENT, even if a
  // directory took its name meanwhile. Named as a directory, only a
  // directory moves: it never locks as a file.
  rename(from, to, options = {}) {
    const { place } = this;
    const { directory } = options;
    const keys = !directory && place.files.has(from) ? [from, to] : null;
    return this.run(keys, () => {
      const found = place.files.has(from);
      if (!found && !keys && place.isDirectory(from)) {
        return this.moveTree(subtreeMoves(place, from, to, this.creating));
      }
      const fail = (code, detail) =>
        fsError(code, 'rename', place.pathOf(from), detail, place.pathOf(to));
      if (found && directory) throw fail('ENOTDIR');
      if (place.prepared(from)) throw fail('ENOTSUP', 'prepared source');
      if (!found) throw fail('ENOENT');
      checkHierarchy(place, to, fail, this.creating);
      return from === to
        ? undefined
        : this.create(to, () => this.moveEntry(from, to));
    });
  }
}

module.exports = { VirtualStore };
