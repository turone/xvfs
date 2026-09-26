'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, writeTree, rm, kernel, tap, worker } = require('./helpers.js');

// A worker mutation crosses its link port as a `vfs-mutate` request. The
// main kernel takes nothing it says on trust: the mutation, the place, its
// origin and the key are checked again there, and a store gets only the
// options its mutation takes, as booleans — as many as a worker sends.

let ids = 0;

// Resolves with the response to request `id`, whatever the port carries
// before it (the vfs-update of a publication). The kernel unrefs its link
// ports: a timer holds the event loop meanwhile, as nextEvent does.
const answered = (port, id) =>
  new Promise((resolve) => {
    const hold = setInterval(() => {}, 2 ** 30);
    const onMessage = (msg) => {
      if (msg?.name !== 'vfs-mutated' || msg.id !== id) return;
      port.off('message', onMessage);
      clearInterval(hold);
      resolve(msg);
    };
    port.on('message', onMessage);
  });

// Posts a raw request on a link and resolves with its response.
const request = (link, msg) => {
  const id = `raw:${++ids}`;
  const answer = answered(link.port, id);
  link.port.postMessage({ name: 'vfs-mutate', id, ...msg });
  return answer;
};

const bytes = (text) => new Uint8Array(Buffer.from(text));

// The fields of a refusal that crossed the port.
const refusal = (reply, fields) => {
  assert.ok(reply.error, 'refused');
  for (const [field, value] of Object.entries(fields)) {
    assert.equal(reply.error[field], value, field);
  }
};

