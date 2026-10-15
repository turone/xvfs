// A shared tree: the kernel option of its handlers, kernel.tree(),
// lookups with and without policies, nodes, payloads and bytes, the
// batches of its source; what must not compile.

import { SharedTree, Denied, NotFound, VfsConfig, VfsKernel } from 'xvfs';
import type {
  BatchResult,
  CacheResult,
  Encoding,
  NodeId,
  TreeLanguage,
  TreeLease,
  TreeNode,
  TreePayloadInfo,
  TreeRefusal,
  VfsReadStream,
} from 'xvfs';
import { expectType } from './expect.js';

const config = new VfsConfig({
  trees: {
    pages: {
      ids: 'number',
      containers: [0],
      languages: ['en', 'uk'],
      zeroCopy: true,
      compress: { encodings: ['br'] },
      intake: { seq: 'source', window: 10, limit: 1000 },
    },
  },
});
expectType<readonly string[]>()(config.tree('pages')!.languages);

const kernel = new VfsKernel(config, {
  trees: {
    pages: {
      onGap: (gap) => {
        expectType<number>()(gap.from);
        expectType<number>()(gap.to);
      },
      onError: (err) => {
        expectType<TreeRefusal>()(err);
        expectType<string>()(err.code);
        expectType<number | undefined>()(err.seq);
        expectType<NodeId | undefined>()(err.id);
      },
    },
  },
});

const main = async () => {
  await kernel.initialize();
  const pages = kernel.tree('pages');
  expectType<SharedTree>()(pages);
  expectType<number | null>()(pages.last);
  expectType<number>()(pages.policyVersion);
  expectType<TreeNode | null>()(pages.root);

  const loaded = await pages.load(
    [
      { id: 1, parentId: null, name: '', class: 0 },
      { id: 2, parentId: 1, name: 'about', class: 1, payload: { data: 'x' } },
      { id: 3, parentId: 1, name: 'admin', class: 0, policy: { role: 'a' } },
    ],
    10,
  );
  expectType<number>()(loaded.seq);
  const result = await pages.submit({
    seq: 11,
    ops: [
      ['put', 4, 1, 'news', { class: 1, payload: { data: new Uint8Array(1) } }],
      ['remove', 2],
    ],
  });
  expectType<BatchResult>()(result);
  expectType<'committed' | 'duplicate' | 'superseded'>()(result.status);

  const node = pages.get('/news');
  expectType<TreeNode | null>()(node);
  if (node !== null) {
    expectType<NodeId>()(pages.nodeId(node));
    expectType<string | null>()(pages.pathOf(node));
    expectType<TreePayloadInfo | null>()(pages.payloadOf(node));
    expectType<Buffer | null>()(pages.read(node));
    expectType<string | null>()(pages.read(node, 'utf8'));
    expectType<TreeLease | null>()(pages.view(node));
    expectType<Buffer | null>()(pages.readCompressed(node, 'br'));
    expectType<VfsReadStream | null>()(pages.createReadStream(node));
    for (const [child, depth] of pages.walk(node, { containers: 'skip' })) {
      expectType<TreeNode>()(child);
      expectType<number>()(depth);
    }
  }

  const allow = (policy: unknown) => policy === null || 'forbidden';
  const found = pages.get('/admin', { allow, context: { roles: [] } });
  if (found instanceof Denied) {
    expectType<TreeNode>()(found.node);
    expectType<unknown>()(found.decision);
  } else if (found !== null) {
    expectType<TreeNode>()(found);
  }
  const matched = pages.match('/admin/none');
  if (matched instanceof NotFound) {
    expectType<TreeNode | null>()(matched.node);
    expectType<string>()(matched.rest);
  }

  // Languages and pages.
  expectType<readonly string[]>()(pages.languages);
  const uk = pages.lang('uk');
  expectType<TreeLanguage>()(uk);
  expectType<string>()(uk.code);
  await pages.submit({
    seq: 12,
    ops: [
      [
        'put',
        5,
        1,
        'contacts',
        {
          class: 1,
          payload: { meta: { title: 'Contacts' } },
          rendered: '<h1>Contacts</h1>',
          translations: {
            uk: { name: 'kontakty', payload: { data: '{}' }, rendered: null },
            de: null,
          },
        },
      ],
    ],
  });
  const page = uk.get('/kontakty');
  if (page !== null) {
    expectType<string | null>()(uk.pathOf(page));
    expectType<{ readonly [code: string]: string | null } | null>()(
      pages.pathsOf(page),
    );
    const info = uk.payloadOf(page);
    if (info !== null) {
      expectType<number>()(info.version);
      expectType<{
        readonly size: number;
        readonly encodings: readonly Encoding[];
      } | null>()(info.rendered);
      const cached = await uk.cache(page, '<p>', info.version);
      expectType<CacheResult>()(cached);
      expectType<'cached' | 'stale'>()(cached.status);
    }
    expectType<string | null>()(uk.readRendered(page, 'utf8'));
    expectType<Buffer | null>()(pages.readRendered(page));
    expectType<TreeLease | null>()(uk.viewRendered(page));
    expectType<VfsReadStream | null>()(pages.createRenderedStream(page));
    const { dropped } = await pages.uncache(page, { subtree: true });
    expectType<number>()(dropped);
    await uk.uncache(page);
  }
};
void main;

const onError = (err: TreeRefusal) =>
  expectType<string | undefined>()(err.lang);
void onError;

// --- Refusals ---

// @ts-expect-error a tree's ids are 'number' or 'string'
new VfsConfig({ trees: { t: { ids: 'uuid' } } });
// @ts-expect-error languages are codes
new VfsConfig({ trees: { t: { ids: 'number', languages: [1, 2] } } });
// @ts-expect-error unknown numbering of batches
new VfsConfig({ trees: { t: { ids: 'number', intake: { seq: 'auto' } } } });
const tree = kernel.tree('pages');
// @ts-expect-error an op is put or remove
void tree.submit({ seq: 1, ops: [['move', 1, 2]] });
void tree.submit({
  seq: 1,
  // @ts-expect-error a payload's data is bytes or a string
  ops: [['put', 1, null, '', { payload: { data: 1 } }]],
});
void tree.submit({
  seq: 1,
  // @ts-expect-error a tree's payload has no scriptOptions
  ops: [['put', 1, null, '', { payload: { data: 'x', scriptOptions: {} } }]],
});
void tree.submit({
  seq: 1,
  // @ts-expect-error a page is bytes, a string or null
  ops: [['put', 1, null, '', { rendered: 1 }]],
});
// @ts-expect-error a Denied is no node
const denied: TreeNode = tree.get('/a', { allow: () => true });
void denied;
