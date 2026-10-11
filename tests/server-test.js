// 用模擬的 Google 服務測試啟動程式＋Code.gs 的所有動作（第 2 版）
const assert = require('assert');
const vm = require('vm');
const { makeEnv, loadLoader, codeSrc, call } = require('./gas-mock');

let n = 0;
function ok(cond, msg) { assert.ok(cond, msg); n++; console.log('  ✓ ' + msg); }
const DAY = 86400000;
const base = s => ({ rev: s.rev || 0, coins: s.coins || 0, total: s.total || 0, perfect: s.perfect || 0 });
const rec = (name, rid, extra) => Object.assign({ name, rid, time: Date.now(), mode: '冒險', level: '1-1', bpm: 70, acc: 80, stars: 2, perfect: 6, good: 2, miss: 1, extra: 1, offset: -40,
  tokens: { q: { err: 1, tot: 8 }, r: { err: 1, tot: 3 } }, restHits: 1, holdEarly: 0, maxCombo: 6 }, extra || {});

const env = makeEnv(); env.github.code = codeSrc();
const ctx = loadLoader(env, 'SHEET123', '5678');

console.log('一次設定');
ctx['一次設定']();
ok(/完成！伺服器程式第 2 版，試算表：傳聲筒成績/.test(env._logs.join('\n')), '紀錄出現「完成！伺服器程式第 2 版」');
ok(env._props.SHEET_ID === 'SHEET123' && env._props.TEACHER_PIN === '5678', '試算表 ID 和老師密碼存進指令碼屬性');
ok(env._props.FMT === '2', '記下試算表格式第 2 版');
ok(Number(env._props.CODE_N) >= 1, '伺服器程式有分段備份');
['Users', '成績', '排行榜', '錯誤統計', '學習報告', '設定', '修改器', '修改紀錄', '廣播'].forEach(s => ok(env._sheets[s], '分頁 ' + s));
ok(env._sheets['Users']._data[0].length === 11 && env._sheets['成績']._data[0].length === 18, '新欄位（年級、統計、紀錄ID…）都有表頭');
ok(env._sheets['設定']._data.some(r => r[0] === 'readLevels') && env._sheets['修改器']._data.some(r => r[1] === '連擊加成'), '新設定（看譜關卡、連擊加成…）有預設值');
const modCount = env._sheets['修改器'].getLastRow();
ctx['一次設定']();
ok(env._sheets['修改器'].getLastRow() === modCount, '再執行一次設定不會重複新增');
env._sheets['Users']._data[0][0] = '亂改';
ctx['一次設定']();
ok(env._sheets['Users']._data[0][0] === '姓名', '表頭被改壞時一次設定會修正');
ok(env._sheets['修改器']._data.some(r => r[0] === '關卡速度' && r[1] === '1-1'), '關卡代號 1-1 沒有被試算表變成日期');

console.log('讀取');
let r = call(ctx, 'GET', { action: 'ping' });
ok(r.ok && r.version === 2 && r.sheet === '傳聲筒成績', 'ping 回版本和試算表名稱');
r = call(ctx, 'GET', { action: 'state' });
ok(r.ok && r.config.readLevels === 'true' && r.mods.length > 20 && Array.isArray(r.msgs) && !r.save, 'state 一次回設定、修改器、廣播');
r = call(ctx, 'GET', { action: 'load', name: '小明' });
ok(r.ok && r.save === null, '新玩家 load 回 null');

console.log('同步（存檔＋成績一次送）');
const s0 = { name: '小明', grade: 1, coins: 30, total: 30, perfect: 6, progress: { '1-1': 2 }, owned: ['drum'], equip: 'drum', base: { rev: 0, coins: 0, total: 0, perfect: 0 }, lrev: 1, updated: 1 };
r = call(ctx, 'POST', { action: 'sync', save: s0, records: [rec('小明', 'r1')] });
ok(r.ok && r.added === 1 && r.save.rev === 1 && r.save.coins === 30, '新玩家第一次同步：存檔 rev 1、成績 1 筆');
ok(env._sheets['Users'].getLastRow() === 2 && env._sheets['成績'].getLastRow() === 2, 'Users 一列、成績一列');
const urow = env._sheets['Users']._data[1];
ok(urow[8] === 1 && urow[9] === 6 && JSON.parse(urow[10]).plays === 1, 'Users 有年級、Perfect總數、統計JSON');
r = call(ctx, 'POST', { action: 'sync', save: Object.assign({}, s0, { base: base(r.save) }), records: [rec('小明', 'r1')] });
ok(r.ok && r.added === 0 && env._sheets['成績'].getLastRow() === 2, '同一筆成績重送不會重複記錄');
ok(r.save.rev === 1, '內容沒變時 rev 不增加');

