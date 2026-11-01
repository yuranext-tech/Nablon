'use strict';
// Frozen A/B/C experiment engine. No transport, persistence, or interpretation.
// Actions: R (retry), ALT (alternative), INFO, STOP, TEXT (meta).
const MAX_STEPS = 6;
const WORLDS = Object.freeze({
  A: Object.freeze({ altCost: 5, retryDeliveryAt: 3 }),
  B: Object.freeze({ altCost: 3, retryDeliveryAt: null }),
  C: Object.freeze({ altCost: null, retryDeliveryAt: 1 }),
});
function start(world) {
  if (!Object.hasOwn(WORLDS, world)) throw new Error('invalid_world');
  return { world, steps: 0, retries: 0, indicator: 2, status: 'ACTIVE', outcome: null, events: [] };
}
function transition(state, action, text = null) {
  if (!state || !Object.hasOwn(WORLDS, state.world)) throw new Error('invalid_state');
  if (!['R', 'ALT', 'INFO', 'STOP', 'TEXT'].includes(action)) throw new Error('invalid_action');
  if (state.status !== 'ACTIVE') throw new Error('episode_finished');
  if (action === 'ALT' && state.world === 'C') throw new Error('alt_unavailable_in_warmup');
  const s = { ...state, events: [...state.events] };
  const before = s.steps;
  if (action === 'TEXT' || action === 'INFO') {
    s.events.push({ action, stepsBefore: before, stepsAfter: before, ...(action === 'TEXT' ? { text: String(text ?? '') } : {}) });
    return s;
  }
  if (action === 'STOP') {
    s.status = 'FINISHED'; s.outcome = 'STOPPED';
  } else if (action === 'R') {
    s.steps += 1; s.retries += 1;
    if (s.world === 'A') s.indicator = s.retries === 1 ? 2 : 1;
    if (s.world === 'B') s.indicator = 2;
    if (s.retries === WORLDS[s.world].retryDeliveryAt) {
      s.status = 'FINISHED'; s.outcome = 'DELIVERED';
    }
  } else {
    s.steps += WORLDS[s.world].altCost;
    if (s.steps <= MAX_STEPS) { s.status = 'FINISHED'; s.outcome = 'DELIVERED'; }
  }
  // Delivery on step six takes precedence over budget exhaustion.
  if (s.status === 'ACTIVE' && s.steps >= MAX_STEPS) {
    s.status = 'FINISHED'; s.outcome = 'BUDGET_EXHAUSTED';
  }
  if (s.steps > MAX_STEPS && s.outcome !== 'DELIVERED') {
    s.status = 'FINISHED'; s.outcome = 'BUDGET_EXHAUSTED';
  }
  s.events.push({ action, stepsBefore: before, stepsAfter: s.steps, indicator: s.indicator, outcome: s.outcome });
  return s;
}
function run(world, actions) {
  return actions.reduce((s, action) => transition(s, action), start(world));
}
module.exports = { MAX_STEPS, WORLDS, start, transition, run };
