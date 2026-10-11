// ===== 節奏傳聲筒：伺服器程式（放在 GitHub，由 Apps Script 的「啟動程式」自動下載執行）=====
// 注意：這個檔案是公開的，不能寫試算表 ID 和密碼；一律從指令碼屬性讀取。
// 快取（CacheService）的鍵一律用 'st:' 開頭；'code' 是啟動程式在用的，這裡不能用。
const CODE_VERSION = 2;
const FMT = 2;   // 試算表格式版本：表頭有改就 +1，伺服器會自動補上新欄位

const SHEET_HEADERS = {
  'Users':   ['姓名', '目前金幣', '累計金幣', '段位', '星星總數', '存檔JSON', '最後更新', '更新時間', '年級', 'Perfect總數', '統計JSON'],
  '成績':     ['時間', '姓名', '模式', '關卡', '速度', '正確率', '星星', 'Perfect', 'Good', 'Miss', '多拍', '平均偏差ms', '錯誤節奏', '紀錄ID', '年級', '看譜', '協助題數', '最高連擊'],
  '排行榜':   ['名次', '姓名', '年級', '星星總數', '累計金幣', '段位', '最後更新'],
  '錯誤統計': ['姓名', '節奏', '錯誤次數', '總次數', '錯誤率'],
  '學習報告': ['姓名', '最常拍錯', '快慢傾向', '最近7天正確率', '前7天正確率', '進步', '遊玩次數', '建議練習', '更新時間', '年級', '休止符多拍', '長音符太早放'],
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
  ['leniency', '1', '判定寬鬆度：1.4 寬鬆、1 標準、0.75 嚴格（會再依年級自動調整）'],
  ['classGoal', '500', '全班成就牆目標（全班累積 Perfect 數）'],
  ['readLevels', 'true', '看譜關卡：每區第 4、5 關（三年級以上含大魔王）先看卡片自己拍（true/false）'],
  ['voice', 'true', '語音提示（true/false）']
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
  ['獎勵', '全對加成', 15, '一回合全部 Perfect 的額外金幣'],
  ['獎勵', '連擊加成', 2, '每 5 連擊給的金幣'],
  ['獎勵', '每日任務', 20, '每完成一個每日任務給的金幣']
];

const RANKS = [[0, '節奏小芽'], [5, '小鼓手'], [12, '節奏手'], [20, '節奏高手'], [28, '節奏達人'], [34, '節奏大師']];

const ADVICE = {
  '四分休止符': '休止符不要拍，心裡默數那一拍',
  '四分音符': '跟著節拍器一拍一下，拍在拍點上',
  '八分音符': '八分音符要平均，唸「1 ＋」兩下一樣長',
  '二分音符': '二分音符要按住兩拍再放開',
  '全音符': '全音符要按住四拍再放開'
};

// ---------- 基本工具 ----------
function pin_() { return String(PropertiesService.getScriptProperties().getProperty('TEACHER_PIN') || '1234'); }
let SS_ = null;
const SH_ = {};
function ss_() {
  if (!SS_) SS_ = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  return SS_;
}
function cache_() { return CacheService.getScriptCache(); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function clone_(o) { return JSON.parse(JSON.stringify(o)); }
function parse_(s, d) { try { return s ? JSON.parse(s) : d; } catch (err) { return d; } }
function num_(v) { return Number(v) || 0; }

// 試算表會把「1-3」「05」「true」這種字自動改成日期／數字：寫入時前面加 ' 保持原樣，讀出時把日期轉回來
function txt_(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@]/.test(v) || /^[\d\s.,:\/\-]+$/.test(v) || /^(true|false)$/i.test(v) ? "'" + v : v;
}
function norm_(v) {
  if (v instanceof Date || (v && typeof v.getMonth === 'function')) return (v.getMonth() + 1) + '-' + v.getDate();
  return v === null || v === undefined ? '' : String(v);
}
function stable_(o) {
  if (Array.isArray(o)) return '[' + o.map(stable_).join(',') + ']';
  if (o && typeof o === 'object') return '{' + Object.keys(o).sort().map(function (k) { return JSON.stringify(k) + ':' + stable_(o[k]); }).join(',') + '}';
  return o === undefined ? 'null' : JSON.stringify(o);
}
function maxMap_(a, b) {
  const o = Object.assign({}, a || {});
  Object.keys(b || {}).forEach(function (k) { o[k] = Math.max(num_(o[k]), num_(b[k])); });
  return o;
}
function union_(a, b) {
  const o = (a || []).slice();
  (b || []).forEach(function (x) { if (o.indexOf(x) < 0) o.push(x); });
  return o;
}
function dayKey_(t) { return new Date(t + 8 * 3600000).toISOString().slice(0, 10); }   // 台灣日期

