import { chromium } from '../strangerring/node_modules/playwright/index.mjs';
const OUT = process.env.SCRATCH;
const browser = await chromium.launch();
async function playShot(scheme, path) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, colorScheme: scheme, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto('https://chausar.agapps.workers.dev/?t=' + Date.now(), { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  await p.screenshot({ path: `${OUT}/cs-home-${scheme}.png` });
  // Create solo-vs-bots via UI
  await p.click('text=Create Room'); await p.waitForTimeout(300);
  await p.fill('input.f-in', 'Ankit');
  await p.click('text=CREATE BOARD'); await p.waitForTimeout(2500);
  const start = p.locator('text=START GAME'); if (await start.count()) await start.click();
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${OUT}/cs-board-${scheme}.png` });
  // try to roll a few times if it's our turn
  for (let k = 0; k < 6; k++) {
    const rollable = p.locator('.die.rollable');
    if (await rollable.count()) { await rollable.first().click(); await p.waitForTimeout(1200); }
    const mv = p.locator('.goti.movable');
    if (await mv.count()) { await mv.first().click(); await p.waitForTimeout(1200); }
    else await p.waitForTimeout(1500);
  }
  await p.screenshot({ path: `${OUT}/cs-play-${scheme}.png` });
  await ctx.close();
}
await playShot('dark');
await playShot('light');
// desktop
const d = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' })).newPage();
await d.goto('https://chausar.agapps.workers.dev/?d=' + Date.now(), { waitUntil: 'networkidle' });
await d.click('text=Create Room'); await d.fill('input.f-in', 'Desk'); await d.click('text=CREATE BOARD'); await d.waitForTimeout(2500);
const st = d.locator('text=START GAME'); if (await st.count()) await st.click();
await d.waitForTimeout(3000);
await d.screenshot({ path: `${OUT}/cs-desk.png` });
await browser.close();
console.log('shots done');
