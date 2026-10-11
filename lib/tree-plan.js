'use strict';

// Planning a commit: every check of `commit` and `load` runs here, against
// the tree as it stands and an overlay of what the commit has done so far;
// nothing of the tree changes. What passes becomes a log — the primitive
// steps main and every replica apply alike (lib/tree.js) — and the list of
// what it retires. A refusal throws and leaves only garbage behind.

const { SMALL, KINDS, repOf, kindsOf } = require('./tree-node.js');

const DIR = 0;
const FILE = 1;
const MAX_ID = SMALL - 1;

// The steps of a log.
const NEW = 0; // a node, unattached: id, class
const ATTACH = 1; // under a parent: id, parent id, name
const ROOT = 2; // as the root: id
const DETACH = 3; // from its parent, kept alive with its subtree: id
const KILL = 4; // with its whole subtree: id
const PAYLOAD = 5; // a new payload: id, the payload's columns
const UNPUBLISH = 6; // no payload: id
const CLASS = 7; // id, class
const POLICY = 8; // id, the value
const RELOCATE = 9; // id, kind, extent

const refusal = (code, index, message, other) => {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  err.index = index;
  if (other !== undefined) err.other = other;
  return err;
};

// --- Formats --------------------------------------------------------------

// '' or '/' (the root), or names each after one '/', none empty, '.' or
// '..', none holding '\' or NUL — canonicalKey() of lib/place.js. By
// indexOf rather than a regular expression: twice as fast, and every op of
// a commit takes it.
const isKey = (key) => {
  if (typeof key !== 'string') return false;
  if (key === '' || key === '/') return true;
  if (key.charCodeAt(0) !== 47) return false;
  if (key.indexOf('\\') !== -1 || key.indexOf('\0') !== -1) return false;
  for (let from = 1; ;) {
    const to = key.indexOf('/', from);
    const end = to === -1 ? key.length : to;
    const length = end - from;
    if (length === 0) return false;
    if (length <= 2 && key.charCodeAt(from) === 46) {
      if (length === 1 || key.charCodeAt(from + 1) === 46) return false;
    }
    if (to === -1) return true;
    from = to + 1;
  }
};

const NAME = /^(?!\.\.?$)[^/\\\0]+$/;
const isName = (name) => typeof name === 'string' && NAME.test(name);
const isClass = (cls) => Number.isInteger(cls) && cls >= 0 && cls < SMALL;
const isKind = (kind) => Number.isInteger(kind) && kind >= 0 && kind < KINDS;
const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
const isTime = (t) => typeof t === 'number' && Number.isFinite(t);

// An extent of a segment that exists, within it; the empty one of the pool
// is { 0, 0, 0 }, and an empty extent elsewhere holds no bytes either.
const isExtent = (extent, segments) => {
  if (extent === null || typeof extent !== 'object') return false;
  const { segmentId, offset, length } = extent;
  if (!isCount(segmentId) || !isCount(offset) || !isCount(length)) {
    return false;
  }
  if (length === 0 && segmentId === 0 && offset === 0) return true;
  const sab = segments.get(segmentId);
  return sab !== undefined && offset + length <= sab.byteLength;
};

// { size, mtimeMs, birthtimeMs?, meta?, scriptOptions?, representations }
const isPayload = (input, segments) => {
  if (input === null || typeof input !== 'object') return false;
  const { size, mtimeMs, birthtimeMs, representations } = input;
  if (!isCount(size) || !isTime(mtimeMs)) return false;
  if (birthtimeMs !== undefined && !isTime(birthtimeMs)) return false;
  if (!Array.isArray(representations)) return false;
  let seen = 0;
  for (let i = 0; i < representations.length; i++) {
    const pair = representations[i];
    if (!Array.isArray(pair) || pair.length !== 2) return false;
    const kind = pair[0];
    if (!isKind(kind) || (seen & (1 << kind)) !== 0) return false;
    if (!isExtent(pair[1], segments)) return false;
    seen |= 1 << kind;
  }
  return true;
};

const maskOf = (input) => {
  const { representations } = input;
  let mask = 0;
  for (let i = 0; i < representations.length; i++) {
    mask |= 1 << representations[i][0];
  }
  return mask;
};

// --- The log --------------------------------------------------------------

