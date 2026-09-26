'use strict';

const { SEP } = require('./companion.js');

// Retirement — the books of ACK-before-free on the main thread.
//
// A shared version an update replaces or removes is retired under a fresh
// retireId, a counter never reused. It stays retired until every link live
// at its update has ACKed the update (or is gone) and no thread holds it:
// a worker holds what its ACK reported as retained, until its release;
// the main thread holds what its own pins still read. Nothing is freed on
// a timeout.
//
// The books decide and free nothing: every change of state returns the
// records it may have left unheld, and the kernel settles them — take()
// takes one that nothing keeps any more off the books, once, and the
// kernel returns its bytes to the pool.
//
//   acks     updateId → { pending: Set<linkId>, retired: [record] }
//   retired  retireId → { id, updateId, place, key, entry, retiredAt,
//                         holders: Set<linkId | 'main'> }

// What a change that leaves nothing to settle returns.
const NONE = Object.freeze([]);

// Readable label of a retired representation, for diagnostics only:
// `static:/video.mp4 [fs:br]#1847`. Never parsed back.
const labelOf = ({ place, key, id }) => {
  const at = key.indexOf(SEP);
  const name = at === -1 ? key : `${key.slice(0, at)} [${key.slice(at + 1)}]`;
  return `${place}:${name}#${id}`;
};

class Retirement {
  acks = new Map();
  retired = new Map();
  nextRetireId = 0;

  // A version the update being committed replaces or removes, under a
  // fresh retireId; on the books once the update is committed. Its
  // updateId, set by commit(), is there from the start: every record keeps
  // one shape.
  retire(place, key, entry, retiredAt) {
    const id = ++this.nextRetireId;
    const holders = new Set();
    return { id, updateId: 0, place, key, entry, retiredAt, holders };
  }

  // The update `updateId` is committed: its retired versions are on the
  // books.
  commit(updateId, records) {
    for (const record of records) {
      record.updateId = updateId;
      this.retired.set(record.id, record);
    }
  }

  // `holder` still reads these retired versions; unknown ids are ignored.
  hold(retireIds, holder) {
    for (const id of retireIds || []) {
      this.retired.get(id)?.holders.add(holder);
    }
  }

  // The retired versions of a committed update wait for the ACK of every
  // link live now (`links`, by link id); with none, only for their
  // holders: they are returned, to be settled at once.
  track(updateId, records, links) {
    if (records.length === 0 || links.size === 0) return records;
    const pending = new Set(links.keys());
    this.acks.set(updateId, { pending, retired: records });
    return NONE;
  }

  // A link applied `updateId`. `retained` lists the retired versions it
  // still reads; they are held before its ACK can free anything. The last
  // ACK of an update returns its records.
  ack(updateId, linkId, retained) {
    this.hold(retained, linkId);
    const ack = this.acks.get(updateId);
    if (!ack || !ack.pending.delete(linkId) || ack.pending.size > 0) {
      return NONE;
    }
    this.acks.delete(updateId);
    return ack.retired;
  }

  // The last consumer of these retired versions in one thread is done.
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
  // it: true the one time it does, and the caller frees its bytes.
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
      const { place, key, entry, retiredAt, holders } = record;
      const at = key.indexOf(SEP);
      const pending = this.acks.get(record.updateId)?.pending;
      result.push({
        id: record.id,
        label: labelOf(record),
        place,
        key: at === -1 ? key : key.slice(0, at),
        representation: at === -1 ? 'source' : key.slice(at + 1),
        bytes: entry.length,
        ageMs: now - retiredAt,
        waiting: pending ? 'ack' : 'release',
        pending: pending ? [...pending] : [],
        holders: [...holders],
      });
    }
    return result;
  }

  // Kernel shutdown: nothing waits or is held any more. Ids are never
  // reused.
  clear() {
    this.acks.clear();
    this.retired.clear();
  }
}

module.exports = { Retirement };
