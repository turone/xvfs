// Types of config.js: the raw configuration `new VfsConfig(raw)` takes (and
// `config.raw` gives back), and the resolved, deep-frozen forms `global`,
// `places` and `place(name)` hold. Declared by the code; README, "API".

/** A byte size: a number, or a `metautil.sizeToBytes` string (`'64 mib'`). */
export type Size = number | string;

export type Provider = 'sab' | 'map' | 'sea' | 'disk' | 'node-default';

/** Providers whose files are indexed in a Map: what `kernel.fs()` serves. */
export type IndexedProvider = 'sab' | 'map' | 'sea';

export type Origin = 'disk' | 'virtual';

export type Encoding = 'gzip' | 'deflate' | 'br' | 'zstd';

export type Fallback = 'disk' | 'deny';

/**
 * How strict routing proves a native call on a place's disk: `'deny'`
 * refuses a path through a link the kernel knows (an index, no disk call
 * for an ordinary path); `'verify'` refuses one whose real path lies in
 * managed territory (a `realpath` per call). README, "Strict routing".
 */
export type Links = 'deny' | 'verify';

/**
 * `prepare` of a domain: a preparer name for every extension of the
 * domain's effective, finite `ext` — in fs, what `ext`, `script.ext` and
 * `script.compile` list — or `{ name: [ext, …] }`. Names are registered as
 * functions in the kernel option `preparers`.
 */
export type PrepareConfig =
  string | { readonly [preparer: string]: readonly string[] };

export interface MemoryConfig {
  /** Total SAB pool budget. Default `'1 gib'`. */
  limit?: Size;
  /** SAB segment size. Default `'64 mib'`. */
  segmentSize?: Size;
  /** Larger disk files stay on disk. Default `'10 mb'`. */
  maxFileSize?: Size;
}

export interface CompactionConfig {
  /** 0 = off; else compact a segment used below this share. Default 0.3. */
  threshold?: number;
}

export interface HooksConfig {
  /** Patch `node:fs`. Default true. */
  fs?: boolean;
  /** `module.registerHooks` + `_compile`. Default true. */
  module?: boolean;
}

export interface VfsDefaults {
  memory?: MemoryConfig;
  compaction?: CompactionConfig;
  hooks?: HooksConfig;
  /** Watch disk-origin places. Default false. */
  watch?: boolean;
  /** Watcher debounce (ms). Default 1000. */
  watchTimeout?: number;
  /** Routing policy inside `appRoot`. Default false. */
  strict?: boolean;
  /** Under strict only. Default `'deny'`. */
  links?: Links | null;
}

export interface CodecConfig {
  /** Codec level; native zlib defaults when absent. */
  level?: number;
}

export interface CompressConfig {
  encodings: readonly Encoding[];
  options?: { [E in Encoding]?: CodecConfig | null };
  /** Extensions to compress, or `'compressible'`; default: all of `fs.ext`. */
  ext?: readonly string[] | 'compressible' | null;
  /** Keep the uncompressed source in SAB. Default true. */
  retainRaw?: boolean;
}

interface ScriptLists {
  /** Sources without cached data: their bundle's `cachedData` is undefined. */
  ext?: readonly string[];
  /**
   * Sources with cached data (their script bytecode representation); each
   * is a source of the domain too. Never `json` or `mjs`.
   */
  compile?: readonly string[];
}

/**
 * Sources for `PlaceFs.script()`, named by the user — `ext`, `compile` or
 * both; there are no defaults. Every extension is listed once in fs: in
 * `fs.ext`, `ext` or `compile`.
 */
export type ScriptConfig = ScriptLists &
  ({ ext: readonly string[] } | { compile: readonly string[] });

