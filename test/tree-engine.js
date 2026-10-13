'use strict';

// The engine under test: lib/tree.js, or the module TREE_ENGINE names (an
// absolute path) — the stand's self-check runs a naive engine and its mutants
// that way, and the two engines of step A run from their own worktrees.

const path = require('node:path');

module.exports = require(
  process.env.TREE_ENGINE || path.join(__dirname, '..', 'lib', 'tree.js'),
);