// Steps and their arguments, packed by kind in the order they are taken.
// A payload's representations go by ascending kind.
class Log {
  constructor(birthtime) {
    this.birthtime = birthtime;
    this.op = [];
    this.id = [];
    this.parent = [];
    this.name = [];
    this.int = [];
    this.size = [];
    this.mtime = [];
    this.birth = [];
    this.kinds = [];
    this.seg = [];
    this.off = [];
    this.len = [];
    this.xi = [];
    this.meta = [];
    this.script = [];
    this.policy = [];
    this.changed = false; // anything but relocations
  }

  get empty() {
    return this.op.length === 0;
  }

  step(op, id) {
    this.op.push(op);
    this.id.push(id);
    if (op !== RELOCATE) this.changed = true;
  }

  create(id, cls) {
    this.step(NEW, id);
    this.int.push(cls);
  }

  attach(id, parentId, name) {
    this.step(ATTACH, id);
    this.parent.push(parentId);
    this.name.push(name);
  }

  payload(id, input, birth) {
    this.step(PAYLOAD, id);
    this.size.push(input.size);
    this.mtime.push(input.mtimeMs);
    if (this.birthtime) this.birth.push(birth);
    const { representations } = input;
    const mask = maskOf(input);
    this.kinds.push(mask);
    for (let kind = 0; kind < KINDS; kind++) {
      if ((mask & (1 << kind)) === 0) continue;
      for (let i = 0; i < representations.length; i++) {
        if (representations[i][0] === kind) this.extent(representations[i][1]);
      }
    }
    const { meta, scriptOptions } = input;
    if (meta !== undefined || scriptOptions !== undefined) {
      this.xi.push(this.kinds.length - 1);
      this.meta.push(meta === undefined ? null : meta);
      this.script.push(scriptOptions === undefined ? null : scriptOptions);
    }
  }

  extent({ segmentId, offset, length }) {
    this.seg.push(segmentId);
    this.off.push(offset);
    this.len.push(length);
  }

  relocate(id, kind, extent) {
    this.step(RELOCATE, id);
    this.int.push(kind);
    this.extent(extent);
  }

  setClass(id, cls) {
    this.step(CLASS, id);
    this.int.push(cls);
  }

  setPolicy(id, value) {
    this.step(POLICY, id);
    this.policy.push(value);
  }
}

// --- FS trees ---------------------------------------------------------------

// A node an FS commit makes, until the log is applied: its children as the
// commit has them — a Map of its own, no overlay needed — and the state of
// its payload as #state keeps it for other nodes: kinds, kept (always none,
// nothing of it was published), birth.
class Fresh {
  constructor(id, cls) {
    this.id = id;
    this.cls = cls;
    this.kids = null;
    this.payload = null;
    this.kinds = 0;
    this.kept = 0;
    this.birth = 0;
    this.has = false;
  }
}

// Ops by key in order, each seeing the ones before. The overlay: for each
// directory of the tree the commit changed, its children by name as they
// are now (null for one gone) and their count; the nodes it killed; the
// nodes it made; the payloads it changed.
class FsPlan {
  constructor(tree, ids) {
    this.root = tree.root;
    this.byId = tree.byId;
    this.count = tree.byId.size;
    this.maxNodes = tree.maxNodes;
    this.segments = tree.segments;
    this.ids = ids; // { next, wrapped }: the main tree's counter
    this.log = new Log(tree.birthtime);
    this.retired = []; // [{ id, kind, rep }]: published before, gone after
    this.over = new Map(); // node → { kids: Map<name, node|null>, count }
    this.dead = new Set();
    this.fresh = new Map(); // id → a placeholder of a node made here
    this.pay = new Map(); // node → { kinds, kept, birth, has }
    this.at = null; // the parent of the node find() found
  }

  run(ops) {
    for (let index = 0; index < ops.length; index++) {
      const op = ops[index];
      if (!Array.isArray(op) || typeof op[0] !== 'string') {
        throw refusal('EINVAL', index, 'not an op');
      }
      switch (op[0]) {
        case 'mkdir':
          this.mkdir(op, index);
          break;
        case 'write':
          this.write(op, index);
          break;
        case 'move':
          this.move(op, index);
          break;
        case 'unlink':
        case 'remove':
        case 'rmdir':
          this.remove(op, index);
          break;
        case 'relocate':
          this.relocate(op, index);
          break;
        default:
          throw refusal('EINVAL', index, `an unknown op ${op[0]}`);
      }
    }
    return this;
  }

