'use strict';

const { readFileSync } = require('node:fs');

// node bench/compare.js base.json new.json [--noise base2.json] [--md]
//
// Δ is the change from base to new, signed so that + is better. The noise
// of a figure is the relative difference between two baseline runs
// (--noise, the second one), or else the larger spread of the rounds inside
// base and new. A change is significant when |Δ| > max(5 %, 2 × noise):
// marked `+` (better) or `−` (worse), `=` otherwise.

const FLOOR = 0.05;

const load = (file) => JSON.parse(readFileSync(file, 'utf8'));

const metricsOf = (run) => {
  const all = new Map();
  for (const [scenario, { metrics }] of Object.entries(run.scenarios)) {
    for (const [id, metric] of Object.entries(metrics)) {
      all.set(id, { scenario, ...metric });
    }
  }
  return all;
};

const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

// Relative change from `from` to `to`; a zero figure that stays zero is no
// change, one that leaves zero a full one.
const relative = (from, to) => {
  if (from !== 0) return (to - from) / from;
  return to === 0 ? 0 : Math.sign(to);
};

const compare = (base, next, second) => {
  const a = metricsOf(base);
  const b = metricsOf(next);
  const c = second ? metricsOf(second) : null;
  const rows = [];
  for (const [id, m] of a) {
    const n = b.get(id);
    if (!n) continue;
    const change = relative(m.value, n.value);
    const delta = m.better === 'higher' ? change : -change;
    const other = c?.get(id);
    const noise = other
      ? Math.abs(relative(m.value, other.value))
      : Math.max(m.spread || 0, n.spread || 0);
    const threshold = Math.max(FLOOR, 2 * noise);
    let mark = '=';
    if (Math.abs(delta) > threshold) mark = delta > 0 ? '+' : '−';
    rows.push({
      id,
      unit: m.unit,
      base: m.value,
      next: n.value,
      delta,
      noise,
      threshold,
      mark,
    });
  }
  return rows;
};

const main = (argv) => {
  const files = argv.filter(
    (arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--noise',
  );
  const at = argv.indexOf('--noise');
  const second = at === -1 ? null : load(argv[at + 1]);
  if (files.length !== 2) {
    process.stderr.write(
      'usage: compare.js base.json new.json [--noise base2.json] [--md]\n',
    );
    process.exitCode = 2;
    return;
  }
  const [base, next] = files.map(load);
  const rows = compare(base, next, second);
  const md = argv.includes('--md');
  const head = ['metric', 'unit', 'base', 'new', 'Δ (+ better)', 'noise', ''];
  const lines = rows.map((r) => [
    r.id,
    r.unit,
    String(r.base),
    String(r.next),
    pct(r.delta),
    `${(r.noise * 100).toFixed(1)}%`,
    r.mark,
  ]);
  const describe = (run) =>
    `${run.meta.node} ${run.meta.os} ${run.meta.commit ?? ''}`;
  process.stdout.write(`base: ${describe(base)}\nnew:  ${describe(next)}\n\n`);
  if (md) {
    const row = (cells) => `| ${cells.join(' | ')} |\n`;
    process.stdout.write(row(head) + row(head.map(() => '---')));
    for (const cells of lines) process.stdout.write(row(cells));
  } else {
    const widths = head.map((h, i) =>
      Math.max(h.length, ...lines.map((l) => l[i].length)),
    );
    const row = (cells) =>
      cells
        .map((c, i) => c.padEnd(widths[i]))
        .join('  ')
        .trimEnd() + '\n';
    process.stdout.write(row(head));
    for (const cells of lines) process.stdout.write(row(cells));
  }
  const worse = rows.filter((r) => r.mark === '−').map((r) => r.id);
  const better = rows.filter((r) => r.mark === '+').map((r) => r.id);
  process.stdout.write(
    `\nsignificant: ${better.length} better, ${worse.length} worse\n`,
  );
  if (worse.length > 0) process.stdout.write(`worse: ${worse.join(', ')}\n`);
};

main(process.argv.slice(2));
