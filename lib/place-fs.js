'use strict';

const path = require('node:path');
const { canonicalKey, dirOf } = require('./place.js');
const { SHARED } = require('./config.js');
const { listedNames, shortName } = require('./registry.js');
const disk = require('./disk.js');
const { LINKED, fsError, brokenError } = require('./errors.js');
const { statsOf, listing } = require('./stats.js');
const { VfsReadStream, rangeOf, kernelClosed } = require('./views.js');

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
// Reads are synchronous lookups in the place's tree (lib/tree.js): a
// directory is a node of its own, which mkdir makes and rmdir removes, and
// a file's node holds its payload — attributes, the source, the derived
// representations. Missing files yield null from readFile / stat /
// createReadStream / views; readdir throws Node-style ENOENT / ENOTDIR.
// readFile returns owned copies: safe to keep and to mutate. `stat().ino`
// is the node's id — `idOf(key)`, `keyOf(id)` — and `dev` the place's
// number.
//
// Shared bytes (sab, sea) are replaced by updates and reused afterwards, so
// every direct consumer pins the representation it started with; an
// update publishes the new version for new readers while pinned ones
// finish the old. With `fs.zeroCopy: true` the *View methods return a lease
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

// A file read from disk streams from there with nothing to pin; release()
// only stops it, so callers treat every stream the same way.
const diskStream = (filePath, options) => {
  const stream = disk.createReadStream(filePath, options);
  const release = () => {
    if (!stream.destroyed) stream.destroy();
  };
  stream.release = release;
  stream[Symbol.dispose] = release;
  return stream;
};

// The stats of a path on disk, or null.
const statOf = (abs) => {
  try {
    return disk.statSync(abs, { throwIfNoEntry: false }) || null;
  } catch {
    return null;
  }
};

// A file the fs domain sees: `payload`, its Payload in the place's tree —
// or the attributes of a file of the disk territory, as one — `id`, its
// node's (null on the disk territory), `path`, where a file whose source
// is not in memory is read from (null when it is).
class Found {
  constructor(payload, id, path) {
    this.payload = payload;
    this.id = id;
    this.path = path;
  }
}