  // The child `name` of `node` as the commit has it so far, or null.
  child(node, name) {
    const over = this.over.get(node);
    if (over !== undefined) {
      const child = over.kids.get(name);
      if (child !== undefined) return child;
    }
    const { kids } = node;
    if (kids === null) return null;
    return kids.get(name) ?? null;
  }

  countOf(node) {
    const over = this.over.get(node);
    if (over !== undefined) return over.count;
    return node.kids === null ? 0 : node.kids.size;
  }

  #over(node) {
    let over = this.over.get(node);
    if (over === undefined) {
      const count = node.kids === null ? 0 : node.kids.size;
      over = { kids: new Map(), count };
      this.over.set(node, over);
    }
    return over;
  }

  #put(parent, name, node) {
    if (parent instanceof Fresh) {
      (parent.kids ??= new Map()).set(name, node);
      return;
    }
    const over = this.#over(parent);
    over.kids.set(name, node);
    over.count++;
  }

  #cut(parent, name) {
    if (parent instanceof Fresh) {
      parent.kids.delete(name);
      return;
    }
    const over = this.#over(parent);
    over.kids.set(name, null);
    over.count--;
  }

  // The node at `key` ('' excluded), its parent in `this.at`; null when
  // there is none — a file on the way included.
  find(key) {
    let node = this.root;
    let from = 1;
    for (;;) {
      const to = key.indexOf('/', from);
      const child = this.child(
        node,
        to === -1 ? key.slice(from) : key.slice(from, to),
      );
      if (child === null) return null;
      if (to === -1) {
        this.at = node;
        return child;
      }
      node = child;
      from = to + 1;
    }
  }

  // The directory that would hold `key`, whose last '/' is at `end`: a
  // missing one is ENOENT, a file on the way ENOTDIR.
  parentOf(key, end, index) {
    let node = this.root;
    let from = 1;
    while (from <= end) {
      const to = key.indexOf('/', from);
      const child = this.child(node, key.slice(from, to));
      if (child === null) {
        throw refusal('ENOENT', index, `no ${key.slice(0, to)}`);
      }
      if (child.cls !== DIR) {
        throw refusal('ENOTDIR', index, `${key.slice(0, to)} is a file`);
      }
      node = child;
      from = to + 1;
    }
    return node;
  }

  #room(count, index) {
    if (this.count + count > this.maxNodes) {
      throw refusal('ENOSPC', index, `more than ${this.maxNodes} nodes`);
    }
  }

  // The next id of the counter no live node holds, nor one this commit
  // freed or gave: before the first wraparound none ever does.
  #takeId() {
    const { ids } = this;
    let id = ids.next;
    if (ids.wrapped) {
      while (this.byId.has(id) || this.fresh.has(id)) {
        id = id >= MAX_ID ? 1 : id + 1;
      }
    }
    if (id >= MAX_ID) {
      ids.next = 1;
      ids.wrapped = true;
    } else {
      ids.next = id + 1;
    }
    return id;
  }

  #create(parent, name, cls) {
    const id = this.#takeId();
    const node = new Fresh(id, cls);
    this.fresh.set(id, node);
    this.#put(parent, name, node);
    this.count++;
    this.log.create(id, cls);
    this.log.attach(id, parent.id, name);
    return node;
  }

  // What the commit knows of a node's payload: the kinds it holds now, the
  // kinds of the one published before that it still holds, its birthtime.
  // A fresh node is its own.
  #state(node) {
    if (node instanceof Fresh) return node;
    let state = this.pay.get(node);
    if (state === undefined) {
      const { payload } = node;
      const kinds = kindsOf(payload);
      state =
        payload === null
          ? { kinds: 0, kept: 0, birth: 0, has: false }
          : { kinds, kept: kinds, birth: payload.birthtimeMs, has: true };
      this.pay.set(node, state);
    }
    return state;
  }

  // The published representations of `kinds` leave: non-empty ones retire.
  #drop(node, kinds) {
    for (let kind = 0; kind < KINDS; kind++) {
      if ((kinds & (1 << kind)) === 0) continue;
      const rep = repOf(node.payload, kind);
      if (rep.length > 0) this.retired.push({ id: node.id, kind, rep });
    }
  }

  #payload(node, input) {
    const state = this.#state(node);
    if (state.kept !== 0) this.#drop(node, state.kept);
    let birth = input.birthtimeMs;
    if (birth === undefined) birth = state.has ? state.birth : input.mtimeMs;
    state.kinds = maskOf(input);
    state.kept = 0;
    state.birth = birth;
    state.has = true;
    this.log.payload(node.id, input, birth);
  }

  #kill(node) {
    const stack = [node];
    while (stack.length > 0) {
      const n = stack.pop();
      this.dead.add(n);
      this.count--;
      const state = n instanceof Fresh ? n : this.pay.get(n);
      const kept = state === undefined ? kindsOf(n.payload) : state.kept;
      if (kept !== 0) this.#drop(n, kept);
      const over = this.over.get(n);
      const { kids } = n;
      if (kids !== null) {
        for (const [name, child] of kids) {
          const now = over === undefined ? undefined : over.kids.get(name);
          if (now === undefined) stack.push(child);
          else if (now !== null) stack.push(now);
        }
      }
      if (over === undefined) continue;
      for (const [name, child] of over.kids) {
        if (child !== null && (kids === null || !kids.has(name))) {
          stack.push(child);
        }
      }
    }
  }

  mkdir(op, index) {
    const key = op[1];
    if (op.length !== 2 || !isKey(key)) throw refusal('EINVAL', index, 'mkdir');
    if (key === '' || key === '/') throw refusal('EEXIST', index, 'the root');
    const end = key.lastIndexOf('/');
    const parent = this.parentOf(key, end, index);
    const name = key.slice(end + 1);
    if (this.child(parent, name) !== null) {
      throw refusal('EEXIST', index, `${key} exists`);
    }
    this.#room(1, index);
    this.#create(parent, name, DIR);
  }

  write(op, index) {
    const key = op[1];
    const input = op[2];
    const options = op[3];
    if (op.length < 3 || op.length > 4 || !isKey(key)) {
      throw refusal('EINVAL', index, 'write');
    }
    if (
      options !== undefined &&
      (options === null || typeof options !== 'object')
    ) {
      throw refusal('EINVAL', index, 'write options');
    }
    if (!isPayload(input, this.segments)) {
      throw refusal('EINVAL', index, 'a payload input');
    }
    if (key === '' || key === '/') throw refusal('EISDIR', index, 'the root');
    const parents = options !== undefined && options.parents === true;
    const end = key.lastIndexOf('/');
    let node = this.root;
    let from = 1;
    let missing = -1; // where the first missing directory's name starts
    while (from <= end) {
      const to = key.indexOf('/', from);
      const child = this.child(node, key.slice(from, to));
      if (child === null) {
        if (!parents) throw refusal('ENOENT', index, `no ${key.slice(0, to)}`);
        missing = from;
        break;
      }
      if (child.cls !== DIR) {
        throw refusal('ENOTDIR', index, `${key.slice(0, to)} is a file`);
      }
      node = child;
      from = to + 1;
    }
    const name = key.slice(end + 1);
    let file = null;
    let creates = 1;
    if (missing === -1) {
      file = this.child(node, name);
      if (file !== null) {
        if (file.cls === DIR) {
          throw refusal('EISDIR', index, `${key} is a directory`);
        }
        creates = 0;
      }
    } else {
      for (let at = missing; at <= end; at = key.indexOf('/', at) + 1) {
        creates++;
      }
    }
    this.#room(creates, index);
    if (missing !== -1) {
      for (let at = missing; at <= end;) {
        const to = key.indexOf('/', at);
        node = this.#create(node, key.slice(at, to), DIR);
        at = to + 1;
      }
    }
    if (file === null) file = this.#create(node, name, FILE);
    this.#payload(file, input);
  }

  move(op, index) {
    if (op.length !== 3 || !isKey(op[1]) || !isKey(op[2])) {
      throw refusal('EINVAL', index, 'move');
    }
    const key = op[1] === '/' ? '' : op[1];
    const to = op[2] === '/' ? '' : op[2];
    if (key === '') throw refusal('EINVAL', index, 'a move of the root');
    const node = this.find(key);
    if (node === null) throw refusal('ENOENT', index, `no ${key}`);
    const from = this.at;
    if (to === key) return;
    if (
      to === '' ||
      (to.length > key.length &&
        to.charCodeAt(key.length) === 47 &&
        to.startsWith(key))
    ) {
      throw refusal('EINVAL', index, `${to} is below ${key}`);
    }
    const end = to.lastIndexOf('/');
    const parent = this.parentOf(to, end, index);
    const name = to.slice(end + 1);
    if (this.child(parent, name) !== null) {
      throw refusal('EEXIST', index, `${to} exists`);
    }
    this.#cut(from, key.slice(key.lastIndexOf('/') + 1));
    this.#put(parent, name, node);
    this.log.step(DETACH, node.id);
    this.log.attach(node.id, parent.id, name);
  }

  remove(op, index) {
    const what = op[0];
    if (op.length !== 2 || !isKey(op[1])) throw refusal('EINVAL', index, what);
    const key = op[1] === '/' ? '' : op[1];
    if (key === '') throw refusal('EINVAL', index, `${what} of the root`);
    const node = this.find(key);
    if (node === null) throw refusal('ENOENT', index, `no ${key}`);
    if (what === 'unlink' && node.cls === DIR) {
      throw refusal('EISDIR', index, `${key} is a directory`);
    }
    if (what === 'rmdir') {
      if (node.cls !== DIR) throw refusal('ENOTDIR', index, `${key} is a file`);
      if (this.countOf(node) > 0) {
        throw refusal('ENOTEMPTY', index, `${key} is not empty`);
      }
    }
    this.#cut(this.at, key.slice(key.lastIndexOf('/') + 1));
    this.#kill(node);
    this.log.step(KILL, node.id);
  }

  relocate(op, index) {
    const [, id, kind, extent] = op;
    if (op.length !== 4 || !Number.isInteger(id) || id < 0) {
      throw refusal('EINVAL', index, 'relocate');
    }
    if (!isKind(kind) || !isExtent(extent, this.segments)) {
      throw refusal('EINVAL', index, 'relocate: kind or extent');
    }
    let node = this.fresh.get(id) ?? this.byId.get(id) ?? null;
    if (node !== null && this.dead.has(node)) node = null;
    if (node === null) throw refusal('ENOENT', index, `no node ${id}`);
    if (node.cls === DIR) {
      throw refusal('EISDIR', index, `node ${id} is a directory`);
    }
    const state = this.#state(node);
    const bit = 1 << kind;
    if ((state.kinds & bit) === 0) {
      throw refusal(
        'ENOENT',
        index,
        `node ${id} has no representation ${kind}`,
      );
    }
    if ((state.kept & bit) !== 0) {
      this.#drop(node, bit);
      state.kept &= ~bit;
    }
    this.log.relocate(id, kind, extent);
  }
}