// ---------- 分頁 ----------
function sheet_(name) {
  if (SH_[name]) return SH_[name];
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    const h = SHEET_HEADERS[name];
    if (h) { sh.getRange(1, 1, 1, h.length).setValues([h]); sh.setFrozenRows(1); }
  }
  SH_[name] = sh;
  return sh;
}
function fixHeaders_() {
  Object.keys(SHEET_HEADERS).forEach(function (n) {
    const sh = sheet_(n), head = SHEET_HEADERS[n];
    const cur = sh.getRange(1, 1, 1, head.length).getValues()[0];
    let same = true;
    for (let i = 0; i < head.length; i++) if (norm_(cur[i]) !== head[i]) { same = false; break; }
    if (!same) { sh.getRange(1, 1, 1, head.length).setValues([head]); sh.setFrozenRows(1); }
  });
}
function rows_(sh, c0, nc) {
  const n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  c0 = c0 || 1;
  nc = nc || sh.getLastColumn() - c0 + 1;
  if (nc <= 0) return [];
  return sh.getRange(2, c0, n, nc).getValues();
}
function findRow_(sh, col, val) {
  const n = sh.getLastRow() - 1;
  if (n <= 0) return -1;
  const v = sh.getRange(2, col, n, 1).getValues(), key = String(val).trim();
  for (let i = 0; i < v.length; i++) if (norm_(v[i][0]).trim() === key) return i + 2;
  return -1;
}
function writeTable_(sh, rows, nc) {
  const n = sh.getLastRow() - 1, w = Math.max(nc, sh.getLastColumn());
  if (n > 0) sh.getRange(2, 1, n, w).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, nc).setValues(rows);
}
function log_(act, content) {
  try { sheet_('修改紀錄').appendRow([new Date(), act, String(content).slice(0, 500)]); } catch (err) {}
}

function seedDefaults_() {
  const cfg = sheet_('設定'), have = {};
  rows_(cfg, 1, 1).forEach(function (r) { have[norm_(r[0])] = true; });
  CONFIG_DEFAULTS.forEach(function (d) { if (!have[d[0]]) cfg.appendRow([d[0], txt_(d[1]), d[2]]); });
  const mod = sheet_('修改器'), mh = {};
  rows_(mod, 1, 2).forEach(function (r) { mh[norm_(r[0]) + '|' + norm_(r[1])] = true; });
  MOD_DEFAULTS.forEach(function (d) { if (!mh[d[0] + '|' + d[1]]) mod.appendRow(d); });
  LEVEL_DEFAULTS.forEach(function (d) {
    if (!mh['關卡速度|' + d[0]]) mod.appendRow(['關卡速度', txt_(d[0]), d[1], '每分鐘幾拍 (BPM)，會再依年級自動調整']);
    if (!mh['關卡節奏|' + d[0]]) mod.appendRow(['關卡節奏', txt_(d[0]), d[2], 'q=四分 r=休止 e=八分兩個 h=二分 w=全音符；用 | 分隔每一題']);
  });
  if (!mh['說明|玩家']) mod.appendRow(['說明', '玩家', '', '要改小朋友金幣：類別填「玩家金幣」、項目填姓名、數值填金幣；改進度：類別填「玩家進度」、數值填關卡（例如 1-5）']);
}

// 第 1 版的資料升級：從「成績」重建每個人的統計
function migrate_() {
  const us = sheet_('Users'), n = us.getLastRow() - 1;
  if (n <= 0) return;
  const rows = us.getRange(2, 1, n, 11).getValues();
  if (!rows.some(function (r) { return norm_(r[0]) && r[10] === ''; })) return;
  const by = {};
  rows_(sheet_('成績'), 1, 14).forEach(function (r) {
    const name = norm_(r[1]).trim();
    if (!name) return;
    const st = by[name] || (by[name] = newStats_());
    addRecStats_(st, { acc: r[5], offset: r[11], tokens: parse_(r[12], {}), rid: r[13] }, new Date(r[0]).getTime() || Date.now());
  });
  rows.forEach(function (r, i) {
    const name = norm_(r[0]).trim();
    if (!name || r[10] !== '') return;
    const save = parse_(r[5], {}) || {};
    us.getRange(i + 2, 9, 1, 3).setValues([[save.grade || '', num_(save.perfect), JSON.stringify(by[name] || newStats_())]]);
  });
}

