'use strict';

const path = require('node:path');
const { Readable } = require('node:stream');
const { isCompanionKey } = require('./companion.js');
const { canonicalKey, dirOf } = require('./place.js');
const { SHARED } = require('./config.js');
const { listedNames, shortName } = require('./registry.js');
const disk = require('./disk.js');
const { LINKED, fsError } = require('./errors.js');
const { statsOf, listing } = require('./stats.js');

const DEFAULT_HIGH_WATER_MARK = 64 * 1024;

const NOOP = () => {};

// Whether Windows may take a disk-territory key for another file: a name
// with a `:` is a stream of the file before it — `a.txt::$DATA` is a.txt
// itself — and a file name in short-name form may be the 8.3 name of
// another — `INDEX~1.HTM` of `index.html` — the raw file of a cached
// extension that its own key never serves from disk. Elsewhere both are
// names like any other.
const disguised =
  process.platform === 'win32'
    ? (key) =>
        key.includes(':') || shortName(key.slice(key.lastIndexOf('/') + 1))
    : () => false;

// Whether a key holds a spelling strict routing refuses below appRoot on
// Windows, in any place (PlaceRegistry.route): NTFS stream syntax, or a
// name in 8.3 form, anywhere in it. No path names such a key under strict,
// so no mutation of the facade makes one there either. Elsewhere both are
// names like any other.
const foreign =
  process.platform === 'win32'
    ? (key) =>
        typeof key === 'string' &&
        (key.includes(':') ||
          (key.includes('~') && key.split('/').some(shortName)))
    : () => false;

// The place's own directory: its mount, which always exists and never moves
// or goes away.
const isRoot = (key) => typeof key === 'string' && dirOf(key) === '';

// The canonical key of a mutation, without the trailing slash that names a
// directory (see Mutations).
const dirKey = (key) =>
  canonicalKey(typeof key === 'string' ? dirOf(key) : key);

// PlaceFs — public, per-Place file API returned by `kernel.fs(name)`.
//
// Reads are synchronous Map lookups. Missing files yield null from readFile /
// stat / createReadStream / views; readdir throws Node-style ENOENT / ENOTDIR.
// readFile returns owned copies: safe to keep and to mutate.
//
// Shared bytes (sab, sea) are replaced by updates and reused afterwards, so
// every direct consumer pins the version it started with; an update
// publishes the new version for new readers while pinned ones finish the
// old. With `fs.zeroCopy: true` the *View methods return a lease
// `{ view, version, release, [Symbol.dispose] }`: `view` is a direct SAB
// Buffer, stable until release(), never to be mutated or used after it —
// `Buffer.from(view)` to keep the bytes; `version` is the file's
// (version()). createReadStream returns a
// VfsReadStream: owned chunks, released with the stream, unless zero-copy
// is on (the place's fs.zeroCopy, or `{ zeroCopy }` per call); borrowed SAB
// chunks are released only through stream.release(), since a
// downstream socket may still hold the last ones after the stream ends.
// Map places hold owned Buffers the GC keeps alive: their leases and
// releases are no-ops.
//
// A partial disk cache (`fs.fallback: 'disk'`) also serves its disk
// territory — files of extensions it does not cache, and directories —
// straight from disk: reads, stat, exists and listings merged with what the
// VFS holds. Cached extensions stay VFS-only.
//
// Mutations go to the place's store (a per-thread Map, or the main kernel
// for a shared virtual place), to disk (disk-origin with fs.writable) or
// fail with EROFS. Shared virtual places publish through the allocator, so
// their mutations return a Promise that settles once the new version is
// published; every other place mutates synchronously and returns undefined.
// `await` is correct for both.
// Where a domain declares `prepare` for an extension, the prepared source is
// the canonical content: every read, stream, module load and `script()`
// bundle sees that version, and the raw input is not kept in the VFS.

const encodingOf = (options) =>
  typeof options === 'string' ? options : options?.encoding || null;

// What a writeFile / appendFile flag asks of a store, as node:fs reads it:
// 'w…' replaces the file, 'a…' appends to it, 'x' creates it only. Any
// other — a read flag, a number — is refused, never ignored.
const writes = (write, flags) => flags.map((flag) => [flag, write]);
const WRITES = new Map([
  ...writes('write', ['w', 'w+']),
  ...writes('append', ['a', 'a+', 'as', 'sa', 'as+', 'sa+']),
  ...writes('create', ['wx', 'xw', 'wx+', 'xw+', 'ax', 'xa', 'ax+', 'xa+']),
]);

