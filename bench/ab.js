'use strict';

const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { median } = require('./harness.js');

// A/B benchmark of two revisions, interleaved.
//
//   npm run bench:ab -- <base> <new> [--only read,patch] [--pairs 4]
//                       [--bench <rev>] [--label name] [--out dir] [--keep]
//                       [--repeats 5] [--target 60] [--timeout 900]
//                       [--filter text] [--md] [--verbose]
//   node bench/ab.js --report <dir> [--filter text] [--md]
//
// Both revisions are exported with `git archive` into sibling directories
// `a` and `b` of one temporary directory — where the code lies changes its
// timings (a worktree under the repository measured up to 45 % slower than
// the temp directory on one machine) — and get the production dependencies
// of this checkout's node_modules, so both run from the same place with the
// same dependencies. The revision `worktree` exports the working tree as it
// is (tracked and untracked files, nothing ignored). `--bench <rev>` runs
// that revision's bench/ against both, so new scenarios can measure an old
// base.
//
// Then `bench/run.js --only …` runs `pairs` times per side, the two sides
// alternating within a pair and the order flipping between pairs (A B, B A,
// A B, B A …), so a drift of the machine favours neither: with an even
// number of pairs each side goes first as often as the other. A run that
// exceeds `--timeout` seconds is killed and counts as failed; a failed run
// or a failed scenario makes the exit code 1. Every run's JSON is kept;
// the summary takes, per metric, the median of the base runs and of the
// new runs, the change (signed so that + is better) and the change in each
// pair. A change is significant when it exceeds max(5 %, 2 × spread), the
// spread being the relative range of the base runs: `+` / `−` mark a
// change every pair shows beyond that threshold; `~` one every pair shows
// in the same direction but not all beyond it (consistent, not
// significant); `?` one the medians show beyond it while the pairs
// disagree; `=` everything else.

const FLOOR = 0.05;
const ROOT = path.join(__dirname, '..');
const MAX_BUFFER = 1 << 30;
const DEFAULT_PAIRS = 4;
const DEFAULT_TIMEOUT = 900; // seconds per run

const VALUED = new Set([
  'only',
  'pairs',
  'bench',
  'label',
  'out',
  'repeats',
  'target',
  'timeout',
  'filter',
  'report',
]);
const FLAGS = new Set(['keep', 'md', 'verbose', 'help']);

const USAGE =
  'usage: bench/ab.js <base> <new> [--only a,b] [--pairs 4] [--bench <rev>]\n' +
  '                   [--label name] [--out dir] [--keep] [--repeats 5]\n' +
  '                   [--target 60] [--timeout 900] [--filter text] [--md]\n' +
  '                   [--verbose]\n' +
  '       bench/ab.js --report <dir> [--filter text] [--md]\n';

const parse = (argv) => {
  const options = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      options.positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (FLAGS.has(name)) options[name] = true;
    else if (VALUED.has(name)) options[name] = argv[++i];
    else throw new Error(`unknown option ${arg}\n${USAGE}`);
  }
  return options;
};

