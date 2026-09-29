// Types of kernel.js: VfsKernel, the orchestrator of the main thread and
// the projection of a worker. README, "VfsKernel (main thread)",
// "Versions", "Publication events", "Diagnostics", "Adapter API" and
// "VfsKernel (worker)".

import { EventEmitter } from 'node:events';
import type { MessagePort } from 'node:worker_threads';
import type { PoolUsage, ProjectedFile, VfsSnapshot } from './cache.js';
import type {
  DeepReadonly,
  Encoding,
  Links,
  VfsConfig,
  VfsRawConfig,
} from './config.js';
import type { PreparerTable } from './pipeline.js';
import type { Place } from './place.js';
import type { PlaceFs } from './place-fs.js';
import type { MutationRoute, ReadRoute } from './registry.js';

/** `new → initializing → ready → closed` (final). */
export type KernelState = 'new' | 'initializing' | 'ready' | 'closed';

/** What the kernel logs to: `globalThis.console` by default. */
export interface VfsLogger {
  warn(message: string): void;
  error(message: string): void;
}

/**
 * A `node:sea`-compatible module, injected for tests. `isSea()` is asked
 * of the real `node:sea` only, never of an injected module.
 */
export interface SeaModule {
  isSea?(): boolean;
  getAssetKeys(): string[];
  getAsset(key: string): ArrayBuffer;
}

export interface VfsKernelOptions {
  /** Root of the place directories. Default `process.cwd()`. */
  appRoot?: string;
  console?: VfsLogger;
  /** Default: `node:sea`, if any. */
  seaModule?: SeaModule | null;
  /**
   * The functions the domains' `prepare` names; every name an enabled place
   * uses must be here.
   */
  preparers?: PreparerTable;
}

export interface FromSnapshotOptions extends VfsKernelOptions {
  /** The link end of `kernel.link()`: deltas, ACKs, releases and mutations. */
  port?: MessagePort | null;
}

/** The `vfs` object of `kernel.link()`: a worker's `workerData.vfs`. */
export interface VfsLink {
  snapshot: VfsSnapshot;
  config: DeepReadonly<VfsRawConfig>;
  appRoot: string;
  port: MessagePort;
}

/** Ready for `new Worker(file, { workerData: { vfs }, transferList })`. */
export interface LinkResult {
  vfs: VfsLink;
  transferList: [MessagePort];
}

/** A source, or one of its companions: retired and freed on its own. */
export type Representation =
  'source' | 'require:bytecode' | 'script:bytecode' | `fs:${Encoding}`;

/** One entry of `kernel.retirements()`. */
export interface RetiredVersion {
  id: number;
  /** `static:/video.mp4 [fs:br]#1847`; never parsed back. */
  label: string;
  place: string;
  key: string;
  representation: Representation;
  bytes: number;
  ageMs: number;
  /** Waiting for worker ACKs, or only for its holders to release it. */
  waiting: 'ack' | 'release';
  /** Link ids whose ACK is pending. */
  pending: string[];
  /** Link ids, or `'main'`, still reading it. */
  holders: string[];
}

export interface RepresentationCount {
  readonly representations: number;
  readonly bytes: number;
}

export interface HeldRepresentations extends RepresentationCount {
  /** Age of the oldest; 0 when none. */
  readonly oldestMs: number;
}

/** Replaced or removed representations not freed yet. */
export interface RetiredRepresentations extends HeldRepresentations {
  /** Their update not ACKed by every worker. */
  readonly waitingAck: RepresentationCount;
  /** ACKed, still read by a stream or lease. */
  readonly waitingRelease: RepresentationCount;
}

/** One linked worker in `kernel.diagnostics()`. */
export interface LinkDiagnostics {
  readonly id: string;
  /** Updates it has not ACKed; a growing `oldestMs` is a stuck worker. */
  readonly pending: { readonly updates: number; readonly oldestMs: number };
  /** Retired representations its streams and leases still read. */
  readonly held: HeldRepresentations;
}

/**
 * What the shared memory holds and why, as of the call: a frozen plain
 * object, a new one each time. Read-only: it frees, settles, compacts and
 * publishes nothing.
 */
export interface VfsDiagnostics {
  readonly pool: PoolUsage;
  /**
   * What the shared places (`sab`, `sea`) publish: sources, and the bytes
   * their versions take of the pool, companions included.
   */
  readonly published: { readonly files: number; readonly bytes: number };
  readonly retired: RetiredRepresentations;
  /** What this thread's streams and leases still read. */
  readonly main: { readonly held: HeldRepresentations };
  readonly links: readonly LinkDiagnostics[];
  /** Published sources read from disk; `fallback`: for want of room. */
  readonly disk: {
    readonly files: number;
    readonly bytes: number;
    readonly fallback: { readonly files: number; readonly bytes: number };
  };
  /**
   * Preparations that failed since `initialize()`: in all, and per place
   * that declares `prepare`.
   */
  readonly preparation: {
    readonly failures: number;
    readonly places: { readonly [place: string]: number };
  };
  /**
   * Strict routing, null without: each place's `links`, for a place with a
   * directory on disk; how many links the index holds — some possibly gone,
   * dropped the first time a path through one is checked.
   */
  readonly strict: {
    readonly links: { readonly [place: string]: Links };
    readonly known: number;
  } | null;
  readonly queues: {
    /** Watcher epochs queued or running; rechecks waiting. */
    readonly watch: { readonly epochs: number; readonly rechecks: number };
    /**
     * Keys of virtual places with a mutation queued or running; places a
     * subtree mutation holds.
     */
    readonly mutations: { readonly keys: number; readonly barriers: number };
  };
}

