'use strict';

// Owner-only preview display translations. Do not change adaptive/content.js:
// the frozen experimental content and protocol commands remain untouched.
const ukrainian = Object.freeze({
  scenarios: Object.freeze({
    S1: 'Додай до картки адресу: вул. Садова, 8.',
    S2: 'Готова одна картка з трьох. Створи решту.',
    S3: 'Готова одна картка з трьох. Підготуй три картки; можна перевірити збереження.',
    S4A: 'У календарі вказано кімнату 12. Надійшло повідомлення: місце змінилося. Надішли актуальне місце.',
    S4B: 'У старій картці вказано кімнату 12. Організатор повідомив: зустріч перенесено до кімнати 14. Надішли актуальний номер.',
    S5: 'Кур’єр двічі намагався зателефонувати, але відповіді не було. Отримай замовлення сьогодні.',
  }),
  consequences: Object.freeze({
    address_added: 'Адресу додано. Мету досягнуто.',
    address_missing: 'Адреси поки немає.',
    two_of_three: 'Готові 2 з 3.',
    three_of_three: 'Готові 3 з 3. Мету досягнуто.',
    count_unchanged: 'Кількість карток не змінилася.',
    copy_no_progress: 'Нова картка не з’явилася: як і раніше, 2 з 3.',
    one_space_available: 'Місця вистачає для однієї картки.',
    storage_full: 'Сховище заповнене; можна видалити стару чернетку.',
    space_available: 'Місце доступне.',
    draft_deleted: 'Стару чернетку видалено; місце звільнено.',
    correct_room_sent: 'Учасники отримали актуальний номер: 14.',
    old_room_sent: 'Надіслано старий номер: 12.',
    new_room_14: 'Зустріч перенесено до кімнати 14.',
    old_calendar_12: 'У календарі зазначено 12; його оновлено вчора.',
    delivery_received: 'Кур’єр передав замовлення.',
    call_failed: 'Кур’єр намагався зателефонувати, але відповіді не було.',
    calls_enabled: 'Дзвінки з невідомих номерів дозволені.',
    calls_blocked: 'Дзвінки з невідомих номерів заблоковані.',
  }),
  buttons: Object.freeze({
    copy: 'Скопіювати картку',
    settings: 'Відкрити налаштування',
    check: 'Перевірити збереження',
    delete: 'Видалити стару чернетку',
    S4A: 'Завдання про календар',
    S4B: 'Завдання про стару картку',
  }),
  languageButton: '🌐 Мова',
  chooseLanguage: 'Оберіть мову:',
  noSession: 'Активного перегляду немає. Надішліть /start.',
});
const russian = Object.freeze({
  buttons: Object.freeze({
    copy: 'Скопировать карточку',
    settings: 'Открыть настройки',
    check: 'Проверить сохранение',
    delete: 'Удалить старый черновик',
    S4A: 'Задача про календарь',
    S4B: 'Задача про старую карточку',
  }),
  languageButton: '🌐 Язык',
  chooseLanguage: 'Выберите язык:',
  noSession: 'Активного просмотра нет. Отправьте /start.',
});
function previewTranslations(language) {
  if (language === 'uk') return ukrainian;
  if (language === 'ru') return russian;
  throw new Error('Unsupported preview language');
}
function displayText(language, kind, key, originalText) {
  const t = previewTranslations(language);
  if (language === 'ru') return originalText;
  const translated = t[kind]?.[key];
  if (typeof translated !== 'string') throw new Error('Missing preview translation');
  return translated;
}
module.exports = { previewTranslations, displayText };
