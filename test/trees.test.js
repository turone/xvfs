'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { VfsKernel } = require('../lib/kernel.js');
const { VfsConfig } = require('../lib/config.js');
const { Denied, NotFound } = require('../lib/tree.js');
const {
  tmpDir,
  rm,
  quiet,
  worker,
  until,
  drain,
  leakedBytes,
  assertAtRest,
  activeResources,
  closeAtRest,
} = require('./helpers.js');

// A shared tree in the kernel (doc/architecture.md, "Shared trees"):
// declared in the config, created at initialize() — empty, its root the
// source's first put of one — in every snapshot, read in every thread
// through kernel.tree(name), its batches published by the intake of the
// main thread, from the main thread or a worker.

const MEMORY = { limit: '8 mib', segmentSize: '1 mib', maxFileSize: '1 mib' };

// A kernel with `trees` (and `places`), the handlers of their intakes
// recording what they hear.
const treeKernel = async (trees, extra = {}) => {
  const root = tmpDir('vfs-trees');
  const errors = [];
  const gaps = [];
  const handlers = {};
  for (const name of Object.keys(trees)) {
    handlers[name] = {
      onGap: (gap) => gaps.push([name, gap]),
      onError: (err) => errors.push([name, err]),
    };
  }
  const config = new VfsConfig({
    defaults: { memory: MEMORY, ...extra.defaults },
    places: extra.places ?? {},
    trees,
  });
  const k = new VfsKernel(config, {
    appRoot: root,
    console: quiet,
    trees: handlers,
  });
  await k.initialize();
  const done = () => {
    k.close();
    rm(root);
  };
  return { k, root, errors, gaps, done };
};

const PAGES = { ids: 'number', containers: [0], intake: { window: 1 } };
const ROOT = { id: 1, parentId: null, name: '', class: 0 };
const page = (id, name, data, extra = {}) => ({
  id,
  parentId: 1,
  name,
  class: 1,
  payload: { data, ...extra },
});
const put = (id, parentId, name, fields) => ['put', id, parentId, name, fields];

const record = (k) => {
  const events = [];
  k.on('publish', (event) => events.push(event));
  return events;
};

