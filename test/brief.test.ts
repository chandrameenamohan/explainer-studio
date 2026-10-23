import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../lib/config.ts';
import { fillBrief, listSharedBriefs, loadTemplate, FOLDER_RE } from '../lib/brief.ts';

const cfg = loadConfig();
const where = { repoRoot: cfg.repoRoot, videoDir: 'examples', studioDir: cfg.studioDir };

test('FOLDER_RE', () => {
  assert.ok(FOLDER_RE.test('basics-sse-streaming')); assert.ok(!FOLDER_RE.test('Bad Name')); assert.ok(!FOLDER_RE.test('../x')); assert.ok(!FOLDER_RE.test('ab'));
});

test('listSharedBriefs lists <briefsDir>/*.md by stem, relative to repoRoot when inside it', () => {
  const b = listSharedBriefs(cfg.briefsDir, cfg.repoRoot);
  assert.deepEqual(b, [{ path: 'test/fixtures/briefs/acme.md', label: 'acme' }]);
  assert.deepEqual(listSharedBriefs(cfg.briefsDir, '/elsewhere'), [{ path: path.join(cfg.briefsDir, 'acme.md'), label: 'acme' }]);
  assert.deepEqual(listSharedBriefs(path.join(cfg.repoRoot, 'briefs'), cfg.repoRoot), [], 'README.md is not a brief');
  assert.deepEqual(listSharedBriefs(path.join(cfg.repoRoot, 'no-such-dir'), cfg.repoRoot), []);
});

test('fillBrief substitutes every placeholder', () => {
  const out = fillBrief(loadTemplate(cfg.studioDir), { folder: 'basics-sse', topic: 'How SSE works', outline: '1. hook 30s\n2. body 3m', sharedBrief: 'briefs/acme.md', extraRules: 'Keep it under 4 minutes.', ...where });
  assert.ok(!out.includes('{{'));
  assert.match(out, /folder `examples\/basics-sse\/`/);
  assert.match(out, /Read `briefs\/acme.md` first/);
  assert.ok(out.includes(`copy \`${cfg.studioDir}/pipeline/tts.py\``));
  assert.ok(out.includes(`${cfg.studioDir}/pipeline/heavy.sh node render.mjs`));
  assert.ok(out.includes(`${cfg.studioDir}/examples/sd-model-serving/`));
  assert.match(out, /## The topic\nHow SSE works/);
  assert.match(out, /node render.mjs basics-sse.mp4/);
  assert.match(out, /Keep it under 4 minutes\./);
  const none = fillBrief(loadTemplate(cfg.studioDir), { folder: 'x-y-z', topic: 't', outline: 'o', sharedBrief: null, extraRules: '', ...where });
  assert.ok(!none.includes('{{')); assert.ok(!none.includes('first and follow it'));
});

test('fillBrief throws on an unknown placeholder', () => {
  assert.throws(() => fillBrief('hello {{nope}}', { folder: 'a-b-c', topic: '', outline: '', sharedBrief: null, extraRules: '', repoRoot: '/', videoDir: 'v', studioDir: '/' }), /nope/);
});

test('R01: fillBrief keeps user text that contains {{ verbatim', () => {
  const out = fillBrief(loadTemplate(cfg.studioDir), { folder: 'basics-jinja', topic: 'Jinja {{ var }} templates', outline: '1. show {{name}} and {{folder}}', sharedBrief: null, extraRules: 'no {{', ...where });
  assert.match(out, /Jinja \{\{ var \}\} templates/);
  assert.match(out, /show \{\{name\}\} and \{\{folder\}\}/);
  assert.throws(() => fillBrief('hi {{ broken', { folder: 'a-b-c', topic: '', outline: '', sharedBrief: null, extraRules: '', repoRoot: '/', videoDir: 'v', studioDir: '/' }), /unfilled placeholder/);
});
