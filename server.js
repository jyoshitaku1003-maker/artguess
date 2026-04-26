require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const OpenAI = require('openai');
const path = require('path');
const { randomUUID } = require('crypto');

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
const MAX_PLAYERS = 6;
const ROOM_CREATE_LIMIT_TIMEZONE = 'Asia/Tokyo';
const DEV_OVERRIDE_PASSWORD = process.env.DEV_PASSWORD ?? null;

// ---- room management ----

const rooms = new Map();       // roomCode -> room
const playerRoom = new Map();  // socketId -> roomCode
const sessionRoom = new Map(); // sessionId -> roomCode
const createdRoomDates = new Map(); // sessionId -> YYYY-MM-DD
const unlimitedCreatorSessions = new Set();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function freshGame() {
  return {
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
    roundHistory: [],
  };
}

function freshRoom(code) {
  return { code, game: freshGame(), timerInterval: null, disconnectTimers: new Map(), createdBySessionId: null };
}

function getRoom(socketId) {
  const code = playerRoom.get(socketId);
  return code ? rooms.get(code) : null;
}

function getTodayKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ROOM_CREATE_LIMIT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

function hasCreatedRoomToday(sessionId) {
  if (!sessionId) return false;
  return createdRoomDates.get(sessionId) === getTodayKey();
}

function markRoomCreatedToday(sessionId) {
  if (!sessionId) return;
  createdRoomDates.set(sessionId, getTodayKey());
}

function hasUnlimitedRoomCreation(sessionId) {
  if (!sessionId) return false;
  return unlimitedCreatorSessions.has(sessionId);
}

// ---- helpers ----

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

function guesserCount(game) { return game.players.filter((p) => !p.isDrawer).length; }
function guessedCount(game) { return Object.keys(game.guesses).length; }

function publicState(room) {
  const { game, code } = room;
  return {
    roomCode: code,
    phase: game.phase,
    players: game.players.map(({ id, name, isHost, isDrawer }) => ({ id, name, isHost, isDrawer })),
    timeLeft: game.timeLeft,
    guessedCount: guessedCount(game),
    guesserCount: guesserCount(game),
    scores: { ...game.scores },
    isSuddenDeath: game.isSuddenDeath,
    drawingData: game.drawingData,
  };
}

function clearDisconnectTimer(room, sessionId) {
  const t = room.disconnectTimers.get(sessionId);
  if (t) { clearTimeout(t); room.disconnectTimers.delete(sessionId); }
}

// ---- timer ----

function startTimer(room) {
  if (room.timerInterval) clearInterval(room.timerInterval);
  room.game.timeLeft = ROUND_SECONDS;
  room.timerInterval = setInterval(() => {
    room.game.timeLeft -= 1;
    io.to(room.code).emit('timer_tick', room.game.timeLeft);
    if (room.game.timeLeft <= 0) {
      clearInterval(room.timerInterval);
      room.timerInterval = null;
      endGuessing(room);
    }
  }, 1000);
}

function checkEndCondition(room) {
  const { game } = room;
  if (game.phase !== 'guessing') return;
  if (guessedCount(game) >= guesserCount(game) && game.aiGuess !== null) {
    if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
    endGuessing(room);
  }
}

// ---- AI ----

