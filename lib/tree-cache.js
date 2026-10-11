'use strict';

// The path cache and the miss cache of one thread's tree. Both are filled
// by lookups and emptied by the tree at changes of structure; neither keeps
// an answer — a hit is a node, a miss a place where the walk stopped — so
// the policies of a path are passed anew on every read. Keys are the
// tree's own strings. On overflow a batch of the oldest goes, in the order
// of insertion: a hit does not reorder.

const batchOf = (max) => Math.max(1, max >>> 4);

// A string of the tree's own: never a slice of the caller's, which keeps
// its whole parent alive. V8 slices from 13 chars on. Taken only when a
// cache keeps the key: a cache of size 0 copies nothing.
const own = (s) => (s.length < 13 ? s : JSON.parse(JSON.stringify(s)));

// Whether `node` died or lies in one of the subtrees `roots` (a Set, or
// null): the climb by the parents ends at one of them, or at a node with
// no parent — the tree's root, or a dead node, whose name is null.
const gone = (node, roots) => {
  for (let n = node; ; n = n.parent) {
    if (roots !== null && roots.has(n)) return true;
    if (n.parent === null) return n.name === null;
  }
};

// Whether `key` is one of `prefixes` (an array, or null) or lies below one.
const below = (key, prefixes) => {
  if (prefixes === null) return false;
  for (let i = 0; i < prefixes.length; i++) {
    const prefix = prefixes[i];
    if (!key.startsWith(prefix)) continue;
    if (key.length === prefix.length || key.charCodeAt(prefix.length) === 47) {
      return true;
    }
  }
  return false;
};

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

  // `owned`: the key is the tree's own string already.
  set(key, node, owned) {
    const map = this.#map;
    if (map.size >= this.#max) {
      if (this.#max === 0) return;
      let n = batchOf(this.#max);
      for (const old of map.keys()) {
        map.delete(old);
        if (--n === 0) break;
      }
    }
    map.set(owned ? key : own(key), node);
  }

  delete(key) {
    this.#map.delete(key);
  }

  clear() {
    this.#map.clear();
  }

  // One pass for any number of subtrees: the entries of the nodes that
  // died or lie in `roots`, whatever their keys were.
  sweep(roots) {
    for (const [key, node] of this.#map) {
      if (gone(node, roots)) this.#map.delete(key);
    }
  }

  // One pass for a few subtrees: the entries at or below one of their
  // former keys (`prefixes`, or null), and with `dead` those of the nodes
  // that died — a test of the key alone touches no node.
  sweepKeys(prefixes, dead) {
    for (const [key, node] of this.#map) {
      if (below(key, prefixes) || (dead && node.name === null)) {
        this.#map.delete(key);
      }
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
  // `at + 1`; `owned`: the key is the tree's own string already.
  add(key, stop, at, owned) {
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
    const mine = owned ? key : own(key);
    const miss = new Miss(mine, stop, at);
    map.set(mine, miss);
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

  // One pass for any number of subtrees: the misses that stopped at a node
  // that died or lies in `roots`.
  sweep(roots) {
    for (const stop of this.#stops.keys()) {
      if (gone(stop, roots)) this.drop(stop);
    }
  }

  // One pass for a few subtrees: the misses at or below one of their former
  // keys — a stop in one of them lies on its key's path — and with `dead`
  // those whose stop died.
  sweepKeys(prefixes, dead) {
    for (const [key, miss] of this.#map) {
      if (below(key, prefixes) || (dead && miss.stop.name === null)) {
        this.#map.delete(key);
        this.#unlink(miss);
      }
    }
  }

  clear() {
    this.#map.clear();
    this.#stops.clear();
  }
}

module.exports = { PathCache, MissCache };
