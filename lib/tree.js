'use strict';

// The node tree of a place (.work/stage1/SPEC.md): the main thread's tree
// takes commits, replicas in workers follow it by snapshot and deltas.
//
// A commit is planned first (lib/tree-plan.js) against the tree as it is
// and an overlay of its own ops: every check passes or the commit throws
// with nothing changed. What passes is a log of primitive steps — create,
// attach, detach, kill, set a payload, a class, a policy, relocate — and
// the log is the delta: main applies it to itself with the very code a
// replica applies it with, so the two cannot drift apart. The steps are the
// points where the structure changes; the aggregates, the path cache, the
// miss cache and the tree's numbers follow them there and nowhere else.

const path = require('node:path');
const {
  SMALL,
  KINDS,
  OTHERS,
  column,
  Rep,
  Others,
  Extras,
  Payload,
  BirthPayload,
  CountedKids,
  nodeClass,
  repOf,
  primers,
} = require('./tree-node.js');
const {
  NEW,
  ATTACH,
  ROOT,
  DETACH,
  KILL,
  PAYLOAD,
  UNPUBLISH,
  CLASS,
  POLICY,
  RELOCATE,
  DIR,
  refusal,
  isClass,
  PayloadColumns,
  Log,
  FsPlan,
  ClientPlan,
} = require('./tree-plan.js');
const { PathCache, MissCache } = require('./tree-cache.js');

const MAX_ENTRIES = 2 ** 24; // as many as a V8 Map holds
const DEFAULT_CACHE = 2 ** 16;
const DEFAULT_THRESHOLD = 1024;
// Up to this many former keys a sweep tests keys; past it, it climbs. By
// measure (10^5 files, 2^16 entries): one key 1.3 ms, two 2.2, four 4.4,
// eight 8.2, sixteen 15.1 — the climb 10 ms for any number.
const FEW_PREFIXES = 8;

// The tree's mark: unique in the process — random across threads, counted
// within one.
const MARK_BASE = Math.floor(Math.random() * 2 ** 20) * 2 ** 32;
let marks = 0;

const invalid = (message) => refusal('EINVAL', -1, message);
const stale = () =>
  refusal('ESTALE', -1, 'the structure changed under the iterator');

// A node whose policy refused: `decision` is what allow answered.
class Denied {
  constructor(node, decision) {
    this.node = node;
    this.decision = decision;
  }
}

// A miss of match(): the deepest node on the path and the rest of the key
// from the first missing name, with its leading '/'.
class NotFound {
  constructor(node, rest) {
    this.node = node;
    this.rest = rest;
  }
}

// --- Columns ----------------------------------------------------------------

// A value of a column: one in the range of a small integer read from a
// Float64Array is made one, so that its field does not hold a boxed double.
const at = (col, i) => {
  const v = col[i];
  return typeof v === 'number' && v >= -SMALL && v < SMALL ? v | 0 : v;
};

// Strings of the tree's own: never slices of the caller's, which keep their
// whole parents alive. One JSON round trip copies the names of a commit.
const ownAll = (list) =>
  list.length === 0 ? list : JSON.parse(JSON.stringify(list));

// Whether the rest of a key from `from` (a name's start, past a '/') is
// names each after one '/', none empty, '.' or '..', none holding '\' or
// NUL: a key that is not one misses, and no miss of it is remembered.
const isRest = (key, from) => {
  for (let at = from; ;) {
    const to = key.indexOf('/', at);
    const end = to === -1 ? key.length : to;
    const length = end - at;
    if (length === 0) return false;
    if (length <= 2 && key.charCodeAt(at) === 46) {
      if (length === 1 || key.charCodeAt(at + 1) === 46) return false;
    }
    for (let i = at; i < end; i++) {
      const c = key.charCodeAt(i);
      if (c === 92 || c === 0) return false;
    }
    if (to === -1) return true;
    at = to + 1;
  }
};

// A short digest of a text, for the mark of the format (53 bits of cyrb53).
const digest = (text) => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
};

const bump = (counts, cls, n) => {
  for (let i = 0; i < counts.length; i += 2) {
    if (counts[i] === cls) {
      counts[i + 1] += n;
      return;
    }
  }
  counts.push(cls, n);
};

// --- Options ----------------------------------------------------------------

const isFlag = (value) => value === undefined || typeof value === 'boolean';
const isSize = (n) => Number.isInteger(n) && n >= 0 && n <= MAX_ENTRIES;

// The settings of the caches, { size, misses, moveThreshold }: `options`
// over `base`, refused with EINVAL when they are not ones, as an object of
// their own — for createTree, for fromSnapshot over the snapshot's, and as
// the copy a snapshot carries.
const cacheSettings = (options, base) => {
  if (options === null || typeof options !== 'object') {
    throw invalid('cache options');
  }
  const size = options.size ?? base.size;
  let misses = options.misses ?? base.misses;
  if (misses === true) misses = { size: DEFAULT_CACHE };
  if (misses !== false) {
    if (misses === null || typeof misses !== 'object') {
      throw invalid('misses options');
    }
    misses = { size: misses.size ?? DEFAULT_CACHE };
    if (!isSize(misses.size)) throw invalid('misses.size');
  }
  const moveThreshold = options.moveThreshold ?? base.moveThreshold;
  if (!isSize(size)) throw invalid('cache.size');
  const threshold =
    moveThreshold === Infinity ||
    (Number.isInteger(moveThreshold) && moveThreshold >= 0);
  if (!threshold) throw invalid('cache.moveThreshold');
  return { size, misses, moveThreshold };
};

const CACHE_DEFAULTS = {
  size: DEFAULT_CACHE,
  misses: false,
  moveThreshold: DEFAULT_THRESHOLD,
};

