'use strict';

// What holds down a path (doc/architecture.md, "Rules of subtrees"): a trie
// of names, a node for each path something is set at and for every path
// above one, each node's attributes in force from its path down to the
// next node that sets its own. A place's rules are one (PlaceRules: by
// the keys of the place, compared as the place compares them); the links
// strict knows are another (LinkIndex: by the disk's absolute paths,
// compared as the disk compares them).

// How a file system that takes a name in any case compares names: equal
// once lower-cased, the Greek final sigma as a sigma — NTFS equates them,
// where lower-casing keeps them apart by their place in the word. It
// equates a few names NTFS keeps apart (the Kelvin sign with `k`), which
// only puts more paths under a rule, or behind a link.
const foldName = (name) => {
  const lower = name.toLowerCase();
  return lower.includes('ς') ? lower.replaceAll('ς', 'σ') : lower;
};

// A node: { children: Map<name, node> | null, …what its owner keeps }, made
// by `make()` — one shape for every node of a trie.
class PathTrie {
  #make;

  constructor(make) {
    this.#make = make;
    this.root = make();
  }

  // The node of `name` below `node`, or null.
  static child(node, name) {
    return node.children?.get(name) ?? null;
  }

  // The node at `names` below `from`, each missing one made.
  ensure(names, from = this.root) {
    let node = from;
    for (const name of names) {
      let next = node.children?.get(name);
      if (next === undefined) {
        next = this.#make();
        if (node.children === null) node.children = new Map();
        node.children.set(name, next);
      }
      node = next;
    }
    return node;
  }

  // The node at `names` below `from`, or null.
  find(names, from = this.root) {
    let node = from;
    for (const name of names) {
      node = node.children?.get(name);
      if (node === undefined) return null;
    }
    return node;
  }
}

module.exports = { PathTrie, foldName };
