const express = require('express');
const Database = require('better-sqlite3');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const app      = express();
const PORT     = process.env.PORT || 3000;
const DB_PATH  = process.env.DB_PATH || path.join(__dirname, 'maintenance.db');

// Uploads folder lives next to the database file
const UPLOADS_DIR = path.join(path.dirname(DB_PATH), 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

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
    checklist    TEXT DEFAULT '[]',
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

  CREATE TABLE IF NOT EXISTS work_order_photos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    work_order_id  INTEGER NOT NULL,
    filename       TEXT NOT NULL,
    original_name  TEXT NOT NULL,
    created_at     TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (work_order_id) REFERENCES work_orders(id)
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

// Safe migrations for existing databases
const safeAlter = sql => { try { db.exec(sql); } catch (_) {} };
safeAlter("ALTER TABLE work_orders ADD COLUMN checklist TEXT DEFAULT '[]'");
safeAlter("ALTER TABLE work_orders ADD COLUMN title_es TEXT DEFAULT ''");
safeAlter("ALTER TABLE work_orders ADD COLUMN description_es TEXT DEFAULT ''");
safeAlter("ALTER TABLE work_orders ADD COLUMN equipment_id INTEGER REFERENCES equipment(id)");
safeAlter("CREATE TABLE IF NOT EXISTS work_order_photos (id INTEGER PRIMARY KEY AUTOINCREMENT, work_order_id INTEGER NOT NULL, filename TEXT NOT NULL, original_name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))");

// Seed default sites
if (db.prepare('SELECT COUNT(*) as c FROM sites').get().c === 0) {
  db.prepare('INSERT INTO sites (name) VALUES (?)').run('White Rock');
  db.prepare('INSERT INTO sites (name) VALUES (?)').run('N2 Ranch');
}

// ─── Multer (photo uploads) ───────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `wo-${req.params.id}-${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
  fileFilter: (_req, file, cb) => {
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only'));
  }
});

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
      INSERT INTO work_orders (site_id,template_id,title,description,category,priority,assignee,status,due_date)
      VALUES (?,?,?,?,?,?,?,'open',?)
    `).run(t.site_id, t.id, t.title, t.description, t.category, t.priority, t.assignee, t.next_due_date);
    db.prepare('UPDATE recurring_templates SET next_due_date=? WHERE id=?')
      .run(getNextDueDate(t.frequency, t.next_due_date), t.id);
  }
  if (due.length) console.log(`Generated ${due.length} recurring work order(s)`);
}
generateRecurring();
setInterval(generateRecurring, 60 * 60 * 1000);

// ─── Reusable base queries ────────────────────────────────────────────────────
const WO_SELECT = `
  SELECT wo.*,
    s.name as site_name,
    eq.name as equipment_name,
    (SELECT COUNT(*) FROM work_order_photos WHERE work_order_id=wo.id) as photo_count
  FROM work_orders wo
  JOIN sites s ON wo.site_id=s.id
  LEFT JOIN equipment eq ON wo.equipment_id=eq.id
