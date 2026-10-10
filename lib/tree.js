'use strict';

// The tree engine — to be written in step A (.work/stage1/SPEC.md). This is
// the stand's placeholder: the tests in test/tree-*.js run against the
// engine that replaces it.

class Denied {
  constructor(node, decision) {
    this.node = node;
    this.decision = decision;
  }
}

class NotFound {
  constructor(node, rest) {
    this.node = node;
    this.rest = rest;
  }
}

const notYet = () => {
  throw new Error('lib/tree.js: the engine is not written yet (step A)');
};

module.exports = { createTree: notYet, fromSnapshot: notYet, Denied, NotFound };
