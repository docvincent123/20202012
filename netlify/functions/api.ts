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
  const DEFAULT_TURSO_DATABASE_URL = "libsql://rehaflow-echomedtechnologies.aws-ap-south-1.turso.io";
  const rawUrl = process.env.TURSO_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || DEFAULT_TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN?.trim() || "";
  if (!token) throw new Error("TURSO_AUTH_TOKEN is not configured in Netlify.");
  let base = String(rawUrl).replace(/^\"|\"$/g, "").split("?")[0].replace(/\/+$/, "");
  if (base.startsWith("libsql://")) base = base.replace(/^libsql:\/\//, "https://");
  if (!base.startsWith("https://")) throw new Error("Invalid TURSO_DATABASE_URL. Expected libsql://<database>.turso.io");
  return { endpoint: `${base}/v2/pipeline`, token };
}

class TursoHttpClient {
  private endpoint: string;
  private token: string;
  constructor() {
    const c = getTursoHttpConfig();
    this.endpoint = c.endpoint;
    this.token = c.token;
  }
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
        if (val && typeof val === "object" && "value" in val) obj[name] = val.value;
        else if (val && typeof val === "object" && "base64" in val) obj[name] = Buffer.from(val.base64, "base64");
        else obj[name] = val;
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

function json(body: any, status = 200) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client, X-Device-Id, X-Device-Name, X-Device-Platform, X-App-Version", "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS" }, body: JSON.stringify(body) };
}
function parseBody(event: HandlerEvent): any { try { return event.body ? JSON.parse(event.body) : {}; } catch { return {}; } }
function bearer(event: HandlerEvent) { const h = event.headers?.authorization || event.headers?.Authorization || ""; return h.startsWith("Bearer ") ? h.slice(7) : ""; }
function hashToken(input: string) { return crypto.createHash("sha256").update(input).digest("hex"); }
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString("hex"); }

async function ensureSchema() {
  if (initialized) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const c = db();
    await c.execute(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, name TEXT, password_hash TEXT, role TEXT DEFAULT 'doctor', active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    await c.execute(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT, access_token TEXT, refresh_token TEXT, expires_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    await c.execute(`CREATE TABLE IF NOT EXISTS login_history (id TEXT PRIMARY KEY, user_id TEXT, identifier TEXT, success INTEGER, ip TEXT, user_agent TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);

    // Bootstrap one administrator only when the database has no users yet.
    const countResult = await c.execute(`SELECT COUNT(*) AS count FROM users`);
    const userCount = Number(countResult.rows[0]?.count ?? 0);
    if (userCount === 0) {
      const defaultEmail = process.env.DEFAULT_ADMIN_EMAIL?.trim() || "mishaborkovskijwork@gmail.com";
      const defaultPassword = process.env.DEFAULT_ADMIN_PASSWORD || "12345678";
      const defaultName = process.env.DEFAULT_ADMIN_NAME?.trim() || "System Administrator";
      const passwordHash = await bcrypt.hash(defaultPassword, 10);
      await c.execute({
        sql: `INSERT INTO users(id,email,name,password_hash,role,active) VALUES(?,?,?,?,?,1)`,
        args: ["admin-default", defaultEmail, defaultName, passwordHash, "admin"],
      });
      console.log(`Bootstrapped initial administrator: ${defaultEmail}`);
    }

    initialized = true;
  })().catch(err => { initPromise = null; throw err; });
  return initPromise;
}

async function auth(path: string, event: HandlerEvent) {
  await ensureSchema();
  if (event.httpMethod === "OPTIONS") return json({ ok: true });
  if (path === "/login" && event.httpMethod === "POST") {
    const body = parseBody(event);
    const identifier = String(body.email ?? body.login ?? body.username ?? body.identifier ?? "").trim();
    const password = String(body.password ?? "");
    if (!identifier || !password) return json({ error: "Email/login and password are required" }, 400);
    const c = db();
    const r = await c.execute({ sql: `SELECT id,email,name,password_hash,role,active FROM users WHERE lower(email)=lower(?) OR lower(name)=lower(?) LIMIT 1`, args: [identifier, identifier] });
    const user: any = r.rows[0];
    let ok = false;
    if (user) ok = user.password_hash?.startsWith("$2") ? await bcrypt.compare(password, String(user.password_hash)) : String(user.password_hash) === password;
    await c.execute({ sql: `INSERT INTO login_history(id,user_id,identifier,success,ip,user_agent) VALUES(?,?,?,?,?,?)`, args: [randomToken(12), user?.id ?? null, identifier, ok ? 1 : 0, event.headers?.["x-forwarded-for"] ?? null, event.headers?.["user-agent"] ?? null] });
    if (!user || !ok || String(user.active ?? 1) === "0") return json({ error: "Invalid credentials" }, 401);
    const accessToken = randomToken(32), refreshToken = randomToken(32), sessionId = randomToken(16);
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 12).toISOString();
    await c.execute({ sql: `INSERT INTO sessions(id,user_id,access_token,refresh_token,expires_at) VALUES(?,?,?,?,?)`, args: [sessionId, user.id, hashToken(accessToken), hashToken(refreshToken), expiresAt] });
    const safeUser = { id: user.id, email: user.email, name: user.name, role: user.role, active: Number(user.active ?? 1) };
    return json({ accessToken, refreshToken, token: accessToken, session: { id: sessionId, expiresAt }, user: safeUser });
  }
  if (path === "/logout" && event.httpMethod === "POST") {
    const t = bearer(event); if (t) await db().execute({ sql: `DELETE FROM sessions WHERE access_token=?`, args: [hashToken(t)] });
    return json({ ok: true });
  }
  if (path === "/session" && event.httpMethod === "GET") {
    const t = bearer(event); if (!t) return json({ error: "Unauthorized" }, 401);
    const r = await db().execute({ sql: `SELECT s.id,s.expires_at,u.id user_id,u.email,u.name,u.role,u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.access_token=? LIMIT 1`, args: [hashToken(t)] });
    const row: any = r.rows[0]; if (!row) return json({ error: "Unauthorized" }, 401);
    return json({ authenticated: true, session: { id: row.id, expiresAt: row.expires_at }, user: { id: row.user_id, email: row.email, name: row.name, role: row.role, active: Number(row.active ?? 1) } });
  }
  return json({ error: "API endpoint not found" }, 404);
}

export const handler: Handler = async (event) => {
  try {
    const path = event.path.replace(/^\/.netlify\/functions\/api/, "").replace(/^\/api\/baas/, "").replace(/^\/api/, "") || "/";
    if (event.httpMethod === "OPTIONS") return json({ ok: true });
    if (path.startsWith("/auth/")) return await auth(path.slice(5), event);
    if (path === "/health" && event.httpMethod === "GET") return json({ ok: true, service: "rehaflow-api" });
    if (path === "/" && event.httpMethod === "GET") return json({ ok: true, service: "rehaflow-api" });
    return json({ error: "API endpoint not found", path }, 404);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
};
