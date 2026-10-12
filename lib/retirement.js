'use strict';

const { KIND_NAMES } = require('./place.js');

// Retirement — the books of ACK-before-free on the main thread.
//
// A published representation a commit replaces or removes is retired under
// a retireId the place's tree takes from these books' counter (next()) —
// one counter for the kernel and all its trees. It stays retired until
// every link live at its update has ACKed the update (or is gone) and no
// thread holds it: a worker holds what its ACK reported as retained, until
// its release; the main thread holds what its own pins still read. Nothing
// is freed on a timeout.
//
// The books decide and free nothing: every change of state returns the
// records it may have left unheld, and the kernel settles them — take()
// takes one that nothing keeps any more off the books, once, and the
// kernel returns its extent to the pool.
//
//   acks     updateId → { pending: Set<linkId>, retired: [record] }
//   retired  retireId → { id, updateId, place, key, kind, extent,
//                         retiredAt, holders: Set<linkId | 'main'> }

// What a change that leaves nothing to settle returns.
const NONE = Object.freeze([]);

// RetireIds run from 1 to the largest small integer of any V8 build, then
// from 1 again (lib/tree.js, "Retirement").
const MAX_ID = 2 ** 30 - 1;

// Readable label of a retired representation, for diagnostics only:
// `static:/video.mp4 [fs:br]#1847`. Never parsed back.
const labelOf = ({ place, key, kind, id }) =>
  kind === 0
    ? `${place}:${key}#${id}`
    : `${place}:${key} [${KIND_NAMES[kind]}]#${id}`;

class Retirement {
  acks = new Map();
  retired = new Map();
  #last;

  // `last`: the retireId given last — 0, but for a test of the end of
  // the range.
  constructor(last = 0) {
    this.#last = last;
  }

  // The retireId given last; 0 before the first.
  get nextRetireId() {
    return this.#last;
  }

  // The next retireId, past the ones still on the books: a tree takes one
  // for each representation its commit retires. One a refused commit took
  // is skipped, never given twice in a run of the counter.
  next() {
    let id = this.#last;
    do id = id >= MAX_ID ? 1 : id + 1;
    while (this.retired.has(id));
    this.#last = id;
    return id;
  }

  // The representation of `kind` the update being committed replaces or
  // removes in `place` — its file's key, its extent — under the retireId
  // its tree gave it; on the books once the update is committed. Its
  // updateId, set by commit(), is there from the start: every record keeps
  // one shape.
  retire(id, place, key, kind, extent, retiredAt) {
    const holders = new Set();
    return { id, updateId: 0, place, key, kind, extent, retiredAt, holders };
  }

  // The update `updateId` is committed: its retired representations are on
  // the books.
  commit(updateId, records) {
    for (const record of records) {
      record.updateId = updateId;
      this.retired.set(record.id, record);
    }
  }

  // `holder` still reads these retired representations; unknown ids are
  // ignored.
  hold(retireIds, holder) {
    for (const id of retireIds || []) {
      this.retired.get(id)?.holders.add(holder);
    }
  }

  // The retired representations of a committed update wait for the ACK of
  // every link live now (`links`, by link id); with none, only for their
  // holders: they are returned, to be settled at once.
  track(updateId, records, links) {
    if (records.length === 0 || links.size === 0) return records;
    const pending = new Set(links.keys());
    this.acks.set(updateId, { pending, retired: records });
    return NONE;
  }

  // A link applied `updateId`. `retained` lists the retired representations
  // it still reads; they are held before its ACK can free anything. The
  // last ACK of an update returns its records.
  ack(updateId, linkId, retained) {
    this.hold(retained, linkId);
    const ack = this.acks.get(updateId);
    if (!ack || !ack.pending.delete(linkId) || ack.pending.size > 0) {
      return NONE;
    }
    this.acks.delete(updateId);
    return ack.retired;
  }

  // The last consumer of these retired representations in one thread is
  // done.
  release(holder, retireIds) {
    const done = [];
    for (const id of retireIds || []) {
      const record = this.retired.get(id);
      if (record?.holders.delete(holder)) done.push(record);
    }
    return done;
  }

  // A link is gone: it will neither ACK nor read anything any more.
  exit(linkId) {
    const done = [];
    for (const [updateId, ack] of this.acks) {
      if (!ack.pending.delete(linkId) || ack.pending.size > 0) continue;
      this.acks.delete(updateId);
      done.push(...ack.retired);
    }
    for (const record of this.retired.values()) {
      if (record.holders.delete(linkId)) done.push(record);
    }
    return done;
  }

  // Takes `record` off the books once neither an ACK nor a holder keeps
  // it: true the one time it does, and the caller frees its extent.
  take(record) {
    if (record.holders.size > 0 || this.acks.has(record.updateId)) return false;
    return this.retired.delete(record.id);
  }

  // What is still retired: which representation, held by whom, how large,
  // for how long, and whether it waits for ACKs or only for its holders.
  list() {
    const now = Date.now();
    const result = [];
    for (const record of this.retired.values()) {
      const { place, key, kind, extent, retiredAt, holders } = record;
      const pending = this.acks.get(record.updateId)?.pending;
      result.push({
        id: record.id,
        label: labelOf(record),
        place,
        key,
        representation: KIND_NAMES[kind],
        bytes: extent.length,
        ageMs: now - retiredAt,
        waiting: pending ? 'ack' : 'release',
        pending: pending ? [...pending] : [],
        holders: [...holders],
      });
    }
    return result;
  }

  // The books at `now`, summed for diagnostics; each reads and changes
  // nothing. A record is one representation — a source, or one of its
  // derived representations, retired on its own.

  // What is retired — its representations and bytes, the age of the
  // oldest — and why it waits: for ACKs, or for its holders only.
  summary(now) {
    const count = () => ({ representations: 0, bytes: 0 });
    const waitingAck = count();
    const waitingRelease = count();
    let oldest = now;
    for (const record of this.retired.values()) {
      const part = this.acks.has(record.updateId) ? waitingAck : waitingRelease;
      part.representations++;
      part.bytes += record.extent.length;
      oldest = Math.min(oldest, record.retiredAt);
    }
    return {
      representations:
        waitingAck.representations + waitingRelease.representations,
      bytes: waitingAck.bytes + waitingRelease.bytes,
      oldestMs: now - oldest,
      waitingAck,
      waitingRelease,
    };
  }

  // What `holder` — a link, or the main thread — still reads of what is
  // retired: its representations and bytes, the age of the oldest.
  heldBy(holder, now) {
    const held = { representations: 0, bytes: 0, oldestMs: 0 };
    for (const record of this.retired.values()) {
      if (!record.holders.has(holder)) continue;
      held.representations++;
      held.bytes += record.extent.length;
      held.oldestMs = Math.max(held.oldestMs, now - record.retiredAt);
    }
    return held;
  }

  // The updates `linkId` has not ACKed, and the age of the oldest: the
  // books keep them in the order of their updates. Only an update that
  // retires a representation waits for ACKs: one that retires nothing is
  // never tracked.
  pendingOf(linkId, now) {
    const pending = { updates: 0, oldestMs: 0 };
    for (const ack of this.acks.values()) {
      if (!ack.pending.has(linkId)) continue;
      if (pending.updates++ === 0) {
        pending.oldestMs = now - ack.retired[0].retiredAt;
      }
    }
    return pending;
  }

  // Kernel shutdown: nothing waits or is held any more.
  clear() {
    this.acks.clear();
    this.retired.clear();
  }
}

module.exports = { Retirement };
