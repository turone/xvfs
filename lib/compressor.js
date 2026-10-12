'use strict';

const zlib = require('node:zlib');
const { promisify } = require('node:util');

// Compressor — the pre-compressed representations of the fs domain. Codec
// work only, on the libuv threadpool: allocating the resulting
// representations is the SAB sink's job (publication.js), committing them
// with their source the kernel's.

const CODECS = {
  gzip: { compress: zlib.gzip, param: null },
  deflate: { compress: zlib.deflate, param: null },
  br: {
    compress: zlib.brotliCompress,
    param: zlib.constants.BROTLI_PARAM_QUALITY,
  },
  zstd: {
    compress: zlib.zstdCompress,
    param: zlib.constants.ZSTD_c_compressionLevel,
  },
};

// Translate the validated `{ level }` into the codec's own option shape.
// No options object at all when the user configured none: zlib defaults apply.
const zlibOptions = (encoding, options) => {
  if (!options) return null;
  const { param } = CODECS[encoding];
  if (!param) return { level: options.level };
  return { params: { [param]: options.level } };
};

class Compressor {
  constructor({ console } = {}) {
    this.console = console || globalThis.console;
    this.codecs = new Map();
  }

  #codec(encoding) {
    let fn = this.codecs.get(encoding);
    if (fn) return fn;
    const { compress } = CODECS[encoding];
    if (!compress) {
      throw new Error(
        `[vfs] encoding "${encoding}" is unavailable in this Node.js build`,
      );
    }
    fn = promisify(compress);
    this.codecs.set(encoding, fn);
    return fn;
  }

  // True iff the place compresses this key: it must be visible to the fs
  // domain and, when `compress.ext` is set, match it.
  compressible(place, key) {
    return place.compressible(key);
  }

  // Every configured representation of one source, in config order:
  // [{ encoding, data }], data null when the codec failed (warned).
  async compress(place, key, src) {
    const { codecs } = place.config.fs.compress;
    return this.encode(codecs, src, `place "${place.name}"`, key);
  }

  // `codecs` of a place or a tree, as compress() — `owner` names it in a
  // warning.
  async encode(codecs, src, owner, key) {
    const result = [];
    for (const { encoding, options } of codecs) {
      const codec = this.#codec(encoding);
      const opts = zlibOptions(encoding, options);
      let data = null;
      try {
        data = opts ? await codec(src, opts) : await codec(src);
      } catch (err) {
        this.#warn(owner, key, encoding, err.message);
      }
      result.push({ encoding, data });
    }
    return result;
  }

  warn(place, key, encoding, reason) {
    this.#warn(`place "${place.name}"`, key, encoding, reason);
  }

  #warn(owner, key, encoding, reason) {
    this.console.warn(
      `[vfs] ${owner}: skipped ${encoding} for "${key}" — ${reason}`,
    );
  }
}

module.exports = { Compressor };