`;
const EQ_SELECT  = 'SELECT e.*, s.name as site_name FROM equipment e JOIN sites s ON e.site_id=s.id';
const TMPL_SELECT= 'SELECT t.*, s.name as site_name FROM recurring_templates t JOIN sites s ON t.site_id=s.id';

// ─── Routes: Sites & Team ─────────────────────────────────────────────────────
app.get('/api/sites', (_req, res) => res.json(db.prepare('SELECT * FROM sites ORDER BY name').all()));

app.get('/api/team', (_req, res) => res.json(db.prepare('SELECT * FROM team_members ORDER BY name').all()));
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
app.get('/api/dashboard', (req, res) => {
  const { assignee } = req.query;
  const aFilter = assignee ? ' AND wo.assignee=?' : '';
  const aParam  = assignee ? [assignee] : [];

  const sites = db.prepare('SELECT * FROM sites').all();
  const stats = sites.map(site => {
    const c = db.prepare(`
      SELECT
        COUNT(CASE WHEN status='open'        THEN 1 END) as open,
        COUNT(CASE WHEN status='in_progress' THEN 1 END) as in_progress,
        COUNT(CASE WHEN status='complete'    THEN 1 END) as complete,
        COUNT(CASE WHEN status!='complete' AND due_date IS NOT NULL AND due_date < date('now') THEN 1 END) as overdue
      FROM work_orders wo WHERE site_id=?${aFilter}
    `).get(site.id, ...aParam);
    return { site, ...c };
  });

  const recent = db.prepare(`
    ${WO_SELECT}
    WHERE 1=1${aFilter.replace('wo.','wo.')}
    ORDER BY wo.updated_at DESC LIMIT 10
  `).all(...aParam);

  const upcoming = db.prepare(`
    ${WO_SELECT}
    WHERE wo.status != 'complete' AND wo.due_date IS NOT NULL
      AND wo.due_date BETWEEN date('now') AND date('now','+7 days')
      ${aFilter}
    ORDER BY wo.due_date ASC LIMIT 10
  `).all(...aParam);

  const alerts = db.prepare(`
    SELECT e.*, s.name as site_name FROM equipment e
    JOIN sites s ON e.site_id=s.id
    WHERE e.alert_threshold IS NOT NULL AND (
      (e.alert_direction='below' AND e.current_value <= e.alert_threshold) OR
      (e.alert_direction='above' AND e.current_value >= e.alert_threshold)
    )
  `).all();

  res.json({ stats, recent, alerts, upcoming });
});

// ─── Routes: Work Orders ──────────────────────────────────────────────────────
app.get('/api/work-orders', (req, res) => {
  const { site, status, category, priority, search, assignee } = req.query;
  let q = WO_SELECT + ' WHERE 1=1';
  const p = [];
  if (site)     { q += ' AND wo.site_id=?';    p.push(site); }
  if (status)   { q += ' AND wo.status=?';     p.push(status); }
  if (category) { q += ' AND wo.category=?';   p.push(category); }
  if (priority) { q += ' AND wo.priority=?';   p.push(priority); }
  if (assignee) { q += ' AND wo.assignee=?';   p.push(assignee); }
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
  const { site_id, title, title_es='', description='', description_es='', checklist='[]', category, priority='medium', assignee='', status='open', due_date, notes='', equipment_id } = req.body;
  if (!site_id || !title || !category) return res.status(400).json({ error: 'site_id, title, category required' });
  const r = db.prepare(`
    INSERT INTO work_orders (site_id,title,title_es,description,description_es,checklist,category,priority,assignee,status,due_date,notes,equipment_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(site_id, title, title_es, description, description_es, checklist, category, priority, assignee, status, due_date||null, notes, equipment_id||null);
  res.status(201).json(db.prepare(WO_SELECT+' WHERE wo.id=?').get(r.lastInsertRowid));
});

app.put('/api/work-orders/:id', (req, res) => {
  const { site_id, title, title_es, description, description_es, checklist, category, priority, assignee, status, due_date, notes, equipment_id } = req.body;
  db.prepare(`
    UPDATE work_orders SET
      site_id        = COALESCE(?,site_id),
      title          = COALESCE(?,title),
      title_es       = COALESCE(?,title_es),
      description    = COALESCE(?,description),
      description_es = COALESCE(?,description_es),
      checklist      = COALESCE(?,checklist),
      category       = COALESCE(?,category),
      priority       = COALESCE(?,priority),
      assignee       = COALESCE(?,assignee),
      status         = COALESCE(?,status),
      due_date       = ?,
      notes          = COALESCE(?,notes),
      equipment_id   = ?,
      completed_at   = CASE WHEN COALESCE(?,status)='complete' AND completed_at IS NULL THEN datetime('now') ELSE completed_at END,
      updated_at     = datetime('now')
    WHERE id=?
  `).run(site_id,title,title_es,description,description_es,checklist,category,priority,assignee,status,due_date??undefined,notes,equipment_id||null,status,req.params.id);
  res.json(db.prepare(WO_SELECT+' WHERE wo.id=?').get(req.params.id));
});

app.delete('/api/work-orders/:id', (req, res) => {
  // Delete associated photos from disk
  const photos = db.prepare('SELECT filename FROM work_order_photos WHERE work_order_id=?').all(req.params.id);
  for (const p of photos) {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, p.filename)); } catch (_) {}
  }
  db.prepare('DELETE FROM work_order_photos WHERE work_order_id=?').run(req.params.id);
  db.prepare('DELETE FROM work_orders WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── Routes: Photos ───────────────────────────────────────────────────────────
app.get('/api/work-orders/:id/photos', (req, res) => {
  res.json(db.prepare('SELECT * FROM work_order_photos WHERE work_order_id=? ORDER BY created_at ASC').all(req.params.id));
});

app.post('/api/work-orders/:id/photos', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const r = db.prepare('INSERT INTO work_order_photos (work_order_id,filename,original_name) VALUES (?,?,?)')
    .run(req.params.id, req.file.filename, req.file.originalname);
  // Update WO updated_at
  db.prepare("UPDATE work_orders SET updated_at=datetime('now') WHERE id=?").run(req.params.id);
  res.status(201).json(db.prepare('SELECT * FROM work_order_photos WHERE id=?').get(r.lastInsertRowid));
});

