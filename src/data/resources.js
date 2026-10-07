// Goods and production chains. Specialized industry extracts raw materials; industry turns
// them into goods; commercial sells goods to citizens and tourists; offices make immaterial
// goods for companies and export. Prices are per unit.
export const RESOURCES = {
  grain: { name: 'Grain', kind: 'raw', price: 18, icon: '🌾' },
  wood: { name: 'Wood', kind: 'raw', price: 16, icon: '🪵' },
  ore: { name: 'Ore', kind: 'raw', price: 22, icon: '⛏️' },
  oil: { name: 'Oil', kind: 'raw', price: 26, icon: '🛢️' },
  food: { name: 'Food', kind: 'goods', inputs: { grain: 1 }, price: 44, icon: '🥫' },
  paper: { name: 'Paper', kind: 'goods', inputs: { wood: 1 }, price: 38, icon: '📄' },
  metals: { name: 'Metals', kind: 'goods', inputs: { ore: 1 }, price: 52, icon: '🔩' },
  plastics: { name: 'Plastics', kind: 'goods', inputs: { oil: 1 }, price: 50, icon: '🧴' },
  electronics: { name: 'Electronics', kind: 'goods', inputs: { metals: 0.5, plastics: 0.5 }, price: 96, icon: '💻' },
  software: { name: 'Software', kind: 'immaterial', price: 70, icon: '🧩' },
  finance: { name: 'Financial services', kind: 'immaterial', price: 75, icon: '💹' },
  media: { name: 'Media', kind: 'immaterial', price: 60, icon: '📺' },
};

export const RAW = ['grain', 'wood', 'ore', 'oil'];
export const GOODS = ['food', 'paper', 'metals', 'plastics', 'electronics'];
export const IMMATERIAL = ['software', 'finance', 'media'];
// What shops sell (and in which proportions)
export const RETAIL_MIX = { food: 0.4, paper: 0.15, plastics: 0.15, electronics: 0.3 };
