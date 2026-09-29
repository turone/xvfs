// Types of stats.js: the stat and dirent facades of virtual entries.
// Created per call from an entry's `{ size, mtimeMs }`, never cached.

import type { BigIntStats, StatsBase } from 'node:fs';

/** A `fs.Stats`-shaped stat of a virtual file or implicit directory. */
export class VfsStats implements StatsBase<number> {
  #private;
  constructor(size: number, mtimeMs: number, directory?: boolean);
  size: number;
  /** `0o100644` for a file, `0o040755` for a directory. */
  mode: number;
  mtimeMs: number;
  atimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  mtime: Date;
  atime: Date;
  ctime: Date;
  birthtime: Date;
  nlink: number;
  uid: number;
  gid: number;
  dev: number;
  ino: number;
  rdev: number;
  blksize: number;
  blocks: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): false;
  isFIFO(): false;
  isSocket(): false;
  isBlockDevice(): false;
  isCharacterDevice(): false;
}

/**
 * The `{ bigint: true }` form of `VfsStats`: a `fs.BigIntStats` shape. At
 * runtime it is a subclass of `VfsStats` — `instanceof VfsStats` holds —
 * with every numeric field a bigint; the declaration keeps the two apart
 * so `size` and the times have one type each.
 */
export type VfsBigIntStats = BigIntStats;

/**
 * A `fs.Dirent`-shaped entry of a listing; `name` is a Buffer for
 * `encoding: 'buffer'`.
 */
export class VfsDirent<Name extends string | Buffer = string> {
  #private;
  constructor(name: Name, parentPath: string, directory: boolean);
  name: Name;
  parentPath: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): false;
  isFIFO(): false;
  isSocket(): false;
  isBlockDevice(): false;
  isCharacterDevice(): false;
}