function ensureFmt_() {
  const p = PropertiesService.getScriptProperties();
  if (num_(p.getProperty('FMT')) >= FMT) return false;
  fixHeaders_(); seedDefaults_(); migrate_();
  p.setProperty('FMT', String(FMT));
  try { cache_().remove('st:rebuilt'); cache_().remove('st:pub'); cache_().remove('st:class'); } catch (err) {}
  return true;
}

function setup() {
  fixHeaders_(); seedDefaults_(); migrate_();
  PropertiesService.getScriptProperties().setProperty('FMT', String(FMT));
  rebuildAll_();
  try { cache_().remove('st:pub'); cache_().remove('st:class'); cache_().put('st:rebuilt', '1', 600); } catch (err) {}
  log_('setup', '第 ' + CODE_VERSION + ' 版建立分頁');
  return true;
}

// ---------- 玩家存檔 ----------
function starSum_(save) {
  let s = 0; const p = (save && save.progress) || {};
  Object.keys(p).forEach(function (k) { s += num_(p[k]); });
  return s;
}
function rankOf_(save) {
  const s = starSum_(save); let r = RANKS[0][1];
  RANKS.forEach(function (x) { if (s >= x[0]) r = x[1]; });
  return r;
}
function userRow_(name) {
  const sh = sheet_('Users'), row = findRow_(sh, 1, name);
  if (row < 0) return null;
  const v = sh.getRange(row, 1, 1, 11).getValues()[0];
  return { row: row, save: parse_(v[5], null), stats: parse_(v[10], null) };
}
function writeUser_(row, save, stats) {
  save.rank = rankOf_(save);
  const vals = [txt_(String(save.name)), num_(save.coins), num_(save.total), save.rank, starSum_(save), JSON.stringify(save),
    num_(save.updated) || Date.now(), new Date(), num_(save.grade) || '', num_(save.perfect), stats ? JSON.stringify(stats) : ''];
  const sh = sheet_('Users');
  if (row < 0) sh.appendRow(vals); else sh.getRange(row, 1, 1, 11).setValues([vals]);
}

function mergeDaily_(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  if (a.date !== b.date) return a.date > b.date ? a : b;
  return { date: a.date, ids: (a.ids && a.ids.length ? a.ids : b.ids) || [], prog: maxMap_(a.prog, b.prog), claimed: union_(a.claimed, b.claimed) };
}
// 合併：金幣用「這台平板從上次同步後多出來的部分」相加；星星每關取最高；買過的東西都保留
function mergeSave_(srv, loc) {
  const out = clone_(srv), b = loc.base || {}, bRev = num_(b.rev);
  ['coins', 'total', 'perfect'].forEach(function (k) { out[k] = Math.max(0, num_(srv[k]) + num_(loc[k]) - num_(b[k])); });
  if (!(num_(srv.resetRev) > bRev)) out.progress = maxMap_(srv.progress, loc.progress);
  out.owned = union_(srv.owned || ['drum'], loc.owned);
  if (loc.equip && out.owned.indexOf(loc.equip) >= 0) out.equip = loc.equip;
  out.appliedMods = union_(srv.appliedMods, loc.appliedMods);
  out.wallClaim = Math.max(num_(srv.wallClaim), num_(loc.wallClaim));
  out.badges = Object.assign({}, loc.badges || {}, srv.badges || {});
  out.daily = mergeDaily_(srv.daily, loc.daily);
  if (!(num_(srv.gradeRev) > bRev) && loc.grade) out.grade = loc.grade;
  return out;
}
// 補齊欄位，讓「沒有這個欄位」和「空的」看成一樣
function normSave_(s) {
  s.coins = num_(s.coins); s.total = num_(s.total); s.perfect = num_(s.perfect);
  s.progress = s.progress || {}; s.owned = s.owned && s.owned.length ? s.owned : ['drum']; s.equip = s.equip || 'drum';
  s.appliedMods = s.appliedMods || []; s.wallClaim = num_(s.wallClaim); s.badges = s.badges || {}; s.daily = s.daily || null;
  return s;
}
function sig_(s) {
  const c = normSave_(clone_(s || {}));
  ['rev', 'updated', 'base', 'lrev', 'rank'].forEach(function (k) { delete c[k]; });
  return stable_(c);
}
function mergeIn_(st, inc) {
  let out;
  if (!inc.base) {   // 第 1 版的存檔：比較更新時間，星星取最高
    out = clone_(num_(inc.updated) > num_(st.updated) ? inc : st);
    out.progress = maxMap_(st.progress, inc.progress);
    out.owned = union_(st.owned, inc.owned);
  } else out = mergeSave_(st, inc);
  out.name = st.name;
  delete out.base; delete out.lrev;
  normSave_(out);
  const changed = sig_(out) !== sig_(st);
  out.rev = num_(st.rev) + (changed ? 1 : 0);
  out.updated = changed ? Date.now() : num_(st.updated);
  return { save: out, changed: changed };
}
function initSave_(inc) {
  const out = clone_(inc);
  delete out.base; delete out.lrev;
  out.name = String(inc.name).trim();
  out.rev = 1; out.updated = Date.now();
  return normSave_(out);
}

