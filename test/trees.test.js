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

// A tree of client ids in the kernel (doc/architecture.md, "Trees of
// client ids"): declared in the config, created at initialize() — empty,
// its root the source's first put of one — in every snapshot, read in
// every thread through kernel.tree(name), its batches published by the
// intake of the main thread, from the main thread or a worker.

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
        scriptOptions: null,
        encodings: [],
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

  it('compresses what `compress` names; the encodings are told', async () => {
    const { k, done } = await treeKernel({
      pages: { ...PAGES, compress: { encodings: ['gzip'], ext: ['html'] } },
    });
    try {
      const t = k.tree('pages');
      const html = '<p>' + 'x'.repeat(500) + '</p>';
      await t.load([ROOT, page(2, 'a.html', html), page(3, 'b.bin', 'y')], 0);
      const a = t.get('/a.html');
      assert.deepEqual(t.payloadOf(a).encodings, ['gzip']);
      const zlib = require('node:zlib');
      assert.equal(
        zlib.gunzipSync(t.readCompressed(a, 'gzip')).toString(),
        html,
      );
      assert.deepEqual(t.payloadOf(t.get('/b.bin')).encodings, []);
      assert.equal(t.readCompressed(t.get('/b.bin'), 'gzip'), null);
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
      assert.equal(text, html);
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