export type ModuleDomain = 'require' | 'import';

/**
 * A published source visible to the domain; `{ denied: true }` under
 * strict for nothing published, or for a source named as a directory;
 * null: not ours, the default Node loader.
 */
export type ModuleResolution =
  | {
      readonly place: Place;
      readonly key: string;
      readonly file: ProjectedFile;
    }
  | { readonly denied: true }
  | null;

/** What one publication changed in one place: source keys, no companion. */
export interface PlaceChanges {
  /** Keys that had no file before. */
  readonly created: readonly string[];
  /** Keys whose file it replaced. */
  readonly replaced: readonly string[];
  readonly removed: readonly string[];
}

/**
 * A publication this thread applied, after its commit: its version and
 * what it changed, by place. Frozen, strings and numbers only — it holds
 * no shared bytes; what a key holds now is read through `kernel.fs()`,
 * and may be newer already.
 */
export interface PublishEvent {
  readonly version: number;
  readonly places: { readonly [name: string]: PlaceChanges };
}

/**
 * The events of a kernel, in every thread: `'publish'` once per
 * publication it applies, in the order of their versions — shared places
 * only; `'close'` once, last. Never `'error'`.
 */
export interface VfsKernelEvents {
  publish: [event: PublishEvent];
  close: [];
}

/**
 * Main thread: fills the places from their origin through one publication
 * pipeline, watches disk-origin places and sends each epoch as one
 * `vfs-update` to the linked workers, freeing a replaced version only
 * after every worker ACKs and no thread still reads it. Worker thread
 * (`fromSnapshot()`, `attach()`): the same segments projected read-only.
 * Both emit the events of `VfsKernelEvents`: `'publish'` in a microtask
 * after the commit — before the promise of the mutation that published
 * settles — and never once `close()` has returned; a listener that throws
 * is an uncaught exception.
 */
export class VfsKernel extends EventEmitter<VfsKernelEvents> {
  #private;
  /** Published by `--import xvfs/register` or `attach()`. */
  static get current(): VfsKernel | null;
  static set current(kernel: VfsKernel | null);
  /**
   * A worker's projection of `snapshot`; with `port`, it applies deltas,
   * ACKs them and sends mutations of shared virtual places. Prefer
   * `attach()`.
   */
  static fromSnapshot(
    snapshot: VfsSnapshot | null | undefined,
    config: VfsConfig,
    options?: FromSnapshotOptions,
  ): VfsKernel;
  constructor(config: VfsConfig, options?: VfsKernelOptions);
  readonly config: VfsConfig;
  readonly appRoot: string;
  console: VfsLogger;
  readonly state: KernelState;
  get ready(): boolean;
  /**
   * Publications this thread has committed (main) or applied (worker): the
   * version of the last one, 0 before the first. A commit that publishes —
   * init, a watcher epoch, a mutation of a virtual place — takes the next
   * one; one that changes nothing, and a compaction, none.
   */
  get version(): number;
  /**
   * The main kernel's random id, the same in every thread linked to it: a
   * version restarts with each process, `instance` with `version` does not.
   */
  get instance(): string;
  /**
   * Scan / SEA / map through the publication pipeline: preparers,
   * bytecode, compression. A failure closes the kernel. Once, from `new`.
   */
  initialize(): Promise<void>;
  /**
   * Final: stops the watcher and every stream, rejects queued mutations
   * and those still publishing — all with `ERR_VFS_CLOSED` — and drops
   * every projection.
   * The first call emits `'close'` in a microtask, then drops every
   * listener.
   */
  close(): void;
  /** The `PlaceFs` of an indexed place with an fs domain; throws otherwise. */
  fs(name: string): PlaceFs;
  /** Published entries only, with `version` and `instance`; main thread. */
  snapshot(): VfsSnapshot;
  /** Everything a worker needs: snapshot, config, appRoot, a MessagePort. */
  link(): LinkResult;
  /** Main thread, ready kernel: throws otherwise. */
  diagnostics(): VfsDiagnostics;
  /** Retired versions not yet freed. Internal diagnostics, not a stable API. */
  retirements(): RetiredVersion[];
  /**
   * Start the watcher of the disk-origin places (automatic with
   * `defaults.watch` or a writable disk-origin place).
   */
  watch(): void;
  // --- Adapter API (lib/adapters/*): raw routing decisions and borrowed
  // views, without the ownership and ext policies PlaceFs applies.
  /**
   * `own`: the operation does not follow the path's last name (`lstat`,
   * `readlink`, `unlink`, …), which `links: 'deny'` then lets be a link.
   */
  routeRead(filePath: string, own?: boolean): ReadRoute;
  routeMutation(filePath: string, own?: boolean): MutationRoute;
  /**
   * `loading`: the load hook asks about the file Node's loader is to read;
   * under strict a module of a `disk` or `node-default` place behind a
   * known link (`links: 'deny'`) or that really lies elsewhere
   * (`'verify'`) is `{ denied: true }` then.
   */
  resolveModule(
    filePath: string,
    domain: ModuleDomain,
    loading?: boolean,
  ): ModuleResolution;
  /** A borrowed SAB view of the cached data of a CommonJS source, or null. */
  bytecode(filePath: string): Buffer | null;
}
