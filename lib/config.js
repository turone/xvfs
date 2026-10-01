'use strict';

const { sizeToBytes } = require('metautil');

// VfsConfig — resolves and validates the raw user config into a deep-frozen
// description of global settings and Places.
//
// A Place is one directory under appRoot; its key in `places` is at once its
// name, mount, cache namespace and snapshot/delta identifier. A Place has
// one `provider` (where bytes live), one `origin` (where content comes from)
// and up to three domains — fs, require, import — which describe how the
// patched node:fs and the module hooks see the same files. A domain is
// `false`/absent (off), `true` (defaults) or an object (overrides).
// Each domain may declare `prepare`: the preparer that turns the raw input of
// an extension into the file's one canonical content, shared by every domain.
// `fs.script` nests inside the fs domain: the sources handed to callers that
// build their own `vm.Script`. `require` and `fs.script` list the extensions
// that get V8 cached data in `compile`, the rest in `ext`; a domain lists an
// extension once.

const PROVIDERS = ['sab', 'map', 'sea', 'disk', 'node-default'];
// Providers whose files are indexed in a Map (everything but passthrough).
const INDEXED = new Set(['sab', 'map', 'sea']);
// Providers whose bytes live in pooled SharedArrayBuffer segments.
const SHARED = new Set(['sab', 'sea']);
// Providers that choose an origin; the rest have a fixed one.
const ORIGINED = new Set(['sab', 'map']);
const ORIGINS = ['disk', 'virtual'];
const ENCODINGS = ['gzip', 'deflate', 'br', 'zstd'];
const FALLBACKS = ['disk', 'deny'];

// Domain defaults; those of `require` and `fs.script` apply when the domain
// gives neither `ext` nor `compile`.
const REQUIRE_EXT = ['json'];
const REQUIRE_COMPILE = ['js', 'cjs'];
const IMPORT_EXT = ['js', 'mjs', 'json'];
const SCRIPT_COMPILE = ['js', 'cjs'];
// Extensions no cached data serves: Node loads JSON and ES modules without
// `_compile`, and neither is a `vm.Script` source.
const UNCOMPILED = ['json', 'mjs'];
const PREPARER_RE = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

// Inclusive level bounds per codec, used to validate `compress.options`.
const LEVEL_RANGE = {
  gzip: [0, 9],
  deflate: [0, 9],
  br: [0, 11],
  zstd: [1, 22],
};

// Expansion of `compress.ext: 'compressible'` — formats that gain from
// compression. Already-compressed media (png, jpg, woff2, mp4) is excluded.
const COMPRESSIBLE_EXT = [
  'html',
  'htm',
  'css',
  'js',
  'mjs',
  'cjs',
  'json',
  'map',
  'svg',
  'xml',
  'txt',
  'md',
  'csv',
  'wasm',
  'ttf',
  'otf',
  'webmanifest',
];

const DEFAULTS = {
  memory: {
    limit: '1 gib',
    segmentSize: '64 mib',
    maxFileSize: '10 mb',
  },
  compaction: {
    threshold: 0.3,
  },
  hooks: {
    fs: true,
    module: true,
  },
  watch: false,
  watchTimeout: 1000,
  strict: false,
  links: null,
};

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// --- Generic helpers ---

const fail = (message) => {
  throw new Error(`[vfs config] ${message}`);
};

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const deepClone = (obj) => {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(deepClone);
  const result = {};
  for (const key of Object.keys(obj)) result[key] = deepClone(obj[key]);
  return result;
};

const deepFreeze = (obj) => {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (
      typeof value === 'object' &&
      value !== null &&
      !Object.isFrozen(value)
    ) {
      deepFreeze(value);
    }
  }
  return obj;
};

const mergeDeep = (target, source) => {
  if (!isObject(source)) return target;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    if (sv === undefined) continue; // explicit undefined: as if absent
    const tv = target[key];
    if (Array.isArray(sv)) result[key] = [...sv];
    else if (isObject(sv)) result[key] = mergeDeep(isObject(tv) ? tv : {}, sv);
    else result[key] = sv;
  }
  return result;
};

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const setNested = (obj, path, value) => {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (UNSAFE_KEYS.has(part)) fail(`unsafe CLI key "${path}"`);
    if (i === parts.length - 1) {
      current[part] = value;
    } else {
      if (!isObject(current[part])) current[part] = {};
      current = current[part];
    }
  }
};

