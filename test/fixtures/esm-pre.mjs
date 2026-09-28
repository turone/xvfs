// A preload that runs before the bootstrap and imports node:fs and
// node:fs/promises by name: the ES modules' named exports are bound here,
// before the patch is installed. Run by test/bootstrap.test.js before
// esm-named.mjs.
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

globalThis.boundBeforePatch = [readFileSync, readFile];
