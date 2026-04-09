const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'maintenance.db');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Database ─────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS team_members (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS work_orders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id      INTEGER NOT NULL,
    template_id  INTEGER,
    title        TEXT NOT NULL,
    description  TEXT DEFAULT '',
    category     TEXT NOT NULL,
    priority     TEXT NOT NULL DEFAULT 'medium',
    assignee     TEXT DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'open',
    due_date     TEXT,
    completed_at TEXT,
    notes        TEXT DEFAULT '',
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (site_id) REFERENCES sites(id)
  );

  CREATE TABLE IF NOT EXISTS recurring_templates (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id       INTEGER NOT NULL,
    title         TEXT NOT NULL,
    description   TEXT DEFAULT '',
    category      TEXT NOT NULL,
    priority      TEXT NOT NULL DEFAULT 'medium',
    assignee      TEXT DEFAULT '',
    frequency     TEXT NOT NULL,
    next_due_date TEXT,
    is_active     INTEGER DEFAULT 1,
    created_at    TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (site_id) REFERENCES sites(id)
  );

  CREATE TABLE IF NOT EXISTS equipment (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id         INTEGER NOT NULL,
    name            TEXT NOT NULL,
    description     TEXT DEFAULT '',
    meter_type      TEXT NOT NULL,
    meter_unit      TEXT NOT NULL,
    current_value   REAL DEFAULT 0,
    alert_threshold REAL,
    alert_direction TEXT DEFAULT 'below',
    created_at      TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (site_id) REFERENCES sites(id)
  );

  CREATE TABLE IF NOT EXISTS meter_readings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    equipment_id INTEGER NOT NULL,
    value        REAL NOT NULL,
    notes        TEXT DEFAULT '',
    recorded_by  TEXT DEFAULT '',
    created_at   TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (equipment_id) REFERENCES equipment(id)
  );
