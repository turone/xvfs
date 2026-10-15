'use strict';

const { isClass, isName } = require('./tree-plan.js');
const { PAGE, PAGE_KINDS, kindsOf } = require('./tree-node.js');
const { deepFreeze } = require('./config.js');

// Intake — the batches of an external source for one shared tree
// (doc/architecture.md, "Shared trees"), on the main thread, over
// the tree's `commit` and `load`. A source numbers its changes densely, in
// the order it commits them (`seq: 'source'`), or the intake numbers them
// as they come (`'intake'`, a single writer over one lossless channel);
// either way they are applied strictly by number:
//
//   submit({ seq, ops }) — `ops` the caller's `put` and `remove`, payloads
//                          and pages as bytes; resolves { seq, status }
//                          once published: 'committed', 'duplicate' (of a
//                          batch applied — at once — or waiting — with
//                          it), 'superseded' (dropped by a load past it)
//   load(rows, seq)      — the source's state at `seq`, as one commit: a
//                          row states its whole node, a field it lacks is
//                          none
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
// refusal, a payload or a page too large (EFBIG), a pool without room for
// `spaceTimeout` (ENOSPC) — rejects its promise and holds it and
// everything after it until a load; the batches before it publish, and
// then it is told (`onError`). A load that fails leaves the tree as it
// was, is told, and rejects its promise: in 'source' mode the batches go
// on by their numbers, in 'intake' mode the writer's batches after it wait
// for a load. A publication the kernel could not make — an engine bug —
// rejects every batch of it, and the kernel closes (fatal).
//
// Pages from any thread after a render — no batch of the source:
//
//   cache({ id, lang, data, version }) — the page of a node's payload in a
//                          language, rendered from the payload of that
//                          version; resolves { status: 'cached' | 'stale' }
//   uncache({ id, lang, subtree })     — no page, in a language or (lang
//                          null) in all, of the node or its subtree too;
//                          resolves { dropped }
//
// They are numbered by no one and wait for nothing — a hold, a gap, the
// first load — but a load in flight: at the end of a window they go after
// the part of its run, in its limit — an uncache of a subtree one op — or
// as a publication of their own, one commit of them. Per (id, language)
// the latest one counts: one it replaces is 'stale', its bytes back to the
// pool. A page whose version is no longer its payload's — the payload
// gone, its node dead — is 'stale' too. A page too large (EFBIG) or
// without room (ENOSPC, no waiting) rejects at once; neither is told.
//
// What it is given (the kernel's in production, fakes in its test):
//   tree     the main tree, ids 'number' | 'string'
//   kernel   { version(), publish(results, seq), fatal(err) } — seq: { from,
//            to, loaded }, from and to null for pages alone; fatal: what
//            the tree threw that is no refusal, an engine bug, which closes
//            the kernel
//   pool     { place(bytes) → Promise<extent | null>, free(extent),
//              room() → Promise, resolved once the pool frees something }
//   compress (bytes, name) → Promise<[[kind, bytes]]>, the compressed
//            representations of a page by kind
//   clock    { now() }
//   timers   { setTimeout(fn, ms), clearTimeout(handle), setImmediate(fn) }
//   onGap, onError — both required; what they throw is their own
//   settings { ids, languages, seq, window, limit, gapTimeout, spaceTimeout,
//              maxFileSize } — trees.<name> of the config

const SOURCE = 0; // the kind of a source representation (lib/tree-node.js)
const EMPTY = new Uint8Array(0);

const refusal = (code, message, fields = {}) =>
  Object.assign(new Error(`${code}: ${message}`), { code }, fields);

const closedError = () =>
  refusal('ERR_VFS_CLOSED', 'the kernel closed before the batch published');

// --- The caller's form --------------------------------------------------------
//
// A batch and the rows of a load are checked at once, in the thread that
// takes them — EINVAL, and nothing is taken — and taken as the intake's own:
// the ops and their fields copied, the bytes of each payload and page
// copied over a buffer of their own, a policy and a meta cloned and frozen
// (structured clone: what could not cross to a worker is EINVAL here). What
// the caller does to its own objects after changes nothing, in any thread,
// and a worker transfers the copies it made (mutation-rpc.js). A field no
// one reads is EINVAL: a typo would leave a page as it was. In a tree of
// several languages a refusal about one names it, `lang`, the main one's
// code too.

