'use strict';

// The path cache and the miss cache of one thread's tree. Both are filled
// by lookups and emptied by the tree at changes of structure; neither keeps
// an answer — a hit is a node, a miss a place where the walk stopped — so
// the policies of a path are passed anew on every read. Keys are the
// tree's own strings. On overflow a batch of the oldest goes, in the order
// of insertion: a hit does not reorder.

const batchOf = (max) => Math.max(1, max >>> 4);

// Map<key, node> behind a class of its own, so that the container can be
// swapped should a benchmark show a gain.
class PathCache {
  #map = new Map();
  #max;

  constructor(max) {
    this.#max = max;
  }

  get size() {
    return this.#map.size;
  }

  get(key) {
    return this.#map.get(key);
  }

  set(key, node) {
    const map = this.#map;
    if (map.size >= this.#max) {
      if (this.#max === 0) return;
      let n = batchOf(this.#max);
      for (const old of map.keys()) {
        map.delete(old);
        if (--n === 0) break;
      }
    }
    map.set(key, node);
  }

  delete(key) {
    this.#map.delete(key);
  }

  clear() {
    this.#map.clear();
  }

  // The entries at one of `prefixes` or below one.
  sweep(prefixes) {
    const map = this.#map;
    if (map.size === 0) return;
    for (const prefix of prefixes) {
      if (prefix === '') return void map.clear();
    }
    for (const key of map.keys()) {
      for (const prefix of prefixes) {
        if (
          key.startsWith(prefix) &&
          (key.length === prefix.length || key.charCodeAt(prefix.length) === 47)
        ) {
          map.delete(key);
          break;
        }
      }
    }
  }

  // The entries of nodes that died.
  sweepDead() {
    for (const [key, node] of this.#map) {
      if (node.name === null) this.#map.delete(key);
    }
  }
}

// One remembered miss: its key and the deepest node the walk reached; the
// first missing name starts at `at + 1` in the key. Misses with one stop
// and one name make a list, so that a node appearing there drops them all
// without a search by prefix.
class Miss {
  constructor(key, stop, at) {
    this.key = key;
    this.stop = stop;
    this.at = at;
    this.prev = null;
    this.next = null;
  }

  // Whether its first missing name is `name`, without cutting it out.
  names(name) {
    const { key, at } = this;
    const end = at + 1 + name.length;
    if (!key.startsWith(name, at + 1)) return false;
    return end === key.length || key.charCodeAt(end) === 47;
  }

  get name() {
    const { key, at } = this;
    const to = key.indexOf('/', at + 1);
    return to === -1 ? key.slice(at + 1) : key.slice(at + 1, to);
  }
}

class MissCache {
  #map = new Map(); // key → Miss
  // stop → its misses: the head of the list of its one missing name, or
  // Map<name, head> once it has several — most stops have one.
  #stops = new Map();
  #max;

  constructor(max) {
    this.#max = max;
  }

  get size() {
    return this.#map.size;
  }

  get stops() {
    return this.#stops.size;
  }

  get(key) {
    return this.#map.get(key);
  }

  // A miss of `key`, whose first missing name below `stop` starts at
  // `at + 1`.
  add(key, stop, at) {
    const map = this.#map;
    if (map.size >= this.#max) {
      if (this.#max === 0) return;
      let n = batchOf(this.#max);
      for (const [old, miss] of map) {
        map.delete(old);
        this.#unlink(miss);
        if (--n === 0) break;
      }
    }
    const miss = new Miss(key, stop, at);
    map.set(key, miss);
    const held = this.#stops.get(stop);
    if (held === undefined) return void this.#stops.set(stop, miss);
    if (held instanceof Miss) {
      const { name } = miss;
      if (held.names(name)) {
        this.#push(miss, held);
        this.#stops.set(stop, miss);
      } else {
        this.#stops.set(
          stop,
          new Map([
            [held.name, held],
            [name, miss],
          ]),
        );
      }
      return;
    }
    const { name } = miss;
    const head = held.get(name);
    if (head !== undefined) this.#push(miss, head);
    held.set(name, miss);
  }

  #push(miss, head) {
    miss.next = head;
    head.prev = miss;
  }

  #unlink(miss) {
    const { prev, next, stop } = miss;
    if (next !== null) next.prev = prev;
    if (prev !== null) return void (prev.next = next);
    const held = this.#stops.get(stop);
    if (held === miss) {
      if (next !== null) this.#stops.set(stop, next);
      else this.#stops.delete(stop);
      return;
    }
    const { name } = miss;
    if (next !== null) return void held.set(name, next);
    held.delete(name);
    if (held.size === 0) this.#stops.delete(stop);
  }

  #forget(miss) {
    for (; miss !== null; miss = miss.next) this.#map.delete(miss.key);
  }

  // A node appeared under `stop` with `name`: the misses through it are
  // misses no more.
  appear(stop, name) {
    const held = this.#stops.get(stop);
    if (held === undefined) return;
    if (held instanceof Miss) {
      if (!held.names(name)) return;
      this.#stops.delete(stop);
      return void this.#forget(held);
    }
    const head = held.get(name);
    if (head === undefined) return;
    held.delete(name);
    if (held.size === 0) this.#stops.delete(stop);
    this.#forget(head);
  }

  // `stop` died or its key changed: its misses would hold it.
  drop(stop) {
    const held = this.#stops.get(stop);
    if (held === undefined) return;
    this.#stops.delete(stop);
    if (held instanceof Miss) return void this.#forget(held);
    for (const head of held.values()) this.#forget(head);
  }

  // The misses that stopped at nodes that died.
  dropDead() {
    for (const stop of this.#stops.keys()) {
      if (stop.name === null) this.drop(stop);
    }
  }

  clear() {
    this.#map.clear();
    this.#stops.clear();
  }
}

module.exports = { PathCache, MissCache };
