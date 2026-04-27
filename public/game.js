'use strict';

const socket = io();
const SESSION_KEY  = 'artguessSessionId';
const ROOM_KEY     = 'artguessRoomCode';
const DEV_HOLD_MS  = 1200;

// ---- state ----
let myId        = null;
let myName      = null;
let players     = [];
let phase       = 'lobby';
let amDrawer    = false;
let mySessionId = localStorage.getItem(SESSION_KEY) || null;
let myRoomCode  = localStorage.getItem(ROOM_KEY)    || null;
let devUnlimited = false;
let devPassword  = null;
let lastPhase   = 'lobby';

// ---- solo state ----
let soloMode             = false;
let soloStreak           = 0;
let soloTopic            = null;
let soloCurrentImageData = null;
const SOLO_BEST_KEY      = 'artguessSoloBest';
const MULTI_TOPIC_GENRES = [
  '食べ物',
  '生き物',
  '感情',
  '歴史',
  '医療',
  '国名',
  '職業',
  '科学',
  'スポーツ',
  'ジャンルなし',
];

function getSoloBest() { return parseInt(localStorage.getItem(SOLO_BEST_KEY) || '0'); }
function updateSoloBest(n) {
  if (n > getSoloBest()) {
    localStorage.setItem(SOLO_BEST_KEY, String(n));
    refreshSoloBestLobby();
  }
}
function refreshSoloBestLobby() {
  const el = $('solo-best-lobby');
  if (!el) return;
  const best = getSoloBest();
  if (best > 0) {
    el.textContent = `🏆 ひとりモード ベスト: ${best}問`;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

// ---- canvas drawing ----
const COLORS = ['#111111'];

let isDrawing     = false;
let currentStroke = [];
let penColor      = '#111111';
let brushSize     = 8;
let eraserOn      = false;

// ---- DOM shortcuts ----
const $ = id => document.getElementById(id);
let devHoldTimer = null;
let resultsTerminalTimer = null;
let soloTerminalTimer = null;
let pendingFinalResults = null;
let showingFinalResults = false;
let audioCtx = null;
let masterGain = null;
let lastButtonSoundAt = 0;
let bgmGain = null;
let bgmTimer = null;
let bgmMode = null;
let bgmNextNoteTime = 0;
let bgmStep = 0;

function getAudioContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) audioCtx = new Ctx();
  return audioCtx;
}

function getMasterGain() {
  const ctx = getAudioContext();
  if (!ctx) return null;
  if (!masterGain) {
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.2;
    masterGain.connect(ctx.destination);
  }
  return masterGain;
}

function getBgmGain() {
  const ctx = getAudioContext();
  if (!ctx) return null;
  if (!bgmGain) {
    bgmGain = ctx.createGain();
    bgmGain.gain.value = 0.0001;
    bgmGain.connect(ctx.destination);
  }
  return bgmGain;
}

function warmAudioGraph(ctx, output) {
  if (!ctx || !output) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 440;
  gain.gain.value = 0.00001;
  osc.connect(gain);
  gain.connect(output);
  osc.start();
  osc.stop(ctx.currentTime + 0.01);
}

function playButtonTapTone() {
  const ctx = getAudioContext();
  const output = getMasterGain();
  if (!ctx || !output) return;

  const start = ctx.currentTime + 0.001;
  const oscA = ctx.createOscillator();
  const oscB = ctx.createOscillator();
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();

  oscA.type = 'square';
  oscB.type = 'sawtooth';
  oscA.frequency.setValueAtTime(920, start);
  oscA.frequency.exponentialRampToValueAtTime(610, start + 0.045);
  oscB.frequency.setValueAtTime(460, start + 0.002);
  oscB.frequency.exponentialRampToValueAtTime(280, start + 0.045);
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(1450, start);
  filter.Q.value = 1.6;

  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(0.12, start + 0.003);
  gain.gain.exponentialRampToValueAtTime(0.018, start + 0.028);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.06);

  oscA.connect(filter);
  oscB.connect(filter);
  filter.connect(gain);
  gain.connect(output);

  oscA.start(start);
  oscB.start(start);
  oscA.stop(start + 0.065);
  oscB.stop(start + 0.065);
}

function playBackButtonTone() {
  const ctx = getAudioContext();
  const output = getMasterGain();
  if (!ctx || !output) return;

  const start = ctx.currentTime + 0.001;
  const oscA = ctx.createOscillator();
  const oscB = ctx.createOscillator();
  const gain = ctx.createGain();

  oscA.type = 'triangle';
  oscB.type = 'sine';
  oscA.frequency.setValueAtTime(760, start);
  oscA.frequency.exponentialRampToValueAtTime(380, start + 0.11);
  oscB.frequency.setValueAtTime(510, start + 0.003);
  oscB.frequency.exponentialRampToValueAtTime(250, start + 0.11);

  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(0.1, start + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);

  oscA.connect(gain);
  oscB.connect(gain);
  gain.connect(output);

  oscA.start(start);
  oscB.start(start);
  oscA.stop(start + 0.14);
  oscB.stop(start + 0.14);
}

function triggerButtonSound(kind = 'forward') {
  const now = Date.now();
  if (now - lastButtonSoundAt < 90) return;
  lastButtonSoundAt = now;

  const ctx = getAudioContext();
  const output = getMasterGain();
  if (!ctx || !output) return;

  const play = () => {
    warmAudioGraph(ctx, output);
    if (kind === 'back') {
      playBackButtonTone();
    } else {
      playButtonTapTone();
    }
    syncBgmForState();
  };

  if (ctx.state === 'suspended') {
    ctx.resume().then(play).catch(() => {});
    return;
  }

  play();
}

const BGM_LOOKAHEAD_MS = 120;
const BGM_SCHEDULE_AHEAD_SEC = 0.45;
const GAME_BGM_STEP_SEC = 60 / 68 / 2;
const RESULT_BGM_STEP_SEC = 60 / 96 / 2;