// --- Scalar validation ---

// A bare integer (metautil.sizeToBytes: raw bytes), or one followed by a
// decimal (kb, mb, gb, tb, pb, eb, zb, yb) or binary (kib, mib, …, yib)
// unit, case-insensitive — every unit metautil.sizeToBytes understands
// (lib/units.js: UNIT_SIZES, BINARY_UNIT_SIZES) and README, "VfsConfig".
// metautil.sizeToBytes itself only looks at the last two or three
// characters of the string to find a unit, so a typo like `'1 xb'` — or
// trailing space after a real unit, which shifts that window past it —
// silently parses as a unitless `1`; this is checked before it is called.
// No trailing text (whitespace included) is allowed after a unit, so the
// window metautil reads is always the unit itself.
const SIZE_RE = /^\s*-?\d+(?:\s*[kmgtpezy]i?b|\s*)$/i;

const sizeOf = (where, value) => {
  if (typeof value === 'string' && !SIZE_RE.test(value)) {
    fail(
      `${where}: invalid size unit in ${JSON.stringify(value)} — use a ` +
        'bare number of bytes, or one followed by kb/mb/gb/tb/pb/eb/zb/yb ' +
        '(decimal) or kib/mib/gib/tib/pib/eib/zib/yib (binary)',
    );
  }
  const bytes = typeof value === 'string' ? sizeToBytes(value) : value;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    fail(`${where} must be a positive integer size, got ${String(value)}`);
  }
  return bytes;
};

const booleanOf = (where, value, fallback) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(`${where} must be a boolean`);
  return value;
};

// `links` — under strict, what a native operation on a place's disk does
// with the links on its path: 'deny' refuses one that passes through a
// link the kernel knows (links.js: found at initialize(), added by the
// watcher), without a disk call for an ordinary
// path; 'verify' proves where each call really lands (aliases.js, one
// realpath per call). Resolved: `fallback` under strict (the default of the
// place's `defaults.links`, 'deny' globally), null without strict — where
// setting it is an error, as it would change nothing.
const LINKS = ['deny', 'verify'];

const linksOf = (where, value, strict, fallback) => {
  if (value === undefined || value === null) return strict ? fallback : null;
  if (!LINKS.includes(value)) {
    fail(`${where} must be "deny" or "verify", got ${JSON.stringify(value)}`);
  }
  if (!strict) fail(`${where} applies under strict routing only`);
  return value;
};

