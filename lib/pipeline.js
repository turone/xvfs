'use strict';

const vm = require('node:vm');
const Module = require('node:module');
const { fileExt } = require('metautil');
const { bytecodeKey, isCompanionKey } = require('./companion.js');
const { deepFreeze } = require('./config.js');
const { fsError } = require('./errors.js');

// What a file *is*, decided once per publication attempt, whatever produced
// its raw input (disk scan, watcher, SEA assets, virtual mutations):
//
//   raw input → the one preparer of its extension (if any) → canonical
//   content → script bytecode → require bytecode
//
// Storage belongs to the caller — pooled SAB segments (the SAB sink,
// publication.js) or a per-thread Map (MapStore) — and so does compression
// (SAB only).
//
//   prepare(raw: Buffer, file) → null | undefined | string | Uint8Array
//                              | { source, scriptOptions?, meta? }
//   file: frozen { place, key, path, ext, stat: { size, mtimeMs } }
//   null  → publish the raw bytes unchanged
//   scriptOptions → vm.Script options (filename, lineOffset, columnOffset…)
//           the library passes to V8 when producing the fs.script cached
//           data and ships in the bundle (PlaceFs.script()). They never
//           enable fs.script by themselves. The library invents none of
//           them: without scriptOptions V8 defaults apply. `cachedData` /
//           `produceCachedData` / `importModuleDynamically` are reserved.
//   meta  → structured-cloneable; stored frozen with the entry and handed
//           back by PlaceFs.script() / PlaceFs.meta() in every thread
//
// A preparer is declared by one domain (`fs`, `require` or `import`) but
// prepares the file for all of them. It is synchronous: it runs inside the
// scanner / watcher pipeline and inside synchronous Map writes. Workers
// never prepare shared places — they project published canonical content.

// Extensions Node's CommonJS loader compiles; `require:bytecode` is wrapped.
const REQUIRE_EXT = new Set(['js', 'cjs']);

const NOOP = () => {};

const fail = (message) => {
  throw new Error(`[vfs] ${message}`);
};

class Preparers {
  #fns;

  constructor(preparers = {}) {
    if (preparers === null || typeof preparers !== 'object') {
      fail('option "preparers" must be an object of functions');
    }
    for (const [name, fn] of Object.entries(preparers)) {
      if (typeof fn !== 'function') fail(`preparers.${name} is not a function`);
    }
    this.#fns = new Map(Object.entries(preparers));
  }

  // The callbacks a place's `prepare` index names, as Map<ext, fn>, or null.
  // `strict` (main thread): every name must be registered — publication
  // needs them all before anything is read. Otherwise (a worker) only what
  // was given is bound; a local mutation that needs a missing one fails
  // then, never the attach.
  bind(place, strict) {
    const { prepare } = place.config;
    if (!prepare) return null;
    const bound = new Map();
    for (const [ext, name] of Object.entries(prepare)) {
      const fn = this.#fns.get(name);
      if (fn) bound.set(ext, fn);
      else if (strict) {
        fail(
          `places.${place.name}: preparer "${name}" is not registered ` +
            '(kernel option `preparers`)',
        );
      }
    }
    return bound;
  }
}

const checkSource = (source, where) => {
  if (typeof source === 'string' || source instanceof Uint8Array) return;
  throw new TypeError(`${where}: source must be a string or Uint8Array`);
};

// Canonical bytes of a preparer result, owned by the library: a string is
// encoded, returned bytes are copied (the preparer may reuse its buffer), the
// raw input handed to it is taken as is.
const bytesOf = (source, raw) => {
  if (typeof source === 'string') return Buffer.from(source, 'utf8');
  return source === raw ? raw : Buffer.from(source);
};

const RESERVED_SCRIPT_OPTIONS = [
  'cachedData',
  'produceCachedData',
  'importModuleDynamically',
];

// Cloned + frozen copy of a preparer-returned object, or null.
const cloneField = (value, where, name) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') {
    throw new TypeError(`${where}: ${name} must be an object`);
  }
  return deepFreeze(structuredClone(value));
};

const scriptOptionsOf = (value, where) => {
  const options = cloneField(value, where, 'scriptOptions');
  if (!options) return null;
  for (const name of RESERVED_SCRIPT_OPTIONS) {
    if (name in options) {
      throw new TypeError(`${where}: scriptOptions.${name} is reserved`);
    }
  }
  return options;
};

// The cloned, frozen `scriptOptions` and `meta` of a `{ source, … }`
// result, as fields to put on the FileInput; structuredClone both
// validates cloneability and detaches the copy.
const extrasOf = (result, where) => {
  const extras = {};
  const scriptOptions = scriptOptionsOf(result.scriptOptions, where);
  const meta = cloneField(result.meta, where, 'meta');
  if (scriptOptions) extras.scriptOptions = scriptOptions;
  if (meta) extras.meta = meta;
  return extras;
};

