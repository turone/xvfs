// Types of fs-patch.js: the node:fs patch, routed through the kernel.
// README, "Patched node:fs".

import type { VfsKernel } from '../kernel.js';

/**
 * Patch `node:fs` (sync, callback and promises forms) to route through
 * `kernel`. Once.
 */
export function install(kernel: VfsKernel): void;

/** Restore the original functions. */
export function uninstall(): void;
