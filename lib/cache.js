'use strict';

// FilesystemCache — the pool of SharedArrayBuffer segments the main kernel
// places file bytes in, and its compaction plan. It knows extents, never
// keys: what is published, and under which key, is the trees' business
// (lib/tree.js) — the kernel commits an extent there or frees it here. No
// Node API dependencies: bytes come either from `file.data` (Buffer) or
// from the injected `reader(file, view)` that fills a Uint8Array view over
// the SAB and throws when the source cannot be read completely and
// consistently.
//
// Data contract:
//
// @typedef {Object} FileInput             // value handed to allocate()
// @property {Buffer} [data]               // in-memory content, or
// @property {string} [path]               // path handed to the reader
// @property {{size:number, mtimeMs?:number}} stat  // compact metadata
//
// @typedef {Object} Extent                // bytes in a segment
// @property {number} segmentId
// @property {number} offset
// @property {number} length               // 0: the empty extent { 0, 0, 0 }

// The empty extent: an empty file holds no bytes, in no segment.
const EMPTY = Object.freeze({ segmentId: 0, offset: 0, length: 0 });

// The size `#reserve`/`allocate` place: the length of in-memory bytes, or
// the stat size of a path-only input the reader will fill.
const fileSize = (file) => (file.data ? file.data.length : file.stat.size);

// Whether `file` can never live in SAB, whatever the pool's state: above
// `maxFileSize`, the cap `#reserve` checks first. Distinguishes a refusal
// that would still fail with an empty pool (EFBIG, publication.js noRoom())
// from one that just finds no room right now (ENOSPC).
const exceedsMaxFileSize = (file, maxFileSize) => fileSize(file) > maxFileSize;

// Whether `size` bytes can never fit in one segment, whatever the pool's
// state: above `segmentSize`, the only cap a derived representation has —
// bytecode and compressed bytes (DERIVED, publication.js) set no
// `maxFileSize` of their own. Same EFBIG/ENOSPC distinction as
// `exceedsMaxFileSize`, for content with no maxFileSize.
const exceedsSegmentSize = (size, segmentSize) => size > segmentSize;

class Pool {
  // `sabs`: the kernel's map of segments, id → SAB, which every segment
  // joins as it is made — what the main thread's trees read through.
  constructor(limit, segmentSize, sabs) {
    this.limit = limit;
    this.segmentSize = segmentSize;
    this.segments = new Map();
    this.sabs = sabs;
    // Fully freed segments are kept for reuse, never returned to the OS.
    this.emptySegmentIds = new Set();
    this.totalUsed = 0;
    this.nextSegmentId = 1;
  }

  createSegment() {
    for (const id of this.emptySegmentIds) {
      this.emptySegmentIds.delete(id);
      return this.segments.get(id);
    }
    const size = this.segmentSize;
    if (this.totalUsed + size > this.limit) return null;
    const id = this.nextSegmentId++;
    const segment = { id, sab: new SharedArrayBuffer(size) };
    this.segments.set(id, segment);
    this.sabs.set(id, segment.sab);
    this.totalUsed += size;
    return segment;
  }

  freeSegment(id) {
    if (this.segments.has(id)) this.emptySegmentIds.add(id);
  }

  getSegment(id) {
    return this.segments.get(id) || null;
  }

  snapshot() {
    const result = [];
    for (const { id, sab } of this.segments.values()) result.push({ id, sab });
    return result;
  }
}

// Extent bookkeeping per segment: `free` holds sorted free extents inside the
// used prefix, `tail` is the first never-used offset.
class SegmentRegistry {
  constructor(pool) {
    this.pool = pool;
    this.free = new Map(); // segmentId → [{ offset, length }]
    this.tail = new Map(); // segmentId → number
    // Segments being emptied by compaction: no new allocations land there,
    // but their bytes stay valid until every extent in them is released.
    this.closed = new Set();
  }

  register(segmentId) {
    this.free.set(segmentId, []);
    this.tail.set(segmentId, 0);
  }

  unregister(segmentId) {
    this.free.delete(segmentId);
    this.tail.delete(segmentId);
    this.closed.delete(segmentId);
  }

