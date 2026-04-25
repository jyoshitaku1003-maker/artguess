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

const TOPICS = [
  'ねこ', 'いぬ', 'うさぎ', 'きりん', 'ぞう', 'さかな', 'とり', 'くま', 'うし', 'ぶた',
  'りんご', 'バナナ', 'いちご', 'すいか', 'ぶどう', 'みかん', 'もも', 'なし', 'めろん',
  'くるま', 'じてんしゃ', 'でんしゃ', 'ひこうき', 'ふね', 'バス', 'ロケット',
  'おうち', 'き', 'やま', 'たいよう', 'つき', 'ほし', 'くも', 'かさ', 'ゆき',
  'えんぴつ', 'ほん', 'めがね', 'くつ', 'ぼうし',
  'ピザ', 'ハンバーガー', 'ケーキ', 'ラーメン', 'すし', 'おにぎり', 'アイスクリーム',
  'はな', 'ちょうちょ', 'かめ', 'かえる', 'かに', 'たこ',
];

const freshState = () => ({
  phase: 'lobby',
  players: [],
  drawerIndex: -1,
  topic: '',
  drawingData: null,
  guesses: {},
  aiGuess: null,
  timeLeft: 60,
});

let game = freshState();
let timerInterval = null;

// ---- helpers ----

function normalizeAnswer(text) {
  if (!text) return '';
  return text.trim()
    .replace(/[ァ-ン]/g, s => String.fromCharCode(s.charCodeAt(0) - 0x60))
    .replace(/\s+/g, '')
    .toLowerCase();
}

function guesserCount() {
  return game.players.filter(p => !p.isDrawer).length;
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
  };
}

// ---- timer ----

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  game.timeLeft = 60;
  timerInterval = setInterval(() => {
    game.timeLeft--;
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
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    endGuessing();
  }
}

// ---- AI guess ----

async function requestAIGuess(imageData) {
  if (!openai) {
    game.aiGuess = 'わからない';
    io.emit('game_update', publicState());
    checkEndCondition();
    return;
  }

  try {
    const base64 = imageData.replace(/^data:image\/[^;]+;base64,/, '');
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 30,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${base64}`, detail: 'low' },
          },
          {
            type: 'text',
            text: 'これはお絵かきゲームの手書きイラストです。何を描いていますか？ひらがなで一語のみ答えてください（例：ねこ、りんご、くるま）。',
          },
        ],
      }],
    });

    const raw = resp.choices[0].message.content.trim();
    const match = raw.match(/[ぁ-んァ-ン一-龯]+/);
    game.aiGuess = match ? match[0] : raw.slice(0, 10);
  } catch (err) {
    console.error('OpenAI error:', err.message);
    game.aiGuess = 'わからない';
  }

  if (game.phase === 'guessing') {
    io.emit('game_update', publicState());
    checkEndCondition();
  }
}

// ---- end guessing ----

function endGuessing() {
  if (game.phase !== 'guessing') return;

  if (game.aiGuess === null) game.aiGuess = 'わからない';

  game.phase = 'results';

  const humanWin = Object.values(game.guesses).some(g => g.correct);
  const aiCorrect = normalizeAnswer(game.aiGuess) === normalizeAnswer(game.topic);

  let winner;
  if (humanWin && aiCorrect) winner = 'both';
  else if (humanWin) winner = 'human';
  else if (aiCorrect) winner = 'ai';
  else winner = 'none';

  const drawer = game.players[game.drawerIndex];

  io.emit('game_results', {
    topic: game.topic,
    guesses: game.guesses,
    aiGuess: game.aiGuess,
    aiCorrect,
    winner,
    drawerName: drawer?.name ?? '？',
  });
}

// ---- socket ----

io.on('connection', (socket) => {
  socket.emit('game_update', publicState());

  socket.on('join', ({ name }) => {
    if (game.phase !== 'lobby') {
      socket.emit('error_msg', 'ゲームはすでに始まっています。次のゲームをお待ちください。');
      return;
    }
    const trimmed = String(name ?? '').trim().slice(0, 10);
    if (!trimmed) return;

    const isHost = game.players.length === 0;
    game.players.push({ id: socket.id, name: trimmed, isHost, isDrawer: false });
    io.emit('game_update', publicState());
  });

  socket.on('start_game', () => {
    if (game.phase !== 'lobby') return;
    const me = game.players.find(p => p.id === socket.id);
    if (!me?.isHost) return;
    if (game.players.length < 2) {
      socket.emit('error_msg', 'プレイヤーが2人以上必要です。');
      return;
    }

    game.drawerIndex = Math.floor(Math.random() * game.players.length);
    game.players.forEach((p, i) => { p.isDrawer = i === game.drawerIndex; });
    game.topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
    game.phase = 'drawing';
    game.guesses = {};
    game.drawingData = null;
    game.aiGuess = null;

    io.emit('game_update', publicState());

    const drawer = game.players[game.drawerIndex];
    io.to(drawer.id).emit('your_topic', game.topic);
  });

  socket.on('draw_stroke', (strokeData) => {
    if (game.phase !== 'drawing') return;
    const me = game.players.find(p => p.id === socket.id);
    if (!me?.isDrawer) return;
    socket.broadcast.emit('draw_stroke', strokeData);
  });

  socket.on('canvas_clear', () => {
    if (game.phase !== 'drawing') return;
    const me = game.players.find(p => p.id === socket.id);
    if (!me?.isDrawer) return;
    socket.broadcast.emit('canvas_clear');
  });

  socket.on('submit_drawing', (imageData) => {
    if (game.phase !== 'drawing') return;
    const me = game.players.find(p => p.id === socket.id);
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
    const me = game.players.find(p => p.id === socket.id);
    if (!me || me.isDrawer) return;
    if (game.guesses[socket.id]) return;

    const correct = normalizeAnswer(answer) === normalizeAnswer(game.topic);
    game.guesses[socket.id] = { name: me.name, answer: String(answer).trim(), correct };

    io.emit('game_update', publicState());
    checkEndCondition();
  });

  socket.on('play_again', () => {
    if (game.phase !== 'results') return;
    const me = game.players.find(p => p.id === socket.id);
    if (!me?.isHost) return;

    const savedPlayers = game.players.map(p => ({ ...p, isDrawer: false }));
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    game = freshState();
    game.players = savedPlayers;

    io.emit('game_update', publicState());
    io.emit('reset_game');
  });

  socket.on('disconnect', () => {
    const idx = game.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;

    const { isDrawer, isHost } = game.players[idx];
    game.players.splice(idx, 1);

    if (game.players.length === 0) {
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
      game = freshState();
      return;
    }

    if (isHost) game.players[0].isHost = true;

    if (isDrawer && (game.phase === 'drawing' || game.phase === 'guessing')) {
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
      const savedPlayers = game.players.map(p => ({ ...p, isDrawer: false }));
      game = freshState();
      game.players = savedPlayers;
      io.emit('game_aborted', '絵を描く人が退出しました。ロビーに戻ります。');
    }

    io.emit('game_update', publicState());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎨 お絵かき当てゲーム → http://localhost:${PORT}`);
});
