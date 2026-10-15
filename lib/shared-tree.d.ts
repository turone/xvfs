// Types of shared-tree.js and of what tree.js exports with it: SharedTree,
// a shared tree in every thread (`kernel.tree(name)`) — the pages and
// routes of a site, a menu, a catalogue — its nodes, lookups, payloads and
// the batches of its source. README, "Page and route trees".

import type { Encoding } from './config.js';
import type { ReadStreamOptions, VfsReadStream } from './place-fs.js';

declare const nodeBrand: unique symbol;

/**
 * A node of a shared tree: opaque — the facade hands it out and
 * takes it back. It lives while its node does and keeps its identity
 * through a move; a removed node is dead with its subtree: every
 * operation answers for it as for a missing node, but `nodeId`.
 */
export interface TreeNode {
  readonly [nodeBrand]: true;
}

/**
 * The id a node has in its source — a page's key in the database — kept
 * through moves and renames: a number or a string, as `trees.<name>.ids`
 * says.
 */
export type NodeId = number | string;

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

/**
 * A payload as a batch or a load gives it: the data a page is rendered
 * from — fields of a database — and its metadata. The data stays in the
 * tree, never compressed.
 */
export interface TreePayload {
  /** A string is taken as UTF-8. Default: empty. */
  data?: Uint8Array | string;
  /** Default: the time it is placed. */
  mtimeMs?: number;
  meta?: unknown;
}

/**
 * A page rendered from a payload — what goes to a client — or null: none.
 * A string is taken as UTF-8. Compressed by `trees.<name>.compress`.
 */
export type Rendered = Uint8Array | string | null;

/** A node in a language but the main one. */
export interface Translation {
  /** Its name there: '' for the root, which may leave it out. */
  name?: string;
  /** Absent: as it was; null: none, the name stays. */
  payload?: TreePayload | null;
  /** Absent: as it was, unless `payload` is new; null: none. */
  rendered?: Rendered;
}

/** By code; null: no translation, its name and payload gone. */
export interface Translations {
  readonly [code: string]: Translation | null;
}

export interface PutFields {
  /** A small integer; containers by `trees.<name>.containers`. */
  class?: number;
  /** Absent: the node's as it was; null: none. */
  payload?: TreePayload | null;
  /**
   * Its page in the main language. Absent: as it was, unless `payload` is
   * new — new data has no page but this; null: none.
   */
  rendered?: Rendered;
  /** Absent: the node's as it was; null: none. */
  policy?: unknown;
  /** The languages that changed; absent: the translations as they were. */
  translations?: Translations;
}

/** Creates or changes the node `id`: under `parentId` (null: the root). */
export type PutOp = readonly [
  'put',
  id: NodeId,
  parentId: NodeId | null,
  name: string,
  fields: PutFields,
];
/** Removes the node `id` with its subtree. */
export type RemoveOp = readonly ['remove', id: NodeId];
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

/**
 * A node of the source's state, for `load()`: the whole node — a field it
 * lacks is none (no payload, page, policy or translation), but `class`,
 * which stays a live node's. A translation but the root's has its name.
 */
export interface LoadRow {
  id: NodeId;
  parentId: NodeId | null;
  name: string;
  class?: number;
  payload?: TreePayload | null;
  rendered?: Rendered;
  policy?: unknown;
  translations?: Translations;
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
  readonly id?: NodeId;
  readonly other?: NodeId;
  /**
   * In a tree of several languages, the code of the one it is about — the
   * main one's too: a name taken there, a page without data, a format.
   */
  readonly lang?: string;
}

/** What a node's payload is, without its bytes. Frozen. */
export interface TreePayloadInfo {
  /**
   * The last publication that changed what it holds — its data or its
   * page; a relocation keeps it. An ETag of it changes with the bytes.
   */
  readonly version: number;
  /** Of the data. */
  readonly size: number;
  /** Of the data: a new page leaves it. */
  readonly mtimeMs: number;
  /** With `trees.<name>.birthtime`. */
  readonly birthtimeMs?: number;
  readonly meta: unknown;
  /** Its page, or null: its size and compressed forms, in config order. */
  readonly rendered: {
    readonly size: number;
    readonly encodings: readonly Encoding[];
  } | null;
}

