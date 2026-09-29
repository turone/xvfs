'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { LinkIndex } = require('../lib/links.js');

// LinkIndex on its own, with POSIX and Windows paths on any host: which
// paths pass through a known link, as the patch asks it for 'deny'. The
// kernel's use of it: links.test.js, links-deny.test.js.

// An lstat over a table of paths: 'link', 'dir', 'file', 'fail', or
// missing (undefined, as with throwIfNoEntry: false).
const lstatOf = (table) => (p) => {
  const kind = table[p];
  if (kind === 'fail') {
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
  }
  return kind === undefined
    ? undefined
    : {
        isSymbolicLink: () => kind === 'link',
        isDirectory: () => kind === 'dir',
      };
};

describe('LinkIndex, POSIX paths', () => {
  const index = () => {
    const x = new LinkIndex(path.posix);
    x.add('/app/d/jro');
    return x;
  };

  it('a path through a known link crosses it; one beside it does not', () => {
    const x = index();
    assert.equal(x.crosses('/app/d/jro/h.bin'), true);
    assert.equal(x.crosses('/app/d/jro'), true);
    assert.equal(x.crosses('/app/d/jrox/h.bin'), false);
    assert.equal(x.crosses('/app/d/other/a'), false);
    assert.equal(x.crosses('/app/d'), false);
    assert.equal(x.crosses('/elsewhere/x'), false);
  });

  it('an operation on the link itself (own) does not; a trailing separator, `.` or `..` follows it', () => {
    const x = index();
    assert.equal(x.crosses('/app/d/jro', true), false);
    assert.equal(x.crosses('/app/d/jro/', true), true);
    assert.equal(x.crosses('/app/d/jro/.', true), true);
    assert.equal(x.crosses('/app/d/jro/..', true), true);
    assert.equal(x.crosses('/app/d/jro/h.bin', true), true);
  });

  it('each name is checked before a `..` after it applies', () => {
    const x = index();
    assert.equal(x.crosses('/app/d/jro/../ro/h'), true);
    assert.equal(x.crosses('/app/d/x/../jro/h'), true);
    assert.equal(x.crosses('/app/d/x/../y/h'), false);
    assert.equal(x.crosses('//app///d/./jro/h'), true);
  });

  it(
    'a relative path is taken from the cwd',
    { skip: path.sep === '\\' },
    () => {
      const x = new LinkIndex(path.posix);
      x.add(path.posix.join(process.cwd(), 'j'));
      assert.equal(x.crosses('j/x'), true);
      assert.equal(x.crosses('./j/x'), true);
      assert.equal(x.crosses('k/x'), false);
    },
  );

  it('moved: the links at or below a renamed path are known where it lands', () => {
    const x = new LinkIndex(path.posix);
    x.add('/app/d/sub/j1');
    x.add('/app/d/sub/deep/j2');
    x.add('/app/d/subx/j3');
    const added = x.moved('/app/d/sub', '/app/d/moved');
    assert.deepEqual(added.sort(), ['/app/d/moved/deep/j2', '/app/d/moved/j1']);
    assert.equal(x.crosses('/app/d/moved/j1/f'), true);
    assert.equal(x.crosses('/app/d/moved/deep/j2/f'), true);
    assert.equal(x.crosses('/app/d/movedx/j3/f'), false);
    assert.deepEqual(x.moved('/app/d/sub/j1', '/app/d/j9'), ['/app/d/j9']);
    assert.equal(x.crosses('/app/d/j9/f'), true);
  });

  it('moved: links found on disk under the source move too', () => {
    const x = new LinkIndex(path.posix);
    const added = x.moved('/tmp/into', '/app/d/into', ['/tmp/into/jx']);
    assert.deepEqual(added, ['/app/d/into/jx']);
    assert.equal(x.crosses('/app/d/into/jx/f'), true);
    assert.equal(x.crosses('/tmp/into/jx/f'), false);
    // Onto a place's own directory: what lies below, never itself.
    const found = ['/tmp/build', '/tmp/build/j'];
    const onto = x.moved('/tmp/build', '/app/site', found, false);
    assert.deepEqual(onto, ['/app/site/j']);
    assert.equal(x.crosses('/app/site/f'), false);
    assert.equal(x.crosses('/app/site/j/f'), true);
  });

  it('delete forgets; the early exit follows', () => {
    const x = new LinkIndex(path.posix);
    x.add('/app/d/a/j1');
    x.add('/app/d/a/b/j2');
    x.add('/app/d/c/j3');
    assert.equal(x.size, 3);
    x.delete('/app/d/c/j3');
    assert.equal(x.crosses('/app/d/c/j3/f'), false);
    x.delete('/app/d/a/j1');
    x.delete('/app/d/a/b/j2');
    assert.equal(x.size, 0);
    assert.equal(x.crosses('/app/d/a/b/j2/f'), false);
    assert.deepEqual(x.list(), []);
  });

  it('with a floor: the same answers, the names down to it compared at once', () => {
    const x = new LinkIndex(path.posix, { floor: '/app' });
    x.add('/app/d/jro');
    assert.equal(x.crosses('/app/d/jro/h.bin'), true);
    assert.equal(x.crosses('/app//d/./jro/h.bin'), true);
    assert.equal(x.crosses('/app/d/jro', true), false);
    assert.equal(x.crosses('/app/d/jro/', true), true);
    assert.equal(x.crosses('/app/d/other'), false);
    assert.equal(x.crosses('/app'), false);
    assert.equal(x.crosses('/app/d/x/../jro/h'), true, '`..`: every name');
    assert.equal(x.crosses('/apple/d/jro/h'), false);
    x.add('/elsewhere/j'); // below no floor: every name is asked again
    assert.equal(x.crosses('/elsewhere/j/x'), true);
    assert.equal(x.crosses('/app/d/jro/x'), true);
  });

  // A known link is asked of the disk only on a path that would be
  // refused. Nothing there — a link the patch is still making, or one gone
  // — lets the path through and keeps it; a directory or a file there
  // drops it; an lstat that fails refuses.
  it('a known link is checked by its lstat: kept while nothing is there, dropped for a directory', () => {
    const table = {};
    const asked = [];
    const lstat = (p, o) => {
      asked.push(p);
      return lstatOf(table)(p, o);
    };
    for (const floor of [null, '/app']) {
      const x = new LinkIndex(path.posix, { lstat, floor });
      asked.length = 0;
      x.add('/app/d/j');
      assert.equal(x.crosses('/app/d/other/f'), false);
      assert.deepEqual(asked, []);
      assert.equal(x.crosses('/app/d/j/f'), false, 'nothing there yet');
      assert.deepEqual(asked, ['/app/d/j']);
      assert.equal(x.size, 1, 'kept');
      table['/app/d/j'] = 'link';
      assert.equal(x.crosses('/app/d/j/f'), true, 'made meanwhile');
      table['/app/d/j'] = 'fail';
      assert.equal(x.crosses('/app/d/j/f'), true, 'an lstat that fails');
      table['/app/d/j'] = 'dir';
      assert.equal(x.crosses('/app/d/j/f'), false);
      assert.equal(x.size, 0, 'a directory took its name');
      delete table['/app/d/j'];
    }
  });

  it('caseless: on POSIX paths too (macOS)', () => {
    const x = new LinkIndex(path.posix, { caseless: true, floor: '/App' });
    x.add('/App/d/JRO');
    assert.equal(x.crosses('/app/D/jro/x'), true);
    assert.equal(x.crosses('/APP/d/jro', true), false);
    const exact = new LinkIndex(path.posix);
    exact.add('/App/d/JRO');
    assert.equal(exact.crosses('/app/D/jro/x'), false);
  });

  it('below: each name under the directory is asked of the disk', () => {
    const table = {
      '/app/d/a': 'dir',
      '/app/d/a/j': 'link',
      '/app/d/b': 'dir',
      '/app/d/e': 'fail',
      '/app': 'link', // above the directory: never asked
    };
    const x = new LinkIndex(path.posix, { lstat: lstatOf(table) });
    assert.equal(x.crosses('/app/d/a/j/f', false, '/app/d'), true);
    assert.equal(x.crosses('/app/d/a/j', true, '/app/d'), false);
    assert.equal(x.crosses('/app/d/b/f', false, '/app/d'), false);
    assert.equal(x.crosses('/app/d/missing/f', false, '/app/d'), false);
    assert.equal(x.crosses('/app/d/e/f', false, '/app/d'), true);
    assert.equal(x.crosses('/app/d/b/../a/j/f', false, '/app/d'), true);
  });
});

