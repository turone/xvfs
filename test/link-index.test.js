'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { LinkIndex } = require('../lib/links.js');

// LinkIndex on its own, with POSIX and Windows paths on any host: which
// paths pass through a known link, as the patch asks it for 'deny'. The
// index only grows, and asks no disk. The kernel's use of it: links.test.js,
// links-deny.test.js.

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

  it('add: a new link raises the generation, a known one changes nothing', () => {
    const x = new LinkIndex(path.posix);
    assert.equal(x.generation, 0);
    assert.equal(x.add('/app/d/a/j1'), '/app/d/a/j1');
    assert.equal(x.add('/app/d/a/b/j2'), '/app/d/a/b/j2');
    assert.equal(x.add('/app/d/a/j1'), null);
    assert.equal(x.size, 2);
    assert.equal(x.generation, 2);
    assert.deepEqual(x.list().sort(), ['/app/d/a/b/j2', '/app/d/a/j1']);
    assert.equal(x.holds('/app/d/a'), true);
    assert.equal(x.holds('/app/d/a/j1'), true);
    assert.equal(x.holds('/app/d/c'), false);
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

  it('caseless: on POSIX paths too (macOS)', () => {
    const x = new LinkIndex(path.posix, { caseless: true, floor: '/App' });
    x.add('/App/d/JRO');
    assert.equal(x.crosses('/app/D/jro/x'), true);
    assert.equal(x.crosses('/APP/d/jro', true), false);
    const exact = new LinkIndex(path.posix);
    exact.add('/App/d/JRO');
    assert.equal(exact.crosses('/app/D/jro/x'), false);
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
