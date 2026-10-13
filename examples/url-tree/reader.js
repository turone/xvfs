'use strict';

// The reader worker of url-tree: it resolves URLs in its replica of the
// tree under the pages' policies — `allow` sees each policy from the root
// down; a refusal is a Denied, a miss past them a NotFound — and hears
// every publication of the tree through its kernel's 'publish' event.

const { parentPort } = require('node:worker_threads');
const { attach, Denied, NotFound } = require('../..');

const kernel = attach();
const pages = kernel.tree('pages');

const allow = (policy, node, user) => user.roles.includes(policy.role);
const guest = { allow, context: { roles: [] } };
const admin = { allow, context: { roles: ['admin'] } };

const resolve = (url, as) => {
  const found = pages.match(url, as);
  if (found instanceof Denied) {
    return `denied by ${pages.pathOf(found.node)}`;
  }
  if (found instanceof NotFound) {
    return `not found past ${pages.pathOf(found.node)} (${found.rest})`;
  }
  return pages.read(found, 'utf8');
};

// URLs looked up on demand. The listener also keeps this worker alive:
// the kernel's own port does not.
parentPort.on('message', ({ cmd }) => {
  if (cmd !== 'look') return;
  parentPort.postMessage({
    kind: 'looked',
    lines: [
      `guest /docs/intro: ${resolve('/docs/intro', guest)}`,
      `guest /admin/stats: ${resolve('/admin/stats', guest)}`,
      `admin /admin/stats: ${resolve('/admin/stats', admin)}`,
      `guest /docs/missing: ${resolve('/docs/missing', guest)}`,
    ],
  });
});

kernel.on('publish', ({ trees }) => {
  for (const { tree, seqFrom, seqTo } of trees) {
    if (tree !== 'pages') continue;
    const names = pages.children(pages.get('/docs')).map(([name]) => name);
    parentPort.postMessage({
      kind: 'heard',
      from: seqFrom,
      to: seqTo,
      page: `/docs: ${names.join(', ')}`,
    });
  }
});
