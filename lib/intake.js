'use strict';

const { isClass, isName } = require('./tree-plan.js');
const { deepFreeze } = require('./config.js');

// Intake — the batches of an external source for one tree of client ids
// (doc/architecture.md, "Trees of client ids"), on the main thread, over
// the tree's `commit` and `load`. A source numbers its changes densely, in
// the order it commits them (`seq: 'source'`), or the intake numbers them
// as they come (`'intake'`, a single writer over one lossless channel);
// either way they are applied strictly by number:
//
//   submit({ seq, ops }) — `ops` the client's `put` and `remove`, payloads
//                          as bytes; resolves { seq, status } once
//                          published: 'committed', 'duplicate' (of a batch
//                          applied — at once — or waiting — with it),
//                          'superseded' (dropped by a load past it)
//   load(rows, seq)      — the source's state at `seq`, as one commit
//
// Batches gather for a window; at its end the continuous run last + 1,
// last + 2, … goes in parts of at most `limit` ops (a batch is never cut):
// a part's bytes are placed in the pool, then its batches are committed
// one by one in one synchronous step, all with the kernel's next version,
// and the part goes as one publication — the tree's deltas in order, the
// numbers of the batches it reflects. No thread sees a state between two
// batches of one publication. A batch that finds the pool without room
// waits for it — after the batches of its part before it publish: what
// they replace may be the room it needs. A batch past a gap waits; a gap
// older than `gapTimeout` is told once (`onGap({ from, to })`) and held
// until the missing batches come or a load. A refused batch — a commit
// refusal, a payload too large (EFBIG), a pool without room for
// `spaceTimeout` (ENOSPC) — rejects its promise and holds it and
// everything after it until a load; the batches before it publish, and
// then it is told (`onError`). A load that fails leaves the tree as it
// was, is told, and rejects its promise: in 'source' mode the batches go
// on by their numbers, in 'intake' mode the writer's batches after it wait
// for a load. A publication the kernel could not make — an engine bug —
// rejects every batch of it, and the kernel closes (fatal).
//
// What it is given (the kernel's in production, fakes in its test):
//   tree     the main tree, ids 'number' | 'string'
//   kernel   { version(), publish(results, seq), fatal(err) } — seq: { from,
//            to, loaded }; fatal: what the tree threw that is no refusal,
//            an engine bug, which closes the kernel
//   pool     { place(bytes) → Promise<extent | null>, free(extent),
//              room() → Promise, resolved once the pool frees something }
//   compress (bytes, name) → Promise<[[kind, bytes]]>, the compressed
//            representations of a source by kind
//   clock    { now() }
//   timers   { setTimeout(fn, ms), clearTimeout(handle), setImmediate(fn) }
//   onGap, onError — both required; what they throw is their own
//   settings { ids, seq, window, limit, gapTimeout, spaceTimeout,
//              maxFileSize } — trees.<name> of the config

const SOURCE = 0; // the kind of a source representation (lib/tree-node.js)

const refusal = (code, message, fields = {}) =>
  Object.assign(new Error(`${code}: ${message}`), { code }, fields);

const closedError = () =>
  refusal('ERR_VFS_CLOSED', 'the kernel closed before the batch published');

// --- The client's form --------------------------------------------------------
//
// A batch and the rows of a load are checked at once, in the thread that
// takes them — EINVAL, and nothing is taken — and taken as the intake's own:
// the ops and their fields copied, the bytes of each payload copied over a
// buffer of their own, a policy, a meta and scriptOptions cloned and frozen
// (structured clone: what could not cross to a worker is EINVAL here). What
// the client does to its own objects after changes nothing, in any thread,
// and a worker transfers the copies it made (mutation-rpc.js).

const ENCODER = new TextEncoder();

// The bytes of a payload's `data`: a Uint8Array as it is, a string as UTF-8.
const bytesOf = (data) => {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
};

const isTime = (t) => typeof t === 'number' && Number.isFinite(t);

// The bytes of `data` as the intake keeps them: over a buffer of their own
// — a copy, unless `copy` is false: bytes it has to itself already (a
// worker's, transferred to it).
const ownBytes = (data, copy) => {
  if (typeof data === 'string') return ENCODER.encode(data);
  if (!copy) return data;
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(data);
  return bytes;
};

