import type { Handler, HandlerEvent } from '@netlify/functions';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

type V = string | number | boolean | null;
const DEFAULT_DB = 'libsql://rehaflow-echomedtechnologies.aws-ap-south-1.turso.io';
const now = () => new Date().toISOString();
const uid = (p: string) => `${p}_${crypto.randomBytes(8).toString('hex')}`;
const secret = () => crypto.randomBytes(32).toString('hex');
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const json = (body: any, statusCode = 200) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Device-Id,X-Device-Name,X-Device-Platform,X-App-Version', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' }, body: JSON.stringify(body) });
const body = (e: HandlerEvent) => { try { return e.body ? JSON.parse(e.body) : {}; } catch { return {}; } };
const q = (e: HandlerEvent, k: string, d = '') => e.queryStringParameters?.[k] ?? d;
const bearer = (e: HandlerEvent) => { const h = e.headers?.authorization || e.headers?.Authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : ''; };
const arg = (v: V) => v == null ? { type: 'null' } : typeof v === 'boolean' ? { type: 'integer', value: v ? '1' : '0' } : typeof v === 'number' ? (Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: String(v) }) : { type: 'text', value: String(v) };
const err = (message: string, status = 400) => Object.assign(new Error(message), { status });

class Turso {
  url: string;
  token: string;
  constructor() {
    let base = (process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || DEFAULT_DB).trim().split('?')[0].replace(/\/+$/, '');
    if (base.startsWith('libsql://')) base = base.replace('libsql://', 'https://');
    this.url = `${base}/v2/pipeline`;
    this.token = (process.env.TURSO_AUTH_TOKEN || '').trim();
    if (!this.token) throw new Error('TURSO_AUTH_TOKEN is not configured');
  }
  async run(sql: string, values: V[] = []) {
    const r = await fetch(this.url, { method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, ...(values.length ? { args: values.map(arg) } : {}) } }, { type: 'close' }] }) });
    const p: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Turso HTTP ${r.status}: ${p?.error?.message || r.statusText}`);
    for (const z of p.results || []) if (z?.type === 'error') throw new Error(`Turso SQL error: ${z.error?.message || z.error}`);
    const result: any = (p.results || []).find((x: any) => x?.response?.type === 'execute')?.response?.result || {};
    const cols = result.cols || result.columns || [];
    const rows = (result.rows || []).map((rr: any[]) => { const o: any = {}; cols.forEach((c: any, i: number) => { const n = typeof c === 'string' ? c : c.name; const v = rr[i]; o[n] = v && typeof v === 'object' && 'value' in v ? v.value : v && typeof v === 'object' && 'base64' in v ? Buffer.from(v.base64, 'base64') : v; }); return o; });
    return { rows, affected: Number(result.affected_row_count || 0) };
  }
}
let dbi: Turso | null = null;
const db = () => dbi || (dbi = new Turso());
let initPromise: Promise<void> | null = null;

async function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const ddl = [
      `CREATE TABLE IF NOT EXISTS Session(id TEXT PRIMARY KEY,userId TEXT NOT NULL,tokenHash TEXT UNIQUE NOT NULL,expiresAt TEXT NOT NULL,createdAt TEXT NOT NULL,deviceId TEXT,deviceName TEXT,devicePlatform TEXT,deviceModel TEXT,appVersion TEXT,ip TEXT,userAgent TEXT,lastSeenAt TEXT)`,
      `CREATE TABLE IF NOT EXISTS FailedLogin(id TEXT PRIMARY KEY,email TEXT,ip TEXT,userAgent TEXT,createdAt TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS SecurityAlert(id TEXT PRIMARY KEY,type TEXT NOT NULL,severity TEXT DEFAULT 'warning',title TEXT NOT NULL,message TEXT NOT NULL,email TEXT,ip TEXT,userId TEXT,readAt TEXT,createdAt TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS Appointment(id TEXT PRIMARY KEY,patientId TEXT NOT NULL,cabinetId TEXT NOT NULL,doctorId TEXT,startAt TEXT NOT NULL,endAt TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled',notes TEXT,createdById TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS TreatmentRecord(id TEXT PRIMARY KEY,patientId TEXT NOT NULL,recordDate TEXT NOT NULL,type TEXT NOT NULL DEFAULT 'procedure',title TEXT NOT NULL,description TEXT,authorId TEXT,createdAt TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS PatientTask(id TEXT PRIMARY KEY,patientId TEXT NOT NULL,assignedToId TEXT,title TEXT NOT NULL,description TEXT,priority TEXT NOT NULL DEFAULT 'normal',dueAt TEXT,status TEXT NOT NULL DEFAULT 'pending',createdById TEXT NOT NULL,completedById TEXT,completedAt TEXT,createdAt TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS PatientFile(id TEXT PRIMARY KEY,patientId TEXT NOT NULL,fileName TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'document',storagePath TEXT NOT NULL,category TEXT NOT NULL,publicUrl TEXT,mimeType TEXT,uploadedById TEXT,createdAt TEXT NOT NULL,dataBase64 TEXT)`,
      `CREATE TABLE IF NOT EXISTS ScheduleEvent(id TEXT PRIMARY KEY,patientId TEXT NOT NULL,doctorId TEXT,roomId TEXT,title TEXT NOT NULL,startAt TEXT NOT NULL,endAt TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled',notes TEXT,createdById TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS AuditLog(id TEXT PRIMARY KEY,userId TEXT,userName TEXT,userRole TEXT,action TEXT NOT NULL,entityType TEXT,entityId TEXT,details TEXT,ip TEXT,userAgent TEXT,createdAt TEXT NOT NULL)`
    ];
    for (const s of ddl) await db().run(s);
  })().catch(e => { initPromise = null; throw e; });
  return initPromise;
}