// Run `prepare` once over the raw bytes of one file. Returns the FileInput
// to publish: `{ data, stat, scriptOptions?, meta? }` — `data` is the
// canonical content, `stat.size` its length, `stat.mtimeMs` the raw input's.
// The bytes are taken the moment the preparer returns, before `meta` and
// `scriptOptions` are cloned (their getters run then): with a `sink` —
// `{ place(bytes, stat) → entry | null, free(entry) }`, the SAB sink's
// provisional allocation — a Uint8Array result other than the raw input
// is placed there at once, and the FileInput carries `entry` in place of
// `data`: the bytes are copied exactly once, and a preparer that reuses
// its buffer on its next call cannot reach a version still waiting for
// its copy; an extras that cannot be cloned frees the placed entry. A
// sink that declines (null) leaves the copy to `bytesOf`, as without one.
const prepareInput = (place, key, input, raw, prepare, sink = null) => {
  const where = `[vfs] place "${place.name}": prepare "${key}"`;
  const stat = Object.freeze({ ...input.stat });
  const file = Object.freeze({
    place: place.name,
    key,
    path: place.pathOf(key),
    ext: fileExt(key),
    stat,
  });
  const result = prepare(raw, file);
  if (result === null || result === undefined) {
    return { data: raw, stat: input.stat };
  }
  if (typeof result.then === 'function') {
    // An async preparer's rejection must not surface as an unhandled one.
    if (result instanceof Promise) result.catch(NOOP);
    throw new TypeError(`${where}: preparers must be synchronous`);
  }
  const bare = typeof result === 'string' || result instanceof Uint8Array;
  if (!bare && typeof result !== 'object') {
    throw new TypeError(
      `${where}: result must be a string, a Uint8Array or { source }`,
    );
  }
  const source = bare ? result : result.source;
  checkSource(source, where);
  const { mtimeMs } = input.stat;
  let entry = null;
  if (sink && typeof source !== 'string' && source !== raw) {
    entry = sink.place(source, { size: source.length, mtimeMs });
  }
  const data = entry ? null : bytesOf(source, raw);
  let extras = {};
  if (!bare) {
    try {
      extras = extrasOf(result, where);
    } catch (err) {
      if (entry) sink.free(entry);
      throw err;
    }
  }
  if (entry) return { entry, stat: entry.stat, ...extras };
  return { data, stat: { size: data.length, mtimeMs }, ...extras };
};

// --- V8 cached data ---
// Internal: cached data is always produced by the library from the canonical
// source it publishes, so source and bytecode can never diverge. Callers
// never supply their own; the public result is `PlaceFs.script(key)`.

// Compile to V8 cached data; null when the source does not parse.
const createBytecode = (source, options) => {
  try {
    return new vm.Script(source, options).createCachedData();
  } catch {
    return null;
  }
};

// Bytecode flavors `key` gets in `place`, in a stable order. Two independent
// mechanisms, one companion each, both built from the canonical source:
//   require  Module.wrap(source) under the module filename, consumed by the
//            _compile hook (`require.compile`); ext js / cjs.
//   script   the bare source under the preparer's scriptOptions, consumed
//            through PlaceFs.script() (`fs.script.compile`).
const bytecodeDomains = (place, key) => {
  if (isCompanionKey(key)) return [];
  const result = [];
  const { require: req, fs } = place.config;
  if (req?.compile && REQUIRE_EXT.has(fileExt(key))) {
    if (place.visible('require', key)) result.push('require');
  }
  if (fs?.script?.compile && place.scripted(key)) result.push('script');
  return result;
};

// How a publication refuses the key it publishes: `open` of its path, as a
// write is refused — unless the operation that publishes it passes its own
// `fail(code, detail)`, as a rename does (VirtualStore: `rename`, its
// source and `dest`).
const opening = (place, key) => (code, detail) =>
  fsError(code, 'open', place.pathOf(key), detail);

// Cached data companions of one canonical source, as
// `[{ domain, key, data }]`. A require flavor that does not parse has `data`
// null: it is best-effort, and the caller drops the stale companion. A
// script flavor that does not compile invalidates the whole publication,
// with one error whichever sink publishes it: the refusal of the operation
// (`fail`, else opening()).
const bytecodeFor = (place, key, source, scriptOptions, fail) => {
  const domains = bytecodeDomains(place, key);
  if (domains.length === 0) return [];
  const text = source.toString('utf8');
  const result = [];
  for (const domain of domains) {
    const wrapped = domain === 'require';
    const code = wrapped ? Module.wrap(text) : text;
    const options = wrapped
      ? { filename: place.pathOf(key) }
      : scriptOptions || {};
    const data = createBytecode(code, options);
    if (!data && !wrapped) {
      const refuse = fail || opening(place, key);
      throw refuse('ENOTSUP', 'fs.script.compile: source does not compile');
    }
    result.push({ domain, key: bytecodeKey(key, domain), data });
  }
  return result;
};

module.exports = {
  Preparers,
  prepareInput,
  opening,
  bytecodeDomains,
  bytecodeFor,
  createBytecode,
};