  // Best-fit free extent → tail of a partially used segment → new segment.
  // Returns null when nothing fits (size above segmentSize, or pool budget
  // exhausted). `noGrow` forbids creating segments (used by compaction).
  allocate(size, noGrow = false) {
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new RangeError(`invalid allocation size: ${size}`);
    }
    if (size > this.pool.segmentSize) return null;
    let best = null;
    for (const [segmentId, extents] of this.free) {
      if (this.closed.has(segmentId)) continue;
      for (let i = 0; i < extents.length; i++) {
        const extent = extents[i];
        if (extent.length < size) continue;
        if (!best || extent.length < best.extent.length) {
          best = { segmentId, index: i, extent };
        }
      }
    }
    if (best) {
      const { segmentId, index, extent } = best;
      const offset = extent.offset;
      if (extent.length === size) {
        this.free.get(segmentId).splice(index, 1);
      } else {
        extent.offset += size;
        extent.length -= size;
      }
      return { segmentId, offset };
    }
    for (const [segmentId, tail] of this.tail) {
      if (this.closed.has(segmentId)) continue;
      if (tail + size <= this.pool.segmentSize) {
        this.tail.set(segmentId, tail + size);
        return { segmentId, offset: tail };
      }
    }
    if (noGrow) return null;
    const segment = this.pool.createSegment();
    if (!segment) return null;
    this.register(segment.id);
    this.tail.set(segment.id, size);
    return { segmentId: segment.id, offset: 0 };
  }

  release(segmentId, offset, length) {
    const extents = this.free.get(segmentId);
    if (!extents) return;
    let index = extents.findIndex((e) => e.offset > offset);
    if (index === -1) index = extents.length;
    extents.splice(index, 0, { offset, length });
    SegmentRegistry.mergeSiblings(extents, index);
  }

  static mergeSiblings(extents, index) {
    const current = extents[index];
    const next = extents[index + 1];
    if (next && current.offset + current.length === next.offset) {
      current.length += next.length;
      extents.splice(index + 1, 1);
    }
    const prev = extents[index - 1];
    if (prev && prev.offset + prev.length === current.offset) {
      prev.length += current.length;
      extents.splice(index, 1);
    }
  }

  used(segmentId) {
    const tail = this.tail.get(segmentId);
    if (!tail) return 0;
    let free = 0;
    for (const e of this.free.get(segmentId)) free += e.length;
    return tail - free;
  }
}

class FilesystemCache {
  // options: { limit, segmentSize, maxFileSize, reader, segments } —
  // `segments`, the map every segment of the pool joins as it is made.
  constructor(options = {}) {
    const { limit, segmentSize, maxFileSize, reader } = options;
    this.segmentSize = segmentSize;
    this.maxFileSize = maxFileSize;
    this.reader = reader || null;
    this.pool = new Pool(limit, segmentSize, options.segments ?? new Map());
    this.registry = new SegmentRegistry(this.pool);
  }

  get totalUsed() {
    return this.pool.totalUsed;
  }

  getSegment(id) {
    return this.pool.getSegment(id);
  }

  // Place the bytes of one file in a segment, privately: its extent — the
  // empty extent for an empty file — or null when they cannot live in SAB:
  // above `maxFileSize` (default: the cache-wide limit), or no room in the
  // pool. What becomes of a file that does not fit — read from disk, or
  // refused — is the caller's decision.
  async allocate(file, options = {}) {
    const { maxFileSize = this.maxFileSize } = options;
    const reserved = this.#reserve(file, maxFileSize);
    if (!reserved) return null;
    const { extent, view } = reserved;
    if (!view) return extent;
    try {
      if (file.data) view.set(file.data);
      else await this.reader(file, view);
    } catch (err) {
      this.free(extent);
      throw err;
    }
    return extent;
  }

  // Place in-memory bytes at once, synchronously: an extent, or null when
  // they cannot live in SAB (above `maxFileSize`, or the pool is full). For
  // a caller that must not let go of the bytes before they are copied — a
  // preparer's result, which its next call may overwrite. A copy that
  // throws (an array-like that lies about its length or its elements)
  // leaves nothing allocated.
  allocateSync(file, options = {}) {
    const { maxFileSize = this.maxFileSize } = options;
    if (!file.data) throw new TypeError('allocateSync: in-memory data only');
    const reserved = this.#reserve(file, maxFileSize);
    if (!reserved) return null;
    const { extent, view } = reserved;
    if (!view) return extent;
    try {
      view.set(file.data);
    } catch (err) {
      this.free(extent);
      throw err;
    }
    return extent;
  }

