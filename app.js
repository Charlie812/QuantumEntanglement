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
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

const PEOPLE = ["Charlie", "偉賢", "Eric"];
const PERSON_CLASS = { Charlie: "charlie", "偉賢": "weixian", Eric: "eric" };
const ORB_POSITIONS = {
  Charlie: { x: 180, y: 78 },
  "偉賢":   { x: 70,  y: 282 },
  Eric:    { x: 290, y: 282 },
};
const SVG_NS = "http://www.w3.org/2000/svg";
const LS_LOCAL_ENTRIES = "qe.local.entries";
const LS_LOCAL_SETTLEMENTS = "qe.local.settlements";
const LS_FAB_POS = "qe.fab.pos";

const WIPE_PASSWORD = "cathaybk5566";

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
    async wipeAll() {
      const [entriesSnap, settlementsSnap] = await Promise.all([
        getDocs(entriesCol),
        getDocs(settlementsCol),
      ]);
      const allDocs = [...entriesSnap.docs, ...settlementsSnap.docs];
      let count = 0;
      // Firestore batch limit: 500 operations
      while (allDocs.length > 0) {
        const slice = allDocs.splice(0, 450);
        const batch = writeBatch(db);
        for (const d of slice) batch.delete(d.ref);
        await batch.commit();
        count += slice.length;
      }
      return count;
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
    async wipeAll() {
      const count = readEntries().length + readSettlements().length;
      writeEntries([]);
      writeSettlements([]);
      return count;
    },
  };
}

const backend = FIREBASE_READY ? createFirestoreBackend() : createLocalBackend();

// ====================================================================
// State
// ====================================================================

const state = {
  from: null,                   // 欠錢的人（債務人）
  to: null,                     // 被欠的人（債權人）
  expression: "",               // raw input string e.g. "100+50×3" — evaluated at submit
  note: "",
  entries: [],
  settlements: [],
  view: "main",                 // "main" | "history"
  historyTab: "unsettled",      // "unsettled" | "deleted" | "settlements"
  pendingDeleteId: null,
};

// ====================================================================
// Safe expression evaluator — only digits + - × ÷ (no parens)
// Returns rounded integer; throws if invalid.
// ====================================================================
function evalExpression(raw) {
  if (!raw) throw new Error("empty");
  // Tokenize
  const tokens = [];
  let num = "";
  for (const ch of raw) {
    if (/\d/.test(ch)) {
      num += ch;
    } else if ("+-−*×/÷".includes(ch)) {
      if (!num) throw new Error("bad");
      tokens.push(parseInt(num, 10));
      tokens.push(ch === "×" || ch === "*" ? "*" : ch === "÷" || ch === "/" ? "/" : ch === "−" ? "-" : ch);
      num = "";
    } else {
      throw new Error("bad");
    }
  }
  if (!num) throw new Error("trailing op");
  tokens.push(parseInt(num, 10));
  // Pass 1: × ÷
  let i = 1;
  while (i < tokens.length) {
    const op = tokens[i];
    if (op === "*" || op === "/") {
      const a = tokens[i - 1];
      const b = tokens[i + 1];
      const r = op === "*" ? a * b : (b === 0 ? NaN : a / b);
      tokens.splice(i - 1, 3, r);
    } else {
      i += 2;
    }
  }
  // Pass 2: + −
  let result = tokens[0];
  for (let j = 1; j < tokens.length; j += 2) {
    const op = tokens[j];
    const v = tokens[j + 1];
    if (op === "+") result += v;
    else if (op === "-") result -= v;
  }
  if (!Number.isFinite(result)) throw new Error("non-finite");
  return Math.round(result);
}

function exprHasOperator(s) {
  return /[+\-−*×/÷]/.test(s);
}

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
  renderDeletedEntries();
  renderHistory();
  renderViewToggle();
  renderHistoryTabs();
  renderDashboard();
}

function renderPickers() {
  // Row 1: 誰欠錢
  $$('[data-target="from"] .person-btn').forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.person === state.from);
  });
  // Row 3: 欠誰 (不能欠自己 → disable 已選的債務人)
  $$('[data-target="to"] .person-btn').forEach((btn) => {
    const p = btn.dataset.person;
    btn.classList.toggle("disabled", p === state.from);
    btn.disabled = p === state.from;
    btn.classList.toggle("active", p === state.to);
  });
}

function renderAmount() {
  const el = $("#amountValue");
  const expr = state.expression;
  el.textContent = expr === "" ? "0" : expr;
  el.classList.toggle("zero", expr === "");

  const preview = $("#amountPreview");
  if (expr === "" || !exprHasOperator(expr)) {
    preview.classList.add("hidden");
    preview.textContent = "";
    return;
  }
  try {
    const v = evalExpression(expr);
    if (v > 0) {
      preview.textContent = "= NT$" + v.toLocaleString("en-US");
      preview.classList.remove("hidden", "error");
    } else {
      preview.textContent = "= " + v.toLocaleString("en-US") + " (要 > 0)";
      preview.classList.remove("hidden");
      preview.classList.add("error");
    }
  } catch {
    // partial expression like "100+" — show ellipsis, not error
    preview.textContent = "= …";
    preview.classList.remove("hidden", "error");
  }
}

