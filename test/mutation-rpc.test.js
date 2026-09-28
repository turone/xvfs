'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  tmpDir,
  writeTree,
  rm,
  kernel,
  tap,
  worker,
  nextEvent,
  leakedBytes,
} = require('./helpers.js');

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
    const ops = ['write', 'append', 'unlink', 'mkdir', 'rm', 'rename'];
    for (const op of [...ops, 'writeFiles']) {
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
      await v.writeFiles([['/f.txt', 'f']], { flag: 'wx', mode: 0o600 });
      await v.writeFiles({ '/g.txt': 'g' });
      const expected = [
        ['write', { exclusive: true }],
        ['append', {}],
        ['mkdir', { recursive: true }],
        ['rename', { directory: false }],
        ['unlink', { directory: false }],
        ['write', { exclusive: false }],
        ['rm', { force: true, recursive: true, directory: false }],
        ['writeFiles', { exclusive: true }],
        ['writeFiles', { exclusive: false }],
      ];
      assert.deepEqual(sent, expected, 'sent');
      assert.deepEqual(taken, expected, 'taken');
      assert.equal(k.fs('v').exists('/e'), false);
      // Whatever else a request says, the store gets the options of its
      // mutation.
      taken.length = 0;
      const link = tap(k);
      let reply = await request(link, {
        place: 'v',
        op: 'rm',
        key: '/gone',
        options: { force: 1, extra: true },
      });
      assert.equal(reply.error, null);
      reply = await request(link, {
        place: 'v',
        op: 'writeFiles',
        keys: ['/h.txt'],
        sizes: [1],
        options: { exclusive: 'yes', recursive: true },
        data: bytes('h'),
      });
      assert.equal(reply.error, null);
      assert.deepEqual(taken, [
        ['rm', { force: true, recursive: false, directory: false }],
        ['writeFiles', { exclusive: true }],
      ]);
    } finally {
      w.kernel.close();
      k.close();
      rm(root);
    }
  });

  // A worker kernel's close() settles the requests it still waits for,
  // and refuses those asked afterwards, as the closed kernel; the close of
  // its port that follows changes neither.
  it("a worker kernel's close() rejects its mutations in flight and later ones as the closed kernel", async () => {
    const root = tmpDir('vfs-rpc');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    const w = worker(k);
    try {
      const closed = {
        code: 'ERR_VFS_CLOSED',
        message: '[vfs] kernel closed before publication',
      };
      const v = w.kernel.fs('v');
      const pending = v.writeFile('/a.txt', 'a');
      const portClosed = nextEvent(w.port, 'close');
      w.kernel.close();
      await assert.rejects(pending, closed, 'in flight');
      await assert.rejects(v.writeFile('/b.txt', 'b'), closed, 'after');
      await portClosed;
      await assert.rejects(v.unlink('/a.txt'), closed, 'its port closed');
    } finally {
      w.kernel.close();
      k.close();
      rm(root);
    }
  });

  // The main kernel closes with a worker's request unanswered: before it
  // published the mutation — the request never reached it — or after, here
  // from a 'publish' listener of its own. The worker cannot tell which.
  it("a worker's mutation whose main kernel closes before the answer is refused as the closed kernel, published or not", async () => {
    const refused = {
      code: 'ERR_VFS_CLOSED',
      message:
        '[vfs] link closed before the mutation was answered: ' +
        'it may or may not have been published',
    };
    for (const published of [false, true]) {
      const root = tmpDir('vfs-rpc');
      const k = await kernel(root, {
        v: { origin: 'virtual', fs: { writable: true } },
      });
      const w = worker(k);
      try {
        let content = null;
        k.on('publish', () => {
          content = k.fs('v').readFile('/a.txt', 'utf8');
          k.close();
        });
        const v = w.kernel.fs('v');
        const pending = v.writeFile('/a.txt', 'a');
        if (!published) k.close();
        await assert.rejects(pending, refused, `published: ${published}`);
        assert.equal(content, published ? 'a' : null);
        await assert.rejects(v.unlink('/a.txt'), refused, 'asked afterwards');
      } finally {
        w.kernel.close();
        k.close();
        rm(root);
      }
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

describe('mutation RPC: writeFiles', () => {
  it("a worker's set is one request, one buffer: its update comes before its answer, the version of its commit", async () => {
    const root = tmpDir('vfs-rpc');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    const w = worker(k);
    try {
      const requests = [];
      w.main.on('message', (msg) => {
        if (msg?.name === 'vfs-mutate') requests.push(msg);
      });
      const delivered = [];
      w.port.on('message', (msg) => delivered.push(msg.name));
      let seen = null;
      w.kernel.on('publish', (event) => {
        seen = event;
      });
      const bytes = Buffer.from('bb');
      const written = w.kernel.fs('v').writeFiles([
        ['a.txt', 'a'],
        ['/d/b.txt', bytes],
        ['/c.txt', ''],
      ]);
      bytes.write('xx');
      assert.equal(await written, 1, 'the version of its commit');
      assert.deepEqual(delivered, ['vfs-update', 'vfs-mutated']);
      assert.deepEqual(seen?.places.v.created, [
        '/a.txt',
        '/d/b.txt',
        '/c.txt',
      ]);
      const [request, ...more] = requests;
      assert.deepEqual(more, [], 'one request');
      assert.deepEqual(request.keys, ['/a.txt', '/d/b.txt', '/c.txt']);
      assert.deepEqual(request.sizes, [1, 2, 0]);
      assert.equal(Buffer.from(request.data).toString(), 'abb');
      const v = k.fs('v');
      assert.equal(v.readFile('/d/b.txt', 'utf8'), 'bb', 'taken when called');
      assert.equal(v.version('/c.txt'), 1);
      assert.equal(w.kernel.fs('v').readFile('/a.txt', 'utf8'), 'a');
      assert.equal(k.nextUpdateId, 1);
      // Other mutations answer as they did: no version.
      assert.equal(await w.kernel.fs('v').writeFile('/e.txt', 'e'), undefined);
    } finally {
      w.kernel.close();
      k.close();
      rm(root);
    }
  });

  it('a set a request does not describe, or a place that takes none, is refused whole', async () => {
    const root = writeTree(tmpDir('vfs-rpc'), { 'wd/a.txt': 'a' });
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
      m: { provider: 'map', origin: 'virtual', fs: { writable: true } },
      wd: { fs: { ext: ['txt'] } },
    });
    const link = tap(k);
    try {
      const updates = k.nextUpdateId;
      const malformed = {
        name: 'TypeError',
        message: '[vfs] writeFiles: malformed request',
      };
      const elsewhere = (name) => {
        const where = k.fs(name).pathOf('');
        return {
          code: 'ENOTSUP',
          syscall: 'writeFiles',
          path: where,
          message:
            'ENOTSUP: operation not supported ' +
            `(not a shared virtual place), writeFiles '${where}'`,
        };
      };
      for (const [what, msg, fields] of [
        [
          'keys and sizes apart',
          { keys: ['/a', '/b'], sizes: [1], data: bytes('ab') },
          malformed,
        ],
        [
          'a size past the data',
          { keys: ['/a'], sizes: [3], data: bytes('ab') },
          malformed,
        ],
        [
          'bytes left over',
          { keys: ['/a'], sizes: [1], data: bytes('ab') },
          malformed,
        ],
        [
          'a negative size',
          { keys: ['/a', '/b'], sizes: [-1, 3], data: bytes('ab') },
          malformed,
        ],
        [
          'a size that is no integer',
          { keys: ['/a'], sizes: ['2'], data: bytes('ab') },
          malformed,
        ],
        ['no key', { keys: [], sizes: [], data: bytes('') }, malformed],
        ['no data', { keys: ['/a'], sizes: [0] }, malformed],
        ['no keys', { key: '/a', sizes: [1], data: bytes('a') }, malformed],
        [
          'a key twice',
          { keys: ['/a', 'a'], sizes: [1, 1], data: bytes('ab') },
          { name: 'TypeError', message: 'writeFiles: "a" written twice' },
        ],
        [
          'an invalid key',
          { keys: ['/a', '/b/../c'], sizes: [1, 1], data: bytes('ab') },
          { name: 'TypeError', message: 'invalid key: "/b/../c"' },
        ],
        [
          'a directory',
          { keys: ['/d/'], sizes: [1], data: bytes('a') },
          { name: 'TypeError', message: 'invalid key: "/d/"' },
        ],
        [
          'a map place',
          { place: 'm', keys: ['/a'], sizes: [1], data: bytes('a') },
          elsewhere('m'),
        ],
        [
          'a disk-origin place',
          { place: 'wd', keys: ['/a.txt'], sizes: [1], data: bytes('a') },
          elsewhere('wd'),
        ],
      ]) {
        const reply = await request(link, {
          place: 'v',
          op: 'writeFiles',
          ...msg,
        });
        assert.ok(reply.error, what);
        refusal(reply, fields);
      }
      assert.equal(k.nextUpdateId, updates, 'nothing published');
      assert.deepEqual(k.fs('v').readdir('/'), []);
      assert.equal(k.fs('m').exists('/a'), false);
      assert.equal(
        fs.readFileSync(path.join(root, 'wd', 'a.txt'), 'utf8'),
        'a',
      );
      assert.equal(leakedBytes(k), 0);
      // A request it takes: its keys canonical, its options booleans.
      let reply = await request(link, {
        place: 'v',
        op: 'writeFiles',
        keys: ['a.txt', '/b.txt'],
        sizes: [1, 2],
        options: { exclusive: 'yes', extra: true },
        data: bytes('abb'),
      });
      assert.equal(reply.error, null);
      assert.equal(reply.version, updates + 1);
      const v = k.fs('v');
      assert.equal(v.readFile('/a.txt', 'utf8'), 'a');
      assert.equal(v.readFile('/b.txt', 'utf8'), 'bb');
      // The bytes of a set are a view: one past the start of its buffer.
      const buffer = new Uint8Array(8);
      buffer.set(Buffer.from('xxxoppyy'));
      reply = await request(link, {
        place: 'v',
        op: 'writeFiles',
        keys: ['/o.txt', '/p.txt'],
        sizes: [1, 2],
        data: buffer.subarray(3, 6),
      });
      assert.equal(reply.error, null);
      assert.equal(v.readFile('/o.txt', 'utf8'), 'o');
      assert.equal(v.readFile('/p.txt', 'utf8'), 'pp');
      reply = await request(link, {
        place: 'v',
        op: 'writeFiles',
        keys: ['/c.txt', '/b.txt'],
        sizes: [1, 1],
        options: { exclusive: 1 },
        data: bytes('cb'),
      });
      refusal(reply, {
        code: 'EEXIST',
        syscall: 'writeFiles',
        path: v.pathOf('/b.txt'),
      });
      assert.equal('version' in reply, false);
      assert.equal(v.exists('/c.txt'), false);
      assert.equal(k.mutations.size, 0);
    } finally {
      k.close();
      rm(root);
    }
  });

  it("the refusal of a worker's set crosses the link with its fields", async () => {
    const root = tmpDir('vfs-rpc');
    const k = await kernel(root, {
      v: {
        origin: 'virtual',
        fs: { writable: true, script: { ext: ['js'] } },
      },
    });
    const w = worker(k);
    try {
      const v = w.kernel.fs('v');
      await assert.rejects(
        v.writeFiles([
          ['/ok.js', 'x = 1;'],
          ['/bad.js', '((('],
        ]),
        {
          code: 'ENOTSUP',
          syscall: 'writeFiles',
          path: v.pathOf('/bad.js'),
          message:
            'ENOTSUP: operation not supported (fs.script.compile: source ' +
            `does not compile), writeFiles '${v.pathOf('/bad.js')}'`,
        },
      );
      await assert.rejects(
        v.writeFiles([
          ['/a', 'a'],
          ['/a/b.js', 'b'],
        ]),
        { code: 'ENOTDIR', syscall: 'writeFiles', path: v.pathOf('/a/b.js') },
      );
      assert.equal(k.fs('v').exists('/ok.js'), false);
      assert.equal(k.nextUpdateId, 0);
      assert.equal(leakedBytes(k), 0);
    } finally {
      w.kernel.close();
      k.close();
      rm(root);
    }
  });
});
