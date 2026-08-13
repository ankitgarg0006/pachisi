import { chromium } from '../strangerring/node_modules/playwright/index.mjs';
const b = await chromium.launch();
const host = await (await b.newContext({ viewport: { width: 1280, height: 850 }, reducedMotion: 'no-preference' })).newPage();
const errs = []; host.on('pageerror', e => errs.push('H '+e.message));
await host.goto('https://chausar.agapps.workers.dev/?a=' + Date.now(), { waitUntil: 'networkidle' });
await host.click('text=Create Room'); await host.fill('input.f-in', 'Host');
await host.locator('.seg .s', { hasText: '2' }).first().click();
await host.locator('.seg .s', { hasText: 'No' }).click();
await host.locator('.seg .s', { hasText: 'Public' }).click();
await host.click('text=CREATE BOARD');
await host.waitForSelector('text=BOARD CODE'); await host.waitForTimeout(700);
const code = (await host.locator('.code').innerText()).replace(/\s/g,'');
const guest = await (await b.newContext({ viewport: { width: 390, height: 800 }, reducedMotion: 'no-preference' })).newPage();
await guest.goto('https://chausar.agapps.workers.dev/?g=' + Date.now(), { waitUntil: 'networkidle' });
await guest.click('text=Join Room'); await guest.fill('input.f-in >> nth=0', 'Guest'); await guest.fill('input.f-in >> nth=1', code);
await guest.click('text=JOIN BOARD'); await guest.waitForTimeout(1200);
await host.click('text=START GAME'); await host.waitForTimeout(1200);
await host.waitForSelector('.board'); await guest.waitForSelector('.board');
// host: go to CHAT tab, focus input, type slowly
await host.click('.rail .tabs button:has-text("CHAT")'); await host.waitForTimeout(300);
await host.click('.chatin input');
// guest spams chat every 250ms in background
let spamming = true;
(async () => { let i=0; while (spamming) { try { await guest.click('#chatfab').catch(()=>{}); await guest.fill('.sheet .chatin input', 'ping '+(i++)); await guest.click('.sheet .chatin button'); } catch {} await guest.waitForTimeout(250); } })();
const text = 'hello everyone lets play';
for (const ch of text) { await host.keyboard.type(ch); await host.waitForTimeout(150); }
spamming = false;
const val = await host.locator('.chatin input').inputValue();
const focused = await host.evaluate(() => document.activeElement === document.querySelector('.chatin input'));
await host.press('.chatin input', 'Enter'); await host.waitForTimeout(700);
const feed = await host.locator('#railfeed').innerText();
console.log('host input survived:', JSON.stringify(val), '| focused:', focused);
console.log('host feed shows guest pings + own msg:', feed.includes('hello everyone lets play'), '| ping count:', (feed.match(/ping/g)||[]).length);
console.log('errors:', errs.slice(0,5));
await b.close();