const checkSignal = (options) => {
  const signal = typeof options === 'object' ? options?.signal : undefined;
  if (signal?.aborted) throw signal.reason;
};

const toBuffer = (data, options) => {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array)
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data), encodingOf(options) || 'utf8');
};

// The [key, data] pairs of writeFiles(): from pairs — an array, a Map, any
// iterable — or from an object of key → data.
const pairsOf = (files) => {
  if (files === null || typeof files !== 'object') {
    throw new TypeError(
      'writeFiles: files must be [key, data] pairs or an object',
    );
  }
  const iterable = typeof files[Symbol.iterator] === 'function';
  const pairs = iterable ? [...files] : Object.entries(files);
  for (const pair of pairs) {
    if (pair === null || typeof pair !== 'object') {
      throw new TypeError('writeFiles: every file is a [key, data] pair');
    }
  }
  return pairs;
};

const isOffset = (value) => Number.isSafeInteger(value) && value >= 0;

// Validate { start, end } against `size`; end is inclusive. Only an explicit
// range is checked, so a default read of an empty file is still fine.
const rangeOf = (options, size) => {
  const explicit = options.start !== undefined || options.end !== undefined;
  const start = options.start ?? 0;
  const end = options.end ?? size - 1;
  if (!isOffset(start) || (options.end !== undefined && !isOffset(end))) {
    throw new RangeError(`invalid range: start ${start}, end ${end}`);
  }
  if (explicit && (start > end || end >= size)) {
    throw new RangeError(`range ${start}-${end} outside file of ${size} bytes`);
  }
  return { start, end };
};

// A Readable over one pinned version of a file. Owned chunks (copies, or
// strings with an encoding) outlive the pin: it is released as soon as the
// stream is destroyed — end, error, destroy(), AbortSignal. Borrowed chunks
// are direct SAB views a downstream socket may still hold after the stream
// ends, so only release() ends their lease:
//   try { await pipeline(stream, res); } finally { stream.release(); }
class VfsReadStream extends Readable {
  #release;

  constructor(data, range, options, borrowed, release) {
    const { start, end } = range;
    const highWaterMark = options.highWaterMark || DEFAULT_HIGH_WATER_MARK;
    let offset = start;
    super({
      highWaterMark,
      encoding: options.encoding,
      signal: options.signal,
      read() {
        if (offset > end) return void this.push(null);
        const stop = Math.min(offset + highWaterMark, end + 1);
        const view = data.subarray(offset, stop);
        this.push(borrowed ? view : Buffer.from(view));
        offset = stop;
      },
      destroy(err, callback) {
        if (!borrowed) release();
        callback(err);
      },
    });
    this.#release = release;
  }

  // Ends the lease on the pinned version, stopping the stream first if it
  // is still reading. Idempotent; borrowed chunks are invalid afterwards.
  release() {
    if (!this.destroyed) this.destroy();
    this.#release();
  }

  [Symbol.dispose]() {
    this.release();
  }

  [Symbol.asyncDispose]() {
    this.release();
    return Promise.resolve();
  }
}

// A disk-backed entry streams from disk with nothing to pin; release() only
// stops it, so callers treat every stream the same way.
const diskStream = (filePath, options) => {
  const stream = disk.createReadStream(filePath, options);
  const release = () => {
    if (!stream.destroyed) stream.destroy();
  };
  stream.release = release;
  stream[Symbol.dispose] = release;
  return stream;
};

const kernelClosed = () => {
  const err = new Error('[vfs] kernel closed');
  err.code = 'ERR_VFS_CLOSED';
  return err;
};

// The stats of a path on disk, or null.
const statOf = (abs) => {
  try {
    return disk.statSync(abs, { throwIfNoEntry: false }) || null;
  } catch {
    return null;
  }
};

class PlaceFs {
  #place;
  #pins;
  #shared;
  #fallsBack;
  // Under strict, whether a native call may go on a path of the place's
  // disk, by the place's `links` (VfsKernel#territory): no link the kernel
  // knows on it, or the disk says it really lies in the place; null
  // without strict.
  #territory;
  // Strict routing: the kernel hands the facade a territory only then.
  #strict;
  // The kernel, whose rules for a native call on a place's disk this
  // facade's disk mutations follow as the patch's do: a hidden source
  // (routeRename), a link or a tree through one (touchesLink, movesLink).
  #kernel;