const extListOf = (where, value) => {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${where} must be a non-empty array of extensions`);
  }
  const result = [];
  for (const item of value) {
    if (typeof item !== 'string' || !/^[A-Za-z0-9]+$/.test(item)) {
      fail(`${where} items must be alphanumeric extensions without dots`);
    }
    const ext = item.toLowerCase();
    if (!result.includes(ext)) result.push(ext);
  }
  return result;
};

const knownKeys = (where, obj, allowed) => {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      fail(`${where}: unknown option "${key}". Valid: ${allowed.join(', ')}`);
    }
  }
};

// --- Global section ---

const resolveGlobal = (raw) => {
  const merged = mergeDeep(deepClone(DEFAULTS), raw);
  knownKeys('defaults', merged, Object.keys(DEFAULTS));
  const { memory, compaction, hooks } = merged;
  if (!isObject(memory)) fail('defaults.memory must be an object');
  if (!isObject(compaction)) fail('defaults.compaction must be an object');
  if (!isObject(hooks)) fail('defaults.hooks must be an object');
  knownKeys('defaults.memory', memory, ['limit', 'segmentSize', 'maxFileSize']);
  knownKeys('defaults.compaction', compaction, ['threshold']);
  knownKeys('defaults.hooks', hooks, ['fs', 'module']);
  const threshold = compaction.threshold;
  if (typeof threshold !== 'number' || !(threshold >= 0 && threshold <= 1)) {
    fail('defaults.compaction.threshold must be a number in 0..1');
  }
  const { watchTimeout } = merged;
  if (!Number.isSafeInteger(watchTimeout) || watchTimeout < 0) {
    fail('defaults.watchTimeout must be a non-negative integer');
  }
  const global = {
    memory: {
      limit: sizeOf('defaults.memory.limit', memory.limit),
      segmentSize: sizeOf('defaults.memory.segmentSize', memory.segmentSize),
      maxFileSize: sizeOf('defaults.memory.maxFileSize', memory.maxFileSize),
    },
    compaction: { threshold },
    hooks: {
      fs: booleanOf('defaults.hooks.fs', hooks.fs, true),
      module: booleanOf('defaults.hooks.module', hooks.module, true),
    },
    watch: booleanOf('defaults.watch', merged.watch, false),
    watchTimeout,
    strict: booleanOf('defaults.strict', merged.strict, false),
  };
  global.links = linksOf('defaults.links', merged.links, global.strict, 'deny');
  if (global.memory.segmentSize > global.memory.limit) {
    fail('defaults.memory.limit must be at least one segmentSize');
  }
  if (global.memory.maxFileSize > global.memory.segmentSize) {
    fail('defaults.memory.maxFileSize must not exceed segmentSize');
  }
  return global;
};

// --- Place names ---

const validateName = (name) => {
  if (!NAME_RE.test(name)) {
    fail(
      `invalid place name "${name}": use ASCII letters, digits, ".", "_", ` +
        '"-" and start with a letter or digit',
    );
  }
  if (name.endsWith('.')) fail(`invalid place name "${name}": trailing dot`);
  if (WIN_RESERVED_RE.test(name)) {
    fail(`invalid place name "${name}": reserved device name on Windows`);
  }
};

// --- Domains ---

// Returns null when the user gave no options: the codec then runs with
// native zlib defaults.
const resolveCodecOptions = (where, encoding, raw) => {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) fail(`${where}.${encoding} must be an object`);
  knownKeys(`${where}.${encoding}`, raw, ['level']);
  if (raw.level === undefined) return null;
  const [min, max] = LEVEL_RANGE[encoding];
  if (!Number.isInteger(raw.level) || raw.level < min || raw.level > max) {
    fail(`${where}.${encoding}.level must be an integer in ${min}..${max}`);
  }
  return { level: raw.level };
};

const resolveCompressExt = (where, ext) => {
  if (ext === undefined || ext === null) return null;
  if (ext === 'compressible') return [...COMPRESSIBLE_EXT];
  return extListOf(where, ext);
};

const resolveCompress = (where, raw) => {
  if (raw === undefined || raw === false || raw === null) return null;
  if (!isObject(raw)) fail(`${where} must be an object`);
  knownKeys(where, raw, ['encodings', 'options', 'ext', 'retainRaw']);
  const { encodings, options = {} } = raw;
  if (!Array.isArray(encodings) || encodings.length === 0) {
    fail(`${where}.encodings must be a non-empty array`);
  }
  if (!isObject(options)) fail(`${where}.options must be an object`);
  const codecs = [];
  const seen = new Set();
  for (const encoding of encodings) {
    if (!ENCODINGS.includes(encoding)) {
      fail(
        `${where}.encodings: unknown encoding "${encoding}". ` +
          `Valid: ${ENCODINGS.join(', ')}`,
      );
    }
    if (seen.has(encoding)) fail(`${where}.encodings: duplicate "${encoding}"`);
    seen.add(encoding);
    const codecOptions = resolveCodecOptions(
      `${where}.options`,
      encoding,
      options[encoding],
    );
    codecs.push({ encoding, options: codecOptions });
  }
  for (const key of Object.keys(options)) {
    if (!seen.has(key)) {
      fail(`${where}.options.${key} is set but "${key}" is not in encodings`);
    }
  }
  return {
    codecs,
    ext: resolveCompressExt(`${where}.ext`, raw.ext),
    retainRaw: booleanOf(`${where}.retainRaw`, raw.retainRaw, true),
  };
};

const union = (...lists) => {
  const result = [];
  for (const list of lists) {
    for (const item of list) if (!result.includes(item)) result.push(item);
  }
  return result;
};

// A domain lists an extension once: in one of its lists.
const listedTwice = (where, ext, first, second) =>
  fail(`${where}: extension "${ext}" is listed in both ${first} and ${second}`);

// The lists of a domain that compiles (`require`, `fs.script`): `compile`,
// the extensions that get V8 cached data, and `ext`, every extension of
// the domain — `compile` first, then its own `ext`, which get none. The
// `defaults` apply when the domain gives neither list; a list given
// replaces them whole. An extension is listed once.
const compiledOf = (where, raw, defaults) => {
  const given = raw.ext !== undefined || raw.compile !== undefined;
  const { ext, compile } = given ? raw : defaults;
  const plain = ext === undefined ? [] : extListOf(`${where}.ext`, ext);
  const compiled =
    compile === undefined ? [] : extListOf(`${where}.compile`, compile);
  for (const item of compiled) {
    if (UNCOMPILED.includes(item)) {
      fail(
        `${where}.compile: extension "${item}" gets no cached data — ` +
          `list it in ${where}.ext`,
      );
    }
    if (plain.includes(item)) listedTwice(where, item, 'ext', 'compile');
  }
  return { ext: union(compiled, plain), compile: compiled };
};

// `fs.script` — sources handed to callers that build their own script
// (`PlaceFs.script()`); those of `compile` with `vm.Script` cached data
// built from the canonical (prepared) source.
const resolveScript = (where, raw) => {
  if (raw === undefined || raw === false) return null;
  if (raw === true) raw = {};
  if (!isObject(raw)) fail(`${where} must be true, false or an object`);
  knownKeys(where, raw, ['ext', 'compile']);
  return compiledOf(where, raw, { compile: SCRIPT_COMPILE });
};

// The declared `fs.fallback`, or null; normalizeFallback() resolves it.
const resolveFallback = (where, raw) => {
  if (raw === undefined) return null;
  if (!FALLBACKS.includes(raw)) {
    fail(`${where} must be "disk" or "deny", got ${JSON.stringify(raw)}`);
  }
  return raw;
};

const resolveFs = (where, raw) => {
  if (raw === undefined || raw === false) return null;
  if (raw === true) raw = {};
  if (!isObject(raw)) fail(`${where} must be true, false or an object`);
  knownKeys(where, raw, [
    'ext',
    'writable',
    'zeroCopy',
    'compress',
    'script',
    'prepare',
    'fallback',
  ]);
  const script = resolveScript(`${where}.script`, raw.script);
  const own = raw.ext === undefined ? null : extListOf(`${where}.ext`, raw.ext);
  // Visible extensions are the union of plain files and script sources,
  // each listed once; `ext` absent *and* no script means every file.
  if (script && own) {
    for (const item of own) {
      if (!script.ext.includes(item)) continue;
      const list = script.compile.includes(item) ? 'compile' : 'ext';
      listedTwice(where, item, 'ext', `script.${list}`);
    }
  }
  const ext = script ? union(own || [], script.ext) : own;
  return {
    ext,
    writable: booleanOf(`${where}.writable`, raw.writable, false),
    zeroCopy: booleanOf(`${where}.zeroCopy`, raw.zeroCopy, false),
    compress: resolveCompress(`${where}.compress`, raw.compress),
    script,
    fallback: resolveFallback(`${where}.fallback`, raw.fallback),
  };
};

const resolveRequire = (where, raw) => {
  if (raw === undefined || raw === false) return null;
  if (raw === true) raw = {};
  if (!isObject(raw)) fail(`${where} must be true, false or an object`);
  knownKeys(where, raw, ['ext', 'compile', 'prepare']);
  return compiledOf(where, raw, {
    ext: REQUIRE_EXT,
    compile: REQUIRE_COMPILE,
  });
};

const resolveImport = (where, raw) => {
  if (raw === undefined || raw === false) return null;
  if (raw === true) raw = {};
  if (!isObject(raw)) fail(`${where} must be true, false or an object`);
  knownKeys(where, raw, ['ext', 'prepare']);
  return {
    ext:
      raw.ext === undefined
        ? [...IMPORT_EXT]
        : extListOf(`${where}.ext`, raw.ext),
  };
};

const resolveOrigin = (where, raw, provider) => {
  if (!ORIGINED.has(provider)) {
    if (raw !== undefined) {
      fail(
        `${where}.origin applies to providers "sab" and "map" only; ` +
          `"${provider}" has a fixed origin`,
      );
    }
    return null;
  }
  if (raw === undefined) return 'disk';
  if (!ORIGINS.includes(raw)) {
    fail(
      `${where}.origin: unknown origin "${raw}". Valid: ${ORIGINS.join(', ')}`,
    );
  }
  return raw;
};

// Extensions the scanner loads for a Place: null (everything) when fs is on
// without its own ext, otherwise the ordered union of enabled domain exts.
// `fs.ext` already unions in `fs.script.ext`.
const scanExtOf = (place) => {
  const { fs, require: req, import: imp } = place;
  if (fs && !fs.ext) return null;
  const result = [];
  for (const domain of [fs, req, imp]) {
    if (!domain) continue;
    for (const ext of domain.ext) if (!result.includes(ext)) result.push(ext);
  }
  return result;
};

// --- Preparation ---

const preparerName = (where, name) => {
  if (typeof name !== 'string' || !PREPARER_RE.test(name)) {
    fail(
      `${where}: invalid preparer name ${JSON.stringify(name)} ` +
        '(an identifier registered in the kernel option `preparers`)',
    );
  }
};

// An extension list that names every extension once (after lowercasing).
const distinctExtList = (where, value) => {
  const list = extListOf(where, value);
  if (list.length < value.length) {
    const seen = new Set();
    for (const item of value) {
      const ext = item.toLowerCase();
      if (seen.has(ext)) fail(`${where}: extension "${ext}" is listed twice`);
      seen.add(ext);
    }
  }
  return list;
};

// `"a", "b" and "c"` — `both "a" and "b"` for two.
const quoted = (names) => {
  const all = names.map((name) => `"${name}"`);
  const last = all.pop();
  const first = all.join(', ');
  return all.length === 1
    ? `both ${first} and ${last}`
    : `${first} and ${last}`;
};

// Extensions one domain's `prepare` assigns, as Map<ext, name>:
//   'name'              every extension of `scope`, the domain's own finite
//                       ext list (fsScope for fs) — null when it has none
//   { name: [ext, …] }  explicit routing; with a finite domain ext
//                       (`visible`) every listed extension must be in it,
//                       and an extension assigned to several preparers is
//                       refused naming every one of them
// Neither form adds extensions to the domain or removes any from it.
const domainPrepare = (where, raw, scope, visible) => {
  if (typeof raw === 'string') {
    preparerName(where, raw);
    if (!scope) {
      fail(
        `${where}: "${raw}" needs a finite ext list in this domain; ` +
          `route extensions explicitly: { ${raw}: [ext, …] }`,
      );
    }
    return new Map(scope.map((ext) => [ext, raw]));
  }
  if (!isObject(raw) || Object.keys(raw).length === 0) {
    fail(
      `${where} must be a preparer name or { name: [ext, …] }` +
        (typeof raw === 'function' ? ', got a function' : ''),
    );
  }
  const assigned = new Map(); // ext → [name, …], in declaration order
  for (const [name, list] of Object.entries(raw)) {
    preparerName(where, name);
    for (const ext of distinctExtList(`${where}.${name}`, list)) {
      if (visible && !visible.includes(ext)) {
        fail(`${where}.${name}: extension "${ext}" is not in the domain ext`);
      }
      const names = assigned.get(ext);
      if (names) names.push(name);
      else assigned.set(ext, [name]);
    }
  }
  const result = new Map();
  for (const [ext, names] of assigned) {
    if (names.length > 1) {
      fail(`${where}: extension "${ext}" is assigned to ${quoted(names)}`);
    }
    result.set(ext, names[0]);
  }
  return result;
};

// The scope of a short `fs.prepare`: the extensions fs lists itself —
// `ext`, `script.ext`, `script.compile` — never the defaults of
// `script: true`; null when it lists none.
const fsScope = (raw) => {
  if (!isObject(raw)) return null;
  const script = isObject(raw.script) ? raw.script : {};
  const lists = [raw.ext, script.ext, script.compile].filter(
    (list) => list !== undefined,
  );
  if (lists.length === 0) return null;
  return union(...lists.map((list) => extListOf('fs', list)));
};

// The place's preparation index { [ext]: preparer } or null. `prepare` is
// declared by a domain but prepares the file itself, once, for every domain,
// so an extension may have one declaration in the whole place: two are an
// error even when they name the same preparer — no domain priority, no
// merging. The short form of fs covers the extensions fs lists itself
// (fsScope), never the defaults of `script: true`.
const resolvePrepare = (place, raw) => {
  const where = `places.${place.name}`;
  const declarations = [
    ['fs', raw.fs, fsScope(raw.fs), place.fs],
    ['require', raw.require, place.require?.ext, place.require],
    ['import', raw.import, place.import?.ext, place.import],
  ];
  const declared = new Map(); // ext → [{ domain, name }]
  for (const [domain, rawDomain, scope, resolved] of declarations) {
    if (!isObject(rawDomain) || rawDomain.prepare === undefined) continue;
    const at = `${where}.${domain}.prepare`;
    const assigned = domainPrepare(at, rawDomain.prepare, scope, resolved.ext);
    for (const [ext, name] of assigned) {
      const list = declared.get(ext) || [];
      list.push({ domain, name });
      declared.set(ext, list);
    }
  }
  if (declared.size === 0) return null;
  const index = {};
  for (const [ext, list] of declared) {
    if (list.length > 1) {
      const all = list.map((d) => `${d.domain}.prepare → "${d.name}"`);
      fail(
        `${where}: extension "${ext}" has multiple preparer declarations: ` +
          all.join(', '),
      );
    }
    index[ext] = list[0].name;
  }
  return index;
};

// --- Places ---

const PLACE_KEYS = [
  'enabled',
  'provider',
  'origin',
  'maxFileSize',
  'fs',
  'require',
  'import',
  'links',
];

const validatePlace = (place, global) => {
  const { name, provider, origin, fs, require: req } = place;
  const script = fs?.script || null;
  const where = `places.${name}`;
  if (!fs && !req && !place.import) {
    fail(`${where}: enable at least one domain (fs, require, import)`);
  }
  const passthrough = provider === 'disk' || provider === 'node-default';
  if (script && !INDEXED.has(provider)) {
    fail(
      `${where}.fs.script requires provider sab, map or sea; ` +
        `"${provider}" has no canonical VFS content`,
    );
  }
  if (place.prepare && !INDEXED.has(provider)) {
    fail(
      `${where}: prepare requires provider sab, map or sea; ` +
        `"${provider}" serves files from disk as they are`,
    );
  }
  if (origin === 'virtual') {
    if (!fs) {
      fail(
        `${where}: origin "virtual" requires the fs domain — ` +
          'content arrives through fs mutations',
      );
    }
    if (!fs.writable) {
      fail(
        `${where}: origin "virtual" requires fs.writable — ` +
          'a virtual place has no other content source',
      );
    }
  }
  if (SHARED.has(provider) && place.maxFileSize > global.memory.segmentSize) {
    fail(`${where}.maxFileSize must not exceed defaults.memory.segmentSize`);
  }
  if (fs && provider === 'node-default') {
    if (fs.ext || fs.writable || fs.zeroCopy || fs.compress || fs.fallback) {
      fail(
        `${where}.fs: options are not applicable to provider "node-default"`,
      );
    }
  } else if (fs) {
    if (fs.writable && provider === 'sea') {
      fail(`${where}.fs.writable: SEA assets are read-only`);
    }
    if (fs.zeroCopy && !INDEXED.has(provider)) {
      fail(`${where}.fs.zeroCopy requires provider sab, map or sea`);
    }
    if (fs.compress && !SHARED.has(provider)) {
      fail(`${where}.fs.compress requires provider "sab" or "sea"`);
    }
    if (fs.compress && !fs.compress.retainRaw) {
      if (provider !== 'sab') {
        fail(`${where}.fs.compress.retainRaw: false requires provider "sab"`);
      }
      if (origin !== 'disk') {
        fail(
          `${where}.fs.compress.retainRaw: false requires origin "disk" — ` +
            `provider "${provider}", origin "${origin}" keeps no raw file ` +
            'to serve the source from',
        );
      }
      if (req?.compile.length > 0) {
        fail(
          `${where}.fs.compress.retainRaw: false is incompatible with ` +
            'require.compile — bytecode is built from the source kept in SAB',
        );
      }
      if (script) {
        fail(
          `${where}.fs.compress.retainRaw: false is incompatible with ` +
            'fs.script — its canonical sources and bytecode live in SAB',
        );
      }
      if (place.prepare) {
        fail(
          `${where}.fs.compress.retainRaw: false is incompatible with ` +
            'prepare — a prepared source exists only in memory',
        );
      }
    }
  }
  if (req?.compile.length > 0 && passthrough) {
    fail(
      `${where}.require: provider "${provider}" cannot store bytecode; ` +
        'list its extensions in require.ext',
    );
  }
};

// `fs.fallback` belongs to disk-origin places (provider sab / map reading a
// directory): 'deny' serves published canonical entries only; 'disk' also
// serves, from disk, the files its cache filters do not select. There the
// resolved value is always explicit — strict ? 'deny' : 'disk', the
// permissive default of a non-strict place. Elsewhere (virtual, sea, disk,
// node-default) there is no directory to fall back to: null.
// A place without a finite fs.ext caches every file, so 'disk' has no disk
// territory of files there: without strict it means the permissive reads
// of the default and is accepted — a resolved config is valid input; under
// strict nothing would be served from disk, and the value is refused.
const normalizeFallback = (place, global) => {
  const { fs, provider, origin } = place;
  if (!fs) return;
  const where = `places.${place.name}.fs.fallback`;
  if (!ORIGINED.has(provider) || origin !== 'disk') {
    if (fs.fallback === null) return;
    const from = origin
      ? `provider "${provider}", origin "${origin}"`
      : `provider "${provider}"`;
    fail(
      `${where} applies to disk-origin places (provider "sab" or "map", ` +
        `origin "disk"); ${from} has no directory to fall back to`,
    );
  }
  if (fs.fallback === 'disk' && !place.scanExt && global.strict) {
    fail(
      `${where}: "disk" needs a finite ext list under strict — an ` +
        'unrestricted place caches every file and would serve nothing ' +
        'from disk',
    );
  }
  if (fs.fallback === null) fs.fallback = global.strict ? 'deny' : 'disk';
};

// A place's `links`: its own value or `defaults.links`, for a place with a
// directory on disk its native operations reach — a disk-origin sab or map
// place (its disk-backed entries, its disk territory), a disk or
// node-default place; null elsewhere, and without strict.
const placeLinks = (where, value, place, global) => {
  const { provider, origin } = place;
  const onDisk =
    provider === 'disk' ||
    provider === 'node-default' ||
    (ORIGINED.has(provider) && origin === 'disk');
  if (!onDisk) {
    if (value === undefined || value === null) return null;
    fail(
      `${where}.links applies to places with a directory on disk ` +
        '(origin "disk", or provider "disk" or "node-default")',
    );
  }
  return linksOf(`${where}.links`, value, global.strict, global.links);
};

const resolvePlace = (name, raw, global) => {
  const where = `places.${name}`;
  validateName(name);
  if (!isObject(raw)) fail(`${where} must be an object`);
  knownKeys(where, raw, PLACE_KEYS);
  const provider = raw.provider === undefined ? 'sab' : raw.provider;
  if (!PROVIDERS.includes(provider)) {
    fail(
      `${where}.provider: unknown provider "${provider}". ` +
        `Valid: ${PROVIDERS.join(', ')}`,
    );
  }
  const place = {
    name,
    enabled: booleanOf(`${where}.enabled`, raw.enabled, true),
    provider,
    origin: resolveOrigin(where, raw.origin, provider),
    maxFileSize:
      raw.maxFileSize === undefined
        ? global.memory.maxFileSize
        : sizeOf(`${where}.maxFileSize`, raw.maxFileSize),
    fs: resolveFs(`${where}.fs`, raw.fs),
    require: resolveRequire(`${where}.require`, raw.require),
    import: resolveImport(`${where}.import`, raw.import),
  };
  if (raw.maxFileSize !== undefined && !SHARED.has(provider)) {
    fail(
      `${where}.maxFileSize applies to providers "sab" and "sea" only; ` +
        `"${provider}" does not store files in the SAB pool`,
    );
  }
  place.scanExt = scanExtOf(place);
  place.prepare = resolvePrepare(place, raw);
  validatePlace(place, global);
  normalizeFallback(place, global);
  place.links = placeLinks(where, raw.links, place, global);
  return place;
};

// Two names equal after lowercasing are a conflict on every platform: the
// directories would collide on case-insensitive filesystems.
const validateNames = (places) => {
  const seen = new Map();
  for (const { name } of places) {
    const lower = name.toLowerCase();
    const other = seen.get(lower);
    if (other) fail(`place names "${other}" and "${name}" differ only in case`);
    seen.set(lower, name);
  }
};

// --- CLI ---

// `--vfs.<path>=<value>` after the `--` separator. Values are strings; only
// "true"/"false" are coerced so they can flow through the same validation as
// a JS config.
const coerce = (value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
};

const parseArgv = (argv) => {
  const dash = argv.indexOf('--');
  const args = dash === -1 ? [] : argv.slice(dash + 1);
  const overrides = {};
  const enable = [];
  const disable = [];
  for (const arg of args) {
    if (!arg.startsWith('--vfs.')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) continue;
    const key = arg.substring(6, eq);
    const value = arg.substring(eq + 1);
    if (key === 'config') continue;
    if (key === 'enable' || key === 'disable') {
      const list = key === 'enable' ? enable : disable;
      list.push(
        ...value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
      continue;
    }
    if (!key.startsWith('defaults.') && !key.startsWith('places.')) {
      fail(`unknown CLI key "--vfs.${key}"`);
    }
    setNested(overrides, key, coerce(value));
  }
  return { overrides, enable, disable };
};

class VfsConfig {
  #raw;
  #global;
  #places;

  constructor(raw = {}) {
    if (!isObject(raw)) fail('config must be an object');
    knownKeys('config', raw, ['defaults', 'places']);
    this.#raw = deepFreeze(deepClone(raw));
    const global = resolveGlobal(raw.defaults || {});
    const places = new Map();
    if (raw.places !== undefined && !isObject(raw.places)) {
      fail('places must be an object');
    }
    for (const [name, placeRaw] of Object.entries(raw.places || {})) {
      places.set(name, resolvePlace(name, placeRaw, global));
    }
    validateNames([...places.values()]);
    this.#global = deepFreeze(global);
    this.#places = places;
    for (const place of places.values()) deepFreeze(place);
  }

  // The input this config was resolved from (CLI overrides applied);
  // structured-cloneable, so workers can rebuild the same VfsConfig.
  get raw() {
    return this.#raw;
  }

  get global() {
    return this.#global;
  }

  // Enabled places, in declaration order.
  get places() {
    return [...this.#places.values()].filter((place) => place.enabled);
  }

  get allPlaces() {
    return [...this.#places.values()];
  }

  place(name) {
    return this.#places.get(name) || null;
  }

  // Merge `--vfs.*` CLI overrides into `appConfig` and resolve.
  //   --vfs.defaults.memory.limit=512mib --vfs.defaults.strict=true
  //   --vfs.places.static.maxFileSize=2mib --vfs.enable=a,b --vfs.disable=c
  static fromArgv(argv, appConfig = {}) {
    const { overrides, enable, disable } = parseArgv(argv);
    const raw = mergeDeep(deepClone(appConfig), overrides);
    if (enable.length > 0 || disable.length > 0) {
      raw.places = raw.places || {};
      const placeOf = (name) => {
        if (!isObject(raw.places[name])) fail(`unknown place "${name}"`);
        return raw.places[name];
      };
      if (enable.length > 0) {
        for (const place of Object.values(raw.places)) {
          if (isObject(place)) place.enabled = false;
        }
        for (const name of enable) placeOf(name).enabled = true;
      }
      for (const name of disable) placeOf(name).enabled = false;
    }
    return new VfsConfig(raw);
  }
}

module.exports = {
  VfsConfig,
  ENCODINGS,
  PROVIDERS,
  ORIGINS,
  INDEXED,
  SHARED,
  deepFreeze,
};