// ---------- 統計（每人一份，存在 Users 的「統計JSON」，不用每次重讀整張成績表）----------
function newStats_() { return { tok: {}, days: {}, off: 0, offN: 0, plays: 0, rest: 0, hold: 0, rids: [] }; }
function addRecStats_(st, r, t) {
  st.plays++;
  const tk = r.tokens || {};
  Object.keys(tk).forEach(function (k) {
    const a = st.tok[k] || (st.tok[k] = [0, 0]);
    a[0] += num_(tk[k] && tk[k].err); a[1] += num_(tk[k] && tk[k].tot);
  });
  const day = dayKey_(t), d = st.days[day] || (st.days[day] = [0, 0]);
  d[0]++; d[1] += num_(r.acc);
  if (r.offset !== undefined && r.offset !== '' && r.offset !== null && !isNaN(Number(r.offset))) { st.off += Number(r.offset); st.offN++; }
  st.rest += num_(r.restHits); st.hold += num_(r.holdEarly);
  if (r.rid) { st.rids.push(String(r.rid)); if (st.rids.length > 80) st.rids = st.rids.slice(-80); }
  const keys = Object.keys(st.days).sort();
  while (keys.length > 60) delete st.days[keys.shift()];
}
function recTime_(r) {
  const now = Date.now(), t = num_(r.time) || now;
  return t > now - 30 * 86400000 && t < now + 86400000 ? t : now;
}
function appendRecord_(name, grade, r, t) {
  sheet_('成績').appendRow([new Date(t), txt_(name), r.mode || '', txt_(String(r.level || '')), r.bpm || '', num_(r.acc), num_(r.stars),
    num_(r.perfect), num_(r.good), num_(r.miss), num_(r.extra), r.offset === undefined ? '' : r.offset, JSON.stringify(r.tokens || {}),
    r.rid || '', grade || '', r.read ? '看譜' : '', num_(r.assist) || '', num_(r.maxCombo) || '']);
}

// 一次送：存檔＋成績（同一筆成績重送不會重複記）
function sync_(d) {
  const inc = d.save && typeof d.save === 'object' ? d.save : null;
  const recs = Array.isArray(d.records) ? d.records : [];
  const name = String((inc && inc.name) || (recs[0] && recs[0].name) || '').trim();
  if (!name) return { ok: false, fatal: true, error: '沒有姓名' };
  const u = userRow_(name);
  let save = u ? u.save : null, changed = !u;
  const stats = (u && u.stats) || newStats_();
  let added = 0;
  recs.forEach(function (r) {
    if (!r || String(r.name || name).trim() !== name) return;
    if (r.rid && stats.rids.indexOf(String(r.rid)) >= 0) return;
    const t = recTime_(r);
    appendRecord_(name, (inc && inc.grade) || (save && save.grade) || r.grade, r, t);
    addRecStats_(stats, r, t);
    added++;
  });
  if (inc) {
    if (save) { const m = mergeIn_(save, inc); save = m.save; changed = changed || m.changed; }
    else { save = initSave_(inc); changed = true; }
  }
  if (!save) { save = initSave_({ name: name, coins: 0, total: 0, perfect: 0, progress: {}, owned: ['drum'], equip: 'drum' }); changed = true; }
  if (changed || added || (u && !u.stats)) writeUser_(u ? u.row : -1, save, stats);
  if (changed || added) { try { cache_().remove('st:class'); } catch (err) {} }
  maybeRebuild_(false);
  return { ok: true, save: save, added: added };
}

