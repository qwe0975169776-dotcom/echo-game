// 模擬 Google Apps Script 服務，讓 Node 可以跑啟動程式和 Code.gs
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// 模擬試算表自動轉換：'開頭保持文字；「1-3」會變成日期
function conv(v) {
  if (typeof v !== 'string') return v;
  if (v[0] === "'") return v.slice(1);
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(v);
  if (m && +m[1] <= 12 && +m[2] <= 31) return new Date(2026, +m[1] - 1, +m[2]);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === 'true' || v === 'false') return v === 'true';
  return v;
}
function makeSheet(name) {
  const data = []; // 2D array
  const sh = {
    _data: data, frozen: 0,
    getName: () => name,
    getLastRow: () => { for (let i = data.length - 1; i >= 0; i--) if (data[i].some(v => v !== '' && v !== null && v !== undefined)) return i + 1; return 0; },
    getLastColumn: () => { let m = 0; data.forEach(r => { for (let j = r.length - 1; j >= 0; j--) if (r[j] !== '' && r[j] !== undefined) { m = Math.max(m, j + 1); break; } }); return m; },
    setFrozenRows: n => { sh.frozen = n; },
    appendRow: row => { data[sh.getLastRow()] = row.map(conv); return sh; },
    getRange: (r, c, nr, nc) => {
      if (r < 1 || c < 1) throw new Error('範圍錯誤 ' + r + ',' + c);
      nr = nr || 1; nc = nc || 1;
      if (nr < 1 || nc < 1) throw new Error('範圍列數必須至少 1');
      const rng = {
        getValues: () => { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (data[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined || v === null ? '' : v); } out.push(row); } return out; },
        setValues: vals => {
          if (vals.length !== nr || vals.some(v => v.length !== nc)) throw new Error('setValues 大小不符 ' + nr + 'x' + nc);
          for (let i = 0; i < nr; i++) { data[r - 1 + i] = data[r - 1 + i] || []; for (let j = 0; j < nc; j++) data[r - 1 + i][c - 1 + j] = conv(vals[i][j]); }
          return rng;
        },
        setValue: v => rng.setValues([[v]]),
        clearContent: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (data[r - 1 + i]) data[r - 1 + i][c - 1 + j] = ''; return rng; }
      };
      return rng;
    }
  };
  return sh;
}

function makeEnv(opts) {
  opts = opts || {};
  const sheets = {};
  const spreadsheet = {
    getName: () => opts.sheetName || '傳聲筒成績',
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet(n)),
    _sheets: sheets
  };
  const props = {};
  const cache = {};
  const logs = [];
  const env = {
    _sheets: sheets, _props: props, _cache: cache, _logs: logs,
    github: { up: true, code: null, fetchCount: 0 },
    SpreadsheetApp: { openById: id => { if (!id) throw new Error('沒有試算表 ID'); return spreadsheet; } },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in props ? props[k] : null),
        setProperty: (k, v) => { const s = String(v); if (Buffer.byteLength(s) > 9000) throw new Error('屬性值太大 ' + k + ' ' + Buffer.byteLength(s)); props[k] = s; },
        setProperties: o => { Object.keys(o).forEach(k => { const s = String(o[k]); if (Buffer.byteLength(s) > 9000) throw new Error('屬性值太大 ' + k + ' ' + Buffer.byteLength(s)); props[k] = s; }); }
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: k => { const c = cache[k]; return c && c.exp > Date.now() ? c.v : null; },
        put: (k, v, sec) => { if (Buffer.byteLength(v) > 100000) throw new Error('快取太大'); cache[k] = { v, exp: Date.now() + sec * 1000 }; }
      })
    },
    UrlFetchApp: {
      fetch: url => {
        env.github.fetchCount++;
        if (!env.github.up) throw new Error('DNS error: ' + url);
        return { getResponseCode: () => 200, getContentText: () => env.github.code };
      }
    },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: t => ({ _t: t, setMimeType: function () { return this; }, getContent: function () { return this._t; } })
    },
    Logger: { log: m => logs.push(String(m)) },
    console
  };
  return env;
}

// 載入啟動程式（填好試算表 ID），回傳可以呼叫的 context
function loadLoader(env, sheetId, pin) {
  let src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'loader.gs'), 'utf8');
  src = src.replace("'【試算表 ID】'", JSON.stringify(sheetId || 'TEST_SHEET_ID'));
  if (pin) src = src.replace("const SETUP_TEACHER_PIN = '1234';", 'const SETUP_TEACHER_PIN = ' + JSON.stringify(pin) + ';');
  const ctx = vm.createContext(env); // 不傳主環境的 Function
  vm.runInContext(src, ctx, { filename: 'loader.gs' });
  return ctx;
}

function codeSrc() { return fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'); }

function call(ctx, method, payload) {
  let res;
  if (method === 'GET') res = ctx.doGet({ parameter: payload || {} });
  else res = ctx.doPost({ postData: { contents: JSON.stringify(payload || {}) } });
  return JSON.parse(res.getContent());
}

module.exports = { makeEnv, loadLoader, codeSrc, call };