// A value of the source's — a policy, a meta, scriptOptions — as a tree
// keeps it: a clone, frozen; null and undefined as they are.
const ownValue = (value, fault, what) => {
  if (value === undefined || value === null) return value;
  let copy;
  try {
    copy = structuredClone(value);
  } catch {
    throw fault(`${what}: data that structured clone carries`);
  }
  return deepFreeze(copy);
};

// A payload in the client's form — `{ data, mtimeMs?, meta?, scriptOptions?
// }`, or null: none — as the intake keeps it.
const ownPayload = (payload, fault, copy) => {
  if (payload === null) return null;
  if (typeof payload !== 'object') throw fault('a payload: an object or null');
  const { data } = payload;
  if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
    throw fault('a payload: `data` a Uint8Array or a string');
  }
  if (payload.mtimeMs !== undefined && !isTime(payload.mtimeMs)) {
    throw fault('a payload: `mtimeMs` a finite number');
  }
  const owned = { data: ownBytes(data, copy) };
  if (payload.mtimeMs !== undefined) owned.mtimeMs = payload.mtimeMs;
  if (payload.meta !== undefined) {
    owned.meta = ownValue(payload.meta, fault, 'a meta');
  }
  if (payload.scriptOptions !== undefined) {
    owned.scriptOptions = ownValue(
      payload.scriptOptions,
      fault,
      'scriptOptions',
    );
  }
  return owned;
};

// What is wrong with where a put or a row puts its node — its id, its
// parent's, its name, its class: the checks of a commit's format
// (lib/tree-plan.js) — or null.
const placeFault = (isId, id, parentId, name, cls) => {
  if (!isId(id)) return 'an id';
  if (parentId !== null && !isId(parentId)) return 'a parent id';
  if (parentId === null ? name !== '' : !isName(name)) return 'a name';
  if (cls !== undefined && !isClass(cls)) return 'a class';
  return null;
};

// The fields of a put, or of a row, the intake keeps: its class, payload
// and policy, each absent where it is absent — what the engine reads.
const ownFields = (fields, fault, copy) => {
  const owned = {};
  if (fields.class !== undefined) owned.class = fields.class;
  if (fields.payload !== undefined) {
    owned.payload = ownPayload(fields.payload, fault, copy);
  }
  if (fields.policy !== undefined) {
    owned.policy = ownValue(fields.policy, fault, 'a policy');
  }
  return owned;
};

// The ops of a batch, owned: `put` and `remove` only, each id once.
const ownOps = (isId, ops, copy) => {
  if (!Array.isArray(ops)) throw refusal('EINVAL', 'ops: an array');
  const owned = [];
  const seen = new Set();
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    const id = Array.isArray(op) ? op[1] : undefined;
    const fault = (what) =>
      refusal('EINVAL', `op ${index}: ${what}`, { index, id });
    if (!Array.isArray(op)) throw fault('not an op');
    if (op[0] === 'put') {
      const fields = op[4];
      if (op.length !== 5 || fields === null || typeof fields !== 'object') {
        throw fault('a put: [put, id, parentId, name, fields]');
      }
      const wrong = placeFault(isId, id, op[2], op[3], fields.class);
      if (wrong !== null) throw fault(wrong);
      owned.push(['put', id, op[2], op[3], ownFields(fields, fault, copy)]);
    } else if (op[0] === 'remove') {
      if (op.length !== 2 || !isId(id)) throw fault('a remove: [remove, id]');
      owned.push(['remove', id]);
    } else {
      throw fault(`an op of a batch is put or remove, not ${op[0]}`);
    }
    if (seen.has(id)) throw fault(`id ${id} named twice`);
    seen.add(id);
  }
  return owned;
};

// The rows of `load`, owned.
const ownRows = (isId, rows, copy) => {
  if (!Array.isArray(rows)) throw refusal('EINVAL', 'rows: an array');
  const owned = [];
  const seen = new Set();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const id = row !== null && typeof row === 'object' ? row.id : undefined;
    const fault = (what) =>
      refusal('EINVAL', `row ${index}: ${what}`, { index, id });
    if (row === null || typeof row !== 'object') throw fault('not a row');
    const { parentId, name } = row;
    const wrong = placeFault(isId, id, parentId, name, row.class);
    if (wrong !== null) throw fault(wrong);
    if (seen.has(id)) throw fault(`id ${id} named twice`);
    seen.add(id);
    owned.push({ id, parentId, name, ...ownFields(row, fault, copy) });
  }
  return owned;
};

