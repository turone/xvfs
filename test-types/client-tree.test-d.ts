// A tree of client ids: the kernel option of its handlers, kernel.tree(),
// lookups with and without policies, nodes, payloads and bytes, the
// batches of its source; what must not compile.

import { ClientTree, Denied, NotFound, VfsConfig, VfsKernel } from 'xvfs';
import type {
  BatchResult,
  ClientId,
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
      zeroCopy: true,
      compress: { encodings: ['br'] },
      intake: { seq: 'source', window: 10, limit: 1000 },
    },
  },
});

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
        expectType<ClientId | undefined>()(err.id);
      },
    },
  },
});

const main = async () => {
  await kernel.initialize();
  const pages = kernel.tree('pages');
  expectType<ClientTree>()(pages);
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
    expectType<ClientId>()(pages.nodeId(node));
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
};
void main;

// --- Refusals ---

// @ts-expect-error a tree's ids are 'number' or 'string'
new VfsConfig({ trees: { t: { ids: 'uuid' } } });
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
// @ts-expect-error a Denied is no node
const denied: TreeNode = tree.get('/a', { allow: () => true });
void denied;
