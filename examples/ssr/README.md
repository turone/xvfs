# ssr

`template -> preparer -> render-function source -> fs.script.compile ->
cached data -> vm.Script in a worker`.

A `.tmpl` file is plain text with `{{ dotted.path }}` placeholders. The
`ssr` preparer in `run.js` is the whole compiler — about a dozen lines —
turning it once into the source of a self-contained render function; no
template engine, no dependency. `fs.script.compile` builds V8 cached data
from exactly that source. Each worker gets the bundle from
`PlaceFs.script(key)` — `{ source, cachedData, scriptOptions, meta }` —
builds its own `vm.Script` and runs it.

`templates` is a `sab + virtual` place: `run.js` seeds it, has two workers
render it (round 1), rewrites it, and has the same two workers render again
(round 2) — the new source and new cached data reach both already-running
workers live; nothing of round 1's output survives into round 2. A third
write uses an invalid placeholder (`{{ 1.2 }}`, `{{ .a }}` — not a dotted
identifier path); the preparer rejects it, the write's Promise rejects, and
round 2's template is still what both workers render in round 3.

## Run

```
node examples/ssr/run.js
```

Expected output (two workers, two rounds, then a consistency check of one
bundle from the main thread):

```
worker 1 round 1: Hello, Ada! You have 3 new messages. (cached data accepted)
worker 2 round 1: Hello, Ada! You have 3 new messages. (cached data accepted)
worker 1 round 2: Welcome back, Ada! Your unread count is 3. (cached data accepted)
worker 2 round 2: Welcome back, Ada! Your unread count is 3. (cached data accepted)
bad template rejected: ssr: /greeting.tmpl: "{{ 1.2 }}" is not a dotted identifier path (letters, digits, "_", "$", joined by single dots — e.g. "user.name")
worker 1 round 3: Welcome back, Ada! Your unread count is 3. (cached data accepted)
worker 2 round 3: Welcome back, Ada! Your unread count is 3. (cached data accepted)
main thread bundle meta.template=/greeting.tmpl scriptOptions.filename=... cachedData=...b
```

## What this shows

- A tiny, dependency-free template compiler living entirely in a `prepare`
  preparer — the library ships no such preparer itself, only the mechanism
  (see [Preparation](../../README.md#preparation-prepare)).
- `fs.script` cached data built on the main thread and accepted
  (`cachedDataRejected === false`) by `vm.Script` in a worker's own, fresh
  isolate — the same guarantee `prepared-scripts` shows for plain handlers,
  here for generated render functions.
- Live update over a `sab + virtual` place: rewriting the template reaches
  already-running workers, each of which gets a new `source` and a new
  `cachedData` together — round 2 never reruns round 1's function.
- A placeholder that is not a dotted identifier path is a compiler error,
  not a guess at invalid JavaScript: the preparer throws, the `writeFile`
  Promise rejects, and — all or nothing — the previously published
  template is what every worker still renders (see
  [Preparation](../../README.md#preparation-prepare)).
- Consistency of one bundle: `source`, `scriptOptions`, `meta` and
  `cachedData` returned by one `files.script(key)` call all describe the
  same prepared version of the same file.
