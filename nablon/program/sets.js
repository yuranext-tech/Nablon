// First new-program content pack. Deliberately small: it tests program plumbing,
// not a final cognitive curriculum.

const PROGRAM_VERSION = 'adequacy-probe-v0.1';

const SETS = {
  reconnaissance_v01: {
    id: 'reconnaissance_v01',
    programVersion: PROGRAM_VERSION,
    type: 'PROBE',
    probes: [
      {
        id: 'recon_01',
        kind: 'OPEN_RESPONSE',
        domain: 'SOCIAL_COORDINATION',
        prompt: 'Человек, с которым вы договаривались о встрече, написал: «Сегодня не получится. Давай потом». Больше ничего не объяснил. Что ты думаешь и что сделаешь?',
      },
      {
        id: 'recon_02',
        kind: 'OPEN_RESPONSE',
        domain: 'EVERYDAY_ACTION',
        prompt: 'Ты собираешься сделать небольшую задачу, но понимаешь, что одного важного факта пока не знаешь. Его можно узнать довольно быстро. Что ты думаешь и что сделаешь?',
      },
      {
        id: 'recon_03',
        kind: 'OPEN_RESPONSE',
        domain: 'EVERYDAY_DECISION',
        prompt: 'Ты получил объяснение, которое хорошо подходит к произошедшему. Ошибка в этом объяснении почти ничем тебе не грозит. Что ты будешь делать дальше?',
      },
    ],
  },
};

module.exports = { PROGRAM_VERSION, SETS };