export interface FsDomainConfig {
  /**
   * Visible extensions besides those of `script`; absent = every file,
   * unless `script` is on.
   */
  ext?: readonly string[];
  writable?: boolean;
  zeroCopy?: boolean;
  compress?: CompressConfig | false | null;
  /** An object of lists, or `false` (off). */
  script?: ScriptConfig | false;
  prepare?: PrepareConfig;
  /** Disk-origin places only; default `'deny'` under strict, else `'disk'`. */
  fallback?: Fallback;
}

/**
 * With neither `ext` nor `compile` (`require: true`, `{}`, `{ prepare }`):
 * `ext: ['js', 'cjs', 'json']`, nothing compiled; a list given replaces
 * that default. Cached data is built for the extensions of `compile`
 * only. Every extension is listed once: in `ext` or `compile`.
 */
export interface RequireDomainConfig {
  /** Extensions without cached data. */
  ext?: readonly string[];
  /**
   * Extensions with cached data (their require bytecode representation);
   * each is an extension of the domain too. Never `json` or `mjs`.
   */
  compile?: readonly string[];
  prepare?: PrepareConfig;
}

export interface ImportDomainConfig {
  /** Default `['js', 'mjs', 'json']`. */
  ext?: readonly string[];
  prepare?: PrepareConfig;
}

/**
 * A place: its key in `places` is the directory under `appRoot`, the mount,
 * the cache namespace and the snapshot/delta key. At least one domain must
 * be on; a domain is absent or `false` (off), `true` (defaults) or an
 * object.
 */
export interface PlaceConfig {
  /** Default true. */
  enabled?: boolean;
  /** Default `'sab'`. */
  provider?: Provider;
  /** `sab` and `map` only. Default `'disk'`. */
  origin?: Origin;
  /** `sab` and `sea` only. Default `defaults.memory.maxFileSize`. */
  maxFileSize?: Size;
  fs?: FsDomainConfig | boolean;
  require?: RequireDomainConfig | boolean;
  import?: ImportDomainConfig | boolean;
  /**
   * Under strict, for a place with a directory on disk (origin `'disk'`,
   * provider `'disk'` or `'node-default'`). Default `defaults.links`.
   */
  links?: Links | null;
  /** Indexed providers only (`sab`, `map`, `sea`). Both off by default. */
  stat?: StatConfig;
  /**
   * What holds from a path of the place down instead of its own settings,
   * while it serves the path, by key: `'/private': { fs: false }`.
   * Indexed providers only (`sab`, `map`, `sea`).
   */
  rules?: { [key: string]: RuleConfig };
}

/**
 * A rule of a place's subtree: per domain `false` (off from its path
 * down), `true` (on again, as it was before a rule above turned it off)
 * or what it changes there — within what the place declares: fewer
 * extensions, never more, and no domain the place lacks. The deepest rule
 * on a path holds there.
 */
export interface RuleConfig {
  fs?:
    | boolean
    | {
        /** A subset of the place's `fs.ext`. */
        ext?: readonly string[];
        /** Not for `sea`. */
        writable?: boolean;
        /** Disk-origin places only. */
        fallback?: Fallback;
      };
  /** `ext`: a subset of the place's `require.ext`. */
  require?: boolean | { ext?: readonly string[] };
  /** `ext`: a subset of the place's `import.ext`. */
  import?: boolean | { ext?: readonly string[] };
}

export interface ResolvedRule {
  readonly fs?:
    | false
    | {
        readonly ext?: readonly string[];
        readonly writable?: boolean;
        readonly fallback?: Fallback;
      };
  readonly require?: false | { readonly ext?: readonly string[] };
  readonly import?: false | { readonly ext?: readonly string[] };
}

/**
 * What a place's tree keeps beyond a file's size, mtime and version:
 * `birthtime`, each file's own — the disk's in a disk-origin place, the
 * first write's in a virtual one; `directories`, a directory's version and
 * times, which change with its children. Off: birthtime and ctime equal
 * mtime, and a directory's times are 0.
 */
export interface StatConfig {
  birthtime?: boolean;
  directories?: boolean;
}

