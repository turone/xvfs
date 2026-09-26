'use strict';

const path = require('node:path');
const { fileExt } = require('metautil');
// The disk past fs-patch (disk.js).
const { readdir, stat } = require('./disk.js').promises;
const { pool, IO_LIMIT } = require('./pool.js');

const WIN = process.platform === 'win32';

// Place key of an absolute path under `rootPath`: forward slashes, leading '/'.
const keyOf = WIN
  ? (filePath, rootPath) =>
      filePath.substring(rootPath.length).replace(/\\/g, '/')
  : (filePath, rootPath) => filePath.substring(rootPath.length);

// One directory at a time, depth first: every file the scan may publish,
// as [key, path], in the order of the walk.
const walk = async (ctx, dirPath) => {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
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

// scan(rootPath, { ext, startPath, followSymlinks }) → Map<key, FileInput>
//   FileInput: { path, stat: { size, mtimeMs } }         regular files only
//   ext:       null = every extension, else lowercase list without dots
//   startPath: scan only this subtree; keys stay relative to rootPath
// Symbolic links to directories are never traversed. Links to regular files
// are published only with `followSymlinks` (strict sandboxes turn it off).
// FIFOs, sockets and devices are never published.
// The walk is sequential; the stats of the whole tree run IO_LIMIT at a
// time, each landing at its index: the Map keeps the order of the walk,
// whatever order the stats finish in.
const scan = async (rootPath, options = {}) => {
  const ctx = {
    rootPath,
    ext: options.ext || null,
    followSymlinks: options.followSymlinks === true,
    found: [],
  };
  await walk(ctx, options.startPath || rootPath);
  const inputs = new Array(ctx.found.length);
  await pool(ctx.found, IO_LIMIT, async ([, filePath], index) => {
    inputs[index] = await inputOf(filePath);
  });
  const files = new Map();
  for (let i = 0; i < inputs.length; i++) {
    if (inputs[i]) files.set(ctx.found[i][0], inputs[i]);
  }
  return files;
};

module.exports = { scan, keyOf };
