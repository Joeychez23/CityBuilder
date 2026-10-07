// Inspector: click a building (or road) to see what's going on there.
import { registerPanel, row, meter, pct } from './panels.js';
import { money } from './tools.js';
import { bus } from '../core/events.js';
import { ROADS, UPGRADES, lanesText, CLASS_NAMES } from '../data/roads.js';
import { cellCapacity, junctionKind, drivewaysAt } from '../sim/traffic.js';
import { RESOURCES } from '../data/resources.js';
import { EDU_NAMES } from '../data/zones.js';
import { centerIdx, isService, covAt, serviceEfficiency, storageCap, expansionPlan, expandStorage, MAX_EXPANSIONS, buildingUpkeep, cellsOf } from '../sim/services.js';
import { truckCount, trucksOut } from '../sim/garbage.js';
import { demolishBuilding, buildingValue, REFUND_RATE } from '../sim/build.js';
import { ageGroup } from '../sim/citizens.js';
import { FACTOR_ICONS, levelFactors, levelNeed } from '../sim/wellbeing.js';
import { onSiteSpaces } from '../sim/parking.js';
import { unitsOf } from '../sim/emergency.js';
import { idx } from '../core/grid.js';
import { perWeek } from '../sim/economy.js';
import { rushCost, rushConstruction } from '../sim/construction.js';

const status = (v) => (v >= 0.95 ? '<span class="good">OK</span>' : v >= 0.5 ? `<span class="warn">${pct(v)}</span>` : `<span class="bad">${pct(v)}</span>`);

function residentsHtml(app, b) {
  const s = app.state;
  const people = [];
  for (const hid of b.households || []) {
    const hh = s.households.get(hid);
    for (const cid of hh?.members || []) { const c = s.citizens.get(cid); if (c) people.push(c); }
  }
  if (!people.length) return '';
  const sample = people.slice(0, 8);
  return `<div class="section-title">Residents (${people.length})</div>` + sample.map((c) =>
    `<div class="row"><span>${c.sick ? '🤒' : c.jail ? '🚔' : ageGroup(c.age) === 'child' ? '🧒' : ageGroup(c.age) === 'senior' ? '🧓' : '🧑'} Citizen #${c.id} · ${Math.floor(c.age)}y · ${EDU_NAMES[c.edu]}</span>
     <button class="btn" data-follow="${c.id}" style="padding:1px 6px;font-size:11px">Follow</button></div>`).join('');
}

// Level: progress toward the next one, what adds or takes points each day, or the extension
// being built
function levelHtml(app, b) {
  if (b.def.signature) return '';
  if (b.reno) {
    return `<div class="section-title">🏗️ Extending to level ${b.reno.to}</div>${meter(b.reno.progress, 'var(--yellow)')}
      <div class="muted" style="font-size:11px;margin:4px 0">It stays open while the new floors go up; the new level counts once they're done.</div>`;
  }
  if (b.level >= 5) return `<div class="section-title">Level 5 · top level</div>`;
  const need = levelNeed(b), have = Math.max(0, b.levelProgress);
  const f = levelFactors(app.state, app.ctx, b).filter(([, v]) => Math.abs(v) >= 0.05);
  const total = f.reduce((a, [, v]) => a + v, 0);
  const eta = total > 0.1 ? Math.ceil((need - have) / total) : null;
  return `<div class="section-title">Level ${b.level} → ${b.level + 1}</div>${meter(have / need, 'var(--blue)')}
    ${row('Progress', `${Math.round(have)} / ${need}${eta ? ` · about ${eta} day${eta === 1 ? '' : 's'} to go` : ''}`)}
    ${f.map(([k, v]) => row(k, `${v > 0 ? '+' : ''}${v.toFixed(1)} / day`, v > 0 ? 'good' : 'bad')).join('')}
    ${total <= 0.1 ? '<div class="bad" style="font-size:11px;margin-top:3px">Not levelling up: fix the red items above.</div>' : ''}`;
}

