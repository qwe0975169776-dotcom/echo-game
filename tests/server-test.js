// 用模擬的 Google 服務測試啟動程式＋Code.gs 的所有動作
const assert = require('assert');
const { makeEnv, loadLoader, codeSrc, call } = require('./gas-mock');

let n = 0;
function ok(cond, msg) { assert.ok(cond, msg); n++; console.log('  ✓ ' + msg); }

const env = makeEnv();
env.github.code = codeSrc();
const ctx = loadLoader(env, 'SHEET123', '5678');

console.log('一次設定');
ctx['一次設定']();
ok(/完成！伺服器程式第 \d+ 版，試算表：傳聲筒成績/.test(env._logs.join('\n')), '紀錄出現「完成！伺服器程式第 N 版」');
ok(env._props.SHEET_ID === 'SHEET123', '試算表 ID 存進指令碼屬性');
ok(env._props.TEACHER_PIN === '5678', '老師密碼存進指令碼屬性');
ok(Number(env._props.CODE_N) >= 1, '伺服器程式有分段備份');
['Users', '成績', '排行榜', '錯誤統計', '學習報告', '設定', '修改器', '修改紀錄', '廣播'].forEach(s => ok(env._sheets[s], '分頁 ' + s + ' 已建立'));
ok(env._sheets['設定']._data.length >= 7, '設定有預設值');
const modCount = env._sheets['修改器'].getLastRow();
ctx['一次設定']();
ok(env._sheets['修改器'].getLastRow() === modCount, '再執行一次設定不會重複新增');

// 表頭被改壞會自動修正
env._sheets['Users']._data[0][0] = '亂改';
ctx['一次設定']();
ok(env._sheets['Users']._data[0][0] === '姓名', '表頭不對時自動修正');

console.log('doGet');
let r = call(ctx, 'GET', { action: 'ping' });
ok(r.ok && r.version >= 1 && r.sheet === '傳聲筒成績', 'ping 回版本和試算表名稱');
r = call(ctx, 'GET', { action: 'config' });
ok(r.ok && r.config.leniency === '1' && r.mods.some(m => m.cat === '關卡速度' && m.item === '1-1'), 'config 回設定和修改器');
r = call(ctx, 'GET', { action: 'load', name: '小明' });
ok(r.ok && r.save === null, '新玩家 load 回 null');

console.log('doPost');
const save1 = { name: '小明', coins: 30, total: 30, rank: '小喇叭', progress: { '1-1': 3 }, updated: 1000 };
r = call(ctx, 'POST', { action: 'save', save: save1 });
ok(r.ok && !r.stale, 'save 成功');
r = call(ctx, 'GET', { action: 'load', name: '小明' });
ok(r.save && r.save.coins === 30, 'load 讀回存檔');
r = call(ctx, 'POST', { action: 'save', save: Object.assign({}, save1, { coins: 5, updated: 500 }) });
ok(r.ok && r.stale && r.save.coins === 30, '舊存檔不會蓋掉新存檔');
r = call(ctx, 'POST', { action: 'save', save: Object.assign({}, save1, { coins: 60, total: 60, updated: 2000 }) });
ok(env._sheets['Users'].getLastRow() === 2, '同一人只保留一列');
call(ctx, 'POST', { action: 'save', save: { name: '小華', coins: 5, total: 5, progress: { '1-1': 1 }, updated: 1500 } });
ok(env._sheets['排行榜']._data[1][1] === '小明', '排行榜依星星排序');

const rec = { name: '小明', mode: '冒險', level: '1-1', bpm: 70, acc: 80, stars: 2, perfect: 6, good: 2, miss: 1, extra: 1, offset: -40, tokens: { q: { err: 1, tot: 8 }, r: { err: 1, tot: 3 } } };
r = call(ctx, 'POST', { action: 'record', record: rec });
ok(r.ok, 'record 成功');
call(ctx, 'POST', { action: 'record', record: Object.assign({}, rec, { tokens: { r: { err: 2, tot: 3 } } }) });
ok(env._sheets['成績'].getLastRow() === 3, '成績寫入兩筆');
const es = env._sheets['錯誤統計']._data.filter(x => x[0] === '小明' && x[1] === '四分休止符')[0];
ok(es && es[2] === 3 && es[3] === 6, '錯誤統計累加');
const rp = env._sheets['學習報告']._data.filter(x => x[0] === '小明')[0];
ok(rp && rp[1] === '四分休止符' && /偏快/.test(rp[2]) && /休止符/.test(rp[7]), '學習報告：最常拍錯、偏快、建議');
r = call(ctx, 'GET', { action: 'class' });
ok(r.ok && r.totalPerfect === 12 && r.board.length === 2 && r.goal === 500, 'class 回排行榜和全班 Perfect');