const ENCODER = new TextEncoder();

const PUT_FIELDS = ['class', 'payload', 'policy', 'rendered', 'translations'];
const ROW_FIELDS = ['id', 'parentId', 'name', ...PUT_FIELDS];
const PAYLOAD_FIELDS = ['data', 'mtimeMs', 'meta'];
const TRANSLATION_FIELDS = ['name', 'payload', 'rendered'];

// The first field of `value` that `known` does not list, or null.
const unknownOf = (value, known) => {
  for (const key of Object.keys(value)) if (!known.includes(key)) return key;
  return null;
};

// The bytes of a payload's `data` or a page: a Uint8Array as it is, a
// string as UTF-8.
const bytesOf = (data) => {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
};

const isBytes = (data) =>
  typeof data === 'string' || data instanceof Uint8Array;

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

// A value of the source's — a policy, a meta — as a tree keeps it: a
// clone, frozen; null and undefined as they are.
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

// A payload in the caller's form — `{ data?, mtimeMs?, meta? }`, or null:
// none — as the intake keeps it. Without `data` its data is empty.
const ownPayload = (payload, fault, copy) => {
  if (payload === null) return null;
  if (typeof payload !== 'object') throw fault('a payload: an object or null');
  const unknown = unknownOf(payload, PAYLOAD_FIELDS);
  if (unknown !== null) throw fault(`a payload has no field ${unknown}`);
  const { data } = payload;
  if (data !== undefined && !isBytes(data)) {
    throw fault('a payload: `data` a Uint8Array or a string');
  }
  if (payload.mtimeMs !== undefined && !isTime(payload.mtimeMs)) {
    throw fault('a payload: `mtimeMs` a finite number');
  }
  const owned = {};
  if (data !== undefined) owned.data = ownBytes(data, copy);
  if (payload.mtimeMs !== undefined) owned.mtimeMs = payload.mtimeMs;
  if (payload.meta !== undefined) {
    owned.meta = ownValue(payload.meta, fault, 'a meta');
  }
  return owned;
};

// A page beside `payload: null` says two things at once — no data, and a
// page of it — in the put itself: a wrong form, not a final state.
const pageWithoutData = (said) =>
  said.payload === null &&
  said.rendered !== undefined &&
  said.rendered !== null;

// A rendered page: its bytes, or null — none.
const ownRendered = (rendered, fault, copy) => {
  if (rendered === null) return null;
  if (!isBytes(rendered)) {
    throw fault('`rendered` a Uint8Array, a string or null');
  }
  return ownBytes(rendered, copy);
};

// What a put or a row states of the languages but the main one — `{ code:
// null | { name?, payload?, rendered? } }` — owned in the same form, the
// codes in the order of the tree's list: what a worker took is taken again
// on the main thread as it came. The root's name is '' in every language.
const ownTranslations = (translations, fault, copy, languages, root) => {
  if (languages.length < 2) {
    throw fault('translations: the tree has one language');
  }
  const plain =
    translations !== null &&
    typeof translations === 'object' &&
    !Array.isArray(translations);
  if (!plain) throw fault('translations: an object of languages');
  for (const code of Object.keys(translations)) {
    if (languages.indexOf(code) < 1) {
      const what = `translations: "${code}" is no language of the tree but the main one`;
      throw fault(what, code);
    }
  }
  const owned = {};
  for (let lang = 1; lang < languages.length; lang++) {
    const code = languages[lang];
    if (!Object.hasOwn(translations, code)) continue;
    const said = translations[code];
    const at = (what) => fault(`translations.${code}: ${what}`, code);
    if (said === null) {
      owned[code] = null;
      continue;
    }
    if (typeof said !== 'object') throw at('null or an object');
    const unknown = unknownOf(said, TRANSLATION_FIELDS);
    if (unknown !== null) throw at(`no field ${unknown}`);
    const t = {};
    if (said.name !== undefined) {
      if (root ? said.name !== '' : !isName(said.name)) throw at('a name');
      t.name = said.name;
    }
    if (said.payload !== undefined) {
      t.payload = ownPayload(said.payload, at, copy);
    }
    if (said.rendered !== undefined) {
      t.rendered = ownRendered(said.rendered, at, copy);
    }
    if (pageWithoutData(t)) throw at('a page beside payload null');
    owned[code] = t;
  }
  return owned;
};