// --- Trees with client ids ----------------------------------------------------

// A put of a commit or a row of a load: what it states. `node` is the
// tree's node of its id, if any; `parent` its final parent once known — a
// node of the tree, a put of a new id, null for the root, or UNKNOWN;
// `moves` whether it is new or leaves its place.
class Put {
  constructor(index, id, parentId, name, cls, payload, policy, node) {
    this.index = index;
    this.id = id;
    this.parentId = parentId;
    this.name = name;
    this.cls = cls;
    this.payload = payload;
    this.policy = policy;
    this.node = node;
    this.parent = null;
    this.moves = true;
  }
}

const VIOLATIONS = {
  ENOENT: 'the parent will not live',
  EINVAL: 'a cycle',
  EEXIST: 'the name is taken',
};

const UNKNOWN = Symbol('unknown parent');
const ON = -1; // on a cycle
const OFF = -2; // on no cycle

// A commit states a final state: the first group of checks runs in the order
// of the ops, then the final state is built from the whole set and checked —
// before anything is logged. The log takes the nodes that leave or move out
// first, then the creations, then the attachments by ascending index, then
// the changes of the nodes themselves: no apply holds more than the final
// count of nodes on the way. No closures: what a commit names lives in the
// plan's fields and dies with the plan.
class ClientPlan {
  constructor(tree) {
    this.root = tree.root;
    this.byId = tree.byId;
    this.count = tree.byId.size;
    this.maxNodes = tree.maxNodes;
    this.segments = tree.segments;
    this.strings = tree.mode === 'string';
    this.log = new Log(tree.birthtime);
    this.retired = [];
    this.puts = []; // in the order of their index
    this.named = new Map(); // id → its put
    this.removed = new Set(); // nodes that die by name
    this.alive = new Map(); // node → whether it lives after
    this.kind = null; // 'change' or 'relocate': the first op's
  }

