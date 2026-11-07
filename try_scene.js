// Автономный продуктовый эксперимент /try.
// Сессии и обезличенный журнал существуют только в памяти процесса: после
// рестарта они намеренно теряются. Этот модуль не обращается к БД, PROBES или cron.

const { randomBytes } = require('crypto');

const MAX_ACTIONS = 4;
const MAX_EVENTS = 1000;

const ACTIONS = {
  repeat: 'Повторить действие',
  change: 'Изменить способ',
  result: 'Узнать результат',
  finish: 'Завершить',
};

const SITUATIONS = [
  {
    code: 'repeat_progress',
    opening: 'Ты переносишь четыре подписанные коробки в соседнюю комнату. Две уже перенесены тем же способом, каждая за одну ходку. Нужно перенести оставшиеся. Что сделаешь дальше?',
    repeat: 'Ты снова переносишь коробки привычным способом. Оставшиеся коробки доставлены: способ продолжал работать.',
    change: 'Ты начал искать другой способ перевозки, но коробки пока остаются на месте.',
    success: 'Результат: привычный способ уже давал прогресс и позволил закончить работу.',
    pending: 'Коробки ещё не доставлены. Решение можно изменить на следующем ходе.',
  },
  {
    code: 'change_progress',
    opening: 'Ты пытаешься отправить электронную форму. Дважды нажал «Отправить» и оба раза увидел одинаковое сообщение «Не заполнено обязательное поле». Нужно отправить форму. Что сделаешь?',
    repeat: 'Ты снова нажал «Отправить». Система опять показала «Не заполнено обязательное поле». Ничего не изменилось.',
    change: 'Ты проверил обязательные поля, заполнил пропущенное и отправил форму. Отправка подтверждена.',
    success: 'Результат: вместо повторной отправки ты устранил указанную причину ошибки.',
    pending: 'Форма ещё не отправлена. Сообщение об ошибке осталось тем же.',
  },
];

function userKey(userId) {
  if ((typeof userId !== 'string' && typeof userId !== 'number') || String(userId).length === 0) {
    throw new TypeError('A Telegram user identifier is required');
  }
  return String(userId);
}

function callbackData(session, action) {
  return `try:${session.token}:${session.turn}:${action}`;
}

function buttons(session) {
  if (!session.active) return [];
  return Object.entries(ACTIONS).map(([action, text]) => ([{
    text,
    callback_data: callbackData(session, action),
  }]));
}

function intro(session) {
  return `${session.situation.opening}\n\nВыбери действие. В сцене не больше ${MAX_ACTIONS} действий.`;
}

function resultText(session) {
  return session.progress ? session.situation.success : session.situation.pending;
}

class TrySceneManager {
  constructor({ tokenFactory = () => randomBytes(12).toString('base64url') } = {}) {
    this.tokenFactory = tokenFactory;
    this.sessions = new Map();
    this.currentByUser = new Map();
    this.startsByUser = new Map();
    this.events = [];
  }

  start(userId) {
    const owner = userKey(userId);
    const previousToken = this.currentByUser.get(owner);
    if (previousToken) this.sessions.delete(previousToken);
    const startCount = this.startsByUser.get(owner) || 0;
    const token = this.tokenFactory();
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token) || this.sessions.has(token)) {
      throw new Error('Invalid or duplicate scene token');
    }
    const session = {
      token,
      owner,
      situation: SITUATIONS[startCount % SITUATIONS.length],
      turn: 0,
      actions: 0,
      active: true,
      progress: false,
      processedCallbacks: new Set(),
    };
    // Completed sessions are discarded at the next start. Keep no per-click history
    // beyond the lifetime of the current scene.
    this.sessions.set(token, session);
    this.currentByUser.set(owner, token);
    this.startsByUser.set(owner, startCount + 1);
    return { status: 'STARTED', message: intro(session), buttons: buttons(session), situation: session.situation.code };
  }

  handle(userId, data, callbackId) {
    if (typeof data !== 'string' || !data.startsWith('try:')) return { handled: false };
    const match = /^try:([A-Za-z0-9_-]{16,64}):(\d+):(repeat|change|result|finish)$/.exec(data);
    if (!match) return this._rejected('STALE', 'Эта кнопка устарела. Запусти /try ещё раз.');
    const [, token, turnText, action] = match;
    const session = this.sessions.get(token);
    if (!session) return this._rejected('STALE', 'Эта сцена больше недоступна. Запусти /try ещё раз.');
    if (session.owner !== userKey(userId)) {
      return this._rejected('FOREIGN_USER', 'Эта сцена открыта для другого пользователя.');
    }
    if (this.currentByUser.get(session.owner) !== token || !session.active) {
      return this._rejected('STALE', 'Эта сцена уже завершена или заменена. Запусти /try ещё раз.');
    }
    if (callbackId && session.processedCallbacks.has(callbackId)) {
      return this._rejected('DUPLICATE', 'Это нажатие уже обработано.');
    }
    if (Number(turnText) !== session.turn) {
      return this._rejected('STALE', 'Эта кнопка устарела. Используй последние кнопки сцены.');
    }
    if (session.actions >= MAX_ACTIONS) {
      session.active = false;
      return this._rejected('LIMIT', 'Лимит действий достигнут. Запусти /try для новой сцены.');
    }

    if (callbackId) session.processedCallbacks.add(callbackId);
    session.actions += 1;
    session.turn += 1;
    let message;

    if (action === 'repeat') {
      const progressed = session.situation.code === 'repeat_progress';
      session.progress = session.progress || progressed;
      this._record(session.situation.code, action, progressed ? 'progress' : 'no_progress');
      message = session.situation.repeat;
    } else if (action === 'change') {
      const progressed = session.situation.code === 'change_progress';
      session.progress = session.progress || progressed;
      this._record(session.situation.code, action, progressed ? 'progress' : 'no_progress');
      message = session.situation.change;
    } else if (action === 'result') {
      message = resultText(session);
    } else {
      session.active = false;
      message = `Сцена завершена. ${resultText(session)}`;
    }

    if (session.actions >= MAX_ACTIONS && session.active) {
      session.active = false;
      message += '\n\nДостигнут лимит действий. Запусти /try для новой сцены.';
    }
    return {
      handled: true,
      status: 'APPLIED',
      message,
      buttons: buttons(session),
      terminal: !session.active,
      situation: session.situation.code,
    };
  }

  anonymousEvents() {
    return this.events.map((event) => ({ ...event }));
  }

  _record(situation, action, outcome) {
    this.events.push({ type: 'try_action', situation, action, outcome });
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  _rejected(status, message) {
    return { handled: true, status, message, buttons: [], terminal: false };
  }
}

module.exports = { ACTIONS, MAX_ACTIONS, SITUATIONS, TrySceneManager };
