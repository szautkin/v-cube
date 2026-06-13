// Render the three README hero images from real cubes in data_cubes/.
// Local-only (hardcoded data paths); not committed.
import { chromium } from 'playwright';

const DATA = '/Users/szautkin/projects/cadc-cube/data_cubes';
const OUT = '/Users/szautkin/projects/cadc-cube/docs/images';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 })).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto('http://localhost:5180', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

async function load(path, totalToken, timeout = 300000) {
  await page.setInputFiles('#fileInput', path);
  await page.waitForFunction((t) => document.getElementById('chanReadout')?.textContent?.includes(t), totalToken, {
    timeout,
  });
  await page.waitForTimeout(1200);
}
const setColormap = (i) => page.click(`#cmapRow .swatch:nth-child(${i})`); // 1 viridis 2 inferno 3 magma 4 plasma 5 gray
const setStretch = (label) => page.click(`#stretchRow button:has-text("${label}")`);
const setChannelFrac = async (f) => {
  const box = await (await page.$('#scrubTrack')).boundingBox();
  await page.mouse.click(box.x + box.width * f, box.y + box.height / 2);
  await page.waitForTimeout(800);
};

// ---- v-cube-1: MOS_049 Galactic-plane SLICE ----
console.log('v-cube-1: MOS_049 slice…');
await load(`${DATA}/MOS_049.Tb.fits`, '/340');
await setColormap(1); // viridis
await setStretch('ASINH');
await setChannelFrac(0.5);
await page.mouse.move(840, 500);
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/v-cube-1.png` });
console.log('  dims', await page.textContent('#ciDims'), '| spec', await page.textContent('#specReadout'));

// ---- v-cube-2: DRAGONS Faraday VOLUME ----
console.log('v-cube-2: DRAGONS volume…');
await load(`${DATA}/dragons_FDF_clean_tot_Kgal.car.32bit.fits`, '/801');
await setColormap(4); // plasma
await setStretch('ASINH');
await page.click('#modeSwitch button[data-mode="volume"]');
await page.waitForTimeout(2500);
// nudge the density a touch and let it settle
await page.screenshot({ path: `${OUT}/v-cube-2.png` });
console.log('  dims', await page.textContent('#ciDims'));

// ---- v-cube-3: JCMT CO figure PLATE ----
console.log('v-cube-3: JCMT figure plate…');
await load(`${DATA}/JCMT/jcmth20260604_00047_06_reduced001_obs_000.fits`, '/3872');
await setColormap(2); // inferno
await setStretch('ASINH');
await page.click('#modeSwitch button[data-mode="volume"]');
await page.waitForTimeout(2000);
await page.click('#plateBtn');
await page.waitForTimeout(1500);
// screenshot just the composed plate canvas (the publication artifact)
await (await page.$('#plateCanvas')).screenshot({ path: `${OUT}/v-cube-3.png` });
console.log('  plate done');

console.log('errors:', errs.length ? errs : 'none');
await browser.close();
