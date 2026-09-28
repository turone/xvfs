'use strict';

const { canonicalKey } = require('./place.js');
const { fsError } = require('./errors.js');

// Mutation RPC — worker → main writes for `sab + virtual` places.
//
// Workers never allocate in the SAB pool. A mutation travels over the same
// private MessagePort `kernel.link()` already uses for deltas and ACKs:
//
//   worker → main  { name: 'vfs-mutate', id, place, op, key, to?, options?,
//                    data? }   `data` is a Uint8Array over a transferred
//                              ArrayBuffer owned by the request
//                  writeFiles: { …, op, keys, sizes, options, data } — the
//                              bytes of every file one after another in
//                              `data`, `sizes[i]` of them for `keys[i]`
//   main → worker  { name: 'vfs-mutated', id, error?, version? }
//                              `version`: of the commit of a writeFiles
//
// The response arrives after the new version is published (one `vfs-update`
// for every thread), not after every worker ACKs: ACKs only govern when the
// replaced bytes are released. The bytes themselves are never echoed back —
// they are in SAB, and the delta carries projection metadata only.
//
// Ordering is the arrival order at the main kernel, which serialises every
// mutation (its own included) in one queue.
//
// One table (OPS) describes each mutation for both ends: what its request
// carries besides the key — `data` (bytes), `to` (a second key), or
// `files` (a set of keys and their bytes, in place of the key) — and the
// options its store takes, which travel as booleans.

const MUTATE = 'vfs-mutate';
const MUTATED = 'vfs-mutated';

const OPS = {
  write: { data: true, options: ['exclusive'] },
  append: { data: true, options: [] },
  unlink: { options: ['directory'] },
  mkdir: { options: ['recursive'] },
  rm: { options: ['force', 'recursive', 'directory'] },
  rename: { to: true, options: ['directory'] },
  writeFiles: { files: true, options: ['exclusive'] },
};

// The options of `op` its store takes, as booleans; nothing else.
const optionsOf = (op, options) => {
  const result = {};
  for (const name of OPS[op].options) result[name] = Boolean(options?.[name]);
  return result;
};

// A detached copy of the payload: the caller's Buffer is often a view into
// Node's shared pool, so transferring it directly would detach memory the
// caller still owns.
const payloadOf = (data) => {
  const src = Buffer.isBuffer(data) || ArrayBuffer.isView(data) ? data : null;
  const bytes = src
    ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
    : new Uint8Array(Buffer.from(String(data), 'utf8'));
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
};

// Errors cross the port as plain cloneable records of their node:fs fields
// (a SystemError's `info` included), and come back with the same ones.
const FIELDS = ['name', 'code', 'errno', 'syscall', 'path', 'dest', 'info'];

const errorOf = (err) => {
  const record = { message: err.message };
  for (const field of FIELDS) {
    if (err[field] !== undefined) record[field] = err[field];
  }
  return record;
};

const restore = (record) => {
  const err = new Error(record.message);
  for (const field of FIELDS) {
    if (record[field] !== undefined) err[field] = record[field];
  }
  return err;
};

// The link's other end is gone: the main kernel closed.
const linkClosed = () =>
  new Error('[vfs] link closed before the mutation was published');

// MutationClient — worker end of the protocol; one per link port, shared by
// every virtual place of that link. The port is unref'd so an idle link
// never keeps a worker alive; a request in flight does, like any pending
// I/O, until its response or the link's end settles it.
class MutationClient {
  #port;
  #pending = new Map();
  #nextId = 0;
  #closed = null;

  constructor(port) {
    this.#port = port;
  }

  // Requests sent and not settled yet (tests, diagnostics).
  get pending() {
    return this.#pending.size;
  }

  #settle(id) {
    const pending = this.#pending.get(id);
    this.#pending.delete(id);
    if (this.#pending.size === 0) this.#port.unref();
    return pending;
  }

