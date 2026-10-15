// The quick start of the README, "Page and route trees": a site's pages
// and routes as a shared tree in two languages, served over HTTP — a page
// rendered from its data on its first request and cached for every
// thread, sent in br or gzip with an ETag and its other language as an
// alternate; 403 under a policy, 301 from a section that moved, 404 with
// the dynamic tail of a path. The README shows this file's code from its
// first import on.
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
        languages: ['en', 'uk'], // the main one first
        compress: { encodings: ['br', 'gzip'] }, // every rendered page, once
      },
    },
  }),
  // A gap in the changes' numbers: replay them from the log; a refused
  // change: load the whole state again.
  { trees: { site: { onGap: console.warn, onError: console.error } } },
);
await kernel.initialize();
const site = kernel.tree('site'); // in a worker: attach().tree('site')

// The database's state at change 41: a page's fields, the data its
// template renders, in each language it has — with its name there.
const fields = (title) => ({ data: JSON.stringify({ title }) });
const uk = (name, title) => ({
  translations: { uk: { name, payload: title && fields(title) } },
});
await site.load(
  [
    { id: 1, parentId: null, name: '', class: SECTION },
    { id: 2, parentId: 1, name: 'docs', class: SECTION, ...uk('dokumenty') },
    {
      id: 3,
      parentId: 2,
      name: 'intro',
      class: PAGE,
      payload: fields('Intro'),
      ...uk('vstup', 'Вступ'),
    },
    {
      id: 4,
      parentId: 1,
      name: 'admin',
      class: SECTION,
      policy: { role: 'admin' },
    },
    {
      id: 5,
      parentId: 4,
      name: 'stats',
      class: PAGE,
      payload: fields('Stats'),
    },
    {
      id: 6,
      parentId: 1,
      name: 'products',
      class: PAGE,
      payload: fields('Products'),
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

// The application's template: a page from its data.
const render = (data) => `<h1>${JSON.parse(data).title}</h1>`;

// A language's paths: under /uk for Ukrainian, at the root for English.
const PREFIX = { en: '', uk: '/uk' };

const server = http.createServer(async (req, res) => {
  const url = keyOf(req.url); // the path as a key of the tree, below
  if (url === null) return res.writeHead(400).end();
  const code = url === '/uk' || url.startsWith('/uk/') ? 'uk' : 'en';
  const key = url.slice(PREFIX[code].length);
  const lang = site.lang(code); // the tree in that language
  const user = { roles: req.headers['x-role'] ? [req.headers['x-role']] : [] };
  const found = lang.match(key, { allow, context: user });
  if (found instanceof Denied) {
    // the uppermost policy that refused: its node, and what allow answered
    const to = found.decision?.redirect;
    if (!to) return res.writeHead(403).end();
    const rest = key.slice(lang.pathOf(found.node).length);
    return res.writeHead(301, { location: to + rest }).end();
  }
  if (found instanceof NotFound) {
    // the deepest node on the path, and what lies past it: a 404 here, or a
    // dynamic tail the application serves — '/42' of '/products/42'
    const under = lang.pathOf(found.node);
    return res.writeHead(404, { 'x-under': under }).end(found.rest);
  }
  let info = lang.payloadOf(found);
  if (info === null) return res.writeHead(404).end(); // a section, no page
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'content-language': code,
  };
  // The node in the other language, where it is: an alternate.
  const other = code === 'en' ? 'uk' : 'en';
  const there = site.pathsOf(found)[other];
  if (there !== null) {
    const href = PREFIX[other] + (there || '/');
    headers.link = `<${href}>; rel="alternate"; hreflang="${other}"`;
  }
  if (info.rendered === null) {
    // Its first request renders it, once for every thread; data that
    // changed meanwhile is rendered again on the next.
    const html = render(lang.read(found, 'utf8'));
    const { status } = await lang.cache(found, html, info.version);
    if (status === 'stale') return res.writeHead(200, headers).end(html);
    info = lang.payloadOf(found);
  }
  const etag = `"${kernel.instance}-${info.version}"`;
  if (req.headers['if-none-match'] === etag) return res.writeHead(304).end();
  headers.etag = etag;
  // the first of br and gzip the page has and the client takes (q aside)
  const accepted = req.headers['accept-encoding'] ?? '';
  const encoding = ['br', 'gzip'].find(
    (e) => info.rendered.encodings.includes(e) && accepted.includes(e),
  );
  if (!encoding) {
    return res.writeHead(200, headers).end(lang.readRendered(found));
  }
  headers['content-encoding'] = encoding;
  return res.writeHead(200, headers).end(lang.readCompressed(found, encoding));
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
