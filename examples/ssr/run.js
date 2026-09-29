'use strict';

// ssr — template -> preparer -> render-function source -> fs.script.compile
// -> cached data -> executed in workers with vm.Script.
//
// A `.tmpl` file is plain text with `{{ dotted.path }}` placeholders. The
// `ssr` preparer below is the whole compiler — about a dozen lines — turning
// it once into the source of a self-contained render function; no template
// engine, no dependency. `fs.script.compile` builds V8 cached data from
// exactly that source. Each worker gets the bundle from
// `PlaceFs.script(key)` — `{ source, cachedData, scriptOptions, meta }` —
// builds its own `vm.Script` in its own (fresh) isolate and runs it.
//
// `templates` is a `sab + virtual` place: this script seeds it, has two
// workers render it, rewrites it, and has the same two workers render
// again — showing the new source and new cached data replacing the old,
// live, in already-running workers. A third write, with an invalid
// placeholder, shows the preparer rejecting the whole publication: the
// same workers render the same round-2 template once more, unchanged.
//
// Run:
//   node examples/ssr/run.js

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { VfsConfig, VfsKernel } = require('../..');

const APP_ROOT = __dirname;
const KEY = '/greeting.tmpl';
const TEMPLATE_A =
  'Hello, {{ user.name }}! You have {{ user.count }} new messages.';
const TEMPLATE_B =
  'Welcome back, {{ user.name }}! Your unread count is {{ user.count }}.';

// A placeholder is a dotted path of identifiers — nothing else is a valid
// property-access chain, so nothing else is accepted.
const PLACEHOLDER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

// The whole compiler: `{{ a.b }}` -> `esc(data?.a?.b)`, spliced between the
// literal chunks of text as a `+`-joined expression. Anything between `{{`
// and `}}` that is not a dotted identifier path is a compile error, not a
// best-effort guess at invalid JavaScript.
const compile = (text, key) => {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(/\{\{\s*(.*?)\s*\}\}/g)) {
    const path = match[1];
    if (!PLACEHOLDER.test(path)) {
      throw new Error(
        `ssr: ${key}: "{{ ${path} }}" is not a dotted identifier path ` +
          '(letters, digits, "_", "$", joined by single dots — e.g. "user.name")',
      );
    }
    parts.push(JSON.stringify(text.slice(last, match.index)));
    parts.push(`esc(data?.${path.split('.').join('?.')})`);
    last = match.index + match[0].length;
  }
  parts.push(JSON.stringify(text.slice(last)));
  return parts.join(' + ');
};

// The preparer: canonical content becomes the render function's source; the
// template's own key travels along in meta for consistency checks. A
// `compile` failure throws out of here too — the pipeline publishes
// nothing, and the previous version of the template stays current.
const ssr = (raw, file) => ({
  source: `(function (data) {
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESCAPES[c]);
  return ${compile(raw.toString('utf8'), file.key)};
})`,
  scriptOptions: { filename: file.path },
  meta: { template: file.key },
});

const config = new VfsConfig({
  defaults: {
    memory: { limit: '2 mib', segmentSize: '512 kib', maxFileSize: '128 kib' },
  },
  places: {
    templates: {
      origin: 'virtual',
      fs: {
        writable: true,
        ext: ['tmpl'],
        prepare: 'ssr',
        script: { ext: ['tmpl'], compile: true },
      },
    },
  },
});

const kernel = new VfsKernel(config, {
  appRoot: APP_ROOT,
  preparers: { ssr },
});

// Ask every worker to render `round`, and collect their replies. Listeners
// go on before any postMessage, so a fast reply can never be missed. The
// command carries the version this thread has published: the update and
// the command reach a worker on two channels, which keep no order between
// them, so the worker waits for that version before it renders.
const renderRound = (workers, round) => {
  const replies = Promise.all(
    workers.map(
      (worker) =>
        new Promise((resolve, reject) => {
          const onError = reject;
          const onMessage = (msg) => {
            if (msg.round !== round) return;
            worker.off('message', onMessage);
            worker.off('error', onError);
            resolve(msg);
          };
          worker.on('message', onMessage);
          worker.once('error', onError);
        }),
    ),
  );
  const { version } = kernel;
  for (const worker of workers) {
    worker.postMessage({ cmd: 'render', round, version });
  }
  return replies;
};

(async () => {
  await kernel.initialize();
  const templates = kernel.fs('templates');
  await templates.writeFile(KEY, TEMPLATE_A);

  const workers = [];
  for (let id = 1; id <= 2; id++) {
    const { vfs, transferList } = kernel.link();
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { vfs, id },
      transferList,
    });
    workers.push(worker);
  }

  const first = await renderRound(workers, 1);
  for (const msg of first) {
    const cache = msg.cachedDataRejected ? 'rejected' : 'accepted';
    console.log(
      `worker ${msg.worker} round 1: ${msg.html} (cached data ${cache})`,
    );
  }

  await templates.writeFile(KEY, TEMPLATE_B);

  const second = await renderRound(workers, 2);
  for (const msg of second) {
    const cache = msg.cachedDataRejected ? 'rejected' : 'accepted';
    console.log(
      `worker ${msg.worker} round 2: ${msg.html} (cached data ${cache})`,
    );
  }

  // A bad placeholder rejects the whole publication: no compile, no write.
  // The template already published (round 2's) stays current.
  let rejected = null;
  try {
    await templates.writeFile(KEY, 'Hi {{ 1.2 }} / {{ .a }}!');
  } catch (err) {
    rejected = err;
  }
  console.log(
    rejected
      ? `bad template rejected: ${rejected.message}`
      : 'bad template was NOT rejected (this would be a bug)',
  );

  const third = await renderRound(workers, 3);
  for (const msg of third) {
    const cache = msg.cachedDataRejected ? 'rejected' : 'accepted';
    console.log(
      `worker ${msg.worker} round 3: ${msg.html} (cached data ${cache})`,
    );
  }

  // One bundle, checked here for internal consistency too.
  const bundle = templates.script(KEY);
  console.log(
    `main thread bundle meta.template=${bundle.meta.template} ` +
      `scriptOptions.filename=${bundle.scriptOptions.filename} ` +
      `cachedData=${bundle.cachedData.length}b`,
  );

  await Promise.all(workers.map((worker) => worker.terminate()));
  kernel.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
