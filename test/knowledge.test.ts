import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../lib/config.ts';
import { readRecord, loadOverrides, type CatalogRecord } from '../lib/catalog.ts';
import {
  SLUG_RE, EDGE_TYPES, slugify, parseLink, parseConcept, serializeConcept, newConcept,
  parseCompany, serializeCompany, videoStub, companyKey, fmtTime,
} from '../lib/knowledge.ts';

const EXAMPLE = `---
title: Dynamic batching
aliases:
  - batching
tags:
  - concept
status: fuzzy
origin: seed
definition: Grouping requests so one GPU pass serves many.
created: 2026-10-13
updated: 2026-10-13
---
## In my words

Batch requests so the GPU is busy.

## From the videos

- [[sd-model-serving]] @0:43 — "One GPU serves 100 requests a second."
- [[videos/globex-sd-03-ingest|ingest]]
> agent note

## Companies

- [[globex]] — ingest batches events before the write.
- [[acme]]

## Related

- prerequisite: [[gpu-utilization]]
- part-of: [[concepts/model-serving#Why]]

## My notes

free text
`;

test('slugify', () => {
  assert.equal(slugify('Dynamic Batching!'), 'dynamic-batching');
  assert.equal(slugify('  A  b  '), 'a-b');
  assert.equal(slugify('3 phase commit'), '3-phase-commit');
  const long = slugify('x'.repeat(40) + ' ' + 'y'.repeat(39));
  assert.equal(long.length, 61);
  assert.match(long, SLUG_RE);
  assert.ok(!slugify('a'.repeat(60) + ' b c').endsWith('-'));
  assert.equal(slugify('--Hello--'), 'hello');
});

test('parseLink variants', () => {
  assert.equal(parseLink('[[x]]'), 'x');
  assert.equal(parseLink('[[concepts/x|label]]'), 'x');
  assert.equal(parseLink('[[x#h]]'), 'x');
  assert.equal(parseLink('[[videos/sd-model-serving]]'), 'sd-model-serving');
  assert.equal(parseLink('[[x#h|label]]'), 'x');
  assert.equal(parseLink('plain'), null);
  assert.equal(parseLink('[[]]'), null);
  assert.equal(parseLink('[[|label]]'), null);
});

test('parseConcept reads frontmatter, edges, extra lines and other sections', () => {
  const c = parseConcept('dynamic-batching', EXAMPLE);
  assert.equal(c.title, 'Dynamic batching');
  assert.deepEqual(c.aliases, ['batching']);
  assert.deepEqual(c.tags, ['concept']);
  assert.equal(c.status, 'fuzzy'); assert.equal(c.origin, 'seed');
  assert.equal(c.definition, 'Grouping requests so one GPU pass serves many.');
  assert.equal(c.created, '2026-10-13');
  assert.equal(c.inMyWords, 'Batch requests so the GPU is busy.');
  assert.deepEqual(c.sources, [
    { folder: 'sd-model-serving', t: 43, quote: 'One GPU serves 100 requests a second.', raw: '[[sd-model-serving]]' },
    { folder: 'globex-sd-03-ingest', t: null, quote: '', raw: '[[videos/globex-sd-03-ingest|ingest]]' },
  ]);
  assert.deepEqual(c.extra, { sources: ['> agent note'], companies: [], related: [] });
  assert.deepEqual(c.companies, [
    { company: 'globex', why: 'ingest batches events before the write.', raw: '[[globex]]' },
    { company: 'acme', why: '', raw: '[[acme]]' },
  ]);
  assert.deepEqual(c.related, [
    { type: 'prerequisite', to: 'gpu-utilization', raw: '[[gpu-utilization]]' },
    { type: 'part-of', to: 'model-serving', raw: '[[concepts/model-serving#Why]]' },
  ]);
  assert.equal(c.otherSections, '## My notes\n\nfree text');
  assert.deepEqual(c.frontmatterExtra, {});
});

test('serializeConcept round-trips the example byte for byte', () => {
  const c = parseConcept('dynamic-batching', EXAMPLE);
  const s = serializeConcept(c);
  assert.equal(s, EXAMPLE);
  assert.deepEqual(parseConcept('dynamic-batching', s), c);
});

test('round trip keeps frontmatter extras and drops nothing when edited', () => {
  const md = EXAMPLE.replace('updated: 2026-10-13\n', 'updated: 2026-10-13\nfoo: 1\ncssclasses:\n  - wide\n');
  const c = parseConcept('dynamic-batching', md);
  assert.deepEqual(c.frontmatterExtra, { foo: 1, cssclasses: ['wide'] });
  c.related.push({ type: 'contrast', to: 'static-batching', raw: '' });
  c.sources[0].raw = '';
  const s = serializeConcept(c);
  assert.match(s, /^foo: 1$/m);
  assert.match(s, /^- contrast: \[\[static-batching\]\]$/m);
  assert.match(s, /^- \[\[sd-model-serving\]\] @0:43 — "One GPU serves 100 requests a second\."$/m);
  assert.match(s, /^> agent note$/m);
  assert.match(s, /## My notes\n\nfree text\n$/);
  const back = parseConcept('dynamic-batching', s);
  const strip = (x: typeof c) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'raw' ? undefined : v)));
  assert.deepEqual(strip(back), strip(c));
});

