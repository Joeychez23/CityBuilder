// Fetch wrapper for the Gridlock City API (same shape as Tone Radar's): attaches the
// session token and turns error responses into ApiError with a readable message.
const TOKEN_KEY = 'gridlock-token';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ } };

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError("Can't reach the Gridlock City server. Is it running? (npm run server)", 0);
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) setToken(null);
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  }
  return data;
}

// Account status: { available, user } — available is false when the server or database is down
export async function accountStatus() {
  const health = await api('/health').catch(() => null);
  if (!health?.accounts) return { available: false, user: null, reason: health ? 'The server is running without a database.' : 'The server isn\'t running.' };
  if (!getToken()) return { available: true, user: null };
  try {
    const { user } = await api('/auth/me');
    return { available: true, user };
  } catch {
    return { available: true, user: null };
  }
}