function midiToHz(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

function scheduleBgmPluck(note, start, duration, volume, type = 'triangle') {
  const ctx = getAudioContext();
  const output = getBgmGain();
  if (!ctx || !output || note == null) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();

  osc.type = type;
  osc.frequency.setValueAtTime(midiToHz(note), start);
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(type === 'sine' ? 1200 : 2200, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(volume, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(Math.max(volume * 0.26, 0.0001), start + duration * 0.5);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(output);

  osc.start(start);
  osc.stop(start + duration + 0.03);
}

function scheduleBgmPad(notes, start, duration, volume) {
  const ctx = getAudioContext();
  const output = getBgmGain();
  if (!ctx || !output || !notes?.length) return;

  notes.forEach((note, index) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc.type = index % 2 === 0 ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(midiToHz(note), start);
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1650, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(volume / notes.length, start + 0.22);
    gain.gain.linearRampToValueAtTime((volume / notes.length) * 0.82, start + duration * 0.7);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(output);

    osc.start(start);
    osc.stop(start + duration + 0.05);
  });
}

function scheduleBgmPulse(note, start, volume) {
  const ctx = getAudioContext();
  const output = getBgmGain();
  if (!ctx || !output || note == null) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(midiToHz(note), start);
  osc.frequency.exponentialRampToValueAtTime(midiToHz(note - 12), start + 0.12);
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(560, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(volume, start + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(output);

  osc.start(start);
  osc.stop(start + 0.16);
}

function scheduleBgmShimmer(note, start, duration, volume) {
  const ctx = getAudioContext();
  const output = getBgmGain();
  if (!ctx || !output || note == null) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(midiToHz(note), start);
  osc.frequency.linearRampToValueAtTime(midiToHz(note + 5), start + duration * 0.45);
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(1900, start);
  filter.Q.value = 1.8;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(volume, start + 0.04);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(output);

  osc.start(start);
  osc.stop(start + duration + 0.03);
}

function scheduleGameplayStep(time, step) {
  const localStep = step % 16;
  const chordIndex = Math.floor(localStep / 4);
  const chords = [
    [38, 45, 50],
    [36, 43, 48],
    [41, 48, 53],
    [34, 41, 46],
  ];
  const subBass = [26, null, null, null, 24, null, null, null, 29, null, null, null, 22, null, null, null];
  const pulse = [null, 50, null, null, null, 48, null, null, null, 53, null, null, null, 46, null, null];
  const shimmer = [74, null, null, 77, null, null, 76, null, 79, null, null, 81, null, null, 77, null];
  const air = [86, null, 84, null, null, 83, null, null, 88, null, 86, null, null, 84, null, null];

  if (localStep % 4 === 0) {
    scheduleBgmPad(chords[chordIndex], time, GAME_BGM_STEP_SEC * 5.8, 0.06);
  }
  if (localStep % 8 === 0) {
    scheduleBgmPulse(24 + chordIndex, time, 0.05);
  }
  scheduleBgmPluck(subBass[localStep], time, GAME_BGM_STEP_SEC * 2.4, 0.048, 'sine');
  scheduleBgmPluck(pulse[localStep], time + 0.03, GAME_BGM_STEP_SEC * 1.2, 0.018, 'triangle');
  scheduleBgmShimmer(shimmer[localStep], time + 0.12, GAME_BGM_STEP_SEC * 2.7, 0.018);
  scheduleBgmShimmer(air[localStep], time + 0.2, GAME_BGM_STEP_SEC * 2.2, 0.011);
}

function scheduleResultStep(time, step) {
  const localStep = step % 16;
  const chordIndex = Math.floor(localStep / 4);
  const chords = [
    [55, 62, 67],
    [57, 60, 64],
    [59, 64, 67],
    [60, 64, 69],
  ];
  const bass = [43, null, 43, 50, 45, null, 45, 52, 47, null, 47, 54, 48, null, 50, 55];
  const bell = [79, 81, 83, 86, 84, 83, 81, 84, 86, 88, 91, 88, 86, 84, 83, 79];
  const counter = [67, null, 69, null, 71, null, 72, null, 74, null, 76, null, 77, null, 79, null];

  if (localStep % 4 === 0) {
    scheduleBgmPad(chords[chordIndex], time, RESULT_BGM_STEP_SEC * 4.8, 0.092);
  }
  if (localStep % 2 === 0) {
    scheduleBgmPulse(31 + (localStep >= 8 ? 2 : 0), time, 0.054);
  }
  scheduleBgmPluck(bass[localStep], time, RESULT_BGM_STEP_SEC * 1.15, 0.078, 'triangle');
  scheduleBgmPluck(counter[localStep], time + 0.03, RESULT_BGM_STEP_SEC * 0.72, 0.044, 'sine');
  scheduleBgmPluck(bell[localStep], time + 0.06, RESULT_BGM_STEP_SEC * 0.88, 0.062, 'triangle');
}

function scheduleBgmLoop() {
  const ctx = getAudioContext();
  const output = getBgmGain();
  if (!ctx || !output || !bgmMode) return;
  if (ctx.state !== 'running') return;

  const stepDuration = bgmMode === 'results' ? RESULT_BGM_STEP_SEC : GAME_BGM_STEP_SEC;
  while (bgmNextNoteTime < ctx.currentTime + BGM_SCHEDULE_AHEAD_SEC) {
    if (bgmMode === 'results') {
      scheduleResultStep(bgmNextNoteTime, bgmStep);
    } else {
      scheduleGameplayStep(bgmNextNoteTime, bgmStep);
    }
    bgmNextNoteTime += stepDuration;
    bgmStep += 1;
  }
}

function stopBgm() {
  if (bgmTimer) {
    clearInterval(bgmTimer);
    bgmTimer = null;
  }
  bgmMode = null;
  bgmStep = 0;
  bgmNextNoteTime = 0;

  const ctx = getAudioContext();
  const output = getBgmGain();
  if (!ctx || !output) return;
  output.gain.cancelScheduledValues(ctx.currentTime);
  output.gain.setValueAtTime(Math.max(output.gain.value, 0.0001), ctx.currentTime);
  output.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
}

function startBgm(mode) {
  const ctx = getAudioContext();
  const output = getBgmGain();
  if (!ctx || !output) return;
  if (ctx.state !== 'running') return;

  if (bgmTimer) {
    clearInterval(bgmTimer);
    bgmTimer = null;
  }

  bgmMode = mode;
  bgmStep = 0;
  bgmNextNoteTime = ctx.currentTime + 0.03;
  output.gain.cancelScheduledValues(ctx.currentTime);
  output.gain.setValueAtTime(Math.max(output.gain.value, 0.0001), ctx.currentTime);
  output.gain.exponentialRampToValueAtTime(mode === 'results' ? 0.145 : 0.16, ctx.currentTime + 0.25);
  scheduleBgmLoop();
  bgmTimer = setInterval(scheduleBgmLoop, BGM_LOOKAHEAD_MS);
}

function syncBgmForState(screenName = null) {
  const activeScreen = screenName || document.querySelector('.screen.active')?.id?.replace('screen-', '') || 'lobby';
  const shouldPlayFinal = activeScreen === 'results' && showingFinalResults;
  const shouldPlayGameplay = !soloMode && !shouldPlayFinal && ['topic', 'drawing', 'guessing', 'results'].includes(activeScreen);

  if (shouldPlayFinal) {
    if (bgmMode !== 'results') startBgm('results');
    return;
  }
  if (shouldPlayGameplay) {
    if (bgmMode !== 'gameplay') startBgm('gameplay');
    return;
  }
  if (bgmMode) stopBgm();
}

// ---- URL招待パラメータ ----
const _urlRoomCode = new URLSearchParams(location.search).get('room')?.toUpperCase().trim() || null;
if (_urlRoomCode) history.replaceState(null, '', location.pathname);


function getWinnerLabel({ aiFiltered, roundWinner, humanWin, gameOver, matchWinner }) {
  if (gameOver && matchWinner) {
    return matchWinner === 'human' ? '人間チーム' : 'AI';
  }
  if (aiFiltered) return '判定なし';
  switch (roundWinner) {
    case 'human': return '人間チーム';
    case 'ai': return humanWin ? 'AI（両者正解）' : 'AI';
    case 'both': return '引き分け';
    case 'none': return '勝者なし';
    default: return '不明';
  }
}

function getAiReasonText({ aiReason, aiFiltered }) {
  if (aiReason) return aiReason;
  if (aiFiltered) return 'セーフティフィルターにより回答理由を生成できませんでした';
  return 'AI の推測理由を取得できませんでした';
}

function appendResultTerminalLine(linesEl, text, className = '') {
  const line = document.createElement('div');
  line.className = `howto-line result-line${className ? ` ${className}` : ''}`;
  line.textContent = text;
  linesEl.appendChild(line);
}

const RESULTS_TERMINAL_TEXT_DELAY_MS = 1500;
const RESULTS_TERMINAL_SPACER_DELAY_MS = 700;
const RESULTS_TERMINAL_CHAR_DELAY_MS = 34;

function getResultsTerminalCharDelay(ch) {
  if (/[。、]/.test(ch)) return 140;
  if (/[,.]/.test(ch)) return 90;
  if (/\s/.test(ch)) return 18;
  if (/[:>\-[\]]/.test(ch)) return 24;
  if (/[A-Za-z0-9]/.test(ch)) return 22;
  return RESULTS_TERMINAL_CHAR_DELAY_MS;
}

function clearResultsTerminalAnimation() {
  if (!resultsTerminalTimer) return;
  clearTimeout(resultsTerminalTimer);
  resultsTerminalTimer = null;
}

function playTerminalLines(linesEl, queuedLines, onComplete = () => {}) {
  clearResultsTerminalAnimation();
  linesEl.innerHTML = '';

  let index = 0;
  function paintNextLine() {
    if (index >= queuedLines.length) {
      resultsTerminalTimer = null;
      onComplete();
      return;
    }
    const { text, className } = queuedLines[index++];
    const line = document.createElement('div');
    line.className = `howto-line result-line${className ? ` ${className}` : ''}`;
    linesEl.appendChild(line);
    linesEl.scrollTop = linesEl.scrollHeight;

    if (!text) {
      resultsTerminalTimer = setTimeout(paintNextLine, RESULTS_TERMINAL_SPACER_DELAY_MS);
      return;
    }

    let charIndex = 0;
    function typeNextChar() {
      if (charIndex >= text.length) {
        resultsTerminalTimer = setTimeout(paintNextLine, RESULTS_TERMINAL_TEXT_DELAY_MS);
        return;
      }
      const ch = text[charIndex++];
      line.textContent += ch;
      linesEl.scrollTop = linesEl.scrollHeight;
      resultsTerminalTimer = setTimeout(typeNextChar, getResultsTerminalCharDelay(ch));
    }

    typeNextChar();
  }

  paintNextLine();
}

function setResultsView(mode) {
  const isFinal = mode === 'final';
  showingFinalResults = isFinal;
  $('screen-results').classList.toggle('final-summary-active', isFinal);
  $('final-results-panel').classList.toggle('hidden', !isFinal);
}

function getFinalRoundWinnerLabel(roundWinner) {
  switch (roundWinner) {
    case 'human': return '人間チーム';
    case 'ai': return 'AI';
    case 'both': return '引き分け';
    case 'none': return '判定なし';
    default: return '記録なし';
  }
}

function renderFinalGallery(roundHistory) {
  const gallery = $('drawings-gallery');
  if (!roundHistory?.length) {
    gallery.classList.add('hidden');
    return;
  }

  const list = $('drawings-list');
  list.innerHTML = '';
  roundHistory.forEach(({ drawing, topic, drawerName }) => {
    const card = document.createElement('div');
    card.className = 'drawing-card';
    const img = document.createElement('img');
    img.src = drawing;
    img.alt = topic;
    const info = document.createElement('div');
    info.className = 'drawing-card-info';
    info.innerHTML = `<div class="drawing-card-topic">${esc(topic)}</div>${esc(drawerName)}`;
    card.appendChild(img);
    card.appendChild(info);
    list.appendChild(card);
  });
  gallery.classList.remove('hidden');
}

function showFinalResults() {
  if (!pendingFinalResults) return;
  clearResultsTerminalAnimation();
  setResultsView('final');
  $('screen-results').scrollTop = 0;
  syncBgmForState('results');

  const { matchWinner, scores, roundHistory } = pendingFinalResults;
  const linesEl = $('final-results-terminal-lines');
  const queuedLines = [
    { text: '> ARCHIVE OPENED :: thank you for drawing with us', className: 'result-topic-line' },
    { text: matchWinner === 'human'
      ? '> 人のひらめきが最後まで光っていました。付き合ってくれて、ありがとう。'
      : '> 最後までこの勝負を見届けてくれて、ありがとう。AI も本気でした。', className: 'result-dim' },
    { text: `> FINAL WINNER :: ${matchWinner === 'human' ? '人間チーム' : 'AI'}`, className: matchWinner === 'human' ? 'result-correct' : 'result-ai' },
    { text: `> FINAL SCORE :: HUMAN ${scores.human} / AI ${scores.ai}`, className: 'result-topic-line' },
    { text: '', className: 'result-spacer' },
  ];

  roundHistory.forEach((round, index) => {
    queuedLines.push({
      text: `> ROUND ${String(index + 1).padStart(2, '0')} :: お題「${round.topic}」 / DRAWER ${round.drawerName}`,
      className: 'result-topic-line',
    });
    if (round.guesses?.length) {
      round.guesses.forEach((guess) => {
        queuedLines.push({
          text: `>   ${guess.name} :: ${guess.answer}`,
          className: guess.correct ? 'result-correct' : 'result-wrong',
        });
      });
    } else {
      queuedLines.push({ text: '>   HUMAN :: 回答なし', className: 'result-dim' });
    }
    queuedLines.push({ text: `>   AI :: ${round.aiGuess || '回答なし'}`, className: 'result-ai' });
    queuedLines.push({ text: `>   ROUND WINNER :: ${getFinalRoundWinnerLabel(round.roundWinner)}`, className: 'result-dim' });
    queuedLines.push({ text: '', className: 'result-spacer' });
  });

  queuedLines.push({ text: '> LOG COMPLETE :: また次のラウンドで会いましょう。', className: 'result-topic-line' });
  playTerminalLines(linesEl, queuedLines);
  renderFinalGallery(roundHistory);

  const me = players.find(p => p.id === myId);
  const isHost = me?.isHost ?? false;
  $('next-round-btn').classList.add('hidden');
  $('play-again-btn').classList.toggle('hidden', !isHost);
  $('leave-room-btn').classList.remove('hidden');
}

function animateScoreUpdate(el, nextValue) {
  if (!el) return;
  const prevValue = el.textContent;
  const nextText = String(nextValue);
  el.textContent = nextText;
  if (prevValue !== nextText) {
    el.classList.remove('score-updated');
    void el.offsetWidth;
    el.classList.add('score-updated');
  }
}

function renderResultsTerminal(res, onComplete = () => {}) {
  const linesEl = $('results-terminal-lines');
  if (!linesEl) {
    onComplete();
    return;
  }

  const {
    topic, guesses, aiGuess, aiReason, aiCorrect, aiFiltered, humanWin,
    roundWinner, gameOver, matchWinner,
  } = res;

  const queuedLines = [];
  const entries = Object.values(guesses || {});
  if (entries.length === 0) {
    queuedLines.push({ text: '> 人間チーム :: 回答なし', className: 'result-dim' });
  } else {
    entries.forEach((guess) => {
      queuedLines.push({
        text: `> ${guess.name} :: ${guess.answer}`,
        className: guess.correct ? 'result-correct' : 'result-wrong',
      });
    });
  }

  queuedLines.push({ text: '', className: 'result-spacer' });
  queuedLines.push({
    text: `> AI :: ${aiGuess || '回答なし'}`,
    className: aiCorrect ? 'result-correct' : 'result-ai',
  });
  queuedLines.push({
    text: `> AI_REASON :: ${getAiReasonText({ aiReason, aiFiltered })}`,
    className: 'result-dim',
  });
  queuedLines.push({ text: '', className: 'result-spacer' });
  queuedLines.push({ text: `> 今回のお題 :: ${topic}`, className: 'result-topic-line' });
  queuedLines.push({
    text: `> WINNER :: ${getWinnerLabel({ aiFiltered, roundWinner, humanWin, gameOver, matchWinner })}`,
    className: gameOver && matchWinner === 'human'
      ? 'result-correct'
      : gameOver && matchWinner === 'ai'
        ? 'result-ai'
        : 'result-topic-line',
  });

  playTerminalLines(linesEl, queuedLines, onComplete);
}

function clearSoloTerminalAnimation() {
  if (!soloTerminalTimer) return;
  clearTimeout(soloTerminalTimer);
  soloTerminalTimer = null;
}

function playSoloTerminalLines(linesEl, queuedLines) {
  clearSoloTerminalAnimation();
  linesEl.innerHTML = '';
  let index = 0;
  function paintNextLine() {
    if (index >= queuedLines.length) { soloTerminalTimer = null; return; }
    const { text, className } = queuedLines[index++];
    const line = document.createElement('div');
    line.className = `howto-line result-line${className ? ` ${className}` : ''}`;
    linesEl.appendChild(line);
    linesEl.scrollTop = linesEl.scrollHeight;
    if (!text) {
      soloTerminalTimer = setTimeout(paintNextLine, RESULTS_TERMINAL_SPACER_DELAY_MS);
      return;
    }
    let charIndex = 0;
    function typeNextChar() {
      if (charIndex >= text.length) {
        soloTerminalTimer = setTimeout(paintNextLine, RESULTS_TERMINAL_TEXT_DELAY_MS);
        return;
      }
      line.textContent += text[charIndex++];
      linesEl.scrollTop = linesEl.scrollHeight;
      soloTerminalTimer = setTimeout(typeNextChar, getResultsTerminalCharDelay(text[charIndex - 1]));
    }
    typeNextChar();
  }
  paintNextLine();
}

function renderSoloResultTerminal({ aiGuess, correct, topic, aiFiltered, streak, prevStreak }) {
  const linesEl = $('solo-result-terminal-lines');
  if (!linesEl) return;

  const lines = [];
  lines.push({ text: '> DRAWING UPLOAD :: complete', className: 'result-dim' });
  lines.push({ text: '> AI_SCAN :: neural pattern recognition — initializing...', className: 'result-dim' });
  lines.push({ text: '', className: 'result-spacer' });

  if (aiFiltered) {
    lines.push({ text: '> AI_SCAN :: CONTENT FILTER TRIGGERED — 回答不能', className: 'result-wrong' });
    lines.push({ text: '', className: 'result-spacer' });
    lines.push({ text: `> お題 :: ${topic}`, className: 'result-topic-line' });
    lines.push({ text: '> VERDICT :: VOID — 判定スキップ', className: 'result-dim' });
  } else {
    lines.push({ text: `> AI :: ${aiGuess}`, className: correct ? 'result-correct' : 'result-wrong' });
    lines.push({ text: '', className: 'result-spacer' });
    lines.push({ text: `> お題 :: ${topic}`, className: 'result-topic-line' });
    lines.push({ text: '', className: 'result-spacer' });
    if (correct) {
      lines.push({ text: '> VERDICT :: RECOGNIZED — 絵師の意図、AIに届いた', className: 'result-correct' });
      lines.push({ text: `> STREAK :: ${streak}問連続正解 — 画力認定済み`, className: 'result-topic-line' });
    } else {
      lines.push({ text: '> VERDICT :: UNRECOGNIZED — AIの理解を超えた絵だった', className: 'result-wrong' });
      if (prevStreak > 0) {
        lines.push({ text: `> STREAK BROKEN :: ${prevStreak}問連続記録 — リセット`, className: 'result-dim' });
      } else {
        lines.push({ text: '> STREAK :: 0 — まだ記録なし', className: 'result-dim' });
      }
    }
  }

  playSoloTerminalLines(linesEl, lines);
}


function enableDeveloperUnlimited(password) {
  devPassword = password;
  socket.emit('enable_dev_mode', { password, sessionId: mySessionId });
}

function promptDeveloperMode() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';

  const box = document.createElement('div');
  box.style.cssText = 'background:#010a01;border:1px solid rgba(0,255,65,0.3);border-radius:8px;padding:24px;width:100%;max-width:280px;';
  box.innerHTML =
    '<p style="color:#00ff41;margin-bottom:14px;font-size:0.88rem;letter-spacing:0.05em;">開発者パスワード</p>' +
    '<input type="tel" inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="20"' +
    '  style="width:100%;padding:12px;background:#000;border:1px solid rgba(0,255,65,0.4);color:#00ff41;font-size:1.4rem;letter-spacing:0.4em;text-align:center;border-radius:4px;margin-bottom:14px;outline:none;">' +
    '<div style="display:flex;gap:8px;">' +
    '  <button style="flex:1;padding:11px;background:transparent;border:1px solid rgba(0,255,65,0.2);color:#2e6e2e;border-radius:4px;font-size:0.9rem;">キャンセル</button>' +
    '  <button style="flex:1;padding:11px;background:rgba(0,60,0,0.8);border:1px solid rgba(0,255,65,0.5);color:#00ff41;border-radius:4px;font-size:0.9rem;font-weight:700;">OK</button>' +
    '</div>';

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const input    = box.querySelector('input');
  const [cancelBtn, okBtn] = box.querySelectorAll('button');
  input.focus();

  function submit() {
    const val = input.value.trim();
    document.body.removeChild(overlay);
    if (!val) return;
    enableDeveloperUnlimited(val);
  }
  function close() { document.body.removeChild(overlay); }

  okBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

socket.on('dev_mode_result', (success) => {
  if (success) {
    devUnlimited = true;
    alert('開発者モードを有効にしました。ルーム作成制限は無効です。');
  } else {
    devUnlimited = false;
    devPassword  = null;
    alert('パスワードが違います。');
  }
});

function clearDevHoldTimer() {
  if (!devHoldTimer) return;
  clearTimeout(devHoldTimer);
  devHoldTimer = null;
}

function startDevHold() {
  clearDevHoldTimer();
  devHoldTimer = setTimeout(() => {
    devHoldTimer = null;
    promptDeveloperMode();
  }, DEV_HOLD_MS);
}

function initHowtoTerminal() {
  const linesEl = document.getElementById('howto-lines');
  if (!linesEl) return;

  // segs: array of { t } (plain) or { kana, kanji } (IME conversion)
  const LINES = [
    { segs: [{ t: '$ artdecode.exe --boot' }], pause: 700 },
    { segs: [{ t: '' }], pause: 120 },
    { segs: [{ t: '  SYSTEM LINK............ ESTABLISHED' }], pause: 80 },
    { segs: [{ t: '  AI CORE................ ONLINE' }], pause: 260 },
    { segs: [{ t: '' }], pause: 60 },
    { segs: [
      { t: '  ─── ' },
      { kana: 'さくせん',    kanji: '作戦' },
      { kana: 'しれいしょ',  kanji: '指令書' },
      { t: ' ────────────────' },
    ], pause: 100 },
    { segs: [{ t: '' }], pause: 50 },
    { segs: [
      { t: '  // MISSION 01  ひとりで' },
      { kana: 'あそぶ', kanji: '遊ぶ' },
    ], pause: 160 },
    { segs: [
      { t: '  AIが"' },
      { kana: 'ふういん',  kanji: '封印' },
      { t: 'されたお' },
      { kana: 'だい',      kanji: '題' },
      { t: '"を' },
      { kana: 'せんてい',  kanji: '選定' },
      { t: 'する' },
    ], pause: 55 },
    { segs: [
      { t: '  ' },
      { kana: 'なんじ',        kanji: '汝' },
      { t: 'に' },
      { kana: 'あたえられた',  kanji: '与えられた' },
      { kana: 'じかん',        kanji: '時間' },
      { t: 'は60' },
      { kana: 'びょう',        kanji: '秒' },
      { t: 'のみ' },
    ], pause: 55 },
    { segs: [
      { t: '  ' },
      { kana: 'ぜんりょく',  kanji: '全力' },
      { t: 'の' },
      { kana: 'がりょく',    kanji: '画力' },
      { t: 'でAIを' },
      { kana: 'うなら',      kanji: '唸ら' },
      { t: 'せろ' },
    ], pause: 55 },
    { segs: [
      { t: '  ' },
      { kana: 'れんぞく',      kanji: '連続' },
      { kana: 'せいかいすう',  kanji: '正解数' },
      { t: 'が' },
      { kana: 'まこと',        kanji: '真' },
      { t: 'の' },
      { kana: 'じつりょく',    kanji: '実力' },
      { t: 'を' },
      { kana: 'しょうめい',    kanji: '証明' },
      { t: 'する' },
    ], pause: 240 },
    { segs: [{ t: '' }], pause: 50 },
    { segs: [
      { t: '  // MISSION 02  みんなで' },
      { kana: 'あそぶ', kanji: '遊ぶ' },
    ], pause: 160 },
    { segs: [
      { t: '  ' },
      { kana: 'かきて',    kanji: '描き手' },
      { t: 'のみが' },
      { kana: 'しる',      kanji: '知る' },
      { t: '「' },
      { kana: 'きんだん',  kanji: '禁断' },
      { t: 'のお' },
      { kana: 'だい',      kanji: '題' },
      { t: '」' },
    ], pause: 55 },
    { segs: [
      { t: '  60' },
      { kana: 'びょう',    kanji: '秒' },
      { t: 'で' },
      { kana: 'たましい',  kanji: '魂' },
      { t: 'を' },
      { kana: 'こめた',    kanji: '込めた' },
      { kana: 'え',        kanji: '絵' },
      { t: 'を' },
      { kana: 'かんせい',  kanji: '完成' },
      { t: 'させろ' },
    ], pause: 55 },
    { segs: [
      { t: '  ' },
      { kana: 'なかま',    kanji: '仲間' },
      { t: 'とAIが' },
      { kana: 'しんじつ',  kanji: '真実' },
      { t: 'を' },
      { kana: 'あばこう',  kanji: '暴こう' },
      { t: 'とする' },
    ], pause: 55 },
    { segs: [
      { t: '  ' },
      { kana: 'にんげん',  kanji: '人間' },
      { t: 'の' },
      { kana: 'えいち',    kanji: '叡智' },
      { t: 'でAIを' },
      { kana: 'りょうが',  kanji: '凌駕' },
      { t: 'せよ' },
    ], pause: 260 },
    { segs: [{ t: '' }], pause: 80 },
    { segs: [
      { t: '> ' },
      { kana: 'なまえ',       kanji: '名前' },
      { t: 'を' },
      { kana: 'にゅうりょく', kanji: '入力' },
      { t: 'し、' },
      { kana: 'たたかい',     kanji: '戦い' },
      { t: 'に' },
      { kana: 'そなえよ',     kanji: '備えよ' },
    ], pause: 3400 },
  ];

  let timer = null;
  let lineIdx = 0;
  let segIdx  = 0;
  let charIdx = 0;
  let lineEl  = null;
  let segEl   = null;
  let cursor  = makeCursor();
  linesEl.appendChild(cursor);

  function makeCursor() {
    const c = document.createElement('span');
    c.className = 'howto-cursor';
    return c;
  }

  function charDelay(ch, isKana) {
    const code = ch.charCodeAt(0);
    if (isKana && code >= 0x3040 && code <= 0x30FF) return 36;
    if (code > 0x3000) return 65;
    if (ch === '─') return 18;
    if (ch === ' ') return 26;
    return 38;
  }

  function tick() {
    if (lineIdx >= LINES.length) {
      linesEl.style.transition = 'opacity 0.55s ease';
      linesEl.style.opacity = '0';
      timer = setTimeout(() => {
        linesEl.innerHTML = '';
        linesEl.style.transition = 'none';
        linesEl.style.opacity = '1';
        cursor = makeCursor();
        linesEl.appendChild(cursor);
        lineIdx = 0; segIdx = 0; charIdx = 0;
        lineEl = null; segEl = null;
        timer = setTimeout(tick, 320);
      }, 650);
      return;
    }

    const line = LINES[lineIdx];

    // 行の先頭：.howto-line 要素を作成
    if (segIdx === 0 && charIdx === 0) {
      lineEl = document.createElement('span');
      lineEl.className = 'howto-line';
      linesEl.insertBefore(lineEl, cursor);
    }

    // 行の全セグメント完了
    if (segIdx >= line.segs.length) {
      linesEl.scrollTop = linesEl.scrollHeight;
      lineIdx++; segIdx = 0; charIdx = 0;
      lineEl = null; segEl = null;
      timer = setTimeout(tick, line.pause);
      return;
    }

    const seg = line.segs[segIdx];
    const src = seg.kana || seg.t;

    // セグメント先頭：span を作成して行に追加
    if (charIdx === 0) {
      segEl = document.createElement('span');
      if (seg.kana) segEl.className = 'ime-pending';
      lineEl.appendChild(segEl);
    }

    if (charIdx < src.length) {
      segEl.textContent += src[charIdx++];
      linesEl.scrollTop = linesEl.scrollHeight;
      timer = setTimeout(tick, charDelay(src[charIdx - 1], !!seg.kana));
    } else if (seg.kana) {
      // 変換：ハイライト → 漢字に置換
      segEl.classList.replace('ime-pending', 'ime-converting');
      timer = setTimeout(() => {
        segEl.textContent = seg.kanji;
        segEl.classList.remove('ime-converting');
        segEl = null;
        segIdx++; charIdx = 0;
        timer = setTimeout(tick, 40);
      }, 260);
    } else {
      segEl = null;
      segIdx++; charIdx = 0;
      timer = setTimeout(tick, 0);
    }
  }

  tick();
}

function setupDeveloperHotspot() {
  const hotspot = $('dev-hotspot');
  if (!hotspot) return;

  hotspot.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    startDevHold();
  });
  hotspot.addEventListener('pointerup', clearDevHoldTimer);
  hotspot.addEventListener('pointerleave', clearDevHoldTimer);
  hotspot.addEventListener('pointercancel', clearDevHoldTimer);
  hotspot.addEventListener('touchstart', (event) => {
    event.preventDefault();
    startDevHold();
  }, { passive: false });
  hotspot.addEventListener('touchend', clearDevHoldTimer);
  hotspot.addEventListener('touchcancel', clearDevHoldTimer);
  hotspot.addEventListener('contextmenu', (event) => event.preventDefault());
  hotspot.addEventListener('selectstart', (event) => event.preventDefault());
}

setupDeveloperHotspot();
refreshSoloBestLobby();
initHowtoTerminal();

// ---- screen management ----
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const s = $(`screen-${name}`);
  if (s) s.classList.add('active');
  syncBgmForState(name);
}

// ===== SOCKET EVENTS =====

socket.on('connect', () => {
  myId = socket.id;
  if (devUnlimited && devPassword) socket.emit('enable_dev_mode', { password: devPassword, sessionId: mySessionId });
  // 再接続：名前・ルームコード・セッションIDが揃っていれば自動復帰
  if (myName && myRoomCode && mySessionId) {
    socket.emit('join_room', { name: myName, roomCode: myRoomCode, sessionId: mySessionId });
  }
});

socket.on('joined', ({ sessionId, roomCode }) => {
  mySessionId = sessionId;
  myRoomCode  = roomCode;
  localStorage.setItem(SESSION_KEY, sessionId);
  localStorage.setItem(ROOM_KEY, roomCode);
  if (devUnlimited && devPassword) socket.emit('enable_dev_mode', { password: devPassword, sessionId });
});

socket.on('game_update', (state) => {
  const prevPhase = phase;
  players = state.players;
  phase   = state.phase;
  lastPhase = state.phase;
  const me = players.find(p => p.id === myId);
  amDrawer = me?.isDrawer ?? false;


  if (state.phase === 'lobby' && myName) refreshLobby(state);
  if (state.phase === 'guessing')        updateGuessCount(state);
  if (state.phase === 'guessing' && state.drawingData) restoreGuessingState(state);
});

socket.on('your_topic', (topic) => {
  $('topic-display').textContent = topic;
  $('topic-banner').classList.remove('hidden');
  $('spectator-banner').classList.add('hidden');
  $('draw-tools').classList.remove('hidden');
});

socket.on('drawing_timer_tick', (t) => {
  const badge = $('drawing-timer-badge');
  if (!badge) return;
  badge.textContent = t;
  badge.classList.toggle('urgent', t <= 10);
});

socket.on('drawing_timeout', () => {
  if (!amDrawer) return;
  const btn = $('submit-drawing-btn');
  if (!btn || btn.disabled) return;
  btn.click();
});

socket.on('draw_stroke', (stroke) => {
  const canvas = $('draw-canvas');
  if (canvas) renderStroke(canvas.getContext('2d'), stroke);
});

socket.on('canvas_clear', () => {
  const c = $('draw-canvas');
  if (c) fillWhite(c);
});

socket.on('guessing_start', ({ imageData, genre }) => {
  showScreen('guessing');
  renderGuessCanvas(imageData);
  const genreLabel = $('guess-genre-label');
  if (genreLabel) genreLabel.textContent = genre ? `ジャンル: ${genre}` : '';

  if (amDrawer) {
    $('guess-form').classList.add('hidden');
    $('guessed-msg').classList.add('hidden');
    $('drawer-wait-msg').classList.remove('hidden');
  } else {
    $('guess-form').classList.remove('hidden');
    $('guessed-msg').classList.add('hidden');
    $('drawer-wait-msg').classList.add('hidden');
  }
  $('guess-input').value = '';
  $('submit-guess-btn').disabled = false;
  $('timer-count').textContent = '60';
  setRingProgress(60);
  $('timer-count').classList.remove('urgent');
  $('ring-progress').classList.remove('urgent');
});

socket.on('timer_tick', (t) => {
  $('timer-count').textContent = t;
  setRingProgress(t);
  const urgent = t <= 10;
  $('timer-count').classList.toggle('urgent', urgent);
  $('ring-progress').classList.toggle('urgent', urgent);
});

socket.on('game_results', (res) => {
  showScreen('results');
  $('screen-results').scrollTop = 0;
  const { topic, guesses, aiGuess, aiCorrect, aiFiltered, humanWin, roundWinner,
          scores, isSuddenDeath, gameOver, matchWinner, drawerName, drawing } = res;
  const myGuess = guesses?.[myId];
  pendingFinalResults = gameOver ? res : null;
  setResultsView('round');
  syncBgmForState('results');


  // Sudden death banner (show when in SD and match not yet over)
  $('sudden-death-banner').classList.toggle('hidden', !isSuddenDeath || gameOver);
  renderResultsTerminal(res, () => {
    animateScoreUpdate($('score-human'), scores.human);
    animateScoreUpdate($('score-ai'), scores.ai);
  });

  // Match winner banner
  const mwBanner = $('match-winner-banner');
  const mwText   = $('match-winner-text');
  mwBanner.classList.add('hidden');
  mwBanner.className = 'match-winner-banner hidden';
  if (gameOver && matchWinner) {
    mwBanner.classList.remove('hidden');
    if (matchWinner === 'human') {
      mwBanner.classList.add('mw-human');
      mwText.textContent = '🎉 人間チームの優勝！';
    } else {
      mwBanner.classList.add('mw-ai');
      mwText.textContent = '🤖 AIの優勝！';
    }
  }

  // Round result banner
  $('result-topic').textContent  = topic;
  $('result-drawer').textContent = `（${drawerName} が描きました）`;

  const drawingCard = $('result-drawing-card');
  const drawingImage = $('result-drawing-image');
  const drawingMeta = $('result-drawing-meta');
  if (drawing) {
    drawingImage.src = drawing;
    drawingMeta.textContent = drawerName ? `${drawerName} のラウンド記録` : '';
    drawingCard.classList.remove('hidden');
  } else {
    drawingImage.removeAttribute('src');
    drawingMeta.textContent = '';
    drawingCard.classList.add('hidden');
  }

  $('ai-guess-text').textContent = aiGuess || '（回答なし）';
  const aiCard = $('ai-result-card');
  aiCard.classList.toggle('correct-card', aiCorrect);
  aiCard.classList.toggle('wrong-card', !aiCorrect);

  const ul = $('human-guesses');
  ul.innerHTML = '';
  const entries = Object.values(guesses);
  if (entries.length === 0) {
    $('no-guesses').classList.remove('hidden');
  } else {
    $('no-guesses').classList.add('hidden');
    entries.forEach(g => {
      const li = document.createElement('li');
      li.innerHTML =
        `<span class="g-name">${esc(g.name)}</span>` +
        `<span class="g-ans ${g.correct ? 'correct' : 'wrong'}">${esc(g.answer)}</span>` +
        (g.correct ? ' ✅' : ' ❌');
      ul.appendChild(li);
    });
  }

  const banner = $('winner-banner');
  const txt    = $('winner-text');
  banner.className = 'winner-banner';
  if (aiFiltered) {
    banner.classList.add('win-none');
    txt.textContent = '🚫 AIが回答できませんでした';
  } else if (isSuddenDeath && !gameOver) {
    if (roundWinner === 'none') {
      banner.classList.add('win-none');
      txt.textContent = '😅 両者不正解…サドンデス継続';
    } else {
      applyRoundBanner(banner, txt, roundWinner, humanWin);
    }
  } else {
    applyRoundBanner(banner, txt, roundWinner, humanWin);
  }

  $('drawings-gallery').classList.add('hidden');

  // ボタン表示
  const me = players.find(p => p.id === myId);
  const isHost = me?.isHost ?? false;
  $('next-round-btn').textContent = gameOver ? '最終結果へ' : '次のラウンドへ';
  $('next-round-btn').classList.toggle('hidden', gameOver ? false : !isHost);
  $('play-again-btn').classList.add('hidden');
  $('leave-room-btn').classList.add('hidden');
});

function applyRoundBanner(banner, txt, roundWinner, humanWin) {
  switch (roundWinner) {
    case 'human': banner.classList.add('win-human'); txt.textContent = '🎉 このラウンドは人間チームの勝ち！'; break;
    case 'ai':    banner.classList.add('win-ai');    txt.textContent = humanWin ? '🤖 両者正解！AIのポイント' : '🤖 このラウンドはAIの勝ち！'; break;
    case 'none':  banner.classList.add('win-none');  txt.textContent = '😅 誰も正解できませんでした';         break;
  }
}

socket.on('reset_game', () => {
  pendingFinalResults = null;
  setResultsView('round');
  $('drawings-gallery').classList.add('hidden');
  topicInputSetupDone = false;
  drawingSetupDone = false;
  showScreen('lobby');
  $('next-round-btn').textContent = '次のラウンドへ';
  $('play-again-btn').classList.add('hidden');
  $('next-round-btn').classList.add('hidden');
  $('leave-room-btn').classList.add('hidden');
  $('join-card').classList.add('hidden');
  $('lobby-info').classList.remove('hidden');
  refreshLobby({ players, phase: 'lobby' });
});

socket.on('game_aborted', (msg) => {
  pendingFinalResults = null;
  setResultsView('round');
  $('drawings-gallery').classList.add('hidden');
  topicInputSetupDone = false;
  drawingSetupDone = false;
  alert(msg);
  showScreen('lobby');
  amDrawer = false;
});

socket.on('error_msg', (msg) => {
  alert(msg);
  // 参加失敗時は入力画面へ戻す
  if (phase === 'lobby') {
    $('join-card').classList.remove('hidden');
    $('lobby-info').classList.add('hidden');
  }
});

// ===== LOBBY =====

// URL招待コードがある場合、専用の参加ボタンを先頭に挿入
if (_urlRoomCode) {
  const modeSelect = $('mode-select');
  const inviteBtn = document.createElement('button');
  inviteBtn.className = 'btn btn-success btn-block';
  inviteBtn.style.marginBottom = '10px';
  inviteBtn.textContent = `🔗 ルーム ${_urlRoomCode} に参加`;
  inviteBtn.addEventListener('click', () => {
    triggerButtonSound();
    const name = $('name-input').value.trim();
    if (!name) { alert('名前を入力してください。'); return; }
    myName = name;
    socket.emit('join_room', { name, roomCode: _urlRoomCode, sessionId: mySessionId });
    $('join-card').classList.add('hidden');
    $('lobby-info').classList.remove('hidden');
  });
  modeSelect.insertBefore(inviteBtn, modeSelect.firstChild);
}

$('solo-btn').addEventListener('click', startSoloMode);
$('multi-btn').addEventListener('click', () => {
  triggerButtonSound();
  const name = $('name-input').value.trim();
  if (!name) { alert('名前を入力してください。'); return; }
  $('mode-select').classList.add('hidden');
  $('multi-options').classList.remove('hidden');
});
$('back-to-mode-btn').addEventListener('click', () => {
  triggerButtonSound('back');
  $('multi-options').classList.add('hidden');
  $('mode-select').classList.remove('hidden');
});
$('create-room-btn').addEventListener('click', doCreateRoom);
$('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') { if (!$('multi-options').classList.contains('hidden')) doCreateRoom(); } });
$('show-rooms-btn').addEventListener('click', showRoomList);
$('lobby-back-btn').addEventListener('click', returnToEntryLobby);
$('back-to-lobby-btn').addEventListener('click', () => {
  triggerButtonSound('back');
  $('room-list-card').classList.add('hidden');
  $('join-card').classList.remove('hidden');
});
$('refresh-rooms-btn').addEventListener('click', () => {
  triggerButtonSound();
  socket.emit('get_rooms');
});

