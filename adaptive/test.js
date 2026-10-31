'use strict';
const assert = require('node:assert/strict');
const E = require('./engine');
const content = require('./content');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function begin() { const s=E.create(); E.selectInterest(s,'unknown'); return s; }
function confirm(s) { E.presentation(s,'scenario','confirmed'); }
function move(s,a) { E.act(s,a); E.presentation(s,'consequence','confirmed',s.current.turns); }
function throughS2() { const s=begin(); confirm(s); move(s,'add'); E.next(s); confirm(s); move(s,'copy'); move(s,'copy'); E.next(s); confirm(s); return s; }
test('onboarding and interest and intention history',()=>{const s=begin(); assert.equal(s.current.id,'S1'); E.selectInterest(s,'planning'); E.selectIntention(s,'unknown'); E.selectIntention(s,'notice_stalled'); assert.deepEqual(s.interests.map(x=>x.value),['unknown','planning']); assert.equal(s.interests[1].previous,1); assert.deepEqual(s.intentions.map(x=>x.value),['unknown','notice_stalled']); assert.equal(s.intentions[1].previous,1);});
test('working method continued',()=>{const s=throughS2(); assert.equal(s.episodes[1].continued,true);});
test('S3 observed change after failure qualifies',()=>{const s=throughS2(); ['copy','copy','check','delete','copy'].forEach(a=>move(s,a)); assert.equal(s.current.changed,true); assert.equal(s.current.precautionary,false); assert.equal(E.offer(s),'S4A');});
test('S3 precautionary check qualifies without failure',()=>{const s=throughS2(); ['copy','check','delete','copy'].forEach(a=>move(s,a)); assert.equal(s.current.changed,false); assert.equal(s.current.precautionary,true); assert.equal(E.offer(s),'S4A');});
test('supported change is not independent',()=>{const s=throughS2(); move(s,'copy'); move(s,'copy'); E.help(s); E.presentation(s,'help','confirmed'); ['check','delete','copy'].forEach(a=>move(s,a)); assert.equal(s.current.changed,false); assert.equal(s.current.supported,true); assert.equal(E.offer(s),'S4B');});
test('unknown consequence delivery does not downgrade',()=>{const s=throughS2(); E.act(s,'copy'); E.presentation(s,'consequence','unknown',s.current.turns); E.act(s,'check'); E.presentation(s,'consequence','confirmed',s.current.turns); move(s,'delete'); move(s,'copy'); assert.equal(E.offer(s),'choice');});
test('guess success does not imply independent change',()=>{const s=throughS2(); ['delete','copy','copy'].forEach(a=>move(s,a)); assert.equal(s.current.result,'success'); assert.equal(s.current.changed,false); assert.equal(s.current.precautionary,false); assert.equal(E.offer(s),'S4B'); E.next(s,'S4A'); confirm(s); move(s,'send14'); assert.equal(s.current.result,'success'); assert.equal(s.current.known,false);});
test('failure and action limit',()=>{const s=throughS2(); ['copy','copy','copy','copy','copy'].forEach(a=>move(s,a)); assert.equal(s.current.result,'limit'); assert.equal(E.offer(s),'S4B');});
test('pause and restore without duplicate',()=>{let s=throughS2(); move(s,'copy'); E.stop(s); s=E.restore(JSON.stringify(s)); assert.throws(()=>E.act(s,'copy')); E.resume(s); move(s,'check'); move(s,'delete'); move(s,'copy'); assert.equal(s.current.result,'success'); assert.equal(s.events.filter(x=>x.type==='action' && x.episode==='S3').length,4); assert.equal(s.episodes.at(-1).result,'success');});
test('full path and raw action log',()=>{const s=throughS2(); ['copy','check','delete','copy'].forEach(a=>move(s,a)); E.next(s,'S4A'); confirm(s); move(s,'open'); move(s,'send14'); E.next(s); confirm(s); ['wait','wait','message'].forEach(a=>move(s,a)); assert.equal(s.current.changed,true); assert.deepEqual(s.events.filter(x=>x.type==='action'&&x.episode==='S5').map(x=>x.action),['wait','wait','message']); E.next(s); assert.equal(s.status,'complete'); assert.equal(s.version,E.VERSION); assert(!/intelligence|personality|rigidity|ability/i.test(JSON.stringify(s)));});
test('exhaustive bounded actions for each scenario',()=>{
  for (const id of Object.keys(E.ACTIONS)) {
    let leaves=0, successes=0, max=0;
    const root=E.create(); root.status='active'; root.episodes=[]; root.events=[];
    // Reach scenario through public transitions to test actual engine, not a duplicate model.
    const s=throughS2(); ['copy','check','delete','copy'].forEach(a=>move(s,a));
    let initial;
    if(id==='S1') initial=begin();
    else if(id==='S2') {initial=begin(); move(initial,'add'); E.next(initial);}
    else if(id==='S3') initial=throughS2();
    else { E.next(s,id==='S4B'?'S4B':'S4A'); if(id==='S5'){move(s,'send14'); E.next(s);} initial=s; }
    function walk(state) {
      const ep=state.current; max=Math.max(max,ep.turns);
      if(ep.done){leaves++; if(ep.result==='success') successes++; return;}
      for(const action of E.ACTIONS[id]) { const child=structuredClone(state); child.current=child.episodes[child.episodes.length-1]; if(child.current.delivery!=='confirmed') E.presentation(child,'scenario','confirmed'); E.act(child,action); E.presentation(child,'consequence','confirmed',child.current.turns); const event=child.events.findLast(x=>x.type==='action'); assert(content.consequences[event.consequence],event.consequence); walk(child); }
    }
    walk(initial); assert(successes>0,id); assert(max<=E.LIMITS[id],id);
    console.log(`  ${id}: terminal_paths=${leaves} success_paths=${successes} max_turns=${max}`);
  }
});
console.log(`PASS ${passed} tests`);
