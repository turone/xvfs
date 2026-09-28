// Types of place-fs.js: PlaceFs, the per-place file API `kernel.fs(name)`
// returns, its leases and streams. README, "PlaceFs" and "Lifetime of
// shared bytes".

import type { RmOptions } from 'node:fs';
import type { Readable } from 'node:stream';
import type { CompressedStat } from './cache.js';
import type { DeepReadonly, Encoding, IndexedProvider } from './config.js';
import type { ScriptOptions } from './pipeline.js';
import type { VfsBigIntStats, VfsDirent, VfsStats } from './stats.js';

/**
 * A lease over the current version of a file (`fs.zeroCopy`): `view` is a
 * direct SAB Buffer, stable until `release()`, never to be mutated or used
 * afterwards — `Buffer.from(view)` keeps the bytes. `version` is the
 * file's (`PlaceFs.version()`). `release()` is synchronous and idempotent.
 * Map places hold owned Buffers: their leases are no-ops.
 */
export interface FileLease {
  readonly view: Buffer;
  readonly version: number | null;
  readonly release: () => void;
  readonly [Symbol.dispose]: () => void;
}

/**
 * A Readable over one pinned version of a file. Owned chunks release the
 * version when the stream ends, errors or is destroyed; borrowed chunks
 * (`zeroCopy`) only through `release()`, since a downstream socket may
 * still hold them after the stream ends. A stream of a file kept on disk
 * reads it from disk; `release()` only stops it.
 */
export interface VfsReadStream extends Readable {
  /** Ends the lease, stopping the stream first if it still reads. */
  release(): void;
  [Symbol.dispose](): void;
}

export interface ReadFileOptions {
  encoding?: BufferEncoding | null;
  signal?: AbortSignal;
}

export interface ReadStreamOptions {
  start?: number;
  /** Inclusive. */
  end?: number;
  encoding?: BufferEncoding | null;
  /** Default 64 KiB. */
  highWaterMark?: number;
  signal?: AbortSignal;
  /** Borrowed SAB chunks; the place's `fs.zeroCopy` by default. */
  zeroCopy?: boolean;
}

/** `'/'`, the form of keys; `'\\'`, what native node:fs gives on Windows. */
export type ListingSeparator = '/' | '\\';

export interface ListingOptions {
  recursive?: boolean;
  /**
   * The separator of recursive names (without `withFileTypes`): `'/'` by
   * default, the form of keys, on every platform; `sep: path.sep` asks for
   * the native one — what the patched node:fs lists with — in the same
   * order, the keys'. Anything else is a `TypeError`.
   */
  sep?: ListingSeparator;
}

export interface ReaddirOptions extends ListingOptions {
  withFileTypes?: boolean;
  encoding?: BufferEncoding | 'buffer' | null;
}

export interface StatOptions {
  bigint?: boolean;
}

export interface WriteFileOptions {
  encoding?: BufferEncoding | null;
  /** As node:fs reads it: `w…` replaces, `a…` appends, `x` creates only. */
  flag?: string;
}

/**
 * The files of `writeFiles`: `[key, data]` pairs — an array, a `Map`, any
 * iterable — or an object of key → data.
 */
export type WriteFilesInput =
  | Iterable<readonly [key: string, data: string | Uint8Array]>
  | { readonly [key: string]: string | Uint8Array };

export interface WriteFilesOptions {
  /** Of the strings. */
  encoding?: BufferEncoding | null;
  /**
   * One flag for the set, as node:fs reads it: `w…` replaces; `x` creates
   * every key only — `wx` or `xw`, and `ax` or `xa` too, which create as
   * well; an append flag without `x` (`a`, `as`, `a+`…), a read or a
   * numeric flag is `ENOTSUP`. Default `'w'`.
   */
  flag?: string;
}

export interface MkdirOptions {
  recursive?: boolean;
  /** Disk only. */
  mode?: number | string;
}

/**
 * Everything needed to build a local `vm.Script` for a source `fs.script`
 * covers: `new vm.Script(source, { ...scriptOptions, cachedData })`.
 * `source` and `cachedData` are owned copies; `scriptOptions` and `meta`
 * are the frozen objects the entry holds, shared by every call.
 * `cachedData` is null when `fs.script.compile` is off. `version` is the
 * file's (`PlaceFs.version()`): a script built from the bundle serves until
 * it changes.
 */
export interface ScriptBundle<M extends object = Record<string, unknown>> {
  source: string;
  cachedData: Buffer | null;
  scriptOptions: Readonly<ScriptOptions> | null;
  meta: DeepReadonly<M> | null;
  version: number | null;
}

/** Sync for map and disk-origin places, a Promise for `sab + virtual`. */
export type MutationResult = void | Promise<void>;

/**
 * Public, per-place file API returned by `kernel.fs(name)`. Reads are
 * synchronous Map lookups; missing files yield null. `readFile` returns
 * owned copies. Keys: exact, then `'/' + key`; mutations take a canonical
 * key (a leading slash, then names) and a trailing slash names a
 * directory. Where a domain declares `prepare`, the prepared source is the
 * canonical content every read sees.
 */
