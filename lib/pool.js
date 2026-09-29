'use strict';

// pool — works through a list a bounded number of calls at a time.
//
// Disk work that grows with a tree or an epoch never runs all at once: a
// read holds a file descriptor from open to close, and an unbounded epoch
// of 2000 files at `ulimit -n 1024` failed half of them with EMFILE.
// IO_LIMIT keeps the libuv threadpool (4 threads by default) busy: more in
// flight is no faster, 4 is slower.

const IO_LIMIT = 16;

// Calls fn(item, index) for every item, in order, at most `limit` at a
// time: the first `limit` calls start before pool() returns, and each one
// that settles starts the next. The first failure starts nothing more and
// rejects with its error, without waiting for the calls still running; a
// caller whose items must all run catches inside `fn`.
const pool = async (items, limit, fn) => {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        await fn(items[index], index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const size = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: size }, worker));
};

module.exports = { pool, IO_LIMIT };
