// Types of errors.js: the refusals of the VFS, shaped as node:fs shapes its
// own errors. README, "Errors".

/**
 * A Node-style filesystem error of a virtual entry or a routing decision.
 * `code` is one of `EACCES`, `EROFS`, `ENOTSUP`, `ENOENT`, `EEXIST`,
 * `ENOTDIR`, `EISDIR`, `ENOTEMPTY`, `EXDEV`, `EINVAL`, `ENOSPC` (no room in
 * the pool right now), `EFBIG` (larger than `maxFileSize`: would refuse the
 * same way whatever the pool's state), with `errno`, `syscall` and `path`
 * as node:fs sets them and `dest` for copies, links and renames; a copy
 * refused by its destination carries the write's error as `cause`. A
 * stream stopped by `kernel.close()` errors with `code` `ERR_VFS_CLOSED`
 * and no `errno`, `syscall` or `path`, and so does a publication it cuts
 * short (`[vfs] kernel closed before publication`): `initialize()`, a
 * mutation still publishing, a worker's mutation its own kernel's
 * `close()` finds waiting or that is asked afterwards. `ERR_FS_EISDIR` and
 * `ERR_FS_CP_*` are node:fs's own `SystemError`; a mutation still queued
 * when a main kernel closes, or asked of it afterwards, rejects with a
 * plain `Error` (`[vfs] …`) without `code`, and so does a worker's
 * mutation whose main kernel closed.
 */
export interface VfsError extends Error {
  code: string;
  errno?: number;
  syscall?: string;
  path?: string;
  dest?: string;
}