console.log('合併存檔（兩台平板、老師修改）');
let srv = call(ctx, 'GET', { action: 'load', name: '小明' }).save;   // rev 1, coins 30
const devA = Object.assign({}, srv, { coins: srv.coins + 20, total: srv.total + 20, progress: { '1-1': 3, '1-2': 1 }, base: base(srv) });
// 平板 B：賺 10（40），再花 30 買拍手 → 10
const devB = Object.assign({}, srv, { coins: 10, total: srv.total + 10, owned: ['drum', 'clap'], equip: 'clap', progress: { '1-1': 2, '1-2': 2 }, base: base(srv) });
r = call(ctx, 'POST', { action: 'sync', save: devA, records: [] });
ok(r.save.coins === 50 && r.save.rev === 2, '平板 A：+20 金幣 → 50');
r = call(ctx, 'POST', { action: 'sync', save: devB, records: [] });
ok(r.save.coins === 30, '平板 B（從同一份舊存檔出發，淨 -20）合併後 → 30，A 賺的沒有被蓋掉');
ok(r.save.progress['1-1'] === 3 && r.save.progress['1-2'] === 2, '星星每關取最高');
ok(r.save.owned.indexOf('clap') >= 0 && r.save.equip === 'clap', '買過的東西保留');
ok(r.save.total === 60, '累計金幣兩台都算到（30+20+10）');

srv = r.save;
r = call(ctx, 'POST', { action: 'setPlayer', pin: '5678', name: '小明', coins: 100, grade: 3 });
ok(r.ok && r.save.coins === 100 && r.save.grade === 3 && r.save.rev === srv.rev + 1, '老師把金幣改成 100、年級改成 3');
const offline = Object.assign({}, srv, { coins: srv.coins + 5, total: srv.total + 5, grade: 1, base: base(srv) });
r = call(ctx, 'POST', { action: 'sync', save: offline, records: [] });
ok(r.save.coins === 105, '平板離線時多賺 5 金幣 → 老師的 100 + 5 = 105');
ok(r.save.grade === 3, '舊平板的年級不會蓋掉老師改的年級');
srv = r.save;
r = call(ctx, 'POST', { action: 'setPlayer', pin: '5678', name: '小明', resetProgress: true });
const stale = Object.assign({}, srv, { progress: { '1-1': 3, '1-2': 2, '1-3': 1 }, base: base(srv) });
r = call(ctx, 'POST', { action: 'sync', save: stale, records: [] });
ok(Object.keys(r.save.progress).length === 0, '老師清除進度後，舊平板的進度不會跑回來');
srv = r.save;
const fresh = Object.assign({}, srv, { progress: { '1-1': 1 }, base: base(srv) });
r = call(ctx, 'POST', { action: 'sync', save: fresh, records: [] });
ok(r.save.progress['1-1'] === 1, '清除之後新玩的進度照常存');

const d1 = { date: '2026-10-11', prog: { perfect: 12, clear: 1 }, claimed: ['perfect15'] };
const d2 = { date: '2026-10-11', prog: { perfect: 5, combo: 9 }, claimed: [] };
srv = r.save;
call(ctx, 'POST', { action: 'sync', save: Object.assign({}, srv, { daily: d1, badges: { first: 1 }, base: base(srv) }), records: [] });
r = call(ctx, 'POST', { action: 'sync', save: Object.assign({}, srv, { daily: d2, badges: { full: 2 }, base: base(srv) }), records: [] });
ok(r.save.daily.prog.perfect === 12 && r.save.daily.prog.combo === 9 && r.save.daily.claimed[0] === 'perfect15', '每日任務進度合併');
ok(r.save.badges.first && r.save.badges.full, '徽章合併');

console.log('第 1 版存檔相容');
call(ctx, 'POST', { action: 'save', save: { name: '小華', coins: 5, total: 5, progress: { '1-1': 1 }, updated: 1500 } });
r = call(ctx, 'POST', { action: 'save', save: { name: '小華', coins: 1, total: 1, progress: { '1-2': 1 }, updated: 1000 } });
ok(r.save.coins === 5 && r.save.progress['1-1'] === 1 && r.save.progress['1-2'] === 1, '第 1 版存檔：較新的勝出、星星合併');
r = call(ctx, 'POST', { action: 'record', record: rec('小華', '', { level: '1-2' }) });
ok(r.ok && r.added === 1, '第 1 版成績也收得到');

