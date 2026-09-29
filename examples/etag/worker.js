'use strict';

// A worker of etag: answers GET requests straight from shared memory, using
// the ETag the main thread's preparer already computed — no hashing here.

const http = require('node:http');
const { parentPort, workerData } = require('node:worker_threads');
const { attach } = require('../..');

const kernel = attach();
const pages = kernel.fs('pages');
const { id, port } = workerData;

// RFC 9110 §13.1.1 / §8.8.3.2: If-None-Match is `*` or a comma-separated
// list of entity-tags; a match uses weak comparison, so a candidate's
// leading `W/` is ignored (this demo's own ETag is always strong).
const matchesNoneMatch = (header, etag) => {
  if (!etag || !header) return false;
  if (header.trim() === '*') return true;
  return header
    .split(',')
    .some((tag) => tag.trim().replace(/^W\//, '') === etag);
};

const server = http.createServer((req, res) => {
  const key = req.url.split('?')[0];
  const stat = pages.stat(key);
  if (!stat || stat.isDirectory()) {
    res.writeHead(404);
    return void res.end('not found\n');
  }
  res.setHeader('x-worker', String(id));
  const { etag } = pages.meta(key) || {};
  if (etag) res.setHeader('etag', etag);
  if (matchesNoneMatch(req.headers['if-none-match'], etag)) {
    res.writeHead(304);
    return void res.end();
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(pages.readFile(key));
});

server.listen(port, '127.0.0.1', () => {
  parentPort.postMessage(`http://127.0.0.1:${server.address().port}`);
});
