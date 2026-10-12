'use strict';

const { bytecodeFor, prepareInput, opening } = require('./pipeline.js');
const { VirtualStore } = require('./virtual-store.js');
const { SOURCE } = require('./place.js');
const { closedError } = require('./publication.js');
const { survey } = require('./epoch.js');

// MapStore — the Map sink of the publication pipeline, for provider "map".
// Owns nothing shared: the place's tree in this thread (lib/tree.js) is its
// own, and so are the bytes of its representations — each in a buffer of
// its own, `segments`, id → ArrayBuffer, which the tree reads through; a
// representation a commit retires leaves the map, and the buffer lives on
// while a view of it does. Nothing leaves the thread: no snapshot, delta,
// ACK or pin. It serves two callers:
//   origin virtual  application mutations (any thread), with the semantics
//                   of VirtualStore, executed at once
//   origin disk     the kernel's scanner / watcher (main thread) through
//                   publish(), directory() and removeKey(); mutations
//                   themselves go to disk
// A write into an extension a preparer owns runs that preparer first; a
// thread that was not given it (a worker without attach({ preparers }))
// refuses the write rather than publishing raw bytes as if prepared.

// The extent of an empty file: no bytes, in no buffer.
const EMPTY = Object.freeze({ segmentId: 0, offset: 0, length: 0 });

// What a scan or the watcher makes of a file's missing directories (as the
// kernel's epochs do).
const PARENTS = Object.freeze({ parents: true });

class MapStore extends VirtualStore {
  // Mutations complete synchronously: nothing crosses a thread boundary.
  sync = true;

  // The buffers of the place's representations, by id — the segments of
  // its tree — and the counters of its commits.
  segments = new Map();
  #nextSegment = 0;
  #version = 0;
  // The tree takes a retireId for each representation it retires; nothing
  // here waits for one.
  retireIds = { next: () => 1 };

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