function renderSubmit() {
  let amount = 0;
  try { amount = evalExpression(state.expression); } catch { amount = 0; }
  const valid =
    state.from &&
    state.to &&
    state.from !== state.to &&
    amount > 0;
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
  li.className = "entry entry-card" + (e.deleted ? " entry-deleted" : "");
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
  if (e.deleted) {
    sub.textContent = "已刪除 " + relTime(tsToMs(e.deletedAt));
    sub.title = "刪除時間：" + fullTime(tsToMs(e.deletedAt)) + " / 原建立：" + fullTime(tsToMs(e.createdAt));
  } else {
    sub.textContent = relTime(tsToMs(e.createdAt));
    sub.title = fullTime(tsToMs(e.createdAt));
  }
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

  // 只有非刪除的才能再被刪除
  if (!e.deleted) attachLongPress(li, e.id, e);
  return li;
}

function renderDeletedEntries() {
  const deleted = state.entries
    .filter((e) => e.deleted)
    .sort((a, b) => tsToMs(b.deletedAt) - tsToMs(a.deletedAt));
  $("#histDeletedCount").textContent = deleted.length;
  fillEntryList($("#deletedEntriesList"), $("#deletedEntriesEmpty"), deleted);
}

function renderSettleBar() {
  const meta = $("#settleMeta");
  const btn = $("#settleBtn");
  const wrap = $("#settleWrap");
  const r = computeSettlement(state.entries);
  if (r.activeCount === 0) {
    meta.textContent = "";
    btn.disabled = true;
    wrap?.classList.add("hidden");
  } else {
    meta.textContent = `${r.activeCount} 筆 / $${r.totalAmount.toLocaleString("en-US")}`;
    btn.disabled = false;
    wrap?.classList.remove("hidden");
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
    by.textContent = `${s.triggeredBy ? s.triggeredBy + " 結帳 · " : ""}共 ${s.entryIds?.length || 0} 筆`;
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
  $("#historyToggle").classList.toggle("active", state.view === "history");
}

function renderHistoryTabs() {
  $$("#historyTabs .tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === state.historyTab);
  });
  $("#tabUnsettled").classList.toggle("hidden", state.historyTab !== "unsettled");
  $("#tabDeleted").classList.toggle("hidden", state.historyTab !== "deleted");
  $("#tabSettlements").classList.toggle("hidden", state.historyTab !== "settlements");
}

// ====================================================================
// Entanglement dashboard (FAB → SVG visualization)
// ====================================================================

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// Compute line endpoint at the EDGE of each orb (not center)
function lineEndpoints(p1, p2, r1, r2) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  return {
    start: { x: p1.x + ux * r1, y: p1.y + uy * r1 },
    end:   { x: p2.x - ux * r2, y: p2.y - uy * r2 },
  };
}

// Tapered polygon from (x1,y1) to (x2,y2) with widths w1 → w2
function taperPath(x1, y1, x2, y2, w1, w2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len === 0) return "";
  const ux = -dy / len, uy = dx / len;
  const h1 = w1 / 2, h2 = w2 / 2;
  return `M ${x1 + ux * h1} ${y1 + uy * h1} ` +
         `L ${x2 + ux * h2} ${y2 + uy * h2} ` +
         `L ${x2 - ux * h2} ${y2 - uy * h2} ` +
         `L ${x1 - ux * h1} ${y1 - uy * h1} Z`;
}

// 帶曲線的 path — 控制點偏移在 canvas 中心反方向，讓三條線往外彎
const CANVAS_CENTER = { x: 180, y: 180 };
function curvedPath(p1, p2, curvature = 0.22) {
  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  // 垂直單位向量
  let nx = -dy / len, ny = dx / len;
  // 判斷哪個方向是「離 canvas 中心更遠」
  const dInside  = Math.hypot(midX + nx - CANVAS_CENTER.x, midY + ny - CANVAS_CENTER.y);
  const dOutside = Math.hypot(midX - nx - CANVAS_CENTER.x, midY - ny - CANVAS_CENTER.y);
  if (dInside > dOutside) { nx = -nx; ny = -ny; }
  const ctrlX = midX + nx * len * curvature;
  const ctrlY = midY + ny * len * curvature;
  return { d: `M ${p1.x} ${p1.y} Q ${ctrlX} ${ctrlY} ${p2.x} ${p2.y}`, ctrlX, ctrlY };
}