describe('trees: the main thread', () => {
  it('a declared tree is empty until a load; a load and batches publish, read back', async () => {
    const { k, done } = await treeKernel({ pages: PAGES });
    try {
      const t = k.tree('pages');
      assert.equal(t.name, 'pages');
      assert.equal(t.root, null, 'no root before the source has one');
      assert.equal(t.last, null);
      const events = record(k);
      assert.deepEqual(
        await t.load([ROOT, page(2, 'about', 'About', { mtimeMs: 7 })], 10),
        { seq: 10 },
      );
      const about = t.get('/about');
      assert.ok(about);
      assert.equal(t.read(about, 'utf8'), 'About');
      assert.deepEqual(t.payloadOf(about), {
        version: k.version,
        size: 5,
        mtimeMs: 7,
        meta: null,
        rendered: null,
      });
      assert.ok(Object.isFrozen(t.payloadOf(about)));
      assert.equal(t.nodeId(about), 2);
      assert.equal(t.byId(2), about);
      assert.equal(t.pathOf(about), '/about');
      assert.equal(t.isContainer(t.root), true);
      assert.equal(t.isContainer(about), false);
      assert.deepEqual(t.children(t.root), [['about', false]]);
      assert.equal(t.last, 10);
      const committed = await t.submit({
        seq: 11,
        ops: [
          put(3, 1, 'news', {
            class: 1,
            payload: { data: Buffer.from('News'), meta: { title: 'N' } },
          }),
        ],
      });
      assert.deepEqual(committed, { seq: 11, status: 'committed' });
      const news = t.get('/news');
      assert.equal(t.read(news, 'utf8'), 'News', 'read your own write');
      assert.deepEqual(t.payloadOf(news).meta, { title: 'N' });
      assert.equal(t.last, 11);
      await until(() => events.length === 2);
      assert.deepEqual(
        events.map((e) => e.trees),
        [
          [{ tree: 'pages', seqFrom: 10, seqTo: 10, loaded: true }],
          [{ tree: 'pages', seqFrom: 11, seqTo: 11, loaded: false }],
        ],
      );
      assert.deepEqual(events[0].places, {});
      assert.equal(leakedBytes(k), 0);
    } finally {
      done();
    }
  });

  it('a replaced payload is retired, held by a lease until it is released', async () => {
    const { k, done } = await treeKernel({
      pages: { ...PAGES, zeroCopy: true },
    });
    try {
      const t = k.tree('pages');
      await t.load([ROOT, page(2, 'a', 'one')], 0);
      const lease = t.view(t.get('/a'));
      assert.equal(lease.view.toString(), 'one');
      const stream = t.createReadStream(t.get('/a'));
      await t.submit({
        seq: 1,
        ops: [put(2, 1, 'a', { payload: { data: 'two' } })],
      });
      assert.equal(t.read(t.get('/a'), 'utf8'), 'two');
      assert.equal(lease.view.toString(), 'one', 'the lease reads its own');
      assert.equal((await drain(stream)).toString(), 'one');
      assert.ok(k.retirements().some((r) => r.place === 'pages'));
      lease.release();
      stream.release();
      assert.ok(await until(() => k.retirements().length === 0));
      assert.equal(leakedBytes(k), 0);
    } finally {
      done();
    }
  });

  it('views need zeroCopy; a missing node reads null', async () => {
    const { k, done } = await treeKernel({ pages: PAGES });
    try {
      const t = k.tree('pages');
      await t.load([ROOT, page(2, 'a', 'x')], 0);
      assert.throws(() => t.view(t.get('/a')), { code: 'ENOTSUP' });
      assert.equal(t.read(t.root), null, 'the root has no payload');
      assert.equal(t.get('/none'), null);
    } finally {
      done();
    }
  });

  it('compresses every rendered page, never the data; the encodings are told', async () => {
    const { k, done } = await treeKernel({
      pages: { ...PAGES, compress: { encodings: ['gzip'] } },
    });
    try {
      const t = k.tree('pages');
      const html = '<p>' + 'x'.repeat(500) + '</p>';
      const data = JSON.stringify({ body: 'y'.repeat(500) });
      await t.load(
        [ROOT, { ...page(2, 'a', data), rendered: html }, page(3, 'b', data)],
        0,
      );
      const a = t.get('/a');
      assert.deepEqual(t.payloadOf(a).rendered, {
        size: html.length,
        encodings: ['gzip'],
      });
      assert.equal(t.readRendered(a, 'utf8'), html);
      const zlib = require('node:zlib');
      assert.equal(
        zlib.gunzipSync(t.readCompressed(a, 'gzip')).toString(),
        html,
        'the gzip of the page',
      );
      assert.equal(t.read(a, 'utf8'), data, 'the data as it was given');
      assert.equal(t.payloadOf(t.get('/b')).rendered, null);
      assert.equal(t.readRendered(t.get('/b')), null);
      assert.equal(t.readCompressed(t.get('/b'), 'gzip'), null);
      for (const name of ['br', 'requireBytecode', 'bogus']) {
        assert.throws(() => t.readCompressed(a, name), { code: 'ENOTSUP' });
        assert.throws(() => t.createReadStreamCompressed(a, name), {
          code: 'ENOTSUP',
        });
      }
      let text = '';
      for await (const chunk of t.createReadStream(a, 'utf8')) {
        assert.equal(typeof chunk, 'string', 'an encoding string');
        text += chunk;
      }
      assert.equal(text, data);
      assert.equal(leakedBytes(k), 0);
    } finally {
      done();
    }
  });

  it('a refused batch is told and held until a load', async () => {
    const { k, errors, done } = await treeKernel({ pages: PAGES });
    try {
      const t = k.tree('pages');
      await t.load([ROOT], 0);
      const refused = t.submit({
        seq: 1,
        ops: [put(5, 99, 'x', { class: 1 })],
      });
      await assert.rejects(refused, (err) => {
        return err.code === 'ENOENT' && err.seq === 1 && err.id === 5;
      });
      assert.equal(errors.length, 1);
      assert.equal(errors[0][0], 'pages');
      const held = t.submit({ seq: 2, ops: [put(6, 1, 'y', { class: 1 })] });
      await t.load([ROOT, page(6, 'y', 'loaded')], 2);
      assert.deepEqual(await held, { seq: 2, status: 'superseded' });
      assert.equal(t.read(t.get('/y'), 'utf8'), 'loaded');
    } finally {
      done();
    }
  });

  it('a compaction moves the representations of a tree by id', async () => {
    const KB = 1024;
    const { k, done } = await treeKernel(
      { pages: PAGES },
      {
        defaults: {
          memory: {
            limit: '16 kib',
            segmentSize: '4 kib',
            maxFileSize: '4 kib',
          },
          compaction: { threshold: 0.5 },
        },
      },
    );
    try {
      const t = k.tree('pages');
      await t.load(
        [
          ROOT,
          page(2, 'a', 'a'.repeat(2 * KB)),
          page(3, 'b', 'b'.repeat(2 * KB)),
          page(4, 'c', 'c'.repeat(200)),
        ],
        0,
      );
      const segmentOf = () =>
        k.tree('pages').byId(4) &&
        k.trees.get('pages').tree.payloadOf(k.trees.get('pages').tree.byId(4))
          .source.segmentId;
      assert.equal(segmentOf(), 2);
      const version = t.payloadOf(t.byId(4)).version;
      // Freeing /a makes segment 2 the target: /c moves to segment 1.
      await t.submit({ seq: 1, ops: [['remove', 2]] });
      assert.ok(await until(() => segmentOf() === 1), '/c relocated');
      assert.equal(t.read(t.byId(4), 'utf8'), 'c'.repeat(200));
      assert.equal(t.payloadOf(t.byId(4)).version, version, 'its version kept');
      assert.ok(await until(() => k.retirements().length === 0));
      assert.equal(leakedBytes(k), 0);
    } finally {
      done();
    }
  });

  it('a compaction moves every representation of a node, its data, its page and its gzip in one segment', async () => {
    const KB = 1024;
    const { k, done } = await treeKernel(
      { pages: { ...PAGES, compress: { encodings: ['gzip'] } } },
      {
        defaults: {
          memory: {
            limit: '16 kib',
            segmentSize: '4 kib',
            maxFileSize: '4 kib',
          },
          compaction: { threshold: 0.5 },
        },
      },
    );
    try {
      const t = k.tree('pages');
      const html = `<p>${'c'.repeat(200)}</p>`;
      const data = 'c'.repeat(100);
      await t.load(
        [
          ROOT,
          page(2, 'a', 'a'.repeat(2 * KB)),
          page(3, 'b', 'b'.repeat(2 * KB)),
          { ...page(4, 'c', data), rendered: html },
        ],
        0,
      );
      const tree = k.trees.get('pages').tree;
      const segmentsOf = () => {
        const payload = tree.payloadOf(tree.byId(4));
        const { source, others } = payload;
        return [source, others.requireBytecode, others.gzip].map(
          (rep) => rep.segmentId,
        );
      };
      assert.deepEqual(segmentsOf(), [2, 2, 2]);
      // Freeing /a makes segment 2 the target: all three move to segment 1.
      await t.submit({ seq: 1, ops: [['remove', 2]] });
      assert.ok(
        await until(() => segmentsOf().every((s) => s === 1)),
        'the data, the page and its gzip relocated',
      );
      const c = t.byId(4);
      assert.equal(t.read(c, 'utf8'), data);
      const zlib = require('node:zlib');
      assert.equal(
        zlib.gunzipSync(t.readCompressed(c, 'gzip')).toString(),
        html,
      );
      assert.ok(await until(() => k.retirements().length === 0));
      assert.equal(leakedBytes(k), 0);
    } finally {
      done();
    }
  });

  it('close() rejects what waits; a closed kernel refuses every call', async () => {
    const { k, done } = await treeKernel({ pages: PAGES });
    const t = k.tree('pages');
    const waiting = t.submit({ seq: 1, ops: [] });
    k.close();
    await assert.rejects(waiting, { code: 'ERR_VFS_CLOSED' });
    assert.throws(() => t.get('/'), { code: 'ERR_VFS_CLOSED' });
    assert.throws(() => t.submit({ seq: 2, ops: [] }), {
      code: 'ERR_VFS_CLOSED',
    });
    assert.throws(() => k.tree('pages'), /requires a ready kernel/);
    done();
  });

  it('a tree needs the handlers of its intake; an unknown tree is refused', async () => {
    const root = tmpDir('vfs-trees');
    try {
      const config = new VfsConfig({ trees: { pages: PAGES } });
      const k = new VfsKernel(config, { appRoot: root, console: quiet });
      await assert.rejects(k.initialize(), /trees\.pages: the kernel option/);
      const { k: k2, done } = await treeKernel({ pages: PAGES });
      assert.throws(() => k2.tree('none'), /unknown tree "none"/);
      assert.throws(() => k2.tree('pages').submit({ seq: -1, ops: [] }), {
        code: 'EINVAL',
      });
      done();
    } finally {
      rm(root);
    }
  });
});

