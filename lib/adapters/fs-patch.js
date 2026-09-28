'use strict';

/* eslint-disable consistent-return, no-invalid-this */
// Operation cores return PASS or the operation's result (often undefined);
// variant wrappers are installed on fs and forward the caller's `this`.

const fs = require('node:fs');
const { Blob } = require('node:buffer');
const path = require('node:path');
const { Readable } = require('node:stream');
const { fileURLToPath } = require('node:url');
const disk = require('../disk.js');
const { fsError, argumentTypeError } = require('../errors.js');
const { listedNames } = require('../registry.js');
const { statsOf, listing } = require('../stats.js');
const { copyOptions, copyThrough } = require('./fs-copy.js');
const { VfsDir } = require('./fs-dir.js');

// fs-patch — routes node:fs calls through the kernel's FsRouter and executes
// its decision; it never interprets config itself.
//   'file' / 'dir'   served from the place's PlaceFs facade
//   'root'           the strict appRoot: lists the enabled places, stats as
//                    a directory, refuses everything else
//   'store'          mutation owned by the place's store (per-thread Map, or
//                    the main kernel for a shared virtual place)
//   'disk'           disk territory of `fs.fallback: 'disk'`: original
//                    node:fs, but a listing (readdir, opendir) is the
//                    place's merged listing
//   'passthrough'    original node:fs
//   'deny'           Node-style error (EACCES / EROFS)
// Implemented: readFile, stat, lstat, existsSync, access, realpath (its
// .native variants too), readdir,
// opendir (a Dir over the listing, fs-dir.js), open (a descriptor to the
// raw file for a flag that only writes, where the mutation routing lets it
// through; none that reads what the VFS serves), createReadStream,
// openAsBlob (a Blob over the canonical
// content), writeFile, appendFile, unlink, mkdir, rm, rename, copyFile and
// single-file cp — sync, callback and promises forms where Node has them.
// A copy hands the source's raw input to the destination's own pipeline
// (the copy engine, fs-copy.js); a disk rename moves the raw file once its
// source passes the read routing; an open whose flag writes passes the
// mutation routing too. A mutation that has to reach the main kernel
// cannot block, so the *Sync forms refuse it with ENOTSUP.
// Recognized but unsupported for managed territory (ENOTSUP, nothing read or
// written): a native operation runs only once every path it touches has
// been routed. So:
//   a copy or rename of a prepared virtual entry (no raw input left), a
//   recursive cp of or into managed territory, a hard link into or out of
//   a place;
//   watch of managed territory, and a recursive watch of a tree that holds
//   places;
//   recursive walks (readdir, opendir, watch, rm, rmdir, cp) and rename
//   from appRoot passed through or from a directory above it, and a
//   directory renamed across a place's boundary (a place's root included),
//   and a virtual subtree that is not raw-only;
//   guarded mutations in a virtual place, an open whose flag writes
//   included: only its store changes its entries.
// A hidden source is EACCES: no copy, link or rename makes it readable.
// Guarded passthrough (chmod, utimes, symlink, readlink, statfs,
// truncate, rmdir, watchFile): not implemented, they only ever refuse
// a routing decision the kernel denies, so strict routing or a read-only
// place cannot be bypassed — nor probed — through them; on the strict
// appRoot itself they are refused outright. glob walks with the node:fs
// functions it captured when it loaded: install() loads it, so it walks
// through the wrappers (see glob below).
// Everything else, and every unrelated path outside appRoot, is untouched
// node:fs; full node:fs coverage is not promised.

const PASS = Symbol('passthrough');

let kernel = null;
let installed = null; // [{ target, name, original }]

const pathOf = (p) => {
  if (typeof p === 'string') return p;
  if (p instanceof URL) return fileURLToPath(p);
  if (Buffer.isBuffer(p)) return p.toString();
  return null; // file descriptor
};

const facadeOf = (route) => kernel.fs(route.place.name);

