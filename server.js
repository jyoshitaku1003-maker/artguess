require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const OpenAI = require('openai');
const path = require('path');
const { randomUUID } = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5e6, // 5MB上限（デフォルト1MB）
});

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.use((_, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:");
  next();
});
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
const MAX_IMAGE_B64_LEN = 7 * 1024 * 1024; // ~5MB バイナリ相当
const MAX_STROKE_POINTS = 1000;
const AI_COOLDOWN_MS = 12000; // ソケットごとのAI呼び出し最小間隔（ms）

// ---- room management ----

const rooms = new Map();       // roomCode -> room
const playerRoom = new Map();  // socketId -> roomCode
const sessionRoom = new Map(); // sessionId -> roomCode
const createdRoomDates   = new Map(); // sessionId -> YYYY-MM-DD
const createdRoomDatesByIP = new Map(); // IP -> YYYY-MM-DD
const soloPlayedDates    = new Map(); // sessionId -> YYYY-MM-DD
const soloPlayedDatesByIP  = new Map(); // IP -> YYYY-MM-DD
const soloCurrentTopics = new Map(); // socketId -> 現在のお題
const aiLastCallTime    = new Map(); // socketId -> 最終AI呼び出し時刻
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
    topicChoices: [],
    usedTopics: [],
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
  return { code, game: freshGame(), timerInterval: null, drawingTimerInterval: null, disconnectTimers: new Map(), createdBySessionId: null };
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

function getClientIP(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return socket.handshake.address;
}

function hasCreatedRoomToday(sessionId, ip) {
  if (!sessionId && !ip) return false;
  const today = getTodayKey();
  return createdRoomDates.get(sessionId) === today || (ip && createdRoomDatesByIP.get(ip) === today);
}

function markRoomCreatedToday(sessionId, ip) {
  const today = getTodayKey();
  if (sessionId) createdRoomDates.set(sessionId, today);
  if (ip) createdRoomDatesByIP.set(ip, today);
}

function hasUnlimitedRoomCreation(sessionId) {
  if (!sessionId) return false;
  return unlimitedCreatorSessions.has(sessionId);
}

function hasSoloPlayedToday(sessionId, ip) {
  if (!sessionId && !ip) return false;
  const today = getTodayKey();
  return soloPlayedDates.get(sessionId) === today || (ip && soloPlayedDatesByIP.get(ip) === today);
}

function markSoloPlayedToday(sessionId, ip) {
  const today = getTodayKey();
  if (sessionId) soloPlayedDates.set(sessionId, today);
  if (ip) soloPlayedDatesByIP.set(ip, today);
}

// ---- helpers ----

function canCallAI(socketId) {
  const now = Date.now();
  const last = aiLastCallTime.get(socketId) || 0;
  if (now - last < AI_COOLDOWN_MS) return false;
  aiLastCallTime.set(socketId, now);
  return true;
}

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

function startDrawingTimer(room) {
  if (room.drawingTimerInterval) clearInterval(room.drawingTimerInterval);
  let timeLeft = ROUND_SECONDS;
  io.to(room.code).emit('drawing_timer_tick', timeLeft);
  room.drawingTimerInterval = setInterval(() => {
    timeLeft -= 1;
    io.to(room.code).emit('drawing_timer_tick', timeLeft);
    if (timeLeft <= 0) {
      clearInterval(room.drawingTimerInterval);
      room.drawingTimerInterval = null;
      if (room.game.phase === 'drawing') {
        io.to(room.code).emit('drawing_timeout');
      }
    }
  }, 1000);
}

function clearDrawingTimer(room) {
  if (room.drawingTimerInterval) { clearInterval(room.drawingTimerInterval); room.drawingTimerInterval = null; }
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
    if (humanWin && aiCorrect) roundWinner = 'ai';   // 両者正解はAIのポイント
    else if (humanWin)         roundWinner = 'human';
    else if (aiCorrect)        roundWinner = 'ai';
  }

  if (roundWinner === 'human') game.scores.human += 1;
  if (roundWinner === 'ai')    game.scores.ai += 1;

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
    aiCorrect, aiFiltered, humanWin, roundWinner, scores: { ...game.scores },
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
  clearDrawingTimer(room);
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

  if (room.game.phase === 'topic_input' && player.isDrawer) socket.emit('choose_topic', { choices: room.game.topicChoices });
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

// ---- topic choices ----

