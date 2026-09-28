'use strict';

// A worker of ssr: renders `/greeting.tmpl` on command from the main
// thread, in its own (fresh) V8 isolate, from the bundle `PlaceFs.script()`
// hands it — this worker never prepares or compiles anything itself.

const vm = require('node:vm');
const { parentPort, workerData } = require('node:worker_threads');
const { attach } = require('../..');

const kernel = attach();
const templates = kernel.fs('templates');
const { id } = workerData;
const DATA = { user: { name: 'Ada', count: 3 } };

parentPort.on('message', ({ cmd, round }) => {
  if (cmd !== 'render') return;
  const { source, cachedData, scriptOptions, meta } =
    templates.script('/greeting.tmpl');
  const script = new vm.Script(source, { ...scriptOptions, cachedData });
  const render = script.runInThisContext();
  parentPort.postMessage({
    worker: id,
    round,
    html: render(DATA),
    cachedDataRejected: script.cachedDataRejected,
    template: meta.template,
  });
});