// Read routing shared by every read-side operation. `syscall` names the
// operation in errors. Disk territory is native except for a `listing`: a
// raw disk directory would show files the place serves only once published.
const readRoute = (p, syscall, listing = false) => {
  const filePath = pathOf(p);
  if (filePath === null) return PASS;
  const route = kernel.routeRead(filePath);
  if (route.kind === 'passthrough') return PASS;
  if (route.kind === 'disk' && !listing) return PASS;
  if (route.kind === 'deny') throw fsError(route.code, syscall, filePath);
  return route;
};

// A mutation of a shared virtual place is published by the main kernel, so
// it cannot block; the place's own directory never reaches the store and
// answers at once.
const needsAsync = (route) =>
  route.key !== '' && route.place?.store?.sync === false;

const mutationRoute = (p, syscall, sync) => {
  const filePath = pathOf(p);
  if (filePath === null) return PASS;
  const route = kernel.routeMutation(filePath);
  if (route.kind === 'passthrough') return PASS;
  if (route.kind === 'deny') throw fsError(route.code, syscall, filePath);
  if (sync && needsAsync(route)) {
    throw fsError('ENOTSUP', syscall, filePath, 'asynchronous place');
  }
  return route;
};

// A mutation the patch does not implement: denied as routed, and refused in
// a virtual place — a native call would bypass the store that owns it.
const guardMutation = (p, syscall) => {
  if (mutationRoute(p, syscall) === PASS) return;
  throw fsError('ENOTSUP', syscall, pathOf(p), 'virtual place');
};

// A native operation that walks a tree — or acts on everything under its
// path — checks only that path. From appRoot passed through, or from a
// directory above it, the walk would enter the places past their routing.
const walkGuard = (p, syscall, dest) => {
  const filePath = pathOf(p);
  if (filePath === null || !kernel.enclosesPlaces(filePath)) return;
  throw fsError('ENOTSUP', syscall, filePath, 'walks into places', dest);
};

// A copy hands the source's raw input to the destination (FsRouter.copy):
// the raw file on disk, or the canonical bytes of an unprepared virtual
// entry. Raw on disk into a native destination is node:fs itself; anything
// else is written through the destination by the copy engine (fs-copy.js)
// — a virtual place publishes the bytes through its own pipeline, its
// preparer running once, and no file appears on disk. A recursive copy
// never touches managed territory. The refusals that read nothing are made
// here — an option the copy cannot honor, a *Sync copy into a place that
// cannot block; the copy engine does the rest, `options` being its
// copyOptions(). Errors name the source (`path`) and the destination
// (`dest`).
const copyOf = (src, dest, syscall, recursive, options, sync) => {
  const from = pathOf(src);
  const to = pathOf(dest);
  if (from === null || to === null) return PASS;
  const fail = (code, detail) => fsError(code, syscall, from, detail, to);
  const source = kernel.routeCopy(from, recursive);
  if (source.kind === 'deny') throw fail(source.code);
  if (source.kind === 'unsupported') throw fail('ENOTSUP', 'managed source');
  const target = kernel.routeMutation(to);
  if (target.kind === 'deny') throw fail(target.code);
  // A native walk stays native at both ends.
  if (recursive) {
    if (kernel.routeCopy(to, true).kind !== 'passthrough') {
      throw fail('ENOTSUP', 'managed destination');
    }
    return PASS;
  }
  if (source.kind === 'passthrough' && target.kind === 'passthrough') {
    return PASS;
  }
  if (options.unsupported) throw fail('ENOTSUP', options.unsupported);
  // needsAsync() is false for the only other target left, a passthrough.
  if (sync && needsAsync(target)) throw fail('ENOTSUP', 'asynchronous place');
  return copyThrough(kernel, source, target, { from, to, options, sync, fail });
};

const optionsOf = (args) => (typeof args[0] === 'object' ? args[0] : {});

// A recursive listing names its entries with path.sep, as native node:fs
// does; a place names them with '/', the form of its keys, and so does
// PlaceFs.readdir unless asked for a separator (stats.listing): the patch
// asks for the native one where it differs.
const nativeNames = (opts) =>
  opts?.recursive && path.sep !== '/' ? { ...opts, sep: path.sep } : opts || {};

