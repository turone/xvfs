'use strict';

// Planning a commit: every check of `commit` and `load` runs here, against
// the tree as it stands and an overlay of what the commit has done so far;
// nothing of the tree changes. What passes becomes a log — the primitive
// steps main and every replica apply alike (lib/tree.js) — the list of
// what it retires, the extents it drops and the owners of what it
// places. A refusal throws and leaves only garbage behind.

const {
  SMALL,
  KINDS,
  PAGE_KINDS,
  column,
  repOf,
  kindsOf,
  F64,
  I32,
  U8,
  NUM,
} = require('./tree-node.js');

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
// The steps of a language but the main one, by its index (int) — an id tree
// of several languages only.
const LNAME = 10; // a translation's name, made or changed: id, lang, lname
const LDROP = 11; // the translation gone, its name and payload: id, lang
const LPAYLOAD = 12; // a translation's new payload: id, lang, its columns
const LUNPUBLISH = 13; // a translation without a payload: id, lang
const LRELOCATE = 14; // id, lang, kind, extent
// The page of a payload replaced — kind 1 and its compressed forms, some or
// none: id, lang (0 the main one), the kinds as a mask, their extents. A
// new payload with the commit's version; its source, attributes and extras
// are the replaced one's.
const RENDER = 15;

// `lang`: the index of the language a refusal is about, but the main one.
const refusal = (code, index, message, other, lang) => {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  err.index = index;
  if (other !== undefined) err.other = other;
  if (lang !== undefined && lang !== 0) err.lang = lang;
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

// A page of an id tree's payload: [[kind, extent], …] of the page's kinds
// (PAGE_KINDS), each once; [] for none.
const isPage = (page, segments) => {
  if (!Array.isArray(page)) return false;
  let seen = 0;
  for (let i = 0; i < page.length; i++) {
    const pair = page[i];
    if (!Array.isArray(pair) || pair.length !== 2) return false;
    const kind = pair[0];
    if (!isKind(kind) || (PAGE_KINDS & (1 << kind)) === 0) return false;
    if ((seen & (1 << kind)) !== 0 || !isExtent(pair[1], segments)) {
      return false;
    }
    seen |= 1 << kind;
  }
  return true;
};

// The kinds of a page, as a mask.
const pageMaskOf = (page) => {
  let mask = 0;
  for (let i = 0; i < page.length; i++) mask |= 1 << page[i][0];
  return mask;
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

// The payloads of a delta or a snapshot as columns: the attributes, the
// kinds a payload holds as a mask, the extents of its representations by
// ascending kind (a relocation's among them, in the order of the steps),
// the extras of those that have them. One reader takes both (lib/tree.js,
// #payloadOf); a delta's payloads take its one version, a snapshot's carry
// their own (`versions`).
class PayloadColumns {
  constructor(birthtime, versions) {
    this.birthtime = birthtime;
    this.ver = versions ? [] : null;
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
  }

  // A payload input, as a commit states it.
  input(input, birth) {
    this.#attributes(input.size, input.mtimeMs, birth);
    const { representations } = input;
    const mask = maskOf(input);
    this.kinds.push(mask);
    for (let kind = 0; kind < KINDS; kind++) {
      if ((mask & (1 << kind)) === 0) continue;
      for (let i = 0; i < representations.length; i++) {
        if (representations[i][0] === kind) this.extent(representations[i][1]);
      }
    }
    const { meta = null, scriptOptions = null } = input;
    if (input.meta !== undefined || input.scriptOptions !== undefined) {
      this.#extras(meta, scriptOptions);
    }
  }

  // A payload of the tree, as a snapshot holds it.
  payload(payload) {
    this.ver.push(payload.version);
    this.#attributes(payload.size, payload.mtimeMs, payload.birthtimeMs);
    const mask = kindsOf(payload);
    this.kinds.push(mask);
    for (let kind = 0; kind < KINDS; kind++) {
      if ((mask & (1 << kind)) !== 0) this.extent(repOf(payload, kind));
    }
    const { extras } = payload;
    if (extras !== null) this.#extras(extras.meta, extras.scriptOptions);
  }

  #attributes(size, mtime, birth) {
    this.size.push(size);
    this.mtime.push(mtime);
    if (this.birthtime) this.birth.push(birth);
  }

  #extras(meta, scriptOptions) {
    this.xi.push(this.kinds.length - 1);
    this.meta.push(meta);
    this.script.push(scriptOptions);
  }

  extent({ segmentId, offset, length }) {
    this.seg.push(segmentId);
    this.off.push(offset);
    this.len.push(length);
  }

  // The columns of a snapshot, each a typed array of its own.
  columns() {
    const out = {
      size: column(this.size),
      mtime: new Float64Array(this.mtime),
      birth: this.birthtime ? new Float64Array(this.birth) : null,
      kinds: new Uint8Array(this.kinds),
      seg: column(this.seg),
      off: column(this.off),
      len: column(this.len),
      xi: new Int32Array(this.xi),
      meta: this.meta,
      script: this.script,
    };
    if (this.ver !== null) out.pver = column(this.ver);
    return out;
  }

  // The columns of a delta, gathered into its Columns (lib/tree-node.js) to
  // be made with the rest in one buffer: the index of each in what
  // Columns.made() returns — birth -1 without birthtimes — and the extras
  // as they are.
  gather(set) {
    return {
      size: set.add(NUM, this.size),
      mtime: set.add(F64, this.mtime),
      birth: this.birthtime ? set.add(F64, this.birth) : -1,
      kinds: set.add(U8, this.kinds),
      seg: set.add(NUM, this.seg),
      off: set.add(NUM, this.off),
      len: set.add(NUM, this.len),
      xi: set.add(I32, this.xi),
      meta: this.meta,
      script: this.script,
    };
  }
}