console.log('忙碌與錯誤');
const before = env._sheets['成績'].getLastRow();
env.lockBusy = 1;
r = call(ctx, 'POST', { action: 'sync', save: null, records: [rec('小明', 'busy1')] });
ok(!r.ok && r.retry && !r.fatal, '伺服器忙碌 → 回 retry（平板會保留資料重送）');
ok(env._sheets['成績'].getLastRow() === before, '忙碌時沒有寫入');
r = call(ctx, 'POST', { action: 'sync', save: null, records: [rec('小明', 'busy1')] });
ok(r.ok && r.added === 1, '重送成功');
r = call(ctx, 'POST', { action: 'sync', save: { coins: 1 }, records: [] });
ok(!r.ok && r.fatal, '沒有姓名 → fatal（不用重送）');
r = call(ctx, 'POST', { action: 'setConfig', pin: '0000', config: {} });
ok(!r.ok && r.fatal && /密碼/.test(r.error), '老師密碼錯誤 → fatal');

console.log('state 只在伺服器比較新時回存檔');
srv = call(ctx, 'GET', { action: 'load', name: '小明' }).save;
r = call(ctx, 'GET', { action: 'state', name: '小明', rev: srv.rev });
ok(!r.save, '平板已經是最新 → 不回存檔');
r = call(ctx, 'GET', { action: 'state', name: '小明', rev: srv.rev - 1 });
ok(r.save && r.save.rev === srv.rev, '伺服器比較新 → 回存檔');
r = call(ctx, 'GET', { action: 'state', name: '小明', rev: -1 });
ok(r.save, '舊版平板（rev -1）→ 回存檔');

console.log('快取');
call(ctx, 'GET', { action: 'state' });
env._io.reads = 0;
for (let i = 0; i < 30; i++) call(ctx, 'GET', { action: 'state' });
ok(env._io.reads === 0, '全班 30 台一起問設定 → 用快取，不讀試算表');
call(ctx, 'POST', { action: 'setConfig', pin: '5678', config: { leniency: '1.4', maxLevel: '1-3' } });
r = call(ctx, 'GET', { action: 'state' });
ok(r.config.leniency === '1.4' && r.config.maxLevel === '1-3', '老師改設定後快取立刻更新（1-3 沒變成日期）');
call(ctx, 'POST', { action: 'broadcast', pin: '5678', text: '大家好棒！', minutes: 10 });
r = call(ctx, 'GET', { action: 'state' });
ok(r.msgs.length === 1 && r.msgs[0].text === '大家好棒！', '廣播立刻出現');
r = call(ctx, 'GET', { action: 'class' });
ok(r.ok && r.board.length === 2 && r.board[0].stars >= r.board[1].stars && r.board.some(p => p.name === '小明') && r.totalPerfect >= 6 && r.goal === 500, 'class：排行榜（依星星排序）、全班 Perfect、目標');

console.log('效率：成績表很大時同步不會整張重讀');
const big = env._sheets['成績'];
for (let i = 0; i < 3000; i++) big.appendRow([new Date(), '路人' + (i % 40), '冒險', "'1-1", 70, 80, 2, 5, 1, 1, 0, 0, '{}', 'x' + i, 1, '', '', '']);
for (let i = 0; i < 40; i++) call(ctx, 'POST', { action: 'sync', save: { name: '路人' + i, grade: 2, coins: 1, total: 1, progress: {}, base: { rev: 0, coins: 0, total: 0, perfect: 0 } }, records: [] });
env._cache['st:rebuilt'] = { v: '1', exp: Date.now() + 600000 };
env._io.cells = 0;
r = call(ctx, 'POST', { action: 'sync', save: null, records: [rec('小明', 'eff1')] });
ok(r.ok && env._io.cells < 400, '成績表 3000 列時，一次同步只讀 ' + env._io.cells + ' 格（第 1 版要讀 39000 格以上）');

