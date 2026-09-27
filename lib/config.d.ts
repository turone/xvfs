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
 * `prepare` of a domain: a preparer name for every extension of the
 * domain's own finite `ext`, or `{ name: [ext, …] }`. Names are registered
 * as functions in the kernel option `preparers`.
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

export interface ScriptConfig {
  /** Sources compiled for `PlaceFs.script()`. Default `['js', 'cjs']`. */
  ext?: readonly string[];
  /** Build the `\0script:bytecode` companion. Default true. */
  compile?: boolean;
}

export interface FsDomainConfig {
  /** Visible extensions; absent = every file. */
  ext?: readonly string[];
  writable?: boolean;
  zeroCopy?: boolean;
  compress?: CompressConfig | false | null;
  script?: ScriptConfig | boolean;
  prepare?: PrepareConfig;
  /** Disk-origin places only; default `'deny'` under strict, else `'disk'`. */
  fallback?: Fallback;
}

export interface RequireDomainConfig {
  /** Default `['js', 'cjs', 'json']`. */
  ext?: readonly string[];
  /** Build the `\0require:bytecode` companion. Default true. */
  compile?: boolean;
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
}

/** The raw configuration: hardcoded defaults → `defaults` → per place. */
export interface VfsRawConfig {
  defaults?: VfsDefaults | null;
  places?: { [name: string]: PlaceConfig };
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
  readonly ext: readonly string[];
  readonly compile: boolean;
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
  readonly ext: readonly string[];
  readonly compile: boolean;
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
}

/**
 * The resolved, validated configuration: deep-frozen after construction.
 * A wrong option throws an `Error` whose message starts with
 * `[vfs config]` — except an explicit `undefined` given for `memory`,
 * `compaction` or `hooks` of `defaults`, which today replaces the section
 * and fails as a `TypeError`.
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
  /**
   * `appConfig` with the `--vfs.*` overrides of `argv` (after `--`)
   * applied: `--vfs.defaults.*`, `--vfs.places.<name>.*`, `--vfs.enable`
   * and `--vfs.disable`.
   */
  static fromArgv(argv: readonly string[], appConfig?: VfsRawConfig): VfsConfig;
}
