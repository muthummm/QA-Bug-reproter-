// SQLite database using Node's built-in driver (no native build needed).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, '..', 'data'));
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'bugs.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('Tester','Developer')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bugs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    module        TEXT NOT NULL,
    description   TEXT NOT NULL,
    steps         TEXT NOT NULL DEFAULT '',
    expected      TEXT NOT NULL DEFAULT '',
    actual        TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'Open',
    assignee_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    priority      TEXT NOT NULL DEFAULT 'Medium',
    date_reported TEXT NOT NULL,
    link          TEXT NOT NULL DEFAULT '',
    screenshot    TEXT NOT NULL DEFAULT '',
    notes         TEXT NOT NULL DEFAULT '',
    reporter_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    bug_id      INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    from_status TEXT,
    to_status   TEXT,
    comment     TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_history_bug ON history(bug_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migrations for databases created by earlier versions
const bugCols = db.prepare('PRAGMA table_info(bugs)').all().map(c => c.name);
if (!bugCols.includes('panel')) db.exec("ALTER TABLE bugs ADD COLUMN panel TEXT NOT NULL DEFAULT ''");
if (!bugCols.includes('project_id')) {
  db.exec('ALTER TABLE bugs ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE');
  // Older bugs without a project go into "General"
  if (db.prepare('SELECT COUNT(*) AS n FROM bugs').get().n > 0) {
    const pid = db.prepare("INSERT OR IGNORE INTO projects (name) VALUES ('General')").run().lastInsertRowid
      || db.prepare("SELECT id FROM projects WHERE name = 'General'").get().id;
    db.prepare('UPDATE bugs SET project_id = ? WHERE project_id IS NULL').run(pid);
  }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_bugs_project ON bugs(project_id)');

// Who can see each project. A project is hidden from everyone who is not a member.
const hadMembers = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_members'").get();
db.exec(`
  CREATE TABLE IF NOT EXISTS project_members (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    added_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_members_user ON project_members(user_id);
`);
if (!hadMembers) {
  // One-time setup for existing projects: testers, the creator and current assignees keep access.
  db.exec(`
    INSERT OR IGNORE INTO project_members (project_id, user_id)
      SELECT p.id, u.id FROM projects p, users u WHERE u.role = 'Tester';
    INSERT OR IGNORE INTO project_members (project_id, user_id)
      SELECT id, created_by FROM projects WHERE created_by IS NOT NULL;
    INSERT OR IGNORE INTO project_members (project_id, user_id)
      SELECT DISTINCT project_id, assignee_id FROM bugs WHERE assignee_id IS NOT NULL AND project_id IS NOT NULL;
  `);
}

export const isMember = (projectId, userId) =>
  !!db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId);
export const addMember = (projectId, userId, addedBy = null) =>
  db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, added_by) VALUES (?, ?, ?)').run(projectId, userId, addedBy);

/** Find a project by name, creating it if needed. */
export function projectByName(name, userId = null) {
  const p = db.prepare('SELECT id FROM projects WHERE name = ?').get(name);
  if (p) return p.id;
  const id = db.prepare('INSERT INTO projects (name, created_by) VALUES (?, ?)').run(name, userId).lastInsertRowid;
  // Created outside the app (command-line import): give every tester access
  db.prepare("INSERT OR IGNORE INTO project_members (project_id, user_id) SELECT ?, id FROM users WHERE role = 'Tester'").run(id);
  return id;
}