const containersOf = (list) => {
  if (!Array.isArray(list) || !list.every(isClass)) {
    throw invalid('containers: an array of classes');
  }
  return [...list];
};

const WALK_MODES = { include: 0, skip: 1, only: 2 };

// --- The tree ---------------------------------------------------------------

class Tree {
  // The objects that keep every numeric field tagged (see primers()):
  // held here, as long as the class lives, and read by no one.
  static primers = primers();

  // The mark of this copy of the encoding, the same in every thread that
  // loads this copy: the format's version, and a digest of the code that
  // writes and reads snapshots and deltas and of where it was loaded from
  // — another copy, or other code at the same path, makes another mark.
  // No mark of one module instance can serve: every worker loads its own
  // instance and takes main's snapshots. The path stays out of snapshots.
  static #format = `xvfs-tree/1 ${digest(
    [__filename, Tree, PayloadColumns, Log, column, at].join('\n'),
  )}`;

  #main;
  #mark;
  #fs;
  #mode;
  #sep;
  #segments;
  #directories;
  #birthtime;
  #classes; // the class counters
  #versions; // the subtree versions
  #maxNodes;
  #retireIds;
  #ids = { next: 1, wrapped: false }; // the main FS tree's counter
  #Node;
  #containers; // Set<class>
  #containerList;
  #cacheOptions;
  #cache;
  #cached; // whether the path cache keeps anything: its size is not 0
  #misses;
  #moveThreshold;
  #root = null;
  #byId = new Map();
  #version = 0;
  #structureVersion = 0;
  #policyVersion = 0;
  #revision = 0;
  #epoch = 0; // +1 with every change of structure: the iterators' mark

  constructor(config) {
    this.#main = config.main;
    this.#mark = config.mark;
    this.#mode = config.mode;
    this.#fs = config.mode === 'engine';
    this.#sep = config.sep;
    this.#segments = config.segments;
    this.#directories = config.directories;
    this.#birthtime = config.birthtime;
    this.#classes = config.classes;
    this.#versions = config.versions;
    this.#maxNodes = config.maxNodes;
    this.#retireIds = config.retireIds;
    this.#Node = nodeClass(!this.#fs, this.#versions);
    this.#containerList = this.#fs ? [DIR] : config.containers;
    this.#containers = new Set(this.#containerList);
    this.#cacheOptions = config.cache;
    const { size, misses, moveThreshold } = config.cache;
    this.#cache = new PathCache(size);
    this.#cached = size > 0;
    this.#misses = misses === false ? null : new MissCache(misses.size);
    this.#moveThreshold = moveThreshold;
  }

  static create(options = {}) {
    if (options === null || typeof options !== 'object') {
      throw invalid('options');
    }
    const mode = options.ids ?? 'engine';
    if (mode !== 'engine' && mode !== 'number' && mode !== 'string') {
      throw invalid(`ids: ${mode}`);
    }
    const fs = mode === 'engine';
    const { directories, birthtime, aggregates = {}, retireIds } = options;
    if (!isFlag(directories) || !isFlag(birthtime)) throw invalid('flags');
    if (directories === true && !fs) {
      throw invalid('directory attributes in a tree with client ids');
    }
    if (aggregates === null || typeof aggregates !== 'object') {
      throw invalid('aggregates');
    }
    if (!isFlag(aggregates.classes) || !isFlag(aggregates.subtreeVersion)) {
      throw invalid('aggregates');
    }
    let containers = [];
    const rule = options.containers;
    if (fs) {
      const fixed = Array.isArray(rule) && rule.length === 1 && rule[0] === DIR;
      if (rule !== undefined && !fixed) {
        throw invalid('an FS tree has its own rule of containers');
      }
    } else if (rule !== undefined) {
      containers = containersOf(rule);
    }
    const sep = options.sep ?? path.sep;
    if (sep !== '/' && sep !== '\\') throw invalid(`sep: ${sep}`);
    const segments = options.segments ?? new Map();
    if (!(segments instanceof Map)) throw invalid('segments: a Map');
    const maxNodes = options.maxNodes ?? MAX_ENTRIES;
    const bound = Number.isInteger(maxNodes) && maxNodes >= 1;
    if (!bound || maxNodes > MAX_ENTRIES) throw invalid('maxNodes');
    const now = options.now ?? 0;
    if (typeof now !== 'number' || !Number.isFinite(now)) throw invalid('now');
    if (retireIds === null || typeof retireIds?.next !== 'function') {
      throw invalid('retireIds: { next() }');
    }
    const tree = new Tree({
      main: true,
      mark: MARK_BASE + ++marks,
      mode,
      sep,
      segments,
      containers,
      directories: directories === true,
      birthtime: birthtime === true,
      classes: aggregates.classes === true,
      versions: aggregates.subtreeVersion === true,
      maxNodes,
      retireIds,
      cache: cacheSettings(options.cache ?? {}, CACHE_DEFAULTS),
    });
    if (fs) tree.#plant(now);
    return tree;
  }

  // An FS tree's root: the directory with id 0, attributes from `now`.
  #plant(now) {
    const root = new this.#Node(0, DIR);
    root.name = '';
    if (this.#directories) root.payload = this.#dirPayload(0, now, now);
    this.#root = root;
    this.#byId.set(0, root);
  }

  static fromSnapshot(snapshot, segments, options = {}) {
    if (
      snapshot === null ||
      typeof snapshot !== 'object' ||
      snapshot.format !== Tree.#format
    ) {
      throw invalid('not a snapshot of this engine');
    }
    if (!(segments instanceof Map)) throw invalid('segments: a Map');
    if (options === null || typeof options !== 'object') {
      throw invalid('options');
    }
    const s = snapshot;
    const tree = new Tree({
      main: false,
      mark: s.mark,
      mode: s.ids,
      sep: s.sep,
      segments,
      containers: [...s.containers],
      directories: s.directories,
      birthtime: s.birthtime,
      classes: s.classes,
      versions: s.versions,
      maxNodes: s.maxNodes,
      retireIds: null,
      cache: cacheSettings(options.cache ?? {}, s.cache),
    });
    tree.#revision = s.revision;
    tree.#version = s.version;
    tree.#structureVersion = s.structureVersion;
    tree.#policyVersion = s.policyVersion;
    tree.#grow(s);
    return tree;
  }

  // --- The numbers --------------------------------------------------------

  get version() {
    return this.#version;
  }

  get structureVersion() {
    return this.#structureVersion;
  }

  get policyVersion() {
    return this.#policyVersion;
  }

  // The reading rule: which classes are containers. In this thread only,
  // without a commit; an FS tree's is fixed.
  get containers() {
    return [...this.#containerList];
  }

  set containers(list) {
    if (this.#fs) throw invalid('an FS tree has its own rule of containers');
    this.#containerList = containersOf(list);
    this.#containers = new Set(this.#containerList);
  }

  // --- Lookups ------------------------------------------------------------

  get(key, options) {
    if (options != null && options.allow != null) {
      return this.#allowed(key, 0, false, options, false);
    }
    if (this.#cached) {
      const node = this.#cache.get(key);
      if (node !== undefined) return node;
    }
    return this.#walk(key, 0, false, false, null, undefined);
  }

  match(key, options) {
    if (options != null && options.allow != null) {
      return this.#allowed(key, 0, false, options, true);
    }
    if (this.#cached) {
      const node = this.#cache.get(key);
      if (node !== undefined) return node;
    }
    return this.#walk(key, 0, false, true, null, undefined);
  }

  // `abs.slice(from)`: '' or the path past the mount, '/' between names and
  // '\' too when the tree's sep is '\'. A path with a '\' is walked as it
  // is, past the caches, whose keys are spelled with '/' only: a respelling
  // (split + join, ~170 ns) costs more than the walk while its nodes stay
  // in the CPU's caches — not on random reads over 10⁵ files, where a hit
  // would win (the bench: 300 ns respelled, 410 walked). Linux is the main
  // platform; there no path has a '\'.
  resolve(abs, from, options) {
    if (typeof abs !== 'string') throw invalid('resolve: a path');
    const both = this.#sep === '\\' && abs.indexOf('\\', from) !== -1;
    if (options != null && options.allow != null) {
      return both
        ? this.#allowed(abs, from, true, options, false)
        : this.#allowed(abs.slice(from), 0, false, options, false);
    }
    if (both) return this.#walk(abs, from, true, false, null, undefined);
    const key = from === 0 ? abs : abs.slice(from);
    if (this.#cached) {
      const node = this.#cache.get(key);
      if (node !== undefined) return node;
    }
    return this.#walk(key, 0, false, false, null, undefined);
  }

  // With `allow`: a hit passes the own policies of its chain anew. An FS
  // tree has none, and allow is never called there.
  #allowed(key, from, both, options, match) {
    const { allow, context } = options;
    if (typeof allow !== 'function') throw invalid('allow: a function');
    const node = both || !this.#cached ? undefined : this.#cache.get(key);
    if (this.#fs) {
      if (node !== undefined) return node;
      return this.#walk(key, from, both, match, null, undefined);
    }
    if (node !== undefined) return this.#pass(node, allow, context);
    return this.#walk(key, from, both, match, allow, context);
  }

  // Past a miss of the path cache, or past the caches for a path with '\'
  // (`both`): the miss cache, else the walk name by name from the root
  // along `key` from `from`, a separator or the end, passing each own
  // policy as it reaches it and remembering what it found or where it
  // stopped. `allow` null: none.
  #walk(key, from, both, match, allow, context) {
    if (typeof key !== 'string') throw invalid('a key: a string');
    const root = this.#root;
    const n = key.length;
    const first = key.charCodeAt(from); // NaN past the end
    const sep = first === 47 || (both && first === 92);
    // '' and a separator alone are the root
    if (n === from || (sep && n === from + 1)) {
      if (root === null) return match ? new NotFound(null, '/') : null;
      return allow === null ? root : this.#pass(root, allow, context);
    }
    if (!sep) throw invalid(`not a key: ${key}`);
    if (root === null) return match ? new NotFound(null, key) : null;
    const misses = both ? null : this.#misses;
    if (misses !== null) {
      const miss = misses.get(key);
      if (miss !== undefined) {
        const { stop } = miss;
        if (allow !== null) {
          const answer = this.#pass(stop, allow, context);
          if (answer !== stop) return answer;
        }
        return match ? new NotFound(stop, key.slice(miss.at)) : null;
      }
    }
    let node = root;
    let i = from + 1;
    for (;;) {
      if (allow !== null && node.policy !== null) {
        const decision = allow(node.policy, node, context);
        if (decision !== true) return new Denied(node, decision);
      }
      if (i > n) break; // past the last name
      let end = key.indexOf('/', i);
      if (both) {
        const back = key.indexOf('\\', i);
        if (back !== -1 && (end === -1 || back < end)) end = back;
      }
      if (end === -1) end = n;
      const { kids } = node;
      const child = kids === null ? undefined : kids.get(key.slice(i, end));
      if (child === undefined) {
        if (misses !== null && isRest(key, i)) {
          misses.add(key, node, i - 1, false);
        }
        return match ? new NotFound(node, key.slice(i - 1)) : null;
      }
      node = child;
      i = end + 1;
    }
    if (!both && this.#cached) this.#cache.set(key, node, false);
    return node;
  }

  // The own policies from the root down to `node`: `node` when all let it
  // through, else the upper refusal.
  #pass(node, allow, context) {
    let owners = null;
    for (let n = node; n !== null; n = n.parent) {
      if (n.policy !== null) (owners ??= []).push(n);
    }
    if (owners === null) return node;
    for (let i = owners.length - 1; i >= 0; i--) {
      const owner = owners[i];
      const decision = allow(owner.policy, owner, context);
      if (decision !== true) return new Denied(owner, decision);
    }
    return node;
  }

  check(node, allow, context) {
    if (typeof allow !== 'function') throw invalid('allow: a function');
    if (node.name === null) return null;
    if (this.#fs) return node;
    return this.#pass(node, allow, context);
  }

  byId(id) {
    return this.#byId.get(id) ?? null;
  }

  // --- Nodes ----------------------------------------------------------------

  nodeId(node) {
    return node.id;
  }

  nameOf(node) {
    return node.name;
  }

  parentOf(node) {
    return node.parent;
  }

  payloadOf(node) {
    return node.payload;
  }

  policyOf(node) {
    return this.#fs ? null : node.policy;
  }

  classOf(node) {
    return node.name === null ? null : node.cls;
  }

  isDirectory(node) {
    if (node.name === null) return false;
    return this.#fs ? node.cls === DIR : this.#containers.has(node.cls);
  }

  pathOf(node) {
    if (node.name === null) return null;
    if (node.parent === null) return '';
    const names = [];
    for (let n = node; n.parent !== null; n = n.parent) names.push(n.name);
    return '/' + names.reverse().join('/');
  }

  trailOf(node) {
    if (node.name === null) return null;
    const trail = [];
    for (let n = node; n !== null; n = n.parent) trail.push(n);
    return trail.reverse();
  }

  childOf(node, name) {
    const { kids } = node;
    if (kids === null) return null;
    return kids.get(name) ?? null;
  }

  countOf(node) {
    const { kids } = node;
    return kids === null ? 0 : kids.size;
  }

  children(node) {
    if (node.name === null) return null;
    if (this.#fs && node.cls !== DIR) return null;
    const out = [];
    const { kids } = node;
    if (kids === null) return out;
    if (this.#fs) {
      for (const child of kids.values()) {
        out.push([child.name, child.cls === DIR]);
      }
    } else {
      const containers = this.#containers;
      for (const child of kids.values()) {
        out.push([child.name, containers.has(child.cls)]);
      }
    }
    return out;
  }

  classCountOf(node, cls) {
    if (!this.#classes) throw invalid('the class counters are off');
    const { kids } = node;
    if (kids === null) return 0;
    const { counts } = kids;
    for (let i = 0; i < counts.length; i += 2) {
      if (counts[i] === cls) return counts[i + 1];
    }
    return 0;
  }

  leafCountOf(node) {
    if (!this.#classes) throw invalid('the class counters are off');
    const { kids } = node;
    if (kids === null) return 0;
    const { counts } = kids;
    let sum = 0;
    for (let i = 0; i < counts.length; i += 2) {
      if (!this.#isContainerClass(counts[i])) sum += counts[i + 1];
    }
    return sum;
  }

  #isContainerClass(cls) {
    return this.#fs ? cls === DIR : this.#containers.has(cls);
  }

  subtreeVersionOf(node) {
    if (!this.#versions) throw invalid('the subtree versions are off');
    return node.name === null ? null : node.ver;
  }

  // --- Traversal --------------------------------------------------------------

  // Lazy, copying nothing: a step after a change of structure is ESTALE.
  childNodesOf(node) {
    return this.#childNodes(node.kids, this.#epoch);
  }

  *#childNodes(kids, epoch) {
    if (kids === null) return;
    for (const child of kids.values()) {
      if (this.#epoch !== epoch) throw stale();
      yield child;
    }
    if (this.#epoch !== epoch) throw stale();
  }

  walk(nodes, options = {}) {
    if (options === null || typeof options !== 'object') {
      throw invalid('walk options');
    }
    const { depth = Infinity, containers = 'include', classes } = options;
    const { filter, descend } = options;
    const finite = Number.isInteger(depth) && depth >= 1;
    if (typeof depth !== 'number' || !(depth === Infinity || finite)) {
      throw invalid('walk: depth from 1');
    }
    const mode = WALK_MODES[containers];
    if (mode === undefined) throw invalid(`walk: containers ${containers}`);
    if (classes !== undefined && classes !== null && !Array.isArray(classes)) {
      throw invalid('walk: classes');
    }
    if (filter !== undefined && typeof filter !== 'function') {
      throw invalid('walk: filter');
    }
    if (descend !== undefined && typeof descend !== 'function') {
      throw invalid('walk: descend');
    }
    const starts = Array.isArray(nodes) ? nodes : [nodes];
    const only = classes == null ? null : new Set(classes);
    const epoch = this.#epoch;
    return this.#walkFrom(starts, depth, mode, only, filter, descend, epoch);
  }

  *#walkFrom(starts, depth, mode, classes, filter, descend, epoch) {
    for (let s = 0; s < starts.length; s++) {
      if (this.#epoch !== epoch) throw stale();
      const start = starts[s];
      if (start === null || typeof start !== 'object') continue;
      if (start.name === null || start.kids === null) continue;
      const stack = [start.kids.values()];
      while (stack.length > 0) {
        if (this.#epoch !== epoch) throw stale();
        const next = stack[stack.length - 1].next();
        if (next.done) {
          stack.pop();
          continue;
        }
        const node = next.value;
        const level = stack.length;
        let selected = true;
        if (mode !== 0) {
          const container = this.#isContainerClass(node.cls);
          selected = mode === 1 ? !container : container;
        }
        if (selected && classes !== null) selected = classes.has(node.cls);
        if (selected && filter !== undefined) selected = filter(node) === true;
        if (selected) yield [node, level];
        if (node.kids === null || level >= depth) continue;
        if (descend !== undefined && descend(node) !== true) continue;
        if (this.#epoch !== epoch) throw stale();
        stack.push(node.kids.values());
      }
    }
    if (this.#epoch !== epoch) throw stale();
  }

  // --- Commits ----------------------------------------------------------------

  #arguments(next, now) {
    if (!Number.isSafeInteger(next) || next < this.#version) {
      throw invalid(`next ${next}: a safe integer from ${this.#version}`);
    }
    if (typeof now !== 'number' || !Number.isFinite(now)) {
      throw invalid('now: a finite number');
    }
  }

  #view() {
    return {
      root: this.#root,
      byId: this.#byId,
      maxNodes: this.#maxNodes,
      segments: this.#segments,
      birthtime: this.#birthtime,
      mode: this.#mode,
    };
  }

  commit(ops, next, now) {
    if (!this.#main) throw invalid('a replica takes no commit');
    if (!Array.isArray(ops)) throw invalid('ops: an array');
    this.#arguments(next, now);
    const plan = this.#fs
      ? new FsPlan(this.#view(), this.#ids).run(ops)
      : new ClientPlan(this.#view()).commit(ops);
    return this.#publish(plan, next, now);
  }

  load(rows, next, now) {
    if (!this.#main) throw invalid('a replica takes no load');
    if (!Array.isArray(rows)) throw invalid('rows: an array');
    this.#arguments(next, now);
    if (this.#fs) throw invalid('an FS tree takes no load');
    const plan = new ClientPlan(this.#view()).load(rows);
    return this.#publish(plan, next, now);
  }

  // The retireIds, the last thing that may refuse; then the delta, applied
  // here as every replica applies it.
  #publish(plan, next, now) {
    const { log } = plan;
    if (log.op.length === 0) {
      return { delta: null, retired: [], version: this.#version };
    }
    const retired = [];
    for (const { id, kind, rep } of plan.retired) {
      retired.push({ id, kind, retireId: this.#retireIds.next(), rep });
    }
    const version = log.changed ? next : this.#version;
    const delta = this.#encode(log, retired, version, now);
    this.#run(delta);
    return { delta, retired, version: this.#version };
  }

  // A column of ids: numbers by the rule of a numeric column, strings as
  // the tree's own.
  #idColumn(list) {
    return this.#mode === 'string' ? ownAll(list) : column(list);
  }

  #encode(log, retired, version, now) {
    const rid = [];
    const rkind = [];
    const rret = [];
    for (const r of retired) {
      rid.push(r.id);
      rkind.push(r.kind);
      rret.push(r.retireId);
    }
    return {
      mark: this.#mark,
      from: this.#revision,
      version,
      now,
      op: new Uint8Array(log.op),
      id: this.#idColumn(log.id),
      parent: this.#idColumn(log.parent),
      name: ownAll(log.name),
      int: new Int32Array(log.int),
      ...log.payloads.columns(),
      policy: log.policy,
      retired: {
        id: this.#mode === 'string' ? rid : column(rid),
        kind: new Uint8Array(rkind),
        retireId: column(rret),
      },
    };
  }

  // --- Replicas ---------------------------------------------------------------

  // Every retired representation goes to pins.retain before the first
  // change: what it throws leaves the replica as it was. Past that the
  // delta is trusted — the main tree of this engine made it.
  apply(delta, pins) {
    if (this.#main) throw invalid('a main tree takes no delta');
    if (delta === null || typeof delta !== 'object') throw invalid('a delta');
    if (delta.mark !== this.#mark) throw invalid('a delta of another tree');
    if (delta.from !== this.#revision) {
      const revisions = `${delta.from} to a replica at ${this.#revision}`;
      throw refusal('ESTALE', -1, `a delta from revision ${revisions}`);
    }
    this.#segmentsOf(delta);
    const { id, kind, retireId } = delta.retired;
    const retained = [];
    for (let i = 0; i < kind.length; i++) {
      const node = this.#byId.get(at(id, i));
      const rep = repOf(node.payload, kind[i]);
      const n = at(retireId, i);
      if (pins.retain(rep, n) === true) retained.push(n);
    }
    this.#run(delta);
    return retained;
  }

  // The steps of a delta, in order.
  #run(delta) {
    const { op, id, parent, name, int, policy } = delta;
    const byId = this.#byId;
    const step = {
      version: delta.version,
      now: delta.now,
      changed: false,
      structure: false,
      policy: false,
      touched: null, // directories whose children changed
      created: null, // directories made
      // The caches: one walk of `budget` nodes for the whole delta builds
      // former keys; past it the subtrees that leave go to `moved`, and one
      // pass at the end (`sweep`) drops what they and the dead held.
      budget: this.#moveThreshold,
      moved: null,
      prefixes: null, // the former keys of the subtrees in `moved`
      dead: false, // a kill left its entries to the pass
      sweep: false,
      payload: 0, // the cursors of the payload columns
      rep: 0,
      extras: 0,
    };
    let p = 0; // the cursor of parent and name
    let c = 0; // of int
    let k = 0; // of policy
    for (let i = 0; i < op.length; i++) {
      switch (op[i]) {
        case NEW: {
          const node = new this.#Node(at(id, i), int[c++]);
          byId.set(node.id, node);
          if (this.#versions) node.ver = step.version;
          if (this.#directories && node.cls === DIR) {
            (step.created ??= new Set()).add(node);
          }
          step.changed = true;
          step.structure = true;
          break;
        }
        case ATTACH: {
          const node = byId.get(at(id, i));
          this.#attach(node, byId.get(at(parent, p)), name[p], step);
          p++;
          break;
        }
        case ROOT: {
          const node = byId.get(at(id, i));
          node.name = '';
          node.parent = null;
          this.#root = node;
          step.changed = true;
          step.structure = true;
          break;
        }
        case DETACH:
          this.#detach(byId.get(at(id, i)), step);
          break;
        case KILL:
          this.#kill(byId.get(at(id, i)), step);
          break;
        case PAYLOAD: {
          const node = byId.get(at(id, i));
          node.payload = this.#payloadOf(delta, step);
          this.#changed(node, step);
          break;
        }
        case UNPUBLISH: {
          const node = byId.get(at(id, i));
          node.payload = null;
          this.#changed(node, step);
          break;
        }
        case CLASS: {
          const node = byId.get(at(id, i));
          const cls = int[c++];
          if (this.#classes) {
            for (let a = node.parent; a !== null; a = a.parent) {
              bump(a.kids.counts, node.cls, -1);
              bump(a.kids.counts, cls, 1);
            }
          }
          node.cls = cls;
          this.#changed(node, step);
          break;
        }
        case POLICY: {
          const node = byId.get(at(id, i));
          node.policy = policy[k++];
          step.policy = true;
          this.#changed(node, step);
          break;
        }
        case RELOCATE: {
          const node = byId.get(at(id, i));
          node.payload = this.#relocated(node.payload, int[c++], delta, step);
          break;
        }
        default:
          throw new Error(`lib/tree.js: an unknown step ${op[i]}`);
      }
    }
    const { version } = step;
    if (step.touched !== null || step.created !== null) {
      this.#directoryPayloads(step);
    }
    if (step.sweep) this.#sweep(step);
    if (step.changed) {
      this.#version = version;
      if (step.structure) this.#structureVersion = version;
      if (step.policy) this.#policyVersion = version;
    }
    if (step.structure) this.#epoch++;
    this.#revision++;
  }

  // A change of the node itself: its subtree version and the ancestors'.
  #changed(node, step) {
    if (this.#versions) this.#stamp(node, step.version);
    step.changed = true;
  }

  // Ancestors carry a subtree version no lower than their descendants':
  // the climb stops at the first that has this one already.
  #stamp(from, version) {
    for (let a = from; a !== null && a.ver !== version; a = a.parent) {
      a.ver = version;
    }
  }

  // The class counters of `node`'s subtree, itself included, added to
  // `from` and every ancestor above it (sign 1) or taken from them (−1).
  #count(from, node, sign) {
    const own = node.cls;
    const below = node.kids === null ? null : node.kids.counts;
    for (let a = from; a !== null; a = a.parent) {
      const { counts } = a.kids;
      bump(counts, own, sign);
      if (below === null) continue;
      for (let i = 0; i < below.length; i += 2) {
        if (below[i + 1] !== 0) bump(counts, below[i], sign * below[i + 1]);
      }
    }
  }

  #attach(node, parent, name, step) {
    node.parent = parent;
    node.name = name;
    let { kids } = parent;
    if (kids === null) {
      kids = this.#classes ? new CountedKids() : new Map();
      parent.kids = kids;
    }
    kids.set(name, node);
    if (this.#classes) this.#count(parent, node, 1);
    if (this.#versions) this.#stamp(parent, step.version);
    if (this.#misses !== null) this.#misses.appear(parent, name);
    if (this.#directories) (step.touched ??= new Set()).add(parent);
    step.changed = true;
    step.structure = true;
  }

  #detach(node, step) {
    const { parent } = node;
    step.changed = true;
    step.structure = true;
    if (parent === null) {
      // The root, which a load moves under another.
      this.#root = null;
      this.#cache.clear();
      if (this.#misses !== null) this.#misses.clear();
      return;
    }
    this.#forget(node, step);
    if (this.#classes) this.#count(parent, node, -1);
    const { kids } = parent;
    kids.delete(node.name);
    if (kids.size === 0) parent.kids = null;
    if (this.#versions) this.#stamp(parent, step.version);
    if (this.#directories) (step.touched ??= new Set()).add(parent);
    node.parent = null;
  }

  // The key of an attached node, or null for one in a subtree a step has
  // detached: its keys went with that subtree's.
  #keyOf(node) {
    const names = [];
    let n = node;
    for (; n.parent !== null; n = n.parent) names.push(n.name);
    if (n !== this.#root) return null;
    return names.length === 0 ? '' : '/' + names.reverse().join('/');
  }

  // A subtree changes its keys: the entries and the misses under its former
  // ones go. Walked by those keys while the delta's budget lasts and the
  // subtree is no larger than what the caches hold; else it joins `moved`,
  // and so does every subtree after it — one pass at the end takes them
  // all, however many there are.
  #forget(node, step) {
    const misses = this.#misses;
    const stops = misses === null ? 0 : misses.stops;
    const entries = this.#cache.size + stops;
    if (entries === 0) return;
    // null: a node in a subtree a step has detached already — its keys go
    // with that subtree's, walked or swept.
    const key = this.#keyOf(node);
    if (!step.sweep) {
      if (key === null) return;
      const limit = Math.min(step.budget, entries);
      const walked = this.#unkey(node, key, limit, stops > 0);
      if (walked !== -1) {
        step.budget -= walked;
        return;
      }
      step.sweep = true;
    }
    (step.moved ??= new Set()).add(node);
    if (key !== null) (step.prefixes ??= []).push(key);
  }

  // The one pass: by the former keys while there are few — each key tested
  // against each, no node touched unless a kill left its dead to the pass —
  // else by a climb from each entry's node to the subtrees that left, which
  // costs the same for any number of them and several times one key's
  // test: a node a level, scattered in the heap. The dead go either way.
  #sweep(step) {
    const { prefixes, moved, dead } = step;
    const misses = this.#misses;
    if (prefixes === null || prefixes.length <= FEW_PREFIXES) {
      this.#cache.sweepKeys(prefixes, dead);
      if (misses !== null) misses.sweepKeys(prefixes, dead);
    } else {
      this.#cache.sweep(moved);
      if (misses !== null) misses.sweep(moved);
    }
  }

  // The entries of a subtree, by keys built top-down from its own, and the
  // misses that stopped in it: how many nodes it walked, or −1 past `limit`.
  #unkey(node, key, limit, misses) {
    const cache = this.#cache;
    const nodes = [node];
    const keys = [key];
    let walked = 0;
    while (nodes.length > 0) {
      if (walked === limit) return -1;
      walked++;
      const n = nodes.pop();
      const k = keys.pop();
      cache.delete(k);
      if (misses) this.#misses.drop(n);
      if (n.kids === null) continue;
      for (const child of n.kids.values()) {
        nodes.push(child);
        keys.push(`${k}/${child.name}`);
      }
    }
    return walked;
  }

  // A node and its subtree die: out of byId and the caches, every field
  // that leads anywhere let go — a dead node answers as a missing one.
  #kill(node, step) {
    step.changed = true;
    step.structure = true;
    const cache = this.#cache;
    const misses = this.#misses;
    const root = node === this.#root;
    const key = !root && cache.size > 0 ? this.#keyOf(node) : null;
    const { parent } = node;
    if (root) {
      this.#root = null;
      cache.clear();
      if (misses !== null) misses.clear();
    } else if (parent !== null) {
      if (this.#classes) this.#count(parent, node, -1);
      const { kids } = parent;
      kids.delete(node.name);
      if (kids.size === 0) parent.kids = null;
      if (this.#versions) this.#stamp(parent, step.version);
      if (this.#directories) (step.touched ??= new Set()).add(parent);
    }
    const all = [];
    const stack = [node];
    while (stack.length > 0) {
      const n = stack.pop();
      all.push(n);
      if (n.kids === null) continue;
      for (const child of n.kids.values()) stack.push(child);
    }
    // The entries by keys and the misses by stops, one by one, while the
    // subtree is no larger than what the caches hold; else — and once a
    // pass is due anyway — the pass at the end drops the dead.
    const stops = misses === null ? 0 : misses.stops;
    let each = false;
    if (cache.size + stops > 0) {
      if (step.sweep || all.length > cache.size + stops) {
        step.sweep = true;
        step.dead = true;
      } else {
        if (key !== null) this.#unkey(node, key, Infinity, false);
        each = stops > 0;
      }
    }
    const byId = this.#byId;
    const policies = !this.#fs;
    for (const n of all) {
      byId.delete(n.id);
      if (each) misses.drop(n);
      if (policies && n.policy !== null) {
        step.policy = true;
        n.policy = null;
      }
      n.name = null;
      n.parent = null;
      n.kids = null;
      n.payload = null;
    }
  }

  // --- Payloads ---------------------------------------------------------------

  // A Representation takes its SAB when made: a segment the thread's map
  // does not hold yet is refused here — at fromSnapshot, which makes them
  // all, and before apply's first change (#segmentsOf) — not left to a
  // TypeError of a read long after.
  #rep(kind, segmentId, offset, length) {
    if (length === 0) return new Rep(kind, segmentId, offset, length, null);
    const sab = this.#segments.get(segmentId);
    if (sab === undefined) throw this.#noSegment(segmentId);
    return new Rep(kind, segmentId, offset, length, sab);
  }

  #noSegment(segmentId) {
    return invalid(`segment ${segmentId} is not in this thread's map`);
  }

  // Every non-empty extent of a delta lies in a segment of the map.
  #segmentsOf(delta) {
    const { seg, len } = delta;
    const segments = this.#segments;
    for (let r = 0; r < len.length; r++) {
      if (len[r] !== 0 && !segments.has(at(seg, r))) {
        throw this.#noSegment(at(seg, r));
      }
    }
  }

  #payload(version, size, mtime, birth, source, others, extras) {
    if (!this.#birthtime) {
      return new Payload(version, size, mtime, source, others, extras);
    }
    return new BirthPayload(
      version,
      size,
      mtime,
      birth,
      source,
      others,
      extras,
    );
  }

  // The payload at the cursors of the payload columns of a delta or a
  // snapshot.
  #payloadOf(columns, step) {
    const q = step.payload++;
    const mask = columns.kinds[q];
    let source = null;
    let others = null;
    if (mask !== 0) {
      const { seg, off, len } = columns;
      const slots = [null, null, null, null, null, null, null];
      for (let kind = 0; kind < KINDS; kind++) {
        if ((mask & (1 << kind)) === 0) continue;
        const r = step.rep++;
        slots[kind] = this.#rep(kind, at(seg, r), at(off, r), at(len, r));
      }
      source = slots[0];
      if (mask > 1) {
        others = new Others(
          slots[1],
          slots[2],
          slots[3],
          slots[4],
          slots[5],
          slots[6],
        );
      }
    }
    let extras = null;
    const x = step.extras;
    if (x < columns.xi.length && columns.xi[x] === q) {
      extras = new Extras(columns.meta[x], columns.script[x]);
      step.extras++;
    }
    const size = at(columns.size, q);
    const birth = this.#birthtime ? columns.birth[q] : 0;
    const { version } = step;
    return this.#payload(
      version,
      size,
      columns.mtime[q],
      birth,
      source,
      others,
      extras,
    );
  }

  // A new payload with one representation's extent replaced: the same
  // attributes and extras, the other Representation objects as they are; a
  // relocated source keeps `others`, a derived one gets a new `others`.
  #relocated(payload, kind, delta, step) {
    const r = step.rep++;
    const { seg, off, len } = delta;
    const rep = this.#rep(kind, at(seg, r), at(off, r), at(len, r));
    let { source, others } = payload;
    if (kind === 0) {
      source = rep;
    } else {
      const slots = [];
      for (const field of OTHERS) slots.push(others[field]);
      slots[kind - 1] = rep;
      others = new Others(...slots);
    }
    const { version, size, mtimeMs, birthtimeMs, extras } = payload;
    return this.#payload(
      version,
      size,
      mtimeMs,
      birthtimeMs,
      source,
      others,
      extras,
    );
  }

  #dirPayload(version, mtime, birth) {
    return this.#payload(version, 0, mtime, birth, null, null, null);
  }

  // One new payload for each directory the delta made or whose children it
  // changed, however many of its steps did.
  #directoryPayloads(step) {
    const { version, now, created } = step;
    const dirs = step.touched ?? new Set();
    if (created !== null) for (const dir of created) dirs.add(dir);
    for (const dir of dirs) {
      if (dir.name === null) continue;
      const fresh = created !== null && created.has(dir);
      const before = dir.payload;
      const birth = fresh || before === null ? now : before.birthtimeMs;
      dir.payload = this.#dirPayload(version, now, birth);
    }
  }

  // --- Snapshots --------------------------------------------------------------

  // The tree in pre-order, children in their order, as columns.
  snapshot() {
    const id = [];
    const up = [];
    const names = [];
    const cls = [];
    const ver = [];
    const pay = new PayloadColumns(this.#birthtime, true);
    const pnode = [];
    const qnode = [];
    const qvalue = [];
    const root = this.#root;
    if (root !== null) {
      const versions = this.#versions;
      const policies = !this.#fs;
      const levels = [];
      const parents = [];
      let node = root;
      let parentIndex = -1;
      for (;;) {
        const index = id.length;
        id.push(node.id);
        up.push(parentIndex);
        names.push(node.name);
        cls.push(node.cls);
        if (versions) ver.push(node.ver);
        if (node.payload !== null) {
          pnode.push(index);
          pay.payload(node.payload);
        }
        if (policies && node.policy !== null) {
          qnode.push(index);
          qvalue.push(node.policy);
        }
        if (node.kids !== null) {
          levels.push(node.kids.values());
          parents.push(index);
        }
        let next = null;
        while (levels.length > 0) {
          const item = levels[levels.length - 1].next();
          if (!item.done) {
            next = item.value;
            break;
          }
          levels.pop();
          parents.pop();
        }
        if (next === null) break;
        node = next;
        parentIndex = parents[parents.length - 1];
      }
    }
    const small = cls.every((c) => c < 256);
    return {
      format: Tree.#format,
      mark: this.#mark,
      revision: this.#revision,
      version: this.#version,
      structureVersion: this.#structureVersion,
      policyVersion: this.#policyVersion,
      ids: this.#mode,
      sep: this.#sep,
      containers: [...this.#containerList],
      directories: this.#directories,
      birthtime: this.#birthtime,
      classes: this.#classes,
      versions: this.#versions,
      maxNodes: this.#maxNodes,
      cache: cacheSettings({}, this.#cacheOptions),
      id: this.#mode === 'string' ? id : column(id),
      up: new Int32Array(up),
      name: names,
      cls: small ? new Uint8Array(cls) : new Int32Array(cls),
      ver: this.#versions ? column(ver) : null,
      pnode: new Int32Array(pnode),
      ...pay.columns(),
      qnode: new Int32Array(qnode),
      qvalue,
    };
  }

  // A replica's nodes from the columns of a snapshot. Plain loops: no
  // closure holds a column past the return.
  #grow(s) {
    const count = s.up.length;
    const nodes = new Array(count);
    const byId = this.#byId;
    const Node = this.#Node;
    const Kids = this.#classes ? CountedKids : Map;
    const { up, name, cls } = s;
    for (let i = 0; i < count; i++) {
      const node = new Node(at(s.id, i), cls[i]);
      node.name = name[i];
      const p = up[i];
      if (p === -1) {
        this.#root = node;
      } else {
        const parent = nodes[p];
        node.parent = parent;
        if (parent.kids === null) parent.kids = new Kids();
        parent.kids.set(node.name, node);
      }
      byId.set(node.id, node);
      nodes[i] = node;
    }
    if (this.#versions) {
      for (let i = 0; i < count; i++) nodes[i].ver = at(s.ver, i);
    }
    const step = { version: 0, payload: 0, rep: 0, extras: 0 };
    const { pnode, pver } = s;
    for (let q = 0; q < pnode.length; q++) {
      step.version = at(pver, q);
      nodes[pnode[q]].payload = this.#payloadOf(s, step);
    }
    const { qnode, qvalue } = s;
    for (let j = 0; j < qnode.length; j++) nodes[qnode[j]].policy = qvalue[j];
    if (this.#classes) {
      // Bottom-up: a node's counters are whole before its parent takes them.
      for (let i = count - 1; i > 0; i--) {
        const node = nodes[i];
        const { counts } = node.parent.kids;
        bump(counts, node.cls, 1);
        if (node.kids === null) continue;
        const below = node.kids.counts;
        for (let j = 0; j < below.length; j += 2) {
          bump(counts, below[j], below[j + 1]);
        }
      }
    }
  }
}

const createTree = (options) => Tree.create(options);
const fromSnapshot = (snapshot, segments, options) =>
  Tree.fromSnapshot(snapshot, segments, options);

module.exports = { createTree, fromSnapshot, Denied, NotFound };
