# Backlog

Future project work. Priority: **P1** — strict boundary or correctness,
**P2** — policy gaps and missing implementations, **P3** — improvements.

## P1 — Windows: 8.3 and stream spellings of managed paths

**Problem.** Under strict, spellings of a managed path in drive form that
routing does not compare as the file system does still reach the disk: the
8.3 short name of `appRoot` or of a directory above it
(`…\SMFS-A~1\place\hidden`) and a stream suffix on it
(`appRoot::$INDEX_ALLOCATION\place\hidden`) lie outside `appRoot` to the
strings, and `appRoot\place\a.txt::$DATA` in a place with
`fs.fallback: 'disk'` reads the raw file of a cached, prepared extension —
its extension taken as `txt::$data`. Without strict the same spellings of
a place's name or key pass through as unowned. A drive mapped to a UNC
`appRoot`, or the drive form of a namespaced one, is the same class.

**Cause.** Routing is lexical, and one file has spellings the strings do
not show: 8.3 names, NTFS stream syntax, drive mappings. Case, UNC and
namespace forms are handled (`doc/architecture.md`, Routing and strict
mode).

**Done when.** A decided policy — for instance, under strict, refusing a
`:` past the drive and comparing `appRoot` by its long form — is
implemented with tests on Windows.

## P2 — VFS-aware versions of the operations refused today

**Problem.** For managed territory, native operations that walk a tree or
report raw disk events are recognized but unsupported (`ENOTSUP`), so an
application cannot copy a tree, watch, walk from above, or remove or move a
tree of managed content through `node:fs`. Single-file copies and renames
are implemented: they hand on the raw input.

**Cause.** A native operation checks only its top path. The rule in
`doc/architecture.md` (Patched `node:fs`) refuses whatever the kernel cannot
route path by path.

**Done when**, for each operation below, an implementation replaces its
`ENOTSUP` only if it:

- walks only through the filtered listing;
- hands on each source's raw input (`FsRouter.copy`), never a prepared
  result or a companion, and refuses a source without one;
- writes through each destination's mutation policy, its preparer running
  once;
- supports virtual entries and directories;
- leaves no raw disk bypass;
- holds the strict boundary for every descendant;
- follows a defined symlink policy;
- cleans up atomically after a partial failure;

and regression tests cover the sync, callback and promises forms, strict and
non-strict routing, and both fallbacks.

- Recursive `cp` of or into managed territory, with `force`,
  `errorOnExist` and `filter` per descendant.
- `watch` of managed territory: publication-level events for disk and
  virtual updates, never a hidden raw name; a defined outcome for a
  preparation that fails; a recursive watch bounded by the filtered
  listing; `AbortSignal`, `close()` and backpressure as in `node:fs`.
- Recursive `readdir` / `opendir` / `watch` from above `appRoot`, or from
  `appRoot` without strict: native levels outside, place listings inside.
- Recursive `rm` / `rmdir` of a tree that holds places: every descendant
  through its own place's mutation policy.
- A directory renamed across a place's boundary: every descendant through
  the routing of both ends. (A place's root stays where the config puts
  it.)
- A virtual subtree rename with prepared or compiled sources (raw-only
  subtrees move today): the pipeline run again under the new keys —
  preparers need a raw input to keep, bytecode and `scriptOptions` /
  `meta` the new path — still in one publication.
- `rename` of a tree that holds places: likely refused for good — moving
  `appRoot` under a running kernel has no consistent meaning; decide first.

Hard links into or out of a place stay refused by decision
(`doc/architecture.md`): one physical file cannot carry two canonical
contents.

## P2 — Symbolic links

**Problem.** Routing is lexical, and native reads follow links: a link
inside the disk territory of a place (`fs.fallback: 'disk'`,
`provider: 'disk'`) can point outside `appRoot`, and a link created outside
`appRoot` to a managed entry — or to a directory above `appRoot` — reads its
raw disk content past the routing. Not reproduced here yet (creating links
on Windows needs a privilege).

