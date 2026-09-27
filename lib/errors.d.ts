// Types of errors.js: the refusals of the VFS, shaped as node:fs shapes its
// own errors. README, "Errors".

/**
 * A Node-style filesystem error of a virtual entry or a routing decision.
 * `code` is one of `EACCES`, `EROFS`, `ENOTSUP`, `ENOENT`, `EEXIST`,
 * `ENOTDIR`, `EISDIR`, `ENOTEMPTY`, `EXDEV`, `EINVAL`, `ENOSPC` (no room in
 * the pool), with `errno`, `syscall` and `path` as node:fs sets them and
 * `dest` for copies, links and renames; a copy refused by its destination
 * carries the write's error as `cause`. A stream stopped by
 * `kernel.close()` errors with `code` `ERR_VFS_CLOSED` and no `errno`,
 * `syscall` or `path`. `ERR_FS_EISDIR` and `ERR_FS_CP_*` are node:fs's
 * own `SystemError`; a mutation queued or asked after `close()` rejects
 * with a plain `Error` (`[vfs] …`) without `code`.
 */
export interface VfsError extends Error {
  code: string;
  errno?: number;
  syscall?: string;
  path?: string;
  dest?: string;
}
