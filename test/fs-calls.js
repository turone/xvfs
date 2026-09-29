'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { drain } = require('./helpers.js');

// The families of node:fs calls a refused spelling of a path is tested
// with, and node:fs itself counted beneath the patch: a refusal comes
// before any native call.

// The error of a refused call: its code, syscall and the path as given —
// and, for a call of two paths, the destination as given.
const refused = (code, syscall, given, dest) => (err) => {
  assert.equal(err.code, code, given);
  assert.equal(err.syscall, syscall, given);
  assert.equal(err.path, given);
  assert.equal(err.dest, dest, given);
  return true;
};

// node:fs itself, counted: set before the patch is installed, these are
// the originals it passes a call through to — for every family the tests
// call, in its sync, callback and promise forms.
const FS_CALLS = [
  ...['readFile', 'stat', 'lstat', 'access', 'realpath', 'open', 'readlink'],
  ...['statfs', 'readdir', 'opendir', 'writeFile', 'appendFile', 'truncate'],
  ...['unlink', 'rm', 'rmdir', 'mkdir', 'utimes', 'lutimes', 'chmod'],
  ...['chown', 'lchown', 'symlink', 'rename', 'copyFile', 'cp', 'link'],
  ...['mkdtemp', 'mkdtempDisposable'],
];
const countNative = () => {
  const calls = [];
  const targets = [
    ...FS_CALLS.flatMap((name) => [
      [fs, name, name],
      [fs, `${name}Sync`, `${name}Sync`],
      [fs.promises, name, `promises.${name}`],
    ]),
    ...['watch', 'watchFile', 'existsSync', 'createReadStream'].map((name) => [
      fs,
      name,
      name,
    ]),
    [fs.promises, 'watch', 'promises.watch'],
  ];
  const saved = [];
  for (const [target, name, label] of targets) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    const counted = (...args) => {
      calls.push(label);
      return original.apply(target, args);
    };
    if (original.native) counted.native = original.native;
    target[name] = counted;
    saved.push([target, name, original]);
  }
  const restore = () => {
    for (const [target, name, original] of saved) target[name] = original;
  };
  return { calls, restore };
};

// A callback call, settled as a promise.
const called = (call) =>
  new Promise((resolve, reject) => {
    call((err) => (err ? reject(err) : resolve()));
  });

// A watch not refused is stopped at once: a regression fails, it does not
// keep the process alive.
const watchOnce = (p, options) => fs.watch(p, options).close();
const watchFileOnce = (p) => {
  const listener = () => {};
  fs.watchFile(p, listener);
  fs.unwatchFile(p, listener);
};
const watchNext = (p) => {
  const aborted = new AbortController();
  const watcher = fs.promises.watch(p, { signal: aborted.signal });
  const next = watcher[Symbol.asyncIterator]().next();
  aborted.abort();
  return next;
};

// A write stream, ended: its error, or its finish.
const written = (stream) =>
  new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end('x', (err) => (err ? reject(err) : resolve()));
  });