// The id a tree's settings take: a safe integer, or a string.
const idCheck = (ids) =>
  ids === 'number'
    ? (id) => Number.isSafeInteger(id)
    : (id) => typeof id === 'string';

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

// The fields of a put, or of a row, the intake keeps: its class, payload,
// page, policy and translations, each absent where it is absent — what
// the engine reads. A fault of the main language's payload or page names
// its code in a tree of several.
const ownFields = (fields, known, fault, copy, languages, root) => {
  const unknown = unknownOf(fields, known);
  if (unknown !== null) throw fault(`no field ${unknown}`);
  const main =
    languages.length > 1 ? (what) => fault(what, languages[0]) : fault;
  const owned = {};
  if (fields.class !== undefined) owned.class = fields.class;
  if (fields.payload !== undefined) {
    owned.payload = ownPayload(fields.payload, main, copy);
  }
  if (fields.rendered !== undefined) {
    owned.rendered = ownRendered(fields.rendered, main, copy);
  }
  if (pageWithoutData(owned)) throw main('a page beside payload null');
  if (fields.policy !== undefined) {
    owned.policy = ownValue(fields.policy, fault, 'a policy');
  }
  if (fields.translations !== undefined) {
    const { translations } = fields;
    owned.translations = ownTranslations(
      translations,
      fault,
      copy,
      languages,
      root,
    );
  }
  return owned;
};

// The fault of op or row `index`: EINVAL with its index, its id and, when
// given, the language it is about.
const faultAt = (prefix, index, id) => (what, lang) => {
  const fields = lang === undefined ? { index, id } : { index, id, lang };
  return refusal('EINVAL', `${prefix} ${index}: ${what}`, fields);
};

// The ops of a batch, owned: `put` and `remove` only, each id once.
const ownOps = (settings, ops, copy) => {
  if (!Array.isArray(ops)) throw refusal('EINVAL', 'ops: an array');
  const isId = idCheck(settings.ids);
  const owned = [];
  const seen = new Set();
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    const id = Array.isArray(op) ? op[1] : undefined;
    const fault = faultAt('op', index, id);
    if (!Array.isArray(op)) throw fault('not an op');
    if (op[0] === 'put') {
      const fields = op[4];
      if (op.length !== 5 || fields === null || typeof fields !== 'object') {
        throw fault('a put: [put, id, parentId, name, fields]');
      }
      const wrong = placeFault(isId, id, op[2], op[3], fields.class);
      if (wrong !== null) throw fault(wrong);
      const { languages } = settings;
      const root = op[2] === null;
      const own = ownFields(fields, PUT_FIELDS, fault, copy, languages, root);
      owned.push(['put', id, op[2], op[3], own]);
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

// A row of `load` states its whole node: what it lacks is none — no
// payload, page or policy, no translation — a translation's lacking data
// or page none too; a translation but the root's has its name, and a page
// its data. A class it lacks stays a live node's.
const fullRow = (row, fault, languages) => {
  row.payload ??= null;
  row.rendered ??= null;
  row.policy ??= null;
  if (pageWithoutData(row)) {
    const what = 'a page without data — a row states its node';
    throw fault(what, languages.length > 1 ? languages[0] : undefined);
  }
  if (languages.length < 2) return row;
  const root = row.parentId === null;
  const stated = row.translations ?? {};
  const full = {};
  for (let lang = 1; lang < languages.length; lang++) {
    const code = languages[lang];
    const t = Object.hasOwn(stated, code) ? stated[code] : null;
    if (t === null) {
      full[code] = null;
      continue;
    }
    if (t.name === undefined && !root) {
      throw fault(`translations.${code}: a name — a row states its node`, code);
    }
    const said = {
      name: t.name ?? '',
      payload: t.payload ?? null,
      rendered: t.rendered ?? null,
    };
    if (pageWithoutData(said)) {
      throw fault(`translations.${code}: a page without data`, code);
    }
    full[code] = said;
  }
  row.translations = full;
  return row;
};

// The rows of `load`, owned and full.
const ownRows = (settings, rows, copy) => {
  if (!Array.isArray(rows)) throw refusal('EINVAL', 'rows: an array');
  const isId = idCheck(settings.ids);
  const { languages } = settings;
  const owned = [];
  const seen = new Set();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const id = row !== null && typeof row === 'object' ? row.id : undefined;
    const fault = faultAt('row', index, id);
    if (row === null || typeof row !== 'object') throw fault('not a row');
    const { parentId, name } = row;
    const wrong = placeFault(isId, id, parentId, name, row.class);
    if (wrong !== null) throw fault(wrong);
    if (seen.has(id)) throw fault(`id ${id} named twice`);
    seen.add(id);
    const root = parentId === null;
    const fields = ownFields(row, ROW_FIELDS, fault, copy, languages, root);
    owned.push(fullRow({ id, parentId, name, ...fields }, fault, languages));
  }
  return owned;
};

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
  const ops = ownOps(settings, batch.ops, copy);
  checkSeq(settings, batch.seq);
  return { seq: batch.seq, ops };
};

