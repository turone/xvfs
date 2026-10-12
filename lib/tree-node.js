'use strict';

// The objects a tree hands out — nodes, payloads, representations — and the
// numbers they are built from. Fields only: the tree's operations read them.

// A small integer of any build lies in [-SMALL, SMALL): V8 with pointer
// compression keeps exactly these unboxed.
const SMALL = 2 ** 30;

// Kinds of representation: 0 the source, 1…6 the fields of `others`.
const KINDS = 7;
const OTHERS = [
  'requireBytecode',
  'scriptBytecode',
  'gzip',
  'deflate',
  'br',
  'zstd',
];

const EMPTY = Buffer.alloc(0);

// Whether every value is a small integer of any build.
const small = (values) => {
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!(v >= -SMALL && v < SMALL && Math.floor(v) === v)) return false;
  }
  return true;
};

// A numeric column of a snapshot or a delta: an Int32Array while every
// value is a small integer of any build, else a Float64Array.
const column = (values) =>
  small(values) ? new Int32Array(values) : new Float64Array(values);

// The types of a column of Columns, by width: 8, 4 and 1 bytes.
const F64 = 0;
const I32 = 1;
const U8 = 2;
const NUM = 3; // I32 while every value is small (column), else F64
const WIDTH = [8, 4, 1];

// The typed columns of one delta, gathered one by one and made at once:
// every one a view of its own type over one ArrayBuffer, so that a port
// clones one buffer for them all, not one a column. The 8-byte columns
// come first, then the 4- and the 1-byte ones: every view is aligned.
// add() gives a column's index in what made() returns.
class Columns {
  #types = [];
  #values = [];

  add(type, values) {
    let as = type;
    if (type === NUM) as = small(values) ? I32 : F64;
    this.#types.push(as);
    return this.#values.push(values) - 1;
  }

  made() {
    const types = this.#types;
    const values = this.#values;
    const n = types.length;
    const at = new Array(n);
    let size = 0;
    for (let type = F64; type <= U8; type++) {
      for (let i = 0; i < n; i++) {
        if (types[i] !== type) continue;
        at[i] = size;
        size += WIDTH[type] * values[i].length;
      }
    }
    const buffer = new ArrayBuffer(size);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const list = values[i];
      const type = types[i];
      // A copy loop of each type of its own: one store site, one kind of
      // array.
      if (type === F64) {
        const view = new Float64Array(buffer, at[i], list.length);
        for (let j = 0; j < list.length; j++) view[j] = list[j];
        out[i] = view;
      } else if (type === I32) {
        const view = new Int32Array(buffer, at[i], list.length);
        for (let j = 0; j < list.length; j++) view[j] = list[j];
        out[i] = view;
      } else {
        const view = new Uint8Array(buffer, at[i], list.length);
        for (let j = 0; j < list.length; j++) view[j] = list[j];
        out[i] = view;
      }
    }
    return out;
  }
}

// One extent of one representation. `data` is made on its first access and
// kept with the representation: the object never changes — a new version
// or a relocation is a new one — so its view cannot go stale, and a thread
// pays a view only for what it has read. Its identity is the object's,
// never the view's. TREE_VIEWS=eager (a flag of the measurements) makes the
// view at construction instead.
class Representation {
  #sab;
  #view = null;

  constructor(kind, segmentId, offset, length, sab) {
    this.kind = kind;
    this.segmentId = segmentId;
    this.offset = offset;
    this.length = length;
    this.#sab = sab;
  }

  get data() {
    if (this.length === 0) return EMPTY;
    return (this.#view ??= Buffer.from(this.#sab, this.offset, this.length));
  }
}

class EagerRepresentation {
  constructor(kind, segmentId, offset, length, sab) {
    this.kind = kind;
    this.segmentId = segmentId;
    this.offset = offset;
    this.length = length;
    this.data = length === 0 ? EMPTY : Buffer.from(sab, offset, length);
  }
}

const Rep =
  process.env.TREE_VIEWS === 'eager' ? EagerRepresentation : Representation;

// Every field in one order, so that all `others` share one hidden class.
class Others {
  constructor(requireBytecode, scriptBytecode, gzip, deflate, br, zstd) {
    this.requireBytecode = requireBytecode;
    this.scriptBytecode = scriptBytecode;
    this.gzip = gzip;
    this.deflate = deflate;
    this.br = br;
    this.zstd = zstd;
  }
}

// A value of the caller's a tree keeps — a policy, a payload's meta and
// scriptOptions — frozen at every depth, as the main tree's caller froze it
// (the pipeline, the intake): a replica freezes the clone it takes from a
// snapshot or a delta, so that no thread's copy changes under the others.
const frozen = (value) => {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const field of Object.values(value)) frozen(field);
  return value;
};