const isDirectoryRoute = (route) =>
  route.kind === 'dir' || route.kind === 'root';

// The strict appRoot lists the enabled places and nothing else. A recursive
// listing descends into each place through the patched fs itself, so every
// place applies its own routing; one it refuses lists as a bare name.
const readRoot = (root, options) => {
  const entries = new Map(); // relative '/'-separated name → isDirectory
  const nameOf = listedNames(path, root);
  for (const name of kernel.rootEntries()) {
    entries.set(name, true);
    if (!options.recursive) continue;
    let children = [];
    try {
      children = fs.readdirSync(path.join(root, name), {
        recursive: true,
        withFileTypes: true,
      });
    } catch {
      // Denied, or no directory on disk.
    }
    for (const child of children) {
      const rel = nameOf(child.parentPath ?? child.path, child.name);
      entries.set(rel, child.isDirectory());
    }
  }
  return listing(entries, options, (dir) =>
    dir === '' ? root : path.join(root, dir),
  );
};

// What a Dir (VfsDir, fs-dir.js) lists: the strict appRoot, or a directory
// of a place.
const dirEntries = (route, dirPath, options) => {
  if (route.kind === 'root') return readRoot(dirPath, options);
  const files = facadeOf(route);
  const stat = files.stat(route.key);
  if (!stat) throw fsError('ENOENT', 'opendir', dirPath);
  if (!stat.isDirectory()) throw fsError('ENOTDIR', 'opendir', dirPath);
  return files.readdir(route.key, options);
};

const statOf = (p, args, syscall) => {
  const route = readRoute(p, syscall);
  if (route === PASS) return PASS;
  const options = optionsOf(args);
  if (route.kind !== 'root') return facadeOf(route).stat(route.key, options);
  return statsOf(0, 0, { ...options, directory: true });
};

// The options of a read or a write, as node:fs takes their signal: an
// asynchronous one already aborted fails before it starts; a *Sync form
// takes none, so it passes none on.
const signalled = (options, sync) => {
  const signal = typeof options === 'object' ? options?.signal : undefined;
  if (!signal) return options;
  if (sync) return { ...options, signal: undefined };
  if (!signal.aborted) return options;
  const err = new Error('The operation was aborted', { cause: signal.reason });
  throw Object.assign(err, { name: 'AbortError', code: 'ABORT_ERR' });
};

// Whether an open() flag may change the file: a string with 'w', 'a', 'x'
// or '+', a number with a bit that writes, creates, truncates or appends.
// None is 'r'. And whether the descriptor can read it: a string with 'r'
// or '+', a number without O_WRONLY or with O_RDWR — so 'w', 'a', 'wx',
// O_WRONLY | O_CREAT only write.
const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;
const WRITING = O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND;
const writes = (flags) =>
  typeof flags === 'number'
    ? (flags & WRITING) !== 0
    : typeof flags === 'string' && /[wax+]/.test(flags);
const reads = (flags) =>
  typeof flags === 'number'
    ? (flags & O_WRONLY) === 0 || (flags & O_RDWR) !== 0
    : typeof flags !== 'string' || /[r+]/.test(flags);

// --- Operation cores: (path, args) → result | PASS, or throw ---