// Steps and their arguments, packed by kind in the order they are taken.
class Log {
  constructor(birthtime) {
    this.op = [];
    this.id = [];
    this.parent = [];
    this.name = [];
    this.int = [];
    this.policy = [];
    this.lname = []; // the names of LNAME, in a column of their own
    this.payloads = new PayloadColumns(birthtime, false);
    this.changed = false; // anything but relocations
  }

  get empty() {
    return this.op.length === 0;
  }

  step(op, id) {
    this.op.push(op);
    this.id.push(id);
    if (op !== RELOCATE && op !== LRELOCATE) this.changed = true;
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
    this.payloads.input(input, birth);
  }

  relocate(id, kind, extent) {
    this.step(RELOCATE, id);
    this.int.push(kind);
    this.payloads.extent(extent);
  }

  setClass(id, cls) {
    this.step(CLASS, id);
    this.int.push(cls);
  }

  setPolicy(id, value) {
    this.step(POLICY, id);
    this.policy.push(value);
  }

  langName(id, lang, name) {
    this.step(LNAME, id);
    this.int.push(lang);
    this.lname.push(name);
  }

  langDrop(id, lang) {
    this.step(LDROP, id);
    this.int.push(lang);
  }

  langPayload(id, lang, input, birth) {
    this.step(LPAYLOAD, id);
    this.int.push(lang);
    this.payloads.input(input, birth);
  }

  langUnpublish(id, lang) {
    this.step(LUNPUBLISH, id);
    this.int.push(lang);
  }

  langRelocate(id, lang, kind, extent) {
    this.step(LRELOCATE, id);
    this.int.push(lang, kind);
    this.payloads.extent(extent);
  }

  // The page's extents in the order of their kinds, as a snapshot's are.
  render(id, lang, page) {
    this.step(RENDER, id);
    const mask = pageMaskOf(page);
    this.int.push(lang, mask);
    for (let kind = 0; kind < KINDS; kind++) {
      if ((mask & (1 << kind)) === 0) continue;
      for (let i = 0; i < page.length; i++) {
        if (page[i][0] === kind) this.payloads.extent(page[i][1]);
      }
    }
  }
}

// The entries of `stack` from `first` on, in the reverse order: a walk by a
// stack then takes the children of a node in their order — in pre-order, as
// walk() does.
const reversed = (stack, first) => {
  for (let i = first, j = stack.length - 1; i < j; i++, j--) {
    const top = stack[i];
    stack[i] = stack[j];
    stack[j] = top;
  }
};

// The non-empty representations of `given` ([[kind, extent]], or null) as
// what a commit placed with node `id`, into `out`.
const placedOf = (id, given, out) => {
  if (given === null) return;
  for (let i = 0; i < given.length; i++) {
    const [kind, extent] = given[i];
    if (extent.length > 0) out.push({ id, kind, extent });
  }
};

// --- FS trees ---------------------------------------------------------------

