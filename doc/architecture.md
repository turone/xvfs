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
| `lib/virtual-store.js`          | `VirtualStore`: the semantics of a virtual place's mutations, once — checks, their order, refusals (`checkHierarchy`, `subtreeMoves()`)                   |
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
RPC: what its request carries besides the key — bytes, a second key — and
the options its store takes, which travel as booleans. The main end
(`serveMutation()`) takes nothing else from a request: it checks the
mutation, the place, its origin and writability and every key again, and
hands the store the options of the table.** _Why:_ the worker's projection
is read-only and never authoritative; one description keeps the two ends
from drifting apart, and a store never gets an option its mutation does
not take.

**Mutations of shared places are asynchronous; `*Sync` forms are `ENOTSUP`;
no `Atomics.wait()`.** _Why:_ blocking a worker on the main thread invites
deadlocks and stalls both.

**Per-key ordering with an exclusive place barrier for subtree operations;
one update per accepted mutation, no coalescing.** _Why:_ each Promise
corresponds to its own publication; validation and publication see the same
state without serializing unrelated keys.

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
files. Directories stay implicit: `mkdir` creates no entry, but answers
from the same hierarchy (`checkMkdir`: `EEXIST`, `ENOTDIR`); `unlink` of
a directory is `EISDIR`, `rm` of one without `recursive` the
`ERR_FS_EISDIR` `node:fs` throws.** _Why:_
implicit directories let `/f.txt` and `/f.txt/x` both exist — a structure
no filesystem has, for which listings, `stat`, subtree operations and a
later copy to disk have no consistent answer. Per-key ordering lets
mutations of different keys overlap, so the published index alone cannot
decide; locking every ancestor would serialize all writes of a directory,
while a set of keys in flight costs nothing when nothing conflicts.

**A write's flag reaches the store: `w…` replaces, `a…` appends, `x` is
`{ exclusive }`, checked in the key's turn like the hierarchy; a flag a
store cannot honor (read, numeric) is `ENOTSUP`. A copy's `COPYFILE_EXCL`
and cp's `force: false` / `errorOnExist` are that same exclusive write.**
_Why:_ exclusive creation is how callers avoid replacing a file; checked
before the queue, it would not be exclusive.

## Routing and strict mode

**The router decides, the adapters execute; `fs-patch` (with `fs-copy`,
`fs-dir`) and `module-hook` never read the config.** _Why:_ one chokepoint,
uniform across sync, callback, promise and guarded APIs.

**Containment is lexical: only a real `..` component leaves `appRoot`; the
router never stats or resolves paths.** _Why:_ `..private` is a legal name
and must route like any other; the router sits on the hot path of every fs
call. Symlink / realpath containment is out of scope.

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
so without it the route outside costs nothing more. Spellings in drive
form — an 8.3 short name, an NTFS stream suffix, a drive mapped to a
share — stay unrecognized, so `appRoot` is given in the form the
application uses.

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
  `access`, `realpath`, `existsSync`, `readdir`, `opendir`,
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
  unmanaged paths without strict; and the guarded APIs (`chmod`, `chown`,
  `utimes`, `truncate`, `symlink`, `readlink`, `statfs`, `watchFile`,
  `rmdir`, `glob`, and `open` with a flag that writes) once every path
  argument is routed.

_Why:_ an application must be able to tell which calls the VFS serves, which
it refuses and which belong to the operating system — and a new API must
join a group deliberately, never by default.

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

**`glob` results are filtered by route, relative ones against its `cwd`
option.** _Why:_ glob walks with the `node:fs` functions it captured on first
use — native ones if it ran before the patch — so the filter is the only
boundary; resolving results against `process.cwd()` let a glob with a `cwd`
list what strict routing hides.

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
a place, or one that encloses `appRoot`, is `ENOTSUP`.** _Why:_ a native
walk reads raw files past the filtered listings, misses virtual entries and
writes a destination's files behind its store; a recursive copy of a place,
or of a directory above `appRoot`, carried files strict routing denies to a
readable destination. A VFS-aware walk is in `TASKS.md`.

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
`unsupported`).** In a virtual place the store moves an ordinary entry
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
descendants at once, hidden files included, with nothing routed. A prepared
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
entry.** _Why:_ an unimplemented API must not become a bypass; only its
store changes a virtual place — a native `copyFile` into one left a stray
disk file the place never showed; SAB / Map entries have no file
descriptor.

