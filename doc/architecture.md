# Architecture and decisions

How xvfs is built and **why**. Each section states the
decisions in force together with the reasons behind them; [Rejected
designs](#rejected-designs) lists what was considered and turned down, so it
is not reintroduced without new evidence. Keep this file aligned with the
code: a change that alters a decision updates it in the same commit.

Contents: [Purpose](#purpose) · [Module map](#module-map) ·
[Places and configuration](#places-and-configuration) ·
[Rules of subtrees](#rules-of-subtrees) ·
[Storage](#storage) · [Node trees](#node-trees) ·
[Publication](#publication) ·
[Lifetime of shared bytes](#lifetime-of-shared-bytes) ·
[Preparation](#preparation) ·
[Virtual places and worker mutations](#virtual-places-and-worker-mutations) ·
[Trees of client ids](#trees-of-client-ids) ·
[Routing and strict mode](#routing-and-strict-mode) ·
[Patched `node:fs`](#patched-nodefs) ·
[Hooks and bootstrap](#hooks-and-bootstrap) ·
[Rejected designs](#rejected-designs) · [Invariants](#invariants) ·
[Protocol](#protocol) · [Testing](#testing)

## Purpose

A managed file layer for a Node.js process: places over the
application's real paths, each with a storage model — memory every
`worker_threads` thread shares (`sab`), each thread's own memory (`map`),
the assets of a single executable (`sea`), or the disk under the place's
policy (`disk`, `node-default`) — and a content origin — the disk,
scanned and watched, or what the application writes (`virtual`). The
content the places hold goes through one publication pipeline — prepared
once, compiled and compressed once, committed atomically, with a version
where it is shared — and every place through one set of routing rules,
through the patched `node:fs`, the module hooks and `PlaceFs` alike.

Shared memory is where most of the machinery lies: Node.js servers that
run several `worker_threads` over the same files — static assets,
templates, handler sources, modules. Files are loaded once on the main
thread into pooled `SharedArrayBuffer` segments; every thread reads
zero-copy views of the same bytes. Live changes are published to all
threads atomically; V8 cached data and compressed representations are
built once and shared the same way. The same places serve what one thread
keeps to itself — an agent's or a session's workspace (`map` +
`virtual`), code generated at run time — through the same pipeline, hooks
and routing. Beside the places, trees of client ids hold an application's
own structure — the pages of a site, a catalogue — and their bytes in the
same pool, written by the batches of a source and read in every thread.

It is deliberately **not** a general-purpose virtual filesystem (see
[alternatives.md](alternatives.md) for `node:vfs`), not a sandbox for
untrusted code and not a persistence layer.

Engines: `>=22.22.3 <23 || >=24.12.0 <25 || >=26` — the floor of
`module.registerHooks` with CommonJS `--import` bootstrap of memory-only
modules. Early Node 24 bypasses `registerHooks` for nested `require()` from
CommonJS executed by the ESM translator.

```
Main thread                                  Worker threads
┌───────────────────────────────────┐        ┌──────────────────────────────┐
│ VfsKernel                         │ link() │ attach() → VfsKernel         │
│ ├─ VfsConfig (frozen)             │ ─────► │ ├─ replicas of the trees     │
│ ├─ a node tree per place          │snapshot│ ├─ per-thread map places     │
│ ├─ FilesystemCache (SAB pool)     │        │ └─ Pins: streams and leases  │
│ ├─ SAB sink → #stage → #flush     │ update │                              │
│ ├─ WatchPipeline: watcher → FIFO  │ ─────► │                              │
│ ├─ Retirement: acks + retired     │ ◄───── │ vfs-ack (+ retained)         │
│ └─ Pins (main-thread consumers)   │ ◄───── │ vfs-release / vfs-mutate     │
└───────────────────────────────────┘        └──────────────────────────────┘
SAB segments ──────────── one physical copy ──────────── views in every thread
```

## Module map

| Module                          | Role                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/config.js`                 | `VfsConfig`: raw → deep-frozen `{ global, places, trees }`; domains, `prepare` index, `fs.fallback` normalization; the trees of client ids                                                                                                                                                                                           |
| `lib/cache.js`                  | `Pool` + `SegmentRegistry` + `FilesystemCache`: the SAB allocator only — `allocate()` places bytes privately, `committed()` / `free()` settle them, `compactTarget()` / `relocate()` plan and copy a compaction; it knows extents, never keys                                                                                        |
| `lib/tree.js`                   | The node tree of a place: `createTree()`, `fromSnapshot()`; `commit()` on the main tree, `apply()` of its deltas on a replica; lookups, walks, `snapshot()`                                                                                                                                                                          |
| `lib/tree-plan.js`              | A commit's plan: every check against the tree and an overlay of the commit, then the log of steps that is its delta                                                                                                                                                                                                                  |
| `lib/tree-node.js`              | The objects a tree hands out — nodes, payloads, representations — and the numeric columns of its encodings                                                                                                                                                                                                                           |
| `lib/kernel.js`                 | `VfsKernel`: lifecycle, init, the trees of its places, virtual publications, epochs and their commit to the trees (`#flush`), the trees of client ids and the publications of their intakes, freeing retired representations, compaction by node id, mutation queue, `link()`, worker side and its broken view                       |
| `lib/epoch.js`                  | Epochs: what one publication gathers per place — the intents of a scan or a watcher epoch, the ops of a mutation or a compaction; `reconcile()` into the tree's ops, `eventsOf()` of what a commit changed in files                                                                                                                  |
| `lib/pipeline.js`               | What a file is: `Preparers`, `prepareInput()`, `bytecodeFor()`                                                                                                                                                                                                                                                                       |
| `lib/publication.js`            | `inputOf()`: a source's canonical input, for either sink; the stateless SAB sink, `sharedPublish()`: the payload input and the extents it hands the kernel to stage                                                                                                                                                                  |
| `lib/compressor.js`             | `Compressor`: codec work only                                                                                                                                                                                                                                                                                                        |
| `lib/pins.js`                   | `Pins`: per-thread direct consumers of shared representations, keyed by the `Representation` object; `break()` for a broken view                                                                                                                                                                                                     |
| `lib/retirement.js`             | `Retirement`: the books of ACK-before-free and the counter of retireIds — retired representations, the ACKs they wait for, their holders; decides what is free, frees nothing                                                                                                                                                        |
| `lib/serial-queue.js`           | `SerialQueue`: one task at a time, arrival order                                                                                                                                                                                                                                                                                     |
| `lib/pool.js`                   | `pool()`: a list worked through at most `limit` calls at a time, stopping at the first failure; `IO_LIMIT`                                                                                                                                                                                                                           |
| `lib/place.js`                  | `Place`: its tree (`tree`, `node()`, `file()`, `directory()`, `keyOf()`), its number (`dev`), the spellings of a caseless platform, its rules (`settingsAt()`, `visible()`, `writableAt()`, `rulesBelow()`, `makesParents()`), `cached()`, `scripted()`, `prepared()`, `preparerOf()`, `compressible()`; the kinds of representation |
| `lib/place-fs.js`               | `PlaceFs` facade, view leases, disk territory of `fs.fallback: 'disk'`                                                                                                                                                                                                                                                               |
| `lib/views.js`                  | `VfsReadStream` over one pinned representation, `rangeOf()`, the refusal of a closed kernel: what a facade over a tree hands out                                                                                                                                                                                                     |
| `lib/client-tree.js`            | `ClientTree`: a tree of client ids in every thread — lookups, nodes, payloads without their bytes, bytes as copies, leases and streams; `submit` and `load`                                                                                                                                                                          |
| `lib/intake.js`                 | `Intake`: the batches of a source for one tree of client ids, on the main thread — numbers, window, parts, gaps, refusals, loads, bytes placed before the commit; `checkBatch()` / `checkLoad()`, in every thread                                                                                                                    |
| `lib/registry.js`               | `PlaceRegistry` (path → place, key; `Containment` in `appRoot`) + `FsRouter` (read / mutate / copy / rename / link decisions)                                                                                                                                                                                                        |
| `lib/aliases.js`                | `Aliases` (strict): what the disk says, once each, about other spellings of `appRoot` — its real path, what a drive letter names                                                                                                                                                                                                     |
| `lib/links.js`                  | `LinkIndex` (strict, `links: 'deny'`): the links known below the places' directories; whether a path as given passes through one                                                                                                                                                                                                     |
| `lib/rules.js`                  | `PathTrie`: a trie of names whose attributes hold down a path — a place's rules (`PlaceRules`: the settings in force at a key, what the rules below a key restrict), the links strict knows (`LinkIndex`); `foldName()`, how a disk that takes a name in any case compares names                                                     |
| `lib/virtual-store.js`          | `VirtualStore`: the semantics of a virtual place's mutations, once — checks, their order, refusals, the ops they commit (`checkHierarchy`, `mkdirOps`, `movesAsIs`, `immovable`); `KeysInFlight`                                                                                                                                     |
| `lib/map-store.js`              | `MapStore` (a `VirtualStore`): mutations at once on the thread's own tree, the bytes in buffers of its own; the map sink of the pipeline                                                                                                                                                                                             |
| `lib/sab-store.js`              | `SabStore` (a `VirtualStore`): main-thread mutations of a `sab + virtual` place, each in its key's turn; keys in flight                                                                                                                                                                                                              |
| `lib/mutation-queue.js`         | `MutationQueue`: per-(place, key) ordering, exclusive place barrier                                                                                                                                                                                                                                                                  |
| `lib/mutation-rpc.js`           | `OPS` for both ends; `MutationClient` + `RemoteStore`: worker → main mutations, and the batches and loads of a tree (`sendTree`); `serveMutation()`: the main end, checking each request again                                                                                                                                       |
| `lib/scanner.js`                | `scan()`: directory walk, then stats `IO_LIMIT` at a time → `Map<key, FileInput>` in the order of the walk, and every directory (`dirs`); `linksOf()`: the links below a directory                                                                                                                                                   |
| `lib/watch-pipeline.js`         | `WatchPipeline`: watcher epochs into kernel epochs, one at a time (`SerialQueue`), their jobs `IO_LIMIT` at a time; rechecks                                                                                                                                                                                                         |
| `lib/watcher.js`                | `DirWatcher`: `fs.watch` over each place tree (recursive where native, else one per directory) → debounced epochs; `watchPath()`                                                                                                                                                                                                     |
| `lib/disk.js`                   | the disk past the patch: `node:fs` captured at load; the native section (`native()`, `inNative()`) for calls that re-enter it; own `fs` for streams                                                                                                                                                                                  |
| `lib/stats.js`, `lib/errors.js` | `VfsStats` (`ino`, `dev`, birthtime) / `VfsDirent`, a listing's result (`listing()`); node:fs-shaped errors, the broken view's (`brokenError()`)                                                                                                                                                                                     |
| `lib/adapters/fs-patch.js`      | table-driven `node:fs` patch executing router decisions: the operation cores and their variants, guards, glob, watch, the strict root's listing, install                                                                                                                                                                             |
| `lib/adapters/fs-copy.js`       | the copy engine of the patch: a copy's options, the source's raw input, the write through the destination — its store or the disk                                                                                                                                                                                                    |
| `lib/adapters/fs-surface.js`    | every export of `node:fs` and `node:fs/promises` the patch knows, and what it does with each: implemented, guarded, delegated, path-free                                                                                                                                                                                             |
| `lib/adapters/fs-dir.js`        | `VfsDir`: the `fs.Dir` of the patch's `opendir`, over a listing taken when the directory is opened, with the `node:fs` close semantics                                                                                                                                                                                               |
| `lib/adapters/module-hook.js`   | `module.registerHooks` resolve/load + `_compile` cached data + `_resolveFilename` (`require.resolve()`)                                                                                                                                                                                                                              |
| `lib/bootstrap/*`               | `register.mjs` (main thread, `--import`), `attach.js` (workers)                                                                                                                                                                                                                                                                      |

## Places and configuration

**A place is one directory under `appRoot`; its name is also the mount, the
cache namespace and the snapshot/delta key.** _Why:_ one identifier and no
mapping table; the router maps any path to its place with one lookup on the
first path segment; a place is enabled or disabled without rewriting paths.

**Provider (where bytes live) and origin (where content comes from) are
independent axes.** `sab` / `sea` keep bytes in the SAB pool, `map` in each
thread's own memory, `disk` / `node-default` are passthrough mounts; `sab` and
`map` read a directory (`origin: 'disk'`) or take application writes
(`origin: 'virtual'`). _Why:_ the four `sab`/`map` × `disk`/`virtual`
combinations cover a worker-shared cache, shared scratch state, a per-thread
cache and per-thread scratch space with one code path each.

**Domains `fs`, `require`, `import` each filter by extension; the scanner
reads the union once.** _Why:_ the patched `node:fs` and the module hooks see
the same files under different policies (a place may serve html to fs and
only js to require), and a file is read from disk once.

**Configuration is resolved and validated once, then deep-frozen;
`config.raw` is the structured-cloneable input workers rebuild from;
functions (preparers) never enter it.** _Why:_ workers receive the config by
structured clone and must resolve exactly the same places; a frozen config
cannot drift between threads; invalid combinations fail at construction,
before anything is read — e.g. `compress.retainRaw: false` on a virtual
place (no raw file to serve) or `prepare` on a passthrough provider. Every
resolved value is explicit (origin, `fs.fallback`), so a resolved config
describes itself.

**The CLI says what a config file says: `--vfs.<path>=<value>` builds the
same raw config, merged over the file's and validated as one. A setting
that takes a list takes a comma-separated one, by one table of the list
settings; its items stay strings, and `true` / `false` stay booleans
everywhere. A place name with dots is the longest one the file defines;
flags alone cannot create such a place.** _Why:_ a JS file, a JSON file
and flags are three spellings of one input: one validation, one resolved
config. A key cannot say where a dotted name it alone gives ends, so the
file has to declare it. Comma lists are what `--vfs.enable`
already takes, and they pass unquoted through bash, zsh, PowerShell and
cmd — PowerShell 5.1 drops the quotes of a JSON value, zsh globs `[a,b]`.
Typing by the setting, not by the value, makes one item a list and keeps
an extension `3` a string; a table instead of a rule per setting keeps
the parser general. `compile=true` stays a boolean and is refused as
`compile: true` is: nothing is migrated in hiding.

**An indexed place is its tree ([Node trees](#node-trees)): a lookup
walks the names of its key, a listing reads a directory's children, and a
directory is a node of its own — an empty one included.** _Why:_
directory lookups sit on hot paths — routing a directory or a miss,
`stat`, `exists`, listings, the hierarchy check before every new key — and
a directory that exists only while a file is under it can be neither made
nor listed empty, nor removed as `node:fs` removes one.

**What a place's tree keeps beyond a file's size, mtime and version is the
place's choice: `places.<name>.stat` — `birthtime`, each file's own, and
`directories`, a directory's times — both off by default, for indexed
providers only.** _Why:_ most places serve content whose birthtime nobody
asks, and each costs a field of every file or directory in every thread;
a place whose `stat()` must answer as a disk does — a sync tool, a listing
by date — turns them on. Off, birthtime and ctime equal mtime and a
directory's times are 0, as before.

**A listing names the entries of a native walk from the strings of their
parent paths (`listedNames()`): an entry of the listed directory is its
own name, one below it the rest of its parent past the directory and a
separator, then its name; the directory is walked without a trailing
separator, as its entries' parents are named. The directory is taken as
`path.resolve` makes it, so any spelling of it will do (the strict
`appRoot` with a trailing separator, `.`); where a parent is not in the
form `path.resolve` returns, or not in or below that directory,
`path.relative` names the entry, as it named every entry before. One
builder makes the result of every listing (`listing()`), and a `Dirent`'s
parent path is built once per directory.** _Why:_ `path.join`
and `path.relative` per entry were three quarters of a listing of a disk
directory; the strings give the same names, which a test holds to
`path.relative` for both path flavors — disk territory and the strict
`appRoot` list this way. The directory is resolved, not joined with each
place's name: `path.join('C:', 'site')` is `C:\site`, which is not below
what `path.resolve('C:')` is.

## Rules of subtrees

**A place's rules (`places.<name>.rules`) give a path of the place, and
everything below it, settings of their own while the place serves it —
`'/private': { fs: false }`, `'/static': { fs: { ext: ['html'] },
require: false }`, `'/system': { fs: { writable: false } }`, `'/legacy':
{ fs: { fallback: 'disk' } }`. A rule takes a domain off (`false`), gives
it again below a rule that took it off (`true` or an object: from the
settings it had there), or changes, within what the place declares, its
extensions — fewer, never more — `fs.writable` and `fs.fallback`; the
deepest rule on a path holds there. A rule belongs to a path, not to a
node: it holds for a path nothing lies at yet, and again once a removed
tree comes back. Places with a tree only.** _Why:_ a site keeps its
private files, uploads and system files in one place — one scan, one
pool, one config — rather than a place for each policy; a policy by path
is what a web server's locations give. What a file is — its bytecode, its
compression, its preparer — stays the place's: a rule that changed it
would make a file's representations depend on where it lies, and a move
rebuild them. A rule gives no extension the place does not declare,
which would show a file the place does not hold in memory. A `disk` or
`node-default` place serves its paths through `node:fs`, its listings
too: a rule could refuse a read while the listing showed what it hides.

**The settings in force at a key are settled once, from the config, in a
trie of the rules' paths (`PlaceRules`, lib/rules.js): each node holds the
place's settings overridden by every rule on the way down to it, and a
lookup walks the names of a key while the trie has them. Names compare as
the place compares keys: exactly in a virtual place, without case in a
disk-origin one on Windows (`foldName`). Two paths of rules equal but for
case are refused on every platform, as place names are.** _Why:_ a place
without rules pays nothing — its settings at any key are its config — and
one with rules a walk of the few names its rules share with a key, most
often one lookup. On Windows the disk opens `/PRIVATE/x` as `/private/x`:
a rule compared exactly would let the other spelling through. Kept in the
nodes of the place's tree, a rule would need a node at a path where none
lies, and would leave with a directory removed or moved.

**Every decision that read the place's settings reads the key's: the
routing — a domain off is the place without it (EACCES under strict, else
`node:fs`), the extensions it sees, its fallback, its writability (EROFS);
the facade — a path the fs domain does not see is not there: no file, no
directory, no entry of a listing, which enters no such directory, and a
write there is EACCES (`PlaceFs.writableAt` asks); the module hooks — a
domain off where a module lies serves it no more than a place without
that domain does (refused under strict, Node's own loader's otherwise);
and the store of a
virtual place, which checks again whoever routed the mutation — the
facade, the patch, a worker's request on the main thread. What a place
publishes, its scan and its watcher take no rule.** _Why:_ one function
answers each question (`Place.settingsAt`, `visible`, `writableAt`), so no
path serves by the place's settings what a rule holds otherwise; the
store is where every mutation of a virtual place is decided, a worker's
included, whose own checks the main thread does not trust. Rules hold
while a file is served, not while it is made.

**An operation on a whole tree — a recursive `rm`, a move of a directory
at its source and at its destination — is refused before any change
where a rule below its path hides what the settings above that rule show
(a domain off, fewer extensions, the disk territory refused: EACCES) or
forbids writes they let through (EROFS); so is a recursive `mkdir` that
would make a directory its rules refuse above the path: a directory made
is a write where it lies. What lies below a path is decided by the rules
alone.** _Why:_ a tree moved takes no rule along — a rule belongs to its
path — so the hidden part of a directory moved elsewhere would be shown
there and its read-only part made writable; removed, it would go past
what forbids its removal. Whether anything lies at a rule's path would
be asked of the disk, which a disk-origin place's tree may not show yet:
the rules answer at once, and only refuse more.

## Storage

**Pooled SAB segments (default 64 MiB), a best-fit allocator; emptied
segments are reused, never returned to the OS.** _Why:_ one SAB per file
would exhaust mmap regions and fragment the address space; returning a
segment would require every thread to drop its views, which cannot be
coordinated cheaply; reuse is enough.

**What is derived from a source — bytecode flavors, compressed bytes — is
representations in the file's payload, next to the source, each one extent
of the pool ([Node trees](#node-trees)).** _Why:_ every representation
stays one contiguous region, pinned, retired, relocated and freed on its
own; none is a key, so none can collide with a file, show in a listing, or
be left behind or moved apart from its file — a rename moves them with it.

**Disk files above `maxFileSize` stay disk entries; content without a disk
file of its own — prepared, virtual or SEA sources, and every derived
representation —
never falls back to disk: if it does not fit, its publication is refused
(and `initialize()` fails), as a full disk refuses a write: `ENOSPC`,
named by the operation (Failure policy).** _Why:_ large media do not
belong in the pool; a disk entry must point at a file that holds exactly
the content, and for prepared, virtual or compressed content there is
none — a disk entry would point at the raw source, or at nothing. A pool
without room is a disk without room to the caller: a refusal with a
`code` of its own, like every other refusal of the VFS.

**A `map` place keeps each representation's bytes in an `ArrayBuffer` of
the thread's own (`MapStore.segments`, by id), which its tree reads as the
shared places' trees read the pool: one model of content for every
place.** _Why:_ one tree, one `PlaceFs` and one pipeline for every indexed
place, and no second index to keep in step. The copy a mutation takes of
its bytes is a buffer of its own (`MapStore.own`), kept as it is; a result
that fills less than half of its buffer — a slice of a slab of Node's pool
— is copied into one of its own: 20 000 files of 100 B kept 73.6 MiB of
slabs, 2.1 MiB of their own. Buffers a set placed before a refusal leave
the map with it; one a commit retires leaves it too, and lives while a
view of it does.

## Node trees

**Every indexed place is a tree of nodes in each thread's own heap: the
main kernel's tree takes the commits, a worker holds a replica of it, and a
`map` place has a tree of each thread's own. A directory is a node; a
file's node holds its payload — its attributes, its source and the
representations derived from it. Shared memory holds bytes only: the engine
(`lib/tree.js`, with `lib/tree-plan.js` and `lib/tree-node.js`) never makes
a SAB, and no snapshot or delta carries one.** _Why:_ the flat index it
replaced — a `Map` of key to entry per place, a directory index beside it,
derived bytes as entries of their own under NUL keys, updates addressed by
key — made a move a copy: renaming 10 000 files of 1 KiB took 28 ms on the
main thread, left 10 000 retired versions and a second copy of the bytes
until every ACK, cost each worker 7–17 ms and could fail with `ENOSPC`; an
empty directory could not exist, and a listing gathered names. A tree
shared in SAB would need a protocol for concurrent access — copy-on-write
paths to the root, an atomic swap of the root, nodes freed by ACK — and
names that are no V8 strings (listing 1000 names: 69–72 µs against 17 in
JavaScript); it pays only at 10⁵ files and more, many workers and frequent
spawns. A dropped SAB lives until every holder has collected it, one in
`workerData` for the worker's whole life, so none is made per snapshot,
version or update. On the stand of the engine, against the flat index
before it went (`bench/scenarios/tree.js`, 10⁴ and 10⁵ files), the trees
list 13–35 times faster, a worker attaches 3.6–5.4 times faster, a
snapshot clones 17–37 times faster and a delta of many files costs
2.4–4 times less. In the library
([benchmarks](benchmarks.md#node-trees-against-the-flat-index)) a listing
is 16–64 % faster and a rename copies nothing, while a lookup walks its
names — 20–30 ns over the flat index's hit — and a commit plans, logs and
applies its delta even with no link to send it to: 0.5–0.7 µs a write
in a steady loop, 1.3 a one-file `writeFiles`, about 5 µs an update to a
linked worker. A thread holds 407 B a file in its heap where the flat
index held 535; the RSS of most scenarios stays within a few per cent,
the main thread's under leases (`retain`) grows 17 %.

**A node is opaque: the engine answers through operations — `get`,
`childOf`, `children`, `walk`, `countOf`, `pathOf`, `byId`, `nodeId`,
`nameOf`, `isDirectory`, `payloadOf`. Nodes are objects of one class each;
a node's `Map` of children is made with its first child and dropped with
its last; the root's name is `''`. A node has a class, a small integer:
in an FS tree 0 a directory and 1 a file, which the operations check
(`ENOTDIR`, `EISDIR`).** _Why:_ operations leave the layout to the engine,
and V8 inlines a method of one line. An object costs 24 B and 8 B a field;
an empty `Map` costs 176 B, which an empty directory or a file need not
pay. With the root named `''` a key is `pathOf(parent) + '/' + name`, with
no case of its own and the same on every OS — the form config, `writeFiles`,
events, map places and snapshots take keys in. Typed-array columns would
take about 2.7 times less memory, at the price of code and of pins kept by
number rather than by object.

**A file's payload is immutable — `{ version, size, mtimeMs, birthtimeMs?,
source, others, extras }` — and a change of what its node shows is a new
payload. `source` is a `Representation`, or null where the content stays
on disk (`retainRaw: false`, a file above `maxFileSize`): the place and the
key name the file, and no path is kept. `others` is null or one object of
fixed shape, its fields in one order: `requireBytecode`, `scriptBytecode`,
`gzip`, `deflate`, `br`, `zstd`; `extras` null or `{ meta, scriptOptions }`.
A `Representation` — `{ kind, segmentId, offset, length, data }`, kinds 0
`source`, 1 `require:bytecode`, 2 `script:bytecode`, 3–6 `fs:gzip`,
`fs:deflate`, `fs:br`, `fs:zstd` — is immutable and holds its extent;
`data` is a getter that makes a `Buffer` view on its first read and keeps
it with the representation.** _Why:_ one unit for allocation, pins,
retirement and frees, and the
same object for as long as the representation is published: a move, an
unrelated commit and the relocation of another kind keep it. A `Map` of
representations costs 176 B even empty, and the kinds are seven; a fixed
shape keeps access monomorphic and costs 72 B only on a file that has
derived representations — an object of the kinds present would make up to
16 hidden classes. A view costs about 104 B: one made with each
representation, at 1.6 representations a file and 10⁶ files, would take
about 2.5 GB over the main thread and 8 workers against 0.9, and a full GC
17–21 ms against 7–8. Made on every read and kept nowhere, it cost each
read ~60 ns and each lease a view of its own. Kept from the first read, a
thread pays a view only for what it has read — a replica of 10⁵ files
takes 421 B a file, 588 once it has read them all — a repeated read
costs ~27 ns, and the leases of one file share one view. Nothing
invalidates it: the object never changes, a new version or a relocation
is a new one, so its view never goes stale.

**Attributes are fields of the payload in every thread: version, size,
mtimeMs and, where the place keeps it (`places.<name>.stat.birthtime`),
birthtimeMs; ctime and atime equal mtime. The tree stamps the commit's
version into every payload the commit makes; size and mtime come with the
write, birthtime from the disk in a disk-origin place, else from the
node's earlier payload, else the write's mtime. With
`stat.directories` a directory has a payload of attributes only — the
version and time of the commit that last changed its children, a
new payload at each such change, the birthtime of its making — and without
it none: its times are 0. The caller gives the time:
`createTree({ now })`, `commit(ops, next, now)`.** _Why:_ an earlier design
kept attributes in SAB records of their own, so that any thread could write
atime; without atime the records saved only 24–56 B a file in each thread,
at the price of a second allocator, record numbers, their frees and a
callback inside the commit. A payload holds its stat and its bytes in one
immutable object, so they always agree and a reader's `fstat` is always
right. Changed in place, a directory's mtime could reach a thread before
the delta with its new children, and a listing cached by mtime would keep
the old list under the new time for good. A time the caller gives is one
a model can predict. One size or version from 2³⁰ on changes the
representation and the memory of no other payload: a field that turns
double turns every object of its class, 16 B each and a pass over all of
them.

**The main tree numbers its nodes from a counter that wraps at 2³⁰−1 to
the next id no live node has; an id a commit frees is not given in that
commit. A replica takes the main tree's ids, and `byId` is one `Map`.
Until the counter wraps no id is given twice: `idOf(key)` and
`stat().ino` name their node only, and after its removal none; `keyOf(id)`
gives the node's key now, which a move changes; `stat().dev` is the
place's number.** _Why:_ below 2³⁰ an id is a small integer in every V8
build, kept unboxed in the field and in the `Map`'s key, hashed as itself.
Grown past 2³¹ without a wrap — after 25 days at 1000 creations a second,
never in a test — every node would take 32 B more in every thread, `byId`
would be 4.5 times slower, and the change would pause each thread about
230 ms per 10⁶ nodes. A repeated id is safe for the protocol, whose deltas
apply in order; to an outside holder of an `ino` it can come back only
after a wrap, as ext4 hands out a freed inode number and PIDs repeat. A
live tree holds at most 2²⁴ nodes, so a free id is found at once.

**A reference to a node lives while the node does, and a move keeps it.
A removed node is dead, and so is its whole subtree: the tree never hands
one out again — `get`, `byId`, `childOf`, the walks — only `nodeId`
answers for it, and every other operation answers as for a missing node,
null, false, 0 or nothing, without throwing.** _Why:_ `payloadOf` null
keeps a dead node from reaching bytes that may be freed already; a name or
a class from before the removal could differ between threads, which apply
the commit in their own steps; an error would wrap every call after an
`await`.

**A commit returns `{ delta, retired, dropped, placed, changes, version }` or refuses, and a refusal
changes nothing anyone can observe: an `Error` with a `code`, a numeric
`index` — the refused op — and a `message`; no delta, no retirement, no
version; the structure, the order of children, the payloads, the tree's
numbers and every read as before; its iterators still valid; only the ids
and retireIds it drew may be skipped. Everything that can refuse is decided
before the outcome shows — the arguments, each op's checks op by op, the
final state, the limit of nodes, `retireIds.next()` last. Anything else
thrown is an engine bug: the tree cannot be trusted, and the kernel closes,
as when `initialize()` fails; so does an `index` of −1, a refusal of the
arguments or the version, which is the kernel's own error. A tree holds
at most `maxNodes` nodes, 2²⁴ by default: past it an op that makes a node
is `ENOSPC`, as a full disk refuses a write. An FS commit refuses with
`EINVAL`, `ENOENT`, `EEXIST`, `ENOTDIR`, `EISDIR`, `ENOTEMPTY` or `ENOSPC`;
the FS layer adds `errno`, `syscall` and `path`.** _Why:_ the engine plans
a commit against the tree and an overlay of its own ops
(`lib/tree-plan.js`): every check passes or it throws, and nothing has
changed. What passes is a log of primitive steps — create, attach, detach,
kill, a payload, relocate — and the log is the delta: the main tree applies
it with the very code a replica applies it with, so the two cannot drift
apart. 2²⁴ is what a V8 `Map` holds: unchecked, it would throw a
`RangeError` half-way through and leave the tree unusable, where `ENOSPC`
is an error `node:fs` callers know and the kernel stays up. An undo log
would have to restore the order of children, which a re-inserted entry
loses.

**A replica follows its tree by revision and mark. Every delta that
changes something raises the tree's revision — a relocation's too — and
the snapshot and every delta carry it: a replica applies only a delta made
from its own revision, and refuses a repeated, skipped or reordered one
with `ESTALE`, changing nothing. Every tree has a mark unique in the main
process, in its snapshot and its deltas: another tree's delta is `EINVAL`.
A snapshot also carries the mark of the engine's format: another copy of
the library cannot read it. Before its first change, `apply` checks both
and hands every representation the delta retires to `pins.retain`; past
that it trusts the delta.** _Why:_ the version does not move on a
relocation and `updateId` skips the updates of other places, so neither
can order one tree's deltas; a delta applied twice or lost would pass
unseen and corrupt the books of pins and frees. At start every tree is at
the same revision, so only the mark keeps one place's delta from landing
on another's ids. Checking a delta's references first would mean replaying
it — a second reading of the format — and gains nothing: a replica that
refuses one cannot go on, and its worker's view closes
([Virtual places and worker mutations](#virtual-places-and-worker-mutations)).

**Snapshots and deltas are plain data that structured clone carries, and a
thread keeps nothing of them: not the snapshot once `fromSnapshot` returns,
not a delta once `apply` has, not the ops once `commit` has. A tree's
strings are its own flat ones. A numeric column — ids, versions, sizes — is
an `Int32Array` while every value of it is a small integer of any build,
else a `Float64Array`, chosen for each snapshot and each delta; times are
always a `Float64Array`. A delta's columns are views over one
`ArrayBuffer`, the 8-byte ones first (`Columns`, `lib/tree-node.js`).**
_Why:_ a worker that kept its snapshot paid
1.9 MiB at 10⁴ files and 18.3 MiB at 10⁵, about 30 % of its index. A slice
of a string of 13 characters or more keeps its whole parent alive, and a
name of 16 characters copied takes 32 B against 40 and the parent. Columns
clone 10⁵ records in 2.9 ms where objects took 119. A boxed integer turns
the field of every node of its class. A port clones a buffer of its own
for every typed array: the fourteen columns of a one-file write took
5.3 µs to clone, on each side of the port, where the flat index's entries
took 2.0; one buffer under them all takes 3.5, and the reader indexes
the same columns of the same types.

**A lookup walks: `get` goes from the root by the names of the key, one
`Map` of children a level, in the depth of the key. There is no cache of
paths and none of misses. A move is O(1): a change of structure touches
nothing but its own nodes. On Windows a key with `\` is walked by both
separators as it is, never rebuilt.** _Why:_ a key of four names in a tree
of 10⁴ files is walked in 176–189 ns, where a cache hit took 84–97 and the
flat index 86–105; past its bound a cache loses to the walk — 10⁵ keys
over a cache of 2¹⁶: 825 ns against 672 read evenly, 1239 against 587 in a
cycle — since a miss inserts a copy of its key into a large `Map`. Kept
right, a cache dropped entries at every create, remove, move, rename and
load, needed a threshold for large subtrees and a cache of misses bound to
policies; those removals were the main class of defects the reviews of the
engines found, and the caches took up to 23 MiB a thread. A miss by walk
costs 150 ns, nothing beside the rest of a `require`.

**Reading: `children(node)` names a directory's children in the order they
became its children; `walk(nodes, { depth, containers, filter, descend })`
goes depth-first and lazily; `countOf(node)` counts children in O(1). An
iterator copies nothing, and only a change of structure breaks it
(`ESTALE`). The tree's numbers: its revision, which orders deltas; its
`version`, the last publication that changed it other than by relocation;
its `structureVersion`, the last that made, removed, moved or renamed a
node.** _Why:_ in synchronous code the tree does not change — a delta
applies in a port's handler, a commit in its own task — so an iterator
breaks only across an `await`, which is the guard it is for. A payload, a
commit with nothing to change and a relocation leave every `Map` of
children as it was, and break nothing. Aggregates — counts by class, the
version of a subtree — are the engine's for the trees of other clients;
xvfs creates its trees without them and pays no slot for them.

**A commit retires every representation the state before published and the
state after does not, by identity: what a new payload no longer holds,
what a removed node held. A move retires nothing. The retireIds come from
one counter of the kernel for all its trees (`createTree({ retireIds })`):
from 1, wrapping at 2³⁰−1 and skipping the ids still on the books.**
_Why:_ pins key on the `Representation` object, which a move keeps, so a
pin stays right where a copy would have needed a second identity for one
version. One space of retireIds and one version for all places keep the
ACK and `vfs-release` free of place names and the books whole.

**What a commit gives a node and takes back in itself — a payload written
over, a representation relocated again, a node removed with what the
commit wrote into it — retires nothing: the commit returns its extents
as `dropped`, and the kernel returns them to the pool at once, a `map`
place's store drops their buffers. A set names each key once: the
kernel's batch (`publishVirtualBatch`) refuses a key twice before
anything is placed, as `writeFiles` does.** _Why:_ nobody ever saw what a
commit took back, so nothing waits for an ACK, and without `dropped` its
bytes would stay in the pool for good, outside both the published and
the retired — whatever the next caller of the engine does. A set with a
key twice is a contradiction rather than a commit to take back: what it
published would hang on the order of its files, and its event would
name the key twice.

**A tree's version never decreases and never wraps: the kernel hands each
commit the next publication's version, and a commit that changes nothing,
or only relocates, takes none. A `next` beyond `Number.MAX_SAFE_INTEGER`
refuses the commit (`EINVAL`).** _Why:_ versions order publications,
events and every newer-or-older comparison; a double is exact to 2⁵³, so
running out is a loud refusal, never a wrap or a repeat.

**The engine imports nothing of the kernel: it takes the options of
`createTree`, the arguments of `commit` and `apply`, and gives back the
delta, the retired representations and the version. It also has trees whose
ids a client gives — `put` and `remove` by id, `load` of a whole state, a
class per node and a policy checked on the way down — which the kernel
hosts as [trees of client ids](#trees-of-client-ids), for a URL tree of an
application.** _Why:_ one engine for the files of a place
and the pages of a site; a clean boundary lets the reference model
(`test/tree-model.js`) test it without loading the kernel
(`test/tree-boundary.test.js`).

## Publication

**One pipeline for every source of content: raw input → the preparer of
its extension (once) → canonical content → bytecode flavors → compressed
representations → one epoch.** Initial scan, watcher, SEA assets, virtual
writes from any thread and `map` writes all use it. _Why:_ what a file _is_
cannot differ between init and live updates or between origins, and
atomicity and failure semantics are enforced in one place.

**Tree-at-flush: allocations are private until `#flush` commits an epoch
to the places' trees in one synchronous step.** _Why:_ `snapshot()`,
`link()` and compaction only ever see published state; a failed or
abandoned attempt frees only its own bytes; what a commit replaces is read
from the tree at commit time, so two publications can never retire the
same representation twice.
Consequence: there is no global commit lock — virtual publications of
different keys may overlap.

**The SAB sink (`lib/publication.js`) places the bytes; the kernel commits
them. `sharedPublish()` allocates a canonical input's source, bytecode
flavors and compressed representations privately and hands back what to
stage — the payload input, the attributes and each representation's
`[kind, extent]`, and its extents; `inputOf()` makes the canonical input
for either sink —
a raw input read through the kernel's reader, its preparer run once — and
the map sink is `MapStore.publish()`. A failure frees the attempt's own
allocations and nothing else. The sink keeps no state and calls nothing
private: it reads the kernel's `cache` and `compressor` at each call —
after `close()` both are gone — and the kernel stages what comes back into
its epoch.** _Why:_ what a publication places is one idea; what commits it
— the trees, retirement, the pins, the links — is the kernel's, so the
commit stays a private step of the owner of that state. A sink that kept
the pool or the compressor would outlive `close()` and serve a later
kernel from the old pool; one that kept a function — the reader, a free, a
codec — would miss the one a test puts on the kernel's objects.

**One `vfs-update` per epoch, accepted mutation or part of an intake's
run; a file's payload is
replaced whole — its source and every representation in one delta — and
one that failed to rebuild is missing from the new payload.** _Why:_ V8
accepts cached data by source length, not content — a same-length edit
next to stale bytecode would run the old code silently.

**A commit that publishes takes a version: the next number of the main
kernel's count of publications (`#version`), which `#flush` hands each
tree's commit (`commit(ops, next, now)`) — the tree stamps it into every
payload the commit makes; an intake, every commit of its part — and sends
in its `vfs-update`; every snapshot
carries the kernel's, and each thread takes it with the update: the main
thread in `#flush`, a worker update by update (`#applyUpdate`). A commit
that publishes nothing — an empty epoch, a mutation that changes nothing —
takes none, and neither does a relocation (a `relocation` epoch): a
relocated representation's payload keeps its attributes, its version among
them. A move keeps the version of what it moves: its payload is the same.
A snapshot also carries `instance`, the
main kernel's random id. The files of a `map` place and the disk
territory have no version.** _Why:_ an application needs to tell one
published content from another — an ETag, a `vm.Script` built from a
bundle, whether a worker has seen a write — without the clock, which
repeats within a millisecond and is not one across threads, and without
the content, whose hash is a pass over every byte. `updateId` counts
updates for the ACKs, relocations included, which change no file; a
`retireId` names one retired representation until its free. One counter
on the main thread, stamped at the commit, is the same number in every
thread without a message of its own, and the equal versions of one
commit tell its files published together. A version restarts with the
process, the pair of `instance` and version does not. A map place's
content is each thread's own: a count per thread would give one file a
different version in each.

**A publication is announced where it is applied: `VfsKernel` is an
`EventEmitter`, and a publication of a newer version is one `'publish'`
event in every thread: its version and, by place, the keys of the files
it created, replaced and removed and the `[from, to]` of each node it
moved, deep-frozen — lists the main thread makes of what the tree says
the commit did to its nodes (`changes`, `eventsOf()` in `lib/epoch.js`):
the state after the commit, whatever the order of its ops — a key
created and removed in one commit is named nowhere, a node written and
moved is in `moved` and, under its new key, in `replaced` — and sends
in the update, where a worker takes them. `#announce` emits it in a
microtask of its own, which drops it once `close()` has come; `close()` emits `'close'` once, in a
microtask, then drops every listener. The lists are built only when
there is a listener. No `'error'` is ever emitted; what a listener throws
is an uncaught exception.** _Why:_ an application reacts to what was
published — a cache keyed by version, a route table, a worker waiting for
a write — and a raw `fs.watch` reports disk events, not publications, of
disk-origin places only. Made once, on the main thread, and carried by
the update, an event is the same in every thread and follows the order of
the updates; a relocation, of the same version, is none. A microtask runs no application code inside the commit
— a listener that closes the kernel, writes or throws does so after it —
and still runs before the continuation of the mutation's promise, which
settles later in the same queue: its listeners have run when
`await writeFile()` returns; `process.nextTick` from a microtask would
run after all of them. Strings and numbers hold no shared bytes, so a
listener delays no free. A listener's error is the application's, as
with any Node emitter: logging it would hide it, and the publication is
done by then.

**Watcher epochs run strictly one at a time, in arrival order
(`SerialQueue`); rechecks use the same queue.** _Why:_ epochs processed in
parallel let an older epoch publish over a newer one (new content on disk,
old in the VFS); a FIFO is the simplest correct order, and the debounce
already batches events. The queue is deliberately separate from the per-key
`MutationQueue` of virtual places, which never share a key with a watched
place.

**`WatchPipeline` (`lib/watch-pipeline.js`) owns the live updates — the
watcher, the queue, the jobs of each epoch, the rechecks — and the kernel
keeps the commit. The pipeline is granted one capability: an epoch the
kernel opens for it, `{ publish(place, key, file), directory(place, key),
remove(place, key), flush() }`, bound to an epoch of the kernel's own whose
state never leaves
the kernel; anything else it reads from the kernel's public state when it
runs, never while the kernel is being constructed.** _Why:_ a commit writes
the trees, retires what it replaces, binds the pins and tells the links —
all the kernel's; bound to its epoch, a `flush()` commits what was
published there and nothing else.

**An epoch gathers per place what its commit is made of (`lib/epoch.js`):
an init or watcher epoch the intents — what the disk says each key is
now: a directory, a file with its payload input and extents, or gone, the
last word for a key winning — of which `reconcile()` makes the tree's ops
against the tree as it is: removals first, then directories, every
missing one down to a key, a file in the way unlinked, then files with
their missing directories, a directory in the way removed. A mutation or
a compaction gathers the ops themselves, in order. The tree says what a
commit did to its nodes (`changes`), and `eventsOf()` makes of it what
changed in files — created, replaced, removed, moved — and the keys the
nodes it killed had. Each place is a commit of its own, and a refusal of
one tree is its source's: a watcher epoch drops the refused intent, frees
its bytes, warns, rechecks the key and commits the rest; a compaction
frees its copies and reopens its segment; init and a mutation fail.**
_Why:_ the disk says what is there, not how it changed: intents need no
order of events, and a scan and an epoch make the same tree of the same
disk. No publication is a transaction across places — a rename between
places is `EXDEV` — and all or nothing across them would let one place's
trouble undo another's epoch.

**A disk-origin place publishes every directory under its own — an empty
one, and one that holds only files the place does not cache: the scan
lists them (`scan({ dirs })`), and the watcher adds a new one and removes
one gone as it does a file.** _Why:_ directories are explicit; a directory
that exists on disk exists in the place, whatever its files — under
`fs.fallback: 'deny'` it lists empty.

**A watcher epoch takes each key once: a directory rescan and a file event
that both reach a key publish it first-come. The keys an epoch has taken
are the pipeline's own record, beside the kernel's epoch.** _Why:_ the rule
belongs to the watcher, not to every epoch of the kernel; a virtual write
stages nothing twice.

**Disk work is bounded (`pool()`, `lib/pool.js`). An epoch runs its jobs
`IO_LIMIT` (16) at a time: each logs its own failure and stops none of the
others; a job the pool reaches after `close()` does not start, and one in
flight stops at its next step — the disk call it waits for finishes (a
read of a file it began, to its end), no other starts, no preparer runs, a
scan stops its walk and its stats (`stopped`), and nothing is logged; a
rescan among them publishes its new files one at a time. A
scan walks the tree one directory at a time, then stats the files it found
16 at a time, each result landing at its index: the result keeps the order
of the walk. Init publishes `initConcurrency()` files at a time; the first
failure stops the rest.**
_Why:_ a read holds a file descriptor from open to close — an unbounded
epoch of 2000 changed files failed half of them with `EMFILE` at
`ulimit -n 1024` — and 16 keeps the libuv threadpool busy: 4 was slower,
more no faster. A rescan is already one job of its epoch. A stat holds no
descriptor, but one at a time left the scan waiting on each, and a pool per
directory is no faster on a sparse tree. In the order of the walk, init
publishes files of equal size in the same order from run to run. Init
shares the threadpool with zlib: more in flight only raises the peak heap.

**The watcher sees the disk through `lib/disk.js` — `node:fs` as it was
when the library loaded: recursive `fs.watch` where it is native (Windows,
macOS), elsewhere one plain `fs.watch` per directory, a new one added as an
event shows it, the ones under a deleted path dropped, a link to a
directory never followed.**
_Why:_ on Linux Node builds recursive `fs.watch` over the public
`node:fs`, which `fs-patch` routes: it listed the VFS instead of the disk
and missed new files, and from Node 26.10 a refusal reached it as an
uncaught exception. One watch per directory is also what inotify costs at
least.

**On a disk that takes a name in any case the watcher asks the disk how
it spells a name fs.watch reported in a rename (`realpath`, `spelledSo`;
DirWatcher hands each epoch those paths): spelled otherwise in its case
alone, the key is gone, and the event of the new spelling publishes the
file or rescans the directory.** _Why:_ such a disk stats a name in any
case, so after a rename that changed only the case DirWatcher named the
old spelling a change — or a rescan — and both spellings stayed in the
tree, listed in every worker. A change names a file as the disk spells
it, and the call costs a handle of the disk — about 12 µs a file on
Windows, half again the cost of a watcher epoch of 100 changed files
when it was asked for every one.

**The watcher publishes no link the scan would not: a rescan starts only
at a real directory (`scan()` lstats its `startPath`), and under strict a
changed file is taken by its own stats — a link at a watched key is no
source, its key goes as if the file were gone.** _Why:_ the watcher stats
what an event names, which follows a link: a junction made in a
disk-origin place after `initialize()` became a rescan that read its
target — another place, a directory above `appRoot` — and published it
under the place's keys, content the scan at init never enters. Under
strict the scan takes no link to a file either, so neither does an epoch.

**Stable source reads: stat before and after a looped read; a failed
publication keeps the previous version and gets one deferred recheck.**
_Why:_ a file that changes while being read must never be published half
written, and a flapping file must not loop.

**Failure policy.** Init aborts on any unreadable source, preparer error,
failing `fs.script.compile` or path-less input that does not fit; a
`close()` while it runs stops its scan, and the publication in progress
stops at its next step: a read it began finishes, no other disk call
starts, no preparer runs, and whatever fails once the kernel is closed —
a read close() cut short, the reader close() took away — fails as the
close (`#publishEntry`), so that `initialize()` rejects with the
closed-kernel error. Live updates keep the previous version and its
representations. `require.compile` is
best-effort. A source `fs.script.compile` cannot compile is one error
wherever it is published: `ENOTSUP` (`fs.script.compile: source does not
compile`), `syscall` `open`, `path` the source's — `bytecodeFor()` throws it
for the SAB and the map sink alike, and a worker's mutation gets it back
with the same fields. A rename that publishes a source under a new name
refuses it as the rename: `rename`, the renamed source as `path`, the new
name as `dest` — the operation hands the pipeline its `fail`, and so it
does for a preparer the thread lacks. What the pool has no room for — a
source, a script flavor — is `ENOSPC` (`no space left on device`, what
did not fit as its detail), named the same way: `open` of the key, else
the operation's `fail`; a copy into a virtual place fails as the copy,
the store's refusal as its `cause`. _Why:_
startup is all or nothing; live traffic keeps serving the last good
version; Node's CommonJS loader compiles fine without cached data, while
a script bundle promises its cached data. A caller cannot tell the sinks
apart: the same refusal answers the same, with a `code` like every other
refusal of the VFS, and names the call that was refused, as every refusal
of a rename does.

## Lifetime of shared bytes

**A replaced or removed shared version is retired, not freed: it gets a
temporary `retireId` and its bytes return to the pool only after every linked
worker has ACKed the update and no thread still reads it — never on a
timeout.** _Why:_ a freed extent is reused at once; a stream, lease or socket
write queue still holding it would read another file's bytes. An ACK only
means a replica let the version go, not that its consumers finished; a
timeout would bring the bug back under load.

**The `retireId` exists only from retirement until the free — no permanent
allocation id per representation. It comes from one counter of the main
kernel for all its trees, from 1, wrapping at 2³⁰−1 to the next id not on
the books, and travels in the delta's list of what it retires, never
inside a payload.** Records keep place, key, kind, size and time for
internal diagnostics (`kernel.retirements()`, labels like
`static:/a.mp4 [fs:br]#17`, never parsed back). _Why:_ a published
representation is named by its node's id and its kind; a permanent id
would bloat every payload and message for the rare case; an id on the
books is never given again, so a late release can never match a later
retirement, and below 2³⁰ it stays a small integer in every build. The
public version of a file (Publication) is no `retireId`: it names the
commit that published the file, shared by every file of that commit, and
neither a relocation nor a move changes it.

**`diagnostics()` is the public, read-only picture of the shared memory:
the pool's usage and fragmentation; what the published versions take of
it; the retired representations — a source or one derived representation
each — and
what they wait for; what the main thread and each link still hold; each
link's pending ACKs — the age of the oldest shows a stuck worker; the
sources served from disk because the pool had no room for them; the
failed preparations, by place; the work queued — watcher epochs and
rechecks, the keys and barriers of virtual mutations. It is taken when
asked, from the pool (`FilesystemCache.usage()`), the books
(`Retirement.summary()`, `heldBy()`, `pendingOf()`), the links, one walk
of the trees and the queues' sizes; its one counter, a place's failed
preparations, moves only when one fails. It frees, settles and compacts
nothing and returns a frozen plain object; main thread only.** _Why:_ an
operator must see a stuck worker, a full pool or a pipeline that does not
drain before the memory runs out, and `retirements()` lists records, not
a verdict; figures derived when asked cost the read and publication paths
nothing — a question asked every few seconds must not tax every request —
and cannot drift from the state they describe: `pool.used` is
`published.bytes` and `retired.bytes` plus the publications in progress.
Looking must not change what it looks at: a settle or a compaction would.
Only an update that retires a representation waits for ACKs, so a worker
that receives only additions never shows as stuck — it holds nothing
either.

**`Retirement` (`lib/retirement.js`) keeps the books — the retired
versions, the ACKs each update still waits for, the holders — and decides
what is free; it frees nothing. Each change of the books hands the kernel
the records it may have left unheld, and the kernel's `#settle`, the only
free of a retired version, returns their bytes to the pool and compacts
once.** _Why:_ ACK-before-free is bookkeeping of its own; the pool, the
compaction a free may start and the epoch that publishes it belong to the
kernel, which owns the trees, the links and the pins an update commits to.

**A consumer pins only the representation it reads — the source or one
derived representation; each is retired and freed on its own.** _Why:_ pinning a whole
file bundle, or a segment, for one slow reader would keep unrelated bytes
out of the pool.

**Each thread pins direct consumers by the `Representation` object of its
tree; IPC happens only when a pinned version is retired: its id in the ACK
(`retained`), then one `vfs-release`.** _Why:_ the object is the identity
of a physical version for free — a move and an unrelated commit keep it;
pinning a current version happens
per stream and view and must stay local; reporting the hold inside the ACK
registers it before the ACK can free anything.

**Streams emit owned chunks, released with the stream, unless zero-copy is
on — the place's `fs.zeroCopy`, or `{ zeroCopy }` per call; zero-copy
chunks are released only by `stream.release()`.** node:fs callers (the fs
patch) always get owned chunks. _Why:_ a socket keeps chunks in its write
queue after the source stream ended — releasing on `'end'` would free bytes
still being written; third-party code never calls `release()`.

**Owned-chunk streams release in `_destroy` — the single path of end,
error, `destroy()` and an `AbortSignal`.** _Why:_ one path cannot release
twice; `pipe()` never destroys its source, hence `pipeline()` in the docs.

**Views are explicit leases `{ view, release, [Symbol.dispose] }`, with no
GC backstop — and neither streams nor leases have warning timers: an
unreleased zero-copy stream or lease holds its version until `release()` or
`close()`, visible in `retirements()`.** _Why:_ a Buffer has no lifecycle to
observe; a GC-driven release could free memory while a destructured view or
a `subarray` of it is still in use — use-after-free is worse than a visible
leak; a long pin (a slow download) is normal, not an error.

**`close()` stops active streams (`ERR_VFS_CLOSED`); a worker kernel's
`close()` also closes its link.** _Why:_ after close nothing guards shared
bytes — a worker's streams would otherwise read memory the main thread reuses
once the link is gone.

**A closed link — the `MessagePort` created by `kernel.link()` and
attached with `attach({ link })` — is the worker's exit: its pending ACKs
and its holds are dropped.** _Why:_ a thread that is gone reads nothing;
waiting for it would keep its retired versions forever.

**`map` places take no part in retirement; their leases and releases are
no-ops.** _Why:_ a map place's bytes are buffers of the thread's own,
which the GC keeps alive while a view of them lives; no update reuses
them.

**Compaction copies the published representations of the segment it would
empty and closes it; retired extents never move. It finds their owners in
its books — segment → place → offset → node id, which every commit keeps
from the owners its tree names (`placed`, `#book`): what it gave and the
node that holds it after the commit, whatever keys its ops named — and
names each by its node's id and kind — `['relocate', id, kind, extent]`,
a commit like any other, in an epoch of its own that takes no version —
never by key; the old extents retire like any replaced representation.** _Why:_ moving a retired extent would invalidate its
readers; the closed segment returns to the pool when its last retired
bytes are freed, and an extent placed there before it closed reopens it
when it is committed. A key has to be built and parsed again, and a move
of a directory changes the keys of its subtree: books by key go stale, and
a relocation by an old key could move another file's representation
(`rename a → b`, then `write a`); a move keeps a node's id, and so books
by id. Found by a walk of the trees, the owners cost every free cycle that
had a candidate 30 ms at 10⁵ files and 340–360 ms at 10⁶ (the flat index's
scan: 4.8 and 27–75 ms); the books find them for the cost of one segment —
2 ms at 10⁵ files and at 10⁶ — and take 37 B a file on the main thread.

## Preparation

**`prepare` is declared by a domain but prepares the file: one declaration
per extension per place; a second declaration — even of the same preparer —
is a config error, with no domain priority and no merging. The error names
every declaration of the extension, across domains and inside one.** _Why:_
a file has one canonical content shared by every domain; two declarations
would be ambiguous, and silent priority rules hide configuration mistakes.
An error that named the first two sent the user back once per extra
declaration.

**The short form `prepare: 'name'` covers the domain's effective, finite
`ext` — in fs, what `fs.ext`, `fs.script.ext` and `fs.script.compile`
list; an fs that lists none takes only the object form.** _Why:_ "every
file" is not a meaningful preparation target. fs names an extension once,
in one of its lists, so the short form covers them all — a script
extension is no longer repeated in `fs.ext` — and `fs.script` has no
default that would hand the preparer files nobody named.

**`prepare` routes, it never selects: neither form adds or removes
extensions of a domain or of the scan, and every declaration resolves into
one index `place.prepare = { [ext]: name } | null`.** _Why:_ visibility
stays a function of the consumer filters; one index gives O(1) selection
and no per-domain copy that could disagree.

**On the main thread every preparer an enabled place names must be
registered — `initialize()` checks it before anything is read; a worker
binds only what `attach({ preparers })` gives it.** _Why:_ a missing
function is a deployment error: startup fails, not a later publication.

**Preparers are synchronous, run once per publication attempt and never on
read; returned bytes are taken the moment the preparer returns, `meta` /
`scriptOptions` cloned and deep-frozen.** _Why:_ they run inside
synchronous `map` writes and the watcher pipeline; running on read would
multiply the CPU cost per thread and request; cloned, frozen results
travel to workers and cannot change after publication.

**A `Uint8Array` a preparer returns for a shared place is copied once,
straight into its provisional SAB allocation, synchronously inside
`prepareInput` (the SAB sink hands it `cache.allocateSync`) and before
`meta` / `scriptOptions` are cloned; the publication then places the
derived representations beside it, and a failure — a copy that throws, extras
that cannot be cloned, any later step — frees it like every allocation
of the attempt. Strings are encoded first; Map places keep an owned copy;
the raw input returned as is is placed like any raw input.** _Why:_ a
virtual write already copies its input, and the owned intermediate copy
made such a result three copies against the raw input's two — twice the
publication latency of Buffer and `Uint8Array` results from 64 KiB up
(`doc/benchmarks.md`). The copy must stay synchronous: two writes issued
in one turn run their preparers back to back before either publication
goes on, so a preparer that reuses its output buffer would have
overwritten the first result had the copy waited for its publication;
and it comes before the clones, whose getters are the preparer's code
too. The sink declines — and the pipeline copies as before — when the
bytes cannot live in SAB or after `close()`, which a preparer may call,
so every refusal answers as it did; a source `allocOptions` would keep
on disk it declines as a guard, since the config already refuses
`retainRaw: false` together with `prepare`.

**Workers never prepare shared places; `attach({ preparers })` serves only
local writes to a worker's own `map` places, and a missing preparer fails
that write, not the attach.** _Why:_ functions cannot cross threads; the main
kernel owns every shared publication; a worker that only reads never needs
them.

**Appending to or moving away a prepared key is `ENOTSUP`; renaming raw
content onto an extension with a preparer publishes it through that
preparer.** _Why:_ the raw input is not retained and a bundle may embed its
old key — refusing beats publishing a stale bundle.

**`fs.script.compile` and `require.compile` are independent flavors built
from the same canonical source.** _Why:_ different consumers, wrappers and
options — the bare source under the preparer's `scriptOptions` for
`vm.Script`, `Module.wrap(source)` under the module filename for Node's
loader. The library invents no `scriptOptions`.

**`compile` is a list: the extensions of a domain that get cached data,
and nothing else gets any; `ext` lists those that get none, and
`compile` adds its own to the domain. A domain lists an extension once —
require in `ext` or `compile`, fs in `fs.ext`, `fs.script.ext` or
`fs.script.compile` — a list names it once, and `json` or `mjs` in a
`compile` is an error. No default compiles: `require: true` takes js,
cjs and json without cached data, and `fs.script` is an object that
names its sources (`ext`, `compile` or both), never `true`.
`Place.compiles()` decides both flavors and the representations a source
may hold.** _Why:_ a boolean compiled a fixed set — js and cjs for require —
so a template a module requires by its full name
(`require('./view.dhtml')`, served as CommonJS already) never got cached
data, and a script extension had to be written in `fs.ext` and in
`fs.script.ext`. One list per meaning says of each extension whether it
gets cached data; an extension in two lists — or twice in one — would
say it twice. A default compile list made `ext` alone mean "compile
these" in one config and "do not" in the next; with none, what a config
compiles is what it lists. Node loads JSON and ES modules without
`_compile`, and neither is a `vm.Script` source: their cached data would
never be used. A specifier without its extension still finds js, cjs and
json only (`require('./view')`), as before.

**A script bundle without script bytecode carries `cachedData` undefined,
never null.** _Why:_ `vm.Script` refuses null (`ERR_INVALID_ARG_TYPE`)
and takes undefined, so `{ ...scriptOptions, cachedData }` serves every
bundle and no caller has to test it.

**Cached data is a contract on the text: it serves only a `vm.Script` of
the identical source with compatible `scriptOptions` — the bundle's for
`fs.script`, `Module.wrap(source)` under the module filename for
`require` — and the two flavors never mix. On rejection the consumer
runs the canonical source without it: one isolate's refusal, which
changes no file and no published version.** _Why:_ a changed source, a
wrapper or other V8 version and flags can make V8 reject it, but V8
checks the source's length, not the text: cached data of another text
may be taken and run the wrong code. Only a consumer given the exact text
it was built from is safe — a recipe that handed the require flavor to a
third-party compiler wrapping the source its own way was removed for
that.

## Virtual places and worker mutations

**The main kernel alone owns the allocator, preparation, publication,
retirement and compaction; workers mutate `sab + virtual` places through an
RPC over the `MessagePort` created by `kernel.link()` and attached with
`attach({ link })`, an in-process channel between the main thread and the
worker.** The response follows publication — the update is posted first on
the same port — and the payload travels as a detached copy.
_Why:_ one writer keeps allocation single-threaded without locks inside SAB;
a worker sees its own write before its Promise settles.

**One table (`OPS`) describes each worker mutation for both ends of the
RPC: what its request carries besides the key — bytes, a second key, or,
in place of the key, a set of keys with the sizes of their bytes, all in
one buffer (`writeFiles`) — and the options its store takes, which travel
as booleans. The main end (`serveMutation()`) takes nothing else from a
request: it checks the mutation, the place, its origin and writability
and every key again — a set whole: every key canonical, none twice, sizes
that add up to its buffer — and hands the store the options of the table;
its answer carries the version of the commit of a set.** _Why:_ the
worker's replica is read-only and never authoritative; one description
keeps the two ends from drifting apart, and a store never gets an option
its mutation does not take. A set is one request and one transferred
buffer, not one per file: one message, and the main thread gets all of it
or none.

**Mutations of shared places are asynchronous; `*Sync` forms are `ENOTSUP`;
no `Atomics.wait()`.** _Why:_ blocking a worker on the main thread invites
deadlocks and stalls both.

**Per-key ordering with an exclusive place barrier for subtree operations;
one update per accepted mutation, no coalescing.** _Why:_ each Promise
corresponds to its own publication; validation and publication see the same
state without serializing unrelated keys.

**A mutation settles as published or refused: it commits through
`#commit`, which refuses a kernel closed after the publication's last step
with the closed-kernel error (`[vfs] kernel closed before publication`).
The watch pipeline, compaction and `initialize()` commit through `#flush`
alone. Every refusal a `close()` causes has the `code` of a stream it
stops, `ERR_VFS_CLOSED`: a publication it cuts short, a mutation it finds
queued (`requires a ready kernel`), and a worker's request whose link
closed before its answer — which says the mutation may or may not have
been published.** _Why:_ `close()` is synchronous and a publication is
not; `#flush` publishes nothing on a closed kernel, and returned silently,
so a write whose kernel closed in the last `await` before its commit
resolved though nothing was published. A watcher epoch or a relocation
has no caller to tell, and `initialize()` checks the kernel right before
its commit. One code tells an application that `close()` stopped what it
asked for — stream, publication or queued mutation, in any thread —
without matching a message. A worker whose link closes cannot know whether
the main kernel committed its mutation before it closed: the answer is
what never came.

**The semantics of a virtual place's mutations is written once
(`VirtualStore`): which checks run, in which order, and what each refusal
is; a store only executes it — `MapStore` at once, on the thread's own tree,
`SabStore` in the key's turn of the kernel's queue (under the place barrier
for `rm` and the rename of a directory), publishing through the kernel.
Every check runs inside that turn, and a mutation takes the bytes it is
given when it is called.** _Why:_ the two stores followed the same
`node:fs` rules, each with its own copy of them to keep in step; a template
method keeps apart only what differs — at once or queued, keys in flight or
none — where one class over an execution engine would test every result for
a thenable.

**`link()` / `attach()` is the only worker transport.** _Why:_ one
implementation of the protocol — ACKs, retained versions, releases,
mutations — instead of every integration re-implementing retirement.

**The snapshot is the first message on the link's port, not a field of
`vfs`: `attach()` takes it (`takeSnapshot`, `receiveMessageOnPort`)
before anything else and keeps only the replicas built from it.**
_Why:_ `workerData` lives as long as the worker, and a snapshot in it —
every node of every place — would too: a worker's heap held 8.94 MiB with
the snapshot there against 5.13 with it on the port. A message taken off
the port is the worker's own object, collected once the replicas are
built. A link whose port holds none — taken already, or no port at all —
is refused at once rather than replicated empty.

**An update carries a segment once, in `newSegments` — the first that
publishes into it — and a snapshot every one (`#sentSegments`).** _Why:_
a segment stays in the pool for good, the same SAB, so a link made later
has it from its snapshot. Carried with every update that touched it, a
segment cost 1.7 µs of a clone on each side per update, and a new
`SharedArrayBuffer` object in every worker each time.

**A delta a worker cannot apply breaks its view, in the same synchronous
step, before the event loop runs again: every call that reaches its
places is `ERR_VFS_CLOSED` with the failure as its `cause`, a mutation
waiting for its answer rejects with it, and `'close'` carries it
(`#break`, `#live`); the worker ACKs neither that update nor any later
one and applies none; its streams stop, but its port stays open while it
holds a pin — a lease, a borrowed chunk — and closes with the last
(`Pins.break()`); the error is rethrown, so by default the worker ends.
The main kernel changes nothing: it waits for the ACK, holding what the
link held, and frees it all when the port closes, as on a worker's
exit.** _Why:_ part of the update may be applied already, and the next
delta was made from the state after the refused one: going on, or
skipping it, would part the view from the main kernel without a word.
Closing the port at once would free bytes under a live lease — a socket
still writing a `lease.view` would send another file's bytes. An uncaught
exception alone is not enough: an application's handler may swallow it.
There is no recovery: a new view is a new worker with a new `link()`; a
`'close'` with an error says it, without an event of its own.

**`map` places are per-thread and never part of a snapshot.** _Why:_ fast,
synchronous scratch space without coordination; shared writable state goes
through `sab + virtual`.

**A rename in a virtual place works as on Linux, on every platform, in one
commit of its tree: a file onto a file replaces it, onto a directory is
`EISDIR`; a directory onto a file is `ENOTDIR`, onto an empty directory
replaces it, onto one with children is `ENOTEMPTY`, into its own subtree
`EINVAL`; the destination's directory must exist. The store makes the
replacement one commit — `unlink` (a file) or `rmdir` (a directory) of the
destination, then `move` — whose checks give the codes, and a refused
`move` undoes the removal. The node moves — its id and `ino`, its payload
and every representation, its version — and nothing is copied; the event
names it in `moved`, a destination it replaced in `removed`. A file whose
pipeline would make something else of it under the new key — a preparer
of the new extension, other bytecode flavors or `require.compile`, whose
cached data is compiled under the file's path, another compression
(`movesAsIs`) — is published anew there in the same commit, keeping its
mtime as a rename on disk does. A file renamed onto itself, once its
checks pass, changes nothing — no publication, no `vfs-update` — as
`node:fs` renames a file onto itself.** _Why:_ a virtual place answers
the same everywhere; the disk of the host gives `EPERM` for most of these
on Windows, where a directory replaces a file. `rename`'s table belongs to
the FS layer: a `move` that replaced, or a flag for it, would put the same
table inside the engine, and a commit is atomic anyway; replaced through
`remove`, a destination the FS layer took for the wrong kind would lose
its subtree, where `unlink` and `rmdir` check the kind themselves. A move
is not a write: the content is the same, so is its time, and moving a node
copies no byte and retires nothing — the copies it replaced took 28 ms
for 10 000 files of 1 KiB, left 10 000 retired versions and a second copy
until every ACK, and could fail with `ENOSPC`. A prepared source keeps no
raw input and a compiled or annotated one names its path (`require`
cached data, `scriptOptions`, `meta`): moved as it is, it would lie.

**A virtual place keeps the hierarchy of a filesystem: a path is a file or a
directory, never both. One check (`checkHierarchy`) runs before every
mutation that creates a primary key — write, append, copy, file rename,
subtree move — in `map` and `sab` places alike: a file above the key is
`ENOTDIR`, a directory at it `EISDIR`. A key whose publication has begun
counts as a file until it commits or fails (`SabStore`'s keys in flight),
so two mutations running together cannot create `/f` and `/f/x` both as
files. The keys in flight are indexed by the directories above them
(`KeysInFlight`, a count per directory), so a key in flight above or below
a key is found in the depth of that key. Directories are nodes: `mkdir`
makes one — with `recursive`, every one missing down to it (`mkdirOps`) —
and `rmdir` removes an empty one, each a commit that takes a version; a
write, an append, a `copyFile` or a rename into a directory that does not
exist is `ENOENT`, as in `node:fs` — `writeFiles` makes the directories
its files lack, in its commit (`parents`), and a `cp` of one file makes
them first, where nothing is in the way, as `node:fs` `cp` does
(`storeWrite`, `fs-copy.js`); `unlink` of a directory is
`EISDIR`, `rm` of one without `recursive` the `ERR_FS_EISDIR` `node:fs`
throws.** _Why:_ a path that is both lets `/f.txt` and `/f.txt/x` exist —
a structure no filesystem has, for which listings, `stat`, subtree
operations and a later copy to disk have no consistent answer. Explicit
directories are what `node:fs` gives: an empty one exists, `mkdir` then
`readdir` lists it, and a write into a missing one fails rather than
making it. Per-key ordering lets mutations of different keys overlap, so
the published tree
alone cannot decide; locking every ancestor would serialize all writes of
a directory, while a set of keys in flight costs nothing when nothing
conflicts. Scanned for a key below the one checked, the keys in flight
made every check linear in their number: with a set of 8000 in flight, a
second set of 8000 took 99 ms instead of 20, and 500 writes 15 ms
instead of 3 — indexed, 16 and 3.

**A write's flag reaches the store: `w…` replaces, `a…` appends, `x` is
`{ exclusive }`, checked in the key's turn like the hierarchy; a flag a
store cannot honor (read, numeric) is `ENOTSUP`. A copy's `COPYFILE_EXCL`
and cp's `force: false` / `errorOnExist` are that same exclusive write.**
_Why:_ exclusive creation is how callers avoid replacing a file; checked
before the queue, it would not be exclusive.

**`writeFiles` publishes a set of files of a virtual place as one
accepted mutation, with the directories they lack: its arguments are
checked when it is called; its keys
are locked in one step (`MutationQueue.run` with every key); in their
turn, before any file is prepared, the whole set is checked — against the
place and the keys in flight as a write is, and against itself: a key
below another key of the set is `ENOTDIR` (`ancestorIn`); then its keys
count as files in flight (`createAll`) while each file is prepared once,
in the order given. A `sab` place publishes the set in one epoch of the
kernel (`publishVirtualBatch`), one file after another, and commits it
once — one `vfs-update`, one version, one event, one mtime — or abandons
it (`#abandon`): what its files staged goes back to the pool. A `map`
place prepares every file and builds its bytecode before its tree
changes, then commits the set at once (`publishBatch`). Refusals are the
set's: `syscall`
`writeFiles`, `path` the key's. A disk-origin place refuses a set
(`ENOTSUP`); a set has one flag and no removal.** _Why:_ files that only
work together — a route table and its handlers, a page and its assets —
must never be seen apart, by any thread, and a series of writes publishes
each alone. The tree-at-flush already makes an epoch invisible until its
commit, so a set is one epoch more, not a transaction of its own. Keys
locked one by one would hold some while waiting for others; the barrier
of the place would stop writes of keys the set does not touch. Checked
whole first, a set refused by its hierarchy runs no preparer. Its keys
are checked against each other by their ancestors, in the depth of a key;
put in `creating` while they are checked, a key of the set would refuse
another as its directory or as its file, whichever came first. Files
prepared one at a time let a failure stop the rest, and nothing stage
after the set is abandoned. The disk has no commit of a set of files to
offer.

## Trees of client ids

**A tree of client ids is a tree of the engine whose structure an
application's source gives — the pages of a site, a catalogue — rather than
a directory: its ids, names, classes, policies and payloads are the
source's. It is declared in the config (`trees.<name>`), made empty by
`initialize()`, carried by every snapshot, read in every thread through
`kernel.tree(name)` (`ClientTree`, `lib/client-tree.js`) and written only by
the batches of its source, which the intake of the main thread
(`lib/intake.js`) applies in the order of their numbers. Its bytes lie in
the pool of the places, under the same books — pins, retirement,
ACK-before-free, compaction; it has no path, no disk and no `node:fs`
surface.** _Why:_ the engine had such trees from its first stage — `put`
and `remove` by id, `load` of a whole state, a class per node, a policy
checked on the way down — and an application that keeps a URL tree beside
its files would otherwise build a second pool, a second protocol and
second books of frees. Declared in advance, a tree is known to every
worker from its snapshot and checked with the config; a tree made at run
time would need a message of its own and a lifetime per tree, and nothing
asks for one. What a source provides — batches, numbers, a log, a
snapshot — is [external-sources.md](external-sources.md).

**`trees.<name>`: `ids` (`'number'` or `'string'`, required),
`containers`, `birthtime`, `aggregates`, `maxNodes`, `maxFileSize`
(`defaults.memory.maxFileSize` unless given), `compress` (as a place's, by the extension of a node's
name, without `retainRaw`), `zeroCopy` and `intake: { seq, window, limit,
gapTimeout, spaceTimeout }` — `'source'`, 10 ms, 10 000 ops, 2 s, 2 s by
default. A tree takes no name of a place, in any case. The handlers of an
intake are kernel options of the main thread, `trees: { <name>: { onGap,
onError } }`, both required: `initialize()` refuses a tree without them.
What a handler throws is its own — an uncaught exception, as from any
emitter — and never stops the intake.** _Why:_ one name names one owner
of shared bytes — in the books of compaction, the records of retirement,
diagnostics. Functions cannot cross to a worker in the config, which
structured clone carries; a gap has no caller to tell, and a refusal
nobody receives is lost.

**A node is the engine's and opaque: the facade hands it out and takes it
back, and `payloadOf(node)` is a frozen `{ version, size, mtimeMs,
birthtimeMs?, meta, scriptOptions, encodings }`. A `Representation` never
leaves the facade: bytes come as a copy (`read`, `readCompressed`), a lease
(`view`, `viewCompressed` — `{ view, version, release, [Symbol.dispose]
}`, with `zeroCopy` only) or a stream (`createReadStream`,
`createReadStreamCompressed`), each pinned while it reads, by the
thread's `Pins`, as `PlaceFs` pins. A closed kernel refuses every call
with `ERR_VFS_CLOSED`, a broken worker view with what broke it.** _Why:_ a
representation's `data` is a view over shared memory without a pin: kept
past its free, it would read whatever the pool put there next. The
stream, the range it reads and the refusal of a closed kernel are the
facades' common code (`lib/views.js`).

**The intake numbers a batch as its mode says: in `'source'` the source
does — densely, in the order it commits — and a number applied or
waiting already is a repeat (`'duplicate'`), so a worker's batch and the
same change read back from the source's log collapse; in `'intake'` the
intake numbers batches as they arrive, for a single writer over one
channel that loses nothing. In `'source'` mode nothing applies before the
first load — an empty source loads `[]`; in `'intake'` mode an empty tree
starts with the `put` of its root. Batches gather for a window; at its end the
continuous run from `last + 1` goes in parts of at most `limit` ops — a
batch is never cut — and each part is placed, then committed batch by
batch in one synchronous step, every commit with the kernel's next
version, and published as one `vfs-update`: the tree's deltas in order
and the numbers they show, `seq: { from, to, loaded }`. The next part
goes after a turn of the event loop. A batch's bytes are placed when its
part is, not at `submit`; the first batch of a part waits for room in the
pool, up to `spaceTimeout`, and a later one that finds none ends its
part, so the batches before it publish first.** _Why:_ one publication
for a run keeps every thread from seeing a state between two of its
batches and costs one update and one round of ACKs for all of them; the
limit bounds the synchronous step a run takes from the main thread.
Batches that wait hold no bytes, and a catch-up after a break does not
allocate its whole tail at once. What the batches before a full pool
replace is retired by their publication — it may be the very room the
next one needs, which waiting before them would never see.

**A batch past a gap waits; a gap older than `gapTimeout` is told once,
`onGap({ from, to })`, and lasts until the missing batches come or a
load. A refused batch — a commit's refusal, a payload larger than
`maxFileSize` (`EFBIG`), no room for `spaceTimeout` (`ENOSPC`) — is told
to `onError` and rejects its promise, with its `seq`, `index` and `id`;
the batches before it publish, and it holds everything after it until a
load. `load(rows, seq)` replaces the whole state in one commit: the
batches waiting up to `seq` are `'superseded'`, those after it join its
publication, and in `'source'` mode a load older than the tree is
`ESTALE`. A load that
fails leaves the tree as it was: in `'source'` mode the batches go on by
their numbers; in `'intake'` mode those the writer submitted after it
were made for its state, and wait for a load. A batch that changes
nothing publishes nothing — no delta, no version, no event — and its
update moves `last` in every thread: the tree shows it too.** _Why:_ the
numbers are the order of the source's commits, and a batch applied out
of it would build a state the source never had; a source finds a lost
batch by its gap, and the loss of its last one by comparing its counter
with `last`. A refusal past which batches went on would leave the tree in
a state the source never had either: only the source's snapshot repairs
it.

**A worker's `submit` and `load` are checked at once, as on the main
thread (`EINVAL`), then sent over its link as a `vfs-mutate` naming the
tree, every payload's bytes copied and transferred; the answer comes
after the publication, so the worker's replica shows the batch by the
time its promise resolves. A replica applies the deltas of a tree in an
update in one step, with those of the places, and takes `seq.to` for its
`last`.** _Why:_ a port delivers the update before the answer, which
gives read-your-writes for the writer's own batches with no wait of its
own; a batch from another process reaches the threads in a publication
like any other, and how a thread waits for one is the interface of a
client that has several processes.

**A tree's publication goes through the tail of the places': what a
commit placed is committed, what it took back freed at once, what it
retired recorded — by `#<id>`, a node a commit kills having no key after
it — and the books of compaction follow its `placed`. The `'publish'`
event carries `trees: [{ tree, seqFrom, seqTo, loaded }]`, always an
array, empty when a publication touched no tree; `loaded` says it began
with a load, which replaced the state whole. A compaction relocates a
tree's representations by id, in a commit of its own that keeps their
versions; its update carries `seq: null`, and no event.** _Why:_ one
path for every publication keeps ACK-before-free, pins and compaction
the same for files and nodes. A consumer that caches by id drops
everything after a load, a range otherwise; an entry of an object leaves
room for the ids a publication changed, without a change of protocol.

## Routing and strict mode

**The router decides, the adapters execute; `fs-patch` (with `fs-copy`,
`fs-dir`) and `module-hook` never read the config.** _Why:_ one chokepoint,
uniform across sync, callback, promise and guarded APIs.

**Containment is lexical: only a real `..` component leaves `appRoot`; the
router never stats or resolves the paths it routes.** _Why:_ `..private` is
a legal name and must route like any other; the router sits on the hot
path of every fs call. What only the disk knows about `appRoot` itself —
its real path, what a drive letter names — it learns once (`aliases.js`,
below).

**Containment is what `path.relative` says, computed from the strings:
`appRoot` and a separator are a prefix of the path, on Windows after the
lower-casing `path.win32.relative` applies to both; the part below is
sliced from the path as given, and the registry matches a place's name in
it by its own rule (below). What `path.relative` treats apart it answers
itself: a lower-casing that changes a length (`İ`), where it compares
segment by segment, and, on Windows, a root or a path off a drive —
`path.relative` resolves both paths again, which a UNC or namespace path
may not survive (`\\?\C:\app\..\..` resolves to `\\?\`, that to `D:\?`),
and trims their leading separators (`\\C:\app\x` is `x` under
`C:\app`).** _Why:_
`path.relative` was most of the cost of a routing decision; the prefix
gives the same answer, and a differential test holds it to `path.relative`
for both path flavors on every platform (`Containment` takes `path.win32`
or `path.posix`). A path on a drive is what `path.resolve` keeps as it
is, so the strings compared are the ones `path.relative` compares; a UNC
or namespace `appRoot` routes at the speed it had before.

**A place's name is compared as the platform's file systems compare names,
decided once, by the path flavor: on Windows without the case of ASCII
letters — `appRoot\RO\x` is place `ro`, as `appRoot` matches in any case —
elsewhere exactly, as before. The exact name is looked up first; another
case costs only a path no place owns by its own name. A key keeps the case
it is given, and an error names the path as the caller spelled it.**
_Why:_ one file must have one route: Windows took `appRoot\RO\…` for a
path no place owns, which strict refused and, without strict, passed
natively to the disk — the raw file instead of its prepared content, a
file `fs.fallback: 'deny'` hides, a write into a read-only place. Place
names are ASCII and unique in any case (`VfsConfig`), and NTFS equates no
other character with an ASCII letter, while lower-casing takes the Kelvin
sign `K` for `k`: a name matched so would route an unmanaged directory
under `appRoot` into a place — under strict, native reads and writes
there. The other platforms keep their case-sensitive routing; a
case-insensitive volume there (macOS by default) is not recognized.

**On Windows a UNC or namespace path — two separators first
(`\\server\share\…`, `\\?\…`, `\\.\…`) or `\??\`, with `/` for `\`, or a
relative path through a cwd on a share — lies below `appRoot` only when
`appRoot` is itself given in such a form. Outside it, a registry built
for strict owns it to nobody, which strict refuses like any path no
place owns: `EACCES` before any native I/O, whatever it names. The check
reads the first characters of the path as `path.resolve` gives it, which
routing computes anyway (`namespaced`); without strict nothing asks, and
such a path passes through as before. The module hooks get the same
answer (`\??\` reaches them resolved, as `C:\??\…`, which no file name
can hold); a UNC server named like a drive (`\\C:\app\x`), which
`path.relative` puts below `C:\app`, is owned by no place.** _Why:_ one
file has many Windows spellings, and containment compares strings:
`\\?\C:\app\place\hidden` or `\\localhost\C$\app\place\hidden` lay outside
`appRoot` and passed through natively under strict — a file the place
hides, the raw file of a prepared one, a write into a read-only place, a
module loaded through a share. Refusing the forms is what a lexical router
can guarantee; which file a share or a namespace names is the operating
system's to say, and no list of aliases is complete. Only strict asks,
so without it the route outside costs nothing more.

**On Windows under strict a path with NTFS stream syntax — a `:` past the
colon of its drive, in the path as resolved, or in the part below a UNC or
namespace `appRoot` — is owned by nobody, below `appRoot` or not: `EACCES`
before any native I/O, not found for the module hooks. Without strict
nothing asks. The `PlaceFs` facade takes no key with a `:` for a file of
its disk territory, in either mode.** _Why:_ no file name holds a `:`;
Windows opens a stream of the file or directory the name before it names,
and its main stream is that file itself. `appRoot\place\a.txt::$DATA` in a
place with `fs.fallback: 'disk'` read the raw file of a cached, prepared
extension — its extension taken as `txt::$data` — and
`appRoot::$INDEX_ALLOCATION\place\hidden`, outside `appRoot` to the
strings, read what the place hides. Which stream a name opens is the file
system's to say; the syntax is what the strings show, and refusing it
costs one search of the path. The facade's rule — a cached extension is
never read from disk — holds in either mode, so it holds against a stream
too. A relative `x:stream` is a path on drive X to `path.resolve`, and to
Windows.

**On Windows under strict a name in the form of an 8.3 short name — a
base of at most eight characters ending in `~` and digits, at most three
after one dot (`PROGRA~1`, `INDEX~1.HTM`, `AB12CD~1`, in any case) — is
owned by nobody below `appRoot`, and at the first name where a path on
`appRoot`'s drive leaves `appRoot`'s own names (compared as `Containment`
compares them). Past a name that differs from `appRoot`'s, and on another
drive, it passes. `appRoot` given with short names routes the paths
spelled as it is. The `PlaceFs` facade takes no file name of that form
for a disk file, in either mode.** _Why:_ NTFS resolves a short name to
any long name of its directory, and which one only the disk knows:
`…\Temp\SMFS-A~1\place\hidden` — `appRoot` by its short name — lay
outside `appRoot` to the strings and read what the place hides, wrote
into read-only places and loaded raw modules, and `INDEX~1.HTM` in a
place with `fs.fallback: 'disk'` read the raw `index.html`, its extension
taken as `htm`. A short name at the name where a path departs from
`appRoot`'s spelling may be the short name of `appRoot`'s own name there;
past a name that differs, the path lies in a directory that is no ancestor
of `appRoot`, where a short name names an entry of its own — so
`C:\Windows\SYSTEM~1` passes while `C:\PROGRA~1` does not when `appRoot`
lies below `C:\Users`. Below `appRoot` any short name may stand for
another key. The form is what the strings show: a long name in it is
refused as well, and a path with no `~` costs one search. The volume
decides whether short names exist at all, so the rule does not ask.

**On Windows under strict no mutation of the `PlaceFs` facade takes a key
in either spelling — NTFS stream syntax, or a name in 8.3 form, anywhere in
the key (`foreign` in `place-fs.js`) — in any place: `writeFile`,
`appendFile`, `writeFiles`, `unlink`, `mkdir`, `rm` and `rename` are
`EACCES` once the key is valid, before the place's own checks.** _Why:_ the
facade takes keys, not paths, so the router never sees them, and
`writeFiles` reaches a virtual place past every path: a key no strict path
can name would be an entry `node:fs` under strict never reads. On disk the
same key is the spelling the router refuses — a stream of a file, the file
an 8.3 name resolves to. Reads keep the facade's rule for disk files
(above); a virtual place holds exact keys, so a read of such a key finds
nothing strict could have written.

**Under strict the registry learns two things from the disk, each once,
through `realpath.native` captured at load (`aliases.js`): `appRoot`'s real
path, when the kernel is built, and on Windows what a drive letter other
than `appRoot`'s names, the first time a path on it is routed. Where the
real path differs from `appRoot` as spelled — `appRoot` through a link, a
subst drive, a namespace or 8.3 names — it is a second spelling: a path in
or below it is owned by nobody, a directory above it encloses the places,
and a short name where a path leaves it may stand for it — a name of
`appRoot`'s own 8.3 spelling at that position is `appRoot`'s, and a path
that mixes the two spellings is owned by nobody. A drive whose
root resolves to a UNC or namespace path (a mapped drive), or onto
`appRoot`'s real line — `appRoot`, above it or below it (subst) — is an
alias whole: every path on it is owned by nobody. A letter that names
nothing is asked again; an answer is kept, so a drive mapped anew after it
is not seen. A failure other than a missing path is thrown when the kernel
is built, and makes a drive an alias.** _Why:_ `subst P: appRoot`, a
`net use` of its share — which needs no elevation for the admin share —
and the real path of an `appRoot` given through a junction or a subst
drive read what the places hide, as did the long spelling of an `appRoot`
given with short names: they lie outside `appRoot` to the strings, and
which directory a letter or a link names only the disk knows. Held to the
real spelling alone, a sibling of an `appRoot` given with short names,
spelled as it is (`…\RUNNER~1\…\Temp\other`), left it at `RUNNER~1` and
was refused, though it names nothing of `appRoot`; a path that takes each
name from one spelling or the other (`…\runneradmin\…\Temp\SMFS-A~1\…`)
leaves neither and names `appRoot`, so it is refused whole. Asking once
keeps the router off the disk on its hot path: a Map lookup per path on
another drive, a containment check where `appRoot` has a second spelling.
A drive is asked when first used, not when the kernel starts: auditing
every letter at start would touch every mapped drive — its server —
whether the application uses it or not, and one that is disconnected
stalls on its timeout. A share names what its server says, so a drive
mapped to one is refused as the share's own UNC paths are; for the same
reason the local path behind a share of this machine (`C:\…` behind an
`appRoot` on `\\localhost\C$\…`) is not recognized.

**Under strict a native route on a place's disk — the disk territory of
`fs.fallback: 'disk'`, a `disk` or `node-default` place, a disk-backed
entry, a disk-origin write, the raw source of a copy — names its place
(`{ kind: 'passthrough', place }`), and the kernel's route API checks it
by the place's `links` before it hands the route on (`VfsKernel#proven`).
`links` belongs to a place with a directory on disk, over
`defaults.links`, and is `'deny'` by default: the kernel keeps an index of
the links strictly below each such place's directory (`LinkIndex`,
links.js) — met by the scan at `initialize()`, or found by a walk that
enters no link (`scanner.linksOf`) where no scan runs, and added by the
watcher (`noteLinks`) — and a route whose path passes through a known
link, wherever it leads, is `EACCES` (`#crosses`). The place's own
directory is never indexed: it may be a link out of `appRoot`, its own
disk (below). `'verify'` proves each route (below).** _Why:_ the proof
costs a `realpath` per native call — tens of
microseconds on Windows, more than many of the calls it guards
(doc/benchmarks.md) — against what only a link can do; the index answers
an ordinary path with a few lookups in memory and no disk call. What the
index cannot see is a link made past the patch before the watcher reports
it — by another process, in a place no watcher runs for: that is the
environment owner's part, documented as outside the guarantee, and
`'verify'` stays for a directory others write into. Without a `realpath`
the index cannot tell a link that stays in the place from one that leaves
it, so it refuses every known link. The name follows `fs.fallback:
'deny'`. There is no `'allow'`: no scenario needs a link followed unchecked
under strict, and without strict nothing is asked.

**The index is asked about the path as the OS gets it — on Windows as
`node:fs` resolves it first, a drive-relative or root-relative one
included; on POSIX as given — name by name, each name before a `..` after
it applies (`LinkIndex.crosses`), without case on Windows and macOS —
as their disks compare names, a final sigma as a sigma (`foldName`); a
call that does not follow its last name — `lstat`, `readlink`, the `l*`
forms, and the routing of `unlink`, `rmdir`, `rm`, `rename` and the path a
`symlink` makes — leaves that name out (`own`), but not with a trailing
separator, `.` or `..` after it. The index asks no disk and only grows: a
known link stays refused until the kernel restarts, even once removed or
replaced by another process. A link is an attribute of its path that
holds down it, kept in a trie of names (`PathTrie`, lib/rules.js) as a
place's rules are: a directory with no known link below has no node,
and ends the check.** _Why:_ POSIX resolves `link/..` through the link,
and the platforms resolve a last name's `.`, `..` and trailing separator
differently, so they follow it. A key built from the path as given missed
the OS's own reading of it (`C:d\jro\…`, `\Users\…\jro\…`).
Lower-casing alone kept `λογος` and `λογοσ` apart, which NTFS equates:
a link so named was crossed unseen. Nothing in the
process changes a link on a place's disk (next), so there is nothing to
forget but what another process removed — which only refuses more.

**Under strict xvfs makes, removes and moves no link it can see on a
place's disk, in either mode — through the patch, and through the
`PlaceFs` facade of a writable disk-origin place (the kernel hands it the
same checks): `symlink` and a hard `link` there, a `cp` of a link into it
without `dereference`, an `unlink`, `rmdir`, `rm` or `rename` of a link
there or a `rename` onto one (its `lstat`: `kernel.touchesLink`,
`movesLink`), a `rename` into a place of a tree from outside `appRoot` that
holds a link (a walk of it; a tree it cannot read is refused too), and —
with `'deny'` — a `rename` or a recursive `rm` of a directory under which
the index knows a link, are `ENOTSUP` before any native call
(`kernel.makesLink`, fs-patch). Nor does it remove or move a tree through
one: a recursive `rm` or `rmdir` of a directory, or a `rename` of one,
goes only where its real path — for a rename, its destination's too — lies
in the place's directory (`VfsKernel#inPlace`: `Aliases.territory`,
`placed`), in either mode; a link named with a trailing separator is the
link (`disk.leafStats`). What it sees is a link's `lstat`, a directory's
`realpath` and the index: a link swapped in between the check and the call
is not seen.** _Why:_
no confirmed consumer makes links in managed territory through the patch —
installs, release switches and log links run in their own process or
outside `appRoot` — while keeping an index true under the process's own
changes took a counter in shared memory, messages both ways between the
threads, a walk of the disk while one was in flight, and still left a link
made or dropped mid-call to chance. A link the process cannot make, the
index need not follow. The `lstat` of a removal or a rename is one disk
call on a mutation, never on a read; it also catches a link the watcher
has not reported yet. With `'verify'` the index knows nothing, and a
directory holding a link moves or goes: every call through the link is
proven anyway. A tree is another matter: a recursive removal through a
link out of the place — `link/sub`, `link/` (POSIX `lstat` follows a
trailing separator, and Node 24's native `rm` then empties the target),
`link/../x` on POSIX — deleted a tree outside managed territory, which
`'verify'` let through as reaching what a path there reaches anyway and
`'deny'` saw only for a link it knew. A directory renamed through a link
moved a foreign tree in past the move-in walk, or took its own links out
of the place — `d/sub` holding `jro` → `ro`, moved to `d/jl/moved`, read
what `ro` hides. Both modes pay the `realpath`: a `disk` or `node-default`
place has no watcher, so its index knows the links of `initialize()`
only. Only a directory is held so — a file through a link is what a path
there reaches, a missing path removes nothing (`rm -rf` stays an idiom) —
and one through a link that stays in the place is the place's own.

**Every thread keeps its own index: a worker's comes in its snapshot, with
the main index's generation — how many links it has come to know — and
each link the main kernel's watcher finds after reaches the linked workers
as `vfs-links { add, generation }`, one way (`#learnLinks`); a worker
applies one newer than what it holds (`#heardLinks`).** _Why:_ a worker's
kernel never runs `initialize()`, so it knew no link; the watcher runs on
the main thread only, and a link it reports would stay open in the workers
already running. Nothing flows back, nothing is dropped, and a message no
newer than a worker's snapshot — a duplicate, a late one — changes
nothing. A worker kernel made from a snapshot without a port knows what
the snapshot held.

**With `links: 'verify'` the kernel's route API asks the disk where the
path really lies before it hands the route on (`VfsKernel#proven`,
`Aliases.territory`): `realpath.native` of the path as
the OS opens it — not `path.resolve`'s, whose `..` is folded before a
symbolic link is resolved (`Aliases#absolute` keeps it, so the disk
resolves `..` from the real directory, as the POSIX kernel does; Windows
node:fs folds `..` before the syscall, and realpath.native alike, so
nothing there changes) — for a path to create, of its nearest existing
ancestor with the rest after it — and, once, of the place's directory. A
path that `path.resolve` puts outside `appRoot` but that descended into it
before a `..` climbed out (`d/link/../../x`) the lexical router owns to
nobody (`PlaceRegistry#climbsOut`, POSIX under strict), since a symbolic
link on that name would send it back in. In the place's directory, or off
`appRoot`'s real line and on no share or namespace path, the route holds —
in the disk territory of `fs.fallback: 'disk'` only where the real name
has no extension the place caches: a link names a cached file another way
(`t.bin` → `t.txt`), and the territory never serves one raw; anything else
is `EACCES` before any native call, as is what realpath cannot answer. `PlaceFs` asks the same of its disk territory, its
disk-backed entries and its disk-origin mutations, and the load hook of a
module of a `node-default` or `disk` place. A recursive listing of such a
disk walks one directory at a time and enters no link
(`disk.readdirSyncBelow`); a recursive `cp` of or into any place's disk is
`ENOTSUP`. FsRouter stays lexical: the proof is the kernel's.** _Why:_ a
junction needs no privilege on Windows, and a link inside a place's disk
— an extracted archive, a deployment's shared directory — took a native
read, write, listing or `require` into another place, a hidden file, a
read-only place or above `appRoot`. The router's string answer covers the
path's top, which is where the link is not. A link to elsewhere reaches
what a path there reaches anyway, so it is followed — but for a tree
removed or moved through it (above); refusing every link out of the place
would break the shared directories a release links in.
`node:fs`'s own recursive `readdir` enters a junction even with
`withFileTypes` (Node 22 to 26 on Windows) and its `cp` copies what a
junction holds, so neither walks a place's disk under strict; `opendir`,
`rm` and a recursive `watch` enter none. Node's resolvers take a module's
real path — through the patched `realpath`, which refuses the link — but
not with `--preserve-symlinks`, which the load hook covers. The ops that
act on the link and not its target — `lstat`, `readlink`, `unlink`,
`rmdir`, `rm` — are refused too, though `node:fs` would touch nothing the
link hides: the proof resolves the whole path, so it cannot tell them from
a call that follows the link. A call that does not follow the last
component could be proven by its parent's real path plus the leaf name, so
that such a link can be seen and removed through the patch; the leaf's
`.`, `..` and trailing-separator forms, which the platforms resolve
differently, would each need to fall back to the full proof, so with
`'verify'` the boundary stays fail-closed for now (TASKS.md); `'deny'`
knows a link by its name and lets them through. A native call on a place's
disk pays one `realpath` for a file, two for a directory listing or a path
being created, three for a single `cp` or a `require` of a disk-place
module, and one per directory `glob` walks; a recursive `readdir` pays one
where it starts and walks below without following links (tens of
microseconds each on Windows; doc/benchmarks.md). A link swapped in
between the answer and the call is not seen, as no path-based check can
see it.

**A place's directory is its own where its real path lies off `appRoot`'s
real line — a link out of `appRoot`, a media store elsewhere — or at
`appRoot`'s real path and the place's name. Under strict one that resolves
anywhere else on that line — another place, `appRoot`, a directory above
it — is a configuration error: `initialize()` rejects
(`[vfs config] places.<name>: …`) before anything is read
(`VfsKernel#homed`, `Aliases.misplaced`), and the proof takes nothing as
that place's own (`Aliases#owns`).** _Why:_ the proof asked where a path
lies against the place's real directory; a place `dj` whose directory was
a junction to `ro` had `ro` for its own, so native calls read what `ro`
hides and wrote into it, and a disk-origin place so linked scanned and
watched `ro`'s files under its own keys. A place's directory is the
deployer's configuration, not a path code under strict can make (no link
into managed territory is created through the patch), so it is refused as
configuration, where it is found, once.

**Under strict the patch makes no link to managed territory
(`kernel.linksInto`): a `symlink` whose target, resolved from the link's
directory as the OS resolves it, names — by its real path — a place,
`appRoot` or a directory above it, and a hard `link` whose source so
names one, are `EACCES` before any native call, a link within one place
included. The target keeps its `..`: resolved from the link's directory
but not folded lexically, so the disk resolves `..` past a symbolic link,
and its real path (`Aliases.real`) decides — a target realpath cannot
answer is refused. In either mode a symbolic link's target is routed as a
read from the link's directory, where it was routed from the cwd.** _Why:_
a junction takes no privilege, so any code under strict could make itself
a path outside `appRoot` into a place, `appRoot` or a directory above it,
past every lexical check; a hard link to a file of a read-only `disk`
place gave it a writable name in a writable one. What a link names is
what a read through it reaches, so its target is routed where the OS
resolves it — `..` and all, since `d/link/../secret` follows the link on
POSIX. A link within one place is refused too: which names of a
place's disk may alias which is the place's to decide, not the code
running under strict.

**A link that already leads into `appRoot` from outside it is not
covered: its path lies outside `appRoot`, where strict asks nothing.** _Why:_
every system has such links — Windows' own junctions (`C:\Documents and
Settings`, `%USERPROFILE%\Local Settings`, `AppData\Local\Application
Data`) reach any `appRoot` below the user profile, `/proc/self/root/…` and
`/proc/self/cwd/…` any `appRoot` on Linux — and a hard link has no other
spelling at all. Covering them would ask the disk for every native call
outside `appRoot`, the hot path of everything else the application does;
strict is a routing policy, not an OS sandbox.

**A path already in the form `path.resolve` returns is taken as it is: a
drive letter, `:` and `\` on Windows (UNC paths are resolved), `/` on
POSIX, alone or then names none of which is empty, `.` or `..`, no
trailing separator, and no `/` on Windows.** _Why:_ most paths the router
is handed come from `path.join` or `path.resolve` already, and
`path.resolve` was most of what a routing decision still cost; a fuzz test
holds the check to `path.resolve` for both path flavors
(`resolvedFor()`): what it takes, `path.resolve` gives back, and every
path `path.resolve` gives on a drive it takes.

**A trailing separator names a directory, as on POSIX, on every platform
for what a place serves or stores: the router answers `ENOTDIR` for a
served file named so; a store route keeps the slash on its key, so a file
write is `EISDIR` and `unlink`, `rm` and `rename` hand `{ directory }` to
the store, which checks it when the mutation runs. What passes through
keeps the rules of `node:fs` — on Windows, a trailing separator is
ignored.** _Why:_ the VFS answers the same on every platform, and a path
that names a directory never reaches a file. Checked in the mutation's
own turn, a directory-form `rm` never takes a file written meanwhile.

**A module specifier that names a directory — a trailing `/`, `.`, `..` —
resolves as one only, as Node's resolver does: `require` skips
LOAD_AS_FILE, `import` finds no module; `resolveModule` never takes a path
ending in a separator for a published file.** _Why:_ `require('./lib/')`
must load `lib/index.js`, never a sibling `lib.js`; Node's ESM resolver on
Windows would hand the hooks `x.mjs/` as a file, which the VFS refuses as
on POSIX.

**Strict mode is a routing policy, not isolation.** _Why:_ code can reach
the OS by other means (native addons, child processes, its own hooks) and
worker threads share one process; isolating untrusted code needs OS-level
boundaries.

**Under strict, `appRoot` itself is a managed root: it lists the enabled
places (`readdir`, `opendir`), stats as a directory and refuses native
access (`watch`, writes).** _Why:_ passing the root through listed the
names of unmanaged entries.

**`fs.fallback` belongs to disk-origin places and is always explicit once
resolved: `'deny'` under strict, `'disk'` otherwise.** `'deny'` serves
published canonical entries only; `'disk'` also serves, from disk and inside
that place only, the files its cache filters do not select, and merges them
into listings (the facade serves the same territory). Cached extensions stay
VFS-only under strict; module hooks never fall back. `fs.fallback` governs
reads only: mutations follow `fs.writable`, and a disk write reaches the VFS
only through the watcher — a file outside the cache filters never enters
SAB. A place without a finite `fs.ext` caches every file and has no disk
territory of files: there `'disk'` means the permissive reads of the
non-strict default and is accepted as input — a resolved config is valid
input — while under strict it is a config error, since nothing would be
served from disk and `'deny'` is what the place would do; resolving it to
`'deny'` silently was rejected, as was accepting it (it would list disk
directories the routing then refuses). Its disk territory is a
route of its own (`'disk'`): native for reads, but a listing (`readdir`,
`opendir`) is always the place's — disk directories and uncached files
only, cached extensions from the published collection — even for a
directory that exists only on disk. _Why:_ partial disk caches — html and
js in SAB, media from disk — under strict routing, without a raw file ever
standing in for canonical (prepared) content or an unpublished version; a
native listing of a disk-only directory showed such raw files. The
non-strict default keeps its permissive reads.

**A path through a file a place serves to the fs domain is `ENOTDIR`, as
`node:fs` answers it — through the patched `node:fs` and the `readdir` of
the facade: `Tree.match` names the node a path broke off at
(`Place.throughFile`), one walk, on a miss alone. Past a file the domain
does not see, the place answers as for any path it does not serve.**
_Why:_ `stat`, `readFile` and `readdir` of `a.txt/x` said ENOENT, or
EACCES under strict, where `node:fs` says ENOTDIR; a file the domain sees
is no secret, one it does not see must not show through the code.

**A key keeps its case — in the tree, in keys, in errors. Where the disk
would answer a miss — the non-strict `'disk'` fallback, and Node's own
loader behind the module hooks without strict — a path naming a published
source held in memory in another case answers as that source's own
spelling does. On Windows a disk-origin place keeps, as an index, the
lower-casing of each source key that has capitals (`Place.spelling`),
kept from what each commit created, removed and moved (`Place.spelled()`)
— on the main thread, in a worker from its update, in a map place from
its own commits; the exact key is looked up first. A disk-backed entry
is read from disk by the name given, as before; a directory in another
case is no published directory (`'disk'` lists its disk territory there,
`'deny'` refuses it); V8 cached data is looked up by the key as spelled; a
virtual place keeps exact keys. Strict refuses another case like any path
the place does not publish, and `'deny'` always does.** _Why:_ the tree
compares names exactly, a Windows disk does not: without strict, `A.TXT` of
a published, prepared `a.txt` went to the disk — its raw content, a
descriptor to it, a native watch — and `require` loaded the raw module.
Lower-casing equates whatever NTFS does and a few characters more (the
Kelvin sign), where published content then answers for another name —
never raw bytes: a disk-backed entry, read by the caller's name, is never
taken for another spelling. Under strict nothing is looked up: cached
extensions never fall back there. A virtual place is a filesystem of its
own: another case of a key is another key, as its mutations take it.

## Patched `node:fs`

**One rule decides what a native `node:fs` operation may do: it runs only
once every path it touches has been routed.** A single-path operation runs
after the routing of its source and destination allows it; a copy or a
rename hands on the source's raw input — never a prepared result or a
derived representation — and the destination publishes it through its own pipeline; a
recursive or compound operation whose routing could check only its top path
is refused; a virtual destination is never changed by a native disk
operation; a recursive operation from outside `appRoot` is refused when its
walk would enter `appRoot`; unrelated paths outside `appRoot` stay native.
What the kernel cannot guarantee fails with `ENOTSUP` before anything is
read or written. _Why:_ every bypass found had one shape — a native
operation checked one path, then read, listed or changed many: `opendir`
listed hidden files, a recursive `cp` of a place or of a directory above
`appRoot` carried denied files out, `copyFile` into a virtual place left a
stray disk file, a directory `watch` reported hidden names, a recursive
`rm` from above deleted read-only places, a `rename` gave a hidden file a
readable name. A rule per shape closes the class, not the instance.
`ENOTSUP` keeps the contract honest until a VFS-aware implementation exists
(`TASKS.md`); an approximation such as `cp` with a `filter` would still copy
raw bytes and miss virtual entries.

**Every path-taking API is in one of three groups.**

- _Implemented_, served by the places: `readFile`, `stat`, `lstat`,
  `access`, `realpath` (its `.native` variants too), `existsSync`,
  `readdir`, `opendir`,
  `createReadStream`, `openAsBlob`, `writeFile`, `appendFile`, `unlink`,
  `mkdir`, `rmdir`, `rm`, `rename`, `copyFile` and a non-recursive `cp`.
- _Recognized but unsupported for managed territory_ (`ENOTSUP`): `open` of
  a virtual entry, whatever its flags; a copy or `rename` of a prepared
  virtual entry, a copy of a place directory; a recursive `cp` of or into
  managed territory; a hard link into or out of a place; `watch` of managed
  territory; recursive walks (`readdir`, `opendir`, `watch`, `rm`, `rmdir`)
  and `rename` of a tree that holds places; a directory renamed across a
  place's boundary (a place's root included); a virtual directory rename
  with a file below that cannot move as it is; a recursive `rmdir` in a
  virtual place; guarded mutations in a virtual place. A hidden source is
  `EACCES`.
- _Native passthrough outside managed territory_: unrelated paths outside
  `appRoot`, `disk` / `node-default` places, disk-territory files,
  unmanaged paths without strict; `symlink`, its target routed from the
  link's directory; and the guarded APIs (`chmod`, `chown`, `utimes`,
  `truncate`, `readlink`, `statfs`, `watchFile`, `mkdtemp`,
  `glob`, and `open` — or `readFile`, `createReadStream` — with a flag that
  writes) once every path argument is routed.

_Why:_ an application must be able to tell which calls the VFS serves, which
it refuses and which belong to the operating system — and a new API must
join a group deliberately, never by default.

**The patch knows every export of `node:fs` and `node:fs/promises` of the
supported releases, a function an export carries (`.native`) included,
and what it does with each (`lib/adapters/fs-surface.js`): implemented,
guarded, delegated — not wrapped, every disk access it makes going through
patched functions of the public `node:fs` (`createWriteStream` and the
stream classes open through `fs.open`, `exists` asks `fs.access`,
`unwatchFile` makes none) — or path-free (descriptors, handles, classes
over them, constants). Under strict, `install()` replaces any other
function with one that refuses every call before it runs: `ENOTSUP`, the
function as `syscall` (`fs.x`, `fs.promises.x`, `fs.readFile.x`), a
rejection from `node:fs/promises`, a throw from `node:fs`; the function an
unknown accessor gives is refused when it is read, and every function an
unknown function carries with it (`FsRouter.unknown`). Without strict
nothing it does not know changes. What strict cannot hold fails
`install()`, which undoes what it did: an unknown export it cannot
replace, and an unknown object, plain or behind an accessor, which it
reads once to see — a namespace of functions no table knows, as
`node:fs/promises` is one.** _Why:_ Node
adds path-taking functions (`openAsBlob`, `glob`, the disposable
`mkdtemp`, `Utf8Stream`, `realpath.native`, `openAsBlobSync` in 26.10);
one the patch did not know reached the disk past routing — a silent
strict bypass after an upgrade.
Whether an unknown function takes a path cannot be told at run time
without guessing its signature from its name or its arguments, and a
wrong guess is a bypass; the form of its refusal follows its module,
never its name. A test holds the list to the running Node — a release
with a new export fails it until the export is classified — and holds
each delegated export to the patch on a hidden path, so a release that
made one reach the disk natively fails it too. Refusing strict itself on
a Node with an unknown export would stop every strict application for an
export perhaps path-free; refusing the function stops only its callers.
Without strict the routing is a cache policy, not a boundary, and an
application keeps the whole of its Node.

**Every listing comes from the places: `opendir` is implemented, not
guarded — a `Dir` over the entries `readdir` lists, taken when it is
opened, with the `node:fs` close semantics.** That `Dir` is `VfsDir`
(`lib/adapters/fs-dir.js`), a class over the listing that knows nothing of
routing: the patch takes the listing — the strict `appRoot`'s or a
place's — and hands it over. _Why:_ a guarded native
`opendir` was a second listing path: it showed raw disk files a place hides
(unpublished cached extensions, the disk behind `fallback: 'deny'`) and
missed virtual entries. A snapshot keeps it synchronous and simple;
`node:fs` does not promise to show entries changed during an iteration
either.

**`fs.openAsBlob` is implemented, routed as `readFile`: a `Blob` over an
owned copy of the canonical content, `EISDIR` for a directory, and a
rejection for what the patch refuses.** _Why:_ it reads through a native
binding — no `node:fs` function on its way that a wrapper could route — so
unpatched it read what strict hides and the raw file behind a prepared
entry: the one path-taking read of `node:fs` that reached the disk past
every wrapper. A `Blob` copies its source, so a lease could not be released
behind it; the owned copy costs one more copy than a native `Blob`, which
reads lazily. The call is documented to return a promise, so the patch's
refusals are rejections; `node:fs` refuses its own — a missing file —
before the promise today, and the paths it passes through keep that form.
`fs.openAsBlobSync`, which Node 26.10 added, reads through the same binding
and is routed the same way — unpatched, it read what strict hides too: it
returns the `Blob` and throws the patch's refusals.

**`glob` walks with the `node:fs` functions it captured when Node loaded
`internal/fs/glob`; `install()` loads it, so it walks through the patch:
every directory read and stat routed, virtual entries listed, denied
territory never entered. A glob loaded before the first `install()` walks
natively: a walk that starts in or above managed territory — `cwd`, or the
pattern's literal prefix, resolved as glob resolves them — is `ENOTSUP`,
and a start the routing denies is `EACCES` before any walk, in every
mode.** _Why:_ the walk is Node's, and no wrapper changes the functions it
captured. Filtering its results, as before, let a native walk list hidden
names into memory — and hand them to the caller's `exclude` — and made
what an application saw depend on load order: virtual entries with a
routed walk, none with a native one. Loading glob at `install()` gives
every bootstrapped application the routed walk; the native one — a test
runner's, or a glob before the kernel was wired — is refused where the
routed listings apply, as every other native walk into the places is,
strict or not, and stays native elsewhere.

**A single-file copy (`copyFile`, a non-recursive `cp`) hands the
destination the source's raw input, and the destination publishes it
through its own pipeline (`FsRouter.copy`).** The raw input of a
disk-origin place — published, prepared or not — is its raw disk file; of
an unprepared virtual or SEA entry, its canonical bytes; a prepared virtual
or SEA entry has none (`ENOTSUP`); a hidden source is `EACCES` before
anything is read. A disk destination gets the raw bytes — in a disk-origin
place its watcher prepares them — and a virtual one is written through its
store: its preparer runs once and no file appears on disk. Raw on disk into
a native destination is `node:fs` itself. Derived representations are
never copied.
`node:fs` options keep their meaning for one file; one the VFS cannot honor
(`COPYFILE_FICLONE_FORCE`, `filter`, `preserveTimestamps`) is `ENOTSUP`.
Errors name the source (`path`) and the destination (`dest`). The patch
routes both ends and refuses, before anything is read, an option the copy
cannot honor and a `*Sync` copy into a place that cannot block; given the
kernel, the two routes and the two paths, the copy engine
(`lib/adapters/fs-copy.js`) refuses what needs a stat — a symbolic link, a
directory in the way — reads the raw input and writes the destination,
answering the write's `EEXIST` as the copy's options say. _Why:_ the
raw input is what a publication consumes, so the destination's policy
decides the content — copying canonical (prepared) content into a place
that prepares the same extension would prepare it twice, and its bundle may
embed the source key. A prepared virtual entry keeps no raw input: feeding
its canonical content in as raw would silently change what the preparer
sees, and a native copy could not write a virtual destination at all.
Compressed or bytecode representations are derived from the content;
the destination rebuilds its own. Refusing every copy of served content made
the most common operation on a disk-origin place impossible.

**A recursive `cp` stays native at both ends: a source or a destination in
an indexed place — under strict in any place — or one that encloses
`appRoot`, is `ENOTSUP`.** _Why:_ a native walk reads raw files past the
filtered listings, misses virtual entries and writes a destination's files
behind its store; a recursive copy of a place, or of a directory above
`appRoot`, carried files strict routing denies to a readable destination;
and it enters a link out of a `disk` or `node-default` place, which the
proof of its top path does not see (Routing and strict mode). A VFS-aware
walk is in `TASKS.md`.

**A hard link into or out of an indexed place is `ENOTSUP`
(`FsRouter.link`); a hidden source is `EACCES`.** _Why:_ a hard link is one
physical file under two names, while a place gives every name its own
canonical content, preparation and representations; the second name would
also
escape the place's mutation policy: it can be a writable alias of a
read-only place's raw file, and a write through it may never reach the
place's watcher. A copy gives the same bytes without sharing the file.

**A native rename moves the raw file. Both paths pass the mutation
routing and the source the read routing: a hidden source is `EACCES` —
through the `PlaceFs` facade of a disk-origin place too, which takes the
router's answer from the kernel it is handed (`kernel.routeRename`). A
published disk-origin file may leave `appRoot` or change its extension; the
watchers then drop the old canonical entry and publish the new key by the
policy of its place and extension. A directory moves natively only within
one disk-origin place; across a place's boundary, as a place's root, or as
a tree that holds places it is `ENOTSUP` (`FsRouter.rename`: `crossing`,
`unsupported`). Under strict a rename that leaves any place — a `disk` or
`node-default` one too — or enters an indexed one moves a regular file
only (`crossing` with `file`): a directory, the place's own included, or a
link is `ENOTSUP`.** In a virtual place the store moves the file's node
(Virtual places and worker mutations) — the preparer of a new extension
runs once — and refuses a prepared one (`ENOTSUP`); a directory moves as
one node when every file below it can move as it is (below); across a
virtual boundary a rename is `EXDEV`. _Why:_ the raw file is a disk-origin
place's source of truth: moving it hands on exactly what its publication
consumes, and each end republishes it by its own rules — the extension
change of a prepared file is just a new file of the new extension. What made
a rename a bypass was a hidden source: with write access to a disk-origin
place, a rename carried a file strict routing hides out of `appRoot`, or
gave it an extension its place serves from disk. A published source was
readable before it moved; strict routing decides which paths are served, and
a preparer is a publication step, not an access boundary. Within one
disk-origin place a directory keeps its policy, and the watcher republishes
its tree; across a boundary it would change the policy of all its
descendants at once, hidden files included, with nothing routed. Under
strict the links of a place's disk are proven where they lie; a directory
or a link that leaves the place takes them out of it, where a link into
`appRoot` from outside is seen by nothing — `d\sub` holding
`deeper\jro` → `ro` moved out of `appRoot` read what `ro` hides. A prepared
virtual entry has no raw input, and its bundle may embed the old key
(`scriptOptions.filename`, `meta`, bytecode). A copy and a delete across
places would not be atomic, and a virtual place is a filesystem of its own.
The facade renamed on disk without asking, so a file its place hides took
a published name (`hidden.bin` → `shown.txt`) where the patch refused it.
A file written and not yet published is hidden too where the place
publishes only what it indexed (`fs.fallback: 'deny'`, strict's default):
until the watcher publishes it, a rename of it is `EACCES` through either.

**The patch removes no place's own directory that `PlaceFs` keeps — an
indexed place's, and under strict any place's: `rm` and `rmdir` of it are
`ENOTSUP` (`place root`), an `unlink` `EISDIR`, as `PlaceFs` answers
(`kernel.keepsRoot`), before any native call.** _Why:_ the facade refused
it while `rm -r` through the patch deleted a disk-origin place's directory
under its watcher. A `disk` place's directory may still be renamed into
place from outside — a tree without links, how a release lays one down —
and without strict a `disk` or `node-default` place is `node:fs`
territory.

**A virtual directory renames as one node, its subtree with it, when every
file under it can move as it is — not prepared, without
`require.compile` cached data, without `scriptOptions` or `meta`
(`immovable`); `fs.script.compile` cached data moves along.** Every file keeps its node — its id and `ino` — its
payload, every representation and its version under the new prefix, in
one publication that names one pair in `moved`: one `vfs-update` for SAB,
one commit of its tree for a `map` place. Nothing is copied, prepared, compiled or
compressed again, nothing retires, and the pool needs no room; the move
takes the place barrier. One file that cannot move refuses the whole move
(`ENOTSUP`); onto an empty directory it replaces it, onto one with
children it is `ENOTEMPTY`, onto a file `ENOTDIR`, into itself `EINVAL` —
before anything changes; the place's own directory never moves. _Why:_ a
prefix rename changes no content, extension or config, so every
representation stays valid as it is. What depends on the key cannot be
carried over — a preparer's input is not kept, require cached data was
compiled under the old filename, metadata may name the old path — and
running the pipeline again for a subtree is left for later; moving only
the other files would split the tree. Script cached data is the bare
source's, compiled under V8's defaults — the library gives it no
filename — so it holds under the new prefix as it does after a file
rename, which moves it as it is (`movesAsIs`). The node, and every
`Representation` object with it, stays the same, so a pin on one keeps
protecting its bytes.

**`watch` of managed territory is `ENOTSUP` — a place directory, a
published file, the strict `appRoot`, a recursive watch of a place or of a
tree that holds places — while a file of the disk territory keeps a native
watcher; `fs.promises.watch` reports a refusal when it is iterated.**
_Why:_ a native watcher reports raw disk events: the names a place hides,
changes before or without their publication (a preparation that fails keeps
the previous version), nothing of virtual writes. An event must mean a
publication, and a publication-level watch is in `TASKS.md`. A
disk-territory file is its own content: its events describe what reads
return. `node:fs` reports the errors of `fs.promises.watch` from its
iterator, so a synchronous throw would differ from native behavior.

**A recursive walk, and a `rename`, of a tree that holds places — `appRoot`
passed through without strict, or a directory above it — is `ENOTSUP`; one
level stays native.** _Why:_ such a walk enters the places natively: a
recursive `readdir` from above listed hidden names, a recursive `rm`
deleted the files of read-only places, and a `rename` carried the whole tree
out of `appRoot`, where strict routing no longer reaches it. Only geometry
is checked (`PlaceRegistry.encloses`), so unrelated paths pay nothing.

**APIs the patch does not implement are guarded passthrough; a guarded
mutation in a virtual place is `ENOTSUP`, and so is `open()` of a virtual
entry. `mkdtemp` (its disposable forms too) is a guarded mutation of the
directory it makes: its prefix and the six characters it appends, the
path `node:fs` names — with `XXXXXX` — in its errors.** _Why:_ an
unimplemented API must not become a bypass; only its store changes a
virtual place — a native `copyFile` into one left a stray disk file the
place never showed; SAB / Map entries have no file descriptor. Unpatched,
`mkdtemp` made directories in read-only and virtual places, and under
strict anywhere below `appRoot`; routed by its prefix alone,
`mkdtemp(appRoot/ro)` would be a mutation of place `ro`, while it makes
`roXXXXXX` next to it. A virtual place's directories are nodes only its
store makes.

**A descriptor is the raw file. `open` routes its path as `readFile` does
for what the descriptor can read — a flag with `r`, `+` or `O_RDWR`, or
one that only reads — and as `writeFile` does for what it writes — a
string with `w`, `a`, `x` or `+`, a number with `O_WRONLY`, `O_RDWR`,
`O_CREAT`, `O_TRUNC` or `O_APPEND`. Where the read routing serves the path
from the VFS no descriptor reads it, whatever else the flag does:
`ENOTSUP` for a virtual entry whatever the flag, and for a published
disk-origin entry with a flag that can read. A flag that only writes is a
guarded mutation and needs no read routing: `EROFS` in a read-only place,
`ENOTSUP` in a virtual one, and in a disk-origin place the raw file
(`FsRouter.copy` says whether one is on disk) — a published entry opens so
wherever `writeFile` writes it, and `open(new, 'w')` passes where
`writeFileSync(new)` does, while a flag that can read stays `EACCES` on a
hidden path.
`createWriteStream` opens through `fs.open`, so its stream gets the same
error. `readFile` and `createReadStream` with a flag that writes open the
file with it before they read: they are routed as `open` with that flag
— the stream before it opens anything, whatever `fs` it is given, its
refusal emitted on it — and what `open` lets through is read natively. A
stream given a descriptor opens nothing, whatever path names it: it is
`node:fs`'s.**
_Why:_ routed only as a read,
`openSync(p, 'w')` and `createWriteStream` bypassed the mutation policy:
they created a file in a read-only place, and a stray one in a virtual
place's directory on disk, which the place never shows — and so did
`readFile` with such a flag, which also truncated a file of a read-only
place, while a published entry served its content whatever the flag, as
`createReadStream` did. Routing the stream up front, rather than leaving
it to its own `fs.open`, holds even for a stream given functions of its
own (`{ fs }`), which no wrapper sees.
Refusing every descriptor to a published entry
then left `createWriteStream` unable to do what `writeFileSync` — open,
write, close, in the native section — did: the raw file is a disk-origin
place's source of truth, `truncate` edited it already, and the watcher
republishes any disk write. A descriptor that can read would read that raw
file where `readFile` gives the prepared content — a raw file never stands
in for canonical content — and, on a hidden path, what strict hides; a
flag that only writes reads nothing: it is `writeFile` with a descriptor.
What Node's own implementation opens inside a call the routing passed
through (`writeFileSync` → `openSync`) runs in the native section and is
not routed again.

**`install()` and `uninstall()` update the named exports of the ES
modules `node:fs` and `node:fs/promises` (`syncBuiltinESMExports()`).**
_Why:_ Node binds them from the CommonJS exports when a module first
imports them, and again only when asked: an `import { readFileSync } from
'node:fs'` bound before `install()` — by a preload ahead of the bootstrap
— kept the original function and read what strict hides. A named import
is a live binding, so once updated it follows the patch whenever it was
made; a reference a module copied itself before `install()` cannot be
reached, and is documented as such.

**A wrapper calls its original once no kernel is installed, and each
`install()` wraps the restored originals.** _Why:_ a reference taken while
the patch was installed — a module's destructured `node:fs`, the functions
glob keeps from its first use — outlives `uninstall()`; it threw a
`TypeError` on the kernel that was gone, which glob swallowed into an empty
result. Wrapping the restored originals keeps repeated install / uninstall
from stacking wrappers.

**The library's own disk I/O — kernel, scanner, watcher, `PlaceFs`, the
copy engine — goes through `lib/disk.js`: `node:fs` as it was when it
loaded, and a native section around every synchronous call whose
implementation calls the public `node:fs` back; until it returns, each
wrapper is its original. A disk entry's stream gets an `fs` of its own.**
_Why:_ a captured function is not enough: `readFileSync` and
`writeFileSync` of a Buffer open the file through `fs.openSync`, `rmSync`
lstats its path through `fs.lstatSync` and on Node 22 walks the tree with
the functions its rimraf took from `node:fs`. Routed, those inner calls
refused a write to a published file (`ENOTSUP`), a new or hidden file under
strict (`EACCES`), and a recursive `rm` listed the place instead of the
disk and stopped with part of the tree gone. The section is synchronous — a
depth counter per thread under `try` / `finally` — so no callback or
continuation ever runs inside it, and a stream, which opens after the call
returned, reads through captured functions instead. So does the scanner
on a filesystem that does not report entry types (no `d_type`): there an
asynchronous `readdir` with file types lstats each entry through the
public `node:fs`, past any section, and where the patch refuses one — a
name a strict place does not serve yet — the whole listing fails, which
left a directory out of a rescan silently; the scanner then reads the
names again and types them with the `lstat` of `disk.js`.

**A call the routing passes through runs its original in the native section
— every form of every implemented operation and every guard, except `cp`;
`glob`, `watch`, `watchFile`, `existsSync` and `createReadStream` pass
through as they are. A callback `node:fs` calls before returning runs
outside the section.** _Why:_ what Node's implementation calls back into
`node:fs` before it returns is the call routed already, not a new one:
`writeFileSync` and `truncateSync` open the file through `fs.openSync`, the
callback forms of `writeFile`, `appendFile` and `truncate` do so before
returning, `rmSync` lstats its path and on Node 22 walks the tree. Routed
again, they refused what the first routing allowed: a write to a published
file of a writable place (`ENOTSUP`), a recursive `rm` under strict
(`EACCES`). `cp` calls its `filter`, the caller's code, inside the call —
in the section, the filter would read past strict routing — and so does
`node:fs` with a callback it calls at once (an aborted signal). A glob
loaded under the patch keeps walking through routing; watchers and streams
deliver later; `existsSync` calls nothing back. Node reads the caller's
options inside the call, so a getter there runs in the section as well:
accepted, as strict mode is a routing policy, not a sandbox.

**`install()` loads Node's rimraf over `node:fs` itself before it replaces
anything — synchronously, once per thread (`loadRimraf()`, a
workaround), over a sentinel path that does not exist.** On Node 22
`rmSync` is rimraf too and loads it at once. Later lines load it only
through `rm`, which checks its options through the public `fs.lstat` and
loads rimraf in that callback: a stand-in `lstat` takes the callback of
that one call, the sentinel's, and hands every other call to the `lstat`
it stands in for — whatever takes it meanwhile works as before — and once
`fs.lstat` is itself again, the callback hears that the sentinel does not
exist, which with `force` loads rimraf. When neither loads it — an `rm`
that code before the library wrapped and defers, or that does not reach
`node:fs` — `install()` says so once through the kernel's log and goes
on. _Why:_ the asynchronous `fs.rm` and `fs.promises.rm` — and a
recursive `rmSync` on Node 22 — are a JavaScript rimraf that takes its
functions from the public `node:fs` when it first loads. Loaded under the
patch, it walked a tree through routing — the place's listing, not the
disk — and, asynchronous, past any section: a recursive `rm` removed part
of the tree and failed with `ENOTEMPTY`. `initialize()` used to wait for
an asynchronous load, which covered the bootstrap and a manual
`await initialize()`, but not a worker: `attach()` installs the patch at
once, and every thread loads its own rimraf. Loaded by `install()`, it is
loaded before the patch whatever made the kernel and in whichever thread.
A stand-in that took every call broke whatever took it during the call —
rimraf itself, loaded there by a wrapper of `rm` over `rmSync` on Node 22,
answered no `lstat` again. What fails to load it costs removals inside the
places their completeness, not the strict boundary: a warning, not a
refusal.

**Listings sort and deduplicate the string names, then encode them as
asked; a recursive `encoding: 'buffer'` listing works in places.** _Why:_
the encoding must not change order or duplicates, and a Buffer name cannot
be compared with a string key. Native `node:fs` (22.22.3 to 26.x) fails
`recursive` with `encoding: 'buffer'` — its callback form even crashes the
process — which is a defect, not a documented contract.

**A recursive listing through the patched `node:fs` names its entries with
`path.sep`, as native `node:fs` does; `PlaceFs.readdir` names them with
`/`, the form of its keys, unless asked for a separator (`sep`). The
separator is applied by `listing()` after sorting and before encoding, so
every platform, separator and encoding lists in the one order of the
keys.** _Why:_ the patch stands in for `node:fs`: code that splits a name
on `path.sep`, or compares it with what `path.relative` gives, must not
meet `/` on Windows — and `Dirent.parentPath` was native already, so one
listing mixed both forms. A key is platform-independent, so the facade
keeps its form and offers the native one as an option rather than a second
method. Sorting the `\`-names instead would put `a0` before `a\b` on
Windows alone.

## Hooks and bootstrap

**One `module.registerHooks` chain for `require()` and `import`; modules
keep plain `file:` URLs; a `_compile` patch applies cached data and falls
back to the original compiler once.** _Why:_ in-thread synchronous hooks,
the same identity as files on disk (`import.meta.url`, `__filename`,
`require.cache`), bytecode reuse without changing module semantics; a
throwing module body is never re-executed.

**`require.resolve()` names what `require()` loads: install() also
patches `Module._resolveFilename` with the resolve hook's own lookup,
which answers first — a strict refusal included — and leaves to Node what
no place publishes; uninstall() restores it. No `require.extensions`
entry is ever made.** _Why:_ Node's `require.resolve()` asks the resolve
hooks from 24.20 on; on 22.x and 24.12 it asks `_resolveFilename` alone,
which knows no memory, and so does the `require` the `_compile` patch
gives a module on every version: a memory-only module resolved
`MODULE_NOT_FOUND` although `require()` loaded it, and under strict an
old Node named a disk file `require()` refuses. One lookup for both keeps
them equal; while the hook hands a miss to the default resolver the patch
does not look again. A `require.extensions` entry would make
`require('./view')` find `view.dhtml` — new resolution, process-wide.

**`load` returns the source decoded to a string.** _Why:_ the ESM loader
may compile after an async gap, when the shared bytes could already belong
to a newer version.

**`--import xvfs/register` bootstraps the main thread;
workers call `attach()`.** _Why:_ preloads do not run in worker threads.

## Rejected designs

| Design                                                                                                          | Why not                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Preparer functions inside `VfsConfig`                                                                           | the config must stay structured-cloneable for workers                                       |
| Async preparers                                                                                                 | they run inside synchronous `map` writes and one atomic publication                         |
| Domain priority or merging of `prepare` declarations                                                            | hides mistakes; one extension, one declaration                                              |
| `fs.script.prepare`                                                                                             | preparation belongs to the file, not to the script consumer                                 |
| `compile: boolean`, or an alias for it                                                                          | a fixed set of extensions; `fs.ext` repeated the script ones                                |
| `script: true`; a default compile list                                                                          | what a config compiles would not be what it lists                                           |
| Collapsing a repeat within one extension list                                                                   | a list that names an extension twice hides a mistake                                        |
| JSON or bracket values for lists on the CLI                                                                     | PowerShell drops the quotes of JSON; zsh globs `[a,b]`                                      |
| A list typed by its value on the CLI (a comma makes a list)                                                     | one item would be a string, an extension `3` a number                                       |
| A `require.extensions` entry for each extension a place serves                                                  | `require('./view')` would find `view.dhtml`; process-wide                                   |
| Leaving `require.resolve()` to Node's resolver                                                                  | on 22.x and 24.12 it sees no memory and no strict refusal                                   |
| Handing XVFS cached data to a third-party compiler that wraps the source its own way                            | cached data of another text: refused, or taken and wrong                                    |
| Synchronous worker mutations via `Atomics.wait()`                                                               | deadlock- and stall-prone                                                                   |
| Workers allocating in SAB                                                                                       | one writer keeps the allocator lock-free                                                    |
| Echoing file bytes in mutation responses                                                                        | the bytes are already in SAB; the update carries metadata                                   |
| Rules in the nodes of a place's tree                                                                            | a rule holds where no node is; it would leave with a directory moved or removed             |
| A rule that gives a domain, an extension, compression or a preparer the place lacks                             | what a file is would depend on where it lies                                                |
| Provisional nodes or payloads in a tree                                                                         | snapshots and compaction would observe unpublished state                                    |
| Parallel watcher epochs                                                                                         | an older epoch could publish over a newer one                                               |
| Committing an epoch (`#flush`) outside the kernel                                                               | it commits the trees, retirement, pins and links the kernel owns                            |
| A watch pipeline that holds the kernel's epoch state and passes it back (`publish(ep, …)`, `flush(ep)`)         | kernel state leaves the kernel; no commit is bound to its epoch                             |
| A publication sink that stages into the kernel's epoch, or keeps its pool or compressor                         | kernel state leaves the kernel; a kept pool outlives `close()`                              |
| Unbounded jobs of a watcher epoch                                                                               | a descriptor per changed file: `EMFILE` at `ulimit -n 1024`                                 |
| A scan's stats pooled per directory, or listed in the order they finish                                         | no faster on sparse trees; init's order would change run to run                             |
| A permanent allocation id in every representation                                                               | retirement needs an identity only while a version is retired                                |
| `updateId` as the public version                                                                                | it counts relocations, which change no file; the ACKs' books                                |
| A `retireId` as the version of a file                                                                           | one per representation, and only until its free                                             |
| A hash of the content as the version                                                                            | a pass over every byte; no commit identity (a preparer's `meta`)                            |
| A clock or random ids as versions                                                                               | a clock repeats; neither orders commits nor names one                                       |
| The version in `stat()`                                                                                         | `VfsStats` stands in for `fs.Stats`, which the patch returns                                |
| A version per thread for the files of a map place                                                               | one file, another version in each thread: a false ETag match                                |
| Emitting `'publish'` inside `#flush`                                                                            | application code inside the commit; init's before it is ready                               |
| Emitting `'publish'` with `process.nextTick`                                                                    | runs after the mutation's promise has settled                                               |
| A separate `kernel.events` emitter, an `EventTarget`, `subscribe(fn)`                                           | a second object; no `events.on` / `once`; not the Node idiom                                |
| Entries, stats or views in an event                                                                             | a listener would hold shared bytes, or read stale ones                                      |
| Replaying the current state to a new listener                                                                   | that is `snapshot()` and the reads                                                          |
| Logging what a listener throws                                                                                  | hides the application's error; no emitter of Node does it                                   |
| Locking the keys of a set one by one, or under the place's barrier                                              | hold-and-wait; the barrier stops writes of unrelated keys                                   |
| The keys of a set in `creating` while it is checked                                                             | the refusal would depend on the order of the keys                                           |
| Preparing the files of a set in parallel (`pool()`)                                                             | a failure leaves work in flight that stages after the abandon                               |
| Removals or a flag per file in a set                                                                            | widens a write; a second shape of request and of refusal                                    |
| A set of a disk-origin place                                                                                    | the disk commits files one by one                                                           |
| The version as the result of every mutation                                                                     | changes every result; `version(key)` answers it                                             |
| A request, or a transferred buffer, per file of a worker's set                                                  | a set would reach the main thread in parts; K transfers                                     |
| IPC per chunk or per pin                                                                                        | pins of current versions must stay local                                                    |
| Freeing a retired version on a timeout                                                                          | reuse under a slow reader returns another file's bytes                                      |
| Retirement books that free the bytes themselves                                                                 | a free starts a compaction, whose epoch only the kernel commits                             |
| Diagnostics counted on the read or publication path (hits, fallbacks, ACK ages)                                 | every request pays for a question asked every few seconds                                   |
| A diagnostics call that settles, frees or compacts                                                              | looking would change what is looked at                                                      |
| GC-driven release of views                                                                                      | use-after-free for destructured views and subarrays                                         |
| Releasing zero-copy streams on `'end'`                                                                          | sockets still hold the last chunks                                                          |
| Manual worker transports (`broadcast`, `getWorkerIds`)                                                          | every one would have to re-implement retirement                                             |
| `startsWith('..')` containment, `realpath` in the router                                                        | misroutes `..private`; disk access on the hot path                                          |
| Lower-casing a place's name on Windows to compare it                                                            | NTFS takes no Kelvin sign `K` for `k`: an unmanaged directory                               |
| Storing keys lower-cased on Windows                                                                             | keys and errors keep their spelling; an index finds other cases                             |
| Looking a key up in another case under strict, or for a disk-backed entry                                       | strict refuses it already; a wider match reads another file                                 |
| Other spellings of a virtual place's keys                                                                       | its reads and mutations would disagree (`exists` against `wx`)                              |
| Refusing every miss of a cached extension without strict on Windows                                             | the permissive default's unpublished files; unlike on POSIX                                 |
| Mapping UNC and namespace spellings (`\\?\C:\…`, `\\localhost\C$\…`) onto `appRoot`                             | no list of aliases is complete; the OS says what a share names                              |
| Stripping a stream suffix to route the file before it (`a.txt::$DATA` as `a.txt`)                               | the file system says which stream a name opens, not the strings                             |
| Resolving short names in the router (`GetLongPathName`, `realpath` per path); listing the real aliases          | disk access on the hot path; only the disk knows every alias                                |
| Refusing every short name on `appRoot`'s drive                                                                  | past a differing name none stands for `appRoot` (`SYSTEM~1`)                                |
| Refusing every name where `appRoot` has a short one (its long name may be any)                                  | refuses its siblings; `appRoot`'s real path names the long one                              |
| Auditing every drive letter when the kernel starts                                                              | touches every mapped drive's server; a disconnected one stalls                              |
| Mapping a drive or a share onto the local path it may name                                                      | the server says what a share names; no list of aliases is whole                             |
| Refusing every link out of a place's directory under strict                                                     | one elsewhere reaches nothing new; shared directories of releases                           |
| A proof kept per directory of a place's disk                                                                    | a directory swapped for a link after it passes unseen                                       |
| The proof in FsRouter, or `realpath` for every native call under strict                                         | the router stays lexical; all other I/O would pay for it                                    |
| A `realpath` proof on every place's disk, always (the only mode)                                                | tens of µs a call on Windows against what only a link can do                                |
| `links: 'allow'`                                                                                                | no scenario needs a link followed unchecked under strict                                    |
| Links made, removed and moved through the patch on a place's disk, followed by the index                        | shared counters, two-way messages, a window per call; no consumer                           |
| Forgetting a known link (a check that finds it gone, a watcher event)                                           | only another process removes one: forgetting only lets more pass                            |
| The index asked about a Windows path as given                                                                   | `C:d\…`, `\Users\…`: node:fs resolves them, the keys did not                                |
| An index kept by the main kernel alone                                                                          | a worker's kernel never initializes: it would know no link                                  |
| Walking every directory renamed or removed within a place for links (a tree moved in from outside is walked)    | a rename's cost would grow with its tree; the index knows them                              |
| `node:fs`'s recursive `readdir` or `cp` over a place's disk under strict                                        | they enter junctions, `readdir` even with `withFileTypes`                                   |
| A new link within one place under strict                                                                        | the place decides which of its names alias, not code under strict                           |
| Routing a symbolic link's target from the cwd                                                                   | the OS resolves it from the link's directory                                                |
| Native `cp` with a routing `filter` for managed trees                                                           | raw disk bytes, no virtual entries, no canonical content                                    |
| Copying canonical (prepared) content as a copy's input                                                          | the destination prepares it again; its bundle names the source                              |
| Feeding a prepared virtual entry's canonical content back in as raw                                             | stale `meta` / filename / bytecode, a silently different input                              |
| Refusing every copy or rename of served content                                                                 | the raw source of truth could not move; the bypass was hidden raw                           |
| A cross-place `rename` as a copy and a delete                                                                   | not atomic; a virtual place is a filesystem of its own (`EXDEV`)                            |
| Refusing every virtual directory rename                                                                         | a prefix rename changes no content; a tree of files that move as they are can move          |
| Copying a subtree's versions into fresh allocations on a move                                                   | 28 ms and 10 000 retired versions for 10 000 files, a second copy until every ACK, `ENOSPC` |
| Recompressing, re-preparing or moving part of a subtree                                                         | wasted work; no raw input; a tree split between two names                                   |
| A hierarchy check against the published tree only                                                               | two overlapping mutations would both pass                                                   |
| A mutation committed by a `#flush` that returns silently on a closed kernel                                     | the write resolves, though nothing was published                                            |
| Locking every ancestor of a created key                                                                         | serializes all writes of one directory                                                      |
| One store class over an execution engine, its results sync or thenable                                          | a thenable test of every result; a subclass knows its execution                             |
| Implicit directories — one exists while a file is under it                                                      | no empty directory; `mkdir` made nothing; a listing gathered names                          |
| Scanning the keys in flight for one below a key                                                                 | every check linear in the keys in flight, a set's thousands                                 |
| A native watcher for a published file                                                                           | raw disk events are not publications                                                        |
| A full copy per stream, or of its unread rest                                                                   | the cost grows with the file; a pin gives the same stability                                |
| Atomics or a global lock per read; pinning a segment or every representation of a file                          | cross-thread cost on the hot path; holds unrelated bytes                                    |
| Revisions, cancellation tokens, per-key queues or latest-wins for watcher epochs                                | a FIFO gives the guarantee with less machinery                                              |
| Several chained preparers for one extension                                                                     | one extension, one declaration, one canonical content                                       |
| Copying a preparer's `Uint8Array` result only when its publication places it                                    | the next call of the same turn overwrites a reused output buffer                            |
| Preparation that emits extra files, per-domain variants or derived formats                                      | a file keeps its key, extension and one canonical content                                   |
| A guarded native `opendir`; a native listing of a disk-only directory                                           | a second listing path: hidden raw files, no virtual entries                                 |
| Native passthrough of the strict `appRoot`                                                                      | lists unmanaged names                                                                       |
| A glob-only fix for stale patched references; a wrapper that keeps or re-installs a kernel                      | every captured reference is affected; a closed kernel is gone                               |
| Filtering the results of a glob that walks natively                                                             | it listed hidden names already, and handed them to `exclude`                                |
| Pruning a native glob with `exclude`                                                                            | bare names in its `**` branch; skipped when `cwd` is not the cwd                            |
| Emulating glob over the places with `path.matchesGlob`                                                          | `x/**` matches `x`, `./` and `..` prefixes, literal case differ                             |
| An asynchronous native section (`AsyncLocalStorage`)                                                            | user callbacks inherit it, past strict; `async_hooks` cost on 22                            |
| Own primitives in place of `rmSync`                                                                             | rewrites its retries (`EBUSY`, `EPERM`, `maxRetries`) and errors                            |
| A native section around `cp`                                                                                    | its `filter`, the caller's code, would read past strict                                     |
| Refusing an `open` that writes only where the mutation routing denies it                                        | a virtual place's directory on disk still got a stray file                                  |
| Routing an `open` that writes by the mutation routing alone                                                     | a `+` flag would read what strict hides; no raw file when virtual                           |
| Refusing every descriptor to a published disk-origin entry                                                      | `writeFileSync` opened the same raw file; `createWriteStream` not                           |
| A descriptor that reads and writes (`+`) a published disk-origin entry                                          | it reads the raw file where `readFile` gives the prepared content                           |
| Preloading rimraf when the package is imported                                                                  | races a synchronous `install()`; disk I/O on every import                                   |
| An asynchronous rimraf preload that `initialize()` waits for                                                    | a worker's `attach()` installs the patch before it could load                               |
| Telling by its name or its arguments whether an unknown `node:fs` function takes a path                         | a wrong guess is a strict bypass                                                            |
| Refusing strict on a Node whose `node:fs` has an unknown export                                                 | stops every application for an export perhaps path-free                                     |
| A tree in SAB shared by every thread                                                                            | a protocol for concurrent access, names that are no V8 strings; it pays only for huge trees |
| Partial replicas: a thread holding the subtrees it needs                                                        | a synchronous `fs` call cannot wait for a subtree to load                                   |
| A node's fields in the API (`node.id`, `node.kind`)                                                             | fixes the layout; the engine answers through operations                                     |
| A `Map` of children from a directory's birth                                                                    | 176 B more for every empty directory                                                        |
| Typed-array columns for nodes                                                                                   | code, and pins by number, for 2.7 times less memory                                         |
| Derived bytes as entries of their own, under keys with a NUL                                                    | keys to keep apart from files, out of listings and moving together                          |
| `representations: Map<kind, …>` in a payload; an object of the kinds present                                    | 176 B even empty; up to 16 hidden classes                                                   |
| A `Buffer` view made with every representation                                                                  | ~104 B each in every thread, mostly unread; a full GC 2.5 times longer                      |
| A view made on every read and kept nowhere                                                                      | ~60 ns a read; a lease of one file N times held N views                                     |
| Attributes in SAB records of their own; atime                                                                   | a second allocator and record numbers for 24–56 B a file; work on every read                |
| Node ids growing to 2⁵³ without a wrap; refusing a commit when they run out                                     | +32 B a node, `byId` 4.5 times slower, a pause; an outage after weeks                       |
| `updateId` checked in the engine; a new snapshot when a delta is missing                                        | a tree sees gaps in `updateId`; the port loses no delta                                     |
| A two-phase commit across the trees of a publication                                                            | no source needs a transaction across places; a new API and rules between phases             |
| Relocation, or the books of compaction, by key                                                                  | a key is built and parsed again; a directory move makes the books stale                     |
| Compaction's owners found by a walk of the trees                                                                | every free cycle with a candidate pays for every file: 340–360 ms at 10⁶                    |
| `null` or an error from a removed node's operations; its name before the removal                                | threads would disagree; every call after an `await` wrapped                                 |
| Versions, retireIds and ACKs per tree                                                                           | a publication seen by halves; more messages; the books split                                |
| A cache of paths and one of misses in the engine                                                                | a walk costs tenths of a µs; past its bound a cache is slower; its removals bred defects    |
| Checking a delta's references before `apply` changes anything                                                   | a replay of the delta; a refused delta breaks the view anyway                               |
| Closing a broken worker view and its port at once                                                               | bytes under a live lease freed: a socket sends another file's bytes                         |
| A `Map` left to throw past 2²⁴ entries                                                                          | a `RangeError` half-way through a commit; `ENOSPC` keeps the kernel up                      |
| A `move` that replaces as `rename` does, or a `replace` flag                                                    | `rename`'s table is the FS layer's; the flag is the same table in the op                    |
| Replacing a destination through `remove`                                                                        | a mistake about its kind would take a subtree                                               |
| A virtual place's `rename` as the host's disk does it                                                           | `EPERM` for most on Windows; one answer everywhere                                          |
| A snapshot in `workerData`; `attach()` clearing `link.snapshot`                                                 | it lives as long as the worker; a convention, not a structure                               |
| Standalone place-level `script` domain, provider `memory`, `vfs:` URLs, metawatch, root-level `ext` / `compile` | superseded by the place / domain model; no aliases                                          |

## Invariants

- A representation's bytes are read through `Buffer.from(sab, offset,
length)` views made on each read; `readFile*` returns owned copies;
  direct access goes through leases and streams that pin the
  `Representation`.
- The config is deep-frozen and never mutated at runtime.
- A tree holds published payloads only; every publication commits the
  trees it changes in one synchronous step: a place's in `#flush`, one
  commit per tree; a tree of client ids in its intake's part, one commit
  per batch.
- A retired version is freed only after all linked workers ACKed its update
  and no thread holds it; nothing is freed on a timeout.
- `diagnostics()` reads: it frees, settles, compacts and publishes
  nothing.
- Compaction never moves or overwrites retired bytes; emptied segments are
  reused, never returned to the OS.
- A file's source and representations are one payload, replaced whole in
  one delta.
- Watcher epochs never overlap; the jobs of one run at most `IO_LIMIT` at a
  time, one that fails holds up nothing else, none starts after `close()`,
  and one in flight at `close()` starts no disk call after it beyond the
  rest of a read it began, and runs no preparer.
- A closed kernel publishes nothing and arms no timer: a watcher event
  whose `stat` lands after `close()` is dropped.
- A mutation of a virtual place never resolves without its commit: one
  whose kernel closes before it rejects as the closed kernel.
- The version is the main kernel's count of publications: a commit that
  publishes raises it by exactly one, and the trees stamp it into every
  payload the commit makes; a relocation and a commit that publishes
  nothing change neither, and a move keeps the version of what it moves.
  A file has the same version in every thread, and never a wall-clock
  time or a `retireId`.
- `'publish'` is emitted once per publication a thread applies, after the
  commit, in the order of the versions; never for a relocation, never
  once `close()` has returned. An event holds no shared bytes; `'close'`
  comes once, last.
- A representation is never a key: it never appears in `readdir`,
  `exists`, routing or the patched fs, and a rename moves it with its file.
- Kernel-internal disk I/O (kernel, the publication sink, watch pipeline,
  scanner, watcher, `PlaceFs`, the copy engine, the aliases of strict)
  uses `lib/disk.js`:
  functions captured at load time, the synchronous ones that re-enter run
  in a native section — Node's own implementations call the public
  `node:fs` back (`writeFileSync` → `openSync`, `rmSync` → rimraf), and
  the patch passes such calls through untouched while the section is
  open. Inside `lib/`, only `disk.js`, which captures `node:fs`, and
  `fs-patch.js`, which patches it, load `node:fs`; the copy engine takes
  `fs.constants` from `disk.js`.
- The native section opens only around the library's own disk I/O and a
  call its routing passed through — never around `cp`, whose `filter` is
  the caller's code — and no callback of the caller runs inside it.
- `watchPath()` is a load-bearing workaround (nodejs/node#63638: an 8.3
  alias in a watched path aborts libuv on Windows); remove it only when the
  engines floor clears every affected release.
- `loadRimraf()` is a load-bearing workaround (Node's asynchronous `rm`,
  and `rmSync` on Node 22, is a JavaScript rimraf that takes its functions
  from the public `node:fs` when it first loads): `install()` runs it
  before it replaces anything, in every thread, and says once when it
  could not load rimraf; its stand-in `lstat` answers every call but the
  sentinel's as `lstat`; remove it only when every supported Node line
  removes a tree natively.
- `install()` records every replaced `node:fs` property — an accessor by
  its descriptor — and `uninstall()` restores them in reverse, every one
  it can, and uninstalls whatever one of them throws, then throws it; a
  `.native`
  variant is routed as its function is and restored with it, any other
  function an export carries stays on its replacement; an `install()`
  that fails half-way undoes itself; with no kernel installed, and inside
  the native section, a wrapper is its original; both update the named
  exports of the ES modules `node:fs` and `node:fs/promises`.
- Every export of `node:fs` and `node:fs/promises`, and every function
  one carries, is in the table of `lib/adapters/fs-surface.js`; under
  strict, any other function is refused at every call before it runs.
- Listings are sorted and deduplicated by string name — the key's `/`
  form — before any separator or encoding is applied; only the patch asks
  for `path.sep`.
- A preparer runs once per publication attempt, on the publishing thread,
  never on read; its raw input is never kept in the VFS; a prepared source
  is never a disk entry; `prepare` and `scriptOptions` never turn
  `fs.script` on.
- No native listing, copy, link, rename or watch runs over managed
  territory past its routing — a glob that walks natively included — and
  no descriptor that writes is opened there past the mutation routing; a
  refusal comes before any disk read or write.
- A copy, and a rename on disk, hands on the raw input only — never a
  prepared result or a derived representation; the destination prepares
  it once, and a virtual destination never gets a disk file.
- A virtual rename is one commit or nothing: the node moves with its id,
  payload and version, and no byte is copied.
- A set of `writeFiles` is published in one commit or not at all: a
  refusal, a failure or `close()` leaves no allocation, no key in flight
  and no lock of it.
- A virtual path is a file or a directory, never both — also while
  mutations overlap.
- A replica applies a delta only from its own revision, with the main
  tree's code; one it cannot apply breaks its worker's view, which never
  goes on half applied.
- No snapshot or delta holds a SAB, and a thread keeps nothing of one once
  it is applied.
- A node id names one node until the counter wraps; a removed node is dead
  with its subtree.
- A place serves a key by the settings in force there — its own or its
  rules' — wherever the key is routed, read, listed, loaded or written; a
  rule changes nothing a place publishes. An operation on a whole tree
  that a rule below its path restricts changes nothing.
- A tree of client ids is written by its intake only, on the main thread:
  its batches in the order of their numbers, a publication a continuous
  run of them, in one synchronous step — no thread sees a state between
  two batches of one publication.
- A batch of a tree never resolves without its commit: one whose kernel
  closes before it rejects as the closed kernel; a worker's resolves once
  its replica shows it.
- Disk territory never leaves its place (`PlaceFs.#within`) and, under
  strict, never serves or lists a cached extension.
- On Windows under strict, the patch and the module hooks pass no UNC or
  namespace path outside `appRoot`, no path with NTFS stream syntax and no
  short name below `appRoot` or where a path leaves its spelling on to
  `node:fs` or Node's loader: the router refuses it first.
- Under strict the router asks the disk once for `appRoot`'s real path,
  when the kernel is built, and on Windows at most once per drive letter
  and thread (again only while a letter names nothing); a path in `appRoot`'s
  real spelling, or on a drive that names a share or `appRoot`'s line,
  reaches neither `node:fs` nor Node's loader.
- Under strict no native call on a place's disk — through the patch, the
  facade or the load hook — runs through a link the kernel knows
  (`links: 'deny'`, in every thread once it knows it), or before the disk
  has said its path really lies in the place's directory or off
  `appRoot`'s line (`'verify'`); a recursive listing there enters no link,
  and no native recursive copy walks it.
- The index of links only grows until the kernel restarts; a place's own
  directory is never in it.
- Under strict the patch makes no link, symbolic or hard, to managed
  territory, and — with the facade — makes, removes and moves none it can
  see on a place's disk, and removes or moves no directory past one out of
  the place's directory.
- The patch removes no place's own directory that `PlaceFs` keeps.

## Protocol

```
vfs-snapshot { name: 'vfs-snapshot', snapshot }                               main → worker
            the first message of a link
snapshot    { segments: [{ id, sab }], places: { <name>: tree },
              trees: { <name>: { snapshot: tree, last } },
              version, instance, links?: { known: [path], generation } }
vfs-update  { name, updateId, version, places: { <name>: { delta, created,
              replaced, removed, moved } }, trees: { <name>: { deltas,
              seq: { from, to, loaded } | null } }, newSegments: [{ id,
              sab }] }                                                        main → worker
vfs-ack     { name: 'vfs-ack', updateId, retained?: [retireId] }              worker → main
vfs-release { name: 'vfs-release', retireIds: [retireId] }                    worker → main
vfs-mutate  { name, id, place, op, key, to?, options?, data? }                worker → main
            writeFiles: { name, id, place, op, keys, sizes, options, data }
            a tree's: { name, id, tree, op: 'submit' | 'load', seq, ops |
              rows }, each payload's data a Uint8Array over a transferred
              buffer
vfs-mutated { name, id, error?: { code, message, syscall, path, dest,
              seq, index, id, other }, version?, result? }                    main → worker
vfs-links   { name: 'vfs-links', add: [path], generation }                    main → worker
tree        the place's tree in pre-order as columns — ids, parents, names,
            classes, payloads — typed arrays and arrays of strings, no SAB
delta       one commit's log of steps on nodes by id (create, attach,
            detach, kill, payload, relocate…) as columns over one
            buffer, and the representations it retires: { id, kind,
            retireId }
payload     version, size, mtimeMs (+ birthtimeMs), scriptOptions?, meta?, and
            each representation as kind, segmentId, offset, length; a source
            kept on disk has none: its key names its file
```

## Testing

- `npm test` runs `test/*.test.js`, each test under a 60 s timeout
  (`--test-timeout`) — the slowest take about a second, so a test that
  hangs where no bounded wait guards it fails. The run has no
  `--test-force-exit`: with a process per test file it ends the run once
  the tests reported so far have finished, and on Linux it dropped whole
  files at random — 679 to 727 of 728 tests on Node 22.23.2 and 24.20.0,
  with no failure reported, a green run that did not run everything. The
  price is that on Node 24 and later a timed-out test whose handle stays
  alive keeps its process until CI's own timeout: a red run, late, rather
  than a green one that skipped tests;
  `npm run test:examples` runs the example smoke suite; `npm run lint` is eslint + prettier. CI covers Linux
  and Windows on Node 22.22.3 / 22.x / 24.12.0 / 24.x / 26.x.
- Concurrency tests are deterministic: gate the injected reader
  (`k.cache.reader`), emit watcher epochs by hand and await
  `k.watchQueue.idle`, observe publication on the main side
  (`k.nextUpdateId`, `k.acks`, `k.retired`, `k.retirements()`), and use
  in-thread links (`test/helpers.js`: `tap`, `worker`, `nextMessage`)
  instead of timers. A `'publish'` event is the point where a commit is
  observed — in a worker, where its update was applied — without polling
  the tree. Tests over real `fs.watch` events or real workers wait
  only for a condition to become true (`until`); nothing sleeps to prove
  that something did not happen. A test that reads what a port delivered
  waits for that message (`nextMessage`, or `until` over the messages),
  never for the tree alone: `#flush` commits to the main thread's tree
  before it posts the update, and the port delivers it later.
  Every wait for what the code under test must reach — a gate, an event or
  a message, a queue gone idle, a worker's answer — is bounded (`within()`,
  `nextEvent()`, `diskCalls().started()`, `until` with an assertion): a
  regression fails the test within seconds, naming what it waited for,
  where `node --test` would wait without a word. A test that holds an
  operation at a gate asserts that the gate was reached before it opens
  it, so it never passes by not reaching it. The disk calls a closed kernel starts are
  counted with async_hooks (`diskCalls()`), which sees the functions the
  library captured as well. A filesystem that reports no entry types is
  simulated by the fs binding (`process.binding('fs').readdir` reporting
  each type unknown), so that `node:fs` does what it does on one.
- Hooks are installed only inside a test and uninstalled in `after` /
  `finally`; bootstrap tests run child processes. Every kernel a test
  creates is closed in `finally` (or in `after`, when tests share it), and
  every worker thread terminated there: a failed assertion must not leave a
  watcher or a thread that holds the process, where `node --test` waits
  instead of reporting the failure. A test that closes the kernel under an
  operation holds that operation in flight first — at a gate it is seen to
  reach.
- glob captures the `node:fs` functions it walks with when it is loaded,
  and a `node --test` child loads it before any test runs: in-process
  tests see the native walk the patch refuses over managed territory,
  while the routed walk — glob loaded by `install()` — is tested in plain
  node processes (`test/fixtures/glob-routed.cjs`, both modes, and
  `glob-kept.cjs` across `uninstall()`). So does Node's rimraf, which a
  test process may have loaded before its first `install()` (on Node 22
  `test/helpers.js` does, with its first removal): which functions it
  keeps is tested in a plain node process too (`test/fixtures/rm-kept.cjs`),
  loaded by `install()` over an initialized kernel and over replicas,
  in a worker thread, which loads its own, and with `node:fs` wrapped
  before the library loads (`test/fixtures/rm-wrapped.cjs`: an `rm` that
  defers, a wrapped `lstat`, an `rm` that takes the `lstat` it finds).
- A refused operation is tested for its error (`code`, `syscall`, `path`,
  `dest`) and for leaving nothing behind — no copy, no deletion, no move,
  and no allocation: `leakedBytes()`, the bytes in allocations that no
  published representation and no retired one accounts for, stays 0 (the count
  of segments hides a leak inside one). A failure of the pool itself is
  tested with a pool too small, or an allocation that finds no room. After
  a failure the kernel is at rest (`assertAtRest()`): nothing leaked, no
  mutation queued or holding a key or a place, no key in flight, no
  watcher epoch — and no recheck but the one a failed watcher publication
  schedules — no worker request unanswered; closed, it leaves no open link
  port and no resource that keeps the event loop alive
  (`closeAtRest()`). `test/at-rest.test.js` runs every refusal and failure
  of the mutations, main thread and worker, facade and `node:fs`, a failed
  `initialize()` and a failed watcher publication through both.
- `test/fs-surface.test.js` holds the table of `lib/adapters/fs-surface.js`
  to the running Node: every export known, every export the table requires
  there (but those some supported release lacks), what install() replaces
  exactly what it calls implemented or guarded. Functions planted where a
  new release would add them — in `node:fs`, in `node:fs/promises`, behind
  an accessor, carried by an export — are refused under strict and left
  alone without it; a delegated export is refused on a hidden path through
  the patch it goes through.
- A spelling strict refuses is tested with every family of `node:fs`
  calls over it (`test/fs-calls.js`) and with `node:fs` counted beneath
  the patch: nothing reaches it. The rules are tested for both path
  flavors on any host, a disk that realpath answers for stood in by a
  table (`test/aliases.test.js`); on Windows the real disk makes what it
  can — 8.3 names where the volume generates them, junctions (no
  privilege), subst drives, a drive mapped to the admin share — in the
  tests, which remove them in `finally` and skip, saying why, where
  Windows makes none. A tree with a link above `appRoot` is never walked
  recursively by a test: a regression that followed it would not end.
- The engine has a stand of its own. `test/tree-model.js` is a reference
  model — obviously correct and slow — to which `test/tree-model.test.js`
  holds the engine and every replica it feeds, over random commits by seed
  (`TREE_SEEDS`, `TREE_SEED`); `tree-big` does the same on large trees and
  moves of subtrees of every size; `tree-deep` takes the shapes the random
  commits never reach — a chain 50 000 deep, a parent of 10⁵ children —
  and holds costs to ratios, so that nothing grows with depth or width;
  `tree-retention` checks, in a process of its own with `--expose-gc`,
  that nothing of an encoding stays reachable; `tree-shapes` that one
  large number turns no other object's fields; `tree-boundary` that the
  engine loads no module of the kernel. `test/nodes.test.js` tests the
  tree in the kernel: ids and `ino`, attributes, moves that copy nothing,
  compaction under leases, a broken view.
- A place's rules are tested on their own (`test/rules.test.js`: the
  settings at a key, what the rules below one restrict) and at the
  boundaries (`test/rules-fs.test.js`): the facade, the patched `node:fs`
  under strict, the module hooks, the store of a virtual place from either
  thread.
- The intake has a test of its own, deterministic (`test/intake.test.js`):
  a real tree of the engine under a clock, timers, a pool and a kernel of
  the test's — numbers, windows and parts, repeats, gaps, refusals, room
  in the pool, loads in both modes, close. `test/trees.test.js` tests the
  trees of client ids in the kernel: reads, leases and retirement,
  compression, compaction, a worker's replica, its batches and their
  refusals.
- Prove V8 cached-data acceptance in a worker: the per-isolate compilation
  cache masks `cachedDataRejected` in the compiling thread.
- `npm ci` must work without git or SSH access: git dependencies are pinned
  as HTTPS tarball URLs with lockfile integrity.
- Performance claims rest on `npm run bench` (`bench/`, outside `npm test`
  and CI): one process per scenario, a warm-up, then the median of several
  rounds; latencies as p50 / p95 / p99, memory as RSS and pool usage. Two
  revisions are compared with `bench/ab.js`: both exported with
  `git archive` into sibling directories of one temporary directory — where
  the code lies changes its timings — with the same dependencies, run in
  alternating pairs (the order flipping between pairs), the medians of
  each side compared; a change is significant when it exceeds max(5 %,
  2 × the spread of the base runs) in every pair, and one every pair
  shows in the same direction below that is reported as such, not as
  significant. `bench/compare.js` compares two single runs, with the noise
  taken from a second baseline run (`--noise`). Every reach into kernel
  internals is in `bench/lib.js`.
