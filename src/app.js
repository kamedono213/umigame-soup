import {
  createRoom, joinRoom, subscribeToRoom, selectPuzzle,
  submitPending, answerQuestion, judgeGuess,
  requestEndGame, cancelEndRequest, approveEndGame, startNextRound,
  sendChatMessage, sendEmote,
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
const EMOTE_OPTIONS = ['😂', '😮', '👍', '😢', '🔥', '❤️'];
const CLICKER_STORE_KEY = 'umigame-soup:clickerState';

// ------------------------------------------------------------------
// 効果音(Web Audioでその場合成、音声ファイルなし)。要所だけに絞って
// 鳴らす: 部屋の作成/参加、質問送信、回答、正誤判定、対戦終了、
// チャット受信、エモート、ミニゲームのタップ/購入。
// ------------------------------------------------------------------
let actx;
function tone(freq, dur, opts = {}) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = actx.currentTime + (opts.delay || 0);
    const osc = actx.createOscillator();
    const gain = actx.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.slideTo) osc.frequency.linearRampToValueAtTime(opts.slideTo, t0 + dur);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(opts.vol || 0.16, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(gain); gain.connect(actx.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  } catch (_) {}
}
const sfx = {
  tap: () => tone(480, 0.06, { type: 'sine', vol: 0.1 }),
  room: () => { tone(520, 0.1, { type: 'triangle' }); tone(780, 0.14, { type: 'triangle', delay: 0.08, vol: 0.12 }); },
  send: () => tone(640, 0.08, { type: 'sine', slideTo: 880, vol: 0.12 }),
  answer: () => tone(420, 0.09, { type: 'triangle', vol: 0.13 }),
  correct: () => { tone(560, 0.12, { type: 'triangle' }); tone(840, 0.18, { type: 'triangle', delay: 0.08, vol: 0.14 }); },
  incorrect: () => tone(220, 0.22, { type: 'sine', slideTo: 130, vol: 0.14 }),
  win: () => { tone(523, 0.16, { type: 'sine' }); tone(659, 0.16, { type: 'sine', delay: 0.14 }); tone(784, 0.26, { type: 'sine', delay: 0.28, vol: 0.14 }); },
  lose: () => tone(300, 0.5, { type: 'sine', slideTo: 110, vol: 0.14 }),
  chat: () => tone(700, 0.07, { type: 'sine', slideTo: 900, vol: 0.1 }),
  emote: () => { tone(900, 0.07, { type: 'triangle', vol: 0.12 }); tone(1200, 0.08, { type: 'triangle', delay: 0.05, vol: 0.09 }); },
  clickerTap: () => tone(1000, 0.045, { type: 'sine', vol: 0.07 }),
  purchase: () => { tone(660, 0.08, { type: 'triangle', vol: 0.13 }); tone(990, 0.12, { type: 'triangle', delay: 0.06, vol: 0.11 }); },
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
  lastSeenEmoteTs: 0, // ここまで再生済みのエモートのts(自分のエコー/入室前の古いエモートを再生しないためのガード)
  lastChatCount: 0, // チャット受信音を「新着かつ相手から」の時だけ鳴らすためのカウンタ
  // 待ち時間ミニゲーム。clickerはホーム画面用で端末に保存され継続する。
  // roomClickerは部屋に入っている間だけ使う使い捨てで、保存されない。
  clicker: { cookies: 0, clickPower: 1, owned: {}, upgrades: {} },
  roomClicker: { cookies: 0, clickPower: 1, owned: {}, upgrades: {} },
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
  updateSideGameVisibility();
}

// ミニゲームは部屋を作る前のホーム画面でも、部屋の中でも遊べる(ホーム=
// 継続保存、部屋の中=使い捨て、の違いはactiveClicker()側で吸収する)。
// チャットは相手がいないと意味がないので、こちらは従来通りupdateChatUi()
// 側でroom.guestId確定後だけ表示する。
function updateSideGameVisibility() {
  const visible = state.tab === 'battle';
  $('sideGame').hidden = !visible;
  document.body.classList.toggle('side-game-active', visible);
  if (!visible) $('sideGameShop').hidden = true;
  if (visible) updateSideGameDisplay();
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
    sfx.room();
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
    sfx.room();
    enterRoom(raw);
  } catch (error) {
    showToast(error.message || '参加に失敗しました');
  } finally {
    btn.disabled = false;
  }
}

