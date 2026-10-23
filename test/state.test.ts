import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadState, saveState, updateState, defaultState } from '../lib/state.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'studio-state-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('loadState returns default for unknown folder', () => {
  const s = loadState(dir, 'nope');
  assert.deepEqual({ ...s, updatedAt: '' }, { ...defaultState(), updatedAt: '' });
});

test('updateState patches and persists, round-trips through loadState', () => {
  const s = updateState(dir, 'basics-pagination-worked', { positionSec: 92.5 });
  assert.equal(s.positionSec, 92.5);
  assert.equal(s.watched, false);
  const again = updateState(dir, 'basics-pagination-worked', { watched: true });
  assert.equal(again.positionSec, 92.5);
  assert.equal(again.watched, true);
  assert.deepEqual(loadState(dir, 'basics-pagination-worked'), again);
  assert.ok(existsSync(path.join(dir, 'basics-pagination-worked.json')));
});

test('saveState keeps chat history', () => {
  const s = defaultState();
  s.chat.sessionId = 'abc';
  s.chat.messages.push({ role: 'user', text: 'why?', t: 10, line: '0.1', at: new Date().toISOString() });
  saveState(dir, 'x', s);
  assert.equal(loadState(dir, 'x').chat.messages[0].text, 'why?');
  assert.equal(loadState(dir, 'x').chat.sessionId, 'abc');
});

test('folder names with path separators are rejected', () => {
  assert.throws(() => loadState(dir, '../etc'));
});