function startSoloMode() {
  triggerButtonSound();
  const name = $('name-input').value.trim();
  if (!name) { alert('名前を入力してください。'); return; }
  myName = name;
  socket.emit('solo_session_start', { sessionId: mySessionId });
}

socket.on('solo_session_result', (ok) => {
  if (!ok) {
    alert('ひとりモードは1日1回です。明日またチャレンジしてください！');
    return;
  }
  soloMode = true;
  soloStreak = 0;
  socket.emit('solo_start');
});

function exitSoloMode() {
  triggerButtonSound('back');
  clearSoloTerminalAnimation();
  soloMode = false;
  soloStreak = 0;
  soloTopic = null;
  soloCurrentImageData = null;
  showScreen('lobby');
  $('join-card').classList.remove('hidden');
  $('lobby-info').classList.add('hidden');
  $('multi-options').classList.add('hidden');
  $('mode-select').classList.remove('hidden');
}

socket.on('solo_topic', (topic) => {
  soloTopic = topic;
  $('solo-topic-text').textContent = topic;
  const badge = $('solo-streak-badge');
  if (soloStreak > 0) {
    $('solo-streak-count-badge').textContent = soloStreak;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
  showScreen('solo-topic');
});

socket.on('solo_result', ({ aiGuess, correct, topic, aiFiltered }) => {
  const prevStreak = soloStreak;
  if (correct) {
    soloStreak++;
  } else if (!aiFiltered) {
    updateSoloBest(prevStreak);
    soloStreak = 0;
  }

  renderSoloResultTerminal({ aiGuess, correct, topic, aiFiltered, streak: soloStreak, prevStreak });

  const banner = $('solo-result-banner');
  const txt = $('solo-result-text');
  banner.className = 'winner-banner';
  if (aiFiltered) {
    banner.classList.add('win-none');
    txt.textContent = '🚫 AIが回答できませんでした';
  } else if (correct) {
    banner.classList.add('win-human');
    txt.textContent = '🎉 AIに当ててもらえた！';
  } else {
    banner.classList.add('win-ai');
    txt.textContent = '😅 AIに伝わらなかった…';
  }

  const displayStreak = correct ? soloStreak : prevStreak;
  $('solo-streak-num').textContent = displayStreak;
  const best = getSoloBest();
  $('solo-best-row').textContent = best > 0 ? `ベスト: ${best}問` : '';

  if (soloCurrentImageData) {
    const rc = $('solo-result-canvas');
    if (rc) {
      const ctx = rc.getContext('2d');
      const img = new Image();
      img.onload = () => { ctx.clearRect(0, 0, rc.width, rc.height); ctx.drawImage(img, 0, 0, rc.width, rc.height); };
      img.src = soloCurrentImageData;
    }
  }

  $('solo-next-btn').classList.toggle('hidden', !correct && !aiFiltered);
  $('solo-retry-btn').classList.toggle('hidden', correct || !!aiFiltered);

  showScreen('solo-result');
});

$('solo-start-draw-btn').addEventListener('click', () => {
  triggerButtonSound();
  drawingSetupDone = false;
  eraserOn = false;
  $('eraser-btn').classList.remove('active');
  const btn = $('submit-drawing-btn');
  btn.disabled = false;
  btn.textContent = '完成！送信する';
  $('topic-display').textContent = soloTopic;
  $('topic-banner').classList.remove('hidden');
  $('spectator-banner').classList.add('hidden');
  $('draw-tools').classList.remove('hidden');
  buildPalette();
  attachDrawEvents($('draw-canvas'));
  fillWhite($('draw-canvas'));
  showScreen('drawing');
});

$('solo-topic-back-btn').addEventListener('click', exitSoloMode);

$('solo-next-btn').addEventListener('click', () => {
  triggerButtonSound();
  soloCurrentImageData = null;
  socket.emit('solo_start');
});
$('solo-retry-btn').addEventListener('click', () => {
  triggerButtonSound();
  soloCurrentImageData = null;
  socket.emit('solo_start');
});
$('solo-back-btn').addEventListener('click', exitSoloMode);

socket.on('room_list', (list) => {
  const ul = $('room-list');
  ul.innerHTML = '';
  const filter = $('room-code-input').value.trim().toUpperCase();
  if (list.length === 0) {
    $('no-rooms-msg').classList.remove('hidden');
  } else {
    $('no-rooms-msg').classList.add('hidden');
    list.forEach(({ code, hostName, playerCount }) => {
      const li = document.createElement('li');
      li.className = 'room-item';
      if (filter && !code.includes(filter)) li.classList.add('hidden');
      li.innerHTML =
        `<div class="room-item-info">
          <span class="room-item-code">${esc(code)}</span>
          <span class="room-item-meta">${esc(hostName)} のルーム・${playerCount}/6人</span>
        </div>
        <button class="btn btn-secondary">参加</button>`;
      li.querySelector('button').addEventListener('click', () => doJoinRoom(code));
      ul.appendChild(li);
    });
  }
});

$('room-code-input').addEventListener('input', () => {
  const filter = $('room-code-input').value.trim().toUpperCase();
  document.querySelectorAll('#room-list .room-item').forEach((li) => {
    const code = li.querySelector('.room-item-code')?.textContent || '';
    li.classList.toggle('hidden', filter.length > 0 && !code.includes(filter));
  });
  const visible = document.querySelectorAll('#room-list .room-item:not(.hidden)').length;
  $('no-rooms-msg').classList.toggle('hidden', visible > 0);
});

$('room-code-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('room-code-join-btn').click();
});

