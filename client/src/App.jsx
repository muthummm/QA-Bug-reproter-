import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api, getToken, setToken, downloadCsv, importCsv, STATUSES, DEV_STATUSES, PRIORITIES, STATUS_VAR, PRIORITY_VAR, fmtDate, fmtTime, today,
  isTester,
} from './api.js';

const ROLE_INFO = {
  Tester: 'Report bugs, import sheets, edit bug details, and verify fixes: close or reopen bugs.',
  Developer: 'Work on bugs: move them to In Progress, Fixed, Ready for Retest or Not a Bug, comment and add notes.',
};

// ---------- small pieces ----------
const StatusPill = ({ status }) => (
  <span className="status" style={{ '--c': `var(${STATUS_VAR[status] || '--muted'})` }}>
    <span className="dot" />{status}
  </span>
);
const Priority = ({ priority }) => (
  <span className={'pri' + (priority ? '' : ' unset')}><span className="bar" style={{ '--c': `var(${PRIORITY_VAR[priority] || '--line'})` }} />{priority || 'Not set'}</span>
);

// toast('Saved') shows a green success message; toast(msg, 'error') a red one.
function useToast() {
  const [t, setT] = useState(null);
  const timer = useRef();
  const show = useCallback((msg, kind = 'success') => {
    setT({ msg, kind, id: Date.now() });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setT(null), kind === 'error' ? 4500 : 3000);
  }, []);
  return [t, show];
}

// Shown as a popover so it sits above open dialogs (which live in the browser's top layer).
function Toast({ toast }) {
  const ref = useRef();
  useEffect(() => {
    const el = ref.current;
    if (!el?.showPopover) return;
    try { el.hidePopover(); } catch { /* not open */ }
    if (toast) el.showPopover();
  }, [toast]);
  return (
    <div ref={el => { ref.current = el; el?.setAttribute('popover', 'manual'); }}
      className={'toast ' + (toast?.kind || '')} role={toast?.kind === 'error' ? 'alert' : 'status'}>
      {toast && <><span className="t-icon" aria-hidden="true">{toast.kind === 'error' ? '!' : '✓'}</span>{toast.msg}</>}
    </div>
  );
}

function Modal({ open, onClose, className, children, labelledBy }) {
  const ref = useRef();
  useEffect(() => {
    const d = ref.current;
    if (open && !d.open) { d.showModal(); d.querySelector('[data-autofocus]')?.focus(); }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={className} aria-labelledby={labelledBy}
      onClose={onClose} onClick={e => { if (e.target === ref.current) onClose(); }}>
      {open && children}
    </dialog>
  );
}

// ---------- login / register ----------
function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ name: '', username: '', password: '', role: 'Tester' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = k => e => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const data = await api(`/auth/${mode}`, { method: 'POST', body: f });
      setToken(data.token);
      onAuthed(data.user, mode === 'register');
    } catch (e2) { setErr(e2.message); }
    setBusy(false);
  }

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1>Bug Log</h1>
        <p className="muted">{mode === 'login' ? 'Sign in to report and track bugs.' : 'Create an account for a tester or developer.'}</p>
        {mode === 'register' && (
          <>
            <fieldset className="roles">
              <legend>Are you a tester or a developer?</legend>
              {Object.entries(ROLE_INFO).map(([role, info]) => (
                <label key={role} className="role-card">
                  <input type="radio" name="role" value={role} checked={f.role === role} onChange={set('role')} />
                  <span><b>{role}</b><small>{info}</small></span>
                </label>
              ))}
            </fieldset>
            <label className="f">Full name<input id="r-name" value={f.name} onChange={set('name')} required /></label>
          </>
        )}
        <label className="f">Username<input id="a-user" value={f.username} onChange={set('username')} autoComplete="username" required /></label>
        <label className="f">Password<input id="a-pass" type="password" value={f.password} onChange={set('password')}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required /></label>
        {err && <p className="err">{err}</p>}
        <button className="btn primary" disabled={busy}>{mode === 'login' ? 'Sign in' : 'Create account'}</button>
        <button type="button" className="link-btn" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(''); }}>
          {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in'}
        </button>
      </form>
    </div>
  );
}

// ---------- bug form ----------
const EMPTY = {
  panel: '', module: '', description: '', steps: '', expected: '', actual: '', status: 'Open', priority: 'Medium',
  assignee_id: '', date_reported: '', link: '', screenshot: '', notes: '',
};

