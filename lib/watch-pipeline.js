'use strict';

const path = require('node:path');
const { fileExt } = require('metautil');
// The disk past fs-patch (disk.js).
const {
  promises: { stat, lstat, realpath },
} = require('./disk.js');
const { SerialQueue } = require('./serial-queue.js');
const { pool, IO_LIMIT } = require('./pool.js');
const { DirWatcher } = require('./watcher.js');
const { scan } = require('./scanner.js');

// The renamed paths of an epoch made by hand (tests, benchmarks): none.
const NO_PATHS = new Set();

// WatchPipeline — live updates of a main kernel's disk-origin places.
// DirWatcher batches raw fs.watch events into epochs; each becomes one
// epoch of the kernel — changed files published, deleted files and
// directories removed, new directories rescanned and made — committed as
// one vfs-update. Epochs and rechecks run strictly one at a time, in
// arrival order.
//
// It reaches the kernel two ways, each at the time of a call and never at
// construction: the kernel's public state (ready, state, config, console,
// registry) and `open(refused)`, the one capability it is granted — a new
// epoch { publish(place, key, file), directory(place, key), remove(place,
// key), flush() }, bound to an epoch of the kernel's own, which flush()
// commits; `refused(place, key)` hears of a key the place's tree refused
// in it. Each path an event names is told to the kernel's index of links
// too (noteLinks), once its job is done.

// On a disk that takes a name in any case a stat answers for every
// spelling of it: whether the disk spells the last name of `filePath`
// as the key does. Spelled otherwise in its case alone — a rename that
// changed only the case — the key is gone, and the event of the new
// spelling publishes it. What the disk cannot tell (a race with a
// removal) is left to the stat. Asked only of a name fs.watch reported
// in a rename (`renamed`): a change names a file as the disk spells it,
// and the call costs a handle of the disk (~12 µs on Windows).
const spelledSo = async (place, filePath, renamed) => {
  if (!renamed || !place.caseless) return true;
  const real = await realpath(filePath).catch(() => null);
  if (real === null) return true;
  const name = path.basename(filePath);
  const own = path.basename(real);
  return own === name || own.toLowerCase() !== name.toLowerCase();
};

class WatchPipeline {
  watcher = null; // DirWatcher, once started
  // Watcher epochs and rechecks, strictly one at a time.
  queue = new SerialQueue();
  rechecks = new Map(); // absPath → Timeout
  #kernel;
  #open;

  constructor(kernel, open) {
    this.#kernel = kernel;
    this.#open = open;
  }

