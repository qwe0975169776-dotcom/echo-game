// ===== 節奏傳聲筒：伺服器程式（放在 GitHub，由 Apps Script 的「啟動程式」自動下載執行）=====
// 注意：這個檔案是公開的，不能寫試算表 ID 和密碼；一律從指令碼屬性讀取。
const CODE_VERSION = 1;

const SHEET_HEADERS = {
  'Users':   ['姓名', '目前金幣', '累計金幣', '段位', '星星總數', '存檔JSON', '最後更新', '更新時間'],
  '成績':     ['時間', '姓名', '模式', '關卡', '速度', '正確率', '星星', 'Perfect', 'Good', 'Miss', '多拍', '平均偏差ms', '錯誤節奏'],
  '排行榜':   ['名次', '姓名', '星星總數', '累計金幣', '段位', '最後更新'],
  '錯誤統計': ['姓名', '節奏', '錯誤次數', '總次數', '錯誤率'],
  '學習報告': ['姓名', '最常拍錯', '快慢傾向', '最近7天正確率', '前7天正確率', '進步', '遊玩次數', '建議練習', '更新時間'],
  '設定':     ['項目', '數值', '說明'],
  '修改器':   ['類別', '項目', '數值', '說明'],
  '修改紀錄': ['時間', '動作', '內容'],
  '廣播':     ['時間', '內容', '到期時間']
};

const CONFIG_DEFAULTS = [
  ['mapClosed', 'false', '關閉冒險地圖（true/false）'],
  ['shopLocked', 'false', '鎖商店（true/false）'],
  ['maxLevel', '', '開放到哪一關，例如 1-3；空白＝全部開放'],
  ['speedMult', '1', '速度倍率，例如 0.8 比較慢、1.2 比較快'],
  ['leniency', '1', '判定寬鬆度：1.4 寬鬆、1 標準、0.75 嚴格'],
  ['classGoal', '500', '全班成就牆目標（全班累積 Perfect 數）']
];

const TOKEN_NAMES = { q: '四分音符', r: '四分休止符', e: '八分音符', h: '二分音符', w: '全音符' };

// 預設關卡（和 index.html 相同；老師可以在「修改器」分頁改速度和節奏）
const LEVEL_DEFAULTS = [
  ['1-1', 70, 'q q q q | q q q r | q q r q'],
  ['1-2', 72, 'q r q r | r q q q | q q r q'],
  ['1-3', 76, 'q r r q | r q r q | q r q q'],
  ['1-4', 80, 'r q q r | q r q q | r r q q'],
  ['1-5', 84, 'q r q q | r q r q | q q q r'],
  ['1-B', 92, 'q r q q q q r q | r q r q q r q q | q q r r q r q q | r q q r q q q r'],
  ['2-1', 70, 'q q e q | e q e q | q e q e'],
  ['2-2', 74, 'e e q r | q e r e | e r e q'],
  ['2-3', 78, 'e e e q | r e e q | q e e e'],
  ['2-4', 82, 'e q r e | e e r q | r e q e'],
  ['2-5', 86, 'e e e e | q e r e | e r e r'],
  ['2-B', 90, 'e q e r q e e q | e e r e q r e e | r e e q e e r q | e r e e e q e q']
];

const MOD_DEFAULTS = [
  ['商店價格', 'drum', 0, '音色：小鼓'],
  ['商店價格', 'clap', 50, '音色：拍手'],
  ['商店價格', 'wood', 80, '音色：木魚'],
  ['商店價格', 'tri', 120, '音色：三角鐵'],
  ['商店價格', 'cat', 150, '音色：小貓'],
  ['商店價格', 'laser', 200, '音色：雷射'],
  ['獎勵', '每顆星金幣', 10, '每關每顆星給的金幣'],
  ['獎勵', '第一次過關', 20, '第一次過關的額外金幣'],
  ['獎勵', '大魔王', 100, '打敗大魔王的額外金幣'],
  ['獎勵', '全對加成', 15, '一回合全部 Perfect 的額外金幣']
];