function BugForm({ bug, project, users, modules, panels, onSaved, onCancel }) {
  const [f, setF] = useState(() => bug ? { ...EMPTY, ...bug, assignee_id: bug.assignee_id ?? '' } : { ...EMPTY, date_reported: today() });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = k => e => setF(prev => ({ ...prev, [k]: e.target.value }));

  async function uploadFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    setBusy(true); setErr('Uploading screenshot…');
    try {
      const form = new FormData();
      form.append('file', file);
      const { url } = await api('/upload', { method: 'POST', form });
      setF(prev => ({ ...prev, screenshot: url }));
      setErr('');
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  async function submit(e) {
    e.preventDefault();
    if (!f.module.trim() || !f.description.trim()) { setErr('Module and Description are required.'); return; }
    if (f.date_reported && f.date_reported > today()) { setErr('Date reported cannot be in the future.'); return; }
    setBusy(true); setErr('');
    try {
      const body = { ...f, assignee_id: f.assignee_id || null, project_id: project.id };
      const { bug: saved } = bug
        ? await api(`/bugs/${bug.id}`, { method: 'PUT', body })
        : await api('/bugs', { method: 'POST', body });
      onSaved(saved, !bug);
    } catch (e2) { setErr(e2.message); setBusy(false); }
  }

  const developers = users.filter(u => u.role === 'Developer');
  const others = users.filter(u => u.role !== 'Developer');

  return (
    <form onSubmit={submit} noValidate onPaste={e => { const file = e.clipboardData?.files?.[0]; if (file) { e.preventDefault(); uploadFile(file); } }}>
      <div className="dlg-head"><h2 id="form-title">{bug ? `Edit ${bug.key}` : 'Report a bug'}</h2>
        <button type="button" className="x" onClick={onCancel} aria-label="Close">×</button></div>
      <div className="dlg-body">
        <div className="grid3">
          <label className="f">Panel
            <input id="i-panel" list="panels" value={f.panel} onChange={set('panel')} placeholder="e.g. Agent panel, Admin panel" />
            <datalist id="panels">{panels.map(p => <option key={p} value={p} />)}</datalist>
          </label>
          <label className="f"><span>Module <span className="req">*</span></span>
            <input id="i-module" list="modules" value={f.module} onChange={set('module')} placeholder="e.g. Login, Checkout" data-autofocus />
            <datalist id="modules">{modules.map(m => <option key={m} value={m} />)}</datalist>
          </label>
          <label className="f">Date reported<input id="i-date" type="date" value={f.date_reported} max={today()} onChange={set('date_reported')} /></label>
        </div>
        <label className="f"><span>Description <span className="req">*</span></span>
          <textarea id="i-desc" rows={2} value={f.description} onChange={set('description')} placeholder="Short summary of the problem" /></label>
        <label className="f">Steps to reproduce
          <textarea id="i-steps" rows={4} value={f.steps} onChange={set('steps')} placeholder={'1. Open the login page\n2. Enter a valid email\n3. Click Sign in'} /></label>
        <div className="grid2">
          <label className="f">Expected result<textarea id="i-exp" rows={3} value={f.expected} onChange={set('expected')} /></label>
          <label className="f">Actual result<textarea id="i-act" rows={3} value={f.actual} onChange={set('actual')} /></label>
        </div>
        <div className="grid3">
          <label className="f">Status<select id="i-status" value={f.status} onChange={set('status')}>{STATUSES.map(s => <option key={s}>{s}</option>)}</select></label>
          <label className="f">Priority<select id="i-pri" value={f.priority} onChange={set('priority')}><option value="">Not set</option>{PRIORITIES.map(p => <option key={p}>{p}</option>)}</select></label>
          <label className="f">Assignee
            <select id="i-asg" value={f.assignee_id} onChange={set('assignee_id')}>
              <option value="">Unassigned</option>
              {developers.length > 0 && <optgroup label="Developers">{developers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</optgroup>}
              {others.length > 0 && <optgroup label="Testers">{others.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</optgroup>}
            </select>
          </label>
        </div>
        <label className="f">Screenshot / link<input id="i-link" type="url" value={f.link} onChange={set('link')} placeholder="https://… (Drive, video, Jira, etc.)" /></label>
        <div className="f">
          <span>Screenshot image</span>
          {f.screenshot
            ? <div className="thumb"><img src={f.screenshot} alt="Screenshot" />
                <button type="button" onClick={() => setF(prev => ({ ...prev, screenshot: '' }))}>Remove</button></div>
            : <div className="hint-row"><input id="i-file" type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={e => uploadFile(e.target.files[0])} />
                <span className="hint">or paste an image with Ctrl+V. Max 5 MB.</span></div>}
        </div>
        <label className="f">Notes<textarea id="i-notes" rows={2} value={f.notes} onChange={set('notes')} /></label>
      </div>
      <div className="dlg-foot">
        <span className="err">{err}</span>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={busy}>{bug ? 'Save changes' : 'Save bug'}</button>
      </div>
    </form>
  );
}

// ---------- bug detail ----------
function BugDetail({ id, me, onClose, onEdit, onChanged, toast }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [status, setStatus] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [notes, setNotes] = useState(null); // null = not editing
  const tester = isTester(me);

  const load = useCallback(async () => {
    try {
      const d = await api(`/bugs/${id}`);
      setData(d); setStatus(d.bug.status);
    } catch (e) { setErr(e.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function updateStatus() {
    setBusy(true);
    try {
      const { bug } = await api(`/bugs/${id}/status`, { method: 'PATCH', body: { status, comment } });
      setComment('');
      toast(bug.status !== data.bug.status
        ? `Status updated: ${bug.key} is now ${bug.status}${comment.trim() ? ' (comment added)' : ''}`
        : `Comment added to ${bug.key}`);
      await load(); onChanged();
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  }
  async function saveNotes() {
    setBusy(true);
    try {
      await api(`/bugs/${id}/notes`, { method: 'PATCH', body: { notes } });
      setNotes(null); toast(`Notes saved on ${data.bug.key}`);
      await load(); onChanged();
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  }
  async function del() {
    try { await api(`/bugs/${id}`, { method: 'DELETE' }); toast(`${data.bug.key} deleted successfully`); onChanged(); onClose(); }
    catch (e) { toast(e.message, 'error'); }
  }

  if (err) return <div className="dlg-body"><p className="err">{err}</p></div>;
  if (!data) return <div className="dlg-body"><p className="muted">Loading…</p></div>;
  const b = data.bug;
  const Sec = ({ title, children }) => (
    <div className="sec"><h3>{title}</h3>{children ? <p>{children}</p> : <p className="none">Not provided</p>}</div>
  );

  return (
    <>
      <div className="dlg-head"><span className="key">{b.key}</span><h2 id="view-title">{b.description}</h2>
        <button className="x" onClick={onClose} aria-label="Close">×</button></div>
      <div className="dlg-body">
        <div className="statusbox">
          <strong>Status</strong>
          <select id="v-status" value={status} onChange={e => setStatus(e.target.value)} aria-label="New status">
            {STATUSES.filter(s => tester || DEV_STATUSES.includes(s) || s === b.status).map(s =>
              <option key={s} disabled={!tester && !DEV_STATUSES.includes(s)}>{s}</option>)}
          </select>
          <input id="v-comment" value={comment} onChange={e => setComment(e.target.value)} placeholder="Comment (optional), e.g. fixed in build 1.4.2" />
          <button className="btn primary" disabled={busy} onClick={updateStatus}>Update</button>
          {!tester && <span className="hint full">Closing or reopening is done by the tester after they retest your fix.</span>}
        </div>

        <dl className="meta">
          <div><dt>Status</dt><dd><StatusPill status={b.status} /></dd></div>
          <div><dt>Priority</dt><dd><Priority priority={b.priority} /></dd></div>
          <div><dt>Assignee</dt><dd>{b.assignee_name || 'Unassigned'}</dd></div>
          <div><dt>Panel</dt><dd>{b.panel || '—'}</dd></div>
          <div><dt>Module</dt><dd>{b.module}</dd></div>
          <div><dt>Date reported</dt><dd>{fmtDate(b.date_reported)}</dd></div>
          <div><dt>Reported by</dt><dd>{b.reporter_name || '—'}</dd></div>
        </dl>

        <Sec title="Description">{b.description}</Sec>
        <Sec title="Steps to reproduce">{b.steps}</Sec>
        <div className="compare"><Sec title="Expected result">{b.expected}</Sec><Sec title="Actual result">{b.actual}</Sec></div>
        <div className="sec"><h3>Screenshot / link</h3>
          {!b.link && !b.screenshot && <p className="none">Not provided</p>}
          {b.link && <p><a href={b.link} target="_blank" rel="noopener noreferrer">{b.link}</a></p>}
          {b.screenshot && <a className="shot" href={b.screenshot} target="_blank" rel="noopener noreferrer"><img src={b.screenshot} alt="Screenshot" /></a>}
        </div>
        <div className="sec">
          <h3>Notes {notes == null && <button className="link-btn small" onClick={() => setNotes(b.notes)}>{b.notes ? 'Edit' : 'Add notes'}</button>}</h3>
          {notes != null
            ? <div className="notes-edit">
                <textarea id="v-notes" rows={4} value={notes} onChange={e => setNotes(e.target.value)} autoFocus
                  placeholder="e.g. Root cause: null check missing in cart total. Fixed in build 1.4.2" aria-label="Notes" />
                <div className="row-btns"><button className="btn primary" disabled={busy} onClick={saveNotes}>Save notes</button>
                  <button className="btn" onClick={() => setNotes(null)}>Cancel</button></div>
              </div>
            : b.notes ? <p>{b.notes}</p> : <p className="none">Not provided</p>}
        </div>

        <div className="sec"><h3>History</h3>
          <ul className="hist">
            {data.history.map(h => (
              <li key={h.id}>
                <time>{fmtTime(h.created_at)}</time>
                <span><b>{h.user_name || 'Someone'}</b>{h.user_role ? <span className="role"> {h.user_role}</span> : null}{' '}
                  {h.from_status && h.to_status ? <>changed status <StatusPill status={h.from_status} /> → <StatusPill status={h.to_status} /></>
                    : h.to_status ? <>reported as <StatusPill status={h.to_status} /></>
                    : 'commented'}</span>
                {h.comment && <span className="c">{h.comment}</span>}
              </li>
            ))}
          </ul>
        </div>

        <div className="row-btns">
          {tester && <button className="btn" onClick={() => onEdit(b)}>Edit all fields</button>}
          {b.reporter_id === me.id && <button className="btn danger" onClick={() => setConfirmDel(true)}>Delete</button>}
        </div>
        {confirmDel && (
          <div className="confirm">
            <span>Delete {b.key} for everyone? This can't be undone.</span>
            <button className="btn danger" onClick={del}>Yes, delete</button>
            <button className="btn" onClick={() => setConfirmDel(false)}>Keep</button>
          </div>
        )}
      </div>
    </>
  );
}

// ---------- project picker ----------
function ProjectsScreen({ me, onOpen, onLogout, toast }) {
  const [projects, setProjects] = useState(null);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');

  const load = useCallback(() => api('/projects').then(setProjects).catch(e => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    setErr('');
    try {
      const { project } = await api('/projects', { method: 'POST', body: { name, description: desc } });
      toast(`Project "${project.name}" created successfully`);
      onOpen(project.id);
    } catch (e2) { setErr(e2.message); }
  }

  return (
    <>
      <header className="top">
        <div className="wrap">
          <div className="brand"><h1>Bug Log</h1><span className="sub">{me.name} · {me.role}</span></div>
          <button className="btn ghost" onClick={onLogout}>Sign out</button>
        </div>
      </header>
      <main className="wrap projects">
        <div className="projects-head">
          <h2>Select a project</h2>
          {!adding && <button className="btn primary" onClick={() => setAdding(true)}>+ New project</button>}
        </div>
        {adding && (
          <form className="new-project" onSubmit={create}>
            <label className="f">Project name<input id="p-name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. ROA - Mentorship Web" autoFocus /></label>
            <label className="f">Description<input id="p-desc" value={desc} onChange={e => setDesc(e.target.value)} placeholder="Optional" /></label>
            <div className="row-btns"><button className="btn primary" disabled={!name.trim()}>Create and open</button>
              <button type="button" className="btn" onClick={() => { setAdding(false); setErr(''); }}>Cancel</button></div>
          </form>
        )}
        {err && <div className="notice">{err}</div>}
        {projects && projects.length === 0 && !adding && (
          <div className="empty list"><h2>No projects yet</h2><p>Create a project, then report bugs inside it.</p></div>
        )}
        <div className="project-grid">
          {(projects || []).map(p => (
            <button key={p.id} className="project-card" onClick={() => onOpen(p.id)}>
              <span className="p-name">{p.name}</span>
              {p.description && <span className="p-desc">{p.description}</span>}
              <span className="p-stats">
                <span><b>{p.total}</b> bugs</span>
                <span style={{ '--c': 'var(--s-open)' }}><span className="dot" /> <b>{p.active || 0}</b> open</span>
                <span style={{ '--c': 'var(--s-retest)' }}><span className="dot" /> <b>{p.to_verify || 0}</b> to verify</span>
              </span>
              <span className="p-date">{p.last_activity ? 'Updated ' + fmtTime(p.last_activity) : 'No bugs yet'}</span>
            </button>
          ))}
        </div>
      </main>
    </>
  );
}

const hashProject = () => { const m = location.hash.match(/^#project-(\d+)$/); return m ? Number(m[1]) : null; };

// ---------- main app ----------
export default function App() {
  const [me, setMe] = useState(null);
  const [checking, setChecking] = useState(!!getToken());
  const [projectId, setProjectId] = useState(hashProject);
  useEffect(() => {
    const onHash = () => setProjectId(hashProject());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const [toastState, toast] = useToast();
  const openProject = id => { location.hash = id ? 'project-' + id : ''; setProjectId(id); };
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setToken(null); setMe(null); toast('Signed out successfully');
  };
  const onAuthed = (user, isNew) => {
    setMe(user);
    toast(isNew ? `Account created. Welcome, ${user.name} (${user.role})!` : `Signed in. Welcome back, ${user.name}!`);
  };
  const signedOut = useCallback(() => { setToken(null); setMe(null); toast('Your session ended. Please sign in again.', 'error'); }, [toast]);

  useEffect(() => {
    if (!getToken()) return;
    api('/me').then(d => setMe(d.user)).catch(() => setToken(null)).finally(() => setChecking(false));
  }, []);

  if (checking) return null;
  return (
    <>
      {!me ? <AuthScreen onAuthed={onAuthed} />
        : !projectId ? <ProjectsScreen me={me} onOpen={openProject} onLogout={logout} toast={toast} />
        : <BugPage key={projectId} me={me} projectId={projectId} toast={toast} onBack={() => openProject(null)} onLogout={logout} onSignedOut={signedOut} />}
      <Toast toast={toastState} />
    </>
  );
}

function BugPage({ me, projectId, onBack, onLogout, onSignedOut, toast }) {
  const [project, setProject] = useState(null);
  const [panels, setPanels] = useState([]);
  const [bugs, setBugs] = useState([]);
  const [counts, setCounts] = useState({});
  const [users, setUsers] = useState([]);
  const [loadErr, setLoadErr] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [filters, setFilters] = useState({ status: '', priority: '', assignee: '', panel: '', q: '', sort: 'new' });
  const [viewId, setViewId] = useState(null);
  const [form, setForm] = useState(null); // null | {bug?}
  const fileRef = useRef();
  const me_ = me;

  const loadBugs = useCallback(async () => {
    const qs = new URLSearchParams([['project', projectId], ...Object.entries(filters).filter(([, v]) => v)]).toString();
    try {
      const d = await api('/bugs?' + qs);
      setProject(d.project); setPanels(d.panels);
      setBugs(d.bugs); setCounts(d.counts); setLoadErr(''); setLoaded(true);
    } catch (e) {
      if (e.status === 401) onSignedOut(); else setLoadErr(e.message);
    }
  }, [filters, projectId, onSignedOut]);

  async function onImport(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const r = await importCsv(projectId, file);
      const msg = `Imported ${r.imported} bug${r.imported === 1 ? '' : 's'} successfully` + (r.duplicates ? ` (${r.duplicates} already here, skipped)` : '');
      toast(r.imported || !r.duplicates ? msg : `Nothing new to import: all ${r.duplicates} bugs are already here`, r.imported ? 'success' : 'error');
      loadBugs();
    } catch (e2) { toast(e2.message, 'error'); }
  }

  useEffect(() => {
    const t = setTimeout(loadBugs, filters.q ? 250 : 0);
    return () => clearTimeout(t);
  }, [loadBugs, filters.q]);

  // Refresh every 15 s so status changes by others show up
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) loadBugs(); }, 15000);
    return () => clearInterval(t);
  }, [loadBugs]);

  useEffect(() => { api('/users').then(setUsers).catch(() => {}); }, [form, bugs.length]);

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const setFilter = k => e => setFilters(f => ({ ...f, [k]: e.target.value }));
  const modules = [...new Set(bugs.map(b => b.module))].sort();
  const logout = onLogout;

  return (
    <>
      <header className="top">
        <div className="wrap">
          <button className="btn ghost back" onClick={onBack} aria-label="All projects">← Projects</button>
          <div className="brand"><h1>{project ? project.name : 'Loading…'}</h1><span className="sub">{me_.name} · {me_.role}</span></div>
          {isTester(me) && <>
            <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={onImport} />
            <button className="btn" onClick={() => fileRef.current.click()}>Import CSV</button>
          </>}
          <button className="btn" onClick={() => project && downloadCsv(project).then(() => toast('CSV exported successfully'), e => toast(e.message, 'error'))}>Export CSV</button>
          {isTester(me) && <button className="btn primary" onClick={() => setForm({})}>+ Report bug</button>}
          <button className="btn ghost" onClick={logout}>Sign out</button>
        </div>
      </header>

      <main className="wrap">
        <div className="strip" role="group" aria-label="Filter by status">
          <button className="chip" aria-pressed={!filters.status} onClick={() => setFilters(f => ({ ...f, status: '' }))}>
            All <span className="n">{total}</span></button>
          {STATUSES.map(s => (
            <button key={s} className="chip" aria-pressed={filters.status === s}
              onClick={() => setFilters(f => ({ ...f, status: f.status === s ? '' : s }))}>
              <span className="dot" style={{ '--c': `var(${STATUS_VAR[s]})` }} />{s} <span className="n">{counts[s] || 0}</span>
            </button>
          ))}
        </div>

        <div className="filters">
          <input id="q" type="search" placeholder="Search ID (BUG-012), module, description…" value={filters.q} onChange={setFilter('q')} aria-label="Search bugs" />
          {panels.length > 0 && (
            <select id="f-panel" value={filters.panel} onChange={setFilter('panel')} aria-label="Panel">
              <option value="">All panels</option>{panels.map(p => <option key={p}>{p}</option>)}
            </select>
          )}
          <select id="f-pri" value={filters.priority} onChange={setFilter('priority')} aria-label="Priority">
            <option value="">All priorities</option>{PRIORITIES.map(p => <option key={p}>{p}</option>)}
          </select>
          <select id="f-asg" value={filters.assignee} onChange={setFilter('assignee')} aria-label="Assignee">
            <option value="">All assignees</option><option value="none">Unassigned</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <select id="f-sort" value={filters.sort} onChange={setFilter('sort')} aria-label="Sort">
            <option value="new">Newest first</option><option value="old">Oldest first</option>
            <option value="priority">Priority</option><option value="updated">Recently updated</option>
          </select>
        </div>

        {loadErr && <div className="notice">{loadErr}</div>}

        <div className="list">
          <div className="row head"><span>ID</span><span>Module · Description</span><span>Priority</span><span>Status</span><span>Assignee</span><span>Reported</span></div>
          {loaded && bugs.length === 0 && (
            <div className="empty">
              {total === 0
                ? <><h2>No bugs in this project yet</h2><p>{isTester(me)
                    ? 'Click “+ Report bug” to log one, or “Import CSV” to bring in a spreadsheet.'
                    : 'Testers report bugs here. They will show up as soon as they are logged.'}</p></>
                : <><h2>No bugs match these filters</h2><p>Clear the search or pick another status.</p></>}
            </div>
          )}
          {bugs.map(b => (
            <button key={b.id} className="row" onClick={() => setViewId(b.id)}>
              <span className="key">{b.key}</span>
              <span className="title"><b>{b.description}</b><small>{b.panel ? `${b.panel} · ` : ''}{b.module}</small></span>
              <Priority priority={b.priority} />
              <span className="st"><StatusPill status={b.status} /></span>
              <span className="who">{b.assignee_name || 'Unassigned'}</span>
              <span className="date">{fmtDate(b.date_reported)}</span>
            </button>
          ))}
        </div>
        <p className="foot">The list refreshes every 15 seconds. Every status change is logged in the bug's history.</p>
      </main>

      <Modal open={viewId != null} onClose={() => setViewId(null)} className="sheet" labelledBy="view-title">
        <BugDetail id={viewId} me={me} toast={toast} onClose={() => setViewId(null)} onChanged={loadBugs}
          onEdit={bug => { setViewId(null); setForm({ bug }); }} />
      </Modal>

      <Modal open={form != null} onClose={() => setForm(null)} className="form" labelledBy="form-title">
        <BugForm bug={form?.bug} project={project} users={users} modules={modules} panels={panels} onCancel={() => setForm(null)}
          onSaved={(bug, created) => { toast(created ? `${bug.key} reported successfully` : `${bug.key} updated successfully`); setForm(null); loadBugs(); setViewId(bug.id); }} />
      </Modal>
    </>
  );
}
