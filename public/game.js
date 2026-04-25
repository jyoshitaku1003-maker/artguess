'use strict';

const socket = io();
const SESSION_KEY  = 'artguessSessionId';
const ROOM_KEY     = 'artguessRoomCode';

// ---- state ----
let myId        = null;
let myName      = null;
let players     = [];
let phase       = 'lobby';
let amDrawer    = false;
let mySessionId = localStorage.getItem(SESSION_KEY) || null;
let myRoomCode  = localStorage.getItem(ROOM_KEY)    || null;
let audioCtx    = null;
let audioReady  = false;
let masterGain  = null;
let lastPhase   = 'lobby';
let lastSoundAt = { join: 0, start: 0 };

// ---- canvas drawing ----
const COLORS = ['#111111'];

let isDrawing     = false;
let currentStroke = [];
let penColor      = '#111111';
let brushSize     = 8;
let eraserOn      = false;

// ---- DOM shortcuts ----
const $ = id => document.getElementById(id);

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

window.addEventListener('pointerdown', primeAudio, { once: true });
window.addEventListener('touchend', primeAudio, { once: true });
window.addEventListener('click', primeAudio, { once: true });
window.addEventListener('keydown', primeAudio, { once: true });

// ---- screen management ----
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const s = $(`screen-${name}`);
  if (s) s.classList.add('active');
}

// ===== SOCKET EVENTS =====

socket.on('connect', () => {
  myId = socket.id;
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
  const { topic, guesses, aiGuess, aiCorrect, aiFiltered, roundWinner,
          scores, isSuddenDeath, gameOver, matchWinner, drawerName } = res;
  const myGuess = guesses?.[myId];

  if (myGuess?.correct) playCorrectSound();
  if (gameOver && matchWinner) playVictorySound(matchWinner === 'human');

  // Scores
  $('score-human').textContent = scores.human;
  $('score-ai').textContent    = scores.ai;

  // Sudden death banner (show when in SD and match not yet over)
  $('sudden-death-banner').classList.toggle('hidden', !isSuddenDeath || gameOver);

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
    txt.textContent = '🚫 AIが回答できませんでした（引き分け）';
  } else if (isSuddenDeath && !gameOver) {
    // Sudden death round where no single winner emerged
    if (roundWinner === 'both') {
      banner.classList.add('win-both');
      txt.textContent = '🤝 両者正解！サドンデス継続';
    } else if (roundWinner === 'none') {
      banner.classList.add('win-none');
      txt.textContent = '😅 両者不正解…サドンデス継続';
    } else {
      // single winner — match is over, matchWinner banner handles it
      applyRoundBanner(banner, txt, roundWinner);
    }
  } else {
    applyRoundBanner(banner, txt, roundWinner);
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

function applyRoundBanner(banner, txt, roundWinner) {
  switch (roundWinner) {
    case 'human': banner.classList.add('win-human'); txt.textContent = '🎉 このラウンドは人間チームの勝ち！'; break;
    case 'ai':    banner.classList.add('win-ai');    txt.textContent = '🤖 このラウンドはAIの勝ち！';        break;
    case 'both':  banner.classList.add('win-both');  txt.textContent = '🤝 引き分け！（両者正解）';           break;
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

$('create-room-btn').addEventListener('click', doCreateRoom);
$('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') doCreateRoom(); });
$('show-rooms-btn').addEventListener('click', showRoomList);
$('back-to-lobby-btn').addEventListener('click', () => {
  $('room-list-card').classList.add('hidden');
  $('join-card').classList.remove('hidden');
});
$('refresh-rooms-btn').addEventListener('click', () => socket.emit('get_rooms'));

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

socket.on('choose_topic', () => {
  $('topic-input-drawer').classList.remove('hidden');
  $('topic-input-spectator').classList.add('hidden');
  $('topic-input-field').value = '';
  $('topic-submit-btn').disabled = false;
  $('topic-input-field').focus();
});

function setupTopicInputScreen(state) {
  const me = state.players.find(p => p.id === myId);
  if (me?.isDrawer) {
    $('topic-input-drawer').classList.remove('hidden');
    $('topic-input-spectator').classList.add('hidden');
    $('topic-input-field').value = '';
    $('topic-submit-btn').disabled = false;
    $('topic-input-field').focus();
  } else {
    $('topic-input-drawer').classList.add('hidden');
    $('topic-input-spectator').classList.remove('hidden');
  }
}

$('topic-submit-btn').addEventListener('click', submitTopic);
$('topic-input-field').addEventListener('keydown', e => { if (e.key === 'Enter') submitTopic(); });

function submitTopic() {
  const topic = $('topic-input-field').value.trim();
  if (!topic) return;
  socket.emit('submit_topic', { topic });
  $('topic-submit-btn').disabled = true;
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
  socket.emit('draw_stroke', {
    points: currentStroke,
    color:  eraserOn ? '#ffffff' : penColor,
    size:   eraserOn ? brushSize * 3 : brushSize,
  });
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
  socket.emit('canvas_clear');
});

$('submit-drawing-btn').addEventListener('click', () => {
  const c = $('draw-canvas');
  if (!c) return;
  const btn = $('submit-drawing-btn');
  btn.disabled = true;
  btn.textContent = '送信中…';
  socket.emit('submit_drawing', c.toDataURL('image/png'));
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
$('leave-room-btn').addEventListener('click', () => {
  socket.emit('leave_room');
  myRoomCode = null;
  localStorage.removeItem(ROOM_KEY);
  showScreen('lobby');
  $('join-card').classList.remove('hidden');
  $('lobby-info').classList.add('hidden');

  $('leave-room-btn').classList.add('hidden');
  $('play-again-btn').classList.add('hidden');
  topicInputSetupDone = false;
  drawingSetupDone = false;
});

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