// ---------- 排行榜、錯誤統計、學習報告：最多 10 分鐘整理一次（或老師按按鈕）----------
function maybeRebuild_(force) {
  const c = cache_();
  if (!force && c.get('st:rebuilt')) return false;
  rebuildAll_();
  try { c.put('st:rebuilt', '1', 600); c.remove('st:class'); } catch (err) {}
  return true;
}
function players_(withStats) {
  const us = sheet_('Users'), n = us.getLastRow() - 1;
  if (n <= 0) return [];
  const A = us.getRange(2, 1, n, 5).getValues(), B = us.getRange(2, 7, n, withStats ? 5 : 4).getValues(), out = [];
  for (let i = 0; i < n; i++) {
    const name = norm_(A[i][0]).trim();
    if (!name) continue;
    out.push({ name: name, coins: num_(A[i][1]), total: num_(A[i][2]), rank: norm_(A[i][3]), stars: num_(A[i][4]),
      updated: num_(B[i][0]), grade: num_(B[i][2]) || '', perfect: num_(B[i][3]), stats: withStats ? parse_(B[i][4], null) : null });
  }
  return out;
}
function reportRow_(p, now) {
  const st = p.stats, d7 = dayKey_(now - 7 * 86400000), d14 = dayKey_(now - 14 * 86400000);
  const a = [0, 0], b = [0, 0];
  Object.keys(st.days).forEach(function (k) {
    const v = st.days[k];
    if (k > d7) { a[0] += v[0]; a[1] += v[1]; } else if (k > d14) { b[0] += v[0]; b[1] += v[1]; }
  });
  const A = a[0] ? Math.round(a[1] / a[0]) : '', B = b[0] ? Math.round(b[1] / b[0]) : '';
  let worst = '', wr = 0;
  Object.keys(st.tok).forEach(function (k) {
    const v = st.tok[k];
    if (v[1] >= 3 && v[0] > 0 && v[0] / v[1] > wr) { wr = v[0] / v[1]; worst = TOKEN_NAMES[k] || k; }
  });
  const mo = st.offN ? Math.round(st.off / st.offN) : 0;
  const tend = !st.offN ? '' : (mo < -25 ? '偏快（平均早 ' + (-mo) + 'ms）' : mo > 25 ? '偏慢（平均晚 ' + mo + 'ms）' : '剛剛好');
  const prog = (A === '' || B === '') ? '' : (A - B > 0 ? '+' : '') + (A - B) + '%';
  let tip = ADVICE[worst] || '繼續保持，挑戰下一關！';
  if (st.rest >= 3 && worst !== '四分休止符') tip += '；休止符那一拍手要停住';
  if (st.hold >= 3) tip += '；長音符要按到數完再放開';
  if (mo < -25) tip += '；拍子容易搶快，先聽節拍器再拍';
  if (mo > 25) tip += '；拍子容易拖慢，眼睛看小球提早準備';
  return [txt_(p.name), worst || '（目前沒有）', tend, A === '' ? '' : A + '%', B === '' ? '' : B + '%', prog, st.plays, tip, new Date(),
    p.grade ? p.grade + ' 年級' : '', st.rest, st.hold];
}
function rebuildAll_() {
  const ps = players_(true), now = Date.now();
  const board = ps.slice().sort(function (a, b) { return b.stars - a.stars || b.total - a.total; });
  writeTable_(sheet_('排行榜'), board.map(function (p, i) {
    return [i + 1, txt_(p.name), p.grade ? p.grade + ' 年級' : '', p.stars, p.total, p.rank, p.updated ? new Date(p.updated) : ''];
  }), 7);
  const err = [];
  ps.forEach(function (p) {
    if (!p.stats) return;
    Object.keys(p.stats.tok).forEach(function (k) {
      const v = p.stats.tok[k];
      if (v[1] > 0) err.push([txt_(p.name), TOKEN_NAMES[k] || k, v[0], v[1], Math.round(v[0] / v[1] * 100) + '%']);
    });
  });
  writeTable_(sheet_('錯誤統計'), err, 5);
  const rep = [];
  ps.forEach(function (p) { if (p.stats && p.stats.plays) rep.push(reportRow_(p, now)); });
  writeTable_(sheet_('學習報告'), rep, 12);
}

