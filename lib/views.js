'use strict';

const { Readable } = require('node:stream');

// What a facade over a tree hands out of shared bytes: a stream over one
// pinned version of a representation, the range it reads, the refusal of a
// closed kernel.

const DEFAULT_HIGH_WATER_MARK = 64 * 1024;

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

const kernelClosed = () => {
  const err = new Error('[vfs] kernel closed');
  err.code = 'ERR_VFS_CLOSED';
  return err;
};

module.exports = {
  DEFAULT_HIGH_WATER_MARK,
  VfsReadStream,
  rangeOf,
  kernelClosed,
};
