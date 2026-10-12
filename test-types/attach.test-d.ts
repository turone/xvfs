// The worker side: attach(); FilesystemCache, the pool index.js exports,
// leaf by leaf; the error shape.

import { workerData } from 'node:worker_threads';
import { attach, FilesystemCache, VfsKernel } from 'xvfs';
import type { Extent, FileInput, VfsError, VfsLink } from 'xvfs';
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
const fill = async () => {
  const input: FileInput = {
    data: Buffer.from('x'),
    stat: { size: 1, mtimeMs: 0 },
  };
  expectType<Promise<Extent | null>>()(cache.allocate(input));
  const extent = await cache.allocate(input, { maxFileSize: 2 });
  if (extent) {
    expectType<number>()(extent.segmentId);
    expectType<number>()(extent.offset);
    expectType<number>()(extent.length);
    expectType<void>()(cache.committed(extent));
    expectType<void>()(cache.free(extent));
  }
  expectType<void>()(cache.free(null));
  expectType<void>()(cache.reopen(1));
  expectType<Extent | null>()(
    cache.allocateSync({
      data: Buffer.from('x'),
      stat: { size: 1, mtimeMs: 0 },
    }),
  );
  expectType<{ readonly id: number; readonly sab: SharedArrayBuffer } | null>()(
    cache.getSegment(1),
  );
  expectType<number | null>()(cache.compactTarget(0.3));
  expectType<Extent[] | null>()(cache.relocate(2, extent ? [extent] : []));
  expectType<{ readonly id: number; readonly sab: SharedArrayBuffer }[]>()(
    cache.snapshot(),
  );
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
// @ts-expect-error a link carries config, appRoot and port
attach({ link: { config: link.config } });
// @ts-expect-error unknown option
attach({ hooks: false });
// @ts-expect-error the cache needs its budget
new FilesystemCache();
// @ts-expect-error `allocateSync` takes in-memory bytes
cache.allocateSync({ path: '/x', stat: { size: 1, mtimeMs: 0 } });
// @ts-expect-error the pool knows extents, never keys
cache.free('/x');