// The rows of `load` and its number, as checkBatch: the rows owned.
const checkLoad = (settings, rows, seq, copy = true) => {
  const owned = ownRows(settings, rows, copy);
  checkSeq(settings, seq);
  return owned;
};

// The index of a language by its code — the main one's for none — or
// null for all, where `all` takes it; EINVAL for a code the tree has not.
const langOf = (settings, lang, all) => {
  if (lang === undefined || lang === null) return all ? null : 0;
  const index = settings.languages.indexOf(lang);
  if (index === -1) {
    throw refusal('EINVAL', `lang: no language "${lang}" in the tree`);
  }
  return index;
};

// A page of `cache`, checked and owned as checkBatch takes a batch: `{ id,
// lang, data, version }` — `lang` a code of the tree, or none for the main
// one.
const checkCache = (settings, request, copy = true) => {
  if (request === null || typeof request !== 'object') {
    throw refusal('EINVAL', 'cache: { id, lang, data, version }');
  }
  const { id, data, version } = request;
  if (!idCheck(settings.ids)(id)) throw refusal('EINVAL', 'cache: an id');
  if (!isBytes(data)) {
    throw refusal('EINVAL', 'cache: `data` a Uint8Array or a string');
  }
  if (!Number.isSafeInteger(version) || version < 0) {
    throw refusal('EINVAL', 'cache: `version` the version of the payload');
  }
  langOf(settings, request.lang, false);
  const lang = request.lang ?? null;
  return { id, lang, data: ownBytes(data, copy), version };
};

// An uncache: `{ id, lang, subtree }` — `lang` a code, or none for all.
const checkUncache = (settings, request) => {
  if (request === null || typeof request !== 'object') {
    throw refusal('EINVAL', 'uncache: { id, lang, subtree }');
  }
  const { id } = request;
  if (!idCheck(settings.ids)(id)) throw refusal('EINVAL', 'uncache: an id');
  const subtree = request.subtree ?? false;
  if (typeof subtree !== 'boolean') {
    throw refusal('EINVAL', 'uncache: `subtree` a boolean');
  }
  langOf(settings, request.lang, true);
  return { id, lang: request.lang ?? null, subtree };
};

