// Playwright 前端測試：攔截 script.google.com 轉給模擬伺服器，測畫面不用捲動、完整流程
// 執行：node tests/ui-test.js
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { makeEnv, loadLoader, codeSrc, call } = require('./gas-mock');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS || path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

// 模擬 Apps Script
const env = makeEnv(); env.github.code = codeSrc();
const gas = loadLoader(env, 'SHEET_TEST', '1234');
gas['一次設定']();
let online = true;

const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/echo-game\//, '/').replace(/\/$/, '/index.html'));
  if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain' });
  res.end(fs.readFileSync(f));
});

let failures = 0, passes = 0;
function check(cond, msg) { if (cond) { passes++; console.log('  ✓ ' + msg); } else { failures++; console.log('  ✗ ' + msg); } }

async function setupPage(browser, vp, opts = {}) {
  const context = await browser.newContext({ viewport: vp, hasTouch: !!opts.touch, isMobile: !!opts.mobile });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED/.test(m.text())) errors.push(m.text()); });
  await page.route('https://script.google.com/**', async route => {
    if (!online) return route.abort('internetdisconnected');
    const req = route.request(), u = new URL(req.url());
    let out;
    if (req.method() === 'GET') { const p = {}; u.searchParams.forEach((v, k) => p[k] = v); out = call(gas, 'GET', p); }
    else out = call(gas, 'POST', JSON.parse(req.postData() || '{}'));
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(out) });
  });
  await page.addInitScript(() => {
    if (!localStorage.getItem('echo_url')) localStorage.setItem('echo_url', JSON.stringify('https://script.google.com/macros/s/TEST/exec'));
  });
  await page.goto(`http://localhost:${PORT}/echo-game/`);
  return { page, context, errors };
}

// 檢查目前畫面：不能捲動、所有東西都在畫面內
async function fits(page, label) {
  const r = await page.evaluate(() => {
    const W = innerWidth, H = innerHeight, bad = [];
    const se = document.scrollingElement;
    if (se.scrollHeight > H + 1 || se.scrollWidth > W + 1) bad.push('頁面可以捲動 ' + se.scrollWidth + 'x' + se.scrollHeight);
    const root = document.querySelector('#teacher.on') || document.querySelector('.screen.active');
    root.querySelectorAll('*').forEach(el => {
      if (el.closest('.list,.setList,.tbody,svg') && el.tagName !== 'svg') return;
      if (el.closest('.spark,.ring,.judge')) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.offsetParent === null && cs.position !== 'fixed') return;
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) return;
      if (b.bottom > H + 1 || b.right > W + 1 || b.left < -1 || b.top < -1) bad.push((el.id || el.className || el.tagName) + ' ' + Math.round(b.left) + ',' + Math.round(b.top) + ' ' + Math.round(b.right) + 'x' + Math.round(b.bottom));
    });
    return bad.slice(0, 5);
  });
  check(r.length === 0, label + (r.length ? ' → ' + r.join(' | ') : ''));
}

// 在每個音符的正確時間自動拍（offsetMs 可以模擬偏早偏晚）
async function autoTap(page, offsetMs = 0, skip = []) {
  await page.waitForFunction(() => window.__echo.G.R && window.__echo.G.R.phase === 'play', null, { timeout: 30000 });
  await page.evaluate(({ offsetMs, skip }) => {
    const E = window.__echo, R = E.G.R;
    R.notes.forEach((n, i) => {
      if (skip.includes(i)) return;
      const lat = E.latSec();
      const now = performance.now(), hn = E.heardNow(now);
      const pt = now + (n.T + lat - hn) * 1000 + offsetMs;
      setTimeout(() => {
        E.press(pt);
        if (n.hold) { const rel = pt + n.D * 1000 - 20; setTimeout(() => E.release(rel), Math.max(0, rel - performance.now())); }
        else setTimeout(() => E.release(pt + 60), 50);
      }, Math.max(0, pt - performance.now()));
    });
  }, { offsetMs, skip });
  await page.waitForSelector('#scrCompare.active', { timeout: 30000 });
}