function splitName(full = '') {
  const p = String(full).trim().split(/\s+/).filter(Boolean);
  if (!p.length) return { firstName: '', lastName: '' };
  if (p.length === 1) return { firstName: p[0], lastName: '' };
  return { lastName: p[0], firstName: p[1], middleName: p.slice(2).join(' ') || null };
}
function patientOut(p: any, extra: any = {}) {
  const n = splitName(p.fullName);
  return { ...p, id: p.id, fullName: p.fullName, last_name: n.lastName, first_name: n.firstName, middle_name: n.middleName || null, birth_date: p.birthDate ?? null, sex: p.gender ?? null, phone: p.phone ?? null, address: p.address ?? null, diagnosis: p.diagnosis ?? null, admission_date: p.admissionDate ?? null, discharged_at: p.dischargeDate ?? null, status: p.status, notes: p.notes ?? null, allergies: p.allergies ?? null, contraindications: p.contraindications ?? null, anamnesis: p.anamnesis ?? null, rehabGoals: p.rehabGoals ?? null, functionalAssessment: p.functionalAssessment ?? null, emergencyContact: p.emergencyContact ?? null, dischargeSummary: p.dischargeSummary ?? null, room_id: p.roomId ?? null, bed_id: p.bedId ?? null, attending_doctor_id: p.doctorId ?? null, ...extra };
}
function userOut(u: any) { return { id: u.id, email: u.email, name: u.name, role: u.role, active: Number(u.active ?? 1), emailVerified: Number(u.emailVerified ?? 1), twoFactorEnabled: Number(u.twoFactorEnabled ?? 0), lastLoginAt: u.lastLoginAt ?? null, createdAt: u.createdAt ?? null }; }
function effectiveRole(role: string) { return role === 'reception' ? 'registrar' : role; }
async function current(e: HandlerEvent) {
  const t = bearer(e); if (!t) return null;
  const r = await db().run(`SELECT u.id,u.email,u.name,u.role,u.active,u.emailVerified,u.twoFactorEnabled,s.id sessionId,s.expiresAt FROM Session s JOIN User u ON u.id=s.userId WHERE s.tokenHash=? LIMIT 1`, [sha(t)]);
  const u: any = r.rows[0];
  if (!u || Number(u.active) !== 1 || new Date(u.expiresAt).getTime() < Date.now()) return null;
  await db().run('UPDATE Session SET lastSeenAt=? WHERE id=?', [now(), u.sessionId]);
  return u;
}
async function audit(u: any, action: string, entityType: string, entityId: string | null, details: any = {}, e?: HandlerEvent) {
  try { await db().run('INSERT INTO AuditLog(id,userId,userName,userRole,action,entityType,entityId,details,ip,userAgent,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [uid('audit'), u?.id || null, u?.name || null, u?.role || null, action, entityType, entityId, JSON.stringify(details), e?.headers?.['x-forwarded-for'] || null, e?.headers?.['user-agent'] || null, now()]); } catch {}
}

async function auth(path: string, e: HandlerEvent) {
  if (path === '/login' && e.httpMethod === 'POST') {
    const b = body(e), ident = String(b.email || b.login || b.username || b.identifier || '').trim(), pass = String(b.password || '');
    if (!ident || !pass) return json({ error: 'Email/login and password are required' }, 400);
    const r = await db().run('SELECT * FROM User WHERE lower(email)=lower(?) OR lower(name)=lower(?) LIMIT 1', [ident, ident]);
    const u: any = r.rows[0];
    let ok = false;
    if (u && !u.lockedUntil || (u && (!u.lockedUntil || new Date(u.lockedUntil).getTime() < Date.now()))) { const ph = String(u?.password || ''); ok = ph.startsWith('$2') ? await bcrypt.compare(pass, ph) : false; }
    if (!ok) { await db().run('INSERT INTO FailedLogin(id,email,ip,userAgent,createdAt) VALUES(?,?,?,?,?)', [uid('fail'), ident, e.headers?.['x-forwarded-for'] || null, e.headers?.['user-agent'] || null, now()]); }
    if (!u || !ok || Number(u.active) !== 1) return json({ error: 'Invalid credentials' }, 401);
    const at = secret(), sid = uid('sess'), exp = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    await db().run('INSERT INTO Session(id,userId,tokenHash,expiresAt,createdAt,deviceId,deviceName,devicePlatform,deviceModel,appVersion,ip,userAgent,lastSeenAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', [sid, u.id, sha(at), exp, now(), b.deviceId || 'windows-desktop', b.deviceName || 'RehaFlow Windows', b.platform || 'windows', b.deviceModel || '', b.appVersion || '', e.headers?.['x-forwarded-for'] || null, e.headers?.['user-agent'] || null, now()]);
    await db().run('UPDATE User SET lastLoginAt=?,lastLoginIp=?,failedLoginCount=0,lockedUntil=NULL WHERE id=?', [now(), e.headers?.['x-forwarded-for'] || null, u.id]);
    return json({ accessToken: at, refreshToken: at, token: at, user: userOut(u), session: { id: sid, expiresAt: exp } });
  }
  if (path === '/logout' && e.httpMethod === 'POST') { const t = bearer(e); if (t) await db().run('DELETE FROM Session WHERE tokenHash=?', [sha(t)]); return json({ ok: true }); }
  if ((path === '/me' || path === '/session') && e.httpMethod === 'GET') { const u = await current(e); if (!u) return json({ error: 'Unauthorized' }, 401); return json({ authenticated: true, user: userOut(u) }); }
  return null;
}

async function patients(path: string, e: HandlerEvent, u: any) {
  if (path === '/patients' && e.httpMethod === 'GET') {
    const status = q(e, 'status', 'active'), term = q(e, 'q', ''), like = `%${term}%`;
    const rows = (await db().run(`SELECT p.*,u.name attendingUserName,r.number roomNumber,r.building roomBuilding,b.label bedLabel,b.code bedCode FROM Patient p LEFT JOIN User u ON u.id=p.doctorId LEFT JOIN Room r ON r.id=p.roomId LEFT JOIN Bed b ON b.id=p.bedId WHERE p.status=? AND (?='' OR lower(p.fullName||' '||COALESCE(p.phone,'')||' '||COALESCE(p.diagnosis,'')) LIKE lower(?)) ORDER BY p.createdAt DESC`, [status, term, like])).rows;
    return json({ patients: rows.map((p: any) => patientOut(p, { attending_doctor_name: p.attendingUserName || null, room_name: p.roomNumber ? `Палата ${p.roomNumber}` : null, room_building: p.roomBuilding || null, bed_number: p.bedLabel || null, bed_code: p.bedCode || null })), items: rows, total: rows.length });
  }
  if (path.startsWith('/patients/') && e.httpMethod === 'GET') { const id = path.split('/')[2]; const r = await db().run('SELECT * FROM Patient WHERE id=? LIMIT 1', [id]); if (!r.rows[0]) return json({ error: 'Patient not found' }, 404); return json({ patient: patientOut(r.rows[0]) }); }
  if (path === '/patients' && e.httpMethod === 'POST') {
    const b = body(e); const fullName = String(b.fullName || [b.lastName, b.firstName, b.middleName].filter(Boolean).join(' ')).trim(); if (!fullName) return json({ error: 'Name is required' }, 400); const id = uid('patient'), at = now();
    await db().run(`INSERT INTO Patient(id,fullName,birthDate,gender,phone,address,diagnosis,admissionDate,status,notes,roomId,doctorId,createdById,createdAt,updatedAt,bedId,allergies,contraindications,anamnesis,rehabGoals,functionalAssessment,emergencyContact,dischargeSummary) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, fullName, b.birthDate || b.birth_date || null, b.gender || b.sex || null, b.phone || null, b.address || null, b.diagnosis || null, b.admissionDate || at, 'active', b.notes || null, b.roomId || b.room_id || null, b.doctorId || b.attendingDoctorId || null, u.id, at, at, b.bedId || b.bed_id || null, b.allergies || null, b.contraindications || null, b.anamnesis || null, b.rehabGoals || b.rehab_goals || null, b.functionalAssessment || b.functional_assessment || null, b.emergencyContact || b.emergency_contact || null, b.dischargeSummary || null]);
    await audit(u, 'create', 'Patient', id, { fullName }, e); return json({ patient: { id, fullName }, ok: true }, 201);
  }
  if (path.startsWith('/patients/') && ['PUT','PATCH'].includes(e.httpMethod || '')) {
    const id = path.split('/')[2], b = body(e); const cols: string[] = [], vals: V[] = [];
    const map: Record<string,string> = { fullName:'fullName', firstName:'fullName', birthDate:'birthDate', birth_date:'birthDate', gender:'gender', sex:'gender', phone:'phone', address:'address', diagnosis:'diagnosis', notes:'notes', roomId:'roomId', room_id:'roomId', doctorId:'doctorId', attendingDoctorId:'doctorId', bedId:'bedId', bed_id:'bedId', allergies:'allergies', contraindications:'contraindications', anamnesis:'anamnesis', rehabGoals:'rehabGoals', functionalAssessment:'functionalAssessment', emergencyContact:'emergencyContact', dischargeSummary:'dischargeSummary' };
    for (const [k,c] of Object.entries(map)) if (b[k] !== undefined && !cols.includes(c)) { let v = b[k]; if (c==='fullName' && b.firstName) v = [b.lastName,b.firstName,b.middleName].filter(Boolean).join(' '); cols.push(c); vals.push(v ?? null); }
    if (!cols.length) return json({ error: 'No changes' }, 400);
    cols.push('updatedAt'); vals.push(now()); vals.push(id); await db().run(`UPDATE Patient SET ${cols.map(c=>`${c}=?`).join(',')} WHERE id=?`, vals); await audit(u, 'update', 'Patient', id, { fields: cols }, e); return json({ ok:true });
  }
  if (path.startsWith('/patients/') && e.httpMethod === 'DELETE') { const id=path.split('/')[2]; await dischargePatient(id,u,e); return json({ok:true}); }
  return null;
}
async function dischargePatient(id:string,u:any,e:HandlerEvent){ const r=await db().run('SELECT bedId FROM Patient WHERE id=? LIMIT 1',[id]); const bedId=r.rows[0]?.bedId||null; await db().run('UPDATE Patient SET status=?,dischargeDate=?,updatedAt=? WHERE id=?',['discharged',now(),now(),id]); if(bedId) await db().run('UPDATE Bed SET status=\'available\' WHERE id=?',[bedId]); await audit(u,'discharge','Patient',id,{},e); }

async function archive(path:string,e:HandlerEvent,u:any){
  if(path==='/archive'&&e.httpMethod==='GET'){const term=q(e,'q','');const rows=(await db().run(`SELECT p.*,u.name attendingUserName FROM Patient p LEFT JOIN User u ON u.id=p.doctorId WHERE p.status='discharged' AND (?='' OR lower(p.fullName||' '||COALESCE(p.phone,'')) LIKE lower(?)) ORDER BY p.dischargeDate DESC,p.updatedAt DESC`,[term,`%${term}%`])).rows;return json({patients:rows.map((p:any)=>patientOut(p,{attending_doctor_name:p.attendingUserName||null})),total:rows.length});}
  if(path==='/patient-history'&&e.httpMethod==='GET'){const r=await db().run(`SELECT bh.*,b.code bed_code,b.label bed_label,p.fullName patient_name FROM bed_history bh LEFT JOIN Bed b ON b.id=bh.bed_id LEFT JOIN Patient p ON p.id=bh.patient_id ORDER BY bh.started_at DESC LIMIT 500`);return json({history:r.rows});}
  return null;
}

async function roomsBeds(path:string,e:HandlerEvent,u:any){
  if(path==='/rooms'&&e.httpMethod==='GET'){const rows=(await db().run('SELECT * FROM Room ORDER BY number')).rows;return json({rooms:rows.map((r:any)=>({...r,name:`Палата ${r.number}`,department:r.building||'Реабілітація',active:1}))});}
  if(path==='/rooms'&&e.httpMethod==='POST'){const b=body(e),id=uid('room'),num=String(b.number||b.name||'').replace(/[^0-9A-Za-zА-Яа-яІіЇїЄє_-]/g,'');if(!num)return json({error:'Room number is required'},400);const at=now();await db().run('INSERT INTO Room(id,number,building,capacity,createdAt) VALUES(?,?,?,?,?)',[id,num,b.building||'Реабілітація',Number(b.capacity||2),at]);await audit(u,'create','Room',id,b,e);return json({ok:true,id},201);}
  if(path==='/beds'&&e.httpMethod==='GET'){const rows=(await db().run(`SELECT b.*,r.number roomNumber,r.building roomBuilding,p.fullName patientName FROM Bed b LEFT JOIN Room r ON r.id=b.roomId LEFT JOIN Patient p ON p.bedId=b.id AND p.status='active' ORDER BY r.number,b.label,b.code`)).rows;return json({beds:rows.map((b:any)=>({...b,room_id:b.roomId,number:b.label,patient_id:b.patientName?b.patientId:null,room_name:b.roomNumber?`Палата ${b.roomNumber}`:null,room_building:b.roomBuilding||null,patient_name:b.patientName||null}))});}
  if(path==='/beds'&&e.httpMethod==='POST'){const b=body(e),id=uid('bed'),at=now(),label=String(b.label||b.number||'A'),code=String(b.code||`BED-${crypto.randomBytes(6).toString('hex').toUpperCase()}`);await db().run('INSERT INTO Bed(id,roomId,code,label,createdAt,status) VALUES(?,?,?,?,?,?)',[id,b.roomId||b.room_id,code,label,at,b.status||'available']);await audit(u,'create','Bed',id,b,e);return json({ok:true,id},201);}
  if(path.startsWith('/beds/')&&e.httpMethod==='POST'){const parts=path.split('/');const id=parts[2],action=parts[3];if(action==='assign'){const b=body(e),pid=b.patientId||b.patient_id;if(!pid)return json({error:'patientId required'},400);const cur=await db().run('SELECT bedId FROM Patient WHERE id=?',[pid]);if(cur.rows[0]?.bedId)await db().run('UPDATE Bed SET status=\'available\' WHERE id=?',[cur.rows[0].bedId]);await db().run('UPDATE Patient SET bedId=?,roomId=(SELECT roomId FROM Bed WHERE id=?),updatedAt=? WHERE id=?',[id,id,now(),pid]);await db().run('UPDATE Bed SET status=\'occupied\' WHERE id=?',[id]);await audit(u,'assign','Bed',id,{patientId:pid},e);return json({ok:true});}if(action==='release'){const r=await db().run('SELECT id FROM Patient WHERE bedId=? AND status=\'active\'',[id]);for(const p of r.rows)await db().run('UPDATE Patient SET bedId=NULL,roomId=NULL,updatedAt=? WHERE id=?',[now(),p.id]);await db().run('UPDATE Bed SET status=\'available\' WHERE id=?',[id]);await audit(u,'release','Bed',id,{},e);return json({ok:true});}}
  return null;
}

async function tasks(path:string,e:HandlerEvent,u:any){
  if(path==='/tasks'&&e.httpMethod==='GET'){const rows=(await db().run('SELECT t.*,p.fullName patient_name,uu.name assignee_name FROM PatientTask t LEFT JOIN Patient p ON p.id=t.patientId LEFT JOIN User uu ON uu.id=t.assignedToId ORDER BY CASE t.priority WHEN \'critical\' THEN 1 WHEN \'high\' THEN 2 ELSE 3 END,t.createdAt DESC')).rows;return json({tasks:rows});}
  if(path==='/tasks'&&e.httpMethod==='POST'){const b=body(e),id=uid('task'),at=now();await db().run('INSERT INTO PatientTask(id,patientId,assignedToId,title,description,priority,dueAt,status,createdById,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?)',[id,b.patientId||b.patient_id||null,b.assignedToId||b.assigned_to||null,b.title,b.description||null,b.priority||'normal',b.dueAt||null,b.status||'pending',u.id,at]);await audit(u,'create','PatientTask',id,b,e);return json({ok:true,id},201);}
  if(path.startsWith('/tasks/')&&['PUT','PATCH'].includes(e.httpMethod||'')){const id=path.split('/')[2],b=body(e);await db().run('UPDATE PatientTask SET title=COALESCE(?,title),description=COALESCE(?,description),priority=COALESCE(?,priority),dueAt=COALESCE(?,dueAt),status=COALESCE(?,status),assignedToId=COALESCE(?,assignedToId) WHERE id=?',[b.title??null,b.description??null,b.priority??null,b.dueAt??null,b.status??null,b.assignedToId??b.assigned_to??null,id]);await audit(u,'update','PatientTask',id,b,e);return json({ok:true});}
  if(path.startsWith('/tasks/')&&e.httpMethod==='DELETE'){const id=path.split('/')[2];await db().run('DELETE FROM PatientTask WHERE id=?',[id]);await audit(u,'delete','PatientTask',id,{},e);return json({ok:true});}
  return null;
}

async function treatment(path:string,e:HandlerEvent,u:any){
  if(path==='/treatment-records'&&e.httpMethod==='GET'){const patientId=q(e,'patientId','');const rows=(await db().run(`SELECT tr.*,u.name author_name,p.fullName patient_name FROM TreatmentRecord tr LEFT JOIN User u ON u.id=tr.authorId LEFT JOIN Patient p ON p.id=tr.patientId WHERE (?='' OR tr.patientId=?) ORDER BY tr.recordDate DESC,tr.createdAt DESC`,[patientId,patientId])).rows;return json({records:rows});}
  if(path==='/treatment-records'&&e.httpMethod==='POST'){const b=body(e),id=uid('treat');await db().run('INSERT INTO TreatmentRecord(id,patientId,recordDate,type,title,description,authorId,createdAt) VALUES(?,?,?,?,?,?,?,?)',[id,b.patientId,b.recordDate||now(),b.type||'procedure',b.title,b.description||null,u.id,now()]);await audit(u,'create','TreatmentRecord',id,b,e);return json({ok:true,id},201);}
  if(path.startsWith('/treatment-records/')&&['PUT','PATCH'].includes(e.httpMethod||'')){const id=path.split('/')[2],b=body(e);await db().run('UPDATE TreatmentRecord SET recordDate=COALESCE(?,recordDate),type=COALESCE(?,type),title=COALESCE(?,title),description=COALESCE(?,description) WHERE id=?',[b.recordDate??null,b.type??null,b.title??null,b.description??null,id]);await audit(u,'update','TreatmentRecord',id,b,e);return json({ok:true});}
  return null;
}

async function appointments(path:string,e:HandlerEvent,u:any){
  if(path==='/appointments'&&e.httpMethod==='GET'){const rows=(await db().run(`SELECT a.*,p.fullName patient_name,du.name doctor_name,c.name cabinet_name FROM Appointment a LEFT JOIN Patient p ON p.id=a.patientId LEFT JOIN User du ON du.id=a.doctorId LEFT JOIN Cabinet c ON c.id=a.cabinetId ORDER BY a.startAt DESC`)).rows;return json({appointments:rows});}
  if(path==='/appointments'&&e.httpMethod==='POST'){const b=body(e),id=uid('appt'),at=now();await db().run('INSERT INTO Appointment(id,patientId,cabinetId,doctorId,startAt,endAt,status,notes,createdById,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[id,b.patientId,b.cabinetId,b.doctorId||null,b.startAt,b.endAt,b.status||'scheduled',b.notes||null,u.id,at,at]);await audit(u,'create','Appointment',id,b,e);return json({ok:true,id},201);}
  if(path.startsWith('/appointments/')&&['PUT','PATCH'].includes(e.httpMethod||'')){const id=path.split('/')[2],b=body(e);await db().run('UPDATE Appointment SET doctorId=COALESCE(?,doctorId),startAt=COALESCE(?,startAt),endAt=COALESCE(?,endAt),status=COALESCE(?,status),notes=COALESCE(?,notes),updatedAt=? WHERE id=?',[b.doctorId??null,b.startAt??null,b.endAt??null,b.status??null,b.notes??null,now(),id]);await audit(u,'update','Appointment',id,b,e);return json({ok:true});}
  return null;
}

async function documents(path:string,e:HandlerEvent,u:any){
  if(path==='/documents'&&e.httpMethod==='GET'){const patientId=q(e,'patientId','');const rows=(await db().run('SELECT * FROM PatientFile WHERE (?=\'\' OR patientId=?) ORDER BY createdAt DESC',[patientId,patientId])).rows;return json({documents:rows});}
  if(path==='/documents'&&e.httpMethod==='POST'){const b=body(e),id=uid('file');await db().run('INSERT INTO PatientFile(id,patientId,fileName,kind,storagePath,category,publicUrl,mimeType,uploadedById,createdAt,dataBase64) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[id,b.patientId,b.fileName||'document',b.kind||'document',b.storagePath||b.fileName||id,b.category||'other',b.publicUrl||b.fileUrl||null,b.mimeType||null,u.id,now(),b.dataBase64||null]);await audit(u,'upload','PatientFile',id,{patientId:b.patientId,fileName:b.fileName},e);return json({ok:true,id},201);}
  if(path.startsWith('/documents/')&&e.httpMethod==='DELETE'){const id=path.split('/')[2];await db().run('DELETE FROM PatientFile WHERE id=?',[id]);await audit(u,'delete','PatientFile',id,{},e);return json({ok:true});}
  return null;
}

async function prescriptions(path:string,e:HandlerEvent,u:any){
  if(path==='/prescriptions'&&e.httpMethod==='GET'){const patientId=q(e,'patientId','');const rows=(await db().run('SELECT p.*,u.name doctor_name,pt.fullName patient_name FROM prescriptions p LEFT JOIN User u ON u.id=p.doctor_id LEFT JOIN Patient pt ON pt.id=p.patient_id WHERE (?=\'\' OR p.patient_id=?) ORDER BY p.created_at DESC',[patientId,patientId])).rows;return json({prescriptions:rows});}
  if(path==='/prescriptions'&&e.httpMethod==='POST'){const b=body(e),id=uid('rx');await db().run('INSERT INTO prescriptions(id,patient_id,doctor_id,drug,dose,route,frequency,note,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',[id,b.patientId||b.patient_id,u.id,b.drug,b.dose||null,b.route||null,b.frequency||null,b.note||null,b.status||'active',now()]);await audit(u,'create','Prescription',id,b,e);return json({ok:true,id},201);}
  return null;
}

async function users(path:string,e:HandlerEvent,u:any){
  if(path==='/users'&&e.httpMethod==='GET'){const rows=(await db().run('SELECT id,email,name,role,emailVerified,active,lastLoginAt,createdAt,twoFactorEnabled FROM User ORDER BY name')).rows;return json({users:rows.map(userOut)});}
  if(path==='/users'&&e.httpMethod==='POST'){const b=body(e);if(!b.email||!b.name||!b.password)return json({error:'email, name and password are required'},400);const id=uid('user');await db().run('INSERT INTO User(id,email,password,name,role,emailVerified,createdAt,active,twoFactorEnabled,failedLoginCount) VALUES(?,?,?,?,?,?,?,?,?,0)',[id,b.email,await bcrypt.hash(String(b.password),12),b.name,b.role||'doctor',1,now(),1,0]);await audit(u,'create','User',id,{email:b.email,role:b.role||'doctor'},e);return json({ok:true,id},201);}
  if(path.startsWith('/users/')&&['PUT','PATCH'].includes(e.httpMethod||'')){const id=path.split('/')[2],b=body(e);if(b.password){await db().run('UPDATE User SET password=? WHERE id=?',[await bcrypt.hash(String(b.password),12),id]);}await db().run('UPDATE User SET name=COALESCE(?,name),email=COALESCE(?,email),role=COALESCE(?,role),active=COALESCE(?,active),twoFactorEnabled=COALESCE(?,twoFactorEnabled) WHERE id=?',[b.name??null,b.email??null,b.role??null,b.active===undefined?null:(b.active?1:0),b.twoFactorEnabled===undefined?null:(b.twoFactorEnabled?1:0),id]);await audit(u,'update','User',id,{fields:Object.keys(b).filter(k=>k!=='password')},e);return json({ok:true});}
  if(path.startsWith('/users/')&&e.httpMethod==='DELETE'){const id=path.split('/')[2];if(id===u.id)return json({error:'Cannot delete current user'},409);await db().run('UPDATE User SET active=0 WHERE id=?',[id]);await db().run('DELETE FROM Session WHERE userId=?',[id]);await audit(u,'deactivate','User',id,{},e);return json({ok:true});}
  if(path==='/sessions'&&e.httpMethod==='GET'){const rows=(await db().run(`SELECT s.*,u.name user_name,u.email FROM Session s LEFT JOIN User u ON u.id=s.userId ORDER BY s.lastSeenAt DESC`)).rows;return json({sessions:rows});}
  if(path.startsWith('/sessions/')&&e.httpMethod==='DELETE'){const id=path.split('/')[2];await db().run('DELETE FROM Session WHERE id=?',[id]);await audit(u,'revoke','Session',id,{},e);return json({ok:true});}
  if(path==='/doctors'&&e.httpMethod==='GET'){const rows=(await db().run(`SELECT u.id,u.name fullName,u.email,u.id userId,'' speciality FROM User u WHERE u.active=1 AND u.role IN ('doctor','admin') ORDER BY u.name`)).rows;return json({doctors:rows});}
  return null;
}

async function rolesEndpoint(path:string,e:HandlerEvent){ if(path==='/roles'&&e.httpMethod==='GET') return null; return null; }
async function dashboard(path:string,e:HandlerEvent){
  if(path!=='/dashboard'||e.httpMethod!=='GET')return null;
  const [p,b,t,s,a]=await Promise.all([
    db().run(`SELECT COUNT(*) c FROM Patient WHERE status='active'`),
    db().run(`SELECT COUNT(*) total,SUM(CASE WHEN status='occupied' THEN 1 ELSE 0 END) occupied,SUM(CASE WHEN status='cleaning' THEN 1 ELSE 0 END) cleaning FROM Bed`),
    db().run(`SELECT COUNT(*) c FROM PatientTask WHERE status NOT IN ('completed','cancelled')`),
    db().run(`SELECT COUNT(*) c FROM Session WHERE lastSeenAt IS NOT NULL AND datetime(lastSeenAt)>=datetime('now','-15 minutes') AND expiresAt>datetime('now')`),
    db().run(`SELECT COUNT(*) c FROM Patient WHERE status='discharged'`)
  ]);
  const br:any=b.rows[0]||{};const total=Number(br.total||0),occupied=Number(br.occupied||0),cleaning=Number(br.cleaning||0);return json({stats:{patients:Number(p.rows[0]?.c||0),occupiedBeds:occupied,totalBeds:total,availableBeds:Math.max(0,total-occupied-cleaning),cleaningBeds:cleaning,openTasks:Number(t.rows[0]?.c||0),staffOnline:Number(s.rows[0]?.c||0),archivedPatients:Number(a.rows[0]?.c||0)},rehabilitation:{treatmentToday:0,appointmentsToday:0}});
}

async function auditEndpoint(path:string,e:HandlerEvent,u:any){if(path==='/audit'&&e.httpMethod==='GET'){const rows=(await db().run('SELECT * FROM AuditLog ORDER BY createdAt DESC LIMIT 500')).rows;return json({audit:rows});}return null;}

export const handler: Handler = async (e) => {
  try {
    await init();
    const p = (e.path || '/').replace(/^\\/.netlify\\/functions\\/api6/,'') || '/';
    const a = await auth(p,e); if(a) return a;
    const u = await current(e); if(!u) return json({error:'Unauthorized'},401);
    if(e.httpMethod==='OPTIONS') return json({ok:true});
    let r:any = null;
    r = await dashboard(p,e) || await patients(p,e,u) || await archive(p,e,u) || await roomsBeds(p,e,u) || await tasks(p,e,u) || await treatment(p,e,u) || await appointments(p,e,u) || await documents(p,e,u) || await prescriptions(p,e,u) || await users(p,e,u) || await auditEndpoint(p,e,u);
    if(r) return r;
    return json({error:'Not found'},404);
  } catch(ex:any) { return json({error:ex?.message||'API error'},Number(ex?.status)||500); }
};
