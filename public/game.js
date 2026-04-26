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
let audioCtx    = null;
let audioReady  = false;
let masterGain  = null;
let lastPhase   = 'lobby';
let lastSoundAt = { join: 0, start: 0 };

// ---- solo state ----
let soloMode             = false;
let soloStreak           = 0;
let soloTopic            = null;
let soloCurrentImageData = null;
const SOLO_BEST_KEY      = 'artguessSoloBest';

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

// ---- audio ----
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
    masterGain.gain.value = 0.9;
    masterGain.connect(ctx.destination);
  }
  return masterGain;
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

function primeAudio() {
  const ctx = getAudioContext();
  const output = getMasterGain();
  if (!ctx || !output) return false;
  audioReady = true;
  if (ctx.state === 'suspended') void ctx.resume();
  warmAudioGraph(ctx, output);
  return true;
}

async function unlockAudio() {
  const ctx = getAudioContext();
  const output = getMasterGain();
  if (!ctx || !output) return false;
  audioReady = true;
  if (ctx.state === 'suspended') await ctx.resume();
  warmAudioGraph(ctx, output);
  return true;
}

function playTone({ freq, duration = 0.12, type = 'sine', volume = 0.04, delay = 0, attack = 0.01, release = 0.08 }) {
  const ctx = getAudioContext();
  const output = getMasterGain();
  if (!ctx || !output || !audioReady) return;
  if (ctx.state === 'suspended') void ctx.resume();

  const start = ctx.currentTime + Math.max(delay, 0.02);
  const end = start + duration;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(volume, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, end + release);

  osc.connect(gain);
  gain.connect(output);
  osc.start(start);
  osc.stop(end + release + 0.01);
}

function playWithCooldown(kind, cooldownMs, fn) {
  const now = Date.now();
  if (now - (lastSoundAt[kind] || 0) < cooldownMs) return;
  lastSoundAt[kind] = now;
  fn();
}

function playJoinSound() {
  playWithCooldown('join', 800, () => {
    playTone({ freq: 392, duration: 0.1, type: 'triangle', volume: 0.08 });
    playTone({ freq: 587.33, duration: 0.14, type: 'triangle', volume: 0.1, delay: 0.07 });
  });
}

function playStartSound() {
  playWithCooldown('start', 1200, () => {
    [261.63, 392, 523.25, 783.99].forEach((freq, index) => {
      playTone({ freq, duration: 0.12, type: 'sawtooth', volume: 0.09, delay: index * 0.055, attack: 0.005, release: 0.05 });
    });
  });
}

function playCorrectSound() {
  playTone({ freq: 659.25, duration: 0.09, type: 'triangle', volume: 0.09 });
  playTone({ freq: 783.99, duration: 0.12, type: 'triangle', volume: 0.1, delay: 0.07 });
  playTone({ freq: 1046.5, duration: 0.16, type: 'sine', volume: 0.08, delay: 0.13 });
}

function playVictorySound(victory) {
  const notes = victory
    ? [523.25, 659.25, 783.99, 1046.5]
    : [392, 329.63, 261.63, 196];
  notes.forEach((freq, index) => {
    playTone({
      freq,
      duration: 0.16,
      type: victory ? 'triangle' : 'sawtooth',
      volume: victory ? 0.11 : 0.08,
      delay: index * 0.09,
      attack: 0.006,
      release: 0.08,
    });
  });
}

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

function getAiReasonText({ aiFiltered, aiCorrect, aiGuess, topic }) {
  if (aiFiltered) return 'セーフティフィルターにより回答が無効化されました';
  if (!aiGuess) return 'AIの回答が取得できませんでした';
  if (aiCorrect) return `お題「${topic}」と一致判定になりました`;
  return `「${aiGuess}」と予想しましたが、お題「${topic}」とは一致しませんでした`;
}

function appendResultTerminalLine(linesEl, text, className = '') {
  const line = document.createElement('div');
  line.className = `howto-line result-line${className ? ` ${className}` : ''}`;
  line.textContent = text;
  linesEl.appendChild(line);
}

function clearResultsTerminalAnimation() {
  if (!resultsTerminalTimer) return;
  clearTimeout(resultsTerminalTimer);
  resultsTerminalTimer = null;
}

