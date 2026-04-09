# BigSur Maintenance Tracker

A maintenance tracking web app for **White Rock** and **N2 Ranch** jobsites.

---

## Features

- Work orders with title, description, category, priority, assignee, status, and due dates
- Filter by site, status, and category; full text search
- Dashboard with site stats, alerts, and upcoming work
- Recurring schedules (daily / weekly / biweekly / monthly / quarterly / yearly)
- Equipment meter tracking — hours on tractors, propane tank %, odometers
- Low-level / over-threshold alerts for any meter
- Mobile-friendly (installable as a home screen app)
- Shared database — all team members see the same data in real time

---

## Deploy to Railway (recommended — free tier available)

Railway hosts your app on the internet so the whole crew can access it from any phone.

### Step 1 — Upload to GitHub

1. Create a free account at [github.com](https://github.com) if you don't have one.
2. Create a new repository (call it `maintenance-tracker`).
3. Upload all these files to the repo (drag and drop works on github.com).

### Step 2 — Deploy on Railway

1. Go to [railway.app](https://railway.app) and sign in with GitHub.
2. Click **New Project → Deploy from GitHub Repo**.
3. Select your `maintenance-tracker` repo.
4. Railway will auto-detect Node.js and deploy it. Takes ~2 minutes.

### Step 3 — Add a Volume (keeps your data safe)

Without a volume, your data resets if Railway restarts the app.

1. In your Railway project, click **+ New → Volume**.
2. Attach the volume to your app service.
3. Set the **Mount Path** to `/data`.
4. Add an **Environment Variable** in your service settings:
   - Key: `DB_PATH`
   - Value: `/data/maintenance.db`
5. Redeploy the service.

### Step 4 — Share the link

Railway gives you a public URL like `https://maintenance-tracker-production.up.railway.app`.  
Share this with your crew — they can bookmark it or add it to their phone home screen.

---

## Run locally (for testing)

```bash
npm install
node server.js
# Open http://localhost:3000
```

---

## Add the app to phone home screen

**iPhone:** Open the URL in Safari → Share button → "Add to Home Screen"  
**Android:** Open in Chrome → three-dot menu → "Add to Home screen"

---

## Environment Variables

| Variable  | Default                    | Description                     |
|-----------|----------------------------|---------------------------------|
| `PORT`    | `3000`                     | Port the server listens on      |
| `DB_PATH` | `./maintenance.db`         | Path to the SQLite database file|
