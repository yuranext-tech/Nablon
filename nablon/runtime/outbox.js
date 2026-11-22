'use strict';

async function enqueueOutbox(client, {user, session, episode=null, logicalKey, text, replyMarkup=null}) {
  await client.query(
    `INSERT INTO nablon_outbox
      (user_id,session_id,episode_id,logical_key,chat_id,text,reply_markup,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING')
     ON CONFLICT (logical_key) DO NOTHING`,
    [user.id,session.id,episode?.id || null,logicalKey,user.telegram_id,text,replyMarkup ? JSON.stringify(replyMarkup) : null]
  );
}

function createOutboxSender(pool, telegram) {
  async function deliverOutbox(episodeId) {
    const client=await pool.connect();
    let row=null;
    try {
      await client.query('BEGIN');
      const r=await client.query(
        `SELECT * FROM nablon_outbox
         WHERE ($1::text IS NULL OR episode_id=$1)
           AND ((status='PENDING' AND (next_attempt_at IS NULL OR next_attempt_at<=NOW()))
            OR (status='SENDING' AND claimed_at < NOW() - INTERVAL '5 minutes'))
         ORDER BY created_at, id
         FOR UPDATE SKIP LOCKED LIMIT 1`, [episodeId]
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
      await telegram.sendMessage(row.chat_id,row.text,options);
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

  async function flushOutbox(limit=20, episodeId=null) {
    for(let i=0;i<limit;i++){ if(!await deliverOutbox(episodeId)) break; }
  }
  return flushOutbox;
}

module.exports = { enqueueOutbox, createOutboxSender };
