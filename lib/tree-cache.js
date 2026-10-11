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

// One remembered miss: its key, the deepest node the walk reached and the
// first name missing below it, which starts at `at + 1` in the key. Misses
// with one stop and one name make a list, so that a node appearing there
// drops them all without a search by prefix.
class Miss {
  constructor(key, stop, name, at) {
    this.key = key;
    this.stop = stop;
    this.name = name;
    this.at = at;
    this.prev = null;
    this.next = null;
  }
}

class MissCache {
  #map = new Map(); // key → Miss
  #stops = new Map(); // stop → Map<name, Miss>: the heads of the lists
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

  add(key, stop, name, at) {
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
    const miss = new Miss(key, stop, name, at);
    let names = this.#stops.get(stop);
    if (names === undefined) {
      names = new Map();
      this.#stops.set(stop, names);
    }
    const head = names.get(name);
    if (head !== undefined) {
      miss.next = head;
      head.prev = miss;
    }
    names.set(name, miss);
    map.set(key, miss);
  }

  #unlink(miss) {
    const { prev, next } = miss;
    if (next !== null) next.prev = prev;
    if (prev !== null) {
      prev.next = next;
      return;
    }
    const names = this.#stops.get(miss.stop);
    if (next !== null) return void names.set(miss.name, next);
    names.delete(miss.name);
    if (names.size === 0) this.#stops.delete(miss.stop);
  }

  // A node appeared under `stop` with `name`: the misses through it are
  // misses no more.
  appear(stop, name) {
    const names = this.#stops.get(stop);
    if (names === undefined) return;
    let miss = names.get(name);
    if (miss === undefined) return;
    names.delete(name);
    if (names.size === 0) this.#stops.delete(stop);
    for (; miss !== null; miss = miss.next) this.#map.delete(miss.key);
  }

  // `stop` died or its key changed: its misses would hold it.
  drop(stop) {
    const names = this.#stops.get(stop);
    if (names === undefined) return;
    this.#stops.delete(stop);
    for (let miss of names.values()) {
      for (; miss !== null; miss = miss.next) this.#map.delete(miss.key);
    }
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