function renderDashboard() {
  const r = computeSettlement(state.entries);
  const fabBadge = $("#fabBadge");
  const fab = $("#dashFab");

  // FAB visibility: only on main view
  fab?.classList.toggle("hidden", state.view !== "main");

  // FAB badge: show un-settled count
  if (r.activeCount > 0) {
    fabBadge.textContent = r.activeCount > 99 ? "99+" : String(r.activeCount);
    fabBadge.classList.remove("hidden");
  } else {
    fabBadge.classList.add("hidden");
  }

  // Sub-title
  if (r.activeCount === 0) {
    $("#dashSub").textContent = "目前沒有未結帳的糾纏";
  } else {
    $("#dashSub").textContent = `未結算 ${r.activeCount} 筆 · 共 NT$${r.totalAmount.toLocaleString("en-US")}`;
  }

  // Empty state overlay on canvas
  $("#dashEmpty").classList.toggle("hidden", r.activeCount > 0);

  // 計算 orb 半徑 — 正向 balance 越大、圓越大
  const positives = PEOPLE.map((p) => Math.max(0, r.balances?.[p] || 0));
  const maxPos = Math.max(...positives, 1);
  const orbSizes = {};
  for (let i = 0; i < PEOPLE.length; i++) {
    const p = PEOPLE[i];
    const ratio = maxPos === 0 ? 0.45 : positives[i] / maxPos;
    // 18 ~ 50px core radius — 範圍夠大、視覺差很明顯
    orbSizes[p] = 18 + Math.pow(ratio, 0.85) * 32;
  }

  renderDashboardTerritory(r);
  renderDashboardLines(r, orbSizes);
  renderDashboardOrbs(r, orbSizes);
  renderDashboardSummary(r);

  // 同步 canvas 粒子系統
  refreshDashCanvas(r, orbSizes);
}

// 勢力板塊背景 — 各人正向 net balance 越大、自己那一邊的光暈越大
function renderDashboardTerritory(r) {
  const g = $("#dashTerritory");
  g.innerHTML = "";

  const positives = PEOPLE.map((p) => Math.max(0, r.balances?.[p] || 0));
  const maxPos = Math.max(...positives, 1);
  const totalPos = positives.reduce((a, b) => a + b, 0);

  for (let i = 0; i < PEOPLE.length; i++) {
    const p = PEOPLE[i];
    const pos = ORB_POSITIONS[p];
    const positive = positives[i];
    // 半徑：正向值越大、輻射越廣。最小保留一點光暈、最大幾乎佔整個 canvas
    const ratio = totalPos === 0 ? 0.18 : 0.18 + (positive / maxPos) * 0.55;
    const r_pct = ratio * 360;
    const cls = PERSON_CLASS[p];
    const circle = svgEl("circle", {
      cx: pos.x,
      cy: pos.y,
      r: r_pct,
      fill: `url(#terr-${cls})`,
      class: `dash-territory ${cls}`,
    });
    g.appendChild(circle);
  }
}

// 背景星星 — 給夜空感
const DASH_STARS = (() => {
  // deterministic positions（避免每次 render 重新洗牌讓動畫亂跳）
  const pts = [];
  let seed = 42;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  for (let i = 0; i < 36; i++) {
    pts.push({
      x: 20 + rand() * 320,
      y: 20 + rand() * 320,
      r: 0.8 + rand() * 1.4,
      delay: rand() * 3,
      dur: 2 + rand() * 3,
    });
  }
  return pts;
})();
function renderDashboardStars() {
  const g = $("#dashStars");
  if (g.children.length > 0) return; // 只渲染一次、不要每次更新都重新建
  for (const s of DASH_STARS) {
    g.appendChild(svgEl("circle", {
      cx: s.x, cy: s.y, r: s.r,
      class: "dash-star",
      style: `animation-delay:${s.delay}s; animation-duration:${s.dur}s;`,
    }));
  }
}