**Cause.** The router never touches the disk — it sits on the hot path of
every fs call — and `symlink` targets are resolved only when read.

**Done when.** A decided policy (refuse links whose target the kernel
serves or that enclose `appRoot`, refuse links in disk territory, or check
the real path of passthrough reads) is implemented with tests on Linux and
Windows.

## P2 — Recursive `rm` under the patch in a worker

**Problem.** In a worker, asynchronous `fs.rm` / `fs.promises.rm` with
`recursive` in a disk-origin place walks the place's listing instead of
the disk and removes the tree only in part (`ENOTEMPTY`). The main thread
is covered: `initialize()` loads Node's rimraf before the patch, while
`attach()` is synchronous and installs the patch first.

**Done when.** Workers get the same guarantee — a preload before
`attach()` installs the patch, or the VFS-aware recursive `rm` above —
with a worker test.

## P2 — Writes that bypass the mutation routing

**Problem.** `fs.readFile*(p, { flag: 'w' })` truncates a disk-territory
file of a read-only place (and answers `EBADF`); `{ flag: 'a+' }` creates
a file in a virtual place's directory on disk; `fs.mkdtemp*` is not
patched and creates directories in read-only and virtual places.

**Done when.** These pass the mutation routing as `open` with a writing
flag does, with tests of all three forms.

## P2 — A write resolves without publishing when `close()` comes first

**Problem.** A virtual write whose kernel is closed after the publication
sink's last `alive()` check and before `#flush` resolves successfully,
though nothing was published: `#flush` returns silently on a closed
kernel, so the caller sees success for a write that did not happen.

**Done when.** Such a write rejects with the closed-kernel error, with a
test that closes the kernel between the sink and the commit.

## P2 — Two watcher tests race the delivery of the update

**Problem.** `watcher.test.js` «syntax error: source published, stale
bytecode removed…» and «deleting a directory removes sources and
companions in one message» wait until the main thread's projection shows
the change, then read the messages of the `tap` port. `#flush` updates
the projection synchronously and only then posts the update, and the
port's message can arrive after the `until` timer fires: about 1 run in 12
fails.

