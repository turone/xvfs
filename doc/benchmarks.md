# Benchmarks

What the library costs and saves, measured with `npm run bench` (the
scenarios under `bench/`, outside `npm test` and CI). This page records
one machine and one revision; the figures are there to be reproduced, not
trusted across machines. Absolute numbers change with the CPU, the OS and
the Node.js build; the ratios between the rows of one table are the
durable part.

## Method

- Every scenario runs in a process of its own (`--expose-gc`), warms up,
  then repeats each measurement 5 times; a figure is the **median** of the
  rounds. `ns/op` figures come from loops calibrated to ~60 ms per round;
  latencies are p50 / p95 / p99 of individually timed calls (200 samples
  per round, nearest rank); throughput figures are MiB/s or requests per
  second over a timed window.
- Memory figures are taken after `gc()` and, where the scenario says so,
  **settled**: sampled again after a pause and another collection until two
  samples agree. Right after a collection, `arrayBuffers` and RSS still
  count what the collection found dead — the backing stores of Buffers and
  SAB segments reach the OS later, and a segment can take one more cycle
  than the views over it.
- The numbers below are the medians of **three runs in alternating pairs**
  (`bench/ab.js` with the same code on both sides — an A/A run). Its
  summary shows how far apart runs of the same code land: the median
  relative range of an `ns/op` figure was 14 %, of a p50 latency 9 %, of a
  p99 26 %, of a throughput over workers 9 %, of a memory figure 0 %. Of
  375 metrics, the A/A marked 2 as consistent changes (both p50 / p99 of
  one update figure) — with three pairs on a busy machine the threshold
  is not watertight — and 27 more crossed it on the medians only.
- **This run was made on a shared, busy machine** (other jobs ran in
  parallel). Where a difference is inside the noise band the text says so.
  A quiet machine gives lower p95 / p99 figures and tighter spreads; the
  ratios hold.

## Machine