const ops = {
  readFile(p, [options], sync) {
    const route = readRoute(p, 'open');
    if (route === PASS) return PASS;
    const opts = signalled(options, sync);
    if (isDirectoryRoute(route)) throw fsError('EISDIR', 'read');
    return facadeOf(route).readFile(route.key, opts);
  },

  stat(p, args) {
    return statOf(p, args, 'stat');
  },

  lstat(p, args) {
    return statOf(p, args, 'lstat');
  },

  access(p, [mode = fs.constants.F_OK]) {
    const filePath = pathOf(p);
    const route = readRoute(p, 'access');
    if (route === PASS) return PASS;
    const { W_OK, X_OK } = fs.constants;
    if (mode & X_OK) throw fsError('EACCES', 'access', filePath);
    if (mode & W_OK && (route.kind === 'root' || !facadeOf(route).writable)) {
      throw fsError('EACCES', 'access', filePath);
    }
    return undefined;
  },

  realpath(p) {
    const route = readRoute(p, 'lstat');
    if (route === PASS) return PASS;
    return path.resolve(pathOf(p));
  },

  readdir(p, [options]) {
    const route = readRoute(p, 'scandir', true);
    const opts = typeof options === 'string' ? { encoding: options } : options;
    if (route === PASS) {
      if (opts?.recursive) walkGuard(p, 'scandir');
      return PASS;
    }
    if (route.kind === 'file') throw fsError('ENOTDIR', 'scandir', pathOf(p));
    const listed = nativeNames(opts);
    if (route.kind === 'root') return readRoot(pathOf(p), listed);
    return facadeOf(route).readdir(route.key, listed);
  },

  // A Dir over the same listing; `recursive` walks the whole subtree.
  opendir(p, [options]) {
    const route = readRoute(p, 'opendir', true);
    const opts =
      typeof options === 'string' ? { encoding: options } : { ...options };
    if (route === PASS) {
      if (opts.recursive) walkGuard(p, 'opendir');
      return PASS;
    }
    const dirPath = pathOf(p);
    const entries = dirEntries(route, dirPath, {
      withFileTypes: true,
      recursive: Boolean(opts.recursive),
      encoding: opts.encoding,
    });
    return new VfsDir(Buffer.isBuffer(p) ? p : dirPath, entries);
  },

  // A descriptor is the raw file. The read routing answers for what it can
  // read: a hidden path is EACCES, and an entry the place serves from the
  // VFS has no descriptor to read — the raw file is not its canonical
  // content, and a virtual entry has no raw file at all — whatever else
  // the flag does. A flag that only writes reads nothing: it is writeFile
  // with a descriptor, and the mutation routing alone answers it, as it
  // answers writeFile — a guarded mutation that node:fs would otherwise
  // make past a read-only place or into a virtual place's directory on
  // disk; in a disk-origin place the raw file, published or not, which the
  // watcher republishes.
  open(p, [flags]) {
    const filePath = pathOf(p);
    if (filePath === null) return PASS;
    const writeOnly = writes(flags) && !reads(flags);
    const route = kernel.routeRead(filePath);
    if (route.kind === 'passthrough' || route.kind === 'disk') {
      if (writes(flags)) guardMutation(p, 'open');
      return PASS;
    }
    if (route.kind === 'deny') {
      if (!writeOnly) throw fsError(route.code, 'open', filePath);
    } else if (
      !writeOnly ||
      kernel.routeCopy(filePath).kind !== 'passthrough'
    ) {
      throw fsError('ENOTSUP', 'open', filePath, 'virtual file');
    }
    // The raw file of a published disk-origin entry, or a hidden path, for
    // a flag that only writes: its mutation routing decides.
    guardMutation(p, 'open');
    return PASS;
  },

  writeFile(p, [data, options], sync) {
    const route = mutationRoute(p, 'open', sync);
    if (route === PASS) return PASS;
    const opts = signalled(options, sync);
    return facadeOf(route).writeFile(route.key, data, opts);
  },

  appendFile(p, [data, options], sync) {
    const route = mutationRoute(p, 'open', sync);
    if (route === PASS) return PASS;
    const opts = signalled(options, sync);
    return facadeOf(route).appendFile(route.key, data, opts);
  },

  unlink(p, args, sync) {
    const route = mutationRoute(p, 'unlink', sync);
    if (route === PASS) return PASS;
    return facadeOf(route).unlink(route.key);
  },

  mkdir(p, [options], sync) {
    const route = mutationRoute(p, 'mkdir', sync);
    if (route === PASS) return PASS;
    return facadeOf(route).mkdir(route.key, options);
  },

  rm(p, [options], sync) {
    const route = mutationRoute(p, 'rm', sync);
    if (route === PASS) {
      if (options?.recursive) walkGuard(p, 'rm');
      return PASS;
    }
    return facadeOf(route).rm(route.key, options || {});
  },

  // Guarded, not implemented; the deprecated `recursive` walks like rm.
  rmdir(p, [options]) {
    guardMutation(p, 'rmdir');
    if (options?.recursive) walkGuard(p, 'rmdir');
    return PASS;
  },

  copyFile(src, [dest, mode], sync) {
    const options = copyOptions('copyfile', mode);
    return copyOf(src, dest, 'copyfile', false, options, sync);
  },

  cp(src, [dest, options], sync) {
    const recursive = Boolean(options?.recursive);
    const opts = copyOptions('cp', options);
    return copyOf(src, dest, 'cp', recursive, opts, sync);
  },

  // FsRouter.link: a hard link into or out of an indexed place is refused.
  link(src, [dest]) {
    const from = pathOf(src);
    const to = pathOf(dest);
    if (from === null || to === null) return PASS;
    const route = kernel.routeLink(from, to);
    if (route.kind === 'passthrough') return PASS;
    if (route.kind === 'deny') {
      throw fsError(route.code, 'link', from, undefined, to);
    }
    throw fsError('ENOTSUP', 'link', from, 'managed territory', to);
  },

  // Within a virtual place a rename goes through its store; on disk it moves
  // the raw file once the source passes the read routing (FsRouter.rename);
  // across a virtual boundary it is EXDEV.
  rename(from, [to], sync) {
    const source = pathOf(from);
    const target = pathOf(to);
    if (source === null || target === null) return PASS;
    const fail = (code, detail) =>
      fsError(code, 'rename', source, detail, target);
    const [src, dst] = [source, target].map((p) => kernel.routeMutation(p));
    for (const route of [src, dst]) {
      if (route.kind === 'deny') throw fail(route.code);
      if (sync && needsAsync(route)) {
        throw fail('ENOTSUP', 'asynchronous place');
      }
    }
    if (src.kind === 'passthrough' && dst.kind === 'passthrough') {
      const move = kernel.routeRename(source, target);
      if (move.kind === 'deny') throw fail(move.code);
      if (move.kind === 'unsupported') throw fail('ENOTSUP', 'moves places');
      if (move.kind === 'crossing' && disk.isDirectory(source)) {
        throw fail('ENOTSUP', 'a directory enters or leaves a place');
      }
      return PASS;
    }
    // A virtual place's own directory is its mount: it never moves.
    if (src.key === '' || dst.key === '') throw fail('ENOTSUP', 'place root');
    if (src.kind !== dst.kind || src.place !== dst.place) throw fail('EXDEV');
    return facadeOf(src).rename(src.key, dst.key);
  },
};

