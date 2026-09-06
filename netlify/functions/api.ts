import type { Handler, HandlerEvent } from "@netlify/functions";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

type SqlArg = string | number | bigint | boolean | null | ArrayBuffer | Uint8Array;
type SqlResult = { rows: any[]; columns?: any[]; cols?: any[]; affectedRows?: number; lastInsertRowid?: any };

function encodeArg(v: SqlArg) {
  if (v === null || v === undefined) return { type: "null" };
  if (v instanceof ArrayBuffer || v instanceof Uint8Array) {
    const bytes = v instanceof Uint8Array ? v : new Uint8Array(v);
    return { type: "blob", base64: Buffer.from(bytes).toString("base64") };
  }
  if (typeof v === "boolean") return { type: "integer", value: v ? "1" : "0" };
  if (typeof v === "bigint") return { type: "integer", value: v.toString() };
  if (typeof v === "number") return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: String(v) };
  return { type: "text", value: String(v) };
}

function getTursoHttpConfig() {
  const rawUrl = process.env.TURSO_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || "libsql://rehaflow-echomedtechnologies.aws-ap-south-1.turso.io";
  const token = process.env.TURSO_AUTH_TOKEN?.trim() || "";
  if (!token) throw new Error("TURSO_AUTH_TOKEN is not configured in Netlify.");
  let base = rawUrl.replace(/^\"|\"$/g, "").split("?")[0].replace(/\/+$/, "");
  if (base.startsWith("libsql://")) base = base.replace(/^libsql:\/\//, "https://");
  if (!base.startsWith("https://")) throw new Error("Invalid TURSO_DATABASE_URL. Expected libsql://<database>.turso.io");
  return { endpoint: `${base}/v2/pipeline`, token };
}

class TursoHttpClient {
  private endpoint: string;
  private token: string;
  constructor() { const c = getTursoHttpConfig(); this.endpoint = c.endpoint; this.token = c.token; }
  private async request(requests: any[]): Promise<any[]> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [...requests, { type: "close" }] }),
    });
    const payload: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Turso HTTP ${res.status}: ${payload?.error?.message || payload?.message || res.statusText}`);
    const results = payload.results || [];
    for (const item of results) if (item?.type === "error") throw new Error(`Turso SQL error: ${item.error?.message || item.error || "Unknown error"}`);
    return results.filter((x: any) => x?.response?.type === "execute").map((x: any) => x.response.result || {});
  }
  async execute(input: { sql: string; args?: SqlArg[] } | string): Promise<SqlResult> {
    const stmt = typeof input === "string" ? { sql: input } : { sql: input.sql, ...(input.args?.length ? { args: input.args.map(encodeArg) } : {}) };
    const r = (await this.request([{ type: "execute", stmt }]))[0] || {};
    const cols = r.cols || r.columns || [];
    const rows = (r.rows || []).map((row: any[]) => {
      const obj: any = {};
      cols.forEach((c: any, i: number) => {
        const name = typeof c === "string" ? c : c.name;
        const val = row[i];
        obj[name] = val && typeof val === "object" && "value" in val ? val.value : val && typeof val === "object" && "base64" in val ? Buffer.from(val.base64, "base64") : val;
      });
      return obj;
    });
    return { rows, cols, columns: cols, affectedRows: Number(r.affected_row_count || 0), lastInsertRowid: r.last_insert_rowid };
  }
}

let client: TursoHttpClient | null = null;
let initialized = false;
let initPromise: Promise<void> | null = null;
function db() { if (!client) client = new TursoHttpClient(); return client; }
function now() { return new Date().toISOString(); }
function id(prefix: string) { return `${prefix}_${crypto.randomBytes(10).toString("hex")}`; }
function token(bytes = 32) { return crypto.randomBytes(bytes).toString("hex"); }
function hash(input: string) { return crypto.createHash("sha256").update(input).digest("hex"); }
function json(body: any, status = 200) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client, X-Device-Id, X-Device-Name, X-Device-Platform, X-App-Version",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    },
    body: JSON.stringify(body),
  };
}
function parseBody(event: HandlerEvent): any { try { return event.body ? JSON.parse(event.body) : {}; } catch { return {}; } }
function bearer(event: HandlerEvent) { const h = event.headers?.authorization || event.headers?.Authorization || ""; return h.startsWith("Bearer ") ? h.slice(7) : ""; }
function query(event: HandlerEvent, key: string, fallback = "") { return event.queryStringParameters?.[key] ?? fallback; }

const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: ["*"],
  manager: ["dashboard", "patients", "tasks", "beds", "documents", "schedule", "staff", "analytics", "reception"],
  doctor: ["dashboard", "patients", "tasks", "documents", "schedule", "reception"],
  nurse: ["dashboard", "patients", "tasks", "beds", "documents"],
  registrar: ["dashboard", "patients", "reception", "schedule"],
};

async function ensureSchema() {
  if (initialized) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const c = db();
    await c.execute(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, name TEXT, password_hash TEXT, role TEXT DEFAULT 'doctor', active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    await c.execute(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT, access_token TEXT, refresh_token TEXT, expires_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    await c.execute(`CREATE TABLE IF NOT EXISTS login_history (id TEXT PRIMARY KEY, user_id TEXT, identifier TEXT, success INTEGER, ip TEXT, user_agent TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    await c.execute(`CREATE TABLE IF NOT EXISTS rf_patients (id TEXT PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL, middle_name TEXT, phone TEXT, birth_date TEXT, sex TEXT, diagnosis TEXT, room TEXT, bed INTEGER, status TEXT DEFAULT 'active', notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    await c.execute(`CREATE TABLE IF NOT EXISTS rf_tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, patient_id TEXT, assigned_to TEXT, priority TEXT DEFAULT 'normal', status TEXT DEFAULT 'pending', due_at TEXT, created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    await c.execute(`CREATE TABLE IF NOT EXISTS rf_beds (id TEXT PRIMARY KEY, room TEXT NOT NULL, bed_number INTEGER NOT NULL, status TEXT DEFAULT 'available', patient_id TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    await c.execute(`CREATE TABLE IF NOT EXISTS rf_appointments (id TEXT PRIMARY KEY, patient_id TEXT, doctor_id TEXT, starts_at TEXT NOT NULL, duration_minutes INTEGER DEFAULT 30, type TEXT DEFAULT 'consultation', status TEXT DEFAULT 'scheduled', notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    await c.execute(`CREATE TABLE IF NOT EXISTS rf_documents (id TEXT PRIMARY KEY, patient_id TEXT, title TEXT NOT NULL, category TEXT DEFAULT 'other', file_name TEXT, file_url TEXT, created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    await c.execute(`CREATE TABLE IF NOT EXISTS rf_audit (id TEXT PRIMARY KEY, user_id TEXT, action TEXT, entity TEXT, entity_id TEXT, details TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);

    const adminEmail = process.env.DEFAULT_ADMIN_EMAIL?.trim() || "mishaborkovskijwork@gmail.com";
    const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD || "12345678";
    const adminName = process.env.DEFAULT_ADMIN_NAME?.trim() || "System Administrator";
    const existingAdmin = await c.execute({ sql: `SELECT id FROM users WHERE lower(email)=lower(?) LIMIT 1`, args: [adminEmail] });
    if (existingAdmin.rows.length === 0) {
      await c.execute({ sql: `INSERT INTO users(id,email,name,password_hash,role,active) VALUES(?,?,?,?,?,1)`, args: ["admin-default", adminEmail, adminName, await bcrypt.hash(adminPassword, 10), "admin"] });
    }

    const pc = await c.execute(`SELECT COUNT(*) AS count FROM rf_patients`);
    if (Number(pc.rows[0]?.count || 0) === 0) {
      const sample = [
        ["Олег", "Іваненко", "+380671112233", "1978-04-12", "Гіпертонічна хвороба", "101", 1],
        ["Марія", "Коваль", "+380672223344", "1989-08-19", "Пневмонія", "101", 2],
        ["Андрій", "Бондар", "+380673334455", "1966-11-03", "Цукровий діабет 2 типу", "102", 1],
        ["Ірина", "Шевчук", "+380674445566", "1992-02-21", "Гострий бронхіт", "102", 2],
        ["Петро", "Мельник", "+380675556677", "1959-06-07", "Постінфарктний стан", "103", 1],
      ];
      for (const [first,last,phone,birth,diagnosis,room,bed] of sample) await c.execute({ sql: `INSERT INTO rf_patients(id,first_name,last_name,phone,birth_date,diagnosis,room,bed,status) VALUES(?,?,?,?,?,?,?,?,?)`, args: [id("pt"), first, last, phone, birth, diagnosis, room, bed, "active"] });
    }

    const bc = await c.execute(`SELECT COUNT(*) AS count FROM rf_beds`);
    if (Number(bc.rows[0]?.count || 0) === 0) {
      for (let i = 1; i <= 14; i++) {
        const room = String(101 + Math.floor((i - 1) / 2));
        const status = i <= 10 ? "occupied" : i === 11 ? "dirty" : i === 12 ? "maintenance" : "available";
        const p = i <= 10 ? (await c.execute({ sql: `SELECT id FROM rf_patients ORDER BY created_at LIMIT 1 OFFSET ?`, args: [((i - 1) % 5)] })).rows[0]?.id || null : null;
        await c.execute({ sql: `INSERT INTO rf_beds(id,room,bed_number,status,patient_id) VALUES(?,?,?,?,?)`, args: [id("bed"), room, i % 2 === 0 ? 2 : 1, status, p] });
      }
    }

    const tc = await c.execute(`SELECT COUNT(*) AS count FROM rf_tasks`);
    if (Number(tc.rows[0]?.count || 0) === 0) {
      const titles = ["Контроль тиску · палата 101", "Крапельниця · палата 103", "Перев'язка · палата 104", "Огляд пацієнта", "Підготувати виписку"];
      for (let i = 0; i < titles.length; i++) await c.execute({ sql: `INSERT INTO rf_tasks(id,title,description,priority,status,created_at) VALUES(?,?,?,?,?,?)`, args: [id("task"), titles[i], "Первинне оперативне завдання", i < 2 ? "critical" : i === 2 ? "high" : "normal", i < 2 ? "overdue" : "pending", now()] });
    }
    initialized = true;
  })().catch(err => { initPromise = null; throw err; });
  return initPromise;
}

async function currentUser(event: HandlerEvent) {
  const t = bearer(event);
  if (!t) return null;
  const r = await db().execute({ sql: `SELECT u.id,u.email,u.name,u.role,u.active,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.access_token=? LIMIT 1`, args: [hash(t)] });
  const u: any = r.rows[0];
  if (!u || String(u.active ?? 1) === "0" || (u.expires_at && new Date(String(u.expires_at)).getTime() < Date.now())) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role || "doctor", active: Number(u.active ?? 1) };
}
async function requireUser(event: HandlerEvent) {
  const user = await currentUser(event);
  if (!user) throw Object.assign(new Error("Unauthorized"), { status: 401 });
  return user;
}
function can(user: any, permission: string) { const list = ROLE_PERMISSIONS[user?.role] || []; return list.includes("*") || list.includes(permission); }
function forbidden() { return Object.assign(new Error("Forbidden"), { status: 403 }); }
async function audit(user: any, action: string, entity: string, entityId = "", details: any = {}) { await db().execute({ sql: `INSERT INTO rf_audit(id,user_id,action,entity,entity_id,details) VALUES(?,?,?,?,?,?)`, args: [id("audit"), user?.id ?? null, action, entity, entityId, JSON.stringify(details)] }); }

async function auth(path: string, event: HandlerEvent) {
  if (event.httpMethod === "OPTIONS") return json({ ok: true });
  if (path === "/login" && event.httpMethod === "POST") {
    const body = parseBody(event);
    const identifier = String(body.email ?? body.login ?? body.username ?? body.identifier ?? "").trim();
    const password = String(body.password ?? "");
    if (!identifier || !password) return json({ error: "Email/login and password are required" }, 400);
    const r = await db().execute({ sql: `SELECT id,email,name,password_hash,role,active FROM users WHERE lower(email)=lower(?) OR lower(name)=lower(?) LIMIT 1`, args: [identifier, identifier] });
    const user: any = r.rows[0];
    const ok = !!user && (String(user.password_hash || "").startsWith("$2") ? await bcrypt.compare(password, String(user.password_hash)) : String(user.password_hash || "") === password);
    await db().execute({ sql: `INSERT INTO login_history(id,user_id,identifier,success,ip,user_agent) VALUES(?,?,?,?,?,?)`, args: [id("login"), user?.id ?? null, identifier, ok ? 1 : 0, event.headers?.["x-forwarded-for"] ?? null, event.headers?.["user-agent"] ?? null] });
    if (!user || !ok || String(user.active ?? 1) === "0") return json({ error: "Invalid credentials" }, 401);
    const accessToken = token(), refreshToken = token(), sessionId = id("sess");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 12).toISOString();
    await db().execute({ sql: `INSERT INTO sessions(id,user_id,access_token,refresh_token,expires_at) VALUES(?,?,?,?,?)`, args: [sessionId, user.id, hash(accessToken), hash(refreshToken), expiresAt] });
    return json({ accessToken, refreshToken, token: accessToken, session: { id: sessionId, expiresAt }, user: { id: user.id, email: user.email, name: user.name, role: user.role, active: Number(user.active ?? 1) } });
  }
  if (path === "/logout" && event.httpMethod === "POST") {
    const t = bearer(event); if (t) await db().execute({ sql: `DELETE FROM sessions WHERE access_token=?`, args: [hash(t)] });
    return json({ ok: true });
  }
  if ((path === "/me" || path === "/session") && event.httpMethod === "GET") {
    const u = await currentUser(event); if (!u) return json({ error: "Unauthorized" }, 401);
    return json({ authenticated: true, user: u });
  }
  return json({ error: "API endpoint not found" }, 404);
}

