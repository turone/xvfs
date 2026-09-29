'use strict';

/* eslint-disable consistent-return */
// As fs.Dir: read() and close() return a promise without a callback and
// nothing with one.

// VfsDir — the fs.Dir that fs-patch's opendir returns: a Dir over a routed
// listing, the entries the territory readdir lists, taken when the
// directory is opened (node:fs does not promise to show entries changed
// during an iteration either). Reads, closes and their errors follow
// node:fs: a closed handle refuses reads and a second close; disposal of a
// closed handle is a no-op, and async iteration closes it. The class knows
// nothing of routing: the patch takes the listing and hands it over.

const dirClosed = () => {
  const err = new Error('Directory handle was closed');
  err.code = 'ERR_DIR_CLOSED';
  return err;
};

class VfsDir {
  #path;
  #entries;
  #closed = false;

  constructor(dirPath, entries) {
    this.#path = dirPath;
    this.#entries = entries;
  }

  get path() {
    return this.#path;
  }

  readSync() {
    if (this.#closed) throw dirClosed();
    return this.#entries.shift() ?? null;
  }

  // Without a callback, a promise. With one, a closed handle throws and an
  // invalid callback is refused before an entry is consumed.
  read(callback) {
    if (callback === undefined) {
      return new Promise((resolve) => {
        resolve(this.readSync());
      });
    }
    if (this.#closed) throw dirClosed();
    process.nextTick(callback, null, this.#entries[0] ?? null);
    this.#entries.shift();
  }

  closeSync() {
    if (this.#closed) throw dirClosed();
    this.#closed = true;
    this.#entries = [];
  }

  close(callback) {
    if (callback === undefined) {
      return new Promise((resolve) => {
        this.closeSync();
        resolve();
      });
    }
    process.nextTick(callback, this.#closed ? dirClosed() : null);
    if (!this.#closed) this.closeSync();
  }

  async *entries() {
    try {
      for (let entry = await this.read(); entry; entry = await this.read()) {
        yield entry;
      }
    } finally {
      await this.close();
    }
  }

  [Symbol.asyncIterator]() {
    return this.entries();
  }

  [Symbol.dispose]() {
    if (!this.#closed) this.closeSync();
  }

  async [Symbol.asyncDispose]() {
    if (!this.#closed) await this.close();
  }
}

module.exports = { VfsDir };
