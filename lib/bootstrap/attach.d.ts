// Types of attach.js: the worker-side counterpart of `kernel.link()`.

import type { VfsKernel, VfsLink } from '../kernel.js';
import type { PreparerTable } from '../pipeline.js';

export interface AttachOptions {
  /** The `vfs` object of `kernel.link()`. Default `workerData.vfs`. */
  link?: VfsLink;
  /**
   * For local writes to map places whose domains declare `prepare`; a
   * write whose preparer is missing fails with `ENOTSUP`.
   */
  preparers?: PreparerTable;
}

/**
 * Rebuilds a read-only projection over the shared segments, installs the
 * hooks the config asks for, applies and ACKs the deltas (`vfs-update`)
 * arriving through the `MessagePort` created by `kernel.link()` (`link.port`,
 * an in-process channel to the main thread) and publishes the kernel as
 * `VfsKernel.current`. Idempotent: an attached kernel is returned again.
 * Throws without a link.
 */
export function attach(options?: AttachOptions): VfsKernel;