$('room-code-join-btn').addEventListener('click', () => {
  const code = $('room-code-input').value.trim().toUpperCase();
  if (!code) return;
  doJoinRoom(code);
});

function showRoomList() {
  triggerButtonSound();
  const name = $('name-input').value.trim();
  if (!name) { alert('名前を入力してください。'); return; }
  $('room-code-input').value = '';
  $('join-card').classList.add('hidden');
  $('room-list-card').classList.remove('hidden');
  socket.emit('get_rooms');
}

function doCreateRoom() {
  triggerButtonSound();
  const name = $('name-input').value.trim();
  if (!name) return;
  myName = name;
  resetLobbyInfoState();
  socket.emit('create_room', { name, sessionId: mySessionId });
  $('join-card').classList.add('hidden');
  $('lobby-info').classList.remove('hidden');
}

function doJoinRoom(roomCode) {
  triggerButtonSound();
  const name = $('name-input').value.trim();
  if (!name) { alert('名前を入力してください。'); return; }
  myName = name;
  resetLobbyInfoState();
  socket.emit('join_room', { name, roomCode, sessionId: mySessionId });
  $('room-list-card').classList.add('hidden');
  $('lobby-info').classList.remove('hidden');
}


$('start-btn').addEventListener('click', () => {
  triggerButtonSound();
  socket.emit('start_game');
});

