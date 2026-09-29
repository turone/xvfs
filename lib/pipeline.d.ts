// Types of pipeline.js: the preparer contract — the callbacks the kernel
// option `preparers` (and `attach({ preparers })`) registers under the
// names the domains' `prepare` declares. README, "Preparation".

import type { ScriptOptions as VmScriptOptions } from 'node:vm';
import type { FileStat } from './cache.js';

/**
 * `vm.Script` options a preparer attaches to a file: the library passes
 * them to V8 when producing the `fs.script` cached data and ships them in
 * the bundle (`PlaceFs.script()`). `cachedData`, `produceCachedData` and
 * `importModuleDynamically` are reserved.
 */
export type ScriptOptions = Omit<
  VmScriptOptions,
  'cachedData' | 'produceCachedData' | 'importModuleDynamically'
>;

/** What a preparer is told about the file it prepares; frozen. */
export interface PreparerFile {
  readonly place: string;
  readonly key: string;
  /** Absolute OS path of the key. */
  readonly path: string;
  readonly ext: string;
  /** Of the raw input. */
  readonly stat: FileStat;
}

export interface PreparerResult {
  source: string | Uint8Array;
  scriptOptions?: ScriptOptions | null;
  /** Structured-cloneable; stored frozen with the entry. */
  meta?: object | null;
}

/**
 * Turns the raw input of a file into its one canonical content. Synchronous:
 * a Promise or thenable is a `TypeError`. `null` or `undefined` publishes
 * the raw bytes unchanged; returned bytes are copied the moment the
 * preparer returns, so it may reuse its buffer.
 */
export type Preparer = (
  raw: Buffer,
  file: PreparerFile,
) => string | Uint8Array | PreparerResult | null | undefined | void;

/** `{ name: fn }`, the functions the domains' `prepare` names. */
export interface PreparerTable {
  readonly [name: string]: Preparer;
}
