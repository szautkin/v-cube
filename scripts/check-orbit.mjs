import { writeFileSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import pngpkg from 'pngjs';
import { gradientCube } from './lib/fitsFixture.mjs';
const { PNG } = pngpkg;
writeFileSync('/tmp/cadc-cube-fixture.fits', gradientCube());
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
// seed a 3-second idle delay so the test doesn't wait minutes
await ctx.addInitScript(() => localStorage.setItem('cadcCubeIdleOrbit', JSON.stringify({ enabled: true, delaySec: 3 })));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:5180', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.setInputFiles('#fileInput', '/tmp/cadc-cube-fixture.fits');
await page.waitForFunction(() => document.getElementById('chanReadout')?.textContent?.includes('/8'), null, { timeout: 60000 });
await page.click('#modeSwitch button[data-mode="volume"]');
// minimum ray steps — the test asserts motion, not render quality, and
// SwiftShader needs headroom to serve screenshots during continuous orbit
await page.$eval('#steps', (el) => { el.value = '96'; el.dispatchEvent(new Event('input')); });
await page.waitForTimeout(800);

const glBox = await (await page.$('#gl')).boundingBox();
const shot = async (p) => { await page.screenshot({ path: p, clip: glBox }); return PNG.sync.read(readFileSync(p)); };
const diff = (a, b) => { let n = 0; for (let i = 0; i < a.data.length; i += 401 * 4) if (Math.abs(a.data[i] - b.data[i]) > 8) n++; return n; };

// wait past the 3s idle threshold, then sample twice — frames must differ (orbiting)
await page.waitForTimeout(5000);
const a = await shot('/tmp/orbit-a.png');
await page.waitForTimeout(1500);
const b = await shot('/tmp/orbit-b.png');
const moving = diff(a, b);
console.log(`while idle: ${moving} changed samples → ${moving > 30 ? '✓ auto-orbit active' : '✗ FAIL: no rotation'}`);

// interact → rotation must stop immediately (raise the delay first so the
// orbit can't re-engage while we sample stillness)
await page.$eval('#orbitDelay', (el) => { el.value = '300'; el.dispatchEvent(new Event('input')); });
await page.mouse.move(640, 400);
await page.waitForTimeout(4000); // damping decelerates smoothly — let it settle
const c = await shot('/tmp/orbit-c.png');
await page.waitForTimeout(1500);
const d = await shot('/tmp/orbit-d.png');
const still = diff(c, d);
console.log(`after input: ${still} changed samples → ${still < 20 ? '✓ stops on interaction' : '✗ FAIL: still rotating'}`);

// toggle off → no orbit even after idle
await page.click('#autoOrbit');
await page.$eval('#orbitDelay', (el) => { el.value = '30'; el.dispatchEvent(new Event('input')); });
await page.waitForTimeout(5000); // shortest delay re-armed but toggle is off — must stay still
const e1 = await shot('/tmp/orbit-e.png');
await page.waitForTimeout(1500);
const f = await shot('/tmp/orbit-f.png');
const off = diff(e1, f);
console.log(`toggled off: ${off} changed samples → ${off < 20 ? '✓ toggle works' : '✗ FAIL'}`);
console.log('errors:', errors.length ? errors : 'none');
process.exitCode = moving > 30 && still < 20 && off < 20 ? 0 : 1;
await browser.close();