function renderDashboardOrbs(r, orbSizes) {
  const g = $("#dashOrbs");
  g.innerHTML = "";

  // 找出「最大債權人」（balance 正最高的）— 給他王者金環
  const balances = PEOPLE.map((p) => ({ p, v: r.balances?.[p] || 0 }));
  const kingEntry = balances.filter((b) => b.v > 0).sort((a, b) => b.v - a.v)[0];
  const king = kingEntry?.p;

  for (const p of PEOPLE) {
    const pos = ORB_POSITIONS[p];
    const cls = PERSON_CLASS[p];
    const bal = r.balances?.[p] || 0;
    const coreR = orbSizes[p];
    const haloR = coreR * 1.65;

    const grp = svgEl("g", { transform: `translate(${pos.x}, ${pos.y})`, class: "dash-orb-g" });

    // 光暈
    grp.appendChild(svgEl("circle", { r: haloR, class: `dash-orb-halo ${cls}` }));

    // 3 個 staggered 漣漪 (能量波)
    for (let i = 0; i < 3; i++) {
      grp.appendChild(svgEl("circle", {
        r: coreR,
        class: `dash-orb-ripple ${cls}`,
        style: `animation-delay: ${i * 0.9}s`,
      }));
    }

    // 軌道環（旋轉的虛線）
    grp.appendChild(svgEl("circle", { r: coreR + 9, class: `dash-orb-ring ${cls}` }));

    // 王者金環（最大正債權人）
    if (p === king) {
      grp.appendChild(svgEl("circle", { r: coreR + 5, class: "dash-orb-king-ring" }));
    }

    // 核心 — radial gradient 球體 + feTurbulence 抖動
    grp.appendChild(svgEl("circle", {
      r: coreR,
      class: `dash-orb-core ${cls}`,
      fill: `url(#orb-grad-${cls})`,
      filter: bal > 0 ? "url(#energy-strong)" : "url(#energy)",
    }));

    // 文字用 SVG filter 加柔性深色光暈 (替代矩形 pill 的醜遮罩)
    let balLabel, balFillColor;
    if (bal > 0) {
      balLabel = `+$${bal.toLocaleString("en-US")}`;
      balFillColor = "#6ef0a8";
    } else if (bal < 0) {
      balLabel = `-$${(-bal).toLocaleString("en-US")}`;
      balFillColor = "#ff8d99";
    } else {
      balLabel = "持平";
      balFillColor = "rgba(255,255,255,0.92)";
    }

    // 名字 — 走 SVG attribute + 柔性 dropshadow filter
    const name = svgEl("text", {
      x: 0, y: -3,
      "text-anchor": "middle",
      "font-size": "14",
      "font-weight": "600",
      fill: "#ffffff",
      filter: "url(#textShadow)",
      "pointer-events": "none",
    });
    name.textContent = p;
    grp.appendChild(name);

    // 平衡金額
    const balEl = svgEl("text", {
      x: 0, y: 12,
      "text-anchor": "middle",
      "font-size": "11.5",
      "font-weight": "600",
      "font-variant-numeric": "tabular-nums",
      "letter-spacing": "0.3",
      fill: balFillColor,
      filter: "url(#textShadow)",
      "pointer-events": "none",
    });
    balEl.textContent = balLabel;
    grp.appendChild(balEl);

    g.appendChild(grp);
  }
}

// 線改全交給 canvas、SVG 只放金額 pill (才能用一般文字 + 圓角背景)
function renderDashboardLines(r, orbSizes) {
  const g = $("#dashLines");
  g.innerHTML = "";
  if (!r.transactions || r.transactions.length === 0) return;

  for (const tx of r.transactions) {
    const fromPos = ORB_POSITIONS[tx.from];
    const toPos = ORB_POSITIONS[tx.to];
    const ep = lineEndpoints(fromPos, toPos, orbSizes[tx.from] - 2, orbSizes[tx.to] - 2);
    const curve = curvedPath(ep.start, ep.end, 0.22);

    // 金額 pill at curve midpoint
    const labelX = (ep.start.x + ep.end.x) / 2 * 0.5 + curve.ctrlX * 0.5;
    const labelY = (ep.start.y + ep.end.y) / 2 * 0.5 + curve.ctrlY * 0.5;
    const lblText = `$${tx.amount.toLocaleString("en-US")}`;
    const lblWidth = Math.max(54, lblText.length * 9 + 14);
    const lblG = svgEl("g", { transform: `translate(${labelX}, ${labelY})` });
    lblG.appendChild(svgEl("rect", {
      x: -lblWidth / 2, y: -12, width: lblWidth, height: 24, rx: 12,
      class: "dash-label-bg",
    }));
    const txt = svgEl("text", { class: "dash-label-text", y: 5 });
    txt.textContent = lblText;
    lblG.appendChild(txt);
    g.appendChild(lblG);
  }
}

function renderDashboardSummary(r) {
  const ul = $("#dashSummary");
  ul.innerHTML = "";
  if (!r.transactions || r.transactions.length === 0) return;

  // sort by amount desc so biggest debt first
  const sorted = [...r.transactions].sort((a, b) => b.amount - a.amount);
  for (const tx of sorted) {
    const li = document.createElement("li");
    li.className = "dash-summary-row";

    const flow = document.createElement("div");
    flow.className = "from-to";
    const fromS = document.createElement("span");
    fromS.className = "entry-person";
    fromS.dataset.person = tx.from;
    fromS.textContent = tx.from;
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = "→";
    const toS = document.createElement("span");
    toS.className = "entry-person";
    toS.dataset.person = tx.to;
    toS.textContent = tx.to;
    flow.append(fromS, arrow, toS);

    const amt = document.createElement("span");
    amt.className = "amt";
    amt.textContent = "$" + tx.amount.toLocaleString("en-US");

    li.append(flow, amt);
    ul.append(li);
  }
}

function openDashboard() {
  renderDashboard();
  $("#dashOverlay").classList.remove("hidden");
  startCanvasAnimation();
}
function closeDashboard() {
  $("#dashOverlay").classList.add("hidden");
  stopCanvasAnimation();
}

// ====================================================================
// Canvas 星塵粒子系統 (背景宇宙感)
// ====================================================================

// ================================================
// Canvas particle system v2 — fluid streams + auras
// 全部用 0-360 SVG viewBox 座標、canvas 用 setTransform 自動 scale
// ================================================

const SCENE_W = 360;
const SCENE_H = 360;

const PERSON_RGB = {
  Charlie: [0, 229, 255],
  "偉賢":   [255, 94, 196],
  Eric:    [255, 210, 74],
};