function returnToEntryLobby() {
  triggerButtonSound('back');
  pendingFinalResults = null;
  setResultsView('round');
  $('drawings-gallery').classList.add('hidden');
  socket.emit('leave_room');
  myRoomCode = null;
  localStorage.removeItem(ROOM_KEY);
  showScreen('lobby');
  $('room-list-card').classList.add('hidden');
  $('join-card').classList.remove('hidden');
  $('lobby-info').classList.add('hidden');

  $('leave-room-btn').classList.add('hidden');
  $('play-again-btn').classList.add('hidden');
  topicInputSetupDone = false;
  drawingSetupDone = false;
  resetLobbyInfoState();
}

function refreshLobby(state) {
  const ul = $('player-list');
  ul.innerHTML = '';
  const countEl = $('player-count');
  if (countEl) countEl.textContent = `${state.players.length} / 6人`;
  state.players.forEach(p => {
    const li = document.createElement('li');
    li.textContent = p.name + (p.isHost ? ' 👑' : '');
    if (p.id === myId) li.classList.add('me');
    ul.appendChild(li);
  });

  const me = state.players.find(p => p.id === myId);
  const genreLabel = $('lobby-genre-label');
  if (genreLabel) genreLabel.textContent = `ジャンル: ${state.selectedGenre || 'ジャンルなし'}`;
  const selectGenreBtn = $('select-genre-btn');
  if (selectGenreBtn) selectGenreBtn.classList.toggle('hidden', !me?.isHost);

  if (me?.isHost) {
    $('start-btn').classList.toggle('hidden', state.players.length < 2);
    $('waiting-msg').classList.add('hidden');
  } else {
    $('start-btn').classList.add('hidden');
    $('waiting-msg').classList.remove('hidden');
  }
}