let PORT;
(async () => {
  await new Promise(r => server.listen(0, r)); PORT = server.address().port;
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

  // ===== 完整流程（手機直式） =====
  console.log('完整流程（375×667）');
  const { page, errors } = await setupPage(browser, { width: 375, height: 667 }, { touch: true, mobile: true });
  await fits(page, '登入畫面');
  await page.fill('#nameInput', '小明');
  await page.click('#btnLogin');
  await page.waitForSelector('#scrHome.active');
  await fits(page, '主畫面（地圖）');
  await page.screenshot({ path: SHOTS + '/home-375.png' });
  check(await page.locator('.lv.lock').count() === 5, '第一次只開第 1 關');
  await page.click('[data-lv="1-1"]');
  await page.waitForSelector('#scrCalib.active');
  await fits(page, '延遲校正畫面');
  await page.click('#calSkip');
  await page.waitForSelector('#scrPlay.active');
  await page.waitForFunction(() => document.querySelector('.ncard.demo'));
  check(true, '示範時節奏卡會亮');
  await fits(page, '遊戲畫面（聽）');
  await page.screenshot({ path: SHOTS + '/play-375.png' });
  for (let i = 0; i < 3; i++) {
    await autoTap(page, 0);
    if (i === 0) { await fits(page, '對照畫面'); await page.screenshot({ path: SHOTS + '/compare-375.png' }); }
    const acc = await page.evaluate(() => window.__echo.G.results[window.__echo.G.ri].acc);
    check(acc >= 90, `第 ${i + 1} 題準確拍 → 正確率 ${acc}%`);
    await page.click('#cmpNext');
  }
  await page.waitForSelector('#scrResult.active');
  await page.waitForTimeout(1500);
  await fits(page, '結果畫面');
  await page.screenshot({ path: SHOTS + '/result-375.png' });
  const prog = await page.evaluate(() => window.__echo.S.save.progress['1-1']);
  check(prog === 3, '1-1 拿到 3 星');
  const coins = await page.evaluate(() => window.__echo.S.save.coins);
  check(coins === 3 * 10 + 20 + 3 * 15, '金幣 = 3 星×10 + 第一次過關 20 + 全對加成 3×15 → ' + coins);
  await page.waitForTimeout(800);
  check(env._sheets['Users']._data.some(r => r[0] === '小明' && r[1] === 95), '試算表 Users 有小明 95 金幣');
  check(env._sheets['成績']._data.some(r => r[1] === '小明' && r[3] === '1-1'), '試算表有 1-1 成績');
  check(env._sheets['學習報告']._data.some(r => r[0] === '小明'), '學習報告有小明');

  // 下一關：故意拍晚、漏拍
  await page.click('#resNext');
  await page.waitForSelector('#scrPlay.active');
  await autoTap(page, 120, [1]);
  const r2 = await page.evaluate(() => window.__echo.G.results[0]);
  check(r2.M >= 1 && r2.off > 0, `拍晚＋漏拍 → Miss ${r2.M}、平均晚 ${r2.off}ms`);
  const cmpTxt = await page.textContent('#cmpMsg');
  check(/拖慢|再/.test(cmpTxt), '對照畫面說「拖慢」：' + cmpTxt);
  const svgTxt = await page.textContent('#cmpSvg');
  check(/晚/.test(svgTxt), '時間軸標出「晚」');
  await page.click('#cmpRetry');
  await autoTap(page, -10);
  const r3 = await page.evaluate(() => window.__echo.G.results[0]);
  check(r3.acc >= 90, '再來一次後正確率 ' + r3.acc + '%');

  // 重新整理後重新登入
  await page.goto(`http://localhost:${PORT}/echo-game/`);
  await page.fill('#nameInput', '小明'); await page.click('#btnLogin'); await page.waitForSelector('#scrHome.active');
  check(await page.evaluate(() => window.__echo.S.save.coins) === 95, '重新登入讀回存檔');

  // 練習模式 + 長音符
  console.log('練習模式');
  await page.click('#btnPractice');
  await page.waitForSelector('#scrPractice.active');
  await fits(page, '練習畫面');
  await page.screenshot({ path: SHOTS + '/practice-375.png' });
  await page.click('#prClear');
  await page.click('[data-t="h"]'); await page.click('[data-t="e"]'); await page.click('[data-t="r"]');
  check(await page.evaluate(() => window.__echo.G.practiceTokens.join(' ')) === 'h e r', '放入 二分＋八分＋休止');
  await page.click('#prDemo');
  await page.waitForTimeout(300);
  await page.click('#prGo');
  await page.waitForSelector('#scrPlay.active');
  await autoTap(page, 0);
  const pr = await page.evaluate(() => window.__echo.G.R.notes.map(n => n.j).join(''));
  check(pr === 'PPP', '長音符按住到結束＋八分音符都 Perfect：' + pr);
  await page.click('#cmpNext');
  await page.waitForSelector('#scrPractice.active');
  // 長音符太早放開
  await page.click('#prClear'); await page.click('[data-t="w"]'); await page.click('#prGo');
  await page.waitForFunction(() => window.__echo.G.R && window.__echo.G.R.phase === 'play', null, { timeout: 30000 });
  await page.evaluate(() => {
    const E = window.__echo, n = E.G.R.notes[0], now = performance.now();
    const pt = now + (n.T + E.latSec() - E.heardNow(now)) * 1000;
    setTimeout(() => { E.press(pt); setTimeout(() => E.release(pt + 300), 300); }, Math.max(0, pt - now));
  });
  await page.waitForSelector('#scrCompare.active', { timeout: 30000 });
  check(await page.evaluate(() => window.__echo.G.R.notes[0].j) === 'M', '全音符太早放開算 Miss');
  await page.click('#cmpNext');

  // 商店
  console.log('商店');
  await page.click('#prBack'); await page.click('#btnShop');
  await page.waitForSelector('#scrShop.active');
  await fits(page, '商店畫面');
  await page.click('[data-id="clap"] [data-act="buy"]');
  check(await page.evaluate(() => window.__echo.S.save.equip) === 'clap', '買拍手音色並使用');
  check(await page.evaluate(() => window.__echo.S.save.coins) === 45, '扣 50 金幣');
  await page.click('[data-id="laser"] [data-act="buy"]');
  check(await page.evaluate(() => window.__echo.S.save.owned.indexOf('laser')) < 0, '金幣不夠不能買');

  // 排行榜
  await page.click('#shopBack'); await page.click('#btnBoard');
  await page.waitForSelector('#boardList .row');
  await fits(page, '排行榜畫面');
  check((await page.textContent('#boardList')).includes('小明'), '排行榜有小明');

  // 設定
  await page.click('#boardBack'); await page.click('#btnSettings');
  await fits(page, '設定畫面');

  // 老師面板
  console.log('老師面板');
  await page.click('#setTeach');
  await page.fill('#tPin', '0000'); await page.click('#tPinOk');
  await page.waitForFunction(() => /不對/.test(document.querySelector('#tPinMsg').textContent));
  check(true, '密碼錯誤擋住');
  await page.fill('#tPin', '1234'); await page.click('#tPinOk');
  await page.waitForSelector('#tPing');
  await fits(page, '老師面板');
  await page.click('#tPing');
  await page.waitForFunction(() => /伺服器程式：第 1 版/.test(document.querySelector('#tConnMsg').textContent));
  check((await page.textContent('#tConnMsg')).includes('傳聲筒成績'), '測試連線顯示試算表名稱和版本');
  await page.click('#tUpd');
  await page.waitForFunction(() => /最新版/.test(document.querySelector('#tConnMsg').textContent));
  check(true, '更新伺服器程式：已經是最新版');
  await page.click('[data-t="class"]');
  await page.selectOption('#cLen', '1.4'); await page.selectOption('#cMax', '1-2'); await page.selectOption('#cShop', 'true');
  await page.click('#cSave');
  await page.waitForFunction(() => /已同步/.test(document.querySelector('#cMsg').textContent));
  check(env._sheets['設定']._data.some(r => r[0] === 'leniency' && String(r[1]) === '1.4'), '班級設定寫進試算表');
  await page.fill('#bText', '今天挑戰操場！'); await page.click('#bSend');
  await page.waitForFunction(() => /已送出/.test(document.querySelector('#bMsg').textContent));
  await page.waitForSelector('#bcast.on');
  check((await page.textContent('#bcastText')).includes('今天挑戰操場'), '廣播出現在畫面上方');
  await page.click('[data-t="mod"]');
  await page.fill('#mName', '小明'); await page.fill('#mCoins', '300'); await page.click('#mApply');
  await page.waitForFunction(() => /已更新/.test(document.querySelector('#mMsg').textContent));
  check(await page.evaluate(() => window.__echo.S.save.coins) === 300, '修改器改金幣，小明的平板也更新');
  await page.fill('input[data-cat="關卡速度"][data-item="1-1"]', '60');
  await page.click('#mSave');
  await page.waitForFunction(() => /已同步/.test(document.querySelector('#mSaveMsg').textContent));
  check(env._sheets['修改器']._data.some(r => r[0] === '關卡速度' && r[1] === '1-1' && Number(r[2]) === 60), '修改器速度寫進試算表');
  await page.click('[data-t="other"]');
  await page.fill('#oOld', '1234'); await page.fill('#oNew', '2468'); await page.click('#oPin');
  await page.waitForFunction(() => /已更改/.test(document.querySelector('#oMsg').textContent));
  check(env._props.TEACHER_PIN === '2468', '改老師密碼同步到伺服器');
  check((await page.textContent('#tBody')).includes('第 1 版'), '老師面板有更新日誌');
  await page.click('#oTest');
  check(await page.evaluate(() => window.__echo.S.test) === true, '開啟測試模式');
  await page.click('#tClose');
  await page.click('#setBack');
  await page.waitForSelector('#scrHome.active');
  check(await page.locator('.lv.lock').count() === 0, '測試模式全部解鎖');
  // 測試模式不寫入
  const before = env._sheets['成績'].getLastRow();
  await page.click('#btnPractice'); await page.click('#prGo');
  await autoTap(page, 0); await page.click('#cmpNext');
  await page.waitForTimeout(600);
  check(env._sheets['成績'].getLastRow() === before, '測試模式成績不寫進試算表');
  // 關掉測試模式，鎖關卡生效
  await page.evaluate(() => { window.__echo.S.test = false; localStorage.setItem('echo_test', 'false'); });
  await page.click('#prBack');
  check(await page.locator('[data-lv="1-3"].lock').count() === 1, '老師只開放到 1-2，1-3 鎖住');
  await page.click('#btnShop');
  check((await page.textContent('#shopGrid')).includes('老師暫時關閉商店'), '商店被老師鎖住');
  await page.click('#shopBack');

  // 離線排隊
  console.log('離線補傳');
  online = false;
  await page.click('#btnPractice'); await page.click('#prGo');
  await autoTap(page, 0); await page.click('#cmpNext');
  await page.waitForTimeout(500);
  const q = await page.evaluate(() => window.__echo.queue().length);
  check(q >= 1, '沒網路時排隊 ' + q + ' 筆');
  online = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => window.__echo.queue().length === 0, null, { timeout: 10000 });
  check(true, '連上後自動補傳完成');
  check(errors.length === 0, '沒有 JS 錯誤' + (errors.length ? '：' + errors.join(' / ') : ''));
  await page.context().close();

  // ===== 各種螢幕 =====
  const vps = [[375, 667, '手機直式'], [390, 844, '手機直式 2'], [844, 390, '手機橫式'], [820, 1180, 'iPad 直式'], [1180, 820, 'iPad 橫式'], [667, 375, '小手機橫式']];
  for (const [w, h, nm] of vps) {
    console.log(`${nm} ${w}×${h}`);
    const { page: p, errors: errs } = await setupPage(browser, { width: w, height: h }, { touch: true });
    await fits(p, '登入');
    await p.fill('#nameInput', '測試' + w); await p.click('#btnLogin'); await p.waitForSelector('#scrHome.active');
    await p.evaluate(() => { window.__echo.S.test = true; localStorage.setItem('echo_lat', '0'); window.__echo.S.lat = 0; });
    await fits(p, '主畫面');
    await p.screenshot({ path: `${SHOTS}/home-${w}x${h}.png` });
    // 大魔王（8 拍、兩小節）
    await p.evaluate(() => { window.__echo.S.zone = 1; document.querySelector('#zNext').click(); document.querySelector('#zPrev').click(); });
    await p.click('[data-lv="2-B"]');
    await p.waitForFunction(() => window.__echo.G.R && window.__echo.G.R.phase === 'play', null, { timeout: 30000 });
    await fits(p, '大魔王遊戲畫面（拍）');
    await p.screenshot({ path: `${SHOTS}/boss-${w}x${h}.png` });
    await p.waitForSelector('#scrCompare.active', { timeout: 30000 });
    await fits(p, '對照畫面');
    check(await p.evaluate(() => window.__echo.G.hearts) === 2, '大魔王沒拍 → 扣一顆愛心');
    await p.screenshot({ path: `${SHOTS}/compare-${w}x${h}.png` });
    await p.click('#cmpNext');
    await p.waitForFunction(() => window.__echo.G.R && window.__echo.G.R.phase === 'play', null, { timeout: 30000 });
    await p.click('#playBack');
    await p.click('#btnPractice'); await fits(p, '練習');
    await p.screenshot({ path: `${SHOTS}/practice-${w}x${h}.png` });
    await p.click('#prBack'); await p.click('#btnShop'); await fits(p, '商店');
    await p.click('#shopBack'); await p.click('#btnSettings'); await fits(p, '設定');
    await p.click('#setCal'); await fits(p, '校正');
    await p.click('#calBack'); await p.click('#setTeach'); await p.fill('#tPin', '2468'); await p.click('#tPinOk');
    await p.waitForSelector('#tPing'); await fits(p, '老師面板');
    // 結果畫面
    await p.click('#tClose');
    await p.evaluate(() => { document.querySelector('#setBack').click(); });
    await p.evaluate(() => { window.__echo.S.zone = 1; document.querySelector('#zPrev').click(); });
    await p.click('[data-lv="1-1"]');
    for (let i = 0; i < 3; i++) { await autoTap(p, 0); await p.click('#cmpNext'); }
    await p.waitForSelector('#scrResult.active'); await p.waitForTimeout(1300);
    await fits(p, '結果');
    await p.screenshot({ path: `${SHOTS}/result-${w}x${h}.png` });
    check(errs.length === 0, '沒有 JS 錯誤' + (errs.length ? '：' + errs.join(' / ') : ''));
    await p.context().close();
  }

  await browser.close(); server.close();
  console.log(`\n通過 ${passes} 項，失敗 ${failures} 項`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