// The families of node:fs over one path: [call, syscall, run].
const FILE_READS = [
  ['readFileSync', 'open', (p) => fs.readFileSync(p)],
  ['readFile', 'open', (p) => called((cb) => fs.readFile(p, cb))],
  ['promises.readFile', 'open', (p) => fs.promises.readFile(p)],
  ['statSync', 'stat', (p) => fs.statSync(p)],
  ['stat', 'stat', (p) => called((cb) => fs.stat(p, cb))],
  ['promises.stat', 'stat', (p) => fs.promises.stat(p)],
  ['lstatSync', 'lstat', (p) => fs.lstatSync(p)],
  ['promises.lstat', 'lstat', (p) => fs.promises.lstat(p)],
  ['accessSync', 'access', (p) => fs.accessSync(p)],
  ['promises.access', 'access', (p) => fs.promises.access(p)],
  ['realpathSync', 'lstat', (p) => fs.realpathSync(p)],
  ['realpath', 'lstat', (p) => called((cb) => fs.realpath(p, cb))],
  ['promises.realpath', 'lstat', (p) => fs.promises.realpath(p)],
  ['openSync', 'open', (p) => fs.openSync(p)],
  ['open', 'open', (p) => called((cb) => fs.open(p, cb))],
  ['promises.open', 'open', (p) => fs.promises.open(p)],
  ['createReadStream', 'open', (p) => drain(fs.createReadStream(p))],
  ['readlinkSync', 'readlink', (p) => fs.readlinkSync(p)],
  ['promises.readlink', 'readlink', (p) => fs.promises.readlink(p)],
  ['statfsSync', 'statfs', (p) => fs.statfsSync(p)],
  ['watch', 'watch', (p) => watchOnce(p)],
  ['watchFile', 'watch', (p) => watchFileOnce(p)],
  ['promises.watch', 'watch', (p) => watchNext(p)],
];
const DIR_READS = [
  ['readdirSync', 'scandir', (p) => fs.readdirSync(p)],
  [
    'readdirSync recursive',
    'scandir',
    (p) => fs.readdirSync(p, { recursive: true }),
  ],
  ['readdir', 'scandir', (p) => called((cb) => fs.readdir(p, cb))],
  ['promises.readdir', 'scandir', (p) => fs.promises.readdir(p)],
  ['opendirSync', 'opendir', (p) => fs.opendirSync(p)],
  ['promises.opendir', 'opendir', (p) => fs.promises.opendir(p)],
  ['watch recursive', 'watch', (p) => watchOnce(p, { recursive: true })],
];
const FILE_MUTATIONS = [
  ['writeFileSync', 'open', (p) => fs.writeFileSync(p, 'x')],
  ['writeFile', 'open', (p) => called((cb) => fs.writeFile(p, 'x', cb))],
  ['promises.writeFile', 'open', (p) => fs.promises.writeFile(p, 'x')],
  ['appendFileSync', 'open', (p) => fs.appendFileSync(p, 'x')],
  ['promises.appendFile', 'open', (p) => fs.promises.appendFile(p, 'x')],
  ['openSync w', 'open', (p) => fs.openSync(p, 'w')],
  ['promises.open w', 'open', (p) => fs.promises.open(p, 'w')],
  ['createWriteStream', 'open', (p) => written(fs.createWriteStream(p))],
  ['truncateSync', 'open', (p) => fs.truncateSync(p)],
  ['promises.truncate', 'open', (p) => fs.promises.truncate(p)],
  ['unlinkSync', 'unlink', (p) => fs.unlinkSync(p)],
  ['unlink', 'unlink', (p) => called((cb) => fs.unlink(p, cb))],
  ['promises.unlink', 'unlink', (p) => fs.promises.unlink(p)],
  ['rmSync', 'rm', (p) => fs.rmSync(p)],
  ['promises.rm', 'rm', (p) => fs.promises.rm(p)],
  ['utimesSync', 'utime', (p) => fs.utimesSync(p, 1, 1)],
  ['lutimesSync', 'lutime', (p) => fs.lutimesSync(p, 1, 1)],
  ['promises.utimes', 'utime', (p) => fs.promises.utimes(p, 1, 1)],
  ['chmodSync', 'chmod', (p) => fs.chmodSync(p, 0o644)],
  ['promises.chmod', 'chmod', (p) => fs.promises.chmod(p, 0o644)],
  ['chownSync', 'chown', (p) => fs.chownSync(p, 0, 0)],
  ['lchownSync', 'chown', (p) => fs.lchownSync(p, 0, 0)],
  ['symlinkSync', 'symlink', (p) => fs.symlinkSync(__filename, p)],
];
const DIR_MUTATIONS = [
  ['mkdirSync', 'mkdir', (p) => fs.mkdirSync(p)],
  ['mkdirSync recursive', 'mkdir', (p) => fs.mkdirSync(p, { recursive: true })],
  ['promises.mkdir', 'mkdir', (p) => fs.promises.mkdir(p)],
  ['rmdirSync', 'rmdir', (p) => fs.rmdirSync(p)],
  ['promises.rmdir', 'rmdir', (p) => fs.promises.rmdir(p)],
  [
    'rmSync recursive',
    'rm',
    (p) => fs.rmSync(p, { recursive: true, force: true }),
  ],
];
// Over two paths: [call, syscall, run(from, to)].
const PAIRS = [
  ['renameSync', 'rename', (a, b) => fs.renameSync(a, b)],
  ['rename', 'rename', (a, b) => called((cb) => fs.rename(a, b, cb))],
  ['promises.rename', 'rename', (a, b) => fs.promises.rename(a, b)],
  ['copyFileSync', 'copyfile', (a, b) => fs.copyFileSync(a, b)],
  ['promises.copyFile', 'copyfile', (a, b) => fs.promises.copyFile(a, b)],
  ['cpSync', 'cp', (a, b) => fs.cpSync(a, b)],
  ['cpSync recursive', 'cp', (a, b) => fs.cpSync(a, b, { recursive: true })],
  ['promises.cp', 'cp', (a, b) => fs.promises.cp(a, b)],
  ['linkSync', 'link', (a, b) => fs.linkSync(a, b)],
  ['promises.link', 'link', (a, b) => fs.promises.link(a, b)],
];

// Every family over every path given: refused with `code`, the path as
// given.
const refusesEach = async (families, paths, code = 'EACCES') => {
  for (const p of paths) {
    for (const [call, syscall, run] of families) {
      await assert.rejects(
        async () => run(p),
        refused(code, syscall, p),
        `${call} ${p}`,
      );
    }
  }
};

// Every pair of paths in every two-path family, each way: refused with
// `code`, the source and the destination as given.
const refusesPairs = async (pairs, code = 'EACCES') => {
  for (const [from, to] of pairs) {
    for (const [call, syscall, run] of PAIRS) {
      await assert.rejects(
        async () => run(from, to),
        refused(code, syscall, from, to),
        `${call} ${from} -> ${to}`,
      );
    }
  }
};

module.exports = {
  refused,
  countNative,
  called,
  written,
  refusesEach,
  refusesPairs,
  FILE_READS,
  DIR_READS,
  FILE_MUTATIONS,
  DIR_MUTATIONS,
  PAIRS,
};