  // The places it watches: those the kernel fills from their directory.
  #watched() {
    return this.#kernel.registry.all().filter((place) => place.scanned);
  }

  // Watch every disk-origin place, once.
  start() {
    const kernel = this.#kernel;
    const places = this.#watched();
    if (this.watcher || places.length === 0) return;
    this.watcher = new DirWatcher({
      timeout: kernel.config.global.watchTimeout,
    });
    this.watcher.on('error', (err) =>
      kernel.console.error(`[vfs] watcher: ${err.message}`),
    );
    this.watcher.on('epoch', (events, renamed) => {
      this.#serial('epoch', () => this.#handle(events, renamed));
    });
    for (const place of places) this.watcher.watch(place.root);
  }

  // Stops watching and every pending recheck. The queue stays: a task
  // still in it finds the kernel closed and does nothing.
  close() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.rechecks.values()) clearTimeout(timer);
    this.rechecks.clear();
  }

  // Epochs and rechecks run strictly one after another, in arrival order:
  // an older epoch can never publish over a newer one. A task that finds the
  // kernel closed does nothing; a failing one is logged and does not hold up
  // the next. Deliberately separate from the mutation queue of virtual
  // places, which never share a key with a watched place.
  #serial(what, task) {
    const kernel = this.#kernel;
    this.queue
      .run(() => (kernel.ready ? task() : undefined))
      .catch((err) => {
        if (kernel.ready) kernel.console.error(`[vfs] ${what}: ${err.message}`);
      });
  }

  // An epoch of the pipeline: the kernel's epoch, and the keys its jobs
  // reached (#publish). With `retry`, a key its place's tree refuses is
  // rechecked once; a recheck's epoch retries nothing.
  #begin(retry) {
    const refused = retry
      ? (place, key) => this.#scheduleRecheck(place, key, place.pathOf(key))
      : null;
    const epoch = this.#open(refused);
    epoch.seen = new Set();
    return epoch;
  }

  // The jobs of an epoch run IO_LIMIT at a time (pool.js), each on its own:
  // one that fails is logged and stops none of the others. A job the pool
  // reaches after close() does not start; one in flight at close() stops at
  // its next step (#remove, #refresh, #rescan, the publication): the disk
  // call it waits for finishes — a read of a file, to its end — no other
  // starts, no preparer runs, and nothing is logged.
  async #handle(events, renamed = NO_PATHS) {
    const kernel = this.#kernel;
    const epoch = this.#begin(true);
    const jobs = [];
    for (const [filePath, event] of events) {
      const route = kernel.registry.route(filePath);
      if (!route?.place?.scanned) continue;
      const { place, key } = route;
      const spell = renamed.has(filePath);
      jobs.push({ place, key, filePath, event, spell });
    }
    await pool(jobs, IO_LIMIT, async (job) => {
      const { place, key, filePath, event, spell } = job;
      if (!kernel.ready) return;
      try {
        let links = null; // what a rescan met (#rescan)
        if (event === 'delete') {
          links = await this.#remove(epoch, place, key, filePath, true, spell);
        } else if (event === 'scan') {
          links = await this.#scanned(epoch, place, key, filePath, spell);
        } else await this.#refresh(epoch, place, key, filePath, true, spell);
        if (kernel.ready) await kernel.noteLinks(place, filePath, links);
      } catch (err) {
        kernel.console.error(`[vfs] update: ${err.message}`);
      }
    });
    epoch.flush();
  }

  // A delete event can describe a path that exists again: delete and re-create
  // inside one debounce window are two stats racing on the threadpool, and the
  // ENOENT one may land last. Re-check before unpublishing a live path. What
  // a rescan met, as #rescan returns it. `spell`: the name came in a rename
  // (spelledSo).
  async #remove(epoch, place, key, filePath, retry, spell = false) {
    const stats = await stat(filePath).catch(() => null);
    if (!this.#kernel.ready) return null;
    const so = stats ? await spelledSo(place, filePath, spell) : false;
    if (!this.#kernel.ready) return null;
    if (!stats || !so) {
      this.#unpublish(epoch, place, key, filePath);
      return null;
    }
    if (stats.isDirectory()) return this.#rescan(epoch, place, filePath, retry);
    await this.#refresh(epoch, place, key, filePath, retry);
    return null;
  }

  // A directory an event names: rescanned — unless the disk spells it
  // otherwise in its case alone (spelledSo), a rename that changed only
  // the case: its key is gone, and the event of the new spelling rescans
  // that one.
  async #scanned(epoch, place, key, filePath, spell) {
    const so = await spelledSo(place, filePath, spell);
    if (!this.#kernel.ready) return null;
    if (so) return this.#rescan(epoch, place, filePath);
    this.#unpublish(epoch, place, key, filePath);
    return null;
  }

  // A directory that appeared (move-in, unzip, mkdir -p): it and every
  // directory below it, and the files below it the place does not hold
  // yet, published one at a time: the rescan is already one job of its
  // epoch. Its scan stops at close(); a publication after it refuses at its
  // next step (publication.js, alive()). Returns the links the scan met,
  // for a place with `links: 'deny'` (kernel.noteLinks), else null.
  async #rescan(epoch, place, dirPath, retry = true) {
    const kernel = this.#kernel;
    const links = place.config.links === 'deny' ? [] : null;
    const dirs = [];
    const files = await scan(place.root, {
      ext: place.config.scanExt,
      startPath: dirPath,
      followSymlinks: !kernel.config.global.strict,
      stopped: () => !kernel.ready,
      links,
      dirs,
    });
    if (!kernel.ready) return links;
    for (const key of dirs) epoch.directory(place, key);
    for (const [key, file] of files) {
      if (place.file(key) === null) {
        await this.#publish(epoch, place, key, file, retry);
      }
    }
    return links;
  }

  // A file as the scan takes it: under strict, where the scan follows no
  // link, the path's own stats — a link there is no source, and its key
  // goes as if the file were gone. A file of an extension the place does
  // not cache is none of its business — but where it took the name of a
  // directory the place holds, that directory goes. `spell`: the name came
  // in a rename (spelledSo).
  async #refresh(epoch, place, key, filePath, retry, spell = false) {
    const { scanExt } = place.config;
    const cached = !scanExt || scanExt.includes(fileExt(key));
    if (!cached && !place.isDirectory(key)) return;
    const look = this.#kernel.config.global.strict ? lstat : stat;
    let stats = await look(filePath).catch(() => null);
    if (stats?.isSymbolicLink()) stats = null;
    if (!this.#kernel.ready) return;
    if (stats && !(await spelledSo(place, filePath, spell))) stats = null;
    if (!this.#kernel.ready) return;
    if (!stats) {
      this.#unpublish(epoch, place, key, filePath);
      return;
    }
    if (!stats.isFile()) return;
    if (!cached) {
      this.#unpublish(epoch, place, key, filePath);
      return;
    }
    const { size, mtimeMs, birthtimeMs } = stats;
    const file = { path: filePath, stat: { size, mtimeMs }, birthtimeMs };
    await this.#publish(epoch, place, key, file, retry);
  }

  // A watched source that cannot be read consistently, that its preparer
  // rejects, that fs.script cannot compile or whose canonical form does not
  // fit in SAB keeps its previous version; one deferred recheck follows,
  // then only a real event retries. A directory rescan and a file event may
  // both reach a key: first wins.
  async #publish(epoch, place, key, file, retry) {
    const seen = `${place.name}\0${key}`;
    if (epoch.seen.has(seen)) return;
    epoch.seen.add(seen);
    try {
      await epoch.publish(place, key, file);
    } catch (err) {
      const kernel = this.#kernel;
      if (kernel.state === 'closed') return;
      kernel.console.warn(
        `[vfs] place "${place.name}": "${key}" not published — ${err.message}`,
      );
      if (retry) this.#scheduleRecheck(place, key, file.path);
    }
  }

  // A file or a directory gone from disk, with everything below it (key ''
  // is the place root): its rechecks with it.
  #unpublish(epoch, place, key, filePath) {
    epoch.remove(place, key);
    const below = filePath + path.sep;
    for (const pending of [...this.rechecks.keys()]) {
      if (pending === filePath || pending.startsWith(below)) {
        this.#cancelRecheck(pending);
      }
    }
  }

  // A recheck looks at the path as a new event would — a file, a
  // directory, or nothing there any more — in an epoch of its own, which
  // retries nothing.
  #scheduleRecheck(place, key, filePath) {
    if (this.rechecks.has(filePath)) return;
    const timer = setTimeout(() => {
      this.rechecks.delete(filePath);
      this.#serial('recheck', async () => {
        const epoch = this.#begin(false);
        await this.#remove(epoch, place, key, filePath, false);
        epoch.flush();
      });
    }, this.#kernel.config.global.watchTimeout);
    timer.unref();
    this.rechecks.set(filePath, timer);
  }

  #cancelRecheck(filePath) {
    const timer = this.rechecks.get(filePath);
    if (!timer) return;
    clearTimeout(timer);
    this.rechecks.delete(filePath);
  }
}

module.exports = { WatchPipeline };
