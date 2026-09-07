import type { Config, Handler } from '@netlify/functions';
import { handler as apiHandler } from './api6';
import { allowed, current, ensureRbac, listRoles, permissionForPath } from './rbac';

export const config: Config = { path: ['/api/baas', '/api/baas/*'] };
const json = (body:any,statusCode=200) => ({ statusCode, headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-RehaFlow-Data-Source':'Turso','X-RehaFlow-API':'rehab-v2','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type,Authorization,X-Device-Id,X-Device-Name,X-Device-Platform,X-App-Version','Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS'}, body:JSON.stringify(body) });
const bearer=(event:any)=>{const h=event.headers?.authorization||event.headers?.Authorization||'';return h.startsWith('Bearer ')?h.slice(7):''};

export const handler: Handler = async (event, context) => {
  const rawPath=event.path||'';
  const normalizedPath=rawPath.replace(/^\\/.netlify\\/functions\\/baas/,'').replace(/^\\/api\\/baas/,'')||'/';
  const method=(event.httpMethod||'GET').toUpperCase();
  if(method==='OPTIONS') return json({ok:true});
  try {
    await ensureRbac();
    const required=permissionForPath(normalizedPath,method);
    if(required){
      const user=await current(bearer(event));
      if(!user) return json({error:'Unauthorized'},401);
      if(!allowed(user,required)) return json({error:'Forbidden',permission:required},403);
    }
    if(normalizedPath==='/roles'&&method==='GET') return json({roles:await listRoles()});
    let routePath=normalizedPath;
    let routeMethod=method;
    if(routePath.startsWith('/auth/')) routePath=routePath.slice(5);
    if(routePath==='/staff/doctors') routePath='/doctors';
    if(routePath.match(/^\/patients\/[^/]+\/archive$/)&&routeMethod==='POST'){
      routePath=routePath.replace(/\/archive$/,'');
      routeMethod='DELETE';
    }
    if(routePath.match(/^\/beds\/[^/]+$/)&&routeMethod==='PATCH'){
      routePath += '/assign';
      routeMethod='POST';
    }
    return apiHandler({ ...event, path: routePath, httpMethod: routeMethod as any, rawUrl: event.rawUrl?.replace(/\\/api\\/baas(?=\\/|$)/,'') }, context);
  } catch (e:any) { return json({error:e?.message||'Gateway error'},500); }
};