describe('mutation RPC', () => {
  it('the main kernel checks every request again: mutation, place, origin, key', async () => {
    const root = writeTree(tmpDir('vfs-rpc'), { 'wd/a.txt': 'a' });
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
      m: { provider: 'map', origin: 'virtual', fs: { writable: true } },
      wd: { fs: { ext: ['txt'] } },
    });
    await k.fs('v').writeFile('/a.txt', 'a');
    const link = tap(k);
    try {
      const updates = k.nextUpdateId;
      const data = new Uint8Array([120]);
      const unknown = (message) => ({ name: 'Error', message });
      const elsewhere = (name, syscall, key) => {
        const where = k.fs(name).pathOf(key);
        return {
          code: 'ENOTSUP',
          syscall,
          path: where,
          message:
            'ENOTSUP: operation not supported ' +
            `(not a shared virtual place), ${syscall} '${where}'`,
        };
      };
      for (const [msg, fields] of [
        [
          { place: 'v', op: 'chmod', key: '/a.txt' },
          unknown('[vfs] unknown mutation "chmod"'),
        ],
        [
          { place: 'v', op: 'toString', key: '/a.txt' },
          unknown('[vfs] unknown mutation "toString"'),
        ],
        [
          { place: 'nope', op: 'unlink', key: '/a.txt' },
          unknown('[vfs] unknown place "nope"'),
        ],
        [
          { place: 'v', op: 'unlink', key: '/b/../a.txt' },
          { name: 'TypeError', message: 'invalid key: "/b/../a.txt"' },
        ],
        [
          { place: 'v', op: 'rename', key: '/a.txt', to: '/b/../c.txt' },
          { name: 'TypeError', message: 'invalid key: "/b/../c.txt"' },
        ],
        [
          { place: 'm', op: 'write', key: '/x.txt', data },
          elsewhere('m', 'write', '/x.txt'),
        ],
        [
          { place: 'wd', op: 'unlink', key: '/a.txt' },
          elsewhere('wd', 'unlink', '/a.txt'),
        ],
      ]) {
        refusal(await request(link, msg), fields);
      }
      assert.equal(k.nextUpdateId, updates, 'nothing published');
      assert.equal(k.fs('v').readFile('/a.txt', 'utf8'), 'a');
      assert.equal(k.fs('m').exists('/x.txt'), false);
      assert.ok(fs.existsSync(path.join(root, 'wd', 'a.txt')), 'on disk');
      assert.equal(k.mutations.size, 0);
    } finally {
      k.close();
      rm(root);
    }
  });

  it('a request carries the options its mutation takes, as booleans, and the store gets those only', async () => {
    const root = tmpDir('vfs-rpc');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    const w = worker(k);
    // What a worker sends, and what the store on the main thread gets.
    const sent = [];
    w.main.on('message', (msg) => {
      if (msg?.name === 'vfs-mutate') sent.push([msg.op, msg.options]);
    });
    const store = k.registry.get('v').store;
    const taken = [];
    for (const op of ['write', 'append', 'unlink', 'mkdir', 'rm', 'rename']) {
      const original = store[op];
      store[op] = function (...args) {
        taken.push([op, args.at(-1)]);
        return original.apply(this, args);
      };
    }
    try {
      const v = w.kernel.fs('v');
      await v.writeFile('/d/a.txt', 'a', { flag: 'wx', mode: 0o600 });
      await v.appendFile('/d/a.txt', 'b', { mode: 0o600 });
      await v.mkdir('/n', { recursive: 1, mode: 0o700 });
      await v.rename('/d/a.txt', '/d/b.txt');
      await v.unlink('/d/b.txt');
      await v.writeFile('/e/c.txt', 'c');
      await v.rm('/e', { recursive: 1, force: 'yes', maxRetries: 3 });
      const expected = [
        ['write', { exclusive: true }],
        ['append', {}],
        ['mkdir', { recursive: true }],
        ['rename', { directory: false }],
        ['unlink', { directory: false }],
        ['write', { exclusive: false }],
        ['rm', { force: true, recursive: true, directory: false }],
      ];
      assert.deepEqual(sent, expected, 'sent');
      assert.deepEqual(taken, expected, 'taken');
      assert.equal(k.fs('v').exists('/e'), false);
      // Whatever else a request says, the store gets the options of its
      // mutation.
      taken.length = 0;
      const reply = await request(tap(k), {
        place: 'v',
        op: 'rm',
        key: '/gone',
        options: { force: 1, extra: true },
      });
      assert.equal(reply.error, null);
      assert.deepEqual(taken, [
        ['rm', { force: true, recursive: false, directory: false }],
      ]);
    } finally {
      w.kernel.close();
      k.close();
      rm(root);
    }
  });

  it('an accepted request: its key made canonical, its options booleans, its update before its response', async () => {
    const root = tmpDir('vfs-rpc');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    const link = tap(k);
    const v = k.fs('v');
    try {
      const updates = k.nextUpdateId;
      const seen = link.messages.length;
      let reply = await request(link, {
        place: 'v',
        op: 'write',
        key: 'raw.txt',
        options: { exclusive: 'yes', recursive: true },
        data: bytes('one'),
      });
      assert.equal(reply.error, null);
      assert.equal(v.readFile('/raw.txt', 'utf8'), 'one', 'the canonical key');
      assert.equal(k.nextUpdateId, updates + 1, 'one update');
      assert.deepEqual(
        link.messages.slice(seen).map((msg) => msg.name),
        ['vfs-update', 'vfs-mutated'],
      );
      reply = await request(link, {
        place: 'v',
        op: 'write',
        key: '/raw.txt',
        options: { exclusive: 1 },
        data: bytes('two'),
      });
      refusal(reply, {
        code: 'EEXIST',
        syscall: 'open',
        path: v.pathOf('/raw.txt'),
      });
      assert.equal(v.readFile('/raw.txt', 'utf8'), 'one');
      reply = await request(link, {
        place: 'v',
        op: 'append',
        key: '/raw.txt',
        data: bytes('+'),
      });
      assert.equal(reply.error, null);
      assert.equal(v.readFile('/raw.txt', 'utf8'), 'one+');
      reply = await request(link, {
        place: 'v',
        op: 'write',
        key: '/d/a.txt',
        data: bytes('a'),
      });
      assert.equal(reply.error, null);
      reply = await request(link, { place: 'v', op: 'mkdir', key: '/d' });
      refusal(reply, {
        code: 'EEXIST',
        syscall: 'mkdir',
        path: v.pathOf('/d'),
      });
      reply = await request(link, {
        place: 'v',
        op: 'mkdir',
        key: '/d',
        options: { recursive: 'yes' },
      });
      assert.equal(reply.error, null, 'mkdir: recursive');
      reply = await request(link, {
        place: 'v',
        op: 'unlink',
        key: '/raw.txt',
        options: { directory: 1 },
      });
      refusal(reply, {
        code: 'ENOTDIR',
        syscall: 'unlink',
        path: v.pathOf('/raw.txt'),
      });
      reply = await request(link, {
        place: 'v',
        op: 'rename',
        key: '/raw.txt',
        to: 'moved.txt',
      });
      assert.equal(reply.error, null, 'rename: to');
      assert.equal(v.readFile('/moved.txt', 'utf8'), 'one+');
      assert.equal(v.exists('/raw.txt'), false);
      // A SystemError crosses the port with its fields.
      reply = await request(link, { place: 'v', op: 'rm', key: '/d' });
      refusal(reply, {
        name: 'SystemError',
        code: 'ERR_FS_EISDIR',
        syscall: 'rm',
        path: v.pathOf('/d'),
      });
      assert.equal(reply.error.info.code, 'EISDIR');
      reply = await request(link, {
        place: 'v',
        op: 'rm',
        key: '/d',
        options: { recursive: 1 },
      });
      assert.equal(reply.error, null, 'rm: recursive');
      assert.equal(v.exists('/d'), false);
      reply = await request(link, {
        place: 'v',
        op: 'rm',
        key: '/gone',
        options: { force: 'yes' },
      });
      assert.equal(reply.error, null, 'rm: force');
      reply = await request(link, { place: 'v', op: 'rm', key: '/gone' });
      refusal(reply, {
        code: 'ENOENT',
        syscall: 'rm',
        path: v.pathOf('/gone'),
      });
      reply = await request(link, {
        place: 'v',
        op: 'unlink',
        key: 'moved.txt',
      });
      assert.equal(reply.error, null);
      assert.deepEqual(v.readdir('/'), []);
      assert.equal(k.mutations.size, 0, 'no lock left');
    } finally {
      k.close();
      rm(root);
    }
  });
});