function resetLobbyInfoState() {
  players = [];
  phase = 'lobby';
  lastPhase = 'lobby';
  amDrawer = false;
  refreshLobby({ players: [] });
}

// ===== TOPIC INPUT PHASE =====

let topicInputSetupDone = false;

socket.on('game_update', (state) => {
  if (state.phase === 'topic_input' && !topicInputSetupDone) {
    topicInputSetupDone = true;
    showScreen('topic');
    setupTopicInputScreen(state);
  }
  if (state.phase !== 'topic_input') topicInputSetupDone = false;
});

socket.on('choose_topic', ({ choices, genre }) => {
  buildTopicChoices(choices, genre);
  $('topic-input-drawer').classList.remove('hidden');
  $('topic-input-spectator').classList.add('hidden');
  $('topic-host-wait')?.classList.add('hidden');
  $('topic-genre-host')?.classList.add('hidden');
});

function buildGenreChoices(selectedGenre = '') {
  const container = $('genre-choices');
  if (!container) return;
  container.innerHTML = '';
  MULTI_TOPIC_GENRES.forEach((genre) => {
    const btn = document.createElement('button');
    btn.className = 'btn topic-choice-btn';
    btn.textContent = genre;
    if (genre === selectedGenre) btn.classList.add('selected');
    btn.addEventListener('click', () => {
      triggerButtonSound();
      container.querySelectorAll('button').forEach((button) => { button.disabled = true; });
      btn.classList.add('selected');
      socket.emit('submit_genre', { genre });
    });
    container.appendChild(btn);
  });
}

