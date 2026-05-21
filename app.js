// 量子糾纏 — IOU app
// Firestore real-time + local fallback when not configured

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  addDoc,
  updateDoc,
  doc,
  onSnapshot,
  query,
  orderBy,
  limit,
  serverTimestamp,
  writeBatch,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

const PEOPLE = ["Charlie", "偉賢", "Eric"];
const LS_ME = "qe.me";
const LS_LOCAL_ENTRIES = "qe.local.entries";
const LS_LOCAL_SETTLEMENTS = "qe.local.settlements";

const FIREBASE_READY =
  firebaseConfig &&
  firebaseConfig.apiKey &&
  firebaseConfig.apiKey !== "REPLACE_ME" &&
  firebaseConfig.projectId &&
  firebaseConfig.projectId !== "REPLACE_ME";

// ====================================================================
// Backend abstraction — Firestore when configured, localStorage fallback
// ====================================================================

function createFirestoreBackend() {
  const app = initializeApp(firebaseConfig);
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager(),
    }),
  });

  const entriesCol = collection(db, "entries");
  const settlementsCol = collection(db, "settlements");

  return {
    mode: "firestore",
    subscribeEntries(cb) {
      const q = query(entriesCol, orderBy("createdAt", "desc"), limit(500));
      return onSnapshot(
        q,
        (snap) => {
          const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          cb(items);
        },
        (err) => console.error("entries snapshot error:", err)
      );
    },
    subscribeSettlements(cb) {
      const q = query(settlementsCol, orderBy("settledAt", "desc"), limit(100));
      return onSnapshot(
        q,
        (snap) => {
          const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          cb(items);
        },
        (err) => console.error("settlements snapshot error:", err)
      );
    },
    async addEntry({ from, to, amount, note }) {
      return await addDoc(entriesCol, {
        from,
        to,
        amount,
        note: note || "",
        createdAt: serverTimestamp(),
        settled: false,
        settledAt: null,
        settledBatchId: null,
        deleted: false,
        deletedAt: null,
      });
    },
    async softDeleteEntry(id) {
      await updateDoc(doc(db, "entries", id), {
        deleted: true,
        deletedAt: serverTimestamp(),
      });
    },
    async settleAndArchive({ entryIds, balances, transactions, triggeredBy }) {
      const batch = writeBatch(db);
      const settlementRef = doc(settlementsCol);
      const batchId = settlementRef.id;
      const now = serverTimestamp();
      batch.set(settlementRef, {
        settledAt: now,
        triggeredBy,
        balancesBefore: balances,
        transactions,
        entryIds,
      });
      for (const eid of entryIds) {
        batch.update(doc(db, "entries", eid), {
          settled: true,
          settledAt: now,
          settledBatchId: batchId,
        });
      }
      await batch.commit();
    },
  };
}

function createLocalBackend() {
  const entryListeners = new Set();
  const settlementListeners = new Set();

  const readEntries = () => {
    try {
      return JSON.parse(localStorage.getItem(LS_LOCAL_ENTRIES) || "[]");
    } catch {
      return [];
    }
  };
  const writeEntries = (arr) => {
    localStorage.setItem(LS_LOCAL_ENTRIES, JSON.stringify(arr));
    entryListeners.forEach((cb) => cb(arr));
  };
  const readSettlements = () => {
    try {
      return JSON.parse(localStorage.getItem(LS_LOCAL_SETTLEMENTS) || "[]");
    } catch {
      return [];
    }
  };
  const writeSettlements = (arr) => {
    localStorage.setItem(LS_LOCAL_SETTLEMENTS, JSON.stringify(arr));
    settlementListeners.forEach((cb) => cb(arr));
  };

  return {
    mode: "local",
    subscribeEntries(cb) {
      entryListeners.add(cb);
      cb(readEntries());
      return () => entryListeners.delete(cb);
    },
    subscribeSettlements(cb) {
      settlementListeners.add(cb);
      cb(readSettlements());
      return () => settlementListeners.delete(cb);
    },
    async addEntry({ from, to, amount, note }) {
      const arr = readEntries();
      arr.unshift({
        id: "local-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
        from,
        to,
        amount,
        note: note || "",
        createdAt: { _ms: Date.now() },
        settled: false,
        settledAt: null,
        settledBatchId: null,
        deleted: false,
        deletedAt: null,
      });
      writeEntries(arr);
    },
    async softDeleteEntry(id) {
      const arr = readEntries().map((e) =>
        e.id === id ? { ...e, deleted: true, deletedAt: { _ms: Date.now() } } : e
      );
      writeEntries(arr);
    },
    async settleAndArchive({ entryIds, balances, transactions, triggeredBy }) {
      const now = { _ms: Date.now() };
      const batchId = "local-stl-" + Date.now();
      const entries = readEntries().map((e) =>
        entryIds.includes(e.id)
          ? { ...e, settled: true, settledAt: now, settledBatchId: batchId }
          : e
      );
      writeEntries(entries);
      const settlements = readSettlements();
      settlements.unshift({
        id: batchId,
        settledAt: now,
        triggeredBy,
        balancesBefore: balances,
        transactions,
        entryIds,
      });
      writeSettlements(settlements);
    },
  };
}