  constructor(place, pins, kernel, territory = null) {
    this.#place = place;
    this.#pins = pins;
    this.#shared = SHARED.has(place.provider);
    this.#fallsBack = place.config.fs?.fallback === 'disk';
    this.#kernel = kernel;
    this.#territory = territory;
    this.#strict = territory !== null;
  }

  get name() {
    return this.#place.name;
  }

  get root() {
    return this.#place.root;
  }

  get provider() {
    return this.#place.provider;
  }

  get writable() {
    return Boolean(this.#place.config.fs?.writable);
  }

  get zeroCopy() {
    return Boolean(this.#place.config.fs?.zeroCopy);
  }

  // Absolute OS path of a key (also for entries that exist only in memory).
  pathOf(key) {
    return this.#place.pathOf(key);
  }

  // --- Lookup ---

  #file(key) {
    const place = this.#place;
    const file = place.entry(key);
    if (file && place.visible('fs', place.keyOf(key))) {
      return file.data !== null ? file : this.#held(file);
    }
    return this.#diskFile(key);
  }

  // The published source the fs domain sees under `key`, or null.
  #published(key) {
    const place = this.#place;
    const file = place.entry(key);
    return file && place.visible('fs', place.keyOf(key)) ? file : null;
  }

  // A published disk-backed entry — read from disk by its path — only where
  // strict lets a native call go on that path.
  #held(file) {
    return this.#proves(file.path) ? file : null;
  }

  // Under strict, whether a native call may go on `abs` (#territory) —
  // `own`, one that does not follow its last name (unlink, rm, rename);
  // always without strict.
  #proves(abs, own = false) {
    return this.#territory === null || this.#territory(abs, own) !== null;
  }

  // --- Disk territory (fs.fallback: 'disk') ---

  // Absolute path of a key inside the place directory, or null when the key
  // would leave it: disk territory never reaches past the place — nor,
  // under strict, past where the disk says the place really is, or, for a
  // `file`, onto one of an extension the place caches, which a link names
  // another way.
  #within(key, file = false) {
    const { root } = this.#place;
    const abs = path.join(root, key);
    const rel = path.relative(root, abs);
    if (rel === '..' || rel.startsWith('..' + path.sep)) return null;
    if (path.isAbsolute(rel)) return null;
    if (this.#territory === null) return abs;
    const real = this.#territory(abs);
    if (real === null) return null;
    return file && this.#place.cached(path.basename(real)) ? null : abs;
  }

  #diskStat(key) {
    const abs = this.#fallsBack ? this.#within(key) : null;
    return abs && statOf(abs);
  }

  // A file of an extension the place does not cache, as a disk entry —
  // never one the disk takes for another file (disguised).
  #diskFile(key) {
    if (!this.#fallsBack) return null;
    const place = this.#place;
    const canonical = place.keyOf(key);
    if (isCompanionKey(canonical) || place.cached(canonical)) return null;
    if (disguised(canonical)) return null;
    const abs = this.#within(canonical, true);
    const stats = abs && statOf(abs);
    if (!stats?.isFile()) return null;
    const stat = { size: stats.size, mtimeMs: stats.mtimeMs };
    return { data: null, path: abs, stat };
  }

  #diskDir(key) {
    return Boolean(this.#diskStat(this.#place.keyOf(key))?.isDirectory());
  }

  // Disk entries of a directory into `names`: subdirectories and files of
  // extensions the place does not cache. False when it is not on disk. The
  // directory is named without a trailing separator, as the parents of
  // its entries are, so their names are read from the strings. Under
  // strict a recursive listing enters no link (disk.readdirSyncBelow).
  #diskEntries(dir, names, recursive) {
    const base = this.#fallsBack ? this.#within(dir) : null;
    if (!base) return false;
    let entries;
    try {
      entries =
        recursive && this.#territory !== null
          ? disk.readdirSyncBelow(base)
          : disk.readdirSync(base, { withFileTypes: true, recursive });
    } catch {
      return false;
    }
    const nameOf = listedNames(path, base);
    for (const entry of entries) {
      const rel = nameOf(entry.parentPath ?? entry.path, entry.name);
      if (entry.isDirectory()) names.set(rel, true);
      else if (entry.isFile() && !this.#place.cached(rel)) {
        names.set(rel, false);
      }
    }
    return true;
  }

  #isDirectory(key) {
    return this.#place.isDirectory(key) || this.#diskDir(key);
  }

  #views() {
    if (this.zeroCopy) return;
    throw fsError('ENOTSUP', 'read', undefined, 'fs.zeroCopy is off');
  }

  // One consumer of a projected version: shared bytes are pinned until the
  // returned idempotent release; Map entries are owned Buffers the GC keeps
  // alive. `onClose` stops the consumer if the kernel closes first.
  #pin(file, onClose) {
    return this.#shared ? this.#pins.acquire(file, onClose) : NOOP;
  }

  #lease(file) {
    const release = this.#pin(file);
    return Object.freeze({
      view: file.data,
      version: file.version ?? null,
      release,
      [Symbol.dispose]: release,
    });
  }

  // Borrowed chunks: the place setting by default, per call with
  // `{ zeroCopy }` — true needs fs.zeroCopy on the place.
  #borrowed(options) {
    if (options.zeroCopy === undefined) return this.zeroCopy;
    if (options.zeroCopy) this.#views();
    return Boolean(options.zeroCopy);
  }

  #stream(file, options) {
    const borrowed = this.#borrowed(options) && !options.encoding;
    const range = rangeOf(options, file.data.length);
    let stream = null;
    const release = this.#pin(file, () => stream?.destroy(kernelClosed()));
    try {
      stream = new VfsReadStream(file.data, range, options, borrowed, release);
    } catch (err) {
      release();
      throw err;
    }
    return stream;
  }

  exists(key) {
    return this.#file(key) !== null || this.#isDirectory(key);
  }

  // The version of the commit that published the file a shared place holds
  // under `key`: equal for the files of one commit, the same in every
  // thread. Null for a missing key, a map place's file and the disk
  // territory, which no commit publishes.
  version(key) {
    return this.#file(key)?.version ?? null;
  }

  // Only the documented `{ bigint }` reaches statsOf(): an internal option
  // it also reads (`directory`) must never come from the caller, or e.g.
  // `stat(key, { directory: true })` would turn a file into a directory.
  stat(key, options = {}) {
    const bigint = Boolean(options?.bigint);
    const file = this.#file(key);
    if (file) return statsOf(file.stat.size, file.stat.mtimeMs, { bigint });
    if (this.#isDirectory(key))
      return statsOf(0, 0, { bigint, directory: true });
    return null;
  }

  // --- Reads ---

  readFile(key, options = {}) {
    checkSignal(options);
    const file = this.#file(key);
    if (!file) return null;
    const encoding = encodingOf(options);
    const data =
      file.data === null
        ? disk.readFileSync(file.path)
        : Buffer.from(file.data);
    return encoding ? data.toString(encoding) : data;
  }

  // Lease over the current version: `{ view, version, release,
  // [Symbol.dispose] }`; null when the key is missing or kept on disk (not
  // in memory).
  readFileView(key) {
    this.#views();
    const file = this.#file(key);
    return file?.data ? this.#lease(file) : null;
  }

  // The view of `key` for the duration of `fn` (sync or async); null without
  // calling `fn` when there is none.
  async withFileView(key, fn) {
    const lease = this.readFileView(key);
    if (!lease) return null;
    try {
      return await fn(lease.view);
    } finally {
      lease.release();
    }
  }

  // Options: { start, end (inclusive), encoding, highWaterMark, signal,
  // zeroCopy }, or an encoding string.
  createReadStream(key, options = {}) {
    const file = this.#file(key);
    if (!file) return null;
    const opts = typeof options === 'string' ? { encoding: options } : options;
    if (file.data === null) return diskStream(file.path, opts);
    return this.#stream(file, opts);
  }

  // Directory listing from the place's directory index (directories are
  // implicit), merged with the disk territory of a partial cache.
  // Deterministic lexicographic order of the string names, whatever the
  // requested encoding. Options: { withFileTypes, recursive, encoding }, or
  // an encoding string.
  // A published file is ENOTDIR at once; a file of the disk territory is
  // asked about only where its disk lists nothing — one look at the disk,
  // one proof of the path under strict, for a directory that lists.
  readdir(key, opts) {
    const options = typeof opts === 'string' ? { encoding: opts } : opts || {};
    const place = this.#place;
    const dir = dirOf(key);
    const notDir = () => fsError('ENOTDIR', 'scandir', this.pathOf(dir));
    if (dir !== '' && this.#published(dir)) throw notDir();
    const names = new Map(); // relative name → isDirectory
    const onDisk = this.#diskEntries(dir, names, Boolean(options.recursive));
    if (!onDisk && dir !== '' && this.#diskFile(dir)) throw notDir();
    if (!onDisk && !place.isDirectory(dir))
      throw fsError('ENOENT', 'scandir', this.pathOf(dir));
    const prefix = dir + '/';
    const { files } = place;
    const found = options.recursive ? files.below(dir) : files.children(dir);
    for (const [k, isDirectory] of found) {
      if (isDirectory || place.visible('fs', k)) {
        names.set(k.slice(prefix.length), isDirectory);
      }
    }
    return listing(names, options, (sub) =>
      this.pathOf(sub === '' ? dir : prefix + sub),
    );
  }

  // --- Compressed representations (fs.compress) ---

  #codec(encoding) {
    const codecs = this.#place.config.fs?.compress?.codecs || [];
    if (codecs.some((c) => c.encoding === encoding)) return;
    throw fsError(
      'ENOTSUP',
      'read',
      undefined,
      `encoding "${encoding}" is not configured`,
    );
  }

  #compressed(key, encoding) {
    this.#codec(encoding);
    const place = this.#place;
    if (!this.#file(key)) return null;
    return place.compressed(place.keyOf(key), encoding);
  }

  // Representations actually present, config order; 'raw' only when the
  // source itself is in memory.
  storedEncodings(key) {
    const file = this.#file(key);
    if (!file) return [];
    const result = file.data === null ? [] : ['raw'];
    const place = this.#place;
    for (const { encoding } of place.config.fs?.compress?.codecs || []) {
      if (place.compressed(place.keyOf(key), encoding)) result.push(encoding);
    }
    return result;
  }

  readFileCompressed(key, encoding) {
    const file = this.#compressed(key, encoding);
    return file ? Buffer.from(file.data) : null;
  }

  // Lease over the compressed bytes only: the source and the other
  // representations are not pinned.
  readFileCompressedView(key, encoding) {
    this.#views();
    const file = this.#compressed(key, encoding);
    return file ? this.#lease(file) : null;
  }

  // { size, sourceSize, encoding, mtimeMs } — size of the compressed bytes.
  statCompressed(key, encoding) {
    const file = this.#compressed(key, encoding);
    return file ? { ...file.stat } : null;
  }

  // Range addresses the compressed bytes; only that representation is
  // pinned.
  createReadStreamCompressed(key, encoding, options = {}) {
    const file = this.#compressed(key, encoding);
    return file ? this.#stream(file, options) : null;
  }

  // --- Script bundles (fs.script) ---

  // Everything needed to build a local `vm.Script` for a source fs.script
  // covers, as owned copies:
  //   { source: string, cachedData: Buffer | undefined, scriptOptions,
  //     meta, version }
  //   new vm.Script(source, { ...scriptOptions, cachedData })
  // `cachedData` was produced from exactly this `source` under exactly
  // these `scriptOptions` (the preparer's, or V8 defaults — the library
  // invents no filename), and is undefined — never null, which
  // `vm.Script` refuses — when the key's extension is not in
  // `fs.script.compile`. A rejection (`script.cachedDataRejected`) can
  // therefore only come from a V8 version/flags mismatch; the script then
  // compiles from `source` as it is, in that isolate alone. `version` is
  // the file's (version()): a script built from one bundle serves until
  // the file's version changes. Null when the key is not a published
  // script source.
  script(key) {
    const place = this.#place;
    if (!place.config.fs?.script) {
      throw fsError('ENOTSUP', 'read', undefined, 'no fs.script domain');
    }
    const file = this.#file(key);
    if (!file || !place.scripted(place.keyOf(key))) return null;
    const canonical = place.keyOf(key);
    const data = file.data === null ? disk.readFileSync(file.path) : file.data;
    const code = place.bytecode(canonical, 'script');
    return {
      source: data.toString('utf8'),
      cachedData: code ? Buffer.from(code) : undefined,
      scriptOptions: file.scriptOptions ?? null,
      meta: file.meta ?? null,
      version: file.version ?? null,
    };
  }

  // Frozen metadata a preparer attached to the file, or null.
  meta(key) {
    return this.#file(key)?.meta ?? null;
  }

  // --- Mutations ---
  //
  // A key ending in '/' names a directory, as a path with a trailing
  // separator does on POSIX: a file named so is ENOTDIR, a file write to it
  // EISDIR. The store checks it when the mutation runs (`{ directory }`),
  // so a file written meanwhile is never taken for a directory. On disk,
  // node:fs answers for the path as named, by its own rules — on Windows
  // it ignores a trailing separator.

  // Under strict a mutation takes no key in a spelling the routing refuses
  // (foreign): EACCES once the key is valid, before the place's own checks
  // — EROFS, EISDIR, a store's — as node:fs is refused its path, whatever
  // the place, virtual or on disk. `key` is canonical.
  #spelled(syscall, key) {
    if (!this.#strict || !foreign(key)) return;
    throw fsError('EACCES', syscall, this.pathOf(key));
  }

  // The place's mutation engine, or null when the write goes to disk.
  #mutable(syscall, key) {
    const place = this.#place;
    if (!this.writable) throw fsError('EROFS', syscall, this.pathOf(key));
    return place.virtual ? place.store : null;
  }

  // The path of a key a disk mutation acts on: under strict only where a
  // native call may go on it, as for the patch's own (VfsKernel#proven);
  // else EACCES. `own`: see #proves.
  #onDisk(syscall, key, own = false) {
    const abs = this.pathOf(key);
    if (!this.#proves(abs, own)) throw fsError('EACCES', syscall, abs);
    return abs;
  }

  writeFile(key, data, options) {
    return this.#write(key, data, options, 'w');
  }

  appendFile(key, data, options) {
    return this.#write(key, data, options, 'a');
  }

  // Several files of a virtual place as one publication: every key is
  // checked — against the place, the mutations in flight and the rest of
  // the set — before any file is prepared, each file is prepared once, and
  // the set is published in one commit, or not at all. The arguments are
  // checked first, each key as a write checks it — a directory's name is
  // EISDIR — and a key twice is a TypeError; nothing is queued then. One
  // flag for the set: `w…` replaces, `x` creates every key only; an
  // append, a read or a numeric flag is ENOTSUP, and so is a disk-origin
  // place, whose writes land on disk one by one. The bytes are taken when
  // it is called. Returns a Promise of the version of the commit for
  // `sab + virtual`, undefined for a map place, which publishes at once.
  writeFiles(files, options) {
    const pairs = pairsOf(files);
    if (pairs.length === 0) throw new TypeError('writeFiles: no files');
    const batch = [];
    const keys = new Set();
    for (const [key, data] of pairs) {
      if (isRoot(key)) throw fsError('EISDIR', 'writeFiles', this.pathOf(key));
      const canonical = dirKey(key);
      this.#spelled('writeFiles', canonical);
      if (key.endsWith('/')) {
        throw fsError('EISDIR', 'writeFiles', this.pathOf(canonical));
      }
      if (keys.has(canonical)) {
        throw new TypeError(`writeFiles: ${JSON.stringify(key)} written twice`);
      }
      if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
        throw new TypeError(
          `writeFiles: the data of ${JSON.stringify(key)} is not a string or a Uint8Array`,
        );
      }
      keys.add(canonical);
      batch.push([canonical, toBuffer(data, options)]);
    }
    const store = this.#mutable('writeFiles', '');
    if (!store) {
      throw fsError('ENOTSUP', 'writeFiles', this.root, 'disk-origin place');
    }
    const flag = (typeof options === 'string' ? null : options?.flag) ?? 'w';
    const write = WRITES.get(flag);
    if (write !== 'write' && write !== 'create') {
      throw fsError('ENOTSUP', 'writeFiles', this.root, `flag ${flag}`);
    }
    return store.writeFiles(batch, { exclusive: write === 'create' });
  }

  // A key that names a directory, the place's own included, takes no file.
  // The flag — 'w' for writeFile, 'a' for appendFile unless one is given —
  // chooses the store's write (WRITES); on disk, node:fs takes it as is.
  #write(key, data, options, byDefault) {
    if (isRoot(key)) throw fsError('EISDIR', 'open', this.pathOf(key));
    const canonical = dirKey(key);
    this.#spelled('open', canonical);
    const store = this.#mutable('open', canonical);
    const buf = toBuffer(data, options);
    const flag =
      (typeof options === 'string' ? null : options?.flag) ?? byDefault;
    if (!store) {
      return disk.writeFileSync(this.#onDisk('open', key), buf, { flag });
    }
    const abs = this.pathOf(canonical);
    if (key.endsWith('/')) throw fsError('EISDIR', 'open', abs);
    const write = WRITES.get(flag);
    if (!write) throw fsError('ENOTSUP', 'open', abs, `flag ${flag}`);
    if (write === 'append') return store.append(canonical, buf);
    return store.write(canonical, buf, { exclusive: write === 'create' });
  }

  unlink(key) {
    if (isRoot(key)) throw fsError('EISDIR', 'unlink', this.pathOf(key));
    const canonical = dirKey(key);
    this.#spelled('unlink', canonical);
    const store = this.#mutable('unlink', canonical);
    if (!store) {
      const abs = this.#onDisk('unlink', key, true);
      if (this.#kernel.touchesLink(abs)) {
        throw fsError('ENOTSUP', 'unlink', abs, LINKED);
      }
      return disk.unlinkSync(abs);
    }
    return store.unlink(canonical, { directory: key.endsWith('/') });
  }

  // Directories are implicit in indexed places: mkdir creates no entry,
  // but its store checks the hierarchy.
  mkdir(key, options) {
    const root = isRoot(key);
    if (root && !options?.recursive) {
      throw fsError('EEXIST', 'mkdir', this.pathOf(key));
    }
    if (!root) key = dirKey(key);
    this.#spelled('mkdir', key);
    const store = this.#mutable('mkdir', key);
    if (!store) return disk.mkdirSync(this.#onDisk('mkdir', key), options);
    // The place's own directory exists already: nothing reaches the store.
    return root ? undefined : store.mkdir(key, options);
  }

  rm(key, options = {}) {
    if (isRoot(key)) {
      throw fsError('ENOTSUP', 'rm', this.pathOf(key), 'place root');
    }
    const canonical = dirKey(key);
    this.#spelled('rm', canonical);
    const store = this.#mutable('rm', canonical);
    if (!store) {
      const abs = this.#onDisk('rm', key, true);
      if (this.#kernel.touchesLink(abs, Boolean(options.recursive))) {
        throw fsError('ENOTSUP', 'rm', abs, LINKED);
      }
      return disk.rmSync(abs, options);
    }
    return store.rm(canonical, { ...options, directory: key.endsWith('/') });
  }

  rename(from, to) {
    if (isRoot(from) || isRoot(to)) {
      const dest = this.pathOf(to);
      throw fsError('ENOTSUP', 'rename', this.pathOf(from), 'place root', dest);
    }
    const source = dirKey(from);
    const target = dirKey(to);
    if (this.#strict && (foreign(source) || foreign(target))) {
      const [src, dst] = [this.pathOf(source), this.pathOf(target)];
      throw fsError('EACCES', 'rename', src, undefined, dst);
    }
    const store = this.#mutable('rename', source);
    if (!store) {
      const [src, dst] = [this.pathOf(from), this.pathOf(to)];
      if (!this.#proves(src, true) || !this.#proves(dst, true)) {
        throw fsError('EACCES', 'rename', src, undefined, dst);
      }
      // As the patch's: a source the place hides — unpublished, excluded,
      // `fs.fallback: 'deny'` — is refused as its read is (FsRouter.rename).
      const move = this.#kernel.routeRename(src, dst);
      if (move.kind === 'deny') {
        throw fsError(move.code, 'rename', src, undefined, dst);
      }
      const moved = this.#kernel.movesLink(src, dst);
      if (moved !== null) throw fsError('ENOTSUP', 'rename', src, moved, dst);
      return disk.renameSync(src, dst);
    }
    const directory = from.endsWith('/') || to.endsWith('/');
    return store.rename(source, target, { directory });
  }
}

module.exports = { PlaceFs, toBuffer, encodingOf };
