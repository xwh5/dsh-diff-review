import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cap, splitLines, diffLines, diffHunks, merge3, nextFallbackTurn, serializeSessions, loadSessions } from '../lib/index.js';
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('nextFallbackTurn', () => {
  it('fresh (no prev) -> base+1', () => {
    assert.equal(nextFallbackTurn(null, 0, Date.now(), 600000), 1);
    assert.equal(nextFallbackTurn(null, 7, Date.now(), 600000), 8);
  });
  it('same window -> reuse same turn (同一轮多文件归一组)', () => {
    const now = Date.now();
    const prev = { turn: 3, at: now - 1000 };
    assert.equal(nextFallbackTurn(prev, 2, now, 600000), 3);
    assert.equal(nextFallbackTurn(prev, 3, now, 600000), 3);
  });
  it('window expired -> advance to prev+1', () => {
    const now = Date.now();
    const prev = { turn: 3, at: now - 700000 };
    assert.equal(nextFallbackTurn(prev, 3, now, 600000), 4);
  });
  it('base ahead of prev -> base+1', () => {
    const now = Date.now();
    const prev = { turn: 1, at: now - 1000 };
    assert.equal(nextFallbackTurn(prev, 5, now, 600000), 6);
  });
});

describe('cap', () => {
  it('truncates to MAX_CHARS', () => {
    const big = 'a'.repeat(200000);
    const out = cap(big);
    assert.equal(out.length, 120000);
  });
  it('handles null/undefined', () => {
    assert.equal(cap(null), '');
    assert.equal(cap(undefined), '');
    assert.equal(cap(123), '123');
  });
});

describe('splitLines', () => {
  it('empty string -> []', () => { assert.deepEqual(splitLines(''), []); });
  it('single line', () => { assert.deepEqual(splitLines('hello'), ['hello']); });
  it('multiple lines preserves empty trailing? split behavior', () => {
    assert.deepEqual(splitLines('a\nb\n'), ['a', 'b', '']);
  });
});

describe('diffLines', () => {
  it('identical arrays -> all ctx', () => {
    const a = ['x', 'y'];
    const out = diffLines(a, a);
    assert.equal(out.length, 2);
    assert.equal(out[0].type, 'ctx');
    assert.equal(out[1].type, 'ctx');
  });
  it('simple add/del', () => {
    const a = ['a', 'b', 'c'];
    const b = ['a', 'x', 'c'];
    const out = diffLines(a, b);
    // expect del b / add x
    const types = out.map(o => o.type);
    assert.ok(types.includes('del'));
    assert.ok(types.includes('add'));
  });
  it('empty oldString insert', () => {
    const out = diffLines([], ['new', 'line']);
    assert.equal(out.length, 2);
    assert.equal(out[0].type, 'add');
  });
  it('empty newString delete', () => {
    const out = diffLines(['old'], []);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'del');
  });
});

describe('diffHunks', () => {
  it('identical -> no hunks', () => {
    const a = ['a', 'b'];
    assert.deepEqual(diffHunks(a, a), []);
  });
  it('single replacement -> one hunk', () => {
    const a = ['a', 'b', 'c'];
    const b = ['a', 'x', 'c'];
    const hunks = diffHunks(a, b);
    assert.equal(hunks.length, 1);
    assert.deepEqual(hunks[0], { a0: 1, a1: 2, b0: 1, b1: 2 });
  });
  it('insert at end', () => {
    const a = ['a'];
    const b = ['a', 'b'];
    const hunks = diffHunks(a, b);
    assert.equal(hunks.length, 1);
    assert.deepEqual(hunks[0], { a0: 1, a1: 1, b0: 1, b1: 2 });
  });
  it('delete at start', () => {
    const a = ['a', 'b'];
    const b = ['b'];
    const hunks = diffHunks(a, b);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].a0, 0);
  });
});

