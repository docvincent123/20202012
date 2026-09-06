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

class Turso {
  url: string; token: string;
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

async function column(table: string, name: string, type: string) { try { await db().run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`); } catch {} }
async function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const ddl = [
      `CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT DEFAULT 'doctor',active INTEGER DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,access_token TEXT UNIQUE NOT NULL,refresh_token TEXT UNIQUE NOT NULL,expires_at TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,last_seen_at TEXT,device_id TEXT,device_name TEXT,platform TEXT,app_version TEXT,ip TEXT,user_agent TEXT)`,
      `CREATE TABLE IF NOT EXISTS login_history(id TEXT PRIMARY KEY,user_id TEXT,identifier TEXT,success INTEGER,ip TEXT,user_agent TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS rf_rooms(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,department TEXT,active INTEGER DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS rf_beds(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,number INTEGER NOT NULL,code TEXT UNIQUE NOT NULL,qr_payload TEXT UNIQUE,status TEXT DEFAULT 'available',patient_id TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(room_id,number))`,
      `CREATE TABLE IF NOT EXISTS rf_patients(id TEXT PRIMARY KEY,first_name TEXT NOT NULL,last_name TEXT NOT NULL,middle_name TEXT,birth_date TEXT,sex TEXT,phone TEXT,email TEXT,address TEXT,passport_id TEXT,insurance_number TEXT,emergency_name TEXT,emergency_phone TEXT,blood_type TEXT,allergies TEXT,diagnosis TEXT,admission_reason TEXT,department TEXT,attending_doctor_id TEXT,room_id TEXT,bed_id TEXT,current_bed_id TEXT,status TEXT DEFAULT 'active',admitted_at TEXT,discharged_at TEXT,notes TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS rf_bed_history(id TEXT PRIMARY KEY,patient_id TEXT,bed_id TEXT,started_at TEXT NOT NULL,ended_at TEXT,reason TEXT)`,
      `CREATE TABLE IF NOT EXISTS rf_admissions(id TEXT PRIMARY KEY,patient_id TEXT NOT NULL,doctor_id TEXT,department TEXT,room_id TEXT,bed_id TEXT,reason TEXT,admitted_at TEXT,discharged_at TEXT,status TEXT DEFAULT 'active',created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS rf_tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT,patient_id TEXT,assigned_to TEXT,priority TEXT DEFAULT 'normal',status TEXT DEFAULT 'pending',due_at TEXT,created_by TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS rf_prescriptions(id TEXT PRIMARY KEY,patient_id TEXT,doctor_id TEXT,drug TEXT NOT NULL,dose TEXT,route TEXT,frequency TEXT,start_at TEXT,end_at TEXT,status TEXT DEFAULT 'active',note TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS rf_documents(id TEXT PRIMARY KEY,patient_id TEXT,title TEXT NOT NULL,category TEXT DEFAULT 'other',content TEXT,file_name TEXT,file_url TEXT,created_by TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS rf_audit(id TEXT PRIMARY KEY,user_id TEXT,action TEXT,entity TEXT,entity_id TEXT,details TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`
    ];
    for (const s of ddl) await db().run(s);
    for (const [t, c, ty] of [
      ['sessions','last_seen_at','TEXT'],['sessions','device_id','TEXT'],['sessions','device_name','TEXT'],['sessions','platform','TEXT'],['sessions','app_version','TEXT'],['sessions','ip','TEXT'],['sessions','user_agent','TEXT'],
      ['rf_patients','current_bed_id','TEXT'],['rf_patients','attending_doctor_id','TEXT'],['rf_patients','room_id','TEXT'],['rf_patients','bed_id','TEXT'],['rf_patients','admitted_at','TEXT'],['rf_patients','discharged_at','TEXT'],
      ['rf_beds','qr_payload','TEXT'],['rf_beds','patient_id','TEXT'],['rf_beds','updated_at','TEXT']
    ] as const) await column(t,c,ty);

    const bootstrapEmail = (process.env.DEFAULT_ADMIN_EMAIL || '').trim();
    const bootstrapPassword = process.env.DEFAULT_ADMIN_PASSWORD || '';
    if (bootstrapEmail && bootstrapPassword) {
      const u = await db().run('SELECT id FROM users WHERE lower(email)=lower(?) LIMIT 1',[bootstrapEmail]);
      if (!u.rows.length) await db().run('INSERT INTO users(id,email,name,password_hash,role,active) VALUES(?,?,?,?,?,1)', ['admin-bootstrap',bootstrapEmail,process.env.DEFAULT_ADMIN_NAME || 'System Administrator',await bcrypt.hash(bootstrapPassword,12),'admin']);
    }

    const rooms = await db().run('SELECT COUNT(*) c FROM rf_rooms');
    if (!Number(rooms.rows[0]?.c || 0)) for (const n of ['101','102','103','104','105','106','107']) await db().run('INSERT INTO rf_rooms(id,name,department,active) VALUES(?,?,?,1)',[uid('room'),`Палата ${n}`,'Реабілітація']);
    const beds = await db().run('SELECT COUNT(*) c FROM rf_beds');
    if (!Number(beds.rows[0]?.c || 0)) { const rs = (await db().run('SELECT id FROM rf_rooms ORDER BY name')).rows; for (const r of rs) for (let n=1;n<=2;n++){ const code=`BED-${crypto.randomBytes(5).toString('hex').toUpperCase()}`; await db().run('INSERT INTO rf_beds(id,room_id,number,code,qr_payload,status,updated_at) VALUES(?,?,?,?,?,\'available\',?)',[uid('bed'),r.id,n,code,`rehaflow://bed/${code}`,now()]); } }
    await db().run(`UPDATE rf_beds SET qr_payload=COALESCE(qr_payload,'rehaflow://bed/'||code),updated_at=COALESCE(updated_at,?)`,[now()]);
  })().catch(e => { initPromise = null; throw e; });
  return initPromise;
}

const permissions: Record<string,string[]> = { admin:['*'], manager:['dashboard','patients','archive','reception','beds','tasks','orders','documents','staff','analytics','admin'], doctor:['dashboard','patients','archive','reception','beds','tasks','orders','documents'], nurse:['dashboard','patients','archive','beds','tasks','orders','documents'], registrar:['dashboard','patients','archive','reception'] };
const allowed = (u:any, key:string) => (permissions[u?.role] || []).includes('*') || (permissions[u?.role] || []).includes(key);
const error = (message:string,status:number) => Object.assign(new Error(message),{status});
async function current(e:HandlerEvent){ const t=bearer(e); if(!t) return null; const r=await db().run(`SELECT u.id,u.email,u.name,u.role,u.active,s.id session_id,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.access_token=? LIMIT 1`,[sha(t)]); const u:any=r.rows[0]; if(!u || Number(u.active)!==1 || new Date(u.expires_at).getTime()<Date.now()) return null; await db().run('UPDATE sessions SET last_seen_at=? WHERE id=?',[now(),u.session_id]); return u; }
async function audit(u:any,action:string,entity:string,entityId:string,details:any={}){ try { await db().run('INSERT INTO rf_audit(id,user_id,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?,?)',[uid('audit'),u?.id||null,action,entity,entityId,JSON.stringify(details),now()]); } catch {} }
async function auth(p:string,e:HandlerEvent){
  if(e.httpMethod==='OPTIONS') return json({ok:true});
  if(p==='/login'&&e.httpMethod==='POST'){
    const b=body(e), ident=String(b.email||b.login||b.username||b.identifier||'').trim(), pass=String(b.password||'');
    if(!ident||!pass) return json({error:'Email/login and password are required'},400);
    const r=await db().run('SELECT * FROM users WHERE lower(email)=lower(?) OR lower(name)=lower(?) LIMIT 1',[ident,ident]); const u:any=r.rows[0];
    let ok=false;
    if(u){ const ph=String(u.password_hash||''); ok=ph.startsWith('$2') ? await bcrypt.compare(pass,ph) : false; }
    await db().run('INSERT INTO login_history(id,user_id,identifier,success,ip,user_agent) VALUES(?,?,?,?,?,?)',[uid('login'),u?.id||null,ident,ok?1:0,e.headers?.['x-forwarded-for']||null,e.headers?.['user-agent']||null]);
    if(!u||!ok||Number(u.active)!==1) return json({error:'Invalid credentials'},401);
    const at=secret(),rt=secret(),sid=uid('sess'),exp=new Date(Date.now()+12*60*60*1000).toISOString();
    await db().run('INSERT INTO sessions(id,user_id,access_token,refresh_token,expires_at,last_seen_at,device_id,device_name,platform,app_version,ip,user_agent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[sid,u.id,sha(at),sha(rt),exp,now(),b.deviceId||'windows-desktop',b.deviceName||'RehaFlow Windows',b.platform||'windows',b.appVersion||'',e.headers?.['x-forwarded-for']||null,e.headers?.['user-agent']||null]);
    return json({accessToken:at,refreshToken:rt,token:at,user:{id:u.id,email:u.email,name:u.name,role:u.role,active:Number(u.active)},session:{id:sid,expiresAt:exp}});
  }
  if(p==='/logout'&&e.httpMethod==='POST'){ const t=bearer(e); if(t) await db().run('DELETE FROM sessions WHERE access_token=?',[sha(t)]); return json({ok:true}); }
  if((p==='/me'||p==='/session')&&e.httpMethod==='GET'){ const u=await current(e); if(!u) return json({error:'Unauthorized'},401); return json({authenticated:true,user:{id:u.id,email:u.email,name:u.name,role:u.role,active:Number(u.active)}}); }
  return null;
}

async function patients(p:string,e:HandlerEvent,u:any){
  if(!allowed(u,'patients')) throw error('Forbidden',403);
  if(p==='/patients'&&e.httpMethod==='GET'){
    const status=q(e,'status','active'), term=q(e,'q',''); const like=`%${term}%`;
    const rows=(await db().run(`SELECT p.*,u.name attending_doctor_name,b.number bed_number,b.code bed_code,r.name room_name FROM rf_patients p LEFT JOIN users u ON u.id=p.attending_doctor_id LEFT JOIN rf_beds b ON b.id=p.current_bed_id LEFT JOIN rf_rooms r ON r.id=b.room_id WHERE p.status=? AND (?='' OR lower(p.first_name||' '||p.last_name||' '||COALESCE(p.phone,'')) LIKE lower(?)) ORDER BY p.created_at DESC`,[status,term,like])).rows;
    return json({patients:rows,items:rows,total:rows.length});
  }
  if(p==='/patients'&&e.httpMethod==='POST'){
    const b=body(e), id=uid('pat'); if(!b.firstName||!b.lastName) return json({error:'firstName and lastName are required'},400); const at=now();
    await db().run(`INSERT INTO rf_patients(id,first_name,last_name,middle_name,birth_date,sex,phone,email,address,passport_id,insurance_number,emergency_name,emergency_phone,blood_type,allergies,diagnosis,admission_reason,department,attending_doctor_id,status,admitted_at,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[id,b.firstName,b.lastName,b.middleName||null,b.birthDate||b.birth_date||null,b.sex||null,b.phone||null,b.email||null,b.address||null,b.passportId||b.passport_id||null,b.insuranceNumber||b.insurance_number||null,b.emergencyName||null,b.emergencyPhone||null,b.bloodType||null,b.allergies||null,b.diagnosis||null,b.admissionReason||b.admission_reason||null,b.department||null,b.attendingDoctorId||b.attending_doctor_id||null,'active',at,b.notes||null,at,at]);
    await db().run('INSERT INTO rf_admissions(id,patient_id,doctor_id,department,reason,admitted_at,status) VALUES(?,?,?,?,?,? ,\'active\')',[uid('adm'),id,b.attendingDoctorId||b.attending_doctor_id||null,b.department||null,b.admissionReason||b.admission_reason||null,at]);
    if(b.bedId) await assignBed(b.bedId,id,u); await audit(u,'create','patient',id); return json({patient:{id},id},201);
  }
  const m=p.match(/^\/patients\/([^/]+)$/); const a=p.match(/^\/patients\/([^/]+)\/archive$/);
  if(a&&e.httpMethod==='POST'){ const id=a[1], r=await db().run('SELECT * FROM rf_patients WHERE id=?',[id]); if(!r.rows.length)return json({error:'Patient not found'},404); await dischargePatient(id,u); return json({ok:true}); }
  if(m&&e.httpMethod==='GET'){ const r=await db().run(`SELECT p.*,u.name attending_doctor_name,b.number bed_number,b.code bed_code,r.name room_name FROM rf_patients p LEFT JOIN users u ON u.id=p.attending_doctor_id LEFT JOIN rf_beds b ON b.id=p.current_bed_id LEFT JOIN rf_rooms r ON r.id=b.room_id WHERE p.id=?`,[m[1]]); if(!r.rows.length)return json({error:'Patient not found'},404); return json({patient:r.rows[0]}); }
  if(m&&(e.httpMethod==='PATCH'||e.httpMethod==='PUT')){ const b=body(e), id=m[1], fields:any={firstName:'first_name',lastName:'last_name',middleName:'middle_name',birthDate:'birth_date',sex:'sex',phone:'phone',email:'email',address:'address',passportId:'passport_id',insuranceNumber:'insurance_number',emergencyName:'emergency_name',emergencyPhone:'emergency_phone',bloodType:'blood_type',allergies:'allergies',diagnosis:'diagnosis',admissionReason:'admission_reason',department:'department',attendingDoctorId:'attending_doctor_id',notes:'notes'}; const sets:string[]=[], vals:V[]=[]; for(const k of Object.keys(fields)) if(b[k]!==undefined){sets.push(`${fields[k]}=?`);vals.push(b[k]);} if(sets.length){sets.push('updated_at=?');vals.push(now(),id);await db().run(`UPDATE rf_patients SET ${sets.join(',')} WHERE id=?`,vals);} if(b.bedId!==undefined) await assignBed(b.bedId,id,u); await audit(u,'update','patient',id); return json({ok:true}); }
  if(m&&e.httpMethod==='DELETE'){ await dischargePatient(m[1],u); return json({ok:true}); }
  return null;
}

async function dischargePatient(patientId:string,u:any){
  const r=await db().run('SELECT current_bed_id FROM rf_patients WHERE id=?',[patientId]); const bedId=r.rows[0]?.current_bed_id;
  if(bedId) await releaseBed(bedId,u,'discharge');
  const t=now(); await db().run('UPDATE rf_patients SET status=\'archived\',discharged_at=?,current_bed_id=NULL,bed_id=NULL,updated_at=? WHERE id=?',[t,t,patientId]); await db().run('UPDATE rf_admissions SET discharged_at=?,status=\'closed\' WHERE patient_id=? AND status=\'active\'',[t,patientId]); await audit(u,'archive','patient',patientId);
}
async function assignBed(bedId:string,patientId:string,u:any){
  const b=(await db().run('SELECT * FROM rf_beds WHERE id=?',[bedId])).rows[0] as any; if(!b)throw error('Bed not found',404); if(b.status==='occupied'&&b.patient_id!==patientId)throw error('Bed is already occupied',409);
  const p=(await db().run('SELECT current_bed_id FROM rf_patients WHERE id=?',[patientId])).rows[0] as any; if(p?.current_bed_id&&p.current_bed_id!==bedId) await releaseBed(p.current_bed_id,u,'transfer');
  const t=now(); await db().run('UPDATE rf_beds SET status=\'occupied\',patient_id=?,updated_at=? WHERE id=?',[patientId,t,bedId]); await db().run('UPDATE rf_patients SET current_bed_id=?,bed_id=?,room_id=(SELECT room_id FROM rf_beds WHERE id=?),updated_at=? WHERE id=?',[bedId,bedId,bedId,t,patientId]); await db().run('INSERT INTO rf_bed_history(id,patient_id,bed_id,started_at,reason) VALUES(?,?,?,?,?)',[uid('bh'),patientId,bedId,t,'assign']); return true;
}
async function releaseBed(bedId:string,u:any,reason='release'){ const t=now(); const r=await db().run('SELECT patient_id FROM rf_beds WHERE id=?',[bedId]); const patientId=r.rows[0]?.patient_id; await db().run('UPDATE rf_beds SET status=\'cleaning\',patient_id=NULL,updated_at=? WHERE id=?',[t,bedId]); await db().run('UPDATE rf_bed_history SET ended_at=?,reason=? WHERE bed_id=? AND ended_at IS NULL',[t,reason,bedId]); if(patientId) await db().run('UPDATE rf_patients SET current_bed_id=NULL,bed_id=NULL,room_id=NULL,updated_at=? WHERE id=?',[t,patientId]); await audit(u,reason==='release'?'release_bed':'move_bed','bed',bedId,{patientId}); }

async function clinic(p:string,e:HandlerEvent,u:any){
  if(p==='/dashboard'&&e.httpMethod==='GET'){
    const [patients,beds,tasks,sessions,archived]=await Promise.all([db().run("SELECT COUNT(*) c FROM rf_patients WHERE status='active'"),db().run("SELECT status,COUNT(*) c FROM rf_beds GROUP BY status"),db().run("SELECT COUNT(*) c FROM rf_tasks WHERE status NOT IN ('done','cancelled')"),db().run("SELECT COUNT(*) c FROM sessions WHERE datetime(expires_at)>datetime('now') AND datetime(COALESCE(last_seen_at,created_at))>datetime('now','-15 minutes')"),db().run("SELECT COUNT(*) c FROM rf_patients WHERE status='archived'")]);
    const map:any={}; for(const x of beds.rows) map[x.status]=Number(x.c||0); const total=Object.values(map).reduce((a:any,b:any)=>a+Number(b||0),0);
    return json({stats:{patients:Number(patients.rows[0]?.c||0),archivedPatients:Number(archived.rows[0]?.c||0),totalBeds:total,occupiedBeds:map.occupied||0,availableBeds:map.available||0,cleaningBeds:map.cleaning||0,maintenanceBeds:map.maintenance||0,openTasks:Number(tasks.rows[0]?.c||0),staffOnline:Number(sessions.rows[0]?.c||0)},updatedAt:now()});
  }
  if(p==='/archive'&&e.httpMethod==='GET'){ const rows=(await db().run(`SELECT p.*,u.name attending_doctor_name,r.name room_name FROM rf_patients p LEFT JOIN users u ON u.id=p.attending_doctor_id LEFT JOIN rf_rooms r ON r.id=p.room_id WHERE p.status='archived' ORDER BY p.discharged_at DESC`)).rows; return json({patients:rows,items:rows}); }
  if(p==='/patient-history'&&e.httpMethod==='GET'){ const rows=(await db().run(`SELECT h.*,p.first_name,p.last_name,b.number bed_number,r.name room_name FROM rf_bed_history h JOIN rf_patients p ON p.id=h.patient_id LEFT JOIN rf_beds b ON b.id=h.bed_id LEFT JOIN rf_rooms r ON r.id=b.room_id ORDER BY h.started_at DESC`)).rows; return json({history:rows,items:rows}); }
  if(p==='/rooms'&&e.httpMethod==='GET'){ const rooms=(await db().run('SELECT * FROM rf_rooms WHERE active=1 ORDER BY name')).rows; return json({rooms,items:rooms}); }
  if(p==='/rooms'&&e.httpMethod==='POST'){ if(!allowed(u,'admin'))throw error('Forbidden',403); const b=body(e),id=uid('room'); await db().run('INSERT INTO rf_rooms(id,name,department,active) VALUES(?,?,?,1)',[id,b.name,b.department||null]); return json({room:{id,name:b.name,department:b.department||null}},201); }
  if(p==='/beds'&&e.httpMethod==='GET'){ const beds=(await db().run(`SELECT b.*,r.name room_name,p.first_name patient_first_name,p.last_name patient_last_name FROM rf_beds b JOIN rf_rooms r ON r.id=b.room_id LEFT JOIN rf_patients p ON p.id=b.patient_id ORDER BY r.name,b.number`)).rows; return json({beds,items:beds}); }
  if(p==='/beds'&&e.httpMethod==='POST'){ if(!allowed(u,'admin'))throw error('Forbidden',403); const b=body(e),bid=uid('bed'),code=b.code||`BED-${crypto.randomBytes(5).toString('hex').toUpperCase()}`; await db().run('INSERT INTO rf_beds(id,room_id,number,code,qr_payload,status,updated_at) VALUES(?,?,?,?,?,\'available\',?)',[bid,b.roomId,b.number,code,`rehaflow://bed/${code}`,now()]); return json({bed:{id:bid,code,qr_payload:`rehaflow://bed/${code}`}},201); }
  const bm=p.match(/^\/beds\/([^/]+)$/); if(bm&&e.httpMethod==='PATCH'){ const b=body(e); await assignBed(bm[1],String(b.patientId),u); return json({ok:true}); }
  const br=p.match(/^\/beds\/([^/]+)\/release$/); if(br&&e.httpMethod==='POST'){ await releaseBed(br[1],u); return json({ok:true}); }
  return null;
}

async function generic(p:string,e:HandlerEvent,u:any){
  if(p==='/tasks'&&e.httpMethod==='GET'){const rows=(await db().run(`SELECT t.*,p.first_name patient_first_name,p.last_name patient_last_name,a.name assignee_name FROM rf_tasks t LEFT JOIN rf_patients p ON p.id=t.patient_id LEFT JOIN users a ON a.id=t.assigned_to ORDER BY t.created_at DESC`)).rows;return json({tasks:rows,items:rows});}
  if(p==='/tasks'&&e.httpMethod==='POST'){const b=body(e),id=uid('task');await db().run('INSERT INTO rf_tasks(id,title,description,patient_id,assigned_to,priority,status,due_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)',[id,b.title,b.description||null,b.patientId||null,b.assignedTo||null,b.priority||'normal',b.status||'pending',b.dueAt||null,u.id]);return json({task:{id}},201);}
  const tm=p.match(/^\/tasks\/([^/]+)$/);if(tm&&e.httpMethod==='PATCH'){const b=body(e);await db().run('UPDATE rf_tasks SET status=COALESCE(?,status),title=COALESCE(?,title),description=COALESCE(?,description),assigned_to=COALESCE(?,assigned_to),priority=COALESCE(?,priority),updated_at=? WHERE id=?',[b.status||null,b.title||null,b.description||null,b.assignedTo||null,b.priority||null,now(),tm[1]]);return json({ok:true});}if(tm&&e.httpMethod==='DELETE'){await db().run('DELETE FROM rf_tasks WHERE id=?',[tm[1]]);return json({ok:true});}
  if(p==='/prescriptions'&&e.httpMethod==='GET'){const rows=(await db().run('SELECT * FROM rf_prescriptions ORDER BY created_at DESC')).rows;return json({prescriptions:rows,items:rows});}if(p==='/prescriptions'&&e.httpMethod==='POST'){const b=body(e),id=uid('rx');await db().run('INSERT INTO rf_prescriptions(id,patient_id,doctor_id,drug,dose,route,frequency,start_at,end_at,status,note) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[id,b.patientId||null,b.doctorId||u.id,b.drug,b.dose||null,b.route||null,b.frequency||null,b.startAt||null,b.endAt||null,b.status||'active',b.note||null]);return json({prescription:{id}},201);}
  if(p==='/documents'&&e.httpMethod==='GET'){const patientId=q(e,'patientId');const rows=(await db().run(`SELECT * FROM rf_documents WHERE (?='' OR patient_id=?) ORDER BY created_at DESC`,[patientId,patientId])).rows;return json({documents:rows,items:rows});}if(p==='/documents'&&e.httpMethod==='POST'){const b=body(e),id=uid('doc');await db().run('INSERT INTO rf_documents(id,patient_id,title,category,content,file_name,file_url,created_by) VALUES(?,?,?,?,?,?,?,?)',[id,b.patientId||null,b.title,b.category||'other',b.content||null,b.fileName||null,b.fileUrl||null,u.id]);return json({document:{id}},201);}
  if(p==='/users'&&e.httpMethod==='GET'){const term=q(e,'q');const rows=(await db().run("SELECT id,email,name,role,active,created_at FROM users WHERE (?='' OR lower(name) LIKE lower(?) OR lower(email) LIKE lower(?)) ORDER BY name",[term,`%${term}%`,`%${term}%`])).rows;return json({users:rows,items:rows});}
  if(p==='/users'&&e.httpMethod==='POST'){if(!allowed(u,'staff'))throw error('Forbidden',403);const b=body(e),id=uid('usr');if(!b.email||!b.name||!b.password)return json({error:'name, email and password are required'},400);await db().run('INSERT INTO users(id,email,name,password_hash,role,active) VALUES(?,?,?,?,?,?)',[id,b.email,b.name,await bcrypt.hash(String(b.password),12),b.role||'doctor',b.active===false?0:1]);return json({user:{id}},201);}
  const um=p.match(/^\/users\/([^/]+)$/);if(um&&e.httpMethod==='PATCH'){if(!allowed(u,'staff'))throw error('Forbidden',403);const b=body(e);if(b.name!==undefined)await db().run('UPDATE users SET name=?,updated_at=? WHERE id=?',[b.name,now(),um[1]]);if(b.role!==undefined)await db().run('UPDATE users SET role=?,updated_at=? WHERE id=?',[b.role,now(),um[1]]);if(b.active!==undefined)await db().run('UPDATE users SET active=?,updated_at=? WHERE id=?',[b.active?1:0,now(),um[1]]);if(b.password)await db().run('UPDATE users SET password_hash=?,updated_at=? WHERE id=?',[await bcrypt.hash(String(b.password),12),now(),um[1]]);return json({ok:true});}if(um&&e.httpMethod==='DELETE'){if(!allowed(u,'staff'))throw error('Forbidden',403);await db().run('UPDATE users SET active=0,updated_at=? WHERE id=?',[now(),um[1]]);return json({ok:true});}
  if(p==='/roles'&&e.httpMethod==='GET')return json({roles:Object.entries(permissions).map(([role,items])=>({role,permissions:items}))});
  if(p==='/staff/doctors'&&e.httpMethod==='GET'){const rows=(await db().run("SELECT id,name,email,role FROM users WHERE active=1 AND role='doctor' ORDER BY name")).rows;return json({doctors:rows,items:rows});}
  if(p==='/sessions'&&e.httpMethod==='GET'){if(!allowed(u,'admin'))throw error('Forbidden',403);const rows=(await db().run(`SELECT s.id,s.user_id,u.name,u.email,u.role,s.expires_at,s.created_at,s.last_seen_at,s.device_id,s.device_name,s.platform,s.app_version,s.ip,s.user_agent FROM sessions s JOIN users u ON u.id=s.user_id ORDER BY s.last_seen_at DESC`)).rows;return json({sessions:rows,items:rows});}
  const sm=p.match(/^\/sessions\/([^/]+)$/);if(sm&&e.httpMethod==='DELETE'){if(!allowed(u,'admin'))throw error('Forbidden',403);await db().run('DELETE FROM sessions WHERE id=?',[sm[1]]);return json({ok:true});}
  if(p==='/audit'&&e.httpMethod==='GET'){if(!allowed(u,'admin'))throw error('Forbidden',403);const rows=(await db().run(`SELECT a.*,u.name user_name,u.email user_email FROM rf_audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 500`)).rows;return json({audit:rows,items:rows});}
  if(p==='/analytics'&&e.httpMethod==='GET'){const [ad,bd,td,rd]=await Promise.all([db().run("SELECT status,COUNT(*) c FROM rf_patients GROUP BY status"),db().run("SELECT status,COUNT(*) c FROM rf_beds GROUP BY status"),db().run("SELECT status,COUNT(*) c FROM rf_tasks GROUP BY status"),db().run("SELECT department,COUNT(*) c FROM rf_admissions WHERE status='active' GROUP BY department")]);return json({patients:ad.rows,beds:bd.rows,tasks:td.rows,departments:rd.rows});}
  if(p==='/permissions'&&e.httpMethod==='GET')return json({permissions:permissions[u.role]||[]});
  if(p==='/health')return json({ok:true,db:'turso',time:now()});
  return null;
}

export const handler: Handler = async (e) => {
  try {
    await init();
    const p = (e.path || '/').replace(/^\/.netlify\/functions\/baas/, '').replace(/^\/api\/baas/, '') || '/';
    if(e.httpMethod==='OPTIONS') return json({ok:true});
    const authResponse=await auth(p.replace(/^\/auth/,'') || '/',e); if(authResponse) return authResponse;
    if(p==='/auth/login'||p==='/auth/logout'||p==='/auth/me'||p==='/auth/session') return await auth(p.replace(/^\/auth/,'') || '/',e) || json({error:'API endpoint not found'},404);
    const u=await current(e); if(!u) return json({error:'Unauthorized'},401);
    if(p.startsWith('/patients')){const r=await patients(p,e,u);if(r)return r;}
    if(p==='/dashboard'||p==='/archive'||p==='/patient-history'||p.startsWith('/rooms')||p.startsWith('/beds')){const r=await clinic(p,e,u);if(r)return r;}
    const r=await generic(p,e,u); if(r)return r;
    return json({error:'API endpoint not found'},404);
  } catch (err:any) { console.error(err); return json({error:err?.message||String(err)},Number(err?.status||500)); }
};
