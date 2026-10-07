// Bottom toolbar: categories open a submenu of cards; a card activates a tool.
// Categories are registered by feature modules, so each stage can add its own.
// Every menu toggles: click its button again (or the ✕ in its header, or Esc) to close it.
// The menu stays open while you use one of its tools, so you can switch straight to another
// card (say from housing to shops while zoning); clicking the active card again puts it away.
// "Less" in its header shrinks it to one row of cards (remembered); "All" shows them all again.
// Categories that start a tool directly (Bulldoze, Map Tiles...) switch that tool off again.
import { bus } from '../core/events.js';
import { tipHtml } from './hovertips.js';

// What each toolbar menu is for (shown when you hover it)
const CATEGORY_TIPS = {
  roads: 'Roads at any angle (click the start, then the end), bridges, footpaths and road upgrades like street lights, roundabouts, toll booths and Power Connectors.',
  zones: 'Paint land for homes, shops, industry and offices. Buildings grow on zoned land beside roads when there is demand. Lots let you choose the lot size and a front yard.',
  electricity: 'Power plants, batteries and power lines. Roads carry power to every building beside them; a power line feeds a road through a Power Connector.',
  water: 'Water pumps, water towers, pipes and sewage outlets. Keep sewage outlets downstream of every pump.',
  garbage: 'Landfills (drawn as an area: bigger holds more and runs more trucks), incinerators and recycling. Garbage trucks drive out to collect.',
  health: 'Clinics, hospitals and deathcare. Ambulances and hearses use the roads.',
  fire: 'Fire stations put out fires (their engines drive there), plus disaster shelters and warnings.',
  police: 'Police stations, prisons and city administration: lower crime, catch criminals, city hall.',
  education: 'Schools, colleges and universities: better educated citizens take better jobs.',
  parks: 'Parks and plazas raise land value and happiness nearby; landmarks draw tourists.',
  comms: 'Post offices and telecom: mail service and internet coverage.',
  transport: 'Parking, depots, stations and transit lines (bus, tram, train, subway), railways and the airport.',
  signature: 'Landmark buildings you unlock by reaching goals. They boost well-being around them.',
  custom: 'Buildings you made in the asset editor, and mods.',
  landscaping: 'Raise, lower, level and soften the land; plant or clear trees; paint surfaces.',
  districts: 'Paint districts and give each its own policies.',
  tiles: 'Buy more of the map, a 16 × 16 cell tile at a time (costs money and an expansion permit).',
  bulldoze: 'Click to remove one thing (a building, or one piece of road or line), drag to remove more, or switch to Area for a rectangle. You get half of what you paid back; Undo (Ctrl+Z) puts it all back.',
};

const categories = [];
export function registerCategory(cat) {
  // cat: { key, icon, name, order, items(app) -> [{ group?, name, meta, color, tool, locked?: () => string|null, onPick? }] }
  //   or { key, icon, name, order, direct(app), toolKind?, onClose?(app) } for a button that starts a tool
  categories.push(cat);
  categories.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
}