// chat/lastEmoteだけが変わった更新ではrender()を呼ばない。render()は
// #app.innerHTMLを丸ごと作り直すため、相手からのチャット/エモートが届く
// たびに「質問を入力中」のtextareaなど未保存の入力値が消えてしまっていた。
// チャット自体はupdateChatUi()が#app外のchat-dockだけを更新するので、
// ゲーム進行に関係する項目が変わっていない限りrender()は不要。
// JSON.stringifyはオブジェクトのキー出現順をそのまま使うため、Firestoreの
// スナップショットがフィールド順を毎回同じ保証をしてくれない(同じデータでも
// 呼ぶたびに違う文字列になりうる)。再帰的にキーをソートしてから文字列化する。
function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function roomSignature(room) {
  const { chat, lastEmote, ...rest } = room;
  return stableStringify(rest);
}

function enterRoom(code) {
  state.code = code;
  saveActiveRoom(code);
  state.roomClicker = freshClickerState(); // 部屋に入るたびミニゲームはゼロから(ホーム側の進行には影響しない)
  state.lastSeenEmoteTs = 0; // 入室直後に古いエモートを再生しないよう、最初のスナップショットで現在値に合わせる
  state.lastChatCount = 0;
  let firstSnapshot = true;
  let prevSignature = null;
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
    const sig = roomSignature(room);
    if (sig !== prevSignature) render();
    prevSignature = sig;
    updateChatUi(room);
    if (firstSnapshot) {
      state.lastSeenEmoteTs = room.lastEmote?.ts || 0;
      firstSnapshot = false;
    } else {
      maybePlayIncomingEmote(room);
    }
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
  updateChatUi(null);
}

// ------------------------------------------------------------------
// バトル中のチャット: 画面下1/3くらいに常時固定し、画面転換なしで打てる。
// 相手がいる部屋(guestId確定後)でだけ表示。質問ログとは別枠の自由会話。
// ------------------------------------------------------------------
function updateChatUi(room) {
  const inRoom = !!(room && room.guestId);
  document.body.classList.toggle('in-room', inRoom);
  $('chatDock').hidden = !inRoom;
  if (!inRoom) return;
  renderChatMessages(room);
}

function renderChatMessages(room) {
  const role = myRole(room);
  const chat = room.chat || [];
  const last = chat[chat.length - 1];
  if (chat.length > state.lastChatCount && last && last.from !== role) sfx.chat();
  state.lastChatCount = chat.length;
  const list = $('chatMessages');
  const wasNearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.innerHTML = chat.map((m) => `
    <div class="chat-msg ${m.from === role ? 'is-me' : 'is-them'}">${escapeHtml(m.text)}</div>
  `).join('') || '<p class="hint-text">まだメッセージがありません</p>';
  if (wasNearBottom) list.scrollTop = list.scrollHeight;
}

// ------------------------------------------------------------------
// エモート: 画面上にふわっと出て消える絵文字リアクション。相手にも見える。
// Firestoreには最新の1件(lastEmote)だけを持たせ、tsが変わるたびに
// その場に居合わせた両端末が再生する(蓄積しないトランジェント通知)。
// ------------------------------------------------------------------
function maybePlayIncomingEmote(room) {
  const emote = room.lastEmote;
  if (!emote || !emote.ts || emote.ts <= state.lastSeenEmoteTs) return;
  state.lastSeenEmoteTs = emote.ts;
  spawnFloatingEmote(emote.emoji);
  sfx.emote();
}

