// bot.js — минимальный state machine + push logic, встроены прямо в код.
// Состояния: NEW -> ACTIVE -> WAITING_OUTCOME -> READY_FOR_NEXT -> INACTIVE -> DORMANT
// Никакой отдельной "спецификации" не требуется — это она и есть.

const { Telegraf } = require('telegraf');
const { Pool } = require('pg');
const { PROBES } = require('./probes');

const bot = new Telegraf(process.env.BOT_TOKEN);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Приветствие после /start — не привязано к конкретному зонду, отправляется один раз при регистрации.
const WELCOME_TEXT =
  'Привет. Это когнитивный тренер.\n\n' +
  'Он помогает лучше замечать, как ты думаешь и принимаешь решения — через ' +
  'короткие ежедневные задачи, которые занимают около трёх минут.\n\n' +
  'Первые дни он почти ничего о тебе не знает, поэтому не делает выводов. ' +
  'Сначала он собирает наблюдения. Когда их станет достаточно, начнёт показывать то, что заметил.\n\n' +
  'Когда тебе удобно получать вечерний вопрос? По умолчанию — в 20:00, но это можно изменить в любой момент.';

// Одноразовое объяснение при первом знакомстве с ТИПОМ ЗОНДА (не с продуктом в целом,
// это отдельно от WELCOME_TEXT). Правило: объяснение относится к типу зонда,
// а не к конкретному сообщению.
const ONBOARDING_COPY = {
  forecast_conversation:
    'Сегодня — первая часть: прогноз. Вечером — вторая: как вышло на деле.',
};

bot.start(async (ctx) => {
  const telegramId = ctx.from.id;
  const { rows } = await pool.query(
    `INSERT INTO users (telegram_id) VALUES ($1)
     ON CONFLICT (telegram_id) DO NOTHING
     RETURNING *`,
    [telegramId]
  );
  await ctx.reply(WELCOME_TEXT);

  // Cold start: не ждать до утреннего слота — первый зонд сразу после регистрации.
  // Для уже существующего пользователя (ON CONFLICT сработал, rows пустой) не повторяем.
  if (rows.length > 0) {
    await sendProbe(rows[0]);
  }
});

// probe_clarity_score — производная метрика, НЕ хранится как поле в probes.
// Вычисляется по observations за окно (по умолчанию последние 20 наблюдений зонда).
// score = 1 - validation_rejected_rate (без весов, без suspicious_response_rate —
// тот требует ручного разбора, не автоматизирован преждевременно).
async function computeProbeClarityScore(probeCode, windowSize = 20) {
  const { rows } = await pool.query(
    `SELECT event_type, is_valid FROM observations
     WHERE probe_code = $1
     ORDER BY created_at DESC LIMIT $2`,
    [probeCode, windowSize]
  );
  if (rows.length === 0) return null;

  const rejected = rows.filter((r) => r.event_type === 'VALIDATION_REJECTED').length;
  const rejectedRate = rejected / rows.length;

  return {
    probe_code: probeCode,
    sample_size: rows.length,
    validation_rejected_rate: rejectedRate,
    score: Math.max(0, 1 - rejectedRate),
    note: 'suspicious_response_rate требует ручного разбора первых 10-20 пользователей, не автоматизировано',
  };
}

// --- Push-правила: состояние -> что отправляем ---
// Утренний зонд идёт в фиксированный час (про него отдельно не спрашивали при /start).
// Вечерний вопрос — в preferred_slot_hour, который пользователь указал в WELCOME_TEXT.
const MORNING_SLOT_HOUR = 10;

function nextAction(state, consecutiveNoResponse, currentHour, preferredEveningHour) {
  switch (state) {
    case 'NEW':
      return currentHour === MORNING_SLOT_HOUR ? { type: 'send_probe', phase: 'day' } : { type: 'noop' };
    case 'READY_FOR_NEXT':
      return currentHour === MORNING_SLOT_HOUR ? { type: 'send_probe', phase: 'day' } : { type: 'noop' };
    case 'WAITING_OUTCOME':
      return currentHour === preferredEveningHour ? { type: 'send_evening_checkin' } : { type: 'noop' };
    case 'ACTIVE':
      return { type: 'noop' }; // ждём ответа на уже отправленный зонд
    case 'INACTIVE':
      return currentHour === MORNING_SLOT_HOUR
        ? consecutiveNoResponse >= 3
          ? { type: 'noop' } // переход в DORMANT произойдёт отдельным cron'ом
          : { type: 'soft_reminder' }
        : { type: 'noop' };
    case 'DORMANT':
      return { type: 'noop' }; // weekly_ping обрабатывается отдельным недельным cron, не здесь
    default:
      return { type: 'noop' };
  }
}

