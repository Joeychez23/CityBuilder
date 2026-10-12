// Accounts: sign in, save the current city to your account, load or delete saved cities,
// and (optionally) autosave to the account. Talks to the server in /server.
import { registerPanel } from '../ui/panels.js';
import { registerSystem } from '../sim/simulation.js';
import { pack } from '../sim/save.js';
import { api, setToken } from '../net/api.js';
import { renderAuthForm, renderCityList, accountStatus, esc } from '../ui/accountUI.js';
import { handOver } from '../sim/store.js';

export async function saveToAccount(app) {
  const s = app.state;
  const body = {
    name: s.cityName, mapId: s.mapId, mapName: s.mapName, climate: s.climate,
    population: s.citizens.size, money: Math.round(s.money), day: s.time.day, milestone: s.progression.milestone,
    data: await pack(s),
  };
  if (s.cloudId) {
    try {
      await api(`/cities/${s.cloudId}`, { method: 'PUT', body });
      return 'updated';
    } catch (err) {
      if (err.status !== 404) throw err;
      s.cloudId = null; // it was deleted elsewhere: save a new copy
    }
  }
  const { city } = await api('/cities', { method: 'POST', body });
  s.cloudId = city.id;
  return 'created';
}

// Loading restarts the page with the save handed over (sim/store.js), so the old city's
// renderer and simulation are torn down cleanly.
export async function openCloudCity(city) {
  if (!(await handOver(city.data, city.id))) {
    alert('This browser blocked the hand-off storage, so the city could not be opened.');
    return;
  }
  location.href = location.pathname;
}

registerPanel({
  key: 'account', icon: '👤', title: 'Account & Cloud Saves', order: 88, static: true,
  render(app, body, st, rerender) {
    const s = app.state;
    body.innerHTML = '<div class="muted">Checking your account…</div>';
    accountStatus().then((acc) => {
      app.account = acc;
      if (!acc.available) {
        body.innerHTML = `<div class="warn">Accounts are offline.</div><div class="muted" style="margin-top:6px">${esc(acc.reason)} Start it with <code>npm run server</code> (see server/.env.example for MongoDB). Your city still saves in this browser from the Game panel.</div>`;
        return;
      }
      if (!acc.user) {
        body.innerHTML = '<div class="muted" style="margin-bottom:8px">Sign in to save cities to your account and pick them up on any device.</div><div data-auth></div>';
        renderAuthForm(body.querySelector('[data-auth]'), () => rerender());
        return;
      }
      body.innerHTML = `
        <div class="row"><span>Signed in as <b>${esc(acc.user.name || acc.user.email)}</b></span><button class="btn" data-a="out">Sign out</button></div>
        <div style="display:flex;gap:6px;margin:8px 0;flex-wrap:wrap"><button class="btn primary" data-a="save">☁ ${s.cloudId ? 'Save to account' : 'Save to account (new)'}</button>${s.cloudId ? '<button class="btn" data-a="copy">Save as a copy</button>' : ''}</div>
        <label class="row"><span class="k">Also autosave to my account (every week)</span><input type="checkbox" data-a="auto" ${app.settings.cloudAutosave ? 'checked' : ''}></label>
        <div class="section-title">Your cities</div><div data-list></div>
        <div class="section-title">Danger zone</div><button class="btn" data-a="delete" style="border-color:var(--bad);color:var(--bad)">Delete my account and all its cities</button>`;
      const list = body.querySelector('[data-list]');
      renderCityList(list, { onLoad: openCloudCity, currentId: s.cloudId });
      const saveBtn = body.querySelector('[data-a="save"]');
      const doSave = async (asCopy) => {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        if (asCopy) s.cloudId = null;
        try {
          const how = await saveToAccount(app);
          app.toast(how === 'updated' ? 'Your account copy is up to date.' : 'Saved to your account.', 'good', '☁ Saved');
        } catch (err) { app.toast(err.message, 'bad', 'Cloud save failed'); }
        rerender();
      };
      saveBtn.onclick = () => doSave(false);
      body.querySelector('[data-a="copy"]')?.addEventListener('click', () => doSave(true));
      body.querySelector('[data-a="out"]').onclick = () => { setToken(null); rerender(); };
      body.querySelector('[data-a="auto"]').onchange = (e) => { app.settings.cloudAutosave = e.target.checked; app.applySettings(); };
      body.querySelector('[data-a="delete"]').onclick = async () => {
        if (!confirm('Delete your account and every city saved to it? This cannot be undone.')) return;
        try { await api('/auth/account', { method: 'DELETE' }); setToken(null); s.cloudId = null; app.toast('Account deleted', 'info'); } catch (err) { app.toast(err.message, 'bad'); }
        rerender();
      };
    });
  },
});

export const accountFeature = {
  init(app) {
    registerSystem({
      name: 'cloud-autosave', every: 'week', run: () => {
        if (!app.settings.cloudAutosave) return;
        if (!app.account?.user) return;
        saveToAccount(app).catch((err) => app.toast(err.message, 'warn', 'Cloud autosave skipped'));
      },
    });
    // Know early whether we're signed in (for autosave), without blocking the game
    accountStatus().then((acc) => { app.account = acc; });
  },
};
