"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const DB_PATH = path.resolve(ROOT, process.env.DATABASE_PATH || "data/employee-dashboard.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY, subject TEXT NOT NULL, description TEXT NOT NULL,
    team TEXT NOT NULL, priority TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Open',
    employee_id TEXT NOT NULL DEFAULT 'PK-001', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS follow_ups (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer TEXT NOT NULL, subject TEXT NOT NULL,
    due_at TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'Medium', status TEXT NOT NULL DEFAULT 'Open',
    source TEXT NOT NULL DEFAULT 'employee-portal', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT NOT NULL, work_date TEXT NOT NULL,
    punch_in TEXT, punch_out TEXT, latitude REAL, longitude REAL, photo TEXT,
    UNIQUE(employee_id, work_date)
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, details TEXT,
    due_at TEXT, priority TEXT NOT NULL DEFAULT 'Medium', status TEXT NOT NULL DEFAULT 'Pending',
    employee_id TEXT NOT NULL DEFAULT 'PK-001', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, details TEXT,
    starts_at TEXT NOT NULL, ends_at TEXT, location TEXT, employee_id TEXT NOT NULL DEFAULT 'PK-001'
  );
  CREATE TABLE IF NOT EXISTS settings (
    employee_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const json = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
};
const body = (req) => new Promise((resolve, reject) => {
  let data = "";
  req.on("data", (chunk) => {
    data += chunk;
    if (data.length > 1_000_000) reject(new Error("Request too large"));
  });
  req.on("end", () => {
    try { resolve(data ? JSON.parse(data) : {}); } catch (error) { reject(new Error("Invalid JSON")); }
  });
  req.on("error", reject);
});
const requireFields = (value, fields) => fields.every((field) => typeof value[field] === "string" && value[field].trim());
const authOkay = (req) => !process.env.API_TOKEN || req.headers.authorization === `Bearer ${process.env.API_TOKEN}`;

