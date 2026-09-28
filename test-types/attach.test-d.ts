// The worker side: attach(); FilesystemCache, the engine index.js exports,
// leaf by leaf; the error shape.

import { workerData } from 'node:worker_threads';
import { attach, FilesystemCache, VfsKernel } from 'xvfs';
import type {
  CacheEntry,
  FileInput,
  FileStat,
  ScriptOptions,
  VfsError,
  VfsLink,
} from 'xvfs';
import { expectType } from './expect.js';

// --- attach() ---

expectType<VfsKernel>()(attach());
expectType<VfsKernel>()(attach({}));
attach({ link: workerData.vfs });
attach({ preparers: { api: (raw) => raw.toString() } });
declare const link: VfsLink;
attach({ link, preparers: {} });

// --- FilesystemCache ---

const cache = new FilesystemCache({
  limit: 4 * 1024 * 1024,
  segmentSize: 262144,
  maxFileSize: 65536,
});
// A reader is awaited: synchronous or not.
new FilesystemCache({
  limit: 1,
  segmentSize: 1,
  maxFileSize: 1,
  reader: (file, view) => {
    expectType<FileInput>()(file);
    view.fill(0);
  },
});
new FilesystemCache({
  limit: 1,
  segmentSize: 1,
  maxFileSize: 1,
  reader: async () => {},
});
type Shared = {
  readonly kind: 'shared';
  readonly segmentId: number;
  readonly offset: number;
  readonly length: number;
  readonly stat: FileStat;
  readonly meta?: object;
  readonly scriptOptions?: ScriptOptions;
  readonly version?: number;
};
type Disk = {
  readonly kind: 'disk';
  readonly path: string | null;
  readonly stat: FileStat;
  readonly meta?: object;
  readonly scriptOptions?: ScriptOptions;
  readonly version?: number;
};
type Projected = {
  readonly data: Buffer | null;
  readonly stat: FileStat;
  readonly meta?: object;
  readonly scriptOptions?: ScriptOptions;
  readonly version?: number;
  readonly path?: string | null;
};
const fill = async () => {
  const input: FileInput = {
    data: Buffer.from('x'),
    stat: { size: 1, mtimeMs: 0 },
  };
  expectType<Promise<Shared | Disk | null>>()(cache.allocate(input));
  const entry = await cache.allocate(input, { fallback: false });
  if (entry?.kind === 'shared') expectType<number>()(entry.segmentId);
  if (entry?.kind === 'disk') expectType<string | null>()(entry.path);
  if (entry) {
    expectType<CacheEntry | null>()(cache.put('static', '/x', entry));
    expectType<Shared | Disk | null>()(cache.remove('static', '/x'));
    expectType<void>()(cache.free(entry));
    expectType<Projected>()(FilesystemCache.projectEntry(entry, new Map()));
  }
  expectType<Shared | null>()(
    cache.allocateSync({
      data: Buffer.from('x'),
      stat: { size: 1, mtimeMs: 0 },
    }),
  );
  expectType<{ readonly id: number; readonly sab: SharedArrayBuffer } | null>()(
    cache.getSegment(1),
  );
  expectType<{ readonly entries: Map<string, CacheEntry> }>()(
    cache.index('static'),
  );
  expectType<Shared | Disk | null>()(cache.entry('static', '/x'));
  expectType<{ name: string; key: string; entry: Shared }[] | null>()(
    cache.compact(0.3),
  );
  expectType<Map<string, Projected>>()(
    FilesystemCache.project(cache.index('static'), new Map()),
  );
  expectType<Map<string, Projected>>()(
    FilesystemCache.project(
      cache.snapshot().places['static'],
      new Map(),
      new Map(),
    ),
  );
  expectType<{
    readonly segments: {
      readonly id: number;
      readonly sab: SharedArrayBuffer;
    }[];
    readonly places: {
      readonly [name: string]: { readonly entries: [string, CacheEntry][] };
    };
  }>()(cache.snapshot());
  expectType<{
    readonly limit: number;
    readonly segmentSize: number;
    readonly segments: number;
    readonly reserved: number;
    readonly used: number;
    readonly free: number;
    readonly largestFree: number;
    readonly fragmentation: number;
  }>()(cache.usage());
  expectType<number>()(cache.totalUsed);
  expectType<{
    readonly segmentCount: number;
    readonly emptyCount: number;
    readonly totalUsed: number;
    readonly lines: string[];
  }>()(cache.stats());
};
void fill;

// --- Errors ---

const refused = (err: unknown) => {
  const error = err as VfsError;
  expectType<string>()(error.code);
  expectType<number | undefined>()(error.errno);
  expectType<string | undefined>()(error.syscall);
  expectType<string | undefined>()(error.path);
  expectType<string | undefined>()(error.dest);
  expectType<unknown>()(error.cause);
  const node: NodeJS.ErrnoException = error;
  void node;
};
void refused;

// --- Refusals ---

// @ts-expect-error the options object replaced the positional link
attach(link);
// @ts-expect-error a link is the `vfs` object of `kernel.link()`
attach({ link: 'vfs' });
// @ts-expect-error a link carries snapshot, config, appRoot and port
attach({ link: { snapshot: link.snapshot } });
// @ts-expect-error unknown option
attach({ hooks: false });
// @ts-expect-error the cache needs its budget
new FilesystemCache();
// @ts-expect-error `allocateSync` takes in-memory bytes
cache.allocateSync({ path: '/x', stat: { size: 1, mtimeMs: 0 } });
// @ts-expect-error a cache entry, not a projected file
cache.put('static', '/x', { data: null, stat: { size: 0, mtimeMs: 0 } });
