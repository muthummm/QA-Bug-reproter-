// Imports a bug spreadsheet (CSV exported from Excel / Google Sheets) into the database.
import { db } from './db.js';

export const STATUSES = ['Open', 'In Progress', 'Fixed', 'Ready for Retest', 'Reopened', 'Closed', 'Not a Bug'];
export const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];
export const ROLES = ['Tester', 'Developer'];
// Statuses a developer may move a bug to. Closing and reopening is the tester's call (they verify the fix).
export const DEV_STATUSES = ['Open', 'In Progress', 'Fixed', 'Ready for Retest', 'Not a Bug'];

/** RFC 4180 CSV parser: handles quoted cells with commas, quotes and line breaks. */
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Sheet column name -> bug field
const HEADER_MAP = {
  'panel': 'panel', 'module': 'module', 'description': 'description', 'bug description': 'description', 'summary': 'description',
  'steps to reproduce': 'steps', 'steps': 'steps', 'expected result': 'expected', 'expected': 'expected',
  'actual result': 'actual', 'actual': 'actual', 'status': 'status', 'assignee': 'assignee', 'assigned to': 'assignee',
  'priority': 'priority', 'date reported': 'date', 'date': 'date', 'reported date': 'date',
  'screenshot/link': 'link', 'screenshot': 'link', 'link': 'link', 'notes': 'notes', 'remarks': 'notes', 'comments': 'notes',
};
const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
const clean = s => (s || '').replace(/\r\n?/g, '\n').split('\n').map(l => l.trimEnd()).join('\n').trim();