registerPanel({
  key: 'inspect', icon: '🔎', title: 'Inspector', order: 1, rail: false, closeOnEscape: true,
  onClose(app) { app.preview.setSelection(null); },
  render(app, body, st) {
    const s = app.state;
    const sel = st.args;
    if (!sel) { body.innerHTML = '<div class="muted">Click a building or road.</div>'; return; }
    if (sel.type === 'road') {
      const i = idx(sel.x, sel.y);
      const t = s.road[i];
      if (!t) { body.innerHTML = '<div class="muted">Nothing here anymore.</div>'; return; }
      const r = ROADS[t];
      const vol = s.roadVol[i];
      const cap = cellCapacity(s, i), jk = junctionKind(s, i);
      const dw = drivewaysAt(i);
      body.innerHTML = `<h3 style="margin:0 0 2px">${r.name}</h3><div class="muted" style="margin-bottom:8px">${CLASS_NAMES[r.cls]} · ${r.role}</div>
        ${row('Lanes', lanesText(r))}${row('Speed limit', `${r.speed} km/h`)}${row('Condition', pct(s.roadCond[i]), s.roadCond[i] < 0.5 ? 'bad' : '')}
        ${jk ? row('Junction', ['', 'Traffic lights', 'Roundabout', 'Give way (one car at a time)', 'Merge', 'Side street gives way (main road keeps going)'][jk]) : ''}
        ${dw && (r.cls === 'arterial' || r.cls === 'collector') ? row('Driveways here', `${dw} · −${Math.round(Math.min(0.3, dw * (r.cls === 'arterial' ? 0.08 : 0.04)) * 100)}% capacity`, r.cls === 'arterial' ? 'warn' : '') : ''}
        ${row('Traffic', `${vol.toFixed(1)} / ${cap.toFixed(0)} vehicles`, vol > cap ? 'bad' : '')}${meter(vol / cap, vol / cap > 0.8 ? 'var(--bad)' : 'var(--good)')}
        ${vol > cap ? '<div class="bad" style="font-size:11px">Backed up: more traffic than this road can carry. Add lanes (a bigger road), a roundabout, or another route.</div>' : ''}
        ${row('Snow', pct(s.roadSnow[i]))}${row('Noise', pct(s.noise[i]))}
        ${row('Upgrades', UPGRADES.filter((u) => s.roadUpg[i] & u.bit).map((u) => u.name).join(', ') || '–')}
        ${row('Upkeep', `${money(perWeek(r.upkeep))}/wk per cell`)}`;
      return;
    }
    const b = s.buildings.get(sel.id);
    if (!b) { body.innerHTML = '<div class="muted">This building is gone.</div>'; app.preview.setSelection(null); return; }
    app.preview.setSelection(b);
    const i = centerIdx(b);
    let html = `<h3 style="margin:0 0 2px">${b.name || b.def.name}</h3><div class="muted" style="margin-bottom:8px">${b.kind === 'zone' ? `Level ${b.level} · ${b.def.name}` : b.def.desc || ''}${b.abandoned ? ' · <span class="bad">Abandoned</span>' : ''}${b.onFire ? ' · <span class="bad">ON FIRE</span>' : ''}</div>`;
    if (b.cons) {
      // a building site: how far along it is, and (for city services) the option to rush it
      const left = Math.max(0, (1 - b.cons.progress) * b.cons.hours);
      html += `<div class="section-title">🏗️ Under construction</div>${meter(b.cons.progress, 'var(--yellow)')}
        ${row('Done', pct(b.cons.progress))}${row('Ready in', left < 1 ? 'less than an hour' : `about ${Math.ceil(left)} game hour${Math.ceil(left) === 1 ? '' : 's'}`)}
        <div class="muted" style="font-size:11px;margin:4px 0">${b.kind === 'zone' ? 'People move in (or start work) once it\'s finished.' : 'It starts working once it\'s finished. No upkeep is charged while it\'s being built.'}</div>
        ${b.kind !== 'zone' ? `<button class="btn primary" data-a="rush">⏩ Rush it · ${money(rushCost(b))}</button>` : ''}`;
      body.innerHTML = html;
      body.querySelector('[data-a="rush"]')?.addEventListener('click', () => {
        if (rushConstruction(s, b)) app.toast(`${b.name || b.def.name} is finished`, 'good', '🏗️ Rushed');
        else app.toast('Not enough money', 'bad');
        app.panels.refresh('inspect');
      });
      return;
    }

    if (b.kind === 'zone') {
      if (b.def.cat === 'res') {
        html += row('Households', `${b.households.length} / ${b.hhCap}`);
        if (b.happiness != null) html += `<div class="section-title">Happiness ${Math.round(b.happiness)}%</div>${meter(b.happiness / 100, 'var(--good)')}`;
      }
      if (b.jobs) {
        html += row('Workers', `${b.workers.length}${b.commuters ? ` + ${b.commuters} commuters` : ''} / ${b.jobs}`);
        if (b.product) html += row('Product', b.product === 'retail' ? 'Retail goods & services' : `${RESOURCES[b.product].icon} ${RESOURCES[b.product].name}`);
        if (b.profit != null) html += row('Profit (yesterday)', money(b.profit), b.profit >= 0 ? 'good' : 'bad');
        if (b.efficiency != null) html += row('Efficiency', pct(b.efficiency));
        if (b.parkingNeed) {
          html += row('Parking', `${b.parkingGot} / ${b.parkingNeed} drivers parked${onSiteSpaces(b) ? ` · ${onSiteSpaces(b)} own spaces` : ''}`, b.parkingShort > 0.25 ? 'bad' : '');
          const walkers = Math.round((b.parkWalk || 0) * b.parkingNeed), lost = Math.round((b.parkLost || 0) * b.parkingNeed);
          if (walkers || lost) html += row('No space left', `${walkers ? `${walkers} walk to work` : ''}${walkers && lost ? ' · ' : ''}${lost ? `${lost} commuter${lost === 1 ? '' : 's'} can't come` : ''}`, 'warn');
        }
      }
      if (b.salesRatio != null && b.product === 'retail') html += row('Customers', `${pct(Math.min(1, b.salesRatio))} of what it could sell`, b.salesRatio < 0.5 ? 'bad' : b.salesRatio < 0.75 ? 'warn' : 'good');
      html += levelHtml(app, b);
    } else if (isService(b)) {
      const d = b.def;
      const eff = serviceEfficiency(s, b);
      html += row('Efficiency', pct(eff), eff < 0.7 ? 'warn' : '');
      if (d.workers) html += row('Staff', `${b.workers?.length || 0} / ${d.workers}`);
      html += row('Upkeep', `${money(perWeek(buildingUpkeep(b) * (s.budgets[d.cat] ?? 100) / 100))}/wk`);
      if (d.power) html += row('Output', `${(b.output || 0).toFixed(1)} / ${d.power} MW`);
      if (d.battery) html += row('Charge', `${(b.charge || 0).toFixed(0)} / ${d.battery} MWh`);
      if (d.water) html += row('Pumping', `${Math.round(b.output || 0).toLocaleString()} / ${d.water.toLocaleString()} m³`) + row('Water quality', pct(b.waterQuality ?? 1), (b.waterQuality ?? 1) < 0.8 ? 'bad' : '');
      if (d.sewage) html += row('Sewage handled', `${Math.round(b.load || 0).toLocaleString()} / ${d.sewage.toLocaleString()} m³`);
      if (d.garbageRate) {
        html += row('Garbage trucks out', `${trucksOut(app.ctx, b)} / ${truckCount(s, b)}`) + row('Collected today', `${Math.round(b.collectedToday || 0)} t`);
        if (d.area) html += row('Area', `${b.x1 - b.x0 + 1} × ${b.y1 - b.y0 + 1} cells (${cellsOf(b)})`);
      }
      if (d.storage) {
        const cap = storageCap(b);
        const fill = (b.stored || 0) / cap;
        const perDay = (b.load || 0) * 24;
        const left = perDay > 0.5 ? Math.max(0, (cap - (b.stored || 0)) / perDay) : null;
        html += row(d.garbageRate ? 'Garbage stored' : 'Graves used', `${Math.round(b.stored || 0).toLocaleString()} / ${Math.round(cap).toLocaleString()} t`, b.full ? 'bad' : fill > 0.85 ? 'warn' : '')
          + meter(fill, b.full ? 'var(--bad)' : fill > 0.85 ? 'var(--yellow)' : 'var(--blue)')
          + row(b.full ? 'Status' : 'Full in', b.full ? '<span class="bad">full — not collecting</span>' : left == null ? '–' : `about ${Math.ceil(left)} day${Math.ceil(left) === 1 ? '' : 's'}`)
          + (d.area ? '' : row('Expansions', `${b.expansions || 0} / ${MAX_EXPANSIONS}`));
        if (d.area) {
          html += `<div style="margin:6px 0"><button class="btn ${b.full || fill > 0.7 ? 'primary' : ''}" data-a="grow">⤢ Make it bigger</button><div class="muted" style="font-size:11px;margin-top:3px">Drag more landfill area along one of its sides: every cell holds ${d.storagePerCell} t more.</div></div>`;
        } else {
          const plan = expansionPlan(s, b);
          html += `<div style="margin:6px 0"><button class="btn ${b.full || fill > 0.7 ? 'primary' : ''}" data-a="expand" ${plan.error ? 'disabled' : ''}>⤢ Expand${plan.cost ? ` · ${money(plan.cost)}` : ''}${plan.adds ? ` · +${plan.adds.toLocaleString()} t` : ''}</button>${plan.error ? `<div class="muted" style="font-size:11px;margin-top:3px">${plan.error}</div>` : ''}</div>`;
        }
      }
      if (d.students) html += row('Students', `${b.studentCount || 0} / ${d.students}`);
      if (d.patients) html += row('Patients today', `${b.patientsToday || 0} / ${d.patients}`);
      if (d.parking) {
        html += row('Cars parked (workday)', `${b.used || 0} / ${b.spaces ?? d.parking}${(b.used || 0) >= (b.spaces ?? d.parking) ? ' · full' : ''}`) + meter((b.used || 0) / (b.spaces || d.parking), (b.used || 0) >= (b.spaces ?? d.parking) ? 'var(--bad)' : 'var(--blue)');
        if (b.turnedAway) html += row('Turned away', `${b.turnedAway} driver${b.turnedAway === 1 ? '' : 's'} walk to work instead`, 'warn');
      }
      if (d.engines || d.patrol) {
        const kind = d.engines ? 'fire' : 'police';
        const busy = app.ctx.busy?.get(b.id) || 0;
        html += row(d.engines ? 'Fire engines out' : 'Police cars out', `${busy} / ${unitsOf(s, b, kind)}`);
      }
      if (d.radius) html += row('Range', `${d.radius * 8} m`);
      if (d.radius && s.districts.length) {
        html += `<div class="row"><span class="k">Serve only district</span><select data-district><option value="0">Whole city</option>${s.districts.map((x) => `<option value="${x.id}" ${b.serveDistrict === x.id ? 'selected' : ''}>${x.name}</option>`).join('')}</select></div>`;
      }
    }
    if (b.def.signature) html += `<div class="chip">★ Signature building</div> <span class="muted">${b.def.effect}</span>`;

    const kw = (v) => (v < 1 ? `${Math.round(v * 1000)} kW` : `${v.toFixed(1)} MW`);
    html += '<div class="section-title">Utilities</div>' + row('Electricity', `${b.powerUse > 0 ? `<span class="muted">${kw(b.powerUse)}</span> · ` : ''}${status(b.power)}${b.power < 0.995 && b.powerUse > 0 ? ' · <span class="bad">lights out at night</span>' : ''}`) + row('Water', status(b.water)) + row('Sewage', status(b.sewage));
    if ((b.waterPolluted || 0) > 0.15) html += row('Tap water', `<span class="bad">polluted ${pct(b.waterPolluted)}</span>`);
    html += '<div class="section-title">Area</div>' +
      row('Land value', pct(s.landValue[i])) + row('Air / ground / noise', `${pct(s.air[i])} / ${pct(s.ground[i])} / ${pct(s.noise[i])}`) +
      row('Crime', Math.round(b.crime || 0)) + row('Garbage waiting', `${(b.garbage || 0).toFixed(1)} t`) +
      row('Health / fire / police', `${pct(Math.min(1, covAt(app.ctx, 'health', b)))} / ${pct(Math.min(1, covAt(app.ctx, 'fire', b)))} / ${pct(Math.min(1, covAt(app.ctx, 'police', b)))}`);

    if (b.factors && b.def.cat === 'res') {
      const wbList = [...b.factors.wb.filter(([k]) => k !== 'Base'), ...(b.personalFactors || []).map(([k, v]) => [`${k} (avg.)`, v])]
        .filter(([, v]) => Math.abs(v) >= 0.5).sort((x, y) => x[1] - y[1]);
      html += '<div class="section-title">Well-being factors</div>' + wbList.map(([k, v]) => row(`${FACTOR_ICONS[k.replace(' (avg.)', '')] || '•'} ${k}`, `${v > 0 ? '+' : ''}${Math.round(v)}`, v > 0 ? 'good' : 'bad')).join('');
      html += '<div class="section-title">Health factors</div>' + b.factors.health.filter(([, v]) => Math.abs(v) >= 0.5 && v !== 62).map(([k, v]) => row(k, `${v > 0 ? '+' : ''}${Math.round(v)}`, v > 0 ? 'good' : 'bad')).join('');
    }
    html += residentsHtml(app, b);
    const back = Math.round(buildingValue(b) * REFUND_RATE);
    html += `<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">${b.def.permanent ? '' : `<button class="btn" data-a="bulldoze">🚜 Bulldoze${back ? ` (+${money(back)})` : ''}</button>`}
      ${b.kind !== 'zone' && (b.def.cat === 'transport' || b.def.parking) ? `<label class="row" style="gap:6px"><span class="k">Parking fee</span><input type="number" min="0" max="50" value="${b.parkingFee ?? 0}" data-parking style="width:56px"></label>` : ''}</div>`;
    body.innerHTML = html;
    body.querySelector('[data-a="bulldoze"]')?.addEventListener('click', () => {
      const r = app.undo.wrap(`Bulldozed ${b.name || b.def.name}`, () => demolishBuilding(s, b));
      if (r) app.toast(`+${money(r)} refunded`, 'good');
      app.panels.close('inspect');
    });
    body.querySelector('[data-a="grow"]')?.addEventListener('click', () => app.tools.set({ kind: 'landfill', def: b.def }));
    body.querySelector('[data-a="expand"]')?.addEventListener('click', () => {
      const r = app.undo.wrap(`Expanded ${b.name || b.def.name}`, () => expandStorage(s, b));
      if (r.error) app.toast(r.error, 'bad');
      else app.toast(`${b.name || b.def.name} now holds ${Math.round(storageCap(b)).toLocaleString()} t`, 'good', '⤢ Expanded');
      app.panels.refresh('inspect');
    });
    body.querySelector('[data-district]')?.addEventListener('change', (e) => { b.serveDistrict = +e.target.value; app.ctx.servicesDirty = true; s.counters.districtService = true; });
    body.querySelector('[data-parking]')?.addEventListener('change', (e) => { b.parkingFee = Math.max(0, Math.min(50, +e.target.value)); });
    body.querySelectorAll('[data-follow]').forEach((btn) => btn.addEventListener('click', () => app.panels.open('citizen', { id: +btn.dataset.follow })));
  },
});

bus.on('game:started', (app) => {
  bus.on('select', (sel) => {
    if (!sel) { app.panels.close('inspect'); return; }
    if (app.panels.isOpen('inspect')) app.panels.close('inspect');
    app.panels.open('inspect', sel);
  });
});
