'use strict';

const { fileExt } = require('metautil');
// The disk past fs-patch (disk.js).
const {
  promises: { stat, lstat },
} = require('./disk.js');
const { dirOf } = require('./place.js');
const { SerialQueue } = require('./serial-queue.js');
const { pool, IO_LIMIT } = require('./pool.js');
const { DirWatcher } = require('./watcher.js');
const { scan } = require('./scanner.js');

// WatchPipeline — live updates of a main kernel's disk-origin places.
// DirWatcher batches raw fs.watch events into epochs; each becomes one
// epoch of the kernel — changed files published, deleted ones removed,
// new directories rescanned — committed as one vfs-update. Epochs and
// rechecks run strictly one at a time, in arrival order.
//
// It reaches the kernel two ways, each at the time of a call and never at
// construction: the kernel's public state (ready, state, config, console,
// registry, sources) and `open()`, the one capability it is granted — a
// new epoch { publish(place, key, file), unstage(place, key), flush() },
// bound to an epoch of the kernel's own, which flush() commits. Each path
// an event names is told to the kernel's index of links too (noteLinks),
// once its job is done.

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

  // Watch every disk-origin place, once.
  start() {
    const kernel = this.#kernel;
    if (this.watcher || kernel.sources.size === 0) return;
    this.watcher = new DirWatcher({
      timeout: kernel.config.global.watchTimeout,
    });
    this.watcher.on('error', (err) =>
      kernel.console.error(`[vfs] watcher: ${err.message}`),
    );
    this.watcher.on('epoch', (events) => {
      this.#serial('epoch', () => this.#handle(events));
    });
    for (const name of kernel.sources.keys()) {
      this.watcher.watch(kernel.registry.get(name).root);
    }
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
  // reached (#publish).
  #begin() {
    const epoch = this.#open();
    epoch.seen = new Set();
    return epoch;
  }

  // The jobs of an epoch run IO_LIMIT at a time (pool.js), each on its own:
  // one that fails is logged and stops none of the others. A job the pool
  // reaches after close() does not start; one in flight at close() stops at
  // its next step (#remove, #refresh, #rescan, the publication): the disk
  // call it waits for finishes — a read of a file, to its end — no other
  // starts, no preparer runs, and nothing is logged.
  async #handle(events) {
    const kernel = this.#kernel;
    const epoch = this.#begin();
    const jobs = [];
    for (const [filePath, event] of events) {
      const route = kernel.registry.route(filePath);
      if (!route?.place || !kernel.sources.has(route.place.name)) continue;
      const { place, key } = route;
      jobs.push({ place, key, filePath, event });
    }
    await pool(jobs, IO_LIMIT, async ({ place, key, filePath, event }) => {
      if (!kernel.ready) return;
      try {
        let links = null; // what a rescan met (#rescan)
        if (event === 'delete') {
          links = await this.#remove(epoch, place, key, filePath);
        } else if (event === 'scan') {
          links = await this.#rescan(epoch, place, filePath);
        } else await this.#refresh(epoch, place, key, filePath, true);
        if (kernel.ready) await kernel.noteLinks(place, filePath, links);
      } catch (err) {
        kernel.console.error(`[vfs] update: ${err.message}`);
      }
    });
    epoch.flush();
  }

  // A delete event can describe a path that exists again: delete and re-create
  // inside one debounce window are two stats racing on the threadpool, and the
  // ENOENT one may land last. Re-check before unpublishing a live file. What
  // a rescan met, as #rescan returns it.
  async #remove(epoch, place, key, filePath) {
    const stats = await stat(filePath).catch(() => null);
    if (!this.#kernel.ready) return null;
    if (!stats) {
      this.#unpublish(epoch, place, key, filePath);
      return null;
    }
    if (stats.isDirectory()) return this.#rescan(epoch, place, filePath);
    await this.#refresh(epoch, place, key, filePath, true);
    return null;
  }

  // New files that appeared with a directory (move-in, unzip, mkdir -p),
  // published one at a time: the rescan is already one job of its epoch.
  // Its scan stops at close(); a publication after it refuses at its next
  // step (publication.js, alive()). Returns the links the scan met, for a
  // place with `links: 'deny'` (kernel.noteLinks), else null.
  async #rescan(epoch, place, dirPath) {
    const kernel = this.#kernel;
    const source = kernel.sources.get(place.name);
    const links = place.config.links === 'deny' ? [] : null;
    const files = await scan(place.root, {
      ext: place.config.scanExt,
      startPath: dirPath,
      followSymlinks: !kernel.config.global.strict,
      stopped: () => !kernel.ready,
      links,
    });
    for (const [key, file] of files) {
      if (!source.has(key)) await this.#publish(epoch, place, key, file, true);
    }
    return links;
  }

  // A file as the scan takes it: under strict, where the scan follows no
  // link, the path's own stats — a link there is no source, and its key
  // goes as if the file were gone.
  async #refresh(epoch, place, key, filePath, retry) {
    const { scanExt } = place.config;
    if (scanExt && !scanExt.includes(fileExt(key))) return;
    const look = this.#kernel.config.global.strict ? lstat : stat;
    let stats = await look(filePath).catch(() => null);
    if (stats?.isSymbolicLink()) stats = null;
    if (!this.#kernel.ready) return;
    if (!stats) {
      this.#unpublish(epoch, place, key, filePath);
      return;
    }
    if (!stats.isFile()) return;
    const file = {
      path: filePath,
      stat: { size: stats.size, mtimeMs: stats.mtimeMs },
    };
    await this.#publish(epoch, place, key, file, retry);
  }

  // A watched source that cannot be read consistently, that its preparer
  // rejects, that fs.script cannot compile or whose canonical form does not
  // fit in SAB keeps its previous version and companions; one deferred
  // recheck follows, then only a real event retries.
  // A directory rescan and a file event may both reach a key: first wins.
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

  // Delete a file or a whole subtree (key '' is the place root).
  #unpublish(epoch, place, key, filePath) {
    const source = this.#kernel.sources.get(place.name);
    const gone = source.has(key) ? [key] : [];
    for (const [k, isDirectory] of source.below(dirOf(key))) {
      if (!isDirectory) gone.push(k);
    }
    for (const k of gone) {
      source.delete(k);
      this.#cancelRecheck(place.pathOf(k));
      if (place.provider === 'map') place.store.remove(k);
      else epoch.unstage(place, k);
    }
    this.#cancelRecheck(filePath);
  }

  #scheduleRecheck(place, key, filePath) {
    if (this.rechecks.has(filePath)) return;
    const timer = setTimeout(() => {
      this.rechecks.delete(filePath);
      this.#serial('recheck', async () => {
        const epoch = this.#begin();
        await this.#refresh(epoch, place, key, filePath, false);
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