app.delete('/api/photos/:id', (req, res) => {
  const photo = db.prepare('SELECT * FROM work_order_photos WHERE id=?').get(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(path.join(UPLOADS_DIR, photo.filename)); } catch (_) {}
  db.prepare('DELETE FROM work_order_photos WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── Routes: Equipment ────────────────────────────────────────────────────────
app.get('/api/equipment', (req, res) => {
  const { site } = req.query;
  let q = EQ_SELECT + (site ? ' WHERE e.site_id=?' : '') + ' ORDER BY s.name, e.name';
  res.json(db.prepare(q).all(...(site ? [site] : [])));
});
app.post('/api/equipment', (req, res) => {
  const { site_id, name, description='', meter_type, meter_unit, current_value=0, alert_threshold, alert_direction='below' } = req.body;
  if (!site_id||!name||!meter_type||!meter_unit) return res.status(400).json({ error: 'site_id, name, meter_type, meter_unit required' });
  const r = db.prepare(`
    INSERT INTO equipment (site_id,name,description,meter_type,meter_unit,current_value,alert_threshold,alert_direction)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(site_id,name,description,meter_type,meter_unit,current_value,alert_threshold??null,alert_direction);
  res.status(201).json(db.prepare(EQ_SELECT+' WHERE e.id=?').get(r.lastInsertRowid));
});
app.put('/api/equipment/:id', (req, res) => {
  const { site_id, name, description, meter_type, meter_unit, alert_threshold, alert_direction } = req.body;
  db.prepare(`
    UPDATE equipment SET
      site_id=COALESCE(?,site_id), name=COALESCE(?,name), description=COALESCE(?,description),
      meter_type=COALESCE(?,meter_type), meter_unit=COALESCE(?,meter_unit),
      alert_threshold=?, alert_direction=COALESCE(?,alert_direction)
    WHERE id=?
  `).run(site_id,name,description,meter_type,meter_unit,alert_threshold??null,alert_direction,req.params.id);
  res.json(db.prepare(EQ_SELECT+' WHERE e.id=?').get(req.params.id));
});
app.delete('/api/equipment/:id', (req, res) => {
  db.prepare('DELETE FROM meter_readings WHERE equipment_id=?').run(req.params.id);
  db.prepare('DELETE FROM equipment WHERE id=?').run(req.params.id);
  res.json({ success: true });
});
app.get('/api/equipment/:id/readings', (req, res) => {
  res.json(db.prepare('SELECT * FROM meter_readings WHERE equipment_id=? ORDER BY created_at DESC LIMIT 50').all(req.params.id));
});
app.get('/api/equipment/:id/work-orders', (req, res) => {
  const wos = db.prepare(WO_SELECT + ' WHERE wo.equipment_id=? ORDER BY wo.due_date DESC NULLS LAST, wo.created_at DESC').all(req.params.id);
  res.json(wos);
});

app.post('/api/equipment/:id/readings', (req, res) => {
  const { value, notes='', recorded_by='' } = req.body;
  db.prepare('INSERT INTO meter_readings (equipment_id,value,notes,recorded_by) VALUES (?,?,?,?)').run(req.params.id,value,notes,recorded_by);
  db.prepare('UPDATE equipment SET current_value=? WHERE id=?').run(value, req.params.id);
  res.json(db.prepare(EQ_SELECT+' WHERE e.id=?').get(req.params.id));
});

// ─── Routes: Recurring Templates ──────────────────────────────────────────────
app.get('/api/templates', (_req, res) => {
  res.json(db.prepare(TMPL_SELECT+' ORDER BY t.is_active DESC, t.next_due_date ASC').all());
});
app.post('/api/templates', (req, res) => {
  const { site_id, title, description='', category, priority='medium', assignee='', frequency, start_date } = req.body;
  if (!site_id||!title||!category||!frequency) return res.status(400).json({ error: 'site_id, title, category, frequency required' });
  const r = db.prepare(`
    INSERT INTO recurring_templates (site_id,title,description,category,priority,assignee,frequency,next_due_date)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(site_id,title,description,category,priority,assignee,frequency,start_date||new Date().toISOString().split('T')[0]);
  res.status(201).json(db.prepare(TMPL_SELECT+' WHERE t.id=?').get(r.lastInsertRowid));
});
app.put('/api/templates/:id', (req, res) => {
  const { site_id,title,description,category,priority,assignee,frequency,next_due_date,is_active } = req.body;
  db.prepare(`
    UPDATE recurring_templates SET
      site_id=COALESCE(?,site_id), title=COALESCE(?,title), description=COALESCE(?,description),
      category=COALESCE(?,category), priority=COALESCE(?,priority), assignee=COALESCE(?,assignee),
      frequency=COALESCE(?,frequency), next_due_date=COALESCE(?,next_due_date), is_active=COALESCE(?,is_active)
    WHERE id=?
  `).run(site_id,title,description,category,priority,assignee,frequency,next_due_date,is_active,req.params.id);
  res.json(db.prepare(TMPL_SELECT+' WHERE t.id=?').get(req.params.id));
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
  res.status(201).json(db.prepare(WO_SELECT+' WHERE wo.id=?').get(r.lastInsertRowid));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Maintenance Tracker running on http://localhost:${PORT}`));