describe('LinkIndex, Windows paths', () => {
  // node:fs resolves a Windows path before the OS opens it: `..` folded, a
  // trailing separator dropped — an operation on `jro\` is on the link.
  it('without case, either separator, a drive or a UNC root', () => {
    for (const floor of [null, 'C:\\App']) {
      const x = new LinkIndex(path.win32, { floor });
      x.add('C:\\App\\d\\JRO');
      assert.equal(x.crosses('C:\\app\\D\\jro\\h'), true);
      assert.equal(x.crosses('c:/APP/d/jro/x'), true);
      assert.equal(x.crosses('C:\\app\\d\\jro', true), false);
      assert.equal(x.crosses('C:\\app\\d\\jro\\', true), false);
      assert.equal(x.crosses('C:\\app\\d\\jro\\', false), true);
      assert.equal(x.crosses('C:\\app\\d\\jro\\..\\x'), false, 'folded');
      assert.equal(x.crosses('C:\\app\\d\\x\\..\\jro\\h'), true);
    }
    const x = new LinkIndex(path.win32);
    x.add('C:\\App\\d\\JRO');
    assert.equal(x.crosses('C:\\app\\d\\x'), false);
    assert.equal(x.crosses('D:\\app\\d\\jro\\h'), false);
    x.add('\\\\srv\\share\\app\\d\\j');
    assert.equal(x.crosses('//srv/share/app/d/j/x'), true);
    assert.equal(x.crosses('\\\\srv\\share\\app\\d\\k\\x'), false);
  });

  it('with a floor: in any case and either separator; a drive root', () => {
    const x = new LinkIndex(path.win32, { floor: 'C:\\App' });
    x.add('C:\\App\\d\\JRO');
    assert.equal(x.crosses('c:/APP/d/jro/x'), true);
    assert.equal(x.crosses('C:\\app\\d\\jro', true), false);
    assert.equal(x.crosses('C:\\app\\d\\x'), false);
    assert.equal(x.crosses('C:\\Apple\\d\\jro\\x'), false);
    const top = new LinkIndex(path.win32, { floor: 'D:\\' });
    top.add('D:\\j');
    assert.equal(top.crosses('d:\\J\\x'), true);
    assert.equal(top.crosses('D:\\k\\x'), false);
  });

  // node:fs resolves a path before the OS opens it: a drive-relative one
  // against its drive's cwd, a root-relative one against the cwd's drive.
  // The cwd is this host's, so on Windows only.
  it(
    'a drive-relative or root-relative path, as node:fs resolves it',
    { skip: process.platform !== 'win32' },
    () => {
      const cwd = process.cwd();
      for (const floor of [null, cwd]) {
        const x = new LinkIndex(path.win32, { floor });
        x.add(path.win32.join(cwd, 'd', 'j'));
        assert.equal(x.crosses(`${cwd.slice(0, 2)}d\\j\\x`), true);
        assert.equal(x.crosses(`${cwd.slice(2)}\\d\\j\\x`), true);
        assert.equal(x.crosses(`${cwd.slice(2)}\\d\\k\\x`), false);
        assert.equal(x.crosses('d\\j\\x'), true);
      }
    },
  );

  it('list gives the keys as kept; add takes them back', () => {
    const x = new LinkIndex(path.win32);
    x.add('C:\\App\\J');
    const y = new LinkIndex(path.win32);
    for (const key of x.list()) y.add(key);
    assert.equal(y.crosses('c:\\app\\j\\f'), true);
  });
});