export function createToolbar(app) {
  const bar = document.getElementById('toolbar');
  const sub = document.getElementById('submenu');
  const ui = document.getElementById('ui');
  let openKey = null;
  // One row of cards instead of all of them (you choose; it's remembered)
  let compact = false;
  try { compact = localStorage.getItem('gc.menuCompact') === '1'; } catch { /* storage blocked */ }
  const setCompact = (v) => { compact = v; try { localStorage.setItem('gc.menuCompact', v ? '1' : '0'); } catch { /* storage blocked */ } };
  const syncHeight = () => ui.style.setProperty('--submenu-h', sub.classList.contains('open') ? `${sub.getBoundingClientRect().height / (app.uiScale || 1)}px` : '0px');

  function renderBar() {
    bar.innerHTML = '';
    categories.forEach((c, n) => {
      const b = document.createElement('button');
      const locked = c.locked?.(app);
      b.innerHTML = `<span class="no">${String(n + 1).padStart(2, '0')}</span><span class="ico">${c.icon}</span><span class="lbl">${c.name}</span>`;
      b.dataset.tip = tipHtml(`${c.icon} ${c.name}`, c.desc || CATEGORY_TIPS[c.key] || '', [], locked ? `🔒 ${locked}` : c.direct ? 'Click to use · click again to stop' : 'Click to open · click again to close');
      if (locked) b.classList.add('locked');
      const toolOn = c.toolKind && app.tools?.current?.kind === c.toolKind;
      if (c.key === openKey || toolOn) b.classList.add('on');
      // a dot when the menu has something newly unlocked in it
      if (c.items && c.items(app).some((it) => app.isNewUnlock?.(it.name) && !it.locked?.())) b.classList.add('has-new');

      b.onclick = () => {
        if (c.direct) {
          closeSub();
          if (toolOn) { app.tools.set({ kind: 'select' }); c.onClose?.(app); } else c.direct(app);
          renderBar();
          return;
        }
        const reopen = openKey === c.key && !sub.classList.contains('open');
        openKey = openKey === c.key && !reopen ? null : c.key;
        renderBar();
        renderSub();
      };
      bar.appendChild(b);
    });
    fit();
  }

  // Names under the icons only while they fit on one line
  function fit() {
    bar.classList.remove('icons');
    const kids = bar.children;
    if (kids.length && kids[kids.length - 1].offsetTop > kids[0].offsetTop + 4) bar.classList.add('icons');
  }

  function renderSub() {
    const c = categories.find((k) => k.key === openKey);
    if (!c) { sub.classList.remove('open'); syncHeight(); return; }
    sub.innerHTML = '';
    const items = c.items(app);
    sub.classList.toggle('compact', compact);
    const head = document.createElement('div');
    head.className = 'sub-head';
    head.innerHTML = `<span class="p-num">${String(categories.indexOf(c) + 1).padStart(2, '0')}</span><b>${c.name}</b><span class="connector"></span>
      <button class="sub-size" data-tip="${compact ? 'Show every card' : 'Shrink the menu to one row of cards'}">${compact ? 'All ▴' : 'Less ▾'}</button><button class="sub-x" title="Close (Esc)">✕</button>`;
    head.querySelector('.sub-x').onclick = closeSub;
    head.querySelector('.sub-size').onclick = () => { setCompact(!compact); renderSub(); };
    sub.appendChild(head);
    let group = null;
    for (const item of items) {
      if (item.group && item.group !== group) {
        group = item.group;
        sub.insertAdjacentHTML('beforeend', `<div class="group-title">${group}</div>`);
      }
      const card = document.createElement('button');
      card.className = 'card';
      const locked = item.locked?.();
      if (locked) card.classList.add('locked');
      if (item.isActive?.(app.tools.current)) card.classList.add('on');
      const fresh = !locked && app.isNewUnlock?.(item.name);
      if (fresh) card.classList.add('new');
      card.innerHTML = `<div class="swatch" style="background:${item.color || '#666'}"></div><div class="name">${item.name}${fresh ? ' <span class="new-badge">New</span>' : ''}</div><div class="meta">${locked ? `🔒 ${locked}` : item.meta || ''}</div>`;
      card.dataset.tip = tipHtml(item.name, item.desc || '', item.tipRows || (item.meta ? [['', item.meta]] : []), locked ? `🔒 ${locked}` : item.isActive?.(app.tools.current) ? 'Click to put it away' : item.onPick ? 'Click to open' : 'Click to use');
      if (fresh) card.addEventListener('mouseenter', () => setTimeout(() => app.markSeen?.(item.name), 900), { once: true });
      card.onclick = () => {
        if (locked) { app.toast(`${item.name}: ${locked}`, 'warn'); return; }
        app.markSeen?.(item.name);
        if (item.onPick) { item.onPick(app); return; }
        // the active card toggles its tool off; any other card switches to its tool
        if (item.isActive?.(app.tools.current)) app.tools.set({ kind: 'select' });
        else app.tools.set(item.tool);
        markActive();
      };
      sub.appendChild(card);
    }
    sub.classList.add('open');
    sub.querySelector('.card.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    syncHeight();
  }

  // Highlight the card whose tool is active
  function markActive() {
    const c = categories.find((k) => k.key === openKey);
    if (!c || !sub.classList.contains('open')) return;
    const items = c.items(app);
    sub.querySelectorAll('.card').forEach((el, n) => el.classList.toggle('on', !!items[n]?.isActive?.(app.tools.current)));
  }

  function closeSub() { openKey = null; sub.classList.remove('open'); syncHeight(); renderBar(); }

  bus.on('escape', closeSub);
  bus.on('unlocks:changed', () => { renderBar(); if (openKey) renderSub(); });
  bus.on('unlocks:seen', () => renderBar());
  // the menu stays open with its tool; putting the tool away (✕, Esc, right click) doesn't
  // close it, but Esc does (it emits 'escape')
  bus.on('tool:changed', () => { renderBar(); markActive(); });
  window.addEventListener('resize', () => { fit(); syncHeight(); });
  renderBar();
  return { renderBar, renderSub, close: closeSub, resize: () => { fit(); syncHeight(); } };
}
