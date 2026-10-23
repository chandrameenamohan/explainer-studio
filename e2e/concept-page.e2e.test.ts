/// <reference lib="dom" />
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { loadConfig } from '../lib/config.ts';
import { createStudioServer, type StudioServer } from '../server.ts';
import { installChatRoutes } from '../lib/chat.ts';
import { installJobRoutes } from '../lib/jobs.ts';
import { installKnowledgeRoutes } from '../lib/knowledge-routes.ts';

process.env.STUDIO_FAKE_AGENT = '1';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const cfg = { ...loadConfig(), stateDir: mkdtempSync(path.join(tmpdir(), 'studio-e2e-')), knowledgeRoot: mkdtempSync(path.join(tmpdir(), 'studio-e2e-kg-')) };
let app: StudioServer; let base = ''; let browser: Browser; let page: Page;
const H = { 'content-type': 'application/json', 'x-studio': '1' };
const api = (p: string, init: RequestInit = {}) => fetch(`${base}${p}`, { ...init, headers: { ...H, ...(init.headers as object) } });

before(async () => {
  app = createStudioServer(cfg); const runner = installJobRoutes(app, cfg); const { store } = installKnowledgeRoutes(app, cfg, runner); installChatRoutes(app, cfg, store.summaryForVideo);
  base = `http://127.0.0.1:${await app.listen(0)}`;
  const post = (b: object) => api('/api/knowledge/concepts', { method: 'POST', body: JSON.stringify(b), headers: { origin: base } });
  assert.equal((await post({ title: 'E2E Concept', slug: 'e2e-concept', definition: 'A thing', sources: [{ folder: 'basics-pagination-worked', t: 65, quote: 'tenant boundary' }], companies: [{ company: 'acme', why: 'asked there' }], related: [{ type: 'prerequisite', to: 'nothing-yet' }] })).status, 201);
  assert.equal((await post({ title: 'Other Concept', slug: 'other-concept', related: [{ type: 'related', to: 'e2e-concept' }] })).status, 201);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--mute-audio'] });
  page = await browser.newPage(); await page.setViewport({ width: 1400, height: 900 });
  page.on('pageerror', (e: unknown) => { throw new Error(`page error: ${(e as Error).message}`); });
});
after(async () => {
  await browser?.close(); await app?.close();
  rmSync(cfg.stateDir, { recursive: true, force: true }); rmSync(cfg.knowledgeRoot, { recursive: true, force: true });
});

test('concept page: status, words, sources, related, backlinks, delete to trash', async () => {
  await page.goto(`${base}/k/e2e-concept`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#status');
  assert.equal(await page.$eval('h1', e => e.textContent), 'E2E Concept');
  assert.match(await page.$eval('#obsidian', e => (e as HTMLAnchorElement).href), /^obsidian:\/\/open/);
  // sources with seek link
  assert.equal(await page.$eval('#sources a.seek', e => e.getAttribute('href')), '/v/basics-pagination-worked?t=65');
  assert.match(await page.$eval('#sources', e => e.textContent ?? ''), /tenant boundary/);
  assert.match(await page.$eval('#companies', e => e.textContent ?? ''), /asked there/);
  // unresolved related is dashed
  assert.equal(await page.$eval('#related a.unresolved', e => e.getAttribute('title')), 'no file yet');
  // backlink
  assert.equal(await page.$eval('#backlinks a', e => e.getAttribute('href')), '/k/other-concept');
  // status
  await page.select('#status', 'known');
  await page.waitForFunction(async () => (await (await fetch('/api/knowledge/concepts/e2e-concept')).json()).concept.status === 'known');
  await page.reload({ waitUntil: 'networkidle0' });
  assert.equal(await page.$eval('#status', e => (e as HTMLSelectElement).value), 'known');
  // words
  await page.type('#words', 'my own words');
  await page.click('#savewords');
  await page.waitForFunction(() => /saved/.test(document.querySelector('#wordsmsg')?.textContent ?? ''));
  assert.equal((await (await api('/api/knowledge/concepts/e2e-concept')).json() as any).concept.inMyWords, 'my own words');
  // add related
  await page.type('#reltarget', 'dynamic-batching'); await page.select('#reltype', 'contrast'); await page.click('#reladd');
  await page.waitForSelector('#related a[href="/k/dynamic-batching"]');
  // remove source
  await page.click('#sources .rm');
  await page.waitForFunction(() => !document.querySelector('#sources a.seek'));
  assert.equal(((await (await api('/api/knowledge/concepts/e2e-concept')).json() as any).concept.sources).length, 0);
  // stale write -> 409 reload message
  await api('/api/knowledge/concepts/e2e-concept', { method: 'PATCH', body: JSON.stringify({ inMyWords: 'changed elsewhere' }), headers: { origin: base } });
  await page.$eval('#words', e => { (e as HTMLTextAreaElement).value = 'stale edit'; });
  await page.click('#savewords');
  await page.waitForFunction(() => /Changed on disk/.test(document.querySelector('#wordsmsg')?.textContent ?? ''));
  await page.waitForFunction(() => (document.querySelector('#words') as HTMLTextAreaElement).value === 'changed elsewhere');
  // two-step delete
  await page.click('#delete');
  assert.match(await page.$eval('#delete', e => e.textContent ?? ''), /confirm/i);
  await Promise.all([page.waitForNavigation(), page.click('#delete')]);
  assert.match(page.url(), /\/knowledge$/);
  assert.equal((await api('/api/knowledge/concepts/e2e-concept')).status, 404);
  assert.ok(readdirSync(path.join(cfg.knowledgeRoot, '.trash')).some(f => f.startsWith('e2e-concept-')));
  assert.ok(!existsSync(path.join(cfg.knowledgeRoot, 'concepts', 'e2e-concept.md')));
});