export class PlaceFs {
  #private;
  private constructor();
  get name(): string;
  /** The place's directory: `appRoot/<name>`. */
  get root(): string;
  get provider(): IndexedProvider;
  get writable(): boolean;
  get zeroCopy(): boolean;
  /** Absolute OS path of a key, also for entries that exist only in memory. */
  pathOf(key: string): string;
  /** A file, or an implicit directory. */
  exists(key: string): boolean;
  /**
   * The version of the commit that published the file of a shared place
   * (`sab`, `sea`): equal for the files one commit published, the same in
   * every thread. Null for a missing key, a `map` place's file and the disk
   * territory.
   */
  version(key: string): number | null;
  stat(key: string, options?: { bigint?: false }): VfsStats | null;
  stat(key: string, options: { bigint: true }): VfsBigIntStats | null;
  stat(key: string, options: StatOptions): VfsStats | VfsBigIntStats | null;
  /** An owned copy: safe to keep and to mutate. */
  readFile(
    key: string,
    options?: { encoding?: null; signal?: AbortSignal } | null,
  ): Buffer | null;
  readFile(
    key: string,
    options:
      { encoding: BufferEncoding; signal?: AbortSignal } | BufferEncoding,
  ): string | null;
  readFile(
    key: string,
    options?: ReadFileOptions | BufferEncoding | null,
  ): Buffer | string | null;
  /**
   * A lease over the current version; needs `fs.zeroCopy` (`ENOTSUP`
   * otherwise). Null when the key is missing or kept on disk.
   */
  readFileView(key: string): FileLease | null;
  /** The view of `key` for the duration of `fn`; null when there is none. */
  withFileView<T>(
    key: string,
    fn: (view: Buffer) => T | PromiseLike<T>,
  ): Promise<T | null>;
  /** Options, or an encoding string. Null when the key is missing. */
  createReadStream(
    key: string,
    options?: ReadStreamOptions | BufferEncoding,
  ): VfsReadStream | null;
  /**
   * Directory listing, implicit directories included, merged with the disk
   * territory of a partial cache; lexicographic order of the string names.
   * Throws `ENOENT` / `ENOTDIR`.
   */
  readdir(
    key: string,
    options?:
      | (ListingOptions & {
          withFileTypes?: false;
          encoding?: BufferEncoding | null;
        })
      | BufferEncoding
      | null,
  ): string[];
  readdir(
    key: string,
    options:
      | (ListingOptions & { withFileTypes?: false; encoding: 'buffer' })
      | 'buffer',
  ): Buffer[];
  readdir(
    key: string,
    options: ListingOptions & {
      withFileTypes: true;
      encoding?: BufferEncoding | null;
    },
  ): VfsDirent[];
  readdir(
    key: string,
    options: ListingOptions & { withFileTypes: true; encoding: 'buffer' },
  ): VfsDirent<Buffer>[];
  readdir(
    key: string,
    options?: ReaddirOptions | BufferEncoding | 'buffer' | null,
  ): string[] | Buffer[] | VfsDirent[] | VfsDirent<Buffer>[];
  /**
   * Representations actually present, config order; `'raw'` only when the
   * source is in memory.
   */
  storedEncodings(key: string): ('raw' | Encoding)[];
  /** An owned copy; `ENOTSUP` for an encoding the place does not configure. */
  readFileCompressed(key: string, encoding: Encoding): Buffer | null;
  /** A lease over the compressed bytes only; needs `fs.zeroCopy`. */
  readFileCompressedView(key: string, encoding: Encoding): FileLease | null;
  statCompressed(key: string, encoding: Encoding): CompressedStat | null;
  /** The range addresses the compressed bytes. */
  createReadStreamCompressed(
    key: string,
    encoding: Encoding,
    options?: ReadStreamOptions,
  ): VfsReadStream | null;
  /**
   * The bundle of a source `fs.script` covers; null for any other key.
   * `ENOTSUP` when the place has no `fs.script`.
   */
  script<M extends object = Record<string, unknown>>(
    key: string,
  ): ScriptBundle<M> | null;
  /** Frozen metadata a preparer attached to the file, or null. */
  meta<M extends object = Record<string, unknown>>(
    key: string,
  ): DeepReadonly<M> | null;
  /**
   * Under strict routing on Windows this and every other mutation refuse a
   * key with NTFS stream syntax or a name in 8.3 form anywhere in it — the
   * spellings `node:fs` is refused below `appRoot` — with `EACCES`, before
   * the place's own checks, in any place.
   */
  writeFile(
    key: string,
    data: string | Uint8Array,
    options?: WriteFileOptions | BufferEncoding,
  ): MutationResult;
  /**
   * Several files of a virtual place as one publication: the whole set is
   * checked before any file is prepared, each file is prepared once, and
   * it is published in one commit — one update, one version, one event —
   * or not at all. A `TypeError` for no file, a key twice or data that is
   * not a string or bytes; `ENOTSUP` for a disk-origin place; under strict
   * on Windows, `EACCES` for a key in a stream or 8.3 spelling (see
   * `writeFile`). A Promise of the version of the commit for
   * `sab + virtual`, undefined for a `map` place.
   */
  writeFiles(
    files: WriteFilesInput,
    options?: WriteFilesOptions | BufferEncoding,
  ): void | Promise<number>;
  /** `ENOTSUP` for a prepared key of a virtual place: no raw input kept. */
  appendFile(
    key: string,
    data: string | Uint8Array,
    options?: WriteFileOptions | BufferEncoding,
  ): MutationResult;
  unlink(key: string): MutationResult;
  /**
   * Creates no entry in an indexed place (directories are implicit) but
   * checks the hierarchy; on disk, node:fs's own — the first directory
   * created with `recursive`.
   */
  mkdir(key: string, options?: MkdirOptions): MutationResult | string;
  rm(key: string, options?: RmOptions): MutationResult;
  /**
   * A prepared key of a virtual place is `ENOTSUP`; a directory moves as a
   * raw-only subtree.
   */
  rename(from: string, to: string): MutationResult;
}
