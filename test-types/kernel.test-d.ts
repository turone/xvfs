// VfsKernel on the main thread: construction, lifecycle, link(), snapshot(),
// diagnostics(), retirements() and the adapter API, leaf by leaf; what must
// not compile.

import { EventEmitter, on, once } from 'node:events';
import { Worker } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import { VfsConfig, VfsKernel } from 'shared-memory-fs';
import pkg = require('shared-memory-fs');
import type {
  CacheEntry,
  DeepReadonly,
  FileStat,
  Place,
  PlaceChanges,
  Preparer,
  PreparerFile,
  ProjectedFile,
  PublishEvent,
  ResolvedPlace,
  ScriptOptions,
  VfsRawConfig,
} from 'shared-memory-fs';
import { expectType } from './expect.js';

const config = new VfsConfig({
  places: {
    application: {
      fs: { ext: ['js', 'css'], prepare: { api: ['js'], styles: ['css'] } },
      require: { ext: ['js'], compile: true },
    },
  },
});

// --- Construction ---

const api: Preparer = (raw, file) => {
  expectType<Buffer>()(raw);
  expectType<PreparerFile>()(file);
  expectType<{
    readonly place: string;
    readonly key: string;
    readonly path: string;
    readonly ext: string;
    readonly stat: { readonly size: number; readonly mtimeMs: number };
  }>()(file);
  return {
    source: `(${raw.toString().trim()})`,
    scriptOptions: { filename: file.path },
    meta: { key: file.key },
  };
};

const kernel = new VfsKernel(config, {
  appRoot: process.cwd(),
  console: { warn() {}, error() {} },
  seaModule: {
    isSea: () => true,
    getAssetKeys: () => ['pub/index.html'],
    getAsset: () => new ArrayBuffer(0),
  },
  preparers: {
    api,
    // A preparer may return a string, bytes, nothing (raw stays), or a
    // `{ source }` result.
    styles: (raw) => raw.toString().trim(),
    bytes: (raw) => raw,
    raw: () => null,
    silent: () => {},
    wrapped: (raw) => ({ source: raw }),
  },
});
new VfsKernel(config);
new VfsKernel(config, { console: globalThis.console });
new VfsKernel(config, { seaModule: null });
// An injected SEA module is never asked `isSea()`.
new VfsKernel(config, {
  seaModule: { getAssetKeys: () => [], getAsset: () => new ArrayBuffer(0) },
});

// --- Lifecycle and state ---

const main = async () => {
  expectType<'new' | 'initializing' | 'ready' | 'closed'>()(kernel.state);
  expectType<boolean>()(kernel.ready);
  expectType<number>()(kernel.version);
  expectType<string>()(kernel.instance);
  expectType<VfsConfig>()(kernel.config);
  expectType<string>()(kernel.appRoot);
  expectType<Promise<void>>()(kernel.initialize());
  await kernel.initialize();
  expectType<void>()(kernel.watch());
  expectType<void>()(kernel.close());
  expectType<VfsKernel | null>()(VfsKernel.current);
  VfsKernel.current = null;
  // The package's `kernel` getter, from CommonJS.
  expectType<VfsKernel | null>()(pkg.kernel);
};
void main;

// --- Events ---

const onPublish = (event: PublishEvent) => {
  expectType<{
    readonly version: number;
    readonly places: {
      readonly [name: string]: {
        readonly created: readonly string[];
        readonly replaced: readonly string[];
        readonly removed: readonly string[];
      };
    };
  }>()(event);
  for (const [name, changes] of Object.entries(event.places)) {
    expectType<string>()(name);
    expectType<PlaceChanges>()(changes);
  }
};
expectType<VfsKernel>()(kernel.on('publish', onPublish));
kernel.on('publish', (event) => expectType<PublishEvent>()(event));
kernel.once('close', () => {});
kernel.off('publish', onPublish);
expectType<number>()(kernel.listenerCount('publish'));
const emitter: EventEmitter = kernel;
void emitter;
const listen = async () => {
  const [event] = await once(kernel, 'publish');
  void event;
  for await (const [event] of on(kernel, 'publish', { close: ['close'] })) {
    void event;
  }
};
void listen;

