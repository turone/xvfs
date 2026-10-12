'use strict';

const { sizeToBytes } = require('metautil');
const { foldName } = require('./rules.js');

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
// extension once, and only what `compile` lists gets cached data.

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

// The extensions of `require: true` and `import: true`. They compile
// nothing: cached data is built for the extensions `compile` lists only.
const REQUIRE_EXT = ['js', 'cjs', 'json'];
const IMPORT_EXT = ['js', 'mjs', 'json'];
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

// Sets `value` at `path`, an array of names, the CLI key `key` names.
const setNested = (obj, path, value, key) => {
  let current = obj;
  for (let i = 0; i < path.length; i++) {
    const part = path[i];
    if (UNSAFE_KEYS.has(part)) fail(`unsafe CLI key "${key}"`);
    if (i === path.length - 1) {
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

// A list of extensions, lower-cased, each named once.
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
    if (result.includes(ext)) {
      fail(`${where}: extension "${ext}" is listed twice`);
    }
    result.push(ext);
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

// --- Place and tree names ---

// `what`: 'place' or 'tree'. A tree's name follows a place's rules: the
// two share one space of names (validateNames).
const validateName = (name, what = 'place') => {
  if (!NAME_RE.test(name)) {
    fail(
      `invalid ${what} name "${name}": use ASCII letters, digits, ".", "_", ` +
        '"-" and start with a letter or digit',
    );
  }
  if (name.endsWith('.')) fail(`invalid ${what} name "${name}": trailing dot`);
  if (WIN_RESERVED_RE.test(name)) {
    fail(`invalid ${what} name "${name}": reserved device name on Windows`);
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
// the domain — `compile` first, then its own `ext`, which get none. An
// extension is listed once.
const compiledOf = (where, raw) => {
  const plain = raw.ext === undefined ? [] : extListOf(`${where}.ext`, raw.ext);
  const compiled =
    raw.compile === undefined ? [] : extListOf(`${where}.compile`, raw.compile);
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
// built from the canonical (prepared) source. It names its sources itself:
// an object with `ext`, `compile` or both, never `true`.
const resolveScript = (where, raw) => {
  if (raw === undefined || raw === false) return null;
  if (!isObject(raw)) {
    fail(`${where} must be false or an object { ext, compile }`);
  }
  knownKeys(where, raw, ['ext', 'compile']);
  if (raw.ext === undefined && raw.compile === undefined) {
    fail(`${where} lists its sources: give ext, compile or both`);
  }
  return compiledOf(where, raw);
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
  if (raw.ext === undefined && raw.compile === undefined) {
    return { ext: [...REQUIRE_EXT], compile: [] };
  }
  return compiledOf(where, raw);
};

// `stat` — what a place's tree keeps beyond a file's size, mtime and
// version (lib/tree.js, "Attributes"): `birthtime`, each file's birthtime
// — the disk's in a disk-origin place, the first write's in a virtual one,
// kept by later ones — and `directories`, a directory's own version and
// times, which change with its children. Both off by default: birthtime
// and ctime equal mtime, and a directory's times are 0. Indexed providers
// only: a disk or node-default place has no tree.
const resolveStat = (where, raw, provider) => {
  if (raw === undefined) return { birthtime: false, directories: false };
  if (!INDEXED.has(provider)) {
    fail(`${where} applies to providers sab, map and sea only`);
  }
  if (!isObject(raw)) fail(`${where} must be an object`);
  knownKeys(where, raw, ['birthtime', 'directories']);
  return {
    birthtime: booleanOf(`${where}.birthtime`, raw.birthtime, false),
    directories: booleanOf(`${where}.directories`, raw.directories, false),
  };
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
//   'name'              every extension of `scope`, the domain's effective
//                       ext list — an unrestricted fs has none
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
    for (const ext of extListOf(`${where}.${name}`, list)) {
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

// The place's preparation index { [ext]: preparer } or null. `prepare` is
// declared by a domain but prepares the file itself, once, for every domain,
// so an extension may have one declaration in the whole place: two are an
// error even when they name the same preparer — no domain priority, no
// merging. The short form covers the effective ext of its domain — for fs
// what `fs.ext`, `fs.script.ext` and `fs.script.compile` list, which only
// the user writes.
const resolvePrepare = (place, raw) => {
  const where = `places.${place.name}`;
  const declarations = [
    ['fs', raw.fs, place.fs?.ext, place.fs],
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
  'stat',
  'rules',
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

// --- Rules of subtrees ---

// What a rule may change in each domain.
const RULE_DOMAINS = {
  fs: ['ext', 'writable', 'fallback'],
  require: ['ext'],
  import: ['ext'],
};

// A rule's path: a key below the place's directory — '/', then names, none
// of them empty, '.' or '..', without NUL or a backslash.
const rulePath = (where, key) => {
  const names = key.split('/');
  const wrong = (name) => name === '' || name === '.' || name === '..';
  if (
    names.length < 2 ||
    names[0] !== '' ||
    names.slice(1).some(wrong) ||
    key.includes('\u0000') ||
    key.includes('\\')
  ) {
    fail(
      `${where}: a rule's path is a key below the place, as '/a/b', got ` +
        JSON.stringify(key),
    );
  }
};

// One domain of a rule: false — off from its path down — or what it changes
// there, within what the place declares: fewer extensions, never more;
// `writable` where the place may be written; `fallback` where it has a
// directory to fall back to. A rule gives no domain the place lacks: what a
// file is — its bytecode, its compression, its preparer — is the place's.
const ruleDomain = (where, domain, raw, place, global) => {
  if (!place[domain]) {
    fail(`${where}: places.${place.name} has no ${domain} domain to narrow`);
  }
  if (raw === false) return false;
  if (raw === true) return {};
  if (!isObject(raw)) fail(`${where} must be false, true or an object`);
  knownKeys(where, raw, RULE_DOMAINS[domain]);
  const own = {};
  if (raw.ext !== undefined) {
    own.ext = extListOf(`${where}.ext`, raw.ext);
    const outer = place[domain].ext;
    const more = outer ? own.ext.find((ext) => !outer.includes(ext)) : null;
    if (more) {
      fail(
        `${where}.ext: "${more}" is not in places.${place.name}.${domain}.ext ` +
          '— a rule shows fewer extensions, never more',
      );
    }
  }
  if (raw.writable !== undefined) {
    own.writable = booleanOf(`${where}.writable`, raw.writable, false);
    if (own.writable && place.provider === 'sea') {
      fail(`${where}.writable: SEA assets are read-only`);
    }
  }
  if (raw.fallback !== undefined) {
    if (!ORIGINED.has(place.provider) || place.origin !== 'disk') {
      fail(
        `${where}.fallback applies to disk-origin places (provider "sab" ` +
          'or "map", origin "disk")',
      );
    }
    own.fallback = resolveFallback(`${where}.fallback`, raw.fallback);
    if (own.fallback === 'disk' && !place.scanExt && global.strict) {
      fail(
        `${where}.fallback: "disk" needs a finite ext list under strict — ` +
          'an unrestricted place caches every file',
      );
    }
  }
  return own;
};

// `rules`: { '<path>': { fs?, require?, import? } } — what holds from a
// path of the place down instead of its own settings (lib/rules.js,
// PlaceRules), while the place serves it; what the place publishes and how
// does not change. A place with a tree only: a disk or node-default place
// serves its paths through node:fs, its listings too. Two paths equal but
// for case are one path on a disk that takes names in any case: refused
// everywhere, as place names are.
const resolveRules = (where, raw, place, global) => {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) fail(`${where} must be an object of paths`);
  if (!INDEXED.has(place.provider)) {
    fail(
      `${where} apply to providers sab, map and sea — "${place.provider}" ` +
        'serves its paths through node:fs',
    );
  }
  const rules = {};
  const seen = new Map(); // folded path → as given
  for (const [key, rule] of Object.entries(raw)) {
    const at = `${where}[${JSON.stringify(key)}]`;
    rulePath(where, key);
    const folded = foldName(key);
    if (seen.has(folded)) {
      fail(`${where}: "${seen.get(folded)}" and "${key}" differ only in case`);
    }
    seen.set(folded, key);
    if (!isObject(rule)) fail(`${at} must be an object`);
    knownKeys(at, rule, Object.keys(RULE_DOMAINS));
    const resolved = {};
    for (const domain of Object.keys(RULE_DOMAINS)) {
      if (rule[domain] === undefined) continue;
      const settings = rule[domain];
      resolved[domain] = ruleDomain(
        `${at}.${domain}`,
        domain,
        settings,
        place,
        global,
      );
    }
    if (Object.keys(resolved).length === 0) {
      fail(`${at}: a rule sets fs, require or import`);
    }
    rules[key] = resolved;
  }
  return Object.keys(rules).length === 0 ? null : rules;
};

// Whether a place takes writes anywhere: its fs domain, or a rule's.
const writesAnywhere = (place) =>
  Boolean(place.fs?.writable) ||
  Object.values(place.rules ?? {}).some((rule) => rule.fs?.writable === true);

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
    stat: resolveStat(`${where}.stat`, raw.stat, provider),
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
  place.rules = resolveRules(`${where}.rules`, raw.rules, place, global);
  return place;
};

// Two names equal after lowercasing are a conflict on every platform: the
// directories would collide on case-insensitive filesystems. A tree takes
// no name of a place either: one name names one owner of shared bytes —
// in the books of compaction, the records of retirement, diagnostics.
const validateNames = (places, trees = []) => {
  const seen = new Map();
  for (const { name } of places) {
    const lower = name.toLowerCase();
    const other = seen.get(lower);
    if (other) fail(`place names "${other}" and "${name}" differ only in case`);
    seen.set(lower, name);
  }
  for (const { name } of trees) {
    const lower = name.toLowerCase();
    const other = seen.get(lower);
    if (other !== undefined) {
      fail(`tree "${name}" takes the name of "${other}" (a place or a tree)`);
    }
    seen.set(lower, name);
  }
};

// --- Shared trees ---

const TREE_KEYS = [
  'ids',
  'containers',
  'birthtime',
  'aggregates',
  'maxNodes',
  'maxFileSize',
  'compress',
  'zeroCopy',
  'intake',
];

// The engine's bounds (lib/tree.js): a class is a small integer of any
// build, and a tree holds at most as many nodes as a V8 Map.
const SMALL = 2 ** 30;
const MAX_NODES = 2 ** 24;

const INTAKE_KEYS = ['seq', 'window', 'limit', 'gapTimeout', 'spaceTimeout'];
const SEQ_MODES = ['source', 'intake'];

const integerOf = (where, value, fallback, min) => {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < min) {
    fail(`${where} must be an integer of at least ${min}`);
  }
  return value;
};

// The classes a tree's rule takes for containers: small integers, each
// once.
const containersOf = (where, value) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${where} must be an array of classes`);
  const seen = new Set();
  for (const cls of value) {
    if (!Number.isInteger(cls) || cls < 0 || cls >= SMALL) {
      fail(`${where}: a class is an integer in 0..2^30-1, got ${cls}`);
    }
    if (seen.has(cls)) fail(`${where}: class ${cls} twice`);
    seen.add(cls);
  }
  return [...value];
};

// The intake of a tree (lib/intake.js): how its batches are numbered, the
// window they gather in, the longest run of ops one publication takes,
// how long a gap and a lack of room in the pool are waited for.
const resolveIntake = (where, raw) => {
  if (raw === undefined || raw === null) raw = {};
  if (!isObject(raw)) fail(`${where} must be an object`);
  knownKeys(where, raw, INTAKE_KEYS);
  const seq = raw.seq ?? 'source';
  if (!SEQ_MODES.includes(seq)) {
    fail(`${where}.seq must be one of ${SEQ_MODES.join(', ')}`);
  }
  return {
    seq,
    window: integerOf(`${where}.window`, raw.window, 10, 0),
    limit: integerOf(`${where}.limit`, raw.limit, 1000, 1),
    gapTimeout: integerOf(`${where}.gapTimeout`, raw.gapTimeout, 2000, 0),
    spaceTimeout: integerOf(`${where}.spaceTimeout`, raw.spaceTimeout, 2000, 0),
  };
};

// A shared tree (README, "Page and route trees"): the engine's
// settings of it, where its payloads may compress and be viewed, and its
// intake.
const resolveTree = (name, raw, global) => {
  const where = `trees.${name}`;
  validateName(name, 'tree');
  if (!isObject(raw)) fail(`${where} must be an object`);
  knownKeys(where, raw, TREE_KEYS);
  const { ids } = raw;
  if (ids !== 'number' && ids !== 'string') {
    fail(`${where}.ids must be "number" or "string"`);
  }
  const aggregates = raw.aggregates ?? {};
  if (!isObject(aggregates)) fail(`${where}.aggregates must be an object`);
  knownKeys(`${where}.aggregates`, aggregates, ['classes', 'subtreeVersion']);
  const maxNodes = integerOf(`${where}.maxNodes`, raw.maxNodes, MAX_NODES, 1);
  if (maxNodes > MAX_NODES) fail(`${where}.maxNodes must not exceed 2^24`);
  const maxFileSize =
    raw.maxFileSize === undefined
      ? global.memory.maxFileSize
      : sizeOf(`${where}.maxFileSize`, raw.maxFileSize);
  if (maxFileSize > global.memory.segmentSize) {
    fail(`${where}.maxFileSize must not exceed defaults.memory.segmentSize`);
  }
  if (isObject(raw.compress) && raw.compress.retainRaw !== undefined) {
    fail(`${where}.compress.retainRaw: a tree keeps its sources`);
  }
  return {
    name,
    ids,
    containers: containersOf(`${where}.containers`, raw.containers),
    birthtime: booleanOf(`${where}.birthtime`, raw.birthtime, false),
    aggregates: {
      classes: booleanOf(
        `${where}.aggregates.classes`,
        aggregates.classes,
        false,
      ),
      subtreeVersion: booleanOf(
        `${where}.aggregates.subtreeVersion`,
        aggregates.subtreeVersion,
        false,
      ),
    },
    maxNodes,
    maxFileSize,
    compress: resolveCompress(`${where}.compress`, raw.compress),
    zeroCopy: booleanOf(`${where}.zeroCopy`, raw.zeroCopy, false),
    intake: resolveIntake(`${where}.intake`, raw.intake),
  };
};

// --- CLI ---

// `--vfs.<path>=<value>` after the `--` separator, read into the raw
// config a JS or JSON file would give, which is then validated as one:
// "true" / "false" are booleans, a decimal is a number, anything else a
// string; a setting that takes a list (LISTS) takes a comma-separated one,
// `--vfs.places.lib.require.compile=js,cjs`, one item included — its items
// strings as written, never numbers — or the keyword it takes in place of a
// list, as it is. "true" / "false" stay booleans there too, so
// `compile=true` is refused as `compile: true` is.

// Settings that take a list, by path — `*` is any one name: a place, a
// preparer — each with the keyword it takes in place of a list.
const LISTS = [
  ['places.*.fs.ext'],
  ['places.*.fs.script.ext'],
  ['places.*.fs.script.compile'],
  ['places.*.fs.compress.encodings'],
  ['places.*.fs.compress.ext', 'compressible'],
  ['places.*.fs.prepare.*'],
  ['places.*.require.ext'],
  ['places.*.require.compile'],
  ['places.*.require.prepare.*'],
  ['places.*.import.ext'],
  ['places.*.import.prepare.*'],
  ['trees.*.containers'],
  ['trees.*.compress.encodings'],
  ['trees.*.compress.ext', 'compressible'],
].map(([pattern, ...keywords]) => ({ pattern: pattern.split('.'), keywords }));

// Lists of numbers: their items are read as decimals.
const NUMBERS = [['trees', '*', 'containers']];

const listAt = (path) =>
  LISTS.find(
    ({ pattern }) =>
      pattern.length === path.length &&
      pattern.every((name, i) => name === '*' || name === path[i]),
  ) || null;

const valueOf = (path, value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const list = listAt(path);
  if (list) {
    if (list.keywords.includes(value)) return value;
    const items = value.split(',').map((item) => item.trim());
    const numbers = NUMBERS.some(
      (pattern) =>
        pattern.length === path.length &&
        pattern.every((name, i) => name === '*' || name === path[i]),
    );
    return numbers ? items.map(Number) : items;
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
};

// The path a CLI key names: its names, split at the dots — but a place's
// or a tree's name may hold dots, so after `places.` or `trees.` the
// longest name the config already has there stays whole. A key cannot
// tell where a name it alone gives ends: flags alone cannot create a
// place or a tree with a dot in its name.
const pathOf = (key, places, trees = []) => {
  const parts = key.split('.');
  const section = parts[0];
  const sections = { places, trees };
  const names = Object.hasOwn(sections, section) ? sections[section] : null;
  if (names === null || parts.length < 3) return parts;
  const rest = key.slice(section.length + 1);
  let name = parts[1];
  for (const known of names) {
    const holds = rest === known || rest.startsWith(`${known}.`);
    if (holds && known.length > name.length) name = known;
  }
  const tail = rest.slice(name.length + 1);
  return [section, name, ...(tail === '' ? [] : tail.split('.'))];
};

const parseArgv = (argv, places = [], trees = []) => {
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
    const section = key.slice(0, key.indexOf('.') + 1);
    if (!['defaults.', 'places.', 'trees.'].includes(section)) {
      fail(`unknown CLI key "--vfs.${key}"`);
    }
    const path = pathOf(key, places, trees);
    setNested(overrides, path, valueOf(path, value), key);
  }
  return { overrides, enable, disable };
};

class VfsConfig {
  #raw;
  #global;
  #places;
  #trees;

  constructor(raw = {}) {
    if (!isObject(raw)) fail('config must be an object');
    knownKeys('config', raw, ['defaults', 'places', 'trees']);
    this.#raw = deepFreeze(deepClone(raw));
    const global = resolveGlobal(raw.defaults || {});
    const places = new Map();
    if (raw.places !== undefined && !isObject(raw.places)) {
      fail('places must be an object');
    }
    for (const [name, placeRaw] of Object.entries(raw.places || {})) {
      places.set(name, resolvePlace(name, placeRaw, global));
    }
    const trees = new Map();
    if (raw.trees !== undefined && !isObject(raw.trees)) {
      fail('trees must be an object');
    }
    for (const [name, treeRaw] of Object.entries(raw.trees || {})) {
      trees.set(name, resolveTree(name, treeRaw, global));
    }
    validateNames([...places.values()], [...trees.values()]);
    this.#global = deepFreeze(global);
    this.#places = places;
    this.#trees = trees;
    for (const place of places.values()) deepFreeze(place);
    for (const tree of trees.values()) deepFreeze(tree);
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

  // The shared trees, in declaration order.
  get trees() {
    return [...this.#trees.values()];
  }

  tree(name) {
    return this.#trees.get(name) || null;
  }

  // Merge `--vfs.*` CLI overrides into `appConfig` and resolve.
  //   --vfs.defaults.memory.limit=512mib --vfs.defaults.strict=true
  //   --vfs.places.static.maxFileSize=2mib --vfs.enable=a,b --vfs.disable=c
  //   --vfs.places.lib.require.compile=js,cjs,dhtml
  //   --vfs.trees.pages.intake.window=20 --vfs.trees.pages.containers=1,2
  static fromArgv(argv, appConfig = {}) {
    const known = isObject(appConfig?.places) ? appConfig.places : {};
    const trees = isObject(appConfig?.trees) ? appConfig.trees : {};
    const { overrides, enable, disable } = parseArgv(
      argv,
      Object.keys(known),
      Object.keys(trees),
    );
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
  writesAnywhere,
};