describe('trees: workers', () => {
  it('a worker replicates the tree, applies its publications and tells them', async () => {
    const { k, done } = await treeKernel({ pages: PAGES });
    const w = worker(k);
    try {
      const t = k.tree('pages');
      const wt = w.kernel.tree('pages');
      const events = record(w.kernel);
      await t.load([ROOT, page(2, 'a', 'one')], 3);
      const late = worker(k);
      const lt = late.kernel.tree('pages');
      assert.equal(lt.read(lt.get('/a'), 'utf8'), 'one', 'from its snapshot');
      assert.equal(lt.last, 3);
      await t.submit({
        seq: 4,
        ops: [put(2, 1, 'a', { payload: { data: 'two' } })],
      });
      assert.ok(await until(() => wt.last === 4));
      assert.equal(wt.read(wt.get('/a'), 'utf8'), 'two');
      assert.ok(await until(() => events.length === 2));
      assert.deepEqual(
        events.map((e) => e.trees),
        [
          [{ tree: 'pages', seqFrom: 3, seqTo: 3, loaded: true }],
          [{ tree: 'pages', seqFrom: 4, seqTo: 4, loaded: false }],
        ],
      );
      assert.deepEqual(
        events.map((e) => e.version),
        [k.version - 1, k.version],
      );
      // A batch that changes nothing publishes nothing, and every thread's
      // tree shows it: its `last` moves.
      const version = k.version;
      assert.deepEqual(await t.submit({ seq: 5, ops: [] }), {
        seq: 5,
        status: 'committed',
      });
      assert.equal(t.last, 5);
      assert.ok(await until(() => wt.last === 5 && lt.last === 5));
      assert.equal(k.version, version);
      assert.equal(w.kernel.version, version);
      assert.equal(events.length, 2, 'no event');
      late.kernel.close();
    } finally {
      w.kernel.close();
      done();
    }
  });

  it("a worker's batch is answered once its replica shows it; a refusal comes back whole", async () => {
    const { k, errors, done } = await treeKernel({ pages: PAGES });
    const w = worker(k);
    try {
      await k.tree('pages').load([ROOT], 0);
      const wt = w.kernel.tree('pages');
      assert.ok(await until(() => wt.last === 0));
      const status = await wt.submit({
        seq: 1,
        ops: [put(2, 1, 'w', { class: 1, payload: { data: 'from a worker' } })],
      });
      assert.deepEqual(status, { seq: 1, status: 'committed' });
      assert.equal(wt.read(wt.get('/w'), 'utf8'), 'from a worker');
      assert.equal(
        k.tree('pages').read(k.tree('pages').get('/w'), 'utf8'),
        'from a worker',
      );
      await assert.rejects(
        wt.submit({ seq: 2, ops: [put(3, 77, 'x', { class: 1 })] }),
        (err) =>
          err.code === 'ENOENT' &&
          err.seq === 2 &&
          err.index === 0 &&
          err.id === 3,
      );
      assert.equal(errors.length, 1, 'onError on the main thread');
      assert.throws(() => wt.submit({ seq: 3, ops: [['move', 1]] }), {
        code: 'EINVAL',
      });
      assert.deepEqual(await wt.load([ROOT, page(9, 'z', 'z')], 5), { seq: 5 });
      assert.equal(wt.read(wt.get('/z'), 'utf8'), 'z');
      assert.equal(leakedBytes(k), 0);
    } finally {
      w.kernel.close();
      done();
    }
  });

  it('a worker of other languages is refused at attach(): the indexes would name other codes', async () => {
    const { k, root, done } = await treeKernel({
      pages: { ...PAGES, languages: ['en', 'uk'] },
    });
    try {
      const attach = (languages) =>
        VfsKernel.fromSnapshot(
          k.snapshot(),
          new VfsConfig({
            defaults: { memory: MEMORY },
            trees: { pages: { ...PAGES, languages } },
          }),
          { appRoot: root, console: quiet },
        );
      // Another count, other codes of the same count, another order: each
      // would name other languages by the snapshot's indexes.
      for (const languages of [
        undefined,
        ['en'],
        ['en', 'uk', 'de'],
        ['en', 'ua'],
        ['uk', 'en'],
      ]) {
        assert.throws(() => attach(languages), {
          code: 'EINVAL',
          message: /tree "pages" speaks \["en","uk"\] in the snapshot/,
        });
      }
      const w = attach(['en', 'uk']);
      assert.equal(w.trees.get('pages').tree.languages, 2);
      w.close();
    } finally {
      done();
    }
  });
});