test('missing sections and frontmatter defaults', () => {
  const c = parseConcept('x-y', '---\ntitle: X Y\n---\nsome text?\n');
  assert.equal(c.status, 'fuzzy'); assert.equal(c.origin, 'manual');
  assert.deepEqual(c.aliases, []); assert.deepEqual(c.tags, []);
  assert.equal(c.definition, ''); assert.equal(c.inMyWords, '');
  assert.deepEqual(c.sources, []); assert.deepEqual(c.companies, []); assert.deepEqual(c.related, []);
  assert.equal(c.otherSections, 'some text?');
  assert.deepEqual(parseConcept('x-y', serializeConcept(c)), c, 'text before the first heading stays put');
  const quoted = newConcept({ slug: 'q-x', title: 'Q', sources: [{ folder: 'f', t: 5, quote: 'say "hi" now', raw: '' }] });
  assert.deepEqual(parseConcept('q-x', serializeConcept(quoted)).sources, [{ folder: 'f', t: 5, quote: 'say "hi" now', raw: '[[f]]' }]);
  const bare = parseConcept('x-y', '---\ntitle: X Y\n---\n');
  assert.deepEqual(parseConcept('x-y', serializeConcept(bare)), bare);
  const noTitle = parseConcept('x-y', '---\nstatus: known\n---\n## In my words\n\nmine\n');
  assert.equal(noTitle.title, 'x-y'); assert.equal(noTitle.status, 'known'); assert.equal(noTitle.inMyWords, 'mine');
  const crlf = parseConcept('x-y', '---\r\ntitle: X\r\n---\r\n## Related\r\n\r\n- example: [[z]]\r\n');
  assert.deepEqual(crlf.related, [{ type: 'example', to: 'z', raw: '[[z]]' }]);
  const headingsCase = parseConcept('x-y', '---\ntitle: X\n---\n## in MY words\n\nhi\n## related\n- bogus: [[q]]\n');
  assert.equal(headingsCase.inMyWords, 'hi');
  assert.deepEqual(headingsCase.extra.related, ['- bogus: [[q]]']);
});

test('bad frontmatter throws', () => {
  assert.throws(() => parseConcept('x', 'no frontmatter here'), /no frontmatter/);
  assert.throws(() => parseConcept('x', '---\ntitle: [unclosed\n---\n'));
  assert.throws(() => parseConcept('x', '---\ntitle: x\n'), /no frontmatter/);
  assert.throws(() => parseConcept('x', '---\n- a\n- b\n---\n'), /frontmatter/);
});

test('newConcept fills defaults and today', () => {
  const c = newConcept({ slug: 'warm-replicas', title: 'Warm replicas', definition: 'd' });
  assert.equal(c.status, 'fuzzy'); assert.equal(c.origin, 'manual'); assert.equal(c.definition, 'd');
  assert.match(c.created, /^\d{4}-\d{2}-\d{2}$/); assert.equal(c.updated, c.created);
  assert.deepEqual(c.extra, { sources: [], companies: [], related: [] });
  assert.deepEqual(parseConcept(c.slug, serializeConcept(c)), c);
  assert.throws(() => newConcept({ slug: 'Bad Slug', title: 'x' }), /slug/);
  assert.deepEqual([...EDGE_TYPES], ['prerequisite', 'contrast', 'example', 'part-of', 'related']);
});

test('company note round trip', () => {
  const md = '---\ntitle: Globex\nkind: company\ngenerated: false\nfoo: bar\n---\n## What they care about\n\nevent ingestion\n\n## Rounds\n\n- [[globex-sd-01-overview]] system design #01\n';
  const n = parseCompany('globex', md);
  assert.equal(n.key, 'globex'); assert.equal(n.title, 'Globex'); assert.equal(n.generated, false);
  assert.deepEqual(n.frontmatterExtra, { foo: 'bar' });
  assert.match(n.body, /event ingestion/);
  assert.equal(serializeCompany(n), md);
  assert.equal(parseCompany('x', '---\ngenerated: true\n---\n').generated, true);
  assert.equal(parseCompany('x', '---\ngenerated: true\n---\n').title, 'x');
});

const cfg = loadConfig();
const overrides = loadOverrides(path.join(cfg.studioDir, 'catalog.overrides.json'));
const rec = (f: string) => readRecord(cfg.videoRoot, f, overrides) as CatalogRecord;

test('companyKey uses series, general for unsorted and non-company series', () => {
  assert.equal(companyKey(rec('acme-sd-01-rate-limiter')), 'acme');
  assert.equal(companyKey(rec('globex-beh-01-biggest-failure')), 'globex');
  assert.equal(companyKey(rec('basics-pagination-worked')), 'basics');
  assert.equal(companyKey(rec('sd-model-serving')), 'general');
  assert.equal(companyKey({ series: 'basics', unsorted: false }), 'basics');
  assert.equal(companyKey({ series: 'whatever', unsorted: true }), 'general');
});

test('videoStub is deterministic and quotes strings', () => {
  const r = rec('sd-model-serving');
  const a = videoStub(r, 'http://127.0.0.1:4310/');
  assert.equal(a, videoStub(r, 'http://127.0.0.1:4310'));
  assert.match(a, /^---\ntitle: ".+"\ncompany: general\nkind: sd\nduration: "\d+:\d\d"\nstudio: http:\/\/127\.0\.0\.1:4310\/v\/sd-model-serving\ngenerated: true\n---\nScenes: .+ · .+\n$/);
  assert.equal(fmtTime(43), '0:43'); assert.equal(fmtTime(130.7), '2:10');
});
