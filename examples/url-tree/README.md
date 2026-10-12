# url-tree

The pages of a site as a shared tree: nodes with the ids its source
gives them, each with a class, a policy and a payload of bytes in the
shared pool — the same tree in every thread, written only by the
batches of its source.

`server.mjs` is the README's quick start ("Page and route trees"): the
tree served over HTTP.

```
node examples/url-tree/server.mjs           # PORT, default 3000
curl -i http://127.0.0.1:3000/guide/intro   # 200, an ETag
curl -i http://127.0.0.1:3000/docs/intro    # 301 to /guide/intro
curl -i http://127.0.0.1:3000/admin/stats   # 403; -H 'x-role: admin' 200
curl -i http://127.0.0.1:3000/products/42   # 404 past /products, '/42'
```

`run.js` takes the tree through its source's changes, in three threads.

The source here is an array and a counter, what a database table and
its change log would be. The main thread loads its state at change 3
(`load(rows, 3)`). An `editor` worker submits change 4 — after the
source committed it, with the source's number — and reads its own write
the moment its promise resolves: the main thread answers once it has
posted the update, which the port delivers first. A `reader` worker
resolves URLs in its replica under the pages' policies — `allow` sees
each policy from the root down; a refusal is a `Denied`, a miss past
them a `NotFound` — and hears every publication of the tree through its
kernel's `'publish'` event, with the numbers of the batches it shows.

The main thread then gets what a reader of the source's log gets: change
4 again, a repeat (`'duplicate'`); change 6 before change 5 — it waits,
and the gap is told once (`onGap`) — then change 5, after which 5 and 6
publish together.

## Run

```
node examples/url-tree/run.js
```

Expected output:

```
main: loaded seq=3 last=3
reader: guest /docs/intro: <h1>Intro</h1>
reader: guest /admin/stats: denied by /admin
reader: admin /admin/stats: <h1>Stats</h1>
reader: guest /docs/missing: not found past /docs (/missing)
editor: seq=4 committed; /docs/news reads <h1>News</h1>
reader: publish seq=4..4 /docs: intro, news
main: seq=4 again duplicate
main: gap 5..5
main: seq=5 committed, seq=6 committed
reader: publish seq=5..6 /docs: intro, news, guide, faq
```

See the README, "Page and route trees".
