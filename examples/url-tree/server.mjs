// The quick start of the README, "Page and route trees": a site's pages
// and routes as a shared tree, served over HTTP — a page in br or gzip
// with an ETag, 403 under a policy, 301 from a section that moved, 404
// with the dynamic tail of a path. The README shows this file's code from
// its first import on.
//   node examples/url-tree/server.mjs      (PORT, default 3000)

import http from 'node:http';
import { VfsConfig, VfsKernel, Denied, NotFound } from '../../index.js';

const SECTION = 0; // a node's class: the application's own small integer
const PAGE = 1;

const kernel = new VfsKernel(
  new VfsConfig({
    trees: {
      site: {
        ids: 'number', // the pages' keys in the database
        containers: [SECTION], // classes whose nodes hold others
        compress: { encodings: ['br', 'gzip'] }, // every page, once
      },
    },
  }),
  // A gap in the changes' numbers: replay them from the log; a refused
  // change: load the whole state again.
  { trees: { site: { onGap: console.warn, onError: console.error } } },
);
await kernel.initialize();
const site = kernel.tree('site'); // in a worker: attach().tree('site')

// The database's state at change 41...
const page = (title) => ({ data: `<h1>${title}</h1>`, meta: { title } });
await site.load(
  [
    { id: 1, parentId: null, name: '', class: SECTION },
    { id: 2, parentId: 1, name: 'docs', class: SECTION },
    { id: 3, parentId: 2, name: 'intro', class: PAGE, payload: page('Intro') },
    {
      id: 4,
      parentId: 1,
      name: 'admin',
      class: SECTION,
      policy: { role: 'admin' },
    },
    { id: 5, parentId: 4, name: 'stats', class: PAGE, payload: page('Stats') },
    {
      id: 6,
      parentId: 1,
      name: 'products',
      class: PAGE,
      payload: page('Products'),
    },
  ],
  41,
);
// ...and its change 42: /docs moves to /guide, and a node of the old name
// sends what was below it there.
await site.submit({
  seq: 42,
  ops: [
    ['put', 2, 1, 'guide', {}],
    ['put', 7, 1, 'docs', { class: SECTION, policy: { redirect: '/guide' } }],
  ],
});

// A policy is the application's own: a role, or where a path has moved.
const allow = (policy, node, user) =>
  policy.redirect
    ? { redirect: policy.redirect }
    : user.roles.includes(policy.role);

const server = http.createServer((req, res) => {
  const key = keyOf(req.url); // the path as a key of the tree, below
  if (key === null) return res.writeHead(400).end();
  const user = { roles: req.headers['x-role'] ? [req.headers['x-role']] : [] };
  const found = site.match(key, { allow, context: user });
  if (found instanceof Denied) {
    // the uppermost policy that refused: its node, and what allow answered
    const to = found.decision?.redirect;
    if (!to) return res.writeHead(403).end();
    const rest = key.slice(site.pathOf(found.node).length);
    return res.writeHead(301, { location: to + rest }).end();
  }
  if (found instanceof NotFound) {
    // the deepest node on the path, and what lies past it: a 404 here, or a
    // dynamic tail the application serves — '/42' of '/products/42'
    const under = site.pathOf(found.node);
    return res.writeHead(404, { 'x-under': under }).end(found.rest);
  }
  const info = site.payloadOf(found);
  if (info === null) return res.writeHead(404).end(); // a section, no page
  const etag = `"${kernel.instance}-${info.version}"`;
  if (req.headers['if-none-match'] === etag) return res.writeHead(304).end();
  const headers = { etag, 'content-type': 'text/html; charset=utf-8' };
  // the first of br and gzip the page has and the client takes (q aside)
  const accepted = req.headers['accept-encoding'] ?? '';
  const encoding = ['br', 'gzip'].find(
    (e) => info.encodings.includes(e) && accepted.includes(e),
  );
  if (!encoding) return res.writeHead(200, headers).end(site.read(found));
  headers['content-encoding'] = encoding;
  return res.writeHead(200, headers).end(site.readCompressed(found, encoding));
});
server.listen(Number(process.env.PORT ?? 3000), '127.0.0.1', () => {
  console.log(`listening on http://127.0.0.1:${server.address().port}`);
});

// The path of a request as a key of the tree: no query or hash, '.' and
// '..' resolved, each name decoded; a doubled or a trailing slash
// collapses ('/guide/intro/' is '/guide/intro'); null — a 400 — when a
// name holds a '/' (%2F) or does not decode.
function keyOf(url) {
  const { pathname } = new URL(url, 'http://localhost');
  try {
    const names = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (names.some((name) => name.includes('/'))) return null;
    return '/' + names.join('/');
  } catch {
    return null;
  }
}
