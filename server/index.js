import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { db, UPLOAD_DIR } from './db.js';
import { STATUSES, PRIORITIES, ROLES, DEV_STATUSES, importCsv } from './importer.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------- helpers ----------
const now = () => new Date().toISOString();
const str = (v, max = 5000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bugKey = id => 'BUG-' + String(id).padStart(3, '0');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(password, salt, 64).toString('hex');
}
function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}
function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  return token;
}
const publicUser = u => u && { id: u.id, name: u.name, username: u.username, role: u.role };

function auth(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const user = token && db.prepare(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'
  ).get(token);
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  req.user = user;
  req.token = token;
  next();
}

// Only testers report bugs, import sheets and edit every field.
function testerOnly(req, res, next) {
  if (req.user.role !== 'Tester') return res.status(403).json({ error: 'Only testers can do this. Developers can change the status and add notes.' });
  next();
}

const BUG_SELECT = `
  SELECT b.*, a.name AS assignee_name, r.name AS reporter_name
  FROM bugs b
  LEFT JOIN users a ON a.id = b.assignee_id
  LEFT JOIN users r ON r.id = b.reporter_id`;
const shapeBug = b => b && { ...b, key: bugKey(b.id) };

function readBugBody(body) {
  const bug = {
    panel: str(body.panel, 100),
    module: str(body.module, 200),
    description: str(body.description, 2000),
    steps: str(body.steps),
    expected: str(body.expected),
    actual: str(body.actual),
    status: STATUSES.includes(body.status) ? body.status : 'Open',
    priority: PRIORITIES.includes(body.priority) || body.priority === '' ? body.priority : 'Medium',
    assignee_id: Number.isInteger(Number(body.assignee_id)) && Number(body.assignee_id) > 0 ? Number(body.assignee_id) : null,
    date_reported: /^\d{4}-\d{2}-\d{2}$/.test(body.date_reported || '') ? body.date_reported : now().slice(0, 10),
    link: str(body.link, 1000),
    screenshot: /^\/uploads\/[\w.-]+$/.test(body.screenshot || '') ? body.screenshot : '',
    notes: str(body.notes),
  };
  if (!bug.module || !bug.description) return { error: 'Module and Description are required.' };
  // Latest "today" anywhere on Earth (UTC+14), so users ahead of the server's timezone aren't blocked
  const latestToday = new Date(Date.now() + 14 * 3600 * 1000).toISOString().slice(0, 10);
  if (bug.date_reported > latestToday) return { error: 'Date reported cannot be in the future.' };
  if (bug.link && !/^https?:\/\//i.test(bug.link)) return { error: 'Screenshot/Link must start with http:// or https://' };
  if (bug.assignee_id && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(bug.assignee_id))
    return { error: 'That assignee does not exist.' };
  return { bug };
}

// ---------- auth routes ----------
app.post('/api/auth/register', (req, res) => {
  const name = str(req.body.name, 80), username = str(req.body.username, 40), password = req.body.password || '';
  const role = ROLES.includes(req.body.role) ? req.body.role : null;
  if (!name || !username || !role) return res.status(400).json({ error: 'Name, username and role are required.' });
  if (!/^[\w.-]{3,40}$/.test(username)) return res.status(400).json({ error: 'Username: 3+ letters, numbers, dots, dashes or underscores.' });
  if (typeof password !== 'string' || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  let userId;
  if (existing && existing.password_hash === '') {
    // A placeholder made by the spreadsheet import (e.g. an assignee): the real person claims it
    db.prepare('UPDATE users SET name = ?, password_hash = ?, role = ? WHERE id = ?').run(name, hashPassword(password), role, existing.id);
    userId = existing.id;
  } else if (existing) {
    return res.status(409).json({ error: 'That username is taken.' });
  } else {
    userId = db.prepare('INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(name, username, hashPassword(password), role).lastInsertRowid;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  res.status(201).json({ token: newSession(user.id), user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(str(req.body.username, 40));
  if (user && user.password_hash === '')
    return res.status(401).json({ error: 'This account has no password yet. Use "Create an account" with this username to set one.' });
  if (!user || !checkPassword(String(req.body.password || ''), user.password_hash))
    return res.status(401).json({ error: 'Wrong username or password.' });
  res.json({ token: newSession(user.id), user: publicUser(user) });
});

app.post('/api/auth/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.get('/api/users', auth, (_req, res) => {
  res.json(db.prepare('SELECT id, name, username, role FROM users ORDER BY role DESC, name').all());
});

app.get('/api/meta', (_req, res) => res.json({ statuses: STATUSES, priorities: PRIORITIES, devStatuses: DEV_STATUSES }));

// ---------- project routes ----------
app.get('/api/projects', auth, (_req, res) => {
  res.json(db.prepare(`
    SELECT p.id, p.name, p.description, p.created_at,
      COUNT(b.id) AS total,
      SUM(CASE WHEN b.status IN ('Open','Reopened','In Progress') THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN b.status = 'Ready for Retest' OR b.status = 'Fixed' THEN 1 ELSE 0 END) AS to_verify,
      MAX(b.updated_at) AS last_activity
    FROM projects p LEFT JOIN bugs b ON b.project_id = p.id
    GROUP BY p.id ORDER BY COALESCE(MAX(b.updated_at), p.created_at) DESC`).all());
});

app.post('/api/projects', auth, (req, res) => {
  const name = str(req.body.name, 120), description = str(req.body.description, 500);
  if (!name) return res.status(400).json({ error: 'Give the project a name.' });
  if (db.prepare('SELECT 1 FROM projects WHERE name = ?').get(name)) return res.status(409).json({ error: 'A project with that name already exists.' });
  const id = db.prepare('INSERT INTO projects (name, description, created_by) VALUES (?, ?, ?)').run(name, description, req.user.id).lastInsertRowid;
  res.status(201).json({ project: db.prepare('SELECT * FROM projects WHERE id = ?').get(id) });
});

app.put('/api/projects/:id', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const name = str(req.body.name, 120) || p.name;
  if (name.toLowerCase() !== p.name.toLowerCase() && db.prepare('SELECT 1 FROM projects WHERE name = ?').get(name))
    return res.status(409).json({ error: 'A project with that name already exists.' });
  db.prepare('UPDATE projects SET name = ?, description = ? WHERE id = ?').run(name, str(req.body.description ?? p.description, 500), p.id);
  res.json({ project: db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id) });
});

app.delete('/api/projects/:id', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  if (db.prepare('SELECT COUNT(*) AS n FROM bugs WHERE project_id = ?').get(p.id).n > 0)
    return res.status(400).json({ error: 'Only empty projects can be deleted.' });
  db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

const projectFrom = v => db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(v));

// ---------- bug routes ----------
app.get('/api/bugs', auth, (req, res) => {
  const project = projectFrom(req.query.project);
  if (!project) return res.status(400).json({ error: 'Pick a project first.' });
  const where = ['b.project_id = ?'], args = [project.id];
  if (STATUSES.includes(req.query.status)) { where.push('b.status = ?'); args.push(req.query.status); }
  if (req.query.panel) { where.push('b.panel = ?'); args.push(str(req.query.panel, 100)); }
  if (PRIORITIES.includes(req.query.priority)) { where.push('b.priority = ?'); args.push(req.query.priority); }
  if (req.query.assignee === 'none') where.push('b.assignee_id IS NULL');
  else if (Number(req.query.assignee) > 0) { where.push('b.assignee_id = ?'); args.push(Number(req.query.assignee)); }
  const q = str(req.query.q, 200);
  if (q) {
    const idMatch = q.match(/^bug-?0*(\d+)$/i);
    where.push(`(b.panel LIKE ? OR b.module LIKE ? OR b.description LIKE ? OR b.steps LIKE ? OR b.actual LIKE ? OR b.notes LIKE ?${idMatch ? ' OR b.id = ?' : ''})`);
    const like = `%${q}%`;
    args.push(like, like, like, like, like, like);
    if (idMatch) args.push(Number(idMatch[1]));
  }
  const order = {
    old: 'b.id ASC',
    priority: "CASE b.priority WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END, b.id DESC",
    updated: 'b.updated_at DESC',
  }[req.query.sort] || 'b.id DESC';
  const rows = db.prepare(`${BUG_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order}`).all(...args);
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM bugs WHERE project_id = ? GROUP BY status')
    .all(project.id).map(r => [r.status, r.n]));
  const panels = db.prepare("SELECT DISTINCT panel FROM bugs WHERE project_id = ? AND panel != '' ORDER BY panel").all(project.id).map(r => r.panel);
  res.json({ project, bugs: rows.map(shapeBug), counts, panels });
});

