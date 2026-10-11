// Progression: XP, milestones and their rewards, the development tree, unlock checks,
// and buying map tiles with expansion permits. Buildings, roads and transport unlock by
// themselves when you reach their milestone (they show up in the menus marked NEW); the
// development tree is for perks.
import { MILESTONES, DEV_TREE, DEV_NODES, TIER_COST } from '../data/progression.js';
import { registerPanel, row, meter, tabs } from '../ui/panels.js';
import { registerCategory } from '../ui/toolbar.js';
import { registerTool, money } from '../ui/tools.js';
import { registerSystem } from '../sim/simulation.js';
import { TILE, TILES, idx } from '../core/grid.js';
import { spend } from '../sim/build.js';
import { bus } from '../core/events.js';
import { SERVICE_LIST } from '../data/services.js';
import { TRANSPORT_LIST, LINE_TYPES } from '../data/transport.js';
import { ZONE_LIST } from '../data/zones.js';
import { ROAD_LIST, UPGRADES } from '../data/roads.js';
import { difficultyOf } from '../data/difficulty.js';
import { BOUGHT_LANDMARKS } from '../data/wonders.js';

const devNode = (key) => DEV_NODES.find((n) => n.key === key);

// Everything that unlocks at a milestone, by the name it has in the build menus
function unlockedAt(milestone) {
  const out = [];
  for (const d of [...ZONE_LIST, ...ROAD_LIST, ...UPGRADES, ...SERVICE_LIST, ...TRANSPORT_LIST, ...BOUGHT_LANDMARKS]) if ((d.milestone || 0) === milestone) out.push(d.name);
  for (const d of Object.values(LINE_TYPES)) if ((d.milestone || 0) === milestone) out.push(`${d.name} line`);
  if (milestone === 5) out.push('Railway', 'Railway bridge');
  if (milestone === 8) out.push('Subway tunnel');
  return out;
}
// Development nodes that only unlock buildings come with their milestone now
const nodeOwned = (P, n) => P.dev.includes(n.key) || (!n.perk && P.milestone >= (n.milestone || 0));

export function tilePrice(state, tx, ty) {
  let land = 0, res = 0;
  for (let y = ty * TILE; y < (ty + 1) * TILE; y++) for (let x = tx * TILE; x < (tx + 1) * TILE; x++) {
    const i = idx(x, y);
    if (!state.water[i]) land++;
    res += state.ore[i] + state.oil[i] + state.fertile[i] * 0.5 + (state.forestMax[i] ? 0.3 : 0);
  }
  const owned = state.tiles.reduce((a, v) => a + v, 0);
  return Math.round((15000 + land * 90 + res * 25) * (1 + (owned - 9) * 0.06) / 1000) * 1000;
}
function tileAdjacent(state, tx, ty) {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = tx + dx, y = ty + dy;
    if (x >= 0 && y >= 0 && x < TILES && y < TILES && state.tiles[y * TILES + x]) return true;
  }
  return false;
}

registerTool('tile', {
  enter(app) { app.overlays.setTileMode(true); },
  exit(app) { app.overlays.setTileMode(false); },
  options(app, t, el) {
    const p = app.state.progression;
    el.innerHTML = `<h4>Map tiles</h4>${row('Expansion permits', p.permits)}${row('Owned tiles', `${app.state.tiles.reduce((a, v) => a + v, 0)} / ${TILES * TILES}`)}
      <p class="muted">Click a tile next to your land to buy it. Each tile costs money and one permit (permits come with milestones).</p>`;
  },
  hover(app, t, p) {
    const s = app.state;
    const tx = Math.floor(p.cx / TILE), ty = Math.floor(p.cy / TILE);
    const cells = [];
    for (let y = ty * TILE; y < (ty + 1) * TILE; y += 1) for (let x = tx * TILE; x < (tx + 1) * TILE; x += 1) if (x % 2 === 0 && y % 2 === 0) cells.push([x, y, s.tiles[ty * TILES + tx] ? '#5fd38a' : tileAdjacent(s, tx, ty) ? '#4fc3ff' : '#ff6b5a']);
    app.preview.setCells(cells);
    if (s.tiles[ty * TILES + tx]) app.tools.showTip('Already owned');
    else app.tools.showTip(`Tile ${tx + 1},${ty + 1} · ${money(tilePrice(s, tx, ty))} + 1 permit${tileAdjacent(s, tx, ty) ? '' : '<br><span class="bad">Must border your land</span>'}`);
  },
  up(app, t, a, p) {
    const s = app.state;
    const tx = Math.floor(p.cx / TILE), ty = Math.floor(p.cy / TILE);
    if (s.tiles[ty * TILES + tx] || !tileAdjacent(s, tx, ty)) return;
    if (s.progression.permits < 1 && !s.options.unlockAll) { app.toast('No expansion permits left. Reach the next milestone to get more.', 'bad'); return; }
    if (!spend(s, tilePrice(s, tx, ty), 'tiles')) { app.toast('Not enough money', 'bad'); return; }
    if (!s.options.unlockAll) s.progression.permits--;
    s.tiles[ty * TILES + tx] = 1;
    s.counters.tilesBought = (s.counters.tilesBought || 0) + 1;
    app.overlays.dirty = true;
    app.ctx.netDirty = true;
    bus.emit('tiles:changed');
    app.toast(`You now own ${s.tiles.reduce((a2, v) => a2 + v, 0)} tiles`, 'good', 'Land purchased');
    app.tools.renderOptions();
    this.hover(app, t, p);
  },
});