async function handleSendEmote(emoji) {
  if (!state.room) return;
  const role = myRole(state.room);
  const ts = Date.now();
  state.lastSeenEmoteTs = ts; // 自分の書き込みが戻ってきた時の二重再生を防ぐ
  spawnFloatingEmote(emoji); // 相手の応答を待たず、自分の画面にはすぐ出す
  sfx.emote();
  try {
    await sendEmote(state.room.code, role, emoji);
  } catch (error) {
    showToast('送信に失敗しました');
  }
}

function spawnFloatingEmote(emoji) {
  const layer = $('emoteLayer');
  const el = document.createElement('span');
  el.className = 'floating-emote';
  el.textContent = emoji;
  el.style.left = `${12 + Math.random() * 70}%`;
  layer.appendChild(el);
  setTimeout(() => el.remove(), 1700);
}

// ------------------------------------------------------------------
// 待ち時間の暇つぶしミニゲーム(貝殻拾いタップ)。チャット欄の上、質問回答欄の
// 下の空間に常駐。対戦には一切影響しない、端末ローカルだけのおまけ。
// タップで貝殻を集める→自動収集役(CpSに相当)を雇って放置収入を得る→
// タップ自体を強化する、の2方向で育てる。ショップは同じ固定エリアの上に
// 小さなパネルとして展開する(画面遷移はしない)。
// ------------------------------------------------------------------
const CLICKER_GENERATORS = [
  { key: 'g1', name: 'しんじゅがい', icon: '🦪', desc: '少しずつ貝殻を集めてくれる', baseCost: 15, cps: 0.1 },
  { key: 'g2', name: 'カニの助手', icon: '🦀', desc: '砂浜を歩き回って貝殻を拾う', baseCost: 100, cps: 1 },
  { key: 'g3', name: '小さな漁船', icon: '⛵', desc: '沖まで出て貝殻を集めてくる', baseCost: 1100, cps: 8 },
  { key: 'g4', name: '貝の島', icon: '🏝️', desc: '島ごと貝殻であふれる秘密の島', baseCost: 12000, cps: 47 },
  { key: 'g5', name: '海底探査艇', icon: '🤿', desc: '深い海底まで潜って貝殻を集める', baseCost: 130000, cps: 260 },
  { key: 'g6', name: '漁師村', icon: '🏘️', desc: '村中の漁師が貝殻集めに協力してくれる', baseCost: 1400000, cps: 1400 },
  { key: 'g7', name: '貿易船団', icon: '🚢', desc: '各地から貝殻を運んでくる船団', baseCost: 20000000, cps: 7800 },
  { key: 'g8', name: '深海調査船', icon: '🌊', desc: '誰も知らない深海から貝殻を引き上げる', baseCost: 330000000, cps: 44000 },
];
const CLICKER_UPGRADES = [
  { key: 'u1', name: 'するどい目', icon: '👀', desc: 'タップ1回の獲得量が増える', cost: 500, power: 1 },
  { key: 'u2', name: '海の知識', icon: '📖', desc: 'タップ1回の獲得量がさらに増える', cost: 5000, power: 3 },
  { key: 'u3', name: '潮の勘', icon: '🌙', desc: 'タップ1回の獲得量がぐっと増える', cost: 50000, power: 8 },
  { key: 'u4', name: 'ベテラン漁師の技', icon: '🎣', desc: 'タップ1回の獲得量が大きく増える', cost: 600000, power: 20 },
  { key: 'u5', name: '伝説の海図', icon: '🗺️', desc: 'タップ1回の獲得量が大幅に増える', cost: 7000000, power: 50 },
  { key: 'u6', name: '深海の加護', icon: '🔱', desc: 'タップ1回の獲得量が桁違いに増える', cost: 90000000, power: 130 },
];
// 施設ごとの生産効率を2倍にする、1回だけ買えるブースト。施設を育てるほど
// 「強化」ページでも買うものが増えていくようにするための3つ目のカテゴリ。
const CLICKER_BOOSTS = [
  { key: 'b1', name: 'しんじゅがいの養殖', icon: '📈', desc: 'しんじゅがいの生産効率が2倍になる', cost: 300, genKey: 'g1' },
  { key: 'b2', name: 'カニの訓練', icon: '📈', desc: 'カニの助手の生産効率が2倍になる', cost: 2000, genKey: 'g2' },
  { key: 'b3', name: '漁船の改良', icon: '📈', desc: '小さな漁船の生産効率が2倍になる', cost: 22000, genKey: 'g3' },
  { key: 'b4', name: '島の開発', icon: '📈', desc: '貝の島の生産効率が2倍になる', cost: 240000, genKey: 'g4' },
  { key: 'b5', name: '探査艇の強化', icon: '📈', desc: '海底探査艇の生産効率が2倍になる', cost: 2600000, genKey: 'g5' },
  { key: 'b6', name: '漁師村の増築', icon: '📈', desc: '漁師村の生産効率が2倍になる', cost: 28000000, genKey: 'g6' },
  { key: 'b7', name: '船団の増強', icon: '📈', desc: '貿易船団の生産効率が2倍になる', cost: 400000000, genKey: 'g7' },
  { key: 'b8', name: '深海との同調', icon: '📈', desc: '深海調査船の生産効率が2倍になる', cost: 6600000000, genKey: 'g8' },
];
const CLICKER_SHOP_PAGES = [
  { key: 'gen', label: '施設' },
  { key: 'tap', label: 'タップ強化' },
  { key: 'boost', label: '生産強化' },
];