const backend = FIREBASE_READY ? createFirestoreBackend() : createLocalBackend();

// ====================================================================
// State
// ====================================================================

const state = {
  me: null,
  other: null,
  amount: 0,
  note: "",
  entries: [],
  settlements: [],
  view: "main",                 // "main" | "history"
  historyTab: "unsettled",      // "unsettled" | "settlements"
  pendingDeleteId: null,
};

// ====================================================================
// DOM helpers
// ====================================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showToast(msg, ms = 2200) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add("hidden"), ms);
}

function tsToMs(ts) {
  if (!ts) return 0;
  if (typeof ts === "number") return ts;
  if (ts._ms) return ts._ms;
  if (ts.toMillis) return ts.toMillis();
  if (ts.seconds) return ts.seconds * 1000;
  return 0;
}

function relTime(ms) {
  if (!ms) return "剛剛";
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.floor(diff / 1000);
  if (s < 5) return "剛剛";
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小時前`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} 天前`;
  const date = new Date(ms);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function fullTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ====================================================================
// Settlement algorithm (minimum cash flow)
// ====================================================================

// Pair-net 結算：對每對兩個人單獨算淨額，照原始債務方向轉
// 例：Charlie 欠偉賢 100、偉賢欠 Charlie 30 → Charlie 付偉賢 70
//     Charlie 欠 Eric 50、Eric 不欠 Charlie → Charlie 付 Eric 50
//     共兩筆轉帳，方向跟記帳的方向一致
function computeSettlement(entries) {
  const active = entries.filter((e) => !e.deleted && !e.settled);

  // per-person 淨額（顯示用）
  const balance = Object.fromEntries(PEOPLE.map((p) => [p, 0]));
  for (const e of active) {
    balance[e.from] -= e.amount;
    balance[e.to] += e.amount;
  }

  // pair sums (有方向)
  const pairSums = {};
  for (const e of active) {
    const k = `${e.from}|${e.to}`;
    pairSums[k] = (pairSums[k] || 0) + e.amount;
  }

  // 對每組無序 pair 算淨額
  const txs = [];
  for (let i = 0; i < PEOPLE.length; i++) {
    for (let j = i + 1; j < PEOPLE.length; j++) {
      const a = PEOPLE[i];
      const b = PEOPLE[j];
      const aToB = pairSums[`${a}|${b}`] || 0;
      const bToA = pairSums[`${b}|${a}`] || 0;
      const net = aToB - bToA;
      if (net > 0) txs.push({ from: a, to: b, amount: net });
      else if (net < 0) txs.push({ from: b, to: a, amount: -net });
    }
  }

  return {
    balances: balance,
    transactions: txs,
    entryIds: active.map((e) => e.id),
    activeCount: active.length,
    totalAmount: active.reduce((s, e) => s + e.amount, 0),
  };
}

// ====================================================================
// Rendering
// ====================================================================

function render() {
  renderPickers();
  renderAmount();
  renderSubmit();
  renderEntries();
  renderSettleBar();
  renderHistoryEntries();
  renderHistory();
  renderViewToggle();
  renderHistoryTabs();
}

function renderPickers() {
  // Row 1: 我是誰
  $$('[data-target="me"] .person-btn').forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.person === state.me);
  });
  // Row 3: 我欠誰 (disable self)
  $$('[data-target="other"] .person-btn').forEach((btn) => {
    const p = btn.dataset.person;
    btn.classList.toggle("disabled", p === state.me);
    btn.disabled = p === state.me;
    btn.classList.toggle("active", p === state.other);
  });
}

function renderAmount() {
  const el = $("#amountValue");
  el.textContent = state.amount.toLocaleString("en-US");
  el.classList.toggle("zero", state.amount === 0);
}

function renderSubmit() {
  const valid =
    state.me &&
    state.other &&
    state.me !== state.other &&
    state.amount > 0;
  $("#submitBtn").disabled = !valid;
}

function renderEntries() {
  const active = state.entries.filter((e) => !e.deleted && !e.settled);
  $("#entryCount").textContent = active.length;
  fillEntryList($("#entriesList"), $("#entriesEmpty"), active);
}