// --- Выбор зонда: MVP-правило — активен только forecast_conversation.
// Ротация вернётся, когда в PROBES появится больше active:true после анализа данных.
function pickNextProbe() {
  const active = PROBES.filter((p) => p.active === true && p.payload_day);
  return active[0]; // на сегодня — всегда один и тот же зонд
}

async function sendProbe(user) {
  const probe = pickNextProbe();

  // Идемпотентность: если сегодня этому пользователю уже отправляли зонд этого
  // типа в дневной фазе — не слать повторно (cron гоняется каждые 5 минут).
  const alreadySentToday = await pool.query(
    `SELECT 1 FROM observations
     WHERE user_id=$1 AND probe_code=$2 AND event_phase='day'
       AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [user.id, probe.probe_code]
  );
  if (alreadySentToday.rowCount > 0) return;

  // Первое знакомство пользователя с этим типом зонда — разовое объяснение.
  const seenBefore = await pool.query(
    `SELECT 1 FROM observations WHERE user_id=$1 AND probe_code=$2 LIMIT 1`,
    [user.id, probe.probe_code]
  );
  if (seenBefore.rowCount === 0 && ONBOARDING_COPY[probe.probe_code]) {
    await bot.telegram.sendMessage(user.telegram_id, ONBOARDING_COPY[probe.probe_code]);
  }

  await bot.telegram.sendMessage(user.telegram_id, probe.payload_day);

  await pool.query(
    `INSERT INTO observations (user_id, probe_id, probe_code, intervention_payload, event_type, event_phase)
     VALUES ($1, (SELECT id FROM probes WHERE probe_code=$2), $2, $3, $4, 'day')`,
    [user.id, probe.probe_code, JSON.stringify({ text: probe.payload_day }), probe.event_day]
  );

  await pool.query(
    `UPDATE users SET state='ACTIVE', last_probe_code=$1, last_active_at=NOW() WHERE id=$2`,
    [probe.probe_code, user.id]
  );
}

async function sendEveningCheckin(user) {
  // Источник истины — observations, а не user.last_probe_code (переживает рестарт).
  // Ищем последнее наблюдение ЭТОГО пользователя с event_type=PREDICTION_MADE,
  // для которого ещё нет соответствующего PREDICTION_RESOLVED.
  const { rows } = await pool.query(
    `SELECT o.probe_code FROM observations o
     WHERE o.user_id = $1
       AND o.event_type = 'PREDICTION_MADE'
       AND o.event_phase = 'day'
       AND NOT EXISTS (
         SELECT 1 FROM observations r
         WHERE r.user_id = o.user_id
           AND r.probe_code = o.probe_code
           AND r.event_phase = 'evening'
           AND r.created_at > o.created_at
       )
     ORDER BY o.created_at DESC
     LIMIT 1`,
    [user.id]
  );
  if (rows.length === 0) return; // нечего резолвить — либо уже закрыто, либо не начиналось

  const probeCode = rows[0].probe_code;
  const probe = PROBES.find((p) => p.probe_code === probeCode);
  if (!probe || !probe.payload_evening) return;

  // Идемпотентность: не слать вечерний вопрос повторно в тот же день.
  const alreadySentToday = await pool.query(
    `SELECT 1 FROM observations
     WHERE user_id=$1 AND probe_code=$2 AND event_phase='evening' AND event_type='PROMPT_SENT'
       AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [user.id, probeCode]
  );
  if (alreadySentToday.rowCount > 0) return;

  await bot.telegram.sendMessage(user.telegram_id, probe.payload_evening);

  await pool.query(
    `INSERT INTO observations (user_id, probe_id, probe_code, intervention_payload, event_type, event_phase)
     VALUES ($1, (SELECT id FROM probes WHERE probe_code=$2), $2, $3, $4, 'evening')`,
    [user.id, probeCode, JSON.stringify({ text: probe.payload_evening }), 'PROMPT_SENT']
  );
}

// Устойчивый парсер: ищет отдельное число 1-10 как самостоятельный токен,
// а не любые цифры подряд ("7-8" больше не даст 7, "10/10" не даст 1010).
function parseScoreAnswer(text) {
  const match = text.match(/\b([1-9]|10)\b/);
  return match ? parseInt(match[1], 10) : null;
}