console.log('老師動作');
r = call(ctx, 'POST', { action: 'setConfig', pin: '0000', config: { leniency: '1.4' } });
ok(!r.ok && /密碼/.test(r.error), '密碼錯誤被擋');
r = call(ctx, 'POST', { action: 'setConfig', pin: '5678', config: { leniency: '1.4', maxLevel: '1-3' } });
ok(r.ok && r.config.leniency === '1.4' && r.config.maxLevel === '1-3', 'setConfig 成功');
r = call(ctx, 'POST', { action: 'checkPin', pin: '5678' });
ok(r.ok, 'checkPin 正確');
r = call(ctx, 'POST', { action: 'setMods', pin: '5678', rows: [{ cat: '關卡速度', item: '1-1', value: 66 }, { cat: '玩家金幣', item: '小華', value: 99 }] });
ok(r.ok, 'setMods 成功');
r = call(ctx, 'GET', { action: 'config' });
ok(r.mods.some(m => m.cat === '關卡速度' && m.item === '1-1' && m.value === '66') && r.mods.some(m => m.cat === '玩家金幣' && m.value === '99'), '修改器數值更新');
r = call(ctx, 'POST', { action: 'setPlayer', pin: '5678', name: '小華', coins: 123, levels: ['1-1', '1-2'] });
ok(r.ok && r.save.coins === 123 && r.save.progress['1-2'] === 1 && r.save.updated > 2000, 'setPlayer 改金幣和進度');
r = call(ctx, 'POST', { action: 'setPlayer', pin: '5678', name: '不存在' });
ok(!r.ok, 'setPlayer 找不到人回錯誤');
r = call(ctx, 'POST', { action: 'broadcast', pin: '5678', text: '大家好棒！', minutes: 10 });
r = call(ctx, 'GET', { action: 'feed' });
ok(r.ok && r.msgs.length === 1 && r.msgs[0].text === '大家好棒！', '廣播與 feed');
ok(env._sheets['修改紀錄'].getLastRow() >= 4, '修改紀錄有寫入');

env._sheets['修改器'].appendRow(['關卡速度', '1-4', 50, '老師直接在試算表打的']);
env._sheets['設定']._data.forEach(r => { if (r[0] === 'maxLevel') r[1] = new Date(2026, 1, 5); });
r = call(ctx, 'GET', { action: 'config' });
ok(r.mods.some(m => m.item === '1-4' && m.value === '50') && r.config.maxLevel === '2-5', '老師在試算表打 1-4、2-5 被變成日期也讀得回來');
console.log('改密碼');
r = call(ctx, 'POST', { action: 'setPin', oldPin: '1111', newPin: '9999' });
ok(!r.ok, '舊密碼錯誤不能改');
r = call(ctx, 'POST', { action: 'setPin', oldPin: '5678', newPin: '9999' });
ok(r.ok && env._props.TEACHER_PIN === '9999', 'setPin 成功');

console.log('selfUpdate 與快取');
r = call(ctx, 'POST', { action: 'selfUpdate', pin: '9999' });
ok(r.ok && r.updated === false && /已經是最新版/.test(r.msg), '沒有新版本時回「已經是最新版」');
env.github.code = codeSrc().replace(/const CODE_VERSION = (\d+);/, (m, v) => 'const CODE_VERSION = ' + (Number(v) + 1) + ';');
r = call(ctx, 'GET', { action: 'ping' });
ok(r.version === 1, '快取 10 分鐘內還是舊版');
r = call(ctx, 'POST', { action: 'selfUpdate', pin: '9999' });
ok(r.ok && r.updated === true && r.version === 2 && r.msg === '已更新到第 2 版', 'selfUpdate 更新到新版');
r = call(ctx, 'GET', { action: 'ping' });
ok(r.version === 2, '更新後 ping 回新版');

console.log('GitHub 連不上');
env.github.up = false;
delete env._cache.code;
r = call(ctx, 'GET', { action: 'ping' });
ok(r.ok && r.version === 2, 'GitHub 連不上時用備份');
env.github.up = true;
env.github.code = '<html>404 Not Found</html>';
delete env._cache.code;
r = call(ctx, 'GET', { action: 'ping' });
ok(r.ok && r.version === 2, 'GitHub 回錯誤內容時也用備份');

console.log('直接貼 Code.gs（沒有啟動程式）');
const env2 = makeEnv(); env2._props.SHEET_ID = 'X';
const vm = require('vm'); const ctx2 = vm.createContext(env2);
vm.runInContext(codeSrc(), ctx2);
ctx2.setup();
r = call(ctx2, 'POST', { action: 'selfUpdate', pin: '1234' });
ok(!r.ok && /啟動程式/.test(r.error), '沒有 LOADER 時 selfUpdate 回錯誤');

console.log('備份大小');
const big = codeSrc() + '\n// ' + '中'.repeat(20000);
const env3 = makeEnv(); env3.github.code = big;
const ctx3 = loadLoader(env3, 'S3');
ctx3['一次設定']();
ok(Number(env3._props.CODE_N) > 5, '大檔案中文也能分段備份（每段不超過 9KB）');

console.log('\n全部通過：' + n + ' 項');
