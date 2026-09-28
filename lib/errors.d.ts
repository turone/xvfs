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
 * and no `errno`, `syscall` or `path`, and so does every mutation a closed
 * kernel refuses: a publication `close()` cuts short (`[vfs] kernel closed
 * before publication`) — `initialize()`, a mutation still publishing, a
 * worker's mutation its own kernel's `close()` finds waiting or that is
 * asked afterwards; a mutation still queued when a main kernel closes, or
 * asked of it afterwards (`[vfs] mutations requires a ready kernel (state:
 * closed)`); a worker's mutation whose link closed before its answer
 * (`[vfs] link closed before the mutation was answered: it may or may not
 * have been published`). `ERR_FS_EISDIR` and `ERR_FS_CP_*` are node:fs's
 * own `SystemError`; another call that needs a ready kernel (`fs()`,
 * `snapshot()`, `link()`, …) throws a plain `Error` (`[vfs] …`) without
 * `code`.
 */
export interface VfsError extends Error {
  code: string;
  errno?: number;
  syscall?: string;
  path?: string;
  dest?: string;
}
