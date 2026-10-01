// Types of module-hook.js: one `module.registerHooks` chain for require()
// and import, plus the `_compile` patch that applies V8 cached data and the
// `_resolveFilename` patch that lets require.resolve() name what require()
// loads.

import type { VfsKernel } from '../kernel.js';

/**
 * Register the resolve/load hooks and the `_compile` and `_resolveFilename`
 * patches over `kernel`. Once. `require.extensions` is not touched.
 */
export function install(kernel: VfsKernel): void;

/** Deregister the hooks and restore `_compile` and `_resolveFilename`. */
export function uninstall(): void;
