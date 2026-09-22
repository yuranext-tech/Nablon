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
const QUESTION_BUTTONS = Markup.inlineKeyboard([
  [Markup.button.callback('Зачем это?', 'q:purpose')],
  [Markup.button.callback('Почему ты это спрашиваешь?', 'q:why')],
  [Markup.button.callback('Покажи другой пример', 'q:example')],
  [Markup.button.callback('Как это применить в жизни?', 'q:life')],
]);
const RESTART_BUTTON = Markup.inlineKeyboard([[Markup.button.callback('Пройти ещё раз', 'start_training')]]);

function id(prefix) { return prefix + '_' + crypto.randomUUID(); }

// Telegram retries delivery of updates. Deduplicate at the runtime boundary so
// the same update cannot start two sessions, answer twice, or advance an episode twice.
bot.use(async (ctx, next) => {
  const updateId = ctx.update?.update_id;
  if (updateId == null) return next();
  try {
    const r = await pool.query(
      'INSERT INTO nablon_processed_updates (update_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING update_id',
      [updateId]
    );
    if (!r.rows.length) return;
    return next();
  } catch (e) {
    console.error('update deduplication failed:', e.message);
    throw e;
  }
});

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

async function enqueueOutbox(client, {user, session, episode=null, logicalKey, text, replyMarkup=null}) {
  await client.query(
    `INSERT INTO nablon_outbox
      (user_id,session_id,episode_id,logical_key,chat_id,text,reply_markup,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING')
     ON CONFLICT (logical_key) DO NOTHING`,
    [user.id,session.id,episode?.id || null,logicalKey,user.telegram_id,text,replyMarkup ? JSON.stringify(replyMarkup) : null]
  );
}

async function deliverOutbox() {
  const client=await pool.connect();
  let row=null;
  try {
    await client.query('BEGIN');
    const r=await client.query(
      `SELECT * FROM nablon_outbox
       WHERE (status='PENDING' AND (next_attempt_at IS NULL OR next_attempt_at<=NOW()))
          OR (status='SENDING' AND claimed_at < NOW() - INTERVAL '5 minutes')
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED LIMIT 1`
    );
    row=r.rows[0];
    if(!row){ await client.query('COMMIT'); return false; }
    await client.query(
      `UPDATE nablon_outbox SET status='SENDING',claimed_at=NOW(),attempts=attempts+1 WHERE id=$1`,
      [row.id]
    );
    await client.query('COMMIT');
  } catch(e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }

  try {
    const options=row.reply_markup ? {reply_markup:row.reply_markup} : undefined;
    await bot.telegram.sendMessage(row.chat_id,row.text,options);
    await pool.query("UPDATE nablon_outbox SET status='SENT',sent_at=NOW(),claimed_at=NULL,last_error=NULL WHERE id=$1 AND status='SENDING'",[row.id]);
  } catch(e) {
    const delaySeconds=Math.min(300,Math.max(15,15*Math.pow(2,Math.min(row.attempts-1,4))));
    await pool.query(
      "UPDATE nablon_outbox SET status='PENDING',claimed_at=NULL,next_attempt_at=NOW()+($2 * INTERVAL '1 second'),last_error=$3 WHERE id=$1 AND status='SENDING'",
      [row.id,delaySeconds,String(e.message||e).slice(0,1000)]
    );
    console.error('outbox send:',row.logical_key,e.message);
  }
  return true;
}

async function flushOutbox(limit=20) {
  for(let i=0;i<limit;i++){ if(!await deliverOutbox()) break; }
}

async function startEpisode(user,session,index) {
  const s=SCENES[index];
  if(!s) return finish(user,session);
  const ep={id:id('ep'),session_id:session.id,scene_id:s.id,turn_index:0};
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO nablon_episodes (id,session_id,scene_id,turn_index,status,support_stage) VALUES ($1,$2,$3,0,'WAITING_RESPONSE','NONE')",[ep.id,session.id,s.id]);
    if(index===0) await event(client,user,session,ep,'NABLON_SESSION_STARTED',0,{training_id:session.training_id,mode:session.mode});
    await event(client,user,session,ep,'NABLON_EPISODE_STARTED',0,{scene_id:s.id,structure_id:s.structureId,context:s.context,mode:s.mode});
    await event(client,user,session,ep,'NABLON_PROMPT_SHOWN',0,{prompt:s.prompt});
    await enqueueOutbox(client,{user,session,episode:ep,logicalKey:`session:${session.id}:episode:${ep.id}:prompt:0`,text:s.prompt});
    await client.query('UPDATE nablon_sessions SET current_episode_index=$1 WHERE id=$2',[index,session.id]);
    await client.query('COMMIT');
    await flushOutbox(1);
  } catch(e) {
    await client.query('ROLLBACK');
    console.error('startEpisode:',e);
  } finally { client.release(); }
}

