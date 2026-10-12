# Examples

Runnable demos covering the main xvfs use cases. Each subfolder
is self-contained — no extra build steps unless explicitly noted.

| Example                                  | What it shows                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [hot-reload-routes/](hot-reload-routes/) | `provider: 'map', origin: 'virtual'` + `require()` hook; HTTP server whose route handlers are written/replaced at runtime by an "AI agent".                                                                                                                                                                                                                          |
| [sea-static/](sea-static/)               | One config, two providers: `'sab'` when running with `node`, `'sea'` when packaged with Node SEA. Same HTTP handler in both modes.                                                                                                                                                                                                                                   |
| [multi-tenant/](multi-tenant/)           | Two `map + virtual` places under one appRoot + global `strict: true` whitelist; demonstrates the boundary `strict` enforces and where it stops.                                                                                                                                                                                                                      |
| [worker-static/](worker-static/)         | Static HTTP from several worker threads over one SAB copy: `link()` / `attach()`, view leases, zero-copy Range streams, br / gzip representations, live reload of disk and virtual places.                                                                                                                                                                           |
| [prepared-scripts/](prepared-scripts/)   | `prepare` + `fs.script`: handler sources prepared once, run in a worker with shared V8 cached data, and updated from the worker through a `sab + virtual` place.                                                                                                                                                                                                     |
| [etag/](etag/)                           | `prepare` computes a per-file ETag in `meta`, identical in every worker; a framework-free `node:http` server answers `If-None-Match` with 304 / 200, live-updated over `sab + virtual`.                                                                                                                                                                              |
| [ssr/](ssr/)                             | A tiny template compiler in a `prepare` preparer, `fs.script.compile` cached data, `vm.Script` in workers; a live template update reaches already-running workers.                                                                                                                                                                                                   |
| [async-worker/](async-worker/)           | A worker does a heavy async transformation (async crypto, async zlib) and publishes several related artifacts with one atomic `writeFiles`, through its own RPC; reader workers learn of it only through `kernel.on('publish')` and see one consistent version, never a partial set.                                                                                 |
| [url-tree/](url-tree/)                   | A shared tree — the pages of a site: `server.mjs`, the README's quick start over HTTP (a page, 304, 301 from a moved section, 403, 404 with a tail, 400); `run.js`, loaded on the main thread, a batch submitted from a worker and read back at once, URLs resolved under policies (`Denied`, `NotFound`) in another worker, a repeat and a gap of the source's log. |

These examples are docs-grade and are also covered by the automated smoke suite
in `test-examples/`, run with `npm run test:examples`. That suite is not part of
`npm test`.

The smoke suite validates the runnable examples on the supported Linux and
Windows matrix. It exercises the `sea-static` example in the normal `sab` mode
that ships from source; the full SEA packaging flow remains a documented manual
check.

## Common setup

All examples import xvfs as a sibling of this folder:

```js
const { VfsConfig, VfsKernel } = require('../..');
const fsPatch = require('../../lib/adapters/fs-patch.js');
const moduleHook = require('../../lib/adapters/module-hook.js');
```

If you copy an example out of the repo, replace those paths with
`require('xvfs')`, `require('xvfs/adapters/fs-patch')`
and `require('xvfs/adapters/module-hook')` — or skip the manual
wiring entirely and start with `node --import xvfs/register`.
