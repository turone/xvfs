// Types of place.js: a place of the kernel's registry, as the adapter API
// hands it back (kernel.js, Adapter API). Internal: consumers get a PlaceFs
// facade through `kernel.fs(name)`.

import type { Origin, Provider, ResolvedPlace } from './config.js';

export interface Place {
  readonly name: string;
  readonly config: ResolvedPlace;
  readonly provider: Provider;
  readonly origin: Origin | null;
  /** The place's directory: `appRoot/<name>`. */
  readonly root: string;
  /** Content is created by the application; nothing backs it on disk. */
  readonly virtual: boolean;
  /** Absolute OS path of a key (`''` or `'/'` is the place directory). */
  pathOf(key: string): string;
}