function renderHistoryEntries() {
  const active = state.entries.filter((e) => !e.deleted && !e.settled);
  $("#histUnsettledCount").textContent = active.length;
  fillEntryList($("#historyEntriesList"), $("#historyEntriesEmpty"), active);
}

function fillEntryList(listEl, emptyEl, entries) {
  if (!listEl) return;
  listEl.innerHTML = "";
  if (entries.length === 0) {
    emptyEl?.classList.remove("hidden");
    return;
  }
  emptyEl?.classList.add("hidden");
  for (const e of entries) {
    listEl.append(buildEntryEl(e));
  }
}

function buildEntryEl(e) {
  const li = document.createElement("li");
  li.className = "entry entry-card";
  li.dataset.id = e.id;

  const flow = document.createElement("div");
  flow.className = "entry-flow";
  const from = document.createElement("span");
  from.className = "entry-person";
  from.dataset.person = e.from;
  from.textContent = e.from;
  const arrow = document.createElement("span");
  arrow.className = "entry-arrow";
  arrow.textContent = "→";
  const to = document.createElement("span");
  to.className = "entry-person";
  to.dataset.person = e.to;
  to.textContent = e.to;
  flow.append(from, arrow, to);

  const meta = document.createElement("div");
  meta.className = "entry-meta";
  const amount = document.createElement("span");
  amount.className = "entry-amount";
  amount.textContent = "$" + e.amount.toLocaleString("en-US");
  const sub = document.createElement("span");
  sub.className = "entry-sub";
  sub.textContent = relTime(tsToMs(e.createdAt));
  sub.title = fullTime(tsToMs(e.createdAt));
  meta.append(amount, sub);

  const top = document.createElement("div");
  top.style.display = "flex";
  top.style.justifyContent = "space-between";
  top.style.alignItems = "center";
  top.style.gap = "10px";
  top.style.width = "100%";
  top.append(flow, meta);
  li.append(top);

  if (e.note) {
    const noteEl = document.createElement("div");
    noteEl.className = "entry-note";
    noteEl.textContent = "“" + e.note + "”";
    li.append(noteEl);
  }

  attachLongPress(li, e.id, e);
  return li;
}

function renderSettleBar() {
  const meta = $("#settleMeta");
  const btn = $("#settleBtn");
  const r = computeSettlement(state.entries);
  if (r.activeCount === 0) {
    meta.textContent = "";
    btn.disabled = true;
  } else {
    meta.textContent = `${r.activeCount} 筆 / $${r.totalAmount.toLocaleString("en-US")}`;
    btn.disabled = false;
  }
}

function renderHistory() {
  const list = $("#settlementsList");
  const empty = $("#settlementsEmpty");
  list.innerHTML = "";
  if (state.settlements.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  for (const s of state.settlements) {
    const li = document.createElement("li");
    li.className = "settlement-card";

    const head = document.createElement("div");
    head.className = "settlement-head";
    const time = document.createElement("span");
    time.className = "settlement-time";
    time.textContent = fullTime(tsToMs(s.settledAt));
    const by = document.createElement("span");
    by.className = "settlement-by";
    by.textContent = `${s.triggeredBy || "?"} 結帳 · 共 ${s.entryIds?.length || 0} 筆`;
    head.append(time, by);
    li.append(head);

    if (!s.transactions || s.transactions.length === 0) {
      const e = document.createElement("div");
      e.className = "settlement-empty-txs";
      e.textContent = "（淨額為 0，不需轉帳）";
      li.append(e);
    } else {
      for (const tx of s.transactions) {
        const row = document.createElement("div");
        row.className = "settlement-tx";
        const left = document.createElement("span");
        left.innerHTML = `<b style="color: var(--c-${
          tx.from === "Charlie" ? "charlie" : tx.from === "偉賢" ? "weixian" : "eric"
        })">${tx.from}</b> → <b style="color: var(--c-${
          tx.to === "Charlie" ? "charlie" : tx.to === "偉賢" ? "weixian" : "eric"
        })">${tx.to}</b>`;
        const right = document.createElement("span");
        right.style.fontWeight = "700";
        right.style.fontVariantNumeric = "tabular-nums";
        right.textContent = "$" + tx.amount.toLocaleString("en-US");
        row.append(left, right);
        li.append(row);
      }
    }

    list.append(li);
  }
}

function renderViewToggle() {
  $("#mainView").classList.toggle("hidden", state.view !== "main");
  $("#historyView").classList.toggle("hidden", state.view !== "history");
  $("#bottomBar").classList.toggle("hidden", state.view !== "main");
  $("#historyToggle").classList.toggle("active", state.view === "history");
}

function renderHistoryTabs() {
  $$("#historyTabs .tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === state.historyTab);
  });
  $("#tabUnsettled").classList.toggle("hidden", state.historyTab !== "unsettled");
  $("#tabSettlements").classList.toggle("hidden", state.historyTab !== "settlements");
}

