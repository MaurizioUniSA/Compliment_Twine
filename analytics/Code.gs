/**
 * Complement System activity: analytics endpoint (Google Apps Script Web App)
 * ---------------------------------------------------------------------------
 * Receives batched events from the activity and writes them to these tabs:
 *   Sessions | MCQ Results | Answers | Time on Page | Page Views | Health | Errors
 *
 * SETUP (once):
 *   1. Create a Google Sheet. Extensions > Apps Script. Paste this file as Code.gs.
 *   2. Run setup() once from the editor and accept the authorisation prompts.
 *      (This is the step that prevents silent authorisation blocks later.)
 *   3. Deploy > New deployment > type "Web app"
 *        Execute as: Me        Who has access: Anyone
 *      Copy the /exec URL into SCRIPT_URL in the activity's HTML.
 *
 * WHEN YOU CHANGE THIS CODE LATER:
 *   Deploy > Manage deployments > (pencil) > Version: "New version" > Deploy.
 *   Do NOT use "New deployment": that creates a different URL and the old one
 *   keeps serving the old code (or stops working), which silently breaks logging.
 *
 * BEFORE EVERY SESSION DAY: open the activity's code screen. It pings this
 * endpoint and must show "Analytics connected". You can also open the /exec URL
 * with ?action=ping in a browser tab and look for {"ok":true,...}.
 */

var CONFIG = {
  SPREADSHEET_ID: '',                       // leave blank when the script is bound to the Sheet (Extensions > Apps Script)
  VERSION: 'complement-analytics-v6',
  DEDUPE_SECONDS: 21600                     // event_id de-duplication window (max for CacheService)
};

var SCHEMA = {
  'Sessions': ['session_id', 'student_code', 'session_type', 'is_test', 'started_at', 'last_seen_at', 'last_event_ts',
    'end_reason', 'active_seconds', 'wall_seconds', 'passages_viewed', 'unique_passages', 'pathways_visited',
    'questions_answered', 'first_attempt_correct', 'wrong_answers', 'mcq_answered', 'mcq_score', 'mcq_completed',
    'reached_summary', 'prev_session_id', 'last_passage', 'app_version', 'user_agent', 'screen', 'timezone'],
  'MCQ Results': ['event_id', 'ts', 'session_id', 'student_code', 'session_type', 'is_test', 'q_number', 'question_id',
    'question_text', 'option_position', 'option_text', 'destination_passage', 'correct', 'dest_name_says_correct',
    'signals_agree', 'score_so_far', 'seconds_on_question'],
  'Answers': ['event_id', 'ts', 'session_id', 'student_code', 'session_type', 'is_test', 'pathway', 'question_id',
    'question_text', 'option_position', 'option_text', 'destination_passage', 'correct', 'dest_name_says_correct',
    'signals_agree', 'attempt_number', 'first_attempt_correct', 'seconds_on_question'],
  'Time on Page': ['event_id', 'ts', 'session_id', 'student_code', 'session_type', 'is_test', 'passage', 'pathway',
    'active_seconds', 'wall_seconds', 'segment_reason'],
  'Page Views': ['event_id', 'ts', 'session_id', 'student_code', 'session_type', 'is_test', 'passage', 'pathway',
    'prev_passage', 'nav_type', 'view_number'],
  'Health': ['received_at', 'client_ts', 'source', 'ok', 'user_agent', 'note'],
  'Errors': ['received_at', 'where', 'message', 'payload_excerpt']
};

// Columns that must NEVER be turned into numbers/dates by Sheets (keeps leading zeros, e.g. 02210).
var TEXT_COLUMNS = ['session_id', 'student_code', 'event_id', 'prev_session_id', 'question_id', 'passage',
  'prev_passage', 'destination_passage', 'last_passage'];

// Session fields that only ever grow (a late/replayed older update must not lower them).
var MAX_FIELDS = ['active_seconds', 'wall_seconds', 'passages_viewed', 'unique_passages', 'questions_answered',
  'first_attempt_correct', 'wrong_answers', 'mcq_answered', 'mcq_score'];
