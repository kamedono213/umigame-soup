import {
  createRoom, joinRoom, subscribeToRoom, selectPuzzle,
  submitPending, answerQuestion, judgeGuess,
  requestEndGame, cancelEndRequest, approveEndGame, startNextRound,
  sendChatMessage,
  getClientId,
} from './room.js';
import { listGames, putGame, deleteGame } from './db.js';
import { PUZZLES } from './puzzles.js';

const $ = (id) => document.getElementById(id);
const app = $('app');
const bottomTabbar = $('bottomTabbar');

const ANSWER_OPTIONS = ['はい', 'いいえ', 'どちらでもない', '部分的にはい', '部分的にいいえ'];
const ANSWER_CLASS = {
  'はい': 'ans-yes', 'いいえ': 'ans-no', 'どちらでもない': 'ans-maybe',
  '部分的にはい': 'ans-partial-yes', '部分的にいいえ': 'ans-partial-no',
};

const PUZZLE_BY_ID = new Map(PUZZLES.map((p) => [p.id, p]));
const ALL_TAGS = (() => {
  const freq = new Map();
  for (const p of PUZZLES) for (const t of p.tags) freq.set(t, (freq.get(t) || 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
})();

const state = {
  tab: 'battle',
  code: null,
  room: null,
  unsubscribe: null,
  selectedTags: new Set(),
  previewPuzzleId: null, // 選択画面で詳細プレビュー中の問題
  answerPanelOpen: false, // 親の「答えを確認」パネルの開閉状態
  freeAnswerMode: false, // 質問への自由回答入力欄を開いているか
  dataGames: [],
  savedEndedKey: null,
  chatOpen: false,
  chatSeenCount: 0, // パネルを開いて既読にした時点でのチャット件数(未読バッジ算出用)
};

function myRole(room) {
  const cid = getClientId();
  if (!room) return null;
  if (room.hostId === cid) return 'host';
  if (room.guestId === cid) return 'guest';
  return null;
}

function saveActiveRoom(code) {
  try { localStorage.setItem('umigame-soup:activeRoom', JSON.stringify({ code })); } catch (_) {}
}
function loadActiveRoom() {
  try { return JSON.parse(localStorage.getItem('umigame-soup:activeRoom') || 'null'); } catch (_) { return null; }
}
function clearActiveRoom() {
  try { localStorage.removeItem('umigame-soup:activeRoom'); } catch (_) {}
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toast.hidden = true; }, 2200);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ------------------------------------------------------------------
// 画面の切り替え
// ------------------------------------------------------------------
function render() {
  if (state.tab === 'data') renderDataTab();
  else renderBattleTab();
  for (const btn of bottomTabbar.querySelectorAll('button')) {
    btn.classList.toggle('is-active', btn.dataset.tab === state.tab);
  }
}
function switchTab(tab) { state.tab = tab; render(); }

function renderBattleTab() {
  const room = state.room;
  if (!room) return renderHomeScreen();
  switch (room.phase) {
    case 'waiting_guest': return renderWaitingGuest(room);
    case 'selecting_puzzle': return renderSelectingPuzzle(room);
    case 'playing': return renderPlaying(room);
    case 'ended': return renderEnded(room);
    default: return renderHomeScreen();
  }
}

function renderHomeScreen() {
  app.innerHTML = `
    <section class="home-view">
      <div class="hero-card">
        <h1>ウミガメのスープ</h1>
        <p>2人であそぶ、水平思考パズルバトル。親が問題を選び、子が質問で謎を解きます。</p>
      </div>
      <div class="action-card">
        <button id="createRoomBtn" class="primary-btn" type="button">部屋を作る(親になる)</button>
      </div>
      <div class="action-card">
        <label class="field-label">4桁の部屋コードで参加</label>
        <div class="join-row">
          <input id="joinCodeInput" inputmode="numeric" maxlength="4" placeholder="0000">
          <button id="joinRoomBtn" class="secondary-btn" type="button">参加する</button>
        </div>
      </div>
    </section>`;
  $('createRoomBtn').addEventListener('click', handleCreateRoom);
  $('joinRoomBtn').addEventListener('click', handleJoinRoom);
  $('joinCodeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleJoinRoom(); });
}

async function handleCreateRoom() {
  const btn = $('createRoomBtn');
  btn.disabled = true;
  try {
    const { code } = await createRoom();
    enterRoom(code);
  } catch (error) {
    showToast(error.message || '部屋の作成に失敗しました');
  } finally {
    btn.disabled = false;
  }
}

async function handleJoinRoom() {
  const raw = $('joinCodeInput').value.trim();
  if (!/^\d{4}$/.test(raw)) { showToast('4桁の数字で入力してください'); return; }
  const btn = $('joinRoomBtn');
  btn.disabled = true;
  try {
    await joinRoom(raw);
    enterRoom(raw);
  } catch (error) {
    showToast(error.message || '参加に失敗しました');
  } finally {
    btn.disabled = false;
  }
}

function enterRoom(code) {
  state.code = code;
  saveActiveRoom(code);
  if (state.unsubscribe) state.unsubscribe();
  state.unsubscribe = subscribeToRoom(code, (room) => {
    if (!room) {
      showToast('部屋が見つかりませんでした');
      leaveRoom();
      return;
    }
    const prevPhase = state.room?.phase;
    state.room = room;
    if (prevPhase !== 'ended' && room.phase === 'ended') saveCompletedGameLocally(room);
    if (prevPhase !== room.phase && room.phase === 'selecting_puzzle') {
      state.previewPuzzleId = null;
      state.selectedTags.clear();
      state.answerPanelOpen = false;
    }
    if (prevPhase !== room.phase && room.phase === 'playing') state.freeAnswerMode = false;
    render();
    updateChatUi(room);
  });
  render();
}

function leaveRoom() {
  if (state.unsubscribe) state.unsubscribe();
  state.unsubscribe = null;
  state.code = null;
  state.room = null;
  clearActiveRoom();
  render();
  closeChatPanel();
  state.chatSeenCount = 0;
  updateChatUi(null);
}

// ------------------------------------------------------------------
// バトル中のチャット(画面下のバーを押すと全画面パネルが開く)。
// 相手がいる部屋(guestId確定後)でだけ使える。質問ログとは別枠の自由会話。
// ------------------------------------------------------------------
function chatBarEl() { return $('chatBar'); }

function updateChatUi(room) {
  const inRoom = !!(room && room.guestId);
  document.body.classList.toggle('in-room', inRoom);
  const bar = chatBarEl();
  bar.hidden = !inRoom;
  if (!inRoom) {
    closeChatPanel();
    return;
  }
  const chat = room.chat || [];
  const last = chat[chat.length - 1];
  $('chatBarPreview').textContent = last
    ? `${last.from === myRole(room) ? 'あなた' : '相手'}: ${last.text}`
    : 'チャット';
  const badge = $('chatBarBadge');
  if (state.chatOpen) {
    state.chatSeenCount = chat.length;
    badge.hidden = true;
    renderChatMessages(room);
  } else {
    const unread = chat.length - state.chatSeenCount;
    badge.hidden = unread <= 0;
    if (unread > 0) badge.textContent = String(unread);
  }
}

function renderChatMessages(room) {
  const role = myRole(room);
  const list = $('chatMessages');
  list.innerHTML = (room.chat || []).map((m) => `
    <div class="chat-msg ${m.from === role ? 'is-me' : 'is-them'}">${escapeHtml(m.text)}</div>
  `).join('') || '<p class="hint-text">まだメッセージがありません</p>';
  list.scrollTop = list.scrollHeight;
}

function openChatPanel() {
  if (!state.room || !state.room.guestId) return;
  state.chatOpen = true;
  $('chatPanel').hidden = false;
  state.chatSeenCount = (state.room.chat || []).length;
  $('chatBarBadge').hidden = true;
  renderChatMessages(state.room);
  $('chatInput').focus();
}

function closeChatPanel() {
  state.chatOpen = false;
  $('chatPanel').hidden = true;
}

// ------------------------------------------------------------------
// 途中終了の共通UI
// ------------------------------------------------------------------
function roundTopbarHtml(room) {
  return `
    <div class="round-topbar">
      <span class="round-topbar-code">部屋 ${room.code}</span>
      <button id="endGameBtn" class="end-game-btn" type="button" title="このラウンドを途中で終了する">✕ 終了</button>
    </div>
    <div id="endRequestBanner"></div>`;
}
function wireRoundTopbar(room) {
  const role = myRole(room);
  $('endGameBtn')?.addEventListener('click', async () => {
    if (!confirm('このラウンドを途中で終了しますか？相手に確認が送られます。')) return;
    await requestEndGame(room.code, role);
  });
  const banner = $('endRequestBanner');
  if (!banner || !room.endRequest) return;
  if (room.endRequest.by === role) {
    banner.innerHTML = `<div class="end-request-banner"><p>相手の返事を待っています…</p><button id="cancelEndBtn" class="secondary-btn" type="button">取り消す</button></div>`;
    $('cancelEndBtn').addEventListener('click', () => cancelEndRequest(room.code));
  } else {
    banner.innerHTML = `
      <div class="end-request-banner is-incoming">
        <p>相手がこのラウンドを終了したがっています</p>
        <div class="end-request-buttons">
          <button id="approveEndBtn" class="primary-btn" type="button">終了する</button>
          <button id="declineEndBtn" class="secondary-btn" type="button">続ける</button>
        </div>
      </div>`;
    $('approveEndBtn').addEventListener('click', () => approveEndGame(room.code));
    $('declineEndBtn').addEventListener('click', () => cancelEndRequest(room.code));
  }
}

function renderWaitingGuest(room) {
  const role = myRole(room);
  app.innerHTML = `
    <section class="waiting-view">
      <div class="code-card">
        <p class="field-label">部屋コード</p>
        <div class="code-display">${room.code}</div>
        <p class="hint-text">このコードを相手に伝えてください</p>
      </div>
      <p class="status-text">${role === 'host' ? '相手の参加を待っています…' : '参加しました'}</p>
      <button id="leaveBtn" class="secondary-btn" type="button">やめる</button>
    </section>`;
  $('leaveBtn').addEventListener('click', leaveRoom);
}

// ------------------------------------------------------------------
// 問題選択(親)
// ------------------------------------------------------------------
function filteredPuzzles() {
  if (state.selectedTags.size === 0) return PUZZLES;
  return PUZZLES.filter((p) => [...state.selectedTags].every((t) => p.tags.includes(t)));
}

function renderSelectingPuzzle(room) {
  const role = myRole(room);
  if (role !== 'host') {
    app.innerHTML = `
      ${roundTopbarHtml(room)}
      <section class="waiting-view"><p class="status-text">親が問題を選んでいます…</p></section>`;
    wireRoundTopbar(room);
    return;
  }

  if (state.previewPuzzleId) {
    const p = PUZZLE_BY_ID.get(state.previewPuzzleId);
    app.innerHTML = `
      ${roundTopbarHtml(room)}
      <section class="puzzle-preview">
        <button id="backToListBtn" class="secondary-btn" type="button">← 一覧へ戻る</button>
        <h2>${escapeHtml(p.title)}</h2>
        <div class="tag-row">${p.tags.map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('')}</div>
        <div class="puzzle-block"><h3>問題</h3><p>${escapeHtml(p.question)}</p></div>
        <div class="puzzle-block answer-block"><h3>答え</h3><p>${escapeHtml(p.answer)}</p></div>
        ${p.author ? `<p class="hint-text">作者: ${escapeHtml(p.author)}</p>` : ''}
        <button id="confirmPuzzleBtn" class="primary-btn" type="button">この問題で出題する</button>
      </section>`;
    wireRoundTopbar(room);
    $('backToListBtn').addEventListener('click', () => { state.previewPuzzleId = null; render(); });
    $('confirmPuzzleBtn').addEventListener('click', async () => {
      $('confirmPuzzleBtn').disabled = true;
      await selectPuzzle(room.code, p.id);
    });
    return;
  }

  const list = filteredPuzzles();
  app.innerHTML = `
    ${roundTopbarHtml(room)}
    <section class="puzzle-select">
      <h2>問題を選んでください</h2>
      <div id="tagFilterRow" class="tag-filter-row"></div>
      <p class="hint-text">${list.length}問 / 全${PUZZLES.length}問</p>
      <div id="puzzleList" class="puzzle-list"></div>
    </section>`;
  wireRoundTopbar(room);

  const tagRow = $('tagFilterRow');
  for (const tag of ALL_TAGS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `tag-filter-chip${state.selectedTags.has(tag) ? ' is-active' : ''}`;
    btn.textContent = tag;
    btn.addEventListener('click', () => {
      if (state.selectedTags.has(tag)) state.selectedTags.delete(tag);
      else state.selectedTags.add(tag);
      render();
    });
    tagRow.appendChild(btn);
  }

  const listEl = $('puzzleList');
  for (const p of list) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'puzzle-card';
    card.innerHTML = `<strong>${escapeHtml(p.title)}</strong><span class="puzzle-card-q">${escapeHtml(p.question)}</span>`;
    card.addEventListener('click', () => { state.previewPuzzleId = p.id; render(); });
    listEl.appendChild(card);
  }
  if (!list.length) {
    listEl.innerHTML = '<p class="hint-text">条件に合う問題がありません。タグを減らしてみてください。</p>';
  }
}

// ------------------------------------------------------------------
// ログ描画
// ------------------------------------------------------------------
function logEntryLine(entry) {
  if (entry.type === 'question') {
    const cls = ANSWER_CLASS[entry.answer] || 'ans-free';
    return `<div class="log-line">
      <span class="log-q">Q${entry.n}. ${escapeHtml(entry.text)}</span>
      <span class="log-a ${cls}">${escapeHtml(entry.answer)}</span>
    </div>`;
  }
  const resultClass = entry.correct ? 'ans-correct' : 'ans-incorrect';
  const resultText = entry.correct ? '正解！' : 'ハズレ';
  return `<div class="log-line log-line-guess">
    <span class="log-q">回答 #${entry.n}: ${escapeHtml(entry.text)}</span>
    <span class="log-a ${resultClass}">${resultText}</span>
  </div>`;
}

// ------------------------------------------------------------------
// プレイ中
// ------------------------------------------------------------------
function renderPlaying(room) {
  const role = myRole(room);
  const puzzle = PUZZLE_BY_ID.get(room.puzzleId);
  const logHtml = (room.log || []).map(logEntryLine).join('') || '<p class="hint-text">まだ質問がありません</p>';

  app.innerHTML = `
    ${roundTopbarHtml(room)}
    <section class="play-view">
      <div class="play-head">
        <span class="role-badge">${role === 'host' ? '親' : '子'}</span>
        <span class="puzzle-title">${escapeHtml(puzzle?.title || '')}</span>
      </div>
      <div class="puzzle-question-card"><p>${escapeHtml(puzzle?.question || '')}</p></div>
      ${role === 'host' ? `
        <button id="toggleAnswerBtn" class="answer-toggle-btn" type="button">${state.answerPanelOpen ? '答えを隠す ▲' : '答えを確認する ▼'}</button>
        <div class="answer-panel" ${state.answerPanelOpen ? '' : 'hidden'}><p>${escapeHtml(puzzle?.answer || '')}</p></div>
      ` : ''}
      <div id="logArea" class="log-area">${logHtml}</div>
      <div id="actionArea" class="action-area"></div>
    </section>`;
  wireRoundTopbar(room);

  if (role === 'host') {
    $('toggleAnswerBtn').addEventListener('click', () => {
      state.answerPanelOpen = !state.answerPanelOpen;
      render();
    });
  }

  const logArea = $('logArea');
  logArea.scrollTop = logArea.scrollHeight;

  const actionArea = $('actionArea');
  if (room.pending) {
    renderPendingForHost(actionArea, room, role);
  } else if (role === 'guest') {
    renderGuestInput(actionArea, room);
  } else {
    actionArea.innerHTML = `<p class="hint-text">相手の質問・回答を待っています…</p>`;
  }
}

function renderPendingForHost(actionArea, room, role) {
  if (role !== 'host') {
    actionArea.innerHTML = `<p class="hint-text">相手の回答を待っています…</p>`;
    return;
  }
  const p = room.pending;
  if (p.type === 'question') {
    if (state.freeAnswerMode) {
      actionArea.innerHTML = `
        <div class="pending-card">
          <p class="pending-label">Q${p.n}. ${escapeHtml(p.text)}</p>
          <textarea id="freeAnswerInput" class="free-answer-input" placeholder="自由に回答を書いてください"></textarea>
          <div class="question-buttons">
            <button id="sendFreeAnswerBtn" class="primary-btn" type="button">この内容で回答する</button>
            <button id="cancelFreeAnswerBtn" class="secondary-btn" type="button">5択に戻る</button>
          </div>
        </div>`;
      $('sendFreeAnswerBtn').addEventListener('click', async () => {
        const text = $('freeAnswerInput').value.trim();
        if (!text) { showToast('回答を入力してください'); return; }
        $('sendFreeAnswerBtn').disabled = true;
        state.freeAnswerMode = false;
        await answerQuestion(room.code, p, text);
      });
      $('cancelFreeAnswerBtn').addEventListener('click', () => { state.freeAnswerMode = false; render(); });
      return;
    }
    actionArea.innerHTML = `
      <div class="pending-card">
        <p class="pending-label">Q${p.n}. ${escapeHtml(p.text)}</p>
        <div class="answer-grid">
          ${ANSWER_OPTIONS.map((opt) => `<button class="answer-btn ${ANSWER_CLASS[opt]}" data-answer="${opt}" type="button">${opt}</button>`).join('')}
        </div>
        <button id="freeAnswerModeBtn" class="secondary-btn" type="button">自由回答で返す</button>
      </div>`;
    actionArea.querySelectorAll('[data-answer]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        actionArea.querySelectorAll('button').forEach((b) => (b.disabled = true));
        await answerQuestion(room.code, p, btn.dataset.answer);
      });
    });
    $('freeAnswerModeBtn').addEventListener('click', () => { state.freeAnswerMode = true; render(); });
  } else {
    actionArea.innerHTML = `
      <div class="pending-card">
        <p class="pending-label">相手の回答: ${escapeHtml(p.text)}</p>
        <div class="judge-grid">
          <button id="judgeCorrectBtn" class="answer-btn ans-correct" type="button">正解</button>
          <button id="judgeIncorrectBtn" class="answer-btn ans-incorrect" type="button">ハズレ</button>
        </div>
      </div>`;
    $('judgeCorrectBtn').addEventListener('click', async () => {
      actionArea.querySelectorAll('button').forEach((b) => (b.disabled = true));
      await judgeGuess(room.code, p, true);
    });
    $('judgeIncorrectBtn').addEventListener('click', async () => {
      actionArea.querySelectorAll('button').forEach((b) => (b.disabled = true));
      await judgeGuess(room.code, p, false);
    });
  }
}

