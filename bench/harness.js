'use strict';

// Measurement primitives. Every figure is the median over `repeats` rounds,
// each after a warm-up; `spread` is the relative half-range of the rounds,
// the noise inside one run.
//   ops        ns/op of a synchronous call, rounds calibrated to ~targetMs
//   opsAsync   the same for an async call, awaited one at a time
//   throughput MiB/s of an async call that moves `bytes` per call
//   latency    p50 / p99 of individually timed calls (sync or async)

const now = () => process.hrtime.bigint();

const sorted = (values) => [...values].sort((a, b) => a - b);

const median = (values) => {
  const s = sorted(values);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// Nearest-rank percentile of an ascending array.
const percentile = (ascending, p) =>
  ascending[Math.max(0, Math.ceil(p * ascending.length) - 1)];

const spreadOf = (values) => {
  const mid = median(values);
  if (mid === 0) return 0;
  return (Math.max(...values) - Math.min(...values)) / 2 / mid;
};

// Anything a measured call returns lands here, so it is never dead code.
let sink = null;

const round3 = (x) => Math.round(x * 1000) / 1000;

class Bench {
  constructor({ repeats = 5, targetMs = 60 } = {}) {
    this.repeats = repeats;
    this.targetNs = targetMs * 1e6;
    this.metrics = {};
  }

  #record(id, unit, better, rounds, extra = {}) {
    this.metrics[id] = {
      unit,
      better,
      value: round3(median(rounds)),
      spread: round3(spreadOf(rounds)),
      rounds: rounds.map(round3),
      ...extra,
    };
    const { value, spread } = this.metrics[id];
    const noise = (spread * 100).toFixed(1);
    process.stderr.write(`  ${id}: ${value} ${unit} (±${noise}%)\n`);
  }

  value(id, unit, better, value) {
    this.metrics[id] = { unit, better, value: round3(value), spread: 0 };
    process.stderr.write(`  ${id}: ${round3(value)} ${unit}\n`);
  }

  // Rounds measured elsewhere (inside a worker), one figure per round.
  rounds(id, unit, better, rounds) {
    this.#record(id, unit, better, rounds);
  }

  // Iterations per round so that one round lasts about targetNs; doubles as
  // the warm-up.
  #calibrate(fn) {
    let n = 1;
    for (;;) {
      const t0 = now();
      for (let i = 0; i < n; i++) sink = fn(i);
      const dt = Number(now() - t0);
      if (dt >= this.targetNs / 4 || n >= 1e7) {
        return Math.max(1, Math.ceil((n * this.targetNs) / Math.max(dt, 1)));
      }
      n *= 4;
    }
  }

  ops(id, fn) {
    const n = this.#calibrate(fn);
    const rounds = [];
    for (let r = 0; r < this.repeats; r++) {
      const t0 = now();
      for (let i = 0; i < n; i++) sink = fn(i);
      rounds.push(Number(now() - t0) / n);
    }
    this.#record(id, 'ns/op', 'lower', rounds, { n });
  }

  async #calibrateAsync(fn) {
    let n = 1;
    for (;;) {
      const t0 = now();
      for (let i = 0; i < n; i++) sink = await fn(i);
      const dt = Number(now() - t0);
      if (dt >= this.targetNs / 4 || n >= 1e6) {
        return Math.max(1, Math.ceil((n * this.targetNs) / Math.max(dt, 1)));
      }
      n *= 4;
    }
  }

  async #roundsAsync(fn) {
    const n = await this.#calibrateAsync(fn);
    const rounds = [];
    for (let r = 0; r < this.repeats; r++) {
      const t0 = now();
      for (let i = 0; i < n; i++) sink = await fn(i);
      rounds.push(Number(now() - t0) / n);
    }
    return { n, rounds };
  }

  async opsAsync(id, fn) {
    const { n, rounds } = await this.#roundsAsync(fn);
    this.#record(id, 'ns/op', 'lower', rounds, { n });
  }

  async throughput(id, bytes, fn) {
    const { n, rounds } = await this.#roundsAsync(fn);
    const mibs = rounds.map((ns) => bytes / 2 ** 20 / (ns / 1e9));
    this.#record(id, 'MiB/s', 'higher', mibs, { n });
  }

  // `setup` (untimed) runs before every sample; `fn` is timed alone.
  async latency(id, fn, { warmup = 20, samples = 200, setup = null } = {}) {
    const one = async (i) => {
      const ctx = setup ? await setup(i) : undefined;
      const t0 = now();
      sink = await fn(i, ctx);
      return Number(now() - t0);
    };
    let i = 0;
    for (let w = 0; w < warmup; w++) await one(i++);
    const p50 = [];
    const p99 = [];
    for (let r = 0; r < this.repeats; r++) {
      const times = [];
      for (let s = 0; s < samples; s++) times.push(await one(i++));
      const ascending = sorted(times);
      p50.push(percentile(ascending, 0.5) / 1e3);
      p99.push(percentile(ascending, 0.99) / 1e3);
    }
    this.#record(`${id}.p50`, 'us', 'lower', p50, { samples });
    this.#record(`${id}.p99`, 'us', 'lower', p99, { samples });
  }
}

module.exports = { Bench, median, percentile, spreadOf, sink: () => sink };