console.log('排行榜／學習報告：最多 10 分鐘整理一次');
const repRows = env._sheets['學習報告'].getLastRow();
call(ctx, 'POST', { action: 'sync', save: null, records: [rec('小明', 'eff2')] });
ok(env._sheets['學習報告'].getLastRow() === repRows, '10 分鐘內不重整（同步很快）');
const now = Date.now();
['old1', 'old2'].forEach((id, i) => call(ctx, 'POST', { action: 'sync', save: null, records: [rec('小美', id, { time: now - 10 * DAY + i, acc: 50, offset: 60, tokens: { e: { err: 3, tot: 6 } } })] }));
['new1', 'new2'].forEach((id, i) => call(ctx, 'POST', { action: 'sync', save: null, records: [rec('小美', id, { time: now - 2 * DAY + i, acc: 90, offset: 60, tokens: { e: { err: 1, tot: 6 } } })] }));
r = call(ctx, 'POST', { action: 'rebuild', pin: '5678' });
ok(r.ok, '老師按「更新排行榜和學習報告」');
const rep = env._sheets['學習報告']._data.find(x => x[0] === '小美');
ok(rep && rep[1] === '八分音符' && /偏慢/.test(rep[2]) && rep[3] === '90%' && rep[4] === '50%' && rep[5] === '+40%', '學習報告：最常拍錯、偏慢、7 天正確率與進步 ' + JSON.stringify(rep && rep.slice(1, 6)));
ok(/八分音符要平均/.test(rep[7]) && /拖慢/.test(rep[7]), '建議練習：' + rep[7]);
const repMing = env._sheets['學習報告']._data.find(x => x[0] === '小明');
ok(repMing && repMing[9] === '3 年級' && repMing[10] >= 3, '學習報告有年級、休止符多拍次數');
ok(env._sheets['錯誤統計']._data.some(x => x[0] === '小美' && x[1] === '八分音符' && x[2] === 8 && x[3] === 24), '錯誤統計累加');
const bd = env._sheets['排行榜']._data.slice(1).filter(x => x[1] !== '');
ok(bd.every((x, i) => i === 0 || bd[i - 1][3] >= x[3]) && bd.some(x => x[1] === '小明' && x[2] === '3 年級'), '排行榜依星星排序、有年級');

console.log('名字是數字也不會亂掉');
call(ctx, 'POST', { action: 'sync', save: { name: '05', coins: 3, total: 3, progress: {}, base: { rev: 0, coins: 0, total: 0, perfect: 0 } }, records: [] });
call(ctx, 'POST', { action: 'sync', save: { name: '05', coins: 4, total: 4, progress: {}, base: { rev: 1, coins: 3, total: 3, perfect: 0 } }, records: [] });
ok(env._sheets['Users']._data.filter(x => x[0] === '05').length === 1, '名字「05」只有一列，不會變成數字 5');
r = call(ctx, 'GET', { action: 'load', name: '05' });
ok(r.save && r.save.coins === 4, '讀得回「05」的存檔');

console.log('老師其他動作');
r = call(ctx, 'POST', { action: 'setMods', pin: '5678', rows: [{ cat: '關卡速度', item: '1-1', value: '66' }, { cat: '玩家金幣', item: '小華', value: '99' }] });
r = call(ctx, 'GET', { action: 'state' });
ok(r.mods.some(m => m.cat === '關卡速度' && m.item === '1-1' && m.value === '66') && r.mods.some(m => m.cat === '玩家金幣' && m.value === '99'), '修改器數值更新');
env._sheets['修改器'].appendRow(['關卡速度', '1-4', 50, '老師直接在試算表打的']);
env._sheets['設定']._data.forEach(x => { if (x[0] === 'maxLevel') x[1] = new Date(2026, 1, 5); });
env._cache['st:pub'] = undefined; delete env._cache['st:pub'];
r = call(ctx, 'GET', { action: 'state' });
ok(r.mods.some(m => m.item === '1-4' && m.value === '50') && r.config.maxLevel === '2-5', '老師在試算表打 1-4、2-5 被變成日期也讀得回來');
r = call(ctx, 'POST', { action: 'checkPin', pin: '5678' }); ok(r.ok, 'checkPin');
r = call(ctx, 'POST', { action: 'setPin', oldPin: '1111', newPin: '9999' }); ok(!r.ok, '舊密碼錯誤不能改');
r = call(ctx, 'POST', { action: 'setPin', oldPin: '5678', newPin: '9999' }); ok(r.ok && env._props.TEACHER_PIN === '9999', 'setPin 成功');
ok(env._sheets['修改紀錄'].getLastRow() >= 5, '修改紀錄有寫入');

