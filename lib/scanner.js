'use strict';

const path = require('node:path');
const { fileExt } = require('metautil');
// The disk past fs-patch (disk.js).
const { readdir, stat, lstat } = require('./disk.js').promises;
const { pool, IO_LIMIT } = require('./pool.js');

const WIN = process.platform === 'win32';

// Place key of an absolute path under `rootPath`: forward slashes, leading '/'.
const keyOf = WIN
  ? (filePath, rootPath) =>
      filePath.substring(rootPath.length).replace(/\\/g, '/')
  : (filePath, rootPath) => filePath.substring(rootPath.length);

// The entries of a directory with their types, in the order readdir lists
// them, or null when it cannot be read. A filesystem that does not report
// the type of an entry (no d_type) leaves it to readdir, which lstats the
// entry through the public node:fs: routed once the patch is installed,
// under strict a name the place does not serve yet is EACCES, and the
// whole listing fails. Then the names are read again, and lstat through
// disk.js types them, IO_LIMIT at a time; an entry gone meanwhile is left
// out. A Stats answers isDirectory(), isFile() and isSymbolicLink() as a
// Dirent does: it takes the entry's name.
const entriesOf = async (ctx, dirPath) => {
  try {
    return await readdir(dirPath, { withFileTypes: true });
  } catch {
    // Unreadable, or refused past the patch: reading the names tells.
  }
  if (ctx.stopped()) return null;
  let names;
  try {
    names = await readdir(dirPath);
  } catch {
    return null;
  }
  const typed = new Array(names.length);
  await pool(names, IO_LIMIT, async (name, index) => {
    if (ctx.stopped()) return;
    const stats = await lstat(path.join(dirPath, name)).catch(() => null);
    if (stats) typed[index] = Object.assign(stats, { name });
  });
  return typed.filter(Boolean);
};

// One directory at a time, depth first: every file the scan may publish,
// as [key, path], in the order of the walk. A stopped scan reads no more.
const walk = async (ctx, dirPath) => {
  if (ctx.stopped()) return;
  const entries = await entriesOf(ctx, dirPath);
  if (!entries) return;
  for (const entry of entries) {
    const filePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await walk(ctx, filePath);
    } else if (
      entry.isFile() ||
      (entry.isSymbolicLink() && ctx.followSymlinks)
    ) {
      const key = keyOf(filePath, ctx.rootPath);
      if (!ctx.ext || ctx.ext.includes(fileExt(key))) {
        ctx.found.push([key, filePath]);
      }
    }
  }
};

// The FileInput of a found path, or null unless it is a regular file.
const inputOf = async (filePath) => {
  const stats = await stat(filePath).catch(() => null);
  if (!stats || !stats.isFile()) return null;
  return {
    path: filePath,
    stat: { size: stats.size, mtimeMs: stats.mtimeMs },
  };
};

// scan(rootPath, { ext, startPath, followSymlinks, stopped }) →
// Map<key, FileInput>
//   FileInput: { path, stat: { size, mtimeMs } }         regular files only
//   ext:       null = every extension, else lowercase list without dots
//   startPath: scan only this subtree; keys stay relative to rootPath
//   stopped:   () => boolean; once true, the scan starts no disk call — a
//              readdir or stat in flight finishes, and the files it did not
//              stat are left out (the kernel stops a scan at close())
// Symbolic links to directories are never traversed — a junction on
// Windows included — nor is a `startPath` that is one: a rescan below the
// root starts only at a real directory. Links to regular files are
// published only with `followSymlinks` (strict sandboxes turn it off).
// FIFOs, sockets and devices are never published.
// The walk is sequential; the stats of the whole tree run IO_LIMIT at a
// time, each landing at its index: the Map keeps the order of the walk,
// whatever order the stats finish in.
const scan = async (rootPath, options = {}) => {
  const ctx = {
    rootPath,
    ext: options.ext || null,
    followSymlinks: options.followSymlinks === true,
    stopped: options.stopped || (() => false),
    found: [],
  };
  const start = options.startPath || rootPath;
  if (start !== rootPath) {
    const own = await lstat(start).catch(() => null);
    if (!own?.isDirectory()) return new Map();
  }
  await walk(ctx, start);
  const inputs = new Array(ctx.found.length);
  await pool(ctx.found, IO_LIMIT, async ([, filePath], index) => {
    if (!ctx.stopped()) inputs[index] = await inputOf(filePath);
  });
  const files = new Map();
  for (let i = 0; i < inputs.length; i++) {
    if (inputs[i]) files.set(ctx.found[i][0], inputs[i]);
  }
  return files;
};

module.exports = { scan, keyOf };
