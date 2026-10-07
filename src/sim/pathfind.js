// A* over grid networks (roads, tram tracks, rails, subway tunnels). Typed arrays with a
// generation stamp so nothing is reallocated between searches.
import { N, DIRS, inBounds, idx } from '../core/grid.js';

const NN = N * N;
const g = new Float32Array(NN);
const came = new Int32Array(NN);
const stamp = new Uint32Array(NN);
const closed = new Uint32Array(NN);
let gen = 1;

// Binary min-heap of [f, cell]
const heapF = new Float32Array(NN * 4);
const heapI = new Int32Array(NN * 4);
let size = 0;
function push(f, i) {
  let k = size++;
  heapF[k] = f; heapI[k] = i;
  while (k > 0) {
    const p = (k - 1) >> 1;
    if (heapF[p] <= heapF[k]) break;
    [heapF[p], heapF[k]] = [heapF[k], heapF[p]];
    [heapI[p], heapI[k]] = [heapI[k], heapI[p]];
    k = p;
  }
}
function pop() {
  const top = heapI[0];
  size--;
  if (size > 0) {
    heapF[0] = heapF[size]; heapI[0] = heapI[size];
    let k = 0;
    for (;;) {
      const l = 2 * k + 1, r = l + 1;
      let m = k;
      if (l < size && heapF[l] < heapF[m]) m = l;
      if (r < size && heapF[r] < heapF[m]) m = r;
      if (m === k) break;
      [heapF[m], heapF[k]] = [heapF[k], heapF[m]];
      [heapI[m], heapI[k]] = [heapI[k], heapI[m]];
      k = m;
    }
  }
  return top;
}

// passable(i) -> bool ; cost(from, to, dir) -> step cost (>0) or Infinity ; minCost: cheapest
// possible step (keeps the heuristic admissible). Returns an array of cell indices or null.
export function astar(start, goal, passable, cost, minCost = 1, maxNodes = NN) {
  if (start === goal) return [start];
  gen++;
  if (gen === 0xffffffff) { stamp.fill(0); closed.fill(0); gen = 1; }
  size = 0;
  const gx = goal % N, gy = (goal / N) | 0;
  stamp[start] = gen; g[start] = 0; came[start] = -1;
  push(0, start);
  let expanded = 0;
  while (size > 0) {
    const cur = pop();
    if (closed[cur] === gen) continue;
    closed[cur] = gen;
    if (cur === goal) {
      const path = [];
      for (let c = goal; c !== -1; c = came[c]) path.push(c);
      return path.reverse();
    }
    if (++expanded > maxNodes) return null;
    const x = cur % N, y = (cur / N) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
      if (!inBounds(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (closed[ni] === gen || !passable(ni)) continue;
      const step = cost(cur, ni, d);
      if (!(step < Infinity)) continue;
      const ng = g[cur] + step;
      if (stamp[ni] !== gen || ng < g[ni]) {
        stamp[ni] = gen; g[ni] = ng; came[ni] = cur;
        const h = (Math.abs(nx - gx) + Math.abs(ny - gy)) * minCost;
        push(ng + h, ni);
      }
    }
  }
  return null;
}

export function pathLength(path) { return path ? path.length - 1 : Infinity; }
