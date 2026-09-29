# Backlog

Future project work. Priority: **P1** — strict boundary or correctness,
**P2** — policy gaps and missing implementations, **P3** — improvements.

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

## P3 — Strict and the links that already lead into `appRoot`

**Problem.** Under strict a link that already leads into `appRoot` from
outside it reads past the routing: Windows' own junctions
(`C:\Documents and Settings`, `%USERPROFILE%\Local Settings`,
`AppData\Local\Application Data`) for any `appRoot` below the user
profile, `/proc/self/root/…` and `/proc/self/cwd/…` on Linux, a link or
a hard link another process made, a volume mounted in a folder, the local
path behind an `appRoot` on a share of this machine. Documented as not
covered (`doc/architecture.md`, Routing and strict mode): strict is a
routing policy, not an OS sandbox.

**Cause.** Such a path lies outside `appRoot`, where strict asks nothing;
only the disk knows where it leads.

**Done when.** Decided and, if taken, implemented with a benchmark: an
opt-in that proves every native path outside `appRoot` as a place's disk
is proven today (its real path off `appRoot`'s real line), at one
`realpath` per call — or the boundary stays as documented.

## P3 — `links: 'verify'` lets a link into managed territory be looked at

**Problem.** Under strict with `links: 'verify'` the ops that look at a
link and not its target — `lstat`, `readlink` — on a link inside a disk
place that leads into managed territory (`d/jro` → `ro`, another place,
`appRoot`, above it) are `EACCES`, though `node:fs` would read nothing the
link hides: the link cannot be inspected through the patch. `links:
'deny'` (the default) knows a link by its name and lets them through.
(Removing or moving a link on a place's disk is `ENOTSUP` in both modes,
by decision — README, Links on a place's disk.)

**Cause.** The proof (`Aliases.territory`) resolves the whole path, which
lands in managed territory, so it cannot tell a call that follows the link
from one that does not.

**Done when.** A call that does not follow the last component is proven by
its parent's real path plus the leaf name (`Aliases.territory(root, p,
own)`, threaded through `VfsKernel.routeRead` / `routeMutation` and the
`PlaceFs` facade), so such a link is seen; the leaf's `.`,
`..` and trailing-separator forms, which win32 and posix resolve
differently, fall back to the full proof, and `stat` / `chmod` / `chown` /
`utimes` (which follow) keep it — with tests on both platforms and the
mutation that a following op wrongly reuses the own proof. Or the boundary
stays fail-closed as documented (README, doc/architecture.md).

## After the next Node.js 26.x release — `doc/alternatives.md`

**Problem.** The comparison describes Node v26.10.0; `main` already removes
`--vfs-mount` (nodejs/node#66162) and adds SEA `vfsArchive`
(nodejs/node#65810).

**Done when.** The page matches the released documentation.