var OR_FIELDS = ['mcq_completed', 'reached_summary'];

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function doGet(e) {
  try {
    var action = e && e.parameter && e.parameter.action;
    if (action === 'ping') return json_(ping_('get', e.parameter.client_ts || '', ''));
    return json_({ ok: true, message: 'Complement analytics endpoint', version: CONFIG.VERSION });
  } catch (err) {
    logError_('doGet', err, '');
    return json_({ ok: false, error: String(err && err.message || err), version: CONFIG.VERSION });
  }
}

function doPost(e) {
  var raw = '';
  try {
    raw = (e && e.postData && e.postData.contents) || '';
    var body = JSON.parse(raw);
    if (body.action === 'ping') return json_(ping_('post', body.client_ts || '', (body.client && body.client.user_agent) || ''));
    if (body.action === 'log') return json_(handleLog_(body));
    return json_({ ok: false, error: 'unknown action', version: CONFIG.VERSION });
  } catch (err) {
    logError_('doPost', err, raw);
    return json_({ ok: false, error: String(err && err.message || err), version: CONFIG.VERSION });
  }
}

/** Run once from the editor: creates the tabs, formats the text columns and triggers the authorisation prompt. */
function setup() {
  ensureSheets_();
  // Touch every service the web app uses so Google asks for all permissions now, not silently later.
  CacheService.getScriptCache().put('setup', '1', 60);
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  lock.releaseLock();
  Logger.log('Setup complete. Tabs: ' + Object.keys(SCHEMA).join(', '));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function ping_(source, clientTs, ua) {
  ensureSheets_();
  var sh = getSheet_('Health');
  sh.appendRow([new Date().toISOString(), String(clientTs), source, true, String(ua || ''), '']);
  return { ok: true, sheet_ok: true, version: CONFIG.VERSION, server_time: new Date().toISOString() };
}

function handleLog_(body) {
  var events = body.events || [];
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, error: 'busy', version: CONFIG.VERSION };   // client retries with backoff
  try {
    ensureSheets_();
    var cache = CacheService.getScriptCache();
    var keys = events.map(function (ev) { return 'e_' + ev.event_id; });
    var seen = keys.length ? cache.getAll(keys) : {};
    var fresh = [];
    var duplicates = 0;
    events.forEach(function (ev) {
      if (!ev || !ev.event_id) return;
      if (seen['e_' + ev.event_id]) { duplicates++; return; }
      fresh.push(ev);
    });

    var pending = { 'MCQ Results': [], 'Answers': [], 'Time on Page': [], 'Page Views': [] };
    var sessions = new SessionTable_();
    var failed = 0;

    fresh.forEach(function (ev) {
      try {
        switch (ev.type) {
          case 'session_start':
          case 'session_update':
            sessions.apply(ev);
            break;
          case 'answer':      pending['Answers'].push(rowFor_('Answers', ev)); break;
          case 'mcq_result':  pending['MCQ Results'].push(rowFor_('MCQ Results', ev)); break;
          case 'time_on_page': pending['Time on Page'].push(rowFor_('Time on Page', ev)); break;
          case 'page_view':   pending['Page Views'].push(rowFor_('Page Views', ev)); break;
          default: throw new Error('unknown event type ' + ev.type);
        }
      } catch (err) {
        failed++;
        logError_('event ' + ev.type, err, JSON.stringify(ev).slice(0, 500));
      }
    });

    sessions.commit();
    Object.keys(pending).forEach(function (tab) {
      var rows = pending[tab];
      if (!rows.length) return;
      var sh = getSheet_(tab);
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, SCHEMA[tab].length).setValues(rows);
    });

    var toCache = {};
    fresh.forEach(function (ev) { toCache['e_' + ev.event_id] = '1'; });
    if (Object.keys(toCache).length) cache.putAll(toCache, CONFIG.DEDUPE_SECONDS);

    return { ok: true, accepted: fresh.length - failed, duplicates: duplicates, failed: failed, version: CONFIG.VERSION };
  } catch (err) {
    logError_('handleLog', err, JSON.stringify(body).slice(0, 500));
    return { ok: false, error: String(err && err.message || err), version: CONFIG.VERSION };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Sessions upsert
// ---------------------------------------------------------------------------

function SessionTable_() {
  this.sheet = getSheet_('Sessions');
  this.header = SCHEMA['Sessions'];
  this.index = {};          // session_id -> sheet row number
  this.rows = {};           // session_id -> row array (only those touched in this request)
  this.isNew = {};
  var last = this.sheet.getLastRow();
  if (last > 1) {
    var ids = this.sheet.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) this.index[String(ids[i][0])] = i + 2;
  }
  this.nextRow = last + 1;
}

