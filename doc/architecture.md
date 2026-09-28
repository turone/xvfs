# Architecture and decisions

How shared-memory-fs is built and **why**. Each section states the
decisions in force together with the reasons behind them; [Rejected
designs](#rejected-designs) lists what was considered and turned down, so it
is not reintroduced without new evidence. Keep this file aligned with the
code: a change that alters a decision updates it in the same commit.

Contents: [Purpose](#purpose) · [Module map](#module-map) ·
[Places and configuration](#places-and-configuration) ·
[Storage](#storage) · [Publication](#publication) ·
[Lifetime of shared bytes](#lifetime-of-shared-bytes) ·
[Preparation](#preparation) ·
[Virtual places and worker mutations](#virtual-places-and-worker-mutations) ·
[Routing and strict mode](#routing-and-strict-mode) ·
[Patched `node:fs`](#patched-nodefs) ·
[Hooks and bootstrap](#hooks-and-bootstrap) ·
[Rejected designs](#rejected-designs) · [Invariants](#invariants) ·
[Protocol](#protocol) · [Testing](#testing)

## Purpose

Node.js servers that run several `worker_threads` over the same files —
static assets, templates, handler sources, modules. Files are loaded once on
the main thread into pooled `SharedArrayBuffer` segments; every thread reads
zero-copy views of the same bytes. Live changes are published to all threads
atomically; V8 cached data and compressed representations are built once and
shared the same way.

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
│ ├─ VfsConfig (frozen)             │ ─────► │ ├─ projected Maps (zero-copy)│
│ ├─ FilesystemCache (SAB pool)     │        │ ├─ per-thread map places     │
│ ├─ SAB sink → #stage → #flush     │ update │ └─ Pins: streams and leases  │
│ ├─ WatchPipeline: watcher → FIFO  │ ─────► │                              │
│ ├─ Retirement: acks + retired     │ ◄───── │ vfs-ack (+ retained)         │
│ └─ Pins (main-thread consumers)   │ ◄───── │ vfs-release / vfs-mutate     │
└───────────────────────────────────┘        └──────────────────────────────┘
SAB segments ──────────── one physical copy ──────────── views in every thread
```

## Module map

| Module                          | Role                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/config.js`                 | `VfsConfig`: raw → deep-frozen `{ global, places }`; domains, `prepare` index, `fs.fallback` normalization                                                |
| `lib/cache.js`                  | `Pool` + `SegmentRegistry` + `FilesystemCache`: SAB allocator; `allocate()` places bytes privately, `put()` / `remove()` publish, `compact()` plans moves |
| `lib/kernel.js`                 | `VfsKernel`: lifecycle, init, virtual publications, epochs and their commit (`#flush`), freeing retired versions, mutation queue, `link()`, worker side   |
| `lib/pipeline.js`               | What a file is: `Preparers`, `prepareInput()`, `bytecodeFor()`                                                                                            |
| `lib/publication.js`            | `inputOf()`: a source's canonical input, for either sink; the stateless SAB sink, `sharedPublish()` / `sharedCopies()`: hands the kernel what to stage    |
| `lib/compressor.js`             | `Compressor`: codec work only                                                                                                                             |
| `lib/pins.js`                   | `Pins`: per-thread direct consumers of shared versions                                                                                                    |
| `lib/retirement.js`             | `Retirement`: the books of ACK-before-free — retired versions, the ACKs they wait for, their holders; decides what is free, frees nothing                 |
| `lib/serial-queue.js`           | `SerialQueue`: one task at a time, arrival order                                                                                                          |
| `lib/pool.js`                   | `pool()`: a list worked through at most `limit` calls at a time, stopping at the first failure; `IO_LIMIT`                                                |
| `lib/place.js`                  | `Place`: projection (`PlaceFiles`, with its directory index), `visible()`, `cached()`, `scripted()`, `prepared()`, `preparerOf()`, `companions()`         |
| `lib/place-fs.js`               | `PlaceFs` facade, `VfsReadStream`, view leases, disk territory of `fs.fallback: 'disk'`                                                                   |
| `lib/registry.js`               | `PlaceRegistry` (path → place, key; `Containment` in `appRoot`) + `FsRouter` (read / mutate / copy / rename / link decisions)                             |
| `lib/aliases.js`                | `Aliases` (strict): what the disk says, once each, about other spellings of `appRoot` — its real path, what a drive letter names                          |
| `lib/virtual-store.js`          | `VirtualStore`: the semantics of a virtual place's mutations, once — checks, their order, refusals (`checkHierarchy`, `subtreeMoves()`); `KeysInFlight`   |
| `lib/map-store.js`              | `MapStore` (a `VirtualStore`): mutations at once on the thread's own Map; the Map sink of the pipeline, atomic publish                                    |
| `lib/sab-store.js`              | `SabStore` (a `VirtualStore`): main-thread mutations of a `sab + virtual` place, each in its key's turn; keys in flight                                   |
| `lib/mutation-queue.js`         | `MutationQueue`: per-(place, key) ordering, exclusive place barrier                                                                                       |
| `lib/mutation-rpc.js`           | `OPS` for both ends; `MutationClient` + `RemoteStore`: worker → main mutations; `serveMutation()`: the main end, checking each request again              |
| `lib/scanner.js`                | `scan()`: directory walk, then stats `IO_LIMIT` at a time → `Map<key, FileInput>` in the order of the walk                                                |
| `lib/watch-pipeline.js`         | `WatchPipeline`: watcher epochs into kernel epochs, one at a time (`SerialQueue`), their jobs `IO_LIMIT` at a time; rechecks                              |
| `lib/watcher.js`                | `DirWatcher`: `fs.watch` over each place tree (recursive where native, else one per directory) → debounced epochs; `watchPath()`                          |
| `lib/disk.js`                   | the disk past the patch: `node:fs` captured at load; the native section (`native()`, `inNative()`) for calls that re-enter it; own `fs` for streams       |
| `lib/companion.js`              | companion keys: `src\0require:bytecode`, `src\0script:bytecode`, `src\0fs:<enc>`                                                                          |
| `lib/stats.js`, `lib/errors.js` | `VfsStats` / `VfsDirent`, a listing's result (`listing()`); node:fs-shaped errors                                                                         |
| `lib/adapters/fs-patch.js`      | table-driven `node:fs` patch executing router decisions: the operation cores and their variants, guards, glob, watch, the strict root's listing, install  |
| `lib/adapters/fs-copy.js`       | the copy engine of the patch: a copy's options, the source's raw input, the write through the destination — its store or the disk                         |
| `lib/adapters/fs-surface.js`    | every export of `node:fs` and `node:fs/promises` the patch knows, and what it does with each: implemented, guarded, delegated, path-free                  |
| `lib/adapters/fs-dir.js`        | `VfsDir`: the `fs.Dir` of the patch's `opendir`, over a listing taken when the directory is opened, with the `node:fs` close semantics                    |
| `lib/adapters/module-hook.js`   | `module.registerHooks` resolve/load + `_compile` cached data                                                                                              |
| `lib/bootstrap/*`               | `register.mjs` (main thread, `--import`), `attach.js` (workers)                                                                                           |

## Places and configuration

**A place is one directory under `appRoot`; its name is also the mount, the
cache namespace and the snapshot/delta key.** _Why:_ one identifier and no
mapping table; the router maps any path to its place with one lookup on the
first path segment; a place is enabled or disabled without rewriting paths.

**Provider (where bytes live) and origin (where content comes from) are
independent axes.** `sab` / `sea` keep bytes in the SAB pool, `map` in a
per-thread Map, `disk` / `node-default` are passthrough mounts; `sab` and
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

**A place's projection indexes the directories its source keys imply
(`PlaceFiles`: `Map<dir, Set<name>>`), kept by the projection's own `set`
and `delete`.** A directory lookup costs the depth of its key, a listing
the size of what it lists. _Why:_ directory lookups sit on hot paths —
routing a directory or a miss, `stat`, `exists`, listings, the hierarchy
check before every new key — and scanning every key made each linear in
the size of the place (a third of a millisecond at 50 000 keys, against a
tens of nanoseconds indexed). Kept inside the Map, the index follows every
writer — kernel deltas, Map stores, worker snapshots — without one call
site to forget; filling it costs about 0.3 µs per key.

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

## Storage

**Pooled SAB segments (default 64 MiB), a best-fit allocator; emptied
segments are reused, never returned to the OS.** _Why:_ one SAB per file
would exhaust mmap regions and fragment the address space; returning a
segment would require every thread to drop its views, which cannot be
coordinated cheaply; reuse is enough.

**Companions — bytecode flavors and compressed representations — are
separate entries under NUL-separated keys.** _Why:_ every entry stays one
contiguous extent, companions travel through snapshot, delta, retirement and
compaction without special cases, and a NUL cannot occur in a file name, so
companions never collide with files nor leak into listings.

**Disk files above `maxFileSize` stay disk entries; content without a disk
file of its own — prepared, virtual or SEA sources, and every companion —
never falls back to disk: if it does not fit, its publication is refused
(and `initialize()` fails), as a full disk refuses a write: `ENOSPC`,
named by the operation (Failure policy).** _Why:_ large media do not
belong in the pool; a disk entry must point at a file that holds exactly
the content, and for prepared, virtual or compressed content there is
none — a disk entry would point at the raw source, or at nothing. A pool
without room is a disk without room to the caller: a refusal with a
`code` of its own, like every other refusal of the VFS.

## Publication

**One pipeline for every source of content: raw input → the preparer of
its extension (once) → canonical content → bytecode flavors → compressed
representations → one epoch.** Initial scan, watcher, SEA assets, virtual
writes from any thread and Map writes all use it. _Why:_ what a file _is_
cannot differ between init and live updates or between origins, and
atomicity and failure semantics are enforced in one place.

**Index-at-flush: allocations are private until `#flush` commits an epoch
to the index in one synchronous step.** _Why:_ `snapshot()`, `link()` and
compaction only ever see published state; a failed or abandoned attempt
frees only its own bytes; the entry a change replaces is read at commit
time, so two publications can never retire the same version twice.
Consequence: there is no global commit lock — virtual publications of
different keys may overlap.

**The SAB sink (`lib/publication.js`) places the bytes; the kernel commits
them. `sharedPublish()` allocates a canonical input's source, bytecode
flavors and compressed representations privately and hands back the
changes to stage — each new version, then each stale companion to drop;
`sharedCopies()` the versions of a subtree under their new keys and the
old keys to drop; `inputOf()` makes the canonical input for either sink —
a raw input read through the kernel's reader, its preparer run once — and
the Map sink is `MapStore.publish()`. A failure frees the attempt's own
allocations and nothing else. The sink keeps no state and calls nothing
private: it reads the kernel's `cache` and `compressor` at each call —
after `close()` both are gone — and the kernel stages what comes back into
its epoch.** _Why:_ what a publication places is one idea; what commits it
— the index, retirement, the pins, the links — is the kernel's, so the
commit stays a private step of the owner of that state. A sink that kept
the pool or the compressor would outlive `close()` and serve a later
kernel from the old pool; one that kept a function — the reader, a free, a
codec — would miss the one a test puts on the kernel's objects.

**One `vfs-update` per epoch or accepted mutation; a file's source and
companions travel together, a companion that failed to rebuild is listed in
`removals` of the same message.** _Why:_ V8 accepts cached data by source
length, not content — a same-length edit next to a stale companion would run
old bytecode silently.

**A commit that publishes takes a version: the next number of the main
kernel's count of publications (`#version`), which `#flush` stamps into
every entry it publishes before the index takes it — the entry is private
until then — and sends in its `vfs-update`; every snapshot carries the
kernel's, and each thread takes it in `#apply`: the main thread in
`#flush`, a worker update by update. A commit that publishes nothing — an
empty epoch, a mutation that changes nothing — takes none, and neither
does a relocation (`ep.relocation`): the copies it publishes keep the
version of the entries they copy. A snapshot also carries `instance`, the
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
`EventEmitter`, and `#apply` — the one code of the main thread and of a
worker — turns an update of a newer version into one `'publish'` event:
its version and the source keys it created, replaced and removed, by
place, deep-frozen. `#announce` emits it in a microtask of its own, which
drops it once `close()` has come; `close()` emits `'close'` once, in a
microtask, then drops every listener. The lists are built only when
there is a listener. No `'error'` is ever emitted; what a listener throws
is an uncaught exception.** _Why:_ an application reacts to what was
published — a cache keyed by version, a route table, a worker waiting for
a write — and a raw `fs.watch` reports disk events, not publications, of
disk-origin places only. Built in `#apply`, an event is the same in every
thread and follows the order of the updates; a relocation, of the same
version, is none. A microtask runs no application code inside the commit
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
kernel opens for it, `{ publish(place, key, file), unstage(place, key),
flush() }`, bound to an epoch of the kernel's own whose state never leaves
the kernel; anything else it reads from the kernel's public state when it
runs, never while the kernel is being constructed.** _Why:_ a commit writes
the index, retires what it replaces, binds the pins and tells the links —
all the kernel's; bound to its epoch, a `flush()` commits what was
published there and nothing else.

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
closed-kernel error. Live updates keep the previous version and
companions. `require.compile` is
best-effort. A source `fs.script.compile` cannot compile is one error
wherever it is published: `ENOTSUP` (`fs.script.compile: source does not
compile`), `syscall` `open`, `path` the source's — `bytecodeFor()` throws it
for the SAB and the Map sink alike, and a worker's mutation gets it back
with the same fields. A rename that publishes a source under a new name
refuses it as the rename: `rename`, the renamed source as `path`, the new
name as `dest` — the operation hands the pipeline its `fail`, and so it
does for a preparer the thread lacks. What the pool has no room for — a
source, a script flavor, the copy of a subtree a rename moves — is
`ENOSPC` (`no space left on device`, what did not fit as its detail),
named the same way: `open` of the key, else the operation's `fail`, which
the rename of a subtree hands `sharedCopies()` too; a copy into a virtual
place fails as the copy, the store's refusal as its `cause`. _Why:_
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
means a projection dropped the version, not that its consumers finished; a
timeout would bring the bug back under load.

**The `retireId` exists only from retirement until the free — no permanent
allocation id per entry. It is a monotonic counter of the main kernel,
never reused, and travels beside the change in the update, never inside the
new entry.** Records keep place, key, size and time for internal
diagnostics (`kernel.retirements()`, labels like `static:/a.mp4 [fs:br]#17`,
never parsed back). _Why:_ current entries are identified by (place, key);
a permanent id would bloat every entry and message for the rare case; a
never-reused id means a late release can never match a later retirement.
The public version of a file (Publication) is no `retireId`: it names the
commit that published the file, shared by every entry of that commit, and
a relocation does not change it.

**`diagnostics()` is the public, read-only picture of the shared memory:
the pool's usage and fragmentation; what the published versions take of
it; the retired representations — a source or one companion each — and
what they wait for; what the main thread and each link still hold; each
link's pending ACKs — the age of the oldest shows a stuck worker; the
sources served from disk because the pool had no room for them; the
failed preparations, by place; the work queued — watcher epochs and
rechecks, the keys and barriers of virtual mutations. It is taken when
asked, from the pool (`FilesystemCache.usage()`), the books
(`Retirement.summary()`, `heldBy()`, `pendingOf()`), the links, one walk
of the index and the queues' sizes; its one counter, a place's failed
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
kernel, which owns the index, the links and the pins an update commits to.

**A consumer pins only the representation it reads — the source or one
companion; each is retired and freed on its own.** _Why:_ pinning a whole
file bundle, or a segment, for one slow reader would keep unrelated bytes
out of the pool.

**Each thread pins direct consumers by the projected entry object; IPC
happens only when a pinned version is retired: its id in the ACK
(`retained`), then one `vfs-release`.** _Why:_ the projected object is the
identity of a physical version for free; pinning a current version happens
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

**A closed link port is the worker's exit: its pending ACKs and its holds
are dropped.** _Why:_ a thread that is gone reads nothing; waiting for it
would keep its retired versions forever.

**`map` places take no part in retirement; their leases and releases are
no-ops.** _Why:_ a Map entry is an owned Buffer the GC keeps alive; an
update never reuses its bytes.

**Compaction moves published entries only and closes the segment it
empties; retired extents never move.** _Why:_ moving a retired extent would
invalidate its readers; the closed segment returns to the pool when its last
retired bytes are freed. Publishing into a closed segment reopens it.

## Preparation

**`prepare` is declared by a domain but prepares the file: one declaration
per extension per place; a second declaration — even of the same preparer —
is a config error, with no domain priority and no merging. The error names
every declaration of the extension, across domains and inside one.** _Why:_
a file has one canonical content shared by every domain; two declarations
would be ambiguous, and silent priority rules hide configuration mistakes.
An error that named the first two sent the user back once per extra
declaration.

**The short form `prepare: 'name'` covers the domain's own finite `ext`; an
unrestricted fs takes only the object form; `fs.script.ext` is never its
scope.** _Why:_ "every file" is not a meaningful preparation target, and the
script extensions are a consumer filter, not a declaration.

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
synchronous Map writes and the watcher pipeline; running on read would
multiply the CPU cost per thread and request; cloned, frozen results
travel to workers and cannot change after publication.

**A `Uint8Array` a preparer returns for a shared place is copied once,
straight into its provisional SAB allocation, synchronously inside
`prepareInput` (the SAB sink hands it `cache.allocateSync`) and before
`meta` / `scriptOptions` are cloned; the publication then places the
companions around that entry, and a failure — a copy that throws, extras
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

## Virtual places and worker mutations

**The main kernel alone owns the allocator, preparation, publication,
retirement and compaction; workers mutate `sab + virtual` places through an
RPC over their link port.** The response follows publication — the update is
posted first on the same port — and the payload travels as a detached copy.
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
worker's projection is read-only and never authoritative; one description
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
is; a store only executes it — `MapStore` at once, on the thread's own Map,
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

**`map` places are per-thread and never part of a snapshot.** _Why:_ fast,
synchronous scratch space without coordination; shared writable state goes
through `sab + virtual`.

**Renaming a virtual entry keeps its mtime, like a rename on disk; a file
renamed onto itself, once the rename's checks pass, changes nothing — no
publication, no `vfs-update` — as `node:fs` renames a file onto itself.**
_Why:_ a move is not a write: the content is the same, so is its time — in
`sab` and `map` places alike. Onto itself nothing moves at all: the SAB
store republished the file under its own key, retiring the old version
and telling every worker, while the Map store left it as it was.

**A virtual place keeps the hierarchy of a filesystem: a path is a file or a
directory, never both. One check (`checkHierarchy`) runs before every
mutation that creates a primary key — write, append, copy, file rename,
subtree move — in `map` and `sab` places alike: a file above the key is
`ENOTDIR`, a directory at it `EISDIR`. A key whose publication has begun
counts as a file until it commits or fails (`SabStore`'s keys in flight),
so two mutations running together cannot create `/f` and `/f/x` both as
files. The keys in flight are indexed by the directories above them
(`KeysInFlight`, a count per directory), so a key in flight above or below
a key is found in the depth of that key. Directories stay implicit:
`mkdir` creates no entry, but answers from the same hierarchy
(`checkMkdir`: `EEXIST`, `ENOTDIR`); `unlink` of a directory is `EISDIR`,
`rm` of one without `recursive` the `ERR_FS_EISDIR` `node:fs` throws.**
_Why:_ implicit directories let `/f.txt` and `/f.txt/x` both exist — a
structure no filesystem has, for which listings, `stat`, subtree
operations and a later copy to disk have no consistent answer. Per-key
ordering lets mutations of different keys overlap, so the published index
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
accepted mutation: its arguments are checked when it is called; its keys
are locked in one step (`MutationQueue.run` with every key); in their
turn, before any file is prepared, the whole set is checked — against the
place and the keys in flight as a write is, and against itself: a key
below another key of the set is `ENOTDIR` (`ancestorIn`); then its keys
count as files in flight (`createAll`) while each file is prepared once,
in the order given. A `sab` place publishes the set in one epoch of the
kernel (`publishVirtualBatch`), one file after another, and commits it
once — one `vfs-update`, one version, one event, one mtime — or abandons
it (`#abandon`): what its files staged goes back to the pool. A `map`
place computes every file — its preparer, its bytecode — before it sets
the first (`#plan`, then `#apply`). Refusals are the set's: `syscall`
`writeFiles`, `path` the key's. A disk-origin place refuses a set
(`ENOTSUP`); a set has one flag and no removal.** _Why:_ files that only
work together — a route table and its handlers, a page and its assets —
must never be seen apart, by any thread, and a series of writes publishes
each alone. The index-at-flush already makes an epoch invisible until its
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

**Under strict the registry learns two things from the disk, each once,
through `realpath.native` captured at load (`aliases.js`): `appRoot`'s real
path, when the kernel is built, and on Windows what a drive letter other
than `appRoot`'s names, the first time a path on it is routed. Where the
real path differs from `appRoot` as spelled — `appRoot` through a link, a
subst drive, a namespace or 8.3 names — it is a second spelling: a path in
or below it is owned by nobody, a directory above it encloses the places,
and a short name where a path leaves it may stand for it. A drive whose
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
which directory a letter or a link names only the disk knows. Asking once
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
(`{ kind: 'passthrough', place }`), and the kernel's route API asks the
disk where the path really lies before it hands the route on
(`VfsKernel#proven`, `Aliases.territory`): `realpath.native` of the path —
for a path to create, of its nearest existing ancestor with the rest after
it — and, once, of the place's directory. In the place's directory, or off
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
what a path there reaches anyway, so it is followed; refusing every link
out of the place would break the shared directories a release links in.
`node:fs`'s own recursive `readdir` enters a junction even with
`withFileTypes` (Node 22 to 26 on Windows) and its `cp` copies what a
junction holds, so neither walks a place's disk under strict; `opendir`,
`rm` and a recursive `watch` enter none. Node's resolvers take a module's
real path — through the patched `realpath`, which refuses the link — but
not with `--preserve-symlinks`, which the load hook covers. Each native
call on a place's disk pays one `realpath` (tens of microseconds on
Windows; doc/benchmarks.md); a link swapped in between the answer and the
call is not seen, as no path-based check can see it.

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
(`FsRouter.linksInto`): a `symlink` whose target, resolved from the link's
directory as the OS resolves it, the registry places below `appRoot`, at
it or above it — in any spelling it knows — and a hard `link` to a file
below `appRoot` are `EACCES` before any native call, a link within one
place included. In either mode a symbolic link's target is routed as a
read from the link's directory, where it was routed from the cwd.** _Why:_
a junction takes no privilege, so any code under strict could make itself
a path outside `appRoot` into a place, `appRoot` or a directory above it,
past every lexical check; a hard link to a file of a read-only `disk`
place gave it a writable name in a writable one. What a link names is
what a read through it reaches, so its target is routed where the OS
resolves it. A link within one place is refused too: which names of a
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

**A key keeps its case — in the index, in keys, in errors. Where the disk
would answer a miss — the non-strict `'disk'` fallback, and Node's own
loader behind the module hooks without strict — a path naming a published
source held in memory in another case answers as that source's own
spelling does. On Windows a disk-origin place keeps, as an index, the
lower-casing of each source key that has capitals (`PlaceFiles.spelling`,
`Place.spelling`); the exact key is looked up first. A disk-backed entry
is read from disk by the name given, as before; a directory in another
case is no published directory (`'disk'` lists its disk territory there,
`'deny'` refuses it); V8 cached data is looked up by the key as spelled; a
virtual place keeps exact keys. Strict refuses another case like any path
the place does not publish, and `'deny'` always does.** _Why:_ the index
compares keys exactly, a Windows disk does not: without strict, `A.TXT` of
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
companion — and the destination publishes it through its own pipeline; a
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
  `mkdir`, `rm`, `rename`, `copyFile` and a non-recursive `cp`.
- _Recognized but unsupported for managed territory_ (`ENOTSUP`): `open` of
  a virtual entry, whatever its flags; a copy or `rename` of a prepared
  virtual entry, a copy of a place directory; a recursive `cp` of or into
  managed territory; a hard link into or out of a place; `watch` of managed
  territory; recursive walks (`readdir`, `opendir`, `watch`, `rm`, `rmdir`)
  and `rename` of a tree that holds places; a directory renamed across a
  place's boundary (a place's root included); a virtual subtree rename that
  is not raw-only; guarded mutations in a virtual place. A hidden source is
  `EACCES`.
- _Native passthrough outside managed territory_: unrelated paths outside
  `appRoot`, `disk` / `node-default` places, disk-territory files,
  unmanaged paths without strict; `symlink`, its target routed from the
  link's directory; and the guarded APIs (`chmod`, `chown`, `utimes`,
  `truncate`, `readlink`, `statfs`, `watchFile`, `rmdir`, `mkdtemp`,
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
a native destination is `node:fs` itself. Companions are never copied.
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
Compressed or bytecode companions are derived from the content; the
destination rebuilds its own. Refusing every copy of served content made
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
canonical content, preparation and companions; the second name would also
escape the place's mutation policy: it can be a writable alias of a
read-only place's raw file, and a write through it may never reach the
place's watcher. A copy gives the same bytes without sharing the file.

**A native rename moves the raw file. Both paths pass the mutation
routing and the source the read routing: a hidden source is `EACCES`. A
published disk-origin file may leave `appRoot` or change its extension; the
watchers then drop the old canonical entry and publish the new key by the
policy of its place and extension. A directory moves natively only within
one disk-origin place; across a place's boundary, as a place's root, or as
a tree that holds places it is `ENOTSUP` (`FsRouter.rename`: `crossing`,
`unsupported`). Under strict a rename that leaves any place — a `disk` or
`node-default` one too — or enters an indexed one moves a regular file
only (`crossing` with `file`): a directory, the place's own included, or a
link is `ENOTSUP`.** In a virtual place the store moves an ordinary entry
atomically and keeps its mtime — the preparer of a new extension runs
once — and refuses a prepared one (`ENOTSUP`); a directory moves as a
raw-only subtree (below); across a virtual boundary a rename is `EXDEV`. _Why:_ the raw file is a disk-origin
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

**A virtual directory renames as a whole subtree when every source under it
is raw-only — not prepared, not compiled (`require.compile`,
`fs.script.compile`), without `scriptOptions` or `meta`
(`subtreeMoves`).** Every source and the companions it has — compressed
representations — reappear under the new prefix with their bytes, stat and
mtime, and the old keys go, in one publication: one `vfs-update` for SAB, a
swap of the entries for a Map. Nothing is prepared, compiled or compressed
again. SAB copies each version into a fresh allocation and retires the old
one through ACK-before-free; the move takes the place barrier. One source
that cannot move refuses the whole subtree (`ENOTSUP`); an existing
destination (`ENOTEMPTY`, `ENOTDIR`) and a move into itself (`EINVAL`)
are refused before anything changes; the place's own directory never moves.
_Why:_ implicit directories are no reason to refuse a rename: a prefix
rename changes no content, extension or config, so compressed bytes stay
valid as they are, and recompressing would only cost time. What depends on
the key cannot be carried over — a preparer's input is not kept, bytecode
was compiled under the old filename, metadata may name the old path — and
running the pipeline again is left for later; moving only the other entries
would split the tree. Copying keeps each projection one physical version,
so a pin on an old version keeps protecting its bytes.

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
`roXXXXXX` next to it. A virtual place's directories are implicit, so a
temporary one would not exist once made.

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

**`load` returns the source decoded to a string.** _Why:_ the ESM loader
may compile after an async gap, when the shared bytes could already belong
to a newer version.

**`--import shared-memory-fs/register` bootstraps the main thread;
workers call `attach()`.** _Why:_ preloads do not run in worker threads.

## Rejected designs

| Design                                                                                                          | Why not                                                           |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Preparer functions inside `VfsConfig`                                                                           | the config must stay structured-cloneable for workers             |
| Async preparers                                                                                                 | they run inside synchronous Map writes and one atomic publication |
| Domain priority or merging of `prepare` declarations                                                            | hides mistakes; one extension, one declaration                    |
| `fs.script.prepare`                                                                                             | preparation belongs to the file, not to the script consumer       |
| Synchronous worker mutations via `Atomics.wait()`                                                               | deadlock- and stall-prone                                         |
| Workers allocating in SAB                                                                                       | one writer keeps the allocator lock-free                          |
| Echoing file bytes in mutation responses                                                                        | the bytes are already in SAB; the update carries metadata         |
| Provisional entries in the index                                                                                | snapshots and compaction would observe unpublished state          |
| Parallel watcher epochs                                                                                         | an older epoch could publish over a newer one                     |
| Committing an epoch (`#flush`) outside the kernel                                                               | it writes the index, retirement, pins and links the kernel owns   |
| A watch pipeline that holds the kernel's epoch state and passes it back (`publish(ep, …)`, `flush(ep)`)         | kernel state leaves the kernel; no commit is bound to its epoch   |
| A publication sink that stages into the kernel's epoch, or keeps its pool or compressor                         | kernel state leaves the kernel; a kept pool outlives `close()`    |
| Unbounded jobs of a watcher epoch                                                                               | a descriptor per changed file: `EMFILE` at `ulimit -n 1024`       |
| A scan's stats pooled per directory, or listed in the order they finish                                         | no faster on sparse trees; init's order would change run to run   |
| A permanent allocation id in every entry                                                                        | retirement needs an identity only while a version is retired      |
| `updateId` as the public version                                                                                | it counts relocations, which change no file; the ACKs' books      |
| A `retireId` as the version of a file                                                                           | one per representation, and only until its free                   |
| A hash of the content as the version                                                                            | a pass over every byte; no commit identity (a preparer's `meta`)  |
| A clock or random ids as versions                                                                               | a clock repeats; neither orders commits nor names one             |
| The version in `stat()`                                                                                         | `VfsStats` stands in for `fs.Stats`, which the patch returns      |
| A version per thread for the files of a map place                                                               | one file, another version in each thread: a false ETag match      |
| Emitting `'publish'` inside `#flush`                                                                            | application code inside the commit; init's before it is ready     |
| Emitting `'publish'` with `process.nextTick`                                                                    | runs after the mutation's promise has settled                     |
| A separate `kernel.events` emitter, an `EventTarget`, `subscribe(fn)`                                           | a second object; no `events.on` / `once`; not the Node idiom      |
| Entries, stats or views in an event                                                                             | a listener would hold shared bytes, or read stale ones            |
| Replaying the current state to a new listener                                                                   | that is `snapshot()` and the reads                                |
| Logging what a listener throws                                                                                  | hides the application's error; no emitter of Node does it         |
| Locking the keys of a set one by one, or under the place's barrier                                              | hold-and-wait; the barrier stops writes of unrelated keys         |
| The keys of a set in `creating` while it is checked                                                             | the refusal would depend on the order of the keys                 |
| Preparing the files of a set in parallel (`pool()`)                                                             | a failure leaves work in flight that stages after the abandon     |
| Removals or a flag per file in a set                                                                            | widens a write; a second shape of request and of refusal          |
| A set of a disk-origin place                                                                                    | the disk commits files one by one                                 |
| The version as the result of every mutation                                                                     | changes every result; `version(key)` answers it                   |
| A request, or a transferred buffer, per file of a worker's set                                                  | a set would reach the main thread in parts; K transfers           |
| IPC per chunk or per pin                                                                                        | pins of current versions must stay local                          |
| Freeing a retired version on a timeout                                                                          | reuse under a slow reader returns another file's bytes            |
| Retirement books that free the bytes themselves                                                                 | a free starts a compaction, whose epoch only the kernel commits   |
| Diagnostics counted on the read or publication path (hits, fallbacks, ACK ages)                                 | every request pays for a question asked every few seconds         |
| A diagnostics call that settles, frees or compacts                                                              | looking would change what is looked at                            |
| GC-driven release of views                                                                                      | use-after-free for destructured views and subarrays               |
| Releasing zero-copy streams on `'end'`                                                                          | sockets still hold the last chunks                                |
| Manual worker transports (`broadcast`, `getWorkerIds`)                                                          | every one would have to re-implement retirement                   |
| `startsWith('..')` containment, `realpath` in the router                                                        | misroutes `..private`; disk access on the hot path                |
| Lower-casing a place's name on Windows to compare it                                                            | NTFS takes no Kelvin sign `K` for `k`: an unmanaged directory     |
| Storing keys lower-cased on Windows                                                                             | keys and errors keep their spelling; an index finds other cases   |
| Looking a key up in another case under strict, or for a disk-backed entry                                       | strict refuses it already; a wider match reads another file       |
| Other spellings of a virtual place's keys                                                                       | its reads and mutations would disagree (`exists` against `wx`)    |
| Refusing every miss of a cached extension without strict on Windows                                             | the permissive default's unpublished files; unlike on POSIX       |
| Mapping UNC and namespace spellings (`\\?\C:\…`, `\\localhost\C$\…`) onto `appRoot`                             | no list of aliases is complete; the OS says what a share names    |
| Stripping a stream suffix to route the file before it (`a.txt::$DATA` as `a.txt`)                               | the file system says which stream a name opens, not the strings   |
| Resolving short names in the router (`GetLongPathName`, `realpath` per path); listing the real aliases          | disk access on the hot path; only the disk knows every alias      |
| Refusing every short name on `appRoot`'s drive                                                                  | past a differing name none stands for `appRoot` (`SYSTEM~1`)      |
| Refusing every name where `appRoot` has a short one (its long name may be any)                                  | refuses its siblings; `appRoot`'s real path names the long one    |
| Auditing every drive letter when the kernel starts                                                              | touches every mapped drive's server; a disconnected one stalls    |
| Mapping a drive or a share onto the local path it may name                                                      | the server says what a share names; no list of aliases is whole   |
| Refusing every link out of a place's directory under strict                                                     | one elsewhere reaches nothing new; shared directories of releases |
| A proof kept per directory of a place's disk                                                                    | a directory swapped for a link after it passes unseen             |
| The proof in FsRouter, or `realpath` for every native call under strict                                         | the router stays lexical; all other I/O would pay for it          |
| `node:fs`'s recursive `readdir` or `cp` over a place's disk under strict                                        | they enter junctions, `readdir` even with `withFileTypes`         |
| A new link within one place under strict                                                                        | the place decides which of its names alias, not code under strict |
| Routing a symbolic link's target from the cwd                                                                   | the OS resolves it from the link's directory                      |
| Native `cp` with a routing `filter` for managed trees                                                           | raw disk bytes, no virtual entries, no canonical content          |
| Copying canonical (prepared) content as a copy's input                                                          | the destination prepares it again; its bundle names the source    |
| Feeding a prepared virtual entry's canonical content back in as raw                                             | stale `meta` / filename / bytecode, a silently different input    |
| Refusing every copy or rename of served content                                                                 | the raw source of truth could not move; the bypass was hidden raw |
| A cross-place `rename` as a copy and a delete                                                                   | not atomic; a virtual place is a filesystem of its own (`EXDEV`)  |
| Refusing every virtual directory rename                                                                         | a prefix rename changes no content; raw-only trees can move       |
| Re-keying a SAB allocation in place on a subtree move                                                           | a pinned version would get a second projection, its pin unheeded  |
| Recompressing, re-preparing or moving part of a subtree                                                         | wasted work; no raw input; a tree split between two names         |
| A hierarchy check against the published index only                                                              | two overlapping mutations would both pass                         |
| A mutation committed by a `#flush` that returns silently on a closed kernel                                     | the write resolves, though nothing was published                  |
| Locking every ancestor of a created key                                                                         | serializes all writes of one directory                            |
| One store class over an execution engine, its results sync or thenable                                          | a thenable test of every result; a subclass knows its execution   |
| Scanning every key for implicit directories                                                                     | linear in the size of the place, on hot paths                     |
| Scanning the keys in flight for one below a key                                                                 | every check linear in the keys in flight, a set's thousands       |
| Updating the directory index at each mutation site                                                              | one new call site could forget it                                 |
| A native watcher for a published file                                                                           | raw disk events are not publications                              |
| A full copy per stream, or of its unread rest                                                                   | the cost grows with the file; a pin gives the same stability      |
| Atomics or a global lock per read; pinning a segment or every companion                                         | cross-thread cost on the hot path; holds unrelated bytes          |
| Revisions, cancellation tokens, per-key queues or latest-wins for watcher epochs                                | a FIFO gives the guarantee with less machinery                    |
| Several chained preparers for one extension                                                                     | one extension, one declaration, one canonical content             |
| Copying a preparer's `Uint8Array` result only when its publication places it                                    | the next call of the same turn overwrites a reused output buffer  |
| Preparation that emits extra files, per-domain variants or derived formats                                      | a file keeps its key, extension and one canonical content         |
| A guarded native `opendir`; a native listing of a disk-only directory                                           | a second listing path: hidden raw files, no virtual entries       |
| Native passthrough of the strict `appRoot`                                                                      | lists unmanaged names                                             |
| A glob-only fix for stale patched references; a wrapper that keeps or re-installs a kernel                      | every captured reference is affected; a closed kernel is gone     |
| Filtering the results of a glob that walks natively                                                             | it listed hidden names already, and handed them to `exclude`      |
| Pruning a native glob with `exclude`                                                                            | bare names in its `**` branch; skipped when `cwd` is not the cwd  |
| Emulating glob over the places with `path.matchesGlob`                                                          | `x/**` matches `x`, `./` and `..` prefixes, literal case differ   |
| An asynchronous native section (`AsyncLocalStorage`)                                                            | user callbacks inherit it, past strict; `async_hooks` cost on 22  |
| Own primitives in place of `rmSync`                                                                             | rewrites its retries (`EBUSY`, `EPERM`, `maxRetries`) and errors  |
| A native section around `cp`                                                                                    | its `filter`, the caller's code, would read past strict           |
| Refusing an `open` that writes only where the mutation routing denies it                                        | a virtual place's directory on disk still got a stray file        |
| Routing an `open` that writes by the mutation routing alone                                                     | a `+` flag would read what strict hides; no raw file when virtual |
| Refusing every descriptor to a published disk-origin entry                                                      | `writeFileSync` opened the same raw file; `createWriteStream` not |
| A descriptor that reads and writes (`+`) a published disk-origin entry                                          | it reads the raw file where `readFile` gives the prepared content |
| Preloading rimraf when the package is imported                                                                  | races a synchronous `install()`; disk I/O on every import         |
| An asynchronous rimraf preload that `initialize()` waits for                                                    | a worker's `attach()` installs the patch before it could load     |
| Telling by its name or its arguments whether an unknown `node:fs` function takes a path                         | a wrong guess is a strict bypass                                  |
| Refusing strict on a Node whose `node:fs` has an unknown export                                                 | stops every application for an export perhaps path-free           |
| Standalone place-level `script` domain, provider `memory`, `vfs:` URLs, metawatch, root-level `ext` / `compile` | superseded by the place / domain model; no aliases                |

## Invariants

- Projections are `Buffer.from(sab, offset, length)` views; `readFile*`
  returns owned copies; direct access goes through leases and streams that
  pin their version.
- The config is deep-frozen and never mutated at runtime.
- The index holds published entries only; every publication commits in one
  synchronous `#flush`.
- A retired version is freed only after all linked workers ACKed its update
  and no thread holds it; nothing is freed on a timeout.
- `diagnostics()` reads: it frees, settles, compacts and publishes
  nothing.
- Compaction never moves or overwrites retired bytes; emptied segments are
  reused, never returned to the OS.
- Source and companions of a file are published in one `vfs-update`.
- Watcher epochs never overlap; the jobs of one run at most `IO_LIMIT` at a
  time, one that fails holds up nothing else, none starts after `close()`,
  and one in flight at `close()` starts no disk call after it beyond the
  rest of a read it began, and runs no preparer.
- A closed kernel publishes nothing and arms no timer: a watcher event
  whose `stat` lands after `close()` is dropped.
- A mutation of a virtual place never resolves without its commit: one
  whose kernel closes before it rejects as the closed kernel.
- The version is the main kernel's count of publications: a commit that
  publishes raises it by exactly one and stamps it into every entry it
  publishes; a relocation and a commit that publishes nothing change
  neither. An entry has the same version in every thread, and never a
  wall-clock time or a `retireId`.
- `'publish'` is emitted once per publication a thread applies, after the
  commit, in the order of the versions; never for a relocation, never
  once `close()` has returned. An event holds no shared bytes; `'close'`
  comes once, last.
- Companions never appear in `readdir`, `exists`, routing or the patched fs;
  `Place.companions(key)` enumerates them — never hand-roll key lists.
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
- A copy or a rename hands on the raw input only — never a prepared result
  or a companion; the destination prepares it once, and a virtual
  destination never gets a disk file.
- A virtual subtree moves in one publication or not at all.
- A set of `writeFiles` is published in one commit or not at all: a
  refusal, a failure or `close()` leaves no allocation, no key in flight
  and no lock of it.
- A virtual path is a file or a directory, never both — also while
  mutations overlap.
- A projection's directory index says what a scan of its keys would say.
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
  facade or the load hook — runs before the disk has said its path really
  lies in the place's directory or off `appRoot`'s line; a recursive
  listing there enters no link, and no native recursive copy walks it.
- Under strict the patch makes no link, symbolic or hard, to managed
  territory.

## Protocol

```
snapshot    { segments: [{ id, sab }], places: { <name>: { entries: [[key, entry]] } },
              version, instance }
vfs-update  { name, updateId, version, places: { <name>: { entries, removals,
              retired: [[key, retireId]] } }, newSegments: [{ id, sab }] }   main → worker
vfs-ack     { name: 'vfs-ack', updateId, retained?: [retireId] }              worker → main
vfs-release { name: 'vfs-release', retireIds: [retireId] }                    worker → main
vfs-mutate  { name, id, place, op, key, to?, options?, data? }                worker → main
            writeFiles: { name, id, place, op, keys, sizes, options, data }
vfs-mutated { name, id, error?: { code, message, syscall, path, dest },
              version? }                                                      main → worker
entry       shared { kind, segmentId, offset, length, stat, version, scriptOptions?, meta? }
            | disk { kind, path, stat, version, scriptOptions?, meta? }
stat        { size, mtimeMs } (+ sourceSize, encoding for compressed companions)
```

## Testing

- `npm test` runs `test/*.test.js`, each test under a 60 s timeout
  (`--test-timeout`) — the slowest take about a second, so a test that
  hangs where no bounded wait guards it fails — and with
  `--test-force-exit`, which ends the run once every test has reported:
  what a timed-out test waits on may still hold its process, where Node
  24 and later would print the timeout and wait on;
  `npm run test:examples` runs the example smoke suite; `npm run lint` is eslint + prettier. CI covers Linux
  and Windows on Node 22.22.3 / 22.x / 24.12.0 / 24.x / 26.x.
- Concurrency tests are deterministic: gate the injected reader
  (`k.cache.reader`), emit watcher epochs by hand and await
  `k.watchQueue.idle`, observe publication on the main side
  (`k.nextUpdateId`, `k.acks`, `k.retired`, `k.retirements()`), and use
  in-thread links (`test/helpers.js`: `tap`, `worker`, `nextMessage`)
  instead of timers. A `'publish'` event is the point where a commit is
  observed — in a worker, where its update was applied — without polling
  the projection. Tests over real `fs.watch` events or real workers wait
  only for a condition to become true (`until`); nothing sleeps to prove
  that something did not happen. A test that reads what a port delivered
  waits for that message (`nextMessage`, or `until` over the messages),
  never for the projection alone: `#flush` applies an update to the main
  thread's projection before it posts it, and the port delivers it later.
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
  loaded by `install()` over an initialized kernel and over a projection,
  in a worker thread, which loads its own, and with `node:fs` wrapped
  before the library loads (`test/fixtures/rm-wrapped.cjs`: an `rm` that
  defers, a wrapped `lstat`, an `rm` that takes the `lstat` it finds).
- A refused operation is tested for its error (`code`, `syscall`, `path`,
  `dest`) and for leaving nothing behind — no copy, no deletion, no move,
  and no allocation: `leakedBytes()`, the bytes in allocations that no
  published entry and no retired version accounts for, stays 0 (the count
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
