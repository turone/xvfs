'use strict';

// The disk past fs-patch (disk.js).
const {
  promises: { readFile },
} = require('./disk.js');
const { exceedsMaxFileSize, exceedsSegmentSize } = require('./cache.js');
const { SOURCE, COMPRESSED } = require('./place.js');
const {
  prepareInput,
  opening,
  bytecodeDomains,
  bytecodeFor,
} = require('./pipeline.js');

// The SAB sink of the publication pipeline, on the main thread. The input
// of a publication (inputOf) — raw bytes with a path, or the canonical
// bytes of a preparer, run once — goes to its sink: a Map place's store,
// or sharedPublish(), which places the source, its bytecode flavors and
// its compressed representations in the pool, privately. What comes back
// is the payload input of a tree's `write` — the attributes, `meta` and
// `scriptOptions`, and the extent of each representation by kind — and the
// extents it placed; the kernel commits the write (#flush) or frees them:
// nothing here is ever published. A failure frees this attempt's own
// allocations and nothing else.
//
// The sink has no state of its own. `host` is the kernel, read at each
// call and never kept: `host.cache` and `host.compressor` are gone after
// close(), and a test replaces the reader, a free or a codec on them.

// Derived representations are bounded by the segment size only, never by
// maxFileSize, and never fall back to the raw file on disk.
const DERIVED = { maxFileSize: Infinity };

const CLOSED = '[vfs] kernel closed before publication';

// The refusal of a publication its kernel's close() stopped: `code`
// ERR_VFS_CLOSED, as a stream close() stops (place-fs.js).
const closedError = () => {
  const err = new Error(CLOSED);
  err.code = 'ERR_VFS_CLOSED';
  return err;
};

// A publication that outlives close() stops at its next step.
const alive = (host) => {
  if (host.state === 'closed') throw closedError();
};

// What must live in SAB and finds no room there is refused as a real
// filesystem refuses such a write, named by the operation (`fail`: a
// rename's), else as a write of the key (`open` of its path, pipeline.js
// opening()). `code` is EFBIG when the content is larger than the place's
// maxFileSize — it would refuse the same way whatever the pool's state —
// else ENOSPC: the pool has no room for it right now. `detail` says what
// did not fit.
const noRoom = (place, key, fail, code, detail) =>
  (fail || opening(place, key))(code, detail);

// EFBIG when `input` alone already exceeds the place's cap — it could
// never have fit, pool or no pool — else ENOSPC: a transient lack of room.
const roomCode = (place, input) =>
  exceedsMaxFileSize(input, place.config.maxFileSize) ? 'EFBIG' : 'ENOSPC';

// Same distinction for a derived representation (DERIVED: no maxFileSize
// of its own) placed at `size` bytes: EFBIG when it exceeds the pool's one
// cap, segmentSize — it could never have fit any segment — else ENOSPC.
const derivedRoomCode = (host, size) =>
  exceedsSegmentSize(size, host.cache.segmentSize) ? 'EFBIG' : 'ENOSPC';

// With `retainRaw: false` the source of a compressed file lives on disk
// only.
const keptOnDisk = (host, place, key) => {
  const compress = place.config.fs?.compress;
  return (
    Boolean(compress) &&
    !compress.retainRaw &&
    host.compressor.compressible(place, key)
  );
};

// Where a preparer's Uint8Array result goes the moment it is returned: its
// provisional SAB allocation, the one copy of the bytes (prepareInput). It
// declines — the pipeline then copies, and the publication answers as it
// always did — when the bytes cannot live in SAB or once the kernel is
// closed (a preparer may close it); a source the place would keep on disk
// (keptOnDisk) is declined too, as a guard: the config refuses `retainRaw:
// false` together with `prepare`, so it cannot arise today. `free` returns
// a placed extent that its publication will never see.
const sinkOf = (host, place, key) => ({
  place: (data, stat) => {
    if (!host.cache || keptOnDisk(host, place, key)) return null;
    const { maxFileSize } = place.config;
    return host.cache.allocateSync({ data, stat }, { maxFileSize });
  },
  free: (extent) => host.cache?.free(extent),
});

// The FileInput to store: the raw `{ path, stat }` when the place keeps it
// untouched (the SAB reader streams it from disk straight into its
// segment), else `{ data, stat, scriptOptions?, meta? }` — a Map place owns
// its bytes, and a prepared source is whatever its preparer returned, or
// `{ extent, stat, … }` once the SAB sink placed it. The raw bytes are
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

// The bytes of the source just placed — its SAB view — or of the raw file
// a source kept on disk is read from (oversize, no room, retainRaw:
// false); null, warned, when that read fails. Read once per publication.
const sourceBytes = async (host, place, key, source, input) => {
  if (source !== null) {
    if (source.length === 0) return Buffer.alloc(0);
    const { sab } = host.cache.getSegment(source.segmentId);
    return Buffer.from(sab, source.offset, source.length);
  }
  try {
    return await readFile(input.path);
  } catch (err) {
    host.console.warn(
      `[vfs] place "${place.name}": cannot read "${key}" — ${err.message}`,
    );
    return null;
  }
};