registerPanel({
  key: 'progression', icon: '🏆', title: 'Progression', order: 5,
  badge: (app) => app.state.progression.devPoints > 0,
  render(app, body, st, rerender) {
    const s = app.state;
    const P = s.progression;
    body.innerHTML = '';
    const tab = tabs(body, st, [['milestones', 'Milestones'], ['dev', `Development (${P.devPoints})`]], rerender);
    const el = document.createElement('div');
    el.style.paddingTop = '8px';
    body.appendChild(el);
    if (tab === 'milestones') {
      const next = MILESTONES[P.milestone + 1];
      el.innerHTML = `<div class="section-title">${MILESTONES[P.milestone].name}${next ? ` → ${next.name}` : ''}</div>
        ${next ? `${meter((P.xp - MILESTONES[P.milestone].xp) / (next.xp - MILESTONES[P.milestone].xp))}${row('XP', `${Math.floor(P.xp)} / ${next.xp}`)}` : '<div class="good">Final milestone reached!</div>'}
        ${row('Development points', P.devPoints)}${row('Expansion permits', P.permits)}${row('Loan limit', money(P.loanLimit ?? 100000))}
        <div class="muted" style="font-size:11px;margin:4px 0">XP comes from population and happiness every 1.5 hours, and from building roads, services and growing buildings.</div>
        <div class="section-title">All milestones</div>` +
        MILESTONES.slice(1).map((m, k) => `<div class="list-item ${k + 1 <= P.milestone ? 'done' : 'locked'}"><div class="row"><b>${k + 1}. ${m.name}</b><span class="muted num">${m.xp.toLocaleString()} XP</span></div>
          <div class="muted" style="font-size:11px">${money(m.money)} · ${m.dev} dev pts · ${m.permits} permits${m.unlocks ? `<br>Unlocks: ${m.unlocks}` : ''}</div></div>`).join('');
    } else {
      el.innerHTML = `<div class="muted" style="margin-bottom:6px">Spend development points on perks. Tiers cost 1, 2, 4 and 8 points. New buildings unlock by themselves when you reach their milestone.</div>`;
      for (const [group, nodes] of Object.entries(DEV_TREE)) {
        el.insertAdjacentHTML('beforeend', `<div class="section-title">${group}</div>`);
        for (const n of nodes) {
          const owned = nodeOwned(P, n) || s.options.unlockAll;
          const reqOk = (n.requires || []).every((r) => nodeOwned(P, devNode(r)));
          const msOk = P.milestone >= (n.milestone || 0);
          const cost = TIER_COST[n.tier];
          const item = document.createElement('div');
          item.className = `list-item ${owned ? 'done' : !reqOk || !msOk ? 'locked' : ''}`;
          if (!n.perk) {
            // a building unlock: it comes with the milestone, nothing to buy
            item.innerHTML = `<div class="row"><span><b>${n.name}</b></span>${owned ? '<span class="good">✓ unlocked</span>' : `<span class="muted">milestone ${n.milestone}</span>`}</div>
              <div class="muted" style="font-size:11px">New buildings, unlocked automatically at milestone ${n.milestone} (${MILESTONES[n.milestone]?.name || ''})</div>`;
            el.appendChild(item);
            continue;
          }
          item.innerHTML = `<div class="row"><span><b>${n.name}</b> <span class="chip">Tier ${n.tier}</span></span>
            ${owned ? '<span class="good">✓</span>' : `<button class="btn ${P.devPoints >= cost && reqOk && msOk ? 'primary' : ''}" ${P.devPoints >= cost && reqOk && msOk ? '' : 'disabled'}>${cost} pt${cost > 1 ? 's' : ''}</button>`}</div>
            <div class="muted" style="font-size:11px">${n.perk}${!msOk ? ` · needs milestone ${n.milestone}` : ''}${!reqOk ? ` · requires ${(n.requires || []).map((r) => devNode(r).name).join(', ')}` : ''}</div>`;
          item.querySelector('button')?.addEventListener('click', () => {
            P.devPoints -= cost;
            P.dev.push(n.key);
            s.journal.push({ day: s.time.day, kind: 'milestone', text: `Developed ${n.name}` });
            bus.emit('unlocks:changed');
            app.ctx.servicesDirty = true;
            rerender();
            app.panels.renderRail();
          });
          el.appendChild(item);
        }
      }
    }
  },
});

