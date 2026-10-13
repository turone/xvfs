// Types of place.js: a place of the kernel's registry, as the adapter API
// hands it back (kernel.js, Adapter API), and what its tree holds for a
// file (lib/tree.js). Internal: consumers get a PlaceFs facade through
// `kernel.fs(name)`.

import type { Origin, Provider, ResolvedPlace } from './config.js';

/**
 * One representation of a file — its source, or one derived from it — as
 * the place's tree holds it: an extent of the pool (a `map` place's own
 * buffer), the same object for as long as it is published. `data` is a new
 * view over its bytes on every access; read it once per operation.
 */
export interface FileRepresentation {
  /** 0 source, 1 require bytecode, 2 script bytecode, 3–6 gzip, deflate, br, zstd. */
  readonly kind: number;
  readonly segmentId: number;
  readonly offset: number;
  readonly length: number;
  readonly data: Buffer;
}

/**
 * What the place's tree holds for a file, immutable: a new one comes with
 * each publication of it, and a move keeps it. `source` is null for a file
 * read from disk.
 */
export interface FilePayload {
  /** The publication that made it; a `map` place's own count. */
  readonly version: number;
  readonly size: number;
  readonly mtimeMs: number;
  /** In a place that keeps it (`places.<name>.stat.birthtime`) only. */
  readonly birthtimeMs?: number;
  readonly source: FileRepresentation | null;
  readonly others: {
    readonly requireBytecode: FileRepresentation | null;
    readonly scriptBytecode: FileRepresentation | null;
    readonly gzip: FileRepresentation | null;
    readonly deflate: FileRepresentation | null;
    readonly br: FileRepresentation | null;
    readonly zstd: FileRepresentation | null;
  } | null;
  /** What its preparer attached, frozen; null when nothing. */
  readonly extras: {
    readonly meta: object | null;
    readonly scriptOptions: object | null;
  } | null;
}

export interface Place {
  readonly name: string;
  readonly config: ResolvedPlace;
  readonly provider: Provider;
  readonly origin: Origin | null;
  /** The place's directory: `appRoot/<name>`. */
  readonly root: string;
  /** Content is created by the application; nothing backs it on disk. */
  readonly virtual: boolean;
  /** The place's number in its kernel's config, from 1: `stat().dev`. */
  readonly dev: number;
  /** The payload of the file at `key`, or null: a directory, or nothing. */
  file(key: string): FilePayload | null;
  /** Whether `key` names a directory of the place's tree. */
  isDirectory(key: string): boolean;
  /** Absolute OS path of a key (`''` or `'/'` is the place directory). */
  pathOf(key: string): string;
}