function pin_() { return String(PropertiesService.getScriptProperties().getProperty('TEACHER_PIN') || '1234'); }
function ss_() { return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID')); }

// 試算表會把「1-3」這種字自動變成日期：寫入時前面加 ' 保持文字，讀出時把日期轉回來
function txt_(v) { const s = String(v); return /^\d{1,2}-\d{1,2}$/.test(s) ? "'" + s : v; }
function norm_(v) {
  if (v instanceof Date || (v && typeof v.getMonth === 'function')) return (v.getMonth() + 1) + '-' + v.getDate();
  return String(v);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_(name) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  const head = SHEET_HEADERS[name];
  if (head) {
    const cur = sh.getLastColumn() > 0 ? sh.getRange(1, 1, 1, head.length).getValues()[0] : [];
    let same = true;
    for (let i = 0; i < head.length; i++) if (String(cur[i] || '') !== head[i]) { same = false; break; }
    if (!same) { sh.getRange(1, 1, 1, head.length).setValues([head]); sh.setFrozenRows(1); }
  }
  return sh;
}

function rows_(sh) {
  const n = sh.getLastRow() - 1, c = sh.getLastColumn();
  if (n <= 0 || c <= 0) return [];
  return sh.getRange(2, 1, n, c).getValues();
}

function setup() {
  Object.keys(SHEET_HEADERS).forEach(function (n) { sheet_(n); });
  const cfg = sheet_('設定'), have = {};
  rows_(cfg).forEach(function (r) { have[norm_(r[0])] = true; });
  CONFIG_DEFAULTS.forEach(function (d) { if (!have[d[0]]) cfg.appendRow(d); });
  const mod = sheet_('修改器'), mh = {};
  rows_(mod).forEach(function (r) { mh[norm_(r[0]) + '|' + norm_(r[1])] = true; });
  MOD_DEFAULTS.forEach(function (d) { if (!mh[d[0] + '|' + d[1]]) mod.appendRow(d); });
  LEVEL_DEFAULTS.forEach(function (d) {
    if (!mh['關卡速度|' + d[0]]) mod.appendRow(['關卡速度', txt_(d[0]), d[1], '每分鐘幾拍 (BPM)']);
    if (!mh['關卡節奏|' + d[0]]) mod.appendRow(['關卡節奏', txt_(d[0]), d[2], 'q=四分 r=休止 e=八分兩個 h=二分 w=全音符；用 | 分隔每一題']);
  });
  if (!mh['說明|玩家']) mod.appendRow(['說明', '玩家', '', '要改小朋友金幣：類別填「玩家金幣」、項目填姓名、數值填金幣；改進度：類別填「玩家進度」、數值填關卡（例如 1-5）']);
  log_('setup', '第 ' + CODE_VERSION + ' 版建立分頁');
  return true;
}

function log_(act, content) {
  try { sheet_('修改紀錄').appendRow([new Date(), act, String(content).slice(0, 500)]); } catch (err) {}
}

function findRow_(sh, col, val) {
  const n = sh.getLastRow() - 1;
  if (n <= 0) return -1;
  const v = sh.getRange(2, col, n, 1).getValues();
  for (let i = 0; i < v.length; i++) if (String(v[i][0]).trim() === String(val).trim()) return i + 2;
  return -1;
}

function starSum_(save) {
  let s = 0; const p = (save && save.progress) || {};
  Object.keys(p).forEach(function (k) { s += Number(p[k]) || 0; });
  return s;
}

function config_() {
  const cfg = {};
  rows_(sheet_('設定')).forEach(function (r) { if (r[0] !== '') cfg[norm_(r[0])] = norm_(r[1]); });
  const mods = rows_(sheet_('修改器')).filter(function (r) { return r[0] !== '' && r[0] !== '說明'; })
    .map(function (r) { return { cat: norm_(r[0]), item: norm_(r[1]), value: norm_(r[2]) }; });
  return { config: cfg, mods: mods };
}

function loadPlayer_(name) {
  const sh = sheet_('Users'), row = findRow_(sh, 1, name);
  if (row < 0) return null;
  const v = sh.getRange(row, 1, 1, 8).getValues()[0];
  try { return JSON.parse(v[5]); } catch (err) { return null; }
}

function writePlayer_(save) {
  const sh = sheet_('Users'), name = String(save.name).trim();
  const vals = [[name, Number(save.coins) || 0, Number(save.total) || 0, save.rank || '', starSum_(save), JSON.stringify(save), Number(save.updated) || Date.now(), new Date()]];
  const row = findRow_(sh, 1, name);
  if (row < 0) sh.appendRow(vals[0]); else sh.getRange(row, 1, 1, 8).setValues(vals);
}

function leaderboard_() {
  const list = rows_(sheet_('Users')).filter(function (r) { return r[0] !== ''; }).map(function (r) {
    return { name: String(r[0]), coins: Number(r[1]) || 0, total: Number(r[2]) || 0, rank: String(r[3]), stars: Number(r[4]) || 0, updated: Number(r[6]) || 0 };
  });
  list.sort(function (a, b) { return b.stars - a.stars || b.total - a.total; });
  return list;
}

function rebuildBoard_() {
  const sh = sheet_('排行榜'), list = leaderboard_();
  const n = sh.getLastRow() - 1;
  if (n > 0) sh.getRange(2, 1, n, 6).clearContent();
  if (list.length) sh.getRange(2, 1, list.length, 6).setValues(list.map(function (p, i) {
    return [i + 1, p.name, p.stars, p.total, p.rank, p.updated ? new Date(p.updated) : ''];
  }));
}

function tokenName_(t) { return TOKEN_NAMES[t] || t; }

function updateErrors_(name, tokens) {
  // tokens: { q: {err:1, tot:4}, ... }
  const sh = sheet_('錯誤統計'), data = rows_(sh);
  Object.keys(tokens || {}).forEach(function (t) {
    const nm = tokenName_(t), add = tokens[t];
    let idx = -1;
    for (let i = 0; i < data.length; i++) if (String(data[i][0]) === name && String(data[i][1]) === nm) { idx = i; break; }
    if (idx < 0) {
      const err = Number(add.err) || 0, tot = Number(add.tot) || 0;
      const r = [name, nm, err, tot, tot ? Math.round(err / tot * 100) + '%' : ''];
      sh.appendRow(r); data.push(r);
    } else {
      const err = (Number(data[idx][2]) || 0) + (Number(add.err) || 0), tot = (Number(data[idx][3]) || 0) + (Number(add.tot) || 0);
      data[idx] = [name, nm, err, tot, tot ? Math.round(err / tot * 100) + '%' : ''];
      sh.getRange(idx + 2, 1, 1, 5).setValues([data[idx]]);
    }
  });
}

const ADVICE = {
  '四分休止符': '休止符不要拍，心裡默數那一拍',
  '四分音符': '跟著節拍器一拍一下，拍在拍點上',
  '八分音符': '八分音符要平均，唸「1 ＋」兩下一樣長',
  '二分音符': '二分音符要按住兩拍再放開',
  '全音符': '全音符要按住四拍再放開'
};

function updateReport_(name) {
  const now = Date.now(), DAY = 86400000;
  const recs = rows_(sheet_('成績')).filter(function (r) { return String(r[1]) === name; });
  let a7 = [], b7 = [], off = 0, offN = 0;
  recs.forEach(function (r) {
    const t = new Date(r[0]).getTime(), acc = Number(r[5]) || 0;
    if (now - t <= 7 * DAY) a7.push(acc); else if (now - t <= 14 * DAY) b7.push(acc);
    if (r[11] !== '' && !isNaN(Number(r[11]))) { off += Number(r[11]); offN++; }
  });
  const avg = function (a) { return a.length ? Math.round(a.reduce(function (x, y) { return x + y; }, 0) / a.length) : ''; };
  const errs = rows_(sheet_('錯誤統計')).filter(function (r) { return String(r[0]) === name && Number(r[3]) > 0; });
  errs.sort(function (a, b) { return (Number(b[2]) / Number(b[3])) - (Number(a[2]) / Number(a[3])); });
  const worst = errs.length && Number(errs[0][2]) > 0 ? String(errs[0][1]) : '（目前沒有）';
  const mo = offN ? Math.round(off / offN) : 0;
  const tend = !offN ? '' : (mo < -25 ? '偏快（平均早 ' + (-mo) + 'ms）' : mo > 25 ? '偏慢（平均晚 ' + mo + 'ms）' : '剛剛好');
  const A = avg(a7), B = avg(b7);
  const prog = (A === '' || B === '') ? '' : (A - B > 0 ? '+' : '') + (A - B) + '%';
  let tip = ADVICE[worst] || '繼續保持，挑戰下一關！';
  if (mo < -25) tip += '；拍子容易搶快，先聽節拍器再拍';
  if (mo > 25) tip += '；拍子容易拖慢，眼睛看卡片提早準備';
  const vals = [name, worst, tend, A === '' ? '' : A + '%', B === '' ? '' : B + '%', prog, recs.length, tip, new Date()];
  const sh = sheet_('學習報告'), row = findRow_(sh, 1, name);
  if (row < 0) sh.appendRow(vals); else sh.getRange(row, 1, 1, vals.length).setValues([vals]);
}

function totalPerfect_() {
  let s = 0;
  rows_(sheet_('成績')).forEach(function (r) { s += Number(r[7]) || 0; });
  return s;
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    const a = p.action || 'ping';
    if (a === 'ping') return json_({ ok: true, version: CODE_VERSION, sheet: ss_().getName() });
    if (a === 'load') {
      const name = String(p.name || '').trim();
      if (!name) return json_({ ok: false, error: '沒有姓名' });
      return json_({ ok: true, save: loadPlayer_(name) });
    }
    if (a === 'class') {
      const c = config_().config;
      return json_({ ok: true, board: leaderboard_().slice(0, 50), totalPerfect: totalPerfect_(), goal: Number(c.classGoal) || 500 });
    }
    if (a === 'config') { const c = config_(); return json_({ ok: true, config: c.config, mods: c.mods, version: CODE_VERSION }); }
    if (a === 'feed') {
      const now = Date.now();
      const msgs = rows_(sheet_('廣播')).filter(function (r) {
        return r[1] !== '' && (!r[2] || new Date(r[2]).getTime() > now);
      }).slice(-5).map(function (r) { return { time: new Date(r[0]).getTime(), text: String(r[1]) }; });
      return json_({ ok: true, msgs: msgs });
    }
    return json_({ ok: false, error: '不認得的動作：' + a });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  let d = {};
  try { d = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return json_({ ok: false, error: '資料格式錯誤' }); }
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return json_({ ok: false, error: '伺服器忙碌，請再試一次' }); }
  try {
    const a = d.action, needPin = ['setConfig', 'setMods', 'setPlayer', 'broadcast', 'selfUpdate'];
    if (needPin.indexOf(a) >= 0 && String(d.pin) !== pin_()) return json_({ ok: false, error: '老師密碼錯誤' });

    if (a === 'save') {
      const s = d.save;
      if (!s || !String(s.name || '').trim()) return json_({ ok: false, error: '沒有姓名' });
      const old = loadPlayer_(s.name);
      if (old && Number(old.updated) > Number(s.updated)) return json_({ ok: true, stale: true, save: old });
      writePlayer_(s);
      rebuildBoard_();
      return json_({ ok: true });
    }
    if (a === 'record') {
      const r = d.record || {}, name = String(r.name || '').trim();
      if (!name) return json_({ ok: false, error: '沒有姓名' });
      sheet_('成績').appendRow([new Date(r.time || Date.now()), name, r.mode || '', txt_(r.level || ''), r.bpm || '', r.acc || 0, r.stars || 0,
        r.perfect || 0, r.good || 0, r.miss || 0, r.extra || 0, r.offset === undefined ? '' : r.offset, JSON.stringify(r.tokens || {})]);
      updateErrors_(name, r.tokens);
      updateReport_(name);
      return json_({ ok: true });
    }
    if (a === 'checkPin') return json_({ ok: String(d.pin) === pin_() });
    if (a === 'setPin') {
      if (String(d.oldPin) !== pin_()) return json_({ ok: false, error: '舊密碼錯誤' });
      const np = String(d.newPin || '').trim();
      if (!np) return json_({ ok: false, error: '新密碼不能空白' });
      PropertiesService.getScriptProperties().setProperty('TEACHER_PIN', np);
      log_('setPin', '老師密碼已更改');
      return json_({ ok: true });
    }
    if (a === 'setConfig') {
      const sh = sheet_('設定'), c = d.config || {};
      Object.keys(c).forEach(function (k) {
        const row = findRow_(sh, 1, k);
        if (row < 0) sh.appendRow([k, txt_(c[k]), '']); else sh.getRange(row, 2).setValue(txt_(c[k]));
      });
      log_('setConfig', JSON.stringify(c));
      return json_({ ok: true, config: config_().config });
    }
    if (a === 'setMods') {
      const sh = sheet_('修改器'), data = rows_(sh);
      (d.rows || []).forEach(function (m) {
        let idx = -1;
        for (let i = 0; i < data.length; i++) if (norm_(data[i][0]) === String(m.cat) && norm_(data[i][1]) === String(m.item)) { idx = i; break; }
        if (idx < 0) { const r = [m.cat, txt_(m.item), txt_(m.value), m.note || '']; sh.appendRow(r); data.push(r); }
        else { data[idx][2] = m.value; sh.getRange(idx + 2, 3).setValue(txt_(m.value)); }
      });
      log_('setMods', JSON.stringify(d.rows));
      return json_({ ok: true });
    }
    if (a === 'setPlayer') {
      const name = String(d.name || '').trim(), s = loadPlayer_(name);
      if (!s) return json_({ ok: false, error: '找不到這位小朋友：' + name });
      if (d.coins !== undefined && d.coins !== '') s.coins = Number(d.coins) || 0;
      if (Array.isArray(d.levels)) { s.progress = s.progress || {}; d.levels.forEach(function (id) { if (!s.progress[id]) s.progress[id] = 1; }); }
      if (d.resetProgress) s.progress = {};
      s.updated = Date.now();
      writePlayer_(s); rebuildBoard_();
      log_('setPlayer', name + ' ' + JSON.stringify({ coins: d.coins, levels: d.levels, reset: !!d.resetProgress }));
      return json_({ ok: true, save: s });
    }
    if (a === 'broadcast') {
      const text = String(d.text || '').trim().slice(0, 80);
      if (!text) return json_({ ok: false, error: '內容空白' });
      const min = Number(d.minutes) || 30;
      sheet_('廣播').appendRow([new Date(), text, new Date(Date.now() + min * 60000)]);
      return json_({ ok: true });
    }
    if (a === 'selfUpdate') {
      if (typeof LOADER === 'undefined') return json_({ ok: false, error: '沒有啟動程式（請確認 Apps Script 貼的是啟動程式）' });
      const app = LOADER.reload();
      return json_({ ok: true, updated: app.CODE_VERSION !== CODE_VERSION, version: app.CODE_VERSION,
        msg: app.CODE_VERSION !== CODE_VERSION ? '已更新到第 ' + app.CODE_VERSION + ' 版' : '已經是最新版（第 ' + app.CODE_VERSION + ' 版）' });
    }
    return json_({ ok: false, error: '不認得的動作：' + a });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}