async function requestAIGuess(room, imageData) {
  const { game } = room;
  if (!openai) {
    game.aiGuess = 'わからない';
    io.to(room.code).emit('game_update', publicState(room));
    checkEndCondition(room);
    return;
  }

  console.log('[AI] Requesting guess...');
  try {
    const base64 = imageData.replace(/^data:image\/[^;]+;base64,/, '');
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 30,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}`, detail: 'high' } },
          { type: 'text', text: 'このイラストが何かを日本語の短い名詞ひとつで答えてください。説明文や言い訳は不要です。' },
        ],
      }],
    });
    const raw = response.choices[0].message.content.trim();
    const REFUSAL = /申し訳|できません|すみません|不適切|I'm sorry|I cannot|inappropriate/i;
    if (REFUSAL.test(raw)) {
      game.aiGuess = '__filtered__';
      console.log(`[AI] Filtered response: "${raw.slice(0, 40)}"`);
    } else {
      const match = raw.match(/[ぁ-んァ-ン一-龠A-Za-z0-9ー]+/);
      game.aiGuess = match ? match[0] : raw.slice(0, 10);
      console.log(`[AI] Answer: "${game.aiGuess}" (raw: "${raw}")`);
    }  } catch (err) {
    console.error('[AI] Error:', err.status ?? '', err.message);
    game.aiGuess = 'わからない';
  }

  if (game.phase === 'guessing') {
    io.to(room.code).emit('game_update', publicState(room));
    checkEndCondition(room);
  }
}

async function judgeAnswers(topic, answers) {
  const keys = Object.keys(answers);
  if (keys.length === 0) return {};
  const fallback = () => Object.fromEntries(keys.map(k => [k, isCorrect(answers[k], topic)]));
  if (!openai) return fallback();

  const numbered = keys.map((k, i) => `${i + 1}. ${answers[k]}`).join('\n');
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 100,
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: `お絵かきゲームのお題は「${topic}」です。以下の回答が正解かどうか判定してください。同じ意味・言い方の違い（例：バンドエイド＝ばんそうこう、グラス＝コップ、えんぴつ＝鉛筆）は正解としてください。\n\n${numbered}\n\n{"1":true,"2":false,...} の形式のJSONのみ返してください。`,
      }],
    });
    const raw = JSON.parse(resp.choices[0].message.content);
    console.log('[Judge]', JSON.stringify(raw));
    return Object.fromEntries(keys.map((k, i) => [k, raw[String(i + 1)] ?? isCorrect(answers[k], topic)]));
  } catch (err) {
    console.error('[Judge] Error:', err.message);
    return fallback();
  }
}

async function emitResults(room) {
  const { game } = room;
  const drawer = game.players[game.drawerIndex];

  const toJudge = {};
  for (const [id, g] of Object.entries(game.guesses)) toJudge[id] = g.answer;
  toJudge['__ai__'] = game.aiGuess;

  const judgments = await judgeAnswers(game.topic, toJudge);
  for (const [id, correct] of Object.entries(judgments)) {
    if (game.guesses[id]) game.guesses[id].correct = correct;
  }
  const aiFiltered = game.aiGuess === '__filtered__';
  const aiCorrect = !aiFiltered && (judgments['__ai__'] ?? isCorrect(game.aiGuess, game.topic));
  const humanWin = Object.values(game.guesses).some((g) => g.correct);

  // AIがフィルターされた場合は引き分け（両者0点）
  let roundWinner = 'none';
  if (!aiFiltered) {
    if (humanWin && aiCorrect) roundWinner = 'both';
    else if (humanWin)         roundWinner = 'human';
    else if (aiCorrect)        roundWinner = 'ai';
  }

  if (roundWinner === 'human' || roundWinner === 'both') game.scores.human += 1;
  if (roundWinner === 'ai'    || roundWinner === 'both') game.scores.ai += 1;

  let gameOver = false;
  let matchWinner = null;
  if (game.isSuddenDeath) {
    if (roundWinner === 'human') { gameOver = true; matchWinner = 'human'; }
    else if (roundWinner === 'ai') { gameOver = true; matchWinner = 'ai'; }
  } else {
    const hr = game.scores.human >= WIN_TARGET;
    const ar = game.scores.ai >= WIN_TARGET;
    if (hr && ar) { game.isSuddenDeath = true; }
    else if (hr)  { gameOver = true; matchWinner = 'human'; }
    else if (ar)  { gameOver = true; matchWinner = 'ai'; }
  }

  // ラウンド履歴に追加
  game.roundHistory.push({
    drawing: game.drawingData,
    topic: game.topic,
    drawerName: drawer?.name ?? '？',
  });

  io.to(room.code).emit('game_results', {
    topic: game.topic, guesses: game.guesses,
    aiGuess: aiFiltered ? '（回答できませんでした）' : game.aiGuess,
    aiCorrect, aiFiltered, roundWinner, scores: { ...game.scores },
    isSuddenDeath: game.isSuddenDeath, gameOver, matchWinner,
    drawerName: drawer?.name ?? '',
    roundHistory: gameOver ? game.roundHistory : null,
  });
}

async function endGuessing(room) {
  if (room.game.phase !== 'guessing') return;
  if (room.game.aiGuess === null) room.game.aiGuess = 'わからない';
  room.game.phase = 'results';
  await emitResults(room).catch(err => console.error('[endGuessing] Error:', err.message));
}

function resetToLobby(room) {
  const saved = room.game.players.map((p) => ({ ...p, isDrawer: false }));
  if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
  room.game = freshGame();
  room.game.players = saved;
}

function resumePlayer(socket, room, player) {
  clearDisconnectTimer(room, player.sessionId);
  player.id = socket.id;

  if (room.game.guesses[socket.id] === undefined) {
    const oldGuess = Object.entries(room.game.guesses).find(([, g]) => g.sessionId === player.sessionId);
    if (oldGuess) {
      room.game.guesses[socket.id] = oldGuess[1];
      delete room.game.guesses[oldGuess[0]];
    }
  }

  socket.join(room.code);
  playerRoom.set(socket.id, room.code);

  socket.emit('joined', { sessionId: player.sessionId, roomCode: room.code });
  socket.emit('game_update', publicState(room));

  if (room.game.phase === 'topic_input' && player.isDrawer) socket.emit('choose_topic');
  if (room.game.phase === 'drawing'     && player.isDrawer) socket.emit('your_topic', room.game.topic);
  if (room.game.phase === 'guessing'    && room.game.drawingData) {
    socket.emit('guessing_start', { imageData: room.game.drawingData });
    socket.emit('timer_tick', room.game.timeLeft);
  }
}

function finalizeDisconnect(room, sessionId) {
  const idx = room.game.players.findIndex((p) => p.sessionId === sessionId);
  if (idx === -1) return;

  const player = room.game.players[idx];
  delete room.game.guesses[player.id];
  room.game.players.splice(idx, 1);
  clearDisconnectTimer(room, sessionId);
  sessionRoom.delete(sessionId);

  if (room.game.players.length === 0) {
    if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
    rooms.delete(room.code);
    return;
  }

  if (player.isHost) room.game.players[0].isHost = true;

  if (player.isDrawer && ['topic_input', 'drawing', 'guessing'].includes(room.game.phase)) {
    const savedScores = { ...room.game.scores };
    const savedSD = room.game.isSuddenDeath;
    resetToLobby(room);
    room.game.scores = savedScores;
    room.game.isSuddenDeath = savedSD;
    io.to(room.code).emit('game_aborted', '絵を描く人が退出しました。次のラウンドをお待ちください。');
  }

  io.to(room.code).emit('game_update', publicState(room));
  checkEndCondition(room);
}

// ---- socket ----

io.on('connection', (socket) => {

  socket.on('enable_dev_mode', ({ password, sessionId }) => {
    if (!DEV_OVERRIDE_PASSWORD || String(password ?? '') !== DEV_OVERRIDE_PASSWORD) return;
    const sid = String(sessionId ?? '').trim();
    if (!sid) return;
    unlimitedCreatorSessions.add(sid);
  });

  socket.on('get_rooms', () => {
    const list = [];
    for (const room of rooms.values()) {
      if (room.game.phase !== 'lobby') continue;
      if (room.game.players.length >= MAX_PLAYERS) continue;
      const host = room.game.players.find(p => p.isHost);
      list.push({
        code: room.code,
        hostName: host?.name ?? '？',
        playerCount: room.game.players.length,
      });
    }
    socket.emit('room_list', list);
  });

  socket.on('create_room', ({ name, sessionId }) => {
    // 再接続チェック
    const existingRoomCode = sessionId ? sessionRoom.get(sessionId) : null;
    const existingRoom = existingRoomCode ? rooms.get(existingRoomCode) : null;
    if (existingRoom) {
      const player = existingRoom.game.players.find((p) => p.sessionId === sessionId);
      if (player) { resumePlayer(socket, existingRoom, player); return; }
    }

    const trimmed = String(name ?? '').trim().slice(0, 10);
    if (!trimmed) return;

    const sid = sessionId || randomUUID();
    if (!hasUnlimitedRoomCreation(sid) && hasCreatedRoomToday(sid)) {
      socket.emit('error_msg', 'ルーム作成は1日1回までです。明日もう一度お試しください。');
      return;
    }

    const code = generateRoomCode();
    const room = freshRoom(code);

    room.game.players.push({ id: socket.id, sessionId: sid, name: trimmed, isHost: true, isDrawer: false });
    room.createdBySessionId = sid;
    rooms.set(code, room);
    socket.join(code);
    playerRoom.set(socket.id, code);
    sessionRoom.set(sid, code);
    markRoomCreatedToday(sid);

    socket.emit('joined', { sessionId: sid, roomCode: code });
    socket.emit('game_update', publicState(room));
    console.log(`[Room] Created ${code} by ${trimmed}`);
  });

  socket.on('join_room', ({ name, roomCode, sessionId }) => {
    const code = String(roomCode ?? '').trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('error_msg', 'ルームが見つかりません。コードを確認してください。');
      return;
    }

    // 再接続チェック
    if (sessionId) {
      const player = room.game.players.find((p) => p.sessionId === sessionId);
      if (player) { resumePlayer(socket, room, player); return; }
    }

    if (room.game.phase !== 'lobby') {
      socket.emit('error_msg', 'ゲームはすでに始まっています。次のゲームをお待ちください。');
      return;
    }

    if (room.game.players.length >= MAX_PLAYERS) {
      socket.emit('error_msg', 'このルームは満員です（最大6人）。');
      return;
    }

    const trimmed = String(name ?? '').trim().slice(0, 10);
    if (!trimmed) return;

    const sid = sessionId || randomUUID();
    room.game.players.push({ id: socket.id, sessionId: sid, name: trimmed, isHost: false, isDrawer: false });
    socket.join(code);
    playerRoom.set(socket.id, code);
    sessionRoom.set(sid, code);

    socket.emit('joined', { sessionId: sid, roomCode: code });
    io.to(code).emit('game_update', publicState(room));
    console.log(`[Room] ${trimmed} joined ${code}`);
  });

  socket.on('start_game', () => {
    const room = getRoom(socket.id);
    if (!room) return;
    const { game } = room;
    if (game.phase !== 'lobby') return;
    const me = game.players.find((p) => p.id === socket.id);
    if (!me?.isHost) return;
    if (game.players.length < 2) { socket.emit('error_msg', 'プレイヤーが2人以上必要です。'); return; }

    game.drawerIndex = Math.floor(Math.random() * game.players.length);
    game.players.forEach((p, i) => { p.isDrawer = i === game.drawerIndex; });
    game.topic = ''; game.phase = 'topic_input';
    game.guesses = {}; game.drawingData = null; game.aiGuess = null;

    io.to(room.code).emit('game_update', publicState(room));
    io.to(game.players[game.drawerIndex].id).emit('choose_topic');
  });

  socket.on('submit_topic', ({ topic }) => {
    const room = getRoom(socket.id);
    if (!room) return;
    const { game } = room;
    if (game.phase !== 'topic_input') return;
    const me = game.players.find((p) => p.id === socket.id);
    if (!me?.isDrawer) return;

    const trimmed = String(topic ?? '').trim().slice(0, 20);
    if (!trimmed) return;

    game.topic = trimmed;
    game.phase = 'drawing';
    io.to(room.code).emit('game_update', publicState(room));
    io.to(me.id).emit('your_topic', game.topic);
  });

  socket.on('next_round', () => {
    const room = getRoom(socket.id);
    if (!room) return;
    const { game } = room;
    if (game.phase !== 'results') return;
    const me = game.players.find((p) => p.id === socket.id);
    if (!me?.isHost) return;

    game.drawerIndex = Math.floor(Math.random() * game.players.length);
    game.players.forEach((p, i) => { p.isDrawer = i === game.drawerIndex; });
    game.topic = ''; game.phase = 'topic_input';
    game.guesses = {}; game.drawingData = null; game.aiGuess = null; game.timeLeft = ROUND_SECONDS;

    io.to(room.code).emit('game_update', publicState(room));
    io.to(game.players[game.drawerIndex].id).emit('choose_topic');
  });

  socket.on('draw_stroke', (strokeData) => {
    const room = getRoom(socket.id);
    if (!room || room.game.phase !== 'drawing') return;
    if (!room.game.players.find((p) => p.id === socket.id)?.isDrawer) return;
    socket.to(room.code).emit('draw_stroke', strokeData);
  });

  socket.on('canvas_clear', () => {
    const room = getRoom(socket.id);
    if (!room || room.game.phase !== 'drawing') return;
    if (!room.game.players.find((p) => p.id === socket.id)?.isDrawer) return;
    socket.to(room.code).emit('canvas_clear');
  });

  socket.on('submit_drawing', (imageData) => {
    const room = getRoom(socket.id);
    if (!room || room.game.phase !== 'drawing') return;
    if (!room.game.players.find((p) => p.id === socket.id)?.isDrawer) return;

    room.game.drawingData = imageData;
    room.game.phase = 'guessing';
    room.game.guesses = {};

    io.to(room.code).emit('guessing_start', { imageData });
    io.to(room.code).emit('game_update', publicState(room));
    startTimer(room);
    requestAIGuess(room, imageData);
  });

  socket.on('submit_guess', ({ answer }) => {
    const room = getRoom(socket.id);
    if (!room || room.game.phase !== 'guessing') return;
    const me = room.game.players.find((p) => p.id === socket.id);
    if (!me || me.isDrawer || room.game.guesses[socket.id]) return;

    const trimmed = String(answer ?? '').trim();
    if (!trimmed) return;

    room.game.guesses[socket.id] = { name: me.name, answer: trimmed, correct: false };
    io.to(room.code).emit('game_update', publicState(room));
    checkEndCondition(room);
  });

  socket.on('leave_room', () => {
    const room = getRoom(socket.id);
    if (!room) return;
    const player = room.game.players.find((p) => p.id === socket.id);
    if (player && room.game.phase === 'lobby' && player.sessionId === room.createdBySessionId) {
      createdRoomDates.delete(player.sessionId);
    }
    playerRoom.delete(socket.id);
    socket.leave(room.code);
    finalizeDisconnect(room, player?.sessionId);
  });

  socket.on('play_again', () => {
    const room = getRoom(socket.id);
    if (!room || room.game.phase !== 'results') return;
    const me = room.game.players.find((p) => p.id === socket.id);
    if (!me?.isHost) return;

    resetToLobby(room);
    io.to(room.code).emit('game_update', publicState(room));
    io.to(room.code).emit('reset_game');
  });

  socket.on('disconnect', () => {
    const room = getRoom(socket.id);
    if (!room) return;
    playerRoom.delete(socket.id);

    const player = room.game.players.find((p) => p.id === socket.id);
    if (!player) return;

    clearDisconnectTimer(room, player.sessionId);
    room.disconnectTimers.set(
      player.sessionId,
      setTimeout(() => finalizeDisconnect(room, player.sessionId), RECONNECT_GRACE_MS)
    );
    io.to(room.code).emit('game_update', publicState(room));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Startup] Server listening on http://localhost:${PORT}`);
});