|          |                                                                                                                                                                 |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPU      | AMD Ryzen 9 9900X, 6 cores visible                                                                                                                              |
| Memory   | 192 GiB                                                                                                                                                         |
| OS       | Windows Server 2022 (10.0.20348)                                                                                                                                |
| Node.js  | v24.20.0 (V8 13.6)                                                                                                                                              |
| Disk     | every file read below was in the page cache                                                                                                                     |
| Revision | `lib/` (unchanged since `edcf38f`) and `bench/` of the commit that added this page; the preparer path changed after — see [Preparer results](#preparer-results) |

## Reproduce

```
npm run bench                                    # everything, ~2 min
npm run bench -- --only pool,read,views          # a subset
npm run bench:ab -- <base> <new> --pairs 4       # two revisions, paired
npm run bench:ab -- HEAD worktree --pairs 4      # A/A: the noise band
node bench/ab.js --report .work/bench/ab/<dir> --md
```

The tables below are the `new` side of
`node bench/ab.js <base> worktree --bench worktree --pairs 3`, every
figure the median of its three runs; `±` is half the relative range of
those runs.

## Worker pools against `node:fs` and a per-worker cache

`bench/scenarios/pool.js`, `bench/workers/pool.js`. One file set — 200
text files, 4 KiB to 1 MiB, 20 MiB in all — served by pools of 1, 2, 4 and
8 worker threads. A request resolves a key, gets the bytes and copies them
into a response buffer (the socket write); the modes differ only in where
the bytes come from:

- **sab** — one copy in shared memory; the worker takes a lease
  (`readFileView`) around the copy and releases it;
- **cache** — every worker reads the whole set into its own Buffers at
  start, the usual per-thread cache;
- **fs** — no cache, `fs.promises.readFile` per request.

### Before serving

| figure                                                          |    ms |
| --------------------------------------------------------------- | ----: |
| `pool.sab.init` — `initialize()` over the set                   |  12.3 |
| `pool.sab.init.gzip` — the same with gzip representations       | 180.3 |
| `pool.cache.load` — the set read into Buffers, per cache worker |   9.9 |

Loading the set once into shared memory costs what one cache worker
spends loading it for itself; a cache pool spends it once per worker.
The gzip representations are built once, at publication (180 ms for the
20 MiB), and never per request.

### Startup, ms until every worker is ready

| workers |      sab |     cache |        fs |
| ------: | -------: | --------: | --------: |
|       1 | 42.2 ±4% |  36.0 ±8% |  22.1 ±7% |
|       2 | 43.9 ±4% |  35.6 ±9% | 22.8 ±24% |
|       4 | 55.0 ±5% | 43.6 ±22% | 27.2 ±99% |
|       8 | 95.6 ±5% | 87.1 ±10% | 47.2 ±23% |

A bare worker takes ~22 ms. A cache worker adds its 10 ms of reads;
`attach()` adds the library's modules and the projection of the snapshot
— offsets, not bytes — and costs more at this set size: `sab` pools are
ready 6, 8 and 11 ms after `cache` pools at 1, 2 and 4 workers (at 2
workers every `sab` run lies above every `cache` run), 8 ms at 8. The
cache's share grows with the set, the projection's does not.

### Memory of the process, MiB (the workers' `arrayBuffers` in brackets)

A fresh process with no pool: 64 MiB RSS.

| workers |      sab |     cache |       fs |
| ------: | -------: | --------: | -------: |
|       1 |  110 (2) |  101 (22) |   81 (2) |
|       2 |  132 (4) |  137 (43) |  96 (12) |
|       4 |  176 (7) |  207 (86) | 126 (39) |
|       8 | 261 (15) | 348 (173) | 180 (44) |

Per worker: a bare worker ~15 MiB (`fs`, plus the Buffers its reads churn
through), a `sab` worker ~21 MiB, a `cache` worker ~35 MiB — the set once
more each time. With one worker the shared copy costs 9 MiB more than the
private one — presumably the main thread's kernel, its index and modules;
not measured apart. From two workers on, `cache` pays 20 MiB per worker
for the set while `sab` holds it once, in the main thread's segments.
With a 200 MiB set the same pools would differ by 1.4 GiB at 8 workers.

### Requests per second over the pool

| workers |        sab |     cache |       fs |
| ------: | ---------: | --------: | -------: |
|       1 |   379k ±3% | 481k ±11% | 10k ±52% |
|       2 |  812k ±14% | 513k ±10% |  20k ±1% |
|       4 |  1372k ±4% |  502k ±1% | 33k ±33% |
|       8 | 1722k ±10% |  627k ±4% |  41k ±2% |

### Request latency, µs — p50 / p95 / p99

| workers |               sab |             cache |                     fs |
| ------: | ----------------: | ----------------: | ---------------------: |
|       1 | 0.8 / 16.1 / 24.1 | 0.5 / 13.8 / 20.4 |   76.4 / 262.1 / 379.9 |
|       2 | 0.8 / 16.1 / 21.5 | 0.7 / 16.8 / 35.8 |   75.8 / 284.9 / 383.6 |
|       4 | 0.9 / 16.7 / 23.3 | 1.2 / 27.1 / 75.9 |   81.0 / 333.7 / 598.4 |
|       8 | 0.9 / 16.7 / 23.2 | 1.1 / 29.1 / 94.1 | 122.5 / 480.3 / 1242.1 |

One worker serving from its own Buffers is the fastest single thread
(0.5 µs a request against 0.8 µs for a lease around the same copy). The
pools diverge: `sab` scales to 1.7 M requests/s on 6 cores with a p99
that stays at ~23 µs, `cache` stops at ~0.5–0.6 M from two workers on
and its p99 quadruples. The per-request work is the same memcpy in both;
what differs is the working set — one 20 MiB copy the threads share
against a private 20 MiB per thread, 160 MiB at eight — which is
consistent with the private copies falling out of the last-level cache.
`fs` pays syscalls and a fresh Buffer per request: 76–122 µs p50, 41 k
requests/s at best.

### One update until every worker serves it, µs — p50 / p99

| workers |       sab |     cache |
| ------: | --------: | --------: |
|       1 | 217 / 324 |  93 / 159 |
|       2 | 236 / 436 |  91 / 185 |
|       4 | 220 / 440 | 121 / 776 |
|       8 | 245 / 869 | 162 / 882 |

For `sab` an update is a watcher epoch: stat and read of the changed
32 KiB file, its placement, the publication, one `vfs-update` per worker
and their ACKs; for `cache` the file is read once and posted to every
worker, a copy each. The epoch's fixed part is what `sab` pays more; per
worker it sends offsets where `cache` sends bytes, and the gap narrows
as the pool grows (the `cache` row for 8 workers was the A/A run's false
positive: noisy).

### gzip, 4 workers

| mode  |     req/s | p50 / p95 / p99 µs    | RSS MiB | update p50 µs |
| ----- | --------: | --------------------- | ------: | ------------: |
| sab   | 1536k ±5% | 1.0 / 6 / 20          |     179 |          1066 |
| cache |    1k ±3% | 716.1 / 33255 / 37056 |     198 |           106 |
| fs    |   1k ±13% | 837.2 / 33504 / 37214 |     119 |             — |

`sab` serves the representation built at publication: a lease on the
compressed bytes, 1 µs. A server without a compressed cache compresses per
request (`zlib.gzipSync` here): 0.7 ms for the median file, 33 ms for the
1 MiB ones — a thousandth of the throughput. The price is paid at
publication instead: 180 ms for the set at start, ~1 ms for an updated
32 KiB file.

## Reads by size

`bench/scenarios/read.js`: `PlaceFs` reads over `sab` and `map` places
against `readFileSync` of the same files through `node:fs`, ns per call.

| size | sab readFile | sab view | map readFile | map view | disk readFileSync |
| ---- | -----------: | -------: | -----------: | -------: | ----------------: |
| 1k   |          374 |      108 |          278 |       45 |             18611 |
| 64k  |        32475 |       93 |        20951 |       47 |             37765 |
| 1m   |       198923 |       94 |       155282 |       51 |            206488 |
| 8m   |      1324897 |       89 |       837028 |       43 |           1725572 |

`stat` 55 ns, `exists` 18 ns, `readdir` of 100 entries 51 µs.

A lease (`view`) costs ~100 ns whatever the size; an owned copy
(`readFile`) is a memcpy, 374 ns for 1 KiB, 1.3 ms for 8 MiB — and a
Buffer to collect. `node:fs` from the page cache starts at 18.6 µs for the
syscalls of a 1 KiB read: 170× a lease, 50× a copy.

Copies out of shared memory ran ~1.3–1.6× slower than out of a `map`
place's own Buffers here, on Windows. That is a platform cost, not the
library's. V8 copies out of a SharedArrayBuffer with its own routine, safe
against concurrent writers, and out of an ordinary buffer with the C
library's `memcpy`; which one wins depends on the destination. On Windows
at 8 MiB, `memcpy` wins into a fresh Buffer — 97 against 145 µs/MiB — and
loses into a warm, reused one — 40 against 20 µs/MiB. `readFile()` returns
a fresh Buffer, so it pays the first case, and so does every copy
primitive of JavaScript: `Buffer.from(view)`, `Buffer.allocUnsafe()` +
`set()`, `buf.copy()` and `Buffer.copyBytesFrom()` landed within noise of
each other, ~1.4× (1.2–1.9× over the runs) the same copy out of a Buffer at
8 MiB, ~1.1–1.2× at 1 MiB. On Linux (the same machine, WSL2, Node.js
24.20.0) the shared copy is as fast or faster either way, and `readFile`
out of `sab` ran as fast as out of `map` or faster: 0.87–0.97 ms against
1.04–1.31 ms for 8 MiB, 92–113 µs against 90–124 µs for 1 MiB, over three
runs. Where the copy matters, a lease (`readFileView`, `withFileView`) or a
zero-copy stream does without it.

Most of a large copy's cost is its destination — the allocation and first
touch of a fresh Buffer. Its pages may come fresh from the kernel or
reused from the allocator, depending on what the process did before: on
Linux the same 1 MiB copy cost ~200 µs/MiB in a fresh process and ~50
after other work, whatever the source. A micro benchmark that measures one
variant first can blame the source for what the allocator does; `npm run
bench` warms every scenario up in a process of its own before it measures.

## Leases

`bench/scenarios/views.js`: the lease lifecycle of a zero-copy place, ns
per call.

| figure                                                                 |    ns |
| ---------------------------------------------------------------------- | ----: |
| `views.acquire` — `readFileView`, N leases of one version              |    87 |
| `views.release` — their releases                                       |    14 |
| `views.acquireRelease` — acquire + release, nothing retired in between |   109 |
| `views.withFileView.sync` — `withFileView`, synchronous callback       |   171 |
| `views.withFileView.async` — `withFileView`, async callback            |   182 |
| `views.manual.async` — `readFileView` + release in an async function   |   138 |
| `views.access.1m.memcmp.view` — `Buffer.equals` over a 1 MiB view      | 17476 |
| `views.access.1m.memcmp.owned` — the same over an owned copy           | 17572 |
| `views.access.1m.js.view` — a JS loop over every 64th byte of the view |  5313 |
| `views.access.1m.js.owned` — the same over an owned copy               |  5619 |

The no-update fast path — a lease taken and released while nothing
retires its version — is local bookkeeping: ~100 ns, no message.
`withFileView` costs one promise more than the manual pair, the async
callback one more still. Reading through a view costs what reading an
owned Buffer costs, natively and from JavaScript alike.

## Updates under active leases

`bench/scenarios/retain.js`: a `sab + virtual` place with one 64 KiB key,
replaced by `writeFile` while leases hold the current version, µs.

| figure                                                                                |  p50 |   p95 |   p99 |
| ------------------------------------------------------------------------------------- | ---: | ----: | ----: |
| `retain.main.update.0` — `writeFile` replacing a version nobody holds                 | 22.9 |  64.4 | 134.4 |
| `retain.main.update.1` — held by one lease                                            | 19.8 |  49.8 | 106.5 |
| `retain.main.update.1000` — held by 1000 leases                                       | 20.1 |  47.9 |  74.9 |
| `retain.main.release.retired` — the release that frees a retired version              |  0.7 |   1.4 |   3.6 |
| `retain.main.release.current` — a release of a current version                        |  0.1 |   0.2 |   1.0 |
| `retain.worker.1.free` — update → ACK → free, 1 worker, nothing held                  | 35.9 | 117.1 | 307.2 |
| `retain.worker.1.held` — the worker holds a lease: ACK with `retained`, release, free | 34.6 | 101.6 | 332.7 |
| `retain.worker.4.free` — 4 workers, nothing held                                      | 44.5 | 117.5 | 289.3 |
| `retain.worker.4.held` — 4 workers, each holding a lease                              | 57.0 | 259.3 | 546.6 |

An update costs the same whether 1 or 1000 leases hold the version it
replaces (the two rows are within noise): retirement binds the version,
not each lease. The row with no lease is not quite the same measurement:
nothing holds the replaced version, so the timed write also frees it and
runs the compaction check, which the other two rows leave to the release
in the next setup — about 0.6 µs by `release.retired`, within noise here
as well. The one release that frees a retired version costs
~0.6 µs more than a release of a current one — the free and the
compaction check. With a worker holding the version, the retired id rides
on the ACK and one `vfs-release` follows: within noise of the unheld
round for one worker, +12 µs for four.

## Streams by size and `highWaterMark`

`bench/scenarios/stream.js`: `createReadStream` piped to a discarding
sink — borrowed SAB chunks (`zeroCopy: true`) against owned copies, and
`node:fs.createReadStream` of the same file, MiB/s.

| file | highWaterMark | zero-copy | owned | node:fs |
| ---- | ------------- | --------: | ----: | ------: |
| 64k  | 16k           |      2648 |  1579 |     450 |
| 64k  | 64k           |      3918 |  1741 |     554 |
| 64k  | 256k          |      3953 |  1915 |     471 |
| 1m   | 16k           |     49859 |  4626 |    1135 |
| 1m   | 64k           |     56816 |  3527 |     673 |
| 1m   | 256k          |     62327 |  6711 |    3621 |
| 8m   | 16k           |    171523 |  6992 |    1094 |
| 8m   | 64k           |    339150 |  7456 |    2292 |
| 8m   | 256k          |    420205 |  8992 |    3307 |

A stream costs ~16 µs to set up and finish whatever it carries (64 KiB at
4 GB/s is that fixed part). Past it, a zero-copy stream only slices views:
the 8 MiB file passes at hundreds of GB/s, so its cost is the chunk count
— a larger `highWaterMark` helps. An owned stream copies each chunk into a
fresh Buffer: 7–9 GB/s. `node:fs` from the page cache: 1–3.3 GB/s, and the
`1m / 64k` row shows how noisy it was.

## The memory lifecycle of shared bytes

`bench/scenarios/memory.js`: a `sab + virtual` place with `zeroCopy`
takes 128 files of 512 KiB (64 MiB), MiB.

| phase     | RSS | heap | arrayBuffers | copies kept | pool used | pool reserved | pinned | retired |
| --------- | --: | ---: | -----------: | ----------: | --------: | ------------: | -----: | ------: |
| start     |  64 |    6 |            0 |           0 |         0 |             0 |      0 |       0 |
| published | 129 |    6 |           64 |           0 |        64 |            64 |      0 |       0 |
| leased    | 129 |    6 |           64 |           0 |        64 |            64 |     64 |       0 |
| copies    | 193 |    7 |          128 |          64 |        64 |            64 |     64 |       0 |
| dropped   | 129 |    6 |           64 |           0 |        64 |            64 |     64 |       0 |
| updated   | 193 |    7 |          128 |           0 |       128 |           128 |     64 |      64 |
| released  | 194 |    7 |          128 |           0 |        64 |           128 |      0 |       0 |
| settled   | 194 |    7 |          128 |           0 |        64 |           128 |      0 |       0 |
| closed    |  66 |    6 |            0 |           0 |         0 |             0 |      0 |       0 |

`pinned` and `copies kept` are what the scenario holds by construction —
the leases on all 128 files, the sum of the copies it keeps — not
readings (`Pins` counts versions, not bytes); the other columns are
measured.

Leases on all 64 MiB cost nothing (`leased`); owned copies of the same
files cost the same again (`copies`) and go with the collection
(`dropped`). Rewriting every file under the leases keeps both versions
until the leases go: 64 MiB retired, 128 in the pool. The release frees
them at once (`released`: retired 0, pool used 64), but the segments stay
reserved for the next publications — never returned to the OS, hence the
RSS of `settled` — and `close()` makes them collectable: 66 MiB, the
process as it started. The `released` row is taken right after `gc()`,
`settled` after the pause: they agree here because segments are not
collected until `close()`; after `close()` the first sample still showed
one segment, gone one collection later — which is what `settledUsage`
waits for.

## Preparer results

`bench/scenarios/preparer.js`: one `writeFile` into a `sab + virtual`
place whose extension has a preparer, until the version is published, by
what the preparer returns — µs, p50 (p95).

| result   |   64 KiB |     1 MiB |       8 MiB |
| -------- | -------: | --------: | ----------: |
| `raw`    |  26 (78) | 170 (317) | 1338 (2159) |
| `same`   |  21 (55) | 170 (273) | 1387 (2449) |
| `buffer` | 36 (113) | 341 (657) | 2355 (3429) |
| `uint8`  | 36 (110) | 314 (521) | 2385 (3998) |
| `string` | 49 (116) | 536 (826) | 4619 (6930) |

A virtual write copies its input before anything else runs
(`VirtualStore.write`), then the pipeline places the canonical bytes into
SAB: `raw` (the preparer returns `null`) and `same` (it returns the raw
input) are those two copies. A `Buffer` or `Uint8Array` of the preparer's
own was copied once more, into an owned Buffer — three copies — and cost
1.4× at 64 KiB, 1.8–2× at 1 MiB, 1.7–1.8× at 8 MiB. A string is encoded
first: 2–3.4×.

That measurement decided the backlog entry "One copy fewer for
`Uint8Array` preparer results": a `Uint8Array` result of a shared place
now goes straight into its provisional SAB allocation the moment the
preparer returns — two copies, like the raw input (`doc/architecture.md`,
Preparation). The A/B of that change against the commit before it, four
alternating pairs of `--only preparer,publish`, p50 in µs, `+` = better in
every pair beyond max(5 %, 2 × base spread):

| result   |    64 KiB |       1 MiB |         8 MiB |
| -------- | --------: | ----------: | ------------: |
| `raw`    | 26 → 25 ~ | 169 → 169 = | 1368 → 1401 = |
| `same`   | 22 → 23 = | 164 → 168 = | 1465 → 1384 = |
| `buffer` | 37 → 21 + | 310 → 167 + | 2463 → 1249 + |
| `uint8`  | 38 → 22 + | 319 → 162 + | 2363 → 1266 + |
| `string` | 52 → 51 = | 540 → 538 = | 4677 → 4560 = |

A Buffer or `Uint8Array` result now publishes at the speed of the raw
input (−41 to −49 % at every size, in every pair); the raw, same and
string rows did not move (`raw` at 64 KiB: 2–8 % in the same direction
in every pair, below the threshold), nor did the `publish` scenario (raw
and prepared writes into `sab` and `map` places).

## Strict routing on Windows: spellings and a place's disk

`bench/scenarios/router.js`, `bench/scenarios/patch.js`. Under strict the
router refuses spellings of `appRoot` the strings do not show — NTFS
streams, 8.3 names, a drive or a real path that names it — and a native
call on a place's disk proves where its path really lands (one
`realpath.native`; `doc/architecture.md`, Routing and strict mode). The
A/B of that work against the commit before it (`f0efa1a`), four
alternating pairs of `--only router,patch,read --bench HEAD` — the new
`patch.strict.*` rows measured on the old code too — ns/op, median of the
four runs on each side:

| metric                                | before |   after | change |
| ------------------------------------- | -----: | ------: | -----: |
| `router.strict.read.outside`          |     62 |      87 |  −40 % |
| `router.strict.mutate.outside`        |     62 |      85 |  −38 % |
| `router.strict.mutate.disk`           |    177 |  73 261 |   ×415 |
| `patch.strict.outside.readFileSync`   | 19 020 |  19 791 |      ~ |
| `patch.strict.territory.readFileSync` | 19 200 |  66 267 |   ×3.5 |
| `patch.strict.territory.statSync`     | 13 432 |  55 863 |   ×4.2 |
| `patch.strict.territory.existsSync`   | 23 488 |  66 283 |   ×2.8 |
| `patch.strict.territory.readdirSync`  | 60 553 | 125 925 |   ×2.1 |
| `patch.strict.disk.readFileSync`      | 18 879 |  61 505 |   ×3.3 |
| `patch.strict.disk.readdirSync`       | 32 373 |  73 765 |   ×2.3 |
| `patch.territory.readdirSync` (open)  | 61 259 |  47 405 |  +23 % |

A route outside `appRoot` under strict pays 23–25 ns for the stream and
short-name checks and the drive lookup — nothing a native call beside it
shows (`patch.strict.outside.*` moved 1–4 %, below the threshold). A
native call on a place's disk pays one `realpath.native`, 42–47 µs on this
machine — `GetFinalPathNameByHandle` opens the file — so a `stat` of the
disk territory costs four times what it did and a read three and a half;
a listing pays two (the route and the facade's walk). `router.strict.
mutate.disk` names a file whose place's directory does not exist: its
proof walks up three levels. Without strict nothing moved, and a listing
of the disk territory got cheaper: the facade no longer stats a directory
it is about to list (+23 %). Where this cost matters, the application
keeps such content in the VFS — a cached extension, a virtual place — or
runs without strict.