// ---------- 公開資料（設定、修改器、廣播、排行榜）有快取，全班一起問也不會塞車 ----------
function pub_() {
  const c = cache_(), hit = c.get('st:pub');
  if (hit) return JSON.parse(hit);
  const cfg = {};
  rows_(sheet_('設定'), 1, 2).forEach(function (r) { const k = norm_(r[0]); if (k) cfg[k] = norm_(r[1]); });
  const mods = rows_(sheet_('修改器'), 1, 3).filter(function (r) { return norm_(r[0]) && norm_(r[0]) !== '說明'; })
    .map(function (r) { return { cat: norm_(r[0]), item: norm_(r[1]), value: norm_(r[2]) }; });
  const now = Date.now();
  const msgs = rows_(sheet_('廣播'), 1, 3).filter(function (r) { return norm_(r[1]) && (!r[2] || new Date(r[2]).getTime() > now); })
    .slice(-5).map(function (r) { return { time: new Date(r[0]).getTime(), text: norm_(r[1]), exp: r[2] ? new Date(r[2]).getTime() : 0 }; });
  const out = { config: cfg, mods: mods, msgs: msgs };
  try { c.put('st:pub', JSON.stringify(out), 30); } catch (err) {}
  return out;
}
function liveMsgs_() {
  const now = Date.now();
  return pub_().msgs.filter(function (m) { return !m.exp || m.exp > now; });
}
function classInfo_() {
  const c = cache_(), hit = c.get('st:class');
  if (hit) return JSON.parse(hit);
  const ps = players_(false);
  let total = 0;
  ps.forEach(function (p) { total += p.perfect; });
  ps.sort(function (a, b) { return b.stars - a.stars || b.total - a.total; });
  const out = {
    board: ps.slice(0, 50).map(function (p) { return { name: p.name, grade: p.grade, rank: p.rank, stars: p.stars, total: p.total }; }),
    totalPerfect: total, goal: Number(pub_().config.classGoal) || 500
  };
  try { c.put('st:class', JSON.stringify(out), 60); } catch (err) {}
  return out;
}
function dropPub_() { try { cache_().remove('st:pub'); cache_().remove('st:class'); } catch (err) {} }