// --- snapshot() and link() into a Worker ---

expectType<{
  readonly segments: { readonly id: number; readonly sab: SharedArrayBuffer }[];
  readonly places: {
    readonly [name: string]: { readonly entries: [string, CacheEntry][] };
  };
  readonly version: number;
  readonly instance: string;
}>()(kernel.snapshot());
const { vfs, transferList } = kernel.link();
expectType<{
  vfs: {
    snapshot: {
      readonly segments: {
        readonly id: number;
        readonly sab: SharedArrayBuffer;
      }[];
      readonly places: {
        readonly [name: string]: { readonly entries: [string, CacheEntry][] };
      };
      readonly version: number;
      readonly instance: string;
    };
    config: DeepReadonly<VfsRawConfig>;
    appRoot: string;
    port: MessagePort;
  };
  transferList: [MessagePort];
}>()(kernel.link());
new Worker('./worker.js', { workerData: { vfs }, transferList });
new VfsConfig(vfs.config);
VfsKernel.fromSnapshot(vfs.snapshot, new VfsConfig(vfs.config), {
  appRoot: vfs.appRoot,
  port: vfs.port,
  preparers: { api },
});
VfsKernel.fromSnapshot(null, config);

// --- Diagnostics, every leaf ---

type Count = { readonly representations: number; readonly bytes: number };
type Held = {
  readonly representations: number;
  readonly bytes: number;
  readonly oldestMs: number;
};
expectType<{
  readonly pool: {
    readonly limit: number;
    readonly segmentSize: number;
    readonly segments: number;
    readonly reserved: number;
    readonly used: number;
    readonly free: number;
    readonly largestFree: number;
    readonly fragmentation: number;
  };
  readonly published: { readonly files: number; readonly bytes: number };
  readonly retired: {
    readonly representations: number;
    readonly bytes: number;
    readonly oldestMs: number;
    readonly waitingAck: {
      readonly representations: number;
      readonly bytes: number;
    };
    readonly waitingRelease: {
      readonly representations: number;
      readonly bytes: number;
    };
  };
  readonly main: {
    readonly held: {
      readonly representations: number;
      readonly bytes: number;
      readonly oldestMs: number;
    };
  };
  readonly links: readonly {
    readonly id: string;
    readonly pending: { readonly updates: number; readonly oldestMs: number };
    readonly held: {
      readonly representations: number;
      readonly bytes: number;
      readonly oldestMs: number;
    };
  }[];
  readonly disk: {
    readonly files: number;
    readonly bytes: number;
    readonly fallback: { readonly files: number; readonly bytes: number };
  };
  readonly preparation: {
    readonly failures: number;
    readonly places: { readonly [place: string]: number };
  };
  readonly queues: {
    readonly watch: { readonly epochs: number; readonly rechecks: number };
    readonly mutations: { readonly keys: number; readonly barriers: number };
  };
}>()(kernel.diagnostics());
const d = kernel.diagnostics();
expectType<number>()(d.pool.largestFree);
expectType<Count>()(d.retired.waitingRelease);
for (const link of d.links) expectType<Held>()(link.held);
expectType<
  {
    id: number;
    label: string;
    place: string;
    key: string;
    representation:
      | 'source'
      | 'require:bytecode'
      | 'script:bytecode'
      | 'fs:gzip'
      | 'fs:deflate'
      | 'fs:br'
      | 'fs:zstd';
    bytes: number;
    ageMs: number;
    waiting: 'ack' | 'release';
    pending: string[];
    holders: string[];
  }[]
>()(kernel.retirements());

// --- Adapter API ---

const read = kernel.routeRead('/abs/path');
expectType<
  | {
      readonly kind: 'file' | 'dir' | 'disk';
      readonly place: Place;
      readonly key: string;
    }
  | { readonly kind: 'root' }
  | { readonly kind: 'passthrough'; readonly place?: Place }
  | { readonly kind: 'deny'; readonly code: 'EACCES' | 'EROFS' | 'ENOTDIR' }
