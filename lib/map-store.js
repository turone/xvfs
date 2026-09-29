'use strict';

const { bytecodeFor, prepareInput, opening } = require('./pipeline.js');
const { VirtualStore } = require('./virtual-store.js');

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
  // its extension runs once, here. A refusal is the operation's (`fail`),
  // else one of a write.
  #input(key, raw, fail, mtimeMs = Date.now()) {
    const { place } = this;
    const stat = { size: raw.length, mtimeMs };
    const name = place.prepared(key);
    if (!name) return { data: raw, stat };
    const prepare = place.preparerOf(key);
    if (!prepare) {
      const refuse = fail || opening(place, key);
      throw refuse(
        'ENOTSUP',
        `preparer "${name}" is not registered in this thread ` +
          '(attach({ preparers }))',
      );
    }
    return prepareInput(place, key, { stat }, raw, prepare);
  }

  // Publish an already-canonical input `{ data, stat, scriptOptions?, meta? }`
  // with fresh companions, atomically: everything is computed first
  // (#plan), so a script flavor that does not compile (bytecodeFor refuses
  // it, as `fail` says, else as a write) leaves the previous version and
  // its companions untouched.
  publish(key, input, fail) {
    return this.#apply(this.#plan(key, input, fail));
  }

  // What publishing `input` under `key` sets: the entry and the bytecode
  // flavors that compiled. Changes nothing.
  #plan(key, input, fail) {
    const { data, stat, scriptOptions, meta } = input;
    const codes = bytecodeFor(this.place, key, data, scriptOptions, fail);
    const entry = { data, stat, scriptOptions, meta };
    return { key, entry, codes: codes.filter((code) => code.data) };
  }

  #apply({ key, entry, codes }) {
    const { place } = this;
    const { files } = place;
    files.set(key, entry);
    for (const companion of place.companions(key)) files.delete(companion);
    for (const code of codes) {
      files.set(code.key, {
        data: code.data,
        stat: { size: code.data.length, mtimeMs: entry.stat.mtimeMs },
      });
    }
    return entry.stat;
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

  createAll(keys, publish) {
    return publish();
  }

  publishRaw(key, raw) {
    this.publish(key, this.#input(key, raw));
  }

  // A set at once, under one mtime: every preparer runs and every bytecode
  // flavor is built before the first entry changes, so a refusal leaves
  // the place as it was.
  publishBatch(files, failOf) {
    const mtimeMs = Date.now();
    const plans = files.map(([key, raw]) => {
      const fail = failOf(key);
      return this.#plan(key, this.#input(key, raw, fail, mtimeMs), fail);
    });
    for (const plan of plans) this.#apply(plan);
  }

  unpublish(keys) {
    for (const key of keys) this.remove(key);
  }

  // The raw content under the new key, through the pipeline — prepared
  // when its extension has a preparer — with its mtime; a refusal of the
  // pipeline is the rename's.
  moveEntry(from, to, fail) {
    const { data, stat } = this.place.files.get(from);
    this.publish(to, this.#input(to, data, fail, stat.mtimeMs), fail);
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
