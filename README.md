# xvfs

Extended virtual filesystem for Node.js: places over the application's
real paths, each with its own storage and content origin; content
prepared once and published atomically, with a version, to every thread;
one shared copy for all `worker_threads` where a place asks for it; and
strict routing of what the application may reach — through `node:fs` and
`module.registerHooks` adapters or the explicit `PlaceFs` API.

A place is a directory under `appRoot`. Its **provider** says where the
bytes live: `sab` — one copy in pooled `SharedArrayBuffer` segments that
every thread reads zero-copy; `map` — each thread's own `Map`, written
synchronously and seen by that thread only; `sea` — the assets of a
single executable, in the shared pool; `disk` and `node-default` — the
file system itself, under the place's policy. Its **origin** says where
the content comes from: `disk` — a scan, then a watcher — or `virtual` —
what the application writes, from code generated at run time to data
fetched at start, with no file on disk. Every place goes through the same
publication pipeline, the same hooks and the same routing.

With `sab`, files are loaded once on the main thread into pooled SAB
segments. Workers get zero-copy `Buffer` views over the same memory — no
per-worker copies, no serialization, no IPC for reads. Optional V8
bytecode (`require.compile`) is compiled once and stored in SAB so
workers skip parse + compile. There is no ESM bytecode cache.