// 部屋に入る前のホーム画面では、継続的に保存される永続クリッカー
// (state.clicker)を使う。部屋を作った/入った瞬間から、別の使い捨て
// クリッカー(state.roomClicker)に切り替わり、常にゼロから始まって
// 保存もされない(対戦が終わって部屋を出てもホーム側には一切引き継がれない)。
// activeClicker()はその時点で「今どちらを見せるべきか」を1箇所にまとめる。
function freshClickerState() { return { cookies: 0, clickPower: 1, owned: {}, upgrades: {}, boosts: {}, shopPage: 'gen' }; }
function activeClicker() { return state.room ? state.roomClicker : state.clicker; }
function isClickerPersistent() { return !state.room; }

function loadClickerState() {
  try {
    const raw = JSON.parse(localStorage.getItem(CLICKER_STORE_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      return {
        cookies: raw.cookies || 0, clickPower: raw.clickPower || 1, owned: raw.owned || {},
        upgrades: raw.upgrades || {}, boosts: raw.boosts || {}, shopPage: 'gen',
      };
    }
  } catch (_) {}
  return freshClickerState();
}
function saveClickerState() {
  if (!isClickerPersistent()) return; // 部屋の中の使い捨てクリッカーは保存しない
  try { localStorage.setItem(CLICKER_STORE_KEY, JSON.stringify(state.clicker)); } catch (_) {}
}
function clickerCost(gen, owned) {
  return Math.round(gen.baseCost * Math.pow(1.15, owned));
}
function clickerTotalCps() {
  const c = activeClicker();
  return CLICKER_GENERATORS.reduce((sum, g) => {
    const boost = CLICKER_BOOSTS.find((b) => b.genKey === g.key);
    const mult = boost && c.boosts[boost.key] ? 2 : 1;
    return sum + g.cps * (c.owned[g.key] || 0) * mult;
  }, 0);
}
function formatClickerNumber(v) {
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(Math.floor(v));
}

function updateSideGameDisplay() {
  const c = activeClicker();
  $('sideGameCount').textContent = formatClickerNumber(c.cookies);
  const cps = clickerTotalCps();
  $('sideGameCps').textContent = cps > 0 ? `+${cps >= 10 ? Math.round(cps) : cps.toFixed(1)}/秒` : '';
}

function handleSideGameTap() {
  const c = activeClicker();
  const gain = c.clickPower;
  c.cookies += gain;
  updateSideGameDisplay();
  saveClickerState();
  spawnFloatingPop('+' + gain);
  sfx.clickerTap();
  if (!$('sideGameShop').hidden) renderSideGameShop();
}

let clickerLoopHandle = null;
function startClickerLoop() {
  if (clickerLoopHandle) return;
  let last = performance.now();
  clickerLoopHandle = setInterval(() => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    const cps = clickerTotalCps();
    if (cps <= 0) return;
    activeClicker().cookies += cps * dt;
    if (!$('sideGame').hidden) updateSideGameDisplay();
    if (!$('sideGameShop').hidden) renderSideGameShop();
    saveClickerState();
  }, 500);
}

