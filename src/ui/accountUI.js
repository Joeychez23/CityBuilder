// Account widgets shared by the start screen and the in-game Account panel: the sign-in /
// create-account form and the list of cities saved to your account.
import { api, setToken, accountStatus } from '../net/api.js';
import { formatDate } from '../sim/simulation.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (v) => `₡${Math.round(v).toLocaleString()}`;
const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function renderAuthForm(el, onSignedIn) {
  let mode = 'login';
  const draw = (error = '') => {
    el.innerHTML = `
      <div class="seg" style="margin-bottom:8px"><button data-m="login" class="${mode === 'login' ? 'on' : ''}">Sign in</button><button data-m="register" class="${mode === 'register' ? 'on' : ''}">Create account</button></div>
      <form class="auth-form" style="display:flex;flex-direction:column;gap:6px">
        ${mode === 'register' ? '<input type="text" name="name" placeholder="Name (optional)" maxlength="80" autocomplete="name">' : ''}
        <input type="email" name="email" placeholder="Email" required autocomplete="email">
        <input type="password" name="password" placeholder="Password${mode === 'register' ? ' (8+ characters)' : ''}" required minlength="${mode === 'register' ? 8 : 1}" autocomplete="${mode === 'register' ? 'new-password' : 'current-password'}">
        ${error ? `<div class="bad" style="font-size:12px">${esc(error)}</div>` : ''}
        <button class="btn primary" type="submit">${mode === 'login' ? 'Sign in' : 'Create account'}</button>
      </form>`;
    el.querySelectorAll('[data-m]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); mode = b.dataset.m; draw(); }));
    el.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const body = { email: f.get('email'), password: f.get('password') };
      if (mode === 'register') body.name = f.get('name') || '';
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const { token, user } = await api(mode === 'login' ? '/auth/login' : '/auth/register', { method: 'POST', body });
        setToken(token);
        onSignedIn(user);
      } catch (err) {
        draw(err.message);
      }
    };
  };
  draw();
}

// onLoad(city) gets { id, data, ... }; currentId highlights the city you're playing
export async function renderCityList(el, { onLoad, currentId, onChange } = {}) {
  el.innerHTML = '<div class="muted">Loading your cities…</div>';
  let cities;
  try {
    ({ cities } = await api('/cities'));
  } catch (err) {
    el.innerHTML = `<div class="bad">${esc(err.message)}</div>`;
    return;
  }
  if (!cities.length) { el.innerHTML = '<div class="muted">No cities saved to your account yet.</div>'; return; }
  el.innerHTML = '';
  for (const c of cities) {
    const item = document.createElement('div');
    item.className = `list-item ${c.id === currentId ? 'done' : ''}`;
    item.innerHTML = `<div class="row"><b>${esc(c.name)}</b><span class="muted num" style="font-size:11px">${when(c.updatedAt)}</span></div>
      <div class="muted" style="font-size:11.5px">${esc(c.mapName)} · ${c.population.toLocaleString()} people · ${money(c.money)} · ${formatDate(c.day)} · ${Math.round(c.size / 1024)} KB</div>
      <div style="display:flex;gap:6px;margin-top:6px">${onLoad ? `<button class="btn primary" data-a="load">${c.id === currentId ? 'Reload' : 'Load'}</button>` : ''}<button class="btn" data-a="del">Delete</button></div>`;
    item.querySelector('[data-a="load"]')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Loading…';
      try {
        const { city } = await api(`/cities/${c.id}`);
        // a city from before the road network update can't be opened: it stays in your account
        const { isLegacySave } = await import('../sim/save.js');
        if (await isLegacySave(city.data)) {
          const { downloadLegacy } = await import('../sim/legacy.js');
          const nb = document.createElement('button');
          nb.className = 'btn';
          nb.textContent = 'Old version: download';
          nb.title = 'Built with grid roads, before the road network update: it can\'t be opened in this version. It stays in your account.';
          nb.onclick = () => downloadLegacy({ text: city.data, name: c.name });
          e.target.replaceWith(nb);
          return;
        }
        onLoad(city);
      } catch (err) { e.target.textContent = err.message; }
    });
    item.querySelector('[data-a="del"]').onclick = async () => {
      if (!confirm(`Delete "${c.name}" from your account? This can't be undone.`)) return;
      await api(`/cities/${c.id}`, { method: 'DELETE' }).catch(() => {});
      renderCityList(el, { onLoad, currentId, onChange });
      onChange?.();
    };
    el.appendChild(item);
  }
}

export { accountStatus, esc };
