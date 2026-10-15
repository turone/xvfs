# Feeding a shared tree

What xvfs needs from a database, Redis or any other system that is the
source of truth for a [shared tree](../README.md#page-and-route-trees) —
the pages and routes of a site, a menu, a catalogue:
what a batch says, how batches are numbered and replayed, how a snapshot
is taken, and how a reader waits for a write made elsewhere. The
mechanics on the xvfs side — the intake, its window, gaps and refusals —
are in the README and in
[architecture.md](architecture.md#shared-trees).

Contents: [The model](#the-model) · [A batch](#a-batch) ·
[Numbers](#numbers) · [A snapshot](#a-snapshot) ·
[Recovery](#recovery) · [Reading a write made elsewhere](#reading-a-write-made-elsewhere) ·
[PostgreSQL](#postgresql) · [Redis](#redis) · [A single writer](#a-single-writer)

## The model

A tree mirrors the source; it is never written any other way. The source
commits a change, numbers it, and hands xvfs a **batch**: the final state,
after that change, of every node the change touched. The intake of the
main thread applies batches strictly in the order of their numbers, from
the last one it applied (`tree.last`) on; a batch that comes twice — from
the worker that made the change and from the source's own notification —
is applied once. When the tree cannot go on — a number missing for too
long, a batch refused — the source's **snapshot** (`load(rows, seq)`)
replaces the tree's state, and the batches after it apply as before.

So the source provides four things:

1. **Batches** — the final state of every row a change touched.
2. **Numbers** — dense, per tree, in the order of commit (or none, for a
   single writer: [below](#a-single-writer)).
3. **A log** — the batches by number, for as long as a gap may need them.
4. **A snapshot** — every row of the tree and the number it is at, read
   consistently.

## A batch

```js
await tree.submit({
  seq: 1042, // the source's number of this change
  ops: [
    ['put', 17, 3, 'about', { class: 1, payload: { data: json }, policy }],
    ['remove', 21],
  ],
});
```

- **One op per id** of each row the change touched — its triggers' and
  cascades' writes included: `['put', id, parentId, name, fields]` for a
  row that exists after it, `['remove', id]` for one that does not. An id
  twice is refused at once (`EINVAL`).
- **Ops are states, not commands**: their order does not matter. After the
  batch, a node of a `put` lives with what it says, a node of a `remove`
  is gone, and a node the batch does not name lives where it was, if its
  parent lives.
- **`put`** names the node's parent (`null`: the root), its name — unique
  among its siblings — and its fields: `class` (required for a new id),
  `payload` (`{ data?, mtimeMs?, meta? }` — the fields a page is rendered
  from — `null` to take it off, absent to keep it), `rendered` (the page,
  if the source renders it; likewise), `policy` (likewise) and
  `translations` (`{ <code>: { name, payload, rendered } | null }`, the
  languages but the main one that changed). A field no one reads is
  `EINVAL`. A `put` that changes nothing publishes nothing.
- **The data only when it changed.** An absent `payload` keeps the
  node's; a `payload` sent again with the same data is new data: it takes
  the page away — new data has none but its `rendered` — and changes the
  version, so every ETag. A change of a policy, a name or a parent sends
  no `payload`. In SQL the trigger compares the row's content:
  `OLD.body IS DISTINCT FROM NEW.body`.
- **A language** is a translation of the same node: its name there,
  unique among the siblings that have one there, and its own data and
  page. A change of one language carries that language only; a
  translation with data has a name — a new one states it.
- **`remove`** takes the node away with everything below it before the
  batch. An id the tree does not hold is no error.
- **The exact rule of removal.** A descendant of a removed node that the
  batch does not name goes with it; one the batch moves elsewhere (a `put`
  under a living parent) stays. Everything else the change deleted the
  source names — in particular a row the same change first moved under
  the removed node and then deleted with it: not named, it stays in the
  tree where it was. A source that names every row a change deleted is
  always right; a source that deletes a subtree in one call, and moved
  nothing under it in that call, may name only its top.
- **A row deleted and inserted again** with the same id within one change
  (natural keys) comes as one `put` with all its fields.
- **The root** is the one node without a parent: a `put` of another id
  with `parentId: null` while one exists is `EEXIST`; a `remove` of the
  root is `EINVAL`. An empty source starts with the `put` of its root.
- **Refusals** are of the final state: a parent that does not live
  (`ENOENT`), a cycle (`EINVAL`), two siblings of one name (`EEXIST`, with
  `other` — and `lang`, the code of the language the names are of), a
  page without data there (`ENOENT` with `lang`), a payload or a page
  larger than `maxFileSize` (`EFBIG`), a pool without room for
  `spaceTimeout` (`ENOSPC`). A refused batch changes nothing; the
  batches before it publish; it and every later one wait for a load
  (`onError`).

## Numbers

In `intake.seq: 'source'` mode (the default) every batch carries the
source's number of its change:

- **Per tree, dense, in the order of commit.** One counter per tree,
  incremented by every change that touches the tree, in the transaction
  that commits it — never one counter for the whole database, which would
  leave every tree with gaps. The first batch after a snapshot at `S` is
  `S + 1`.
- **A safe integer ≥ 0** (`Number.isSafeInteger`): past 2⁵³ `n + 1 === n`.
- **Sent after commit, from anywhere.** The worker that made the change
  may submit its batch right after the source committed it — and reads it
  back as soon as its promise resolves; the source's notification may
  bring the same batch to the main thread too. The number makes the second
  one a repeat (`'duplicate'`). A batch sent before its commit is final
  could publish a change the source then rolled back.
- **A gap is the source's to fill.** A batch past a missing number waits;
  after `gapTimeout` the intake tells `onGap({ from, to })` once. The
  source's log replays `from..to` — submitted in any order, the intake
  sorts them — or the tree reloads.
- **The last batch lost** shows no gap: compare the source's counter with
  `tree.last` from time to time (on reconnect, on a timer) and replay what
  lies between.

## A snapshot

`load(rows, seq)` replaces the tree's state with the source's at `seq`:

- **Read in one consistent snapshot** of the source — every row of the
  tree and the counter with them, in one transaction (`REPEATABLE READ`),
  one `MULTI`, one script — so that `seq` is exactly the state the rows
  show.
- **Rows** are `{ id, parentId, name, class, payload, rendered, policy,
translations }`, in any order; nodes not in them are gone after the
  load. A row carries **every** field of its node: one it lacks is none —
  no data, no page, no policy, no translation — as a node it lacks is
  gone; only `class` stays a live node's. A translation of a row has its
  name. The languages of a page are one row: a `LEFT JOIN` of its
  content rows by language into `translations`.
- **The batches up to `seq`** waiting in the intake are dropped
  (`'superseded'`); those after it join the load's publication.
- **Older than the tree** — `seq` below `tree.last` — is `ESTALE`: take a
  new snapshot. Until its first load the intake applies nothing; an empty
  source loads `[]` at its counter.

## Recovery

| What happens                         | What the source does                                 |
| ------------------------------------ | ---------------------------------------------------- |
| `onGap({ from, to })`                | replay `from..to` from its log, or load a snapshot   |
| `onError(err)` — a refused batch     | load a snapshot (the batches after it wait for it)   |
| the process starts                   | load a snapshot, then follow the log from its number |
| the log no longer holds a gap's part | load a snapshot                                      |
| its counter is ahead of `tree.last`  | replay the difference                                |

A load takes away every page its rows do not carry — rendered by the
source, or by a thread with `cache` — so after a recovery the pages are
rendered anew, on their next requests.

A batch refused by the final state means the source and the tree
disagree — a batch was lost or built wrong — and only the source's
snapshot settles it.

## Reading a write made elsewhere

- **One's own writes.** A worker that submits a batch reads it back as
  soon as the promise resolves: the main thread answers after it posted
  the update, and the port delivers the update first.
- **Another process's writes.** The source knows the number `N` of the
  change it committed; `tree.last` is the number of the last batch a
  thread's tree shows, and a publication names the numbers of the batches
  it shows — `'publish'` carries `trees: [{ tree, seqFrom, seqTo, loaded
}]`. A reader that needs change `N` waits until `tree.last >= N`. A
  batch that changes nothing moves `last` in every thread but publishes
  nothing — no event comes for it — so a wait looks again on a short
  interval too, and gives up after a while: a lost batch shows only once
  the source replays it. The kernel has no wait for a number of its own.

```js
// Resolves once this thread's tree shows change `n` of its source.
const shows = (kernel, name, n, ms = 5000) =>
  new Promise((resolve, reject) => {
    const tree = kernel.tree(name);
    const shown = () => tree.last !== null && tree.last >= n;
    if (shown()) return resolve();
    const done = (err) => {
      clearInterval(again);
      clearTimeout(late);
      kernel.off('publish', check);
      if (err) reject(err);
      else resolve();
    };
    const check = () => shown() && done();
    const again = setInterval(check, 10);
    const late = setTimeout(() => done(new Error(`no change ${n}`)), ms);
    kernel.on('publish', check);
  });
```

## PostgreSQL

The rows of a tree in a table; a counter per tree, a log of its batches;
triggers that number and log each change in its own transaction.

```sql
create table pages (
  id bigint primary key,
  parent_id bigint references pages (id) on delete cascade,
  name text not null,
  class int not null,
  body bytea,
  policy jsonb,
  unique (parent_id, name)
);
-- A page's content in the languages but the main one.
create table page_l10n (
  page_id bigint references pages (id) on delete cascade,
  lang text not null,
  name text not null,
  body bytea,
  primary key (page_id, lang)
);
create table tree_seq (tree text primary key, seq bigint not null);
create table tree_log (
  tree text not null,
  seq bigint not null,
  ops jsonb not null,
  primary key (tree, seq)
);
-- What the open transactions changed, until their commit.
create table tree_changed (txid bigint, id bigint, primary key (txid, id));
create table tree_tx (txid bigint primary key);
insert into tree_seq values ('pages', 0);
```

- **Every row a change touched.** A row-level trigger, `after insert or
update or delete on pages for each row`, sees each of them — a cascade
  runs ordinary `DELETE`s, which fire it; a statement-level one would not
  see the rows of a cascade. It records the row's id under
  `txid_current()` in `tree_changed`, and the transaction once in
  `tree_tx` (`on conflict do nothing`).
- **One number per change, at commit.** A constraint trigger on `tree_tx`,
  `deferrable initially deferred`, fires for the transaction's one row
  when it commits:

  ```sql
  update tree_seq set seq = seq + 1 where tree = 'pages' returning seq;
  ```

  The row lock it takes is held until the commit ends, so the changes of
  one tree get their numbers in the order they commit. With the number it
  builds the batch — for each id of `tree_changed`, a `put` of what
  `pages` and `page_l10n` hold now, or a `remove` where it holds nothing:
  a row updated twice is one op, a row deleted and inserted again one
  `put`; `payload` only where `OLD.body IS DISTINCT FROM NEW.body`, a
  language in `translations` only where its row changed — inserts it
  into `tree_log`, calls `pg_notify('tree_pages', seq::text)` — delivered
  once the commit is done — and deletes its rows of `tree_changed` and
  `tree_tx`.

- **No cycle commits.** The table's keys refuse what the engine refuses
  of a parent (`ENOENT`) and of a name (`EEXIST`); a cycle nothing
  refuses — and two changes that each make none alone, A moved under B
  and B under A, make one together. The same trigger looks for one under
  the lock it took, in a statement that sees every change that committed
  before, and raises if it finds one:

  ```sql
  with recursive up (start, id) as (
    select p.id, p.parent_id from pages p
      join tree_changed c on c.id = p.id and c.txid = txid_current()
    union
    select up.start, p.parent_id from up join pages p on p.id = up.id
      where up.id <> up.start
  )
  select start from up where id = start limit 1;
  ```

  A cycle that commits stalls the tree: every batch past it is refused,
  and so is a snapshot that holds it, until the source mends it.

- **Bytes in the log.** `jsonb` holds no bytes: a batch carries `body`
  base64-encoded (`encode(body, 'base64')`), which the follower decodes
  before it submits (`Buffer.from(body, 'base64')`).

- **Following.** The main thread listens (`LISTEN tree_pages`); on each
  notification, and on start, it reads the log past `tree.last` and
  submits every batch:

  ```sql
  select seq, ops from tree_log where tree = 'pages' and seq > $1 order by seq;
  ```

  The worker that made a change may submit its batch too, read from the
  log after its `COMMIT`: it reads its own write back at once, and the
  main thread's copy is a repeat.

- **A snapshot** is one transaction for the counter and the rows:

  ```sql
  begin isolation level repeatable read;
  select seq from tree_seq where tree = 'pages';
  select p.id, p.parent_id, p.name, p.class, p.body, p.policy,
    jsonb_object_agg(l.lang, jsonb_build_object('name', l.name,
      'body', encode(l.body, 'base64'))) filter (where l.lang is not null)
      as translations
  from pages p left join page_l10n l on l.page_id = p.id
  group by p.id;
  commit;
  ```

  A row of it becomes a row of `load` as a batch's does: `body` is
  `payload.data`, and a language's `{ name, body }` its translation —
  `{ name, payload: { data: body } }`, decoded from base64.

- **The log** keeps what a gap may need — rows past what every process
  has loaded, or a window of them; a gap past it is a reload.

## Redis

A hash per node, a counter and a stream per tree; a Lua script applies
each change and numbers it, atomically.

```lua
-- KEYS[1] tree:pages:seq   KEYS[2] tree:pages:log
-- ARGV[1] the batch, JSON: the final state of each node the change
-- touches — which the script also writes to the nodes' hashes.
local seq = redis.call('INCR', KEYS[1])
redis.call('XADD', KEYS[2], seq .. '-1', 'ops', ARGV[1])
return seq
```

- **The stream id is the number**, `<seq>-1`: `XADD` refuses an id no
  greater than the last, so the numbers stay dense and in order, and a
  gap replays as a range:

  ```
  XRANGE tree:pages:log <from>-1 <to>-1
  ```

- **Following.** The main thread reads the stream past `tree.last` and
  submits every entry; on reconnect it starts there again:

  ```
  XREAD BLOCK 0 STREAMS tree:pages:log <last>-1
  ```

- **A snapshot** is one script that returns the counter and every node's
  hash, or one `MULTI` of `GET tree:pages:seq` and the `HGETALL`s; a tree
  too large for one call is read in pages under `WATCH tree:pages:seq`,
  again when the counter moved.
- **The log** is trimmed to what a gap may need:
  `XTRIM tree:pages:log MINID <seq>-1`.

## A single writer

`intake.seq: 'intake'` is for a source that is one writer over one
channel that loses nothing — the code that changes the data, in one
process, submitting each change in the order it makes it: `submit` on the
main thread, or one worker's link. The intake numbers the batches as they
arrive; there are no gaps, no repeats and no `ESTALE`. `load(rows)` takes
no number: it is the writer's own state, the batches it submitted before
are in it, and those it submits after wait for it. A source with several
processes, several channels, a log, a restart to recover from, or a
reader of writes made elsewhere numbers its own changes: `'source'`.