  // True when the message was a mutation response.
  handle(msg) {
    if (msg?.name !== MUTATED) return false;
    if (!this.#pending.has(msg.id)) return true;
    const pending = this.#settle(msg.id);
    if (msg.error) pending.reject(restore(msg.error));
    else pending.resolve(msg.version);
    return true;
  }

  send(place, op, request, data) {
    if (this.#closed) return Promise.reject(this.#closed());
    const id = ++this.#nextId;
    const msg = { name: MUTATE, id, place, op, ...request };
    const transfer = [];
    if (data) {
      msg.data = data;
      transfer.push(data.buffer);
    }
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      if (this.#pending.size === 1) this.#port.ref();
      try {
        this.#port.postMessage(msg, transfer);
      } catch (err) {
        this.#settle(id);
        reject(err);
      }
    });
  }

  // The link is gone (worker or kernel closing): nothing can be published
  // any more, so no request may stay pending. `failure` makes the error
  // each of them, and each request asked afterwards, rejects with; the
  // first close decides it — a worker kernel's own close() comes before
  // the close of its port.
  close(failure = linkClosed) {
    if (this.#closed) return;
    this.#closed = failure;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    this.#port.unref();
    for (const { reject } of pending) reject(failure());
  }
}

// RemoteStore — worker-side mutation API of one `sab + virtual` place.
// Mirrors SabStore; every method returns a Promise settled by the main
// kernel. Validation happens there, against the state the publication is
// applied to.
class RemoteStore {
  sync = false;

  constructor(place, client) {
    this.place = place;
    this.client = client;
  }

  // A request as OPS describes `op`: the key, the options, the second key
  // of a rename, a copy of the bytes of a write.
  #send(op, key, options, { to, data } = {}) {
    const spec = OPS[op];
    const request = { key, options: optionsOf(op, options) };
    if (spec.to) request.to = to;
    const payload = spec.data ? payloadOf(data) : undefined;
    return this.client.send(this.place.name, op, request, payload);
  }

  write(key, data, options) {
    return this.#send('write', key, options, { data });
  }

  append(key, data) {
    return this.#send('append', key, undefined, { data });
  }

  unlink(key, options) {
    return this.#send('unlink', key, options);
  }

  mkdir(key, options) {
    return this.#send('mkdir', key, options);
  }

  rm(key, options) {
    return this.#send('rm', key, options);
  }

  rename(from, to, options) {
    return this.#send('rename', from, options, { to });
  }

  // A set is one request: its keys, the size of each file, and their bytes
  // one after another in one buffer — a copy, taken now, transferred.
  // Resolves with the version of the commit that published it.
  writeFiles(files, options) {
    const keys = [];
    const sizes = [];
    let total = 0;
    for (const [key, bytes] of files) {
      keys.push(key);
      sizes.push(bytes.byteLength);
      total += bytes.byteLength;
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const [, bytes] of files) {
      data.set(bytes, offset);
      offset += bytes.byteLength;
    }
    const request = { keys, sizes, options: optionsOf('writeFiles', options) };
    return this.client.send(this.place.name, 'writeFiles', request, data);
  }
}

// The files of a set a request carries, `[key, bytes]` each: its keys made
// canonical, none twice, each with a view of the request's buffer that its
// size says, the sizes adding up to the buffer. A request that says
// otherwise is refused whole.
const filesOf = ({ keys, sizes, data }) => {
  const malformed = () => new TypeError('[vfs] writeFiles: malformed request');
  if (!Array.isArray(keys) || !Array.isArray(sizes)) throw malformed();
  if (keys.length === 0 || keys.length !== sizes.length) throw malformed();
  if (!(data instanceof Uint8Array)) throw malformed();
  const files = [];
  const seen = new Set();
  let offset = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = canonicalKey(keys[i]);
    if (seen.has(key)) {
      throw new TypeError(
        `writeFiles: ${JSON.stringify(keys[i])} written twice`,
      );
    }
    const size = sizes[i];
    if (!Number.isSafeInteger(size) || size < 0) throw malformed();
    if (offset + size > data.byteLength) throw malformed();
    seen.add(key);
    const bytes = Buffer.from(data.buffer, data.byteOffset + offset, size);
    files.push([key, bytes]);
    offset += size;
  }
  if (offset !== data.byteLength) throw malformed();
  return files;
};

// One request, against the main kernel's own view: the worker's projection
// is read-only and never authoritative, so the mutation, the place, its
// origin and writability and the keys are validated again here, before
// anything is allocated, and the store gets only the options OPS lists.
// A set names no one key: what refuses it names the place's directory.
const mutate = (registry, msg) => {
  const { place: name, op, key, to, options, data } = msg;
  const spec = Object.hasOwn(OPS, op) ? OPS[op] : null;
  if (!spec) throw new Error(`[vfs] unknown mutation "${op}"`);
  const place = registry.get(name);
  if (!place) throw new Error(`[vfs] unknown place "${name}"`);
  const files = spec.files ? filesOf(msg) : null;
  const canonical = files ? '' : canonicalKey(key);
  if (place.provider !== 'sab' || !place.virtual) {
    const detail = 'not a shared virtual place';
    throw fsError('ENOTSUP', op, place.pathOf(canonical), detail);
  }
  if (!place.config.fs.writable) {
    throw fsError('EROFS', op, place.pathOf(canonical));
  }
  if (files) return place.store.writeFiles(files, optionsOf(op, options));
  const args = [canonical];
  if (spec.to) args.push(canonicalKey(to));
  if (spec.data) {
    args.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }
  return place.store[op](...args, optionsOf(op, options));
};

// The main kernel's end of one link: a worker's request, answered once its
// publication is done — with the version of the commit of a set — or
// refused. A worker gone meanwhile gets nothing.
const serveMutation = (kernel, linkId, port, msg) => {
  const reply = (error, version) => {
    if (!kernel.links.has(linkId)) return; // worker gone: drop the response
    const response = { name: MUTATED, id: msg.id, error };
    if (version !== undefined) response.version = version;
    try {
      port.postMessage(response);
    } catch {
      // The port closed between the check and the post.
    }
  };
  let result;
  try {
    result = mutate(kernel.registry, msg);
  } catch (err) {
    reply(errorOf(err));
    return;
  }
  Promise.resolve(result).then(
    (version) => reply(null, version),
    (err) => reply(errorOf(err)),
  );
};

module.exports = {
  MUTATE,
  MutationClient,
  RemoteStore,
  serveMutation,
  payloadOf,
};