function switchClickerShopPage(pageKey) {
  activeClicker().shopPage = pageKey;
  renderSideGameShop();
}

function renderSideGameShop() {
  const c = activeClicker();
  if (!c.shopPage) c.shopPage = 'gen';
  const tabs = $('sideGameShopTabs');
  tabs.innerHTML = CLICKER_SHOP_PAGES.map((p) => `
    <button type="button" class="shop-page-tab${p.key === c.shopPage ? ' is-active' : ''}" data-page="${p.key}">${p.label}</button>
  `).join('');
  tabs.querySelectorAll('[data-page]').forEach((btn) => btn.addEventListener('click', () => switchClickerShopPage(btn.dataset.page)));

  const list = $('sideGameShopList');
  const parts = [];
  if (c.shopPage === 'gen') {
    for (const g of CLICKER_GENERATORS) {
      const owned = c.owned[g.key] || 0;
      const cost = clickerCost(g, owned);
      const afford = c.cookies >= cost;
      const boost = CLICKER_BOOSTS.find((b) => b.genKey === g.key);
      const boosted = boost && c.boosts[boost.key];
      parts.push(`
        <div class="shop-item${afford ? ' is-affordable' : ''}">
          <span class="shop-item-icon">${g.icon}</span>
          <div class="shop-item-body">
            <div class="shop-item-name">${escapeHtml(g.name)} <span class="shop-item-owned">×${owned}</span>${boosted ? ' <span class="shop-item-boosted">⚡×2</span>' : ''}</div>
            <div class="shop-item-desc">${escapeHtml(g.desc)}(${g.cps}/秒)</div>
          </div>
          <button type="button" class="shop-item-buy" data-gen="${g.key}"${afford ? '' : ' disabled'}>${formatClickerNumber(cost)}</button>
        </div>`);
    }
  } else if (c.shopPage === 'tap') {
    for (const u of CLICKER_UPGRADES) {
      const owned = !!c.upgrades[u.key];
      const afford = c.cookies >= u.cost;
      parts.push(`
        <div class="shop-item${owned ? ' is-maxed' : afford ? ' is-affordable' : ''}">
          <span class="shop-item-icon">${u.icon}</span>
          <div class="shop-item-body">
            <div class="shop-item-name">${escapeHtml(u.name)}</div>
            <div class="shop-item-desc">${escapeHtml(u.desc)}(タップ+${u.power})</div>
          </div>
          <button type="button" class="shop-item-buy" data-upg="${u.key}"${owned || !afford ? ' disabled' : ''}>${owned ? '購入済' : formatClickerNumber(u.cost)}</button>
        </div>`);
    }
  } else {
    for (const b of CLICKER_BOOSTS) {
      const owned = !!c.boosts[b.key];
      const afford = c.cookies >= b.cost;
      parts.push(`
        <div class="shop-item${owned ? ' is-maxed' : afford ? ' is-affordable' : ''}">
          <span class="shop-item-icon">${b.icon}</span>
          <div class="shop-item-body">
            <div class="shop-item-name">${escapeHtml(b.name)}</div>
            <div class="shop-item-desc">${escapeHtml(b.desc)}</div>
          </div>
          <button type="button" class="shop-item-buy" data-boost="${b.key}"${owned || !afford ? ' disabled' : ''}>${owned ? '購入済' : formatClickerNumber(b.cost)}</button>
        </div>`);
    }
  }
  list.innerHTML = parts.join('') || '<p class="hint-text">このページにはまだ何もありません</p>';
  list.querySelectorAll('[data-gen]').forEach((btn) => btn.addEventListener('click', () => buyGenerator(btn.dataset.gen)));
  list.querySelectorAll('[data-upg]').forEach((btn) => btn.addEventListener('click', () => buyClickerUpgrade(btn.dataset.upg)));
  list.querySelectorAll('[data-boost]').forEach((btn) => btn.addEventListener('click', () => buyClickerBoost(btn.dataset.boost)));
}

