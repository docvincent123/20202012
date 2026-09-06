import type { Handler } from '@netlify/functions';
import { handler as apiHandler } from './api3';
import { migrate } from './migrate';
let p:Promise<void>|null=null;
export const handler:Handler=async(e,c)=>{try{p=p||migrate();await p;return apiHandler(e,c)}catch(err:any){p=null;console.error(err);return {statusCode:500,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},body:JSON.stringify({error:err?.message||String(err)})}}};
