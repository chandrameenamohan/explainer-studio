// Step explainer.html frame by frame in headless Chrome and pipe the frames to ffmpeg.
//   node render.mjs out.mp4            full video with narration.wav
//   node render.mjs --stills dir 5 20  PNG stills at the given seconds (for checking layout)
// Needs puppeteer-core resolvable from this script, or set PUPPETEER_FROM to a folder whose
// node_modules holds it (the studio checkout works). CHROME overrides the Chrome binary path.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(process.env.PUPPETEER_FROM ? process.env.PUPPETEER_FROM + '/' : import.meta.url);
const puppeteer = require('puppeteer-core');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FPS = 30;
const WORKERS = 4;
const args = process.argv.slice(2);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars', '--force-color-profile=srgb'] });
const openPage = async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  page.on('pageerror', e => { console.error('page error:', e.message); process.exitCode = 1; });
  await page.goto(pathToFileURL(path.join(HERE, 'explainer.html')).href + '?render=1', { timeout: 0 });
  await page.waitForFunction('window.READY === true', { timeout: 0 });
  return page;
};

if (args[0] === '--stills') {
  const dir = args[1];
  mkdirSync(dir, { recursive: true });
  const page = await openPage();
  for (const t of args.slice(2).map(Number)) {
    await page.evaluate(t => window.renderAt(t), t);
    await page.screenshot({ path: path.join(dir, `t${String(t).padStart(5, '0')}.png`) });
  }
  await browser.close();
  process.exit();
}

const out = path.resolve(args[0] || 'out.mp4');
const tmp = path.dirname(out);
const first = await openPage();
const duration = await first.evaluate('window.DURATION');
const frames = Math.ceil(duration * FPS);
const per = Math.ceil(frames / WORKERS);
let done = 0;

// Each worker renders one contiguous slice to its own silent segment.
// Open every page before rendering starts: on a busy machine a late page load can time out.
const pages = [first];
for (let w = 1; w < WORKERS; w++) pages.push(await openPage());
const segments = await Promise.all(Array.from({ length: WORKERS }, async (_, w) => {
  const page = pages[w];
  const seg = path.join(tmp, `.seg${w}.mp4`);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', seg], { stdio: ['pipe', 'inherit', 'inherit'] });
  for (let f = w * per; f < Math.min(frames, (w + 1) * per); f++) {
    await page.evaluate(t => window.renderAt(t), f / FPS);
    const jpg = await page.screenshot({ type: 'jpeg', quality: 95, optimizeForSpeed: true });
    if (!ff.stdin.write(jpg)) await once(ff.stdin, 'drain');
    if (++done % 300 === 0) console.log(`${done}/${frames} frames`);
  }
  ff.stdin.end();
  const [code] = await once(ff, 'close');
  if (code) throw new Error(`ffmpeg segment ${w} exited ${code}`);
  return seg;
}));
await browser.close();

const mux = spawn('ffmpeg', ['-y', '-loglevel', 'error',
  ...segments.flatMap(s => ['-i', s]), '-i', path.join(HERE, 'narration.wav'),
  '-filter_complex', `${segments.map((_, i) => `[${i}:v]`).join('')}concat=n=${segments.length}:v=1:a=0[v]`,
  '-map', '[v]', '-map', `${segments.length}:a`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-shortest', out], { stdio: 'inherit' });
const [code] = await once(mux, 'close');
for (const s of segments) spawn('rm', ['-f', s]);
if (code) throw new Error(`ffmpeg mux exited ${code}`);
console.log(`wrote ${out} (${frames} frames, ${duration.toFixed(1)}s)`);
process.exit();
