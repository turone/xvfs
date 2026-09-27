'use strict';

// The disk past fs-patch (disk.js).
const {
  promises: { readFile },
} = require('./disk.js');
const { withExtras } = require('./cache.js');
const { compressedKey } = require('./companion.js');
const { prepareInput, bytecodeDomains, bytecodeFor } = require('./pipeline.js');

// The SAB sink of the publication pipeline, on the main thread. The input
// of a publication (inputOf) — raw bytes with a path, or the canonical
// bytes of a preparer, run once — goes to its sink: a Map place's store,
// or sharedPublish(), which places the source, its bytecode flavors and
// its compressed representations in the pool, privately. What comes back
// is a list of changes — [key, entry] to publish, [key, null] to
// unpublish, in the order to stage them — and the kernel stages and
// commits them (#stage, #flush): nothing here is ever published. A failure
// frees this attempt's own allocations and nothing else.
//
// The sink has no state of its own. `host` is the kernel, read at each
// call and never kept: `host.cache` and `host.compressor` are gone after
// close(), and a test replaces the reader, a free or a codec on them.

// Companions are bounded by the segment size only, never by maxFileSize,
// and never fall back to a disk entry pointing at the raw file.
const COMPANION_ALLOC = { fallback: false, maxFileSize: Infinity };

const CLOSED = '[vfs] kernel closed before publication';

// A publication that outlives close() stops at its next step.
const alive = (host) => {
  if (host.state === 'closed') throw new Error(CLOSED);
};

// Path-less inputs (prepared sources, SEA assets, virtual writes) must
// land in SAB or not be published at all — a disk fallback would point at
// a raw file, or at nothing. With `retainRaw: false` the source of a
// compressed file lives on disk only.
const allocOptions = (host, place, key, input) => {
  const compress = place.config.fs?.compress;
  const onDisk =
    Boolean(compress) &&
    !compress.retainRaw &&
    host.compressor.compressible(place, key);
  return {
    maxFileSize: place.config.maxFileSize,
    fallback: Boolean(input.path),
    onDisk,
  };
};

// Where a preparer's Uint8Array result goes the moment it is returned: its
// provisional SAB allocation, the one copy of the bytes (prepareInput). It
// declines — the pipeline then copies, and the publication answers as it
// always did — when the bytes cannot live in SAB or once the kernel is
// closed (a preparer may close it); a source that `allocOptions` would
// keep on disk is declined too, as a guard: the config refuses
// `retainRaw: false` together with `prepare`, so it cannot arise today.
// `free` returns a placed entry that its publication will never see.
const sinkOf = (host, place, key) => ({
  place: (data, stat) => {
    if (!host.cache) return null;
    const options = allocOptions(host, place, key, { stat });
    if (options.onDisk) return null;
    return host.cache.allocateSync({ data, stat }, options);
  },
  free: (entry) => host.cache?.free(entry),
});

// The FileInput to store: the raw `{ path, stat }` when the place keeps it
// untouched (the SAB reader streams it from disk straight into its
// segment), else `{ data, stat, scriptOptions?, meta? }` — a Map place owns
// its bytes, and a prepared source is whatever its preparer returned, or
// `{ entry, stat, … }` once the SAB sink placed it. The raw bytes are
// read through the kernel's reader, which close() takes away: a read asked
// after it fails, and the kernel answers that failure as its close
// (#publishEntry). The preparer of the key's extension runs here, once per
// attempt, and never on a closed kernel: a read close() found in flight
// finishes, its preparer does not run.
const inputOf = async (host, place, key, file) => {
  const prepare = place.preparerOf(key);
  if (!prepare && place.provider !== 'map') return file;
  let raw = file.data;
  if (!raw) {
    raw = Buffer.allocUnsafe(file.stat.size);
    await host.cache.reader(file, raw);
  }
  if (!prepare) return { data: raw, stat: file.stat };
  alive(host);
  const sink = place.provider === 'map' ? null : sinkOf(host, place, key);
  return prepareInput(place, key, file, raw, prepare, sink);
};

// Bytes of a just-allocated entry: its SAB view, or a disk read for an
// entry kept on disk (oversize, retainRaw: false).
const entryBytes = async (host, place, key, entry) => {
  if (entry.kind === 'shared') {
    if (entry.length === 0) return Buffer.alloc(0);
    const { sab } = host.cache.getSegment(entry.segmentId);
    return Buffer.from(sab, entry.offset, entry.length);
  }
  try {
    return await readFile(entry.path);
  } catch (err) {
    host.console.warn(
      `[vfs] place "${place.name}": cannot read "${key}" — ${err.message}`,
    );
    return null;
  }
};

