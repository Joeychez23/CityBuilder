// Districts (paint areas, name them, give them policies) and city-wide policies.
import { registerTool, segButtons, slider } from '../ui/tools.js';
import { registerPanel, row, pct } from '../ui/panels.js';
import { registerCategory } from '../ui/toolbar.js';
import { registerSystem } from '../sim/simulation.js';
import { CITY_POLICIES, DISTRICT_POLICIES, DISTRICT_COLORS } from '../data/policies.js';
import { idx, forRadius } from '../core/grid.js';
import { isOwned } from '../sim/build.js';
import { centerIdx } from '../sim/services.js';
import { bus } from '../core/events.js';
import { money } from '../ui/tools.js';
import { charge, perWeek } from '../sim/economy.js';
import { SPECIALISATIONS, specDef, specialisationsDaily } from '../sim/specialisations.js';
import { meter } from '../ui/panels.js';

const NAMES = ['Oakridge', 'Riverside', 'Old Town', 'Harborview', 'Maple Heights', 'Ironworks', 'Midtown', 'Westgate', 'Sunnyvale', 'Brookside', 'Northfield', 'Cedar Park'];

function newDistrict(state) {
  const id = state.districts.reduce((a, d) => Math.max(a, d.id), 0) + 1;
  const d = { id, name: NAMES[(id - 1) % NAMES.length] + (id > NAMES.length ? ` ${Math.ceil(id / NAMES.length)}` : ''), color: DISTRICT_COLORS[(id - 1) % DISTRICT_COLORS.length], policies: {} };
  state.districts.push(d);
  return d;
}

function refreshBuildingDistricts(state) {
  for (const b of state.buildings.values()) b.district = state.district[centerIdx(b)];
}

registerTool('district', {
  enter(app) { app.overlays.setDistrictMode(true); },
  exit(app) { app.overlays.setDistrictMode(false); },
  options(app, t, el, rerender) {
    const s = app.state;
    el.innerHTML = '<h4>Districts</h4>';
    segButtons(el, 'Mode', [['paint', 'Paint'], ['erase', 'Erase']], t.mode || 'paint', (v) => { t.mode = v; rerender(); });
    if ((t.mode || 'paint') === 'paint') {
      segButtons(el, 'District', [...s.districts.map((d) => [d.id, d.name]), ['new', '＋ New']], t.district, (v) => {
        if (v === 'new') { t.district = newDistrict(s).id; bus.emit('districts:changed'); } else t.district = v;
        rerender();
      });
    }
    slider(el, 'Brush size', 0, 8, 1, t.size ?? 3, (v) => { t.size = v; });
    const pol = document.createElement('button');
    pol.className = 'btn';
    pol.textContent = '📜 Names & policies…';
    pol.dataset.tip = 'Open the districts window to rename districts and set their policies (stops painting).';
    pol.onclick = () => app.panels.open('districts');
    el.appendChild(pol);
  },
  hover(app, t, p) { app.preview.setBrush(p.cx + 0.5, p.cy + 0.5, (t.size ?? 3) + 0.5); },
  drag(app, t, a, b) {
    const s = app.state;
    app.preview.setBrush(b.cx + 0.5, b.cy + 0.5, (t.size ?? 3) + 0.5);
    if ((t.mode || 'paint') === 'paint' && !t.district) { t.district = (s.districts[0] || newDistrict(s)).id; app.tools.renderOptions(); }
    const val = (t.mode || 'paint') === 'erase' ? 0 : t.district;
    forRadius(b.cx + 0.5, b.cy + 0.5, (t.size ?? 3) + 0.5, (x, y) => { if (isOwned(s, x, y)) s.district[idx(x, y)] = val; });
    app.overlays.dirty = true;
  },
  up(app) { refreshBuildingDistricts(app.state); bus.emit('districts:changed'); },
});

