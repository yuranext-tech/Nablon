'use strict';

// Standalone simulation. State and event history are JSON-serializable.
const VERSION = 'adaptive-set-v0.1';
const LIMITS = { S1: 4, S2: 4, S3: 5, S4A: 4, S4B: 4, S5: 5 };
const ACTIONS = {
  S1: ['add', 'view'], S2: ['copy', 'settings'],
  S3: ['copy', 'check', 'delete'],
  S4A: ['open', 'calendar', 'send12', 'send14'],
  S4B: ['review', 'send12', 'send14'],
  S5: ['wait', 'check', 'allow', 'message'],
};
const interests = ['planning', 'unknown'];
function create() {
  return { version: VERSION, status: 'choosing', current: null, episodes: [], interests: [], intentions: [], events: [] };
}
function emit(s, type, payload) { s.events.push({ seq: s.events.length + 1, type, ...payload }); }
function selectIntention(s, value) {
  if (!['notice_stalled', 'continue_working', 'unknown'].includes(value)) throw Error('invalid intention');
  const entry = { id: s.intentions.length + 1, value, previous: s.intentions.at(-1)?.id ?? null };
  s.intentions.push(entry); emit(s, 'intention_selected', { ...entry });
}
function selectInterest(s, value) {
  if (!interests.includes(value)) throw Error('invalid interest');
  const previous = s.interests.length ? s.interests[s.interests.length - 1].id : null;
  const entry = { id: s.interests.length + 1, value, previous };
  s.interests.push(entry); emit(s, 'interest_selected', { ...entry });
  if (s.status === 'choosing') { s.status = 'active'; start(s, 'S1'); }
}
function start(s, id) {
  const ep = { id, scenario_version: VERSION, turns: 0, done: false, result: null,
    phase: id === 'S2' || id === 'S3' ? '1' : 'start', freed: false, known: false,
    delivery: 'unknown', consequenceDelivery: 'unknown', help: 'none', noProgress: false, noProgressObserved: false, checked: false,
    continued: false, changed: false, precautionary: false, supported: false, observationUnknown: false };
  s.episodes.push(ep); s.current = ep; emit(s, 'episode_started', { episode: id });
}
function presentation(s, kind, delivery, turn) {
  if (!['scenario','help','consequence'].includes(kind) || !['confirmed','unknown'].includes(delivery)) throw Error('invalid delivery');
  const ep = kind === 'consequence' ? s.current : active(s);
  if (!ep || s.status !== 'active') throw Error('episode not active');
  if (kind === 'scenario') {
    if (ep.done || ep.turns !== 0) throw Error('scenario already started');
    ep.delivery = delivery;
  } else if (kind === 'help') {
    if (ep.help !== 'pending') throw Error('help not requested');
    ep.help = delivery;
  } else {
    if (!Number.isInteger(turn) || turn !== ep.turns || turn < 1) throw Error('invalid consequence turn');
    if (ep.consequenceDelivery !== 'unknown') throw Error('consequence already confirmed');
    ep.consequenceDelivery = delivery;
    if (delivery === 'confirmed') {
      const last = s.events.findLast(x => x.type === 'action' && x.episode === ep.id && x.turn === turn);
      if (last?.consequence === 'copy_no_progress' || last?.consequence === 'call_failed') ep.noProgressObserved = true;
    }
  }
  emit(s,'presentation',{episode:ep.id,kind,delivery,...(kind==='consequence'?{turn}:{})});
}
function active(s) { if (s.status !== 'active' || !s.current || s.current.done) throw Error('episode not active'); return s.current; }
function help(s) { const e = active(s); if (e.help !== 'none') throw Error('help already requested'); e.help = 'pending'; emit(s, 'help_requested', { episode: e.id }); }
function act(s, action) {
  const e = active(s); if (!ACTIONS[e.id].includes(action)) throw Error('invalid action');
  if (e.delivery !== 'confirmed') throw Error('scenario not confirmed');
  if (e.help === 'pending') throw Error('help pending');
  const priorNoProgress = e.noProgressObserved;
  const independentlyObserved = e.delivery === 'confirmed' && e.consequenceDelivery === 'confirmed' && e.help === 'none';
  if (e.turns > 0 && e.consequenceDelivery !== 'confirmed') e.observationUnknown = true;
  e.turns++; let consequence = '', progress = false, success = false, failure = false;
  if (e.id === 'S1') { success = action === 'add'; consequence = success ? 'address_added' : 'address_missing'; }
  if (e.id === 'S2') {
    if (action === 'copy') { progress = true; if (e.phase === '1') { e.phase = '2'; consequence = 'two_of_three'; } else { success = true; consequence = 'three_of_three'; if (independentlyObserved) e.continued = true; } }
    else consequence = 'count_unchanged';
  }
  if (e.id === 'S3') {
    if (action === 'copy' && e.phase === '1') { e.phase = '2'; progress = true; consequence = 'two_of_three'; }
    else if (action === 'copy' && e.freed) { success = true; consequence = 'three_of_three'; }
    else if (action === 'copy') { e.noProgress = true; consequence = 'copy_no_progress'; }
    else if (action === 'check') { e.checked = true; consequence = e.phase === '1' ? 'one_space_available' : e.freed ? 'space_available' : 'storage_full'; if (e.phase === '2' && !priorNoProgress && independentlyObserved) e.precautionary = true; }
    else { e.freed = true; consequence = 'draft_deleted'; }
    if ((action === 'check' || action === 'delete') && priorNoProgress && independentlyObserved) e.changed = true;
  }
  if (e.id === 'S4A' || e.id === 'S4B') {
    if (action === 'send14') { success = true; consequence = 'correct_room_sent'; }
    else if (action === 'send12') { consequence = 'old_room_sent'; if (e.id === 'S4A') failure = true; }
    else { if (action === 'open') e.known = true; consequence = action === 'open' || action === 'review' ? 'new_room_14' : 'old_calendar_12'; }
  }
  if (e.id === 'S5') {
    if (action === 'message' || (action === 'wait' && e.freed)) { success = true; consequence = 'delivery_received'; }
    else if (action === 'wait') { e.noProgress = true; consequence = 'call_failed'; }
    else if (action === 'check') consequence = e.freed ? 'calls_enabled' : 'calls_blocked';
    else { e.freed = true; consequence = 'calls_enabled'; }
    if (priorNoProgress && action !== 'wait' && independentlyObserved) e.changed = true;
  }
  if (e.help === 'confirmed' && action) e.supported = true;
  emit(s, 'action', { episode: e.id, turn: e.turns, action, consequence, help: e.help, delivery: e.delivery });
  e.consequenceDelivery = 'unknown';
  if (success || failure || e.turns >= LIMITS[e.id]) { e.done = true; e.result = success ? 'success' : failure ? 'failure' : 'limit'; emit(s, 'episode_finished', { episode: e.id, result: e.result }); }
}
function offer(s) {
  if (s.status !== 'active' || !s.current?.done || s.current.id !== 'S3') throw Error('not at branch');
  const s2 = s.episodes.find(x => x.id === 'S2'), s3 = s.current;
  const uncertain = s2.delivery !== 'confirmed' || s3.delivery !== 'confirmed' || s2.observationUnknown || s3.observationUnknown || ['unknown','pending'].includes(s2.help) || ['unknown','pending'].includes(s3.help);
  const qualified = s2.continued && (s3.changed || s3.precautionary) && s3.result === 'success';
  // Unknown evidence is neutral: keep ordinary choice available, never force a lower level.
  return uncertain ? 'choice' : qualified ? 'S4A' : 'S4B';
}
function next(s, choice) {
  if (s.status !== 'active' || !s.current?.done) throw Error('episode not finished');
  const id = s.current.id;
  if (id === 'S3') { if (!['S4A','S4B'].includes(choice)) throw Error('explicit branch choice required'); emit(s, 'branch_selected', { offer: offer(s), choice }); start(s, choice); }
  else if (id === 'S5') { s.current = null; s.status = 'complete'; emit(s, 'set_completed', {}); }
  else start(s, { S1:'S2', S2:'S3', S4A:'S5', S4B:'S5' }[id]);
}
function stop(s) { if (s.status !== 'active') throw Error('not active'); s.status = 'paused'; emit(s, 'paused', {}); }
function resume(s) { if (s.status !== 'paused') throw Error('not paused'); s.status = 'active'; emit(s, 'resumed', {}); }
function restore(serialized) {
  const s = JSON.parse(serialized);
  if (s.version !== VERSION || !Array.isArray(s.episodes) || !Array.isArray(s.events)) throw Error('invalid saved state');
  if (s.current) {
    const last = s.episodes[s.episodes.length - 1];
    if (!last || last.id !== s.current.id) throw Error('invalid current episode');
    s.current = last;
  }
  if (!['choosing','active','paused','complete'].includes(s.status) || !Array.isArray(s.interests) || !Array.isArray(s.intentions)) throw Error('invalid saved state');
  for (const e of s.episodes) {
    if (!ACTIONS[e.id] || !Number.isInteger(e.turns) || e.turns < 0 || e.turns > LIMITS[e.id]) throw Error('invalid episode turns');
    const acts = s.events.filter(x => x.type === 'action' && x.episode === e.id);
    if (acts.length !== e.turns || acts.some((x,i) => x.turn !== i+1 || !ACTIONS[e.id].includes(x.action))) throw Error('invalid action history');
    if (e.done && !['success','failure','limit'].includes(e.result)) throw Error('invalid terminal result');
    if (!e.done && e.result !== null) throw Error('invalid unfinished result');
  }
  return s;
}
module.exports = { VERSION, LIMITS, ACTIONS, create, selectInterest, selectIntention, presentation, help, act, offer, next, stop, resume, restore };