class Extras {
  constructor(meta, scriptOptions) {
    this.meta = meta;
    this.scriptOptions = scriptOptions;
  }
}

// Two shapes: birthtimeMs exists only in a tree created with `birthtime`.
class Payload {
  constructor(version, size, mtimeMs, source, others, extras) {
    this.version = version;
    this.size = size;
    this.mtimeMs = mtimeMs;
    this.source = source;
    this.others = others;
    this.extras = extras;
  }
}

class BirthPayload {
  constructor(version, size, mtimeMs, birthtimeMs, source, others, extras) {
    this.version = version;
    this.size = size;
    this.mtimeMs = mtimeMs;
    this.birthtimeMs = birthtimeMs;
    this.source = source;
    this.others = others;
    this.extras = extras;
  }
}

// A node. `name === null` marks a dead one: every read answers for it as
// for a missing node without a check of its own. `kids` is the Map of
// children, created with the first and dropped with the last. Optional
// fields make shapes of their own, so that a tree without them keeps none:
// `policy` (id trees), `ver` (subtree versions).
class Node {
  constructor(id, cls) {
    this.id = id;
    this.name = null;
    this.parent = null;
    this.kids = null;
    this.payload = null;
    this.cls = cls;
  }
}

class VersionedNode extends Node {
  constructor(id, cls) {
    super(id, cls);
    this.ver = 0;
  }
}

class PolicyNode extends Node {
  constructor(id, cls) {
    super(id, cls);
    this.policy = null;
  }
}

class VersionedPolicyNode extends PolicyNode {
  constructor(id, cls) {
    super(id, cls);
    this.ver = 0;
  }
}

const nodeClass = (policies, versions) => {
  if (policies) return versions ? VersionedPolicyNode : PolicyNode;
  return versions ? VersionedNode : Node;
};

// The children of a node with class counters on: [class, count, …] for its
// whole subtree, living and dying with the Map.
class CountedKids extends Map {
  constructor() {
    super();
    this.counts = [];
  }
}

// One number in a field must not change how the same field is stored in
// the other objects of its class: a double where V8 saw only small integers
// would migrate them all to boxed doubles. Objects holding null first, then
// a small integer, then a double make every numeric field tagged before any
// real object exists. Whoever makes them keeps them (the Tree class does):
// once they are collected the GC drops their maps and the tagging with
// them — a top-level const no function reads dies with the module's run.
const primers = () => {
  const list = [];
  for (const value of [null, 1, 1.5]) {
    const eager = new EagerRepresentation(1, value, value, 0, null);
    eager.length = value;
    list.push(
      new Representation(1, value, value, value, null),
      eager,
      new Payload(value, value, value, null, null, null),
      new BirthPayload(value, value, value, value, null, null, null),
    );
    for (const C of [Node, VersionedNode, PolicyNode, VersionedPolicyNode]) {
      const node = new C(value, 0);
      if (node.ver !== undefined) node.ver = value;
      list.push(node);
    }
  }
  return list;
};

// The representation of `kind` in a payload, or null.
const repOf = (payload, kind) => {
  if (payload === null) return null;
  if (kind === 0) return payload.source;
  const { others } = payload;
  return others === null ? null : others[OTHERS[kind - 1]];
};

// The kinds a payload holds, as a bit mask.
const kindsOf = (payload) => {
  if (payload === null) return 0;
  let mask = payload.source === null ? 0 : 1;
  const { others } = payload;
  if (others === null) return mask;
  for (let k = 1; k < KINDS; k++) {
    if (others[OTHERS[k - 1]] !== null) mask |= 1 << k;
  }
  return mask;
};

module.exports = {
  SMALL,
  KINDS,
  OTHERS,
  EMPTY,
  column,
  Columns,
  F64,
  I32,
  U8,
  NUM,
  Rep,
  Others,
  Extras,
  frozen,
  Payload,
  BirthPayload,
  CountedKids,
  nodeClass,
  repOf,
  kindsOf,
  primers,
};