function districtStats(state, d) {
  let pop = 0, jobs = 0, happy = 0, hn = 0, lv = 0, cells = 0;
  for (let i = 0; i < state.district.length; i++) if (state.district[i] === d.id) { cells++; lv += state.landValue[i]; }
  for (const b of state.buildings.values()) {
    if (b.district !== d.id) continue;
    for (const h of b.households || []) pop += state.households.get(h)?.members.length || 0;
    jobs += b.jobs || 0;
    if (b.happiness != null) { happy += b.happiness; hn++; }
  }
  return { pop, jobs, happy: hn ? happy / hn : null, lv: cells ? lv / cells : 0, cells };
}

registerPanel({
  key: 'districts', icon: '🗺️', title: 'Districts', order: 40,
  render(app, body, st, rerender) {
    const s = app.state;
    body.innerHTML = `<div style="display:flex;gap:6px;margin-bottom:8px"><button class="btn primary" data-a="paint">🖌 Paint districts</button><button class="btn" data-a="new">＋ New district</button></div>`;
    if (!s.districts.length) body.insertAdjacentHTML('beforeend', '<div class="muted">Districts let you name neighbourhoods, give them their own policies, and restrict services to them.</div>');
    for (const d of s.districts) {
      const st2 = districtStats(s, d);
      const el = document.createElement('div');
      el.className = 'list-item';
      el.innerHTML = `<div class="row"><span><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${d.color};margin-right:6px"></span><input type="text" value="${d.name}" data-name style="width:150px"></span><button class="btn" data-del>🗑</button></div>
        ${row('Area', `${st2.cells} cells`)}${row('Population · jobs', `${st2.pop} · ${st2.jobs}`)}${row('Happiness', st2.happy == null ? '–' : `${Math.round(st2.happy)}%`)}${row('Land value', pct(st2.lv))}
        <div class="section-title">Policies</div>
        ${DISTRICT_POLICIES.map((p) => {
          const lock = app.lockReason(p);
          const on = d.policies[p.key];
          return `<label class="row" title="${p.desc}"><span>${p.name}${p.cost ? ` <span class="muted">(${money(perWeek(p.cost))}/wk)</span>` : ''}${lock ? ` <span class="muted">🔒 ${lock}</span>` : ''}</span>
            <span>${p.value && on ? `<input type="number" min="${p.min}" max="${p.max}" value="${on}" data-val="${p.key}" style="width:52px"> ` : ''}<input type="checkbox" data-pol="${p.key}" ${on ? 'checked' : ''} ${lock ? 'disabled' : ''}></span></label>`;
        }).join('')}
        <div class="section-title">Specialisation</div>
        ${d.spec ? `<div class="row"><b>${specDef(d.spec).icon} ${specDef(d.spec).name}</b><button class="btn" data-unspec>Drop it</button></div><div class="muted" style="font-size:11px">${specDef(d.spec).effect}${(d.specProgress?.[d.spec] ?? 1) < 1 ? ' <span class="warn">It no longer has what it takes: half the bonus until it does again.</span>' : ''}</div>`
          : SPECIALISATIONS.map((sp) => {
            const prog = d.specProgress?.[sp.key] || 0;
            return `<div class="list-item" title="${sp.effect}"><div class="row"><span>${sp.icon} ${sp.name}</span>${prog >= 1 ? `<button class="btn primary" data-spec="${sp.key}">Declare</button>` : `<span class="muted num">${Math.round(prog * 100)}%</span>`}</div>${prog < 1 ? meter(prog, 'var(--blue)') : ''}<div class="muted" style="font-size:11px">${prog >= 1 ? sp.effect : `Needs ${sp.req}`}</div></div>`;
          }).join('')}`;
      el.querySelector('[data-name]').onchange = (e) => { d.name = e.target.value; };
      el.querySelector('[data-del]').onclick = () => {
        for (let i = 0; i < s.district.length; i++) if (s.district[i] === d.id) s.district[i] = 0;
        s.districts = s.districts.filter((x) => x !== d);
        refreshBuildingDistricts(s);
        app.overlays.dirty = true;
        rerender();
      };
      el.querySelectorAll('[data-pol]').forEach((c) => (c.onchange = () => {
        const p = DISTRICT_POLICIES.find((x) => x.key === c.dataset.pol);
        d.policies[p.key] = c.checked ? (p.value ? 10 : true) : false;
        s.counters.districtPolicy = true;
        s.journal.push({ day: s.time.day, kind: 'policy', text: `${d.name}: ${p.name} ${c.checked ? 'enacted' : 'repealed'}` });
        rerender();
      }));
      el.querySelectorAll('[data-val]').forEach((inp) => (inp.onchange = () => { d.policies[inp.dataset.val] = Math.max(1, Math.min(50, +inp.value)); }));
      el.querySelectorAll('[data-spec]').forEach((b) => (b.onclick = () => {
        d.spec = b.dataset.spec;
        specialisationsDaily(s, app.ctx);
        s.journal.push({ day: s.time.day, kind: 'policy', text: `${d.name} became a ${specDef(d.spec).name}` });
        app.toast(specDef(d.spec).effect, 'good', `${specDef(d.spec).icon} ${d.name}: ${specDef(d.spec).name}`);
        rerender();
      }));
      el.querySelector('[data-unspec]')?.addEventListener('click', () => { d.spec = null; specialisationsDaily(s, app.ctx); rerender(); });
      body.appendChild(el);
    }
    body.querySelector('[data-a="paint"]').onclick = () => app.tools.set({ kind: 'district', mode: 'paint', district: s.districts[0]?.id });
    body.querySelector('[data-a="new"]').onclick = () => { const d = newDistrict(s); app.tools.set({ kind: 'district', mode: 'paint', district: d.id }); rerender(); };
  },
});

