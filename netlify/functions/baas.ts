import type { Config, Handler } from '@netlify/functions';
import { handler as apiHandler } from './api6';
import { allowed, current, ensureRbac, listRoles, permissionForPath } from './rbac';

export const config: Config = { path: ['/api/baas', '/api/baas/*'] };
const json = (body:any,statusCode=200) => ({ statusCode, headers:{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type,Authorization,X-Device-Id,X-Device-Name,X-Device-Platform,X-App-Version','Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS'}, body:JSON.stringify(body) });
const bearer=(event:any)=>{const h=event.headers?.authorization||event.headers?.Authorization||'';return h.startsWith('Bearer ')?h.slice(7):''};

export const handler: Handler = async (event, context) => {
  const rawPath=event.path||'';
  const normalizedPath=rawPath.replace(/^\\/.netlify\\/functions\\/baas/,'').replace(/^\\/api\\/baas/,'')||'/';
  const method=(event.httpMethod||'GET').toUpperCase();
  if(method==='OPTIONS') return json({ok:true});
  try {
    await ensureRbac();
    const required=permissionForPath(normalizedPath,method);
    if(normalizedPath==='/roles'&&method==='GET'){
      const user=await current(bearer(event));
      if(!user) return json({error:'Unauthorized'},401);
      if(!allowed(user,'roles.view')) return json({error:'Forbidden',permission:'roles.view'},403);
      return json({roles:await listRoles()});
    }
    if(required){
      const user=await current(bearer(event));
      if(!user) return json({error:'Unauthorized'},401);
      if(!allowed(user,required)) return json({error:'Forbidden',permission:required},403);
    }
    return apiHandler({ ...event, path: normalizedPath, rawUrl: event.rawUrl?.replace(/\\/api\\/baas(?=\\/|$)/, '') }, context);
  } catch (e:any) { return json({error:e?.message||'Gateway error'},500); }
};
