// Difficulty: picked when you found a city, and changeable later in the Game panel (the
// starting money only counts for a new city). Normal is the balance the game is tuned for.
//   money: starting funds · income: × tax income · subsidy: × the early government subsidy
//   interest: + loan interest (% a year) · xp: × milestone XP · mood: + citizens' well-being
//   disasters: × how often lightning, wildfires and tornadoes strike
export const DIFFICULTIES = {
  easy: { name: 'Relaxed', blurb: 'More money to start, higher tax income, patient citizens and fewer disasters.', money: 1000000, income: 1.2, subsidy: 1.3, interest: -1, xp: 1.25, mood: 4, disasters: 0.5 },
  normal: { name: 'Normal', blurb: 'The balance the game is made for.', money: 600000, income: 1, subsidy: 1, interest: 0, xp: 1, mood: 0, disasters: 1 },
  hard: { name: 'Challenging', blurb: 'Less money to start, lower tax income, dearer loans and citizens who expect more.', money: 350000, income: 0.85, subsidy: 0.6, interest: 1.5, xp: 0.85, mood: -4, disasters: 1.5 },
  expert: { name: 'Expert', blurb: 'Tight money from day one, thin tax income, costly loans, demanding citizens and twice the disasters.', money: 200000, income: 0.7, subsidy: 0.3, interest: 3, xp: 0.7, mood: -8, disasters: 2 },
};
export const DIFFICULTY_KEYS = Object.keys(DIFFICULTIES);
export const difficultyOf = (state) => DIFFICULTIES[state.options?.difficulty] || DIFFICULTIES.normal;

// The differences from Normal, for the menu and the Game panel
export function difficultyRows(d) {
  const pct = (v) => `${v > 1 ? '+' : '−'}${Math.round(Math.abs(v - 1) * 100)}%`;
  const rows = [['Starting money', `₡${d.money.toLocaleString()}`]];
  if (d.income !== 1) rows.push(['Tax income', pct(d.income)]);
  if (d.interest) rows.push(['Loan interest', `${d.interest > 0 ? '+' : '−'}${Math.abs(d.interest)}% a year`]);
  if (d.xp !== 1) rows.push(['Milestone progress', pct(d.xp)]);
  if (d.mood) rows.push(['Citizen well-being', `${d.mood > 0 ? '+' : '−'}${Math.abs(d.mood)}`]);
  if (d.disasters !== 1) rows.push(['Natural disasters', `× ${d.disasters}`]);
  return rows;
}