What it is used for: worker pools over one copy of static assets,
templates, configuration and modules; worker-local workspaces of agents,
sessions or tenants (`map` + `virtual`); code generated and compiled at
run time, loaded with `require()` and never written to disk; applications
packaged as a single executable; and a declared, reviewable map of what
an application may touch under `appRoot` — which places, which of them
writable, through which links. Strict routing is a policy for code that
goes through the patched `node:fs` and the module hooks, not an OS
sandbox or a security boundary ([Strict routing](#strict-routing)).
[doc/alternatives.md](doc/alternatives.md) walks through the production
scenarios.

Requires Node.js 22.22.3+ or 24.12.0+ or 26+ (`module.registerHooks`;
CJS `--import` bootstrap of memory-only modules). Node 24 below 24.12.0
is unsupported.

## Contents

[Features](#features) · [Install](#install) · [Quick start](#quick-start) ·
[Providers](#providers) · [Preparation](#preparation-prepare) ·
[Compression](#compression) · [Strict routing](#strict-routing) ·
[Lifetime of shared bytes](#lifetime-of-shared-bytes) · [API](#api) ·
[Patched `node:fs`](#patched-nodefs) · [Errors](#errors) ·
[Protocol](#protocol) · [Examples](#examples) ·
[Architecture](#architecture) · [Support](#support) ·
[Design decisions](doc/architecture.md) · [Alternatives](doc/alternatives.md) ·
[Benchmarks](doc/benchmarks.md)

## Features

Storage and origins:

- **Five providers** — `sab` (shared memory), `map` (each thread's own
  memory), `sea` (SEA assets in shared memory), `disk` (a managed mount),
  `node-default` (ordinary Node) — over the same paths, API and routing.
- **Zero-copy sharing** — a `sab` place's projections are
  `Buffer.from(sab, offset, length)` views: one copy for every thread.
- **Pooled segments** — files packed into 64 MiB SAB segments; emptied
  segments are reused, never returned to the OS.
- **Worker-local places** — a `map` place keeps its files in each
  thread's own memory; with `origin: 'virtual'` it is that thread's own
  filesystem: synchronous writes, a filesystem's hierarchy, `require()` of
  what is written, compiled on write, invisible to every other thread.
- **Two content origins** — `origin: 'disk'` (scanner + watcher fill the
  place) or `origin: 'virtual'` (the application writes the content —
  from the main thread or, for `sab`, from a worker over the link port):
  generated code, fetched data, fixtures, with no file on disk.

Publication:

- **`prepare`** — a synchronous callback, declared by the `fs`,
  `require` or `import` domain per extension, turns a raw input into the
  file's one canonical content (bundling, wrapping, templating…), shared by
  every domain. Runs once per publication, never on read.
- **`fs.script`** — V8 bytecode companion of the canonical source for
  callers that build their own `vm.Script` (`PlaceFs.script()`),
  independent of `require.compile`.
- **V8 bytecode** — `require: { compile: true }` (CJS, default when the
  require domain is on) and/or `fs.script.compile` (bare source, default
  true when `fs.script` is on). ESM has no bytecode cache.
- **Pre-compressed representations** — `gzip`, `deflate`, `br`, `zstd`
  built once and shared from SAB. HTTP negotiation stays in your server.
- **Live reload** — watcher batches disk events into epochs processed
  strictly in order, one `vfs-update` per epoch; a replaced version is
  freed after every worker ACKs and no stream or view still reads it.
- **Versions** — every publication has a number, the same in every
  thread: `files.version(key)` for a file, `kernel.version` for the
  published state, `kernel.instance` for the process that owns it.
- **Publication events** — `kernel.on('publish', …)` in every thread:
  what each publication changed, once it is committed.
- **Atomic sets** — `files.writeFiles(…)` publishes several files of a
  virtual place in one commit, or none of them.

Control:

- **Strict routing** — `strict: true` makes `appRoot` the routing
  boundary: a path no place owns is `EACCES` before any native I/O,
  read-only places stay read-only through every `node:fs` form, and
  `fs.fallback` and `links` decide what reaches a place's disk — a
  declared policy, not OS-level isolation.
- **Immutable published versions** — a reader finishes the version it
  started with; a failed preparation keeps the last good one; nothing is
  freed on a timeout.
- **Diagnostics** — `kernel.diagnostics()`: pool usage and fragmentation,
  bytes waiting to be freed, a worker that does not ACK, files the pool
  had no room for, failed preparations, strict's links; read-only.

Integration:

- **Hooks** — `hooks.fs` patches `node:fs`; `hooks.module` is one
  `module.registerHooks` chain for `require()` and `import`.
- **Chunked streaming** — `PlaceFs.createReadStream()` with HTTP Range;
  a stream always finishes the version it started with.

## Install

```
npm install xvfs
```

Package exports: `.`, `./register`, `./adapters/fs-patch`,
`./adapters/module-hook`.

Type declarations ship with the package, written by hand next to the
modules they describe: `index.d.ts` next to `index.js`, `lib/*.d.ts` for
the modules whose API `index.js` exports, and one next to each subpath
(`lib/bootstrap/register.d.mts`, `lib/adapters/*.d.ts`); `package.json`
points to them through `types`. They need `@types/node`, and a
`moduleResolution` that reads `exports` — `node16`, `nodenext` or
`bundler` — for the subpaths (`node10` sees the entry only). `kernel` is
a getter of the CommonJS entry, not an ES module named export: from ESM
read `VfsKernel.current`, or `kernel` of the default import.
`npm run test:types` checks the declarations against their usage in
`test-types/`, `npm test` their exports against the runtime (see
[Tests](#tests)).

## Quick start

Bootstrap (main thread only):

```
node --import xvfs/register app.js -- --vfs.config=./vfs.config.cjs
```

Config file: `--vfs.config=…` or `vfs.config.{js,cjs,mjs,json}` in cwd.
Order: load config → `initialize()` → install hooks → publish
`VfsKernel.current`. Failure uninstalls, closes the kernel and rethrows —
the entry never runs.

Workers do **not** run `--import` / `--require` preloads. Pass
`kernel.link()` as `workerData.vfs` and call `attach()`:

```js
const { attach } = require('xvfs');
const kernel = attach(); // reads workerData.vfs
```

### Manual wiring

Place **name is the directory under `appRoot`**, the mount, the cache
namespace and the snapshot/delta key. There is no separate `dir` field.

```js
const { VfsConfig, VfsKernel } = require('xvfs');
const { Worker } = require('node:worker_threads');

const config = new VfsConfig({
  defaults: {
    memory: { limit: '1 gib', segmentSize: '64 mib', maxFileSize: '10 mb' },
  },
  places: {
    static: {
      // origin defaults to 'disk': scanner + watcher fill it.
      fs: { ext: ['html', 'css', 'js', 'png', 'svg'] },
    },
    lib: {
      fs: { ext: ['js'] },
      require: { ext: ['js'], compile: true },
    },
    scratch: {
      provider: 'map',
      origin: 'virtual', // content comes only from application writes
      fs: { writable: true },
    },
  },
});

const kernel = new VfsKernel(config, { appRoot: process.cwd() });
await kernel.initialize();

const { vfs, transferList } = kernel.link();
const w = new Worker('./worker.js', {
  workerData: { vfs },
  transferList,
});
```

Worker:

```js
const { attach } = require('xvfs');
const kernel = attach();

const site = kernel.fs('static');
const html = site.readFile('/index.html'); // owned copy
const stream = site.createReadStream('/big.mp4');

const scratch = kernel.fs('scratch');
scratch.writeFile('/note.txt', 'hello');
```

`kernel.fs(name)` returns a `PlaceFs` for an indexed place with an fs
domain (`sab` / `map` / `sea`). Disk and node-default places are
plain `node:fs` territory.

`readFile*` returns owned copies. Direct access to shared bytes goes
through leases and streams that pin the version they read — see
[Lifetime of shared bytes](#lifetime-of-shared-bytes).

Mutations of a `sab + virtual` place cross the allocator (and, when
configured, the compression threadpool), so they return a **Promise**
that settles once the new version is published — `await` it. Every other
place (disk-origin, and `map`, including `map + virtual`) mutates
synchronously and returns `undefined`; `await` is still correct for both.

Bytecode is not on `PlaceFs` — it is [adapter API](#adapter-api), except
for `fs.script` bundles, which are `PlaceFs.script(key)` (below).

## Providers

| Provider       | Storage             | VFS index | Origin              | Shared across workers |
| -------------- | ------------------- | --------- | ------------------- | --------------------- |
| `sab`          | SAB pool            | yes       | `disk` \| `virtual` | yes, zero-copy        |
| `map`          | per-thread `Map`    | yes       | `disk` \| `virtual` | no, per-thread        |
| `sea`          | SAB from SEA assets | yes       | fixed (SEA assets)  | yes, zero-copy        |
| `disk`         | OS filesystem       | no        | fixed (disk)        | n/a, managed mount    |
| `node-default` | OS filesystem       | no        | fixed (disk)        | n/a, ordinary Node    |

`INDEXED` = sab | map | sea (have a files Map). `SHARED` = sab | sea
(bytes in SAB). `disk` and `node-default` are passthrough mounts: they
are never scanned and hold no VFS entries. `disk` differs from
`node-default` only in being _managed_ — the router applies the fs
domain's writable policy and strict routing to it.

**`origin`** applies only to `sab` and `map`, defaults to `'disk'`, and is
always explicit in the resolved config:

| provider + origin | content                          | mutations                    | sharing             |
| ----------------- | -------------------------------- | ---------------------------- | ------------------- |
| `sab` + `disk`    | scanner + watcher                | to disk, watcher republishes | snapshot/delta      |
| `sab` + `virtual` | application writes               | main thread or worker RPC    | snapshot/delta      |
| `map` + `disk`    | scanner + watcher, owned Buffers | to disk, watcher republishes | none (thread-local) |
| `map` + `virtual` | application writes               | local `Map`, synchronous     | none (thread-local) |

`origin: 'virtual'` requires the fs domain with `writable: true` —
nothing else can ever give the place content. A virtual place is
legitimately empty right after `initialize()`; workers project it from
the snapshot and receive its first file like any other update.

Writable disk-origin SAB/map is **eventual consistency**: mutations go
to disk; the watcher brings them into the index. There is no
`waitForUpdate`. A `sab + virtual` mutation, in contrast, resolves its
Promise only once the new version is already published. The watcher
also starts when `defaults.watch` is on.

### Map provider

Per-thread writable namespace (`origin: 'disk'` or `'virtual'`). Each
thread owns its own instance after `fromSnapshot()` / `attach()` — it is
never in the snapshot and mutations of one thread are invisible to
others. Writes via `PlaceFs` are local to that thread and synchronous.
JS is compiled to V8 bytecode when `require.compile` and/or
`fs.script.compile` are on.

It is a worker's own workspace — an agent's or a session's files, the
code it generates and loads — with the preparation, compilation, hooks
and strict routing of a shared place, and nothing on disk to clean up
after it. What it does not have: sharing (a `sab` place is for that),
versions shared across threads and `'publish'` events (TASKS.md).

```js
places: {
  agent: {
    provider: 'map',
    origin: 'virtual',
    fs: { writable: true },
    require: true, // compile defaults to true
  },
}

const agent = kernel.fs('agent');
agent.writeFile('/tool.js', 'module.exports = () => 42;');
const tool = require('/abs/path/agent/tool.js');
```

### `fs.script`

`fs.script` marks the sources the library compiles for callers that build
their own `vm.Script` (`PlaceFs.script(key)`) — orthogonal to
`require.compile`, which serves Node's CJS loader. Both may cover the same
file with independent companions, both built from the one canonical
(prepared) source.

- `fs.script.compile` (default `true`) builds `\0script:bytecode` —
  cached data of the **bare** canonical source under the preparer's
  `scriptOptions`. `require.compile` builds `\0require:bytecode` —
  cached data of `Module.wrap(source)`. Neither substitutes for the
  other. A script-compile failure invalidates the whole publication
  (previous version kept) with `ENOTSUP`, and so does a script flavor
  that finds no room — `EFBIG` when it is larger than one segment and
  could never fit, `ENOSPC` when the pool merely has none right now —
  named by the operation: `open` of the source, or a rename with its
  source and `dest`; a require-compile failure is best-effort (only its
  own companion is dropped).
- `kernel.fs(name).script(key)` →
  `{ source, cachedData, scriptOptions, meta, version } | null`; `ENOTSUP`
  when the place has no `fs.script`. It never prepares or compiles
  anything itself. `version` is the file's ([Versions](#versions)): a
  `vm.Script` built from the bundle serves until it changes.

### SEA provider

Loads `node:sea` assets matching `<name>/…` into SAB at `initialize()`,
then behaves like a `sab` place — in `snapshot()`, projected to workers,
no watcher.

```js
places: {
  pub: { provider: 'sea', fs: true },
}
```

A SEA built with `assets: { 'pub/index.html': './dist/index.html', … }`
exposes those assets with zero per-worker copy.

For tests, inject a compatible module:

```js
new VfsKernel(config, {
  seaModule: {
    isSea: () => true,
    getAssetKeys: () => [...],
    getAsset: (k) => arrayBuffer,
  },
});
```

## Preparation (`prepare`)

A preparer turns the raw input of a file into its **canonical content**:
the one version every domain serves. It is declared by one domain — `fs`,
`require` or `import` — next to its `ext`, but it prepares the file
itself, once, for all of them.

```js
const config = new VfsConfig({
  places: {
    application: {
      fs: {
        ext: ['js', 'css'],
        prepare: { api: ['js'], styles: ['css'] },
        script: { ext: ['js'], compile: true },
      },
      require: { ext: ['js'], compile: true },
    },
  },
});
const kernel = new VfsKernel(config, {
  appRoot,
  preparers: {
    // Synchronous; the functions never enter the (cloneable) config.
    api: (raw, file) => ({
      source: `(${raw.toString().trim()})`,
      scriptOptions: { filename: file.path },
      meta: { key: file.key },
    }),
    styles: (raw) => minifyCss(raw.toString()),
  },
});
```

Here `.js` goes through `api` once; that one prepared source is what
`fs` reads, `fs.script.compile` and `require.compile` compile and
`require()` loads. `.css` goes through `styles`.

- **Forms.** `prepare: 'name'` covers every extension of the domain's own
  finite `ext` (for `require` / `import` including the defaults — so
  `require: { prepare }` also covers `json`). An unrestricted `fs` (no
  `ext`) takes only the object form; `fs.script.ext` is never the scope of
  a short `fs.prepare`. `prepare: { name: [ext, …] }` routes extensions
  explicitly; with a finite domain `ext` each one must be in it. Neither
  form adds extensions to a domain or removes any.
- **One declaration per extension per place.** Declaring the same
  extension in two domains — even with the same preparer — is a config
  error naming the place, the extension and every declaration; so is
  assigning it to several preparers inside one domain, naming every one
  of them. No domain priority, no merging.
- **Providers.** `prepare` applies to `sab`, `map` and `sea` places;
  `disk` and `node-default` places pass files through untouched, so
  declaring it there is a config error, and so is combining it with
  `compress.retainRaw: false` (reads would come from the raw disk file,
  not the prepared content).
  `fs.script.prepare` of earlier versions is gone: declare `prepare` in a
  domain.
- **Contract.** `prepare(raw: Buffer, file)` → `null` / `undefined`
  (publish raw) | `string` | `Uint8Array` |
  `{ source, scriptOptions?, meta? }`. `file` is frozen
  `{ place, key, path, ext, stat }`. Synchronous only: a Promise or
  thenable is a `TypeError`. Returned bytes are taken the moment the
  preparer returns, before `meta` and `scriptOptions` are cloned — a
  `Uint8Array` of a shared place is copied once, straight into its SAB
  allocation — so a preparer may reuse its buffer; `meta` and
  `scriptOptions` are cloned and deep-frozen. `scriptOptions` never turn
  `fs.script` on by themselves. The library ships no Babel, CSS, HTML,
  SVG or image preparers — only the mechanism.
- **Same file.** Key, path, extension and type do not change; only the
  content (and `meta` / `scriptOptions`) does. No extra files or
  representations are created.
- **Once per publication, never on read.** Initial scan, watcher
  updates, SEA assets, virtual writes (main thread or worker RPC) and
  `map` writes all run the same pipeline. The raw disk file stays the
  source of truth; the raw input is not kept next to the prepared content.
- **All or nothing.** A preparer that throws, or a required
  `fs.script.compile` that fails, publishes nothing: the previous version
  and its companions stay.
- **Mutations and copies.** In a virtual place `appendFile`, `rename` and
  copies of a prepared key are `ENOTSUP`: its raw input is not kept, and
  its bundle may embed the old key. Renaming or copying an unprepared entry
  onto an extension with a preparer publishes it through that preparer,
  once. In a disk-origin place mutations edit the raw file and the watcher
  re-prepares it; a copy or a rename hands on that raw file, never the
  prepared content (see [Copies and renames](#copies-and-renames)).
  `readFile` gives the prepared content: writing it elsewhere with
  `writeFile` is a new publication the destination may prepare again, not
  a raw-preserving copy.
- **Threads.** The main kernel prepares everything shared (`sab`, `sea`).
  A worker's own `map` places prepare locally with
  `attach({ preparers })`; without the preparer such a write fails with
  `ENOTSUP`, while reading published content never needs one.

## Compression

Representations are built once during `initialize()` and stored in SAB
next to the source. HTTP negotiation stays in your server.

```js
places: {
  static: {
    fs: {
      ext: ['html', 'css', 'js', 'svg', 'png', 'mp4'],
      compress: {
        encodings: ['br', 'gzip'],
        options: { br: { level: 5 } },
        ext: 'compressible',
        retainRaw: true,
      },
    },
  },
}
```

`fs.ext` decides what the place contains; `compress.ext` narrows that
set. `'compressible'` expands to a built-in list of text-ish formats;
already-compressed media is excluded.

```js
const place = kernel.fs('static');
place.storedEncodings('/app.css'); // ['raw', 'br', 'gzip']
const body = place.readFileCompressed('/app.css', 'br');
const { size, sourceSize } = place.statCompressed('/app.css', 'br');
```

A codec listed in `encodings` but missing from `options` runs with native
zlib defaults (brotli quality 11, gzip/deflate 6, zstd 3).

**`retainRaw: false`** keeps only compressed bytes in SAB; the source
stays a disk entry. Requires provider `sab` with `origin: 'disk'` (a
virtual place has no raw file to serve), and no `require.compile`,
`fs.script` or `prepare`. `place.readFile()` and the patched `fs` then
read the source from disk; `readFileView()` has no view of it.

A compressed representation is never content of its own: a copy or a
rename hands on the raw input — from disk with `retainRaw: false` — and
the destination builds its own representations.

Failures are per representation: a codec that does not fit is skipped
with a warning; `storedEncodings()` reports what actually exists.

## Strict routing

```js
new VfsConfig({ defaults: { strict: true }, places: { ... } });
```

**`strict: true` makes `appRoot` the routing boundary.** Every path under
`appRoot` that no place owns is `EACCES` — at every depth, file or
directory, without the router touching the disk (but to learn, once, the
real path of `appRoot` and, on Windows, what a drive letter names: below).

Strict is a **routing and access policy inside `appRoot`** for code that
goes through the patched `node:fs` and the module hooks: unmanaged
territory is refused, and the disk territory that stays reachable is
exactly what the configured places and their `fs.fallback` allow. It is
not an OS sandbox: worker threads share one process, and neither they nor
the patched `node:fs` replace the operating system's isolation.

- Containment is lexical: only a real `..` component leaves `appRoot`.
  `..private`, `...data` or `file..js` are ordinary names — an unowned
  `appRoot/..private/x` is denied like any other unowned path, and
  `appRoot/api/..private/x` belongs to place `api`.
- Names compare as the platform's file systems compare them: on Windows
  `appRoot` in any case and a place's name without the case of ASCII
  letters — `appRoot\RO\x` is place `ro`, with its prepared content,
  read-only policy and fallback, in either mode; elsewhere exactly. A key
  keeps the case it is given, and an error names the path as the caller
  spelled it.
- On Windows a UNC or namespace path — `\\?\…`, `\\.\…`, `\??\…`,
  `\\server\share\…`, an admin share `\\localhost\C$\…`, with `\` or `/`,
  or a relative path through a cwd on a share — may name a file below
  `appRoot` in a spelling `appRoot` does not share. Under strict it is
  `EACCES` (not found for `require` / `import`) before any native I/O,
  whatever it names: an application on a share keeps its `appRoot` there,
  where the paths lexically below it, in any case, route as usual.
  Without strict such paths pass through natively, as before.
- On Windows a path with NTFS stream syntax — a `:` past the drive:
  `…\a.txt::$DATA`, the main stream of `a.txt`, which is the file itself;
  `appRoot::$INDEX_ALLOCATION\…`, `appRoot` as a name its strings do not
  show; `…\x:stream` — is, under strict, `EACCES` (not found for `require`
  / `import`) before any native I/O, below `appRoot` or not. Without
  strict it passes through as before.
- On Windows a name in the form of an 8.3 short name — a base of up to
  eight characters that ends in `~` and digits, up to three more after a
  dot: `PROGRA~1`, `INDEX~1.HTM` — may stand for any long name of its
  directory, which only the disk knows. Under strict it is `EACCES` (not
  found for `require` / `import`) before any native I/O below `appRoot`, in
  every place, and at the name where a path leaves `appRoot`'s spelling:
  `…\Temp\APP~1\place\hidden` may name `appRoot`, `C:\Users\ME~1\…` a
  directory above it. Past a name that differs from `appRoot`'s, and on
  another drive, a short name names nothing of `appRoot` and passes. A
  long name of that form is taken for a short one. `appRoot` itself may be
  given with short names (`os.tmpdir()` on a CI runner): the paths spelled
  as it is route as usual. Without strict nothing changes for `node:fs` —
  but the `PlaceFs` facade (`kernel.fs(name)`) serves no disk file whose
  name is in this form, in either mode: a legitimate long name that looks
  8.3 (`FOO~1.BIN`) is not served from a place's disk territory, so a short
  name can never make a raw file stand in for a cached one.
- On Windows under strict the `PlaceFs` facade takes neither spelling for
  a mutation — a stream (`/a.txt:s`) or a name in 8.3 form
  (`/SUB~1/a.txt`) anywhere in the key: `writeFile`, `appendFile`,
  `writeFiles`, `unlink`, `mkdir`, `rm` and `rename` are `EACCES` before
  the place's own checks, in a virtual place and on disk alike. No path
  under strict names such a key, and `writeFiles` reaches a virtual place
  past every path. Without strict, and off Windows, it is a name like any
  other.
- On Windows under strict a drive letter other than `appRoot`'s that
  names a share (`net use`), or `appRoot`, a directory above it or below
  it (`subst`), is refused whole: every path on it is `EACCES` before any
  native I/O. What a letter names is asked of the disk
  (`fs.realpathSync.native` of its root) the first time a path on it is
  routed, once per letter and thread; a letter that names nothing is asked
  again, one mapped anew after its answer is not seen. A drive off
  `appRoot`'s line stays native. An application that reaches its own files
  through a mapped network drive cannot under strict — the share is refused
  whole. The first `realpath` of a disconnected drive waits out its SMB
  timeout, and an error other than a missing drive caches the letter as
  refused for the life of the process.
- Under strict an `appRoot` spelled through a link, a subst drive or 8.3
  names has a second spelling, its real path (`fs.realpathSync.native`,
  asked once when the kernel is built): a path in or below it is `EACCES`,
  a recursive walk from above it `ENOTSUP`, a short name where a path
  leaves it `EACCES`, as for `appRoot`'s own spelling. A name of
  `appRoot`'s own 8.3 spelling at that position is `appRoot`'s: a path
  along either spelling leaves it where it leaves `appRoot`, so a sibling
  of `appRoot` in its 8.3 spelling stays native, and a path that mixes the
  two (`…\runneradmin\…\APP~1\…` for an `appRoot` given as
  `…\RUNNER~1\…\APP~1`) is `EACCES`. A share of this
  machine is not recognized as its local path: an `appRoot` on
  `\\localhost\C$\…` is reachable as `C:\…` too.
- Under strict a native call on a place's disk — the disk territory of
  `fs.fallback: 'disk'`, a `disk` or `node-default` place, a disk-backed
  entry, a disk-origin write — passes through no link the kernel knows
  (`links: 'deny'`, the default), or first proves where it really lands
  (`links: 'verify'`): see [Links on a place's disk](#links-on-a-places-disk-links).
  A recursive listing of such a disk names a link and never enters it —
  `node:fs`'s own `readdir` does, on Windows even with `withFileTypes` —
  and a recursive `cp` of or into it is `ENOTSUP`. The `PlaceFs` facade
  serves its disk territory the same way. A place's directory may itself
  be a link out of `appRoot` — a media store elsewhere — and is then the
  place's own disk; one that resolves into the territory `appRoot`
  manages — another place, `appRoot`, a directory above it — is a
  configuration error under strict: `initialize()` rejects (`[vfs config]
places.<name>: …`) before anything is read.
- Under strict the patch makes no link to managed territory: a `symlink`
  whose target — resolved from the link's directory, as the OS resolves
  it — lies below `appRoot`, is `appRoot` or a directory above it, and a
  hard `link` to a file below `appRoot`, are `EACCES` before any native
  call (a link within one place too: its target lies below `appRoot`). A
  target off `appRoot`'s line is linked natively — in a place with
  `links: 'deny'`, known from then on, so nothing passes through it. In
  either mode a symbolic link's target is routed as a read, from the
  link's directory: a hidden target is refused.
- A link that already leads into `appRoot` from outside it is not
  covered: its path lies outside `appRoot`, where strict asks nothing.
  Every system has such links — Windows' own junctions,
  `C:\Documents and Settings`, `%USERPROFILE%\Local Settings` and
  `AppData\Local\Application Data`, reach any `appRoot` below the user
  profile, and on Linux `/proc/self/root/…` and `/proc/self/cwd/…` reach
  any `appRoot` at all — and so do hard links and links another process
  makes. Strict is a routing policy, not an OS sandbox.
- `appRoot` itself is a **managed root**: `readdir(appRoot)` and
  `opendir(appRoot)` list the enabled places and nothing else, and
  `stat(appRoot)` is a directory. `watch` of it — as of any managed
  territory — is `ENOTSUP` (recognized but unsupported); writes to it and
  the other guarded calls on it (`rmdir`, `statfs`, `watchFile`, …) are
  `EACCES`.
- A trusted entry point and `package.json` must live **outside
  `appRoot`**, or inside an explicit `node-default` / `disk` place.
  Under strict, `appRoot` should contain place directories and nothing
  else. See `test/fixtures/sandbox` + `strict-app.cjs`.
- Indexed mounts: only published, fs-visible entries are readable;
  unpublished or excluded-ext paths → `EACCES` (disk-backed entries
  excepted) — unless a disk-origin place sets `fs.fallback: 'disk'`
  (below).
- Paths outside `appRoot` → ordinary Node (the spellings of `appRoot`
  above excepted), except operations whose walk would enter
  `appRoot` from above: recursive listings, watches, copies and removals,
  and `rename`, of a directory above it. The scanner does not follow
  symlinks, and neither does the watcher: a link to a directory made
  later in a disk-origin place publishes nothing of its target, and under
  strict a link at a watched key is no source.
- Listings (`readdir`, `opendir`) always come from the places. A copy or a
  rename routes both of its paths and hands on the raw input, so a hidden
  source stays `EACCES`; recursive copies, hard links and watches of
  managed territory are refused (see [Patched `node:fs`](#patched-nodefs)).
  Guarded APIs still enforce the routing decision, so a denied path cannot
  be probed via `glob`, `readlink`, `statfs`, … and a `node:fs` function
  the patch does not know — a later Node release may add one — is refused
  at every call (`ENOTSUP`, see [Patched `node:fs`](#patched-nodefs)).
- Same-process places are not firewalled from each other, and a linked
  worker receives the whole config and snapshot.

### Links on a place's disk: `links`

```js
new VfsConfig({
  defaults: { strict: true }, // links: 'deny' by default
  places: {
    media: { provider: 'disk', fs: true },
    uploads: { provider: 'disk', fs: { writable: true }, links: 'verify' },
  },
});
```

Under strict a native call on a place's disk may meet a link — a symbolic
link, a junction, any entry `node:fs` reports as a symbolic link — and
through it land where the routing never looked: another place, `appRoot`,
anywhere. `links` says how the kernel stands in the way: per place with a
directory on disk (origin `'disk'`, provider `'disk'` or `'node-default'`),
over `defaults.links`. It is a config error without strict and on a place
with no directory; there is no mode that lets links through.

**`'deny'` (the default) refuses the links the kernel knows.**

- `initialize()` walks each such place's directory — `readdir` only,
  entering no link; the scan of a disk-origin place does it — and indexes
  every link below it. The kernel's watcher keeps the index where one
  runs (`watch: true`, a disk-origin place): a link that appears, a
  directory moved in with links, a directory or a file where a link was.
  The patched `node:fs` keeps it too: a `symlink` made in the place, a
  `rename` that moves a link or a directory holding some, within the place
  or into it from outside. The place's own directory is never a known
  link: it may be a link out of `appRoot` (below).
- A call whose path passes through a known link — wherever it leads, the
  place itself included — is `EACCES` before any native I/O: reading,
  writing, listing, creating, copying or renaming through it, and, for the
  module loader, a module behind it. `..` after a link is through it, as
  the OS resolves it on POSIX. A call that names the link itself does not
  follow it and proceeds: `lstat`, `readlink`, `lutimes`, `lchmod`,
  `lchown`, `unlink`, `rmdir`, `rm`, `rename`. The path is read as
  `node:fs` hands it to the OS — on Windows resolved first, a
  drive-relative or root-relative one included — and names compare
  without case on Windows and macOS, as their file systems do by default
  (a case-sensitive volume there only refuses more).
- An ordinary path costs a few lookups in memory — no disk call, no
  `realpath`. A path through a known link costs one `lstat`: a link there
  is refused; a directory or a file there drops it from the index; nothing
  there lets the path through and keeps it known — the patch may be making
  it still. So a link removed and not replaced stays known, a cost of
  memory only (`diagnostics().strict.known`).
- Every thread refuses the same links. A worker (`link()`, `attach()`)
  receives the index with its snapshot; a link one thread makes or moves
  through the patch reaches the others as a `vfs-links` message, the main
  thread passing a worker's on. A counter in shared memory, raised before
  the native call, tells a thread its index may lack one: until the
  message comes, that thread asks the disk (`lstat`) for each name of a
  path below the place's directory. So a link made through the patch is
  known in every thread from the moment the call that makes it starts,
  and refused wherever it is there; a call that runs while that call is
  still in flight — not ordered after it — may find nothing there yet and
  pass, as it may with a proof per call (`'verify'`). A worker kernel made
  from a snapshot without a port hears of no link after it.
- **Not guaranteed:** a link made past the patch — by another process, a
  child process, a native addon, a `node:fs` function captured before the
  patch — is unknown until the watcher reports it, and in a place no
  watcher runs for (`disk`, `node-default`, a disk-origin place without
  `watch`) until the next start. Meanwhile a call through it lands where
  it leads. Who may write into a place's directory is the responsibility
  of whoever owns the environment; where others do, use `'verify'`.

**`'verify'` proves where each call lands.** A native call first asks the
disk where its path really lies (`fs.realpathSync.native`; for a path to
create, of its nearest existing ancestor; for the place's directory,
once). The path is proven as the OS opens it: `..` is resolved from the
real directory before it, past a symbolic link, not folded lexically, so
`d/link/../secret` cannot slip past — and a path that leaves `appRoot`
through `..` after a name inside it is `EACCES` (on Windows `node:fs` folds
`..` before the OS, so this changes nothing there). It holds where it
lands: in the place's directory, or off `appRoot`'s line and on no share —
and, in the disk territory of `fs.fallback: 'disk'`, on no file of an
extension the place caches, which a link can name another way (`t.bin` →
`t.txt`). A link out of the place into another place, `appRoot` or a
directory above it is `EACCES` before any native I/O — reading, writing,
listing or removing through it, and inspecting or removing the link itself
(`lstat`, `readlink`, `unlink`, `rmdir`, `rm`), which the proof cannot
tell from following it — and so, for the module loader, is a module it
leads to; a link that stays in the place, or leads elsewhere, is
followed, whoever made it and whenever. Each such call proves its path
with `realpath`, so it costs more than the string routing: one for a file
read, write or `stat`; two for a directory listing or a path being created
(its parent too); one where a recursive `readdir` starts (it walks below
without following links); one per directory `glob` walks (it re-routes
each); three for a single `cp` or a `require` of a disk-place module
(source, destination and what the resolver reads) — a few microseconds on
Linux, tens on Windows ([benchmarks](doc/benchmarks.md)). A link swapped
in between the answer and the call is not seen: the proof and the call
are two steps, and strict is no OS sandbox.

In both modes the Windows spellings above — namespace, device, UNC and
admin-share paths, NTFS streams, 8.3 forms — are refused before either
applies; read-only places, prepared content and `fs.fallback` route the
same. `kernel.diagnostics().strict` shows each place's mode and how many
links the index holds.

### Partial disk cache: `fs.fallback`

A disk-origin place (`sab` / `map`, `origin: 'disk'`) decides what happens
to a path it does not serve. The resolved value is always explicit:
`'deny'` under strict, `'disk'` otherwise.

```js
places: {
  public: { fs: { ext: ['html', 'css', 'js'], fallback: 'disk' } },
}
```

- `'deny'` — only published canonical VFS entries are served.
- `'disk'` — the files its cache filters do not select (here: images,
  video, …) are served from disk, inside this place only. Cached
  extensions stay VFS-only under strict, so a raw or unpublished file
  never stands in for canonical (prepared) content — nor under another
  name: on Windows the `PlaceFs` facade takes no key with a `:` and no
  file name in short-name form for a disk file, in either mode
  (`/a.txt::$DATA` is `a.txt`, `/INDEX~1.HTM` may be `index.html`). `readdir` merges
  published entries with disk directories and files of the other
  extensions (no companions, no duplicates) — also in a directory that
  exists only on disk, and in either mode: a file of a cached extension is
  listed only once published. The `PlaceFs` facade serves the same disk
  territory.
- The fallback never reaches another place or an unmanaged sibling;
  `fs.writable` stays independent; `require` / `import` never fall back.
- A key keeps its case, while a Windows disk takes a name in any. Without
  strict, a path naming a published file held in memory in another case
  (`A.TXT` for `a.txt`) is that file — its canonical, prepared content,
  never the raw one — for `node:fs` and for `require` / `import` (a module
  so loaded runs without V8 cached data, which is looked up by the key as
  spelled); a disk-backed file is read from disk by the name given, as
  before. Under strict another case is refused like any unpublished path,
  and `'deny'` always refuses it. A directory named in another case is no
  published directory: `'disk'` lists what its disk territory holds there,
  `'deny'` refuses it. A virtual place keeps exact keys on every platform.
- A place without a finite `fs.ext` caches every file and has no disk
  territory of files: `'disk'` is accepted there without strict — it means
  the permissive reads of the default, so a resolved config is valid input
  — and is a config error under strict, where nothing would be served from
  disk.
- Virtual, `sea`, `disk` and `node-default` places have no directory to
  fall back to: `fs.fallback` is `null` there and setting it is a config
  error.

## Lifetime of shared bytes

Shared places (`sab`, `sea`) replace files in place: an update publishes
the new version for new readers and **retires** the old one. Its bytes go
back to the pool only after every linked worker has ACKed the update and
no stream or view in any thread still reads them — never on a timeout.

| API                                           | What you get                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `readFile()`                                  | Owned `Buffer`: keep it, mutate it                                                               |
| `readFileView()` / `readFileCompressedView()` | Lease `{ view, version, release, [Symbol.dispose] }` — needs `fs.zeroCopy`                       |
| `withFileView(key, fn)`                       | `fn(view)` under a lease released when `fn` settles; `null` when missing                         |
| `createReadStream()`, `zeroCopy: false`       | `Readable` of owned chunks; the version is released when the stream ends, errors or is destroyed |
| `createReadStream()`, `zeroCopy: true`        | `Readable` of borrowed SAB chunks; the version is released only by `stream.release()`            |

- A **lease view** is a direct, mutable SAB `Buffer`: stable until
  `release()`, never to be mutated, never to be used afterwards (nor any
  `subarray` of it). `Buffer.from(view)` to keep the bytes. `release()`
  is synchronous, idempotent and safe after any update.
- A **stream** always finishes the version it started with, while new
  readers see the new one. Owned chunks stay valid forever. Borrowed
  chunks (`zeroCopy: true`) can still sit in a socket's write queue after
  the stream ends, so the stream itself holds the version until
  `release()` (idempotent, also `[Symbol.dispose]`; on a still-active
  stream it stops it first). Borrowed chunks are views of shared memory,
  like a lease view: never mutate them, never use them after `release()`;
  `Buffer.from(chunk)` keeps the bytes. Without an option a stream follows
  the place's `fs.zeroCopy`; per call, `{ zeroCopy: false }` asks for owned
  chunks even in a `zeroCopy` place, and `{ zeroCopy: true }` in a place
  without it is `ENOTSUP`.
- Use `pipeline()`. It destroys the source when the destination fails;
  a manual `pipe()` does not — destroy the source yourself when the
  destination closes or aborts.
- A compressed consumer pins only its representation; source and
  companions are held independently.
- `kernel.close()` stops active streams (`ERR_VFS_CLOSED`); a lease still
  held afterwards is a caller error. `map` places hold owned Buffers the
  GC keeps alive: their leases and releases are no-ops.

```js
const stream = files.createReadStream('/video.mp4', { start, end });
try {
  await pipeline(stream, res);
} finally {
  stream.release(); // required for zeroCopy chunks, harmless otherwise
}

const lease = files.readFileView('/index.html');
finished(res, () => lease.release()); // the socket may still be writing
res.end(lease.view);
```

## API

### `VfsConfig`

`new VfsConfig(raw)` — hardcoded defaults → `raw.defaults` → per-place.
Deep-frozen after construction. `config.raw` is the merged input,
cloneable so workers rebuild from it.

| `defaults.*`           | Type   | Default    | Description                         |
| ---------------------- | ------ | ---------- | ----------------------------------- |
| `memory.limit`         | size   | `'1 gib'`  | Total SAB pool budget               |
| `memory.segmentSize`   | size   | `'64 mib'` | SAB segment size                    |
| `memory.maxFileSize`   | size   | `'10 mb'`  | Larger disk files stay on disk      |
| `compaction.threshold` | number | `0.3`      | 0 = off; else compact below this    |
| `hooks.fs`             | bool   | `true`     | Patch `node:fs`                     |
| `hooks.module`         | bool   | `true`     | `module.registerHooks` + `_compile` |
| `watch`                | bool   | `false`    | Watch disk-origin places            |
| `watchTimeout`         | number | `1000`     | Watcher debounce (ms)               |
| `strict`               | bool   | `false`    | Routing policy inside `appRoot`     |
| `links`                | string | `'deny'`   | Under strict: `deny` \| `verify`    |

Sizes accept `metautil.sizeToBytes` strings or numbers: a bare integer
(bytes), or one followed by a decimal (`kb`, `mb`, `gb`, `tb`, `pb`, `eb`,
`zb`, `yb`) or binary (`kib`, `mib`, `gib`, `tib`, `pib`, `eib`, `zib`,
`yib`) unit, case-insensitive, with optional whitespace before the unit
and none after. Any other unit — `'1 xb'`, or trailing text after a real
one — is rejected with `[vfs config]`, not silently read as bytes.
Booleans must be booleans.

`memory.maxFileSize` keeps large disk files out of the pool: they stay
disk entries, read from disk. Content without a disk file of its own —
prepared, virtual or SEA — cannot fall back to disk: if it does not fit,
its publication is refused, named by the operation (see
[Errors](#errors)) — `EFBIG` when the content is larger than
`maxFileSize` and could never fit whatever the pool's state, `ENOSPC`
when the pool merely has no room for it right now; the previous version
stays, and at startup `initialize()` fails.

`watch` starts the kernel's own watcher: it republishes disk changes of
the disk-origin cached places — `sab` + `disk` and `map` + `disk` alike;
virtual places have no disk to watch. It is unrelated to the patched
`fs.watch`, which refuses managed territory with `ENOTSUP` (see
[Patched `node:fs`](#patched-nodefs)). `strict` is described in
[Strict routing](#strict-routing); it is not an OS sandbox. `links` —
also per place — in [Links on a place's disk](#links-on-a-places-disk-links).

| `places.<name>.*` | Type   | Default       | Description                                                                  |
| ----------------- | ------ | ------------- | ---------------------------------------------------------------------------- |
| `provider`        | string | `'sab'`       | `sab`, `map`, `sea`, `disk`, `node-default`                                  |
| `origin`          | string | `'disk'`      | `disk` \| `virtual`; sab/map only                                            |
| `enabled`         | bool   | `true`        | Drop a place without removing it                                             |
| `maxFileSize`     | size   | from defaults | SAB/sea only                                                                 |
| `fs`              | domain | off           | `true` or `{ ext, writable, zeroCopy, compress, script, prepare, fallback }` |
| `require`         | domain | off           | `true` or `{ ext, compile, prepare }` (compile default true)                 |
| `import`          | domain | off           | `true` or `{ ext, prepare }`                                                 |
| `links`           | string | from defaults | Under strict, a place with a directory on disk: `deny` \| `verify`           |

Place name: ASCII `[A-Za-z0-9][A-Za-z0-9._-]*`, no trailing dot, no
Windows reserved names, unique after lowercasing.

Domain defaults: require ext `js,cjs,json`; import ext `js,mjs,json`;
fs ext `null` = everything (resolved `fs.ext` is the union of `fs.ext`
and `fs.script.ext`). At least one domain must be on.

`<domain>.prepare` is `'name'` or `{ name: [ext, …] }` — see
[Preparation](#preparation-prepare). The resolved place carries one index,
`place.prepare = { [ext]: name } | null`.

| `places.<name>.fs.script.*` | Type     | Default        | Description                             |
| --------------------------- | -------- | -------------- | --------------------------------------- |
| `ext`                       | string[] | `['js','cjs']` | Never `mjs`                             |
| `compile`                   | bool     | `true`         | Build the `\0script:bytecode` companion |

| `places.<name>.fs.compress.*` | Type               | Default | Description                     |
| ----------------------------- | ------------------ | ------- | ------------------------------- |
| `encodings`                   | string[]           | —       | `gzip`, `deflate`, `br`, `zstd` |
| `options.<codec>.level`       | number             | native  | Codec level                     |
| `ext`                         | string[] \| string | all     | Or `'compressible'`             |
| `retainRaw`                   | bool               | `true`  | Keep uncompressed source in SAB |

`VfsConfig.fromArgv(argv, appConfig)` parses `--vfs.*` after `--`:
`--vfs.defaults.*`, `--vfs.places.<n>.*`, `--vfs.enable` /
`--vfs.disable`. Coerces `"true"` / `"false"` / numbers only.
`setNested` rejects `__proto__` | `prototype` | `constructor`.

```
node app.js -- --vfs.defaults.memory.limit=512mib \
               --vfs.defaults.strict=true \
               --vfs.enable=static,lib \
               --vfs.disable=scratch
```

### `VfsKernel` (main thread)

`new VfsKernel(config, options)`

| Option      | Default              | Description                                                                                                                 |
| ----------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `appRoot`   | `process.cwd()`      | Root for place directories                                                                                                  |
| `console`   | `globalThis.console` | Logger                                                                                                                      |
| `seaModule` | `node:sea` if any    | Inject for tests                                                                                                            |
| `preparers` | `{}`                 | `{ name: (raw, file) => ... }` named by the domains' `prepare` — synchronous; every name an enabled place uses must be here |

States: `new → initializing → ready → closed` (final). `fs()`,
`snapshot()`, `watch()`, `link()` require `ready`. `initialize()`
failure closes the kernel; a `close()` while it runs makes it reject with
`[vfs] kernel closed before publication` (`code` `ERR_VFS_CLOSED`) — the
file reads it began finish, and nothing else starts: no read, no
preparer. A mutation of a virtual place still publishing when `close()`
comes rejects with the same error: it never resolves without having
published.

| Method               | Description                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `await initialize()` | Scan / SEA / map through the publication pipeline: preparers, bytecode, compression                                                  |
| `fs(name)`           | `PlaceFs` for an indexed fs place                                                                                                    |
| `on('publish', fn)`  | What each publication changed, after its commit — [Publication events](#publication-events); `'close'` once, last                    |
| `version`            | The version of the last publication this thread committed or applied; 0 before the first — [Versions](#versions)                     |
| `instance`           | The main kernel's random id, the same in every thread linked to it                                                                   |
| `snapshot()`         | `{ segments, places, version, instance }` — published entries only                                                                   |
| `link()`             | `{ vfs, transferList }` for a worker — the only worker transport                                                                     |
| `watch()`            | Start `DirWatcher` (also auto if writable disk-origin)                                                                               |
| `diagnostics()`      | Read-only picture of the shared memory: pool, bytes waiting to be freed, each worker's ACKs and holds — [Diagnostics](#diagnostics)  |
| `retirements()`      | Internal diagnostics (debugging, tests; not a stable API): retired versions still held — representation, bytes, age, ACKs or holders |
| `close()`            | Stop watcher and streams, reject queued and publishing mutations, drop projections, collectable SAB                                  |

`link()` returns `{ vfs: { snapshot, config: raw, appRoot, port },
transferList }`. The kernel posts every `vfs-update` to the port, reads
`vfs-ack`, `vfs-release` and mutation requests, and treats port `close`
as worker exit.

#### Versions

Every commit that publishes something takes the next number of the main
kernel's count of publications — its **version** — and so does every
file it publishes:

```js
const files = kernel.fs('static');
files.version('/index.html'); // 7: the commit that published this file
kernel.version; // 9: the last publication this thread has seen
```

- **What takes one.** A commit that publishes: `initialize()` (one commit,
  version 1 when anything was published), each watcher epoch, each
  mutation of a `sab + virtual` place — a write, an append, an `unlink`, a
  `rm`, the rename of a file or of a subtree, removals included. Writing
  the same bytes again is a new version, as it is a new mtime on disk.
- **What takes none.** What publishes nothing: a rename onto itself,
  `mkdir`, a forced `rm` of nothing, a watcher epoch that finds nothing to
  change; and a compaction, which moves bytes without changing any file:
  every entry keeps its version.
- **One commit, one version.** The files of one commit — a watcher epoch,
  a `rm -r`, a subtree move — share it: equal versions mean published
  together.
- **Every thread.** An entry carries its version into every snapshot and
  update: `files.version(key)` is the same number in the main thread and in
  every worker. A worker's `kernel.version` is the version of the last
  update it applied: it lags while an update is on its way, and is equal
  once the worker holds the same state.
- **`null`** for a missing key, a file of a `map` place (per-thread
  content, which no commit publishes) and the disk territory of
  `fs.fallback: 'disk'`. A published entry the place keeps on disk — a
  file larger than `maxFileSize`, the source of `retainRaw: false` — is no
  disk territory: its commit published it, and it has its version.
- Leases carry the version of their file (`lease.version`), and so does a
  script bundle (`files.script(key).version`): a `vm.Script` built from a
  bundle serves until the file's version changes.
- **Not a clock, not an identity across restarts.** A version never
  depends on the time, and restarts at 0 with each process: alone, it
  would name another content after a restart. `kernel.instance` — 6
  random bytes, base64url — names the main kernel that owns the pool, in
  every thread linked to it, so `${kernel.instance}-${files.version(key)}`
  never names two contents: a weak validator (an ETag) that changes with
  each publication of the file. One that stays equal for equal content,
  whatever process published it, is a hash of the content, which a
  preparer can compute once and return in `meta`.

#### Publication events

`VfsKernel` is an `EventEmitter`, in the main thread and in every worker
(`attach()` returns the worker's kernel):

```js
kernel.on('publish', ({ version, places }) => {
  for (const [name, { created, replaced, removed }] of Object.entries(places)) {
    // the source keys of place `name` this publication created, replaced
    // or removed
  }
});
```

- **`'publish'`** comes once per publication a thread applies — one
  commit: `initialize()`, a watcher epoch, a mutation of a `sab + virtual`
  place — with its version and the source keys it changed, by place:
  `created` (no file there before), `replaced`, `removed`. A rename is its
  old key `removed` and its new one `created` or `replaced`, in one event;
  companions are never named. What publishes nothing is not announced,
  nor is a compaction.
- **When.** After the commit, in a microtask of its own — never inside
  it: the index and the projection hold the publication already. On the
  main thread, and in a worker for its own mutation, the listeners run
  before the mutation's promise settles. A worker announces an update when
  it applies it, and ACKs it without waiting for the listeners. Events come
  in the order of their versions. A listener there before `initialize()`
  gets the init publication, every key it published; the lists are built
  only when there is a listener.
- **What.** A frozen object of strings and numbers — no Buffer, no entry,
  no view: a listener holds no shared bytes and delays no free. It says
  what changed; what a key holds is read through `kernel.fs(name)` and may
  be newer already — compare `files.version(key)` with `event.version`.
- **Shared places only.** A `map` place is each thread's own: its writes
  publish nothing and announce nothing.
- **Errors.** What a listener throws is an uncaught exception, as from any
  emitter; the publication, its ACK and the mutation's promise are done by
  then. An async listener's rejection is its own. The kernel never emits
  `'error'`.
- **`'close'`** comes once, last, in a microtask after the first
  `close()`, which then drops every listener. Once `close()` has
  returned, no `'publish'` listener is called — not even for a
  publication committed before it. Iterated with
  `events.on(kernel, 'publish', { close: ['close'] })`, the events end
  there; `events.on` and `events.once` take an `AbortSignal` too — an
  `events.once(kernel, 'publish')` still waiting at `close()` never
  settles without one.
- Past 10 listeners of `'publish'` on one kernel — each `events.on`
  iteration counts as one — Node prints its `MaxListenersExceededWarning`,
  as for any emitter: `kernel.setMaxListeners(n)` raises the limit.
- Events report publications, whatever their origin — never raw disk
  events: they are no `fs.watch`, which stays `ENOTSUP` for managed
  territory in the patched `node:fs`.

#### Diagnostics

`kernel.diagnostics()` returns what the shared memory holds and why, as
of the call — a frozen plain object, a new one each time:

```js
{
  pool: {
    limit, segmentSize, // the budget, the size of a segment (bytes)
    segments,           // segments reserved, empty ones kept for reuse included
    reserved,           // their bytes
    used,               // bytes in allocations: published, retired or being published
    free,               // reserved − used
    largestFree,        // the largest allocation that fits without a new segment
    fragmentation,      // 1 − largestFree / free; 0 when nothing is free
  },
  published: {          // what the shared places (sab, sea) publish
    files,              // their sources, those read from disk included
    bytes,              // what their versions take of the pool, companions included
  },
  retired: {            // replaced or removed representations not freed yet
    representations, bytes, oldestMs,
    waitingAck: { representations, bytes },     // their update not ACKed by every worker
    waitingRelease: { representations, bytes }, // ACKed, still read by a stream or lease
  },
  main: {
    held: { representations, bytes, oldestMs }, // what this thread's streams and leases still read
  },
  links: [              // one per linked worker (link())
    {
      id,
      pending: { updates, oldestMs },           // updates it has not ACKed
      held: { representations, bytes, oldestMs }, // retired representations it still reads
    },
  ],
  disk: {               // published sources read from disk
    files, bytes,
    fallback: { files, bytes }, // of them, those the pool had no room for
  },
  preparation: {
    failures,           // preparations that failed since initialize()
    places,             // { [place]: failures }, each place that declares `prepare`
  },
  strict: {             // null without strict
    links,              // { [place]: 'deny' | 'verify' }, each place with a directory on disk
    known,              // links the index holds, some perhaps removed since (see links)
  },
  queues: {
    watch: { epochs, rechecks }, // watcher epochs queued or running; rechecks waiting
    mutations: { keys, barriers }, // keys of virtual places with a mutation queued or
                                   // running; places a subtree mutation holds
  },
}
```

- A **representation** is what is retired and freed on its own: a source,
  or one of its companions — a compressed form, a bytecode flavor. One
  replaced file with gzip and bytecode is three.
- A **stuck worker** shows as a link whose `pending.oldestMs` grows: it
  receives updates but does not ACK them, and every representation they
  retire stays in the pool (`retired.waitingAck`). Only an update that
  retires one waits for ACKs; one that adds files never does. A worker
  that ACKs but keeps a stream or lease open shows as its `held`; the
  main thread's own streams and leases as `main.held`.
- `pool.used` is `published.bytes` plus `retired.bytes`, plus the bytes of
  the publications in progress: anything more is a leak.
- `disk.fallback` counts sources a place caches but serves from disk, the
  pool having had no room when they were published — neither larger than
  `maxFileSize` nor kept on disk by `retainRaw: false`; they stay on disk
  until a change republishes them. A sign that `memory.limit` is too small.
- `preparation.failures` counts the preparations on the main thread that
  threw or returned what no preparer may — at init, in the watcher (the
  previous version stays), in writes.
- `queues` that stay above zero show a pipeline that does not drain: a
  watcher epoch that does not finish, or a mutation that does not settle.
  A barrier (`rm`, the rename of a directory) takes over the keys queued
  before it.
- Read-only: it frees, settles, compacts and publishes nothing, and costs
  nothing on reads or publications — every figure but the failures is
  taken from the pool, the retirement books, the links, the index and the
  queues when asked. It walks the index: call it every few seconds, not
  per request. Main thread only, on a ready kernel.

#### Adapter API

`routeRead(absPath)`, `routeMutation(absPath)`,
`resolveModule(absPath, domain)` and `bytecode(absPath)` exist for
`lib/adapters/*`, not for application code: they hand back raw routing
decisions and borrowed views without the ownership and ext policies
`PlaceFs` applies. `bytecode()` in particular returns a borrowed SAB
view that the compile hook passes straight to `vm.Script`. Application
code should use `kernel.fs(name)`.

### `VfsKernel` (worker)

`attach({ link = workerData.vfs, preparers } = {})` projects the
snapshot — at its `version`, with the main kernel's `instance` — installs
hooks the config asks for, applies `vfs-update` from the link port, each
with its version, announcing each publication to its own `'publish'`
listeners, and ACKs **those — and only those** — back, with the
retired versions its streams and leases still read. Publishes
`VfsKernel.current` (also the `kernel` getter of the package's CommonJS
entry — not an ES module named export: from ESM read `VfsKernel.current`,
or `kernel` of the default import).
`preparers` serve local writes to the worker's own `map` places; a
worker never prepares shared places. The options object replaces the
positional `attach(link)` of earlier versions.

### `PlaceFs`

Returned by `kernel.fs(name)`. Reads return `null` when missing;
`readdir` throws `ENOENT` / `ENOTDIR`. Keys: exact, then `'/' + key`.
Mutations take a canonical key: a leading slash, then names — an empty,
`.` or `..` segment, NUL or a backslash is a `TypeError`. A trailing slash
names a directory, as on POSIX: a write to it is `EISDIR`; `unlink`, `rm`
and `rename` of a file named so are `ENOTDIR`, which `rm` with `force`
ignores as it does `ENOENT`. `writeFile` / `appendFile` honor a `flag` as
`node:fs` does: `w…` replaces the file, `a…` appends to it, `x` only
creates it (`EEXIST`, checked when the write runs); a read or numeric flag
is `ENOTSUP` in a virtual place. On disk, `node:fs` answers by its own
rules. A recursive `readdir` names its entries with `/`, the form of keys,
on every platform; `sep: path.sep` asks for the native separator — what
the patched `node:fs` lists with — in the same order, the keys'.

| Method                                       | Returns                                                        | Description                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readFile(key, opts)`                        | Buffer \| string \| null                                       | Owned copy                                                                                                                                        |
| `readFileView(key)`                          | lease \| null                                                  | `{ view, version, release, [Symbol.dispose] }`; needs `zeroCopy`; null when missing or on disk                                                    |
| `withFileView(key, fn)`                      | Promise                                                        | `fn(view)` under a lease; `null` without calling `fn` when missing                                                                                |
| `stat(key, opts)`                            | `VfsStats` \| null                                             | Lazy; `{ bigint }` ok                                                                                                                             |
| `exists(key)`                                | bool                                                           | File or implicit directory                                                                                                                        |
| `version(key)`                               | number \| null                                                 | The commit that published the file ([Versions](#versions)); null for a missing key, a `map` place, the disk territory                             |
| `readdir(key, opts)`                         | string[] \| Buffer[] \| Dirent[]                               | Implicit dirs; lex order; `{ withFileTypes, recursive, encoding, sep }` or an encoding; recursive names `/`-separated unless `sep: path.sep`      |
| `createReadStream(key, opts)`                | `VfsReadStream` \| null                                        | `{ start, end }` inclusive, `zeroCopy`; `release()`                                                                                               |
| `storedEncodings(key)`                       | string[]                                                       | `'raw'` plus configured codecs                                                                                                                    |
| `readFileCompressed(key, enc)`               | Buffer \| null                                                 | Owned copy                                                                                                                                        |
| `readFileCompressedView(key, enc)`           | lease \| null                                                  | Pins that representation only; needs `zeroCopy`                                                                                                   |
| `statCompressed(key, enc)`                   | object \| null                                                 | `{ size, sourceSize, encoding, … }`                                                                                                               |
| `createReadStreamCompressed(key, enc, opts)` | `VfsReadStream` \| null                                        | Range is compressed bytes                                                                                                                         |
| `pathOf(key)`                                | string                                                         | Absolute OS path                                                                                                                                  |
| `script(key)`                                | `{ source, cachedData, scriptOptions, meta, version }` \| null | `ENOTSUP` when no `fs.script`                                                                                                                     |
| `meta(key)`                                  | object \| null                                                 | Frozen preparer metadata                                                                                                                          |
| `writeFile` / `appendFile` / `unlink`        | void \| Promise                                                | Sync for map/disk; Promise for `sab + virtual`                                                                                                    |
| `writeFiles(files, opts)`                    | void \| `Promise<number>`                                      | Several files of a virtual place as one publication, or none — [writeFiles](#several-files-as-one-writefiles); the version of its commit          |
| `mkdir` / `rm` / `rename`                    | void \| Promise                                                | `mkdir` creates no entry, checks the hierarchy; a directory `rename` moves a raw-only subtree; `ENOTSUP` for `appendFile` / moving a prepared key |

A virtual place keeps the hierarchy of a filesystem: a path is a file or a
directory, never both. A key under a file is `ENOTDIR`, a file where a
directory is `EISDIR` — for writes, appends, copies, renames and subtree
moves alike, and for mutations that run at the same time. Directories are
implicit — `mkdir` creates no entry, a directory exists while a file is
under it — yet answer as a filesystem does: `mkdir` of a file is `EEXIST`,
under a file `ENOTDIR`, of an existing directory `EEXIST` without
`recursive`; `unlink` of a directory is `EISDIR`, and `rm` of one without
`recursive` is `ERR_FS_EISDIR`, `node:fs`'s own error. The place's own
directory (`'/'`) always exists and never moves: a recursive `mkdir` of it
succeeds, a plain one is `EEXIST`, writes and `unlink` are `EISDIR`, `rm`
and `rename` are `ENOTSUP`. Through patched
`fs`, a `rename` across a virtual place's boundary is `EXDEV` (see
[Copies and renames](#copies-and-renames)), and the `*Sync` forms refuse a
`sab + virtual` place (`ENOTSUP`): the main kernel publishes its
mutations — `mkdirSync` included, except of the place's own directory,
which answers at once.

#### Several files as one: `writeFiles`

```js
const version = await files.writeFiles([
  ['/api/routes.js', routes],
  ['/api/handlers.js', handlers],
]);
files.version('/api/routes.js') === version; // true: one commit
```

`writeFiles(files, options)` writes several files of a virtual place as
one publication: either every file is published, in one commit — one
`vfs-update`, one version, one `'publish'` event, one mtime — or none is,
and no thread ever sees part of the set.

- **Input.** `[key, data]` pairs — an array, a `Map`, any iterable — or an
  object of key → data; data is a string (in `options.encoding`, or an
  encoding string as the options) or bytes, taken when it is called.
  `options.flag`: `w…` (the default) replaces, `x` creates every key only
  (`wx`, `xw`, and `ax`, `xa` alike); an append flag without `x` is
  `ENOTSUP`.
- **Checked whole, then prepared.** The arguments are checked at once and
  nothing is queued when they fail: no file, a key twice (as its canonical
  key) or data that is not a string or bytes is a `TypeError`, an invalid
  key too; the place's own directory or a key named as a directory is
  `EISDIR`. Then, in the turn of all its keys — locked in one step, never
  one by one — the set keeps the hierarchy as a write does, against the
  place, the mutations in flight and itself: a file of the set above
  another of its keys is `ENOTDIR`; with `x` any existing key is `EEXIST`.
  Only then is each file prepared, once; its keys count as files in flight
  until the set is published or refused.
- **All or nothing.** A preparer that throws, a script flavor that does
  not compile (`ENOTSUP`), a pool without room (`ENOSPC`) or a file larger
  than `maxFileSize` (`EFBIG`), a `close()` before the commit
  (`ERR_VFS_CLOSED`): the set is refused, what its files placed goes back
  to the pool, and every file keeps its previous version.
  A refusal about a key is named by it: `syscall` `writeFiles`, `path` the
  key's.
- **Places.** A `sab + virtual` place resolves with the version of the
  commit, in any thread: a worker's set crosses its link as one request,
  its bytes in one transferred buffer, and the main kernel checks it again
  whole; its update reaches the worker before the answer, as for any
  worker mutation. A `map` place — each thread's own — publishes the set
  at once, every preparer and bytecode flavor computed before the first
  file changes, and returns `undefined`. A read-only place is `EROFS`, a
  disk-origin place `ENOTSUP` (its writes land on disk file by file): both
  with the place's directory as `path`.
- One flag and no removals in a set: `null` data is a `TypeError`.

## Patched `node:fs`

With `hooks.fs` on, `node:fs` routes through the kernel. Every path-taking
API falls into one of three groups below. Full `node:fs` compatibility is
not promised. A path is routed as `path.resolve` gives it, except that a
trailing separator names a directory, as on POSIX — on every platform, for
what a place serves or stores: a file named so is `ENOTDIR` (`existsSync`
is false), a write or copy to it `EISDIR`. What passes through keeps the
rules of `node:fs`, which on Windows ignores a trailing separator.

**The rule.** A native `node:fs` operation runs only once every path it
touches has been routed:

- a single-path operation runs after the routing of its source and
  destination allows it;
- a copy or a rename hands on the source's raw input — the raw disk file
  of a disk-origin place, prepared or not, or the canonical bytes of an
  unprepared virtual entry — never a prepared result or a companion, and
  the destination publishes it through its own pipeline;
- a recursive or compound operation whose routing could check only its top
  path is refused;
- a virtual destination is never changed by a native disk operation;
- a recursive operation from outside `appRoot` is refused when its walk
  would enter `appRoot`;
- unrelated paths outside `appRoot` stay native.

Where the kernel cannot guarantee that, the operation fails with `ENOTSUP`
before anything is read or written; it is not approximated. Under strict
routing every compound native operation stays within these limits; strict
is a routing and access boundary, not an OS sandbox.

**Every export is known.** The patch lists every export of `node:fs` and
`node:fs/promises` of the supported Node releases, and what it does with
each (`lib/adapters/fs-surface.js`): implemented, guarded (the groups
below), _delegated_ — not wrapped, every disk access it makes goes through
patched functions: `createWriteStream`, the `ReadStream` / `WriteStream` /
`Utf8Stream` classes open through `fs.open`, `exists` asks `fs.access`,
`unwatchFile` touches no disk — or _path-free_: descriptors (`read`,
`fstat`, …), handles, classes over them, constants. Under strict, a
function the list does not know — one a later Node release adds — is
refused at every call before it runs, whatever its arguments: `ENOTSUP`
with the function as `syscall` (`fs.newThing`, `fs.promises.newThing`,
`fs.readFile.newThing`); a function of `node:fs/promises` rejects, one of
`node:fs` throws. So is the function an unknown accessor gives, and every
function an unknown one carries (as `realpath` carries `.native`).
Without strict, the patch leaves what it does not know as Node made it. A
test fails on a Node whose exports differ from the list, so a new one is
classified deliberately. Under strict, `install()` fails — installing
nothing — on an unknown export it cannot hold: one it cannot replace, and
an object, plain or behind an accessor — a namespace of functions, as
`node:fs/promises` is one (`[vfs] unknown node:fs surface fs.x: strict
routing cannot hold it`).

**1. Implemented** — served by the places; sync, callback and promises
forms: `readFile`, `stat`, `lstat`, `access`, `realpath` (its `.native`
variants too), `readdir`,
`opendir`, `existsSync`, `createReadStream`, `openAsBlob`, `writeFile`,
`appendFile`, `unlink`, `mkdir`, `rm`, `rename`, `copyFile` and a
non-recursive `cp` (see [Copies and renames](#copies-and-renames)).

`openAsBlob` reads through a native binding, past every `node:fs`
function, so it is routed here rather than passed through: a published
entry gives a `Blob` over an owned copy of its canonical content, a
directory is `EISDIR`, and what the patch refuses is a rejection — the call
is documented to return a promise. The disk territory and paths outside
stay native, in whatever form `node:fs` refuses them. `openAsBlobSync`
(Node 26.10) reads through the same binding and is routed the same way: it
returns the `Blob`, and throws what the patch refuses.

`opendir` returns a `Dir` over exactly what `readdir` lists there (the
strict `appRoot`, a place directory, the disk territory of
`fs.fallback: 'disk'`), taken when it is opened; it is not an `fs.Dir`
instance. It supports `read()` / `read(callback)` / `readSync()`, `close()`
/ `close(callback)` / `closeSync()`, async iteration (which closes the
handle), `recursive` and `encoding`. As in `node:fs`, reading or closing a
closed handle fails with `ERR_DIR_CLOSED`, while `[Symbol.dispose]()` /
`[Symbol.asyncDispose]()` of a closed handle do nothing.

Listings (`readdir`, `opendir`) give names in the requested `encoding`
(an options object or an encoding string): `'buffer'` gives Buffer names,
`Dirent.name` included; any other encoding re-encodes the UTF-8 name.
Entries are deduplicated and sorted by their string names first, so every
encoding lists them in the same order. A recursive listing names its
entries with `path.sep`, as native `node:fs` does (`sub\a.txt` on
Windows) — `PlaceFs.readdir` keeps the `/` of its keys — sorted by their
key, so every platform lists them in the same order too. Unlike native
`node:fs` (22.22.3 to 26.x), which fails `recursive` together with
`encoding: 'buffer'`, a managed recursive listing gives Buffer names too;
`parentPath` stays a string.

A reference to a patched function taken while the patch is installed
(`const { readFile } = require('node:fs')`, or glob's own walk) keeps
working after `uninstall()`: with no kernel installed it is the original
`node:fs` function again. A named import (`import { readFileSync } from
'node:fs'`, or from `node:fs/promises`) follows `install()` and
`uninstall()` whenever it was bound — by a preload before the bootstrap
too: both update the named exports of the ES modules. A reference taken
before `install()` in any other way, as `const { readFile } = fs` then,
stays the original function: take references from `node:fs` once the
kernel is wired, or call through the module (`fs.readFile`).

**2. Recognized but unsupported for managed territory** — `ENOTSUP` with
`syscall`, `path` and, for copies, links and renames, `dest`; nothing is
read or written:

- `open` of a virtual entry, whatever its flags — a `sab` or `map` entry
  of a virtual place, a SEA asset — and of a published disk-origin entry
  with a flag that can read (`r`, `+`, `O_RDWR`), whether it writes too: a
  descriptor is the raw file, not the canonical content, so
  descriptor-based calls (`read`, `write`, `fstat`, …) never read what a
  place serves. `readFile` and `createReadStream` with a flag that writes
  open as `open` does.
- `cp` / `copyFile` / `rename` of a prepared virtual (or SEA) entry: there
  is no raw input to hand on. A copy of a place directory, too.
- A recursive `cp` whose source or destination is in an indexed place —
  under strict in any place, whose walk would follow a link out of it —
  or that encloses `appRoot`: a native walk reads and writes raw files
  past the routing and misses virtual entries.
- A hard link into or out of a place: one physical file under two names,
  while a place gives each name its own canonical content, preparation and
  companions — and a second name would escape the place's mutation policy.
- `watch` of managed territory — a place directory, a published file, the
  strict `appRoot`, any recursive watch of a place: a native watcher
  reports raw disk events, hidden names included, not publications. A file
  of the disk territory keeps a native watcher: it is its own content.
  `fs.promises.watch` reports the refusal when iterated, as `node:fs`
  reports its errors.
- Recursive `readdir`, `opendir`, `watch`, `rm` and `rmdir`, and `rename`,
  of a tree that holds places — `appRoot` passed through without strict,
  or a directory above it: the walk would enter the places natively. One
  level (`readdir(parent)`) stays native.
- A directory renamed across a place's boundary — into, out of or between
  places, a place's root included: every descendant would change policy
  at once. And a virtual subtree that is not raw-only: a prepared or
  compiled source cannot move without its pipeline running again.
- A guarded mutation (below) in a virtual place, `open` with a flag that
  writes included: only its store changes its entries, and no file appears
  in its directory on disk.
- A `glob` loaded before the first `install()` whose walk starts in or
  above managed territory: it walks with the native functions it captured
  (see below).

**3. Native passthrough outside managed territory** — plain `node:fs`:

- unrelated paths outside `appRoot`, `disk` and `node-default` places,
  files of the disk territory (`fs.fallback: 'disk'`), and — without
  strict — unmanaged paths under `appRoot`; under strict a place's disk
  only past its `links` — no link the kernel knows on the path, or the
  disk says where it really lies (see
  [Links on a place's disk](#links-on-a-places-disk-links)) — and its
  recursive `readdir` from a walk that enters no link;
- `symlink`, once its path passes the mutation routing and its target —
  resolved from the link's directory, as the OS resolves it — the read
  routing, and under strict lies off `appRoot`'s line (above);
- the guarded APIs, once the routing of every path argument allows them:
  `chmod` / `lchmod`, `chown` / `lchown`, `utimes` / `lutimes`,
  `truncate`, `readlink`, `statfs`, `watchFile`, `rmdir`
  (without `recursive`), `mkdtemp` — its disposable forms too — whose
  path is the directory it makes: its prefix and the six characters it
  appends, `XXXXXX` in its errors, as in `node:fs`'s. A denied path stays
  `EACCES` / `EROFS`, so it cannot be read, listed, copied or probed
  through them, and the strict `appRoot` itself is refused; in a virtual
  place a directory is implicit, so `mkdtemp` there is `ENOTSUP`, like
  any guarded mutation.
- `glob`, which walks with the `node:fs` functions it captured when Node
  loaded it: `install()` loads it, so it walks through the patch — every
  directory read and stat routed, so it lists what the places list at
  each level (virtual entries included; a non-strict `appRoot` lists
  natively, as `readdir` does there) and never enters denied territory. A
  `cwd`, or a pattern's literal prefix, that the routing denies is
  `EACCES` before any walk. A glob loaded before the first `install()` —
  by a test runner, or by a call before the kernel was wired — walks
  natively, which no wrapper can change: a walk that starts in or above
  managed territory is then `ENOTSUP`, like any native walk into the
  places, and one elsewhere stays native.
- `open` of what the read routing passes through; with a flag that writes
  — a string with `w`, `a`, `x` or `+`, a number with `O_WRONLY`,
  `O_RDWR`, `O_CREAT`, `O_TRUNC` or `O_APPEND` — only once the mutation
  routing allows it too, as a guarded mutation: `EROFS` in a read-only
  place, `ENOTSUP` in a virtual one. In a disk-origin place a descriptor
  that only writes — no `r`, no `+`, no `O_RDWR` — is the raw file, as
  `writeFile` writes it, and the watcher republishes it: a published entry
  opens so wherever `writeFile` would write it, and such a flag needs no
  read routing, so `open(new, 'w')` passes where `writeFileSync(new)`
  does. A flag that can read has no descriptor to a published entry
  (`ENOTSUP`), whether it writes too — the raw file never stands in for
  the canonical content — and stays `EACCES` on a hidden path.
  `createWriteStream` opens through `fs.open`, so its stream emits the
  same error. `readFile` with a flag that writes (`{ flag: 'w' }`,
  `'a+'`, …) opens the file with it before it reads, which may create or
  truncate it: it is routed as `open` with that flag, and what `open`
  lets through is read natively — a flag that only writes then reads
  nothing, as `node:fs` answers it (`EBADF`). So is `createReadStream`
  with `flags` that write: the call returns a stream at once and a
  refusal is emitted on it, before the stream opens anything, whatever
  `fs` it is given; what `open` lets through streams natively. A stream
  given a descriptor (`fd`, a number or a `FileHandle`) opens nothing: it
  is `node:fs`'s, reading the descriptor whatever path names it.

### Copies and renames

`copyFile` and a non-recursive `cp` route the source as a read and the
destination as a mutation, then hand the destination the source's **raw
input** — what a publication consumes:

| Source                                                   | Raw input                                       |
| -------------------------------------------------------- | ----------------------------------------------- |
| Disk-origin place: a published entry, prepared or not    | its raw disk file, never the prepared content   |
| Disk territory, `disk` / `node-default` place, elsewhere | the file on disk                                |
| Unprepared virtual (or SEA) entry                        | its canonical bytes — they are its raw input    |
| Prepared virtual (or SEA) entry                          | none, it is not kept: `ENOTSUP`                 |
| Hidden source (unpublished, unmanaged, `fallback: deny`) | `EACCES`, before anything is read               |
| Compression or bytecode companion                        | never: derived from the content, rebuilt anyway |

The destination publishes the bytes through its own pipeline — its
preparer runs once, the source's never runs again:

| Destination                | Result                                                         |
| -------------------------- | -------------------------------------------------------------- |
| Outside `appRoot`          | the raw bytes, as `node:fs` copies them                        |
| Writable disk-origin place | the raw bytes on disk; its watcher prepares and publishes them |
| Writable virtual place     | written through its store; no file appears on disk             |
| Read-only place, denied    | `EROFS` / `EACCES`, nothing written                            |

A `sab + virtual` place mutates asynchronously, so `copyFileSync` /
`cpSync` into it are `ENOTSUP`. Options keep their `node:fs` meaning for
one file (`COPYFILE_EXCL`, `COPYFILE_FICLONE`, `force`, `errorOnExist`,
`dereference`); one the VFS cannot honor (`COPYFILE_FICLONE_FORCE`,
`filter`, `preserveTimestamps`) is `ENOTSUP`, never ignored. As in
`node:fs`, `cp` never puts a file on a directory, whatever `force` says
(`ERR_FS_CP_NON_DIR_TO_DIR`), and `errorOnExist` fails with
`ERR_FS_CP_EEXIST` — both `node:fs`'s own `SystemError`, named by the
destination. A recursive `cp` of or into managed territory is `ENOTSUP`.

A `rename` routes both paths as mutations and its source as a read:

- On disk it moves the raw file. A published disk-origin file may leave
  `appRoot` — it arrives as its raw source — or change its extension; the
  watchers drop the old canonical entry and publish the new key by the
  policy of its place and extension: its preparer, or the disk territory
  for an extension the place does not cache. Disk-origin places share the
  disk, so a file moves between them natively.
- A hidden source is `EACCES`: no new name makes it readable.
- A directory moves natively within one disk-origin place — the watcher
  republishes its tree — and outside managed territory. A directory rename
  across a place's boundary, of a place's root or of a tree that holds
  places is `ENOTSUP`. `disk` and `node-default` places are plain
  `node:fs` territory — but under strict nothing but a regular file leaves
  any place, whatever its provider: a directory, the place's own included,
  or a link leaving it is `ENOTSUP` (it could take a link of the place's
  disk out of it, a link into `appRoot` from outside).
- In a virtual place the store moves an ordinary entry atomically and keeps
  its mtime; the preparer of a new extension runs once. A prepared entry
  has no raw input to move: `ENOTSUP`. A file renamed onto itself changes
  nothing — no publication, no update — as with `node:fs`.
- A virtual directory moves as a whole subtree when every source under it
  is raw-only — no preparer, no bytecode (`require.compile`,
  `fs.script.compile`), no path-dependent `scriptOptions` / `meta`.
  Sources and their compressed representations keep their bytes, stat and
  mtime under the new prefix, in one publication; nothing is prepared,
  compiled or compressed again. One source that cannot move refuses the
  whole subtree (`ENOTSUP`); a destination that exists is `ENOTEMPTY` /
  `ENOTDIR`, one under a file `ENOTDIR`, a move into itself `EINVAL` —
  before anything changes.
- Across a virtual place's boundary it is `EXDEV` — never a copy and a
  delete.

`readFile` returns the canonical (prepared) content: writing it elsewhere
with `writeFile` is a new publication the destination may prepare again,
not a raw-preserving copy.

## Errors

| Code            | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EACCES`        | Strict routing denial: unowned path under `appRoot`, place with no fs domain, or an unpublished / excluded-ext entry in an indexed mount; any unpublished entry of a place with `fs.fallback: 'deny'`, strict or not; the hidden source of a copy, rename or link; under strict a path through a link on a place's disk (`links`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `EROFS`         | Place has `fs.writable: false` (or provider `sea`) — also for `open` / `createWriteStream` / `readFile` / `createReadStream` with a flag that writes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ENOTSUP`       | No file descriptor for a virtual entry (`open`, whatever its flags) or for the canonical content of a published disk-origin entry (`open` with a flag that can read, `+` included) — nor for `readFile` or `createReadStream` with a flag that writes, which open as `open` does; `*View` or a `{ zeroCopy: true }` stream without `fs.zeroCopy`; compressed API for an unconfigured encoding; `appendFile`, `rename` or a copy of a prepared virtual key; a write whose preparer is not registered in this thread; a `*Sync` mutation or copy into a `sab + virtual` place; a copy option the VFS cannot honor; a recursive `cp` of or into managed territory; a hard link into or out of a place; `watch` of managed territory; a recursive walk or `rename` of a tree that holds places; a directory renamed across a place's boundary (a place's root included) — under strict a directory or a link leaving any place; a virtual subtree rename that is not raw-only; `rm` / `rename` of a place's own directory; a guarded mutation in a virtual place, `open` / `createWriteStream` / `readFile` / `createReadStream` with a flag that writes included; a `glob` loaded before the patch whose walk starts in or above managed territory; under strict, a `node:fs` function the patch does not know (`syscall` names it); `writeFiles` of a disk-origin place, or with a flag that neither replaces nor creates |
| `ENOENT`        | Missing key in a writable place; `readdir` of a missing directory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ERR_FS_EISDIR` | `rm` of a virtual directory without `recursive` — the `SystemError` `node:fs` throws, `info.code` `EISDIR`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ERR_FS_CP_*`   | `cp` of a file onto a directory (`ERR_FS_CP_NON_DIR_TO_DIR`), or onto an existing file with `errorOnExist` (`ERR_FS_CP_EEXIST`) — the `SystemError` `node:fs` throws, named by the destination                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `EEXIST`        | `mkdir` of a virtual file, or of a directory without `recursive` (the place's own included); a write with an `x` flag, or a `COPYFILE_EXCL` copy, onto an existing virtual entry; an existing key of a `writeFiles` set with an `x` flag                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ENOTDIR`       | `readdir` of a file; a virtual key under a file — in a `writeFiles` set, under another key of the set too; a file the VFS serves or stores, named with a trailing separator (`force` ignores it in `rm`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `EXDEV`         | `rename` across a virtual place's boundary: between two places, or between one and the disk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ENOSPC`        | The pool has no room right now for content that cannot fall back to disk — a virtual write, copy or rename (a subtree move included), a prepared or SEA source, a `fs.script.compile` flavor; nothing is published. Named by the operation: `open` of the key (at startup too, where `initialize()` rejects with it), `rename` with `dest`, a copy's `copyfile` / `cp` with `dest` and the store's refusal as its `cause`, `writeFiles` with the key that did not fit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `EFBIG`         | Same content as `ENOSPC`, but too large to ever fit, whatever the pool's state, never just a transient lack of room: a canonical source larger than `places.<name>.maxFileSize` (or `defaults.memory.maxFileSize`), or a companion — a `fs.script.compile` flavor, a subtree-move copy — larger than one segment (`defaults.memory.segmentSize`). Named the same way as `ENOSPC`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `EISDIR`        | `readFile` / `createReadStream` / `openAsBlob` / `openAsBlobSync` of an implicit directory; a virtual file written, copied or renamed where a directory is; a write or `unlink` of a place's own directory; `unlink` of a virtual directory; a virtual file write or copy to a path with a trailing separator                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Errors carry the same `code`, `errno`, `syscall` and `path` fields as
`node:fs`, and `dest` for copies, links and renames. A stream stopped by
`kernel.close()` errors with `ERR_VFS_CLOSED`, and so does every mutation
a closed kernel refuses: a publication `close()` cuts short —
`initialize()`, a mutation still publishing, a worker's mutation its own
kernel's `close()` finds waiting (`[vfs] kernel closed before
publication` — the worker's request may have reached the main kernel,
which may or may not have published it); a mutation still queued when the
kernel closes, or asked of it afterwards (`[vfs] mutations requires a
ready kernel (state: closed)`); a worker's mutation whose link to the main
kernel closed before its answer (`[vfs] link closed before the mutation
was answered: it may or may not have been published` — the main kernel
may have published it before it closed).

## Protocol

```
snapshot    { segments: [{ id, sab }], places: { <name>: { entries: [[key, entry]] } },
              version, instance, links?: { known: [path], made: Int32Array, seen } }
vfs-update  { name, updateId, version, places: { <name>: { entries, removals,
              retired: [[key, retireId]] } }, newSegments: [{ id, sab }] }   main → worker
vfs-ack     { name: 'vfs-ack', updateId, retained?: [retireId] }              worker → main
vfs-release { name: 'vfs-release', retireIds: [retireId] }                    worker → main
vfs-mutate  { name, id, place, op, key, to?, options?, data? }                worker → main
            writeFiles: { name, id, place, op, keys, sizes, options, data }
vfs-mutated { name, id, error?: { code, message, syscall, path, dest },
              version? }                                                      main → worker
vfs-links   { name: 'vfs-links', add: [path], made: 0 | 1 }                   both ways
entry       shared { kind, segmentId, offset, length, stat, version, scriptOptions?, meta? }
            | disk { kind, path, stat, version, scriptOptions?, meta? }
stat        { size, mtimeMs } (+ sourceSize, encoding for compressed companions)
```

One `vfs-update` per watcher epoch or accepted virtual mutation. Source
and companions of one file go in the same message. Every shared version
an update replaces or removes is `retired` under a `retireId` that exists
only until it is freed. A worker ACKs each update; `retained` lists the
retired versions its streams or leases still read, and one `vfs-release`
follows when the last of them is done. Bytes are freed once every linked
worker has ACKed (or exited) and no thread holds them. An update's
`version` is the kernel's after it — a relocation keeps it — and each
entry carries the version of the commit that published it. A worker's
`writeFiles` is one `vfs-mutate`: its keys, the size of each file and
their bytes one after another in `data`; its answer carries the version
of the commit. Under strict with `links: 'deny'` a snapshot carries the
links the main kernel knows and a counter in shared memory (`made`) of
the links threads made through the patch, with how many of them the
index holds (`seen`); `vfs-links` hands on the links a thread learned —
`made: 1` for one it made, which it counted — and main passes a worker's
on to the others ([Links on a place's disk](#links-on-a-places-disk-links)).

## Examples

Runnable demos under [examples/](examples/):

- [hot-reload-routes/](examples/hot-reload-routes/) — HTTP server whose
  route handlers are written into a `map + virtual` place and `require()`d.
- [sea-static/](examples/sea-static/) — same static server as `sab` or
  Node SEA (`provider: 'sea'`).
- [multi-tenant/](examples/multi-tenant/) — two `map + virtual` places +
  `strict: true`.
- [worker-static/](examples/worker-static/) — static HTTP served by
  several worker threads from one SAB copy: Range streams, pre-compressed
  representations, live reload.
- [prepared-scripts/](examples/prepared-scripts/) — `prepare` +
  `fs.script`: handlers prepared once, run in a worker with V8 cached
  data, updated from the worker through `sab + virtual`.
- [etag/](examples/etag/) — `prepare` computes a per-file ETag in `meta`,
  the same in every worker; a framework-free `node:http` server answers
  `If-None-Match` with 304 / 200, live-updated over `sab + virtual`.
- [ssr/](examples/ssr/) — a template compiler in `prepare`,
  `fs.script.compile` cached data, `vm.Script` in workers; a live
  template update reaches already-running workers.
- [async-worker/](examples/async-worker/) — a worker's heavy async
  transformation publishes several related files as one atomic
  `writeFiles`; other workers learn of it only through
  `kernel.on('publish')`, never a partial set.

Further reading: [doc/integration.md](doc/integration.md) (integration
notes and recipes), [doc/architecture.md](doc/architecture.md) (design
decisions and their reasons), [doc/alternatives.md](doc/alternatives.md)
(`node:vfs` and other alternatives).

## Streaming and HTTP Range

```js
const stream = place.createReadStream('/video.mp4', { start, end });
res.writeHead(206, {
  'Content-Range': `bytes ${start}-${end}/${stat.size}`,
  'Content-Length': end - start + 1,
  'Accept-Ranges': 'bytes',
});
try {
  await pipeline(stream, res);
} finally {
  stream.release();
}
```

With `zeroCopy`, each chunk is a borrowed view held until `release()`.
Without it, chunks are copies and the stream releases itself.
`createReadStreamCompressed` ranges address compressed bytes. See
[Lifetime of shared bytes](#lifetime-of-shared-bytes).

## Architecture

```
Main thread                             Worker threads
┌──────────────────────────┐            ┌─────────────────────────┐
│ VfsKernel                │  link()    │ attach()                │
│ ├─ VfsConfig (frozen)    │ ─────────► │ ├─ projected Maps       │
│ ├─ FilesystemCache       │  vfs + SAB │ ├─ per-thread map       │
│ │  └─ Pool+Registry      │            │ └─ Pins (streams/views) │
│ ├─ PlaceRegistry/FsRouter│  vfs-update│                         │
│ ├─ scanner + DirWatcher  │ ─────────► │                         │
│ └─ retirement: ACK +     │ ◄───────── │ vfs-ack (+ retained)    │
│    release before free   │ ◄───────── │ vfs-release             │
└──────────────────────────┘            └─────────────────────────┘
         SAB segments  ←  shared physical memory  →  zero-copy views
```

Companions are internal keys `<source>\0require:bytecode`,
`<source>\0script:bytecode` and `<source>\0fs:<enc>`. They never appear
in `readdir` / `exists` / patched `fs`.

## Tests

```
npm test              # node --test --test-timeout=60000 "test/*.test.js"
npm run test:types    # tsc --noEmit over test-types/
npm run lint          # eslint + prettier
npm run bench         # hot-path benchmarks (not part of npm test or CI)
```

Run the complete test suite with `npm test`. The suite covers
configuration, cache allocation, scanner, places, routing, module hooks,
compression, SEA, watcher, bootstrap, workers and strict routing
behavior. The tests of symbolic links to files are skipped where none can
be made (Windows without the privilege); a link to a directory is a
junction there. On Windows the spellings of `appRoot` are tested on the
real disk where Windows makes them — 8.3 names where the volume generates
them, subst drives, a drive mapped to the admin share — made and removed
by the tests themselves; where Windows makes none, the test says why it
skips.

`npm run test:types` type-checks the declarations (`index.d.ts`,
`lib/**/*.d.ts`) with `tsc --noEmit` under `strict` against
`test-types/`: the usage of this README as positive cases, the exact
type of what every call returns (`expectType`), and `@ts-expect-error`
where a wrong configuration or call must not compile. That checks the
declarations against their intended use, not against the code;
`test/exports.test.js`, part of `npm test`, checks that every value they
export exists at runtime — for `require()` and for `import` — and that
every declaration file is packed. ESLint does not parse TypeScript
(`.eslintignore`); prettier formats these files like the rest.

`npm run bench [-- --only read,patch]` measures the hot paths — reads by
size, leases (`views`), streams by size and `highWaterMark`, the patched
`node:fs`, routing, publication, preparer results, update → ACK → free,
updates under active leases (`retain`), the memory lifecycle of shared
bytes, watcher epochs, compaction, `require`, `initialize()` and worker
pools against `node:fs` and a per-worker Buffer cache (`pool`) — each
scenario in its own process, and writes JSON to `.work/bench/`;
`node bench/compare.js base.json new.json [--noise base2.json]` compares
two runs. Results and method: [doc/benchmarks.md](doc/benchmarks.md).

`npm run bench:ab -- <base> <new> [--only read,patch] [--pairs 4]`
compares two revisions: both are exported with `git archive` into sibling
directories of one temporary directory (where the code lies changes its
timings) with the same dependencies, run alternately `pairs` times (the
order flipping between pairs), and summarized per metric as the medians
of both sides, the change and the change in every pair — a table on the
console, `summary.md` and `summary.json` with every run's JSON under
`.work/bench/ab/`. A change is significant (`+` / `−`) only when it
exceeds max(5 %, 2 × the spread of the base runs) in every pair; `~`
marks one every pair shows in the same direction below that. A run over
`--timeout` seconds (900) is killed; a failed run or scenario makes the
exit code 1. `worktree` names the uncommitted working tree;
`--bench <rev>` runs that revision's `bench/` against both, so new
scenarios can measure an old base; `--report <dir>` prints a saved
summary again (`--md`, `--filter`).

## Support

CI (`.github/workflows/ci.yml`) runs on pushes to `main` and on pull
requests to `main`: `npm ci`, `npm test`, `npm run test:examples`,
`npm run lint` and `npm run test:types`, on each combination below:

|         | Node 22.22.3 | Node 22.x | Node 24.12.0 | Node 24.x | Node 26.x |
| ------- | ------------ | --------- | ------------ | --------- | --------- |
| Linux   | ✓            | ✓         | ✓            | ✓         | ✓         |
| Windows | ✓            | ✓         | ✓            | ✓         | ✓         |

Engines: `>=22.22.3 <23 || >=24.12.0 <25 || >=26`. Node 22 is supported
from 22.22.3; Node 24 from 24.12.0. Early Node 24 bypasses
`registerHooks` for nested `require()` from CJS executed by the ESM
translator. The limitation is the same on Linux and Windows. ESM and
disk-backed CommonJS could work on earlier 24.x, but those releases are
outside the library's supported matrix. macOS is expected to work (same
`fs.watch` capabilities as Linux and Windows) but is not in the matrix.

The watcher needs `fs.watch`: recursive where Node implements it
natively (Windows, macOS), elsewhere one watch per directory — Node builds
its recursive form there over the public `node:fs`, which the patch
routes. On IBM i, where `fs.watch` is unavailable, the live-reload
features do not work; on AIX they need AHAFS; everything else does.

On Windows the watcher resolves a place root through
`fs.realpathSync.native` when the path contains an 8.3 alias segment
(`C:\Users\RUNNER~1\...`). Node 24.16.0 through at least 24.20.0 abort
the process otherwise ([nodejs/node#63638][63638], fixed upstream in
libuv and being backported). Watch events keep the path form the place
was configured with, so this is invisible to place keys.

[63638]: https://github.com/nodejs/node/issues/63638

`npm ci` needs no git or SSH access: dependencies resolve over HTTPS
with lockfile integrity hashes.

## License

MIT
