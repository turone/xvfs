# Integration Guide

In-depth notes that complement the [README](../README.md): worker protocol,
hooks model, recipes, and design rationale.

## Architecture in one screen

```
Main thread                                Worker threads
┌──────────────────────────────────┐       ┌──────────────────────────────┐
│ VfsKernel (full)                 │       │ attach() / fromSnapshot()    │
│ ├─ VfsConfig (frozen)            │       │ ├─ same VfsConfig from raw   │
│ ├─ a node tree per place         │       │ ├─ replicas of the trees     │
│ ├─ FilesystemCache: pool of SABs │       │ ├─ per-thread map places     │
│ ├─ PlaceRegistry + FsRouter      │       │ └─ Pins: streams and leases  │
│ ├─ scanner                       │       └──────────────────────────────┘
│ ├─ DirWatcher (FIFO epochs)      │  link() → workerData.vfs
│ └─ acks + retired (retireId)     │  vfs-snapshot ─────────► (first)
└──────────────────────────────────┘  vfs-update  ──────────►
                                      vfs-ack     ◄────────── (+ retained)
                                      vfs-release ◄──────────
SAB segments ─────────── shared physical memory ─────────── zero-copy views
```

Invariants:

- Every thread holds each place as a tree of nodes. The main kernel's
  takes the commits; a worker's replica applies each commit's delta with
  the very code the main tree applied it with, so the two cannot drift
  apart. A directory is a node, a rename moves a node and copies
  nothing, and `stat().ino` is the node's id — in every thread, for a
  shared place; a `map` place's tree is each thread's own.
- Workers never write SAB directly; a `sab + virtual` write from a worker
  goes through the mutation RPC and is applied by the main kernel.
- A virtual place keeps a filesystem's hierarchy: a write into a
  directory that does not exist is `ENOENT`, a key under a file
  `ENOTDIR`, a file where a directory is `EISDIR` — whatever the mutation,
  and also when mutations overlap. A path ending in a separator names a
  directory, as on POSIX, on every platform: a file the VFS serves or
  stores, named so, is `ENOTDIR`.
- One publication pipeline for every source of content: raw input → the
  preparer of its extension (once) → canonical content → bytecode and
  compressed representations → one commit. Allocations stay private until
  the commit, so snapshots and compaction only ever see published files,
  and a failed attempt only frees its own bytes.
- Watcher epochs (and their rechecks) run strictly one at a time, in
  arrival order: an older epoch never publishes over a newer one.
- ACK-before-free, per version: a shared version an update replaces or
  removes is retired under a temporary `retireId` and freed only when
  every linked worker has ACKed the update (or exited) **and** no stream or
  lease in any thread still reads it. Nothing is freed on a timeout.
- Empty segments are recycled, never returned to the OS. Compaction
  _closes_ a segment until its retired bytes are gone and never moves a
  retired extent.
- Config is deep-frozen at construction. Workers rebuild from `config.raw`.
- Place name **is** the directory under `appRoot`, the mount and the
  snapshot/delta key.
- Preparation and `require.compile` / `fs.script.compile` of shared places
  are main-thread-only; there is no ESM bytecode. A worker prepares only
  writes to its own `map` places, with `attach({ preparers })`.

## Provider matrix

|                       | `sab` + `disk`                       | `sab` + `virtual`             | `map` + `disk`       | `map` + `virtual`    | `sea`             | `node-default` | `disk`                  |
| --------------------- | ------------------------------------ | ----------------------------- | -------------------- | -------------------- | ----------------- | -------------- | ----------------------- |
| Source                | scanned dir                          | application writes            | scanned dir          | application writes   | `node:sea` assets | OS fs          | OS path entries         |
| Storage               | SAB pool                             | SAB pool                      | per-thread buffers   | per-thread buffers   | SAB pool          | OS fs          | OS fs                   |
| Writable              | disk + watch                         | main or worker RPC            | disk + watch         | local tree, sync     | no                | passthrough    | `fs.writable`           |
| Shared across workers | yes                                  | yes                           | no                   | no                   | yes               | n/a            | metadata only           |
| In `snapshot()`       | yes                                  | yes (empty until first write) | no (recreated empty) | no (recreated empty) | yes               | n/a            | no                      |
| Watched               | yes                                  | no                            | yes                  | no                   | no                | n/a            | no                      |
| Bytecode              | `kernel.bytecode` / `PlaceFs.script` | same, on publish              | auto on write        | auto on write        | `kernel.bytecode` | n/a            | no (`require.ext` only) |