describe('trees: policies', () => {
  it('allow passes each policy from the root down; a refusal is Denied, a miss NotFound', async () => {
    const { k, done } = await treeKernel({ pages: PAGES });
    const w = worker(k);
    try {
      const t = k.tree('pages');
      const admin = { id: 2, parentId: 1, name: 'admin', class: 0 };
      await t.load(
        [
          ROOT,
          { ...admin, policy: { role: 'admin' } },
          {
            id: 3,
            parentId: 2,
            name: 'page',
            class: 1,
            payload: { data: 's' },
          },
          page(4, 'public', 'open'),
        ],
        0,
      );
      const allow = (policy, node, context) =>
        context.roles.includes(policy.role) || 'forbidden';
      const guest = { allow, context: { roles: [] } };
      const staff = { allow, context: { roles: ['admin'] } };
      const wt = w.kernel.tree('pages');
      assert.ok(await until(() => wt.last === 0));
      for (const tree of [t, wt]) {
        const denied = tree.get('/admin/page', guest);
        assert.ok(denied instanceof Denied);
        assert.equal(denied.decision, 'forbidden');
        assert.equal(tree.pathOf(denied.node), '/admin');
        assert.equal(tree.read(tree.get('/admin/page', staff), 'utf8'), 's');
        assert.equal(tree.read(tree.get('/public', guest), 'utf8'), 'open');
        const missing = tree.match('/admin/none', staff);
        assert.ok(missing instanceof NotFound);
        assert.equal(missing.rest, '/none');
        assert.equal(tree.pathOf(missing.node), '/admin');
        assert.ok(tree.match('/admin/none', guest) instanceof Denied);
        assert.ok(tree.check(tree.get('/admin/page'), guest) instanceof Denied);
        assert.equal(
          tree.check(tree.get('/public'), guest),
          tree.get('/public'),
        );
        assert.deepEqual(tree.policyOf(tree.get('/admin')), { role: 'admin' });
      }
      // A batch that changes a policy: policyVersion moves in every thread.
      const before = t.policyVersion;
      await t.submit({
        seq: 1,
        ops: [['put', 2, 1, 'admin', { class: 0, policy: null }]],
      });
      assert.ok(t.policyVersion > before);
      assert.ok(await until(() => wt.last === 1));
      assert.equal(wt.policyVersion, t.policyVersion);
      assert.equal(wt.read(wt.get('/admin/page', guest), 'utf8'), 's');
      assert.throws(() => t.get('/admin', { allow: 'yes' }), {
        code: 'EINVAL',
      });
    } finally {
      w.kernel.close();
      done();
    }
  });
});

