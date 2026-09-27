'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// disk — the disk as the library sees it: node:fs as it was when this
// module loaded, before fs-patch replaces the functions of the public
// object. Every disk access of the library goes through here: kernel,
// scanner, watcher, PlaceFs (disk entries, disk territory, disk-origin
// mutations) and the copy engine of fs-patch (fs-copy.js), which takes the
// constants of node:fs from here as well.
//
// A captured function is not enough: Node's own implementations call the
// public node:fs back — readFileSync and writeFileSync of a Buffer open the
// file through `fs.openSync`, rmSync lstats its path through
// `fs.lstatSync` and, on Node 22, walks the tree with the functions its
// rimraf took from the public object, readdirSync lstats an entry whose
// type the filesystem does not report. fs-patch would route those inner
// calls: `open` of a published file is ENOTSUP, a hidden path EACCES under
// strict, a walk lists the place instead of the disk. So such a call runs
// in the native section: until it returns, every fs-patch wrapper is its
// original (`inNative()`); fs-patch runs a call it passes through to
// node:fs the same way (`sectioned()`). The section is synchronous — a
// depth counter under try/finally, one per thread, each loading its own
// copy of this module — so no asynchronous continuation is ever inside it:
// a disk entry's stream opens and reads through functions of its own.

let depth = 0;

// Runs `fn` in the native section; sections nest.
const native = (fn) => {
  depth++;
  try {
    return fn();
  } finally {
    depth--;
  }
};

const inNative = () => depth > 0;

// `fn` with the section closed while it runs: a caller's callback that a
// native call makes before returning is routed as any other code.
const outside = (fn) =>
  function (...args) {
    const open = depth;
    depth = 0;
    try {
      // eslint-disable-next-line no-invalid-this
      return fn.apply(this, args);
    } finally {
      depth = open;
    }
  };

// `fn` with every call in the native section, its receiver and arguments
// as given.
const sectioned = (fn) =>
  function (...args) {
    // eslint-disable-next-line no-invalid-this
    return native(() => fn.apply(this, args));
  };

// node:fs opens, reads and closes a stream after createReadStream has
// returned: past any section, so through the functions it is given.
const STREAM_FS = Object.freeze({
  open: fs.open,
  read: fs.read,
  close: fs.close,
});

const { createReadStream: readStream, lstatSync, rm, promises } = fs;

const createReadStream = (filePath, options) => {
  const opts = typeof options === 'string' ? { encoding: options } : options;
  return readStream(filePath, { ...opts, fs: STREAM_FS });
};

// A directory on disk; a missing path is left to fail natively.
const isDirectory = (p) =>
  lstatSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;

// WORKAROUND. Node's asynchronous rm (fs.rm, fs.promises.rm; rmSync too on
// Node 22) is rimraf in JavaScript, which takes its functions from the
// public node:fs when it first loads, on first use. Loaded while the patch
// is installed, it walks a tree through routing — the place's listing, not
// the disk — and past any section, being asynchronous: a recursive rm
// removes part of the tree and fails with ENOTEMPTY. Loaded here first, it
// keeps node:fs itself: the captured rm of a path that does not exist
// settles only after the module has loaded. initialize() waits for it, so
// the bootstrap and `await initialize()` before install() are covered; a
// worker's attach() is synchronous and is not. Load-bearing, like
// watchPath(): delete once every supported Node line removes a tree
// natively.
let rimraf = null;

const loadRimraf = () => {
  rimraf ??= new Promise((resolve) => {
    const nonce = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    const missing = path.join(os.tmpdir(), `smfs-rimraf-${nonce}`);
    rm(missing, { recursive: true, force: true }, () => resolve());
  });
  return rimraf;
};

module.exports = {
  native,
  inNative,
  sectioned,
  outside,
  // For the modules that do not load node:fs: all but this one and fs-patch.
  constants: fs.constants,
  // System calls that never call node:fs back.
  statSync: fs.statSync,
  lstatSync: fs.lstatSync,
  existsSync: fs.existsSync,
  mkdirSync: fs.mkdirSync,
  unlinkSync: fs.unlinkSync,
  renameSync: fs.renameSync,
  realpathSync: fs.realpathSync, // and its `.native`
  watch: fs.watch,
  // Implementations that do: always in the section.
  readFileSync: sectioned(fs.readFileSync),
  writeFileSync: sectioned(fs.writeFileSync),
  rmSync: sectioned(fs.rmSync),
  readdirSync: sectioned(fs.readdirSync),
  // Over the captured functions: a stream with an fs of its own, whether a
  // path is a directory on disk, Node's rimraf loaded past the patch.
  createReadStream,
  isDirectory,
  loadRimraf,
  // Asynchronous, so past any section: file handles and system calls. Only
  // a `withFileTypes` readdir lstats an entry through the public node:fs,
  // on a filesystem that does not report its type — where the patch may
  // refuse it: the scanner then types the names with the lstat here.
  promises: Object.freeze({
    open: promises.open,
    readFile: promises.readFile,
    writeFile: promises.writeFile,
    mkdir: promises.mkdir,
    readdir: promises.readdir,
    stat: promises.stat,
    lstat: promises.lstat,
  }),
};