Disk-origin writable places (`sab + disk`, `map + disk`) are **eventual
consistency**: mutations go to disk — copies and renames through the
patched `fs` included — and the watcher brings them into the place's tree (no
`waitForUpdate`). A `sab + virtual` mutation, a copy into the place
included, resolves its Promise only once the new version is already
published — no watcher involved.

Disk-origin places also decide what happens to a path they do not serve,
with `fs.fallback` (resolved explicitly: `'deny'` under strict, `'disk'`
otherwise). A **partial disk cache** keeps the extensions it serves hot in
SAB and leaves the rest on disk:

```js
places: {
  public: {
    fs: { ext: ['html', 'css', 'js'], fallback: 'disk' }, // media from disk
  },
}
```

Under strict, `public/logo.png` is then read from disk while
`public/app.js` is served only from the VFS (a `.js` file on disk that is
not published stays `EACCES`); listings merge both and show a `.js` file
only once it is published. The fallback never reaches another place or an
unmanaged sibling, `fs.writable` stays its own policy, and `require` /
`import` never fall back.

## Worker message protocol

Main → worker (`link()` port): first the snapshot, `{ name:
'vfs-snapshot', snapshot }` — every shared place's tree as committed,
the segments, `version` and `instance`; `attach()` takes it before
anything else and keeps nothing of it but the replicas — then one
update per commit:

```js
{
  name: 'vfs-update',
  updateId: 7,
  version: 9, // the kernel's version after this update; a compaction keeps it
  places: {
    static: {
      // The commit's steps on the tree's nodes, by id, as columns: the
      // payloads they bring and, in `retired`, every representation the
      // update replaces or removes, with its retireId (lib/tree.js).
      delta: { mark, from, version, now, op, id, parent, name, …, retired },
      // The keys of its 'publish' event.
      created: [], replaced: ['/index.html'], removed: ['/old.html'],
      moved: [['/a.html', '/b.html']],
    },
  },
  newSegments: [{ id: 3, sab: SharedArrayBuffer }],
}
```

Worker → main:

```js
{ name: 'vfs-ack', updateId: 7, retained: [41] } // a stream still reads it
{ name: 'vfs-release', retireIds: [41] }         // its last consumer is done
```

