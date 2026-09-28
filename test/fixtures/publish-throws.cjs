'use strict';

// Run by test/events.test.js in a plain node process: a 'publish'
// listener that throws. Its error is uncaught, as from any emitter; the
// commit is done before the listener runs, and the write that published
// resolves. argv: the mode, then the directory to use as appRoot.
//   crash    no handler: the process dies of the listener's error
//   handled  an 'uncaughtException' handler reports it, the write goes on
// Prints one JSON line per report.

const { VfsConfig, VfsKernel } = require('../../index.js');

const [mode, appRoot] = process.argv.slice(2);
const report = (what) => process.stdout.write(JSON.stringify(what) + '\n');

const main = async () => {
  const config = new VfsConfig({
    places: { v: { origin: 'virtual', fs: { writable: true } } },
  });
  const kernel = new VfsKernel(config, { appRoot });
  await kernel.initialize();
  const files = kernel.fs('v');
  kernel.on('publish', (event) => {
    report({ listener: event.version, read: files.readFile('/a.txt', 'utf8') });
    throw new Error('listener failed');
  });
  if (mode === 'handled') {
    process.on('uncaughtException', (err) => report({ uncaught: err.message }));
  }
  const write = await files.writeFile('/a.txt', 'a').then(
    () => 'resolved',
    (err) => err.message,
  );
  report({ write, version: kernel.version });
  kernel.close();
};

main();