**`open` with a flag that writes — a string with `w`, `a`, `x` or `+`, a
number with `O_WRONLY`, `O_RDWR`, `O_CREAT`, `O_TRUNC` or `O_APPEND` — is
a guarded mutation of what its read routing passes through: `EROFS` in a
read-only place, `ENOTSUP` in a virtual one. The read routing answers
first: a published entry stays `ENOTSUP` and a hidden path `EACCES`,
whatever the flag — the `EACCES` of an `open` that writes always comes
from its read routing. `createWriteStream` opens through `fs.open`, so its
stream gets the same error.** _Why:_ routed only as a read,
`openSync(p, 'w')` and `createWriteStream` bypassed the mutation policy:
they created a file in a read-only place, and a stray one in a virtual
place's directory on disk, which the place never shows. Checked after the
read routing, the check keeps every refusal `open` gave before; what Node's
own implementation opens inside a call the routing passed through
(`writeFileSync` → `openSync`) runs in the native section and is not
routed again.

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

**`initialize()` loads Node's rimraf before anything can install the patch
(`loadRimraf()`, a workaround).** _Why:_ the asynchronous `fs.rm` and
`fs.promises.rm` — and a recursive `rmSync` on Node 22 — are a JavaScript
rimraf that takes its functions from the public `node:fs` when it first
loads. Loaded under the patch, it walked a tree through routing — the
place's listing, not the disk — and, asynchronous, past any section: a
recursive `rm` removed part of the tree and failed with `ENOTEMPTY`. The
bootstrap and a manual `await initialize()` install the patch afterwards,
so they get rimraf over `node:fs` itself; a worker's `attach()` installs
it synchronously, so there an asynchronous recursive `rm` of managed
territory can still walk the routed listing.

**Listings sort and deduplicate the string names, then encode them as
asked; a recursive `encoding: 'buffer'` listing works in places.** _Why:_
the encoding must not change order or duplicates, and a Buffer name cannot
be compared with a string key. Native `node:fs` (22.22.3 to 26.x) fails
`recursive` with `encoding: 'buffer'` — its callback form even crashes the
process — which is a defect, not a documented contract.

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
| Native `cp` with a routing `filter` for managed trees                                                           | raw disk bytes, no virtual entries, no canonical content          |
| Copying canonical (prepared) content as a copy's input                                                          | the destination prepares it again; its bundle names the source    |
| Feeding a prepared virtual entry's canonical content back in as raw                                             | stale `meta` / filename / bytecode, a silently different input    |
| Refusing every copy or rename of served content                                                                 | the raw source of truth could not move; the bypass was hidden raw |
| A cross-place `rename` as a copy and a delete                                                                   | not atomic; a virtual place is a filesystem of its own (`EXDEV`)  |
| Refusing every virtual directory rename                                                                         | a prefix rename changes no content; raw-only trees can move       |
| Re-keying a SAB allocation in place on a subtree move                                                           | a pinned version would get a second projection, its pin unheeded  |
| Recompressing, re-preparing or moving part of a subtree                                                         | wasted work; no raw input; a tree split between two names         |
| A hierarchy check against the published index only                                                              | two overlapping mutations would both pass                         |
| Locking every ancestor of a created key                                                                         | serializes all writes of one directory                            |
| One store class over an execution engine, its results sync or thenable                                          | a thenable test of every result; a subclass knows its execution   |
| Scanning every key for implicit directories                                                                     | linear in the size of the place, on hot paths                     |
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
| An asynchronous native section (`AsyncLocalStorage`)                                                            | user callbacks inherit it, past strict; `async_hooks` cost on 22  |
| Own primitives in place of `rmSync`                                                                             | rewrites its retries (`EBUSY`, `EPERM`, `maxRetries`) and errors  |
| A native section around `cp`                                                                                    | its `filter`, the caller's code, would read past strict           |
| Refusing an `open` that writes only where the mutation routing denies it                                        | a virtual place's directory on disk still got a stray file        |
| Routing an `open` that writes as a mutation before its read                                                     | a published entry would answer `EROFS`, not `ENOTSUP`             |
| Preloading rimraf when the package is imported                                                                  | races a synchronous `install()`; disk I/O on every import         |
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
- Companions never appear in `readdir`, `exists`, routing or the patched fs;
  `Place.companions(key)` enumerates them — never hand-roll key lists.
