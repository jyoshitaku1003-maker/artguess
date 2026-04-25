require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const OpenAI = require('openai');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.use(express.static(path.join(__dirname, 'public')));

if (openai) {
  console.log('[Startup] OpenAI API key loaded');
} else {
  console.log('[Startup] OPENAI_API_KEY not set. AI will answer with a fallback.');
}

const WIN_TARGET = 3;
const ROUND_SECONDS = 60;
const RECONNECT_GRACE_MS = 15000;

const freshState = () => ({
  phase: 'lobby',
  players: [],
  drawerIndex: -1,
  topic: '',
  drawingData: null,
  guesses: {},
  aiGuess: null,
  timeLeft: ROUND_SECONDS,
  scores: { human: 0, ai: 0 },
  isSuddenDeath: false,
});

let game = freshState();
let timerInterval = null;
const disconnectTimers = new Map();

function normalizeAnswer(text) {
  if (!text) return '';
  return text.trim()
    .replace(/[ァ-ン]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0x60))
    .replace(/\s+/g, '')
    .toLowerCase();
}

function isCorrect(guess, topic) {
  const g = normalizeAnswer(guess);
  const t = normalizeAnswer(topic);
  if (g === t) return true;
  if (g.length >= 2 && t.length >= 2 && (g.includes(t) || t.includes(g))) return true;
  return false;
}

function guesserCount() {
  return game.players.filter((p) => !p.isDrawer).length;
}

function guessedCount() {
  return Object.keys(game.guesses).length;
}

function publicState() {
  return {
    phase: game.phase,
    players: game.players.map(({ id, name, isHost, isDrawer }) => ({ id, name, isHost, isDrawer })),
    timeLeft: game.timeLeft,
    guessedCount: guessedCount(),
    guesserCount: guesserCount(),
    scores: { ...game.scores },
    isSuddenDeath: game.isSuddenDeath,
    drawingData: game.drawingData,
  };
}

function clearDisconnectTimer(sessionId) {
  const timer = disconnectTimers.get(sessionId);
  if (!timer) return;
  clearTimeout(timer);
  disconnectTimers.delete(sessionId);
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  game.timeLeft = ROUND_SECONDS;
  timerInterval = setInterval(() => {
    game.timeLeft -= 1;
    io.emit('timer_tick', game.timeLeft);
    if (game.timeLeft <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      endGuessing();
    }
  }, 1000);
}

function checkEndCondition() {
  if (game.phase !== 'guessing') return;
  if (guessedCount() >= guesserCount() && game.aiGuess !== null) {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    endGuessing();
  }
}