/** What a `cache()` came to: `'stale'`, a page of data no longer there. */
export interface CacheResult {
  readonly status: 'cached' | 'stale';
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

/** What a page op takes: the node, its subtree too with `subtree`. */
export interface UncacheOptions {
  subtree?: boolean;
}

/**
 * A language of a shared tree, `tree.lang(code)`: what depends on it. A
 * node without a translation there is not there, nor what lies below it;
 * the root is, named ''. Children come in the order of the main language.
 */
export interface TreeLanguage {
  readonly code: string;
  get(key: string): TreeNode | null;
  get(key: string, options: AllowOptions): TreeNode | Denied | null;
  match(key: string): TreeNode | NotFound;
  match(key: string, options: AllowOptions): TreeNode | NotFound | Denied;
  nameOf(node: TreeNode): string | null;
  pathOf(node: TreeNode): string | null;
  childOf(node: TreeNode, name: string): TreeNode | null;
  children(node: TreeNode): [string, boolean][] | null;
  countOf(node: TreeNode): number;
  payloadOf(node: TreeNode): TreePayloadInfo | null;
  read(node: TreeNode): Buffer | null;
  read(node: TreeNode, encoding: BufferEncoding): string | null;
  view(node: TreeNode): TreeLease | null;
  createReadStream(
    node: TreeNode,
    options?: ReadStreamOptions | BufferEncoding,
  ): VfsReadStream | null;
  readRendered(node: TreeNode): Buffer | null;
  readRendered(node: TreeNode, encoding: BufferEncoding): string | null;
  viewRendered(node: TreeNode): TreeLease | null;
  createRenderedStream(
    node: TreeNode,
    options?: ReadStreamOptions | BufferEncoding,
  ): VfsReadStream | null;
  readCompressed(node: TreeNode, encoding: Encoding): Buffer | null;
  viewCompressed(node: TreeNode, encoding: Encoding): TreeLease | null;
  createReadStreamCompressed(
    node: TreeNode,
    encoding: Encoding,
    options?: ReadStreamOptions | BufferEncoding,
  ): VfsReadStream | null;
  /**
   * The page of a node's payload here, rendered from the payload of
   * `version` — `payloadOf(node).version` — from any thread: resolves once
   * published and in this thread; `'stale'` when that payload is gone.
   */
  cache(
    node: TreeNode,
    bytes: Uint8Array | string,
    version: number,
  ): Promise<CacheResult>;
  /** No page here, of the node — of its subtree too. */
  uncache(
    node: TreeNode,
    options?: UncacheOptions,
  ): Promise<{ readonly dropped: number }>;
}

/**
 * A shared tree, in every thread: on the main thread its main tree,
 * in a worker its replica. It speaks its main language; `lang(code)` is a
 * view of any. A closed kernel refuses every call (`ERR_VFS_CLOSED`), a
 * broken worker view with what broke it.
 */
export class SharedTree {
  #private;
  private constructor();
  get name(): string;
  get zeroCopy(): boolean;
  /** The codes of its languages, the main one first; [] without. */
  get languages(): readonly string[];
  /** A view of a language, one per code; `EINVAL` for a code it has not. */
  lang(code: string): TreeLanguage;
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
  byId(id: NodeId): TreeNode | null;

  nodeId(node: TreeNode): NodeId;
  nameOf(node: TreeNode): string | null;
  parentOf(node: TreeNode): TreeNode | null;
  /** `'/a/b'`, `''` for the root, null for a dead node. */
  pathOf(node: TreeNode): string | null;
  /**
   * Its path in every language, by code — null where it is not — or null
   * for a dead node; `{}` in a tree without `languages`.
   */
  pathsOf(node: TreeNode): { readonly [code: string]: string | null } | null;
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
  /** An owned copy of its data. */
  read(node: TreeNode): Buffer | null;
  read(node: TreeNode, encoding: BufferEncoding): string | null;
  /** A lease over its data; needs `zeroCopy` (`ENOTSUP`). */
  view(node: TreeNode): TreeLease | null;
  /** Its page: an owned copy. */
  readRendered(node: TreeNode): Buffer | null;
  readRendered(node: TreeNode, encoding: BufferEncoding): string | null;
  viewRendered(node: TreeNode): TreeLease | null;
  createRenderedStream(
    node: TreeNode,
    options?: ReadStreamOptions | BufferEncoding,
  ): VfsReadStream | null;
  /** A compressed form of its page. */
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

  /** The page in the main language (`TreeLanguage.cache`). */
  cache(
    node: TreeNode,
    bytes: Uint8Array | string,
    version: number,
  ): Promise<CacheResult>;
  /**
   * No page in any language — `lang(code).uncache` for one — of the node,
   * of its subtree too: how many pages went.
   */
  uncache(
    node: TreeNode,
    options?: UncacheOptions,
  ): Promise<{ readonly dropped: number }>;

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