// Cached data of a freshly placed canonical source, built from its bytes.
// A script flavor that does not compile (bytecodeFor refuses it, as `fail`
// says) or does not fit invalidates the whole publication; a require
// flavor is best-effort: the file goes without it.
const bytecode = async (host, place, key, src, input, out, fail) => {
  if (bytecodeDomains(place, key).length === 0) return;
  if (!src) throw new Error(`cannot read "${key}" to compile`);
  for (const code of bytecodeFor(place, key, src, input.scriptOptions, fail)) {
    if (!code.data) continue;
    const stat = { size: code.data.length };
    const extent = await host.cache.allocate(
      { data: code.data, stat },
      DERIVED,
    );
    if (extent) {
      out.extents.push(extent);
      out.representations.push([code.kind, extent]);
    } else if (code.domain === 'script') {
      // Capped only by the segment size (DERIVED has no maxFileSize): EFBIG
      // when it could never fit one segment, ENOSPC when the pool merely
      // has no room for it right now.
      const refusal = derivedRoomCode(host, code.data.length);
      const detail = 'fs.script.compile: source does not fit in SAB';
      throw noRoom(place, key, fail, refusal, detail);
    }
  }
};

// Compressed representations; a codec that fails or does not fit leaves
// only its own out.
const compress = async (host, place, key, src, out) => {
  if (!host.compressor.compressible(place, key)) return;
  const codecs = place.config.fs.compress.codecs;
  const built = src
    ? await host.compressor.compress(place, key, src)
    : codecs.map(({ encoding }) => ({ encoding, data: null }));
  alive(host);
  for (const { encoding, data } of built) {
    if (!data) continue;
    const stat = { size: data.length };
    const extent = await host.cache.allocate({ data, stat }, DERIVED);
    if (extent) {
      out.extents.push(extent);
      out.representations.push([COMPRESSED[encoding], extent]);
    } else {
      host.compressor.warn(
        place,
        key,
        encoding,
        'does not fit in one SAB segment',
      );
    }
  }
};

// The allocations of an abandoned attempt go back to the pool: its own
// only, none of them published. After close() the pool is gone with them.
const abandon = (host, extents) => {
  if (!host.cache) return;
  for (const extent of extents) host.cache.free(extent);
};

// The payload input of a tree's `write` (lib/tree.js): the attributes —
// `birthtimeMs`, the disk's, only where the place keeps it — the
// preparer's `meta` and `scriptOptions` where it attached them, and the
// representations.
const payloadInput = (place, input, representations, birthtimeMs) => {
  const { size, mtimeMs } = input.stat;
  const payload = { size, mtimeMs, representations };
  if (birthtimeMs !== undefined && place.config.stat.birthtime) {
    payload.birthtimeMs = birthtimeMs;
  }
  if (input.meta) payload.meta = input.meta;
  if (input.scriptOptions) payload.scriptOptions = input.scriptOptions;
  return payload;
};

// SAB storage of one canonical input: the source — placed here, or by the
// sink of prepareInput already (`input.extent`) — its bytecode flavors and
// compressed representations, placed privately. Returns `{ input, extents
// }`: the payload input of the file's `write`, and every extent placed, to
// free should the write never be committed. A source that does not fit
// stays on disk when it has a path there — the payload has no source, and
// readers go to the disk — and is refused otherwise. Nothing is published
// until the kernel commits the write, so a failure only frees this
// attempt's own bytes — the published version stays. A refusal is the
// operation's (`fail`: a rename's), else one of `open` (pipeline.js,
// opening()). `birthtimeMs`: the disk's, of a scanned file.
const sharedPublish = async (host, place, key, input, fail, birthtimeMs) => {
  const out = { representations: [], extents: [] };
  try {
    let source = input.extent ?? null;
    if (source !== null) {
      out.extents.push(source);
    } else if (!(input.path && keptOnDisk(host, place, key))) {
      const { maxFileSize } = place.config;
      source = await host.cache.allocate(input, { maxFileSize });
      if (source !== null) out.extents.push(source);
      else if (!input.path) {
        const code = roomCode(place, input);
        const detail = 'canonical source does not fit in SAB';
        throw noRoom(place, key, fail, code, detail);
      }
    }
    if (source !== null) out.representations.push([SOURCE, source]);
    alive(host);
    const derived =
      bytecodeDomains(place, key).length > 0 ||
      host.compressor.compressible(place, key);
    const src = derived
      ? await sourceBytes(host, place, key, source, input)
      : null;
    alive(host);
    await bytecode(host, place, key, src, input, out, fail);
    await compress(host, place, key, src, out);
    alive(host);
  } catch (err) {
    abandon(host, out.extents);
    throw err;
  }
  return {
    input: payloadInput(place, input, out.representations, birthtimeMs),
    extents: out.extents,
  };
};

module.exports = {
  closedError,
  alive,
  inputOf,
  keptOnDisk,
  sharedPublish,
};
