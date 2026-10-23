/// <reference lib="dom" />
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
const cfg = { ...loadConfig(), stateDir: mkdtempSync(path.join(tmpdir(), 'studio-e2e-kp-')), knowledgeRoot: mkdtempSync(path.join(tmpdir(), 'studio-e2e-kp-kg-')) };
let app: StudioServer; let base = ''; let browser: Browser; let page: Page;

before(async () => {
  app = createStudioServer(cfg); const runner = installJobRoutes(app, cfg); const { store } = installKnowledgeRoutes(app, cfg, runner); installChatRoutes(app, cfg, store.summaryForVideo);
  base = `http://127.0.0.1:${await app.listen(0)}`;
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--mute-audio'] });
  page = await browser.newPage(); await page.setViewport({ width: 1400, height: 900 });
  page.on('pageerror', (e: unknown) => { throw new Error(`page error: ${(e as Error).message}`); });
});
after(async () => {
  await browser?.close(); await app?.close();
  rmSync(cfg.stateDir, { recursive: true, force: true }); rmSync(cfg.knowledgeRoot, { recursive: true, force: true });
});

test('knowledge page: empty vault, filters, search, seed panel with progress', async () => {
  await page.goto(`${base}/knowledge`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /videos seeded/.test(document.querySelector('#seedcount')?.textContent ?? ''));
  assert.match(await page.$eval('.nothing', e => e.textContent ?? ''), /Nothing saved yet\. Seed from the videos or press \+ on a transcript line\./);
  assert.match(await page.$eval('#seedcount', e => e.textContent ?? ''), /^0 of \d+ videos seeded$/);

  const r = await fetch(`${base}/api/knowledge/concepts`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-studio': '1' },
    body: JSON.stringify({ title: 'E2E concept', slug: 'e2e-concept', inMyWords: 'my own words about it', status: 'learning', companies: [{ company: 'globex', why: 'asked' }] }) });
  assert.equal(r.status, 201);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('a.kcard[href="/k/e2e-concept"]');
  await page.click('[data-status="learning"]');
  await page.waitForSelector('a.kcard[href="/k/e2e-concept"]');
  await page.click('[data-status="learning"]');
  await page.type('#q', 'zzz');
  await page.waitForSelector('.empty');
  await page.click('#q', { count: 3 }); await page.keyboard.press('Backspace');
  await page.waitForSelector('a.kcard[href="/k/e2e-concept"]');

  await page.$eval('#limit', (e) => { (e as HTMLInputElement).value = '1'; });
  await page.click('#seedgo');
  await page.waitForFunction(() => /^1 of /.test(document.querySelector('#seedcount')?.textContent ?? ''), { timeout: 5000 });
  await page.waitForSelector('a.kcard[href="/k/dynamic-batching"]', { timeout: 5000 });
  assert.ok(await page.$eval('#seedlog', e => /\+/.test(e.textContent ?? '')));
  assert.equal(await page.$eval('a[href^="obsidian://"]', e => e.getAttribute('href')?.startsWith('obsidian://open?vault=') ?? false), true);
});