describe('trees: at rest', () => {
  it('a refused batch leaves nothing; close() leaves nothing alive, a gap waited for included', async () => {
    const baseline = activeResources();
    // A gap waited for far longer than closeAtRest waits for a timer.
    const intake = { window: 1, gapTimeout: 60_000 };
    const { k, errors, done } = await treeKernel({
      pages: { ...PAGES, maxFileSize: '1 kib', intake },
    });
    const w = worker(k);
    try {
      await k.tree('pages').load([ROOT], 0);
      const wt = w.kernel.tree('pages');
      assert.ok(await until(() => wt.last === 0));
      const refusals = [
        [{ seq: 1, ops: [put(2, 9, 'x', { class: 1 })] }, 'ENOENT'],
        [
          {
            seq: 1,
            ops: [
              put(2, 1, 'x', { class: 1, payload: { data: 'x'.repeat(2048) } }),
            ],
          },
          'EFBIG',
        ],
      ];
      for (const [batch, code] of refusals) {
        await assert.rejects(wt.submit(batch), { code });
        await assertAtRest(k, { workers: [w.kernel] });
        await k.tree('pages').load([ROOT], 0);
      }
      assert.equal(errors.length, 2);
      // A batch past a gap waits — its timer with it — until close().
      const late = k.tree('pages').submit({ seq: 9, ops: [] });
      const closed = assert.rejects(late, { code: 'ERR_VFS_CLOSED' });
      await closeAtRest(k, { workers: [w.kernel], baseline });
      await closed;
    } finally {
      w.kernel.close();
      done();
    }
  });
});