// The attributes of a file of the disk territory, shaped as a payload.
const diskPayload = (size, mtimeMs) => ({
  version: null,
  size,
  mtimeMs,
  source: null,
  others: null,
  extras: null,
});

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

  // Once the view of this thread broke (kernel.js, #break), every call is
  // the closed kernel's, with that failure as its cause.
  #live() {
    const cause = this.#kernel?.broken;
    if (cause) throw brokenError(cause);
  }

  // A read of a closed kernel is refused (ERR_VFS_CLOSED), never answered
  // "no file". A mutation is refused by its own path — its store, the
  // queue, a worker's client — asynchronously where its API is.
  #reading() {
    this.#live();
    if (this.#kernel?.state === 'closed') throw kernelClosed();
  }

  // The file the fs domain sees under `key` (Found), or null: a published
  // one — whose source, when it is not in memory, is read from disk only
  // where strict lets a native call go on its path — else one of the disk
  // territory.
  #file(key) {
    const place = this.#place;
    const node = this.#published(key);
    if (node === null) return this.#diskFile(key);
    const { tree } = place;
    const payload = tree.payloadOf(node);
    const id = tree.nodeId(node);
    if (payload.source !== null) return new Found(payload, id, null);
    const abs = place.pathOf(place.keyOf(key));
    return this.#proves(abs) ? new Found(payload, id, abs) : null;
  }

  // The node of the published file the fs domain sees under `key`, or
  // null.
  #published(key) {
    const place = this.#place;
    const node = place.node(key);
    if (node === null || place.tree.isDirectory(node)) return null;
    return place.visible('fs', place.keyOf(key)) ? node : null;
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

  // A file of an extension the place does not cache, read from disk —
  // never one the disk takes for another file (disguised).
  #diskFile(key) {
    if (!this.#fallsBack) return null;
    const place = this.#place;
    const canonical = place.keyOf(key);
    if (place.cached(canonical)) return null;
    if (disguised(canonical)) return null;
    const abs = this.#within(canonical, true);
    const stats = abs && statOf(abs);
    if (!stats?.isFile()) return null;
    return new Found(diskPayload(stats.size, stats.mtimeMs), null, abs);
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

  // One consumer of a published representation: shared bytes are pinned
  // until the returned idempotent release; a Map place's buffers are its
  // own, which the GC keeps alive while a view of them lives. `onClose`
  // stops the consumer if the kernel closes first.
  #pin(rep, onClose) {
    return this.#shared ? this.#pins.acquire(rep, onClose) : NOOP;
  }

  // The version of a found file, as version() gives it.
  #versionOf(found) {
    return this.#shared && found.id !== null ? found.payload.version : null;
  }

  #lease(rep, found) {
    const release = this.#pin(rep);
    return Object.freeze({
      view: rep.data,
      version: this.#versionOf(found),
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

  #stream(rep, options) {
    const borrowed = this.#borrowed(options) && !options.encoding;
    const range = rangeOf(options, rep.length);
    let stream = null;
    const release = this.#pin(rep, () => stream?.destroy(kernelClosed()));
    try {
      stream = new VfsReadStream(rep.data, range, options, borrowed, release);
    } catch (err) {
      release();
      throw err;
    }
    return stream;
  }

  exists(key) {
    this.#reading();
    return this.#file(key) !== null || this.#isDirectory(key);
  }

  // The version of the commit that published the file a shared place holds
  // under `key`: equal for the files of one commit, the same in every
  // thread; a move keeps it. A directory's is the commit's that last
  // changed its children, where the place keeps directory attributes
  // (`places.<name>.stat.directories`). Null for a missing key, a directory
  // without them, a map place's file and the disk territory, which no
  // commit publishes.
  version(key) {
    this.#reading();
    const found = this.#file(key);
    if (found) return this.#versionOf(found);
    const dir = this.#shared ? this.#place.directory(key) : null;
    return dir === null
      ? null
      : (this.#place.tree.payloadOf(dir)?.version ?? null);
  }

  // Only the documented `{ bigint }` reaches statsOf(): an internal option
  // it also reads (`directory`) must never come from the caller, or e.g.
  // `stat(key, { directory: true })` would turn a file into a directory.
  // A file's and a directory's of the tree carry their node's id as `ino`
  // and the place's number as `dev`; birthtime and a directory's times
  // are their payload's where the place keeps them (`places.<name>.stat`),
  // else as `statsOf` makes them.
  stat(key, options = {}) {
    this.#reading();
    const bigint = Boolean(options?.bigint);
    const place = this.#place;
    const found = this.#file(key);
    if (found) {
      const { payload, id } = found;
      return statsOf(payload.size, payload.mtimeMs, {
        bigint,
        ino: id ?? 0,
        dev: id === null ? 0 : place.dev,
        birthtimeMs: payload.birthtimeMs,
      });
    }
    const dir = place.directory(key);
    if (dir !== null) {
      const payload = place.tree.payloadOf(dir);
      return statsOf(0, payload?.mtimeMs ?? 0, {
        bigint,
        directory: true,
        ino: place.tree.nodeId(dir),
        dev: place.dev,
        birthtimeMs: payload?.birthtimeMs,
      });
    }
    if (this.#diskDir(key)) return statsOf(0, 0, { bigint, directory: true });
    return null;
  }

  // The id of the node `key` names — a directory, or a file the fs domain
  // sees — as `stat().ino` gives it: the same in every thread, kept by a
  // move and never given to another node until the ids wrap (lib/tree.js).
  // Null for nothing there and for the disk territory.
  idOf(key) {
    this.#reading();
    const found = this.#file(key);
    if (found) return found.id;
    const dir = this.#place.directory(key);
    return dir === null ? null : this.#place.tree.nodeId(dir);
  }

  // The key of the node with this id now — '' for the place's directory —
  // or null: no node has it, or the fs domain does not see the file.
  keyOf(id) {
    this.#reading();
    const place = this.#place;
    const node = place.tree?.byId(id) ?? null;
    if (node === null) return null;
    const key = place.tree.pathOf(node);
    if (!place.tree.isDirectory(node) && !place.visible('fs', key)) return null;
    return key;
  }

  // --- Reads ---

  readFile(key, options = {}) {
    this.#reading();
    checkSignal(options);
    const found = this.#file(key);
    if (!found) return null;
    const encoding = encodingOf(options);
    const { source } = found.payload;
    const data =
      source === null
        ? disk.readFileSync(found.path)
        : Buffer.from(source.data);
    return encoding ? data.toString(encoding) : data;
  }

  // Lease over the current version: `{ view, version, release,
  // [Symbol.dispose] }`; null when the key is missing or kept on disk (not
  // in memory).
  readFileView(key) {
    this.#reading();
    this.#views();
    const found = this.#file(key);
    const source = found?.payload.source;
    return source ? this.#lease(source, found) : null;
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
    this.#reading();
    const found = this.#file(key);
    if (!found) return null;
    const opts = typeof options === 'string' ? { encoding: options } : options;
    const { source } = found.payload;
    if (source === null) return diskStream(found.path, opts);
    return this.#stream(source, opts);
  }

  // Directory listing from the place's tree — a directory's children, or
  // every node below it — merged with the disk territory of a partial
  // cache. Deterministic lexicographic order of the string names, whatever
  // the requested encoding. Options: { withFileTypes, recursive, encoding },
  // or an encoding string.
  // A published file is ENOTDIR at once; a file of the disk territory is
  // asked about only where its disk lists nothing — one look at the disk,
  // one proof of the path under strict, for a directory that lists.
  readdir(key, opts) {
    this.#reading();
    const options = typeof opts === 'string' ? { encoding: opts } : opts || {};
    const place = this.#place;
    const dir = dirOf(key);
    const notDir = () => fsError('ENOTDIR', 'scandir', this.pathOf(dir));
    if (dir !== '' && this.#published(dir)) throw notDir();
    const names = new Map(); // relative name → isDirectory
    const onDisk = this.#diskEntries(dir, names, Boolean(options.recursive));
    if (!onDisk && dir !== '' && this.#diskFile(dir)) throw notDir();
    const node = place.directory(dir);
    if (!onDisk && node === null) {
      if (place.throughFile(dir)) throw notDir();
      throw fsError('ENOENT', 'scandir', this.pathOf(dir));
    }
    if (node !== null) this.#listed(node, names, Boolean(options.recursive));
    const prefix = dir + '/';
    return listing(names, options, (sub) =>
      this.pathOf(sub === '' ? dir : prefix + sub),
    );
  }

  // The names below a directory node into `names`, '/'-separated from it:
  // its children, or with `recursive` every node below it — each
  // directory, and each file the fs domain sees.
  #listed(node, names, recursive) {
    const place = this.#place;
    const { tree } = place;
    if (!recursive) {
      for (const [name, isDirectory] of tree.children(node)) {
        if (isDirectory || place.visible('fs', '/' + name)) {
          names.set(name, isDirectory);
        }
      }
      return;
    }
    const dirs = []; // by depth, the listed name of the directory entered last
    for (const [child, depth] of tree.walk(node)) {
      const name = tree.nameOf(child);
      const listed = depth === 1 ? name : `${dirs[depth - 1]}/${name}`;
      const isDirectory = tree.isDirectory(child);
      if (isDirectory) dirs[depth] = listed;
      if (isDirectory || place.visible('fs', '/' + name)) {
        names.set(listed, isDirectory);
      }
    }
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

  // The file under `key` and its representation compressed with
  // `encoding`, `{ found, rep }`, or null.
  #compressed(key, encoding) {
    this.#codec(encoding);
    const found = this.#file(key);
    const rep = found?.payload.others?.[encoding] ?? null;
    return rep === null ? null : { found, rep };
  }

  // Representations actually present, config order; 'raw' only when the
  // source itself is in memory.
  storedEncodings(key) {
    this.#reading();
    const found = this.#file(key);
    if (!found) return [];
    const { source, others } = found.payload;
    const result = source === null ? [] : ['raw'];
    const place = this.#place;
    for (const { encoding } of place.config.fs?.compress?.codecs || []) {
      if (others?.[encoding]) result.push(encoding);
    }
    return result;
  }

  readFileCompressed(key, encoding) {
    this.#reading();
    const compressed = this.#compressed(key, encoding);
    return compressed ? Buffer.from(compressed.rep.data) : null;
  }

  // Lease over the compressed bytes only: the source and the other
  // representations are not pinned.
  readFileCompressedView(key, encoding) {
    this.#reading();
    this.#views();
    const compressed = this.#compressed(key, encoding);
    return compressed ? this.#lease(compressed.rep, compressed.found) : null;
  }

  // { size, sourceSize, encoding, mtimeMs } — size of the compressed bytes,
  // the rest the file's.
  statCompressed(key, encoding) {
    this.#reading();
    const compressed = this.#compressed(key, encoding);
    if (!compressed) return null;
    const { found, rep } = compressed;
    const { size: sourceSize, mtimeMs } = found.payload;
    return { size: rep.length, sourceSize, encoding, mtimeMs };
  }

  // Range addresses the compressed bytes; only that representation is
  // pinned.
  createReadStreamCompressed(key, encoding, options = {}) {
    this.#reading();
    const compressed = this.#compressed(key, encoding);
    return compressed ? this.#stream(compressed.rep, options) : null;
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
    this.#reading();
    const place = this.#place;
    if (!place.config.fs?.script) {
      throw fsError('ENOTSUP', 'read', undefined, 'no fs.script domain');
    }
    const found = this.#file(key);
    if (!found || !place.scripted(place.keyOf(key))) return null;
    const { source, others, extras } = found.payload;
    const data = source === null ? disk.readFileSync(found.path) : source.data;
    const code = others?.scriptBytecode ?? null;
    return {
      source: data.toString('utf8'),
      cachedData: code ? Buffer.from(code.data) : undefined,
      scriptOptions: extras?.scriptOptions ?? null,
      meta: extras?.meta ?? null,
      version: this.#versionOf(found),
    };
  }

  // Frozen metadata a preparer attached to the file, or null.
  meta(key) {
    this.#reading();
    return this.#file(key)?.payload.extras?.meta ?? null;
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
    this.#live();
    return this.#write(key, data, options, 'w');
  }

  appendFile(key, data, options) {
    this.#live();
    return this.#write(key, data, options, 'a');
  }

  // Several files of a virtual place as one publication: every key is
  // checked — against the place, the mutations in flight and the rest of
  // the set — before any file is prepared, each file is prepared once, and
  // the set is published in one commit, with the directories it lacks, or
  // not at all. The arguments are
  // checked first, each key as a write checks it — a directory's name is
  // EISDIR — and a key twice is a TypeError; nothing is queued then. One
  // flag for the set: `w…` replaces, `x` creates every key only; an
  // append, a read or a numeric flag is ENOTSUP, and so is a disk-origin
  // place, whose writes land on disk one by one. The bytes are taken when
  // it is called. Returns a Promise of the version of the commit for
  // `sab + virtual`, undefined for a map place, which publishes at once.
  writeFiles(files, options) {
    this.#live();
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
    // The path names a refusal only: a write that goes on never builds it.
    if (key.endsWith('/')) {
      throw fsError('EISDIR', 'open', this.pathOf(canonical));
    }
    const write = WRITES.get(flag);
    if (!write) {
      throw fsError('ENOTSUP', 'open', this.pathOf(canonical), `flag ${flag}`);
    }
    if (write === 'append') return store.append(canonical, buf);
    return store.write(canonical, buf, { exclusive: write === 'create' });
  }

  unlink(key) {
    this.#live();
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

  // A directory of a virtual place is a node of its tree: mkdir makes it —
  // with `recursive` every one missing down to it — and its parent must be
  // there without.
  mkdir(key, options) {
    this.#live();
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

  // An empty directory goes; one with children is ENOTEMPTY, a file
  // ENOTDIR. The place's own directory stays.
  rmdir(key) {
    this.#live();
    if (isRoot(key)) {
      throw fsError('ENOTSUP', 'rmdir', this.pathOf(key), 'place root');
    }
    const canonical = dirKey(key);
    this.#spelled('rmdir', canonical);
    const store = this.#mutable('rmdir', canonical);
    if (!store) {
      const abs = this.#onDisk('rmdir', key, true);
      if (this.#kernel.touchesLink(abs)) {
        throw fsError('ENOTSUP', 'rmdir', abs, LINKED);
      }
      return disk.rmdirSync(abs);
    }
    return store.rmdir(canonical);
  }

  rm(key, options = {}) {
    this.#live();
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
    this.#live();
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
