'use strict';

// Data for the tree engine's stand: pooled segments, extents, payload inputs,
// names and a seeded generator — shared by the model test, the large test,
// the retention test and the bench. Segments are created once and never
// dropped, as the xvfs pool does.

const SEGMENT = 1 << 20;

// Map<segmentId, SharedArrayBuffer>: ids from 1; 0 is the empty extent's.
const createSegments = (count = 2, size = SEGMENT) => {
  const segments = new Map();
  for (let id = 1; id <= count; id++)
    segments.set(id, new SharedArrayBuffer(size));
  return segments;
};

// Distinct extents, round-robin over the segments: a new representation's
// extent is never one that is published (the kernel's allocator guarantees
// it), and wrapping only after a whole segment's worth keeps that true for
// the trees a test builds.
class Extents {
  #segments;
  #ids;
  #offsets;
  #at = 0;

  constructor(segments) {
    this.#segments = segments;
    this.#ids = [...segments.keys()];
    this.#offsets = new Map(this.#ids.map((id) => [id, 0]));
  }

  next(length = 16) {
    const segmentId = this.#ids[this.#at++ % this.#ids.length];
    const size = this.#segments.get(segmentId).byteLength;
    let offset = this.#offsets.get(segmentId);
    if (offset + length > size) offset = 0;
    this.#offsets.set(segmentId, offset + length);
    return { segmentId, offset, length };
  }
}

const emptyExtent = () => ({ segmentId: 0, offset: 0, length: 0 });

// The kinds: 0 source, 1 require:bytecode, 2 script:bytecode, 3 fs:gzip,
// 4 fs:deflate, 5 fs:br, 6 fs:zstd.
const KIND = {
  source: 0,
  requireBytecode: 1,
  scriptBytecode: 2,
  gzip: 3,
  deflate: 4,
  br: 5,
  zstd: 6,
};

// A seeded generator (mulberry32) with helpers.
const rng = (seed) => {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (n) => Math.floor(next() * n);
  next.pick = (array) => array[Math.floor(next() * array.length)];
  next.chance = (p) => next() < p;
  next.shuffle = (array) => {
    const out = array.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  return next;
};

// A payload input: { size, mtimeMs, birthtimeMs?, meta?, scriptOptions?,
// representations: [[kind, extent], …] }.
const payloadOf = (random, extents, options = {}) => {
  const kinds = [KIND.source];
  if (options.noSource && random.chance(0.5)) kinds.length = 0;
  for (const k of [
    KIND.br,
    KIND.gzip,
    KIND.requireBytecode,
    KIND.scriptBytecode,
  ]) {
    if (random.chance(options.derived ?? 0.25)) kinds.push(k);
  }
  const empty =
    kinds.includes(KIND.source) && random.chance(options.emptyChance ?? 0.08);
  const representations = kinds.map((kind) => [
    kind,
    kind === KIND.source && empty
      ? emptyExtent()
      : extents.next(8 + random.int(24)),
  ]);
  const input = {
    size: empty ? 0 : 8 + random.int(4096),
    mtimeMs: 1.7e12 + random.int(1e6) + 0.25,
    representations,
  };
  if (options.birthtime && random.chance(0.3))
    input.birthtimeMs = 1.6e12 + random.int(1e6);
  if (random.chance(0.15))
    input.meta = { tag: random.int(1000), nested: { list: [random.int(9)] } };
  if (random.chance(0.1))
    input.scriptOptions = { filename: 'x.js', line: random.int(99) };
  return input;
};

// Names of every length: short ones, ones at the slice threshold of 13 and
// long ones.
const nameOf = (random, i) => {
  const base = `n${i}`;
  switch (random.int(6)) {
    case 0:
      return base;
    case 1:
      return base.padEnd(12, 'a');
    case 2:
      return base.padEnd(13, 'b');
    case 3:
      return `${base}.html`;
    case 4:
      return `${base}-${'c'.repeat(random.int(30))}`;
    default:
      return `item-${String(i).padStart(6, '0')}.js`;
  }
};

// /section-S/category-CC/sub-SSS/item-IIIIII.html — 20 files per leaf
// directory, 20 subs per category, 20 categories per section; 30 % of the
// files with fs:br and fs:gzip.
const pad = (n, w) => String(n).padStart(w, '0');
const catalogKeys = (n) => {
  const keys = new Array(n);
  for (let i = 0; i < n; i++) {
    const leaf = Math.floor(i / 20);
    keys[i] =
      `/section-${Math.floor(leaf / 400)}/category-${pad(Math.floor(leaf / 20) % 20, 2)}` +
      `/sub-${pad(leaf % 20, 3)}/item-${pad(i, 6)}.html`;
  }
  return keys;
};
const catalogKinds = (i) =>
  i % 10 < 3 ? [KIND.source, KIND.br, KIND.gzip] : [KIND.source];

// Every directory above the keys, parents first.
const directoriesOf = (keys) => {
  const dirs = new Set();
  for (const key of keys) {
    for (let at = key.indexOf('/', 1); at !== -1; at = key.indexOf('/', at + 1))
      dirs.add(key.slice(0, at));
  }
  return [...dirs].sort(
    (a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1),
  );
};

// The ops that build a catalog of `keys`: mkdir of every directory, then a
// write per file, in batches of `batch` ops per commit.
const catalogBatches = (keys, extents, batch = 5000) => {
  const ops = directoriesOf(keys).map((dir) => ['mkdir', dir]);
  keys.forEach((key, i) => {
    const representations = catalogKinds(i).map((kind) => [
      kind,
      extents.next(kind === KIND.source ? 64 : 32),
    ]);
    ops.push([
      'write',
      key,
      { size: 64, mtimeMs: 1727900000000, representations },
    ]);
  });
  const batches = [];
  for (let i = 0; i < ops.length; i += batch)
    batches.push(ops.slice(i, i + batch));
  return batches;
};

// A counter for createTree({ retireIds }), as the kernel's: from 1. `failAt`
// makes the n-th call throw (a test of foreign throws inside a commit).
class RetireIds {
  constructor() {
    this.last = 0;
    this.failAt = 0;
    this.calls = 0;
    this.error = null;
  }

  next() {
    this.calls++;
    if (this.failAt !== 0 && this.calls === this.failAt) {
      this.failAt = 0;
      this.error = new Error('retireIds: a planned failure');
      throw this.error;
    }
    return ++this.last;
  }
}

module.exports = {
  SEGMENT,
  createSegments,
  Extents,
  emptyExtent,
  KIND,
  rng,
  payloadOf,
  nameOf,
  catalogKeys,
  catalogKinds,
  directoriesOf,
  catalogBatches,
  RetireIds,
};