function renderResultsTerminal(res) {
  const linesEl = $('results-terminal-lines');
  if (!linesEl) return;

  const {
    topic, guesses, aiGuess, aiCorrect, aiFiltered, humanWin,
    roundWinner, gameOver, matchWinner,
  } = res;

  clearResultsTerminalAnimation();
  linesEl.innerHTML = '';

  const queuedLines = [];
  const entries = Object.values(guesses || {});
  if (entries.length === 0) {
    queuedLines.push({ text: '> 人間チーム :: 回答なし', className: 'result-dim' });
  } else {
    entries.forEach((guess) => {
      const status = guess.correct ? '[CORRECT]' : '[MISS]';
      queuedLines.push({
        text: `> ${guess.name} :: ${guess.answer} ${status}`,
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
    text: `> AI_REASON :: ${getAiReasonText({ aiFiltered, aiCorrect, aiGuess, topic })}`,
    className: 'result-dim',
  });
  queuedLines.push({ text: '', className: 'result-spacer' });
  queuedLines.push({ text: `> TOPIC :: ${topic}`, className: 'result-topic-line' });
  queuedLines.push({
    text: `> WINNER :: ${getWinnerLabel({ aiFiltered, roundWinner, humanWin, gameOver, matchWinner })}`,
    className: gameOver && matchWinner === 'human'
      ? 'result-correct'
      : gameOver && matchWinner === 'ai'
        ? 'result-ai'
        : 'result-topic-line',
  });

  let index = 0;
  function paintNextLine() {
    if (index >= queuedLines.length) {
      resultsTerminalTimer = null;
      return;
    }
    const { text, className } = queuedLines[index++];
    appendResultTerminalLine(linesEl, text, className);
    linesEl.scrollTop = linesEl.scrollHeight;
    resultsTerminalTimer = setTimeout(paintNextLine, text ? 150 : 80);
  }

  paintNextLine();
}

window.addEventListener('pointerdown', primeAudio, { once: true });
window.addEventListener('touchend', primeAudio, { once: true });
window.addEventListener('click', primeAudio, { once: true });
window.addEventListener('keydown', primeAudio, { once: true });

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
  playJoinSound();
});

socket.on('game_update', (state) => {
  const prevPhase = phase;
  players = state.players;
  phase   = state.phase;
  lastPhase = state.phase;
  const me = players.find(p => p.id === myId);
  amDrawer = me?.isDrawer ?? false;

  if (prevPhase === 'lobby' && state.phase === 'topic_input') {
    playStartSound();
  }

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

socket.on('guessing_start', ({ imageData }) => {
  showScreen('guessing');
  renderGuessCanvas(imageData);

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
  const { topic, guesses, aiGuess, aiCorrect, aiFiltered, humanWin, roundWinner,
          scores, isSuddenDeath, gameOver, matchWinner, drawerName } = res;
  const myGuess = guesses?.[myId];

  if (myGuess?.correct) playCorrectSound();
  if (gameOver && matchWinner) playVictorySound(matchWinner === 'human');

  // Scores
  $('score-human').textContent = scores.human;
  $('score-ai').textContent    = scores.ai;

  // Sudden death banner (show when in SD and match not yet over)
  $('sudden-death-banner').classList.toggle('hidden', !isSuddenDeath || gameOver);
  renderResultsTerminal(res);

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

  // 絵ギャラリー（ゲーム終了時）
  const gallery = $('drawings-gallery');
  if (gameOver && res.roundHistory?.length) {
    const list = $('drawings-list');
    list.innerHTML = '';
    res.roundHistory.forEach(({ drawing, topic, drawerName }) => {
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
  } else {
    gallery.classList.add('hidden');
  }

  // ボタン表示
  const me = players.find(p => p.id === myId);
  const isHost = me?.isHost ?? false;
  $('next-round-btn').classList.toggle('hidden', !isHost || gameOver);
  $('play-again-btn').classList.toggle('hidden', !isHost || !gameOver);
  $('leave-room-btn').classList.toggle('hidden', !gameOver);
});

function applyRoundBanner(banner, txt, roundWinner, humanWin) {
  switch (roundWinner) {
    case 'human': banner.classList.add('win-human'); txt.textContent = '🎉 このラウンドは人間チームの勝ち！'; break;
    case 'ai':    banner.classList.add('win-ai');    txt.textContent = humanWin ? '🤖 両者正解！AIのポイント' : '🤖 このラウンドはAIの勝ち！'; break;
    case 'none':  banner.classList.add('win-none');  txt.textContent = '😅 誰も正解できませんでした';         break;
  }
}

socket.on('reset_game', () => {
  topicInputSetupDone = false;
  drawingSetupDone = false;
  showScreen('lobby');
  $('play-again-btn').classList.add('hidden');
  $('next-round-btn').classList.add('hidden');
  $('join-card').classList.add('hidden');
  $('lobby-info').classList.remove('hidden');
  refreshLobby({ players, phase: 'lobby' });
});

socket.on('game_aborted', (msg) => {
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

$('solo-btn').addEventListener('click', startSoloMode);
$('multi-btn').addEventListener('click', () => {
  const name = $('name-input').value.trim();
  if (!name) { alert('名前を入力してください。'); return; }
  $('mode-select').classList.add('hidden');
  $('multi-options').classList.remove('hidden');
});
$('back-to-mode-btn').addEventListener('click', () => {
  $('multi-options').classList.add('hidden');
  $('mode-select').classList.remove('hidden');
});
$('create-room-btn').addEventListener('click', doCreateRoom);
$('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') { if (!$('multi-options').classList.contains('hidden')) doCreateRoom(); } });
$('show-rooms-btn').addEventListener('click', showRoomList);
$('lobby-back-btn').addEventListener('click', returnToEntryLobby);
$('back-to-lobby-btn').addEventListener('click', () => {
  $('room-list-card').classList.add('hidden');
  $('join-card').classList.remove('hidden');
});
$('refresh-rooms-btn').addEventListener('click', () => socket.emit('get_rooms'));

function startSoloMode() {
  const name = $('name-input').value.trim();
  if (!name) { alert('名前を入力してください。'); return; }
  primeAudio();
  void unlockAudio();
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
    playCorrectSound();
  } else if (!aiFiltered) {
    updateSoloBest(prevStreak);
    soloStreak = 0;
    playVictorySound(false);
  }

  $('solo-result-topic').textContent = topic;
  $('solo-ai-guess').textContent = aiGuess || '（回答なし）';

  const aiCard = $('solo-ai-card');
  aiCard.classList.toggle('correct-card', !!correct);
  aiCard.classList.toggle('wrong-card', !correct && !aiFiltered);

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
  soloCurrentImageData = null;
  socket.emit('solo_start');
});
$('solo-retry-btn').addEventListener('click', () => {
  soloCurrentImageData = null;
  socket.emit('solo_start');
});
$('solo-back-btn').addEventListener('click', exitSoloMode);

socket.on('room_list', (list) => {
  const ul = $('room-list');
  ul.innerHTML = '';
  if (list.length === 0) {
    $('no-rooms-msg').classList.remove('hidden');
  } else {
    $('no-rooms-msg').classList.add('hidden');
    list.forEach(({ code, hostName, playerCount }) => {
      const li = document.createElement('li');
      li.className = 'room-item';
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

function showRoomList() {
  const name = $('name-input').value.trim();
  if (!name) { alert('名前を入力してください。'); return; }
  $('join-card').classList.add('hidden');
  $('room-list-card').classList.remove('hidden');
  socket.emit('get_rooms');
}

function doCreateRoom() {
  const name = $('name-input').value.trim();
  if (!name) return;
  primeAudio();
  playJoinSound();
  void unlockAudio();
  myName = name;
  socket.emit('create_room', { name, sessionId: mySessionId });
  $('join-card').classList.add('hidden');
  $('lobby-info').classList.remove('hidden');
}

function doJoinRoom(roomCode) {
  const name = $('name-input').value.trim();
  if (!name) { alert('名前を入力してください。'); return; }
  primeAudio();
  playJoinSound();
  void unlockAudio();
  myName = name;
  socket.emit('join_room', { name, roomCode, sessionId: mySessionId });
  $('room-list-card').classList.add('hidden');
  $('lobby-info').classList.remove('hidden');
}


$('start-btn').addEventListener('click', () => {
  primeAudio();
  playStartSound();
  void unlockAudio();
  socket.emit('start_game');
});

function returnToEntryLobby() {
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
  if (me?.isHost) {
    $('start-btn').classList.toggle('hidden', state.players.length < 2);
    $('waiting-msg').classList.add('hidden');
  } else {
    $('start-btn').classList.add('hidden');
    $('waiting-msg').classList.remove('hidden');
  }
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

socket.on('choose_topic', ({ choices }) => {
  buildTopicChoices(choices);
  $('topic-input-drawer').classList.remove('hidden');
  $('topic-input-spectator').classList.add('hidden');
});

function buildTopicChoices(choices) {
  const container = $('topic-choices');
  container.innerHTML = '';
  (choices || []).forEach(topic => {
    const btn = document.createElement('button');
    btn.className = 'btn topic-choice-btn';
    btn.textContent = topic;
    btn.addEventListener('click', () => {
      container.querySelectorAll('button').forEach(b => { b.disabled = true; });
      btn.classList.add('selected');
      socket.emit('submit_topic', { topic });
    });
    container.appendChild(btn);
  });
}

function setupTopicInputScreen(state) {
  const me = state.players.find(p => p.id === myId);
  if (me?.isDrawer) {
    $('topic-input-drawer').classList.add('hidden');
    $('topic-input-spectator').classList.add('hidden');
  } else {
    $('topic-input-drawer').classList.add('hidden');
    $('topic-input-spectator').classList.remove('hidden');
  }
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
  const c = $('draw-canvas');
  if (c) fillWhite(c);
  if (!soloMode) socket.emit('canvas_clear');
});

$('submit-drawing-btn').addEventListener('click', () => {
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

$('next-round-btn').addEventListener('click', () => { socket.emit('next_round'); });
$('play-again-btn').addEventListener('click', () => { socket.emit('play_again'); });
$('leave-room-btn').addEventListener('click', returnToEntryLobby);

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