`);

// Seed default sites if empty
const siteCount = db.prepare('SELECT COUNT(*) as c FROM sites').get().c;
if (siteCount === 0) {
  db.prepare('INSERT INTO sites (name) VALUES (?)').run('White Rock');
  db.prepare('INSERT INTO sites (name) VALUES (?)').run('N2 Ranch');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().split('T')[0];
}

function getNextDueDate(frequency, fromDate) {
  const base = fromDate || new Date().toISOString().split('T')[0];
  switch (frequency) {
    case 'daily':     return addDays(base, 1);
    case 'weekly':    return addDays(base, 7);
    case 'biweekly':  return addDays(base, 14);
    case 'monthly':   return addMonths(base, 1);
    case 'quarterly': return addMonths(base, 3);
    case 'yearly':    return addMonths(base, 12);
    default:          return addDays(base, 7);
  }
}

function generateRecurring() {
  const today = new Date().toISOString().split('T')[0];
  const due = db.prepare(
    'SELECT * FROM recurring_templates WHERE is_active=1 AND next_due_date <= ?'
  ).all(today);

  for (const t of due) {
    db.prepare(`
      INSERT INTO work_orders (site_id, template_id, title, description, category, priority, assignee, status, due_date)
      VALUES (?,?,?,?,?,?,?,'open',?)
    `).run(t.site_id, t.id, t.title, t.description, t.category, t.priority, t.assignee, t.next_due_date);

    db.prepare('UPDATE recurring_templates SET next_due_date=? WHERE id=?')
      .run(getNextDueDate(t.frequency, t.next_due_date), t.id);
  }
  if (due.length) console.log(`Generated ${due.length} recurring work order(s)`);
}

generateRecurring();
setInterval(generateRecurring, 60 * 60 * 1000); // check every hour

// ─── Reusable queries ─────────────────────────────────────────────────────────
const woWithSite = 'SELECT wo.*, s.name as site_name FROM work_orders wo JOIN sites s ON wo.site_id=s.id WHERE wo.id=?';
const eqWithSite = 'SELECT e.*, s.name as site_name FROM equipment e JOIN sites s ON e.site_id=s.id WHERE e.id=?';
const tmplWithSite = 'SELECT t.*, s.name as site_name FROM recurring_templates t JOIN sites s ON t.site_id=s.id WHERE t.id=?';

// ─── Routes: Sites & Team ─────────────────────────────────────────────────────
app.get('/api/sites', (_req, res) => {
  res.json(db.prepare('SELECT * FROM sites ORDER BY name').all());
});

app.get('/api/team', (_req, res) => {
  res.json(db.prepare('SELECT * FROM team_members ORDER BY name').all());
});
app.post('/api/team', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const r = db.prepare('INSERT INTO team_members (name) VALUES (?)').run(name.trim());
  res.status(201).json(db.prepare('SELECT * FROM team_members WHERE id=?').get(r.lastInsertRowid));
});
app.delete('/api/team/:id', (req, res) => {
  db.prepare('DELETE FROM team_members WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── Routes: Dashboard ────────────────────────────────────────────────────────
app.get('/api/dashboard', (_req, res) => {
  const sites = db.prepare('SELECT * FROM sites').all();
  const stats = sites.map(site => {
    const c = db.prepare(`
      SELECT
        COUNT(CASE WHEN status='open'        THEN 1 END) as open,
        COUNT(CASE WHEN status='in_progress' THEN 1 END) as in_progress,
        COUNT(CASE WHEN status='complete'    THEN 1 END) as complete,
        COUNT(CASE WHEN status!='complete' AND due_date IS NOT NULL AND due_date < date('now') THEN 1 END) as overdue
      FROM work_orders WHERE site_id=?
    `).get(site.id);
    return { site, ...c };
  });

  const recent = db.prepare(`
    SELECT wo.*, s.name as site_name FROM work_orders wo
    JOIN sites s ON wo.site_id=s.id
    ORDER BY wo.updated_at DESC LIMIT 10
  `).all();

  const alerts = db.prepare(`
    SELECT e.*, s.name as site_name FROM equipment e
    JOIN sites s ON e.site_id=s.id
    WHERE e.alert_threshold IS NOT NULL AND (
      (e.alert_direction='below' AND e.current_value <= e.alert_threshold) OR
      (e.alert_direction='above' AND e.current_value >= e.alert_threshold)
    )
  `).all();

  const upcoming = db.prepare(`
    SELECT wo.*, s.name as site_name FROM work_orders wo
    JOIN sites s ON wo.site_id=s.id
    WHERE wo.status != 'complete' AND wo.due_date IS NOT NULL
      AND wo.due_date BETWEEN date('now') AND date('now','+7 days')
    ORDER BY wo.due_date ASC LIMIT 10
  `).all();

  res.json({ stats, recent, alerts, upcoming });
});

// ─── Routes: Work Orders ──────────────────────────────────────────────────────
app.get('/api/work-orders', (req, res) => {
  const { site, status, category, priority, search } = req.query;
  let q = 'SELECT wo.*, s.name as site_name FROM work_orders wo JOIN sites s ON wo.site_id=s.id WHERE 1=1';
  const p = [];
  if (site)     { q += ' AND wo.site_id=?';  p.push(site); }
  if (status)   { q += ' AND wo.status=?';   p.push(status); }
  if (category) { q += ' AND wo.category=?'; p.push(category); }
  if (priority) { q += ' AND wo.priority=?'; p.push(priority); }
  if (search)   {
    q += ' AND (wo.title LIKE ? OR wo.description LIKE ? OR wo.assignee LIKE ?)';
    p.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  q += ` ORDER BY
    CASE wo.status WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END,
    CASE wo.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
    wo.due_date ASC NULLS LAST, wo.created_at DESC`;
  res.json(db.prepare(q).all(...p));
});

app.post('/api/work-orders', (req, res) => {
  const { site_id, title, description='', category, priority='medium', assignee='', status='open', due_date, notes='' } = req.body;
  if (!site_id || !title || !category) return res.status(400).json({ error: 'site_id, title, category required' });
  const r = db.prepare(`
    INSERT INTO work_orders (site_id,title,description,category,priority,assignee,status,due_date,notes)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(site_id, title, description, category, priority, assignee, status, due_date||null, notes);
  res.status(201).json(db.prepare(woWithSite).get(r.lastInsertRowid));
});

app.put('/api/work-orders/:id', (req, res) => {
  const { site_id, title, description, category, priority, assignee, status, due_date, notes } = req.body;
  db.prepare(`
    UPDATE work_orders SET
      site_id     = COALESCE(?,site_id),
      title       = COALESCE(?,title),
      description = COALESCE(?,description),
      category    = COALESCE(?,category),
      priority    = COALESCE(?,priority),
      assignee    = COALESCE(?,assignee),
      status      = COALESCE(?,status),
      due_date    = ?,
      notes       = COALESCE(?,notes),
      completed_at= CASE WHEN COALESCE(?,status)='complete' AND completed_at IS NULL THEN datetime('now') ELSE completed_at END,
      updated_at  = datetime('now')
    WHERE id=?
  `).run(site_id,title,description,category,priority,assignee,status,due_date??undefined,notes,status,req.params.id);
  res.json(db.prepare(woWithSite).get(req.params.id));
});

