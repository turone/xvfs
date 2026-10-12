// Types of client-tree.js and of what tree.js exports with it: ClientTree,
// a tree of client ids in every thread (`kernel.tree(name)`), its nodes,
// lookups, payloads and the batches of its source. README, "Trees of
// client ids".

import type { Encoding } from './config.js';
import type { ReadStreamOptions, VfsReadStream } from './place-fs.js';

declare const nodeBrand: unique symbol;

/**
 * A node of a tree of client ids: opaque — the facade hands it out and
 * takes it back. It lives while its node does and keeps its identity
 * through a move; a removed node is dead with its subtree: every
 * operation answers for it as for a missing node, but `nodeId`.
 */
export interface TreeNode {
  readonly [nodeBrand]: true;
}

/** The ids a source gives its nodes: as `trees.<name>.ids` says. */
export type ClientId = number | string;

/**
 * A refusal of a policy on the way to a node: the node whose policy
 * refused, the uppermost, and what `allow` answered.
 */
export class Denied<Decision = unknown> {
  private constructor();
  readonly node: TreeNode;
  readonly decision: Decision;
}

/**
 * A miss of `match()`: the deepest node on the path — null where the tree
 * has no root — and the rest of the key from the first missing name, with
 * its leading `/`.
 */
export class NotFound {
  private constructor();
  readonly node: TreeNode | null;
  readonly rest: string;
}

/**
 * What a lookup asks of the policies on its way, from the root down:
 * `allow(policy, node, context)` for each node with one; `true` lets it
 * through, anything else refuses — `Denied` with that answer.
 */
export interface AllowOptions<Policy = unknown, Context = unknown> {
  allow: (policy: Policy, node: TreeNode, context: Context) => unknown;
  context?: Context;
}

/** A payload in the client's form: bytes and their metadata. */
export interface ClientPayload {
  /** A string is taken as UTF-8. */
  data: Uint8Array | string;
  /** Default: the time it is placed. */
  mtimeMs?: number;
  meta?: unknown;
  scriptOptions?: unknown;
}

export interface PutFields {
  /** A small integer; containers by `trees.<name>.containers`. */
  class?: number;
  /** Absent: the node's as it was; null: none. */
  payload?: ClientPayload | null;
  /** Absent: the node's as it was; null: none. */
  policy?: unknown;
}

/** Creates or changes the node `id`: under `parentId` (null: the root). */
export type PutOp = readonly [
  'put',
  id: ClientId,
  parentId: ClientId | null,
  name: string,
  fields: PutFields,
];
/** Removes the node `id` with its subtree. */
export type RemoveOp = readonly ['remove', id: ClientId];
export type BatchOp = PutOp | RemoveOp;

/**
 * A batch of the source: `seq` its number in `'source'` mode — a safe
 * integer, dense in the order the source commits — none in `'intake'`
 * mode, which numbers batches as they come. Each id once.
 */
export interface Batch {
  seq?: number;
  ops: readonly BatchOp[];
}

/**
 * `'committed'`: published, and this thread's tree shows it;
 * `'duplicate'`: a repeat of a batch applied or waiting — with it;
 * `'superseded'`: dropped by a load past it, whose state it is in.
 */
export interface BatchResult {
  readonly seq: number;
  readonly status: 'committed' | 'duplicate' | 'superseded';
}

/** A node of the source's state, for `load()`. */
export interface LoadRow {
  id: ClientId;
  parentId: ClientId | null;
  name: string;
  class?: number;
  payload?: ClientPayload | null;
  policy?: unknown;
}

/**
 * What the intake refuses a batch or a load with — `onError` and the
 * promise alike: the code (a commit's refusal, `EFBIG`, `ENOSPC`, …), the
 * number of the batch, the index and id of the op, and with `EEXIST` the
 * other node's id. A format refused at once is `EINVAL`, thrown.
 */
export interface TreeRefusal extends Error {
  readonly code: string;
  readonly seq?: number;
  readonly index?: number;
  readonly id?: ClientId;
  readonly other?: ClientId;
}

/** What a node's payload is, without its bytes. Frozen. */
export interface TreePayloadInfo {
  /** The publication that made it. */
  readonly version: number;
  readonly size: number;
  readonly mtimeMs: number;
  /** With `trees.<name>.birthtime`. */
  readonly birthtimeMs?: number;
  readonly meta: unknown;
  readonly scriptOptions: unknown;
  /** The compressed representations it has, in config order. */
  readonly encodings: readonly Encoding[];
}

/**
 * A lease over a representation of a payload (`zeroCopy`): `view` is a
 * direct SAB Buffer, stable until `release()`, never to be mutated or
 * used afterwards. `release()` is synchronous and idempotent.
 */
export interface TreeLease {
  readonly view: Buffer;
  readonly version: number;
  readonly release: () => void;
  readonly [Symbol.dispose]: () => void;
}

