# async-worker

A worker performs a heavy async transformation and publishes the result
itself; other workers learn of it only through publication events, and
read a consistent set.

The `generator` worker builds a report from a dataset: an async SHA-256
(`crypto.webcrypto.subtle.digest`) and an async gzip (`zlib.gzip`,
promisified) — no network, no dependency, several `await`s. It writes
three related artifacts — `report.html`, `report.json`, `render.js` — as
one atomic `writeFiles([...])` call of its own: the write crosses this
worker's own RPC to the main thread, which checks, compiles
(`fs.script.compile`, for `render.js`) and publishes the whole set in one
commit before the generator's call resolves. `reports` is a
`sab + virtual` place with no preparer: the canonical content is exactly
the bytes the generator wrote.

Two `reader` workers never write. Each learns of a new report only
through its own kernel's `'publish'` event and then reads `report.html`,
`report.json` and `render.js` as one set: every artifact carries the same
version, and `render.js` — run from the V8 cached data
`fs.script.compile` built — reproduces `report.html`'s markup exactly. A
batch that cannot publish (round 3: a `render.js` that does not compile)
leaves the previous set exactly as it was: the readers' next read is
still round 2, in full, never a mix of round 2 and round 3.

## Run

```
node examples/async-worker/run.js
```

Expected output (two published rounds, a refused third, then a check of
the unchanged set):

```
generator round 1: published version=1 sha256=<hex>… gzipBytes=<n>
reader 1 round 1: version=1 versions-match=true html-matches=true sha256=<hex>… (cached data accepted)
reader 2 round 1: version=1 versions-match=true html-matches=true sha256=<hex>… (cached data accepted)
generator round 2: published version=2 sha256=<hex>… gzipBytes=<n>
reader 1 round 2: version=2 versions-match=true html-matches=true sha256=<hex>… (cached data accepted)
reader 2 round 2: version=2 versions-match=true html-matches=true sha256=<hex>… (cached data accepted)
generator round 3: writeFiles rejected: ENOTSUP: operation not supported (fs.script.compile: source does not compile), writeFiles '...'
reader 1 after rejection: version=2 versions-match=true html-matches=true sha256=<hex>… (unchanged)
reader 2 after rejection: version=2 versions-match=true html-matches=true sha256=<hex>… (unchanged)
main thread reports.version: html=2 json=2 render.js=2
```

## What this shows

- The heavy transformation — async crypto, async zlib — runs entirely in
  the worker that publishes its result; the library ships no async
  preparer, by design (see
  [Preparation](../../README.md#preparation-prepare)).
- `writeFiles` publishing several related artifacts as one commit, called
  from a worker: the RPC crosses to the main thread, which alone owns the
  pool and publishes (see
  [writeFiles](../../README.md#several-files-as-one-writefiles)).
- `fs.script.compile` building V8 cached data for one file of the set
  (`render.js`) while its companions are plain data — and, when that one
  file cannot compile, refusing the whole batch, `report.html` and
  `report.json` included, even though both were perfectly valid on their
  own (see [`fs.script`](../../README.md#fsscript)).
- `kernel.on('publish')` in a worker (`attach()`'s kernel): the reader
  workers never poll and never touch raw disk or SAB events, only the
  library's own publication events (see
  [Publication events](../../README.md#publication-events)).
- One version per commit, the same in every thread: `files.version(key)`
  agrees for all three artifacts, in both readers and in the main thread
  (see [Versions](../../README.md#versions)).
- No intermediate state: a reader's read always sees the whole set of one
  version — never `report.html` of one version next to `report.json` of
  another — and a batch that fails to publish (round 3) leaves the
  previous whole set exactly as it was.