// --- Variant generators ---

const isThenable = (value) => typeof value?.then === 'function';

const syncVariant = (op, original) =>
  function (p, ...args) {
    const result = op(p, args, true);
    return result === PASS ? original.call(this, p, ...args) : result;
  };

// As node:fs, a void operation calls back with the error alone.
const succeed = (callback, value) =>
  value === undefined ? callback(null) : callback(null, value);

// node:fs may call back before it returns (an aborted signal): the
// caller's callback runs outside the native section all the same.
const callbackVariant = (op, original) =>
  function (p, ...args) {
    const callback = typeof args.at(-1) === 'function' ? args.pop() : null;
    let result;
    try {
      result = op(p, args, false);
    } catch (err) {
      return void process.nextTick(callback, err);
    }
    if (result === PASS) {
      const done = callback && disk.outside(callback);
      return original.call(this, p, ...args, done);
    }
    if (isThenable(result)) {
      return void result.then(
        (value) => succeed(callback, value),
        (err) => callback(err),
      );
    }
    return void process.nextTick(succeed, callback, result);
  };

const promiseVariant = (op, original) =>
  async function (p, ...args) {
    const result = op(p, args, false);
    return result === PASS ? original.call(this, p, ...args) : result;
  };

const existsSync = (original) =>
  function (p) {
    const filePath = pathOf(p);
    if (filePath === null) return original.call(this, p);
    const { kind } = kernel.routeRead(filePath);
    if (kind === 'passthrough' || kind === 'disk') {
      return original.call(this, p);
    }
    return kind !== 'deny';
  };

