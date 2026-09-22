// Nablon MVP runtime v0.1
const crypto = require('crypto');
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const { SCENES, QUESTION_ANSWERS } = require('./probes');

const bot = new Telegraf(process.env.BOT_TOKEN);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ROUTER_VERSION = 'mvp-router-v0.1';

const START_TEXT = 'Nablon\nТренажёр здравого смысла.\n\nКороткие ситуации из обычной жизни.\nНапиши, что думаешь и что сделаешь — как в жизни.\n\nОбычно это занимает несколько минут.';
const START_BUTTON = Markup.inlineKeyboard([[Markup.button.callback('Начать', 'start_training')]]);
const ASK_BUTTON = Markup.inlineKeyboard([[Markup.button.callback('Задать вопрос', 'ask')]]);
const QUESTION_BUTTONS = Markup.inlineKeyboard([
  [Markup.button.callback('Зачем это?', 'q:purpose')],
  [Markup.button.callback('Почему ты это спрашиваешь?', 'q:why')],
  [Markup.button.callback('Покажи другой пример', 'q:example')],
  [Markup.button.callback('Как это применить в жизни?', 'q:life')],
]);
const RESTART_BUTTON = Markup.inlineKeyboard([[Markup.button.callback('Пройти ещё раз', 'start_training')]]);

function id(prefix) { return prefix + '_' + crypto.randomUUID(); }

async function userFor(tgId) {
  const r = await pool.query(
    'INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO UPDATE SET last_active_at=NOW() RETURNING *',
    [tgId]
  );
  return r.rows[0];
}
async function activeSession(userId) {
  const r = await pool.query("SELECT * FROM nablon_sessions WHERE user_id=$1 AND status='ACTIVE' ORDER BY started_at DESC LIMIT 1", [userId]);
  return r.rows[0] || null;
}
async function event(client, user, session, episode, name, turn, payload={}) {
  await client.query(
    'INSERT INTO nablon_events (user_id,session_id,episode_id,event_name,turn_index,payload) VALUES ($1,$2,$3,$4,$5,$6)',
    [user.id,session.id,episode.id,name,turn,JSON.stringify(payload)]
  );
}
function routeLocal(text) {
  const action = /\b(сделаю|сделать|напишу|позвоню|пойду|закажу|подожду|спрошу|проверю|начну|отложу|отменю|решу|буду|не буду|сначала|потом)\b/i.test(text);
  const explain = /\b(потому что|так как|из-за|думаю|мне кажется|причина|поскольку|скорее всего|видимо)\b/i.test(text);
  if (action) return { c:'ACTION', confidence: explain ? .55 : .72 };
  if (explain) return { c:'EXPLAIN', confidence:.72 };
  return { c:'UNCLEAR', confidence:.4 };
}
async function route(text, prompt) {
  if (!process.env.OPENAI_API_KEY) return routeLocal(text);
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST',
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.OPENAI_API_KEY},
      body:JSON.stringify({
        model:process.env.OPENAI_MODEL || 'gpt-4o-mini', temperature:0,
        response_format:{type:'json_object'},
        messages:[
          {role:'system',content:'Return JSON only: {"class":"ACTION"|"EXPLAIN"|"UNCLEAR","confidence":0..1}. Classify only current-dialogue routing. ACTION contains a decision/action; EXPLAIN is mainly an explanation; UNCLEAR otherwise. Do not judge correctness, intelligence, motives or personality.'},
          {role:'user',content:'Scene:\n'+prompt+'\n\nResponse:\n'+text}
        ]
      })
    });
    if (!r.ok) return routeLocal(text);
    const j=JSON.parse((await r.json()).choices?.[0]?.message?.content || '{}');
    if (!['ACTION','EXPLAIN','UNCLEAR'].includes(j.class)) return routeLocal(text);
    return {c:j.class,confidence:Number.isFinite(Number(j.confidence))?Number(j.confidence):.5};
  } catch(e) { console.error('router fallback:',e.message); return routeLocal(text); }
}
function scene(ep) { return SCENES.find(s=>s.id===ep.scene_id); }

async function startEpisode(user,session,index) {
  const s=SCENES[index];
  if (!s) return finish(user,session);
  const ep={id:id('ep'),session_id:session.id,scene_id:s.id,turn_index:0};
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO nablon_episodes (id,session_id,scene_id,turn_index,status,support_stage) VALUES ($1,$2,$3,0,'WAITING_RESPONSE','NONE')",[ep.id,session.id,s.id]);
    await event(client,user,session,ep,'NABLON_EPISODE_STARTED',0,{scene_id:s.id,structure_id:s.structureId,context:s.context,mode:s.mode});
    await event(client,user,session,ep,'NABLON_PROMPT_SHOWN',0,{prompt:s.prompt});
    await client.query('UPDATE nablon_sessions SET current_episode_index=$1 WHERE id=$2',[index,session.id]);
    await client.query('COMMIT');
    await bot.telegram.sendMessage(user.telegram_id,s.prompt,ASK_BUTTON);
  } catch(e) { await client.query('ROLLBACK'); console.error('startEpisode:',e); }
  finally { client.release(); }
}
async function finish(user,session) {
  const r=await pool.query("SELECT id FROM nablon_episodes WHERE session_id=$1 ORDER BY started_at DESC LIMIT 1",[session.id]);
  await pool.query("UPDATE nablon_sessions SET status='COMPLETED',completed_at=NOW() WHERE id=$1",[session.id]);
  if(r.rows[0]) await pool.query(
    "INSERT INTO nablon_events (user_id,session_id,episode_id,event_name,turn_index,payload) VALUES ($1,$2,$3,'NABLON_SET_COMPLETED',$4,$5)",
    [user.id,session.id,r.rows[0].id,SCENES.length*4,JSON.stringify({training_id:session.training_id,episodes:SCENES.length})]
  );
  await bot.telegram.sendMessage(user.telegram_id,'Сет завершён.\n\nМожно остановиться здесь или пройти ещё один.',RESTART_BUTTON);
}