// A node an FS commit makes, until the log is applied: its children as the
// commit has them — a Map of its own, no overlay needed — and the state of
// its payload as #state keeps it for other nodes: kinds, kept (always none,
// nothing of it was published), given, birth.
class Fresh {
  constructor(id, cls) {
    this.id = id;
    this.cls = cls;
    this.kids = null;
    this.payload = null;
    this.kinds = 0;
    this.kept = 0;
    this.given = null;
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
    this.dropped = []; // extents given here and taken back here (#takeBack)
    this.over = new Map(); // node → { kids: Map<name, node|null>, count }
    this.dead = new Set();
    this.fresh = new Map(); // id → a placeholder of a node made here
    this.pay = new Map(); // node → { kinds, kept, given, birth, has, written }
    this.moved = new Map(); // a node of the tree → { parent, name } it ends at
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
  // kinds of the one published before that it still holds, the
  // representations the commit gave it that it holds — `[[kind, extent]]`,
  // null for none — and its birthtime. A fresh node is its own.
  #state(node) {
    if (node instanceof Fresh) return node;
    let state = this.pay.get(node);
    if (state === undefined) {
      const { payload } = node;
      const kinds = kindsOf(payload);
      const birth = payload === null ? 0 : payload.birthtimeMs;
      const has = payload !== null;
      const written = false;
      state = { kinds, kept: kinds, given: null, birth, has, written };
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

  // What the commit did to its nodes (commit's `changes`), `pathOf` keying
  // a node as the tree stands before the commit: the ids of the nodes it
  // made that live after it; of the nodes that lived before and live after
  // and got a payload of its ops; the nodes that lived before and live
  // after under another parent or name, keyed as before; and every node
  // of the state before that dies, keyed as before, with its class.
  changes(pathOf) {
    const created = [];
    for (const node of this.fresh.values()) {
      if (!this.dead.has(node)) created.push(node.id);
    }
    const changed = [];
    for (const [node, state] of this.pay) {
      if (state.written && !this.dead.has(node)) changed.push(node.id);
    }
    const moved = [];
    for (const [node, at] of this.moved) {
      if (this.dead.has(node)) continue;
      if (at.parent === node.parent && at.name === node.name) continue;
      moved.push({ id: node.id, from: pathOf(node) });
    }
    const removed = [];
    for (const node of this.dead) {
      if (node instanceof Fresh) continue;
      removed.push({ id: node.id, key: pathOf(node), cls: node.cls });
    }
    return { created, changed, moved, removed };
  }

  // What the commit gave and the state after holds — each representation
  // of a live node's `given` with a non-empty extent — as [{ id, kind,
  // extent }]: the owners after the commit, whatever keys its ops named.
  placed() {
    const out = [];
    for (const node of this.fresh.values()) {
      if (!this.dead.has(node)) placedOf(node.id, node.given, out);
    }
    for (const [node, state] of this.pay) {
      if (!this.dead.has(node)) placedOf(node.id, state.given, out);
    }
    return out;
  }

  // What the commit gave a node and takes back — written over, relocated
  // again or removed in the commit itself — of `kind`, or every kind for
  // -1: published to no one, nobody reads it; its non-empty extents are
  // dropped, the caller's to free. Returns the rest of `given`, or null.
  #takeBack(given, kind) {
    let rest = null;
    for (let i = 0; i < given.length; i++) {
      const pair = given[i];
      if (kind !== -1 && pair[0] !== kind) (rest ??= []).push(pair);
      else if (pair[1].length > 0) this.dropped.push(pair[1]);
    }
    return rest;
  }

  #payload(node, input) {
    const state = this.#state(node);
    if (state.kept !== 0) this.#drop(node, state.kept);
    if (state.given !== null) this.#takeBack(state.given, -1);
    let birth = input.birthtimeMs;
    if (birth === undefined) birth = state.has ? state.birth : input.mtimeMs;
    state.kinds = maskOf(input);
    state.kept = 0;
    state.given = input.representations;
    state.written = true;
    state.birth = birth;
    state.has = true;
    this.log.payload(node.id, input, birth);
  }

  // The node and its subtree as the commit has it so far: what dies, what
  // of it retires and what it drops. The one place that reads a node's
  // children through the overlay whole — the tree's Map, each name as the
  // overlay has it now (gone, replaced or as it was), then the names the
  // commit added.
  #kill(node) {
    const stack = [node];
    while (stack.length > 0) {
      const n = stack.pop();
      this.dead.add(n);
      this.count--;
      const state = n instanceof Fresh ? n : this.pay.get(n);
      const kept = state === undefined ? kindsOf(n.payload) : state.kept;
      if (kept !== 0) this.#drop(n, kept);
      if (state !== undefined && state.given !== null) {
        this.#takeBack(state.given, -1);
      }
      const first = stack.length;
      const over = this.over.get(n);
      const { kids } = n;
      if (kids !== null) {
        for (const [name, child] of kids) {
          const now = over === undefined ? undefined : over.kids.get(name);
          if (now === undefined) stack.push(child);
          else if (now !== null) stack.push(now);
        }
      }
      if (over !== undefined) {
        for (const [name, child] of over.kids) {
          if (child !== null && (kids === null || !kids.has(name))) {
            stack.push(child);
          }
        }
      }
      reversed(stack, first);
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
    if (!(node instanceof Fresh)) this.moved.set(node, { parent, name });
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
    const { given } = state;
    const rest = given === null ? null : this.#takeBack(given, kind);
    if (rest === null) state.given = [[kind, extent]];
    else {
      rest.push([kind, extent]);
      state.given = rest;
    }
    this.log.relocate(id, kind, extent);
  }
}

// --- Id trees -----------------------------------------------------------------