function reachMilestones(app) {
  const s = app.state;
  const P = s.progression;
  while (MILESTONES[P.milestone + 1] && P.xp >= MILESTONES[P.milestone + 1].xp) {
    P.milestone++;
    const m = MILESTONES[P.milestone];
    s.money += m.money;
    P.devPoints += m.dev;
    P.permits += m.permits;
    P.loanLimit = m.loan;
    s.journal.push({ day: s.time.day, kind: 'milestone', text: `Milestone reached: ${m.name}` });
    // everything this milestone unlocks is ready to build right away (marked NEW in the menus)
    const fresh = unlockedAt(P.milestone);
    P.newUnlocks = [...new Set([...(P.newUnlocks || []), ...fresh])];
    app.toast(`+${money(m.money)}, ${m.dev} development point${m.dev > 1 ? 's' : ''}, ${m.permits} expansion permit${m.permits > 1 ? 's' : ''}${fresh.length ? `<br>Now you can build: ${fresh.join(', ')}` : ''}`, 'good', `🏆 ${m.name}!`);
    bus.emit('unlocks:changed');
    bus.emit('milestone', P.milestone);
    app.panels.renderRail();
  }
}

export const progressionFeature = {
  init(app) {
    const s = app.state;
    const P = s.progression;
    P.loanLimit = P.loanLimit ?? MILESTONES[P.milestone].loan;
    // Locked until its milestone; nothing else to buy or research
    app.lockReason = (def) => {
      if (!def || s.options.unlockAll) return null;
      if (def.milestone && def.milestone > P.milestone) return `Milestone ${def.milestone}: ${MILESTONES[def.milestone].name}`;
      return null;
    };
    // NEW badges in the build menus, until you've looked at the item
    app.isNewUnlock = (name) => !s.options.unlockAll && (P.newUnlocks || []).includes(name);
    app.markSeen = (name) => {
      if (!P.newUnlocks?.includes(name)) return;
      P.newUnlocks = P.newUnlocks.filter((x) => x !== name);
      bus.emit('unlocks:seen');
    };
    app.progressInfo = () => {
      const cur = MILESTONES[P.milestone], next = MILESTONES[P.milestone + 1];
      if (!next) return { name: cur.name, xp: P.xp, need: cur.xp, frac: 1 };
      return { name: `${P.milestone}. ${cur.name}`, xp: P.xp, need: next.xp, frac: (P.xp - cur.xp) / (next.xp - cur.xp) };
    };
    bus.on('xp', ({ amount }) => { P.xp += amount * difficultyOf(app.state).xp; reachMilestones(app); });
    // Passive XP every 1.5 in-game hours from population and happiness
    let steps = 0;
    registerSystem({
      name: 'xp', every: 'step', run: (state) => {
        if (++steps % 9) return;
        const pop = state.citizens.size;
        const happy = state.stats.happiness ?? 50;
        const gain = ((pop / 60) * (0.5 + happy / 100) + Math.min(5, pop / 20)) * difficultyOf(state).xp;
        if (gain > 0) { P.xp += gain; reachMilestones(app); }
      },
    });
    // Research center: a development point every week (the particle collider: two more,
    // while it runs)
    registerSystem({ name: 'research', every: 'week', run: (state, ctx) => {
      let pts = [...state.buildings.values()].some((b) => b.def.research === true && !b.cons) ? 1 : 0;
      pts += ctx.wonders?.research || 0;
      if (pts) { P.devPoints += pts; app.panels.renderRail(); }
    } });
    registerCategory({ key: 'tiles', icon: '🧩', name: 'Map Tiles', order: 95, toolKind: 'tile', direct: (a) => a.tools.set({ kind: 'tile' }) });
  },
};
