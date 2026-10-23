import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../lib/config.ts';
import { pickMp4, readRecord, buildCatalog, sortKey, loadOverrides } from '../lib/catalog.ts';

const cfg = loadConfig();

test('pickMp4 follows the three naming rules and ignores dot-files', () => {
  assert.equal(pickMp4('a', ['a-explainer.mp4', 'a.mp4', 'x.mp4']), 'a-explainer.mp4');
  assert.equal(pickMp4('a', ['a.mp4', 'x.mp4']), 'a.mp4');
  assert.equal(pickMp4('a', ['x.mp4', 'script.json']), 'x.mp4');
  assert.equal(pickMp4('a', ['x.mp4', 'y.mp4']), null);
  assert.equal(pickMp4('a', ['.seg0.mp4', '.seg1.mp4']), null);
});

test('pickMp4 against the example folders', async () => {
  const r = (f: string) => readRecord(cfg.videoRoot, f, {})!;
  assert.equal(r('sd-model-serving').mp4, 'sd-model-serving-explainer.mp4');
  assert.equal(r('basics-pagination-worked').mp4, 'basics-pagination-worked.mp4');
  assert.equal(r('acme-sd-01-rate-limiter').mp4, null);
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(path.join(tmpdir(), 'studio-mp4-'));
  try {
    mkdirSync(path.join(root, 'acme-sd-02-only-mp4'));
    writeFileSync(path.join(root, 'acme-sd-02-only-mp4', 'brief.md'), 'b');
    writeFileSync(path.join(root, 'acme-sd-02-only-mp4', 'acme-sd-02-tradeoffs.mp4'), '');
    assert.equal(readRecord(root, 'acme-sd-02-only-mp4', {})!.mp4, 'acme-sd-02-tradeoffs.mp4');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readRecord builds scenes from timeline.json with positional keys', () => {
  const r = readRecord(cfg.videoRoot, 'basics-pagination-worked', {})!;
  assert.equal(r.title, 'Pagination, worked end to end (3b1b style)');
  assert.ok(r.durationSec! > 200);
  assert.equal(r.scenes[0].chip, 'The duplicate row');
  assert.equal(r.scenes[0].lines[0].key, '0.0');
  assert.equal(r.scenes[0].lines[0].start, 0.7);
  assert.ok(r.scenes[0].lines[0].text.startsWith('Here is a feed.'));
  assert.equal(r.hasSource, false);
});

test('overrides win and hidden returns null', () => {
  const o = { 'sd-model-serving': { kind: 'sd' as const, company: 'General' }, 'basics-pagination-worked': { hidden: true } };
  assert.equal(readRecord(cfg.videoRoot, 'sd-model-serving', o)!.kind, 'sd');
  assert.equal(readRecord(cfg.videoRoot, 'sd-model-serving', o)!.unsorted, false);
  assert.equal(readRecord(cfg.videoRoot, 'sd-model-serving', {})!.unsorted, true);
  assert.equal(readRecord(cfg.videoRoot, 'basics-pagination-worked', o), null);
});

test('buildCatalog reads every folder and sorts by series, kind, number', () => {
  const c = buildCatalog(cfg.videoRoot, loadOverrides(path.join(cfg.studioDir, 'catalog.overrides.json')));
  assert.deepEqual(c.records.map(r => r.folder).sort(), ['acme-sd-01-rate-limiter', 'basics-pagination-worked', 'globex-beh-01-biggest-failure', 'sd-model-serving']);
  assert.deepEqual(c.unreadable, []);
  for (const r of c.records) {
    assert.ok(r.title.length > 0, r.folder);
    assert.ok(r.scenes.length > 0 || (r.hasBrief && r.mp4 === null), r.folder);
    assert.ok(r.durationSec === null || r.durationSec > 0, r.folder);
  }
  assert.deepEqual(c.records.map(r => r.folder), ['acme-sd-01-rate-limiter', 'basics-pagination-worked', 'globex-beh-01-biggest-failure', 'sd-model-serving']);
  for (let i = 1; i < c.records.length; i++) assert.ok(sortKey(c.records[i - 1]) <= sortKey(c.records[i]));
});

test('readRecord throws on a folder with no timeline, script or brief', () => {
  assert.throws(() => readRecord(cfg.videoRoot, 'definitely-missing-folder', {}));
});

test('R03: script.json fallback has no times; malformed script.json lands in unreadable', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(path.join(tmpdir(), 'studio-cat-'));
  try {
    mkdirSync(path.join(root, 'acme-sd-90-script-only'));
    writeFileSync(path.join(root, 'acme-sd-90-script-only', 'script.json'), JSON.stringify({ title: 'Script only', scenes: [{ chip: 'Intro', lines: [{ text: 'hello' }] }] }));
    mkdirSync(path.join(root, 'acme-sd-91-broken'));
    writeFileSync(path.join(root, 'acme-sd-91-broken', 'script.json'), '{ not json');
    const c = buildCatalog(root, {});
    assert.deepEqual(c.records.map(r => r.folder), ['acme-sd-90-script-only']);
    const r = c.records[0];
    assert.equal(r.title, 'Script only'); assert.equal(r.durationSec, null); assert.equal(r.mp4, null);
    assert.deepEqual(r.scenes[0].lines[0], { key: '0.0', text: 'hello', start: null, end: null });
    assert.deepEqual(c.unreadable.map(u => u.folder), ['acme-sd-91-broken']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