  // A buffer of its own for `bytes`: the one under them when they span it
  // whole — the place's own copy already — else a copy; its extent among
  // the place's segments, its id added to `ids`.
  #own(bytes, ids) {
    if (bytes.length === 0) return EMPTY;
    const { buffer } = bytes;
    const whole =
      bytes.byteOffset === 0 &&
      bytes.byteLength === buffer.byteLength &&
      buffer instanceof ArrayBuffer;
    const id = ++this.#nextSegment;
    this.segments.set(id, whole ? buffer : new Uint8Array(bytes).buffer);
    ids.push(id);
    return { segmentId: id, offset: 0, length: bytes.length };
  }

  // The payload input of an already-canonical input `{ data, stat,
  // scriptOptions?, meta? }`: its bytes and the bytecode flavors that
  // compiled, each in a buffer of its own. Computed before anything
  // changes, so a script flavor that does not compile (bytecodeFor refuses
  // it, as `fail` says, else as a write) leaves the published version as
  // it is.
  #payload(key, input, fail, ids, birthtimeMs) {
    const { data, stat, scriptOptions, meta } = input;
    const codes = bytecodeFor(this.place, key, data, scriptOptions, fail);
    const representations = [[SOURCE, this.#own(data, ids)]];
    for (const code of codes) {
      if (code.data)
        representations.push([code.kind, this.#own(code.data, ids)]);
    }
    const payload = {
      size: data.length,
      mtimeMs: stat.mtimeMs,
      representations,
    };
    if (birthtimeMs !== undefined && this.place.config.stat.birthtime) {
      payload.birthtimeMs = birthtimeMs;
    }
    if (meta) payload.meta = meta;
    if (scriptOptions) payload.scriptOptions = scriptOptions;
    return payload;
  }

  // One commit of the place's tree; what it retires leaves the segments,
  // and the files it creates, removes and moves reach the place's
  // spellings where it keeps them (Place.spelled). A refusal — which the
  // checks of VirtualStore leave none of — changes nothing: the buffers of
  // its writes, `ids`, leave with it.
  #commit(ops, ids = []) {
    const { place } = this;
    const { tree } = place;
    const changes = place.caseless ? survey(tree, ops) : null;
    let retired;
    try {
      ({ retired } = tree.commit(ops, ++this.#version, Date.now()));
    } catch (err) {
      for (const id of ids) this.segments.delete(id);
      throw err;
    }
    for (const { rep } of retired) this.segments.delete(rep.segmentId);
    if (changes) place.spelled(changes.created, changes.removed, changes.moved);
  }

  // The tree of the place: gone once its kernel closed, when every change
  // is refused as the closed kernel's.
  #open() {
    if (this.place.tree === null) throw closedError();
  }

  // --- The kernel's sink (origin disk) ---

  // Publish an already-canonical input `{ data, stat, scriptOptions?, meta?
  // }` of a scanned file — `birthtimeMs`, the disk's — with its missing
  // directories; a directory where the disk has a file now goes first.
  publish(key, input, birthtimeMs) {
    this.#open();
    const ids = [];
    const ops = [];
    const node = this.place.node(key);
    if (node !== null && this.place.tree.isDirectory(node)) {
      ops.push(['remove', key]);
    }
    const payload = this.#payload(key, input, undefined, ids, birthtimeMs);
    ops.push(['write', key, payload, PARENTS]);
    this.#commit(ops, ids);
  }

  // A scanned directory, and every one above it; a file where the disk
  // has a directory now goes first.
  directory(key) {
    this.#open();
    const { place } = this;
    const ops = [];
    for (let at = key.indexOf('/', 1); ; at = key.indexOf('/', at + 1)) {
      const part = at === -1 ? key : key.slice(0, at);
      const node = place.node(part);
      const directory = node !== null && place.tree.isDirectory(node);
      if (node !== null && !directory) ops.push(['unlink', part]);
      if (!directory) ops.push(['mkdir', part]);
      if (at === -1) break;
    }
    if (ops.length > 0) this.#commit(ops);
  }

  // What the disk no longer holds: a file, or a directory with everything
  // below it — the root's children for the root. Nothing there, nothing to
  // do.
  removeKey(key) {
    this.#open();
    const { place } = this;
    const ops = [];
    if (key === '') {
      for (const [name] of place.tree.children(place.node(''))) {
        ops.push(['remove', '/' + name]);
      }
    } else if (place.node(key) !== null) {
      ops.push(['remove', key]);
    }
    if (ops.length > 0) this.#commit(ops);
  }

  // --- Execution of the mutations (VirtualStore): at once, on the tree ---

  // A place whose kernel closed has no tree any more: its mutations are
  // refused as the closed kernel's.
  run(keys, fn) {
    this.#open();
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
    const ids = [];
    const payload = this.#payload(key, this.#input(key, raw), undefined, ids);
    this.#commit([['write', key, payload]], ids);
  }

  // A set at once, under one mtime, with the directories it lacks: every
  // preparer runs and every bytecode flavor is built before the tree
  // changes, so a refusal leaves the place as it was.
  publishBatch(files, failOf) {
    const mtimeMs = Date.now();
    const ids = [];
    const ops = files.map(([key, raw]) => {
      const fail = failOf(key);
      const input = this.#input(key, raw, fail, mtimeMs);
      return ['write', key, this.#payload(key, input, fail, ids), PARENTS];
    });
    this.#commit(ops, ids);
  }

  commit(ops) {
    this.#commit(ops);
  }

  // The moved file's raw content under its new key, through the pipeline —
  // prepared when its extension has a preparer — with its mtime, in the
  // commit of the move; a refusal of the pipeline is the rename's.
  move(ops, to, raw, mtimeMs, fail) {
    const ids = [];
    const input = this.#input(to, raw, fail, mtimeMs);
    const payload = this.#payload(to, input, fail, ids);
    this.#commit([...ops, ['write', to, payload]], ids);
  }
}

module.exports = { MapStore };
