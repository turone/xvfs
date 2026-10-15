'use strict';

// The reference model of the tree engine (doc/architecture.md, "Node
// trees"): obviously correct and slow. The differential test holds every
// engine, and every replica it feeds, to it: this file is the engine's
// semantics in executable form.
//
// State: nodes with a model-own `uid`, kept by a move, never reused, and the
// tree's numbers. A commit works on a copy of the state and the copy replaces
// the state only when every check has passed — so a refusal changes nothing.
// Payloads and representations carry uids too: the test maps them to the
// engine's objects and checks their identity.

const SMALL = 2 ** 30; // a small integer of any build is in [-SMALL, SMALL)
const OTHERS = [
  'requireBytecode',
  'scriptBytecode',
  'gzip',
  'deflate',
  'br',
  'zstd',
];
const KIND_COUNT = 7; // 0 source, 1…6 the `others` fields in that order
// An id tree's page: kind 1 and its compressed forms 3…6.
const PAGE_KINDS = new Set([1, 3, 4, 5, 6]);

// `lang`: the index of the language a refusal is about, given in a tree of
// several languages only — the main one's, 0, too.
const refusal = (code, index, other, lang) => {
  const err = new Error(`${code} at ${index}`);
  err.code = code;
  err.index = index;
  if (other !== undefined) err.other = other;
  if (lang !== undefined) err.lang = lang;
  return err;
};

// Whether what a put states of a language holds data or a page.
const states = (said) =>
  (said.payload !== undefined && said.payload !== null) ||
  (said.page !== undefined && said.page.length > 0);

// A key as get() takes it: '' or '/' (the root), or names each after one '/',
// none empty, '.' or '..', none holding '\' or NUL.
const NAMES = /^(?:\/(?!\.\.?(?:\/|$))[^/\\\0]+)+$/;
const isKey = (key) =>
  typeof key === 'string' && (key === '' || key === '/' || NAMES.test(key));
const canonical = (key) => (key === '/' ? '' : key);
const namesOf = (key) => (key === '' ? [] : key.slice(1).split('/'));
const isName = (name) =>
  typeof name === 'string' &&
  name !== '' &&
  name !== '.' &&
  name !== '..' &&
  !/[/\\\0]/.test(name);

// A string the model keeps: its own flat copy, never a slice of the caller's
// key or row (a slice of 13+ chars keeps its whole parent alive).
const own = (s) =>
  typeof s !== 'string' || s.length < 13 ? s : JSON.parse(JSON.stringify(s));

const isClass = (c) => Number.isInteger(c) && c >= 0 && c < SMALL;
const ownPolicy = (p) => p !== null && p !== undefined;

class ModelNode {
  constructor(uid, id, parent, name, cls) {
    this.uid = uid;
    this.id = own(id);
    this.parent = parent;
    this.name = own(name);
    this.cls = cls;
    this.payload = null;
    this.policy = null;
    this.kids = [];
    this.subVer = 0;
    this.tr = new Map(); // language → { name, payload }: its translations
  }
}

// A payload of the model: its attributes, its representations by kind (each
// with a uid of its own) and the uid of its `others` object (shared by a
// source relocation, new otherwise).
class ModelPayload {
  constructor(uid, fields) {
    this.uid = uid;
    this.version = fields.version;
    this.size = fields.size;
    this.mtimeMs = fields.mtimeMs;
    this.birthtimeMs = fields.birthtimeMs; // undefined without `birthtime`
    this.reps = fields.reps; // Map<kind, { kind, segmentId, offset, length, uid }>
    this.extras = fields.extras; // null | { meta, scriptOptions }
    this.othersUid = fields.othersUid; // null when no derived representation
    this.directory = fields.directory === true; // attributes-only directory payload
  }
}

const extentKey = (r) => `${r.segmentId}:${r.offset}:${r.length}`;
const isEmptyExtent = (r) => r.length === 0;

class ModelTree {
  // options: { ids, containers, directories, birthtime, aggregates, maxNodes,
  // now, segments } as createTree takes them (cache and retireIds are the
  // engine's business: the model has no cache, and the test checks retireIds).
  constructor(options = {}) {
    const ids = options.ids ?? 'engine';
    if (!['engine', 'number', 'string'].includes(ids))
      throw refusal('EINVAL', -1);
    this.mode = ids;
    this.fs = ids === 'engine';
    this.directories = options.directories === true;
    this.birthtime = options.birthtime === true;
    this.aggregates = {
      classes: options.aggregates?.classes === true,
      subtreeVersion: options.aggregates?.subtreeVersion === true,
    };
    this.maxNodes = options.maxNodes ?? 2 ** 24;
    this.languages = options.languages ?? 1;
    this.segments = options.segments ?? new Map();
    this.containers = this.fs ? [0] : [...(options.containers ?? [])];
    this.version = 0;
    this.structureVersion = 0;
    this.policyVersion = 0;
    this.revision = 0;
    this.nextUid = 1;
    this.nextId = 1; // the engine-mode counter (the model's own ids)
    this.made = []; // the representations the running commit made
    this.wrote = new Set(); // uids of nodes of the state before its ops wrote
    this.wantChanges = false; // whether the running commit asked for `changes`
    this.byId = new Map();
    this.root = null;
    if (this.fs) {
      const now = options.now ?? 0;
      this.root = new ModelNode(0, 0, null, '', 0);
      this.byId.set(0, this.root);
      if (this.directories) this.root.payload = this.#dirPayload(0, now, now);
    }
    this.#index();
  }