async function usersApi(path: string, event: HandlerEvent, user: any) {
  if (!can(user, "staff")) throw forbidden();
  if (path === "/users" && event.httpMethod === "GET") {
    const q = query(event, "q");
    const r = await db().execute({ sql: `SELECT id,email,name,role,active,created_at FROM users WHERE (?='' OR lower(email) LIKE lower(?) OR lower(name) LIKE lower(?)) ORDER BY name`, args: [q, `%${q}%`, `%${q}%`] });
    return json({ users: r.rows });
  }
  if (path === "/users" && event.httpMethod === "POST") {
    const b = parseBody(event); if (!b.email || !b.password || !b.name) return json({ error: "name, email and password are required" }, 400);
    const exists = await db().execute({ sql: `SELECT id FROM users WHERE lower(email)=lower(?) LIMIT 1`, args: [String(b.email).trim()] });
    if (exists.rows.length) return json({ error: "Email already exists" }, 409);
    const newId = id("usr");
    await db().execute({ sql: `INSERT INTO users(id,email,name,password_hash,role,active) VALUES(?,?,?,?,?,?)`, args: [newId, String(b.email).trim(), String(b.name).trim(), await bcrypt.hash(String(b.password), 10), String(b.role || "doctor"), b.active === false ? 0 : 1] });
    await audit(user, "create", "user", newId, { role: b.role });
    return json({ user: { id: newId, email: b.email, name: b.name, role: b.role || "doctor", active: b.active === false ? 0 : 1 } }, 201);
  }
  const m = path.match(/^\/users\/([^/]+)$/);
  if (m && event.httpMethod === "PATCH") {
    const b = parseBody(event); const sets: string[] = []; const args: any[] = [];
    if (b.name !== undefined) { sets.push("name=?"); args.push(b.name); }
    if (b.role !== undefined) { sets.push("role=?"); args.push(b.role); }
    if (b.active !== undefined) { sets.push("active=?"); args.push(b.active ? 1 : 0); }
    if (b.password) { sets.push("password_hash=?"); args.push(await bcrypt.hash(String(b.password), 10)); }
    if (!sets.length) return json({ ok: true });
    args.push(m[1]); await db().execute({ sql: `UPDATE users SET ${sets.join(",")} WHERE id=?`, args });
    await audit(user, "update", "user", m[1], b); return json({ ok: true });
  }
  if (m && event.httpMethod === "DELETE") { if (m[1] === user.id) return json({ error: "You cannot delete your own account" }, 400); await db().execute({ sql: `DELETE FROM users WHERE id=?`, args: [m[1]] }); await audit(user, "delete", "user", m[1]); return json({ ok: true }); }
  if (path === "/roles" && event.httpMethod === "GET") return json({ roles: Object.entries(ROLE_PERMISSIONS).map(([role, permissions]) => ({ role, permissions })) });
  return json({ error: "API endpoint not found" }, 404);
}

