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

// Resolves once this thread has applied the publication `version`: the
// command that asks for it may come before the update that carries it.
const reached = (version) =>
  new Promise((resolve) => {
    if (kernel.version >= version) return void resolve();
    const onPublish = () => {
      if (kernel.version < version) return;
      kernel.off('publish', onPublish);
      resolve();
    };
    kernel.on('publish', onPublish);
  });

parentPort.on('message', async ({ cmd, round, version }) => {
  if (cmd !== 'render') return;
  await reached(version);
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