// fs.createReadStream never throws: errors are emitted on the stream.
// node:fs callers never release a lease, so their chunks are always owned
// copies and the pin ends with the stream.
const createReadStream = (original) =>
  function (p, options) {
    let route;
    try {
      route = readRoute(p, 'open');
      if (route === PASS) return original.call(this, p, options);
      if (isDirectoryRoute(route)) throw fsError('EISDIR', 'read');
      const opts =
        typeof options === 'string' ? { encoding: options } : { ...options };
      opts.zeroCopy = false;
      return facadeOf(route).createReadStream(route.key, opts);
    } catch (err) {
      const stream = new Readable({ read() {} });
      process.nextTick(() => stream.destroy(err));
      return stream;
    }
  };

// fs.openAsBlob reads through a native binding, past every node:fs function
// the patch replaces, so it is routed here as readFile is: a published
// entry gives a Blob over an owned copy of its canonical content, a
// directory EISDIR, a denied path its refusal; the disk territory and paths
// outside stay native, whatever form node:fs gives its own refusals there.
// The call is documented to return a promise, so what the patch refuses is
// a rejection; the options are checked as node:fs checks them.
const blobOf = (route, options = {}) => {
  if (options === null || typeof options !== 'object') {
    throw argumentTypeError('options', 'object', options);
  }
  const type = options.type || '';
  if (typeof type !== 'string') {
    throw argumentTypeError('options.type', 'string', type);
  }
  if (isDirectoryRoute(route)) throw fsError('EISDIR', 'read');
  return new Blob([facadeOf(route).readFile(route.key)], { type });
};

const openAsBlob = (original) =>
  function (p, options) {
    try {
      const route = readRoute(p, 'open');
      if (route === PASS) return original.call(this, p, options);
      return Promise.resolve(blobOf(route, options));
    } catch (err) {
      return Promise.reject(err);
    }
  };

// --- watch ---

// A native watcher reports raw disk events: names a place hides, changes
// before (or without) their publication, nothing of virtual writes. So a
// watch of managed territory is recognized but unsupported, and so is a
// recursive watch of a tree that holds places. A file of the disk territory
// is its own content and keeps a native watcher (a missing one fails
// natively).
const watchOp = (p, [options]) => {
  const recursive = Boolean(options?.recursive);
  const route = readRoute(p, 'watch', true);
  if (route === PASS) {
    if (recursive) walkGuard(p, 'watch');
    return PASS;
  }
  const territory = route.kind === 'disk' && !recursive;
  if (territory && !facadeOf(route).stat(route.key)?.isDirectory()) return PASS;
  throw fsError('ENOTSUP', 'watch', pathOf(p), 'managed territory');
};

// An async iterator whose first step fails with `err`, then is done.
const failedIterator = (err) => {
  let failed = false;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (failed) return Promise.resolve({ value: undefined, done: true });
      failed = true;
      return Promise.reject(err);
    },
    return(value) {
      failed = true;
      return Promise.resolve({ value, done: true });
    },
  };
};

// fs.promises.watch returns an async iterator: as in node:fs, a refusal
// surfaces when it is iterated.
const watchPromises = (original) =>
  function (p, ...args) {
    try {
      watchOp(p, args);
    } catch (err) {
      return failedIterator(err);
    }
    return original.call(this, p, ...args);
  };

// --- Guards for APIs the patch does not implement ---

// Every path argument is routed and its decision enforced; the call itself
// continues to the original node:fs — except on the strict appRoot, which
// only this patch can present.
const guardOp = (syscall, roles) => (p, args) => {
  const paths = [p, ...args];
  for (let i = 0; i < roles.length; i++) {
    if (roles[i] !== 'read') {
      guardMutation(paths[i], syscall);
      continue;
    }
    const route = readRoute(paths[i], syscall);
    if (route !== PASS && route.kind === 'root') {
      throw fsError('EACCES', syscall, pathOf(paths[i]));
    }
  }
  return PASS;
};

