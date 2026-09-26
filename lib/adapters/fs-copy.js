'use strict';

/* eslint-disable consistent-return */
// A copy returns the destination's result, or nothing for one it skips.

const path = require('node:path');
const disk = require('../disk.js');
const { cpExistsError, cpOntoDirectoryError } = require('../errors.js');

// fs-copy — the copy engine of fs-patch. A single-file copy (copyFile, a
// non-recursive cp) hands the destination the source's raw input: the raw
// file on disk, or the canonical bytes of an unprepared virtual entry
// (FsRouter.copy). The destination publishes it through its own pipeline
// — a virtual place through its store, its preparer running once and no
// file appearing on disk; a disk destination gets the bytes on disk. The
// patch routes both ends and refuses, before anything is read, an option
// the copy cannot honor and a *Sync copy into a place that cannot block
// (copyOf, over what copyOptions() makes of the caller's arguments); the
// engine refuses what needs a stat — a symbolic link, a directory in the
// way — reads the raw input and writes the destination (copyThrough),
// answering the write's EEXIST as the copy's options say. Errors name the
// source (`path`) and the destination (`dest`): `fail` builds them.
// `kernel` is the one fs-patch is installed with, handed to each call and
// never kept.

const { COPYFILE_EXCL, COPYFILE_FICLONE_FORCE } = disk.constants;

// The options of a copy through the VFS: node:fs semantics for one file;
// what it cannot honor is refused, never ignored.
const copyOptions = (syscall, arg) => {
  const cp = syscall === 'cp';
  const options = cp ? arg || {} : {};
  const mode = (cp ? options.mode : arg) || 0;
  let unsupported = null;
  if (mode & COPYFILE_FICLONE_FORCE) unsupported = 'COPYFILE_FICLONE_FORCE';
  else if (options.filter) unsupported = 'filter';
  else if (options.preserveTimestamps) unsupported = 'preserveTimestamps';
  // copyFile: COPYFILE_EXCL. cp: `force` (default true) replaces an existing
  // file whatever the mode; without it, skip it or fail with errorOnExist.
  let existing = 'overwrite';
  if (!cp && mode & COPYFILE_EXCL) existing = 'fail';
  else if (options.force === false) {
    existing = options.errorOnExist ? 'fail' : 'skip';
  }
  return { cp, unsupported, existing, links: cp && !options.dereference };
};

const facadeOf = (kernel, route) => kernel.fs(route.place.name);

// Whether a copy's destination is a directory, in its place or on disk.
const isDirectoryAt = (kernel, target, to) =>
  target.kind === 'store'
    ? Boolean(facadeOf(kernel, target).stat(target.key)?.isDirectory())
    : disk.isDirectory(to);

// The raw input of a copy's source, once FsRouter.copy has allowed it (a
// hidden source is EACCES, one without raw input ENOTSUP): the canonical
// bytes of an unprepared virtual entry, else the file on disk — a Buffer, or
// a Promise of one.
const rawInputOf = (kernel, source, from, sync) => {
  if (source.kind === 'canonical') {
    return facadeOf(kernel, source).readFile(source.key);
  }
  return sync ? disk.readFileSync(from) : disk.promises.readFile(from);
};

// A write into the destination — its store or the disk — that fails is
// answered by `refuse`, sync or not; other errors (a preparer's) pass as
// they are.
const settle = (write, refuse) => {
  const failed = (err) => {
    if (!err?.syscall) throw err;
    return refuse(err);
  };
  try {
    const result = write();
    return result instanceof Promise ? result.catch(failed) : result;
  } catch (err) {
    return failed(err);
  }
};

// A copy's bytes on disk; cp first creates the directories the destination
// lacks, as node:fs cp does.
const diskWrite = (to, bytes, { flag, parents, sync }) => {
  const parent = path.dirname(to);
  if (sync) {
    if (parents) disk.mkdirSync(parent, { recursive: true });
    return disk.writeFileSync(to, bytes, { flag });
  }
  const made = parents
    ? disk.promises.mkdir(parent, { recursive: true })
    : Promise.resolve();
  return made.then(() => disk.promises.writeFile(to, bytes, { flag }));
};

// The raw bytes of one file, written through the destination: the source
// route (`canonical`, else on disk), the mutation route of the destination
// (`store`, else on disk), and the paths as the caller gave them. The patch
// (copyOf) has refused already an option the copy cannot honor and a *Sync
// copy into a place that cannot block; refused here is what needs a stat —
// a symbolic link into a store, a directory in the way of cp — and the
// write's EEXIST is answered as the copy's options say.
const copyThrough = (
  kernel,
  source,
  target,
  { from, to, options, sync, fail },
) => {
  const store = target.kind === 'store';
  const link = source.kind === 'passthrough' && options.links;
  if (store && link && disk.lstatSync(from).isSymbolicLink()) {
    throw fail('ENOTSUP', 'symbolic link');
  }
  // As node:fs: cp never puts a file on a directory, whatever `force` says.
  if (options.cp && isDirectoryAt(kernel, target, to)) {
    throw cpOntoDirectoryError(from, to);
  }
  const skip = options.existing === 'skip';
  if (
    skip &&
    (store ? facadeOf(kernel, target).exists(target.key) : disk.existsSync(to))
  ) {
    return undefined;
  }
  // An existing destination is the exclusive write's own EEXIST, found when
  // it runs: cp skips it or reports ERR_FS_CP_EEXIST, COPYFILE_EXCL fails.
  // Any other refusal fails as the copy, the write's error as its cause.
  const flag = options.existing === 'overwrite' ? 'w' : 'wx';
  const refuse = (err) => {
    if (err.code === 'EEXIST' && skip) return undefined;
    if (err.code === 'EEXIST' && options.cp) throw cpExistsError(to);
    throw Object.assign(fail(err.code), { cause: err });
  };
  const write = (bytes) =>
    settle(
      () =>
        store
          ? facadeOf(kernel, target).writeFile(target.key, bytes, { flag })
          : diskWrite(to, bytes, { flag, parents: options.cp, sync }),
      refuse,
    );
  const input = rawInputOf(kernel, source, from, sync);
  return input instanceof Promise ? input.then(write) : write(input);
};

module.exports = { copyOptions, copyThrough };