async function generateTopicChoices(usedTopics = []) {
  if (!openai) return ['猫', '家', '車'].filter(t => !usedTopics.includes(t)).slice(0, 3).concat(['猫', '家', '車']).slice(0, 3);
  const exclusion = usedTopics.length > 0
    ? `\n次のお題はすでに使用済みなので絶対に使わないでください：${usedTopics.join('、')}`
    : '';
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 60,
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: `お絵かきゲームのお題を3つ考えてください。条件：日本語の名詞で1〜8文字、絵として描けるもの、3つとも難しめにしてください（例：身近でないもの、抽象的な概念に近いもの、複雑な形のもの、あまり見慣れないものなど）。簡単すぎるものや頻出すぎるものは避けてください。{"topics":["お題1","お題2","お題3"]}の形式でJSONのみ返してください。${exclusion}`,
      }],
    });
    const raw = JSON.parse(resp.choices[0].message.content);
    if (Array.isArray(raw.topics) && raw.topics.length === 3) return raw.topics.map(t => String(t).trim().slice(0, 20));
    return ['猫', '家', '車'];
  } catch (err) {
    console.error('[TopicChoices] Error:', err.message);
    return ['猫', '家', '車'];
  }
}

// ---- solo mode ----

const SOLO_TOPIC_FALLBACK = ['猫', '犬', '魚', '家', '山', '木', '車', '船', '傘', '鳥'];
const soloUsedTopics = new Map(); // socketId -> string[]

async function generateSoloTopic(usedTopics = []) {
  if (!openai) {
    const available = SOLO_TOPIC_FALLBACK.filter(t => !usedTopics.includes(t));
    const pool = available.length > 0 ? available : SOLO_TOPIC_FALLBACK;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  const exclusion = usedTopics.length > 0
    ? `\n次のお題はすでに使用済みなので絶対に使わないでください：${usedTopics.join('、')}`
    : '';
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 20,
      messages: [{
        role: 'user',
        content: `お絵かきゲームのお題を1つ考えてください。条件：日本語の名詞で1〜6文字、絵に描きやすいもの（動物・食べ物・乗り物・日用品・自然など）、単語のみ返してください。説明不要。${exclusion}`,
      }],
    });
    const raw = resp.choices[0].message.content.trim();
    const m = raw.match(/[ぁ-んァ-ン一-龠A-Za-zー]+/);
    return m ? m[0] : raw.slice(0, 6);
  } catch (err) {
    console.error('[Solo] Topic generation error:', err.message);
    return SOLO_TOPIC_FALLBACK[Math.floor(Math.random() * SOLO_TOPIC_FALLBACK.length)];
  }
}

// ---- socket ----