function buildTopicChoices(choices, genre = '') {
  const container = $('topic-choices');
  container.innerHTML = '';
  const genreLabel = $('topic-genre-label');
  if (genreLabel) genreLabel.textContent = genre ? `ジャンル: ${genre}` : '';
  (choices || []).forEach(topic => {
    const btn = document.createElement('button');
    btn.className = 'btn topic-choice-btn';
    btn.textContent = topic;
    btn.addEventListener('click', () => {
      triggerButtonSound();
      container.querySelectorAll('button').forEach(b => { b.disabled = true; });
      btn.classList.add('selected');
      socket.emit('submit_topic', { topic });
    });
    container.appendChild(btn);
  });
}

function setupTopicInputScreen(state) {
  const me = state.players.find(p => p.id === myId);
  const isDrawer = me?.isDrawer ?? false;
  const spectatorText = $('topic-spectator-text');
  const genreCard = $('topic-genre-host');
  const hostWait = $('topic-host-wait');
  const drawerCard = $('topic-input-drawer');
  const spectatorCard = $('topic-input-spectator');

  if (genreCard) genreCard.classList.add('hidden');
  if (hostWait) hostWait.classList.add('hidden');
  if (drawerCard) drawerCard.classList.add('hidden');
  if (spectatorCard) spectatorCard.classList.add('hidden');

  if (isDrawer) return;

  if (spectatorText) {
    spectatorText.textContent = state.selectedGenre
      ? `描く人が「${state.selectedGenre}」のお題を選んでいます`
      : '描く人がお題を選んでいます';
  }
  if (spectatorCard) spectatorCard.classList.remove('hidden');
}

// ===== DRAWING PHASE SETUP =====

let drawingSetupDone = false;

socket.on('game_update', (state) => {
  if (state.phase === 'drawing' && !drawingSetupDone) {
    drawingSetupDone = true;
    showScreen('drawing');
    setupDrawingScreen(state);
  }
  if (state.phase !== 'drawing') drawingSetupDone = false;
});

function setupDrawingScreen(state) {
  eraserOn = false;
  $('eraser-btn').classList.remove('active');

  const submitBtn = $('submit-drawing-btn');
  submitBtn.disabled = false;
  submitBtn.textContent = '完成！送信する';

  const me = state.players.find(p => p.id === myId);
  if (me?.isDrawer) {
    $('draw-tools').classList.remove('hidden');
    $('spectator-banner').classList.add('hidden');
    buildPalette();
    attachDrawEvents($('draw-canvas'));
    fillWhite($('draw-canvas'));
  } else {
    $('draw-tools').classList.add('hidden');
    $('topic-banner').classList.add('hidden');
    $('spectator-banner').classList.remove('hidden');
    fillWhite($('draw-canvas'));
  }
}

