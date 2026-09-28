'use strict';

// fs-surface — every export of node:fs and node:fs/promises the patch
// knows, from Node 22.22.3 to 26.x, and what it does with each. An export
// is named by where it lives: `fs.readFile`, `fs.promises.readFile`,
// `fs.realpath.native` (a function an export carries).
//
//   implemented  served by the places (fs-patch's operation cores)
//   guarded      its path arguments are routed; then node:fs runs it, or
//                the routing refuses it (EACCES, EROFS, ENOTSUP)
//   delegated    not wrapped: every disk access it makes goes through
//                patched functions of the public node:fs — a stream opens
//                through `fs.open`, `exists` asks `fs.access` — or it
//                makes none (`unwatchFile`)
//   pathFree     takes no path: a descriptor, a handle, a class over one,
//                a constant
//
// Under strict routing install() refuses any other function the modules
// export — a Node release may add one whose paths the routing never sees:
// each call fails with ENOTSUP, naming it, before it runs (fs-patch.js,
// refuseUnknown). Its signature is never guessed. Without strict it stays
// as Node made it. `test/fs-surface.test.js` fails on a Node whose exports
// differ from this table, so a new one is classified here, deliberately.

const IMPLEMENTED = 'implemented';
const GUARDED = 'guarded';
const DELEGATED = 'delegated';
const PATH_FREE = 'pathFree';

// name → [sync, callback, promises]: the forms a family has.
const ALL = [true, true, true];

const families = (kind, names, forms = ALL) => {
  const entries = [];
  for (const name of names) {
    const [sync, callback, promises] = forms;
    if (callback) entries.push([`fs.${name}`, kind]);
    if (sync) entries.push([`fs.${name}Sync`, kind]);
    if (promises) entries.push([`fs.promises.${name}`, kind]);
  }
  return entries;
};

const SURFACE = Object.freeze(
  Object.fromEntries([
    ...families(IMPLEMENTED, [
      'readFile',
      'stat',
      'lstat',
      'access',
      'realpath',
      'readdir',
      'opendir',
      'writeFile',
      'appendFile',
      'unlink',
      'mkdir',
      'rm',
      'rename',
      'copyFile',
      'cp',
    ]),
    ['fs.realpath.native', IMPLEMENTED],
    ['fs.realpathSync.native', IMPLEMENTED],
    ['fs.existsSync', IMPLEMENTED],
    ['fs.createReadStream', IMPLEMENTED],
    ['fs.openAsBlob', IMPLEMENTED],
    ['fs.openAsBlobSync', IMPLEMENTED],
    ...families(GUARDED, [
      'open',
      'rmdir',
      'link',
      'mkdtemp',
      'readlink',
      'statfs',
      'truncate',
      'utimes',
      'lutimes',
      'chmod',
      'lchmod',
      'chown',
      'lchown',
      'symlink',
      'glob',
    ]),
    ['fs.mkdtempDisposableSync', GUARDED],
    ['fs.promises.mkdtempDisposable', GUARDED],
    ['fs.watch', GUARDED],
    ['fs.promises.watch', GUARDED],
    ['fs.watchFile', GUARDED],
    ['fs.exists', DELEGATED],
    ['fs.createWriteStream', DELEGATED],
    ['fs.ReadStream', DELEGATED],
    ['fs.WriteStream', DELEGATED],
    ['fs.FileReadStream', DELEGATED],
    ['fs.FileWriteStream', DELEGATED],
    ['fs.Utf8Stream', DELEGATED],
    ['fs.unwatchFile', DELEGATED],
    ...families(
      PATH_FREE,
      [
        'close',
        'fchmod',
        'fchown',
        'fdatasync',
        'fstat',
        'fsync',
        'ftruncate',
        'futimes',
        'read',
        'readv',
        'write',
        'writev',
      ],
      [true, true, false],
    ),
    ['fs.Dir', PATH_FREE],
    ['fs.Dirent', PATH_FREE],
    ['fs.Stats', PATH_FREE],
    ['fs._toUnixTimestamp', PATH_FREE],
    ['fs.constants', PATH_FREE],
    ['fs.F_OK', PATH_FREE],
    ['fs.R_OK', PATH_FREE],
    ['fs.W_OK', PATH_FREE],
    ['fs.X_OK', PATH_FREE],
    ['fs.promises.constants', PATH_FREE],
  ]),
);

// Known exports some supported Node release or platform lacks: the
// disposable mkdtemp and Utf8Stream came with Node 24, openAsBlobSync with
// Node 26.10, the access modes left node:fs itself with Node 26. (`lchmod`
// is always there, a function on macOS only.)
const OPTIONAL = Object.freeze(
  new Set([
    'fs.mkdtempDisposableSync',
    'fs.promises.mkdtempDisposable',
    'fs.Utf8Stream',
    'fs.openAsBlobSync',
    'fs.F_OK',
    'fs.R_OK',
    'fs.W_OK',
    'fs.X_OK',
  ]),
);

// What every function has of its own, not an export it carries.
const INTRINSIC = new Set([
  'length',
  'name',
  'prototype',
  'arguments',
  'caller',
]);

// The functions `fn` carries as its own properties (`.native`), as
// [{ key, descriptor }].
const carried = (fn) => {
  const found = [];
  for (const key of Object.getOwnPropertyNames(fn)) {
    if (INTRINSIC.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(fn, key);
    if (typeof descriptor.value === 'function') found.push({ key, descriptor });
  }
  return found;
};

// The exports of node:fs — `promises` being node:fs/promises, whose own
// follow — and the functions an export carries, each as { name, target,
// key, descriptor, promises }: where it lives, its property descriptor
// (an accessor is never read), and whether node:fs/promises exports it.
// `fs` is node:fs, handed in: only disk.js and fs-patch.js load it.
const exportsOf = (fs) => {
  const found = [];
  const collect = (target, prefix, promises) => {
    for (const key of Object.getOwnPropertyNames(target)) {
      if (target === fs && key === 'promises') continue;
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      const name = `${prefix}.${key}`;
      found.push({ name, target, key, descriptor, promises });
      const { value } = descriptor;
      if (typeof value !== 'function') continue;
      for (const sub of carried(value)) {
        const { key: own, descriptor: of } = sub;
        found.push({
          name: `${name}.${own}`,
          target: value,
          key: own,
          descriptor: of,
          promises,
        });
      }
    }
  };
  collect(fs, 'fs', false);
  collect(fs.promises, 'fs.promises', true);
  return found;
};

module.exports = {
  SURFACE,
  OPTIONAL,
  IMPLEMENTED,
  GUARDED,
  DELEGATED,
  PATH_FREE,
  carried,
  exportsOf,
};
