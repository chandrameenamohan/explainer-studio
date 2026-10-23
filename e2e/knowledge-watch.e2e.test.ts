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
import { companyKey } from '../lib/knowledge.ts';

process.env.STUDIO_FAKE_AGENT = '1';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const cfg = { ...loadConfig(), stateDir: mkdtempSync(path.join(tmpdir(), 'studio-e2e-kw-')), knowledgeRoot: mkdtempSync(path.join(tmpdir(), 'studio-e2e-kw-kg-')) };
const FOLDER = 'sd-model-serving';
let app: StudioServer; let base = ''; let browser: Browser; let page: Page;

const api = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', 'x-studio': '1', origin: base }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json() as any };
};
const dialogOpen = () => page.waitForFunction(() => (document.querySelector('#cmodal') as HTMLDialogElement).open);
const dialogClosed = () => page.waitForFunction(() => !(document.querySelector('#cmodal') as HTMLDialogElement).open);
const val = (sel: string) => page.$eval(sel, e => (e as HTMLInputElement).value);
const setVal = async (sel: string, v: string) => { await page.click(sel, { count: 3 }); await page.keyboard.press('Backspace'); if (v) await page.type(sel, v); };

before(async () => {
  app = createStudioServer(cfg); const runner = installJobRoutes(app, cfg); const { store } = installKnowledgeRoutes(app, cfg, runner); installChatRoutes(app, cfg, store.summaryForVideo);
  base = `http://127.0.0.1:${await app.listen(0)}`;
  const r = await api('POST', '/api/knowledge/concepts', { title: 'Existing idea', inMyWords: 'already here' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  page = await browser.newPage(); await page.setViewport({ width: 1400, height: 900 });
  page.on('pageerror', (e: unknown) => { throw new Error(`page error: ${(e as Error).message}`); });
});
after(async () => {
  await browser?.close(); await app?.close();
  rmSync(cfg.stateDir, { recursive: true, force: true }); rmSync(cfg.knowledgeRoot, { recursive: true, force: true });
});

test('watch page: empty strip, + on a line saves a concept, strip shows the chip', async () => {
  await page.goto(`${base}/v/${FOLDER}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.transcript .line');
  await page.waitForFunction(() => /No concepts saved from this video yet/.test(document.querySelector('#concepts')?.textContent ?? ''));
  const first = await page.$eval('.transcript .line', e => ({ text: e.querySelector('.txt')!.textContent ?? '', start: Number((e as HTMLElement).dataset.start) }));
  await page.hover('.transcript .line');
  await page.click('.transcript .line .plus');
  await dialogOpen();
  assert.equal(await val('#cm-title'), '');
  assert.equal(await val('#cm-quote'), first.text);
  assert.equal(await val('#cm-t'), `${Math.floor(first.start / 60)}:${String(Math.floor(first.start % 60)).padStart(2, '0')}`);
  assert.equal(await val('#cm-status'), 'learning');
  const rec = (await api('GET', `/api/video/${FOLDER}`)).body.record;
  assert.deepEqual(await page.$$eval('#cm-companies input:checked', els => els.map(e => (e as HTMLInputElement).value)), [companyKey(rec)]);
  assert.equal((await page.$$eval('#cm-companies input:checked', els => els.length)), 1);
  assert.ok(await page.$$eval('#cm-related-list option', els => els.some(o => (o as HTMLOptionElement).value === 'Existing idea')));
  await page.type('#cm-title', 'E2E concept');
  assert.equal(await val('#cm-slug'), 'e2e-concept');
  await page.type('#cm-words', 'my words');
  await page.type('#cm-related', 'Existing idea');
  await page.click('#cm-save');
  await dialogClosed();
  await page.waitForFunction(() => /Saved E2E concept/.test(document.querySelector('#toast')?.textContent ?? ''));
  assert.equal(await page.$eval('#toast a', a => a.getAttribute('href')), '/k/e2e-concept');
  const r = await api('GET', '/api/knowledge/concepts/e2e-concept');
  assert.equal(r.status, 200);
  assert.equal(r.body.concept.inMyWords, 'my words');
  assert.equal(r.body.concept.status, 'learning');
  assert.equal(r.body.concept.sources[0].folder, FOLDER);
  assert.equal(r.body.concept.sources[0].quote, first.text.replace(/\s+/g, ' ').replace(/"/g, "'"));
  assert.deepEqual(r.body.concept.related.map((x: { to: string }) => x.to), ['existing-idea']);
  await page.waitForSelector('#concepts a.chip.concept[data-slug="e2e-concept"]');
  assert.equal(await page.$eval('#concepts a.chip.concept[data-slug="e2e-concept"]', a => a.getAttribute('href')), '/k/e2e-concept');
  assert.equal(await page.$eval('#concepts a.chip.concept[data-slug="e2e-concept"] .dot', d => d.classList.contains('learning')), true);
  await page.hover('#concepts a.chip.concept[data-slug="e2e-concept"]');
  await page.waitForFunction(() => document.querySelectorAll('.transcript .line.src').length === 1);
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => document.querySelectorAll('.transcript .line.src').length === 0);
});

test('watch page: saving an existing title switches to add-this-moment and patches the source', async () => {
  await page.goto(`${base}/v/${FOLDER}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.transcript .line:nth-of-type(4)');
  await page.hover('.transcript .line:nth-of-type(4)');
  await page.click('.transcript .line:nth-of-type(4) .plus');
  await dialogOpen();
  await page.type('#cm-title', 'Existing idea');
  await page.type('#cm-words', 'ignored');
  await page.click('#cm-save');
  await page.waitForFunction(() => /Add this moment to Existing idea/.test(document.querySelector('#cm-head')?.textContent ?? ''));
  assert.equal(await page.$eval('#cmodal', d => (d as HTMLDialogElement).open), true);
  await page.click('#cm-save');
  await dialogClosed();
  const r = await api('GET', '/api/knowledge/concepts/existing-idea');
  assert.equal(r.body.concept.inMyWords, 'already here');
  assert.deepEqual(r.body.concept.sources.map((s: { folder: string }) => s.folder), [FOLDER]);
  assert.equal(r.body.concept.companies.length, 1);
  await page.waitForSelector('#concepts a.chip.concept[data-slug="existing-idea"]');
});

test('watch page: s opens the modal from the current line, ignored in inputs, Escape/Cancel closes', async () => {
  await page.goto(`${base}/v/${FOLDER}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.transcript .line');
  await page.click('#chatq'); await page.keyboard.press('s');
  assert.equal(await page.$eval('#cmodal', d => (d as HTMLDialogElement).open), false);
  await page.$eval('#chatq', e => { (e as HTMLTextAreaElement).value = ''; (e as HTMLTextAreaElement).blur(); });
  await page.keyboard.press('s');
  await dialogOpen();
  assert.notEqual(await val('#cm-quote'), '');
  await page.click('#cm-cancel');
  await dialogClosed();
});

test('watch page: Save concept under a chat answer drafts a card', async () => {
  await page.goto(`${base}/v/${FOLDER}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.transcript .line');
  await page.type('#chatq', 'Why a reverse index?');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !(document.querySelector('form button.primary') as HTMLButtonElement).disabled && document.querySelectorAll('.msg.assistant button.savec').length > 0, { timeout: 10000 });
  await page.click('.msg.assistant:last-of-type button.savec');
  await dialogOpen();
  await page.waitForFunction(() => (document.querySelector('#cm-title') as HTMLInputElement).value === 'Fake concept', { timeout: 10000 });
  assert.equal(await val('#cm-slug'), 'fake-concept');
  assert.equal(await val('#cm-words'), '');
  assert.equal(await page.$eval('#cm-words', e => (e as HTMLTextAreaElement).placeholder), 'A concept the fake agent drafted.');
  await page.click('#cm-cancel');
  await dialogClosed();
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.msg.assistant button.savec');
  assert.equal((await api('GET', '/api/knowledge/concepts/fake-concept')).status, 404);
});
