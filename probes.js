// Probe Library v0
//
// MVP-правило: до появления первых пользовательских данных активен только ОДИН зонд
// (forecast_conversation). Остальные — active: false, ждут в бэклоге.
// Подключение следующих — только после анализа probe_clarity_score первого зонда.
//
// Каждый зонд отвечает фильтру: "какое новое поле Layer A появится после выполнения?"
// LLM (если используется) — ТОЛЬКО нормализатор свободного текста в structured_fields.
// Никакой интерпретации, никаких выводов.
//
// Пять фильтров отбора (PASS/FAIL/UNKNOWN, без весов, без общего score):
// understandable | structured_output | lifestyle_invariant | repeatable | creates_layer_a_data

const PROBES = [
  {
    probe_code: 'forecast_conversation',
    name: 'Прогноз-факт (самовыбор события)',
    target_core: 'forecasting_calibration', // свободная метка, не используется алгоритмами
    active: true,

    payload_day:
      'Подумай о любом деле, которое ты сегодня ещё не закончил.\nНасколько сложно оно пройдёт? Ответь числом от 1 до 10.',
    payload_evening: 'А как оказалось на самом деле? Числом от 1 до 10.',

    fields_schema: {
      predicted_value: 'int(1-10)',
      actual_value: 'int(1-10)',
      delta: 'int (actual - predicted)',
    },
    event_day: 'PREDICTION_MADE',
    event_evening: 'PREDICTION_RESOLVED',
    completion_burden: 'low',

    known_tradeoffs: [
      'self_selected_event_may_reduce_delta_variance',
    ],

    filters: {
      understandable: { status: 'PASS', note: 'Проверить на первых 10 пользователях' },
      structured_output: { status: 'PASS', note: 'Ответ — одно число' },
      lifestyle_invariant: { status: 'PASS', note: 'Пользователь сам выбирает событие' },
      repeatable: { status: 'PASS', note: 'Можно использовать ежедневно' },
      creates_layer_a_data: {
        status: 'PASS',
        new_fields: ['predicted_value', 'actual_value', 'delta'],
      },
    },

    onboarding_note:
      'При первом использовании этого типа зонда — короткое объяснение один раз, ' +
      'дальше без объяснений (см. onboardingCopy в bot.js).',
  },
  // --- БЭКЛОГ: active=false. Подключение только после анализа probe_clarity_score
  // зонда forecast_conversation на первых 10-20 пользователях. Фильтры ниже — UNKNOWN,
  // пока не проверены вживую (не путать с PASS у активного зонда).
  {
    probe_code: 'time_estimate',
    name: 'Оценка времени',
    target_core: 'forecasting_calibration',
    active: false,
    payload_day: 'Сколько минут займёт эта задача?',
    payload_evening: 'Сколько заняло по факту?',
    fields_schema: {
      predicted_minutes: 'int',
      actual_minutes: 'int',
      delta_minutes: 'int (actual - predicted)',
    },
    event_day: 'PREDICTION_MADE',
    event_evening: 'PREDICTION_RESOLVED',
    completion_burden: 'low',
    filters: {
      understandable: { status: 'UNKNOWN' },
      structured_output: { status: 'PASS', note: 'Ответ — одно число' },
      lifestyle_invariant: { status: 'UNKNOWN', note: 'Требует привязки к конкретной задаче — уточнить формулировку по образцу forecast_conversation' },
      repeatable: { status: 'UNKNOWN' },
      creates_layer_a_data: { status: 'PASS', new_fields: ['predicted_minutes', 'actual_minutes', 'delta_minutes'] },
    },
  },
  {
    probe_code: 'choice_before_after_fact',
    name: 'Выбор до/после нового факта',
    target_core: 'belief_update',
    active: false,
    payload_day: 'Выбери один из вариантов: [A / B / C]',
    payload_evening:
      'Новый факт: {fact}. С учётом этого — тот же выбор, или изменил бы?',
    fields_schema: {
      initial_choice: 'string',
      final_choice: 'string',
      changed: 'bool (final !== initial)',
    },
    event_day: 'CHOICE_MADE',
    event_evening: 'CHOICE_REVISED', // если changed=false — писать CHOICE_CONFIRMED в коде
    completion_burden: 'medium',
    filters: {
      understandable: { status: 'UNKNOWN', note: 'Требует контекста "почему потом ещё раз спросят" — см. правило одноразового объяснения типа зонда' },
      structured_output: { status: 'PASS' },
      lifestyle_invariant: { status: 'UNKNOWN', note: 'Нужен реальный "новый факт" — источник факта не определён' },
      repeatable: { status: 'UNKNOWN' },
      creates_layer_a_data: { status: 'PASS', new_fields: ['initial_choice', 'final_choice', 'changed'] },
    },
  },
  {
    probe_code: 'confidence_after_choice',
    name: 'Уверенность в решении',
    target_core: 'belief_update',
    active: false,
    payload_day: null, // не самостоятельный день-зонд — довесок к любому CHOICE_MADE
    payload_evening: 'Насколько ты уверен в этом решении, от 1 до 10?',
    fields_schema: {
      confidence_score: 'int(1-10)',
    },
    event_day: null,
    event_evening: 'CONFIDENCE_LOGGED',
    completion_burden: 'low',
    filters: {
      understandable: { status: 'PASS', note: 'Короткий, но зависит от того, что перед ним был CHOICE_MADE' },
      structured_output: { status: 'PASS' },
      lifestyle_invariant: { status: 'PASS' },
      repeatable: { status: 'UNKNOWN', note: 'Как довесок — не самостоятелен, зависит от choice_before_after_fact' },
      creates_layer_a_data: { status: 'PASS', new_fields: ['confidence_score'] },
    },
  },
];

module.exports = { PROBES };