const positive = (name, value, fallback) => {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--${name} must be a positive integer, got ${value}`);
  }
  return n;
};

// --- Revisions ---

const git = (args) =>
  execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });

const gitBytes = (args) =>
  execFileSync('git', args, { cwd: ROOT, maxBuffer: MAX_BUFFER });

const WORKTREE = 'worktree';

const revisionOf = (rev) => {
  if (rev === WORKTREE) {
    const dirty = git(['status', '--porcelain']).trim() !== '';
    const sha = git(['rev-parse', '--short', 'HEAD']).trim();
    return { rev, sha: dirty ? `${sha}+dirty` : sha, subject: 'working tree' };
  }
  const sha = git(['rev-parse', '--short', '--verify', `${rev}^{commit}`]);
  const subject = git(['log', '-1', '--format=%s', rev]).trim();
  return { rev, sha: sha.trim(), subject };
};

// --- Export: git archive → directory, no tar binary needed ---

// A NUL-terminated string field of a tar header.
const field = (header, offset, length) => {
  let end = header.indexOf(0, offset);
  if (end === -1 || end > offset + length) end = offset + length;
  return header.toString('utf8', offset, end);
};

const octal = (header, offset, length) =>
  parseInt(field(header, offset, length).trim() || '0', 8);

// The `path` record of a pax extended header (`<length> path=<value>\n`).
const paxPath = (body) => {
  let at = 0;
  let result = null;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    const length = Number(body.toString('utf8', at, space));
    const record = body.toString('utf8', space + 1, at + length - 1);
    const eq = record.indexOf('=');
    if (record.slice(0, eq) === 'path') result = record.slice(eq + 1);
    at += length;
  }
  return result;
};

// The place of an archive entry under `dest`; never outside it, whatever
// the separators of its name.
const targetOf = (dest, name) => {
  const segments = name.split(/[\\/]/).filter((s) => s !== '' && s !== '.');
  const target = path.join(dest, ...segments);
  const rel = path.relative(dest, target);
  if (
    segments.includes('..') ||
    rel === '' ||
    rel.startsWith('..') ||
    path.isAbsolute(rel)
  ) {
    throw new Error(`refusing to extract ${name}`);
  }
  return target;
};

const TYPE_FILE = 0x30; // '0'
const TYPE_DIR = 0x35; // '5'
const TYPE_PAX_GLOBAL = 0x67; // 'g'
const TYPE_PAX_NEXT = 0x78; // 'x'

// Extracts the ustar / pax stream `git archive --format=tar` writes.
const untar = (tar, dest) => {
  let at = 0;
  let longName = null;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header[0] === 0) break; // the end-of-archive zero blocks
    const size = octal(header, 124, 12);
    const type = header[156];
    const body = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === TYPE_PAX_NEXT) {
      longName = paxPath(body);
      continue;
    }
    if (type === TYPE_PAX_GLOBAL) continue;
    let name = longName;
    if (name === null) {
      name = field(header, 0, 100);
      const prefix = field(header, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    longName = null;
    const target = targetOf(dest, name);
    if (type === TYPE_DIR) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    if (type !== TYPE_FILE && type !== 0) {
      const kind = String.fromCharCode(type);
      process.stderr.write(`  skipped ${name} (tar entry type ${kind})\n`);
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body, { mode: octal(header, 100, 8) & 0o777 });
  }
};

// The working tree as it is: tracked and untracked files, nothing ignored;
// nested repositories (listed as `dir/`) stay out.
const copyWorktree = (dest, pathspec) => {
  const args = ['ls-files', '-z', '-co', '--exclude-standard'];
  if (pathspec) args.push('--', pathspec);
  const list = git(args).split('\0').filter(Boolean);
  for (const rel of list) {
    if (rel.endsWith('/')) continue;
    const src = path.join(ROOT, rel);
    if (!existsSync(src)) continue; // deleted in the working tree
    const dst = path.join(dest, rel);
    mkdirSync(path.dirname(dst), { recursive: true });
    cpSync(src, dst);
  }
};

// `revision` (or its `pathspec` subtree) into `dest`.
const exportTree = (revision, dest, pathspec = null) => {
  mkdirSync(dest, { recursive: true });
  if (revision.rev === WORKTREE) return void copyWorktree(dest, pathspec);
  const args = ['archive', '--format=tar', revision.rev];
  if (pathspec) args.push(pathspec);
  untar(gitBytes(args), dest);
};

// The production dependencies of the exported package.json, and theirs,
// copied from this checkout's node_modules: both sides get the same ones.
const copyDependencies = (dest) => {
  const pkg = JSON.parse(readFileSync(path.join(dest, 'package.json'), 'utf8'));
  const queue = Object.keys(pkg.dependencies || {});
  const seen = new Set();
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const src = path.join(ROOT, 'node_modules', name);
    const manifest = path.join(src, 'package.json');
    if (!existsSync(manifest)) {
      throw new Error(`dependency ${name} is not installed — run npm ci first`);
    }
    cpSync(src, path.join(dest, 'node_modules', name), { recursive: true });
    const sub = JSON.parse(readFileSync(manifest, 'utf8'));
    queue.push(...Object.keys(sub.dependencies || {}));
  }
};

// --- Runs ---

// One `bench/run.js` of `dir`; a run over the timeout is killed. Returns
// what happened: ok, or the failure (a timeout, a signal, an exit code).
const runBench = (dir, out, options) => {
  const args = [
    path.join(dir, 'bench', 'run.js'),
    '--out',
    out,
    '--repeats',
    String(options.repeats),
    '--target',
    String(options.target),
  ];
  if (options.only) args.push('--only', options.only);
  const t0 = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: options.verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_BUFFER,
    timeout: options.timeout * 1000,
    killSignal: 'SIGKILL',
  });
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  let failure = null;
  if (result.error?.code === 'ETIMEDOUT') {
    failure = `timed out after ${options.timeout} s`;
  } else if (result.error) failure = String(result.error);
  else if (result.signal) failure = `killed by ${result.signal}`;
  else if (result.status !== 0) failure = `exit code ${result.status}`;
  if (failure && !options.verbose && result.stderr) {
    const tail = result.stderr.split('\n').slice(-12);
    process.stderr.write(`${tail.join('\n')}\n`);
  }
  return { seconds, ok: failure === null, failure, signal: result.signal };
};

const load = (file) => JSON.parse(readFileSync(file, 'utf8'));

// --- Summary ---

const metricsOf = (run) => {
  const all = new Map();
  for (const [scenario, result] of Object.entries(run.scenarios || {})) {
    for (const [id, metric] of Object.entries(result.metrics || {})) {
      all.set(id, { scenario, ...metric });
    }
  }
  return all;
};

// Relative change from `from` to `to`; a zero figure that stays zero is no
// change, one that leaves zero a full one.
const relative = (from, to) => {
  if (from !== 0) return (to - from) / from;
  return to === 0 ? 0 : Math.sign(to);
};

// The verdict on the changes of one metric in every pair (`perPair`,
// signed so that + is better) and on the change of the medians.
const markOf = (perPair, delta, threshold) => {
  if (perPair.every((d) => d > threshold)) return '+';
  if (perPair.every((d) => d < -threshold)) return '−';
  if (perPair.every((d) => d > 0) || perPair.every((d) => d < 0)) return '~';
  if (Math.abs(delta) > threshold) return '?';
  return '=';
};

// One row per metric of the base runs: medians of both sides, the change in
// each pair where both sides have the figure, and the verdict.
const summarize = (pairs, filter) => {
  const sides = pairs
    .filter((pair) => pair.a && pair.b)
    .map((pair) => ({ a: metricsOf(pair.a), b: metricsOf(pair.b) }));
  const ids = new Set();
  for (const { a } of sides) for (const id of a.keys()) ids.add(id);
  const rows = [];
  for (const id of ids) {
    if (filter && !id.includes(filter)) continue;
    const both = sides.filter(({ a, b }) => a.has(id) && b.has(id));
    if (both.length === 0) continue;
    const first = both[0].a.get(id);
    const sign = first.better === 'higher' ? 1 : -1;
    const base = both.map(({ a }) => a.get(id).value);
    const next = both.map(({ b }) => b.get(id).value);
    const mb = median(base);
    const mn = median(next);
    const perPair = base.map((from, i) => sign * relative(from, next[i]));
    const range = Math.max(...base) - Math.min(...base);
    const spread = mb === 0 ? 0 : range / Math.abs(mb);
    const threshold = Math.max(FLOOR, 2 * spread);
    const delta = sign * relative(mb, mn);
    rows.push({
      id,
      scenario: first.scenario,
      unit: first.unit,
      base: mb,
      new: mn,
      delta,
      perPair,
      spread,
      threshold,
      mark: markOf(perPair, delta, threshold),
      pairs: both.length,
    });
  }
  return rows;
};

const fmt = (x) => {
  const a = Math.abs(x);
  if (a >= 1000) return x.toFixed(0);
  if (a >= 100) return x.toFixed(1);
  if (a >= 10) return x.toFixed(2);
  return x.toFixed(3);
};

const pct = (x) => `${x > 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

const HEAD = [
  'metric',
  'unit',
  'base',
  'new',
  'Δ (+ better)',
  'pairs %',
  'thr',
  '',
];

const cellsOf = (row) => [
  row.id,
  row.unit,
  fmt(row.base),
  fmt(row.new),
  pct(row.delta),
  row.perPair.map((d) => (d * 100).toFixed(0)).join(' '),
  `${(row.threshold * 100).toFixed(0)}%`,
  row.mark,
];

const table = (rows, md) => {
  const lines = rows.map(cellsOf);
  if (md) {
    const row = (cells) => `| ${cells.join(' | ')} |\n`;
    return row(HEAD) + row(HEAD.map(() => '---')) + lines.map(row).join('');
  }
  const widths = HEAD.map((h, i) =>
    Math.max(h.length, ...lines.map((l) => l[i].length)),
  );
  const row = (cells) =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd() + '\n';
  return row(HEAD) + lines.map(row).join('');
};

const describe = (meta) => {
  const side = (s) => `${s.sha} ${s.subject} (${s.rev})`;
  const lines = [
    `base: ${side(meta.base)}`,
    `new:  ${side(meta.new)}`,
    `${meta.node} ${meta.os} ${meta.cpu} (${meta.cores} cores)`,
    `pairs: ${meta.pairs}, scenarios: ${meta.only || 'all'}` +
      (meta.bench ? `, bench/ of ${meta.bench.sha}` : ''),
  ];
  return lines.join('\n') + '\n';
};

const LEGEND =
  '+ / − significant: beyond max(5 %, 2 × base spread) in every pair; ' +
  '~ same direction in every pair, not significant; ? medians beyond the ' +
  'threshold, pairs disagree; = no change\n';

const verdict = (rows) => {
  const of = (mark) => rows.filter((r) => r.mark === mark).map((r) => r.id);
  const better = of('+');
  const worse = of('−');
  let text = `\nsignificant: ${better.length} better, ${worse.length} worse`;
  if (worse.length > 0) text += `\nworse: ${worse.join(', ')}`;
  const same = of('~');
  if (same.length > 0) {
    text += `\nsame direction, not significant (~): ${same.join(', ')}`;
  }
  const unclear = of('?');
  if (unclear.length > 0) text += `\nmedians only (?): ${unclear.join(', ')}`;
  return `${text}\n\n${LEGEND}`;
};

// Prints the summary; a failed run or scenario makes the exit code 1.
const report = (meta, pairs, options) => {
  const rows = summarize(pairs, options.filter || null);
  const failed = [];
  for (const [i, pair] of pairs.entries()) {
    for (const side of ['a', 'b']) {
      const run = pair[side];
      if (!run) failed.push(`pair ${i + 1} ${side}: no result`);
      for (const [name, s] of Object.entries(run?.scenarios || {})) {
        if (s.error) failed.push(`pair ${i + 1} ${side} ${name}: ${s.error}`);
      }
    }
  }
  process.stdout.write(
    describe(meta) +
      '\n' +
      table(rows, options.md) +
      verdict(rows) +
      (failed.length > 0 ? `\nfailures:\n  ${failed.join('\n  ')}\n` : ''),
  );
  if (failed.length > 0) process.exitCode = 1;
  return rows;
};

// --- Main ---

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

const machine = () => {
  const cpus = os.cpus();
  return {
    node: process.version,
    platform: process.platform,
    os: `${os.type()} ${os.release()}`,
    cpu: cpus[0]?.model.trim() ?? 'unknown',
    cores: cpus.length,
  };
};

const fileOf = (dir, side, pair) => path.join(dir, `${side}-${pair}.json`);

const loadPairs = (dir, count) => {
  const pairs = [];
  for (let i = 1; i <= count; i++) {
    const side = (name) => {
      const file = fileOf(dir, name, i);
      return existsSync(file) ? load(file) : null;
    };
    pairs.push({ a: side('a'), b: side('b') });
  }
  return pairs;
};

// The results of an earlier run in the same directory would count as this
// one's where a run of this one fails: gone before it starts.
const clearResults = (dir) => {
  const stale = readdirSync(dir).filter((name) =>
    /^([ab]-\d+\.json|summary\.(json|md))$/.test(name),
  );
  for (const name of stale) rmSync(path.join(dir, name));
  if (stale.length > 0) {
    process.stderr.write(`note: ${stale.length} earlier result(s) removed\n`);
  }
};

// The console gets the table as asked (`--md` or plain); summary.md always
// the markdown one, summary.json the rows and the run list.
const save = (dir, meta, runs, pairs, options) => {
  const rows = report(meta, pairs, options);
  writeFileSync(
    path.join(dir, 'summary.json'),
    JSON.stringify({ meta, runs, rows }, null, 2) + '\n',
  );
  writeFileSync(
    path.join(dir, 'summary.md'),
    describe(meta) + '\n' + table(rows, true) + verdict(rows),
  );
  process.stdout.write(`\n${dir}\n`);
};

const reportSaved = (options) => {
  const dir = path.resolve(options.report);
  const summary = load(path.join(dir, 'summary.json'));
  const pairs = loadPairs(dir, summary.meta.pairs);
  report(summary.meta, pairs, options);
};

const main = (argv) => {
  const options = parse(argv);
  if (options.help) return void process.stdout.write(USAGE);
  if (options.report) return void reportSaved(options);
  if (options.positional.length !== 2) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const pairs = positive('pairs', options.pairs, DEFAULT_PAIRS);
  if (pairs < 3) {
    process.stderr.write(
      `warning: ${pairs} pair(s) — the threshold cannot see the noise; ` +
        'take 3 or more\n',
    );
  } else if (pairs % 2 === 1) {
    process.stderr.write(
      'note: an odd number of pairs runs one side first once more than the ' +
        'other\n',
    );
  }
  const settings = {
    only: options.only || null,
    repeats: positive('repeats', options.repeats, 5),
    target: positive('target', options.target, 60),
    timeout: positive('timeout', options.timeout, DEFAULT_TIMEOUT),
    verbose: Boolean(options.verbose),
  };
  const base = revisionOf(options.positional[0]);
  const next = revisionOf(options.positional[1]);
  const bench = options.bench ? revisionOf(options.bench) : null;
  const label = options.label || `${base.sha}-${next.sha}`;
  const out = options.out
    ? path.resolve(options.out)
    : path.join(ROOT, '.work', 'bench', 'ab', `${label}-${stamp()}`);
  mkdirSync(out, { recursive: true });
  clearResults(out);

  const temp = mkdtempSync(path.join(os.tmpdir(), 'xvfs-ab-'));
  const cleanup = () => {
    if (options.keep) process.stderr.write(`kept ${temp}\n`);
    else rmSync(temp, { recursive: true, force: true });
  };
  // Ctrl+C reaches the running bench too; once it is gone, so is the
  // export.
  const onInterrupt = () => {
    process.stderr.write('\ninterrupted\n');
    cleanup();
    process.exit(130);
  };
  process.once('SIGINT', onInterrupt);
  const dirs = { a: path.join(temp, 'a'), b: path.join(temp, 'b') };
  const revisions = { a: base, b: next };
  try {
    for (const side of ['a', 'b']) {
      const revision = revisions[side];
      process.stderr.write(`export ${side}: ${revision.sha} → ${dirs[side]}\n`);
      exportTree(revision, dirs[side]);
      if (bench) {
        rmSync(path.join(dirs[side], 'bench'), {
          recursive: true,
          force: true,
        });
        exportTree(bench, dirs[side], 'bench');
      }
      copyDependencies(dirs[side]);
    }
    if (!bench && base.rev !== WORKTREE && next.rev !== WORKTREE) {
      const diff = spawnSync(
        'git',
        ['diff', '--quiet', base.rev, next.rev, '--', 'bench'],
        { cwd: ROOT },
      );
      if (diff.status === 1) {
        process.stderr.write(
          'note: bench/ differs between the revisions; --bench <rev> runs ' +
            'one bench/ against both\n',
        );
      }
    }
    const meta = {
      ...machine(),
      date: new Date().toISOString(),
      base,
      new: next,
      bench,
      pairs,
      only: settings.only,
      repeats: settings.repeats,
      target: settings.target,
      timeout: settings.timeout,
    };
    const runs = [];
    for (let i = 1; i <= pairs; i++) {
      // A B, B A, A B, B A …: a drift of the machine favours neither side.
      const order = i % 2 === 1 ? ['a', 'b'] : ['b', 'a'];
      for (const side of order) {
        const file = fileOf(out, side, i);
        process.stderr.write(
          `pair ${i}/${pairs} ${side} ${revisions[side].sha}`,
        );
        const run = runBench(dirs[side], file, settings);
        const { seconds, ok, failure, signal } = run;
        const status = ok ? '' : ` FAILED (${failure})`;
        process.stderr.write(`: ${seconds} s${status}\n`);
        runs.push({ pair: i, side, file: path.basename(file), seconds, ok });
        if (signal === 'SIGINT') onInterrupt();
      }
    }
    save(out, meta, runs, loadPairs(out, pairs), options);
  } finally {
    process.off('SIGINT', onInterrupt);
    cleanup();
  }
};

try {
  main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
}
