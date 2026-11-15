// Renders the launcher banner and icons from banner.html (node android/art/render.js).
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const res = path.join(__dirname, '../app/src/main/res');
  const b = await chromium.launch();
  const p = await b.newPage({ deviceScaleFactor: 1 });
  await p.goto('file://' + path.join(__dirname, 'banner.html'));
  await p.evaluate(() => document.fonts.ready);
  await p.locator('#banner').screenshot({ path: res + '/drawable-xhdpi/tv_banner.png' });
  for (const [dir, px] of [['mipmap-mdpi', 48], ['mipmap-hdpi', 72], ['mipmap-xhdpi', 96], ['mipmap-xxhdpi', 144], ['mipmap-xxxhdpi', 192]]) {
    const q = await b.newPage({ deviceScaleFactor: px / 192 });
    await q.goto('file://' + path.join(__dirname, 'banner.html'));
    await q.evaluate(() => document.fonts.ready);
    require('fs').mkdirSync(res + '/' + dir, { recursive: true });
    await q.locator('#icon').screenshot({ path: res + '/' + dir + '/ic_launcher.png' });
  }
  await b.close();
})();
