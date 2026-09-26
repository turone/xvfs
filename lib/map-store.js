'use strict';

const { bytecodeFor, prepareInput } = require('./pipeline.js');
const { VirtualStore } = require('./virtual-store.js');
const { fsError } = require('./errors.js');

// MapStore — the Map sink of the publication pipeline, for provider "map".
// Owns nothing shared: entries are owned Buffers in `place.files` and never
// leave the thread. It serves two callers:
//   origin virtual  application mutations (any thread), with the semantics
//                   of VirtualStore, executed at once
//   origin disk     the kernel's scanner / watcher (main thread) through
//                   publish() and remove(); mutations themselves go to disk
// A write into an extension a preparer owns runs that preparer first; a
// thread that was not given it (a worker without attach({ preparers }))
// refuses the write rather than publishing raw bytes as if prepared.

class MapStore extends VirtualStore {
  // Mutations complete synchronously: nothing crosses a thread boundary.
  sync = true;

  // The canonical input of raw bytes written under `key`: the preparer of
  // its extension runs once, here.
  #input(key, raw, syscall, mtimeMs = Date.now()) {
    const { place } = this;
    const stat = { size: raw.length, mtimeMs };
    const name = place.prepared(key);
    if (!name) return { data: raw, stat };
    const prepare = place.preparerOf(key);
    if (!prepare) {
      throw fsError(
        'ENOTSUP',
        syscall,
        place.pathOf(key),
        `preparer "${name}" is not registered in this thread ` +
          '(attach({ preparers }))',
      );
    }
    return prepareInput(place, key, { stat }, raw, prepare);
  }

  // Publish an already-canonical input `{ data, stat, scriptOptions?, meta? }`
  // with fresh companions, atomically: everything is computed first, so a
  // script flavor that does not compile (bytecodeFor refuses it) leaves the
  // previous version and its companions untouched.
  publish(key, input) {
    const { place } = this;
    const { files } = place;
    const { data, stat, scriptOptions, meta } = input;
    const codes = bytecodeFor(place, key, data, scriptOptions).filter(
      (code) => code.data,
    );
    files.set(key, { data, stat, scriptOptions, meta });
    for (const companion of place.companions(key)) files.delete(companion);
    for (const code of codes) {
      files.set(code.key, {
        data: code.data,
        stat: { size: code.data.length, mtimeMs: stat.mtimeMs },
      });
    }
    return stat;
  }

  // Removes the source and its companions; false when there was no source.
  remove(key) {
    const { files } = this.place;
    if (!files.delete(key)) return false;
    for (const companion of this.place.companions(key)) files.delete(companion);
    return true;
  }

  // --- Execution of the mutations (VirtualStore): at once, on the Map ---

  run(keys, fn) {
    return fn();
  }

  // Published before the call returns: no key stays in flight.
  create(key, publish) {
    return publish();
  }

  publishRaw(key, raw) {
    this.publish(key, this.#input(key, raw, 'open'));
  }

  unpublish(keys) {
    for (const key of keys) this.remove(key);
  }

  // The raw content under the new key, through the pipeline — prepared
  // when its extension has a preparer — with its mtime; onto itself,
  // nothing moves.
  moveEntry(from, to) {
    if (from === to) return;
    const { data, stat } = this.place.files.get(from);
    this.publish(to, this.#input(to, data, 'rename', stat.mtimeMs));
    this.remove(from);
  }

  // The same entries — sources and companions — under the new keys, swapped
  // in one step once the whole plan is known.
  moveTree(moves) {
    const { files } = this.place;
    const entries = moves.map(([key, newKey]) => [newKey, files.get(key)]);
    for (const [key] of moves) files.delete(key);
    for (const [newKey, entry] of entries) files.set(newKey, entry);
  }
}

module.exports = { MapStore };
