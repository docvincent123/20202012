const API = 'https://gregarious-frangollo-24145c.netlify.app/api/baas';
const DIRECT = 'https://gregarious-frangollo-24145c.netlify.app/.netlify/functions/api';
export async function apiFetch(path, options={}){
  const token=localStorage.getItem('rf-token');
  const headers={'Accept':'application/json','Content-Type':'application/json',...(options.headers||{})};
  if(token) headers.Authorization=`Bearer ${token}`;
  let res;
  try{res=await fetch(API+path,{...options,headers});}
  catch(e){res=await fetch(DIRECT+path,{...options,headers});}
  const text=await res.text();
  let data=null; try{data=text?JSON.parse(text):null;}catch{}
  if(!res.ok) throw new Error(data?.error?.message||data?.message||text||`HTTP ${res.status}`);
  return data;
}
export async function login(identifier,password){
  const body={email:identifier,login:identifier,username:identifier,identifier,password,client:'desktop',deviceId:'windows-desktop'};
  const data=await apiFetch('/auth/login',{method:'POST',body:JSON.stringify(body)});
  const token=data?.accessToken||data?.access_token||data?.token||data?.data?.accessToken||data?.data?.access_token||data?.data?.token;
  if(token)localStorage.setItem('rf-token',token);
  if(data?.user) localStorage.setItem('rf-user',JSON.stringify(data.user));
  return data;
}
export const getPatients=()=>apiFetch('/patients?status=active&limit=500');
export const getTasks=()=>apiFetch('/tasks?limit=500');
export const getMe=()=>apiFetch('/auth/me');
export const createPatient=(body)=>apiFetch('/patients',{method:'POST',body:JSON.stringify(body)});
export const createTask=(body)=>apiFetch('/tasks',{method:'POST',body:JSON.stringify(body)});
export const logout=async()=>{try{await apiFetch('/auth/logout',{method:'POST',body:JSON.stringify({deviceId:'windows-desktop'})});}finally{localStorage.removeItem('rf-token');localStorage.removeItem('rf-user');}};
