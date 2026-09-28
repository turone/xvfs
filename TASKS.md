# Backlog

Future project work. Priority: **P1** — strict boundary or correctness,
**P2** — policy gaps and missing implementations, **P3** — improvements.

## P1 — Windows: drive spellings of managed paths

**Problem.** Under strict, a drive letter that names `appRoot` or a
directory on its line — `subst P: <appRoot>`, `net use Q:` to its share —
and the drive form of a namespaced `appRoot` reach the disk past the
routing: they lie outside `appRoot` to the strings. Without strict the
same spellings pass through as unowned.

**Cause.** Routing is lexical, and what a drive letter names only the
disk knows. Case, UNC and namespace forms, NTFS stream syntax and 8.3
names are handled (`doc/architecture.md`, Routing and strict mode).

**Done when.** A decided policy — for instance, under strict, refusing a
drive whose root the disk resolves onto `appRoot`'s line or to a share —
is implemented with tests on Windows.

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
  virtual updates — the kernel announces its publications already
  (`kernel.on('publish')`, README, Publication events), which a watch
  could follow — never a hidden raw name; a defined outcome for a
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

## P3 — Publication events of map places

**Problem.** `kernel.on('publish')` announces the publications of shared
places only (`sab`, `sea`): a `map` place — each thread's own — publishes
at once on its Map, past the kernel's epochs, and announces nothing, so an
application that keeps route handlers in a `map + virtual` place (the
hot-reload example) cannot react to its own writes through events, nor to
what the watcher publishes into a `map + disk` place.

**Cause.** The event is a property of a commit (`#flush`, `#apply`), and a
map place commits nothing through the kernel: `MapStore` sets its entries
itself, and the watch pipeline removes them directly
(`place.store.remove`).

**Done when.** A map place announces each local commit — a mutation, a
set of `writeFiles`, a watcher epoch — as one `'publish'` event of its
thread with `version: null` (its content has no version shared across
threads), and a watcher epoch that changes shared and map places is one
event. One way: the kernel hands each `MapStore` an announcer its
mutations call once each, and a watcher epoch records its map changes
beside its kernel epoch, which `#flush` joins into the epoch's event.

## After the next Node.js 26.x release — `doc/alternatives.md`

**Problem.** The comparison describes Node v26.10.0; `main` already removes
`--vfs-mount` (nodejs/node#66162) and adds SEA `vfsArchive`
(nodejs/node#65810).

**Done when.** The page matches the released documentation.