// ---------- 網址呼叫 ----------
function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    const a = p.action || 'ping';
    if (a === 'ping') {
      const lock = LockService.getScriptLock();
      if (lock.tryLock(5000)) { try { ensureFmt_(); } finally { lock.releaseLock(); } }
      return json_({ ok: true, version: CODE_VERSION, sheet: ss_().getName() });
    }
    if (a === 'load') {
      const name = String(p.name || '').trim();
      if (!name) return json_({ ok: false, error: '沒有姓名' });
      const u = userRow_(name);
      return json_({ ok: true, save: u ? u.save : null });
    }
    if (a === 'state') {
      const pb = pub_(), out = { ok: true, version: CODE_VERSION, config: pb.config, mods: pb.mods, msgs: liveMsgs_() };
      const name = String(p.name || '').trim();
      if (name) {
        const u = userRow_(name);
        if (u && u.save && num_(u.save.rev) > Number(p.rev === undefined ? -1 : p.rev)) out.save = u.save;
      }
      return json_(out);
    }
    if (a === 'class') {
      const ci = classInfo_();
      return json_({ ok: true, board: ci.board, totalPerfect: ci.totalPerfect, goal: ci.goal });
    }
    if (a === 'config') { const pb = pub_(); return json_({ ok: true, config: pb.config, mods: pb.mods, version: CODE_VERSION }); }
    if (a === 'feed') return json_({ ok: true, msgs: liveMsgs_() });
    return json_({ ok: false, error: '不認得的動作：' + a });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  let d = {};
  try { d = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return json_({ ok: false, fatal: true, error: '資料格式錯誤' }); }
  const lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (err) { return json_({ ok: false, retry: true, error: '伺服器忙碌，請再試一次' }); }
  try {
    ensureFmt_();
    const a = d.action, needPin = ['setConfig', 'setMods', 'setPlayer', 'broadcast', 'selfUpdate', 'rebuild'];
    if (needPin.indexOf(a) >= 0 && String(d.pin) !== pin_()) return json_({ ok: false, fatal: true, error: '老師密碼錯誤' });

    if (a === 'sync') return json_(sync_(d));
    if (a === 'save') return json_(sync_({ save: d.save, records: [] }));          // 第 1 版相容
    if (a === 'record') return json_(sync_({ save: null, records: [d.record] }));  // 第 1 版相容
    if (a === 'checkPin') return json_({ ok: String(d.pin) === pin_() });
    if (a === 'setPin') {
      if (String(d.oldPin) !== pin_()) return json_({ ok: false, fatal: true, error: '舊密碼錯誤' });
      const np = String(d.newPin || '').trim();
      if (!np) return json_({ ok: false, fatal: true, error: '新密碼不能空白' });
      PropertiesService.getScriptProperties().setProperty('TEACHER_PIN', np);
      log_('setPin', '老師密碼已更改');
      return json_({ ok: true });
    }
    if (a === 'setConfig') {
      const sh = sheet_('設定'), c = d.config || {};
      Object.keys(c).forEach(function (k) {
        const row = findRow_(sh, 1, k);
        if (row < 0) sh.appendRow([k, txt_(String(c[k])), '']); else sh.getRange(row, 2).setValue(txt_(String(c[k])));
      });
      dropPub_();
      log_('setConfig', JSON.stringify(c));
      return json_({ ok: true, config: pub_().config });
    }
    if (a === 'setMods') {
      const sh = sheet_('修改器'), data = rows_(sh, 1, 3);
      (d.rows || []).forEach(function (m) {
        let idx = -1;
        for (let i = 0; i < data.length; i++) if (norm_(data[i][0]) === String(m.cat) && norm_(data[i][1]) === String(m.item)) { idx = i; break; }
        if (idx < 0) { const r = [m.cat, txt_(String(m.item)), txt_(String(m.value)), m.note || '']; sh.appendRow(r); data.push(r); }
        else { data[idx][2] = m.value; sh.getRange(idx + 2, 3).setValue(txt_(String(m.value))); }
      });
      dropPub_();
      log_('setMods', JSON.stringify(d.rows));
      return json_({ ok: true });
    }
    if (a === 'setPlayer') {
      const name = String(d.name || '').trim(), u = userRow_(name);
      if (!u || !u.save) return json_({ ok: false, fatal: true, error: '找不到這位小朋友：' + name });
      const s = u.save, rev = num_(s.rev) + 1;
      if (d.coins !== undefined && d.coins !== '' && d.coins !== null) s.coins = num_(d.coins);
      if (Array.isArray(d.levels)) { s.progress = s.progress || {}; d.levels.forEach(function (id) { if (!s.progress[id]) s.progress[id] = 1; }); }
      if (d.resetProgress) { s.progress = {}; s.resetRev = rev; }
      if (d.grade) { s.grade = Math.max(1, Math.min(6, num_(d.grade))); s.gradeRev = rev; }
      s.rev = rev; s.updated = Date.now();
      writeUser_(u.row, s, u.stats);
      dropPub_();
      log_('setPlayer', name + ' ' + JSON.stringify({ coins: d.coins, levels: d.levels, reset: !!d.resetProgress, grade: d.grade }));
      return json_({ ok: true, save: s });
    }
    if (a === 'broadcast') {
      const text = String(d.text || '').trim().slice(0, 80);
      if (!text) return json_({ ok: false, fatal: true, error: '內容空白' });
      const min = Number(d.minutes) || 30;
      sheet_('廣播').appendRow([new Date(), text, new Date(Date.now() + min * 60000)]);
      dropPub_();
      return json_({ ok: true });
    }
    if (a === 'rebuild') { maybeRebuild_(true); return json_({ ok: true }); }
    if (a === 'selfUpdate') {
      if (typeof LOADER === 'undefined') return json_({ ok: false, fatal: true, error: '沒有啟動程式（請確認 Apps Script 貼的是啟動程式）' });
      const app = LOADER.reload();
      return json_({ ok: true, updated: app.CODE_VERSION !== CODE_VERSION, version: app.CODE_VERSION,
        msg: app.CODE_VERSION !== CODE_VERSION ? '已更新到第 ' + app.CODE_VERSION + ' 版' : '已經是最新版（第 ' + app.CODE_VERSION + ' 版）' });
    }
    return json_({ ok: false, error: '不認得的動作：' + a });
  } catch (err) {
    return json_({ ok: false, retry: true, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}