// ====================================================================
// Long-press for delete
// ====================================================================

function attachLongPress(el, id, entry) {
  let timer = null;
  let startXY = null;

  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    el.classList.remove("deleting");
  };

  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    startXY = { x: e.clientX, y: e.clientY };
    el.classList.add("deleting");
    timer = setTimeout(() => {
      el.classList.remove("deleting");
      timer = null;
      if (navigator.vibrate) navigator.vibrate(40);
      openDeleteModal(id, entry);
    }, 550);
  });
  el.addEventListener("pointerup", cancel);
  el.addEventListener("pointercancel", cancel);
  el.addEventListener("pointerleave", cancel);
  el.addEventListener("pointermove", (e) => {
    if (!startXY) return;
    const dx = e.clientX - startXY.x;
    const dy = e.clientY - startXY.y;
    if (Math.hypot(dx, dy) > 10) cancel();
  });
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openDeleteModal(id, entry);
  });
}

// ====================================================================
// Modals
// ====================================================================

function openSettleModal() {
  const r = computeSettlement(state.entries);
  if (r.activeCount === 0) {
    showToast("沒有東西可以結算");
    return;
  }
  if (!state.me) {
    showToast("請先選你是誰");
    return;
  }

  $("#settleSub").textContent = `共 ${r.activeCount} 筆糾纏、$${r.totalAmount.toLocaleString("en-US")}`;

  // balances
  const balUl = $("#settleBalances");
  balUl.innerHTML = "";
  for (const p of PEOPLE) {
    const v = r.balances[p] || 0;
    const row = document.createElement("li");
    row.className = "balance-row";
    const name = document.createElement("span");
    name.className = "balance-name";
    name.dataset.person = p;
    name.textContent = p;
    const val = document.createElement("span");
    val.className = "balance-value " + (v > 0 ? "positive" : v < 0 ? "negative" : "zero");
    val.textContent = (v > 0 ? "+$" : v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US");
    row.append(name, val);
    balUl.append(row);
  }

  // transactions
  const txUl = $("#settleTxs");
  txUl.innerHTML = "";
  if (r.transactions.length === 0) {
    const e = document.createElement("div");
    e.className = "tx-empty";
    e.textContent = "✨ 淨額剛好為 0、不需要轉帳";
    txUl.append(e);
  } else {
    for (const tx of r.transactions) {
      const row = document.createElement("li");
      row.className = "tx-row";
      const flow = document.createElement("div");
      flow.className = "tx-flow";
      const from = document.createElement("span");
      from.className = "entry-person";
      from.dataset.person = tx.from;
      from.textContent = tx.from;
      const arrow = document.createElement("span");
      arrow.className = "arrow";
      arrow.textContent = "→";
      const to = document.createElement("span");
      to.className = "entry-person";
      to.dataset.person = tx.to;
      to.textContent = tx.to;
      flow.append(from, arrow, to);
      const amount = document.createElement("span");
      amount.className = "tx-amount";
      amount.textContent = "$" + tx.amount.toLocaleString("en-US");
      row.append(flow, amount);
      txUl.append(row);
    }
  }

  $("#settleModal").classList.remove("hidden");
  $("#settleModal")._snapshot = r; // stash for confirm
}

function closeSettleModal() {
  $("#settleModal").classList.add("hidden");
}

async function confirmSettle() {
  const modal = $("#settleModal");
  const r = modal._snapshot;
  if (!r) return;
  try {
    await backend.settleAndArchive({
      entryIds: r.entryIds,
      balances: r.balances,
      transactions: r.transactions,
      triggeredBy: state.me,
    });
    closeSettleModal();
    showToast("結帳完成、已封存");
  } catch (err) {
    console.error(err);
    showToast("結帳失敗：" + (err.message || err));
  }
}

function openDeleteModal(id, entry) {
  state.pendingDeleteId = id;
  $("#deletePreview").textContent = `${entry.from} → ${entry.to}　$${entry.amount.toLocaleString("en-US")}${entry.note ? "（" + entry.note + "）" : ""}`;
  $("#deleteModal").classList.remove("hidden");
}
function closeDeleteModal() {
  state.pendingDeleteId = null;
  $("#deleteModal").classList.add("hidden");
}
async function confirmDelete() {
  const id = state.pendingDeleteId;
  closeDeleteModal();
  if (!id) return;
  try {
    await backend.softDeleteEntry(id);
    showToast("已刪除");
  } catch (err) {
    console.error(err);
    showToast("刪除失敗");
  }
}

// ====================================================================
// Actions
// ====================================================================

function selectMe(person) {
  if (state.me === person) {
    state.me = null;
  } else {
    state.me = person;
  }
  if (state.other === state.me) state.other = null;
  if (state.me) localStorage.setItem(LS_ME, state.me);
  else localStorage.removeItem(LS_ME);
  render();
}

function selectOther(person) {
  if (person === state.me) return;
  state.other = state.other === person ? null : person;
  render();
}

function pressKey(key) {
  if (key === "back") {
    state.amount = Math.floor(state.amount / 10);
  } else if (key === "clear") {
    state.amount = 0;
  } else {
    const digit = Number(key);
    if (Number.isNaN(digit)) return;
    const next = state.amount * 10 + digit;
    if (next > 9999999) return;
    state.amount = next;
  }
  renderAmount();
  renderSubmit();
  renderSettleBar();
}

async function submitEntry() {
  const note = ($("#noteInput").value || "").trim();
  if (!state.me || !state.other || state.amount <= 0) return;
  if (state.me === state.other) return;

  const payload = {
    from: state.me,
    to: state.other,
    amount: state.amount,
    note,
  };
  try {
    await backend.addEntry(payload);
    // reset amount + other + note, keep me
    state.amount = 0;
    state.other = null;
    $("#noteInput").value = "";
    state.note = "";
    render();
    showToast(`已記下：${payload.from} → ${payload.to} $${payload.amount.toLocaleString("en-US")}`);
  } catch (err) {
    console.error(err);
    showToast("寫入失敗：" + (err.message || err));
  }
}

function toggleView() {
  state.view = state.view === "main" ? "history" : "main";
  render();
}

// ====================================================================
// Bind UI
// ====================================================================

function bindUI() {
  // person pickers
  $$('[data-target="me"] .person-btn').forEach((btn) => {
    btn.addEventListener("click", () => selectMe(btn.dataset.person));
  });
  $$('[data-target="other"] .person-btn').forEach((btn) => {
    btn.addEventListener("click", () => selectOther(btn.dataset.person));
  });

  // keypad
  $$("#keypad .key").forEach((btn) => {
    btn.addEventListener("click", () => pressKey(btn.dataset.key));
  });

  // submit
  $("#submitBtn").addEventListener("click", submitEntry);

  // settle
  $("#settleBtn").addEventListener("click", openSettleModal);
  $("#settleCancel").addEventListener("click", closeSettleModal);
  $("#settleConfirm").addEventListener("click", confirmSettle);

  // delete
  $("#deleteCancel").addEventListener("click", closeDeleteModal);
  $("#deleteConfirm").addEventListener("click", confirmDelete);

  // history toggle
  $("#historyToggle").addEventListener("click", toggleView);

  // history tabs
  $$("#historyTabs .tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.historyTab = btn.dataset.tab;
      renderHistoryTabs();
    });
  });

  // tap outside modal to close
  $("#settleModal").addEventListener("click", (e) => {
    if (e.target.id === "settleModal") closeSettleModal();
  });
  $("#deleteModal").addEventListener("click", (e) => {
    if (e.target.id === "deleteModal") closeDeleteModal();
  });

  // online status
  const updateOnline = () => {
    const online = navigator.onLine;
    $("#connStatus").classList.toggle("offline", !online);
    $("#connStatus").title = online ? "online" : "offline";
  };
  window.addEventListener("online", updateOnline);
  window.addEventListener("offline", updateOnline);
  updateOnline();

  // prevent pinch zoom on double tap
  document.addEventListener("dblclick", (e) => e.preventDefault());
}

// ====================================================================
// Service worker
// ====================================================================

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("SW registration failed:", err);
    });
  });
}

// ====================================================================
// Init
// ====================================================================

function init() {
  bindUI();

  const stored = localStorage.getItem(LS_ME);
  if (stored && PEOPLE.includes(stored)) state.me = stored;

  if (backend.mode === "local") {
    showToast("Demo 模式：請先設定 firebase-config.js", 3500);
  }

  backend.subscribeEntries((items) => {
    state.entries = items;
    renderEntries();
    renderHistoryEntries();
    renderSettleBar();
  });
  backend.subscribeSettlements((items) => {
    state.settlements = items;
    renderHistory();
  });

  render();
}

init();

// expose for debugging in console
window.__qe = { state, computeSettlement, backend };