registerPanel({
  key: 'policies', icon: '📜', title: 'City Policies', order: 42,
  render(app, body, st, rerender) {
    const s = app.state;
    const active = CITY_POLICIES.filter((p) => s.policies[p.key]).length;
    body.innerHTML = `<div class="muted" style="margin-bottom:8px">${active} active. District policies are set in the Districts panel; parking fees for single buildings in the inspector.</div>` +
      CITY_POLICIES.map((p) => {
        const lock = app.lockReason(p);
        return `<div class="list-item ${lock ? 'locked' : ''}"><label class="row"><b>${p.name}</b><input type="checkbox" data-k="${p.key}" ${s.policies[p.key] ? 'checked' : ''} ${lock ? 'disabled' : ''}></label>
          <div class="muted" style="font-size:11.5px">${p.desc}</div>${p.cost ? `<div class="muted" style="font-size:11px">${money(perWeek(p.cost))}/week</div>` : ''}${lock ? `<div class="muted">🔒 ${lock}</div>` : ''}</div>`;
      }).join('');
    body.querySelectorAll('[data-k]').forEach((c) => (c.onchange = () => {
      const p = CITY_POLICIES.find((x) => x.key === c.dataset.k);
      s.policies[p.key] = c.checked;
      s.journal.push({ day: s.time.day, kind: 'policy', text: `${p.name} ${c.checked ? 'enacted' : 'repealed'}` });
      app.ctx.servicesDirty = true;
      rerender();
    }));
  },
});

// Monthly policy costs
function policyCosts(state) {
  let cost = 0;
  for (const p of CITY_POLICIES) if (state.policies[p.key] && p.key !== 'cityPromotion') cost += p.cost;
  for (const d of state.districts) for (const p of DISTRICT_POLICIES) if (d.policies[p.key]) cost += p.cost;
  charge(state, 'policies', cost);
}

export const governanceFeature = {
  init(app) {
    registerSystem({ name: 'policies', every: 'day', run: policyCosts });
    registerSystem({ name: 'specialisations', every: 'day', run: specialisationsDaily });
    specialisationsDaily(app.state, app.ctx);
    bus.on('districts:changed', () => specialisationsDaily(app.state, app.ctx));
    registerCategory({ key: 'districts', icon: '🗾', name: 'Districts', order: 90, toolKind: 'district',
      direct: (a) => a.tools.set({ kind: 'district', mode: 'paint', district: a.state.districts[0]?.id }) });
    bus.on('building:add', (b) => { b.district = app.state.district[centerIdx(b)]; });
  },
};
