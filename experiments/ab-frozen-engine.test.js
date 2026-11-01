'use strict';
const assert=require('node:assert/strict');
const {start,transition,run}=require('./ab-frozen-engine');
function check(world,actions,steps,outcome){const s=run(world,actions);assert.equal(s.steps,steps,world+':'+actions.join(',')+' steps');assert.equal(s.outcome,outcome,world+':'+actions.join(',')+' outcome');}
check('A',['R','R','R'],3,'DELIVERED');
check('A',['ALT'],5,'DELIVERED');
check('A',['R','ALT'],6,'DELIVERED');
check('A',['R','R','ALT'],7,'BUDGET_EXHAUSTED');
check('B',['ALT'],3,'DELIVERED');
check('B',['R','R','ALT'],5,'DELIVERED');
assert.equal(run('B',['R','R']).outcome,null);
check('C',['R'],1,'DELIVERED');
assert.throws(()=>transition(start('C'),'ALT'),/alt_unavailable/);
const a=transition(transition(start('A'),'INFO'),'TEXT','hello');
assert.equal(a.steps,0);assert.equal(a.events[1].text,'hello');assert.equal(a.status,'ACTIVE');
assert.equal(transition(start('A'),'R').indicator,2);
assert.equal(run('A',['R','R']).indicator,1);
assert.equal(run('B',['R','R','R']).indicator,2);
assert.equal(transition(start('B'),'STOP').outcome,'STOPPED');
assert.throws(()=>transition(run('A',['R','ALT']),'R'),/episode_finished/);
for(const world of ['A','B','C'])for(const first of ['R','INFO','STOP','TEXT',...(world==='C'?[]:['ALT'])]){
 const s=transition(start(world),first);
 if(['INFO','TEXT','STOP'].includes(first))assert.equal(s.steps,0);
 if(s.status==='FINISHED')assert.throws(()=>transition(s,'R'),/episode_finished/);
}
console.log('PASS frozen A/B/C contract tests');
