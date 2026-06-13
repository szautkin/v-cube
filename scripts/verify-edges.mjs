import { writeFileSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import pngpkg from 'pngjs';
import { gradientCube } from './lib/fitsFixture.mjs';
const { PNG } = pngpkg;
writeFileSync('/tmp/cadc-cube-fixture.fits', gradientCube());
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1680, height: 1000 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:5180', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
await page.setInputFiles('#fileInput', '/tmp/cadc-cube-fixture.fits');
await page.waitForFunction(() => document.getElementById('chanReadout')?.textContent?.includes('/8'), null, { timeout: 60000 });
await page.click('#modeSwitch button[data-mode="volume"]');
await page.waitForTimeout(1200);

// count amber-ish edge pixels at width 1 vs width 3.5 with amber accent
const countAmber = async (tag) => {
  // Only the top-right quadrant, where box edges cross empty space — the
  // volume's own orange falloff would otherwise pollute the count.
  await (await page.$('#gl')).screenshot({ path: `/tmp/edge-${tag}.png` });
  const png = PNG.sync.read(readFileSync(`/tmp/edge-${tag}.png`));
  let n = 0;
  for (let y = Math.floor(png.height * 0.05); y < png.height * 0.4; y++) {
    for (let x = Math.floor(png.width * 0.65); x < png.width * 0.98; x++) {
      const i = (y * png.width + x) * 4;
      const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
      if (r > 140 && g > 80 && g < 190 && b < 100) n++;
    }
  }
  return n;
};
await page.click('#styleBtn');
await page.click('#styleColor .color-swatch[data-v="#ffb454"]');
await page.click('#styleClose');
await page.waitForTimeout(600);
const thin = await countAmber('thin');
await page.click('#styleBtn');
await page.$eval('#styleEdge', (el) => { el.value = '350'; el.dispatchEvent(new Event('input')); });
await page.click('#styleClose');
await page.waitForTimeout(600);
const thick = await countAmber('thick');
console.log(`amber edge pixels: width 1.0 → ${thin}, width 3.5 → ${thick}`);
console.log(thick > thin * 2 ? '✓ edge thickness control works' : '✗ FAIL: thickness had no effect');
await page.screenshot({ path: '/tmp/cadc-cube-shots/edges-thick.png' });
// reset defaults
await page.click('#styleBtn');
await page.$eval('#styleEdge', (el) => { el.value = '100'; el.dispatchEvent(new Event('input')); });
await page.click('#styleColor .color-swatch[data-v="auto"]');
console.log('errors:', errors.length ? errors : 'none');
process.exitCode = thick > thin * 2 ? 0 : 1;
await browser.close();