describe('trees: diagnostics', () => {
  it('a tree shows its nodes, payloads, bytes and intake; the pool adds up', async () => {
    const { k, done } = await treeKernel({
      pages: { ...PAGES, intake: { window: 1, gapTimeout: 60_000 } },
    });
    try {
      const t = k.tree('pages');
      const empty = k.diagnostics().trees.pages;
      assert.deepEqual(empty, {
        nodes: 0,
        payloads: 0,
        bytes: 0,
        languages: {},
        last: null,
        held: true,
        waiting: 0,
      });
      await t.load([ROOT, page(2, 'a', 'one'), page(3, 'b', 'three')], 4);
      const late = t.submit({ seq: 9, ops: [] });
      late.catch(() => {});
      const { pool, published, retired, trees } = k.diagnostics();
      assert.deepEqual(trees.pages, {
        nodes: 3,
        payloads: 2,
        bytes: 8,
        languages: {},
        last: 4,
        held: false,
        waiting: 1,
      });
      assert.equal(
        pool.used,
        published.bytes + trees.pages.bytes + retired.bytes,
      );
    } finally {
      done();
    }
  });
});

describe('trees: what the source gives', () => {
  it('what structured clone cannot carry is EINVAL at once in every thread; what is kept is a frozen copy', async () => {
    const { k, done } = await treeKernel({ pages: PAGES });
    const w = worker(k);
    try {
      const t = k.tree('pages');
      const wt = w.kernel.tree('pages');
      await t.load([ROOT], 0);
      assert.ok(await until(() => wt.last === 0));
      for (const tree of [t, wt]) {
        const bad = [
          put(2, 1, 'a', { class: 1, policy: () => true }),
          put(2, 1, 'a', {
            class: 1,
            payload: { data: 'a', meta: { f() {} } },
          }),
        ];
        for (const op of bad) {
          assert.throws(() => tree.submit({ seq: 1, ops: [op] }), {
            code: 'EINVAL',
            index: 0,
            id: 2,
          });
        }
        const row = { ...page(2, 'a', 'a'), policy: Symbol('p') };
        assert.throws(() => tree.load([ROOT, row], 1), { code: 'EINVAL' });
      }
      assert.equal(k.state, 'ready');
      const policy = { role: 'admin' };
      const meta = { title: 'A' };
      const fields = { class: 1, policy, payload: { data: 'a', meta } };
      const submitted = wt.submit({ seq: 1, ops: [put(2, 1, 'a', fields)] });
      policy.role = 'guest';
      meta.title = 'B';
      await submitted;
      for (const tree of [t, wt]) {
        const node = tree.get('/a');
        assert.deepEqual(tree.policyOf(node), { role: 'admin' });
        assert.ok(Object.isFrozen(tree.policyOf(node)));
        assert.deepEqual(tree.payloadOf(node).meta, { title: 'A' });
        assert.ok(Object.isFrozen(tree.payloadOf(node).meta));
      }
      assert.equal(leakedBytes(k), 0);
    } finally {
      w.kernel.close();
      done();
    }
  });
});

describe('trees: the rule of containers', () => {
  it('a thread sets its own, each class once', async () => {
    const { k, done } = await treeKernel({ pages: PAGES });
    try {
      const t = k.tree('pages');
      t.containers = [0, 1];
      assert.deepEqual(t.containers, [0, 1]);
      assert.throws(
        () => {
          t.containers = [1, 1];
        },
        { code: 'EINVAL' },
      );
      assert.deepEqual(t.containers, [0, 1], 'as it was');
    } finally {
      done();
    }
  });
});

