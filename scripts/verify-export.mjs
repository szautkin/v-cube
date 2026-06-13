import { writeFileSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import pngpkg from 'pngjs';
import { gradientCube } from './lib/fitsFixture.mjs';
const { PNG } = pngpkg;
let failures = 0;
const check = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL:'} ${m}`); if (!c) failures++; };

writeFileSync('/tmp/cadc-cube-fixture.fits', gradientCube());
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 }, acceptDownloads: true });
const page = await ctx.newPage();
await page.goto('http://localhost:5180', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
await page.setInputFiles('#fileInput', '/tmp/cadc-cube-fixture.fits');
await page.waitForFunction(() => document.getElementById('chanReadout')?.textContent?.includes('/8'), null, { timeout: 60000 });
await page.waitForTimeout(500);

const box = await (await page.$('#gl')).boundingBox();

// --- slice export 2× with annotations ---
let dl = page.waitForEvent('download');
await page.click('#exportPng2');
let file = await (await dl).path();
let png = PNG.sync.read(readFileSync(file));
const W = Math.round(box.width * 2), H = Math.round(box.height * 2), BAR = Math.round(34 * 2);
check(png.width === W && png.height === H + BAR, `slice 2× dims ${W}×${H + BAR} (got ${png.width}×${png.height})`);
const px = (x, y) => { const o = (Math.round(y) * png.width + Math.round(x)) * 4; return [png.data[o], png.data[o + 1], png.data[o + 2]]; };
// center pixel must match the live canvas center
await (await page.$('#gl')).screenshot({ path: '/tmp/live-center.png' });
const live = PNG.sync.read(readFileSync('/tmp/live-center.png'));
const lo = ((Math.round(live.height / 2) * live.width) + Math.round(live.width / 2)) * 4;
const liveC = [live.data[lo], live.data[lo + 1], live.data[lo + 2]];
const expC = px(W / 2, H / 2);
const d = Math.max(...liveC.map((v, i) => Math.abs(v - expC[i])));
check(d <= 4, `export center pixel matches live render (Δ=${d}, live rgb(${liveC}) vs export rgb(${expC}))`);
// colorbar right end ≈ last inferno stop (252,255,164)
const u = 2, cbW = 150 * u, cbX = png.width - cbW - 12 * u, cbY = H + BAR / 2 - 8 * u + 4 * u;
const cbEnd = px(cbX + cbW - 3, cbY);
check(Math.max(Math.abs(cbEnd[0] - 252), Math.abs(cbEnd[1] - 255), Math.abs(cbEnd[2] - 164)) <= 8, `colorbar hot end ≈ rgb(252,255,164) (got rgb(${cbEnd}))`);

// --- volume export 2× ---
await page.click('#modeSwitch button[data-mode="volume"]');
await page.waitForTimeout(1500);
dl = page.waitForEvent('download');
await page.click('#exportPng2');
const dlObj = await dl;
check(dlObj.suggestedFilename().includes('volume'), `volume filename: ${dlObj.suggestedFilename()}`);
png = PNG.sync.read(readFileSync(await dlObj.path()));
check(png.width === W && png.height === H + BAR, `volume 2× dims (got ${png.width}×${png.height})`);
// volume frame must contain non-background pixels (the rendered box)
let lit = 0;
for (let i = 0; i < W * H * 4; i += 4 * 997) if (png.data[i] + png.data[i + 1] + png.data[i + 2] > 40) lit++;
check(lit > 20, `volume frame has rendered content (${lit} lit samples)`);
writeFileSync('/tmp/cadc-cube-shots/export-volume.png', PNG.sync.write(png));

// --- raw export (annotations off) ---
await page.click('#exportAnnotate');
dl = page.waitForEvent('download');
await page.click('#exportPng2');
png = PNG.sync.read(readFileSync(await (await dl).path()));
check(png.width === W && png.height === H, `raw export has no annotation bar (got ${png.width}×${png.height})`);

// --- transparent background (annotations still off, currently in volume mode) ---
await page.click('#exportTransparent');
dl = page.waitForEvent('download');
await page.click('#exportPng2');
png = PNG.sync.read(readFileSync(await (await dl).path()));
check(png.data[3] === 0, `transparent volume: corner alpha 0 (got ${png.data[3]})`);
let anyAlpha = 0;
for (let i = 3; i < png.data.length; i += 4 * 991) if (png.data[i] > 16) anyAlpha++;
check(anyAlpha > 10, `transparent volume: rendered content carries alpha (${anyAlpha} samples)`);
writeFileSync('/tmp/cadc-cube-shots/export-volume-transparent.png', PNG.sync.write(png));

await page.click('#modeSwitch button[data-mode="slice"]');
await page.waitForTimeout(400);
dl = page.waitForEvent('download');
await page.click('#exportPng2');
png = PNG.sync.read(readFileSync(await (await dl).path()));
const ca = png.data[(Math.round(H / 2) * png.width + Math.round(W / 2)) * 4 + 3];
check(png.data[3] === 0 && ca === 255, `transparent slice: void alpha 0, data quad alpha 255 (got ${png.data[3]}, ${ca})`);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nEXPORT CHECKS PASSED');
process.exitCode = failures ? 1 : 0;
await browser.close();