- Kernel-internal disk I/O (kernel, the publication sink, watch pipeline,
  scanner, watcher, `PlaceFs`, the copy engine) uses `lib/disk.js`:
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
  from the public `node:fs` when it first loads): `initialize()` waits for
  it before publishing; remove it only when every supported Node line
  removes a tree natively.
- `install()` records every replaced `node:fs` property and `uninstall()`
  restores them in reverse; `.native` variants are preserved; with no
  kernel installed, and inside the native section, a wrapper is its
  original.
- Listings are sorted and deduplicated by string name before any encoding.
- A preparer runs once per publication attempt, on the publishing thread,
  never on read; its raw input is never kept in the VFS; a prepared source
  is never a disk entry; `prepare` and `scriptOptions` never turn
  `fs.script` on.
- No native listing, copy, link, rename or watch runs over managed
  territory past its routing, and no descriptor that writes is opened there
  past the mutation routing; a refusal comes before any disk read or
  write.
- A copy or a rename hands on the raw input only — never a prepared result
  or a companion; the destination prepares it once, and a virtual
  destination never gets a disk file.
- A virtual subtree moves in one publication or not at all.
- A virtual path is a file or a directory, never both — also while
  mutations overlap.
- A projection's directory index says what a scan of its keys would say.
- Disk territory never leaves its place (`PlaceFs.#within`) and, under
  strict, never serves or lists a cached extension.
- On Windows under strict, the patch and the module hooks pass no UNC or
  namespace path outside `appRoot` on to `node:fs` or Node's loader: the
  router refuses it first.

## Protocol

```
snapshot    { segments: [{ id, sab }], places: { <name>: { entries: [[key, entry]] } } }
vfs-update  { name, updateId, places: { <name>: { entries, removals, retired: [[key, retireId]] } },
              newSegments: [{ id, sab }] }                                    main → worker
vfs-ack     { name: 'vfs-ack', updateId, retained?: [retireId] }              worker → main
vfs-release { name: 'vfs-release', retireIds: [retireId] }                    worker → main
vfs-mutate  { name, id, place, op, key, to?, options?, data? }                worker → main
vfs-mutated { name, id, error?: { code, message, syscall, path, dest } }      main → worker
entry       shared { kind, segmentId, offset, length, stat, scriptOptions?, meta? }
            | disk { kind, path, stat, scriptOptions?, meta? }
stat        { size, mtimeMs } (+ sourceSize, encoding for compressed companions)
```

## Testing

- `npm test` runs `test/*.test.js`; `npm run test:examples` runs the
  example smoke suite; `npm run lint` is eslint + prettier. CI covers Linux
  and Windows on Node 22.22.3 / 22.x / 24.12.0 / 24.x / 26.x.
- Concurrency tests are deterministic: gate the injected reader
  (`k.cache.reader`), emit watcher epochs by hand and await
  `k.watchQueue.idle`, observe publication on the main side
  (`k.nextUpdateId`, `k.acks`, `k.retired`, `k.retirements()`), and use
  in-thread links (`test/helpers.js`: `tap`, `worker`, `nextMessage`)
  instead of timers. Tests over real `fs.watch` events or real workers wait
  only for a condition to become true (`until`); nothing sleeps to prove
  that something did not happen. The disk calls a closed kernel starts are
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
  and a `node --test` child loads it before any test runs: a glob that kept
  the patched functions is tested in a plain node process
  (`test/fixtures/glob-kept.cjs`). So does Node's rimraf, which
  `test/helpers.js` loads with its first removal: which functions it keeps
  is tested in a plain node process too (`test/fixtures/rm-kept.cjs`),
  loaded by `initialize()` and, as in a worker, under the patch.
- A refused operation is tested for its error (`code`, `syscall`, `path`,
  `dest`) and for leaving nothing behind — no copy, no deletion, no move,
  and no allocation: `leakedBytes()`, the bytes in allocations that no
  published entry and no retired version accounts for, stays 0 (the count
  of segments hides a leak inside one). A failure of the pool itself is
  tested with a pool too small, or an allocation that finds no room.
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