async function finish(user,session) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const last=(await client.query("SELECT id,turn_index FROM nablon_episodes WHERE session_id=$1 ORDER BY started_at DESC LIMIT 1",[session.id])).rows[0];
    await client.query("UPDATE nablon_sessions SET status='COMPLETED',completed_at=NOW() WHERE id=$1 AND status='ACTIVE'",[session.id]);
    if(last){
      await event(client,user,session,last,'NABLON_SET_COMPLETED',last.turn_index,{training_id:session.training_id,episodes:SCENES.length});
      await event(client,user,session,last,'NABLON_SESSION_ENDED',last.turn_index,{reason:'completed'});
      await enqueueOutbox(client,{user,session,episode:last,logicalKey:`session:${session.id}:completion`,text:'Сет завершён.\\n\\nМожно остановиться здесь или пройти ещё один.',replyMarkup:RESTART_BUTTON});
    }
    await client.query('COMMIT');
  } catch(e){ await client.query('ROLLBACK'); throw e; }
  finally{ client.release(); }
  await flushOutbox(1);
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
  let s;
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize session creation per user so two concurrent button deliveries
    // cannot receive the same session_number.
    const lockedUser=(await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[u.id])).rows[0];
    if (!lockedUser) { await client.query('ROLLBACK'); return; }
    const active=(await client.query("SELECT id FROM nablon_sessions WHERE user_id=$1 AND status='ACTIVE' LIMIT 1",[u.id])).rows[0];
    if (active) { await client.query('ROLLBACK'); return ctx.reply('У тебя уже есть незавершённый сет.'); }
    const n=(await client.query('SELECT COALESCE(MAX(session_number),0)+1 AS session_number FROM nablon_sessions WHERE user_id=$1',[u.id])).rows[0].session_number;
    await client.query(
      "INSERT INTO nablon_sessions (id,user_id,session_number,mode,training_id,current_episode_index,status) VALUES ($1,$2,$3,'live','condition_change_test_v01',0,'ACTIVE')",
      [sId,u.id,n]
    );
    s=(await client.query('SELECT * FROM nablon_sessions WHERE id=$1',[sId])).rows[0];
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return ctx.reply('У тебя уже есть незавершённый сет.');
    throw e;
  } finally {
    client.release();
  }
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
    const rt=await route(text,sc.prompt);
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const locked=(await client.query('SELECT * FROM nablon_episodes WHERE id=$1 FOR UPDATE',[ep.id])).rows[0];
      if(!locked || locked.status!=='WAITING_RESPONSE') { await client.query('ROLLBACK'); return; }
      await event(client,u,s,locked,'NABLON_USER_RESPONDED',1,{raw_text:text});
      await client.query('INSERT INTO nablon_routing_telemetry (user_id,session_id,episode_id,routing_class,confidence,classifier_version) VALUES ($1,$2,$3,$4,$5,$6)',[u.id,s.id,locked.id,rt.c,rt.confidence]);

      if (!sc.intervention?.question) {
        await client.query("UPDATE nablon_episodes SET turn_index=1,status='COMPLETED',completed_at=NOW(),routing_class=$1,classifier_version=$2 WHERE id=$3",[rt.c,ROUTER_VERSION,locked.id]);
        await event(client,u,s,locked,'NABLON_EPISODE_COMPLETED',1,{transfer:true});
        await client.query('COMMIT');
        const next=s.current_episode_index+1;
        const fresh=(await pool.query('SELECT * FROM nablon_sessions WHERE id=$1',[s.id])).rows[0];
        if(next>=SCENES.length) await finish(u,fresh); else await startEpisode(u,fresh,next);
        return;
      }

      await client.query("UPDATE nablon_episodes SET turn_index=2,status='WAITING_NEW_DECISION',support_stage='DIRECTED',routing_class=$1,classifier_version=$2 WHERE id=$3",[rt.c,ROUTER_VERSION,locked.id]);
      const q=sc.intervention.question;
      await event(client,u,s,locked,'NABLON_PROMPT_SHOWN',2,{prompt:q});
      await enqueueOutbox(client,{user:u,session:s,episode:locked,logicalKey:`session:${s.id}:episode:${locked.id}:prompt:2`,text:q});
      await client.query('COMMIT');
      await flushOutbox(1);
    } catch(e) { await client.query('ROLLBACK'); console.error('first response:',e); }
    finally { client.release(); }
    return;
  }

  if(ep.status==='WAITING_NEW_DECISION') {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const locked=(await client.query('SELECT * FROM nablon_episodes WHERE id=$1 FOR UPDATE',[ep.id])).rows[0];
      if(!locked || locked.status!=='WAITING_NEW_DECISION') { await client.query('ROLLBACK'); return; }
      await event(client,u,s,locked,'NABLON_USER_RESPONDED',3,{raw_text:text});
      await client.query("UPDATE nablon_episodes SET turn_index=3,status='COMPLETED',completed_at=NOW() WHERE id=$1",[locked.id]);
      await event(client,u,s,locked,'NABLON_EPISODE_COMPLETED',3,{});
      await client.query('COMMIT');
      const next=s.current_episode_index+1;
      const fresh=(await pool.query('SELECT * FROM nablon_sessions WHERE id=$1',[s.id])).rows[0];
      if(next>=SCENES.length) await finish(u,fresh); else await startEpisode(u,fresh,next);
    } catch(e) { await client.query('ROLLBACK'); console.error('new decision:',e); }
    finally { client.release(); }
  }
});

