# etag

ETag computed once by a `prepare` preparer, shared by every worker through
`meta`.

The `etag` preparer hashes each file's canonical content (sha256 →
base64url, quoted per RFC 9110) and returns it in `meta`; the content
itself passes through unchanged. `pages` is a `sab + virtual` place, so a
main-thread `writeFile` publishes to every worker before its Promise
resolves — every worker reads the same `meta.etag` for the same version of
a file, through `files.meta(key)`. The HTTP layer is plain `node:http`, no
framework: 304 when the request's `If-None-Match` already matches, 200 with
the `ETag` header otherwise.

## Run

```
node examples/etag/server.js
```

It prints one URL per worker (`WORKERS=2`, ports from `PORT=3000`; `PORT=0`
picks free ports). Then:

```
curl -i http://127.0.0.1:3000/hello.txt
curl -i -H 'If-None-Match: "<etag from above>"' http://127.0.0.1:3000/hello.txt
curl -i http://127.0.0.1:3001/hello.txt   # another worker, same ETag
```

About a second in, the server rewrites `/hello.txt` once — the next `GET`
from either worker returns a new `ETag`, and the old `If-None-Match` no
longer matches (200, not 304).

## What this shows

- `prepare` computing `meta.etag` once, on the main thread; every worker
  sees the same value through `kernel.fs('pages').meta(key)`, because
  `meta` is cloned and deep-frozen at publication (see
  [Preparation](../../README.md#preparation-prepare)).
- A framework-free `If-None-Match` → 304 / 200 flow over `node:http`.
- Live update over a `sab + virtual` place: a main-thread `writeFile` is
  published to every worker before its Promise resolves, so the content and
  its `ETag` change atomically, for every worker, at once.