// A put of a commit or a row of a load: what it states. `node` is the
// tree's node of its id, if any; `parent` its final parent once known — a
// node of the tree, a put of a new id, null for the root, or UNKNOWN;
// `moves` whether it is new or leaves its place. `page` the main
// language's page, undefined to keep it; `tr` null, or a Map of the
// languages it states but the main one, by index, to what it states there:
// null for no translation, or { name, payload, page }, each undefined to
// keep it.
class Put {
  constructor(index, id, parentId, name, cls, payload, policy, page, tr, node) {
    this.index = index;
    this.id = id;
    this.parentId = parentId;
    this.name = name;
    this.cls = cls;
    this.payload = payload;
    this.policy = policy;
    this.page = page;
    this.tr = tr;
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
// The other refusals of the final state, ENOENT in a language.
const NO_PAYLOAD = 'a page without the payload it renders';
const NO_NAME = 'a translation without a name';

const UNKNOWN = Symbol('unknown parent');
const ON = -1; // on a cycle
const OFF = -2; // on no cycle

// The translation of `node` in language `lang` (from 1), or null.
const translationOf = (node, lang) => {
  if (node === null || node.tr === null) return null;
  return node.tr[lang - 1];
};

// The payload of `node` in language `lang` (0 the main one), or null.
const payloadIn = (node, lang) => {
  if (lang === 0) return node.payload;
  const t = translationOf(node, lang);
  return t === null ? null : t.payload;
};

// Whether what a put states of a language holds data or a page: what a
// translation it does not have cannot take without a name.
const states = (said) =>
  (said.payload !== undefined && said.payload !== null) ||
  (said.page !== undefined && said.page.length > 0);

// A commit states a final state: the first group of checks runs in the order
// of the ops, then the final state is built from the whole set and checked —
// before anything is logged. The log takes the nodes that leave or move out
// first, then the creations, the names of the moving nodes in the other
// languages, the attachments by ascending index, then the changes of the
// nodes themselves: no apply holds more than the final count of nodes on
// the way. No closures: what a commit names lives in the plan's fields and
// dies with the plan.
class IdPlan {
  constructor(tree) {
    this.root = tree.root;
    this.byId = tree.byId;
    this.count = tree.byId.size;
    this.maxNodes = tree.maxNodes;
    this.segments = tree.segments;
    this.strings = tree.mode === 'string';
    this.languages = tree.languages;
    this.log = new Log(tree.birthtime);
    this.retired = [];
    // An id tree's commit names each id once: nothing it gives a node is
    // taken back in it, and what it gives stays where its put or relocation
    // names it.
    this.dropped = [];
    this.given = []; // [{ id, kind, extent, lang? }], placed()
    this.doomed = []; // the nodes of the tree that die (#final)
    this.changed = []; // the ids of the nodes of the tree whose payload changes
    this.puts = []; // in the order of their index
    this.named = new Map(); // id → its put
    this.removed = new Set(); // nodes that die by name
    this.alive = new Map(); // node → whether it lives after
    this.kind = null; // 'change', 'relocate' or 'render': the first op's
  }

  isId(id) {
    return this.strings ? typeof id === 'string' : Number.isSafeInteger(id);
  }

  #isLang(lang) {
    return Number.isInteger(lang) && lang >= 0 && lang < this.languages;
  }

  // The format of a put or a row: EINVAL at `index`, in any order. A page
  // comes without a payload: the page of new data is among its
  // representations.
  #format(index, id, parentId, name, cls, payload, page) {
    const data = payload !== undefined && payload !== null;
    const bad =
      !this.isId(id) ||
      (parentId !== null && !this.isId(parentId)) ||
      (parentId === null ? name !== '' : !isName(name)) ||
      (cls !== undefined && !isClass(cls)) ||
      (data && !isPayload(payload, this.segments)) ||
      (page !== undefined && (data || !isPage(page, this.segments)));
    if (bad) throw refusal('EINVAL', index, 'the format of a put or a row');
  }