describe('trees: languages and pages', () => {
  const SITE = {
    ...PAGES,
    languages: ['en', 'uk'],
    compress: { encodings: ['gzip'] },
  };
  const about = (data, rendered, uk) => ({
    id: 2,
    parentId: 1,
    name: 'about',
    class: 1,
    payload: { data },
    rendered,
    translations: { uk },
  });

  it('a tree speaks its main language; lang(code) any — lookups, names, paths, data and pages there', async () => {
    const { k, done } = await treeKernel({ site: SITE });
    try {
      const t = k.tree('site');
      assert.deepEqual(t.languages, ['en', 'uk']);
      const uk = t.lang('uk');
      assert.equal(t.lang('uk'), uk, 'one view a code');
      assert.equal(uk.code, 'uk');
      assert.throws(() => t.lang('de'), { code: 'EINVAL' });
      await t.load(
        [
          ROOT,
          about('{"en":1}', '<en>', {
            name: 'pro',
            payload: { data: '{"uk":1}' },
            rendered: '<uk>',
          }),
          { id: 3, parentId: 2, name: 'team', class: 1 },
        ],
        0,
      );
      const node = uk.get('/pro');
      assert.equal(node, t.get('/about'), 'one node');
      assert.equal(uk.get('/about'), null, 'the main name is not one there');
      assert.deepEqual(t.pathsOf(t.byId(3)), { en: '/about/team', uk: null });
      assert.equal(uk.nameOf(t.byId(3)), null, 'not translated: not there');
      assert.equal(t.lang('en').get('/about'), node, 'the main view');
      assert.equal(uk.read(node, 'utf8'), '{"uk":1}');
      assert.equal(uk.readRendered(node, 'utf8'), '<uk>');
      assert.equal(t.readRendered(node, 'utf8'), '<en>');
      const zlib = require('node:zlib');
      assert.equal(
        zlib.gunzipSync(uk.readCompressed(node, 'gzip')).toString(),
        '<uk>',
      );
      assert.deepEqual(uk.payloadOf(node).rendered, {
        size: 4,
        encodings: ['gzip'],
      });
      assert.deepEqual(uk.children(t.root), [['pro', false]]);
      assert.equal(uk.countOf(node), 0);
      assert.equal(t.countOf(node), 1);
      const { languages } = k.diagnostics().trees.site;
      assert.deepEqual(languages.uk, {
        names: 2,
        payloads: 1,
        rendered: 1,
        bytes: languages.uk.bytes,
      });
      assert.equal(languages.en.names, 3);
      assert.equal(leakedBytes(k), 0);
    } finally {
      done();
    }
  });

  it('cache publishes the page alone — no number, an event of nulls; a worker reads its own', async () => {
    const { k, done } = await treeKernel({
      site: { ...SITE, maxFileSize: '1 kib' },
    });
    const w = worker(k);
    try {
      const t = k.tree('site');
      await t.load([ROOT, about('{"en":1}', null, { name: 'pro' })], 7);
      const wt = w.kernel.tree('site');
      assert.ok(await until(() => wt.last === 7));
      const events = record(k);
      const node = wt.get('/about');
      const info = wt.payloadOf(node);
      assert.equal(info.rendered, null);
      // A page of the main language, from the worker: in its replica once
      // the promise resolves.
      assert.deepEqual(await wt.cache(node, '<p>en</p>', info.version), {
        status: 'cached',
      });
      assert.equal(wt.readRendered(node, 'utf8'), '<p>en</p>');
      assert.equal(t.readRendered(t.get('/about'), 'utf8'), '<p>en</p>');
      assert.equal(wt.last, 7, 'no batch: last stays');
      assert.ok(await until(() => events.length === 1));
      assert.deepEqual(events[0].trees, [
        { tree: 'site', seqFrom: null, seqTo: null, loaded: false },
      ]);
      // Of a version no longer its payload's: stale, nothing published.
      assert.deepEqual(await wt.cache(node, '<old>', info.version), {
        status: 'stale',
      });
      // uk has no data: stale; the main thread's uncache: every language.
      const uk = wt.lang('uk');
      assert.deepEqual(await uk.cache(node, '<uk>', 1), { status: 'stale' });
      assert.deepEqual(await t.uncache(t.get('/about')), { dropped: 1 });
      assert.ok(await until(() => wt.readRendered(node) === null));
      // Over the link: an uncache of the worker's, and a refusal with its
      // fields — the language among them.
      assert.deepEqual(await uk.uncache(node, { subtree: true }), {
        dropped: 0,
      });
      const version = wt.payloadOf(node).version;
      await assert.rejects(wt.cache(node, 'x'.repeat(2048), version), {
        code: 'EFBIG',
        id: 2,
        lang: 'en',
      });
      assert.throws(() => uk.uncache(node, { subtree: 1 }), {
        code: 'EINVAL',
      });
      await assertAtRest(k, { workers: [w.kernel] });
    } finally {
      w.kernel.close();
      done();
    }
  });

  it('a worker submits every language over the link; a refusal in one names it', async () => {
    const { k, errors, done } = await treeKernel({ site: SITE });
    const w = worker(k);
    try {
      await k.tree('site').load(
        [
          ROOT,
          {
            id: 3,
            parentId: 1,
            name: 'x',
            class: 1,
            translations: { uk: { name: 'taken' } },
          },
        ],
        0,
      );
      const wt = w.kernel.tree('site');
      assert.ok(await until(() => wt.last === 0));
      await wt.submit({
        seq: 1,
        ops: [
          put(2, 1, 'about', {
            class: 1,
            payload: { data: 'en' },
            rendered: '<en>',
            translations: {
              uk: { name: 'pro', payload: { data: 'uk' }, rendered: '<uk>' },
            },
          }),
        ],
      });
      const uk = wt.lang('uk');
      assert.equal(uk.readRendered(uk.get('/pro'), 'utf8'), '<uk>');
      assert.equal(wt.read(wt.get('/about'), 'utf8'), 'en');
      await assert.rejects(
        wt.submit({
          seq: 2,
          ops: [
            put(2, 1, 'about', { translations: { uk: { name: 'taken' } } }),
          ],
        }),
        (err) =>
          err.code === 'EEXIST' &&
          err.lang === 'uk' &&
          err.other === 3 &&
          err.id === 2,
      );
      assert.equal(errors.at(-1)[1].lang, 'uk');
      assert.throws(
        () =>
          wt.submit({
            seq: 3,
            ops: [put(2, 1, 'about', { translations: { de: { name: 'd' } } })],
          }),
        { code: 'EINVAL', lang: 'de' },
      );
      assert.equal(leakedBytes(k), 0);
    } finally {
      w.kernel.close();
      done();
    }
  });

  it('a translation and its page retire with their node; a compaction moves them by language', async () => {
    const KB = 1024;
    const { k, done } = await treeKernel(
      { site: { ...SITE, compress: null } },
      {
        defaults: {
          memory: {
            limit: '16 kib',
            segmentSize: '4 kib',
            maxFileSize: '4 kib',
          },
          compaction: { threshold: 0.5 },
        },
      },
    );
    try {
      const t = k.tree('site');
      const uk = t.lang('uk');
      const data = 'c'.repeat(100);
      await t.load(
        [
          ROOT,
          { ...page(2, 'a', 'a'.repeat(2 * KB)) },
          { ...page(3, 'b', 'b'.repeat(2 * KB)) },
          {
            ...page(4, 'c', data),
            translations: {
              uk: { name: 'c-uk', payload: { data }, rendered: '<c>' },
            },
          },
        ],
        0,
      );
      const tree = k.trees.get('site').tree;
      const segmentsOf = () => {
        const payload = tree.payloadOf(tree.byId(4), 1);
        return [payload.source, payload.others.requireBytecode].map(
          (rep) => rep.segmentId,
        );
      };
      assert.deepEqual(segmentsOf(), [2, 2]);
      await t.submit({ seq: 1, ops: [['remove', 2]] });
      assert.ok(
        await until(() => segmentsOf().every((s) => s === 1)),
        'the translation and its page relocated',
      );
      const c = uk.get('/c-uk');
      assert.equal(uk.read(c, 'utf8'), data);
      assert.equal(uk.readRendered(c, 'utf8'), '<c>');
      assert.ok(await until(() => k.retirements().length === 0));
      // The node removed: its translation and its page retire with it.
      await t.submit({ seq: 2, ops: [['remove', 4]] });
      assert.ok(await until(() => k.retirements().length === 0));
      await assertAtRest(k);
    } finally {
      done();
    }
  });
});
