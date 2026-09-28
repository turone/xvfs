# Use cases and alternatives

xvfs gives a Node.js process **one copy of the files its
`worker_threads` serve** — static assets, templates, configuration,
handler sources, modules — under the real paths the application already
uses, with every change published to every thread at once.
`SharedArrayBuffer` is the mechanism. The subject is how many copies of a
file a process holds, which work on it is done once, and how every thread
comes to serve the same version at the same moment.

This page says what the library does, where it fits in production, what it
leaves out on purpose, and how it compares with its neighbours. Figures are
quoted from [benchmarks.md](benchmarks.md): one machine, one revision, the
method described there.

Contents: [What it does](#what-it-does) ·
[What it does not do](#what-it-does-not-do) ·
[Production scenarios](#production-scenarios) · [Measured](#measured) ·
[Alternatives](#alternatives) · [When not to use it](#when-not-to-use-it) ·
[Sources](#sources)

## What it does

**Places over the real paths.** A place is a directory under `appRoot`;
its name is the mount, the cache namespace and the key of every update.
The _provider_ says where the bytes live — `sab` (the shared pool), `map`
(a per-thread `Map`), `sea` (the pool, filled from SEA assets), `disk` and
`node-default` (passthrough mounts) — and the _origin_ where the content
comes from: `disk` (a scanner, then a watcher) or `virtual` (the
application writes it). Code that reads `appRoot/static/index.html` keeps
doing so and gets the shared bytes. → README
[Providers](../README.md#providers).

**Transparent to existing code.** `hooks.fs` routes `node:fs` — sync,
callback and promises forms — through the kernel: `readFile`, `stat`,
`readdir`, `opendir`, `createReadStream`, `writeFile`, `unlink`, `rename`,
`copyFile`, … `hooks.module` is one `module.registerHooks` chain for
`require()` and `import` of published files, with plain `file:` URLs, so
`__filename`, `import.meta.url` and `require.cache` mean what they always
did. Code that prefers an explicit API takes `kernel.fs(name)`, a
`PlaceFs`. → README [Patched `node:fs`](../README.md#patched-nodefs),
[`PlaceFs`](../README.md#placefs), [integration.md → Hooks](integration.md#hooks).

**`prepare`: one canonical content per file.** A synchronous callback,
declared per extension, turns the raw input into the content every domain
serves — minified, wrapped, bundled, templated — once per publication,
never on read; the initial scan, watcher epochs, SEA assets and virtual
writes all pass through it. It may return `{ source, scriptOptions, meta }`:
`scriptOptions` go to V8 when `fs.script` cached data is built, `meta` is
stored frozen with the entry and read in every thread with `meta(key)`. The
library ships the mechanism and no preparers. → README
[Preparation](../README.md#preparation-prepare).

**V8 cached data, built once.** `require: { compile: true }` compiles
CommonJS sources on the main thread and stores the bytecode next to the
source; a worker's `require()` gets it as `cachedData` and skips parsing
and compilation. `fs.script.compile` does the same for the bare source, for
code that builds its own `vm.Script` (`PlaceFs.script(key)`). An update
rebuilds the bytecode and ships it in the same message as the source. A
`map` place compiles in its own thread on every write. ESM has no bytecode
cache. → README [`fs.script`](../README.md#fsscript),
[integration.md → V8 bytecode](integration.md#v8-bytecode-for-a-hot-module-path).

**Pre-compressed representations.** `gzip`, `deflate`, `br` and `zstd`
are built at publication and stored next to the source;
`storedEncodings(key)` says what exists, `readFileCompressed*` and
`createReadStreamCompressed` serve it. `Accept-Encoding` negotiation stays
in the server. `retainRaw: false` keeps only the compressed bytes in memory
and serves the source from disk. → README
[Compression](../README.md#compression).

**Live updates, atomic for every thread.** The watcher batches disk events
into epochs processed strictly in order; a virtual write is a publication
of its own. Each publication is one `vfs-update` that carries a file's
source together with its bytecode and compressed representations — a
companion never outlives its source. A replaced version is retired, and its
bytes return to the pool only after every worker has ACKed the update and
no stream or lease in any thread still reads them: a reader finishes the
version it started with, and nothing is freed on a timeout. A preparer that
throws keeps the previous version. → README
[Lifetime of shared bytes](../README.md#lifetime-of-shared-bytes),
[Protocol](../README.md#protocol).

**Zero-copy views and streams.** `readFileView()` and `withFileView()`
lease a `Buffer` over the shared bytes; `createReadStream({ zeroCopy })`
yields borrowed chunks; `readFile()` returns an owned copy where that is
simpler. A lease costs about 100 ns and copies nothing, whatever the size of
the file. → README
[Lifetime of shared bytes](../README.md#lifetime-of-shared-bytes),
[Streaming and HTTP Range](../README.md#streaming-and-http-range).

**Writable virtual places.** With `origin: 'virtual'` the content is what
the application writes — data or code generated at run time. A
`sab + virtual` place is shared: the main thread or any worker writes it (a
worker's write travels to the main thread, which prepares, compiles and
publishes it before the Promise resolves), and every thread reads the same
version. A `map + virtual` place is per-thread and synchronous: scratch
space, a workspace of one worker. Both keep a filesystem's hierarchy
(`ENOTDIR`, `EISDIR`, `EXDEV` where a filesystem says so) and go through the
same pipeline. → README [Providers](../README.md#providers),
[Map provider](../README.md#map-provider).

**`strict` as an access policy; `fs.fallback`.** `strict: true` makes
`appRoot` the routing boundary: a path under it that no place owns is
`EACCES` before the disk is touched, `readdir(appRoot)` lists the places,
and `require` and `import` follow the same rule. `fs.fallback: 'disk'` lets
a disk-origin place serve from disk what its cache filters do not select —
html and js from memory, media from disk — inside that place only. Both
are routing policies for code that goes through `node:fs` and the module
hooks, not isolation of untrusted code. → README
[Strict routing](../README.md#strict-routing),
[Partial disk cache](../README.md#partial-disk-cache-fsfallback).

**SEA assets.** `provider: 'sea'` loads the `node:sea` assets under
`<name>/…` into the pool at `initialize()`, then behaves as a `sab` place:
shared with the workers, prepared, compiled and compressed as configured,
read-only. One server runs from a directory in development and from the
executable when packaged. → README [SEA provider](../README.md#sea-provider),
[examples/sea-static/](../examples/sea-static/).

**What stays on disk.** `memory.maxFileSize` keeps large disk files out of
the pool: they stay disk entries, served from disk through the same API.
Content without a disk file of its own — prepared, virtual, SEA — either
fits or its publication is refused. → README
[`VfsConfig`](../README.md#vfsconfig).

**One set of path rules on every platform.** Place keys are `/`-separated;
a trailing separator names a directory, as on POSIX, on Windows too;
routing is lexical — a path as `path.resolve` gives it, only a real `..`
leaves `appRoot` — and does not touch the disk for the paths it routes.
Names compare as the file system compares them: on Windows `appRoot` and
a place's name in any case (`appRoot\RO\x` is place `ro`, prepared and
read-only as ever), while a key keeps its case — and a key in another
case never gets the raw file where the disk would answer. Under strict,
UNC and namespace forms (`\\?\C:\…`, `\\localhost\C$\…`), NTFS stream
syntax and 8.3 short names where they may stand for `appRoot` are refused
before any native I/O; what only the disk knows of `appRoot` itself — its
real path, what a drive letter names — is learned once, and a drive that
names it or a share is refused whole, as is its real path when it is
spelled through a link; a native call on a place's disk proves where its
path really lands, and the patch makes no link into managed territory. A
link that already leads into `appRoot` from outside it is not covered:
strict is a routing policy, not an OS sandbox. The watcher works around a
Windows abort on 8.3 aliases in watched paths (nodejs/node#63638). → README
[Strict routing](../README.md#strict-routing),
[Patched `node:fs`](../README.md#patched-nodefs),
[Support](../README.md#support).

## What it does not do

The contract is narrow on purpose ([architecture.md → Purpose](architecture.md#purpose)):

- **A subset of `node:fs`.** Reads, stats, listings, streams and single-file
  mutations are served. `open()` of a published entry is `ENOTSUP` — there
  is no file descriptor — and so are `watch` of managed territory, recursive
  `cp`, hard links, directory renames across a place's boundary and
  recursive walks from above `appRoot`. What is not served is refused
  before anything is read, never approximated. → README
  [Patched `node:fs`](../README.md#patched-nodefs).
- **Not a sandbox.** `strict` decides which paths are served. Native addons,
  child processes and the worker threads that share the process reach the
  OS by other means, and same-process places are not firewalled from each
  other.
- **Module resolution of files and directories only.** `require` gets
  Node's LOAD_AS_FILE and LOAD_AS_DIRECTORY (`package.json` `main`,
  `index.*`) over published entries; `import` needs the extension, as in
  Node. `exports` and `imports` maps are not consulted; bare specifiers go
  to Node's own resolver; native addons never load from memory; ESM has no
  bytecode.
- **No module-cache invalidation.** Replacing a source publishes new bytes;
  a module already loaded stays loaded until the application deletes it
  from `require.cache`. Node offers no API to evict an ES module instance.
- **No change events.** A thread reads what is published when it reads;
  nothing tells the application that a key changed, and `fs.watch` of
  managed territory is `ENOTSUP`. `stat(key)` (55 ns) shows a new version's
  `mtimeMs` and `size`.
- **One process.** A `SharedArrayBuffer` is shared between the threads of
  one process; `cluster` and `child_process` get nothing from it.
- **No persistence, no eviction.** Virtual content lives as long as the
  kernel, `map` content as long as its thread. There are no TTLs and no
  LRU: the pool holds every published file within `memory.limit`, reuses
  freed segments and returns none to the OS before `close()`.
- **Synchronous preparers on the publishing thread** — the main thread for
  shared places: a preparer that takes 300 ms stalls that event loop for
  300 ms.
- **Asynchronous shared mutations, eventual disk-origin consistency.** A
  `sab + virtual` write returns a Promise; `*Sync` forms are `ENOTSUP`. A
  write into a writable disk-origin place goes to disk, and the watcher
  publishes it after its debounce (`watchTimeout`, 1 s by default).

## Production scenarios

Each scenario names what to configure, what it gives over the usual way,
and what stays the application's job.

### Static assets and server-side templates in a worker pool

A `sab` place over the directory, `zeroCopy` for leases, `compress` for the
text formats, `watch` for edits in place. Every worker `attach()`es and
serves from the same bytes: `readFileView()` for whole files, a zero-copy
stream for `Range` requests, `readFileCompressedView()` when the client
accepts `br` or `gzip`. A template engine that reads its templates through
`node:fs` needs no change: the patched `readFileSync` hands it the shared
content as an owned copy.

```js
places: {
  public: {
    fs: {
      ext: ['html', 'css', 'js', 'svg'],
      zeroCopy: true,
      compress: { encodings: ['br', 'gzip'], ext: 'compressible' },
    },
  },
}
```

**Against the usual way** — each worker reading through `node:fs`, or
holding a Buffer cache of its own: one copy of the set instead of one per
worker (261 MiB against 348 MiB of RSS at eight workers for a 20 MiB set;
1.4 GiB apart, by extrapolation, for 200 MiB); a lease of ~100 ns instead
of the syscalls of a read (18.6 µs for 1 KiB out of the page cache);
representations built once at publication (180 ms for the 20 MiB set)
instead of per request (1.5 M against 1 k requests per second at four
workers); and an update every worker serves from the same moment, while
responses in flight finish the version they started with.

**Not covered:** the HTTP server, content negotiation, `ETag` /
`Cache-Control`, MIME types; files above `maxFileSize` stay on disk and
stream from there; a CDN in front still does what a CDN does. →
[examples/worker-static/](../examples/worker-static/),
[integration.md → Static server](integration.md#static-server-with-pre-compressed-assets).

### An application cache: configuration, i18n, feature flags, reference data

The data every request needs — settings, translations, flags, lookup
tables — as files of a place: a `sab` place over a directory the
deployment updates (with `watch`), or a `sab + virtual` place the
application writes from the main thread or from a worker. Every thread
reads the current version; a file changes atomically, together with its
companions, and no thread sees half a publication. A preparer can parse the
file once, at publication, and hand the parsed result to every thread as
`meta` — frozen, cloned into each thread's projection — so a request reads
`meta(key)` and parses nothing.

```js
places: {
  settings: {
    origin: 'virtual',
    fs: { writable: true, ext: ['json'], prepare: 'parsed' },
  },
}
// preparers: { parsed: (raw) => ({ source: raw, meta: JSON.parse(raw) }) }
```

**Against the usual way** — a cache object in every worker (`lru-cache`
and the like), loaded and invalidated per thread, or a `require()`d JSON
that stays what it was at first load: one copy, one invalidation, the same
version in every thread at the same moment — a virtual write is published
and ACKed by four workers in ~45 µs (p50), a watcher epoch reaches every
worker in ~220–245 µs. Against Redis or memcached: no round trip and no
deserialization on the read path — a lease, or a frozen `meta` — for data
that lives in the process anyway.

**Not covered:** a set of files that must change together — a watcher
epoch carries the files that changed within its debounce, a virtual write
publishes one key — so values that must change together belong in one
file. No notification of a change: read on each request, or compare
`stat(key).mtimeMs`. No TTL, no eviction, no queries; nothing across
processes or machines; a virtual place is not persisted.

### Hot reload of content and handlers without a restart

Disk-origin places with `watch: true` republish an edited file — source,
bytecode, representations — in one message, and content is served new from
the next read on. For code there are two shapes: a `require` domain, where
the application deletes the entry from `require.cache` and the next
`require()` loads the new source with its new bytecode
([examples/hot-reload-routes/](../examples/hot-reload-routes/)); or
`fs.script`, where the application builds a `vm.Script` from `script(key)`
and builds a new one when `stat(key).mtimeMs` changes
([examples/prepared-scripts/](../examples/prepared-scripts/)).

**Against the usual way** — restarting the pool, or a watcher and a reload
in every worker: one watcher, epochs in order (an older epoch never
publishes over a newer one), no stale bytecode next to a new source, a
change that fails preparation keeps the last good version, and requests in
flight finish with the version they started with.

**Not covered:** module caches, module-scope state, ES module instances,
connection draining; a change reaches the index after the watcher
debounce. → [integration.md → Generated code with hot reload](integration.md#generated-code-with-hot-reload-no-disk).

### Shared module bytecode

`require: { compile: true }` on the places that hold the application's
CommonJS modules. `initialize()` compiles each source once; the module
hook's `_compile` hands the bytecode to `vm.Script` as `cachedData` in
every worker, so V8 skips parsing and compilation, lazy functions included.
`fs.script.compile` gives the same to code that runs sources through
`vm.Script` itself ([integration.md → Sharing bytecode with `metavm`](integration.md#sharing-bytecode-with-metavm)).

**Against the usual way** — every worker parsing and compiling the same
sources; Node's compile cache (`module.enableCompileCache()`: on disk,
written when the instance exits, per Node version, enabled per thread) or
`v8-compile-cache` (on disk, per entry point, `require` only): built once
in memory at publication, shared zero-copy, rebuilt on change in the same
message as the source, and available to `vm.Script` callers, not only to
the loader.

**Not covered:** ESM (Node's compile cache does cover it), `node_modules`
and bare specifiers (Node's resolver), a heap snapshot (`useSnapshot`).
benchmarks.md carries no figure for it yet;
`npm run bench -- --only require` measures 200 modules in a fresh worker
with cached data, without it, and from disk.

### Preprocessing at publication

A preparer per extension: minify CSS, HTML or SVG; wrap a handler body into
a function ([examples/prepared-scripts/](../examples/prepared-scripts/));
transpile or bundle with a synchronous tool (esbuild's `transformSync`, or
`buildSync` with `write: false`); render a template. The result is the
file's one content for `fs`, `require` and `import`; `fs.script` and
`require.compile` compile that content, compression compresses it, and
`meta` carries what was derived along the way — a route table, a hash for
`ETag`.

**Against the usual way** — a build step whose output is deployed as files,
or a transform per request or at first load in every worker: the
transformation runs at publication — for the initial scan, for every
watcher epoch, for virtual writes from any thread — once, on the publishing
thread, and its result is what every domain and every companion is built
from, with the raw file staying the source of truth. A build at deploy time
is not replaced; a preparer covers what changes while the process runs.

**Not covered:** no preparers are shipped; synchronous only (no async
pipelines, no esbuild plugins); one preparer per extension, no chains; no
extra files (a source map travels inside the content or `meta`), no change
of key or extension; the raw input is not kept, so `appendFile`, `rename`
and copies of a prepared virtual key are `ENOTSUP`; the result must fit
`maxFileSize`; and a slow preparer stalls the main thread for shared
places. → README [Preparation](../README.md#preparation-prepare),
[integration.md → Preparing sources](integration.md#preparing-sources).

### SEA assets for many workers

A single executable bundles its assets; `sea.getAsset()` returns a copy
per call, in the thread that calls it. `provider: 'sea'` copies each asset
once into the pool at `initialize()`; the workers project them zero-copy
and get the same `PlaceFs` API, leases, representations and cached data as
a directory would give. The same server runs with `provider: 'sab'` from a
directory in development. Node's own `useVfs` mounts the assets read-only
under `node:fs`, excludes `useCodeCache` and `useSnapshot`, and describes
no sharing across threads.

**Not covered:** building the executable; the assets are read-only
(`EROFS`) and have no watcher; the main script is not served from the
place; each asset must fit `maxFileSize`; outside a SEA build the place is
empty and logs a warning. →
[examples/sea-static/](../examples/sea-static/),
[integration.md → SEA bundling](integration.md#single-executable-application-bundling).

### Plugin code generated at run time

A `map + virtual` place per worker or agent — per-thread, synchronous,
`require: true` compiles on every write — or a `sab + virtual` place when
every thread must run the same generated code: prepared and compiled once
on the main thread, published to all before the writer's Promise resolves.
`strict: true` closes the rest of `appRoot`.

**Against the usual way** — generated code written to a temporary
directory and `require()`d, or `vm.Script` over strings in every thread: no
disk and no temporary files, ordinary `require()` semantics (`__filename`,
stack traces name the path), bytecode for free, one generated source for
every thread (`sab + virtual`) or a private one per thread
(`map + virtual`).

**Not covered:** isolation — a plugin runs in the process with the
application's privileges, `strict` refuses paths and not capabilities, and
tenants in one process see each other's places; module-cache eviction; a
worker's writes into its `map` places need `attach({ preparers })` when the
extension has a preparer. →
[examples/multi-tenant/](../examples/multi-tenant/),
[integration.md → AI agent / plugin workspace](integration.md#ai-agent--plugin-workspace).

## Measured

From [benchmarks.md](benchmarks.md): AMD Ryzen 9 9900X with 6 cores
visible, Windows Server 2022, Node.js v24.20.0, every file in the page
cache, a busy machine; medians of three runs in alternating pairs. Absolute
numbers change with the machine; the ratios are the durable part.

Worker pools over one set of 200 text files (20 MiB), `sab` against a
per-worker Buffer cache and `fs.promises.readFile` per request
([Worker pools](benchmarks.md#worker-pools-against-nodefs-and-a-per-worker-cache)):

| workers                       |          `sab` | per-worker cache |      `node:fs` |
| ----------------------------- | -------------: | ---------------: | -------------: |
| requests / s, 1 worker        |          379 k |            481 k |           10 k |
| requests / s, 4 workers       |         1372 k |            502 k |           33 k |
| requests / s, 8 workers       |         1722 k |            627 k |           41 k |
| p50 / p99 µs, 8 workers       |     0.9 / 23.2 |       1.1 / 94.1 | 122.5 / 1242.1 |
| RSS MiB, 8 workers            |            261 |              348 |            180 |
| memory per worker             |        ~21 MiB |          ~35 MiB |        ~15 MiB |
| one update to every worker    | 220–245 µs p50 |    91–162 µs p50 |              — |
| gzip, 4 workers, requests / s |         1536 k |              1 k |            1 k |

One worker serving from its own Buffers is the fastest single thread; from
two workers on, the shared copy scales and the private copies stop at
~0.5–0.6 M requests per second with a p99 that quadruples. Loading the set
into shared memory costs what one cache worker spends on it (12 ms; 180 ms
with gzip representations).

The library's own costs
([Reads](benchmarks.md#reads-by-size), [Leases](benchmarks.md#leases),
[Updates under active leases](benchmarks.md#updates-under-active-leases),
[Streams](benchmarks.md#streams-by-size-and-highwatermark),
[Memory lifecycle](benchmarks.md#the-memory-lifecycle-of-shared-bytes)):

| figure                                            |                                 value |
| ------------------------------------------------- | ------------------------------------: |
| lease (`readFileView`), any size                  |                               ~100 ns |
| `readFile` copy, 1 KiB / 8 MiB                    |                       374 ns / 1.3 ms |
| `readFileSync` from the page cache, 1 KiB / 8 MiB |                      18.6 µs / 1.7 ms |
| `stat` / `exists` / `readdir` of 100 entries      |                 55 ns / 18 ns / 51 µs |
| `writeFile` into `sab + virtual`, 64 KiB, p50     |                                ~20 µs |
| the same under 1000 active leases                 |                         the same cost |
| update → ACK → free, 1 / 4 workers, p50           |                            36 / 45 µs |
| zero-copy stream, 8 MiB, `highWaterMark` 256 KiB  | hundreds of GB/s (`node:fs` 3.3 GB/s) |
| 64 MiB leased in full                             |                       no extra memory |
| 64 MiB copied with `readFile`                     |                     +64 MiB, until GC |
| after `close()`                                   |              RSS as at start (66 MiB) |

## Alternatives

|                                     | files live in                       | shared across threads             | live updates                              | done once: bytecode, compression, preparation | real paths        |
| ----------------------------------- | ----------------------------------- | --------------------------------- | ----------------------------------------- | --------------------------------------------- | ----------------- |
| xvfs                                | one SAB copy                        | yes, zero-copy                    | atomic epochs, ACK-before-free            | yes                                           | yes               |
| `node:vfs`                          | memory, a directory, ZIP, providers | not described; mounted per worker | memory local; `RealFSProvider` reads disk | no                                            | no, own namespace |
| `@platformatic/vfs`                 | memory, SQLite, a directory         | no                                | local to the instance                     | no                                            | overlay (shim)    |
| memfs                               | memory, one volume                  | no                                | local to the volume                       | no                                            | no                |
| `node:fs` + page cache              | the OS page cache                   | yes, and across processes         | always current                            | no: per read, per thread                      | yes               |
| a cache per worker (`lru-cache`, …) | one copy per thread                 | no                                | per thread                                | per thread                                    | n/a               |
| Redis / memcached                   | another process or machine          | yes, across processes             | invalidation messages, TTL                | n/a                                           | n/a               |
| static servers, CDNs                | disk + page cache, the edge         | across processes                  | per file                                  | at build or per request                       | yes               |
| bundlers, compile caches            | files built ahead; disk cache       | disk, read per thread             | at build; at exit                         | at build time                                 | yes               |

### `node:vfs`

The virtual file system in Node.js core is the closest neighbour and the
easiest to confuse with this library. Facts below reflect September 25,
2026: the documentation of Node.js v26.10.0 (the latest release, September
22, 2026) and, where marked, changes merged into `main` but not released
yet. `node:vfs` is experimental and still changing — check the current docs
before relying on a detail.

|                         | xvfs                                                                         | `node:vfs`                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Status                  | userland; Node 22.22.3+, 24.12+, 26                                          | core, Node 26 only (not backported to 22 / 24); Stability 1 (experimental), behind `--experimental-vfs` |
| Built for               | many threads reading the same files                                          | self-contained file trees: tests, fixtures, embedded assets, archives, SEA                              |
| Paths                   | the real paths under `appRoot`, one place per directory                      | a reserved mount namespace (e.g. `/dev/null/vfs/0`) that never shadows real paths; no overlay           |
| Across `worker_threads` | one SAB copy, zero-copy views in every thread, deltas to all                 | not described; startup mounts are re-created in each worker                                             |
| Updates                 | watcher / writes → atomic epochs to every thread; readers keep their version | memory writes are local to the instance; `RealFSProvider` reads through to disk                         |
| Content sources         | disk directories, application writes, SEA assets                             | memory, a real directory, ZIP archives, custom providers, SEA assets (`useVfs`)                         |
| `node:fs` surface       | a subset: reads, stat, readdir, streams, mutations; no descriptors           | broad: sync, callback and promises, descriptors, streams, watch, symlinks                               |
| Modules                 | `require` / `import` of published files; no `exports` maps                   | full CommonJS / ESM resolution from the mount, `node_modules`, native addons                            |
| V8 cached data          | built once, shared (`require.compile`, `fs.script.compile`)                  | none; SEA `useVfs` cannot be combined with `useCodeCache` or `useSnapshot`                              |
| Compression             | gzip / deflate / br / zstd representations built once, shared                | none                                                                                                    |
| Content preparation     | `prepare`: one canonical content per file, once per publication              | none                                                                                                    |
| Access policy           | `strict` routing under `appRoot` (a policy, not isolation)                   | none (not a sandbox); under `--permission`, mounting needs `--allow-fs-vfs`                             |

In short:

- **v26.4.0** — the module, behind `--experimental-vfs`:
  `vfs.create([provider])` returns a `VirtualFileSystem` with an fs-like API
  of its own. Providers: `MemoryProvider` (default: in-memory tree,
  symlinks, watch), `RealFSProvider(rootPath)`, and custom subclasses of
  `VirtualProvider`.
- **v26.9.0** — `mount()` (no arguments) returns a mount point in a
  reserved namespace, after which `node:fs`, `require()` and `import()`
  reach the tree under that path: "any given path is served either by
  exactly one VFS or by the real file system, never both." Also
  `ZipProvider` (over an open `zlib.ZipBuffer` / `zlib.ZipFile`), SEA
  `"useVfs": true` (the bundled assets mounted read-only, the main script
  run from the mount root) and `--allow-fs-vfs`, without which the
  permission model refuses to mount.
- **v26.10.0** — `--vfs-mount=<dir|zip>` mounts a source at startup and
  `--vfs-load` also runs the entry point from it; `vfs.registerProvider()`
  lets them mount a format Node has no provider for. A worker inherits these
  mounts, mounting each source again, and runs its own entry point.
- It is documented as not a sandbox, permission system or access-control
  mechanism.

Status and outlook, as of September 25, 2026:

- **Released.** v26.10.0 is the newest release. `node:vfs` exists only in
  Node 26 — it is not backported to the 24 or 22 LTS lines — and remains
  Stability 1 behind `--experimental-vfs`: outside semantic versioning,
  incompatible changes may come in any release.
- **Merged into `main`, not released yet:**
  - `--vfs-mount` is removed; `--vfs-load` alone mounts and runs its single
    source, at the same mount point in every thread. A worker created with
    its own `execArgv` inherits no mount and must be given
    `--experimental-vfs --vfs-load` again (nodejs/node#66162).
  - SEA `"vfsArchive"`: the assets come from a prebuilt ZIP archive served
    by `ZipProvider` (nodejs/node#65810).
- **Open pull requests.**
  - `ComposableProvider`: several providers layered in one mount — reads by
    priority, copy-up on write, whiteouts for deletions
    (nodejs/node#66235). The layers stay inside the mount; real paths are
    still never overlaid.
  - A readable reserved root listing the mounts, and `vfs.vfsBase()`
    (nodejs/node#66140).
- **Release schedule.** Node 26 enters LTS on October 28, 2026 — the first
  LTS line with `node:vfs`. It is the last line of the two-majors-a-year
  model: from Node 27 there is one major a year, in April, preceded by an
  alpha channel (27 alpha from October 2026, 27.0.0 in April 2027, LTS in
  October 2027).

None of these changes — released, merged or proposed — shares a VFS
between threads, builds cached data, compresses content or overlays real
paths, so the differences below should hold in the near term.

**Purpose.** `node:vfs` gives a program a file tree that does not exist on
disk. xvfs keeps files that do exist (or that the application
writes) in one shared copy for many threads. The first is about _where
files come from_; the second is about _how many copies of them a process
holds and how they change_.

**Path model.** A `node:vfs` mount lives in its own namespace: code has to
use the mount point (or be started from it with `--vfs-load`). A place of
xvfs is a real directory under `appRoot`: existing code keeps
reading `appRoot/static/index.html` and gets the cached bytes, with the
patched `node:fs` and the module hooks deciding per path.

**Threads.** The `node:vfs` documentation does not describe sharing an
instance between threads; a `MemoryProvider` tree is ordinary JavaScript
state, and a startup source is mounted again in each worker (on `main`, at
the same mount point in every thread). xvfs keeps every byte
once in `SharedArrayBuffer` segments: each worker projects the same memory
from a snapshot, receives each change as one delta, and a replaced version
is freed only after every worker has moved on and no stream or view still
reads it. With `n` workers and `m` MiB of files that is `m` MiB instead of
up to `n × m` — measured above as 261 against 348 MiB of RSS at eight
workers for a 20 MiB set.

**Live updates.** `RealFSProvider` always reads the disk, so it is current
but not cached. xvfs watches disk-origin places and publishes
each batch of changes atomically — a source with its bytecode and
compressed companions — to every thread, while readers that started before
finish the version they began with.

**API surface.** `node:vfs` aims at the whole `node:fs` contract, including
file descriptors and symlinks. xvfs implements what hot read
paths need and guards the rest: an unimplemented API can refuse a path, but
it is never served from the VFS; `open()` of a published file is `ENOTSUP`.

**Modules.** `node:vfs` mounts take part in the full CommonJS and ESM
resolution, `node_modules` and native addons included. xvfs
resolves files and directories of its places (no `exports` / `imports`
maps) and adds what `node:vfs` does not: V8 cached data built once on the
main thread and reused by every worker's `require()`.

**Work done once.** Preparation (`prepare`), bytecode flavors and
compressed representations are computed at publication and shared. With
`node:vfs` each of those stays the application's job, in every thread.

**SEA.** `useVfs` mounts the assets and excludes `useCodeCache` and
`useSnapshot`; on `main`, `vfsArchive` serves them from an embedded ZIP
archive. `provider: 'sea'` copies the assets into SAB once, shares them
across workers and can build cached data for them.

**Access policy.** Neither is a sandbox. `strict: true` makes `appRoot` a
managed root that refuses unowned paths for code going through `node:fs`
and the module hooks — useful discipline, not a security boundary.

Use **`node:vfs`** for a virtual tree: test fixtures without touching disk,
packaging an application or its assets (ZIP, SEA), code that needs the full
`node:fs` contract, descriptors or native addons from memory, or a
single-threaded program. Use **xvfs** when several worker
threads read the same files and memory, startup time or per-request CPU
matter. They can coexist: a `node:vfs` mount and the places of
xvfs never overlap. A `VirtualProvider` backed by a
xvfs place would give the full fs contract over shared bytes;
it is **not built**.

### `@platformatic/vfs`

A userland shim of the `node:vfs` API for Node 22+. Its README (September
27, 2026): "Use built-in `node:vfs` when running a Node version that
provides it. The shim remains useful for Node 22+ and for
`SqliteProvider`." Providers: `MemoryProvider`, `SqliteProvider` over
`node:sqlite`, `RealFSProvider`, custom ones; overlay and virtual-cwd modes
are shim-only. It states that "native addon and FFI library loading from
virtual bytes, SEA integration, and transparent interception of Node's
internal module-resolution filesystem calls require Node core and are not
supported", and that core's `ZipProvider` is not included. Against
xvfs the trade-offs are those of `node:vfs`: a tree of its own,
one instance per thread, no work done once.

### memfs

"Implementation of in-memory Node.js `fs` module API and in-memory browser
File System API" (README, September 27, 2026) — an `fs`-compatible volume
in memory, with `fs.watch`, snapshots and adapters to the browser's file
system API. It is the right tool for tests and mocks
and for code that needs a full `fs` in memory; one volume per thread,
nothing shared, no module loading of its own and no work done once.
xvfs can serve test fixtures too
([integration.md → Testing with virtual fixtures](integration.md#testing-with-virtual-fixtures)),
but that is a side effect of the patch, not its purpose.

### `node:fs` and the OS page cache

The baseline, and the right choice more often than not: a single thread, a
handful of files, content that must be current at every read, or media
that stays on disk anyway. The page cache is shared by every thread and
every process, so a read rarely touches the disk — but each read is a
syscall and a fresh `Buffer` (18.6 µs for 1 KiB, 76–122 µs per request
in the pool measurement), and every thread parses, compiles, compresses and
prepares the same files again. xvfs keeps large files there
(`maxFileSize`) and serves them from disk through the same API.

### A cache in every worker (`lru-cache` and the like)

An in-process cache bounded by `max`, `maxSize` or `ttl` — "a cache object
that deletes the least-recently-used items" (README, September 27, 2026) —
is the fastest single thread: 0.5 µs per request against 0.8 µs for a
lease around the same copy, 481 k against 379 k requests per second with
one worker. With `n` workers it is `n` copies (348 against 261 MiB at
eight workers for a 20 MiB set, 1.4 GiB apart, by extrapolation, for
200 MiB), `n`
invalidations, and no moment at which every thread serves the same version;
in the measurement the private copies stopped at ~0.5–0.6 M requests per
second from two workers on, with a p99 four times the shared copy's. It
stays the right choice for one worker, for computed values rather than
files, and for TTL semantics, which xvfs has not.

### Out-of-process caches: Redis, memcached

Shared across processes and machines, with invalidation (Redis tracking)
and TTLs; memcached describes itself as "a high-performance, distributed
memory object caching system". Every read is a round trip over a socket
and a deserialization — the reason Redis documents client-side caching:
"the time needed in order to access the local computer memory is orders of
magnitude smaller compared to accessing a networked service like a
database". xvfs is that local layer for the threads of one
process, for file-shaped data; it does not replace the shared store across
processes. The two combine: the store holds the truth, an invalidation
message makes the main thread write the new value into a `sab + virtual`
place, and every worker serves it from then on.

### Static servers and CDNs

nginx serves files from disk with `sendfile` and caches descriptors,
sizes and modification times (`open_file_cache`), not contents — the page
cache does that; a CDN caches at the edge. They are the right layer for
public static content in front of an origin. xvfs serves the
origin: what the Node.js process itself must render or serve — templates,
handlers, data, private assets, SEA assets — and the static files of a
deployment that runs without a reverse proxy.

### Bundlers and compile caches

A bundler (esbuild, webpack, …) reduces the number of modules and
transforms them at build time; the two are complementary, and a bundler's
synchronous API can be a preparer. Node's compile cache
(`module.enableCompileCache()`, added in v22.1.0) is an on-disk V8 code
cache for CommonJS, ESM and TypeScript modules, written when the instance
exits, invalid across Node versions and enabled per thread (or inherited
through `NODE_COMPILE_CACHE`); `v8-compile-cache` is the userland
predecessor: on disk under `os.tmpdir()`, per entry point, `require()`
only. The library's cached data is in memory, per published file, rebuilt
on change and shipped with it, shared zero-copy, and available to
`vm.Script` callers. Use both: Node's compile cache for the application's
own module graph and `node_modules`, the library for the published places.

## When not to use it

- **One thread, or many processes.** A single-threaded server has nothing
  to share; `cluster` and `child_process` do not share memory. Then
  `node:fs`, a cache per process, or Node's compile cache.
- **The full `node:fs` contract.** Descriptors, `watch`, symlinks,
  recursive operations over managed trees, `node_modules` from memory,
  native addons: `node:vfs`, memfs, or the disk.
- **Isolation of untrusted code.** Nothing here is a security boundary;
  processes, users, containers are.
- **Data that is written more than read**, request-scoped state, or
  anything larger than memory: a publication is a write into shared memory
  (~20 µs for 64 KiB), one key at a time, ACKed by every worker; the pool
  holds everything it has published.
- **State shared across processes or machines**, or that must survive the
  process: Redis, memcached, a database.
- **ESM bytecode**: Node's compile cache covers it; the library does not.
- **Public static content behind a reverse proxy or CDN**, where nginx or
  the edge serves it before the process is reached.
- **Content that must be current on every read** of a writable disk-origin
  place: it reaches the index after the watcher debounce (`watchTimeout`).
- **Node.js below 22.22.3 or 24.12.0**, or IBM i and AIX without AHAFS for
  the live-reload features.

## Sources

Node.js and `node:vfs` facts are as of September 25, 2026; the other
sources were consulted on September 27, 2026. Statements about the
alternatives follow their documentation, not measurements; unreleased
changes and open pull requests are reported as such and may change before
a release.

- Node.js documentation: [`node:vfs`](https://nodejs.org/api/vfs.html),
  [`--vfs-load` / `--vfs-mount`](https://nodejs.org/api/cli.html#--vfs-loadsource),
  [single executable applications](https://nodejs.org/api/single-executable-applications.html),
  [`worker_threads`](https://nodejs.org/api/worker_threads.html) (shared
  memory against `child_process` / `cluster`),
  [`module.enableCompileCache()`](https://nodejs.org/api/module.html#moduleenablecompilecacheoptions)
- nodejs/node: [#65748](https://github.com/nodejs/node/pull/65748) (startup
  mounts, workers), [#66162](https://github.com/nodejs/node/pull/66162)
  (`--vfs-mount` removed), [#65810](https://github.com/nodejs/node/pull/65810)
  (`vfsArchive`), [#66235](https://github.com/nodejs/node/pull/66235)
  (`ComposableProvider`), [#66140](https://github.com/nodejs/node/pull/66140)
  (`vfs.vfsBase()`), [#63638](https://github.com/nodejs/node/issues/63638)
  (8.3 aliases abort the watcher on Windows)
- Release plans:
  [Evolving the Node.js release schedule](https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule),
  [nodejs/Release schedule](https://github.com/nodejs/Release/blob/main/schedule.json)
- [platformatic/vfs](https://github.com/platformatic/vfs),
  [streamich/memfs](https://github.com/streamich/memfs),
  [isaacs/node-lru-cache](https://github.com/isaacs/node-lru-cache),
  [zertosh/v8-compile-cache](https://github.com/zertosh/v8-compile-cache)
- [esbuild API](https://esbuild.github.io/api/) (`transformSync`,
  `buildSync`, `write: false`)
- [Redis client-side caching](https://redis.io/docs/latest/develop/reference/client-side-caching/),
  [memcached](https://memcached.org/about),
  [nginx `open_file_cache`](https://nginx.org/en/docs/http/ngx_http_core_module.html#open_file_cache)
- [benchmarks.md](benchmarks.md) — the figures quoted on this page
