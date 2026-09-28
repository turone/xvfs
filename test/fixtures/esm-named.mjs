// ESM entry for the bootstrap test, under strict, after esm-pre.mjs bound
// the named exports of node:fs before the patch: a named import reads what
// strict hides no more than the default one. Prints one JSON line.
import fs, { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const hidden = new URL('./sandbox/secret/s.txt', import.meta.url);

const codeOf = async (read) => {
  try {
    await read(hidden, 'utf8');
    return 'read';
  } catch (err) {
    return err.code;
  }
};

console.log(
  JSON.stringify({
    named: await codeOf(readFileSync),
    default: await codeOf(fs.readFileSync),
    promises: await codeOf(readFile),
    patched: readFileSync === fs.readFileSync,
  }),
);
