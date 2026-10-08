const SETUP_SHEET_ID = '【試算表 ID】';
const SETUP_TEACHER_PIN = '1234';   // 老師密碼（之後可在遊戲老師面板修改）
const CODE_URL = 'https://raw.githubusercontent.com/qwe0975169776-dotcom/echo-game/main/Code.gs';
const CACHE_MIN = 10;
function doGet(e)  { return app_().doGet(e); }
function doPost(e) { return app_().doPost(e); }
function 一次設定() {
  const p = PropertiesService.getScriptProperties();
  if (SETUP_SHEET_ID) p.setProperty('SHEET_ID', SETUP_SHEET_ID);
  if (SETUP_TEACHER_PIN && !p.getProperty('TEACHER_PIN')) p.setProperty('TEACHER_PIN', SETUP_TEACHER_PIN);
  const app = app_(true); app.setup();
  Logger.log('完成！伺服器程式第 ' + app.CODE_VERSION + ' 版，試算表：' + SpreadsheetApp.openById(SETUP_SHEET_ID).getName());
}
function app_(force) {
  const cache = CacheService.getScriptCache();
  let src = force ? null : cache.get('code');
  if (!src) {
    try {
      const r = UrlFetchApp.fetch(CODE_URL + '?t=' + Date.now(), { muteHttpExceptions: true });
      const t = r.getContentText();
      if (r.getResponseCode() === 200 && t.indexOf('function doPost') >= 0 && /const CODE_VERSION = \d+;/.test(t)) { src = t; backupSave_(t); }
    } catch (err) {}
    if (!src) src = backupLoad_();
    if (!src) throw new Error('抓不到伺服器程式');
    try { cache.put('code', src, CACHE_MIN * 60); } catch (err) {}
  }
  const LOADER = { reload: () => app_(true) };
  return new Function('LOADER', src + '\n;return { doGet: doGet, doPost: doPost, setup: setup, CODE_VERSION: CODE_VERSION };')(LOADER);
}
function backupSave_(src) {   // 指令碼屬性每個值上限約 9KB，中文一字 3 bytes，所以每段 2500 字
  const p = PropertiesService.getScriptProperties(), size = 2500, n = Math.ceil(src.length / size), o = {};
  for (let i = 0; i < n; i++) o['CODE_' + i] = src.slice(i * size, (i + 1) * size);
  o.CODE_N = String(n); p.setProperties(o);
}
function backupLoad_() {
  const p = PropertiesService.getScriptProperties(), n = Number(p.getProperty('CODE_N') || 0);
  let s = ''; for (let i = 0; i < n; i++) s += p.getProperty('CODE_' + i) || '';
  return s || null;
}
