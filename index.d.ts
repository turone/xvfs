// Type declarations of the package entry (index.js), written by hand next
// to the modules they describe: each lib/*.d.ts declares what index.js
// exports of its module, and the types of that API. Checked by
// `npm run test:types` against test-types/, and by test/exports.test.js
// against the runtime exports.

import type { VfsKernel } from './lib/kernel.js';

export * from './lib/bootstrap/attach.js';
export * from './lib/cache.js';
export * from './lib/config.js';
export * from './lib/errors.js';
export * from './lib/kernel.js';
export * from './lib/pipeline.js';
export * from './lib/place.js';
export * from './lib/place-fs.js';
export * from './lib/registry.js';
export * from './lib/stats.js';

/**
 * The kernel published by `--import shared-memory-fs/register` or
 * `attach()`, or null: a getter, live. Not a named export for an ES
 * module — Node finds no `kernel` in the CommonJS entry — so in ESM read
 * `VfsKernel.current`, or `kernel` of the default import (the
 * `module.exports` object).
 */
export const kernel: VfsKernel | null;