function buildPalette() {
  const pal = $('color-palette');
  pal.innerHTML = '';
  COLORS.forEach(color => {
    const div = document.createElement('div');
    div.className = 'swatch' + (color === '#ffffff' ? ' white-border' : '');
    if (color === penColor) div.classList.add('active');
    div.style.background = color;
    div.addEventListener('click', () => {
      penColor = color;
      eraserOn = false;
      $('eraser-btn').classList.remove('active');
      pal.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
      div.classList.add('active');
    });
    pal.appendChild(div);
  });
}

function attachDrawEvents(canvas) {
  const fresh = canvas.cloneNode(true);
  canvas.parentNode.replaceChild(fresh, canvas);
  const c = $('draw-canvas');

  c.addEventListener('mousedown',  e => startDraw(c, e));
  c.addEventListener('mousemove',  e => continueDraw(c, e));
  c.addEventListener('mouseup',    () => endDraw(c));
  c.addEventListener('mouseleave', () => endDraw(c));
  c.addEventListener('touchstart', e => { e.preventDefault(); startDraw(c, e.touches[0]); }, { passive: false });
  c.addEventListener('touchmove',  e => { e.preventDefault(); continueDraw(c, e.touches[0]); }, { passive: false });
  c.addEventListener('touchend',   e => { e.preventDefault(); endDraw(c); }, { passive: false });
}

function getXY(canvas, e) {
  const r  = canvas.getBoundingClientRect();
  const sx = canvas.width  / r.width;
  const sy = canvas.height / r.height;
  return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
}

function startDraw(canvas, e) {
  if (!soloMode && !amDrawer) return;
  isDrawing = true;
  currentStroke = [getXY(canvas, e)];
}

function continueDraw(canvas, e) {
  if (!isDrawing) return;
  const p   = getXY(canvas, e);
  const ctx = canvas.getContext('2d');
  currentStroke.push(p);

  const prev = currentStroke[currentStroke.length - 2];
  ctx.beginPath();
  ctx.moveTo(prev.x, prev.y);
  ctx.lineTo(p.x, p.y);
  ctx.lineWidth   = eraserOn ? brushSize * 3 : brushSize;
  ctx.strokeStyle = eraserOn ? '#ffffff' : penColor;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.stroke();
}

function endDraw(canvas) {
  if (!isDrawing || currentStroke.length < 2) { isDrawing = false; currentStroke = []; return; }
  isDrawing = false;
  if (!soloMode) {
    socket.emit('draw_stroke', {
      points: currentStroke,
      color:  eraserOn ? '#ffffff' : penColor,
      size:   eraserOn ? brushSize * 3 : brushSize,
    });
  }
  currentStroke = [];
}

function renderStroke(ctx, { points, color, size }) {
  if (!points || points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.lineWidth   = size;
  ctx.strokeStyle = color;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.stroke();
}

function fillWhite(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

$('eraser-btn').addEventListener('click', () => {
  triggerButtonSound();
  eraserOn = !eraserOn;
  $('eraser-btn').classList.toggle('active', eraserOn);
  if (eraserOn) {
    $('color-palette').querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
  } else {
    const active = $('color-palette').querySelector(`[style*="${penColor}"]`);
    if (active) active.classList.add('active');
  }
});

$('brush-size').addEventListener('input', e => { brushSize = Number(e.target.value); });

$('clear-btn').addEventListener('click', () => {
  triggerButtonSound();
  const c = $('draw-canvas');
  if (c) fillWhite(c);
  if (!soloMode) socket.emit('canvas_clear');
});

$('submit-drawing-btn').addEventListener('click', () => {
  triggerButtonSound();
  const c = $('draw-canvas');
  if (!c) return;
  const btn = $('submit-drawing-btn');
  btn.disabled = true;
  btn.textContent = '送信中…';
  const imageData = c.toDataURL('image/png');
  if (soloMode) {
    soloCurrentImageData = imageData;
    socket.emit('solo_submit_drawing', { imageData, topic: soloTopic });
  } else {
    socket.emit('submit_drawing', imageData);
  }
});

// ===== GUESSING =====

$('submit-guess-btn').addEventListener('click', submitGuess);
$('guess-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitGuess(); });

function submitGuess() {
  triggerButtonSound();
  const answer = $('guess-input').value.trim();
  if (!answer) return;
  socket.emit('submit_guess', { answer });
  $('guess-form').classList.add('hidden');
  $('guessed-msg').classList.remove('hidden');
}

function updateGuessCount(state) {
  const msg = $('guess-count-msg');
  if (msg) msg.textContent = `${state.guessedCount} / ${state.guesserCount} 人が回答済み`;
}

function restoreGuessingState(state) {
  const me = state.players.find(p => p.id === myId);
  if (!me) return;

  showScreen('guessing');
  renderGuessCanvas(state.drawingData);
  const genreLabel = $('guess-genre-label');
  if (genreLabel) genreLabel.textContent = state.selectedGenre ? `ジャンル: ${state.selectedGenre}` : '';

  if (me.isDrawer) {
    $('guess-form').classList.add('hidden');
    $('guessed-msg').classList.add('hidden');
    $('drawer-wait-msg').classList.remove('hidden');
  } else if ($('guessed-msg').classList.contains('hidden')) {
    $('guess-form').classList.remove('hidden');
    $('drawer-wait-msg').classList.add('hidden');
    $('submit-guess-btn').disabled = false;
  }
}

function renderGuessCanvas(imageData) {
  const gc = $('guess-canvas');
  if (!gc || !imageData) return;

  const gCtx = gc.getContext('2d');
  const img = new Image();
  img.onload = () => {
    gCtx.clearRect(0, 0, gc.width, gc.height);
    gCtx.drawImage(img, 0, 0, gc.width, gc.height);
  };
  img.src = imageData;
}

// ===== RESULTS =====

$('next-round-btn').addEventListener('click', () => {
  triggerButtonSound();
  if (pendingFinalResults && !showingFinalResults) {
    showFinalResults();
    return;
  }
  socket.emit('next_round');
});
$('play-again-btn').addEventListener('click', () => {
  triggerButtonSound();
  socket.emit('play_again');
});
$('leave-room-btn').addEventListener('click', returnToEntryLobby);

// ===== QR CODE =====

$('show-qr-btn').addEventListener('click', () => {
  triggerButtonSound();
  if (!myRoomCode) return;
  const url = `${location.origin}?room=${myRoomCode}`;
  socket.emit('get_room_qr', { url });
});

socket.on('room_qr', ({ dataUrl, code }) => {
  $('qr-img').src = dataUrl;
  $('qr-room-code').textContent = code;
  $('qr-modal').classList.remove('hidden');
});

$('qr-close-btn').addEventListener('click', () => {
  triggerButtonSound();
  $('qr-modal').classList.add('hidden');
});

$('qr-modal').addEventListener('click', (e) => {
  if (e.target === $('qr-modal')) $('qr-modal').classList.add('hidden');
});

// ===== GENRE MODAL =====

$('select-genre-btn').addEventListener('click', () => {
  triggerButtonSound();
  openGenreModal();
});

$('genre-modal-close-btn').addEventListener('click', () => {
  triggerButtonSound();
  $('genre-modal').classList.add('hidden');
});

$('genre-modal').addEventListener('click', (e) => {
  if (e.target === $('genre-modal')) $('genre-modal').classList.add('hidden');
});

function openGenreModal() {
  const modal = $('genre-modal');
  const container = $('genre-modal-choices');
  const currentGenre = $('lobby-genre-label')?.textContent.replace('ジャンル: ', '') || 'ジャンルなし';
  container.innerHTML = '';
  MULTI_TOPIC_GENRES.forEach(genre => {
    const btn = document.createElement('button');
    btn.className = 'btn topic-choice-btn' + (genre === currentGenre ? ' selected' : '');
    btn.textContent = genre;
    btn.addEventListener('click', () => {
      triggerButtonSound();
      socket.emit('submit_genre', { genre });
      container.querySelectorAll('.topic-choice-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      $('lobby-genre-label').textContent = `ジャンル: ${genre}`;
      setTimeout(() => modal.classList.add('hidden'), 250);
    });
    container.appendChild(btn);
  });
  modal.classList.remove('hidden');
}

// ===== TIMER RING =====

function setRingProgress(t) {
  const circumference = 175.9;
  const offset = circumference * (1 - t / 60);
  const ring = $('ring-progress');
  if (ring) ring.style.strokeDashoffset = offset;
}

// ===== UTILITY =====

function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
