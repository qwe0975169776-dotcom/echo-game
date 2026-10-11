// Playwright 前端測試（第 2 版）：攔截 script.google.com 轉給模擬伺服器，測畫面不用捲動、完整流程
// 執行：NODE_PATH=/opt/npm-tools/node_modules node tests/ui-test.js
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
const net = { online: true, dropAfter: 0, newerVersion: 0 };

const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/echo-game\//, '/').replace(/\/$/, '/index.html'));
  if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(f);
  if (net.newerVersion && /vcheck=/.test(req.url)) body = Buffer.from(body.toString().replace(/const APP_VERSION = \d+;/, 'const APP_VERSION = ' + net.newerVersion + ';'));
  res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain' });
  res.end(body);
});

let failures = 0, passes = 0;
function check(cond, msg) { if (cond) { passes++; console.log('  ✓ ' + msg); } else { failures++; console.log('  ✗ ' + msg); } }

async function setupPage(browser, vp, opts = {}) {
  const context = await browser.newContext({ viewport: vp, hasTouch: true, isMobile: !!opts.mobile });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED|ERR_FAILED|net::/.test(m.text())) errors.push(m.text()); });
  await page.route('https://script.google.com/**', async route => {
    if (!net.online) return route.abort('internetdisconnected');
    const req = route.request(), u = new URL(req.url());
    let out;
    if (req.method() === 'GET') { const p = {}; u.searchParams.forEach((v, k) => p[k] = v); out = call(gas, 'GET', p); }
    else out = call(gas, 'POST', JSON.parse(req.postData() || '{}'));
    if (net.dropAfter > 0 && req.method() === 'POST') { net.dropAfter--; return route.abort('timedout'); }   // 伺服器做完了，但回應沒送到
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(out) });
  });
  await page.addInitScript(o => {
    if (!localStorage.getItem('echo_url')) localStorage.setItem('echo_url', JSON.stringify('https://script.google.com/macros/s/TEST/exec'));
    if (o.quiet && !localStorage.getItem('echo_opts')) localStorage.setItem('echo_opts', JSON.stringify({ metro: true, low: false, voice: false }));
  }, { quiet: !!opts.quiet });
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
      if (el.closest('.list,.setList,.tbody') && el.tagName !== 'svg') return;
      if (el.closest('.spark,.ring,.judge,.ball,svg') && !(el.tagName === 'svg' && !el.parentElement.closest('svg'))) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || (el.offsetParent === null && cs.position !== 'fixed' && el.tagName !== 'svg')) return;
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) return;
      if (b.bottom > H + 1 || b.right > W + 1 || b.left < -1 || b.top < -1) bad.push((el.id || el.className.baseVal || el.className || el.tagName) + ' ' + Math.round(b.left) + ',' + Math.round(b.top) + ' ' + Math.round(b.right) + 'x' + Math.round(b.bottom));
    });
    return bad.slice(0, 5);
  });
  check(r.length === 0, label + (r.length ? ' → ' + r.join(' | ') : ''));
}

const waitPlay = page => page.waitForFunction(() => window.__echo.G.R && window.__echo.G.R.phase === 'play', null, { timeout: 40000 });
// 依照每個音符的時間自動拍（offsetMs 模擬偏早偏晚；skip 不拍；extraBeats 在第幾拍多拍一下；holdFrac 長音符按多久）
async function tapNotes(page, o = {}) {
  await waitPlay(page);
  await page.evaluate(({ offsetMs, skip, extraBeats, holdFrac }) => {
    const E = window.__echo, R = E.G.R;
    const sched = (T, cb) => { const now = performance.now(), hn = E.heardNow(now); const pt = now + (T + E.latSec() - hn) * 1000; setTimeout(() => cb(pt), Math.max(0, pt - performance.now())); };
    R.notes.forEach((n, i) => {
      if (skip.includes(i)) return;
      sched(n.T + offsetMs / 1000, pt => {
        E.press(pt);
        if (n.hold) { const rel = pt + n.D * 1000 * holdFrac - 20; setTimeout(() => E.release(rel), Math.max(0, rel - performance.now())); }
        else setTimeout(() => E.release(pt + 60), 50);
      });
    });
    extraBeats.forEach(b => sched(R.tP + b * R.beat, pt => { E.press(pt); setTimeout(() => E.release(pt + 60), 50); }));
  }, { offsetMs: o.offsetMs || 0, skip: o.skip || [], extraBeats: o.extraBeats || [], holdFrac: o.holdFrac == null ? 1 : o.holdFrac });
  await page.waitForSelector('#scrCompare.active', { timeout: 40000 });
}
const ev = (page, fn, arg) => page.evaluate(fn, arg);
const waitSynced = page => page.waitForFunction(() => { const p = window.__echo.pending(); return !Object.keys(p.dirty).length && !p.recs.length; }, null, { timeout: 30000 });
const userRow = name => env._sheets['Users']._data.find(r => r[0] === name);
const save = name => JSON.parse(userRow(name)[5]);