app.get('/api/bugs/:id', auth, (req, res) => {
  const bug = db.prepare(`${BUG_SELECT} WHERE b.id = ?`).get(Number(req.params.id));
  if (!bug) return res.status(404).json({ error: 'Bug not found.' });
  const history = db.prepare(`
    SELECT h.*, u.name AS user_name, u.role AS user_role FROM history h
    LEFT JOIN users u ON u.id = h.user_id WHERE h.bug_id = ? ORDER BY h.id DESC`).all(bug.id);
  res.json({ bug: shapeBug(bug), history });
});

app.post('/api/bugs', auth, testerOnly, (req, res) => {
  const project = projectFrom(req.body.project_id);
  if (!project) return res.status(400).json({ error: 'Pick a project first.' });
  const { bug, error } = readBugBody(req.body);
  if (error) return res.status(400).json({ error });
  const t = now();
  const { lastInsertRowid: id } = db.prepare(`
    INSERT INTO bugs (project_id, panel, module, description, steps, expected, actual, status, assignee_id, priority,
                      date_reported, link, screenshot, notes, reporter_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    project.id, bug.panel, bug.module, bug.description, bug.steps, bug.expected, bug.actual, bug.status, bug.assignee_id, bug.priority,
    bug.date_reported, bug.link, bug.screenshot, bug.notes, req.user.id, t, t);
  db.prepare('INSERT INTO history (bug_id, user_id, to_status, comment, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.user.id, bug.status, 'Bug reported', t);
  res.status(201).json({ bug: shapeBug(db.prepare(`${BUG_SELECT} WHERE b.id = ?`).get(id)) });
});

app.put('/api/bugs/:id', auth, testerOnly, (req, res) => {
  const old = db.prepare('SELECT * FROM bugs WHERE id = ?').get(Number(req.params.id));
  if (!old) return res.status(404).json({ error: 'Bug not found.' });
  const { bug, error } = readBugBody(req.body);
  if (error) return res.status(400).json({ error });
  const t = now();
  db.prepare(`
    UPDATE bugs SET panel=?, module=?, description=?, steps=?, expected=?, actual=?, status=?, assignee_id=?, priority=?,
                    date_reported=?, link=?, screenshot=?, notes=?, updated_at=? WHERE id=?`).run(
    bug.panel, bug.module, bug.description, bug.steps, bug.expected, bug.actual, bug.status, bug.assignee_id, bug.priority,
    bug.date_reported, bug.link, bug.screenshot, bug.notes, t, old.id);
  const changed = bug.status !== old.status;
  db.prepare('INSERT INTO history (bug_id, user_id, from_status, to_status, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(old.id, req.user.id, changed ? old.status : null, changed ? bug.status : null, 'Edited bug details', t);
  if (old.screenshot && old.screenshot !== bug.screenshot) removeUpload(old.screenshot);
  res.json({ bug: shapeBug(db.prepare(`${BUG_SELECT} WHERE b.id = ?`).get(old.id)) });
});

// Quick status change (the main thing developers and testers do)
app.patch('/api/bugs/:id/status', auth, (req, res) => {
  const old = db.prepare('SELECT * FROM bugs WHERE id = ?').get(Number(req.params.id));
  if (!old) return res.status(404).json({ error: 'Bug not found.' });
  const status = req.body.status, comment = str(req.body.comment, 1000);
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status.' });
  if (status === old.status && !comment) return res.status(400).json({ error: 'Pick a new status or add a comment.' });
  if (status !== old.status && req.user.role === 'Developer' && !DEV_STATUSES.includes(status))
    return res.status(403).json({ error: `Only a tester can set a bug to ${status}. Mark it Fixed or Ready for Retest and the tester will verify it.` });
  const t = now();
  db.prepare('UPDATE bugs SET status = ?, updated_at = ? WHERE id = ?').run(status, t, old.id);
  db.prepare('INSERT INTO history (bug_id, user_id, from_status, to_status, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(old.id, req.user.id, status !== old.status ? old.status : null, status !== old.status ? status : null, comment, t);
  res.json({ bug: shapeBug(db.prepare(`${BUG_SELECT} WHERE b.id = ?`).get(old.id)) });
});

// Notes can be edited by anyone (developers add root cause, build numbers, etc.)
app.patch('/api/bugs/:id/notes', auth, (req, res) => {
  const old = db.prepare('SELECT * FROM bugs WHERE id = ?').get(Number(req.params.id));
  if (!old) return res.status(404).json({ error: 'Bug not found.' });
  const notes = str(req.body.notes);
  if (notes === old.notes) return res.status(400).json({ error: 'Notes are unchanged.' });
  const t = now();
  db.prepare('UPDATE bugs SET notes = ?, updated_at = ? WHERE id = ?').run(notes, t, old.id);
  db.prepare('INSERT INTO history (bug_id, user_id, comment, created_at) VALUES (?, ?, ?, ?)')
    .run(old.id, req.user.id, 'Updated notes', t);
  res.json({ bug: shapeBug(db.prepare(`${BUG_SELECT} WHERE b.id = ?`).get(old.id)) });
});

app.delete('/api/bugs/:id', auth, (req, res) => {
  const old = db.prepare('SELECT * FROM bugs WHERE id = ?').get(Number(req.params.id));
  if (!old) return res.status(404).json({ error: 'Bug not found.' });
  if (old.reporter_id !== req.user.id) return res.status(403).json({ error: 'Only the person who reported this bug can delete it.' });
  db.prepare('DELETE FROM bugs WHERE id = ?').run(old.id);
  if (old.screenshot) removeUpload(old.screenshot);
  res.json({ ok: true });
});

// CSV export (opens in Excel)
app.get('/api/export.csv', auth, (req, res) => {
  const project = projectFrom(req.query.project);
  if (!project) return res.status(400).json({ error: 'Pick a project first.' });
  const cols = [['ID', b => bugKey(b.id)], ['Panel', 'panel'], ['Module', 'module'], ['Description', 'description'], ['Steps to Reproduce', 'steps'],
    ['Expected Result', 'expected'], ['Actual Result', 'actual'], ['Status', 'status'], ['Assignee', 'assignee_name'],
    ['Priority', 'priority'], ['Date Reported', 'date_reported'], ['Screenshot/Link', 'link'], ['Notes', 'notes'],
    ['Reported By', 'reporter_name']];
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = db.prepare(`${BUG_SELECT} WHERE b.project_id = ? ORDER BY b.id`).all(project.id);
  const csv = '﻿' + [cols.map(c => q(c[0])).join(','),
    ...rows.map(b => cols.map(([, f]) => q(typeof f === 'function' ? f(b) : b[f])).join(','))].join('\r\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  const safeName = project.name.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '') || 'bugs';
  res.set('Content-Disposition', `attachment; filename="${safeName}-${now().slice(0, 10)}.csv"`);
  res.send(csv);
});

// Import a spreadsheet (CSV text in the body)
app.post('/api/import', auth, testerOnly, express.text({ type: '*/*', limit: '5mb' }), (req, res) => {
  try {
    const project = projectFrom(req.query.project);
    if (!project) return res.status(400).json({ error: 'Pick a project first.' });
    const result = importCsv(String(req.body || ''), project.id, req.user.id);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- screenshot uploads ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[file.mimetype];
      cb(null, crypto.randomBytes(12).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mimetype)),
});
app.post('/api/upload', auth, (req, res) => {
  upload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 5 MB.' : 'Upload failed.' });
    if (!req.file) return res.status(400).json({ error: 'Only PNG, JPG, GIF or WebP images are allowed.' });
    res.json({ url: '/uploads/' + req.file.filename });
  });
});
function removeUpload(url) {
  const file = path.join(UPLOAD_DIR, path.basename(url));
  fs.rm(file, { force: true }, () => {});
}
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

// ---------- serve the built React app ----------
const DIST = path.join(import.meta.dirname, '..', 'client', 'dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/^(?!\/api\/|\/uploads\/).*/, (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
}
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Something went wrong on the server.' }); });

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, () => console.log(`Bug tracker API running on http://localhost:${PORT}`));
