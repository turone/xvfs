// Types of cache.js: FilesystemCache, the pooled SharedArrayBuffer file
// cache the main kernel allocates from, and its data contract — the
// entries a snapshot carries and the files a thread projects from them.

import type { Encoding } from './config.js';
import type { ScriptOptions } from './pipeline.js';

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
  /** Frozen cloneable; travels with the entry. */
  meta?: object | null;
  scriptOptions?: ScriptOptions | null;
}

/** A file placed in a SAB segment. */
export interface SharedEntry {
  readonly kind: 'shared';
  readonly segmentId: number;
  readonly offset: number;
  readonly length: number;
  readonly stat: FileStat;
  readonly meta?: object;
  readonly scriptOptions?: ScriptOptions;
  /** The kernel's commit that published it; none before it is published. */
  readonly version?: number;
}

/** A file left on disk: above `maxFileSize`, no room, `retainRaw: false`. */
export interface DiskEntry {
  readonly kind: 'disk';
  readonly path: string | null;
  readonly stat: FileStat;
  readonly meta?: object;
  readonly scriptOptions?: ScriptOptions;
  /** The kernel's commit that published it; none before it is published. */
  readonly version?: number;
}

export type CacheEntry = SharedEntry | DiskEntry;

/** One namespace (place): its published entries only. */
export interface FsIndex {
  readonly entries: Map<string, CacheEntry>;
}

export interface Segment {
  readonly id: number;
  readonly sab: SharedArrayBuffer;
}

export interface PlaceSnapshot {
  readonly entries: [string, CacheEntry][];
}

/** What `FilesystemCache.snapshot()` gives: published entries only. */
export interface CacheSnapshot {
  readonly segments: Segment[];
  readonly places: { readonly [name: string]: PlaceSnapshot };
}

/**
 * What `kernel.snapshot()` gives a worker: published entries only, the
 * kernel's version and its instance; under strict with a place of `links:
 * 'deny'`, the links the kernel knows and the count of those made that it
 * holds, against the count every thread shares.
 */
export interface VfsSnapshot extends CacheSnapshot {
  readonly version: number;
  readonly instance: string;
  readonly links?: {
    readonly known: readonly string[];
    readonly made: Int32Array;
    readonly seen: number;
  };
}

/**
 * One physical version of a file, as a thread projects it: a zero-copy SAB
 * view (shared entry), an owned Buffer (map place) or `null` for an entry
 * kept on disk, which carries its `path`. `version`: the commit that
 * published a shared entry; none for a map place's file.
 */
export interface ProjectedFile {
  readonly data: Buffer | null;
  readonly stat: FileStat;
  readonly meta?: object;
  readonly scriptOptions?: ScriptOptions;
  readonly version?: number;
  readonly path?: string | null;
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
}

export interface AllocateOptions {
  /** Default: the cache-wide `maxFileSize`. */
  maxFileSize?: number;
  /** With `false`, a file that cannot live in SAB is null, no disk entry. */
  fallback?: boolean;
  /** Keep the file on disk. */
  onDisk?: boolean;
}

/**
 * Pooled SharedArrayBuffer file cache: the engine the main kernel
 * allocates from, exported for tests and benchmarks — not a stable API.
 * Placing bytes and publishing them are separate steps: `allocate()`
 * returns an entry nobody else sees; `put()` / `remove()` change the
 * index, which holds published entries only.
 */
export class FilesystemCache {
  constructor(options: FilesystemCacheOptions);
  readonly segmentSize: number;
  readonly maxFileSize: number;
  reader: CacheReader | null;
  /** Bytes of the segments reserved. */
  get totalUsed(): number;
  getSegment(id: number): Segment | null;
  index(name: string): FsIndex;
  entry(name: string, key: string): CacheEntry | null;
  /**
   * Place one file without publishing it: a shared entry, else a disk entry
   * (or null with `fallback: false`).
   */
  allocate(
    file: FileInput,
    options?: AllocateOptions,
  ): Promise<CacheEntry | null>;
  /**
   * Place in-memory bytes at once, synchronously: a shared entry, or null
   * when they cannot live in SAB. A copy that throws leaves nothing
   * allocated.
   */
  allocateSync(
    file: FileInput & { data: Buffer },
    options?: { maxFileSize?: number },
  ): SharedEntry | null;
  /** Publish `entry` under `key`; the entry it replaces, or null. */
  put(name: string, key: string, entry: CacheEntry): CacheEntry | null;
  /** Unpublish `key`; the removed entry, or null. */
  remove(name: string, key: string): CacheEntry | null;
  /** Return an entry's bytes to the pool: nobody may still read it. */
  free(entry: CacheEntry | null | undefined): void;
  /**
   * Plan the relocation of the least-utilised segment's published entries
   * (below `threshold`); the caller publishes the moves. Null when nothing
   * qualifies or not everything fits.
   */
  compact(
    threshold: number,
  ): { name: string; key: string; entry: SharedEntry }[] | null;
  snapshot(): CacheSnapshot;
  /** What the pool holds, for diagnostics; changes nothing. */
  usage(): PoolUsage;
  stats(): CacheStats;
  /** Projections of an index's entries into `files`. */
  static project(
    index: {
      entries: Map<string, CacheEntry> | Iterable<[string, CacheEntry]>;
    },
    segmentsMap: ReadonlyMap<number, SharedArrayBuffer>,
    files?: Map<string, ProjectedFile>,
  ): Map<string, ProjectedFile>;
  /** Zero-copy view of a shared entry; a disk entry carries only its path. */
  static projectEntry(
    entry: CacheEntry,
    segmentsMap: ReadonlyMap<number, SharedArrayBuffer>,
  ): ProjectedFile;
}