export interface TreeWalkOptions {
  /** From 1. Default: every level. */
  depth?: number;
  /** Default `'include'`. */
  containers?: 'include' | 'skip' | 'only';
  classes?: readonly number[] | null;
  /** Whether a node is given. */
  filter?: (node: TreeNode) => boolean;
  /** Whether the walk enters a node it gave. */
  descend?: (node: TreeNode) => boolean;
}

/**
 * A tree of client ids, in every thread: on the main thread its main tree,
 * in a worker its replica. A closed kernel refuses every call
 * (`ERR_VFS_CLOSED`), a broken worker view with what broke it.
 */
export class ClientTree {
  #private;
  private constructor();
  get name(): string;
  get zeroCopy(): boolean;
  /** The last publication that changed it, but by a relocation. */
  get version(): number;
  /** The last publication that made, removed, moved or renamed a node. */
  get structureVersion(): number;
  /** The last publication that changed a policy. */
  get policyVersion(): number;
  /**
   * The number of the last batch of the source this thread's tree shows,
   * or null before a load.
   */
  get last(): number | null;
  /** The classes taken for containers in this thread. */
  get containers(): readonly number[];
  /** Set in this thread alone, without a commit. */
  set containers(classes: readonly number[]);
  /** Null until the source puts one. */
  get root(): TreeNode | null;

  /** The node at `key` (`'/a/b'`, `''` the root), or null. */
  get(key: string): TreeNode | null;
  get(key: string, options: AllowOptions): TreeNode | Denied | null;
  match(key: string): TreeNode | NotFound;
  match(key: string, options: AllowOptions): TreeNode | NotFound | Denied;
  /** The node, the upper refusal on its way, or null for a dead node. */
  check(node: TreeNode, options: AllowOptions): TreeNode | Denied | null;
  byId(id: ClientId): TreeNode | null;

  nodeId(node: TreeNode): ClientId;
  nameOf(node: TreeNode): string | null;
  parentOf(node: TreeNode): TreeNode | null;
  /** `'/a/b'`, `''` for the root, null for a dead node. */
  pathOf(node: TreeNode): string | null;
  /** The nodes from the root down to it. */
  trailOf(node: TreeNode): TreeNode[] | null;
  classOf(node: TreeNode): number | null;
  policyOf(node: TreeNode): unknown;
  isContainer(node: TreeNode): boolean;
  childOf(node: TreeNode, name: string): TreeNode | null;
  /** `[name, isContainer]` of each child in the order it came; null for a dead node. */
  children(node: TreeNode): [string, boolean][] | null;
  /** Lazy; a step after a change of structure is `ESTALE`. */
  childNodesOf(node: TreeNode): IterableIterator<TreeNode>;
  countOf(node: TreeNode): number;
  /** Depth-first, lazy: `[node, depth]`; `ESTALE` after a change of structure. */
  walk(
    nodes: TreeNode | readonly TreeNode[],
    options?: TreeWalkOptions,
  ): IterableIterator<[TreeNode, number]>;
  /** With `aggregates.classes`. */
  classCountOf(node: TreeNode, cls: number): number;
  /** With `aggregates.classes`. */
  leafCountOf(node: TreeNode): number;
  /** With `aggregates.subtreeVersion`. */
  subtreeVersionOf(node: TreeNode): number | null;

  payloadOf(node: TreeNode): TreePayloadInfo | null;
  /** An owned copy of its source. */
  read(node: TreeNode): Buffer | null;
  read(node: TreeNode, encoding: BufferEncoding): string | null;
  /** A lease over its source; needs `zeroCopy` (`ENOTSUP`). */
  view(node: TreeNode): TreeLease | null;
  readCompressed(node: TreeNode, encoding: Encoding): Buffer | null;
  viewCompressed(node: TreeNode, encoding: Encoding): TreeLease | null;
  createReadStream(
    node: TreeNode,
    options?: ReadStreamOptions | BufferEncoding,
  ): VfsReadStream | null;
  /** `encoding` one the tree's `compress` makes (`ENOTSUP` otherwise). */
  createReadStreamCompressed(
    node: TreeNode,
    encoding: Encoding,
    options?: ReadStreamOptions | BufferEncoding,
  ): VfsReadStream | null;

  /**
   * A batch of the source, from any thread: resolves once it is published
   * and this thread's tree shows it. A wrong form throws `EINVAL` at once;
   * a refusal rejects (`TreeRefusal`), a closed kernel `ERR_VFS_CLOSED`.
   */
  submit(batch: Batch): Promise<BatchResult>;
  /**
   * The source's state at `seq` (none in `'intake'` mode), replacing the
   * tree's; the batches after it join its publication.
   */
  load(
    rows: readonly LoadRow[],
    seq?: number,
  ): Promise<{ readonly seq: number }>;
}
