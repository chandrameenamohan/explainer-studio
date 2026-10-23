import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseName, KIND_LABELS, configureNames } from '../lib/names.ts';

configureNames({ companies: { acme: 'Acme', globex: 'Globex' }, generalSeries: ['basics'] });

const names = readFileSync(path.join(import.meta.dirname, 'fixtures', 'folder-names.txt'), 'utf8').trim().split('\n');

test('every current folder name parses without throwing', () => {
  for (const n of names) {
    const p = parseName(n);
    assert.equal(p.folder, n);
    assert.ok(p.kind in KIND_LABELS, `${n}: kind ${p.kind}`);
  }
});

test('one example per pattern', () => {
  assert.deepEqual(parseName('globex-sd-01-tenant-isolation'), {
    folder: 'globex-sd-01-tenant-isolation', series: 'globex', company: 'Globex', kind: 'sd', nn: '01', slug: 'tenant-isolation', unsorted: false,
  });
  assert.equal(parseName('acme-beh-02-biggest-failure').kind, 'beh');
  assert.equal(parseName('acme-hm-01-sixty-minute-deep-dive').kind, 'hm');
  assert.equal(parseName('globex-sd-06b-agent-deployment').nn, '06b');
  assert.equal(parseName('acme-00-company-primer').kind, 'primer');
  assert.equal(parseName('acme-01-the-round-and-the-scope-gap').nn, '01');
  assert.equal(parseName('acme-01-the-round-and-the-scope-gap').kind, 'other');
  const b = parseName('basics-01-consistent-hashing');
  assert.equal(b.company, 'General'); assert.equal(b.series, 'basics'); assert.equal(b.nn, '01'); assert.equal(b.unsorted, false);
  const s = parseName('acme-alerting');
  assert.equal(s.company, 'Acme'); assert.equal(s.kind, 'other'); assert.equal(s.slug, 'alerting'); assert.equal(s.unsorted, false);
  const u = parseName('sd-model-serving');
  assert.equal(u.unsorted, true); assert.equal(u.company, 'General'); assert.equal(u.slug, 'sd-model-serving');
  assert.equal(parseName('turso-vs-beads').unsorted, true);
  assert.equal(parseName('initech-sd-01-unknown-company').unsorted, true);
});

test('configureNames replaces the companies and general series', () => {
  try {
    configureNames({ companies: { initech: 'Initech' }, generalSeries: ['notes'] });
    assert.equal(parseName('initech-sd-01-x').company, 'Initech');
    assert.equal(parseName('acme-sd-01-x').unsorted, true);
    assert.equal(parseName('notes-01-x').unsorted, false);
    assert.equal(parseName('basics-01-x').unsorted, true);
  } finally {
    configureNames({ companies: { acme: 'Acme', globex: 'Globex' }, generalSeries: ['basics'] });
  }
});