**Done when.** Both tests wait for the message they read (`nextMessage`,
or `until` over the port's messages), and 50 runs under load pass.

## P3 — Separators of recursive listings on Windows

**Problem.** A managed recursive `readdir` returns `/`-separated names on
every platform; native `node:fs` returns `path.sep` (`sub\b.txt` on
Windows).

**Cause.** Place keys are `/`-separated and listings reuse them.

**Done when.** Listings either use `path.sep` like native `node:fs` or
document `/` as the contract, with a test pinning the choice on Windows.

## P3 — Public diagnostics

**Problem.** Only the internal `retirements()` shows what the kernel holds.
Pool usage and fragmentation, bytes waiting to be freed, ACK age (a stuck
worker), disk-fallback counts and preparation failures are not observable.

**Cause.** A public `stats()` was deliberately left out of the lifetime
work.

**Done when.** A documented, read-only API reports these metrics, a test
shows a stuck worker through it, and the API never frees or changes
anything.

## P3 — Preparation regression tests

**Problem.** Two guarantees hold by construction but have no test: a new
file in a new directory gets its prepared source and its bytecode in one
`vfs-update`, and compaction keeps a prepared source and its companions
together.

**Done when.** Both are pinned in `test/prepare.test.js`, driven by manual
watcher epochs and a forced compaction.

## P3 — Diagnostics of `prepare` conflicts inside one domain

**Problem.** When one domain's object form assigns an extension to several
preparers, the config error names only the first two; across domains it
names every declaration.

**Done when.** The error lists every declaration of the extension, with a
test for three or more.

## P3 — `fs.fallback: 'disk'` on a place without `fs.ext`

**Problem.** Without strict, a disk-origin place with no `fs.ext` resolves
`fs.fallback` to `'disk'` (its permissive reads), yet the same value set
explicitly is a config error ("needs a finite ext list"). A resolved config
should be valid input.

**Done when.** Either the explicit value is accepted with that meaning, or
the default resolves to another value — decided, documented and tested.

## P3 — glob and virtual entries

**Problem.** glob captures the `node:fs` functions it walks with when it is
loaded: loaded after the patch it walks the places (virtual entries show,
filtered by route); loaded before, it walks the disk natively (they never
show). Which one an application gets depends on load order.

**Done when.** One behavior is chosen and documented — e.g. glob always
lists through the places — with a test for both load orders.

## P3 — TypeScript declarations

**Problem.** The public API has no type declarations.

**Done when.** Declarations cover the public API (`VfsConfig`, `VfsKernel`,
`PlaceFs`, `attach`) and a type check runs in CI.

## P3 — `open` for writing of a published disk-origin file

**Problem.** `open(p, 'w')` / `createWriteStream(p)` of a published file
of a writable disk-origin place is `ENOTSUP 'virtual file'`, while
`writeFile(p)` writes it; under strict, `open(new, 'w')` there is
`EACCES` while `writeFileSync(new)` passes.

**Done when.** A decided policy for descriptors that write in disk-origin
places is documented and tested.

## P3 — A refusal for want of room names nothing

**Problem.** A publication the pool has no room for is refused with a
plain `Error` — `canonical source does not fit in SAB`, `"<key>" does not
fit in SAB` for a moved subtree, `fs.script.compile: source does not fit
in SAB` — without the `code`, `syscall`, `path` and `dest` every other
refusal of the VFS carries: a write, a copy or a rename refused so cannot
be told apart by its code, and a rename names neither the call nor its
ends.

**Cause.** The SAB sink refuses where the allocator finds no room, and
knows neither the operation nor its paths: the refusals of the pipeline
take their operation's `fail` (the compile refusal of a rename), these
do not.

**Done when.** They are node:fs-shaped — a code decided (`ENOSPC`, as a
full disk answers), the operation's `syscall` and `path`, and `dest` for
a rename or a copy — for main-thread and worker mutations alike, with
tests.

## P3 — Tests that do not test what they say, or hang instead of failing

**Problem.** `subtree-rename.test.js` «a move queued behind a write in
flight when the kernel closes» never reaches its gate on
`k.compressor.compress`: both mutations fail on the closed kernel before
any write is in flight. `compression.test.js`, `prepare.test.js` and
`mutation-order.test.js` close their kernels outside `try/finally`, so a
failing assertion leaves a watcher or a worker open and `node --test`
hangs instead of reporting the failure.

**Done when.** The subtree-rename test holds a write in flight at
`close()` (the compressor taken before it), and every test closes its
kernel in `finally`.

## P3 — Coverage gaps found by mutation testing

**Problem.** Mutants survive on `main` as on later revisions: a
publication that fails does not free its own allocations
(`cache.stats().totalUsed` counts segments, not the bytes in them); no
test fills the pool, so a subtree move that stops half-way, a source that
silently does not publish, or a script flavor dropped instead of refused
go unseen; no test reads a map + disk place without a preparer; no test
closes a kernel with a recheck pending, sees a recheck succeed, or deletes
a map + disk file through the watcher; no test copies a symbolic link
into a store place without `dereference`, fixes the order of the two
refusals of a copy, or shows that a `Dir` is a snapshot.

**Done when.** A test for each, each seen failing under its mutant.

## After the next Node.js 26.x release — `doc/alternatives.md`

**Problem.** The comparison describes Node v26.10.0; `main` already removes
`--vfs-mount` (nodejs/node#66162) and adds SEA `vfsArchive`
(nodejs/node#65810).

**Done when.** The page matches the released documentation.
