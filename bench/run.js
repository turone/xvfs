'use strict';

const os = require('node:os');
const path = require('node:path');
const { fork, execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');

// Benchmarks of the hot paths. Not part of `npm test` or CI.
//
//   npm run bench [-- --only read,patch] [--repeats 5] [--target 60]
//                    [--out file.json]
//   node bench/compare.js base.json new.json [--noise base2.json] [--md]
//
// Every scenario runs as one function in its own process (`--expose-gc`);
// results go to `.work/bench/<platform>-<node>-<time>.json` unless `--out`
// names a file. A figure is the median of `repeats` rounds after a warm-up.

const SCENARIOS = [
  'read',
  'stream',
  'patch',
  'router',
  'publish',
  'ack',
  'watch',
  'compact',
  'require',
  'init',
];

const ROOT = path.join(__dirname, '..');

const argOf = (argv, name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};

const commitOf = () => {
  try {
    const run = (args) =>
      execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
    const dirty = run(['status', '--porcelain', '--', 'lib', 'bench']) !== '';
    return run(['rev-parse', '--short', 'HEAD']) + (dirty ? '+dirty' : '');
  } catch {
    return null;
  }
};

const meta = (options) => {
  const cpus = os.cpus();
  return {
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    os: `${os.type()} ${os.release()}`,
    arch: process.arch,
    cpu: cpus[0]?.model.trim() ?? 'unknown',
    cores: cpus.length,
    memoryGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    commit: commitOf(),
    date: new Date().toISOString(),
    ...options,
  };
};

const child = async (name, options) => {
  const { Bench } = require('./harness.js');
  const b = new Bench(options);
  try {
    await require(`./scenarios/${name}.js`)(b);
    return { metrics: b.metrics };
  } catch (err) {
    return { metrics: b.metrics, error: err.stack || String(err) };
  }
};

const inProcess = (name, options) =>
  new Promise((resolve) => {
    const args = ['--child', name, '--options', JSON.stringify(options)];
    const proc = fork(__filename, args, { execArgv: ['--expose-gc'] });
    let result = null;
    proc.on('message', (msg) => {
      result = msg;
    });
    proc.on('exit', (code) => {
      resolve(result || { metrics: {}, error: `exit code ${code}` });
    });
  });

const main = async (argv) => {
  const only = argOf(argv, 'only', null);
  const names = only ? only.split(',').map((s) => s.trim()) : SCENARIOS;
  for (const name of names) {
    if (!SCENARIOS.includes(name)) throw new Error(`unknown scenario ${name}`);
  }
  const options = {
    repeats: Number(argOf(argv, 'repeats', 5)),
    targetMs: Number(argOf(argv, 'target', 60)),
  };
  const result = { meta: meta(options), scenarios: {} };
  let failed = false;
  for (const name of names) {
    process.stderr.write(`${name}\n`);
    const t0 = Date.now();
    const { metrics, error } = await inProcess(name, options);
    result.scenarios[name] = { metrics, seconds: (Date.now() - t0) / 1e3 };
    if (error) {
      failed = true;
      result.scenarios[name].error = error;
      process.stderr.write(`  FAILED: ${error}\n`);
    }
  }
  const stamp = result.meta.date.replace(/[:.]/g, '-');
  const node = process.version.slice(1);
  const out =
    argOf(argv, 'out', null) ||
    path.join(
      ROOT,
      '.work',
      'bench',
      `${process.platform}-${node}-${stamp}.json`,
    );
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  process.stderr.write(`\n${out}\n`);
  if (failed) process.exitCode = 1;
};

const at = process.argv.indexOf('--child');
if (at === -1) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err.stack}\n`);
    process.exitCode = 1;
  });
} else {
  const options = JSON.parse(argOf(process.argv, 'options', '{}'));
  child(process.argv[at + 1], options).then((result) => {
    process.send(result, () => process.exit(0));
  });
}
