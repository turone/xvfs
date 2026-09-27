// Types of registry.js: the routing decisions FsRouter makes of an absolute
// path, as `kernel.routeRead()` and `kernel.routeMutation()` return them
// (kernel.js, Adapter API).

import type { Place } from './place.js';

export type DenialCode = 'EACCES' | 'EROFS' | 'ENOTDIR';

/**
 * A path a place serves: `file`, a published source visible to the fs
 * domain; `dir`, an implicit directory of an indexed place; `disk`, the
 * disk territory of `fs.fallback: 'disk'`. `key` is `'/'`-separated with
 * a leading `'/'`, `''` for the mount itself.
 */
export interface ServedRoute {
  readonly kind: 'file' | 'dir' | 'disk';
  readonly place: Place;
  readonly key: string;
}

/** `appRoot` under strict: a managed root that lists the enabled places. */
export interface RootRoute {
  readonly kind: 'root';
}

/** Original node:fs handles it. */
export interface PassthroughRoute {
  readonly kind: 'passthrough';
}

/**
 * `EACCES` under strict or `fs.fallback`; `ENOTDIR` for a served file
 * named with a trailing separator.
 */
export interface ReadDenial {
  readonly kind: 'deny';
  readonly code: DenialCode;
}

export type ReadRoute = ServedRoute | RootRoute | PassthroughRoute | ReadDenial;

/**
 * A mutation owned by the place's store: a per-thread Map, or the main
 * kernel for a shared virtual place. A trailing separator stays as a slash
 * on the key: a directory.
 */
export interface StoreRoute {
  readonly kind: 'store';
  readonly place: Place;
  readonly key: string;
}

/**
 * `EACCES` under strict (`appRoot` itself included), `EROFS` for a
 * read-only place.
 */
export interface MutationDenial {
  readonly kind: 'deny';
  readonly code: 'EACCES' | 'EROFS';
}

/** `passthrough`: a disk write — disk-origin, `disk`, `node-default`. */
export type MutationRoute = StoreRoute | PassthroughRoute | MutationDenial;