SessionTable_.prototype.load_ = function (id) {
  if (this.rows[id]) return this.rows[id];
  if (this.index[id]) {
    this.rows[id] = this.sheet.getRange(this.index[id], 1, 1, this.header.length).getValues()[0];
  } else {
    this.rows[id] = this.header.map(function () { return ''; });
    this.index[id] = this.nextRow++;
    this.isNew[id] = true;
  }
  return this.rows[id];
};

SessionTable_.prototype.apply = function (ev) {
  var id = String(ev.session_id || '');
  if (!id) throw new Error('missing session_id');
  var row = this.load_(id);
  var h = this.header;
  var col = function (name) { return h.indexOf(name); };
  var existingTs = String(row[col('last_event_ts')] || '');
  var stale = existingTs && ev.ts && String(ev.ts) < existingTs;      // replayed older update: only monotonic fields may change

  // Fields set once
  ['student_code', 'session_type', 'is_test', 'started_at', 'prev_session_id', 'app_version', 'user_agent', 'screen', 'timezone']
    .forEach(function (f) {
      if (ev[f] !== undefined && ev[f] !== null && (row[col(f)] === '' || f === 'is_test')) row[col(f)] = (f === 'student_code') ? String(ev[f]) : ev[f];
    });

  MAX_FIELDS.forEach(function (f) {
    if (ev[f] === undefined) return;
    var cur = Number(row[col(f)]) || 0;
    row[col(f)] = Math.max(cur, Number(ev[f]) || 0);
  });
  OR_FIELDS.forEach(function (f) {
    if (ev[f] === undefined) return;
    row[col(f)] = (row[col(f)] === true || ev[f] === true);
  });

  if (!stale) {
    ['last_seen_at', 'end_reason', 'pathways_visited', 'last_passage'].forEach(function (f) {
      if (ev[f] !== undefined) row[col(f)] = (f === 'last_passage') ? String(ev[f]) : ev[f];
    });
    if (ev.ts) row[col('last_event_ts')] = String(ev.ts);
  }
  row[col('session_id')] = id;
};

SessionTable_.prototype.commit = function () {
  var self = this;
  Object.keys(this.rows).forEach(function (id) {
    self.sheet.getRange(self.index[id], 1, 1, self.header.length).setValues([self.rows[id]]);
  });
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowFor_(tab, ev) {
  return SCHEMA[tab].map(function (name) {
    var v = ev[name];
    if (v === undefined || v === null) return '';
    if (TEXT_COLUMNS.indexOf(name) !== -1) return String(v);        // never numeric
    return v;
  });
}

function getSS_() {
  return CONFIG.SPREADSHEET_ID ? SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet_(name) {
  var sh = getSS_().getSheetByName(name);
  if (!sh) { ensureSheets_(); sh = getSS_().getSheetByName(name); }
  return sh;
}

function ensureSheets_() {
  var ss = getSS_();
  Object.keys(SCHEMA).forEach(function (name) {
    var header = SCHEMA[name];
    var sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      // Plain Text is applied to the whole column BEFORE any data lands in it.
      header.forEach(function (colName, i) {
        if (TEXT_COLUMNS.indexOf(colName) !== -1) sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
      });
      sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });
}

function logError_(where, err, payload) {
  try {
    var sh = getSS_().getSheetByName('Errors');
    if (!sh) { ensureSheets_(); sh = getSS_().getSheetByName('Errors'); }
    sh.appendRow([new Date().toISOString(), where, String(err && err.message || err), String(payload || '').slice(0, 500)]);
  } catch (e2) { /* nothing more we can do */ }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