`attach()` is the only worker transport (`link()` on the main side). The
worker kernel applies each `vfs-update` synchronously and ACKs **those —
and only those** — messages. Before its tree changes, every
representation the delta retires goes to its pins: one a stream or lease
still reads is bound to its `retireId` and reported in `retained`, in the
same ACK — so it is held before the ACK can free anything. When the last local
consumer of that version is done, one `vfs-release` follows. Pinning a
current version is local bookkeeping: no IPC per chunk, per stream or for
a version that is never retired while in use. A worker that exits drops
all its ACKs and holds. A delta a worker cannot apply breaks its view: it
ACKs nothing more, and its port closes once it holds no lease or borrowed
chunk — or with the worker, which the rethrown error ends by default
([README → `VfsKernel` (worker)](../README.md#vfskernel-worker)).

Worker → main, for a mutation of a `sab + virtual` place
(`lib/mutation-rpc.js`):

```js
{ name: 'vfs-mutate', id: 3, place: 'scratch', op: 'write', key: '/note.txt',
  data: Uint8Array, options: { exclusive: false } }
// writeFiles: { …, op: 'writeFiles', keys, sizes, options, data } — every
// file's bytes one after another in `data`, `sizes[i]` of them for `keys[i]`
```

Main → worker, once that mutation is decided:

```js
{ name: 'vfs-mutated', id: 3, version: 12 }             // published
{ name: 'vfs-mutated', id: 3, error: { code: 'EROFS', … } } // refused
```

The response arrives once the new version is already published — the same
`vfs-update` reaches every linked worker, this one included — never
before it, and never after every worker has ACKed: ACKs only govern when
replaced bytes are freed. `writeFiles` is one such request: `version` is
that of the single commit that published every file of the set, or the
response carries `error` and nothing is published.

Main → worker, under strict with a place of `links: 'deny'` — a link the
main kernel's watcher found, for the worker's index:

```js
{ name: 'vfs-links', add: ['/app/media/j'], generation: 4 }
```

A worker's snapshot carries the index as main knows it and its
`generation` (how many links it has come to know); a worker applies a
`vfs-links` newer than what it holds, and nothing flows back — the patch
makes, removes and moves no link on a place's disk under strict, and the
index only grows ([README → Links on a place's disk](../README.md#links-on-a-places-disk-links)).

There is no `file-update` / `file-delete`. One `vfs-update` per commit.
A file's source and representations are published together, in its
payload; one that fails to rebuild — `require.compile` is best-effort —
is missing from the payload the delta brings.
`kernel.retirements()` lists what is still held — representation, bytes,
age, and whether it waits for ACKs or for consumers — for debugging.

### Streams and views

A `PlaceFs` stream or view lease pins the version it started with; see
[README → Lifetime of shared bytes](../README.md#lifetime-of-shared-bytes).
Prefer `pipeline(stream, destination)`: it destroys the source when the
destination fails. After a manual `stream.pipe(res)`, destroy the source
yourself when `res` closes or aborts — a paused, abandoned source keeps
its version pinned. Zero-copy chunks may outlive the stream in a socket's
write queue, so a zero-copy stream is released only by `release()`:

```js
const stream = files.createReadStream(key, { start, end });
try {
  await pipeline(stream, res);
} finally {
  stream.release();
}
```

## Hooks

Two layers, `defaults.hooks.{fs,module}`:

| Layer    | Mechanism                                                                  | Notes                                                                                                                                        |
| -------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `fs`     | table-driven `node:fs` patch (sync/callback/promises)                      | Executes `FsRouter` decisions: implemented, recognized but unsupported, passthrough (README).                                                |
| `module` | `module.registerHooks({ resolve, load })` + `_compile`, `_resolveFilename` | One chain for `require()` and `import`. Domain = `context.conditions.includes('require')`; `require.resolve()` names what `require()` loads. |

Manual install (when not using `--import xvfs/register`):

```js
const fsPatch = require('xvfs/adapters/fs-patch');
const moduleHook = require('xvfs/adapters/module-hook');
fsPatch.install(kernel);
moduleHook.install(kernel);
```

Workers: `attach()` installs whatever the config asks for. Preloads do
not run in worker threads.

## Recipes

### V8 bytecode for a hot module path

```js
places: {
  domain: {
    fs: { ext: ['js'] },
    require: { compile: ['js'] },
  },
}
```

`initialize()` compiles every source of an extension of `require.compile`
(here `.js`) once, stores the bytecode as the file's `require:bytecode`
representation in the same SAB segments, and hands both source and
bytecode to workers in the snapshot. Workers
`require('/abs/domain/x.js')` and the patched
`_compile` calls `new vm.Script(wrapped, { cachedData })`. V8 skips
parse + compile for all functions, including lazy ones. There is no ESM
bytecode cache.

When the watcher detects a source change, it recompiles bytecode in the
same epoch and publishes both in one `vfs-update`.

### Cached data in your own `vm.Script`

XVFS cached data serves only a consumer that creates a `vm.Script` from
the identical source with compatible `scriptOptions`. For code that runs
sources itself, that is the `fs.script` bundle, as it is:

```js
const bundle = files.script(key);
const script = new vm.Script(bundle.source, {
  ...bundle.scriptOptions,
  cachedData: bundle.cachedData ?? undefined,
});
```

- **What V8 refuses.** A changed source, a wrapper added around it, or
  compile parameters that differ where V8 looks — its version and flags
  — can make it reject the cached data:
  `script.cachedDataRejected === true`. V8 does not compare the text
  itself, only the source's length, so cached data of another text may
  also be taken and run the wrong code: never pass it with any source but
  the bundle's, nor under a compiler that wraps the source its own way.
- **On rejection** the consumer runs the canonical source without cached
  data: the `vm.Script` has compiled `bundle.source` itself — run it as
  usual. The refusal is that V8 isolate's alone; it changes no file, no
  representation and no published version of XVFS, and nothing is published
  again.
- **CommonJS keeps its own.** An ordinary `require()` uses the cached
  data `require.compile` builds for `Module.wrap(canonicalSource)` under
  the module's filename — the `require:bytecode` representation the module
  hook applies, falling back to Node's compiler once on rejection. It
  and the bare cached data of `fs.script.compile` are cached data of
  different texts: never mix them, nor hand `kernel.bytecode()` to a
  `vm.Script` of the bare source.

Prove `cachedDataRejected === false` in a worker, not in the compiling
thread: V8's per-isolate cache masks rejection there.

### AI agent / plugin workspace

Pattern: one writable `map + virtual` place per agent (or per session),
strict mode on, optional `sab` place for read-only tooling. The trusted
entry and `package.json` live **outside `appRoot`**.

```js
const config = new VfsConfig({
  defaults: { strict: true },
  places: {
    tools: {
      fs: { ext: ['js'] },
      require: { compile: ['js'] },
    },
    workspace: {
      provider: 'map',
      origin: 'virtual',
      fs: { writable: true },
    },
  },
});

const ws = kernel.fs('workspace');
ws.writeFile('/notes.md', '# scratch');
fs.writeFileSync(path.join(appRoot, 'workspace', 'code.js'), 'console.log(1)');
fs.readFileSync('/etc/passwd'); // ordinary Node (outside appRoot)
fs.readFileSync(path.join(appRoot, 'elsewhere', 'file')); // EACCES
```

`map` places are per-thread, so concurrent agents in different workers
cannot see each other's scratch state. Same-process places are **not**
firewalled from each other, and strict mode is a routing policy for code
that goes through `node:fs` and the module hooks — not a security
boundary for untrusted code: worker threads share one process and do not
replace OS-level isolation.

### Static server with pre-compressed assets

```js
const config = new VfsConfig({
  places: {
    public: {
      fs: {
        compress: {
          encodings: ['br', 'gzip'],
          options: { br: { level: 11 }, gzip: { level: 9 } },
          ext: 'compressible',
        },
      },
    },
  },
});
```

Every worker then answers from the same SAB bytes:

```js
const place = kernel.fs('public');

const pick = (key, accept) => {
  const stored = place.storedEncodings(key); // ['raw', 'br', 'gzip']
  for (const encoding of ['br', 'gzip']) {
    if (accept.includes(encoding) && stored.includes(encoding)) {
      return encoding;
    }
  }
  return 'raw';
};

const serve = (req, res, key) => {
  const accept = req.headers['accept-encoding'] || '';
  const encoding = pick(key, accept);
  if (encoding === 'raw') {
    const body = place.readFile(key);
    res.writeHead(200, { 'Content-Length': body.length });
    return void res.end(body);
  }
  const body = place.readFileCompressed(key, encoding);
  res.writeHead(200, {
    'Content-Encoding': encoding,
    'Content-Length': body.length,
    Vary: 'Accept-Encoding',
  });
  res.end(body);
};
```

Parsing `Accept-Encoding` is the server's job. With `retainRaw: false`
the `'raw'` branch still works: the source is not in SAB, so `readFile()`
and `createReadStream()` read it from disk themselves (`readFileView()`
returns `null`).

### Single-Executable Application bundling

```js
// Build with sea-config.json:
//   "assets": { "pub/index.html": "./dist/index.html",
//               "pub/app.js":     "./dist/app.js" }

const config = new VfsConfig({
  places: {
    pub: { provider: 'sea', fs: true },
  },
});
```

At runtime the kernel copies each matching `node:sea` asset into SAB
once; workers get it in the snapshot. Outside an SEA build the
provider stays empty and logs a warning — the same code runs unmodified
during development. See [examples/sea-static/](../examples/sea-static/).

### Generated code with hot reload (no disk)

```js
places: {
  gen: {
    provider: 'map',
    origin: 'virtual',
    fs: { writable: true },
    require: true,
  },
}

const gen = kernel.fs('gen');
gen.writeFile('/route.js', generateRouteHandler(spec));
const handler = require(path.join(appRoot, 'gen', 'route.js'));

gen.writeFile('/route.js', generateRouteHandler(newSpec));
delete require.cache[path.join(appRoot, 'gen', 'route.js')];
const next = require(path.join(appRoot, 'gen', 'route.js'));
```

### Preparing sources

A preparer is declared inside a domain — `fs`, `require` or `import` —
next to its `ext`, and registered as a function in the kernel option
`preparers` (functions never enter the cloneable config). The declaring
domain only owns the configuration; the result is the file's one
canonical content, which every domain serves. The library ships the
mechanism only — no Babel, CSS, HTML, SVG or image preparers.

**API sources** — one preparer for the domain's extensions, plus script
bundles compiled from the prepared source:

```js
fs: {
  prepare: 'api',
  script: { compile: ['js'] },
}
```

**Several content types** — explicit routing by extension:

```js
fs: {
  ext: ['js', 'css', 'html', 'svg'],
  prepare: { api: ['js'], styles: ['css'], markup: ['html', 'svg'] },
}
```

**Overlapping domains** — `.js` goes through `api` once; that one prepared
source is what `fs` reads, `fs.script.compile` turns into
`script:bytecode` (bare source, the preparer's `scriptOptions`) and
`require.compile` turns into `require:bytecode` (`Module.wrap(source)`).
Declaring `prepare` for `js` in `require` too would be a config error,
even with the same name:

```js
fs: {
  ext: ['css'],
  prepare: { api: ['js'], styles: ['css'] },
  script: { compile: ['js'] },
},
require: { compile: ['js'] },
```

```js
const kernel = new VfsKernel(config, {
  appRoot,
  preparers: {
    api: (raw, file) => ({
      source: `(${raw.toString().trim()})`,
      scriptOptions: { filename: file.path },
    }),
    styles: (raw) => minifyCss(raw.toString()),
    markup: (raw) => minifyMarkup(raw.toString()),
  },
});

const bundle = kernel.fs('application').script('/handler.js');
const script = new vm.Script(bundle.source, {
  ...bundle.scriptOptions,
  cachedData: bundle.cachedData ?? undefined,
});
const handler = script.runInThisContext();
```

- The short form covers the domain's effective, finite `ext` — in `fs`
  what `fs.ext`, `fs.script.ext` and `fs.script.compile` list; an `fs`
  that lists none must use the object form. The object form must stay
  inside a finite domain `ext`. Neither adds extensions to a domain.
- Key, path, extension and type of the file do not change. The raw disk
  file stays the source of truth; the raw input is not kept next to the
  prepared content in SAB.
- Preparers are synchronous and run once per publication attempt — scan,
  watcher, SEA, virtual writes from any thread, `map` writes — never on
  read. A preparer error or a failing `fs.script.compile` publishes
  nothing; a failing `require.compile` only drops its own representation.
- In a **virtual** place `appendFile`, `rename` and copies of a prepared
  key are `ENOTSUP`: its raw input is not kept. Renaming or copying an
  unprepared entry onto an extension with a preparer publishes it through
  that preparer, once. A directory moves as one node only when no file
  under it is prepared, has `require.compile` cached data or holds
  path-dependent `scriptOptions` / `meta`: files, compressed
  representations and `fs.script` cached data keep their bytes, ids,
  versions and times, in one publication, and nothing is copied. In a
  disk-origin place mutations edit the raw file and the watcher
  re-prepares it; a copy or a rename hands on the raw file, never the
  prepared content.
- `readFile` gives the prepared content; passing it to `writeFile`
  elsewhere is a new publication the destination may prepare again, not a
  raw-preserving copy — `copyFile` hands on the raw input.

### Testing with virtual fixtures

```js
const fs = require('node:fs');
const fsPatch = require('xvfs/adapters/fs-patch');

beforeEach(async () => {
  kernel = new VfsKernel(testConfig, { appRoot: '/test' });
  await kernel.initialize();
  fsPatch.install(kernel);
  kernel.fs('fixtures').writeFile('/data.json', '{"a":1}');
});

afterEach(() => {
  fsPatch.uninstall();
  kernel.close();
});

it('reads via patched fs', () => {
  const data = JSON.parse(fs.readFileSync('/test/fixtures/data.json'));
  assert.equal(data.a, 1);
});
```

Never leave hooks installed on the test runner: uninstall in `after`.

## CLI overrides

```
node --import xvfs/register app.js -- \
  --vfs.defaults.memory.limit=512mib \
  --vfs.defaults.strict=true \
  --vfs.defaults.hooks.fs=false \
  --vfs.places.tools.require.compile=js,cjs \
  --vfs.enable=tools,workspace \
  --vfs.disable=static
```

`VfsConfig.fromArgv(process.argv, appConfig)` applies the same flags
when you construct the kernel yourself. A setting that takes a list
takes a comma-separated one, one item included, and replaces the list of
the config file; `true` / `false` are booleans and a decimal a number,
and the result is validated as a JS or JSON config is. The flags can say
a whole config — README, [CLI overrides](../README.md#cli-overrides) —
but a config of many places reads better as `vfs.config.json`. A place
whose name holds a dot can be overridden on the CLI only when the config
file declares it; flags alone cannot create one.

## Alternatives and decisions

[alternatives.md](alternatives.md) compares the library with `node:vfs`
(the virtual file system in Node.js core), `@platformatic/vfs`, `memfs` and
plain `node:fs`. [architecture.md](architecture.md) records the design
decisions and their reasons.

## Design notes

**Why SAB.** A single physical copy of cached files, read zero-copy by
N workers. With 100 MiB of cached files and 8 workers, that's
~800 MiB saved versus per-worker copies.

**Why pooled segments.** One SAB per file would exhaust mmap regions
quickly. A best-fit allocator over 64 MiB segments amortizes the cost;
free extents are recycled and empty segments stay around to be reused,
never returned to the OS.

**Why a tree of nodes.** A directory is a node, so a listing reads its
children and an empty directory exists; a rename re-links one node — a
file or a whole directory — copying no byte and retiring nothing; a
node's id is its `ino` in every thread of a shared place. The main tree
and the replicas apply the same delta with the same code. Details:
[architecture.md](architecture.md).

**Why representations.** A file's node holds one payload: its source and
what is made of it — `require:bytecode`, `script:bytecode`,
`fs:<encoding>` — each a contiguous region of the pool, pinned, retired
and freed on its own, and the allocator stays simple. They are never
keys: nothing lists, routes or moves them apart from their file.

**Why main-thread-only compilation.** N workers compiling the same source
is N× wasted CPU. The main thread compiles once during `initialize()`,
stores bytecode in SAB, and workers consume it via `cachedData`. Workers
stay read-only with respect to SAB. ESM has no bytecode cache.

**Why per-thread map places.** Concurrent agents in different workers
must not see each other's scratch state. `map` places are deliberately
not shared — `fromSnapshot()` / `attach()` instantiates each one empty.
Cross-worker writable state (`sab + virtual`) goes through the main
kernel instead, with ACK-before-free and per-key ordering — the right
trade for shared state, not for a fast per-thread scratch space.

**Why strict mode at the router.** `FsRouter` is the chokepoint that sees
every routed path; gating there is cheap and uniform across sync,
callback, promises, and the guarded APIs, and a check in application
code would be bypassed by `require('node:fs')`. It stays a routing
policy: containment is lexical (only a real `..` component leaves
`appRoot`), symlinks are not resolved, and code that reaches the OS by
other means is not contained.

## Integration checklist

- [ ] Build `VfsConfig` matching your directory layout (place name =
      folder = mount).
- [ ] Main: `new VfsKernel(config, { appRoot })` (or
      `--import xvfs/register`).
- [ ] Main: `await kernel.initialize()` _before_ spawning workers.
- [ ] Main: `const { vfs, transferList } = kernel.link()`.
- [ ] Worker: `new Worker(file, { workerData: { vfs }, transferList })`.
- [ ] Worker: `attach()` first thing (preloads do not run in workers).
- [ ] Main: `kernel.close()` on shutdown.
- [ ] Optional: `defaults.strict` — entry + `package.json` outside
      `appRoot`.
- [ ] Optional: `require.compile` — the extensions that get CJS bytecode;
      nothing is compiled unless it is listed.
- [ ] Optional: `fs.compress` for pre-compressed SAB representations.
