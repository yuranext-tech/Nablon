const VERSION = 'last-copy-v1';
const INTRO = 'NABLON · ОЗНАКОМЛЕНИЕ 01\n\nПоследняя копия\n\nНужно открыть последнюю версию файла «План».\n\nСейчас перед тобой папка «Материалы».\n\nЧто сделаешь?';
const SCREENS = {
  folder: [INTRO, [['Открыть папку', 'open'], ['Завершить', 'finish']]],
  files: ['В папке два файла: «План — 12 ноября» и «План — 14 ноября». Ни один пока не открыт.',
    [['Открыть от 12 ноября', 'old'], ['Открыть от 14 ноября', 'latest'], ['Завершить', 'finish']]],
  old_open: ['Открылся «План — 12 ноября». В папке есть более свежий файл от 14 ноября.',
    [['Открыть от 14 ноября', 'latest'], ['Завершить', 'finish']]],
  complete: ['Открылся «План — 14 ноября». Это последняя версия.', []],
  stopped: ['Эпизод завершён.', []],
};
const HELP = 'Нажми кнопку с действием. После нажатия появится результат.';

function initialState() {
  return { sceneVersion: VERSION, stage: 'folder', understanding: 'unverified', helpRequested: false, helpPending: false, goal: 'pending' };
}

function screen(episode, includeHelp = false) {
  const [message, actions] = SCREENS[episode.state.stage];
  return {
    message: includeHelp ? HELP + '\n\n' + message : message,
    buttons: actions.map(([text, action]) => [{
      text, callback_data: `o1:${episode.id}:${episode.version}:${action}`,
    }]),
  };
}

function advance(state, action, precedingVersion) {
  const [previousScreen, actions] = SCREENS[state.stage];
  if (!actions.length) return null;
  if (action === 'help') {
    return {
      state: { ...state, helpRequested: true, helpPending: true },
      events: [
        { type: 'HELP_REQUESTED', precedingVersion },
        { type: 'HELP_PREPARED', message: HELP, screen: previousScreen },
      ],
    };
  }
  if (!actions.some(([, key]) => key === action)) return null;

  const next = { ...state, helpPending: false };
  const events = [{
    type: 'ACTION_ACCEPTED', action, precedingVersion,
    ...(action !== 'finish' ? { afterHelp: state.helpPending } : {}),
  }];
  if (action === 'finish') {
    next.stage = 'stopped';
    next.goal = 'not_reached';
  } else if (action === 'open') {
    next.stage = 'files';
  } else {
    next.stage = action === 'old' ? 'old_open' : 'complete';
    if (action === 'latest') next.goal = 'reached';
    // The next content action consumes the help marker. Later actions can
    // establish understanding without changing earlier observations.
    const understanding = state.helpPending ? 'assisted' : 'confirmed';
    if (state.understanding !== 'confirmed' && state.understanding !== understanding) {
      next.understanding = understanding;
      events.push({ type: 'INTERFACE_CHECK_RECORDED', result: understanding });
    }
  }
  events.push({ type: 'CONSEQUENCE_PREPARED', stage: next.stage, message: SCREENS[next.stage][0] });
  if (next.stage === 'stopped' || next.stage === 'complete') {
    events.push({ type: 'EPISODE_CLOSED', reason: next.stage, goal: next.goal });
  }
  return { state: next, events };
}

module.exports = { VERSION, INTRO, initialState, screen, advance };