function buyGenerator(key) {
  const c = activeClicker();
  const g = CLICKER_GENERATORS.find((x) => x.key === key);
  const owned = c.owned[key] || 0;
  const cost = clickerCost(g, owned);
  if (c.cookies < cost) return;
  c.cookies -= cost;
  c.owned[key] = owned + 1;
  saveClickerState();
  updateSideGameDisplay();
  sfx.purchase();
  renderSideGameShop();
}
function buyClickerUpgrade(key) {
  const c = activeClicker();
  const u = CLICKER_UPGRADES.find((x) => x.key === key);
  if (c.upgrades[key] || c.cookies < u.cost) return;
  c.cookies -= u.cost;
  c.upgrades[key] = true;
  c.clickPower += u.power;
  saveClickerState();
  updateSideGameDisplay();
  sfx.purchase();
  renderSideGameShop();
}
function buyClickerBoost(key) {
  const c = activeClicker();
  const b = CLICKER_BOOSTS.find((x) => x.key === key);
  if (c.boosts[key] || c.cookies < b.cost) return;
  c.cookies -= b.cost;
  c.boosts[key] = true;
  saveClickerState();
  sfx.purchase();
  updateSideGameDisplay();
  renderSideGameShop();
}

function openSideGameShop() {
  renderSideGameShop();
  $('sideGameShop').hidden = false;
}
function closeSideGameShop() {
  $('sideGameShop').hidden = true;
}

function spawnFloatingPop(text) {
  const layer = $('emoteLayer');
  const el = document.createElement('span');
  el.className = 'floating-pop';
  el.textContent = text;
  el.style.left = '50%';
  layer.appendChild(el);
  setTimeout(() => el.remove(), 900);
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
      sfx.room();
      await selectPuzzle(room.code, p.id);
    });
    return;
  }

  const list = filteredPuzzles();
  app.innerHTML = `
    ${roundTopbarHtml(room)}
    <section class="puzzle-select">
      <h2>問題を選んでください</h2>
      <div class="tag-filter-head">
        <p class="field-label">タグで絞り込み(よく使う順)</p>
        ${state.selectedTags.size ? `<button id="tagClearBtn" type="button" class="tag-filter-clear">クリア</button>` : ''}
      </div>
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
  $('tagClearBtn')?.addEventListener('click', () => { state.selectedTags.clear(); render(); });

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
        sfx.answer();
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
        sfx.answer();
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
      sfx.correct();
      await judgeGuess(room.code, p, true);
    });
    $('judgeIncorrectBtn').addEventListener('click', async () => {
      actionArea.querySelectorAll('button').forEach((b) => (b.disabled = true));
      sfx.incorrect();
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
    sfx.send();
    await submitPending(room.code, 'question', text);
  });
  $('useGuessBtn').addEventListener('click', async () => {
    const text = prompt('回答(真相はこうだと思う、という内容)を入力してください');
    if (!text || !text.trim()) return;
    sfx.send();
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
  if (!isAborted) { if (isCorrect) sfx.win(); else sfx.lose(); }
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
  const emotePicker = $('emotePicker');
  emotePicker.innerHTML = EMOTE_OPTIONS.map((e) => `<button type="button" class="emote-btn">${e}</button>`).join('');
  emotePicker.querySelectorAll('.emote-btn').forEach((btn, i) => {
    btn.addEventListener('click', () => handleSendEmote(EMOTE_OPTIONS[i]));
  });
  state.clicker = loadClickerState();
  updateSideGameVisibility();
  startClickerLoop();
  $('sideGameBtn').addEventListener('click', handleSideGameTap);
  $('sideGameShopBtn').addEventListener('click', openSideGameShop);
  $('sideGameShopClose').addEventListener('click', closeSideGameShop);
  window.addEventListener('beforeunload', saveClickerState);
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