const STATUS_MAP = {
  'done': 'Fixed', 'fixed': 'Fixed', 'resolved': 'Fixed', 'completed': 'Fixed',
  'not done': 'Open', 'open': 'Open', 'new': 'Open', 'pending': 'Open', 'todo': 'Open', 'to do': 'Open',
  're-test': 'Ready for Retest', 'retest': 'Ready for Retest', 're test': 'Ready for Retest', 'ready for retest': 'Ready for Retest',
  'in progress': 'In Progress', 'inprogress': 'In Progress', 'wip': 'In Progress',
  'reopened': 'Reopened', 'reopen': 'Reopened', 're-open': 'Reopened', 're-opened': 'Reopened',
  'closed': 'Closed', 'verified': 'Closed',
  'not a bug': 'Not a Bug', 'invalid': 'Not a Bug', 'rejected': 'Not a Bug', 'duplicate': 'Not a Bug',
};
function mapStatus(raw) {
  const s = norm(raw);
  if (!s) return { status: 'Open' };
  return STATUS_MAP[s] ? { status: STATUS_MAP[s] } : { status: 'Open', unknown: raw.trim() };
}
function mapPriority(raw) {
  const s = norm(raw).replace(/\s/g, '');
  const p = { p0: 'Critical', p1: 'Critical', p2: 'High', p3: 'Medium', p4: 'Low', p5: 'Low',
    critical: 'Critical', blocker: 'Critical', high: 'High', major: 'High', medium: 'Medium', normal: 'Medium', low: 'Low', minor: 'Low', trivial: 'Low' }[s];
  return p || '';
}
/** Dates like 17/11/2026 (day first, as in Indian/UK sheets), 2026-11-17, or 17-11-2026. */
function mapDate(raw) {
  const s = (raw || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    let [, a, b, y] = m;
    if (y.length === 2) y = '20' + y;
    let day = +a, month = +b;
    if (month > 12 && day <= 12) [day, month] = [month, day]; // clearly month-first
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

function findOrCreateUser(name, created) {
  const n = name.trim();
  let u = db.prepare('SELECT id FROM users WHERE lower(name) = lower(?) OR lower(username) = lower(?)').get(n, n);
  if (u) return u.id;
  let base = n.toLowerCase().replace(/[^a-z0-9._-]+/g, '') || 'user';
  if (base.length < 3) base = (base + 'user').slice(0, 6);
  let username = base, k = 2;
  while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) username = base + k++;
  // Empty password: the real person sets one by registering with this username.
  const id = db.prepare("INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, '', 'Developer')").run(n, username).lastInsertRowid;
  created.push({ name: n, username });
  return id;
}

export function importCsv(text, projectId, reporterId = null) {
  if (!projectId) throw new Error('Pick a project to import into.');
  const rows = parseCsv(text);
  const headerIdx = rows.findIndex(r => {
    const h = r.map(norm);
    return h.includes('module') && (h.includes('description') || h.includes('bug description'));
  });
  if (headerIdx < 0) throw new Error('Could not find a header row with "Module" and "Description" columns.');
  const cols = rows[headerIdx].map(h => HEADER_MAP[norm(h)] || null);
  const idx = f => cols.indexOf(f);

  // A lone label above the header (e.g. "Agent panel") is the panel for the rows below.
  let panel = '';
  for (let i = headerIdx - 1; i >= 0; i--) {
    const filled = rows[i].map(c => c.trim()).filter(Boolean);
    if (filled.length === 1) { panel = filled[0]; break; }
  }

  const result = { imported: 0, skipped: 0, duplicates: 0, createdUsers: [], notes: [] };
  const today = new Date().toISOString().slice(0, 10);
  const latestToday = new Date(Date.now() + 14 * 3600 * 1000).toISOString().slice(0, 10);
  let module = '', lastDate = null;
  const exists = db.prepare('SELECT 1 FROM bugs WHERE project_id = ? AND lower(module) = lower(?) AND description = ?');
  const insert = db.prepare(`
    INSERT INTO bugs (project_id, panel, module, description, steps, expected, actual, status, assignee_id, priority,
                      date_reported, link, notes, reporter_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const hist = db.prepare('INSERT INTO history (bug_id, user_id, to_status, comment, created_at) VALUES (?, ?, ?, ?, ?)');

  db.exec('BEGIN');
  try {
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      const get = f => (idx(f) >= 0 ? row[idx(f)] || '' : '');
      const filled = row.map(c => c.trim()).filter(Boolean);
      if (!filled.length) continue;

      const description = clean(get('description'));
      // A row with only a label in the first column starts a new panel/section
      if (!description && filled.length === 1 && row[0].trim()) { panel = row[0].trim(); module = ''; continue; }
      if (get('module').trim()) module = clean(get('module'));
      if (!description) { result.skipped++; continue; }
      const mod = module || 'General';
      if (exists.get(projectId, mod, description)) { result.duplicates++; continue; }

      const { status, unknown } = mapStatus(get('status'));
      const notesParts = [clean(get('notes'))];
      if (unknown) notesParts.push(`Status in sheet: ${unknown}`);
      const rawPri = get('priority').trim();
      const priority = mapPriority(rawPri);
      if (rawPri && !priority) notesParts.push(`Priority in sheet: ${rawPri}`);
      let link = clean(get('link'));
      if (link && !/^https?:\/\//i.test(link)) { notesParts.push(`Screenshot/Link: ${link}`); link = ''; }
      let date = mapDate(get('date'));
      if (date && date > latestToday) date = null; // future dates aren't allowed
      if (get('date').trim() && !date) notesParts.push(`Date in sheet: ${get('date').trim()}`);
      if (!date) date = lastDate || today;
      lastDate = date;

      const assignee = get('assignee').trim();
      const assigneeId = assignee ? findOrCreateUser(assignee, result.createdUsers) : null;
      const t = new Date().toISOString();
      const id = insert.run(projectId, panel, mod, description, clean(get('steps')), clean(get('expected')), clean(get('actual')),
        status, assigneeId, priority, date, link, notesParts.filter(Boolean).join('\n'), reporterId, t, t).lastInsertRowid;
      const sheetStatus = get('status').trim();
      hist.run(id, reporterId, status, `Imported from spreadsheet${sheetStatus ? ` (status was "${sheetStatus}")` : ''}`, t);
      result.imported++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return result;
}