const BG_COLORS = [
  [0, 229, 255],
  [255, 94, 196],
  [255, 210, 74],
  [139, 108, 255],
  [255, 255, 255],
  [255, 255, 255],
];

const canvasState = {
  bg: [],        // background drifters
  streams: [],   // line flow particles
  auras: [],     // orbital particles around each orb
  needsRebuild: true,
  txs: [],
  orbSizes: {},
};

let canvasAnimHandle = null;
let canvasDimsCache = null;

function initCanvas() {
  const canvas = $("#dashCanvas");
  if (!canvas) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return null;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext("2d");
  // map 0-360 SVG space onto canvas
  const sx = (rect.width * dpr) / SCENE_W;
  const sy = (rect.height * dpr) / SCENE_H;
  ctx.setTransform(sx, 0, 0, sy, 0, 0);
  ctx.clearRect(0, 0, SCENE_W, SCENE_H);
  canvasDimsCache = { w: rect.width, h: rect.height, dpr };

  // background drifters — 一次性 spawn (砍量 + 降亮度)
  if (canvasState.bg.length === 0) {
    for (let i = 0; i < 80; i++) {
      const c = BG_COLORS[Math.floor(Math.random() * BG_COLORS.length)];
      canvasState.bg.push({
        x: Math.random() * SCENE_W,
        y: Math.random() * SCENE_H,
        vx: (Math.random() - 0.5) * 0.14,
        vy: (Math.random() - 0.5) * 0.14,
        r: 0.3 + Math.random() * 1.6,
        color: c,
        a: 0.08 + Math.random() * 0.38,
        phase: Math.random() * Math.PI * 2,
        speed: 0.4 + Math.random() * 1.6,
      });
    }
  }
  canvasState.needsRebuild = true;
  return canvasDimsCache;
}

function bezierPointAt(t, p0, ctrl, p1) {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * ctrl.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * ctrl.y + t * t * p1.y,
  };
}

// derivative — gives tangent direction at t (for accurate perpendicular along curve)
function bezierTangent(t, p0, ctrl, p1) {
  const u = 1 - t;
  return {
    x: 2 * u * (ctrl.x - p0.x) + 2 * t * (p1.x - ctrl.x),
    y: 2 * u * (ctrl.y - p0.y) + 2 * t * (p1.y - ctrl.y),
  };
}

function rebuildStreamsAndAuras() {
  canvasState.streams.length = 0;
  canvasState.auras.length = 0;

  // Orbit auras for each person — 數量更少、size 更小
  for (const p of PEOPLE) {
    const pos = ORB_POSITIONS[p];
    const baseR = canvasState.orbSizes[p] || 32;
    const color = PERSON_RGB[p];
    const count = Math.round(10 + ((baseR - 18) / 32) * 12); // 10~22
    for (let i = 0; i < count; i++) {
      canvasState.auras.push({
        cx: pos.x, cy: pos.y,
        baseR,
        radOffset: 3 + Math.random() * (baseR * 0.5),
        angle: Math.random() * Math.PI * 2,
        omega: (Math.random() < 0.5 ? -1 : 1) * (0.003 + Math.random() * 0.009),
        size: 0.35 + Math.random() * 1.0,
        color,
        ellipseRatio: 0.55 + Math.random() * 0.45,
        tiltCos: Math.cos(Math.random() * Math.PI),
        tiltSin: Math.sin(Math.random() * Math.PI),
        phase: Math.random() * Math.PI * 2,
        pulseSpeed: 0.6 + Math.random() * 1.8,
      });
    }
  }

  // Stream particles for each transaction
  const txs = canvasState.txs || [];
  if (txs.length === 0) return;
  const maxAmt = Math.max(...txs.map((t) => t.amount), 1);

  for (const tx of txs) {
    const fromPos = ORB_POSITIONS[tx.from];
    const toPos = ORB_POSITIONS[tx.to];
    const startR = (canvasState.orbSizes[tx.from] || 32) - 2;
    const endR = (canvasState.orbSizes[tx.to] || 32) - 2;
    const ep = lineEndpoints(fromPos, toPos, startR, endR);
    const curve = curvedPath(ep.start, ep.end, 0.22);
    const ratio = tx.amount / maxAmt;
    const count = Math.round(40 + ratio * 60); // 40~100 — 收斂
    const color = PERSON_RGB[tx.to];
    // stream 寬度收窄（金額越大才寬）
    const streamWidth = 2 + Math.pow(ratio, 0.55) * 7; // 2~9

    for (let i = 0; i < count; i++) {
      // triangular 分布 偏中間
      const u = Math.random() + Math.random() - 1;
      canvasState.streams.push({
        p0: ep.start,
        p1: ep.end,
        ctrl: { x: curve.ctrlX, y: curve.ctrlY },
        color,
        t: Math.random(),
        speed: (0.0026 + Math.random() * 0.0042) * (0.6 + ratio * 0.7),
        size: 0.35 + Math.random() * (0.7 + ratio * 0.9), // 更小
        whiteCore: Math.random() < 0.10,
        lateralBase: u * (streamWidth / 2),
        lateralAmp: 0.15 + Math.random() * 0.7,
        lateralFreq: 1.2 + Math.random() * 3.5,
        lateralPhase: Math.random() * Math.PI * 2,
      });
    }
  }
}