// --- Обработка ответа пользователя (только структурирование, без интерпретации) ---
bot.on('text', async (ctx) => {
  const telegramId = ctx.from.id;
  const { rows } = await pool.query('SELECT * FROM users WHERE telegram_id=$1', [telegramId]);
  const user = rows[0];
  if (!user) return;

  // Явная проверка: бот вообще сейчас ждёт ответ от этого пользователя?
  // Если state не ACTIVE и не WAITING_OUTCOME — сообщение вне цикла, игнорируем
  // (это и есть правило "принимается первый валидный ответ": после того как state
  // сдвинулся дальше, повторные сообщения по старому зонду больше не обрабатываются).
  if (user.state !== 'ACTIVE' && user.state !== 'WAITING_OUTCOME') return;

  const probe = PROBES.find((p) => p.probe_code === user.last_probe_code);
  if (!probe) return;

  const isEveningPhase = user.state === 'WAITING_OUTCOME';
  const num = parseScoreAnswer(ctx.message.text);
  const isValid = num !== null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (!isEveningPhase) {
      // --- ДНЕВНАЯ фаза: прогноз ---
      await client.query(
        `INSERT INTO observations (user_id, probe_id, probe_code, response_payload, structured_fields, event_type, event_phase, is_valid, invalid_reason)
         VALUES ($1, (SELECT id FROM probes WHERE probe_code=$2), $2, $3, $4, $5, 'day', $6, $7)`,
        [
          user.id,
          probe.probe_code,
          JSON.stringify({ raw_text: ctx.message.text }),
          isValid ? JSON.stringify({ predicted_value: num }) : null,
          isValid ? 'VALIDATION_ACCEPTED' : 'VALIDATION_REJECTED',
          isValid,
          isValid ? null : 'could_not_parse_number',
        ]
      );

      if (isValid) {
        const newState = probe.payload_evening ? 'WAITING_OUTCOME' : 'READY_FOR_NEXT';
        await client.query(`UPDATE users SET state=$1, last_active_at=NOW() WHERE id=$2`, [
          newState,
          user.id,
        ]);
      }

      await client.query('COMMIT');

      if (!isValid) {
        await ctx.reply('Не понял ответ — можешь прислать просто числом от 1 до 10?');
      }
      return;
    }

    // --- ВЕЧЕРНЯЯ фаза: факт ---
    // Достаём predicted_value из дневного наблюдения того же цикла (в той же транзакции)
    const { rows: dayRows } = await client.query(
      `SELECT structured_fields FROM observations
       WHERE user_id=$1 AND probe_code=$2 AND event_phase='day' AND is_valid=true
       ORDER BY created_at DESC LIMIT 1`,
      [user.id, probe.probe_code]
    );
    const predictedValue = dayRows[0]?.structured_fields?.predicted_value;
    const delta = isValid && typeof predictedValue === 'number' ? num - predictedValue : null;

    await client.query(
      `INSERT INTO observations (user_id, probe_id, probe_code, response_payload, structured_fields, event_type, event_phase, is_valid, invalid_reason, resolved_at)
       VALUES ($1, (SELECT id FROM probes WHERE probe_code=$2), $2, $3, $4, $5, 'evening', $6, $7, $8)`,
      [
        user.id,
        probe.probe_code,
        JSON.stringify({ raw_text: ctx.message.text }),
        isValid ? JSON.stringify({ actual_value: num, delta }) : null,
        isValid ? 'PREDICTION_RESOLVED' : 'VALIDATION_REJECTED',
        isValid,
        isValid ? null : 'could_not_parse_number',
        isValid ? new Date() : null,
      ]
    );

    if (isValid) {
      await client.query(`UPDATE users SET state='READY_FOR_NEXT', last_active_at=NOW() WHERE id=$1`, [
        user.id,
      ]);
    }

    await client.query('COMMIT');

    if (!isValid) {
      await ctx.reply('Не понял ответ — можешь прислать просто числом от 1 до 10?');
      return;
    }

    // Layer A feedback — только факт, без интерпретации
    if (predictedValue !== undefined) {
      await ctx.reply(`Записал.\nПрогноз: ${predictedValue}\nФакт: ${num}`);
    } else {
      await ctx.reply('Записал.');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('text handler error:', err);
  } finally {
    client.release();
  }
});

// --- Cron: гоняется раз в час, для каждого пользователя решает, пора ли действовать ---
async function dailyCronTick() {
  const currentHour = new Date().getHours(); // TODO: учитывать user.timezone, пока сервер = Europe/Kiev
  const { rows: users } = await pool.query('SELECT * FROM users');
  for (const user of users) {
    const action = nextAction(
      user.state,
      user.consecutive_no_response,
      currentHour,
      user.preferred_slot_hour
    );
    if (action.type === 'send_probe') await sendProbe(user);
    if (action.type === 'send_evening_checkin') await sendEveningCheckin(user);
    if (action.type === 'soft_reminder') {
      await bot.telegram.sendMessage(user.telegram_id, 'Не потерялся? Можем продолжить, когда будет удобно.');
    }
  }
}

module.exports = { bot, dailyCronTick, nextAction, pickNextProbe, sendProbe, sendEveningCheckin, computeProbeClarityScore, pool };
