'use strict';

const socket = io();

// ---- state ----
let myId     = null;
let myName   = null;
let players  = [];
let phase    = 'lobby';
let amDrawer = false;

// ---- canvas drawing ----
const COLORS = [
  '#111111','#ffffff','#ef4444','#f97316','#eab308',
  '#22c55e','#3b82f6','#8b5cf6','#ec4899','#92400e',
];

let isDrawing     = false;
let currentStroke = [];
let penColor      = '#111111';
let brushSize     = 8;
let eraserOn      = false;

// ---- DOM shortcuts ----
const $ = id => document.getElementById(id);

// ---- screen management ----
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const s = $(`screen-${name}`);
  if (s) s.classList.add('active');
}

// ===== SOCKET EVENTS =====

socket.on('connect', () => { myId = socket.id; });

socket.on('game_update', (state) => {
  players = state.players;
  phase   = state.phase;
  const me = players.find(p => p.id === myId);
  amDrawer = me?.isDrawer ?? false;

  if (state.phase === 'lobby' && myName) refreshLobby(state);
  if (state.phase === 'guessing')        updateGuessCount(state);
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

  const gc = $('guess-canvas');
  const gCtx = gc.getContext('2d');
  const img = new Image();
  img.onload = () => {
    gCtx.clearRect(0, 0, gc.width, gc.height);
    gCtx.drawImage(img, 0, 0, gc.width, gc.height);
  };
  img.src = imageData;

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
  const { topic, guesses, aiGuess, aiCorrect, roundWinner,
          scores, isSuddenDeath, gameOver, matchWinner, drawerName } = res;

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
  if (isSuddenDeath && !gameOver) {
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

  // Host buttons
  const me = players.find(p => p.id === myId);
  const isHost = me?.isHost ?? false;
  $('next-round-btn').classList.toggle('hidden', !isHost || gameOver);
  $('play-again-btn').classList.toggle('hidden', !isHost || !gameOver);
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
  showScreen('lobby');
  $('play-again-btn').classList.add('hidden');
  $('next-round-btn').classList.add('hidden');
  refreshLobby({ players, phase: 'lobby' });
});

socket.on('game_aborted', (msg) => {
  alert(msg);
  showScreen('lobby');
  amDrawer = false;
});

socket.on('error_msg', (msg) => { alert(msg); });

// ===== LOBBY =====

$('join-btn').addEventListener('click', doJoin);
$('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });

function doJoin() {
  const name = $('name-input').value.trim();
  if (!name) return;
  myName = name;
  socket.emit('join', { name });
  $('join-card').classList.add('hidden');
  $('lobby-info').classList.remove('hidden');
}

$('start-btn').addEventListener('click', () => { socket.emit('start_game'); });

function refreshLobby(state) {
  const ul = $('player-list');
  ul.innerHTML = '';
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

// ===== RESULTS =====

$('next-round-btn').addEventListener('click', () => { socket.emit('next_round'); });
$('play-again-btn').addEventListener('click', () => { socket.emit('play_again'); });

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