// --- glob ---

// glob walks with the node:fs functions it captured when internal/fs/glob
// loaded. Loaded under the patch — install() loads it — it walks through
// the wrappers: every directory read and stat is routed, so it lists what
// the places list, virtual entries included, and never enters what the
// routing denies. Loaded before the first install() — by a test runner,
// or a glob before the kernel was wired — it walks the disk natively, and
// no wrapper changes that: a walk that starts in or above managed
// territory is then refused, as any native walk into the places is
// (ENOTSUP), and one elsewhere stays native. A start the routing denies is
// EACCES before any walk. The walk starts where glob starts it: at `cwd`
// (the process's without one) plus the leading segments of the pattern
// without glob magic, resolved as glob resolves them.
const GLOB_MODULE = 'NativeModule internal/fs/glob';
let globNative = null; // decided once, at the first install()

const MAGIC = /[*?[\]{}()]/;

const walkStart = (cwd, pattern) => {
  const literal = [];
  for (const part of pattern.split(/[\\/]/)) {
    if (MAGIC.test(part)) break;
    literal.push(part);
  }
  return path.resolve(cwd, literal.join('/'));
};

const globGuard = (args) => {
  const options = args[1];
  const cwd =
    (options?.cwd !== undefined && pathOf(options.cwd)) || process.cwd();
  const patterns = Array.isArray(args[0]) ? args[0] : [args[0]];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue; // node:fs refuses it
    const start = walkStart(cwd, pattern);
    const route = kernel.routeRead(start);
    if (route.kind === 'deny') throw fsError(route.code, 'scandir', start);
    if (!globNative) continue;
    if (route.kind !== 'passthrough' || kernel.enclosesPlaces(start)) {
      throw fsError('ENOTSUP', 'scandir', start, 'native walk into places');
    }
  }
};

const globSync = (original) =>
  function (...args) {
    globGuard(args);
    return original.apply(this, args);
  };

const globCallback = (original) =>
  function (...args) {
    try {
      globGuard(args);
    } catch (err) {
      const callback = args.at(-1);
      if (typeof callback !== 'function') throw err;
      return void process.nextTick(callback, err);
    }
    return original.apply(this, args);
  };

// fs.promises.glob returns an async iterator: as in node:fs, a refusal
// surfaces when it is iterated.
const globPromises = (original) =>
  function (...args) {
    try {
      globGuard(args);
    } catch (err) {
      return failedIterator(err);
    }
    return original.apply(this, args);
  };

// Loads Node's glob under the patch, once: from then on it walks through
// the wrappers, whichever kernel they route to. Loaded before, it keeps
// the native functions for the life of the process.
const loadGlob = () => {
  if (globNative !== null || typeof fs.globSync !== 'function') return;
  globNative = process.moduleLoadList.includes(GLOB_MODULE);
  if (!globNative) fs.globSync([]);
};

// --- Install / Uninstall ---

// [name, operation, { native }]: a passthrough calls its original in the
// native section (disk.sectioned) unless `native` is false. Until it
// returns, what Node's implementation calls back into node:fs —
// writeFileSync and truncateSync open the file through fs.openSync, rmSync
// lstats its path and, on Node 22, rimraf walks the tree — is the call
// routed already, so it reaches the originals; callbacks and continuations
// are routed. Not cp: it calls its `filter`, the caller's code, before it
// returns, and in the section that code would read past routing.
const TABLE = [
  ['readFile', ops.readFile],
  ['stat', ops.stat],
  ['lstat', ops.lstat],
  ['access', ops.access],
  ['realpath', ops.realpath],
  ['readdir', ops.readdir],
  ['opendir', ops.opendir],
  ['open', ops.open],
  ['writeFile', ops.writeFile],
  ['appendFile', ops.appendFile],
  ['unlink', ops.unlink],
  ['mkdir', ops.mkdir],
  ['rm', ops.rm],
  ['rename', ops.rename],
  ['copyFile', ops.copyFile],
  ['cp', ops.cp, { native: false }],
  ['rmdir', ops.rmdir],
  ['link', ops.link],
];