// The bytes an owned batch, rows or page hold — what a worker transfers.
const bytesIn = (owned) => {
  const out = [];
  const take = (said) => {
    if (said === null || said === undefined) return;
    if (said.payload?.data !== undefined) out.push(said.payload.data);
    if (said.rendered instanceof Uint8Array) out.push(said.rendered);
    for (const t of Object.values(said.translations ?? {})) take(t);
  };
  if (owned.data instanceof Uint8Array) out.push(owned.data);
  for (const op of owned.ops ?? []) if (op[0] === 'put') take(op[4]);
  for (const row of owned.rows ?? []) take(row);
  return out;
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

// The kinds of a page op.
const CACHE = 0;
const UNCACHE = 1;

// A page op, from cache() or uncache(): `order` the order of the calls,
// `prepared` the page placed (a cache's), `dropped` the pages an uncache
// took away.
class PageOp {
  constructor(kind, id, lang, order, resolve, reject) {
    this.kind = kind;
    this.id = id;
    this.lang = lang; // an index; null: every language (an uncache's)
    this.order = order;
    this.resolve = resolve;
    this.reject = reject;
    this.data = null; // a cache's bytes
    this.version = 0; // a cache's
    this.subtree = false; // an uncache's
    this.prepared = null; // [[kind, extent]] of a cache, placed
    this.dropped = 0;
  }
}

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
  #languages; // the codes; [] for one language without one
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
  // Page ops waiting: the caches by (id, language), the latest of each,
  // and the uncaches in their order; `#order` counts the calls.
  #caches = new Map();
  #uncaches = [];
  #order = 0;
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
    this.#settings = { ...settings, languages: settings.languages ?? [] };
    this.#languages = this.#settings.languages;
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

  // A batch or a page op arrived, or a run or a load ended: the window
  // starts when the next batch waits, unless a run or a hold is on, or a
  // page op waits; a gap before the waiting starts its timer.
  #arrived() {
    if (this.#closed) return;
    let due = this.#pagesWait();
    if (!this.#held) {
      if (this.#waiting.has(this.#last + 1)) {
        this.#unwatchGap();
        due = true;
      } else {
        this.#watchGap();
      }
    }
    if (!due || this.#timer !== null || this.#running) return;
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

  // The continuous run from last + 1, part by part, and the page ops
  // waiting after a part, in its limit: each placed, then committed and
  // published in one step; the next after a turn of the event loop. Page
  // ops alone, held batches or none, publish alone.
  async #run() {
    this.#running = true;
    try {
      for (;;) {
        const batches = this.#ready() && this.#waiting.has(this.#last + 1);
        if (this.#closed || (!batches && !this.#pagesWait())) break;
        const cut = this.#cuts;
        const part = batches ? this.#part(this.#last + 1) : [];
        let weight = 0;
        for (const batch of part) weight += weightOf(batch);
        const pages = this.#takePages(this.#limit - weight, part.length === 0);
        const { ready, refusal } = await this.#prepareAll(part, true, cut);
        const placed = await this.#preparePages(pages, cut);
        if (this.#cuts !== cut) {
          for (const batch of ready) this.#release(batch);
          if (this.#closed) this.#failPages(placed, closedError());
          else this.#putBack(placed);
          break;
        }
        this.#commit(ready, null, refusal, placed);
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

  // The engine's ops of a batch, its payloads and pages placed: `{ ops,
  // extents }`.
  async #prepare(batch, wait, cut) {
    const extents = [];
    try {
      const ops = [];
      for (let index = 0; index < batch.ops.length; index++) {
        const op = batch.ops[index];
        if (op[0] !== 'put') {
          ops.push(op);
          continue;
        }
        const where = { seq: batch.seq, index, id: op[1] };
        const placing = { where, name: op[3], wait, cut };
        const fields = await this.#fieldsOf(op[4], extents, placing);
        ops.push(['put', op[1], op[2], op[3], fields]);
      }
      return { ops, extents };
    } catch (err) {
      for (const extent of extents) this.#pool.free(extent);
      throw err;
    }
  }

  // The engine's fields of a put or a row: what it states of each language
  // — its payload and page placed — the translations by index.
  async #fieldsOf(fields, extents, placing) {
    const out = {};
    if (fields.class !== undefined) out.class = fields.class;
    if (fields.policy !== undefined) out.policy = fields.policy;
    const languages = this.#languages;
    await this.#stated(fields, out, languages[0], extents, placing);
    if (fields.translations === undefined) return out;
    const list = [];
    const { translations } = fields;
    for (let lang = 1; lang < languages.length; lang++) {
      const code = languages[lang];
      if (!Object.hasOwn(translations, code)) continue;
      const t = translations[code];
      if (t === null) {
        list.push([lang, null]);
        continue;
      }
      const said = {};
      if (t.name !== undefined) said.name = t.name;
      await this.#stated(t, said, code, extents, placing);
      list.push([lang, said]);
    }
    out.translations = list;
    return out;
  }

  // What `said` states of one language — its payload, its page — into the
  // engine's `out`: new data with its page among its representations, a
  // page alone the engine's `page`, [] for none.
  async #stated(said, out, code, extents, placing) {
    const { payload, rendered } = said;
    if (payload !== undefined && payload !== null) {
      const page = rendered ?? null;
      out.payload = await this.#payload(payload, page, code, extents, placing);
      return;
    }
    if (payload === null) out.payload = null;
    if (rendered === null) out.page = [];
    else if (rendered !== undefined) {
      out.page = await this.#page(rendered, code, extents, placing);
    }
  }

  // The fields of a refusal about language `code`: its code in a tree of
  // several languages.
  #about(where, code) {
    return this.#languages.length > 1 ? { ...where, lang: code } : where;
  }

  // The engine's payload input of a caller's payload: its bytes placed in
  // the pool as the source (#place), and its page, if `rendered`, beside
  // it. The data is never compressed: it stays here. `placing`: { where —
  // the fields of a refusal — name, wait, cut }.
  async #payload(payload, rendered, code, extents, placing) {
    const bytes = payload.data === undefined ? EMPTY : bytesOf(payload.data);
    if (bytes.length > this.#maxSize) {
      const where = this.#about(placing.where, code);
      throw refusal('EFBIG', `a payload of ${bytes.length} bytes`, where);
    }
    const source = await this.#place(bytes, placing);
    extents.push(source);
    const representations = [[SOURCE, source]];
    if (rendered !== null) {
      const page = await this.#page(rendered, code, extents, placing);
      for (const pair of page) representations.push(pair);
    }
    const input = {
      size: bytes.length,
      mtimeMs: payload.mtimeMs ?? this.#clock.now(),
      representations,
    };
    if (payload.meta !== undefined) input.meta = payload.meta;
    return input;
  }

  // A page placed — kind 1 — and its compressed forms beside it where they
  // fit at once: they are a convenience, the page is the page.
  async #page(rendered, code, extents, placing) {
    const bytes = bytesOf(rendered);
    if (bytes.length > this.#maxSize) {
      const where = this.#about(placing.where, code);
      throw refusal('EFBIG', `a page of ${bytes.length} bytes`, where);
    }
    const extent = await this.#place(bytes, placing);
    extents.push(extent);
    const page = [[PAGE, extent]];
    for (const [kind, data] of await this.#compress(bytes, placing.name)) {
      this.#live(placing.cut);
      const placed = await this.#pool.place(data);
      if (placed === null) continue;
      extents.push(placed);
      page.push([kind, placed]);
    }
    return page;
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
    this.#code(err);
    this.#waiting.delete(batch.seq);
    this.#held = true;
    this.#unwatchGap();
    fail(batch, err);
    tell(this.#onError, err);
  }

  // The engine names a language by its index: the source by its code.
  #code(err) {
    if (Number.isInteger(err.lang)) err.lang = this.#languages[err.lang];
  }

  // The batches of a part committed one by one, in one step, all with the
  // kernel's next version, then the page ops after them as one commit, and
  // all published as one; `loaded`, the result of a load the part follows.
  // A refusal stops the batches there — a commit's, or `refusal`, the
  // preparation's of the batch after the part: what came before it
  // publishes, and then it is refused. What the engine throws that is no
  // refusal, and a publication the kernel could not make, leave the tree
  // ahead of every other thread: the batches and page ops of the part
  // reject, and it goes on to the kernel's fatal.
  #commit(part, loaded, refusal = null, pages = []) {
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
          this.#failPages(pages, err);
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
    let paged = [];
    try {
      const pageResult = this.#commitPages(pages, next, now);
      if (pageResult !== null) {
        results.push(pageResult.result);
        paged = pageResult.cached;
      }
    } catch (err) {
      for (const each of done) fail(each, err);
      this.#failPages(pages, err);
      throw err;
    }
    if (results.length > 0) {
      const batches = loaded !== null || done.length > 0;
      const from = loaded === null ? (done[0]?.seq ?? null) : loaded.seq;
      const seq = batches
        ? { from, to: this.#last, loaded: loaded !== null }
        : { from: null, to: null, loaded: false };
      try {
        this.#kernel.publish(results, seq);
      } catch (err) {
        for (const batch of done) fail(batch, err);
        this.#failPages(pages, err);
        throw err;
      }
      for (const batch of done) settle(batch, 'committed');
    }
    this.#settlePages(pages, paged);
    if (refusal !== null) this.#refuse(refusal[0], refusal[1]);
  }

  // --- pages ---

  // `copy`: as submit's.
  cache(request, copy = true) {
    if (this.#closed) return Promise.reject(closedError());
    const owned = checkCache(this.#settings, request, copy);
    const { id, data, version } = owned;
    const lang = langOf(this.#settings, owned.lang, false);
    if (data.byteLength > this.#maxSize) {
      const fields = this.#about({ id }, this.#languages[lang]);
      const err = refusal(
        'EFBIG',
        `a page of ${data.byteLength} bytes`,
        fields,
      );
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      const op = new PageOp(CACHE, id, lang, ++this.#order, resolve, reject);
      op.data = data;
      op.version = version;
      const key = this.#keyOf(id, lang);
      const before = this.#caches.get(key);
      if (before !== undefined) this.#stale(before);
      this.#caches.set(key, op);
      this.#arrived();
    });
  }

  uncache(request) {
    if (this.#closed) return Promise.reject(closedError());
    const owned = checkUncache(this.#settings, request);
    const { id, subtree } = owned;
    const lang = langOf(this.#settings, owned.lang, true);
    return new Promise((resolve, reject) => {
      const op = new PageOp(UNCACHE, id, lang, ++this.#order, resolve, reject);
      op.subtree = subtree;
      this.#uncaches.push(op);
      this.#arrived();
    });
  }

  #keyOf(id, lang) {
    return `${lang}:${id}`;
  }

  #pagesWait() {
    return this.#caches.size > 0 || this.#uncaches.length > 0;
  }

  // The page ops waiting, the earliest first, as many as `budget` — one at
  // least when they go `alone` — out of the waiting.
  #takePages(budget, alone) {
    const count = alone ? Math.max(budget, 1) : budget;
    if (count <= 0 || !this.#pagesWait()) return [];
    const all = [...this.#caches.values(), ...this.#uncaches];
    all.sort((a, b) => a.order - b.order);
    const taken = all.slice(0, count);
    for (const op of taken) {
      if (op.kind === CACHE) this.#caches.delete(this.#keyOf(op.id, op.lang));
    }
    this.#uncaches = this.#uncaches.filter((op) => !taken.includes(op));
    return taken;
  }

  // Page ops a cut put off, back among the waiting — the earlier for a
  // pair a later one took since is stale.
  #putBack(ops) {
    for (const op of ops) {
      if (op.kind === UNCACHE) {
        this.#uncaches.push(op);
        continue;
      }
      const key = this.#keyOf(op.id, op.lang);
      const now = this.#caches.get(key);
      if (now === undefined) this.#caches.set(key, op);
      else this.#stale(op);
    }
    this.#uncaches.sort((a, b) => a.order - b.order);
  }

  // The pages of the caches of `ops` placed, without waiting for room —
  // ENOSPC at once — their compressed forms beside them where they fit:
  // what is ready to commit. A cut stops it: what is left is put back.
  async #preparePages(ops, cut) {
    const ready = [];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.kind === UNCACHE || op.prepared !== null) {
        ready.push(op);
        continue;
      }
      const extents = [];
      const code = this.#languages[op.lang];
      try {
        const node = this.#tree.byId(op.id);
        const name = node === null ? String(op.id) : this.#tree.nameOf(node);
        const placing = { where: { id: op.id }, name, wait: false, cut };
        op.prepared = await this.#page(op.data, code, extents, placing);
        op.data = null;
        ready.push(op);
      } catch (err) {
        for (const extent of extents) this.#pool.free(extent);
        // Cut short: #run puts the rest back, or rejects it on close().
        if (err === CUT || this.#closed || cut !== this.#cuts) {
          return [...ready, ...ops.slice(i)];
        }
        const fields = this.#about({ id: op.id }, code);
        op.reject(
          err === NO_ROOM
            ? refusal('ENOSPC', 'no room in the pool for a page', fields)
            : err,
        );
      }
    }
    return ready;
  }

  // The page ops of a publication as one commit, after its batches: for
  // each (id, language) the latest op of them — an uncache of a subtree
  // takes its nodes as they are now — a cache whose version is still its
  // payload's there committed, one where there is no such payload stale;
  // an uncache where there is a page. Null when nothing changes.
  #commitPages(ops, next, now) {
    if (ops.length === 0) return null;
    const tree = this.#tree;
    const entries = new Map(); // key → { op, id, lang }
    const set = (op, id, lang) => {
      const key = this.#keyOf(id, lang);
      const before = entries.get(key);
      if (before !== undefined && before.op.kind === CACHE) {
        this.#stale(before.op);
      }
      entries.set(key, { op, id, lang });
    };
    for (const op of ops) {
      if (op.kind === CACHE) {
        set(op, op.id, op.lang);
        continue;
      }
      const node = tree.byId(op.id);
      if (node === null) continue;
      const nodes = [node];
      if (op.subtree) for (const [n] of tree.walk(node)) nodes.push(n);
      const count = Math.max(1, this.#languages.length);
      for (const n of nodes) {
        if (op.lang !== null) set(op, n.id, op.lang);
        else for (let lang = 0; lang < count; lang++) set(op, n.id, lang);
      }
    }
    const renders = [];
    const cached = [];
    for (const { op, id, lang } of entries.values()) {
      const node = tree.byId(id);
      const payload = node === null ? null : tree.payloadOf(node, lang);
      if (op.kind === CACHE) {
        if (payload === null || payload.version !== op.version) {
          this.#stale(op);
          continue;
        }
        renders.push(['render', id, lang, op.prepared]);
        cached.push(op);
      } else if (payload !== null && (kindsOf(payload) & PAGE_KINDS) !== 0) {
        renders.push(['render', id, lang, []]);
        op.dropped++;
      }
    }
    if (renders.length === 0) return null;
    const result = tree.commit(renders, next, now);
    for (const op of cached) op.prepared = null; // the tree's now
    return { result, cached };
  }

  // The page ops of a publication answered once it is out: what was
  // cached, what an uncache dropped; one already answered stays so.
  #settlePages(ops, cached) {
    for (const op of ops) {
      if (op.kind === UNCACHE) op.resolve({ dropped: op.dropped });
      else if (cached.includes(op)) op.resolve({ status: 'cached' });
    }
  }

  // A cache that will not be: 'stale', its page back to the pool.
  #stale(op) {
    if (op.prepared !== null) {
      for (const [, extent] of op.prepared) this.#pool.free(extent);
      op.prepared = null;
    }
    op.resolve({ status: 'stale' });
  }

  #failPages(ops, err) {
    for (const op of ops) {
      if (op.prepared !== null) {
        for (const [, extent] of op.prepared) this.#pool.free(extent);
        op.prepared = null;
      }
      op.reject(err);
    }
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
  // The page ops waiting go in the run after it, checked against its state.
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
      this.#code(err);
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

  // The engine's rows of a load, their payloads and pages placed into
  // `extents`.
  async #rowsOf(rows, seq, extents) {
    const out = [];
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const where = { seq, index, id: row.id };
      const placing = { where, name: row.name, wait: true, cut: null };
      const fields = await this.#fieldsOf(row, extents, placing);
      const { id, parentId, name } = row;
      out.push({ id, parentId, name, ...fields });
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

  // Everything waiting rejects as the closed kernel — batches and page ops
  // — what was placed goes back to the pool, the timers stop, the work in
  // flight is cut short.
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
    this.#failPages(
      [...this.#caches.values(), ...this.#uncaches],
      closedError(),
    );
    this.#caches.clear();
    this.#uncaches = [];
  }
}

module.exports = {
  Intake,
  checkBatch,
  checkLoad,
  checkCache,
  checkUncache,
  bytesIn,
  bytesOf,
};
