'use strict';

// A reader worker of async-worker: never writes. It learns of a new report
// only through its own kernel's `'publish'` event (README, "Publication
// events") — never raw disk or SAB events — then reads report.html,
// report.json and render.js as one set, proving every artifact of one
// commit carries the same version (README, "Versions") and that
// render.js, run from its own V8 cached data (`fs.script.compile`),
// reproduces report.html exactly.

const vm = require('node:vm');
const { parentPort, workerData } = require('node:worker_threads');
const { attach } = require('../..');

const kernel = attach();
const reports = kernel.fs('reports');
const { id } = workerData;

// One read of the whole set, as it stands at this instant: either every
// artifact is the new version, or every one is still the old — writeFiles
// never publishes part of its set (README, "writeFiles").
const observe = () => {
  const html = reports.readFile('/report.html', 'utf8');
  const json = reports.readFile('/report.json', 'utf8');
  const bundle = reports.script('/render.js');
  const report = JSON.parse(json);
  const script = new vm.Script(bundle.source, {
    ...bundle.scriptOptions,
    cachedData: bundle.cachedData,
  });
  const rendered = script.runInThisContext()(report);
  const htmlVersion = reports.version('/report.html');
  const jsonVersion = reports.version('/report.json');
  const jsVersion = reports.version('/render.js');
  return {
    worker: id,
    round: report.round,
    version: jsonVersion,
    versionsMatch: htmlVersion === jsonVersion && jsonVersion === jsVersion,
    htmlMatches: rendered === html,
    cachedDataRejected: script.cachedDataRejected,
    sha256: report.sha256,
  };
};

// The library's own publication event — not `fs.watch`, which stays
// ENOTSUP for managed territory. Fires only after a commit that actually
// published something to this place.
kernel.on('publish', (event) => {
  if (!event.places.reports) return;
  parentPort.postMessage({ kind: 'published', ...observe() });
});

// On demand, for the main thread to confirm the set is unchanged after a
// publication that never happened (round 3 of run.js).
parentPort.on('message', ({ cmd }) => {
  if (cmd === 'peek') parentPort.postMessage({ kind: 'peek', ...observe() });
});
