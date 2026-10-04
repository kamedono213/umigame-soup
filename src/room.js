// Firestoreとのやり取りをこのファイルにまとめる(アキネーターバトルのsrc/room.js
// と同じ考え方)。ログインは使わないためfirebase-authは読み込まない。
//
// アキネーターバトルとの大きな違い: お題(答え)はホストが自由記入するのではなく、
// 両クライアントに同梱された静的データ(puzzles.js)から選ぶ。そのため「答えは
// ホストの端末にしか存在しない」という前提が成り立たず、answerの秘匿は
// あくまで画面上の表示を控える、という運用上の約束に過ぎない。この結果、
// ゲーム終了の確定処理をホスト側だけに限定する必要がなく、アキネーター
// バトルにあった「ホストだけが確定できる」ための反応的な仕組みは不要になり、
// シンプルになっている。
import { firebaseConfig } from './firebase-config.js';

const SDK_VERSION = '10.14.1';
const CDN_BASE = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;

const [{ initializeApp }, firestoreSdk] = await Promise.all([
  import(`${CDN_BASE}/firebase-app.js`),
  import(`${CDN_BASE}/firebase-firestore.js`),
]);

const {
  initializeFirestore,
  doc,
  getDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp,
  runTransaction,
  arrayUnion,
} = firestoreSdk;

const app = initializeApp(firebaseConfig);
const dbFs = initializeFirestore(app, {});

const ROOMS = 'rooms';

function getClientId() {
  const key = 'umigame-soup:clientId';
  let id = localStorage.getItem(key);
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(key, id);
  }
  return id;
}

function randomCode() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

function freshRoundFields() {
  return {
    phase: 'selecting_puzzle',
    puzzleId: null,
    log: [],
    pending: null,
    result: null,
    endRequest: null,
    chat: [],
    startedAt: serverTimestamp(),
    endedAt: null,
  };
}

// バトル中にチャットできる自由会話欄。質問ログ(log)とは別枠で、ラウンドが
// 変わる(startNextRound)たびにリセットされる。
export async function sendChatMessage(code, from, text) {
  await updateDoc(doc(dbFs, ROOMS, code), {
    chat: arrayUnion({ from, text, ts: Date.now() }),
  });
}

export async function createRoom() {
  const hostId = getClientId();
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = randomCode();
    const ref = doc(dbFs, ROOMS, code);
    const created = await runTransaction(dbFs, async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists()) return false;
      tx.set(ref, {
        code,
        createdAt: serverTimestamp(),
        hostId,
        guestId: null,
        ...freshRoundFields(),
        phase: 'waiting_guest',
      });
      return true;
    });
    if (created) return { code, hostId };
  }
  throw new Error('部屋コードの発行に失敗しました。もう一度お試しください。');
}

export async function joinRoom(code) {
  const guestId = getClientId();
  const ref = doc(dbFs, ROOMS, code);
  const result = await runTransaction(dbFs, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('その部屋コードは見つかりませんでした。');
    const data = snap.data();
    if (data.hostId === guestId) return data; // 自分が作った部屋への再入室
    if (data.guestId && data.guestId !== guestId) throw new Error('その部屋はすでに満員です。');
    tx.update(ref, { guestId, phase: 'selecting_puzzle' });
    return { ...data, guestId, phase: 'selecting_puzzle' };
  });
  return { code, ...result };
}

export function subscribeToRoom(code, callback) {
  const ref = doc(dbFs, ROOMS, code);
  return onSnapshot(ref, (snap) => {
    if (!snap.exists()) { callback(null); return; }
    callback({ code, ...snap.data() });
  }, (error) => {
    console.error('[room] subscribe error', error);
  });
}

export async function getRoomOnce(code) {
  const snap = await getDoc(doc(dbFs, ROOMS, code));
  return snap.exists() ? { code, ...snap.data() } : null;
}

// ホストが問題を選んで出題開始。
export async function selectPuzzle(code, puzzleId) {
  await updateDoc(doc(dbFs, ROOMS, code), { puzzleId, phase: 'playing' });
}

// 子が質問、または回答を送信する(質問数は無制限なので、いつでも何度でも送れる)。
export async function submitPending(code, type, text) {
  const ref = doc(dbFs, ROOMS, code);
  await runTransaction(dbFs, async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    const n = (data.log || []).length + 1;
    tx.update(ref, { pending: { type, text, n } });
  });
}

// 親が質問に回答する。5択、または自由回答(answerにそのままテキストが入る)。
export async function answerQuestion(code, pendingEntry, answer) {
  const ref = doc(dbFs, ROOMS, code);
  await runTransaction(dbFs, async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    const log = [...(data.log || []), { ...pendingEntry, answer }];
    tx.update(ref, { log, pending: null });
  });
}

// 親が子の回答(当て)を正誤判定する。正解ならそこで終了。
export async function judgeGuess(code, pendingEntry, correct) {
  const ref = doc(dbFs, ROOMS, code);
  await runTransaction(dbFs, async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    const log = [...(data.log || []), { ...pendingEntry, correct }];
    if (correct) {
      tx.update(ref, { log, pending: null, phase: 'ended', result: 'correct', endedAt: serverTimestamp() });
    } else {
      tx.update(ref, { log, pending: null });
    }
  });
}

// 途中終了。答えは両端末とも静的データから参照できるため、
// アキネーターバトルと違って承認した側がそのまま確定できる。
export async function requestEndGame(code, by) {
  await updateDoc(doc(dbFs, ROOMS, code), { endRequest: { by, approved: false } });
}

export async function cancelEndRequest(code) {
  await updateDoc(doc(dbFs, ROOMS, code), { endRequest: null });
}

export async function approveEndGame(code) {
  await updateDoc(doc(dbFs, ROOMS, code), {
    endRequest: null, phase: 'ended', result: 'aborted', endedAt: serverTimestamp(),
  });
}

// ホストが対局後に親交代するかどうかを決める。部屋コードは使い回す。
export async function startNextRound(code, swapHost) {
  const ref = doc(dbFs, ROOMS, code);
  await runTransaction(dbFs, async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    const nextHostId = swapHost ? data.guestId : data.hostId;
    const nextGuestId = swapHost ? data.hostId : data.guestId;
    tx.update(ref, {
      hostId: nextHostId,
      guestId: nextGuestId,
      ...freshRoundFields(),
    });
  });
}

export { getClientId };