async function resumeActiveSessions() {
  const r = await pool.query(
    "SELECT s.*, u.telegram_id FROM nablon_sessions s JOIN users u ON u.id=s.user_id WHERE s.status='ACTIVE' ORDER BY s.started_at ASC"
  );

  for (const s of r.rows) {
    const epResult = await pool.query(
      "SELECT * FROM nablon_episodes WHERE session_id=$1 AND status IN ('WAITING_RESPONSE','WAITING_NEW_DECISION','INCOMPLETE') ORDER BY started_at DESC LIMIT 1",
      [s.id]
    );
    let ep = epResult.rows[0];
    if (!ep) {
      // A process can die after the previous episode commits but before the
      // next episode is created. Reconstruct the next step from durable state.
      const lastResult = await pool.query(
        "SELECT * FROM nablon_episodes WHERE session_id=$1 ORDER BY turn_index DESC, started_at DESC LIMIT 1",
        [s.id]
      );
      const last = lastResult.rows[0];
      const nextIndex = last ? Number(s.current_episode_index) + 1 : 0;
      if (nextIndex >= SCENES.length) {
        try { await finish({ id: s.user_id, telegram_id: s.telegram_id }, s); } catch (e) { console.error('resumeActiveSessions finish:', s.id, e.message); }
      } else {
        await startEpisode(
          { id: s.user_id, telegram_id: s.telegram_id },
          s,
          nextIndex
        );
      }
      continue;
    }

    const promptResult = await pool.query(
      "SELECT payload FROM nablon_events WHERE episode_id=$1 AND event_name='NABLON_PROMPT_SHOWN' ORDER BY created_at DESC LIMIT 1",
      [ep.id]
    );
    const prompt = promptResult.rows[0]?.payload?.prompt;
    if (!prompt) {
      console.error('resumeActiveSessions: waiting episode has no prompt', ep.id);
      continue;
    }

    if (ep.status === 'INCOMPLETE') {
      const repaired = await pool.query("UPDATE nablon_episodes SET status='WAITING_RESPONSE', completed_at=NULL WHERE id=$1 AND status='INCOMPLETE' RETURNING *", [ep.id]);
      if (!repaired.rows.length) continue;
      ep.status = 'WAITING_RESPONSE';
    }
    const resumeText = 'Продолжим с того места, где остановились.\n\n' + prompt;
    try {
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          "INSERT INTO nablon_events (user_id,session_id,episode_id,event_name,turn_index,payload) VALUES ($1,$2,$3,'NABLON_SESSION_RESUMED',$4,$5)",
          [s.user_id,s.id,ep.id,ep.turn_index,JSON.stringify({status:ep.status,scene_id:ep.scene_id})]
        );
        await client.query(
          "INSERT INTO nablon_events (user_id,session_id,episode_id,event_name,turn_index,payload) VALUES ($1,$2,$3,'NABLON_PROMPT_SHOWN',$4,$5)",
          [s.user_id,s.id,ep.id,ep.turn_index,JSON.stringify({prompt:resumeText,resumed:true})]
        );
        await enqueueOutbox(client,{user:{id:s.user_id,telegram_id:s.telegram_id},session:s,episode:ep,logicalKey:`session:${s.id}:episode:${ep.id}:resume`,text:resumeText});
        await client.query('COMMIT');
      } catch(e){ await client.query('ROLLBACK'); throw e; }
      finally{ client.release(); }
      await flushOutbox(1);
    } catch (e) {
      console.error('resumeActiveSessions outbox:', s.id, e.message);
    }
  }
}

async function dailyCronTick() {}
module.exports={bot,dailyCronTick,pool,route,resumeActiveSessions};