  // Live nodes by uid: an adapter keeps stable handles by uid, since a
  // commit replaces the model's node objects with copies.
  #index() {
    this.byUid = new Map();
    for (const n of this.nodes()) this.byUid.set(n.uid, n);
  }

  // --- reading -----------------------------------------------------------

  get liveCount() {
    return this.byId.size;
  }

  isContainer(node, containers = this.containers) {
    return this.fs ? node.cls === 0 : containers.includes(node.cls);
  }

  // `lang` in what follows: a language but the main one (0), where a node
  // is by its translation; one without has no name, path or payload there,
  // nor what lies below it. The root is in every language, named ''.
  nameIn(node, lang = 0) {
    if (lang === 0) return node.name;
    if (node.parent === null) return '';
    return node.tr.get(lang)?.name ?? null;
  }

  payloadIn(node, lang = 0) {
    if (lang === 0) return node.payload;
    return node.tr.get(lang)?.payload ?? null;
  }

  pathOf(node, lang = 0) {
    const names = [];
    for (let n = node; n.parent !== null; n = n.parent) {
      const name = this.nameIn(n, lang);
      if (name === null) return null;
      names.push(name);
    }
    return names.length === 0 ? '' : '/' + names.reverse().join('/');
  }

  trailOf(node) {
    const trail = [];
    for (let n = node; n !== null; n = n.parent) trail.push(n);
    return trail.reverse();
  }

  childOf(node, name, lang = 0) {
    return node.kids.find((k) => this.nameIn(k, lang) === name) ?? null;
  }

  // Every live node, pre-order, children in their order.
  *nodes() {
    if (this.root === null) return;
    const stack = [this.root];
    while (stack.length > 0) {
      const n = stack.pop();
      yield n;
      for (let i = n.kids.length - 1; i >= 0; i--) stack.push(n.kids[i]);
    }
  }

  // The node at a canonical key, without policies.
  find(key) {
    if (this.root === null) return null;
    let n = this.root;
    for (const name of namesOf(canonical(key))) {
      n = this.childOf(n, name);
      if (n === null) return null;
    }
    return n;
  }

  // The policies of `trail` top-down, until the first refusal. `log` gets
  // [policy, owner, context] per call. Returns null when all let through, else
  // { owner, decision }.
  #pass(trail, allow, context, log) {
    for (const n of trail) {
      if (!ownPolicy(n.policy)) continue;
      if (log) log.push([n.policy, n, context]);
      const decision = allow(n.policy, n, context);
      if (decision !== true) return { owner: n, decision };
    }
    return null;
  }

  // get/resolve/match: walk the names from the root, passing each existing
  // node's policy as it is reached. Returns
  //   { node } — found and let through;
  //   { denied: { owner, decision } };
  //   { miss: { stop, rest } } — `stop` the deepest existing node (in the FS
  //   also a file the path broke off at), `rest` from the first missing name.
  walkNames(names, options = {}, lang = 0) {
    const { allow, context, log } = options;
    if (this.root === null) return { miss: { stop: null, rest: names } };
    let n = this.root;
    const policies = typeof allow === 'function';
    for (let i = 0; ; i++) {
      if (policies && ownPolicy(n.policy)) {
        if (log) log.push([n.policy, n, context]);
        const decision = allow(n.policy, n, context);
        if (decision !== true) return { denied: { owner: n, decision } };
      }
      if (i === names.length) return { node: n };
      const next = this.childOf(n, names[i], lang);
      if (next === null) return { miss: { stop: n, rest: names.slice(i) } };
      n = next;
    }
  }

  // A string that is not '' and does not start with '/' is no key: EINVAL
  // (QA В41).
  static #keyOf(key) {
    if (typeof key !== 'string' || (key !== '' && key[0] !== '/'))
      throw refusal('EINVAL', -1);
    return canonical(key);
  }

  get(key, options, lang = 0) {
    const r = this.walkNames(namesOf(ModelTree.#keyOf(key)), options, lang);
    if (r.node) return { node: r.node };
    if (r.denied) return { denied: r.denied };
    return { node: null };
  }

  // `abs.slice(from)`: '' or a separator then names; '/' separates, and '\'
  // too when `sep` is '\'.
  resolve(abs, from, sep, options) {
    const rel = abs.slice(from);
    if (rel === '') return this.get('', options);
    const parts = sep === '\\' ? rel.split(/[\\/]/) : rel.split('/');
    const names = parts.slice(1);
    const r = this.walkNames(names, options);
    if (r.node) return { node: r.node };
    if (r.denied) return { denied: r.denied };
    return { node: null };
  }

  match(key, options, lang = 0) {
    const r = this.walkNames(namesOf(ModelTree.#keyOf(key)), options, lang);
    if (r.node) return { node: r.node };
    if (r.denied) return { denied: r.denied };
    return {
      notFound: { node: r.miss.stop, rest: '/' + r.miss.rest.join('/') },
    };
  }

  // check(node, allow, context): the chain by climbing, top-down.
  check(node, allow, context, log) {
    const d = this.#pass(this.trailOf(node), allow, context, log);
    return d === null ? { node } : { denied: d };
  }

  children(node, containers = this.containers, lang = 0) {
    if (this.fs && node.cls === 1) return null;
    return node.kids
      .filter((k) => this.nameIn(k, lang) !== null)
      .map((k) => [this.nameIn(k, lang), this.isContainer(k, containers)]);
  }

  classCount(node, cls) {
    let count = 0;
    const stack = [...node.kids];
    while (stack.length > 0) {
      const n = stack.pop();
      if (n.cls === cls) count++;
      for (const k of n.kids) stack.push(k);
    }
    return count;
  }

  leafCount(node, containers = this.containers) {
    let count = 0;
    const stack = [...node.kids];
    while (stack.length > 0) {
      const n = stack.pop();
      if (!this.isContainer(n, containers)) count++;
      for (const k of n.kids) stack.push(k);
    }
    return count;
  }

  // walk(starts, opts) as the spec states it: the yielded [node, depth] pairs
  // and, in `log`, the calls of `filter` and `descend` in their order.
  walk(starts, opts = {}, containers = this.containers, log = null) {
    const depthMax = opts.depth ?? Infinity;
    const mode = opts.containers ?? 'include';
    const classes = opts.classes ?? null;
    const out = [];
    // Pre-order with an explicit stack (any depth): a node, then its
    // children in order — the same order of filter and descend calls.
    const visit = (first, firstDepth) => {
      const stack = [[first, firstDepth]];
      while (stack.length > 0) {
        const [node, depth] = stack.pop();
        const isCont = this.isContainer(node, containers);
        let selected =
          (mode === 'include' || (mode === 'skip' ? !isCont : isCont)) &&
          (classes === null || classes.includes(node.cls));
        if (selected && opts.filter) {
          if (log) log.push(['filter', node]);
          selected = opts.filter(node) === true;
        }
        if (selected) out.push([node, depth]);
        if (node.kids.length > 0 && depth < depthMax) {
          let down = true;
          if (opts.descend) {
            if (log) log.push(['descend', node]);
            down = opts.descend(node) === true;
          }
          if (down)
            for (let i = node.kids.length - 1; i >= 0; i--)
              stack.push([node.kids[i], depth + 1]);
        }
      }
    };
    for (const s of starts) {
      if (s === null) continue; // a dead start yields nothing
      if (depthMax >= 1) for (const k of s.kids) visit(k, 1);
    }
    return out;
  }

  // The state as a value, to restore after a throw that is not a refusal
  // (a commit replaces root and byId with copies, so the old ones stay intact).
  save() {
    const {
      root,
      byId,
      byUid,
      version,
      structureVersion,
      policyVersion,
      revision,
      nextUid,
      nextId,
    } = this;
    return {
      root,
      byId,
      byUid,
      version,
      structureVersion,
      policyVersion,
      revision,
      nextUid,
      nextId,
    };
  }

  restore(saved) {
    Object.assign(this, saved);
  }

  // An FS tree's ids are the engine's: the test learns them after a commit
  // and gives them to the model (uid → id), so that ops by id — relocate —
  // name the same node in both. A new node's id in the model is provisional
  // until then.
  rekey(ids) {
    let changed = false;
    for (const n of this.nodes()) {
      const id = ids.get(n.uid);
      if (id !== undefined && id !== n.id) {
        n.id = id;
        changed = true;
      }
    }
    if (!changed) return;
    this.byId = new Map();
    for (const n of this.nodes()) this.byId.set(n.id, n);
  }

  // A copy of the whole model, for a generator to try ops on.
  clone() {
    const c = Object.create(ModelTree.prototype);
    return this.#cloneInto(c);
  }

  #cloneInto(target) {
    const copy = new ModelTree({
      ids: this.mode,
      containers: this.containers,
      directories: this.directories,
      birthtime: this.birthtime,
      aggregates: this.aggregates,
      maxNodes: this.maxNodes,
      languages: this.languages,
      segments: this.segments,
    });
    const st = this.#copy();
    copy.root = st.root;
    copy.byId = st.byId;
    copy.version = this.version;
    copy.structureVersion = this.structureVersion;
    copy.policyVersion = this.policyVersion;
    copy.revision = this.revision;
    copy.nextUid = this.nextUid;
    copy.nextId = this.nextId;
    copy.byUid = new Map();
    for (const n of copy.nodes()) copy.byUid.set(n.uid, n);
    void target;
    return copy;
  }

  // --- committing ------------------------------------------------------------

  #dirPayload(version, mtimeMs, birthtimeMs) {
    return new ModelPayload(this.nextUid++, {
      version,
      size: 0,
      mtimeMs,
      birthtimeMs: this.birthtime ? birthtimeMs : undefined,
      reps: new Map(),
      extras: null,
      othersUid: null,
      directory: true,
    });
  }

  // A copy of the state for a commit to work on: new node objects, the same
  // payloads (immutable) and uids. Returns { root, byId, map } where `map`
  // takes an original node to its copy.
  #copy() {
    const map = new Map();
    const byId = new Map();
    let root = null;
    if (this.root !== null) {
      const make = (n, parent) => {
        const c = new ModelNode(n.uid, n.id, parent, n.name, n.cls);
        c.payload = n.payload;
        c.policy = n.policy;
        c.subVer = n.subVer;
        for (const [lang, t] of n.tr) {
          c.tr.set(lang, { name: t.name, payload: t.payload });
        }
        map.set(n, c);
        byId.set(n.id, c);
        return c;
      };
      // An explicit stack: trees of any depth (the stand builds 50 000).
      root = make(this.root, null);
      const stack = [this.root];
      while (stack.length > 0) {
        const n = stack.pop();
        const c = map.get(n);
        c.kids = n.kids.map((k) => make(k, c));
        for (const k of n.kids) stack.push(k);
      }
    }
    return { root, byId, map };
  }

  // The format of a payload input: { size, mtimeMs, birthtimeMs?, meta?,
  // scriptOptions?, representations: [[kind, extent], …] }.
  validPayload(input) {
    if (input === null || typeof input !== 'object') return false;
    const { size, mtimeMs, birthtimeMs, representations } = input;
    if (!Number.isSafeInteger(size) || size < 0) return false;
    if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) return false;
    if (
      birthtimeMs !== undefined &&
      (typeof birthtimeMs !== 'number' || !Number.isFinite(birthtimeMs))
    )
      return false;
    if (!Array.isArray(representations)) return false;
    const seen = new Set();
    for (const pair of representations) {
      if (!Array.isArray(pair) || pair.length !== 2) return false;
      const [kind, extent] = pair;
      if (
        !Number.isInteger(kind) ||
        kind < 0 ||
        kind >= KIND_COUNT ||
        seen.has(kind)
      )
        return false;
      seen.add(kind);
      if (!this.validExtent(extent)) return false;
    }
    return true;
  }

  // A page: [[kind, extent], …] of the page's kinds, each once; [] for none.
  validPage(page) {
    if (!Array.isArray(page)) return false;
    const seen = new Set();
    for (const pair of page) {
      if (!Array.isArray(pair) || pair.length !== 2) return false;
      const [kind, extent] = pair;
      if (!PAGE_KINDS.has(kind) || seen.has(kind)) return false;
      seen.add(kind);
      if (!this.validExtent(extent)) return false;
    }
    return true;
  }

  // The language of a refusal: none in a tree of one.
  langOf(lang) {
    return this.languages > 1 ? lang : undefined;
  }

  isLang(lang) {
    return Number.isInteger(lang) && lang >= 0 && lang < this.languages;
  }

  // The translations of a put or a row — [[lang, null | { name, payload,
  // page }], …] — as a Map, null when it states none; EINVAL at `index`,
  // with the language when the record is the fault.
  translationsOf(list, root, index) {
    if (list === undefined) return null;
    if (this.languages === 1 || !Array.isArray(list))
      throw refusal('EINVAL', index);
    const tr = new Map();
    for (const entry of list) {
      const lang = Array.isArray(entry) && entry.length === 2 ? entry[0] : -1;
      if (lang === 0 || !this.isLang(lang) || tr.has(lang))
        throw refusal('EINVAL', index);
      const said = entry[1];
      if (said !== null) {
        let good = typeof said === 'object';
        if (good) {
          const { name, payload, page } = said;
          const data = payload !== undefined && payload !== null;
          if (name !== undefined && !(root ? name === '' : isName(name)))
            good = false;
          if (data && !this.validPayload(payload)) good = false;
          if (page !== undefined && (data || !this.validPage(page)))
            good = false;
        }
        if (!good) throw refusal('EINVAL', index, undefined, lang);
      }
      tr.set(lang, said);
    }
    return tr;
  }

  validExtent(e) {
    if (e === null || typeof e !== 'object') return false;
    const { segmentId, offset, length } = e;
    if (
      ![segmentId, offset, length].every(
        (v) => Number.isSafeInteger(v) && v >= 0,
      )
    )
      return false;
    if (length === 0) return segmentId === 0 && offset === 0;
    const sab = this.segments.get(segmentId);
    if (sab === undefined) return false;
    return offset + length <= sab.byteLength;
  }

  #newPayload(input, version, previous, isNew) {
    const reps = new Map();
    const sorted = [...input.representations].sort((a, b) => a[0] - b[0]);
    for (const [kind, e] of sorted) {
      const rep = {
        kind,
        segmentId: e.segmentId,
        offset: e.offset,
        length: e.length,
        uid: this.nextUid++,
      };
      reps.set(kind, rep);
      this.made.push(rep);
    }
    let birthtimeMs;
    if (this.birthtime) {
      if (input.birthtimeMs !== undefined) birthtimeMs = input.birthtimeMs;
      else if (
        !isNew &&
        previous !== null &&
        previous.birthtimeMs !== undefined
      )
        birthtimeMs = previous.birthtimeMs;
      else birthtimeMs = input.mtimeMs;
    }
    const hasMeta = input.meta !== undefined;
    const hasScript = input.scriptOptions !== undefined;
    const extras =
      hasMeta || hasScript
        ? {
            meta: hasMeta ? input.meta : null,
            scriptOptions: hasScript ? input.scriptOptions : null,
          }
        : null;
    const derived = [...reps.keys()].some((k) => k !== 0);
    return new ModelPayload(this.nextUid++, {
      version,
      size: input.size,
      mtimeMs: input.mtimeMs,
      birthtimeMs,
      reps,
      extras,
      othersUid: derived ? this.nextUid++ : null,
    });
  }

  // A relocation: a new representation of `kind`, a new payload with the same
  // attributes and extras; a relocated source keeps the `others` object, a
  // derived one gets a new `others`.
  #relocated(payload, kind, extent) {
    const reps = new Map(payload.reps);
    const rep = {
      kind,
      segmentId: extent.segmentId,
      offset: extent.offset,
      length: extent.length,
      uid: this.nextUid++,
    };
    reps.set(kind, rep);
    this.made.push(rep);
    return new ModelPayload(this.nextUid++, {
      version: payload.version,
      size: payload.size,
      mtimeMs: payload.mtimeMs,
      birthtimeMs: payload.birthtimeMs,
      reps,
      extras: payload.extras,
      othersUid: kind === 0 ? payload.othersUid : this.nextUid++,
      directory: payload.directory,
    });
  }

  // A payload's page replaced (RENDER): the page's kinds those of `page`,
  // the other representations the same, a new payload of `version` with the
  // attributes and extras of the data. null when nothing changes: no
  // page where there was none.
  #rendered(payload, page, version) {
    const had =
      payload !== null &&
      [...payload.reps.keys()].some((k) => PAGE_KINDS.has(k));
    if (page.length === 0 && !had) return null;
    const reps = new Map();
    for (const [kind, rep] of payload.reps) {
      if (!PAGE_KINDS.has(kind)) reps.set(kind, rep);
    }
    for (const [kind, e] of page) {
      const rep = {
        kind,
        segmentId: e.segmentId,
        offset: e.offset,
        length: e.length,
        uid: this.nextUid++,
      };
      reps.set(kind, rep);
      this.made.push(rep);
    }
    const sorted = new Map([...reps].sort((a, b) => a[0] - b[0]));
    const derived = [...sorted.keys()].some((k) => k !== 0);
    return new ModelPayload(this.nextUid++, {
      version,
      size: payload.size,
      mtimeMs: payload.mtimeMs,
      birthtimeMs: payload.birthtimeMs,
      reps: sorted,
      extras: payload.extras,
      othersUid: derived ? this.nextUid++ : null,
    });
  }

  // The representations a state publishes, by identity: uid → { id, rep,
  // lang }.
  static published(root) {
    const out = new Map();
    if (root === null) return out;
    const stack = [root];
    const add = (id, payload, lang) => {
      if (payload === null) return;
      for (const rep of payload.reps.values()) {
        if (!isEmptyExtent(rep)) out.set(rep.uid, { id, rep, lang });
      }
    };
    while (stack.length > 0) {
      const n = stack.pop();
      add(n.id, n.payload, 0);
      for (const [lang, t] of n.tr) add(n.id, t.payload, lang);
      for (const k of n.kids) stack.push(k);
    }
    return out;
  }

  #checkArgs(ops, next, now, options) {
    if (!Array.isArray(ops)) throw refusal('EINVAL', -1);
    if (!Number.isSafeInteger(next) || next < this.version)
      throw refusal('EINVAL', -1);
    if (typeof now !== 'number' || !Number.isFinite(now))
      throw refusal('EINVAL', -1);
    // options: nothing, or { changes: boolean }
    let changes = false;
    if (options !== undefined) {
      if (options === null || typeof options !== 'object')
        throw refusal('EINVAL', -1);
      if (options.changes !== undefined) {
        if (typeof options.changes !== 'boolean') throw refusal('EINVAL', -1);
        changes = options.changes;
      }
    }
    this.wantChanges = changes;
    this.made = [];
    this.wrote = new Set();
  }

  // Apply `ops` atomically. Throws a refusal ({ code, index, other? }) and
  // changes nothing; else returns the outcome:
  //   { delta: boolean, versioned, structure, policy,
  //     retired: [{ id, kind, uid, extent }], dropped: [extent],
  //     placed: [{ id, kind, extent }], changes }
  // where an extent is extentKey() of one, and `changes`, with `{ changes:
  // true }` in `options`, what the commit did to its nodes (#changes) —
  // else null.
  commit(ops, next, now, options) {
    this.#checkArgs(ops, next, now, options);
    const result = this.fs
      ? this.#commitFs(ops, next, now)
      : this.#commitClient(ops, next, now);
    return result;
  }

  // ----- FS trees ----------------------------------------------------------

  #commitFs(ops, next, now) {
    const st = this.#copy();
    const before = ModelTree.published(this.root);
    let count = st.byId.size;
    let nextId = this.nextId;
    const saveUid = this.nextUid;
    let changed = false; // anything but relocation
    let relocated = false;
    let structure = false;
    const touchedDirs = new Set(); // directories whose children changed
    const createdDirs = new Set();
    const marks = new Set(); // nodes whose subtree version takes `next`
    const findIn = (key) => {
      let n = st.root;
      for (const name of namesOf(key)) {
        n = n.kids.find((k) => k.name === name) ?? null;
        if (n === null) return null;
      }
      return n;
    };
    const leafName = (key) => key.slice(key.lastIndexOf('/') + 1);
    const isDir = (n) => n.cls === 0;
    const takeId = () => {
      // ids from the counter, wrapping at 2^30-1 to the next id no live node
      // holds; an id freed in this commit is not given again in it (the model
      // never frees into the counter: it only grows within a run).
      let id = nextId;
      while (st.byId.has(id) || id === 0) id = id >= SMALL - 1 ? 1 : id + 1;
      nextId = id >= SMALL - 1 ? 1 : id + 1;
      return id;
    };
    const ancestorsMark = (n) => {
      // a mark always reaches the root: an ancestor marked has all above it
      for (let a = n; a !== null && !marks.has(a); a = a.parent) marks.add(a);
    };
    // The parent of a key, walking down from the root: the first component
    // above the key that is not an existing directory decides — missing →
    // ENOENT, a file → ENOTDIR, as on Linux (QA В41).
    const parentOf = (key, index) => {
      const names = namesOf(key);
      let n = st.root;
      for (let at = 0; at < names.length - 1; at++) {
        const kid = n.kids.find((k) => k.name === names[at]) ?? null;
        if (kid === null) throw refusal('ENOENT', index);
        if (!isDir(kid)) throw refusal('ENOTDIR', index);
        n = kid;
      }
      return n;
    };
    const create = (parent, name, cls) => {
      const n = new ModelNode(this.nextUid++, takeId(), parent, name, cls);
      parent.kids.push(n);
      st.byId.set(n.id, n);
      count++;
      touchedDirs.add(parent);
      ancestorsMark(n);
      structure = true;
      changed = true;
      return n;
    };
    const detach = (n) => {
      const p = n.parent;
      p.kids.splice(p.kids.indexOf(n), 1);
      touchedDirs.add(p);
      ancestorsMark(p);
      structure = true;
      changed = true;
    };
    const killSubtree = (n) => {
      const stack = [n];
      while (stack.length > 0) {
        const m = stack.pop();
        st.byId.delete(m.id);
        count--;
        touchedDirs.delete(m);
        createdDirs.delete(m);
        marks.delete(m);
        for (const k of m.kids) stack.push(k);
      }
    };
    try {
      ops.forEach((op, index) => {
        if (!Array.isArray(op) || typeof op[0] !== 'string')
          throw refusal('EINVAL', index);
        const name = op[0];
        switch (name) {
          case 'mkdir': {
            if (op.length !== 2 || !isKey(op[1]))
              throw refusal('EINVAL', index);
            const key = canonical(op[1]);
            if (key === '') throw refusal('EEXIST', index);
            const parent = parentOf(key, index);
            if (parent.kids.some((k) => k.name === leafName(key)))
              throw refusal('EEXIST', index);
            if (count + 1 > this.maxNodes) throw refusal('ENOSPC', index);
            const n = create(parent, leafName(key), 0);
            createdDirs.add(n);
            return;
          }
          case 'write': {
            if (op.length < 3 || op.length > 4 || !isKey(op[1]))
              throw refusal('EINVAL', index);
            const options = op[3];
            if (
              options !== undefined &&
              (options === null || typeof options !== 'object')
            )
              throw refusal('EINVAL', index);
            if (!this.validPayload(op[2])) throw refusal('EINVAL', index);
            const key = canonical(op[1]);
            if (key === '') throw refusal('EISDIR', index);
            const names = namesOf(key);
            const parents = options?.parents === true;
            // The directories to create above the key, and the parent.
            let n = st.root;
            let missing = 0;
            let at = 0;
            for (; at < names.length - 1; at++) {
              const name = names[at];
              const kid = n.kids.find((k) => k.name === name) ?? null;
              if (kid === null) break;
              if (!isDir(kid)) throw refusal('ENOTDIR', index);
              n = kid;
            }
            if (at < names.length - 1) {
              if (!parents) throw refusal('ENOENT', index);
              missing = names.length - 1 - at;
            }
            const existing =
              missing === 0
                ? (n.kids.find((k) => k.name === names[names.length - 1]) ??
                  null)
                : null;
            if (existing !== null && isDir(existing))
              throw refusal('EISDIR', index);
            const creates = missing + (existing === null ? 1 : 0);
            if (count + creates > this.maxNodes) throw refusal('ENOSPC', index);
            for (; at < names.length - 1; at++) {
              const d = create(n, names[at], 0);
              createdDirs.add(d);
              n = d;
            }
            if (existing !== null) {
              this.wrote.add(existing.uid);
              existing.payload = this.#newPayload(
                op[2],
                next,
                existing.payload,
                false,
              );
              ancestorsMark(existing);
              changed = true;
            } else {
              const f = create(n, names[names.length - 1], 1);
              f.payload = this.#newPayload(op[2], next, null, true);
            }
            return;
          }
          case 'move': {
            if (op.length !== 3 || !isKey(op[1]) || !isKey(op[2]))
              throw refusal('EINVAL', index);
            const key = canonical(op[1]);
            const to = canonical(op[2]);
            if (key === '') throw refusal('EINVAL', index);
            const node = findIn(key);
            if (node === null) throw refusal('ENOENT', index);
            if (to === key) return;
            if (to === '' || to.startsWith(key + '/'))
              throw refusal('EINVAL', index);
            const parent = parentOf(to, index);
            if (parent.kids.some((k) => k.name === leafName(to)))
              throw refusal('EEXIST', index);
            detach(node);
            node.parent = parent;
            node.name = own(leafName(to));
            parent.kids.push(node);
            touchedDirs.add(parent);
            ancestorsMark(parent);
            return;
          }
          case 'unlink':
          case 'remove':
          case 'rmdir': {
            if (op.length !== 2 || !isKey(op[1]))
              throw refusal('EINVAL', index);
            const key = canonical(op[1]);
            if (key === '') throw refusal('EINVAL', index);
            const node = findIn(key);
            if (node === null) throw refusal('ENOENT', index);
            if (name === 'unlink' && isDir(node))
              throw refusal('EISDIR', index);
            if (name === 'rmdir') {
              if (!isDir(node)) throw refusal('ENOTDIR', index);
              if (node.kids.length > 0) throw refusal('ENOTEMPTY', index);
            }
            detach(node);
            killSubtree(node);
            return;
          }
          case 'relocate': {
            if (op.length !== 4) throw refusal('EINVAL', index);
            const [, id, kind, extent] = op;
            if (!Number.isInteger(id) || id < 0) throw refusal('EINVAL', index);
            if (!Number.isInteger(kind) || kind < 0 || kind >= KIND_COUNT)
              throw refusal('EINVAL', index);
            if (!this.validExtent(extent)) throw refusal('EINVAL', index);
            const node = st.byId.get(id) ?? null;
            if (node === null) throw refusal('ENOENT', index);
            if (isDir(node)) throw refusal('EISDIR', index);
            if (node.payload === null || !node.payload.reps.has(kind))
              throw refusal('ENOENT', index);
            node.payload = this.#relocated(node.payload, kind, extent);
            relocated = true;
            return;
          }
          default:
            throw refusal('EINVAL', index);
        }
      });
    } catch (err) {
      this.nextUid = saveUid;
      throw err;
    }
    // Directory attributes: one new payload per changed directory per commit.
    if (this.directories) {
      for (const d of touchedDirs) {
        if (!st.byId.has(d.id) || st.byId.get(d.id) !== d) continue;
        const birth = createdDirs.has(d)
          ? now
          : (d.payload?.birthtimeMs ?? now);
        d.payload = this.#dirPayload(next, now, birth);
      }
      for (const d of createdDirs) {
        if (touchedDirs.has(d)) continue;
        d.payload = this.#dirPayload(next, now, now);
      }
    }
    return this.#finish(st, before, {
      changed,
      relocated,
      structure,
      policy: false,
      marks,
      next,
      nextId,
    });
  }

  // The common end of a successful commit: swap the state in, take the
  // version, set the numbers and the subtree versions, list what retired
  // — published before, not after — what dropped: what the commit made
  // and the state after does not publish, published to no one — and what
  // it placed: what it made that the state after publishes, with the id
  // of the node that holds it.
  // What a commit did to its nodes, as the engine reports it when asked:
  // the ids of the nodes it made that live after it; of the nodes that
  // lived before and live after and got a payload of its ops; the nodes
  // that lived before and live after under another parent or name, keyed
  // as before; every node of the state before that dies, keyed as before,
  // with its class. Before: this tree as it stands; after: `st`.
  #changes(st) {
    const was = new Map();
    for (const n of this.nodes()) was.set(n.uid, n);
    const created = [];
    const changed = [];
    const moved = [];
    const live = new Set();
    const stack = st.root === null ? [] : [st.root];
    while (stack.length > 0) {
      const n = stack.pop();
      live.add(n.uid);
      for (const k of n.kids) stack.push(k);
      const before = was.get(n.uid);
      if (before === undefined) {
        created.push(n.id);
        continue;
      }
      if (this.wrote.has(n.uid)) changed.push(n.id);
      const from = before.parent === null ? null : before.parent.uid;
      const to = n.parent === null ? null : n.parent.uid;
      if (from !== to || before.name !== n.name)
        moved.push({ id: n.id, from: this.pathOf(before) });
    }
    const removed = [];
    for (const [uid, n] of was) {
      if (!live.has(uid))
        removed.push({ id: n.id, key: this.pathOf(n), cls: n.cls });
    }
    return { created, changed, moved, removed };
  }

  #finish(st, before, f) {
    const changes = this.wantChanges ? this.#changes(st) : null;
    const after = ModelTree.published(st.root);
    const retired = [];
    for (const [uid, { id, rep, lang }] of before) {
      if (!after.has(uid))
        retired.push({ id, kind: rep.kind, uid, extent: extentKey(rep), lang });
    }
    const dropped = [];
    const placed = [];
    for (const rep of this.made) {
      if (isEmptyExtent(rep)) continue;
      const owner = after.get(rep.uid);
      if (owner === undefined) dropped.push(extentKey(rep));
      else
        placed.push({
          id: owner.id,
          kind: rep.kind,
          extent: extentKey(rep),
          lang: owner.lang,
        });
    }
    const delta = f.changed || f.relocated;
    if (f.changed) {
      if (this.aggregates.subtreeVersion)
        for (const n of f.marks) n.subVer = f.next;
      this.version = f.next;
      if (f.structure) this.structureVersion = f.next;
      if (f.policy) this.policyVersion = f.next;
    }
    if (delta) this.revision++;
    this.root = st.root;
    this.byId = st.byId;
    this.#index();
    if (f.nextId !== undefined) this.nextId = f.nextId;
    return {
      delta,
      versioned: f.changed,
      structure: f.changed && f.structure,
      policy: f.changed && f.policy,
      retired,
      dropped,
      placed,
      changes,
    };
  }

  // ----- id trees -------------------------------------------------------------

  isId(id) {
    return this.mode === 'number'
      ? Number.isSafeInteger(id)
      : typeof id === 'string';
  }

  // The format of a page in a put or a row: a page comes without the data
  // it renders — the page of new data is among the data's representations.
  #pageFormat(fields, index) {
    if (fields.page === undefined) return;
    const data = fields.payload !== undefined && fields.payload !== null;
    if (data || !this.validPage(fields.page)) throw refusal('EINVAL', index);
  }

  #commitClient(ops, next, now) {
    // Group 1: in the order of the ops.
    const named = new Set();
    const pinned = new Set(); // `${id}|${lang}|${kind}` of relocations, renders
    let rootId = this.root === null ? null : this.root.id;
    let kind = null; // 'relocate', 'render' or 'change', from the first op
    const puts = [];
    const removes = [];
    const relocs = [];
    const renders = [];
    const once = (id, at, index) => {
      const key = `${typeof id}:${id}|${at}`;
      if (pinned.has(key)) throw refusal('EINVAL', index);
      pinned.add(key);
    };
    ops.forEach((op, index) => {
      if (!Array.isArray(op) || typeof op[0] !== 'string')
        throw refusal('EINVAL', index);
      const name = op[0];
      if (name === 'put') {
        if (op.length !== 5) throw refusal('EINVAL', index);
        const [, id, parentId, nodeName, fields] = op;
        if (!this.isId(id)) throw refusal('EINVAL', index);
        if (parentId !== null && !this.isId(parentId))
          throw refusal('EINVAL', index);
        if (fields === null || typeof fields !== 'object')
          throw refusal('EINVAL', index);
        if (parentId === null ? nodeName !== '' : !isName(nodeName))
          throw refusal('EINVAL', index);
        if (fields.class !== undefined && !isClass(fields.class))
          throw refusal('EINVAL', index);
        if (
          fields.payload !== undefined &&
          fields.payload !== null &&
          !this.validPayload(fields.payload)
        )
          throw refusal('EINVAL', index);
        this.#pageFormat(fields, index);
        const tr = this.translationsOf(
          fields.translations,
          parentId === null,
          index,
        );
        if (named.has(id)) throw refusal('EINVAL', index);
        named.add(id);
        // The root rules: a root exists when it existed or a lower put made it.
        if (parentId === null) {
          if (rootId !== null && rootId !== id) throw refusal('EEXIST', index);
          rootId = id;
        } else if (rootId !== null && id === rootId) {
          throw refusal('EINVAL', index);
        }
        const exists = this.byId.has(id);
        if (!exists && fields.class === undefined)
          throw refusal('EINVAL', index);
        if (kind === null) kind = 'change';
        else if (kind !== 'change') throw refusal('EINVAL', index);
        puts.push({ index, id, parentId, name: nodeName, fields, exists, tr });
        return;
      }
      if (name === 'remove') {
        if (op.length !== 2) throw refusal('EINVAL', index);
        const id = op[1];
        if (!this.isId(id)) throw refusal('EINVAL', index);
        if (named.has(id)) throw refusal('EINVAL', index);
        named.add(id);
        if (this.root !== null && id === this.root.id)
          throw refusal('EINVAL', index);
        if (kind === null) kind = 'change';
        else if (kind !== 'change') throw refusal('EINVAL', index);
        removes.push({ index, id });
        return;
      }
      if (name === 'relocate') {
        if (op.length !== 4 && op.length !== 5) throw refusal('EINVAL', index);
        const [, id, k, extent] = op;
        const lang = op[4] === undefined ? 0 : op[4];
        if (!this.isId(id)) throw refusal('EINVAL', index);
        if (!Number.isInteger(k) || k < 0 || k >= KIND_COUNT)
          throw refusal('EINVAL', index);
        if (!this.isLang(lang)) throw refusal('EINVAL', index);
        if (!this.validExtent(extent)) throw refusal('EINVAL', index);
        // each representation once: a node may have several in a segment
        once(id, `${lang}:${k}`, index);
        if (kind === null) kind = 'relocate';
        else if (kind !== 'relocate') throw refusal('EINVAL', index);
        const node = this.byId.get(id) ?? null;
        if (node === null) throw refusal('ENOENT', index);
        const payload = this.payloadIn(node, lang);
        if (payload === null || !payload.reps.has(k))
          throw refusal('ENOENT', index, undefined, this.langOf(lang));
        relocs.push({ index, id, kind: k, extent, lang });
        return;
      }
      if (name === 'render') {
        if (op.length !== 4) throw refusal('EINVAL', index);
        const [, id, lang, page] = op;
        if (!this.isId(id) || !this.isLang(lang))
          throw refusal('EINVAL', index);
        if (!this.validPage(page)) throw refusal('EINVAL', index);
        once(id, lang, index);
        if (kind === null) kind = 'render';
        else if (kind !== 'render') throw refusal('EINVAL', index);
        const node = this.byId.get(id) ?? null;
        if (node === null) throw refusal('ENOENT', index);
        if (this.payloadIn(node, lang) === null && page.length > 0)
          throw refusal('ENOENT', index, undefined, this.langOf(lang));
        renders.push({ id, lang, page });
        return;
      }
      throw refusal('EINVAL', index);
    });
    if (kind === 'relocate') return this.#relocateClient(relocs);
    if (kind === 'render') return this.#renderClient(renders, next);
    return this.#finalState(puts, removes, next, now, false);
  }

  #relocateClient(relocs) {
    const st = this.#copy();
    const before = ModelTree.published(this.root);
    for (const r of relocs) {
      const node = st.byId.get(r.id);
      if (r.lang === 0) {
        node.payload = this.#relocated(node.payload, r.kind, r.extent);
      } else {
        const t = node.tr.get(r.lang);
        t.payload = this.#relocated(t.payload, r.kind, r.extent);
      }
    }
    return this.#finish(st, before, {
      changed: false,
      relocated: relocs.length > 0,
      structure: false,
      policy: false,
      marks: new Set(),
      next: this.version,
    });
  }

  // Pages, from any thread after a render: each a new payload of its
  // language with the page replaced, or nothing — no page where there was
  // none. The data and the place stay.
  #renderClient(renders, next) {
    const st = this.#copy();
    const before = ModelTree.published(this.root);
    const marks = new Set();
    let changed = false;
    for (const { id, lang, page } of renders) {
      const n = st.byId.get(id);
      const t = lang === 0 ? null : n.tr.get(lang);
      const fresh = this.#rendered(
        lang === 0 ? n.payload : (t?.payload ?? null),
        page,
        next,
      );
      if (fresh === null) continue;
      if (lang === 0) n.payload = fresh;
      else t.payload = fresh;
      this.wrote.add(n.uid);
      for (let a = n; a !== null && !marks.has(a); a = a.parent) marks.add(a);
      changed = true;
    }
    return this.#finish(st, before, {
      changed,
      relocated: false,
      structure: false,
      policy: false,
      marks,
      next,
    });
  }

  // The final state of puts and removes (a commit or a load). `load` removes
  // every node whose id is not in the rows.
  #finalState(puts, removes, next, now, isLoad) {
    const putById = new Map(puts.map((p) => [p.id, p]));
    const removeIds = new Set(removes.map((r) => r.id));
    if (isLoad) {
      for (const id of this.byId.keys())
        if (!putById.has(id)) removeIds.add(id);
    }
    // Final parent and name of every node that exists after: existing nodes
    // keep theirs unless put; new ids come from puts.
    const finalParent = new Map();
    const finalName = new Map();
    const ids = new Set([...this.byId.keys(), ...putById.keys()]);
    for (const id of ids) {
      const p = putById.get(id);
      if (p) {
        finalParent.set(id, p.parentId);
        finalName.set(id, p.name);
      } else {
        const n = this.byId.get(id);
        finalParent.set(id, n.parent === null ? null : n.parent.id);
        finalName.set(id, n.name);
      }
    }
    // Liveness: removed nodes are dead; put nodes alive; others alive when
    // their final parent is alive; the root (no parent) alive.
    // A climb, not recursion: chains of any length; each id is decided once.
    const aliveMemo = new Map();
    const aliveOf = (start) => {
      const path = [];
      const onPath = new Set();
      let id = start;
      let alive;
      for (;;) {
        if (aliveMemo.has(id)) {
          alive = aliveMemo.get(id);
          break;
        }
        if (!ids.has(id) || removeIds.has(id)) {
          alive = false;
          break;
        }
        if (putById.has(id) || finalParent.get(id) === null) {
          alive = true;
          break;
        }
        if (onPath.has(id)) {
          alive = false; // a cycle of unnamed nodes cannot happen; guard
          break;
        }
        onPath.add(id);
        path.push(id);
        id = finalParent.get(id);
      }
      if (ids.has(id)) aliveMemo.set(id, alive);
      for (const x of path) aliveMemo.set(x, alive);
      return alive;
    };
    // Violations, per put: ENOENT (parent not alive), EINVAL (on a cycle),
    // EEXIST (name taken).
    const violations = new Map(); // index → { code, other? } — the first rule it breaks
    const putsByIndex = [...puts].sort((a, b) => a.index - b.index);
    // ENOENT
    for (const p of putsByIndex) {
      if (p.parentId === null) continue;
      if (!aliveOf(p.parentId)) violations.set(p.index, { code: 'ENOENT' });
    }
    // EINVAL — a put node on a cycle by the final parents. Each id is climbed
    // over once: a climb stops at an id already decided, and the ids of a
    // cycle it closes are the ones on it (a node leading into a cycle is not).
    const onCycle = new Set();
    const decided = new Set();
    for (const p of putsByIndex) {
      const path = [];
      const at = new Map(); // id → its place in path
      let id = p.id;
      while (
        id !== null &&
        id !== undefined &&
        ids.has(id) &&
        !decided.has(id) &&
        !at.has(id)
      ) {
        at.set(id, path.length);
        path.push(id);
        id = finalParent.get(id);
      }
      if (at.has(id))
        for (let i = at.get(id); i < path.length; i++) onCycle.add(path[i]);
      for (const x of path) decided.add(x);
    }
    for (const p of putsByIndex) {
      if (violations.has(p.index)) continue;
      if (onCycle.has(p.id)) violations.set(p.index, { code: 'EINVAL' });
    }
    // EEXIST — live children's names under each parent.
    const groups = new Map(); // `${parent}\0${name}` → [ids]
    for (const id of ids) {
      if (!aliveOf(id)) continue;
      const parent = finalParent.get(id);
      if (parent === null) continue;
      const k = `${typeof parent}:${parent}\0${finalName.get(id)}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(id);
    }
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      // The one that had the name before and keeps it.
      const keeper = members.find((id) => {
        const n = this.byId.get(id);
        if (n === undefined || n.parent === null) return false;
        return (
          n.parent.id === finalParent.get(id) && n.name === finalName.get(id)
        );
      });
      const violators = members.filter(
        (id) => id !== keeper && putById.has(id),
      );
      for (const id of violators) {
        const p = putById.get(id);
        if (violations.has(p.index)) continue;
        let other;
        if (keeper !== undefined) other = keeper;
        else {
          const others = violators
            .filter((v) => v !== id)
            .map((v) => putById.get(v))
            .sort((a, b) => a.index - b.index);
          other = others.length > 0 ? others[0].id : undefined;
        }
        violations.set(p.index, { code: 'EEXIST', other, lang: 0 });
      }
    }
    // The name of a node in a language but the main one after the commit,
    // or null: the one its put states, else the one it has. The root's is
    // '' — a node that becomes the root takes it, one that leaves the root
    // has none — and the root has a translation it states data of.
    const nameAfter = (id, lang) => {
      const n = this.byId.get(id) ?? null;
      const t = n === null ? null : (n.tr.get(lang) ?? null);
      const p = putById.get(id);
      if (p === undefined) return t === null ? null : t.name;
      const said = p.tr === null ? undefined : p.tr.get(lang);
      if (said === null) return null;
      if (said !== undefined && said.name !== undefined) return said.name;
      const root = p.parentId === null;
      if (t === null)
        return root && said !== undefined && states(said) ? '' : null;
      if (root) return '';
      return t.name === '' ? null : t.name;
    };
    // EEXIST in each language, by ascending index: live children of one
    // name there under one parent, the one that had it and keeps it the
    // keeper.
    for (let lang = 1; lang < this.languages; lang++) {
      const byName = new Map();
      for (const id of ids) {
        if (!aliveOf(id)) continue;
        const parent = finalParent.get(id);
        if (parent === null) continue;
        const name = nameAfter(id, lang);
        if (name === null) continue;
        const k = `${typeof parent}:${parent}\0${name}`;
        if (!byName.has(k)) byName.set(k, []);
        byName.get(k).push(id);
      }
      for (const members of byName.values()) {
        if (members.length < 2) continue;
        const keeper = members.find((id) => {
          const n = this.byId.get(id);
          if (n === undefined || n.parent === null) return false;
          if (n.parent.id !== finalParent.get(id)) return false;
          return (n.tr.get(lang)?.name ?? null) === nameAfter(id, lang);
        });
        const violators = members
          .filter((id) => id !== keeper && putById.has(id))
          .map((id) => putById.get(id))
          .sort((a, b) => a.index - b.index);
        for (const p of violators) {
          if (violations.has(p.index)) continue;
          let other = keeper;
          if (other === undefined)
            other = violators.find((v) => v !== p)?.id ?? undefined;
          violations.set(p.index, { code: 'EEXIST', other, lang });
        }
      }
    }
    // ENOENT, in a language, for what the final state cannot hold: a page
    // without the data it renders, a translation with data or a page and
    // no name; the former root under a parent, where '' is no name.
    const unstated = (p) => {
      const n = this.byId.get(p.id) ?? null;
      const { fields } = p;
      if (fields.page !== undefined && fields.page.length > 0) {
        if (fields.payload === null || n === null || n.payload === null)
          return { code: 'ENOENT', lang: 0 };
      }
      if (p.tr !== null) {
        for (const [lang, said] of p.tr) {
          if (said === null) continue;
          const t = n === null ? null : (n.tr.get(lang) ?? null);
          if ((t !== null || states(said)) && nameAfter(p.id, lang) === null)
            return { code: 'ENOENT', lang };
          if (said.page !== undefined && said.page.length > 0) {
            if (said.payload === null || t === null || t.payload === null)
              return { code: 'ENOENT', lang };
          }
        }
      }
      if (p.parentId !== null && n !== null && n.parent === null) {
        for (let lang = 1; lang < this.languages; lang++) {
          if (n.tr.has(lang) && (p.tr === null || !p.tr.has(lang)))
            return { code: 'ENOENT', lang };
        }
      }
      return null;
    };
    for (const p of putsByIndex) {
      if (violations.has(p.index)) continue;
      const v = unstated(p);
      if (v !== null) violations.set(p.index, v);
    }
    if (violations.size > 0) {
      const index = Math.min(...violations.keys());
      const v = violations.get(index);
      const other = v.code === 'EEXIST' ? v.other : undefined;
      throw refusal(v.code, index, other, this.langOf(v.lang));
    }
    // ENOSPC — the bound on the final state; removals before creations.
    let live = 0;
    for (const id of this.byId.keys()) if (aliveOf(id)) live++;
    for (const p of putsByIndex) {
      if (p.exists) continue;
      live++;
      if (live > this.maxNodes) throw refusal('ENOSPC', p.index);
    }
    // Apply: build the new state.
    const st = this.#copy();
    const before = ModelTree.published(this.root);
    const marks = new Set();
    let changed = false;
    let structure = false;
    let policy = false;
    const markUp = (n) => {
      // a mark always reaches the root: an ancestor marked has all above it
      for (let a = n; a !== null && !marks.has(a); a = a.parent) marks.add(a);
    };
    // What a put states of the other languages, on its node `n` of the new
    // state: a change of a name a change of the structure, every change one
    // of the node itself. A node that becomes the root takes '' in every
    // language the put leaves as it is.
    const translate = (p, n, becomesRoot) => {
      const touched = () => {
        markUp(n);
        changed = true;
      };
      if (p.tr !== null) {
        for (const [lang, said] of p.tr) {
          const t = n.tr.get(lang) ?? null;
          if (said === null) {
            if (t === null) continue;
            n.tr.delete(lang);
            if (t.payload !== null) this.wrote.add(n.uid);
            touched();
            structure = true;
            continue;
          }
          const name = nameAfter(p.id, lang);
          if (name === null) continue;
          let tt = t;
          if (tt === null) {
            tt = { name: own(name), payload: null };
            n.tr.set(lang, tt);
          }
          if (tt !== t || tt.name !== name) {
            tt.name = own(name);
            touched();
            structure = true;
          }
          if (said.payload === null) {
            if (tt.payload === null) continue;
            tt.payload = null;
          } else if (said.payload !== undefined) {
            tt.payload = this.#newPayload(
              said.payload,
              next,
              tt.payload,
              false,
            );
          } else if (said.page !== undefined) {
            const fresh = this.#rendered(tt.payload, said.page, next);
            if (fresh === null) continue;
            tt.payload = fresh;
          } else {
            continue;
          }
          this.wrote.add(n.uid);
          touched();
        }
      }
      if (!becomesRoot) return;
      for (const [lang, t] of n.tr) {
        if (t.name === '' || (p.tr !== null && p.tr.has(lang))) continue;
        t.name = '';
        touched();
        structure = true;
      }
    };
    // Removals: nodes not alive after the commit.
    for (const [id, n] of [...st.byId]) {
      if (aliveOf(id)) continue;
      st.byId.delete(id);
      if (ownPolicy(n.policy)) policy = true;
      changed = true;
      structure = true;
    }
    // Detach dead nodes from live parents, marking the live ancestors.
    for (const n of [...this.byId.values()]) {
      if (aliveOf(n.id)) continue;
      const c = st.map.get(n);
      const p = c.parent;
      if (p !== null && aliveOf(p.id)) {
        p.kids.splice(p.kids.indexOf(c), 1);
        markUp(p);
      }
    }
    // Moves and renames, then creations: attached in ascending index.
    for (const p of putsByIndex) {
      const existing = st.byId.get(p.id) ?? null;
      if (existing !== null) {
        const oldParent = existing.parent;
        const moved =
          p.parentId === null
            ? oldParent !== null
            : oldParent === null ||
              oldParent.id !== p.parentId ||
              existing.name !== p.name;
        // A load may change the root: the former root comes under a parent,
        // another node becomes the root (QA В41).
        if (moved) {
          if (oldParent !== null) {
            oldParent.kids.splice(oldParent.kids.indexOf(existing), 1);
            markUp(oldParent);
          }
          existing._pendingParent = p.parentId;
          existing.name = own(p.name);
          changed = true;
          structure = true;
        }
      }
    }
    for (const p of putsByIndex) {
      let n = st.byId.get(p.id) ?? null;
      if (n === null) {
        n = new ModelNode(this.nextUid++, p.id, null, p.name, p.fields.class);
        st.byId.set(n.id, n); // the node's own id string, not the caller's
        n._pendingParent = p.parentId;
        n._created = true;
        changed = true;
        structure = true;
      }
    }
    // Attach the pending nodes in ascending index (parents may be pending too,
    // so attach by reference first, then push in index order).
    for (const p of putsByIndex) {
      const n = st.byId.get(p.id);
      if (n._pendingParent === undefined) continue;
      const parentId = n._pendingParent;
      delete n._pendingParent;
      if (parentId === null) {
        n.parent = null;
        st.root = n;
        continue;
      }
      const parent = st.byId.get(parentId);
      n.parent = parent;
      parent.kids.push(n);
    }
    if (st.root !== null && !st.byId.has(st.root.id)) st.root = null;
    // Root by the final state: the alive node without a parent.
    for (const n of st.byId.values()) if (n.parent === null) st.root = n;
    if (st.byId.size === 0) st.root = null;
    for (const p of putsByIndex) {
      const n = st.byId.get(p.id);
      if (n._created) {
        delete n._created;
        n.cls = p.fields.class;
        if (p.fields.payload !== undefined && p.fields.payload !== null) {
          n.payload = this.#newPayload(p.fields.payload, next, null, true);
        }
        n.policy = p.fields.policy === undefined ? null : p.fields.policy;
        if (ownPolicy(n.policy)) policy = true;
        markUp(n);
        translate(p, n, false);
        continue;
      }
      // A move or rename marks the ancestors of the new place, not the node.
      if (n.parent !== null && p.parentId !== null) {
        const wasMoved =
          this.byId.get(p.id).parent?.id !== p.parentId ||
          this.byId.get(p.id).name !== p.name;
        if (wasMoved) markUp(n.parent);
      }
      let own = false;
      if (p.fields.class !== undefined && p.fields.class !== n.cls) {
        n.cls = p.fields.class;
        own = true;
      }
      if (p.fields.payload !== undefined) {
        if (p.fields.payload === null) {
          if (n.payload !== null) {
            n.payload = null;
            own = true;
            this.wrote.add(n.uid);
          }
        } else {
          this.wrote.add(n.uid);
          n.payload = this.#newPayload(
            p.fields.payload,
            next,
            n.payload,
            false,
          );
          own = true;
        }
      } else if (p.fields.page !== undefined) {
        const fresh = this.#rendered(n.payload, p.fields.page, next);
        if (fresh !== null) {
          n.payload = fresh;
          this.wrote.add(n.uid);
          own = true;
        }
      }
      if (p.fields.policy !== undefined) {
        const value = p.fields.policy;
        if (
          !Object.is(value, n.policy) &&
          !(value === null && n.policy === null)
        ) {
          if (ownPolicy(value) || ownPolicy(n.policy)) policy = true;
          n.policy = value;
          own = true;
        }
      }
      if (own) {
        markUp(n);
        changed = true;
      }
      const wasRoot = this.byId.get(p.id).parent === null;
      translate(p, n, p.parentId === null && !wasRoot);
    }
    return this.#finish(st, before, {
      changed,
      relocated: false,
      structure,
      policy,
      marks,
      next,
    });
  }

  load(rows, next, now, options) {
    if (!Array.isArray(rows)) throw refusal('EINVAL', -1);
    this.#checkArgs([], next, now, options);
    if (this.fs) throw refusal('EINVAL', -1);
    const seen = new Set();
    const puts = [];
    let rootRow = false; // a row without a parent seen already (QA В42)
    rows.forEach((row, index) => {
      if (row === null || typeof row !== 'object')
        throw refusal('EINVAL', index);
      const { id, parentId, name } = row;
      if (!this.isId(id)) throw refusal('EINVAL', index);
      if (parentId !== null && !this.isId(parentId))
        throw refusal('EINVAL', index);
      if (parentId === null ? name !== '' : !isName(name))
        throw refusal('EINVAL', index);
      if (row.class !== undefined && !isClass(row.class))
        throw refusal('EINVAL', index);
      if (
        row.payload !== undefined &&
        row.payload !== null &&
        !this.validPayload(row.payload)
      )
        throw refusal('EINVAL', index);
      this.#pageFormat(row, index);
      const tr = this.translationsOf(
        row.translations,
        parentId === null,
        index,
      );
      if (seen.has(id)) throw refusal('EINVAL', index);
      seen.add(id);
      // The row without a parent is the root; a second one is EEXIST. The
      // former root's row may come under a parent: load states the whole tree.
      if (parentId === null) {
        if (rootRow) throw refusal('EEXIST', index);
        rootRow = true;
      }
      const exists = this.byId.has(id);
      if (!exists && row.class === undefined) throw refusal('EINVAL', index);
      const fields = {};
      if (row.class !== undefined) fields.class = row.class;
      if (row.payload !== undefined) fields.payload = row.payload;
      if (row.policy !== undefined) fields.policy = row.policy;
      if (row.page !== undefined) fields.page = row.page;
      puts.push({ index, id, parentId, name, fields, exists, tr });
    });
    return this.#finalState(puts, [], next, now, true);
  }
}

module.exports = {
  own,
  ModelTree,
  ModelNode,
  ModelPayload,
  refusal,
  isKey,
  isName,
  canonical,
  namesOf,
  extentKey,
  OTHERS,
  KIND_COUNT,
  PAGE_KINDS,
  SMALL,
};
