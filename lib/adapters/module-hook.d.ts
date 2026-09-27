// Types of module-hook.js: one `module.registerHooks` chain for require()
// and import, plus the `_compile` patch that applies V8 cached data.

import type { VfsKernel } from '../kernel.js';

/**
 * Register the resolve/load hooks and the `_compile` patch over `kernel`.
 * Once.
 */
export function install(kernel: VfsKernel): void;

/** Deregister the hooks and restore `_compile`. */
export function uninstall(): void;