let PORT;
(async () => {
  await new Promise(r => server.listen(0, r)); PORT = server.address().port;
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

  // ================= 完整流程（手機直式 375×667） =================
  if (process.env.PART !== 'screens') {
  console.log('登入與選年級');
  const { page, errors } = await setupPage(browser, { width: 375, height: 667 }, { mobile: true });
  await fits(page, '登入畫面');
  check(await page.locator('#btnTeacher1.dotRed').count() === 1, '這台還沒校正 → 老師按鈕有紅點');
  await page.fill('#nameInput', '小明'); await page.click('#btnLogin');
  await page.waitForSelector('#scrGrade.active');
  await fits(page, '選年級畫面');
  await page.screenshot({ path: SHOTS + '/grade-375.png' });
  await page.click('[data-g="1"]');
  await page.waitForSelector('#scrHome.active');
  await fits(page, '主畫面（5 個按鈕）');
  await page.screenshot({ path: SHOTS + '/home-375.png' });
  check(await page.locator('.lv.lock').count() === 5, '第一次只開第 1 關');
  check(await ev(page, () => window.__echo.S.save.grade) === 1, '存了一年級');

  console.log('第 1 關：示範、小球、連擊');
  await page.click('[data-lv="1-1"]');
  await page.waitForSelector('#scrPlay.active');
  check(await page.locator('#scrCalib.active').count() === 0, '小朋友不用做延遲校正');
  await page.waitForSelector('.ncard.demo', { timeout: 15000 });
  await page.waitForSelector('#ball.on', { timeout: 5000 });
  check(true, '示範時卡片亮、小球在跳');
  const bpm11 = await ev(page, () => window.__echo.G.R.bpm);
  check(bpm11 === Math.round(70 * 0.85), '一年級速度變慢：70 → ' + bpm11);
  await fits(page, '遊戲畫面（聽）');
  await page.screenshot({ path: SHOTS + '/play-375.png' });
  for (let i = 0; i < 3; i++) {
    await tapNotes(page);
    if (i === 0) {
      await fits(page, '對照畫面（3 個按鈕）');
      await page.screenshot({ path: SHOTS + '/compare-375.png' });
      await page.click('#cmpPlay');
      await page.waitForFunction(() => document.querySelector('#cmpHead') && document.querySelector('#cmpHead').getAttribute('visibility') === 'visible', null, { timeout: 8000 });
      check(true, '「聽聽看」播放時有移動的指針');
      await page.waitForFunction(() => document.querySelector('#rowB').getAttribute('opacity') === '1', null, { timeout: 12000 });
      check(true, '先播示範、再播自己拍的（下排亮）');
    }
    const acc = await ev(page, () => window.__echo.G.results[window.__echo.G.ri].acc);
    check(acc >= 90, `第 ${i + 1} 題準確拍 → 正確率 ${acc}%`);
    await page.click('#cmpNext');
  }
  await page.waitForSelector('#scrResult.active');
  await page.waitForTimeout(1300);
  await fits(page, '結果畫面');
  await page.screenshot({ path: SHOTS + '/result-375.png' });
  const g1 = await ev(page, () => ({ coins: window.__echo.S.save.coins, combo: window.__echo.G.maxCombo, badges: Object.keys(window.__echo.S.save.badges), prog: window.__echo.S.save.progress['1-1'], daily: window.__echo.S.save.daily }));
  check(g1.prog === 3, '1-1 拿到 3 星');
  check(g1.combo === 10, '最高連擊 10');
  check(g1.coins === 30 + 20 + 3 * 15 + 2 * 2, '金幣 = 3 星×10 + 第一次過關 20 + 全對 3×15 + 連擊 2×2 → ' + g1.coins);
  check(['first', 'star3', 'full', 'combo10'].every(b => g1.badges.includes(b)), '得到徽章：' + g1.badges.join(','));
  check((await page.textContent('#resExtra')).includes('最高連擊 10'), '結果畫面顯示最高連擊');
  check(g1.daily && g1.daily.prog.perfect === 10 && g1.daily.prog.clear === 1, '每日任務進度有記錄');
  await waitSynced(page);
  check(userRow('小明') && userRow('小明')[1] === 99 && userRow('小明')[8] === 1, '試算表 Users：小明 99 金幣、一年級');
  const rec1 = env._sheets['成績']._data.filter(r => r[1] === '小明' && r[3] === '1-1');
  check(rec1.length === 1 && rec1[0][13] && rec1[0][17] === 10, '成績有 1-1、紀錄ID、最高連擊');

  console.log('第 2 關：拍太晚、休止符、卡關協助');
  await page.click('#resNext');
  await page.waitForSelector('#scrPlay.active');
  await tapNotes(page, { offsetMs: 120, skip: [1] });
  const r2 = await ev(page, () => { const r = window.__echo.G.results[0]; return { M: r.M, off: r.off, acc: r.acc }; });
  check(r2.M >= 1 && r2.off > 0, `拍晚＋漏拍 → Miss ${r2.M}、平均晚 ${r2.off}ms`);
  check((await page.textContent('#cmpMsg')).includes('太慢'), '對照畫面：烏龜「有一點太慢」');
  check(await page.locator('#cmpSvg use[href="#sTur"]').count() >= 2, '時間軸上拍晚的地方有烏龜');
  check(await page.locator('#cmpRetry:not(.white)').count() === 1, '沒過 → 「再來一次」變成主要按鈕');
  await page.click('#cmpRetry');
  await tapNotes(page, { extraBeats: [1] });   // 1-2 第一題是 q r q r，第 2 拍是休止符
  check(await ev(page, () => window.__echo.G.R.extras[0].rest) === 1, '在休止符上拍 → 認得是休止符');
  check((await page.textContent('#cmpMsg')).includes('休止符不要拍'), '對照畫面：「噓～休止符不要拍」');
  check((await page.textContent('#cmpSvg')).includes('噓'), '時間軸把拍錯的休止符圈起來');
  const fails = await ev(page, () => window.__echo.G.att.fails);
  check(fails === 2, '這題錯了 2 次');
  const bpmBefore = await ev(page, () => window.__echo.G.R.bpm);
  await page.click('#cmpRetry');
  await waitPlay(page);
  const bpmAfter = await ev(page, () => window.__echo.G.R.bpm);
  check(bpmAfter < bpmBefore && await ev(page, () => window.__echo.G.assist) === 0.9, `錯兩次自動放慢：${bpmBefore} → ${bpmAfter}`);
  await page.waitForSelector('#scrCompare.active', { timeout: 40000 });

  console.log('看譜關卡（第 4 關）');
  await ev(page, () => { const E = window.__echo, s = E.S.save; s.progress['1-2'] = 2; s.progress['1-3'] = 2; E.persist(); E.goHome(); });
  await page.waitForSelector('#scrHome.active');
  check(await page.locator('[data-lv="1-4"] .md').count() === 1, '第 4 關有「看」的圖示');
  await page.click('[data-lv="1-4"]');
  await waitPlay(page);
  check(await ev(page, () => window.__echo.G.R.demo) === false, '看譜關卡沒有先示範');
  check(await ev(page, () => window.__echo.G.R.ballPts.length === window.__echo.G.R.beats), '看譜時小球只打拍子（不洩漏節奏）');
  await page.waitForSelector('#scrCompare.active', { timeout: 40000 });
  await page.click('#cmpRetry');
  await page.waitForSelector('#scrCompare.active', { timeout: 40000 });
  await page.click('#cmpRetry');
  await waitPlay(page);
  check(await ev(page, () => window.__echo.G.R.demo) === true, '看譜錯兩次 → 這次先示範');
  await page.waitForSelector('#scrCompare.active', { timeout: 40000 });

  console.log('練習模式：長音符、不示範');
  await ev(page, () => window.__echo.goHome());
  await page.waitForSelector('#scrHome.active');
  await page.click('#btnPractice');
  await page.waitForSelector('#scrPractice.active');
  await fits(page, '練習畫面');
  await page.screenshot({ path: SHOTS + '/practice-375.png' });
  await page.click('#prClear');
  await page.click('[data-t="h"]'); await page.click('[data-t="e"]'); await page.click('[data-t="r"]');
  await page.click('#prGo');
  await tapNotes(page);
  check(await ev(page, () => window.__echo.G.R.notes.map(n => n.j).join('')) === 'PPP', '長音符按住到結束＋八分音符都 Perfect');
  await page.click('#cmpNext');
  await page.click('#prClear'); await page.click('[data-t="w"]'); await page.click('#prGo');
  await tapNotes(page, { holdFrac: 0.2 });
  check(await ev(page, () => window.__echo.G.R.notes[0].j) === 'M', '全音符太早放開 → Miss');
  check((await page.textContent('#cmpMsg')).includes('長音符要按久一點'), '對照畫面：「長音符要按久一點」');
  await page.click('#cmpNext');
  await page.click('#prDemoTog');
  await page.click('#prClear'); await page.click('[data-t="q"]'); await page.click('[data-t="q"]'); await page.click('[data-t="r"]'); await page.click('[data-t="q"]');
  await page.click('#prGo');
  await waitPlay(page);
  check(await ev(page, () => window.__echo.G.R.read) === true, '練習可以關掉示範（看譜練習）');
  await page.waitForSelector('#scrCompare.active', { timeout: 40000 });
  await page.click('#cmpNext');
  await page.click('#prBack');

  console.log('每日任務、徽章');
  const ids = await ev(page, () => window.__echo.S.save.daily.ids);
  check(ids.length === 3, '今天有 3 個任務：' + ids.join(','));
  await ev(page, () => { const s = window.__echo.S.save; ['perfect', 'clear', 'stars', 'combo', 'practice', 'full', 'read'].forEach(k => { s.daily.prog[k] = 99; }); });
  await page.click('#btnMission');
  await page.waitForSelector('#scrMission.active');
  await fits(page, '每日任務畫面');
  await page.screenshot({ path: SHOTS + '/mission-375.png' });
  const coinsBefore = await ev(page, () => window.__echo.S.save.coins);
  for (let i = 0; i < 3; i++) await page.click('#misList [data-m]:not([disabled])');
  const coinsAfter = await ev(page, () => window.__echo.S.save.coins);
  check(coinsAfter === coinsBefore + 60, '領 3 個任務獎勵 +60 金幣');
  check(await ev(page, () => !!window.__echo.S.save.badges.daily), '3 個任務都完成 → 任務達人徽章');
  check((await page.textContent('#badgeCount')).startsWith('5 /'), '徽章牆 ' + await page.textContent('#badgeCount'));
  await page.click('#misBack');

  console.log('商店、排行、設定');
  await page.click('#btnShop'); await page.waitForSelector('#scrShop.active');
  await fits(page, '商店畫面');
  await page.click('[data-id="clap"] [data-act="buy"]');
  check(await ev(page, () => window.__echo.S.save.equip) === 'clap', '買拍手音色並使用');
  await page.click('#shopBack');
  await waitSynced(page);
  await page.click('#btnBoard'); await page.waitForSelector('#boardList .row');
  await fits(page, '排行榜畫面');
  check((await page.textContent('#boardList')).includes('一年級'), '排行榜顯示年級');
  await page.click('#boardBack'); await page.click('#btnSettings');
  await fits(page, '設定畫面');
  check((await page.textContent('#setList')).includes('年級：一年級') && !(await page.textContent('#setList')).includes('延遲校正'), '設定：顯示年級，沒有延遲校正（改由老師做）');

  console.log('老師面板');
  await page.click('#setTeach');
  await page.fill('#tPin', '0000'); await page.click('#tPinOk');
  await page.waitForFunction(() => /不對/.test(document.querySelector('#tPinMsg').textContent));
  await page.fill('#tPin', '1234'); await page.click('#tPinOk');
  await page.waitForSelector('#tPing');
  await fits(page, '老師面板（連線）');
  check(await page.locator('#tTabs button').count() === 5, '老師面板 5 個分頁');
  await page.click('#tPing');
  await page.waitForFunction(() => /伺服器程式：第 2 版/.test(document.querySelector('#tConnMsg').textContent));
  check(true, '測試連線：第 2 版');
  await page.click('#tRebuild');
  await page.waitForFunction(() => /都更新了/.test(document.querySelector('#tConnMsg').textContent));
  check(env._sheets['學習報告']._data.some(r => r[0] === '小明' && r[9] === '1 年級'), '學習報告有小明（一年級）');
  await page.click('[data-t="class"]'); await fits(page, '老師面板（班級設定）');
  await page.selectOption('#cRead', 'false'); await page.selectOption('#cVoice', 'false');
  await page.click('#cSave');
  await page.waitForFunction(() => /已同步/.test(document.querySelector('#cMsg').textContent));
  check(env._sheets['設定']._data.some(r => r[0] === 'readLevels' && String(r[1]) === 'false'), '看譜關卡關閉 → 寫進試算表');
  check(await ev(page, () => window.__echo.S.cfg.voice) === 'false', '語音提示可以全班關掉');
  await page.click('[data-t="mod"]'); await fits(page, '老師面板（修改器）');
  await page.fill('#mName', '小明'); await page.selectOption('#mGrade', '3'); await page.fill('#mCoins', '300');
  await page.click('#mApply');
  await page.waitForFunction(() => /已更新/.test(document.querySelector('#mMsg').textContent));
  const after = await ev(page, () => ({ g: window.__echo.S.save.grade, c: window.__echo.S.save.coins }));
  check(after.g === 3 && after.c === 300, '老師改年級（三年級）和金幣（300），小明的平板馬上更新');
  await page.click('[data-t="dev"]'); await fits(page, '老師面板（這台平板）');
  check((await page.textContent('#tBody')).includes('還沒校正'), '這台平板：顯示還沒校正');
  await page.click('#dCal');
  await page.waitForSelector('#scrCalib.active');
  await fits(page, '延遲校正畫面');
  await page.click('#calStart');
  await page.waitForFunction(() => window.__echo.CAL.clicks.length === 8);
  await page.evaluate(() => {   // 每一下都比「嘟」晚 40ms 拍
    const E = window.__echo;
    E.CAL.clicks.forEach(c => {
      const now = performance.now(), pt = now + (c + 0.04 - E.heardNow(now)) * 1000;
      setTimeout(() => { E.press(pt); E.release(pt + 50); }, Math.max(0, pt - performance.now()));
    });
  });
  await page.waitForFunction(() => /完成/.test(document.querySelector('#calPadText').textContent), null, { timeout: 20000 });
  const lat = await ev(page, () => window.__echo.S.lat);
  check(Math.abs(lat - 40) <= 3, '延遲校正量到 ' + lat + ' ms（實際 40）');
  check(await page.locator('#btnTeacher1.dotRed').count() === 0, '校正後老師按鈕的紅點消失');
  await page.click('#calSkip');
  await page.waitForSelector('#teacher.on');
  check(true, '校正完回到老師面板');
  await page.click('[data-t="other"]'); await fits(page, '老師面板（其他）');
  check((await page.textContent('#tBody')).includes('第 2 版'), '更新日誌有第 2 版');
  await page.click('#tClose');

  console.log('新版本提示');
  net.newerVersion = 3;
  await ev(page, () => window.__echo.checkUpdate(false));
  await page.waitForSelector('#updBar.on', { timeout: 5000 });
  check((await page.textContent('#updBar')).includes('第 3 版'), '有新版本 → 上方出現「點這裡更新」');
  net.newerVersion = 0;

  console.log('伺服器忙碌、回應遺失、沒網路');
  await page.click('#setBack').catch(() => {});
  await page.waitForSelector('#scrHome.active');
  await waitSynced(page);
  env.lockBusy = 1;
  const rowsBefore = env._sheets['成績'].getLastRow();
  await page.click('#btnPractice'); await page.click('#prGo');
  await tapNotes(page); await page.click('#cmpNext'); await page.click('#prBack');
  await page.waitForFunction(() => window.__echo.pending().recs.length === 0, null, { timeout: 30000 });
  check(env._sheets['成績'].getLastRow() === rowsBefore + 1, '伺服器忙碌一次 → 自動重送，成績沒有掉');
  net.dropAfter = 1;
  await page.click('#btnPractice'); await page.click('#prGo');
  await tapNotes(page); await page.click('#cmpNext'); await page.click('#prBack');
  await page.waitForFunction(() => window.__echo.pending().recs.length === 0, null, { timeout: 40000 });
  check(env._sheets['成績'].getLastRow() === rowsBefore + 2, '伺服器做完但回應遺失 → 重送也不會重複記錄');
  net.online = false;
  await page.click('#btnPractice'); await page.click('#prGo');
  await tapNotes(page); await page.click('#cmpNext'); await page.click('#prBack');
  await ev(page, () => window.__echo.flush());
  await page.waitForTimeout(500);
  check(await ev(page, () => window.__echo.pending().recs.length) === 1, '沒網路 → 先存在平板（1 筆）');
  console.log('共用平板：換人玩');
  await page.click('#btnSettings'); await page.click('#setOut');
  await page.fill('#nameInput', '小美'); await page.click('#btnLogin');
  await page.waitForSelector('#scrGrade.active'); await page.click('[data-g="2"]');
  net.online = true;
  await ev(page, () => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => { const p = window.__echo.pending(); return !p.recs.length && !Object.keys(p.dirty).length; }, null, { timeout: 30000 });
  check(env._sheets['成績'].getLastRow() === rowsBefore + 3, '連上網路後，上一位（小明）的成績也補傳了');
  check(userRow('小美') && userRow('小美')[8] === 2, '小美（二年級）也存進試算表');

  console.log('測試模式');
  await page.click('#btnSettings'); await page.click('#setTeach');
  await page.waitForSelector('#tTabs button');
  await page.click('[data-t="other"]'); await page.click('#oTest');
  await page.waitForSelector('#scrLogin.active');
  await page.fill('#nameInput', '老師'); await page.click('#btnLogin');
  await page.waitForSelector('#scrGrade.active'); await page.click('[data-g="4"]');
  check(await page.locator('.lv.lock').count() === 0, '測試模式全部解鎖');
  const before2 = env._sheets['成績'].getLastRow();
  await page.click('#btnPractice'); await page.click('#prGo');
  await tapNotes(page); await page.click('#cmpNext'); await page.click('#prBack');
  await page.waitForTimeout(800);
  check(env._sheets['成績'].getLastRow() === before2 && !userRow('老師'), '測試模式的資料不送到試算表');
  check(errors.length === 0, '沒有 JS 錯誤' + (errors.length ? '：' + errors.join(' / ') : ''));
  await page.context().close();

  }

  // ================= 各種螢幕 =================
  // PART=flow 只跑完整流程；PART=screens 只跑各種螢幕；不設就全部跑
  let vps = [[375, 667, '手機直式'], [390, 844, '手機直式 2'], [844, 390, '手機橫式'], [820, 1180, 'iPad 直式'], [1180, 820, 'iPad 橫式'], [667, 375, '小手機橫式']];
  if (process.env.VPS) vps = vps.filter(v => process.env.VPS.split(',').includes(v[0] + 'x' + v[1]));
  if (process.env.PART === 'flow') vps = [];
  for (const [w, h, nm] of vps) {
    console.log(`${nm} ${w}×${h}`);
    const { page: p, errors: errs } = await setupPage(browser, { width: w, height: h }, { quiet: true });
    await fits(p, '登入');
    await p.fill('#nameInput', '測試' + w); await p.click('#btnLogin');
    await p.waitForSelector('#scrGrade.active'); await fits(p, '選年級');
    await p.click('[data-g="5"]'); await p.waitForSelector('#scrHome.active');
    await ev(p, () => { window.__echo.S.test = true; });
    await p.click('#zNext'); await p.click('#zPrev');
    await fits(p, '主畫面');
    await p.screenshot({ path: `${SHOTS}/home-${w}x${h}.png` });
    await p.click('#zNext');
    await p.click('[data-lv="2-B"]');
    await waitPlay(p);
    await p.waitForSelector('#ball.on', { timeout: 8000 });
    await fits(p, '大魔王（兩小節、小球）');
    await p.screenshot({ path: `${SHOTS}/boss-${w}x${h}.png` });
    await p.waitForSelector('#scrCompare.active', { timeout: 40000 });
    await fits(p, '對照');
    check(await ev(p, () => window.__echo.G.hearts) === 2, '大魔王沒拍 → 扣一顆愛心');
    await p.screenshot({ path: `${SHOTS}/compare-${w}x${h}.png` });
    await p.click('#playBack').catch(() => {});
    await ev(p, () => { document.querySelector('#cmpNext').click(); });
    await waitPlay(p);
    await p.click('#playBack');
    await p.waitForSelector('#scrHome.active');
    await p.click('#zPrev');
    await p.click('[data-lv="1-1"]');
    await waitPlay(p);
    check(await ev(p, () => window.__echo.G.R.beats) === 8, '五年級：題目變兩小節');
    await p.screenshot({ path: `${SHOTS}/play2bar-${w}x${h}.png` });
    for (let i = 0; i < 3; i++) { await tapNotes(p); if (i === 0) await p.screenshot({ path: `${SHOTS}/compare2bar-${w}x${h}.png` }); await p.click('#cmpNext'); }
    await p.waitForSelector('#scrResult.active'); await p.waitForTimeout(1300);
    await fits(p, '結果');
    await p.screenshot({ path: `${SHOTS}/result-${w}x${h}.png` });
    await p.click('#resMap');
    await p.click('#btnPractice'); await fits(p, '練習');
    await p.screenshot({ path: `${SHOTS}/practice-${w}x${h}.png` });
    await p.click('#prBack'); await p.click('#btnMission'); await fits(p, '每日任務');
    await p.screenshot({ path: `${SHOTS}/mission-${w}x${h}.png` });
    await p.click('#misBack'); await p.click('#btnShop'); await fits(p, '商店');
    await p.click('#shopBack'); await p.click('#btnSettings'); await fits(p, '設定');
    await p.click('#setTeach'); await p.fill('#tPin', '1234'); await p.click('#tPinOk');
    await p.waitForSelector('#tPing');
    for (const t of ['conn', 'class', 'mod', 'dev', 'other']) { await p.click(`[data-t="${t}"]`); await fits(p, '老師面板 ' + t); }
    await p.click('[data-t="dev"]'); await p.click('#dCal'); await p.waitForSelector('#scrCalib.active'); await fits(p, '延遲校正');
    check(errs.length === 0, '沒有 JS 錯誤' + (errs.length ? '：' + errs.join(' / ') : ''));
    await p.context().close();
  }

  await browser.close(); server.close();
  console.log(`\n通過 ${passes} 項，失敗 ${failures} 項`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