/**
 * How a shared tree takes its batches (`lib/intake.js`, README, "Page
 * and route trees").
 */
export interface IntakeConfig {
  /**
   * Who numbers the batches: `'source'` (default) — the source, densely,
   * in the order it commits them; `'intake'` — the intake, in the order
   * they arrive, for a single writer over one lossless channel.
   */
  seq?: 'source' | 'intake';
  /** How long batches gather before a publication, ms. Default 10. */
  window?: number;
  /** The most ops one publication takes; a run is cut there. Default 1000. */
  limit?: number;
  /** How long a gap is waited for before `onGap`, ms. Default 2000. */
  gapTimeout?: number;
  /** How long a batch waits for room in the pool, ms. Default 2000. */
  spaceTimeout?: number;
}

/**
 * A shared tree: nodes with the ids its source gives them — a page's key
 * in the database — payloads in the pool, the same in every thread
 * (`kernel.tree(name)`). Its name takes no name of a place.
 */
export interface TreeConfig {
  /** The source's ids: numbers (safe integers) or strings. */
  ids: 'number' | 'string';
  /** The classes that are containers in every thread at first. Default []. */
  containers?: readonly number[];
  /**
   * The languages' codes, the main one first — 1 to 255, each once: a node
   * has a name and a payload in each it is translated to. Without, one
   * language and no code.
   */
  languages?: readonly string[];
  /** Payloads keep a birthtime. Default false. */
  birthtime?: boolean;
  /** The aggregates the tree keeps; both off by default. */
  aggregates?: { classes?: boolean; subtreeVersion?: boolean };
  /** The most live nodes. Default 2^24, the most there can be. */
  maxNodes?: number;
  /** The largest payload. Default `defaults.memory.maxFileSize`. */
  maxFileSize?: Size;
  /**
   * The compressed forms of every rendered page, made once as it is
   * published; the data a payload holds is never compressed.
   */
  compress?: Pick<CompressConfig, 'encodings' | 'options'> | false | null;
  /** Leases and borrowed stream chunks. Default false. */
  zeroCopy?: boolean;
  intake?: IntakeConfig;
}

/** The raw configuration: hardcoded defaults → `defaults` → per place. */
export interface VfsRawConfig {
  defaults?: VfsDefaults | null;
  places?: { [name: string]: PlaceConfig };
  trees?: { [name: string]: TreeConfig };
}

/** `T` with every property read-only, at every depth. */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

// --- Resolved forms ---

export interface VfsGlobal {
  readonly memory: {
    readonly limit: number;
    readonly segmentSize: number;
    readonly maxFileSize: number;
  };
  readonly compaction: { readonly threshold: number };
  readonly hooks: { readonly fs: boolean; readonly module: boolean };
  readonly watch: boolean;
  readonly watchTimeout: number;
  readonly strict: boolean;
  /** `'deny'` or as set under strict; null without. */
  readonly links: Links | null;
}

export interface ResolvedCodec {
  readonly encoding: Encoding;
  /** Null: native zlib defaults. */
  readonly options: { readonly level: number } | null;
}

export interface ResolvedCompress {
  readonly codecs: readonly ResolvedCodec[];
  /** Null: every extension of the place. */
  readonly ext: readonly string[] | null;
  readonly retainRaw: boolean;
}

export interface ResolvedScript {
  /** Every script source: `compile`, then the extensions of `ext`. */
  readonly ext: readonly string[];
  /** Sources with cached data; empty when none. */
  readonly compile: readonly string[];
}

export interface ResolvedFsDomain {
  /** The union of `fs.ext` and `fs.script.ext`; null = every file. */
  readonly ext: readonly string[] | null;
  readonly writable: boolean;
  readonly zeroCopy: boolean;
  readonly compress: ResolvedCompress | null;
  readonly script: ResolvedScript | null;
  /** Explicit for disk-origin places; null where there is no disk. */
  readonly fallback: Fallback | null;
}

