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

// --- A place's rules ---

const DOMAINS = ['fs', 'require', 'import'];

// Whether a domain's `ext` sees fewer names than `outer`: null sees all.
const narrower = (ext, outer) => {
  if (ext === null || ext === undefined) return false;
  if (outer === null || outer === undefined) return true;
  return outer.some((name) => !ext.includes(name));
};

// What settings hide that `parent` showed — a domain off, fewer
// extensions, the disk territory refused — and whether they forbid the
// writes `parent` let through.
const restrictionOf = (settings, parent) => {
  let hides = false;
  for (const domain of DOMAINS) {
    const outer = parent[domain];
    if (outer === null) continue;
    const own = settings[domain];
    if (own === null || narrower(own.ext, outer.ext)) hides = true;
  }
  const { fs } = settings;
  if (fs !== null && parent.fs?.fallback === 'disk' && fs.fallback === 'deny') {
    hides = true;
  }
  const readOnly = Boolean(parent.fs?.writable) && fs !== null && !fs.writable;
  return { hides, readOnly };
};

// PlaceRules — the rules of one place (config `places.<name>.rules`): the
// settings in force at each of its keys — the place's own, overridden by
// every rule on the way down to the key, the deepest last: a domain a rule
// turns off is off below it, and on again below a rule that gives it
// again, from the settings it had before it went off. Settled once, from
// the config: a lookup walks the names of a key while the trie has them,
// and the node it stops at holds the settings. Names compare as the place
// compares them: without case (foldName) where its disk does (`caseless`,
// Place.caseless), else exactly.
//
// A node also knows whether a rule below it restricts — hides what the
// settings above it show (`hides`), or forbids writes they let through
// (`readOnly`): an operation on its whole subtree — a recursive removal, a
// move of a directory — would act past them.
class PlaceRules {
  #trie = new PathTrie(() => ({
    children: null,
    settings: null,
    lastOn: null,
    hides: false,
    readOnly: false,
    hidesBelow: false,
    readOnlyBelow: false,
  }));
  #fold;

  // `config`: a place's resolved config with `rules` (config.js).
  constructor(config, caseless = false) {
    this.#fold = caseless ? foldName : null;
    const { root } = this.#trie;
    root.settings = Object.freeze({
      fs: config.fs,
      require: config.require,
      import: config.import,
    });
    root.lastOn = root.settings;
    const rules = new Map(); // node → its rule
    for (const [key, rule] of Object.entries(config.rules)) {
      rules.set(this.#trie.ensure(this.#namesOf(key)), rule);
    }
    this.#settle(root, rules);
  }

  // The settings of each node below `node`, from its parent's and its own
  // rule (`lastOn`: per domain, those it had where it was last on); then
  // what the rules below each restrict.
  #settle(node, rules) {
    if (node.children === null) return;
    for (const child of node.children.values()) {
      const rule = rules.get(child);
      if (rule === undefined) {
        child.settings = node.settings;
        child.lastOn = node.lastOn;
      } else {
        const settings = {};
        const lastOn = {};
        for (const domain of DOMAINS) {
          const own = rule[domain];
          if (own === undefined) {
            settings[domain] = node.settings[domain];
            lastOn[domain] = node.lastOn[domain];
          } else if (own === false) {
            settings[domain] = null;
            lastOn[domain] = node.lastOn[domain];
          } else {
            const base = node.settings[domain] ?? node.lastOn[domain];
            settings[domain] = Object.freeze({ ...base, ...own });
            lastOn[domain] = settings[domain];
          }
        }
        child.settings = Object.freeze(settings);
        child.lastOn = lastOn;
        const { hides, readOnly } = restrictionOf(settings, node.settings);
        child.hides = hides;
        child.readOnly = readOnly;
      }
      this.#settle(child, rules);
      if (child.hides || child.hidesBelow) node.hidesBelow = true;
      if (child.readOnly || child.readOnlyBelow) node.readOnlyBelow = true;
    }
  }

  // The names of a key: '/a/b', 'a/b' and '/a/b/' alike; '' and '/' none.
  #namesOf(key) {
    const folded = this.#fold === null ? key : this.#fold(key);
    return folded.split('/').filter((name) => name !== '');
  }

  // The settings in force at `key`: { fs, require, import }, each a
  // domain's settings or null where it is off.
  at(key) {
    const folded = this.#fold === null ? key : this.#fold(key);
    let node = this.#trie.root;
    let start = folded.charCodeAt(0) === 47 ? 1 : 0;
    while (node.children !== null && start < folded.length) {
      const end = folded.indexOf('/', start);
      const last = end === -1;
      const next = node.children.get(
        folded.slice(start, last ? undefined : end),
      );
      if (next === undefined) break;
      node = next;
      if (last) break;
      start = end + 1;
    }
    return node.settings;
  }

  // Why an operation on the whole subtree at `key` — a recursive removal, a
  // move of a directory — is refused by a rule below it, or null: EACCES
  // where one hides a path, else EROFS where one forbids writes there.
  below(key) {
    const node = this.#trie.find(this.#namesOf(key));
    if (node === null) return null;
    if (node.hidesBelow) return 'EACCES';
    return node.readOnlyBelow ? 'EROFS' : null;
  }
}

module.exports = { PathTrie, PlaceRules, foldName };
