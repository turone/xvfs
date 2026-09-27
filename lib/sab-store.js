'use strict';

const { VirtualStore } = require('./virtual-store.js');

// SabStore — mutations of a `sab + virtual` Place on the main thread, with
// the semantics of VirtualStore. The kernel owns the allocator, the
// preparation pipeline, epoch publication and ACK-before-free; this store
// runs each mutation in its turn and hands raw input to the kernel.
//
// Publication crosses the SAB allocator and (when configured) the
// compression threadpool, so mutations are asynchronous: every method
// returns a Promise that settles once the new version is published, before
// worker ACKs — those only govern when the replaced bytes are released.
//
// Ordering is per key, so the state a method validates against is the state
// its publication is applied to, while unrelated keys never wait. `rename`
// of a file locks both keys at once; `rm` and the `rename` of a directory
// may touch a whole subtree and therefore take an exclusive place barrier,
// which cannot race a write to a child. The kernel's methods are called
// through the kernel object, each time.

class SabStore extends VirtualStore {
  sync = false;

  // Keys whose publication has begun and not committed yet.
  #creating = new Set();

  constructor(place, kernel) {
    super(place);
    this.kernel = kernel;
  }

  get creating() {
    return this.#creating;
  }

  run(keys, fn) {
    return this.kernel.enqueueMutation(this.place, keys, fn);
  }

  // Until the publication commits or fails the key counts as a file, so a
  // mutation of another key running meanwhile cannot put a file above or
  // below it.
  async create(key, publish) {
    this.#creating.add(key);
    try {
      return await publish();
    } finally {
      this.#creating.delete(key);
    }
  }

  publishRaw(key, raw) {
    return this.kernel.publishVirtual(this.place, key, raw);
  }

  unpublish(keys) {
    return this.kernel.unpublishVirtual(this.place, keys);
  }

  moveEntry(from, to, fail) {
    return this.kernel.renameVirtual(this.place, from, to, fail);
  }

  moveTree(moves, fail) {
    return this.kernel.renameVirtualTree(this.place, moves, fail);
  }
}

module.exports = { SabStore };