  // The extent of `file` in a segment, not yet filled: `{ extent, view }`,
  // `view` null for an empty file; null when the bytes cannot live in SAB.
  #reserve(file, maxFileSize) {
    const { data, stat } = file;
    if (data && stat.size !== undefined && stat.size !== data.length) {
      throw new Error(`size mismatch: stat ${stat.size}, data ${data.length}`);
    }
    const size = fileSize(file);
    if (size > maxFileSize) return null;
    if (!data && !this.reader) return null;
    if (size === 0) return { extent: EMPTY, view: null };
    const allocation = this.registry.allocate(size);
    if (!allocation) return null;
    const { segmentId, offset } = allocation;
    const view = new Uint8Array(
      this.pool.getSegment(segmentId).sab,
      offset,
      size,
    );
    return { extent: { segmentId, offset, length: size }, view };
  }

  // An extent committed to a tree in a segment compaction closed meanwhile
  // keeps that segment live: it is reopened for allocation and later
  // compaction.
  committed(extent) {
    if (extent.length > 0) this.reopen(extent.segmentId);
  }

  // A segment compaction closed is open to allocation again: what it was
  // to empty stays there.
  reopen(segmentId) {
    this.registry.closed.delete(segmentId);
  }

  // Return an extent's bytes to the pool. Callers guarantee nobody still
  // reads it: never published, or retired, ACKed and released.
  free(extent) {
    if (!extent || extent.length === 0) return;
    const { segmentId, offset, length } = extent;
    if (!this.pool.getSegment(segmentId)) return;
    this.registry.release(segmentId, offset, length);
    if (this.registry.used(segmentId) === 0) {
      this.registry.unregister(segmentId);
      this.pool.freeSegment(segmentId);
    }
  }

  // The least-utilised segment open to allocation, below `threshold` of
  // its size, while at least two are in use — the one compaction would
  // empty — or null.
  compactTarget(threshold) {
    if (!threshold) return null;
    let target = null;
    let minUtil = threshold;
    let count = 0;
    for (const [segmentId, tail] of this.registry.tail) {
      if (tail === 0 || this.registry.closed.has(segmentId)) continue;
      count++;
      const util = this.registry.used(segmentId) / this.segmentSize;
      if (util < minUtil) {
        minUtil = util;
        target = segmentId;
      }
    }
    return count < 2 ? null : target;
  }

  // Copy the published extents of `target` (compactTarget) into free space
  // of the other segments — never growing the pool — and close it: no new
  // allocation lands there. Returns the new extent of each, in order, or
  // null when not everything fits (nothing is kept). The trees' owners of
  // the old extents are the caller's: it commits the new ones by id and
  // retires the old like any replaced representation; what still reads one
  // keeps it, in the closed segment, which returns to the pool once the
  // last is freed. One relocation per call — the kernel runs it once per
  // free cycle.
  // TODO(design): evaluate scheduled / repeated compaction to a target.
  relocate(target, extents) {
    this.registry.closed.add(target);
    const moved = [];
    const src = this.pool.getSegment(target).sab;
    for (const { offset, length } of extents) {
      const allocation = this.registry.allocate(length, true);
      if (!allocation) {
        for (const extent of moved) {
          this.registry.release(extent.segmentId, extent.offset, extent.length);
        }
        this.registry.closed.delete(target);
        return null;
      }
      const dst = this.pool.getSegment(allocation.segmentId).sab;
      new Uint8Array(dst, allocation.offset, length).set(
        new Uint8Array(src, offset, length),
      );
      const { segmentId } = allocation;
      moved.push({ segmentId, offset: allocation.offset, length });
    }
    return moved;
  }

  // Every segment of the pool: what a worker's map needs.
  snapshot() {
    return this.pool.snapshot();
  }

  // What the pool holds, for diagnostics; reads and changes nothing. The
  // budget and the size of a segment; the segments reserved, empty ones
  // kept for reuse included, and their bytes; the bytes in allocations —
  // published, retired or being published — and the rest; the largest
  // allocation that fits without a new segment: a free extent or the tail
  // of a segment open to allocations, or a whole empty segment; and the
  // fragmentation of the free bytes, 1 − largestFree / free.
  usage() {
    const { segmentSize, pool, registry } = this;
    let used = 0;
    let largestFree = 0;
    for (const id of pool.segments.keys()) {
      if (pool.emptySegmentIds.has(id)) {
        largestFree = segmentSize;
        continue;
      }
      used += registry.used(id);
      if (registry.closed.has(id)) continue;
      largestFree = Math.max(largestFree, segmentSize - registry.tail.get(id));
      for (const { length } of registry.free.get(id)) {
        largestFree = Math.max(largestFree, length);
      }
    }
    const reserved = pool.totalUsed;
    const free = reserved - used;
    return {
      limit: pool.limit,
      segmentSize,
      segments: pool.segments.size,
      reserved,
      used,
      free,
      largestFree,
      fragmentation: free === 0 ? 0 : 1 - largestFree / free,
    };
  }

  stats() {
    const lines = [];
    for (const { id } of this.pool.segments.values()) {
      const used = this.registry.used(id);
      const pct = ((used / this.segmentSize) * 100).toFixed(1);
      const mark = this.pool.emptySegmentIds.has(id) ? ' [empty]' : '';
      lines.push(`  seg ${id}: ${used}/${this.segmentSize} (${pct}%)${mark}`);
    }
    return {
      segmentCount: this.pool.segments.size,
      emptyCount: this.pool.emptySegmentIds.size,
      totalUsed: this.pool.totalUsed,
      lines,
    };
  }
}

module.exports = {
  FilesystemCache,
  EMPTY,
  exceedsMaxFileSize,
  exceedsSegmentSize,
};
