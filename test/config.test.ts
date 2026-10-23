import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '../lib/config.ts';

const SHIPPED = path.join(import.meta.dirname, '..', 'studio.config.json');

test('loadConfig resolves paths to absolute and finds the video root', () => {
  const c = loadConfig();
  assert.ok(path.isAbsolute(c.repoRoot));
  assert.ok(path.isAbsolute(c.videoRoot));
  assert.ok(path.isAbsolute(c.stateDir));
  assert.ok(existsSync(path.join(c.videoRoot, 'sd-model-serving', 'timeline.json')));
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.port, 4399);
  assert.equal(c.chatConcurrency, 2);
  assert.ok(c.briefsDir.endsWith(path.join('test', 'fixtures', 'briefs')));
  assert.deepEqual(c.companies, { acme: 'Acme', globex: 'Globex' });
});

test('the shipped config uses repo-local paths and port 4310', () => {
  const c = loadConfig(SHIPPED);
  const root = path.dirname(SHIPPED);
  assert.equal(c.repoRoot, root);
  assert.equal(c.videoRoot, path.join(root, 'videos'));
  assert.equal(c.knowledgeRoot, path.join(root, 'knowledge'));
  assert.equal(c.briefsDir, path.join(root, 'briefs'));
  assert.equal(c.port, 4310);
  assert.equal(c.claudePath, null);
  loadConfig(); // restore the test config's names
});

test('loadConfig honours STUDIO_CONFIG override file', () => {
  const c = loadConfig(path.join(import.meta.dirname, 'fixtures', 'config.alt.json'));
  assert.equal(c.port, 4999);
  assert.ok(c.videoRoot.endsWith('/examples'));
  assert.deepEqual(c.companies, {});
  assert.deepEqual(c.generalSeries, ['basics']);
  loadConfig(); // restore the test config's names
});

test('loadConfig adds knowledge vault fields with defaults', () => {
  const c = loadConfig();
  assert.ok(path.isAbsolute(c.knowledgeRoot));
  assert.ok(c.knowledgeRoot.endsWith('/.test-tmp/knowledge'));
  assert.equal(c.seedModel, 'sonnet');
  assert.equal(c.seedBudgetUsd, 15);
  assert.equal(c.draftBudgetUsd, 0.1);
  assert.equal(c.vaultName, 'knowledge');
  const alt = loadConfig(path.join(import.meta.dirname, 'fixtures', 'config.alt.json'));
  assert.ok(path.isAbsolute(alt.knowledgeRoot));
  assert.equal(alt.seedModel, 'sonnet');
  assert.ok(alt.knowledgeRoot.endsWith('/knowledge'));
  loadConfig(); // restore the test config's names
});