// [name, syscall, roles per path argument]. A guard passes the call
// through, always in the native section.
const GUARDS = [
  ['readlink', 'readlink', ['read']],
  ['statfs', 'statfs', ['read']],
  ['truncate', 'open', ['mutate']],
  ['utimes', 'utime', ['mutate']],
  ['lutimes', 'lutime', ['mutate']],
  ['chmod', 'chmod', ['mutate']],
  ['lchmod', 'chmod', ['mutate']],
  ['chown', 'chown', ['mutate']],
  ['lchown', 'chown', ['mutate']],
  ['symlink', 'symlink', ['read', 'mutate']],
];

// A reference taken while the patch is installed outlives uninstall() — a
// module's `const { readFile } = require('node:fs')`, or the functions glob
// keeps from its first use. With no kernel installed it is the original
// function again: same receiver and arguments, so every callback, promise
// and overload keeps node:fs behavior. So it is inside the native section
// (disk.js): there node:fs calls itself back, and its inner calls reach
// the originals unrouted. Each install() patches the restored originals,
// so wrappers never stack.
const wrapped = (original, routed) =>
  function (...args) {
    const call = kernel === null || disk.inNative() ? original : routed;
    return call.apply(this, args);
  };

const patch = (target, name, make) => {
  const original = target[name];
  installed.push({ target, name, original });
  const patched = wrapped(original, make(original));
  // fs.realpath.native / fs.realpathSync.native: the same routing over the
  // native variant — unrouted, it told a hidden path from a missing one.
  if (original.native) {
    patched.native = wrapped(original.native, make(original.native));
  }
  target[name] = patched;
};

const install = (k) => {
  if (installed) return;
  // WORKAROUND (disk.js): Node's rimraf takes node:fs itself before
  // anything here is replaced.
  disk.loadRimraf();
  kernel = k;
  installed = [];
  for (const [name, op, { native = true } = {}] of TABLE) {
    const through = native ? disk.sectioned : (orig) => orig;
    patch(fs, name, (orig) => callbackVariant(op, through(orig)));
    patch(fs, `${name}Sync`, (orig) => syncVariant(op, through(orig)));
    patch(fs.promises, name, (orig) => promiseVariant(op, through(orig)));
  }
  for (const [name, syscall, roles] of GUARDS) {
    const op = guardOp(syscall, roles);
    const through = disk.sectioned;
    if (typeof fs[name] === 'function') {
      patch(fs, name, (orig) => callbackVariant(op, through(orig)));
    }
    if (typeof fs[`${name}Sync`] === 'function') {
      patch(fs, `${name}Sync`, (orig) => syncVariant(op, through(orig)));
    }
    if (typeof fs.promises[name] === 'function') {
      patch(fs.promises, name, (orig) => promiseVariant(op, through(orig)));
    }
  }
  if (typeof fs.globSync === 'function') {
    patch(fs, 'globSync', globSync);
    patch(fs, 'glob', globCallback);
    patch(fs.promises, 'glob', globPromises);
  }
  // Watchers hand back their result synchronously (a watcher, or an async
  // iterator), so the callback and promise variants do not apply.
  patch(fs, 'watch', (orig) => syncVariant(watchOp, orig));
  patch(fs.promises, 'watch', watchPromises);
  const watchFile = guardOp('watch', ['read']);
  patch(fs, 'watchFile', (orig) => syncVariant(watchFile, orig));
  patch(fs, 'existsSync', existsSync);
  patch(fs, 'createReadStream', createReadStream);
  if (typeof fs.openAsBlob === 'function') {
    patch(fs, 'openAsBlob', openAsBlob);
  }
  loadGlob();
};

const uninstall = () => {
  if (!installed) return;
  for (const { target, name, original } of installed.reverse()) {
    target[name] = original;
  }
  installed = null;
  kernel = null;
};

module.exports = { install, uninstall };
