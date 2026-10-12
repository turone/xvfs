// Types of cache.js: FilesystemCache, the pool of SharedArrayBuffer
// segments the main kernel places file bytes in, and its compaction plan,
// and the snapshot a worker is made from.

import type { Encoding } from './config.js';

/** Compact metadata of a file. */
export interface FileStat {
  readonly size: number;
  readonly mtimeMs: number;
}

/** Stat of a compressed representation: `size` is of the compressed bytes. */
export interface CompressedStat extends FileStat {
  readonly sourceSize: number;
  readonly encoding: Encoding;
}

/** Value handed to `allocate()`: in-memory bytes, or a path for the reader. */
export interface FileInput {
  data?: Buffer | null;
  path?: string | null;
  stat: FileStat;
}

/**
 * Bytes in a segment of the pool; `{ segmentId: 0, offset: 0, length: 0 }`
 * is the empty extent, in no segment.
 */
export interface Extent {
  readonly segmentId: number;
  readonly offset: number;
  readonly length: number;
}

export interface Segment {
  readonly id: number;
  readonly sab: SharedArrayBuffer;
}

/**
 * What `kernel.snapshot()` gives a worker: every segment of the pool, the
 * tree of each shared place as it is published (lib/tree.js: an encoding
 * of the engine's own, structured-cloneable), the kernel's version and its
 * instance; under strict with a place of `links: 'deny'`, the links the
 * kernel knows and its index's generation — how many it has come to know —
 * against which a `vfs-links` is newer or not.
 */
export interface VfsSnapshot {
  readonly segments: Segment[];
  readonly places: { readonly [name: string]: object };
  /** Each shared tree, and the number of the last batch it shows. */
  readonly trees: {
    readonly [name: string]: {
      readonly snapshot: object;
      readonly last: number | null;
    };
  };
  readonly version: number;
  readonly instance: string;
  readonly links?: {
    readonly known: readonly string[];
    readonly generation: number;
  };
}

/** What the pool holds (`kernel.diagnostics().pool`), in bytes. */
export interface PoolUsage {
  readonly limit: number;
  readonly segmentSize: number;
  /** Segments reserved, empty ones kept for reuse included. */
  readonly segments: number;
  readonly reserved: number;
  /** Bytes in allocations: published, retired or being published. */
  readonly used: number;
  /** `reserved − used`. */
  readonly free: number;
  /** The largest allocation that fits without a new segment. */
  readonly largestFree: number;
  /** `1 − largestFree / free`; 0 when nothing is free. */
  readonly fragmentation: number;
}

export interface CacheStats {
  readonly segmentCount: number;
  readonly emptyCount: number;
  readonly totalUsed: number;
  readonly lines: string[];
}

/**
 * Fills `view`, a Uint8Array over the SAB, with the bytes of `file.path`;
 * throws unless the file is read completely and consistently. Awaited:
 * synchronous or not.
 */
export type CacheReader = (
  file: FileInput,
  view: Uint8Array,
) => void | Promise<void>;

export interface FilesystemCacheOptions {
  limit: number;
  segmentSize: number;
  maxFileSize: number;
  reader?: CacheReader | null;
  /** The map every segment joins as it is made: id → SAB. */
  segments?: Map<number, SharedArrayBuffer>;
}

export interface AllocateOptions {
  /** Default: the cache-wide `maxFileSize`. */
  maxFileSize?: number;
}

/**
 * The pool of SharedArrayBuffer segments the main kernel allocates from,
 * exported for tests and benchmarks — not a stable API. It knows extents,
 * never keys: what is published, and under which key, is the places'
 * trees' business — the kernel commits an extent there or frees it here.
 */
export class FilesystemCache {
  constructor(options: FilesystemCacheOptions);
  readonly segmentSize: number;
  readonly maxFileSize: number;
  reader: CacheReader | null;
  /** Bytes of the segments reserved. */
  get totalUsed(): number;
  getSegment(id: number): Segment | null;
  /**
   * Place the bytes of one file, privately: its extent — the empty one for
   * an empty file — or null when they cannot live in SAB: above
   * `maxFileSize`, or no room in the pool.
   */
  allocate(file: FileInput, options?: AllocateOptions): Promise<Extent | null>;
  /**
   * Place in-memory bytes at once, synchronously, or null. A copy that
   * throws leaves nothing allocated.
   */
  allocateSync(
    file: FileInput & { data: Buffer },
    options?: AllocateOptions,
  ): Extent | null;
  /** An extent committed into a segment compaction closed reopens it. */
  committed(extent: Extent): void;
  /** A segment compaction closed is open to allocation again. */
  reopen(segmentId: number): void;
  /** Return an extent's bytes to the pool: nobody may still read them. */
  free(extent: Extent | null | undefined): void;
  /**
   * The least-utilised segment open to allocation, below `threshold` of
   * its size, while at least two are in use; null otherwise.
   */
  compactTarget(threshold: number): number | null;
  /**
   * Copy `extents` of `target` into free space of the other segments,
   * never growing the pool, and close `target`: their new extents, in
   * order, or null when not everything fits (nothing kept).
   */
  relocate(target: number, extents: readonly Extent[]): Extent[] | null;
  /** Every segment of the pool. */
  snapshot(): Segment[];
  /** What the pool holds, for diagnostics; changes nothing. */
  usage(): PoolUsage;
  stats(): CacheStats;
}