bot.start(async ctx=>{
  const u=await userFor(ctx.from.id);
  if(await activeSession(u.id)) return ctx.reply('У тебя уже есть незавершённый сет.');
  return ctx.reply(START_TEXT,START_BUTTON);
});
bot.action('start_training',async ctx=>{
  await ctx.answerCbQuery();
  const u=await userFor(ctx.from.id);
  if(await activeSession(u.id)) return ctx.reply('У тебя уже есть незавершённый сет.');
  const sId=id('ses');
  await pool.query("INSERT INTO nablon_sessions (id,user_id,mode,training_id,current_episode_index,status) VALUES ($1,$2,'live','condition_change_test_v01',0,'ACTIVE')",[sId,u.id]);
  const s=(await pool.query('SELECT * FROM nablon_sessions WHERE id=$1',[sId])).rows[0];
  await startEpisode(u,s,0);
});
bot.action('ask',async ctx=>{
  await ctx.answerCbQuery();
  const u=await userFor(ctx.from.id), s=await activeSession(u.id);
  if(!s) return ctx.reply('Сейчас нет активного сета.');
  const r=await pool.query("SELECT * FROM nablon_episodes WHERE session_id=$1 ORDER BY started_at DESC LIMIT 1",[s.id]);
  const ep=r.rows[0]; if(!ep) return;
  await pool.query('UPDATE nablon_episodes SET question_requested=true WHERE id=$1',[ep.id]);
  await pool.query("INSERT INTO nablon_events (user_id,session_id,episode_id,event_name,turn_index,payload) VALUES ($1,$2,$3,'NABLON_QUESTION_REQUESTED',$4,'{}')",[u.id,s.id,ep.id,ep.turn_index]);
  await ctx.reply('Что именно хочешь узнать?',QUESTION_BUTTONS);
});
bot.action(/^q:(purpose|why|example|life)$/,async ctx=>{
  await ctx.answerCbQuery();
  await ctx.reply(QUESTION_ANSWERS[ctx.match[1]]);
});

bot.on('text',async ctx=>{
  const u=await userFor(ctx.from.id), s=await activeSession(u.id); if(!s) return;
  const r=await pool.query("SELECT * FROM nablon_episodes WHERE session_id=$1 ORDER BY started_at DESC LIMIT 1",[s.id]);
  const ep=r.rows[0]; if(!ep) return;
  const sc=scene(ep); if(!sc) return;
  const text=ctx.message.text;

  if(ep.status==='WAITING_RESPONSE') {
    const rt=await route(text,sc.prompt), client=await pool.connect();
    try {
      await client.query('BEGIN');
      await event(client,u,s,ep,'NABLON_USER_RESPONDED',1,{raw_text:text});
      await client.query('INSERT INTO nablon_routing_telemetry (user_id,session_id,episode_id,routing_class,confidence,classifier_version) VALUES ($1,$2,$3,$4,$5,$6)',[u.id,s.id,ep.id,rt.c,rt.confidence]);

      if (!sc.intervention?.question) {
        await client.query("UPDATE nablon_episodes SET turn_index=1,status='COMPLETED',completed_at=NOW(),routing_class=$1,classifier_version=$2 WHERE id=$3",[rt.c,ROUTER_VERSION,ep.id]);
        await event(client,u,s,ep,'NABLON_EPISODE_COMPLETED',1,{transfer:true});
        await client.query('COMMIT');
        const next=s.current_episode_index+1;
        const fresh=(await pool.query('SELECT * FROM nablon_sessions WHERE id=$1',[s.id])).rows[0];
        if(next>=SCENES.length) await finish(u,fresh); else await startEpisode(u,fresh,next);
        return;
      }

      await client.query("UPDATE nablon_episodes SET turn_index=2,status='WAITING_NEW_DECISION',support_stage='DIRECTED',routing_class=$1,classifier_version=$2 WHERE id=$3",[rt.c,ROUTER_VERSION,ep.id]);
      const q=sc.intervention.question;
      await event(client,u,s,ep,'NABLON_PROMPT_SHOWN',2,{prompt:q});
      await client.query('COMMIT');
      await ctx.reply(q);
    } catch(e) { await client.query('ROLLBACK'); console.error('first response:',e); }
    finally { client.release(); }
    return;
  }

  if(ep.status==='WAITING_NEW_DECISION') {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await event(client,u,s,ep,'NABLON_USER_RESPONDED',3,{raw_text:text});
      await client.query("UPDATE nablon_episodes SET turn_index=3,status='COMPLETED',completed_at=NOW() WHERE id=$1",[ep.id]);
      await event(client,u,s,ep,'NABLON_EPISODE_COMPLETED',3,{});
      await client.query('COMMIT');
      const next=s.current_episode_index+1;
      const fresh=(await pool.query('SELECT * FROM nablon_sessions WHERE id=$1',[s.id])).rows[0];
      if(next>=SCENES.length) await finish(u,fresh); else await startEpisode(u,fresh,next);
    } catch(e) { await client.query('ROLLBACK'); console.error('new decision:',e); }
    finally { client.release(); }
  }
});

async function dailyCronTick() {}
module.exports={bot,dailyCronTick,pool,route};