async function patientsApi(path: string, event: HandlerEvent, user: any) {
  if (!can(user, "patients")) throw forbidden();
  if (path === "/patients" && event.httpMethod === "GET") {
    const q = query(event, "q"); const status = query(event, "status", "active"); const limit = Math.min(Number(query(event, "limit", "500")) || 500, 1000);
    const r = await db().execute({ sql: `SELECT * FROM rf_patients WHERE (?='' OR status=?) AND (?='' OR lower(first_name||' '||last_name) LIKE lower(?) OR lower(phone) LIKE lower(?)) ORDER BY last_name,first_name LIMIT ?`, args: [status, status, q, `%${q}%`, `%${q}%`, limit] });
    return json({ patients: r.rows, items: r.rows });
  }
  if (path === "/patients" && event.httpMethod === "POST") {
    const b = parseBody(event); if (!b.firstName && !b.first_name || !b.lastName && !b.last_name) return json({ error: "First and last name are required" }, 400);
    const newId = id("pt");
    await db().execute({ sql: `INSERT INTO rf_patients(id,first_name,last_name,middle_name,phone,birth_date,sex,diagnosis,room,bed,status,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, args: [newId, b.firstName ?? b.first_name, b.lastName ?? b.last_name, b.middleName ?? b.middle_name ?? null, b.phone ?? null, b.birthDate ?? b.birth_date ?? null, b.sex ?? null, b.diagnosis ?? null, b.room ?? null, b.bed ?? null, b.status ?? "active", b.notes ?? null] });
    await audit(user, "create", "patient", newId, b); return json({ patient: { id: newId, ...b } }, 201);
  }
  const m = path.match(/^\/patients\/([^/]+)$/);
  if (m && event.httpMethod === "GET") { const r = await db().execute({ sql: `SELECT * FROM rf_patients WHERE id=? LIMIT 1`, args: [m[1]] }); if (!r.rows[0]) return json({ error: "Patient not found" }, 404); return json({ patient: r.rows[0] }); }
  if (m && (event.httpMethod === "PATCH" || event.httpMethod === "PUT")) {
    const b = parseBody(event); const map: Record<string,string> = { firstName:"first_name", lastName:"last_name", middleName:"middle_name", phone:"phone", birthDate:"birth_date", sex:"sex", diagnosis:"diagnosis", room:"room", bed:"bed", status:"status", notes:"notes" }; const sets: string[] = [], args: any[] = [];
    for (const [k,col] of Object.entries(map)) if (b[k] !== undefined) { sets.push(`${col}=?`); args.push(b[k]); }
    sets.push("updated_at=?"); args.push(now(), m[1]); await db().execute({ sql: `UPDATE rf_patients SET ${sets.join(",")} WHERE id=?`, args }); await audit(user, "update", "patient", m[1], b); return json({ ok: true });
  }
  if (m && event.httpMethod === "DELETE") { await db().execute({ sql: `DELETE FROM rf_patients WHERE id=?`, args: [m[1]] }); await audit(user, "delete", "patient", m[1]); return json({ ok: true }); }
  return json({ error: "API endpoint not found" }, 404);
}

async function tasksApi(path: string, event: HandlerEvent, user: any) {
  if (!can(user, "tasks")) throw forbidden();
  if (path === "/tasks" && event.httpMethod === "GET") {
    const status = query(event, "status"); const priority = query(event, "priority");
    const r = await db().execute({ sql: `SELECT t.*, p.first_name||' '||p.last_name patient_name, u.name assignee_name FROM rf_tasks t LEFT JOIN rf_patients p ON p.id=t.patient_id LEFT JOIN users u ON u.id=t.assigned_to WHERE (?='' OR t.status=?) AND (?='' OR t.priority=?) ORDER BY CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END, t.created_at DESC`, args: [status,status,priority,priority] });
    return json({ tasks: r.rows, items: r.rows });
  }
  if (path === "/tasks" && event.httpMethod === "POST") {
    const b = parseBody(event); if (!b.title) return json({ error: "title is required" }, 400); const newId=id("task");
    await db().execute({ sql:`INSERT INTO rf_tasks(id,title,description,patient_id,assigned_to,priority,status,due_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)`, args:[newId,b.title,b.description??null,b.patientId??null,b.assignedTo??null,b.priority??"normal",b.status??"pending",b.dueAt??null,user.id] });
    await audit(user,"create","task",newId,b); return json({ task:{id:newId,...b,status:b.status??"pending"} },201);
  }
  const m=path.match(/^\/tasks\/([^/]+)$/);
  if(m && (event.httpMethod==="PATCH"||event.httpMethod==="PUT")){const b=parseBody(event);const map:Record<string,string>={title:"title",description:"description",patientId:"patient_id",assignedTo:"assigned_to",priority:"priority",status:"status",dueAt:"due_at"};const sets:string[]=[],args:any[]=[];for(const[k,col]of Object.entries(map))if(b[k]!==undefined){sets.push(`${col}=?`);args.push(b[k]);}sets.push("updated_at=?");args.push(now(),m[1]);await db().execute({sql:`UPDATE rf_tasks SET ${sets.join(",")} WHERE id=?`,args});await audit(user,"update","task",m[1],b);return json({ok:true});}
  if(m&&event.httpMethod==="DELETE"){await db().execute({sql:`DELETE FROM rf_tasks WHERE id=?`,args:[m[1]]});await audit(user,"delete","task",m[1]);return json({ok:true});}
  return json({error:"API endpoint not found"},404);
}

async function bedsApi(path:string,event:HandlerEvent,user:any){if(!can(user,"beds"))throw forbidden();if(path==="/beds"&&event.httpMethod==="GET"){const r=await db().execute(`SELECT b.*,p.first_name||' '||p.last_name patient_name FROM rf_beds b LEFT JOIN rf_patients p ON p.id=b.patient_id ORDER BY b.room,b.bed_number`);return json({beds:r.rows});}const m=path.match(/^\/beds\/([^/]+)$/);if(m&&(event.httpMethod==="PATCH"||event.httpMethod==="PUT")){const b=parseBody(event);await db().execute({sql:`UPDATE rf_beds SET status=?,patient_id=?,updated_at=? WHERE id=?`,args:[b.status??"available",b.patientId??null,now(),m[1]]});await audit(user,"update","bed",m[1],b);return json({ok:true});}return json({error:"API endpoint not found"},404);}

async function appointmentsApi(path:string,event:HandlerEvent,user:any){if(!can(user,"schedule"))throw forbidden();if(path==="/appointments"&&event.httpMethod==="GET"){const from=query(event,"from");const to=query(event,"to");const r=await db().execute({sql:`SELECT a.*,p.first_name||' '||p.last_name patient_name,u.name doctor_name FROM rf_appointments a LEFT JOIN rf_patients p ON p.id=a.patient_id LEFT JOIN users u ON u.id=a.doctor_id WHERE (?='' OR a.starts_at>=?) AND (?='' OR a.starts_at<=?) ORDER BY a.starts_at`,args:[from,from,to,to]});return json({appointments:r.rows});}if(path==="/appointments"&&event.httpMethod==="POST"){const b=parseBody(event);if(!b.startsAt)return json({error:"startsAt is required"},400);const newId=id("apt");await db().execute({sql:`INSERT INTO rf_appointments(id,patient_id,doctor_id,starts_at,duration_minutes,type,status,notes) VALUES(?,?,?,?,?,?,?,?)`,args:[newId,b.patientId??null,b.doctorId??user.id,b.startsAt,b.durationMinutes??30,b.type??"consultation",b.status??"scheduled",b.notes??null]});await audit(user,"create","appointment",newId,b);return json({appointment:{id:newId,...b}},201);}const m=path.match(/^\/appointments\/([^/]+)$/);if(m&&(event.httpMethod==="PATCH"||event.httpMethod==="PUT")){const b=parseBody(event);await db().execute({sql:`UPDATE rf_appointments SET patient_id=?,doctor_id=?,starts_at=?,duration_minutes=?,type=?,status=?,notes=? WHERE id=?`,args:[b.patientId??null,b.doctorId??user.id,b.startsAt,b.durationMinutes??30,b.type??"consultation",b.status??"scheduled",b.notes??null,m[1]]});return json({ok:true});}if(m&&event.httpMethod==="DELETE"){await db().execute({sql:`DELETE FROM rf_appointments WHERE id=?`,args:[m[1]]});return json({ok:true});}return json({error:"API endpoint not found"},404);}

async function documentsApi(path:string,event:HandlerEvent,user:any){if(!can(user,"documents"))throw forbidden();if(path==="/documents"&&event.httpMethod==="GET"){const patientId=query(event,"patientId");const r=await db().execute({sql:`SELECT d.*,p.first_name||' '||p.last_name patient_name,u.name created_by_name FROM rf_documents d LEFT JOIN rf_patients p ON p.id=d.patient_id LEFT JOIN users u ON u.id=d.created_by WHERE (?='' OR d.patient_id=?) ORDER BY d.created_at DESC`,args:[patientId,patientId]});return json({documents:r.rows});}if(path==="/documents"&&event.httpMethod==="POST"){const b=parseBody(event);if(!b.title)return json({error:"title is required"},400);const newId=id("doc");await db().execute({sql:`INSERT INTO rf_documents(id,patient_id,title,category,file_name,file_url,created_by) VALUES(?,?,?,?,?,?,?)`,args:[newId,b.patientId??null,b.title,b.category??"other",b.fileName??null,b.fileUrl??null,user.id]});return json({document:{id:newId,...b}},201);}return json({error:"API endpoint not found"},404);}

async function analyticsApi(path:string,event:HandlerEvent,user:any){if(!can(user,"analytics"))throw forbidden();if(path==="/dashboard"||path==="/analytics"){const [p,t,b,a,s]=await Promise.all([db().execute(`SELECT COUNT(*) count FROM rf_patients WHERE status='active'`),db().execute(`SELECT COUNT(*) count FROM rf_tasks WHERE status NOT IN ('done','completed')`),db().execute(`SELECT COUNT(*) count FROM rf_beds WHERE status='occupied'`),db().execute(`SELECT COUNT(*) count FROM rf_beds WHERE status='available'`),db().execute(`SELECT COUNT(*) count FROM users WHERE active=1`)]);return json({stats:{patients:Number(p.rows[0]?.count||0),openTasks:Number(t.rows[0]?.count||0),occupiedBeds:Number(b.rows[0]?.count||0),availableBeds:Number(a.rows[0]?.count||0),staffOnline:Number(s.rows[0]?.count||0)},generatedAt:now()});}return json({error:"API endpoint not found"},404);}

export const handler: Handler = async (event) => {
  try {
    await ensureSchema();
    const path = event.path.replace(/^\/.netlify\/functions\/api/, "").replace(/^\/api\/baas/, "").replace(/^\/api/, "") || "/";
    if (event.httpMethod === "OPTIONS") return json({ ok:true });
    if (path.startsWith("/auth/")) return await auth(path.slice(5), event);
    const user = await requireUser(event);
    if (path === "/health" && event.httpMethod === "GET") return json({ ok:true, service:"rehaflow-api", time:now() });
    if (path === "/" && event.httpMethod === "GET") return json({ ok:true, service:"rehaflow-api" });
    if (path.startsWith("/users") || path === "/roles") return await usersApi(path,event,user);
    if (path.startsWith("/patients")) return await patientsApi(path,event,user);
    if (path.startsWith("/tasks")) return await tasksApi(path,event,user);
    if (path.startsWith("/beds")) return await bedsApi(path,event,user);
    if (path.startsWith("/appointments")) return await appointmentsApi(path,event,user);
    if (path.startsWith("/documents")) return await documentsApi(path,event,user);
    if (path === "/dashboard" || path === "/analytics" || path === "/analytics/summary") return await analyticsApi(path,event,user);
    if (path === "/permissions" && event.httpMethod === "GET") return json({ role:user.role, permissions:ROLE_PERMISSIONS[user.role]||[] });
    if (path === "/audit" && event.httpMethod === "GET") { if (!can(user,"staff")) throw forbidden(); const r=await db().execute(`SELECT a.*,u.name user_name FROM rf_audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 300`); return json({audit:r.rows}); }
    return json({ error:"API endpoint not found", path },404);
  } catch (error:any) {
    console.error(error);
    return json({ error:error?.message || String(error) }, error?.status || 500);
  }
};