async function requestAIGuess(imageData) {
  if (!openai) {
    console.log('[AI] Skipped: no API key');
    game.aiGuess = 'わからない';
    io.emit('game_update', publicState());
    checkEndCondition();
    return;
  }

  try {
    const base64 = imageData.replace(/^data:image\/[^;]+;base64,/, '');
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 30,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${base64}`, detail: 'high' },
          },
          {
            type: 'text',
            text: 'このイラストが何かを日本語の短い名詞ひとつで答えてください。説明文や言い訳は不要です。',
          },
        ],
      }],
    });

    const raw = response.choices[0].message.content.trim();
    const match = raw.match(/[ぁ-んァ-ン一-龠A-Za-z0-9ー]+/);
    game.aiGuess = match ? match[0] : raw.slice(0, 10);
    console.log(`[AI] Answer: "${game.aiGuess}"`);
  } catch (error) {
    console.error('[AI] Error:', error.message);
    game.aiGuess = 'わからない';
  }

  if (game.phase === 'guessing') {
    io.emit('game_update', publicState());
    checkEndCondition();
  }
}

function emitResults() {
  const drawer = game.players[game.drawerIndex];
  const humanWin = Object.values(game.guesses).some((g) => g.correct);
  const aiCorrect = isCorrect(game.aiGuess, game.topic);

  let roundWinner = 'none';
  if (humanWin && aiCorrect) roundWinner = 'both';
  else if (humanWin) roundWinner = 'human';
  else if (aiCorrect) roundWinner = 'ai';

  if (roundWinner === 'human' || roundWinner === 'both') game.scores.human += 1;
  if (roundWinner === 'ai' || roundWinner === 'both') game.scores.ai += 1;

  let gameOver = false;
  let matchWinner = null;

  if (game.isSuddenDeath) {
    if (roundWinner === 'human') {
      gameOver = true;
      matchWinner = 'human';
    } else if (roundWinner === 'ai') {
      gameOver = true;
      matchWinner = 'ai';
    }
  } else {
    const humanReached = game.scores.human >= WIN_TARGET;
    const aiReached = game.scores.ai >= WIN_TARGET;
    if (humanReached && aiReached) {
      game.isSuddenDeath = true;
    } else if (humanReached) {
      gameOver = true;
      matchWinner = 'human';
    } else if (aiReached) {
      gameOver = true;
      matchWinner = 'ai';
    }
  }

  io.emit('game_results', {
    topic: game.topic,
    guesses: game.guesses,
    aiGuess: game.aiGuess,
    aiCorrect,
    roundWinner,
    scores: { ...game.scores },
    isSuddenDeath: game.isSuddenDeath,
    gameOver,
    matchWinner,
    drawerName: drawer?.name ?? '',
  });
}

function endGuessing() {
  if (game.phase !== 'guessing') return;
  if (game.aiGuess === null) game.aiGuess = 'わからない';
  game.phase = 'results';
  emitResults();
}

function resetToLobbyKeepPlayers() {
  const savedPlayers = game.players.map((p) => ({ ...p, isDrawer: false }));
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  game = freshState();
  game.players = savedPlayers;
}

function resumePlayer(socket, player) {
  clearDisconnectTimer(player.sessionId);

  socket.emit('joined', { sessionId: player.sessionId });
  socket.emit('game_update', publicState());

  if (game.phase === 'topic_input' && player.isDrawer) {
    socket.emit('choose_topic');
  }

  if (game.phase === 'drawing' && player.isDrawer) {
    socket.emit('your_topic', game.topic);
  }

  if (game.phase === 'guessing' && game.drawingData) {
    socket.emit('guessing_start', { imageData: game.drawingData });
    socket.emit('timer_tick', game.timeLeft);
  }
}

function finalizeDisconnect(sessionId) {
  const idx = game.players.findIndex((p) => p.sessionId === sessionId);
  if (idx === -1) return;

  const player = game.players[idx];
  delete game.guesses[player.id];
  game.players.splice(idx, 1);
  clearDisconnectTimer(sessionId);

  if (game.players.length === 0) {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    game = freshState();
    return;
  }

  if (player.isHost) {
    game.players[0].isHost = true;
  }

  if (player.isDrawer && ['topic_input', 'drawing', 'guessing'].includes(game.phase)) {
    const savedScores = { ...game.scores };
    const savedSuddenDeath = game.isSuddenDeath;
    resetToLobbyKeepPlayers();
    game.scores = savedScores;
    game.isSuddenDeath = savedSuddenDeath;
    io.emit('game_aborted', '描き手が切断されたため、このラウンドは中断されました。');
  }

  io.emit('game_update', publicState());
  checkEndCondition();
}

io.on('connection', (socket) => {
  socket.emit('game_update', publicState());

  socket.on('join', ({ name, sessionId }) => {
    const trimmed = String(name ?? '').trim().slice(0, 10);
    const stableSessionId = String(sessionId ?? '').trim().slice(0, 100) || socket.id;
    if (!trimmed) return;

    const existing = game.players.find((p) => p.sessionId === stableSessionId);
    if (existing) {
      const oldId = existing.id;
      existing.id = socket.id;
      existing.name = trimmed;

      if (oldId !== socket.id && game.guesses[oldId]) {
        game.guesses[socket.id] = game.guesses[oldId];
        delete game.guesses[oldId];
      }

      resumePlayer(socket, existing);
      return;
    }

    if (game.phase !== 'lobby') {
      socket.emit('error_msg', 'ゲームはすでに始まっています。次のゲームをお待ちください。');
      return;
    }

    const isHost = game.players.length === 0;
    game.players.push({
      id: socket.id,
      sessionId: stableSessionId,
      name: trimmed,
      isHost,
      isDrawer: false,
    });

    socket.emit('joined', { sessionId: stableSessionId });
    io.emit('game_update', publicState());
  });

  socket.on('start_game', () => {
    if (game.phase !== 'lobby') return;
    const me = game.players.find((p) => p.id === socket.id);
    if (!me?.isHost) return;
    if (game.players.length < 2) {
      socket.emit('error_msg', 'プレイヤーが2人以上必要です。');
      return;
    }

    game.drawerIndex = Math.floor(Math.random() * game.players.length);
    game.players.forEach((p, i) => { p.isDrawer = i === game.drawerIndex; });
    game.topic = '';
    game.phase = 'topic_input';
    game.guesses = {};
    game.drawingData = null;
    game.aiGuess = null;

    io.emit('game_update', publicState());
    io.to(game.players[game.drawerIndex].id).emit('choose_topic');
  });

  socket.on('submit_topic', ({ topic }) => {
    if (game.phase !== 'topic_input') return;
    const me = game.players.find((p) => p.id === socket.id);
    if (!me?.isDrawer) return;

    const trimmed = String(topic ?? '').trim().slice(0, 20);
    if (!trimmed) return;

    game.topic = trimmed;
    game.phase = 'drawing';

    io.emit('game_update', publicState());
    io.to(me.id).emit('your_topic', game.topic);
  });

  socket.on('next_round', () => {
    if (game.phase !== 'results') return;
    const me = game.players.find((p) => p.id === socket.id);
    if (!me?.isHost) return;

    game.drawerIndex = Math.floor(Math.random() * game.players.length);
    game.players.forEach((p, i) => { p.isDrawer = i === game.drawerIndex; });
    game.topic = '';
    game.phase = 'topic_input';
    game.guesses = {};
    game.drawingData = null;
    game.aiGuess = null;
    game.timeLeft = ROUND_SECONDS;

    io.emit('game_update', publicState());
    io.to(game.players[game.drawerIndex].id).emit('choose_topic');
  });

  socket.on('draw_stroke', (strokeData) => {
    if (game.phase !== 'drawing') return;
    const me = game.players.find((p) => p.id === socket.id);
    if (!me?.isDrawer) return;
    socket.broadcast.emit('draw_stroke', strokeData);
  });

  socket.on('canvas_clear', () => {
    if (game.phase !== 'drawing') return;
    const me = game.players.find((p) => p.id === socket.id);
    if (!me?.isDrawer) return;
    socket.broadcast.emit('canvas_clear');
  });

  socket.on('submit_drawing', (imageData) => {
    if (game.phase !== 'drawing') return;
    const me = game.players.find((p) => p.id === socket.id);
    if (!me?.isDrawer) return;

    game.drawingData = imageData;
    game.phase = 'guessing';
    game.guesses = {};

    io.emit('guessing_start', { imageData });
    io.emit('game_update', publicState());

    startTimer();
    requestAIGuess(imageData);
  });

  socket.on('submit_guess', ({ answer }) => {
    if (game.phase !== 'guessing') return;
    const me = game.players.find((p) => p.id === socket.id);
    if (!me || me.isDrawer) return;
    if (game.guesses[socket.id]) return;

    const trimmed = String(answer ?? '').trim();
    if (!trimmed) return;

    game.guesses[socket.id] = {
      name: me.name,
      answer: trimmed,
      correct: isCorrect(trimmed, game.topic),
    };

    io.emit('game_update', publicState());
    checkEndCondition();
  });

  socket.on('play_again', () => {
    if (game.phase !== 'results') return;
    const me = game.players.find((p) => p.id === socket.id);
    if (!me?.isHost) return;

    resetToLobbyKeepPlayers();
    io.emit('game_update', publicState());
    io.emit('reset_game');
  });

  socket.on('disconnect', () => {
    const player = game.players.find((p) => p.id === socket.id);
    if (!player) return;

    clearDisconnectTimer(player.sessionId);
    disconnectTimers.set(
      player.sessionId,
      setTimeout(() => finalizeDisconnect(player.sessionId), RECONNECT_GRACE_MS)
    );
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Startup] Server listening on http://localhost:${PORT}`);
});