// Cached data of a freshly allocated canonical source, built from the
// bytes just placed. A script flavor that does not compile (bytecodeFor
// refuses it) or does not fit invalidates the whole publication; a require
// flavor is best-effort and only drops its stale companion.
const bytecode = async (host, place, key, entry, input, changes, dropped) => {
  if (bytecodeDomains(place, key).length === 0) return;
  const src = await entryBytes(host, place, key, entry);
  if (!src) throw new Error(`cannot read "${key}" to compile`);
  for (const code of bytecodeFor(place, key, src, input.scriptOptions)) {
    const stat = code.data
      ? { size: code.data.length, mtimeMs: entry.stat.mtimeMs }
      : null;
    const companion = code.data
      ? await host.cache.allocate({ data: code.data, stat }, COMPANION_ALLOC)
      : null;
    if (companion) changes.push([code.key, companion]);
    else if (code.domain === 'script') {
      throw new Error('fs.script.compile: source does not fit in SAB');
    } else dropped.push(code.key);
  }
};

// Compressed representations; a codec that fails or does not fit drops
// only its own stale companion.
const compress = async (host, place, key, entry, changes, dropped) => {
  if (!host.compressor.compressible(place, key)) return;
  const src = await entryBytes(host, place, key, entry);
  const codecs = place.config.fs.compress.codecs;
  const built = src
    ? await host.compressor.compress(place, key, src)
    : codecs.map(({ encoding }) => ({ encoding, data: null }));
  alive(host);
  for (const { encoding, data } of built) {
    const companionKey = compressedKey(key, encoding);
    const stat = data && {
      size: data.length,
      sourceSize: entry.stat.size,
      encoding,
      mtimeMs: entry.stat.mtimeMs,
    };
    const companion = data
      ? await host.cache.allocate({ data, stat }, COMPANION_ALLOC)
      : null;
    if (companion) changes.push([companionKey, companion]);
    else {
      if (data) {
        host.compressor.warn(
          place,
          key,
          encoding,
          'does not fit in one SAB segment',
        );
      }
      dropped.push(companionKey);
    }
  }
};

// The allocations of an abandoned attempt go back to the pool: its own
// only, none of them published. After close() the pool is gone with them.
const abandon = (host, changes) => {
  if (!host.cache) return;
  for (const [, entry] of changes) if (entry) host.cache.free(entry);
};

// SAB storage of one canonical input: the source — placed here, or by the
// sink of prepareInput already (`input.entry`) — its bytecode flavors and
// compressed representations, placed privately. Returns the changes to
// stage: each new version, in that order, then each stale companion that
// was not rebuilt. Nothing is published until the kernel commits them, so
// a failure only frees this attempt's own bytes — the published version
// and its companions stay.
const sharedPublish = async (host, place, key, input) => {
  const changes = []; // [key, entry] in staging order
  const dropped = []; // stale companion keys
  try {
    const entry = input.entry
      ? withExtras(input.entry, input)
      : await host.cache.allocate(input, allocOptions(host, place, key, input));
    if (!entry) throw new Error('canonical source does not fit in SAB');
    changes.push([key, entry]);
    alive(host);
    await bytecode(host, place, key, entry, input, changes, dropped);
    await compress(host, place, key, entry, changes, dropped);
    alive(host);
  } catch (err) {
    abandon(host, changes);
    throw err;
  }
  for (const k of dropped) changes.push([k, null]);
  return changes;
};

// The versions of a subtree under their new keys (subtreeMoves): each
// source and companion copied with its stat and mtime — nothing is
// prepared, compiled or compressed again — and the old key to drop, move
// by move. A failure (the pool is full, the kernel closed) leaves nothing
// allocated.
const sharedCopies = async (host, place, moves) => {
  const changes = []; // [key, null], [newKey, entry] per move
  try {
    for (const [key, newKey] of moves) {
      const { data, stat } = place.files.get(key);
      const entry = await host.cache.allocate(
        { data, stat: { ...stat } },
        COMPANION_ALLOC,
      );
      if (!entry) throw new Error(`"${key}" does not fit in SAB`);
      changes.push([key, null], [newKey, entry]);
      alive(host);
    }
  } catch (err) {
    abandon(host, changes);
    throw err;
  }
  return changes;
};

module.exports = { CLOSED, alive, inputOf, sharedPublish, sharedCopies };
