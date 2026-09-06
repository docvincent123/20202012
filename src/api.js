const API = 'https://gregarious-frangollo-24145c.netlify.app/api/baas';
const DIRECT = 'https://gregarious-frangollo-24145c.netlify.app/.netlify/functions/api';

async function nativeApi(path, options = {}) {
  if (typeof window !== 'undefined' && typeof window.__rfNativeApi === 'function') {
    const token = localStorage.getItem('rf-token');
    return window.__rfNativeApi({ method: options.method || 'GET', path, body: options.body || null, token });
  }
  return null;
}

export async function apiFetch(path, options = {}) {
  try {
    const native = await nativeApi(path, options);
    if (native !== null) return native;
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
  const token = localStorage.getItem('rf-token');
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try { res = await fetch(API + path, { ...options, headers }); }
  catch { res = await fetch(DIRECT + path, { ...options, headers }); }
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error(data?.error?.message || data?.error || data?.message || text || `HTTP ${res.status}`);
  return data;
}

export async function login(identifier, password) {
  const body = { email: identifier, login: identifier, username: identifier, identifier, password, client: 'desktop', deviceId: 'windows-desktop' };
  const data = await apiFetch('/auth/login', { method: 'POST', body: JSON.stringify(body) });
  const token = data?.accessToken || data?.access_token || data?.token || data?.data?.accessToken || data?.data?.access_token;
  if (token) localStorage.setItem('rf-token', token);
  if (data?.user) localStorage.setItem('rf-user', JSON.stringify(data.user));
  return data;
}

export const me = () => apiFetch('/auth/me');
export const getDashboard = () => apiFetch('/dashboard');
export const getPatients = (q = '') => apiFetch(`/patients?status=active&limit=500${q ? `&q=${encodeURIComponent(q)}` : ''}`);
export const getPatient = (id) => apiFetch(`/patients/${id}`);
export const createPatient = (body) => apiFetch('/patients', { method: 'POST', body: JSON.stringify(body) });
export const updatePatient = (id, body) => apiFetch(`/patients/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const deletePatient = (id) => apiFetch(`/patients/${id}`, { method: 'DELETE' });
export const getTasks = () => apiFetch('/tasks?limit=500');
export const createTask = (body) => apiFetch('/tasks', { method: 'POST', body: JSON.stringify(body) });
export const updateTask = (id, body) => apiFetch(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const deleteTask = (id) => apiFetch(`/tasks/${id}`, { method: 'DELETE' });
export const getBeds = () => apiFetch('/beds');
export const updateBed = (id, body) => apiFetch(`/beds/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const getAppointments = () => apiFetch('/appointments');
export const createAppointment = (body) => apiFetch('/appointments', { method: 'POST', body: JSON.stringify(body) });
export const updateAppointment = (id, body) => apiFetch(`/appointments/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const deleteAppointment = (id) => apiFetch(`/appointments/${id}`, { method: 'DELETE' });
export const getDocuments = (patientId = '') => apiFetch(`/documents${patientId ? `?patientId=${encodeURIComponent(patientId)}` : ''}`);
export const createDocument = (body) => apiFetch('/documents', { method: 'POST', body: JSON.stringify(body) });
export const getUsers = (q = '') => apiFetch(`/users${q ? `?q=${encodeURIComponent(q)}` : ''}`);
export const createUser = (body) => apiFetch('/users', { method: 'POST', body: JSON.stringify(body) });
export const updateUser = (id, body) => apiFetch(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const deleteUser = (id) => apiFetch(`/users/${id}`, { method: 'DELETE' });
export const getRoles = () => apiFetch('/roles');
export const getAudit = () => apiFetch('/audit');
export const logout = async () => { try { await apiFetch('/auth/logout', { method: 'POST', body: '{}' }); } finally { localStorage.removeItem('rf-token'); localStorage.removeItem('rf-user'); } };