function renderGuestInput(actionArea, room) {
  actionArea.innerHTML = `
    <div class="question-input-card">
      <textarea id="questionInput" class="question-input" placeholder="はい/いいえで答えられる質問を書いてください"></textarea>
      <div class="question-buttons">
        <button id="sendQuestionBtn" class="primary-btn" type="button">質問する</button>
        <button id="useGuessBtn" class="secondary-btn" type="button">回答する</button>
      </div>
    </div>`;
  $('sendQuestionBtn').addEventListener('click', async () => {
    const text = $('questionInput').value.trim();
    if (!text) { showToast('質問を入力してください'); return; }
    $('sendQuestionBtn').disabled = true;
    await submitPending(room.code, 'question', text);
  });
  $('useGuessBtn').addEventListener('click', async () => {
    const text = prompt('回答(真相はこうだと思う、という内容)を入力してください');
    if (!text || !text.trim()) return;
    await submitPending(room.code, 'guess', text.trim());
  });
}

// ------------------------------------------------------------------
// 終了画面
// ------------------------------------------------------------------
function renderEnded(room) {
  const role = myRole(room);
  const puzzle = PUZZLE_BY_ID.get(room.puzzleId);
  const isCorrect = room.result === 'correct';
  const isAborted = room.result === 'aborted';
  const resultClass = isAborted ? 'is-aborted' : (isCorrect ? 'is-correct' : 'is-incorrect');
  const resultMark = isAborted ? '🚪' : (isCorrect ? '🎉' : '😵');
  const resultTitle = isAborted ? '途中終了' : (isCorrect ? '正解！' : '終了');
  const logHtml = (room.log || []).map(logEntryLine).join('');
  app.innerHTML = `
    <section class="ended-view">
      <div class="result-card ${resultClass}">
        <div class="result-mark">${resultMark}</div>
        <h1>${resultTitle}</h1>
        <p class="puzzle-title-reveal">${escapeHtml(puzzle?.title || '')}</p>
        <div class="puzzle-block"><h3>問題</h3><p>${escapeHtml(puzzle?.question || '')}</p></div>
        <div class="puzzle-block answer-block"><h3>答え</h3><p>${escapeHtml(puzzle?.answer || '')}</p></div>
      </div>
      <div class="log-area">${logHtml}</div>
      <div id="swapArea" class="swap-area"></div>
      <button id="homeBtn" class="secondary-btn" type="button">ホームに戻る</button>
    </section>`;

  const swapArea = $('swapArea');
  if (role === 'host') {
    swapArea.innerHTML = `
      <p class="field-label">次のラウンド、親を交代しますか？</p>
      <div class="swap-buttons">
        <button id="swapYesBtn" class="primary-btn" type="button">交代する</button>
        <button id="swapNoBtn" class="secondary-btn" type="button">このまま続ける</button>
      </div>`;
    $('swapYesBtn').addEventListener('click', async () => {
      swapArea.querySelectorAll('button').forEach((b) => (b.disabled = true));
      await startNextRound(room.code, true);
    });
    $('swapNoBtn').addEventListener('click', async () => {
      swapArea.querySelectorAll('button').forEach((b) => (b.disabled = true));
      await startNextRound(room.code, false);
    });
  } else {
    swapArea.innerHTML = `<p class="hint-text">親が次のラウンドを準備しています…</p>`;
  }
  $('homeBtn').addEventListener('click', leaveRoom);
}