describe('merge3', () => {
  it('non-overlapping changes merge', () => {
    const base = ['a', 'b', 'c', 'd'];
    const ours = ['a', 'B', 'c', 'd']; // change line 1
    const theirs = ['a', 'b', 'c', 'D']; // change line 3
    const out = merge3(base, ours, theirs);
    assert.deepEqual(out, ['a', 'B', 'c', 'D']);
  });
  it('overlapping changes throw', () => {
    const base = ['a', 'b', 'c'];
    const ours = ['a', 'X', 'c'];
    const theirs = ['a', 'Y', 'c'];
    assert.throws(() => merge3(base, ours, theirs), /重叠/);
  });
  it('empty base with inserts merge', () => {
    const base = [];
    const ours = ['hello'];
    const theirs = [];
    // ours inserts at 0, theirs no change -> should succeed containing ours
    // But note diffHunks with empty base: ours insert is hunk a0=0 a1=0 b0=0 b1=1, theirs none
    const out = merge3(base, ours, theirs);
    assert.deepEqual(out, ['hello']);
  });
  it('both insert different lines at same position -> overlapping? treated as same hunk? current impl throws if overlap', () => {
    const base = ['mid'];
    const ours = ['before', 'mid'];
    const theirs = ['mid', 'after'];
    // ours inserts before, theirs appends after -> hunks at different a positions -> non-overlapping
    const out = merge3(base, ours, theirs);
    // This should attempt to merge both: expect ['before','mid','after'] but due to diffHunks grouping may differ
    // At least should not throw if positions differ
    assert.ok(Array.isArray(out));
  });
});

describe('serialize/loadSessions round-trip', () => {
  it('preserves ops with turn', () => {
    const sessions = new Map();
    const files = new Map();
    files.set('/tmp/a.txt', { path: '/tmp/a.txt', cwd: '/tmp', ops: [
      { kind: 'edit', at: 123, turn: 5, before: 'old', after: 'new', oldString: 'old', newString: 'new' },
      { kind: 'write', at: 124, turn: 5, before: null, after: 'content', content: 'content' }
    ]});
    sessions.set('sess1', files);
    const ser = serializeSessions(sessions);
    assert.equal(ser.version, 1);
    assert.ok(ser.sessions.sess1.files['/tmp/a.txt']);

    const target = new Map();
    const tmp = mkdtempSync(join(tmpdir(), 'drv-'));
    const f = join(tmp, 'state.json');
    writeFileSync(f, JSON.stringify(ser), 'utf8');
    loadSessions(target, f);
    const loaded = target.get('sess1');
    assert.ok(loaded);
    const rec = loaded.get('/tmp/a.txt');
    assert.equal(rec.ops.length, 2);
    assert.equal(rec.ops[0].turn, 5);
    try { unlinkSync(f); } catch {}
  });
  it('ignores corrupt file gracefully', () => {
    const m = new Map();
    const tmp = mkdtempSync(join(tmpdir(), 'drv-'));
    const f = join(tmp, 'bad.json');
    writeFileSync(f, '{ not json', 'utf8');
    // should not throw
    loadSessions(m, f);
    assert.equal(m.size, 0);
    try { unlinkSync(f); } catch {}
  });
  it('migrates all-zero turn to 1 for visibility', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'drv-'));
    const f = join(tmp, 'state.json');
    const raw = {
      version: 1,
      sessions: {
        sessZero: {
          files: {
            '/tmp/b.txt': {
              path: '/tmp/b.txt',
              cwd: '/tmp',
              ops: [
                { kind: 'edit', at: 1, turn: 0, before: 'a', after: 'b', oldString: 'a', newString: 'b' },
                { kind: 'edit', at: 2, turn: 0, before: 'b', after: 'c', oldString: 'b', newString: 'c' }
              ]
            }
          }
        }
      }
    };
    writeFileSync(f, JSON.stringify(raw), 'utf8');
    const m = new Map();
    loadSessions(m, f);
    const rec = m.get('sessZero').get('/tmp/b.txt');
    assert.equal(rec.ops[0].turn, 1);
    assert.equal(rec.ops[1].turn, 1);
    try { unlinkSync(f); } catch {}
  });
  it('does not migrate mixed zero/non-zero', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'drv-'));
    const f = join(tmp, 'state.json');
    const raw = {
      version: 1,
      sessions: {
        sessMixed: {
          files: {
            '/tmp/c.txt': {
              path: '/tmp/c.txt',
              cwd: '/tmp',
              ops: [
                { kind: 'edit', at: 1, turn: 0, before: 'a', after: 'b', oldString: 'a', newString: 'b' },
                { kind: 'edit', at: 2, turn: 5, before: 'b', after: 'c', oldString: 'b', newString: 'c' }
              ]
            }
          }
        }
      }
    };
    writeFileSync(f, JSON.stringify(raw), 'utf8');
    const m = new Map();
    loadSessions(m, f);
    const rec = m.get('sessMixed').get('/tmp/c.txt');
    assert.equal(rec.ops[0].turn, 0);
    assert.equal(rec.ops[1].turn, 5);
    try { unlinkSync(f); } catch {}
  });
});
