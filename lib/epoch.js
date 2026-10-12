'use strict';

// Epochs — what one publication of the main kernel gathers for each place
// before its commit (kernel.js, #flush), and the two pure steps that turn
// it into a commit of the place's tree (lib/tree.js) and tell what that
// commit changes.
//
// An epoch is one of four kinds:
//   init        the scan of every place and its SEA assets at initialize()
//   watch       one epoch of the watcher, or one recheck
//   ops         one mutation of a virtual place
//   relocation  one compaction of the pool
// The first two gather intents — what the disk says each key is now: a
// directory, a file (its payload input and the extents it took), or gone
// — the last of them for a key winning; reconcile() makes the commit of
// them against the tree as it is. The other two gather the tree's ops
// themselves, in the order the mutation or the compaction gives them.

const INIT = 'init';
const WATCH = 'watch';
const OPS = 'ops';
const RELOCATION = 'relocation';

const DIR = 1;
const FILE = 2;
const GONE = 3;

// What a file's `write` makes of its missing directories: a scan and the
// watcher publish what the disk holds, whose directories exist there; a
// set of files of a virtual place creates the ones it lacks.
const PARENTS = Object.freeze({ parents: true });

// What one epoch gathers for one place.
class PlaceEpoch {
  constructor(place) {
    this.place = place;
    this.intents = new Map(); // init, watch: key → { type, input?, extents? }
    this.ops = []; // ops, relocation: the tree's ops, in order
    this.extents = []; // ops, relocation: every extent the ops took
  }

  // Every extent the epoch holds and no commit has published: to free
  // when it is given up.
  *placed() {
    yield* this.extents;
    for (const intent of this.intents.values()) {
      if (intent.extents) yield* intent.extents;
    }
  }
}

const newEpoch = (mode) => ({ mode, places: new Map(), target: null });

const placeEpoch = (ep, place) => {
  let pe = ep.places.get(place.name);
  if (!pe) ep.places.set(place.name, (pe = new PlaceEpoch(place)));
  return pe;
};

// Whether `key` or a directory above it is in `keys`.
const within = (keys, key) => {
  for (let k = key; k !== ''; k = k.slice(0, k.lastIndexOf('/'))) {
    if (keys.has(k)) return true;
  }
  return false;
};

// The commit of a scan's or a watcher's intents for one place, against
// its tree as it is: `{ ops, owners }`, `owners[i]` the key of the intent
// op `i` serves — what a refusal of that op drops. Removals first — the
// keys gone that the tree holds, a directory with what lies below it, each
// once (the root's children for the root) — then directories, every
// missing one down to the key, a file in the way unlinked first, then
// files, written with their missing directories (PARENTS), a directory in
// the way removed first: the disk holds the one or the other, and says
// which.
const reconcile = (tree, intents) => {
  const ops = [];
  const owners = [];
  const gone = [];
  const dirs = [];
  const files = [];
  for (const [key, intent] of intents) {
    if (intent.type === GONE) gone.push(key);
    else if (intent.type === DIR) dirs.push(key);
    else files.push(key);
  }
  const removed = new Set(); // keys this commit removes, with their subtrees
  const made = new Map(); // key → DIR | FILE this commit makes there
  const kindOf = (key) => {
    const own = made.get(key);
    if (own !== undefined) return own;
    if (within(removed, key)) return null;
    const node = tree.get(key);
    if (node === null) return null;
    return tree.isDirectory(node) ? DIR : FILE;
  };
  const op = (owner, ...args) => {
    ops.push(args);
    owners.push(owner);
  };
  gone.sort();
  for (const key of gone) {
    const roots = [];
    if (key !== '') roots.push(key);
    else
      for (const [name] of tree.children(tree.get(''))) roots.push('/' + name);
    for (const root of roots) {
      if (kindOf(root) === null) continue;
      op(key, 'remove', root);
      removed.add(root);
    }
  }
  dirs.sort();
  for (const key of dirs) {
    if (key === '') continue;
    for (let at = key.indexOf('/', 1); ; at = key.indexOf('/', at + 1)) {
      const part = at === -1 ? key : key.slice(0, at);
      const kind = kindOf(part);
      if (kind === FILE) op(key, 'unlink', part);
      if (kind !== DIR) {
        op(key, 'mkdir', part);
        made.set(part, DIR);
      }
      if (at === -1) break;
    }
  }
  for (const key of files) {
    if (kindOf(key) === DIR) {
      op(key, 'remove', key);
      removed.add(key);
    }
    op(key, 'write', key, intents.get(key).input, PARENTS);
    made.set(key, FILE);
  }
  return { ops, owners };
};

// What a commit asks its tree for: what it did to its nodes (the
// commit's `changes`), which its events are made of (eventsOf).
const CHANGES = Object.freeze({ changes: true });

// The FS tree's class of a directory.
const DIRECTORY = 0;

// The events of a commit — the files it changed in a place — and the
// keys of the nodes it killed, which its retired versions are named by
// afterwards, from what the tree says it did to its nodes (the commit's
// `changes`): the state after the commit, not its ops. A key created and
// removed in one commit is named nowhere; a node written and moved is in
// `moved` and, under its new key, in `replaced`.
//   created   files the commit made, by their key after it
//   replaced  files that lived before, got a payload of its ops and live
//             after, by their key after it
//   removed   files of the state before that died, by their key before
//   moved     [from, to] of every node — a file or a directory, its
//             subtree with it — that lives after under another key; a
//             file it replaced is in `removed`
//   keys      id → key before, of every node that died
const eventsOf = (tree, changes) => {
  const created = [];
  for (const id of changes.created) {
    const node = tree.byId(id);
    if (!tree.isDirectory(node)) created.push(tree.pathOf(node));
  }
  const replaced = [];
  for (const id of changes.changed) {
    const node = tree.byId(id);
    if (!tree.isDirectory(node)) replaced.push(tree.pathOf(node));
  }
  const moved = [];
  for (const { id, from } of changes.moved) {
    moved.push([from, tree.pathOf(tree.byId(id))]);
  }
  const removed = [];
  const keys = new Map();
  for (const { id, key, cls } of changes.removed) {
    keys.set(id, key);
    if (cls !== DIRECTORY) removed.push(key);
  }
  return { created, replaced, removed, moved, keys };
};

// The extents an op publishes: a write's representations, a relocation's
// new extent.
const extentsOf = (op) => {
  if (op[0] === 'write') return op[2].representations.map(([, e]) => e);
  if (op[0] === 'relocate') return [op[3]];
  return [];
};

module.exports = {
  INIT,
  WATCH,
  OPS,
  RELOCATION,
  DIR,
  FILE,
  GONE,
  PARENTS,
  newEpoch,
  placeEpoch,
  reconcile,
  CHANGES,
  eventsOf,
  extentsOf,
};