function tickCanvas() {
  const canvas = $("#dashCanvas");
  if (!canvas) {
    canvasAnimHandle = null;
    return;
  }
  const ctx = canvas.getContext("2d");
  if (!canvasDimsCache) {
    if (!initCanvas()) {
      canvasAnimHandle = requestAnimationFrame(tickCanvas);
      return;
    }
  }
  if (canvasState.needsRebuild) {
    rebuildStreamsAndAuras();
    canvasState.needsRebuild = false;
  }

  // 拖尾 — 7.5% per frame (~14 frame trail) 不要過糊
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "rgba(0,0,0,0.075)";
  ctx.fillRect(0, 0, SCENE_W, SCENE_H);

  // additive (bloom)
  ctx.globalCompositeOperation = "lighter";

  const now = performance.now() * 0.001;

  // ---- Background drifters ----
  for (const p of canvasState.bg) {
    p.x += p.vx;
    p.y += p.vy;
    if (p.x < -3) p.x = SCENE_W + 3;
    else if (p.x > SCENE_W + 3) p.x = -3;
    if (p.y < -3) p.y = SCENE_H + 3;
    else if (p.y > SCENE_H + 3) p.y = -3;

    const pulse = (Math.sin(now * p.speed + p.phase) + 1) * 0.5;
    const a = p.a * (0.3 + pulse * 0.7);
    drawGlowDot(ctx, p.x, p.y, p.r, p.color, a);
  }

  // ---- Orb auras (orbital particles) ----
  for (const o of canvasState.auras) {
    o.angle += o.omega;
    const r = o.baseR + o.radOffset;
    const lx = Math.cos(o.angle) * r;
    const ly = Math.sin(o.angle) * r * o.ellipseRatio;
    // rotate by tilt
    const x = o.cx + lx * o.tiltCos - ly * o.tiltSin;
    const y = o.cy + lx * o.tiltSin + ly * o.tiltCos;
    const pulse = (Math.sin(now * o.pulseSpeed + o.phase) + 1) * 0.5;
    const a = 0.45 + pulse * 0.55;
    drawGlowDot(ctx, x, y, o.size, o.color, a);
  }

  // ---- Stream particles (bezier flow with ribbon-like lateral spread) ----
  for (const s of canvasState.streams) {
    s.t += s.speed;
    if (s.t > 1) s.t -= 1; // recycle smoothly

    // 沿曲線取點 + tangent (才能算正確的 perpendicular)
    const pt = bezierPointAt(s.t, s.p0, s.ctrl, s.p1);
    const tan = bezierTangent(s.t, s.p0, s.ctrl, s.p1);
    const tlen = Math.hypot(tan.x, tan.y) || 1;
    const px = -tan.y / tlen;
    const py = tan.x / tlen;

    // lateral = 固定偏移 + sin 抖動 (粒子互相穿插、形成 ribbon-weave)
    const wob = Math.sin(s.t * s.lateralFreq * Math.PI * 2 + s.lateralPhase + now * 1.2) * s.lateralAmp;
    const lateral = s.lateralBase + wob;
    const x = pt.x + px * lateral;
    const y = pt.y + py * lateral;

    // lifecycle fade at extremes (smooth in/out)
    const lifeFade =
      s.t < 0.06 ? s.t / 0.06 :
      s.t > 0.94 ? (1 - s.t) / 0.06 : 1;

    if (s.whiteCore) {
      drawGlowDot(ctx, x, y, s.size, [255, 255, 255], 0.7 * lifeFade);
    } else {
      drawGlowDot(ctx, x, y, s.size, s.color, 0.62 * lifeFade);
    }
  }

  canvasAnimHandle = requestAnimationFrame(tickCanvas);
}

