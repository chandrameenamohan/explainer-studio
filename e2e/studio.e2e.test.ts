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
const cfg = { ...loadConfig(), stateDir: mkdtempSync(path.join(tmpdir(), 'studio-e2e-')), knowledgeRoot: mkdtempSync(path.join(tmpdir(), 'studio-e2e-kg-')) };
const jobFolder = `e2e-fake-ui-${process.pid}`;
let app: StudioServer; let base = ''; let browser: Browser; let page: Page;

before(async () => {
  app = createStudioServer(cfg); const runner = installJobRoutes(app, cfg); const { store } = installKnowledgeRoutes(app, cfg, runner); installChatRoutes(app, cfg, store.summaryForVideo);
  base = `http://127.0.0.1:${await app.listen(0)}`;
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  page = await browser.newPage(); await page.setViewport({ width: 1400, height: 900 });
  page.on('pageerror', (e: unknown) => { throw new Error(`page error: ${(e as Error).message}`); });
});
after(async () => {
  await browser?.close(); await app?.close();
  rmSync(cfg.stateDir, { recursive: true, force: true }); rmSync(cfg.knowledgeRoot, { recursive: true, force: true });
  rmSync(path.join(cfg.videoRoot, jobFolder), { recursive: true, force: true });
});

test('library lists the videos and search finds a narration line', async () => {
  await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.card');
  const n = await page.$$eval('.card', els => els.length);
  assert.equal(n, 4, `cards: ${n}`);
  await page.type('#q', 'three tweets');
  await page.waitForFunction(() => document.querySelectorAll('.card').length < 4);
  const cards = await page.$$eval('.card', els => els.map(el => ({ href: (el as HTMLAnchorElement).getAttribute('href') ?? '', hit: el.querySelector('.hit')?.textContent ?? '' })));
  const hit = cards.find(c => c.href.startsWith('/v/basics-pagination-worked'));
  assert.ok(hit, JSON.stringify(cards));
  assert.match(hit!.href, /\?t=\d/); assert.match(hit!.hit, /Three tweets/);
  await page.click('#q', { count: 3 }); await page.keyboard.press('Backspace');
  await page.click('[data-company="Acme"]'); await page.click('[data-kind="sd"]');
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 1);
  const only = await page.$$eval('.card', els => els.every(e => /^\/v\/acme-sd-/.test((e as HTMLAnchorElement).getAttribute('href') ?? '')));
  assert.equal(only, true);
});

test('watch page: transcript, video metadata, click-to-seek, chat with seek link', async () => {
  await page.goto(`${base}/v/sd-model-serving`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.transcript .line');
  const lines = await page.$$eval('.transcript .line', els => els.length);
  assert.ok(lines > 20);
  await page.waitForFunction(() => (document.querySelector('#player') as HTMLVideoElement).readyState >= 1, { timeout: 15000 });
  const dur = await page.$eval('#player', v => (v as HTMLVideoElement).duration);
  assert.ok(dur > 200 && dur < 300, `duration ${dur}`);
  await page.click('.transcript .line:nth-of-type(6)');
  await page.waitForFunction(() => (document.querySelector('#player') as HTMLVideoElement).currentTime > 1);
  await page.$eval('#player', v => (v as HTMLVideoElement).pause());
  await page.type('#chatq', 'Why a reverse index?');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /reverse index/.test(document.querySelector('.msg.assistant')?.textContent ?? ''), { timeout: 10000 });
  // the page re-renders the answer on 'done'; wait for the send button to come back before clicking
  await page.waitForFunction(() => !(document.querySelector('form button.primary') as HTMLButtonElement).disabled);
  await page.waitForSelector('.msg.assistant a.seek');
  await page.click('.msg.assistant a.seek');
  await page.waitForFunction(() => Math.abs((document.querySelector('#player') as HTMLVideoElement).currentTime - 5) < 1.5);
  await page.$eval('#player', v => { (v as HTMLVideoElement).currentTime = 33; (v as HTMLVideoElement).pause(); });
  await page.waitForFunction(() => /saved 0:33/.test(document.querySelector('#saved')?.textContent ?? ''));
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.msg.user');
  assert.ok((await page.$$eval('.msg', els => els.length)) >= 2);
  await page.waitForFunction(() => Math.abs((document.querySelector('#player') as HTMLVideoElement).currentTime - 33) < 1.5, { timeout: 15000 });
});

test('watch page: default and theater views, theater video spans the page, choice persists', async () => {
  await page.evaluate(() => { try { localStorage.removeItem('studio.view'); } catch {} });
  await page.goto(`${base}/v/sd-model-serving`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.transcript .line');
  assert.equal(await page.$eval('.watch', e => e.classList.contains('theater')), false);
  const vw = await page.evaluate(() => document.documentElement.clientWidth);
  const defW = (await (await page.$('#player'))!.boundingBox())!.width;
  assert.ok(defW >= 900, `default video width ${defW}`);
  await page.click('#view-theater');
  assert.equal(await page.$eval('.watch', e => e.classList.contains('theater')), true);
  const box = (await (await page.$('#player'))!.boundingBox())!;
  assert.ok(box.width >= 0.95 * vw, `theater video width ${box.width} of ${vw}`);
  const chat = (await (await page.$('#chatform'))!.boundingBox())!;
  assert.ok(chat.y + chat.height <= 900, `chat form bottom ${chat.y + chat.height}`);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.transcript .line');
  assert.equal(await page.$eval('.watch', e => e.classList.contains('theater')), true);
  await page.keyboard.press('t');
  assert.equal(await page.$eval('.watch', e => e.classList.contains('theater')), false);
  assert.equal(await page.evaluate(() => localStorage.getItem('studio.view')), 'default');
});

test('create page: fake job runs and the log shows the pipeline steps', async () => {
  await page.goto(`${base}/create`, { waitUntil: 'networkidle0' });
  await page.type('#folder', jobFolder);
  await page.type('#topic', 'How SSE works');
  await page.type('#outline', '1. hook 30s\n2. body 3m');
  await page.click('#go');
  await page.waitForFunction(() => /tts\.py/.test(document.querySelector('#log')?.textContent ?? ''), { timeout: 10000 });
  await page.waitForFunction(() => /failed|done/.test(document.querySelector('#status')?.textContent ?? ''), { timeout: 10000 });
  assert.match(await page.$eval('#jobmeta', e => e.textContent ?? ''), /no mp4/);
  await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
  await page.type('#q', jobFolder);
  await page.waitForSelector('.card.unrendered');
});