  isId(id) {
    return this.strings ? typeof id === 'string' : Number.isSafeInteger(id);
  }

  // The format of a put or a row: EINVAL at `index`, in any order.
  #format(index, id, parentId, name, cls, payload) {
    const bad =
      !this.isId(id) ||
      (parentId !== null && !this.isId(parentId)) ||
      (parentId === null ? name !== '' : !isName(name)) ||
      (cls !== undefined && !isClass(cls)) ||
      (payload !== undefined &&
        payload !== null &&
        !isPayload(payload, this.segments));
    if (bad) throw refusal('EINVAL', index, 'the format of a put or a row');
  }

  #once(index, id, seen) {
    if (seen.has(id)) throw refusal('EINVAL', index, `id ${id} named twice`);
    seen.add(id);
  }

  #kindOf(index, kind) {
    if (this.kind === null) this.kind = kind;
    else if (this.kind !== kind) {
      throw refusal('EINVAL', index, 'relocate together with put or remove');
    }
  }

  commit(ops) {
    const seen = new Set();
    let rootId = this.root === null ? null : this.root.id;
    const relocations = [];
    for (let index = 0; index < ops.length; index++) {
      const op = ops[index];
      if (!Array.isArray(op) || typeof op[0] !== 'string') {
        throw refusal('EINVAL', index, 'not an op');
      }
      const [what, id] = op;
      if (what === 'put') {
        const [, , parentId, name, fields] = op;
        if (op.length !== 5 || fields === null || typeof fields !== 'object') {
          throw refusal('EINVAL', index, 'put');
        }
        const { class: cls, payload, policy } = fields;
        this.#format(index, id, parentId, name, cls, payload);
        this.#once(index, id, seen);
        // A root exists when it existed or a put of a lower index made it.
        if (parentId === null) {
          if (rootId !== null && rootId !== id) {
            throw refusal('EEXIST', index, 'a second root');
          }
          rootId = id;
        } else if (rootId !== null && id === rootId) {
          throw refusal('EINVAL', index, 'the root under a parent');
        }
        this.#put(index, id, parentId, name, cls, payload, policy);
        this.#kindOf(index, 'change');
      } else if (what === 'remove') {
        if (op.length !== 2 || !this.isId(id)) {
          throw refusal('EINVAL', index, 'remove');
        }
        this.#once(index, id, seen);
        if (this.root !== null && id === this.root.id) {
          throw refusal('EINVAL', index, 'a remove of the root');
        }
        this.#kindOf(index, 'change');
        const node = this.byId.get(id);
        if (node !== undefined) this.removed.add(node);
      } else if (what === 'relocate') {
        const [, , kind, extent] = op;
        if (op.length !== 4 || !this.isId(id) || !isKind(kind)) {
          throw refusal('EINVAL', index, 'relocate');
        }
        if (!isExtent(extent, this.segments)) {
          throw refusal('EINVAL', index, 'relocate: an extent');
        }
        this.#once(index, id, seen);
        this.#kindOf(index, 'relocate');
        const node = this.byId.get(id) ?? null;
        if (node === null) throw refusal('ENOENT', index, `no node ${id}`);
        const rep = repOf(node.payload, kind);
        if (rep === null) {
          const message = `node ${id} has no representation ${kind}`;
          throw refusal('ENOENT', index, message);
        }
        relocations.push({ node, kind, extent, rep });
      } else {
        throw refusal('EINVAL', index, `an unknown op ${what}`);
      }
    }
    if (this.kind !== 'relocate') return this.#final();
    for (const { node, kind, extent, rep } of relocations) {
      if (rep.length > 0) this.retired.push({ id: node.id, kind, rep });
      this.log.relocate(node.id, kind, extent);
    }
    return this;
  }

  load(rows) {
    const seen = new Set();
    let rooted = false;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (row === null || typeof row !== 'object') {
        throw refusal('EINVAL', index, 'not a row');
      }
      const { id, parentId, name, class: cls, payload, policy } = row;
      this.#format(index, id, parentId, name, cls, payload);
      this.#once(index, id, seen);
      // One root, as in a commit; which node it is the rows say.
      if (parentId === null) {
        if (rooted) throw refusal('EEXIST', index, 'a second root');
        rooted = true;
      }
      this.#put(index, id, parentId, name, cls, payload, policy);
    }
    for (const node of this.byId.values()) {
      if (!this.named.has(node.id)) this.removed.add(node);
    }
    return this.#final();
  }

  #put(index, id, parentId, name, cls, payload, policy) {
    const node = this.byId.get(id) ?? null;
    if (node === null && cls === undefined) {
      throw refusal('EINVAL', index, `no class for a new id ${id}`);
    }
    const put = new Put(index, id, parentId, name, cls, payload, policy, node);
    this.puts.push(put);
    this.named.set(id, put);
  }

  // The final state checked, then logged. A cycle has a node that moves,
  // and so has a name taken twice: those checks start from the puts that
  // move or are new, and a load that moves nothing costs no more than its
  // rows.
  #final() {
    const { puts } = this;
    for (const put of puts) {
      const { parentId, node } = put;
      if (parentId !== null) {
        put.parent =
          this.byId.get(parentId) ?? this.named.get(parentId) ?? UNKNOWN;
      }
      if (node !== null) {
        put.moves = node.parent !== put.parent || node.name !== put.name;
      }
    }
    const violations = new Map(); // index → [code, other?]
    for (const put of puts) {
      if (put.parentId === null) continue;
      if (put.parent === UNKNOWN || !this.#lives(put.parent)) {
        violations.set(put.index, ['ENOENT']);
      }
    }
    this.#cycles(violations);
    this.#names(violations);
    if (violations.size > 0) {
      let index = Infinity;
      for (const at of violations.keys()) if (at < index) index = at;
      const [code, other] = violations.get(index);
      throw refusal(code, index, VIOLATIONS[code], other);
    }
    // What dies: the subtrees of the removed nodes but for the nodes of
    // puts, which live wherever they go, and what lies below them.
    const dead = [];
    for (const node of this.removed) {
      if (node.parent === null || this.#lives(node.parent)) {
        this.#doom(node, dead);
      }
    }
    let live = this.count - dead.length;
    for (const put of puts) {
      if (put.node === null && ++live > this.maxNodes) {
        throw refusal('ENOSPC', put.index, `more than ${this.maxNodes} nodes`);
      }
    }
    this.#write(dead);
    return this;
  }

  // Whether a node (or a put) lives after the commit: a node of a put lives,
  // a removed one dies, one the commit does not name lives when its parent
  // does. One climb fills in every node it passed.
  #lives(target) {
    if (target instanceof Put) return true;
    const { alive, named, removed } = this;
    const path = [];
    let at = target;
    let known = alive.get(at);
    while (known === undefined) {
      if (named.has(at.id)) known = true;
      else if (removed.has(at)) known = false;
      else if (at.parent === null) known = true;
      else {
        path.push(at);
        at = at.parent;
        known = alive.get(at);
        continue;
      }
      alive.set(at, known);
    }
    for (const node of path) alive.set(node, known);
    return known;
  }

  // A node's parent after the commit: a put's, else the one it has.
  #up(at) {
    if (at instanceof Put) return at.parent;
    const put = this.named.get(at.id);
    return put === undefined ? at.parent : put.parent;
  }

  // EINVAL for a node of a put whose climb by the final parents comes back
  // to it. Each node is climbed through once: a path that runs into a node
  // seen before ends there, on a cycle of its own or not.
  #cycles(violations) {
    const fate = new Map(); // node or put → the walk that saw it, or ON / OFF
    let walk = 0;
    for (const put of this.puts) {
      if (!put.moves) continue;
      const start = put.node ?? put;
      if (fate.has(start)) continue;
      walk++;
      const path = [];
      let at = start;
      while (at !== null && at !== UNKNOWN && !fate.has(at)) {
        fate.set(at, walk);
        path.push(at);
        at = this.#up(at);
      }
      let from = path.length;
      if (at !== null && at !== UNKNOWN && fate.get(at) === walk) {
        from = path.indexOf(at);
      }
      for (let i = 0; i < path.length; i++) {
        fate.set(path[i], i < from ? OFF : ON);
      }
    }
    for (const put of this.puts) {
      if (violations.has(put.index)) continue;
      if (fate.get(put.node ?? put) === ON) {
        violations.set(put.index, ['EINVAL']);
      }
    }
  }

  // EEXIST: two live children of one name under one parent. The violators
  // are the puts among them but the one that had the name and keeps it —
  // the puts that move or are new, as the one that stays is the keeper.
  #names(violations) {
    const groups = new Map(); // final parent → Map<name, put[]>
    for (const put of this.puts) {
      if (!put.moves || put.parent === null || put.parent === UNKNOWN) {
        continue;
      }
      let names = groups.get(put.parent);
      if (names === undefined) {
        names = new Map();
        groups.set(put.parent, names);
      }
      const group = names.get(put.name);
      if (group === undefined) names.set(put.name, [put]);
      else group.push(put);
    }
    for (const [parent, names] of groups) {
      for (const [name, group] of names) {
        const keeper = this.#keeper(parent, name);
        if (group.length + (keeper === null ? 0 : 1) < 2) continue;
        // `other` without a keeper: the violator of the lowest index but
        // this one — the first, or the second for the first itself.
        const [first, second] = group;
        for (const put of group) {
          if (violations.has(put.index)) continue;
          let other;
          if (keeper !== null) other = keeper.id;
          else other = (put === first ? second : first).id;
          violations.set(put.index, ['EEXIST', other]);
        }
      }
    }
  }

  // The node that holds `name` under `parent` now and keeps it: one the
  // commit does not name, or a node of a put that leaves it where it is.
  #keeper(parent, name) {
    if (parent instanceof Put || parent.kids === null) return null;
    const holder = parent.kids.get(name);
    if (holder === undefined) return null;
    const put = this.named.get(holder.id);
    if (put === undefined) return this.removed.has(holder) ? null : holder;
    return put.parent === parent && put.name === name ? put : null;
  }

  // The nodes that die with `node`: its subtree but for the nodes of puts
  // and what lies below them. Their published representations retire.
  #doom(node, dead) {
    const stack = [node];
    while (stack.length > 0) {
      const n = stack.pop();
      dead.push(n);
      const kinds = kindsOf(n.payload);
      if (kinds !== 0) this.#drop(n, kinds);
      if (n.kids === null) continue;
      for (const child of n.kids.values()) {
        if (!this.named.has(child.id)) stack.push(child);
      }
    }
  }

  #drop(node, kinds) {
    for (let kind = 0; kind < KINDS; kind++) {
      if ((kinds & (1 << kind)) === 0) continue;
      const rep = repOf(node.payload, kind);
      if (rep.length > 0) this.retired.push({ id: node.id, kind, rep });
    }
  }

  #write(dead) {
    const { log, puts } = this;
    for (const put of puts) {
      if (put.moves && put.node !== null) log.step(DETACH, put.node.id);
    }
    const doomed = new Set(dead);
    for (const node of this.removed) {
      const root = node.parent === null || !doomed.has(node.parent);
      if (root && doomed.has(node)) log.step(KILL, node.id);
    }
    for (const put of puts) {
      if (put.node === null) log.create(put.id, put.cls);
    }
    for (const put of puts) {
      if (!put.moves) continue;
      if (put.parentId === null) log.step(ROOT, put.id);
      else log.attach(put.id, put.parentId, put.name);
    }
    for (const put of puts) this.#own(put);
  }

  // A put's changes of the node itself: class, payload, policy.
  #own(put) {
    const { log } = this;
    const { node, payload, policy } = put;
    if (node === null) {
      if (payload !== undefined && payload !== null) {
        log.payload(put.id, payload, payload.birthtimeMs ?? payload.mtimeMs);
      }
      if (policy !== undefined && policy !== null) {
        log.setPolicy(put.id, policy);
      }
      return;
    }
    if (put.cls !== undefined && put.cls !== node.cls) {
      log.setClass(node.id, put.cls);
    }
    const before = node.payload;
    if (payload === null) {
      if (before !== null) {
        this.#drop(node, kindsOf(before));
        log.step(UNPUBLISH, node.id);
      }
    } else if (payload !== undefined) {
      if (before !== null) this.#drop(node, kindsOf(before));
      let birth = payload.birthtimeMs;
      if (birth === undefined) {
        const inherited = before === null ? undefined : before.birthtimeMs;
        birth = inherited === undefined ? payload.mtimeMs : inherited;
      }
      log.payload(node.id, payload, birth);
    }
    if (policy !== undefined && !Object.is(policy, node.policy)) {
      log.setPolicy(node.id, policy);
    }
  }
}

module.exports = {
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
  FILE,
  refusal,
  isClass,
  FsPlan,
  ClientPlan,
};