function drawGlowDot(ctx, x, y, r, color, alpha) {
  const [cr, cg, cb] = color;
  // 3-pass glow stack — halo 收緊、core 銳利 = 更有質感
  ctx.beginPath();
  ctx.arc(x, y, r * 3.5, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${cr},${cg},${cb},${alpha * 0.06})`;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r * 1.7, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${cr},${cg},${cb},${alpha * 0.20})`;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.9, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${cr},${cg},${cb},${alpha * 0.95})`;
  ctx.fill();
}

function refreshDashCanvas(r, orbSizes) {
  canvasState.txs = r?.transactions || [];
  canvasState.orbSizes = orbSizes || {};
  canvasState.needsRebuild = true;
}

function startCanvasAnimation() {
  if (canvasAnimHandle) return;
  requestAnimationFrame(() => {
    initCanvas();
    canvasAnimHandle = requestAnimationFrame(tickCanvas);
  });
}

function stopCanvasAnimation() {
  if (canvasAnimHandle) {
    cancelAnimationFrame(canvasAnimHandle);
    canvasAnimHandle = null;
  }
}

window.addEventListener("resize", () => {
  canvasDimsCache = null;
});

// ====================================================================
// Settings & wipe-all (password protected)
// ====================================================================

function openSettings() {
  // populate stats
  const unsettled = state.entries.filter((e) => !e.deleted && !e.settled).length;
  const deleted = state.entries.filter((e) => e.deleted).length;
  $("#settingsBackend").textContent = backend.mode === "firestore" ? "Firestore (sync)" : "本機 (demo)";
  $("#settingsUnsettled").textContent = unsettled;
  $("#settingsDeleted").textContent = deleted;
  $("#settingsSettlements").textContent = state.settlements.length;
  $("#settingsModal").classList.remove("hidden");
}
function closeSettings() {
  $("#settingsModal").classList.add("hidden");
}

function openWipeModal() {
  $("#wipePassword").value = "";
  $("#wipeModal").classList.remove("hidden");
  setTimeout(() => $("#wipePassword").focus(), 60);
}
function closeWipeModal() {
  $("#wipeModal").classList.add("hidden");
}

async function confirmWipe() {
  const pw = $("#wipePassword").value;
  if (pw !== WIPE_PASSWORD) {
    showToast("密碼錯誤");
    $("#wipePassword").value = "";
    return;
  }
  const btn = $("#wipeConfirm");
  btn.disabled = true;
  btn.textContent = "清除中...";
  try {
    const count = await backend.wipeAll();
    closeWipeModal();
    closeSettings();
    showToast(`已清除 ${count} 筆資料`);
  } catch (err) {
    console.error(err);
    showToast("清除失敗：" + (err.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = "確認清除";
  }
}

// ====================================================================
// FAB: drag + click
// ====================================================================

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function loadFabPos() {
  try {
    const s = localStorage.getItem(LS_FAB_POS);
    if (!s) return null;
    const o = JSON.parse(s);
    if (typeof o?.left === "number" && typeof o?.top === "number") return o;
  } catch {}
  return null;
}
function saveFabPos(left, top) {
  localStorage.setItem(LS_FAB_POS, JSON.stringify({ left, top }));
}

function applyFabPos(fab, left, top) {
  const margin = 8;
  const fabSize = 60;
  const maxLeft = window.innerWidth - fabSize - margin;
  const maxTop = window.innerHeight - fabSize - margin;
  left = clamp(left, margin, Math.max(margin, maxLeft));
  top = clamp(top, margin, Math.max(margin, maxTop));
  fab.style.left = left + "px";
  fab.style.top = top + "px";
  fab.style.right = "auto";
  fab.style.bottom = "auto";
  return { left, top };
}

function bindFabDrag() {
  const fab = $("#dashFab");
  if (!fab) return;

  // 還原上次位置
  const saved = loadFabPos();
  if (saved) applyFabPos(fab, saved.left, saved.top);

  let drag = null;
  const THRESHOLD = 6;

  fab.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const rect = fab.getBoundingClientRect();
    drag = {
      startX: e.clientX,
      startY: e.clientY,
      fabX: rect.left,
      fabY: rect.top,
      moved: false,
      pointerId: e.pointerId,
    };
    fab.setPointerCapture(e.pointerId);
  });

  fab.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < THRESHOLD) return;
    drag.moved = true;
    fab.classList.add("dragging");
    applyFabPos(fab, drag.fabX + dx, drag.fabY + dy);
    e.preventDefault();
  });

  const finish = (e) => {
    if (!drag) return;
    const wasDrag = drag.moved;
    try { fab.releasePointerCapture(drag.pointerId); } catch {}
    drag = null;
    fab.classList.remove("dragging");
    if (wasDrag) {
      // 存位置
      const rect = fab.getBoundingClientRect();
      saveFabPos(rect.left, rect.top);
      // 防止 click 觸發 (拖完不該開 dashboard)
      fab._lastDragEndAt = Date.now();
    }
  };
  fab.addEventListener("pointerup", finish);
  fab.addEventListener("pointercancel", finish);

  fab.addEventListener("click", (e) => {
    // 剛拖完不要觸發 click
    if (fab._lastDragEndAt && Date.now() - fab._lastDragEndAt < 250) {
      e.preventDefault();
      return;
    }
    openDashboard();
  });

  // 視窗改大小時 re-clamp
  window.addEventListener("resize", () => {
    const rect = fab.getBoundingClientRect();
    if (rect.left + 60 > window.innerWidth || rect.top + 60 > window.innerHeight) {
      const fixed = applyFabPos(fab, rect.left, rect.top);
      saveFabPos(fixed.left, fixed.top);
    }
  });
}

// ====================================================================
// 實體鍵盤 → keypad
// ====================================================================
function handleKeyboardInput(e) {
  // 只在主畫面、且 input 沒在 focus 時接管數字鍵
  if (state.view !== "main") return;
  const active = document.activeElement;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
  // 也跳過如果 modal 開著
  if (!$("#settleModal").classList.contains("hidden")) return;
  if (!$("#dashOverlay").classList.contains("hidden")) return;
  if (!$("#deleteModal").classList.contains("hidden")) return;

  const k = e.key;
  let mapped = null;
  if (/^\d$/.test(k)) mapped = k;
  else if (k === "+") mapped = "+";
  else if (k === "-") mapped = "−";
  else if (k === "*" || k === "x" || k === "X") mapped = "×";
  else if (k === "/") mapped = "÷";
  else if (k === "Backspace") mapped = "back";
  else if (k === "Delete" || k === "Escape") mapped = "clear";
  else if (k === "Enter") {
    e.preventDefault();
    if (!$("#submitBtn").disabled) submitEntry();
    return;
  }
  if (mapped !== null) {
    e.preventDefault();
    pressKey(mapped);
  }
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
      triggeredBy: null,
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

function selectFrom(person) {
  state.from = state.from === person ? null : person;
  // 不能欠自己 → 若債主跟新債務人撞，清掉債主
  if (state.to === state.from) state.to = null;
  render();
}

function selectTo(person) {
  if (person === state.from) return;
  state.to = state.to === person ? null : person;
  render();
}

function pressKey(key) {
  const OPS = "+-−*×/÷";
  if (key === "back") {
    state.expression = state.expression.slice(0, -1);
  } else if (key === "clear") {
    state.expression = "";
  } else if (OPS.includes(key)) {
    // Can't start expression with operator
    if (state.expression === "") return;
    const last = state.expression.slice(-1);
    if (OPS.includes(last)) {
      // Replace previous trailing operator
      state.expression = state.expression.slice(0, -1) + key;
    } else {
      state.expression += key;
    }
  } else if (/^\d$/.test(key)) {
    if (state.expression.length >= 28) return; // cap
    // Avoid leading-zero junk: if last segment is just "0", replace it
    const lastSegMatch = state.expression.match(/(?:^|[+\-−*×/÷])(\d+)$/);
    if (lastSegMatch && lastSegMatch[1] === "0" && key !== "0") {
      state.expression = state.expression.slice(0, -1) + key;
    } else {
      state.expression += key;
    }
  }
  renderAmount();
  renderSubmit();
}

async function submitEntry() {
  const note = ($("#noteInput").value || "").trim();
  if (!state.from || !state.to) return;
  if (state.from === state.to) return;

  let amount;
  try {
    amount = evalExpression(state.expression);
  } catch {
    showToast("金額算式有誤");
    return;
  }
  if (amount <= 0) {
    showToast("金額必須大於 0");
    return;
  }

  const payload = {
    from: state.from,
    to: state.to,
    amount,
    note,
  };
  try {
    await backend.addEntry(payload);
    // reset 整筆 — 每次記帳都從頭選誰欠誰
    state.expression = "";
    state.from = null;
    state.to = null;
    $("#noteInput").value = "";
    state.note = "";
    render();
    showToast(`已記下：${payload.from} → ${payload.to} $${amount.toLocaleString("en-US")}`);
  } catch (err) {
    console.error(err);
    showToast("寫入失敗：" + (err.message || err));
  }
}

function toggleView() {
  state.view = state.view === "main" ? "history" : "main";
  // 進歷史頁時，default tab 固定回未結帳（按使用者要求）
  if (state.view === "history") state.historyTab = "unsettled";
  render();
}

// ====================================================================
// Bind UI
// ====================================================================

function bindUI() {
  // person pickers
  $$('[data-target="from"] .person-btn').forEach((btn) => {
    btn.addEventListener("click", () => selectFrom(btn.dataset.person));
  });
  $$('[data-target="to"] .person-btn').forEach((btn) => {
    btn.addEventListener("click", () => selectTo(btn.dataset.person));
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

  // dashboard FAB — supports drag + click
  bindFabDrag();
  $("#dashClose").addEventListener("click", closeDashboard);
  $("#dashOverlay").addEventListener("click", (e) => {
    if (e.target.id === "dashOverlay") closeDashboard();
  });

  // settings
  $("#settingsBtn").addEventListener("click", openSettings);
  $("#settingsClose").addEventListener("click", closeSettings);
  $("#settingsModal").addEventListener("click", (e) => {
    if (e.target.id === "settingsModal") closeSettings();
  });
  $("#wipeBtn").addEventListener("click", openWipeModal);
  $("#wipeCancel").addEventListener("click", closeWipeModal);
  $("#wipeConfirm").addEventListener("click", confirmWipe);
  $("#wipeModal").addEventListener("click", (e) => {
    if (e.target.id === "wipeModal") closeWipeModal();
  });
  $("#wipePassword").addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirmWipe();
  });

  // 實體鍵盤 (desktop / 鍵盤外接) — calculator 用
  document.addEventListener("keydown", handleKeyboardInput);

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

  if (backend.mode === "local") {
    showToast("Demo 模式：請先設定 firebase-config.js", 3500);
  }

  backend.subscribeEntries((items) => {
    state.entries = items;
    renderEntries();
    renderHistoryEntries();
    renderDeletedEntries();
    renderSettleBar();
    renderDashboard();
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