  // What a put or a row states of the languages but the main one, from
  // [[lang, null | { name, payload, page }], …]: null for nothing, else the
  // Map of Put.tr. Each language once; the root's name is '' in all.
  #translations(index, list, root) {
    if (list === undefined) return null;
    if (this.languages === 1 || !Array.isArray(list)) {
      throw refusal('EINVAL', index, 'translations');
    }
    const tr = new Map();
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      const pair = Array.isArray(entry) && entry.length === 2;
      const lang = pair ? entry[0] : -1;
      if (lang === 0 || !this.#isLang(lang) || tr.has(lang)) {
        throw refusal('EINVAL', index, 'translations: a language');
      }
      const said = entry[1];
      if (said !== null && !this.#isTranslation(said, root)) {
        throw refusal('EINVAL', index, 'a translation', undefined, lang);
      }
      tr.set(lang, said);
    }
    return tr;
  }

  #isTranslation(said, root) {
    if (typeof said !== 'object') return false;
    const { name, payload, page } = said;
    if (name !== undefined && !(root ? name === '' : isName(name))) {
      return false;
    }
    const data = payload !== undefined && payload !== null;
    if (data && !isPayload(payload, this.segments)) return false;
    return page === undefined || (!data && isPage(page, this.segments));
  }

  #once(index, id, seen) {
    if (seen.has(id)) throw refusal('EINVAL', index, `id ${id} named twice`);
    seen.add(id);
  }

  // A relocation names each representation of a node once — a node may
  // have several in the segment a compaction empties — and a render each
  // of its languages: `at` the one it names.
  #onceIn(index, id, at, seen) {
    let named = seen.get(id);
    if (named === undefined) seen.set(id, (named = new Set()));
    if (named.has(at)) throw refusal('EINVAL', index, `id ${id} named twice`);
    named.add(at);
  }

  #kindOf(index, kind) {
    if (this.kind === null) this.kind = kind;
    else if (this.kind !== kind) {
      throw refusal('EINVAL', index, `${kind} together with other ops`);
    }
  }

  commit(ops) {
    const seen = new Set();
    const named = new Map(); // id → what its relocations or renders named
    let rootId = this.root === null ? null : this.root.id;
    const relocations = [];
    const renders = [];
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
        const { class: cls, payload, policy, page, translations } = fields;
        this.#format(index, id, parentId, name, cls, payload, page);
        const tr = this.#translations(index, translations, parentId === null);
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
        this.#put(index, id, parentId, name, cls, payload, policy, page, tr);
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
        const [, , kind, extent, lang = 0] = op;
        const shaped = op.length === 4 || op.length === 5;
        if (!shaped || !this.isId(id) || !isKind(kind) || !this.#isLang(lang)) {
          throw refusal('EINVAL', index, 'relocate');
        }
        if (!isExtent(extent, this.segments)) {
          throw refusal('EINVAL', index, 'relocate: an extent');
        }
        this.#onceIn(index, id, lang * KINDS + kind, named);
        this.#kindOf(index, 'relocate');
        const node = this.byId.get(id) ?? null;
        if (node === null) throw refusal('ENOENT', index, `no node ${id}`);
        const rep = repOf(payloadIn(node, lang), kind);
        if (rep === null) {
          const message = `node ${id} has no representation ${kind}`;
          throw refusal('ENOENT', index, message, undefined, lang);
        }
        relocations.push({ id, kind, extent, rep, lang });
      } else if (what === 'render') {
        const [, , lang, page] = op;
        if (op.length !== 4 || !this.isId(id) || !this.#isLang(lang)) {
          throw refusal('EINVAL', index, 'render');
        }
        if (!isPage(page, this.segments)) {
          throw refusal('EINVAL', index, 'render: a page');
        }
        this.#onceIn(index, id, lang, named);
        this.#kindOf(index, 'render');
        const node = this.byId.get(id) ?? null;
        if (node === null) throw refusal('ENOENT', index, `no node ${id}`);
        const payload = payloadIn(node, lang);
        if (payload === null && page.length > 0) {
          throw refusal('ENOENT', index, NO_PAYLOAD, undefined, lang);
        }
        renders.push({ id, lang, payload, page });
      } else {
        throw refusal('EINVAL', index, `an unknown op ${what}`);
      }
    }
    if (this.kind === 'relocate') {
      for (const { id, kind, extent, rep, lang } of relocations) {
        if (rep.length > 0) this.#retire(id, kind, rep, lang);
        if (extent.length > 0) this.#placed(id, kind, extent, lang);
        if (lang === 0) this.log.relocate(id, kind, extent);
        else this.log.langRelocate(id, lang, kind, extent);
      }
      return this;
    }
    if (this.kind === 'render') {
      const changed = new Set();
      for (const { id, lang, payload, page } of renders) {
        if (this.#render(id, lang, payload, page)) changed.add(id);
      }
      this.changed = [...changed];
      return this;
    }
    return this.#final();
  }

  load(rows) {
    const seen = new Set();
    let rooted = false;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (row === null || typeof row !== 'object') {
        throw refusal('EINVAL', index, 'not a row');
      }
      const { id, parentId, name, class: cls, payload, policy, page } = row;
      this.#format(index, id, parentId, name, cls, payload, page);
      const tr = this.#translations(index, row.translations, parentId === null);
      this.#once(index, id, seen);
      // One root, as in a commit; which node it is the rows say.
      if (parentId === null) {
        if (rooted) throw refusal('EEXIST', index, 'a second root');
        rooted = true;
      }
      this.#put(index, id, parentId, name, cls, payload, policy, page, tr);
    }
    for (const node of this.byId.values()) {
      if (!this.named.has(node.id)) this.removed.add(node);
    }
    return this.#final();
  }

  #put(index, id, parentId, name, cls, payload, policy, page, tr) {
    const node = this.byId.get(id) ?? null;
    if (node === null && cls === undefined) {
      throw refusal('EINVAL', index, `no class for a new id ${id}`);
    }
    const put = new Put(
      index,
      id,
      parentId,
      name,
      cls,
      payload,
      policy,
      page,
      tr,
      node,
    );
    this.puts.push(put);
    this.named.set(id, put);
  }

  // The final state checked, then logged. A cycle has a node that moves,
  // and so has a name taken twice: those checks start from the puts that
  // move or are new, or take another name, and a load that moves nothing
  // costs no more than its rows.
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
    const violations = new Map(); // index → [code, other?, lang?, message?]
    for (const put of puts) {
      if (put.parentId === null) continue;
      if (put.parent === UNKNOWN || !this.#lives(put.parent)) {
        violations.set(put.index, ['ENOENT']);
      }
    }
    this.#cycles(violations);
    this.#names(violations);
    if (this.languages > 1) this.#langNames(violations);
    this.#stated(violations);
    if (violations.size > 0) {
      let index = Infinity;
      for (const at of violations.keys()) if (at < index) index = at;
      const [code, other, lang, message] = violations.get(index);
      throw refusal(code, index, message ?? VIOLATIONS[code], other, lang);
    }
    // What dies: the subtrees of the removed nodes but for the nodes of
    // puts, which live wherever they go, and what lies below them.
    const dead = [];
    for (const node of this.removed) {
      if (node.parent === null || this.#lives(node.parent)) {
        this.#doom(node, dead);
      }
    }
    this.doomed = dead;
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
      this.#group(groups, put, put.name);
    }
    this.#taken(groups, 0, violations);
  }

  // The same in the languages but the main one, by ascending index, with
  // the names the children have there. A put is in the check of a language
  // where its node is new, moves to another parent — its names go with it
  // — or takes another name.
  #langNames(violations) {
    const byLang = []; // lang − 1 → the groups of #names, or none
    for (const put of this.puts) {
      const { parent, node, tr } = put;
      if (parent === null || parent === UNKNOWN) continue;
      const away = node === null || node.parent !== parent;
      if (away && node !== null && node.tr !== null) {
        for (let lang = 1; lang < this.languages; lang++) {
          if (node.tr[lang - 1] === null || (tr !== null && tr.has(lang))) {
            continue;
          }
          this.#groupIn(byLang, put, lang, this.#nameIn(put, lang));
        }
      }
      if (tr === null) continue;
      for (const lang of tr.keys()) {
        const name = this.#nameIn(put, lang);
        if (!away) {
          const t = translationOf(node, lang);
          if (t !== null && t.name === name) continue;
        }
        this.#groupIn(byLang, put, lang, name);
      }
    }
    for (let i = 0; i < byLang.length; i++) {
      if (byLang[i] !== undefined) this.#taken(byLang[i], i + 1, violations);
    }
  }

  #groupIn(byLang, put, lang, name) {
    if (name === null) return;
    this.#group((byLang[lang - 1] ??= new Map()), put, name);
  }

  #group(groups, put, name) {
    let names = groups.get(put.parent);
    if (names === undefined) {
      names = new Map();
      groups.set(put.parent, names);
    }
    const group = names.get(name);
    if (group === undefined) names.set(name, [put]);
    else group.push(put);
  }

  #taken(groups, lang, violations) {
    for (const [parent, names] of groups) {
      for (const [name, group] of names) {
        const keeper = this.#keeper(parent, name, lang);
        if (group.length + (keeper === null ? 0 : 1) < 2) continue;
        // `other` without a keeper: the violator of the lowest index but
        // this one — the first, or the second for the first itself.
        const [first, second] = group;
        for (const put of group) {
          if (violations.has(put.index)) continue;
          let other;
          if (keeper !== null) other = keeper.id;
          else other = (put === first ? second : first).id;
          violations.set(put.index, ['EEXIST', other, lang]);
        }
      }
    }
  }

  // The name a put's node has in language `lang` (from 1) after the
  // commit, or null: the one the put states, else the one it has. The
  // root's is '' — a node that becomes the root takes it, one that leaves
  // the root has none — and the root has a translation it states data of.
  #nameIn(put, lang) {
    const said = put.tr === null ? undefined : put.tr.get(lang);
    if (said === null) return null;
    if (said !== undefined && said.name !== undefined) return said.name;
    const t = translationOf(put.node, lang);
    const root = put.parentId === null;
    if (t === null) {
      return root && said !== undefined && states(said) ? '' : null;
    }
    if (root) return '';
    return t.name === '' ? null : t.name;
  }

  // The node that holds `name` under `parent` in language `lang` (0 the
  // main one) and keeps it: one the commit does not name, or a node of a
  // put that leaves it where it is, under that name.
  #keeper(parent, name, lang) {
    if (parent instanceof Put || parent.kids === null) return null;
    let holder;
    if (lang === 0) {
      holder = parent.kids.get(name);
    } else {
      const { alt } = parent.kids;
      const names = alt === null ? null : alt[lang - 1];
      holder = names === null ? undefined : names.get(name);
    }
    if (holder === undefined) return null;
    const put = this.named.get(holder.id);
    if (put === undefined) return this.removed.has(holder) ? null : holder;
    if (put.parent !== parent) return null;
    const after = lang === 0 ? put.name : this.#nameIn(put, lang);
    return after === name ? put : null;
  }

  // ENOENT, in a language, for what the final state cannot hold: a page
  // where the node will have no payload to render, a translation with data
  // or a page but no name.
  #stated(violations) {
    for (const put of this.puts) {
      if (violations.has(put.index)) continue;
      const violation = this.#unstated(put);
      if (violation !== null) violations.set(put.index, violation);
    }
  }

  #unstated(put) {
    const { node, page, tr } = put;
    if (page !== undefined && page.length > 0) {
      if (put.payload === null || node === null || node.payload === null) {
        return ['ENOENT', undefined, 0, NO_PAYLOAD];
      }
    }
    if (tr !== null) {
      for (const [lang, said] of tr) {
        if (said === null) continue;
        const t = translationOf(node, lang);
        if ((t !== null || states(said)) && this.#nameIn(put, lang) === null) {
          return ['ENOENT', undefined, lang, NO_NAME];
        }
        if (said.page !== undefined && said.page.length > 0) {
          if (said.payload === null || t === null || t.payload === null) {
            return ['ENOENT', undefined, lang, NO_PAYLOAD];
          }
        }
      }
    }
    // The root moved under a parent: '' is no name there.
    if (put.parentId !== null && node !== null && node.parent === null) {
      for (let lang = 1; lang < this.languages; lang++) {
        if (translationOf(node, lang) === null) continue;
        if (tr === null || !tr.has(lang)) {
          return ['ENOENT', undefined, lang, NO_NAME];
        }
      }
    }
    return null;
  }

  // The nodes that die with `node`: its subtree but for the nodes of puts
  // and what lies below them. Their published representations retire, in
  // every language.
  #doom(node, dead) {
    const stack = [node];
    while (stack.length > 0) {
      const n = stack.pop();
      dead.push(n);
      if (n.payload !== null) this.#drop(n.id, n.payload, 0);
      if (this.languages > 1 && n.tr !== null) {
        for (let lang = 1; lang < this.languages; lang++) {
          const t = n.tr[lang - 1];
          if (t !== null && t.payload !== null) {
            this.#drop(n.id, t.payload, lang);
          }
        }
      }
      if (n.kids === null) continue;
      const first = stack.length;
      for (const child of n.kids.values()) {
        if (!this.named.has(child.id)) stack.push(child);
      }
      reversed(stack, first);
    }
  }

  // The representations of `payload` retire, those of `mask` only when
  // given.
  #drop(id, payload, lang, mask = -1) {
    const kinds = kindsOf(payload) & mask;
    for (let kind = 0; kind < KINDS; kind++) {
      if ((kinds & (1 << kind)) === 0) continue;
      const rep = repOf(payload, kind);
      if (rep.length > 0) this.#retire(id, kind, rep, lang);
    }
  }

  // What a commit of a tree of one language retires and places names no
  // language, as before languages.
  #retire(id, kind, rep, lang) {
    if (this.languages === 1) this.retired.push({ id, kind, rep });
    else this.retired.push({ id, kind, rep, lang });
  }

  #placed(id, kind, extent, lang) {
    if (this.languages === 1) this.given.push({ id, kind, extent });
    else this.given.push({ id, kind, extent, lang });
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
    // A node that moves takes its names in the other languages while it is
    // out of every list: its attachment lists it under them, and no name it
    // leaves behind is taken from another on the way.
    if (this.languages > 1) {
      for (const put of puts) if (put.moves) this.#rename(put);
    }
    for (const put of puts) {
      if (!put.moves) continue;
      if (put.parentId === null) log.step(ROOT, put.id);
      else log.attach(put.id, put.parentId, put.name);
    }
    for (const put of puts) this.#own(put);
  }

  // What the commit placed: the representations of its puts and
  // relocations, with their ids.
  placed() {
    return this.given;
  }

  // What the commit did to its nodes (commit's `changes`, as FsPlan's):
  // the puts of new ids; the nodes whose payload changes in any language;
  // the nodes of puts that move, keyed as before; the nodes that die.
  changes(pathOf) {
    const created = [];
    const moved = [];
    for (const put of this.puts) {
      if (put.node === null) created.push(put.id);
      else if (put.moves) moved.push({ id: put.id, from: pathOf(put.node) });
    }
    const removed = [];
    for (const node of this.doomed) {
      removed.push({ id: node.id, key: pathOf(node), cls: node.cls });
    }
    return { created, changed: this.changed, moved, removed };
  }

  #give(id, given, lang) {
    for (let i = 0; i < given.length; i++) {
      const [kind, extent] = given[i];
      if (extent.length > 0) this.#placed(id, kind, extent, lang);
    }
  }

  // A put's changes of the node itself: class, payload, policy, page, then
  // what it states of the other languages.
  #own(put) {
    const { log } = this;
    const { node, payload, policy, tr } = put;
    if (node === null) {
      if (payload !== undefined && payload !== null) {
        log.payload(put.id, payload, payload.birthtimeMs ?? payload.mtimeMs);
        this.#give(put.id, payload.representations, 0);
      }
      if (policy !== undefined && policy !== null) {
        log.setPolicy(put.id, policy);
      }
      if (tr !== null) this.#translate(put);
      return;
    }
    if (put.cls !== undefined && put.cls !== node.cls) {
      log.setClass(node.id, put.cls);
    }
    const before = node.payload;
    let changed = false;
    if (payload === null) {
      if (before !== null) {
        this.#drop(node.id, before, 0);
        log.step(UNPUBLISH, node.id);
        changed = true;
      }
    } else if (payload !== undefined) {
      if (before !== null) this.#drop(node.id, before, 0);
      log.payload(node.id, payload, this.#birth(payload, before));
      this.#give(node.id, payload.representations, 0);
      changed = true;
    } else if (put.page !== undefined) {
      changed = this.#render(node.id, 0, before, put.page);
    }
    if (policy !== undefined && !Object.is(policy, node.policy)) {
      log.setPolicy(node.id, policy);
    }
    if (this.languages > 1) {
      if (!put.moves) this.#rename(put);
      if (tr !== null && this.#translate(put)) changed = true;
    }
    if (changed) this.changed.push(node.id);
  }

  // A new payload's birth: its own, else the one of the payload it
  // replaces, else its mtime.
  #birth(payload, before) {
    if (payload.birthtimeMs !== undefined) return payload.birthtimeMs;
    const inherited = before === null ? undefined : before.birthtimeMs;
    return inherited === undefined ? payload.mtimeMs : inherited;
  }

  // A page of the payload `before` in language `lang`: the kinds of its
  // page it had retire. No page where there was none is nothing. Whether
  // a step was logged.
  #render(id, lang, before, page) {
    const had = kindsOf(before) & PAGE_KINDS;
    if (page.length === 0 && had === 0) return false;
    if (had !== 0) this.#drop(id, before, lang, PAGE_KINDS);
    this.log.render(id, lang, page);
    this.#give(id, page, lang);
    return true;
  }

  // The names a put gives its node in the other languages, a translation
  // it drops with its payload — and '' in every language for a node that
  // becomes the root.
  #rename(put) {
    const { log } = this;
    const { id, node, tr } = put;
    if (tr !== null) {
      for (const [lang, said] of tr) {
        const t = translationOf(node, lang);
        if (said === null) {
          if (t === null) continue;
          if (t.payload !== null) this.#drop(id, t.payload, lang);
          log.langDrop(id, lang);
          continue;
        }
        const name = this.#nameIn(put, lang);
        if (name !== null && (t === null || t.name !== name)) {
          log.langName(id, lang, name);
        }
      }
    }
    if (put.parentId !== null || node === null || node.parent === null) return;
    if (node.tr === null) return;
    for (let lang = 1; lang < this.languages; lang++) {
      const t = node.tr[lang - 1];
      if (t === null || t.name === '' || (tr !== null && tr.has(lang))) {
        continue;
      }
      log.langName(id, lang, '');
    }
  }

  // The payloads and pages a put gives its node in the other languages,
  // where it has a translation after #rename. Whether one changed.
  #translate(put) {
    const { log } = this;
    const { id, node } = put;
    let changed = false;
    for (const [lang, said] of put.tr) {
      const t = translationOf(node, lang);
      const before = t === null ? null : t.payload;
      if (said === null) {
        if (before !== null) changed = true; // #rename dropped it
        continue;
      }
      if (this.#nameIn(put, lang) === null) continue;
      const { payload, page } = said;
      if (payload === null) {
        if (before === null) continue;
        this.#drop(id, before, lang);
        log.langUnpublish(id, lang);
      } else if (payload !== undefined) {
        if (before !== null) this.#drop(id, before, lang);
        log.langPayload(id, lang, payload, this.#birth(payload, before));
        this.#give(id, payload.representations, lang);
      } else if (page === undefined || !this.#render(id, lang, before, page)) {
        continue;
      }
      changed = true;
    }
    return changed;
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
  LNAME,
  LDROP,
  LPAYLOAD,
  LUNPUBLISH,
  LRELOCATE,
  RENDER,
  DIR,
  FILE,
  refusal,
  isClass,
  isName,
  isPage,
  PayloadColumns,
  Log,
  FsPlan,
  IdPlan,
};
