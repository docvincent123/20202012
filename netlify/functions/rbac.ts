import crypto from 'node:crypto';

type V = string | number | boolean | null;
const DEFAULT_DB = 'libsql://rehaflow-echomedtechnologies.aws-ap-south-1.turso.io';
const sha = (s:string) => crypto.createHash('sha256').update(s).digest('hex');
const uid = (p:string) => `${p}_${crypto.randomBytes(8).toString('hex')}`;
const arg = (v:V) => v == null ? {type:'null'} : typeof v === 'boolean' ? {type:'integer',value:v?'1':'0'} : typeof v === 'number' ? {type:Number.isInteger(v)?'integer':'float',value:String(v)} : {type:'text',value:String(v)};

class Turso {
  url:string; token:string;
  constructor(){
    let base=(process.env.TURSO_DATABASE_URL||process.env.DATABASE_URL||DEFAULT_DB).trim().split('?')[0].replace(/\/+$/,'');
    if(base.startsWith('libsql://')) base=base.replace('libsql://','https://');
    this.url=`${base}/v2/pipeline`;
    this.token=(process.env.TURSO_AUTH_TOKEN||'').trim();
    if(!this.token) throw new Error('TURSO_AUTH_TOKEN is not configured');
  }
  async run(sql:string,values:V[]=[]){
    const r=await fetch(this.url,{method:'POST',headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},body:JSON.stringify({requests:[{type:'execute',stmt:{sql,...(values.length?{args:values.map(arg)}:{})}},{type:'close'}]})});
    const p:any=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(`Turso HTTP ${r.status}: ${p?.error?.message||r.statusText}`);
    for(const z of p.results||[]) if(z?.type==='error') throw new Error(`Turso SQL error: ${z.error?.message||z.error}`);
    const result:any=(p.results||[]).find((x:any)=>x?.response?.type==='execute')?.response?.result||{};
    const cols=result.cols||result.columns||[];
    const rows=(result.rows||[]).map((rr:any[])=>{const o:any={};cols.forEach((c:any,i:number)=>{const n=typeof c==='string'?c:c.name;const v=rr[i];o[n]=v&&typeof v==='object'&&'value'in v?v.value:v&&typeof v==='object'&&'base64'in v?Buffer.from(v.base64,'base64'):v;});return o;});
    return {rows,affected:Number(result.affected_row_count||0)};
  }
}
let dbi:Turso|null=null; const db=()=>dbi||(dbi=new Turso());
let ready:Promise<void>|null=null;

const roleSeeds:[string,string][]=[['admin','Адміністратор'],['manager','Керівник'],['doctor','Лікар'],['nurse','Медсестра'],['registrar','Реєстрація']];
const permissionSeeds=['dashboard','patients','archive','reception','beds','tasks','orders','documents','staff','analytics','admin','*'];
const matrix:Record<string,string[]>={admin:['*'],manager:['dashboard','patients','archive','reception','beds','tasks','orders','documents','staff','analytics'],doctor:['dashboard','patients','archive','reception','beds','tasks','orders','documents'],nurse:['dashboard','patients','archive','beds','tasks','orders','documents'],registrar:['dashboard','patients','archive','reception']};

export async function ensureRbac(){
  if(ready) return ready;
  ready=(async()=>{
    await db().run(`CREATE TABLE IF NOT EXISTS rf_roles(id TEXT PRIMARY KEY,key TEXT UNIQUE NOT NULL,name TEXT NOT NULL,active INTEGER DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    await db().run(`CREATE TABLE IF NOT EXISTS rf_permissions(id TEXT PRIMARY KEY,key TEXT UNIQUE NOT NULL,name TEXT NOT NULL,active INTEGER DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    await db().run(`CREATE TABLE IF NOT EXISTS rf_role_permissions(role_id TEXT NOT NULL,permission_id TEXT NOT NULL,PRIMARY KEY(role_id,permission_id))`);
    for(const [key,name] of roleSeeds){const r=await db().run('SELECT id FROM rf_roles WHERE key=? LIMIT 1',[key]);if(!r.rows.length)await db().run('INSERT INTO rf_roles(id,key,name,active) VALUES(?,?,?,1)',[uid('role'),key,name]);}
    for(const key of permissionSeeds){const p=await db().run('SELECT id FROM rf_permissions WHERE key=? LIMIT 1',[key]);if(!p.rows.length)await db().run('INSERT INTO rf_permissions(id,key,name,active) VALUES(?,?,?,1)',[uid('perm'),key,key]);}
    for(const [role,keys] of Object.entries(matrix)){const rr=await db().run('SELECT id FROM rf_roles WHERE key=?',[role]);for(const rk of keys){const pp=await db().run('SELECT id FROM rf_permissions WHERE key=?',[rk]);if(rr.rows[0]&&pp.rows[0])await db().run('INSERT OR IGNORE INTO rf_role_permissions(role_id,permission_id) VALUES(?,?)',[rr.rows[0].id,pp.rows[0].id]);}}
  })().catch(e=>{ready=null;throw e;});
  return ready;
}

export async function roles(){await ensureRbac();const rows=(await db().run(`SELECT r.key,r.name,r.active,COALESCE((SELECT json_group_array(p.key) FROM rf_role_permissions rp JOIN rf_permissions p ON p.id=rp.permission_id WHERE rp.role_id=r.id),'[]') permissions FROM rf_roles r WHERE r.active=1 ORDER BY r.key`)).rows;return rows.map((r:any)=>({...r,active:Number(r.active),permissions:typeof r.permissions==='string'?JSON.parse(r.permissions):r.permissions}));}
export async function current(accessToken:string){if(!accessToken)return null;await ensureRbac();const r=await db().run(`SELECT u.id,u.email,u.name,u.role,u.active,s.id session_id,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.access_token=? LIMIT 1`,[sha(accessToken)]);const u:any=r.rows[0];if(!u||Number(u.active)!==1||new Date(u.expires_at).getTime()<Date.now())return null;const ps=(await db().run(`SELECT p.key FROM rf_role_permissions rp JOIN rf_permissions p ON p.id=rp.permission_id JOIN rf_roles r ON r.id=rp.role_id WHERE r.key=? AND r.active=1 AND p.active=1`,[u.role])).rows;u.permissions=ps.map((x:any)=>x.key);return u;}
export const allowed=(user:any,permission:string)=>Array.isArray(user?.permissions)&&(user.permissions.includes('*')||user.permissions.includes(permission));
export function permissionForPath(path:string,method:string){if(method==='OPTIONS'||path==='/auth/login'||path==='/auth/logout'||path==='/auth/me'||path==='/session'||path==='/me'||path==='/roles')return null;if(path.startsWith('/dashboard'))return'dashboard';if(path.startsWith('/patients'))return'patients';if(path.startsWith('/archive')||path.startsWith('/patient-history'))return'archive';if(path.startsWith('/rooms')||path.startsWith('/beds'))return'beds';if(path.startsWith('/tasks'))return'tasks';if(path.startsWith('/prescriptions'))return'orders';if(path.startsWith('/documents'))return'documents';if(path.startsWith('/users')||path.startsWith('/staff')||path.startsWith('/sessions'))return'staff';if(path.startsWith('/audit'))return'admin';return null;}
export async function listRoles(){return roles();}