// The id a tree's settings take: a safe integer, or a string.
const idCheck = (ids) =>
  ids === 'number'
    ? (id) => Number.isSafeInteger(id)
    : (id) => typeof id === 'string';

// The number of a batch or a load as its tree's mode wants it: none in
// 'intake' mode, which numbers them itself.
const checkSeq = (settings, seq) => {
  if (settings.seq === 'intake') {
    if (seq !== undefined) {
      throw refusal('EINVAL', "seq: the intake numbers its batches ('intake')");
    }
  } else if (!Number.isSafeInteger(seq) || seq < 0) {
    throw refusal('EINVAL', 'seq: a safe integer >= 0');
  }
};

// A batch of `submit` as the settings of its tree take it — its ops, the
// number its mode wants — checked and owned at once, on the main thread or
// in a worker before it is sent: `{ seq, ops }`. `copy`: see ownBytes.
const checkBatch = (settings, batch, copy = true) => {
  if (batch === null || typeof batch !== 'object') {
    throw refusal('EINVAL', 'a batch: { seq, ops }');
  }
  const ops = ownOps(idCheck(settings.ids), batch.ops, copy);
  checkSeq(settings, batch.seq);
  return { seq: batch.seq, ops };
};

// The rows of `load` and its number, as checkBatch: the rows owned.
const checkLoad = (settings, rows, seq, copy = true) => {
  const owned = ownRows(idCheck(settings.ids), rows, copy);
  checkSeq(settings, seq);
  return owned;
};

// How many ops a batch counts in a part of a run: one at least.
const weightOf = (batch) => Math.max(batch.ops.length, 1);

// The promises of a batch and of its repeats, settled alike.
const settle = (batch, status) => {
  batch.resolve({ seq: batch.seq, status });
  const again = status === 'committed' ? 'duplicate' : status;
  for (const repeat of batch.repeats) {
    repeat.resolve({ seq: batch.seq, status: again });
  }
};

const fail = (batch, err) => {
  batch.reject(err);
  for (const repeat of batch.repeats) repeat.reject(err);
};

// What a handler of the source's — onGap, onError — throws is its own: an
// uncaught exception, as from any emitter, never the intake's.
const tell = (handler, value) => {
  try {
    handler(value);
  } catch (err) {
    queueMicrotask(() => {
      throw err;
    });
  }
};

// What ends the placement of a batch without refusing it: NO_ROOM, a pool
// without room for a batch that may not wait for it; CUT, a load that
// superseded it.
const NO_ROOM = Symbol('no room');
const CUT = Symbol('cut');

class Intake {
  #tree;
  #kernel;
  #pool;
  #compress;
  #clock;
  #timers;
  #onGap;
  #onError;
  #settings;
  #mode;
  #window;
  #limit;
  #gapTimeout;
  #spaceTimeout;
  #maxSize;

  // The number of the last batch applied: null in 'source' mode until the
  // first load — nothing applies before it.
  #last;
  // The last number the intake gave in 'intake' mode.
  #given = 0;
  // Held: before the first load in 'source' mode, from a refusal until a
  // load, in 'intake' mode from a load until it is done — batches wait,
  // none applies.
  #held;
  #waiting = new Map(); // seq → Batch
  #timer = null; // the window's
  #gap = null; // { from, timer } of the gap held now
  #busy = Promise.resolve(); // runs and loads, one at a time
  #running = false;
  #rooms = new Set(); // the waits for room in the pool
  // What cut the work in flight short, counted — a load in 'intake' mode,
  // which supersedes every batch waiting, and close(): a part or a load
  // takes the count as it starts, and stops where it moved.
  #cuts = 0;
  #closed = false;

  constructor(options) {
    const { tree, kernel, pool, compress, clock, timers } = options;
    const { onGap, onError, settings } = options;
    if (typeof onGap !== 'function' || typeof onError !== 'function') {
      throw new TypeError('[vfs] an intake needs onGap and onError');
    }
    this.#tree = tree;
    this.#kernel = kernel;
    this.#pool = pool;
    this.#compress = compress;
    this.#clock = clock;
    this.#timers = timers;
    this.#onGap = onGap;
    this.#onError = onError;
    this.#settings = settings;
    this.#mode = settings.seq;
    this.#window = settings.window;
    this.#limit = settings.limit;
    this.#gapTimeout = settings.gapTimeout;
    this.#spaceTimeout = settings.spaceTimeout;
    this.#maxSize = settings.maxFileSize;
    const source = this.#mode === 'source';
    this.#last = source ? null : 0;
    this.#held = source;
  }

