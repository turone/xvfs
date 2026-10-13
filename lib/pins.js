'use strict';

// Pins — the direct consumers of shared bytes in one thread: streams and
// view leases over a published representation. Keys are the
// Representation objects of the place's tree (lib/tree.js), each one
// physical version of one representation: a move or an unrelated commit
// keeps the object, and a new version is a new one.
//
// Pinning the current version is local bookkeeping only. When an update
// retires a pinned representation, the thread binds it to the retireId the
// main kernel assigned and reports it with its ACK; once the last consumer
// is done it sends one release. Nothing crosses threads per chunk, per pin
// or for a version that is never retired while in use.

class Pins {
  #counts = new Map(); // representation → active consumers
  #retired = new Map(); // representation → retireId, once retired while in use
  #closers = new Set(); // shutdown hooks of active streams
  #release; // (retireIds) → void
  // A broken view (break()): runs once nothing is pinned any more.
  #idle = null;

  constructor(release) {
    this.#release = release;
  }

  // One more consumer of `rep`; returns its idempotent release. `onClose`
  // runs if the kernel closes while the consumer is still active.
  acquire(rep, onClose = null) {
    this.#counts.set(rep, (this.#counts.get(rep) || 0) + 1);
    if (onClose) this.#closers.add(onClose);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      if (onClose) this.#closers.delete(onClose);
      this.#drop(rep);
    };
  }

  #drop(rep) {
    const count = this.#counts.get(rep);
    if (count === undefined) return; // closed meanwhile
    if (count > 1) return void this.#counts.set(rep, count - 1);
    this.#counts.delete(rep);
    const id = this.#retired.get(rep);
    if (id !== undefined) {
      this.#retired.delete(rep);
      this.#release([id]);
    }
    if (this.#idle !== null && this.#counts.size === 0) this.#done();
  }

  #done() {
    const idle = this.#idle;
    this.#idle = null;
    idle();
  }

  // Called while an update retires `rep`, before the tree drops it: true
  // when consumers still read it, which binds them to `retireId`.
  retain(rep, retireId) {
    if (!rep || !this.#counts.has(rep)) return false;
    this.#retired.set(rep, retireId);
    return true;
  }

  // Kernel shutdown: stop every active stream and forget every pin.
  close() {
    const closers = [...this.#closers];
    this.#closers.clear();
    this.#counts.clear();
    this.#retired.clear();
    this.#idle = null;
    for (const close of closers) close();
  }

  // A worker's view broke (kernel.js, #break): every stream stops, but the
  // leases and borrowed chunks a consumer still holds stay counted — their
  // bytes are still read, and the main kernel keeps them while the link
  // lives. `idle` runs once the last is released, at once when none is.
  break(idle) {
    const closers = [...this.#closers];
    this.#closers.clear();
    for (const close of closers) close();
    this.#idle = idle;
    if (this.#counts.size === 0) this.#done();
  }

  // Pinned representations (inspection).
  get size() {
    return this.#counts.size;
  }
}

module.exports = { Pins };