// ------------------------------------------------------------------
// 対戦終了時、この端末のローカル履歴(データタブ)に保存する
// ------------------------------------------------------------------
async function saveCompletedGameLocally(room) {
  const key = `${room.code}:${(room.log || []).length}:${room.result}`;
  if (state.savedEndedKey === key) return;
  state.savedEndedKey = key;
  const role = myRole(room);
  const puzzle = PUZZLE_BY_ID.get(room.puzzleId);
  await putGame({
    id: `${room.code}-${Date.now()}`,
    roomCode: room.code,
    role,
    puzzleTitle: puzzle?.title || '(不明な問題)',
    puzzleQuestion: puzzle?.question || '',
    puzzleAnswer: puzzle?.answer || '',
    result: room.result,
    log: room.log || [],
    endedAt: Date.now(),
  });
  if (state.tab === 'data') await refreshDataGames();
}

// ------------------------------------------------------------------
// データタブ
// ------------------------------------------------------------------
async function refreshDataGames() { state.dataGames = await listGames(); }

function formatDate(ts) {
  if (!ts) return '';
  return new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ts);
}

async function renderDataTab() {
  if (!state.dataGames.length) await refreshDataGames();
  const games = state.dataGames;
  app.innerHTML = `
    <section class="data-view">
      <div class="dictionary-head-card"><h1>対戦データ</h1><p>完了した対戦の記録です。タップで質問・回答の履歴を見られます。</p></div>
      <div id="gameList" class="game-list">${games.length ? '' : '<p class="hint-text">まだ記録がありません</p>'}</div>
    </section>`;
  const list = $('gameList');
  for (const game of games) {
    const row = document.createElement('div');
    row.className = 'game-row';
    const dotClass = game.result === 'aborted' ? 'is-aborted' : (game.result === 'correct' ? 'is-correct' : 'is-incorrect');
    row.innerHTML = `
      <button class="game-row-head" type="button">
        <span class="game-result-dot ${dotClass}"></span>
        <span class="game-topic">${escapeHtml(game.puzzleTitle)}</span>
        <span class="game-role">${game.role === 'host' ? '親' : '子'}</span>
        <span class="game-date">${formatDate(game.endedAt)}</span>
      </button>
      <div class="game-row-body" hidden></div>`;
    const head = row.querySelector('.game-row-head');
    const body = row.querySelector('.game-row-body');
    head.addEventListener('click', () => {
      const open = !body.hidden;
      body.hidden = open;
      if (!open && !body.dataset.filled) {
        body.dataset.filled = '1';
        body.innerHTML =
          `<div class="puzzle-block"><h3>問題</h3><p>${escapeHtml(game.puzzleQuestion)}</p></div>` +
          `<div class="puzzle-block answer-block"><h3>答え</h3><p>${escapeHtml(game.puzzleAnswer)}</p></div>` +
          (game.log || []).map(logEntryLine).join('') +
          `<button class="delete-game-btn" type="button">この記録を削除</button>`;
        body.querySelector('.delete-game-btn').addEventListener('click', async () => {
          await deleteGame(game.id);
          await refreshDataGames();
          render();
        });
      }
    });
    list.append(row);
  }
}

// ------------------------------------------------------------------
// 起動
// ------------------------------------------------------------------
async function init() {
  for (const btn of bottomTabbar.querySelectorAll('button')) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }
  $('chatBar').addEventListener('click', openChatPanel);
  $('chatCloseBtn').addEventListener('click', closeChatPanel);
  $('chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.room) return;
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const role = myRole(state.room);
    try {
      await sendChatMessage(state.room.code, role, text);
    } catch (error) {
      showToast('送信に失敗しました');
    }
  });
  const active = loadActiveRoom();
  if (active?.code) enterRoom(active.code);
  else render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('SW registration failed', error));
  }
}

init().catch((error) => {
  console.error(error);
  alert('アプリを起動できませんでした。ブラウザを再読み込みしてください。');
});
