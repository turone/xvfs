'use strict';

const { VfsConfig } = require('../../lib/config.js');
const { VfsKernel } = require('../../lib/kernel.js');
const { worker } = require('../../test/helpers.js');
const { median } = require('../harness.js');
const { tmpDir, cleanup, quiet, timeCommits, timePosts } = require('../lib.js');

// The intake of a shared tree (doc/architecture.md, "Shared trees"): the
// synchronous step one part of a run takes on the main thread — from its
// first commit to the update posted to the one linked worker — by the size
// of the batches and the limit of a part; what
// `trees.<name>.intake.limit` defaults to rests on it. A run is `TOTAL`
// ops of new nodes with a 64-byte payload each, under 100 parents,
// submitted at once.
//
//   node --expose-gc bench/run.js --only intake
//
//   intake.part.<batch>.<limit>  the longest part, ms
//   intake.run.<batch>.<limit>   the whole run, until every batch settled,
//                                ms
//
// Not part of `npm test` or CI.

const TOTAL = 20000;
const BATCHES = [1, 10, 100];
const LIMITS = [1000, 2000, 5000, 10000];
const ROUNDS = 5;
const DATA = Buffer.alloc(64, 1);
const MEMORY = {
  limit: '256 mib',
  segmentSize: '16 mib',
  maxFileSize: '1 mib',
};

const once = async (per, limit) => {
  const root = tmpDir('intake');
  const config = new VfsConfig({
    defaults: { memory: MEMORY },
    trees: {
      t: { ids: 'number', containers: [0], intake: { window: 5, limit } },
    },
  });
  const k = new VfsKernel(config, {
    appRoot: root,
    console: quiet,
    trees: { t: { onGap() {}, onError() {} } },
  });
  await k.initialize();
  const w = worker(k);
  try {
    const t = k.tree('t');
    const rows = [{ id: 1, parentId: null, name: '', class: 0 }];
    for (let p = 0; p < 100; p++) {
      rows.push({ id: 2 + p, parentId: 1, name: `p${p}`, class: 0 });
    }
    await t.load(rows, 0);
    const commits = timeCommits(k, 't');
    const posts = timePosts(k);
    const batches = [];
    for (let b = 0, id = 1000; b < TOTAL / per; b++) {
      const ops = [];
      for (let i = 0; i < per; i++, id++) {
        const fields = { class: 1, payload: { data: DATA } };
        ops.push(['put', id, 2 + (id % 100), `n${id}`, fields]);
      }
      batches.push({ seq: b + 1, ops });
    }
    const started = performance.now();
    await Promise.all(batches.map((batch) => t.submit(batch)));
    const run = performance.now() - started;
    // Commits back to back are one part, which its posted update ends.
    const parts = [];
    for (const [start, end] of commits) {
      const part = parts.at(-1);
      if (part && start - part.end < 0.2) part.end = end;
      else parts.push({ start, end });
    }
    for (const part of parts) {
      const post = posts.find((at) => at >= part.end);
      if (post !== undefined) part.end = post;
    }
    const longest = Math.max(...parts.map((p) => p.end - p.start));
    return { longest, run };
  } finally {
    w.kernel.close();
    k.close();
    cleanup(root);
  }
};

module.exports = async (b) => {
  for (const per of BATCHES) {
    for (const limit of LIMITS) {
      await once(per, limit); // warm-up
      const rounds = [];
      for (let r = 0; r < ROUNDS; r++) rounds.push(await once(per, limit));
      const id = `${per}.${limit}`;
      b.value(
        `intake.part.${id}`,
        'ms',
        'lower',
        median(rounds.map((x) => x.longest)),
      );
      b.value(
        `intake.run.${id}`,
        'ms',
        'lower',
        median(rounds.map((x) => x.run)),
      );
    }
  }
};