async function api(req, res, url) {
  if (!authOkay(req)) return json(res, 401, { error: "Unauthorized" });
  if (url.pathname === "/api/health") return json(res, 200, { ok: true, database: "connected", time: new Date().toISOString() });

  if (url.pathname === "/api/follow-ups" && req.method === "GET") {
    if (process.env.CRM_FOLLOWUPS_URL) {
      try {
        const headers = { Accept: "application/json" };
        if (process.env.CRM_API_TOKEN) headers.Authorization = `Bearer ${process.env.CRM_API_TOKEN}`;
        const response = await fetch(process.env.CRM_FOLLOWUPS_URL, { headers, signal: AbortSignal.timeout(8000) });
        if (response.ok) return json(res, 200, await response.json());
      } catch (_) {}
    }
    return json(res, 200, { followUps: db.prepare("SELECT id, customer, subject, due_at AS dueAt, priority, status FROM follow_ups ORDER BY due_at LIMIT 20").all() });
  }
  if (url.pathname === "/api/follow-ups" && req.method === "POST") {
    const value = await body(req);
    if (!requireFields(value, ["customer", "subject", "dueAt"])) return json(res, 400, { error: "customer, subject and dueAt are required" });
    const result = db.prepare("INSERT INTO follow_ups (customer, subject, due_at, priority, status) VALUES (?, ?, ?, ?, ?)").run(value.customer.trim(), value.subject.trim(), value.dueAt, value.priority || "Medium", value.status || "Open");
    return json(res, 201, { id: Number(result.lastInsertRowid) });
  }

  if (url.pathname === "/api/tickets" && req.method === "GET")
    return json(res, 200, { tickets: db.prepare("SELECT id, subject, description, team, priority, status, created_at AS createdAt FROM tickets ORDER BY created_at DESC").all() });
  if (url.pathname === "/api/tickets" && req.method === "POST") {
    const value = await body(req);
    if (!requireFields(value, ["subject", "description", "team", "priority"])) return json(res, 400, { error: "Missing ticket fields" });
    const prefix = value.team === "HR" ? "HR" : value.team === "Finance" ? "FIN" : "IT";
    const id = `${prefix}-${String(Date.now()).slice(-7)}`;
    db.prepare("INSERT INTO tickets (id, subject, description, team, priority, employee_id) VALUES (?, ?, ?, ?, ?, ?)").run(id, value.subject.trim(), value.description.trim(), value.team, value.priority, value.employeeId || "PK-001");
    return json(res, 201, { id, status: "Open" });
  }
  const ticketMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)$/);
  if (ticketMatch && req.method === "PATCH") {
    const value = await body(req);
    db.prepare("UPDATE tickets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(value.status || "Open", decodeURIComponent(ticketMatch[1]));
    return json(res, 200, { ok: true });
  }

  for (const resource of ["tasks", "events"]) {
    if (url.pathname === `/api/${resource}` && req.method === "GET")
      return json(res, 200, { [resource]: db.prepare(`SELECT * FROM ${resource} ORDER BY id DESC`).all() });
    if (url.pathname === `/api/${resource}` && req.method === "POST") {
      const value = await body(req);
      if (resource === "tasks") {
        if (!value.title) return json(res, 400, { error: "title is required" });
        const result = db.prepare("INSERT INTO tasks (title, details, due_at, priority, status) VALUES (?, ?, ?, ?, ?)").run(value.title, value.details || "", value.dueAt || null, value.priority || "Medium", value.status || "Pending");
        return json(res, 201, { id: Number(result.lastInsertRowid) });
      }
      if (!value.title || !value.startsAt) return json(res, 400, { error: "title and startsAt are required" });
      const result = db.prepare("INSERT INTO events (title, details, starts_at, ends_at, location) VALUES (?, ?, ?, ?, ?)").run(value.title, value.details || "", value.startsAt, value.endsAt || null, value.location || "");
      return json(res, 201, { id: Number(result.lastInsertRowid) });
    }
  }

  if (url.pathname === "/api/attendance" && req.method === "GET")
    return json(res, 200, { attendance: db.prepare("SELECT * FROM attendance ORDER BY work_date DESC LIMIT 90").all() });
  if (url.pathname === "/api/attendance" && req.method === "POST") {
    const value = await body(req);
    const date = value.workDate || new Date().toISOString().slice(0, 10);
    db.prepare(`INSERT INTO attendance (employee_id, work_date, punch_in, punch_out, latitude, longitude, photo)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(employee_id, work_date) DO UPDATE SET
      punch_in = COALESCE(excluded.punch_in, punch_in), punch_out = COALESCE(excluded.punch_out, punch_out),
      latitude = COALESCE(excluded.latitude, latitude), longitude = COALESCE(excluded.longitude, longitude), photo = COALESCE(excluded.photo, photo)`)
      .run(value.employeeId || "PK-001", date, value.punchIn || null, value.punchOut || null, value.latitude || null, value.longitude || null, value.photo || null);
    return json(res, 200, { ok: true, workDate: date });
  }

  if (url.pathname === "/api/settings" && req.method === "GET") {
    const row = db.prepare("SELECT payload FROM settings WHERE employee_id = ?").get("PK-001");
    return json(res, 200, row ? JSON.parse(row.payload) : {});
  }
  if (url.pathname === "/api/settings" && req.method === "PUT") {
    const value = await body(req);
    db.prepare("INSERT INTO settings (employee_id, payload) VALUES (?, ?) ON CONFLICT(employee_id) DO UPDATE SET payload = excluded.payload, updated_at = CURRENT_TIMESTAMP").run("PK-001", JSON.stringify(value));
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: "API route not found" });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), geolocation=(self)");
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    const requested = url.pathname === "/" ? "employee-hiring-joining-form.html" : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(ROOT, requested);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { error: "Not found" });
    const types = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    console.error(error);
    json(res, error.message === "Invalid JSON" ? 400 : 500, { error: error.message || "Internal server error" });
  }
});

server.listen(PORT, HOST, () => console.log(`OpsPulse running at http://localhost:${PORT}`));

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

