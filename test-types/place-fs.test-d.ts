// PlaceFs: reads, leases, streams, listings, compressed representations,
// script bundles and mutations, as README's "PlaceFs" table gives them.

import { delimiter, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';
import { PlaceFs, VfsDirent, VfsStats } from 'shared-memory-fs';
import type {
  Encoding,
  FileLease,
  ScriptOptions,
  VfsBigIntStats,
  VfsKernel,
  VfsReadStream,
} from 'shared-memory-fs';
import { expectType } from './expect.js';

declare const kernel: VfsKernel;
declare const res: ServerResponse;
const files = kernel.fs('static');
expectType<PlaceFs>()(files);

// --- Identity ---

expectType<string>()(files.name);
expectType<string>()(files.root);
expectType<'sab' | 'map' | 'sea'>()(files.provider);
expectType<boolean>()(files.writable);
expectType<boolean>()(files.zeroCopy);
expectType<string>()(files.pathOf('/index.html'));
expectType<boolean>()(files.exists('/index.html'));
expectType<number | null>()(files.version('/index.html'));

// --- Stats ---

expectType<VfsStats | null>()(files.stat('/index.html'));
expectType<VfsStats | null>()(files.stat('/index.html', {}));
expectType<VfsStats | null>()(files.stat('/index.html', { bigint: false }));
expectType<VfsBigIntStats | null>()(
  files.stat('/index.html', { bigint: true }),
);
const stat = files.stat('/index.html');
if (stat) {
  expectType<number>()(stat.size);
  expectType<number>()(stat.mode);
  expectType<number>()(stat.mtimeMs);
  expectType<Date>()(stat.mtime);
  expectType<boolean>()(stat.isFile());
  expectType<boolean>()(stat.isDirectory());
  expectType<false>()(stat.isSymbolicLink());
  expectType<VfsStats>()(new VfsStats(stat.size, stat.mtimeMs));
  expectType<VfsStats>()(new VfsStats(0, 0, true));
}
const big = files.stat('/index.html', { bigint: true });
if (big) {
  expectType<bigint>()(big.size);
  expectType<bigint>()(big.mtimeNs);
  expectType<Date>()(big.mtime);
}

// --- Reads ---

expectType<Buffer | null>()(files.readFile('/index.html'));
expectType<Buffer | null>()(files.readFile('/index.html', {}));
expectType<Buffer | null>()(files.readFile('/index.html', null));
expectType<Buffer | null>()(files.readFile('/index.html', { encoding: null }));
expectType<string | null>()(files.readFile('/index.html', 'utf8'));
expectType<string | null>()(
  files.readFile('/index.html', { encoding: 'utf8' }),
);
expectType<Buffer | string | null>()(
  files.readFile('/index.html', { encoding: 'utf8' as BufferEncoding | null }),
);
files.readFile('/index.html', { signal: AbortSignal.timeout(100) });

// --- Leases ---

const lease = files.readFileView('/index.html');
expectType<{
  readonly view: Buffer;
  readonly version: number | null;
  readonly release: () => void;
  readonly [Symbol.dispose]: () => void;
} | null>()(lease);
expectType<FileLease | null>()(files.readFileCompressedView('/app.css', 'br'));
if (lease) {
  res.end(Buffer.from(lease.view));
  lease.release();
  lease[Symbol.dispose]();
}
const scoped = () => {
  using held = files.readFileView('/index.html');
  return held?.view.length ?? 0;
};
void scoped;
expectType<Promise<number | null>>()(
  files.withFileView('/index.html', (view) => view.length),
);
expectType<Promise<string | null>>()(
  files.withFileView('/index.html', async (view) => view.toString()),
);

// --- Streams ---

const stream = files.createReadStream('/video.mp4', { start: 0, end: 1023 });
expectType<VfsReadStream | null>()(stream);
expectType<VfsReadStream | null>()(
  files.createReadStream('/index.html', 'utf8'),
);
files.createReadStream('/video.mp4', {
  highWaterMark: 1 << 20,
  zeroCopy: true,
  encoding: null,
  signal: AbortSignal.timeout(100),
});
const serve = async () => {
  if (!stream) return;
  expectType<() => void>()(stream.release);
  expectType<() => void>()(stream[Symbol.dispose]);
  expectType<() => Promise<void>>()(stream[Symbol.asyncDispose]);
  expectType<boolean>()(stream.readable);
  try {
    await pipeline(stream, res);
  } finally {
    stream.release();
  }
  for await (const chunk of stream) res.write(chunk);
  using disposed = stream;
  void disposed;
};
void serve;

// --- Listings ---

expectType<string[]>()(files.readdir('/'));
expectType<string[]>()(files.readdir('/', null));
expectType<string[]>()(files.readdir('/', 'utf8'));
expectType<string[]>()(files.readdir('/', { recursive: true }));
// Recursive names are `/`-separated, the form of keys; `sep: path.sep`
// asks for the native separator.
expectType<string[]>()(files.readdir('/', { recursive: true, sep }));
expectType<string[]>()(files.readdir('/', { recursive: true, sep: '/' }));
expectType<string[]>()(files.readdir('/', { recursive: true, sep: '\\' }));
expectType<Buffer[]>()(
  files.readdir('/', { recursive: true, sep, encoding: 'buffer' }),
);
expectType<VfsDirent[]>()(
  files.readdir('/', { withFileTypes: true, recursive: true, sep }),
);
expectType<string[]>()(
  files.readdir('/', { withFileTypes: false, encoding: 'latin1' }),
);
expectType<Buffer[]>()(files.readdir('/', 'buffer'));
expectType<Buffer[]>()(
  files.readdir('/', { encoding: 'buffer', recursive: true }),
);
expectType<VfsDirent[]>()(files.readdir('/', { withFileTypes: true }));
expectType<VfsDirent<Buffer>[]>()(
  files.readdir('/', { withFileTypes: true, encoding: 'buffer' }),
);
for (const entry of files.readdir('/', {
  withFileTypes: true,
  recursive: true,
})) {
  expectType<string>()(entry.name);
  expectType<string>()(entry.parentPath);
  expectType<boolean>()(entry.isFile());
  expectType<boolean>()(entry.isDirectory());
  expectType<false>()(entry.isSymbolicLink());
  expectType<VfsDirent>()(new VfsDirent(entry.name, entry.parentPath, false));
}
for (const entry of files.readdir('/', {
  withFileTypes: true,
  encoding: 'buffer',
})) {
  expectType<Buffer>()(entry.name);
}

// --- Compressed representations ---

expectType<('raw' | Encoding)[]>()(files.storedEncodings('/app.css'));
expectType<Buffer | null>()(files.readFileCompressed('/app.css', 'br'));
expectType<{
  readonly size: number;
  readonly mtimeMs: number;
  readonly sourceSize: number;
  readonly encoding: 'gzip' | 'deflate' | 'br' | 'zstd';
} | null>()(files.statCompressed('/app.css', 'gzip'));
expectType<VfsReadStream | null>()(
  files.createReadStreamCompressed('/app.css', 'zstd', { start: 0, end: 9 }),
);
files.createReadStreamCompressed('/app.css', 'deflate');

// --- Script bundles and metadata ---

// Generic calls go through a variable: a type parameter with no argument
// would otherwise be inferred from the assertion's own parameter type.
const bundle = files.script('/handler.js');
expectType<{
  source: string;
  cachedData: Buffer | null;
  scriptOptions: Readonly<ScriptOptions> | null;
  meta: { readonly [key: string]: unknown } | null;
  version: number | null;
} | null>()(bundle);
if (bundle) {
  expectType<Buffer | null>()(bundle.cachedData);
  expectType<number | null>()(bundle.version);
  expectType<string | undefined>()(bundle.scriptOptions?.filename);
  expectType<number | undefined>()(bundle.scriptOptions?.lineOffset);
  expectType<unknown>()(bundle.meta?.['key']);
}
const typed = files.script<{ key: string; tags: string[] }>('/handler.js');
expectType<string | undefined>()(typed?.meta?.key);
expectType<readonly string[] | undefined>()(typed?.meta?.tags);
expectType<string | undefined>()(
  files.meta<{ key: string }>('/handler.js')?.key,
);
const meta = files.meta('/handler.js');
expectType<{ readonly [key: string]: unknown } | null>()(meta);

// --- Mutations: sync for map and disk-origin places, a Promise for
// sab + virtual ---

const mutate = async (place: PlaceFs) => {
  await place.writeFile('/note.txt', 'hello');
  await place.writeFile('/note.txt', Buffer.from('hello'), { flag: 'wx' });
  await place.writeFile('/note.txt', new Uint8Array(2), 'utf8');
  await place.appendFile('/note.txt', ' world', { encoding: 'utf8' });
  await place.unlink('/note.txt');
  expectType<void | string>()(await place.mkdir('/dir', { recursive: true }));
  await place.mkdir('/dir');
  await place.rm('/dir/', { recursive: true, force: true });
  await place.rename('/a.txt', '/b.txt');
  place.writeFile('/sync.txt', 'no await for a map place');
  expectType<void | Promise<void>>()(place.unlink('/sync.txt'));
  expectType<void | Promise<void>>()(place.rename('/a', '/b'));
};
void mutate;

// --- A set of files as one publication: the version of its commit for
// sab + virtual ---

const batch = async (place: PlaceFs) => {
  expectType<void | Promise<number>>()(
    place.writeFiles([
      ['/a.txt', 'a'],
      ['/b.bin', new Uint8Array(1)],
    ]),
  );
  place.writeFiles(new Map([['/a.txt', 'a']]));
  place.writeFiles({ '/a.txt': 'a', '/b.txt': Buffer.from('b') });
  place.writeFiles([['/a.txt', 'a']], { flag: 'wx', encoding: 'latin1' });
  place.writeFiles({ '/a.txt': 'YQ==' }, 'base64');
  const pairs: (readonly [string, string])[] = [['/a.txt', 'a']];
  place.writeFiles(pairs);
  expectType<number | void>()(await place.writeFiles(pairs));
};
void batch;

// --- Refusals ---

// @ts-expect-error a key
files.readFile();
// @ts-expect-error a string key
files.readFile(Buffer.from('/index.html'));
// @ts-expect-error a text read gives a string
expectType<Buffer | null>()(files.readFile('/index.html', 'utf8'));
// @ts-expect-error a binary read gives a Buffer
expectType<string | null>()(files.readFile('/index.html'));
// @ts-expect-error `withFileTypes` gives Dirents
expectType<string[]>()(files.readdir('/', { withFileTypes: true }));
// @ts-expect-error a separator is `/` or `\`
files.readdir('/', { recursive: true, sep: '|' });
// @ts-expect-error a separator is `/` or `\`, never empty
files.readdir('/', { sep: '' });
// @ts-expect-error `path.delimiter` is no separator
files.readdir('/', { recursive: true, sep: delimiter });
// @ts-expect-error unknown encoding
files.readFileCompressed('/app.css', 'lz4');
// @ts-expect-error a range is numeric
files.createReadStream('/video.mp4', { start: '0' });
// @ts-expect-error a stream takes options or an encoding, never null
files.createReadStream('/video.mp4', null);
// @ts-expect-error a compressed stream takes options, not an encoding string
files.createReadStreamCompressed('/app.css', 'br', 'utf8');
// @ts-expect-error data is a string or bytes
files.writeFile('/note.txt', 42);
// @ts-expect-error `stat` takes `{ bigint }`
files.stat('/index.html', { bigInt: true });
// @ts-expect-error `stat` takes options, never null
files.stat('/index.html', null);
// @ts-expect-error a bigint stat has no `toFixed`
big?.size.toFixed();
// @ts-expect-error a lease is frozen
lease!.view = Buffer.alloc(0);
// @ts-expect-error a lease is frozen
lease!.release = () => {};
// @ts-expect-error a lease is frozen
lease!.version = 1;
// @ts-expect-error a version is looked up by key
files.version();
// @ts-expect-error a getter
files.name = 'other';
// @ts-expect-error a facade comes from `kernel.fs(name)`
new PlaceFs();
// @ts-expect-error `withFileView` gives `fn` the view
files.withFileView('/index.html', (view: string) => view.length);
// @ts-expect-error a mutation result is not a Promise for every place
files.unlink('/note.txt').then(() => {});
// @ts-expect-error data is a string or bytes
files.writeFiles([['/a.txt', 42]]);
// @ts-expect-error a removal is no write
files.writeFiles({ '/a.txt': null });
// @ts-expect-error [key, data] pairs or an object of them
files.writeFiles('/a.txt');
// @ts-expect-error the result is not a Promise for every place
files.writeFiles({ '/a.txt': 'a' }).then(() => {});