console.log('selfUpdate 與 GitHub 備份');
r = call(ctx, 'POST', { action: 'selfUpdate', pin: '9999' });
ok(r.ok && r.updated === false && /已經是最新版（第 2 版）/.test(r.msg), '沒有新版本 →「已經是最新版」');
env.github.code = codeSrc().replace(/const CODE_VERSION = (\d+);/, (m, v) => 'const CODE_VERSION = ' + (Number(v) + 1) + ';');
r = call(ctx, 'GET', { action: 'ping' }); ok(r.version === 2, '快取 10 分鐘內還是舊版');
r = call(ctx, 'POST', { action: 'selfUpdate', pin: '9999' }); ok(r.ok && r.updated && r.msg === '已更新到第 3 版', 'selfUpdate 更新到新版');
r = call(ctx, 'GET', { action: 'ping' }); ok(r.version === 3, '更新後 ping 回新版');
env.github.up = false; delete env._cache.code;
r = call(ctx, 'GET', { action: 'ping' }); ok(r.ok && r.version === 3, 'GitHub 連不上時用備份');
env.github.up = true; env.github.code = '<html>404</html>'; delete env._cache.code;
r = call(ctx, 'GET', { action: 'ping' }); ok(r.ok && r.version === 3, 'GitHub 回錯誤內容時也用備份');

console.log('從第 1 版升級（已經有資料的試算表）');
const env1 = makeEnv(); env1.github.code = codeSrc();
const c1 = loadLoader(env1, 'OLD', '1234');
env1._props.SHEET_ID = 'OLD';
const ss = env1.SpreadsheetApp.openById('OLD');
const U = ss.insertSheet('Users'); U.appendRow(['姓名', '目前金幣', '累計金幣', '段位', '星星總數', '存檔JSON', '最後更新', '更新時間']);
U.appendRow(['阿寶', 40, 60, '小鼓手', 6, JSON.stringify({ name: '阿寶', coins: 40, total: 60, perfect: 22, progress: { '1-1': 3, '1-2': 3 }, owned: ['drum'], updated: 5000 }), 5000, new Date()]);
const C = ss.insertSheet('成績'); C.appendRow(['時間', '姓名', '模式', '關卡', '速度', '正確率', '星星', 'Perfect', 'Good', 'Miss', '多拍', '平均偏差ms', '錯誤節奏']);
C.appendRow([new Date(Date.now() - DAY), '阿寶', '冒險', "'1-1", 70, 90, 3, 10, 0, 0, 0, -10, JSON.stringify({ q: { err: 0, tot: 8 }, r: { err: 1, tot: 2 } })]);
r = call(c1, 'POST', { action: 'sync', save: null, records: [rec('阿寶', 'n1')] });
ok(r.ok && env1._props.FMT === '2', '第一次呼叫就自動升級（不用重貼、不用重新部署）');
ok(env1._sheets['Users']._data[0].length === 11 && env1._sheets['成績']._data[0][13] === '紀錄ID', '自動補上新欄位表頭');
const st = JSON.parse(env1._sheets['Users']._data[1][10]);
ok(st.plays === 2 && st.tok.r[0] === 2, '舊成績也算進統計（' + st.plays + ' 筆）');
ok(env1._sheets['Users']._data[1][9] === 22, 'Perfect總數從舊存檔帶過來');
r = call(c1, 'GET', { action: 'load', name: '阿寶' });
ok(r.save.coins === 40 && r.save.progress['1-2'] === 3, '舊存檔完整保留');

console.log('沒有啟動程式時');
const env2 = makeEnv(); env2._props.SHEET_ID = 'X';
const ctx2 = vm.createContext(env2);
vm.runInContext(codeSrc(), ctx2);
ctx2.setup();
r = call(ctx2, 'POST', { action: 'selfUpdate', pin: '1234' });
ok(!r.ok && /啟動程式/.test(r.error), '沒有 LOADER 時 selfUpdate 回錯誤');

console.log('備份大小');
const env3 = makeEnv(); env3.github.code = codeSrc() + '\n// ' + '中'.repeat(20000);
const ctx3 = loadLoader(env3, 'S3');
ctx3['一次設定']();
ok(Number(env3._props.CODE_N) > 5, '大檔案中文也能分段備份（每段不超過 9KB）');

console.log('\n全部通過：' + n + ' 項');
