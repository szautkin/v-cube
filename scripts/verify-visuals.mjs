/**
 * Pixel-truth harness — proves the rendered visuals match the numbers.
 *
 * A synthetic cube with analytically known voxel values (v = x + 16y + 256z)
 * is loaded through the real app. We then assert, with hard failures:
 *   1. the probe FLUX/PX readouts equal the known voxel values exactly,
 *   2. the actual canvas pixel colors equal colormap(stretch(normalize(v)))
 *      computed independently on the CPU (within sRGB/LUT tolerance),
 *   3. NaN voxels render the void color,
 *   4. the volume click-pick lands on the analytically brightest channel,
 *   5. axis captions show the fixture's WCS.
 */
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import pngpkg from 'pngjs';
import { gradientCube, gradientValue } from './lib/fitsFixture.mjs';

const { PNG } = pngpkg;
const NX = 16, NY = 16, NZ = 8;
const FIXTURE = '/tmp/cadc-cube-fixture.fits';
let failures = 0;
const check = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗ FAIL:'} ${msg}`);
  if (!cond) failures++;
};

/* ---- CPU reference implementations (mirrors of src/render math) ---- */

const INFERNO = ['#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9b06', '#f7d13d', '#fcffa4'];
const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
function lut256(stops) {
  const s = stops.map(hex);
  const out = [];
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (s.length - 1);
    const a = Math.min(s.length - 2, Math.floor(t));
    const f = t - a;
    out.push([0, 1, 2].map((c) => s[a][c] * (1 - f) + s[a + 1][c] * f));
  }
  return out;
}
const asinhStretch = (v) => Math.asinh(Math.min(Math.max(v, 0), 1) * 10) / 2.998;
const s2l = (c) => ((c /= 255), c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const l2s = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** GPU linear-filter sample of the 256-LUT at coord s, raw or sRGB-aware. */
function sampleLut(lutArr, s, srgbAware) {
  const u = Math.min(Math.max(s * 256 - 0.5, 0), 255);
  const i0 = Math.min(254, Math.floor(u));
  const f = u - i0;
  return [0, 1, 2].map((c) => {
    const a = lutArr[i0][c];
    const b = lutArr[i0 + 1][c];
    return srgbAware ? l2s(s2l(a) * (1 - f) + s2l(b) * f) : a * (1 - f) + b * f;
  });
}

// computeStats mirror over the fixture's exact value population
function statsRef() {
  const vals = [];
  for (let z = 0; z < NZ; z++)
    for (let y = 0; y < NY; y++)
      for (let x = 0; x < NX; x++) if (!(x === 0 && y === 0)) vals.push(gradientValue(x, y, z));
  vals.sort((a, b) => a - b);
  const q = (f) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(f * (vals.length - 1))))];
  return { lo: q(0.001), hi: q(0.999) };
}

/* ---- drive ---- */

writeFileSync(FIXTURE, gradientCube(NX, NY, NZ));
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1680, height: 1000 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:5180', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
await page.setInputFiles('#fileInput', FIXTURE);
await page.waitForFunction(() => document.getElementById('chanReadout')?.textContent?.includes('/8'), null, { timeout: 60000 });
await page.waitForTimeout(600);

console.log('— probe truth (CPU value path)');
const box = await (await page.$('#gl')).boundingBox();
const aspect = box.width / box.height;
const zoom = Math.max(NX / 2, (NY / 2) * aspect) * 1.06; // mirror of SliceView.fit
const halfH = zoom / aspect;
const toScreen = (wx, wy) => [box.x + (box.width * (wx + zoom)) / (2 * zoom), box.y + (box.height * (halfH - wy)) / (2 * halfH)];

const [sx, sy] = toScreen(0.5, 0.5); // center of voxel (8, 8)
await page.mouse.move(sx, sy);
await page.waitForTimeout(250);
const ch = 4; // middle channel of 8
const expectFlux = gradientValue(8, 8, ch);
check((await page.textContent('#prFlux')) === `${expectFlux.toPrecision(5)} JY`, `FLUX reads ${expectFlux.toPrecision(5)} JY (got "${await page.textContent('#prFlux')}")`);
check((await page.textContent('#prPx')) === `8, 8, ${ch}`, `PX reads 8, 8, ${ch}`);
// voxel (8,8) center is 0.5 px past CRPIX (which sits between voxels 7 and 8) → RA = 179.5°
check((await page.textContent('#prRa')) === '11:58:00.00', `RA half a pixel past CRPIX reads 11:58:00.00 (got "${await page.textContent('#prRa')}")`);

console.log('— pixel truth (GPU render path)');
await (await page.$('#gl')).screenshot({ path: '/tmp/cadc-cube-shots/truth-slice.png' });
const png = PNG.sync.read(await import('node:fs').then((fs) => fs.readFileSync('/tmp/cadc-cube-shots/truth-slice.png')));
const pixel = (cx, cy) => {
  const ix = Math.round((cx - box.x) * (png.width / box.width));
  const iy = Math.round((cy - box.y) * (png.height / box.height));
  const o = (iy * png.width + ix) * 4;
  return [png.data[o], png.data[o + 1], png.data[o + 2]];
};
const { lo, hi } = statsRef();
const s = asinhStretch((expectFlux - lo) / (hi - lo));
const lutArr = lut256(INFERNO);
const got = pixel(sx, sy);
const expRaw = sampleLut(lutArr, s, false);
const expSrgb = sampleLut(lutArr, s, true);
const dist = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const dRaw = dist(got, expRaw);
const dSrgb = dist(got, expSrgb);
console.log(`  rendered rgb(${got}) | raw-lerp rgb(${expRaw.map(Math.round)}) Δ${dRaw.toFixed(1)} | srgb-lerp rgb(${expSrgb.map(Math.round)}) Δ${dSrgb.toFixed(1)}`);
check(Math.min(dRaw, dSrgb) <= 6, `pixel color matches CPU colormap(stretch(norm(v))) within ±6 (Δ=${Math.min(dRaw, dSrgb).toFixed(1)}, model=${dRaw <= dSrgb ? 'raw' : 'srgb'})`);

const [nx0, ny0] = toScreen(-7.5, -7.5); // center of NaN voxel (0, 0)
const nanPx = pixel(nx0, ny0);
check(dist(nanPx, [4, 7, 10]) <= 3, `NaN voxel renders void color rgb(4,7,10) (got rgb(${nanPx}))`);

console.log('— volume link truth');
await page.click('#modeSwitch button[data-mode="volume"]');
await page.waitForTimeout(1500);
const caps = await page.$$eval('.axis-cap', (els) => els.map((e) => e.textContent));
check(JSON.stringify(caps) === JSON.stringify(['RA', 'DEC', 'FREQ GHz']), `axis captions [RA, DEC, FREQ GHz] (got [${caps}])`);
check((await page.$$eval('.axis-tick', (e) => e.length)) === 6, 'six axis endpoint ticks');
await (await page.$('#viewport')).screenshot({ path: '/tmp/cadc-cube-shots/truth-volume.png' });
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(500);
const chText = await page.textContent('#chanReadout');
check(chText === 'CH 8/8', `volume pick locks the analytically brightest channel (CH 8/8, got "${chText}")`);

check(errors.length === 0, `no page errors (${errors.length ? errors : 'clean'})`);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL VISUAL-TRUTH CHECKS PASSED');
process.exitCode = failures ? 1 : 0;
await browser.close();