  // The number of the last batch applied, or null before the first load.
  get last() {
    return this.#last;
  }

  // Whether batches wait without applying: before the first load, after a
  // refusal until a load.
  get held() {
    return this.#held;
  }

  // How many batches wait: past a gap, held, or for their run.
  get waiting() {
    return this.#waiting.size;
  }

  // --- submit ---

  // `copy`: false for bytes the intake has to itself already (ownBytes).
  submit(batch, copy = true) {
    if (this.#closed) return Promise.reject(closedError());
    const { ops } = checkBatch(this.#settings, batch, copy);
    let { seq } = batch;
    if (this.#mode === 'intake') {
      if (this.#given >= Number.MAX_SAFE_INTEGER) {
        throw refusal('ENOSPC', 'the numbers of batches ran out');
      }
      seq = ++this.#given;
    } else {
      // A repeat — of a number applied, or waiting; 'intake' mode has none.
      if (this.#last !== null && seq <= this.#last) {
        return Promise.resolve({ seq, status: 'duplicate' });
      }
      const original = this.#waiting.get(seq);
      if (original !== undefined) {
        return new Promise((resolve, reject) => {
          original.repeats.push({ resolve, reject });
        });
      }
    }
    return new Promise((resolve, reject) => {
      // `prepared`: the engine's ops and the extents they hold, once placed.
      const entry = { seq, ops, resolve, reject, repeats: [] };
      entry.prepared = null;
      this.#waiting.set(seq, entry);
      this.#arrived();
    });
  }

  // A batch arrived, or a run or a load ended: the window starts when the
  // next batch waits, unless a run or a hold is on; a gap before the
  // waiting starts its timer.
  #arrived() {
    if (this.#closed || this.#held) return;
    if (!this.#waiting.has(this.#last + 1)) {
      this.#watchGap();
      return;
    }
    this.#unwatchGap();
    if (this.#timer !== null || this.#running) return;
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = null;
      this.#serial(() => this.#run()).catch((err) => this.#kernel.fatal(err));
    }, this.#window);
  }

  // The gap before the first batch waiting: told once its timeout is over,
  // while it lasts.
  #watchGap() {
    if (this.#waiting.size === 0) return;
    const from = this.#last + 1;
    if (this.#gap !== null && this.#gap.from === from) return;
    this.#unwatchGap();
    const gap = { from, timer: null };
    gap.timer = this.#timers.setTimeout(() => {
      gap.timer = null;
      if (this.#gap !== gap || this.#closed) return;
      let to = Infinity;
      for (const seq of this.#waiting.keys()) to = Math.min(to, seq - 1);
      if (to >= from) tell(this.#onGap, { from, to });
    }, this.#gapTimeout);
    this.#gap = gap;
  }

  #unwatchGap() {
    if (this.#gap === null) return;
    if (this.#gap.timer !== null) this.#timers.clearTimeout(this.#gap.timer);
    this.#gap = null;
  }

  // Runs and loads one at a time, in the order they were asked.
  #serial(task) {
    const run = this.#busy.then(task);
    this.#busy = run.catch(() => {});
    return run;
  }

  // The continuous run from last + 1, part by part: each placed, then
  // committed and published in one step; the next after a turn of the
  // event loop.
  async #run() {
    this.#running = true;
    try {
      while (this.#ready() && this.#waiting.has(this.#last + 1)) {
        const cut = this.#cuts;
        const part = this.#part(this.#last + 1);
        const { ready, refusal } = await this.#prepareAll(part, true, cut);
        if (this.#cuts !== cut) {
          for (const batch of ready) this.#release(batch);
          break;
        }
        this.#commit(ready, null, refusal);
        await new Promise((resolve) => this.#timers.setImmediate(resolve));
      }
    } finally {
      this.#running = false;
    }
    this.#arrived();
  }

  #ready() {
    return !this.#closed && !this.#held;
  }

  // The batches from `from` on, as long as they are continuous and their
  // ops stay within the limit — one at least, however large.
  #part(from) {
    const part = [];
    let ops = 0;
    for (let seq = from; this.#waiting.has(seq); seq++) {
      const batch = this.#waiting.get(seq);
      const weight = weightOf(batch);
      if (part.length > 0 && ops + weight > this.#limit) break;
      part.push(batch);
      ops += weight;
    }
    return part;
  }

  // The batches of `part` placed in order: { ready, refusal } — `ready`,
  // those placed before the first that is refused (`refusal`: [batch, err],
  // to refuse once they publish — #commit) or finds the pool without room
  // when it may not wait for it. Only the first of a run's part waits
  // (`wait`): what the batches before a later one replace may be the room
  // it needs, and they commit and publish first. What the batches after
  // them placed goes back to the pool; so does all a part placed when the
  // count of cuts moved from `cut` — none is ready.
  async #prepareAll(part, wait, cut) {
    for (let i = 0; i < part.length; i++) {
      const batch = part[i];
      try {
        batch.prepared = await this.#prepare(batch, wait && i === 0, cut);
      } catch (err) {
        for (let j = i; j < part.length; j++) this.#release(part[j]);
        if (err === CUT || this.#cuts !== cut) {
          for (let j = 0; j < i; j++) this.#release(part[j]);
          return { ready: [], refusal: null };
        }
        const ready = part.slice(0, i);
        if (err === NO_ROOM) return { ready, refusal: null };
        return { ready, refusal: [batch, err] };
      }
      if (this.#cuts !== cut) {
        for (const each of part) this.#release(each);
        return { ready: [], refusal: null };
      }
    }
    return { ready: part, refusal: null };
  }

  // The engine's ops of a batch, its payloads placed: `{ ops, extents }`.
  async #prepare(batch, wait, cut) {
    const extents = [];
    try {
      const ops = [];
      for (let index = 0; index < batch.ops.length; index++) {
        const op = batch.ops[index];
        if (op[0] !== 'put' || !op[4].payload) {
          ops.push(op);
          continue;
        }
        const where = { seq: batch.seq, index, id: op[1] };
        const placing = { where, name: op[3], wait, cut };
        const fields = { ...op[4] };
        fields.payload = await this.#payload(op[4].payload, extents, placing);
        ops.push(['put', op[1], op[2], op[3], fields]);
      }
      return { ops, extents };
    } catch (err) {
      for (const extent of extents) this.#pool.free(extent);
      throw err;
    }
  }

  // The engine's payload input of a client payload: its bytes placed in the
  // pool as the source (#place), its compressed representations beside it
  // where they fit at once — they are a convenience, the source is the
  // payload. `placing`: { where — the fields of a refusal — name, wait, cut }.
  async #payload(payload, extents, placing) {
    const { where, name, cut } = placing;
    const bytes = bytesOf(payload.data);
    if (bytes.length > this.#maxSize) {
      throw refusal('EFBIG', `a payload of ${bytes.length} bytes`, where);
    }
    const source = await this.#place(bytes, placing);
    extents.push(source);
    const representations = [[SOURCE, source]];
    for (const [kind, data] of await this.#compress(bytes, name)) {
      this.#live(cut);
      const extent = await this.#pool.place(data);
      if (extent === null) continue;
      extents.push(extent);
      representations.push([kind, extent]);
    }
    const input = {
      size: bytes.length,
      mtimeMs: payload.mtimeMs ?? this.#clock.now(),
      representations,
    };
    if (payload.meta !== undefined) input.meta = payload.meta;
    if (payload.scriptOptions !== undefined) {
      input.scriptOptions = payload.scriptOptions;
    }
    return input;
  }

  // An extent of `bytes`: at once, or once the pool has room when it may
  // `wait` — at most `spaceTimeout`, else ENOSPC; NO_ROOM when it may not.
  async #place(bytes, { where, wait, cut }) {
    const deadline = this.#clock.now() + this.#spaceTimeout;
    for (;;) {
      this.#live(cut);
      const extent = await this.#pool.place(bytes);
      if (extent !== null) return extent;
      if (!wait) throw NO_ROOM;
      const left = deadline - this.#clock.now();
      if (left <= 0 || !(await this.#room(left))) {
        this.#live(cut);
        throw refusal('ENOSPC', 'no room in the pool', where);
      }
    }
  }

  // Throws when the work that took the count of cuts `cut` is cut short:
  // the kernel closed, or a load superseded it (CUT). The rows of a load
  // take null: only close() cuts them.
  #live(cut) {
    if (this.#closed) throw closedError();
    if (cut !== null && cut !== this.#cuts) throw CUT;
  }

  // Whether the pool freed something within `ms` — or a load or close()
  // woke the wait (#wake) to look again.
  #room(ms) {
    return new Promise((resolve) => {
      const wait = { resolve, timer: null };
      wait.timer = this.#timers.setTimeout(() => {
        this.#rooms.delete(wait);
        resolve(false);
      }, ms);
      this.#rooms.add(wait);
      this.#pool.room().then(() => this.#wake(wait));
    });
  }

  #wake(wait) {
    if (!this.#rooms.delete(wait)) return;
    this.#timers.clearTimeout(wait.timer);
    wait.resolve(true);
  }

  #release(batch) {
    if (batch.prepared === null) return;
    for (const extent of batch.prepared.extents) this.#pool.free(extent);
    batch.prepared = null;
  }

  // A batch refused — by its preparation or its commit: told, its promise
  // and its repeats rejected, and the intake held until a load.
  #refuse(batch, err) {
    err.seq = batch.seq;
    if (Number.isInteger(err.index) && err.index >= 0 && err.id === undefined) {
      err.id = batch.ops[err.index]?.[1];
    }
    this.#waiting.delete(batch.seq);
    this.#held = true;
    this.#unwatchGap();
    fail(batch, err);
    tell(this.#onError, err);
  }

  // The batches of a part committed one by one, in one step, all with the
  // kernel's next version, then published as one; `loaded`, the result of
  // a load the part follows. A refusal stops the part there — a commit's,
  // or `refusal`, the preparation's of the batch after the part: what came
  // before it publishes, and then it is refused. What the engine throws
  // that is no refusal, and a publication the kernel could not make, leave
  // the tree ahead of every other thread: the batches of the part reject,
  // and it goes on to the kernel's fatal.
  #commit(part, loaded, refusal = null) {
    const next = this.#kernel.version() + 1;
    const now = this.#clock.now();
    const results = loaded === null ? [] : [loaded.result];
    const done = [];
    for (let i = 0; i < part.length; i++) {
      const batch = part[i];
      let result;
      try {
        result = this.#tree.commit(batch.prepared.ops, next, now);
      } catch (err) {
        if (!Number.isInteger(err.index) || err.index < 0) {
          for (const each of done) fail(each, err);
          throw err;
        }
        for (let j = i; j < part.length; j++) this.#release(part[j]);
        refusal = [batch, err];
        break;
      }
      batch.prepared = null; // its extents are the tree's now
      results.push(result);
      done.push(batch);
      this.#waiting.delete(batch.seq);
      this.#last = batch.seq;
    }
    if (results.length > 0) {
      const from = loaded === null ? done[0].seq : loaded.seq;
      const seq = { from, to: this.#last, loaded: loaded !== null };
      try {
        this.#kernel.publish(results, seq);
      } catch (err) {
        for (const batch of done) fail(batch, err);
        throw err;
      }
      for (const batch of done) settle(batch, 'committed');
    }
    if (refusal !== null) this.#refuse(refusal[0], refusal[1]);
  }

  // --- load ---

  // `copy`: as submit's.
  load(rows, seq, copy = true) {
    if (this.#closed) return Promise.reject(closedError());
    const owned = checkLoad(this.#settings, rows, seq, copy);
    let superseded = null;
    if (this.#mode === 'intake') {
      // The writer's own state: what it submitted before is in it, and the
      // numbers start again after it — what it submits meanwhile waits.
      superseded = [...this.#waiting.values()];
      this.#waiting.clear();
      this.#given = 0;
      this.#held = true;
      this.#cuts++;
      for (const wait of this.#rooms) this.#wake(wait);
      seq = 0;
    }
    const cut = this.#cuts;
    const loading = this.#serial(() => this.#load(owned, seq, superseded, cut));
    loading.catch(() => {});
    return loading;
  }

  // One load, in its turn: its rows placed — waited for when the pool has
  // no room — then committed with the batches after it that a part takes,
  // in one step and one publication. `superseded`: the batches an 'intake'
  // mode load took for its own; `cut`, the count of cuts it was asked at.
  async #load(rows, seq, superseded, cut) {
    const extents = [];
    let part = [];
    // A load that does not happen leaves the tree as it was: what it placed
    // goes back, the batches it took for its own are lost with it, and the
    // window opens again for those waiting — in 'intake' mode they stay
    // held, made for its state, until a load.
    const undo = (err) => {
      for (const extent of extents) this.#pool.free(extent);
      for (const batch of part) this.#release(batch);
      this.#failLoad(superseded, err);
      this.#arrived();
      return err;
    };
    // A refusal of the load — its rows' preparation, the engine's — is
    // told with its number and the id of its row, as a batch's is.
    const refused = (err) => {
      undo(err);
      if (err.code === 'ERR_VFS_CLOSED') return err;
      err.seq ??= seq;
      if (Number.isInteger(err.index) && err.index >= 0) {
        err.id ??= rows[err.index]?.id;
      }
      tell(this.#onError, err);
      return err;
    };
    if (this.#closed) throw undo(closedError());
    if (this.#mode === 'source' && this.#last !== null && seq < this.#last) {
      throw refused(
        refusal('ESTALE', `a load at ${seq} older than batch ${this.#last}`),
      );
    }
    if (this.#timer !== null) {
      this.#timers.clearTimeout(this.#timer);
      this.#timer = null;
    }
    let engineRows;
    let prepared = { ready: [], refusal: null };
    try {
      engineRows = await this.#rowsOf(rows, seq, extents);
      // The batches after it that join its publication: as many as a part
      // takes, placed now, none waiting for room — unless a later load took
      // them for its own.
      if (this.#cuts === cut && this.#waiting.has(seq + 1)) {
        part = this.#part(seq + 1);
        prepared = await this.#prepareAll(part, false, cut);
      }
      this.#live(null);
    } catch (err) {
      throw refused(err);
    }
    // A later load took the batches after it for its own, a refusal among
    // them too.
    let { ready, refusal: held } = prepared;
    if (this.#cuts !== cut) {
      for (const batch of ready) this.#release(batch);
      ready = [];
      held = null;
    }
    let result;
    try {
      const next = this.#kernel.version() + 1;
      result = this.#tree.load(engineRows, next, this.#clock.now());
    } catch (err) {
      if (!Number.isInteger(err.index) || err.index < 0) {
        undo(err);
        this.#kernel.fatal(err);
        throw err;
      }
      throw refused(err);
    }
    // The batches it leaves behind, their state the snapshot's — in
    // 'source' mode those waiting now with a number up to its own —
    // dropped once it is published.
    const behind = superseded ?? [];
    if (superseded === null) {
      for (const [number, batch] of this.#waiting) {
        if (number <= seq) behind.push(batch);
      }
    }
    for (const batch of behind) {
      this.#waiting.delete(batch.seq);
      this.#release(batch);
    }
    // Still held after it: by a batch of its part refused, or a later load.
    this.#held = held !== null || this.#cuts !== cut;
    this.#last = seq;
    this.#unwatchGap();
    try {
      this.#commit(ready, { result, seq }, held);
    } catch (err) {
      for (const batch of behind) fail(batch, err);
      this.#kernel.fatal(err);
      throw err;
    }
    for (const batch of behind) settle(batch, 'superseded');
    this.#arrived();
    return { seq };
  }

  // The engine's rows of a load, their payloads placed into `extents`.
  async #rowsOf(rows, seq, extents) {
    const out = [];
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (!row.payload) {
        out.push(row);
        continue;
      }
      const where = { seq, index, id: row.id };
      const placing = { where, name: row.name, wait: true, cut: null };
      const payload = await this.#payload(row.payload, extents, placing);
      out.push({ ...row, payload });
    }
    return out;
  }

  // The batches an 'intake' mode load took for its own, rejected with what
  // it failed with.
  #failLoad(superseded, err) {
    if (superseded === null) return;
    for (const batch of superseded) {
      this.#release(batch);
      fail(batch, err);
    }
  }

  // --- close ---

  // Everything waiting rejects as the closed kernel; what was placed goes
  // back to the pool, the timers stop, the work in flight is cut short.
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#cuts++;
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
    this.#unwatchGap();
    for (const wait of this.#rooms) this.#wake(wait);
    for (const batch of this.#waiting.values()) {
      this.#release(batch);
      fail(batch, closedError());
    }
    this.#waiting.clear();
  }
}

module.exports = { Intake, checkBatch, checkLoad, bytesOf };