export interface ResolvedRequireDomain {
  /** Every extension of the domain: `compile`, then those of `ext`. */
  readonly ext: readonly string[];
  /** Extensions with cached data; empty when none. */
  readonly compile: readonly string[];
}

export interface ResolvedImportDomain {
  readonly ext: readonly string[];
}

export interface ResolvedPlace {
  readonly name: string;
  readonly enabled: boolean;
  readonly provider: Provider;
  /** Null for providers with a fixed origin (`sea`, `disk`, `node-default`). */
  readonly origin: Origin | null;
  readonly maxFileSize: number;
  readonly fs: ResolvedFsDomain | null;
  readonly require: ResolvedRequireDomain | null;
  readonly import: ResolvedImportDomain | null;
  /** Extensions the scanner loads; null = everything. */
  readonly scanExt: readonly string[] | null;
  /** The preparation index `{ [ext]: preparer }`, or null. */
  readonly prepare: { readonly [ext: string]: string } | null;
  /** Under strict, for a place with a directory on disk; else null. */
  readonly links: Links | null;
  readonly stat: { readonly birthtime: boolean; readonly directories: boolean };
  /** By key; null without rules. */
  readonly rules: { readonly [key: string]: ResolvedRule } | null;
}

export interface ResolvedIntake {
  readonly seq: 'source' | 'intake';
  readonly window: number;
  readonly limit: number;
  readonly gapTimeout: number;
  readonly spaceTimeout: number;
}

export interface ResolvedTree {
  readonly name: string;
  readonly ids: 'number' | 'string';
  readonly containers: readonly number[];
  /** As configured; [] without. */
  readonly languages: readonly string[];
  readonly birthtime: boolean;
  readonly aggregates: {
    readonly classes: boolean;
    readonly subtreeVersion: boolean;
  };
  readonly maxNodes: number;
  readonly maxFileSize: number;
  readonly compress: { readonly codecs: readonly ResolvedCodec[] } | null;
  readonly zeroCopy: boolean;
  readonly intake: ResolvedIntake;
}

/**
 * The resolved, validated configuration: deep-frozen after construction.
 * A wrong option throws an `Error` whose message starts with
 * `[vfs config]`. An explicit `undefined` anywhere in `raw` — a whole
 * section (`defaults.memory`, `defaults.compaction`, `defaults.hooks`) or
 * one of its own keys (`memory.limit`) — is the same as the key being
 * absent: the default applies.
 */
export class VfsConfig {
  #private;
  constructor(raw?: VfsRawConfig);
  /**
   * The input this config was resolved from (CLI overrides applied):
   * structured-cloneable, so workers rebuild the same config from it.
   */
  get raw(): DeepReadonly<VfsRawConfig>;
  get global(): VfsGlobal;
  /** Enabled places, in declaration order. */
  get places(): ResolvedPlace[];
  get allPlaces(): ResolvedPlace[];
  place(name: string): ResolvedPlace | null;
  /** The shared trees, in declaration order. */
  get trees(): ResolvedTree[];
  tree(name: string): ResolvedTree | null;
  /**
   * `appConfig` with the `--vfs.*` overrides of `argv` (after `--`)
   * applied: `--vfs.defaults.*`, `--vfs.places.<name>.*`,
   * `--vfs.trees.<name>.*`, `--vfs.enable` and `--vfs.disable`, then
   * validated as a JS or JSON config is.
   * `"true"` / `"false"` are booleans, a decimal a number; a setting that
   * takes a list takes a comma-separated one —
   * `--vfs.places.lib.require.compile=js,cjs`, one item included — which
   * replaces the list of `appConfig`. A place whose name holds a dot can
   * be overridden only when `appConfig.places` declares it — its key is
   * read with the longest name declared there; flags alone cannot create
   * such a place.
   */
  static fromArgv(argv: readonly string[], appConfig?: VfsRawConfig): VfsConfig;
}