>()(read);
expectType<
  | { readonly kind: 'store'; readonly place: Place; readonly key: string }
  | { readonly kind: 'passthrough'; readonly place?: Place }
  | { readonly kind: 'deny'; readonly code: 'EACCES' | 'EROFS' }
>()(kernel.routeMutation('/abs/path'));
if (read.kind === 'file') {
  expectType<{
    readonly name: string;
    readonly config: ResolvedPlace;
    readonly provider: 'sab' | 'map' | 'sea' | 'disk' | 'node-default';
    readonly origin: 'disk' | 'virtual' | null;
    readonly root: string;
    readonly virtual: boolean;
    pathOf(key: string): string;
  }>()(read.place);
  expectType<string>()(read.key);
}
const found = kernel.resolveModule('/abs/path', 'require');
expectType<
  | {
      readonly place: Place;
      readonly key: string;
      readonly file: ProjectedFile;
    }
  | { readonly denied: true }
  | null
>()(found);
if (found && !('denied' in found)) {
  expectType<{
    readonly data: Buffer | null;
    readonly stat: FileStat;
    readonly meta?: object;
    readonly scriptOptions?: ScriptOptions;
    readonly version?: number;
    readonly path?: string | null;
  }>()(found.file);
}
kernel.resolveModule('/abs/path', 'import');
expectType<Buffer | null>()(kernel.bytecode('/abs/path'));

// --- Refusals ---

// @ts-expect-error a config is required
new VfsKernel();
// A VfsConfig instance, not a look-alike: the class is nominal.
declare const configLookalike: Pick<VfsConfig, keyof VfsConfig>;
// @ts-expect-error not a VfsConfig
new VfsKernel(configLookalike);
// @ts-expect-error unknown option
new VfsKernel(config, { root: '/app' });
// @ts-expect-error a preparer is a function
new VfsKernel(config, { preparers: { api: 'api' } });
// @ts-expect-error preparers are synchronous
new VfsKernel(config, { preparers: { api: async () => 'x' } });
// @ts-expect-error a preparer returns a string, bytes or { source }
new VfsKernel(config, { preparers: { api: () => 42 } });
// @ts-expect-error `source` is required in the object form
new VfsKernel(config, { preparers: { api: () => ({ meta: {} }) } });
// @ts-expect-error a logger errors as well
new VfsKernel(config, { console: { warn() {} } });
// @ts-expect-error a logger warns as well
new VfsKernel(config, { console: { error() {} } });
// @ts-expect-error a SEA module gives its assets
new VfsKernel(config, { seaModule: { getAssetKeys: () => [] } });
// @ts-expect-error initialize() takes nothing
kernel.initialize(config);
// @ts-expect-error a place name
kernel.fs();
// @ts-expect-error a place name, not a place
kernel.fs(config.places[0]);
// @ts-expect-error read-only
kernel.state = 'ready';
// @ts-expect-error read-only
kernel.appRoot = '/elsewhere';
// @ts-expect-error no such event
kernel.on('published', () => {});
// @ts-expect-error a 'publish' listener gets the event
kernel.on('publish', (event: string) => void event);
// @ts-expect-error 'close' has no argument
kernel.on('close', (reason: Error) => void reason);
kernel.on('publish', (event) => {
  // @ts-expect-error an event is frozen
  event.version = 0;
  // @ts-expect-error an event is frozen
  event.places['static']?.created.push('/x');
});
// @ts-expect-error the kernel's own count
kernel.version = 7;
// @ts-expect-error the main kernel's id
kernel.instance = 'other';
// @ts-expect-error a frozen result
d.retired.bytes = 0;
// @ts-expect-error a frozen result
d.links.push({
  id: 'x',
  pending: { updates: 0, oldestMs: 0 },
  held: d.main.held,
});
// @ts-expect-error a module domain
kernel.resolveModule('/abs/path', 'fs');
if (read.kind === 'passthrough') {
  // @ts-expect-error no `key` on a passthrough
  read.key;
  // Under strict, the place whose disk it lies on.
  expectType<Place | undefined>()(read.place);
}
expectType<typeof found>()(kernel.resolveModule('/abs/path', 'require', true));