io.on('connection', (socket) => {

  socket.on('enable_dev_mode', ({ password, sessionId }) => {
    if (!DEV_OVERRIDE_PASSWORD || String(password ?? '') !== DEV_OVERRIDE_PASSWORD) {
      socket.emit('dev_mode_result', false);
      return;
    }
    const sid = String(sessionId ?? '').trim();
    if (!sid) { socket.emit('dev_mode_result', false); return; }
    unlimitedCreatorSessions.add(sid);
    socket.emit('dev_mode_result', true);
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
    const ip = getClientIP(socket);
    if (!hasUnlimitedRoomCreation(sid) && hasCreatedRoomToday(sid, ip)) {
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
    markRoomCreatedToday(sid, ip);

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

  socket.on('start_game', async () => {
    const room = getRoom(socket.id);
    if (!room) return;
    const { game } = room;
    if (game.phase !== 'lobby') return;
    const me = game.players.find((p) => p.id === socket.id);
    if (!me?.isHost) return;
    if (game.players.length < 2) { socket.emit('error_msg', 'プレイヤーが2人以上必要です。'); return; }

    game.drawerIndex = Math.floor(Math.random() * game.players.length);
    game.players.forEach((p, i) => { p.isDrawer = i === game.drawerIndex; });
    game.topic = ''; game.topicChoices = []; game.phase = 'topic_input';
    game.guesses = {}; game.drawingData = null; game.aiGuess = null;

    io.to(room.code).emit('game_update', publicState(room));
    const choices = await generateTopicChoices(game.usedTopics);
    game.topicChoices = choices;
    io.to(game.players[game.drawerIndex].id).emit('choose_topic', { choices });
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
    game.usedTopics.push(trimmed);
    game.phase = 'drawing';
    io.to(room.code).emit('game_update', publicState(room));
    io.to(me.id).emit('your_topic', game.topic);
    startDrawingTimer(room);
  });

  socket.on('next_round', async () => {
    const room = getRoom(socket.id);
    if (!room) return;
    const { game } = room;
    if (game.phase !== 'results') return;
    const me = game.players.find((p) => p.id === socket.id);
    if (!me?.isHost) return;

    game.drawerIndex = Math.floor(Math.random() * game.players.length);
    game.players.forEach((p, i) => { p.isDrawer = i === game.drawerIndex; });
    game.topic = ''; game.topicChoices = []; game.phase = 'topic_input';
    game.guesses = {}; game.drawingData = null; game.aiGuess = null; game.timeLeft = ROUND_SECONDS;

    io.to(room.code).emit('game_update', publicState(room));
    const choices = await generateTopicChoices(game.usedTopics);
    game.topicChoices = choices;
    io.to(game.players[game.drawerIndex].id).emit('choose_topic', { choices });
  });

  socket.on('draw_stroke', (strokeData) => {
    if (!strokeData || !Array.isArray(strokeData.points)) return;
    if (strokeData.points.length > MAX_STROKE_POINTS) return;
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
    if (!imageData || typeof imageData !== 'string' || imageData.length > MAX_IMAGE_B64_LEN) return;
    const room = getRoom(socket.id);
    if (!room || room.game.phase !== 'drawing') return;
    if (!room.game.players.find((p) => p.id === socket.id)?.isDrawer) return;
    if (!canCallAI(socket.id)) return;

    clearDrawingTimer(room);
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
      createdRoomDatesByIP.delete(getClientIP(socket));
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

    const ip = getClientIP(socket);
    if (!hasUnlimitedRoomCreation(me.sessionId) && hasCreatedRoomToday(me.sessionId, ip)) {
      socket.emit('error_msg', '本日はすでにプレイ済みです。明日また遊んでください。');
      return;
    }

    resetToLobby(room);
    io.to(room.code).emit('game_update', publicState(room));
    io.to(room.code).emit('reset_game');
  });

  socket.on('solo_session_start', ({ sessionId }) => {
    const sid = String(sessionId ?? '').trim();
    const ip = getClientIP(socket);
    if (!hasUnlimitedRoomCreation(sid) && hasSoloPlayedToday(sid, ip)) {
      socket.emit('solo_session_result', false);
      return;
    }
    markSoloPlayedToday(sid, ip);
    socket.emit('solo_session_result', true);
    console.log(`[Solo] Session started: ${sid} (${ip})`);
  });

  socket.on('solo_start', async () => {
    const used = soloUsedTopics.get(socket.id) || [];
    const topic = await generateSoloTopic(used);
    used.push(topic);
    soloUsedTopics.set(socket.id, used);
    soloCurrentTopics.set(socket.id, topic);
    socket.emit('solo_topic', topic);
    console.log(`[Solo] Topic: "${topic}" (used: ${used.length}) → ${socket.id}`);
  });

  socket.on('solo_submit_drawing', async ({ imageData }) => {
    if (!imageData || typeof imageData !== 'string' || imageData.length > MAX_IMAGE_B64_LEN) return;
    if (!canCallAI(socket.id)) {
      socket.emit('error_msg', '送信が速すぎます。少し待ってから再送信してください。');
      return;
    }
    const cleanTopic = soloCurrentTopics.get(socket.id) || '';
    soloCurrentTopics.delete(socket.id);
    if (!cleanTopic) {
      socket.emit('solo_result', { aiGuess: 'わからない', correct: false, topic: '' });
      return;
    }
    if (!openai) {
      socket.emit('solo_result', { aiGuess: 'わからない', correct: false, topic: cleanTopic });
      return;
    }
    console.log(`[Solo] Judging drawing for: "${cleanTopic}"`);
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
        socket.emit('solo_result', { aiGuess: '（回答できませんでした）', correct: false, topic: cleanTopic, aiFiltered: true });
        return;
      }
      const m = raw.match(/[ぁ-んァ-ン一-龠A-Za-z0-9ー]+/);
      const aiGuess = m ? m[0] : raw.slice(0, 10);
      console.log(`[Solo] AI guessed: "${aiGuess}" for "${cleanTopic}"`);

      const judgments = await judgeAnswers(cleanTopic, { ai: aiGuess });
      const correct = judgments['ai'] ?? isCorrect(aiGuess, cleanTopic);

      socket.emit('solo_result', { aiGuess, correct, topic: cleanTopic });
    } catch (err) {
      console.error('[Solo] Error:', err.message);
      socket.emit('solo_result', { aiGuess: 'わからない', correct: false, topic: cleanTopic });
    }
  });

  socket.on('disconnect', () => {
    soloUsedTopics.delete(socket.id);
    soloCurrentTopics.delete(socket.id);
    aiLastCallTime.delete(socket.id);
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