app.delete('/api/work-orders/:id', (req, res) => {
  db.prepare('DELETE FROM work_orders WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── Routes: Equipment ────────────────────────────────────────────────────────
app.get('/api/equipment', (req, res) => {
  const { site } = req.query;
  let q = 'SELECT e.*, s.name as site_name FROM equipment e JOIN sites s ON e.site_id=s.id';
  if (site) q += ' WHERE e.site_id=?';
  q += ' ORDER BY s.name, e.name';
  res.json(db.prepare(q).all(...(site ? [site] : [])));
});

app.post('/api/equipment', (req, res) => {
  const { site_id, name, description='', meter_type, meter_unit, current_value=0, alert_threshold, alert_direction='below' } = req.body;
  if (!site_id || !name || !meter_type || !meter_unit) return res.status(400).json({ error: 'site_id, name, meter_type, meter_unit required' });
  const r = db.prepare(`
    INSERT INTO equipment (site_id,name,description,meter_type,meter_unit,current_value,alert_threshold,alert_direction)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(site_id, name, description, meter_type, meter_unit, current_value, alert_threshold??null, alert_direction);
  res.status(201).json(db.prepare(eqWithSite).get(r.lastInsertRowid));
});

app.put('/api/equipment/:id', (req, res) => {
  const { site_id, name, description, meter_type, meter_unit, alert_threshold, alert_direction } = req.body;
  db.prepare(`
    UPDATE equipment SET
      site_id         = COALESCE(?,site_id),
      name            = COALESCE(?,name),
      description     = COALESCE(?,description),
      meter_type      = COALESCE(?,meter_type),
      meter_unit      = COALESCE(?,meter_unit),
      alert_threshold = ?,
      alert_direction = COALESCE(?,alert_direction)
    WHERE id=?
  `).run(site_id,name,description,meter_type,meter_unit,alert_threshold??null,alert_direction,req.params.id);
  res.json(db.prepare(eqWithSite).get(req.params.id));
});

app.delete('/api/equipment/:id', (req, res) => {
  db.prepare('DELETE FROM meter_readings WHERE equipment_id=?').run(req.params.id);
  db.prepare('DELETE FROM equipment WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/equipment/:id/readings', (req, res) => {
  res.json(db.prepare('SELECT * FROM meter_readings WHERE equipment_id=? ORDER BY created_at DESC LIMIT 50').all(req.params.id));
});

app.post('/api/equipment/:id/readings', (req, res) => {
  const { value, notes='', recorded_by='' } = req.body;
  db.prepare('INSERT INTO meter_readings (equipment_id,value,notes,recorded_by) VALUES (?,?,?,?)').run(req.params.id, value, notes, recorded_by);
  db.prepare('UPDATE equipment SET current_value=? WHERE id=?').run(value, req.params.id);
  res.json(db.prepare(eqWithSite).get(req.params.id));
});

// ─── Routes: Recurring Templates ──────────────────────────────────────────────
app.get('/api/templates', (_req, res) => {
  res.json(db.prepare(`
    SELECT t.*, s.name as site_name FROM recurring_templates t
    JOIN sites s ON t.site_id=s.id ORDER BY t.is_active DESC, t.next_due_date ASC
  `).all());
});

app.post('/api/templates', (req, res) => {
  const { site_id, title, description='', category, priority='medium', assignee='', frequency, start_date } = req.body;
  if (!site_id||!title||!category||!frequency) return res.status(400).json({ error: 'site_id, title, category, frequency required' });
  const next = start_date || new Date().toISOString().split('T')[0];
  const r = db.prepare(`
    INSERT INTO recurring_templates (site_id,title,description,category,priority,assignee,frequency,next_due_date)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(site_id,title,description,category,priority,assignee,frequency,next);
  res.status(201).json(db.prepare(tmplWithSite).get(r.lastInsertRowid));
});

app.put('/api/templates/:id', (req, res) => {
  const { site_id,title,description,category,priority,assignee,frequency,next_due_date,is_active } = req.body;
  db.prepare(`
    UPDATE recurring_templates SET
      site_id       = COALESCE(?,site_id),
      title         = COALESCE(?,title),
      description   = COALESCE(?,description),
      category      = COALESCE(?,category),
      priority      = COALESCE(?,priority),
      assignee      = COALESCE(?,assignee),
      frequency     = COALESCE(?,frequency),
      next_due_date = COALESCE(?,next_due_date),
      is_active     = COALESCE(?,is_active)
    WHERE id=?
  `).run(site_id,title,description,category,priority,assignee,frequency,next_due_date,is_active,req.params.id);
  res.json(db.prepare(tmplWithSite).get(req.params.id));
});

app.delete('/api/templates/:id', (req, res) => {
  db.prepare('DELETE FROM recurring_templates WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/templates/:id/generate', (req, res) => {
  const t = db.prepare('SELECT * FROM recurring_templates WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const r = db.prepare(`
    INSERT INTO work_orders (site_id,template_id,title,description,category,priority,assignee,status,due_date)
    VALUES (?,?,?,?,?,?,?,'open',?)
  `).run(t.site_id,t.id,t.title,t.description,t.category,t.priority,t.assignee,t.next_due_date);
  db.prepare('UPDATE recurring_templates SET next_due_date=? WHERE id=?')
    .run(getNextDueDate(t.frequency, t.next_due_date), t.id);
  res.status(201).json(db.prepare(woWithSite).get(r.lastInsertRowid));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Maintenance Tracker running on http://localhost:${PORT}`));
