const DB_NAME = "huabu-v1";
const DB_VERSION = 1;

const PEN_COLORS = [
  { id: "black", value: "#1a1a1a", label: "黑" },
  { id: "blue", value: "#1e4f9b", label: "藍" },
  { id: "red", value: "#c0392b", label: "紅" },
];
const WIDTHS = [
  { id: "s", pen: 2.2, high: 10, label: "細" },
  { id: "m", pen: 4, high: 16, label: "中" },
  { id: "l", pen: 7, high: 24, label: "粗" },
];

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

const $app = document.getElementById("app");

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function svg(path, size = 24) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

/* ---------------- IndexedDB ---------------- */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("notes")) {
        const s = db.createObjectStore("notes", { keyPath: "id" });
        s.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains("pages")) {
        const s = db.createObjectStore("pages", { keyPath: "id" });
        s.createIndex("noteId", "noteId", { unique: false });
      }
      if (!db.objectStoreNames.contains("files")) {
        db.createObjectStore("files", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeNames, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    const stores = Object.fromEntries(storeNames.map((n) => [n, t.objectStore(n)]));
    const result = fn(stores, t);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

const db = {
  async allNotes() {
    const dbx = await openDb();
    return new Promise((resolve, reject) => {
      const t = dbx.transaction("notes", "readonly");
      const req = t.objectStore("notes").getAll();
      req.onsuccess = () => {
        const list = req.result.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(list);
      };
      req.onerror = () => reject(req.error);
    });
  },
  async getNote(id) {
    const dbx = await openDb();
    return new Promise((resolve, reject) => {
      const t = dbx.transaction(["notes", "pages"], "readonly");
      const n = t.objectStore("notes").get(id);
      const p = t.objectStore("pages").index("noteId").getAll(id);
      const out = {};
      n.onsuccess = () => { out.note = n.result; };
      p.onsuccess = () => {
        out.pages = (p.result || []).sort((a, b) => a.index - b.index);
      };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
    });
  },
  async putNote(note) {
    const dbx = await openDb();
    return new Promise((resolve, reject) => {
      const t = dbx.transaction("notes", "readwrite");
      t.objectStore("notes").put(note);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },
  async putPage(page) {
    const dbx = await openDb();
    return new Promise((resolve, reject) => {
      const t = dbx.transaction("pages", "readwrite");
      t.objectStore("pages").put(page);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },
  async putPages(pages) {
    const dbx = await openDb();
    return new Promise((resolve, reject) => {
      const t = dbx.transaction("pages", "readwrite");
      for (const p of pages) t.objectStore("pages").put(p);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },
  async deleteNote(id) {
    const dbx = await openDb();
    return new Promise((resolve, reject) => {
      const t = dbx.transaction(["notes", "pages", "files"], "readwrite");
      t.objectStore("notes").delete(id);
      const req = t.objectStore("pages").index("noteId").getAllKeys(id);
      req.onsuccess = () => {
        for (const key of req.result) t.objectStore("pages").delete(key);
      };
      t.objectStore("files").delete(id);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },
  async putFile(id, blob) {
    const dbx = await openDb();
    return new Promise((resolve, reject) => {
      const t = dbx.transaction("files", "readwrite");
      t.objectStore("files").put({ id, blob });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },
  async getFile(id) {
    const dbx = await openDb();
    return new Promise((resolve, reject) => {
      const t = dbx.transaction("files", "readonly");
      const r = t.objectStore("files").get(id);
      r.onsuccess = () => resolve(r.result && r.result.blob);
      r.onerror = () => reject(r.error);
    });
  },
};

function blankPage(noteId, index, aspect = 4 / 3) {
  return {
    id: uid(),
    noteId,
    index,
    aspect,
    backgroundType: "blank",
    backgroundId: null,
    pdfPage: null,
    strokes: [],
    textBoxes: [],
  };
}

function newNote(title = "未命名畫布") {
  const id = uid();
  const now = Date.now();
  return {
    note: {
      id,
      title,
      createdAt: now,
      updatedAt: now,
      sourceName: "",
      favorite: false,
      trashedAt: null,
      tags: [],
    },
    pages: [blankPage(id, 0)],
  };
}

const FINGER_KEY = "huabu-finger-write";
const PALM_MS = 1400;
const MIN_ZOOM = 1;
const MAX_ZOOM = 2.5;

function loadFingerWrite() {
  try {
    return localStorage.getItem(FINGER_KEY) === "1";
  } catch {
    return false;
  }
}

function saveFingerWrite(on) {
  try {
    localStorage.setItem(FINGER_KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}

/* ---------------- App state ---------------- */
const state = {
  view: "list",
  notes: [],
  query: "",
  nav: "home",
  filter: "all",
  sort: "updatedDesc",
  layout: "grid",
  searchOpen: false,
  activeTag: "",
  sideNarrow: false,
  note: null,
  pages: [],
  pageIndex: 0,
  tool: "pen",
  color: "black",
  width: "m",
  fingerWrite: loadFingerWrite(),
  lasso: null,
  aiOpen: false,
  aiMessages: [],
  aiStatus: "",
  aiDraft: "",
  translateDir: "to-en",
  save: "saved", // saving | saved | error
  lastSavedAt: null,
  menu: null,
  confirm: null,
  toast: "",
};

let saveTimer = null;
let lastPenAt = 0;
let drawing = null;
let undoStack = [];
let redoStack = [];
let penPointers = new Set();
let activeTouches = new Map();
let pinch = null;
let scrollLock = null;
let adjustingScroll = false;
let palmTimer = 0;
let viewZoom = 1;
const textGesture = new Map();
const paintToken = new Map();
let globalPointerBound = false;
const fileCache = new Map();
const bgCache = new Map();

function currentPage() {
  return state.pages[state.pageIndex] || null;
}

function markDirty() {
  state.save = "saving";
  if (state.note) state.note.updatedAt = Date.now();
  renderSaveStatus();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrent, 450);
}

async function saveCurrent() {
  if (!state.note) return;
  try {
    state.save = "saving";
    renderSaveStatus();
    await db.putNote(state.note);
    await db.putPages(state.pages);
    state.save = "saved";
    state.lastSavedAt = Date.now();
    renderSaveStatus();
  } catch (err) {
    console.error(err);
    state.save = "error";
    renderSaveStatus();
  }
}

/* ---------------- Render shell ---------------- */
function render() {
  if (state.view === "list") renderList();
  else renderEditor();
}

const TAG_KEY = "huabu-v1-tags";
const ICONS = {
  home: '<path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z"/>',
  ask: '<path d="M12 3.2 13.5 8l4.8 1.5L13.5 11 12 15.8 10.5 11 5.7 9.5 10.5 8z"/><path d="M18 13.8l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  explore: '<circle cx="12" cy="12" r="8"/><path d="m14.8 9.2-1.1 4.5-4.5 1.1 1.1-4.5z"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9 7V4.5h6V7"/><path d="M7 7l1 13h8l1-13"/><path d="M10 11v6M14 11v6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  star: '<path d="m12 4.2 1.9 4.6 5 .5-3.8 3.3 1.1 4.9L12 15.4 7.8 17.5l1.1-4.9L5.1 9.3l5-.5z"/>',
  starFill: '<path d="m12 4.2 1.9 4.6 5 .5-3.8 3.3 1.1 4.9L12 15.4 7.8 17.5l1.1-4.9L5.1 9.3l5-.5z" fill="currentColor" stroke="none"/>',
  more: '<circle cx="6" cy="12" r="1.25" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.25" fill="currentColor" stroke="none"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2"/>',
  list: '<path d="M9 7h11M9 12h11M9 17h11"/><circle cx="5" cy="7" r="1" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="5" cy="17" r="1" fill="currentColor" stroke="none"/>',
  sortDown: '<path d="M12 5v14"/><path d="m7 14 5 5 5-5"/>',
  sortUp: '<path d="M12 19V5"/><path d="m7 10 5-5 5 5"/>',
  panel: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M9 5v14"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  x: '<path d="M7 7l10 10M17 7 7 17"/>',
  canvas: '<rect x="4.2" y="4.2" width="15.6" height="15.6" rx="2.8"/><path d="M7.6 13.8c.4-2.4 2.2-3.6 3.6-2.2.9.9.7 2.2-.4 2.6-1.3.5-1.8-.6-1-.9.7-.3 2.4.2 3.2 1.6 1 1.6 2.6 1.2 3.6-.2"/>',
  file: '<path d="M7.2 3.5h6.2L18 8.1V19.3a1.4 1.4 0 0 1-1.4 1.4H7.2a1.4 1.4 0 0 1-1.4-1.4V4.9a1.4 1.4 0 0 1 1.4-1.4z"/><path d="M13.2 3.7V8.2H17.6"/><path d="M8.3 12.2h7.2M8.3 15.6h5"/>',
  photo: '<rect x="3.8" y="5" width="16.4" height="14" rx="2.2"/><circle cx="8.7" cy="9.7" r="1.35"/><path d="M4.7 16.3 8.8 12.5l2.7 2.4 2.4-2.1 5.1 3.8"/>',
  lasso: '<rect x="4.5" y="5" width="15" height="14" rx="1.6" stroke-dasharray="2.3 1.5"/>',
};

let focusSearch = false;

function icon(name, size = 22) {
  return svg(ICONS[name], size);
}

function noteTags(note) {
  return Array.isArray(note && note.tags) ? note.tags.filter((t) => typeof t === "string" && t.trim()) : [];
}

function normalizeTag(name) {
  const tag = String(name || "").trim().replace(/\s+/g, " ");
  if (!tag) return "";
  return Array.from(tag).slice(0, 16).join("");
}

function loadTagCatalog() {
  try {
    const raw = JSON.parse(localStorage.getItem(TAG_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeTag).filter(Boolean);
  } catch {
    return [];
  }
}

function saveTagCatalog(tags) {
  try {
    localStorage.setItem(TAG_KEY, JSON.stringify([...new Set(tags)]));
  } catch {
    /* storage unavailable */
  }
}

function allTags() {
  const set = new Set(loadTagCatalog());
  for (const note of state.notes) for (const tag of noteTags(note)) set.add(tag);
  return [...set];
}

function greeting() {
  const h = new Date().getHours();
  const part = h < 5 || h >= 18 ? "晚安" : h < 12 ? "早安" : "午安";
  return `${part}，yc`;
}

function fmtCardDate(ts) {
  const d = new Date(ts || Date.now());
  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const start = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  const dayDiff = Math.round((start(now) - start(d)) / 86400000);
  if (dayDiff === 0) return `今天, ${hm}`;
  if (dayDiff === 1) return `昨天, ${hm}`;
  if (dayDiff > 1 && dayDiff < 7) {
    const days = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
    return `${days[d.getDay()]} ${hm}`;
  }
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function visibleNotes() {
  const inTrash = state.nav === "trash";
  let notes = state.notes.filter((n) => (inTrash ? !!n.trashedAt : !n.trashedAt));
  if (!inTrash && state.filter === "favorite") notes = notes.filter((n) => !!n.favorite);
  if (!inTrash && state.activeTag) notes = notes.filter((n) => noteTags(n).includes(state.activeTag));
  const q = state.query.trim().toLowerCase();
  if (q) {
    notes = notes.filter((n) => `${n.title || ""} ${n.sourceName || ""}`.toLowerCase().includes(q));
  }
  const dir = state.sort === "updatedAsc" ? 1 : -1;
  notes.sort((a, b) => ((a.updatedAt || 0) - (b.updatedAt || 0)) * dir);
  return notes;
}

function emptyCopy() {
  if (state.query.trim()) return ["找不到相符的畫布", "只會比對標題和檔名。"];
  if (state.nav === "trash") return ["資源回收桶是空的", "移到這裡的畫布可以還原，或永久刪除。"];
  if (state.filter === "favorite") return ["還沒有收藏", "在畫布卡片的選單裡可以加入收藏。"];
  if (state.activeTag) return ["這個標籤還沒有畫布", "從卡片選單把畫布加上這個標籤。"];
  return ["尚未有畫布", "點右下角的加號，建立一塊空白畫布。"];
}

function renderList() {
  closeMenus();
  const tags = allTags();
  const library = state.nav === "home" || state.nav === "trash";
  const trashCount = state.notes.filter((n) => n.trashedAt).length;
  const sortAsc = state.sort === "updatedAsc";
  const headings = {
    home: [greeting(), "現在，有什麼想記下來的嗎？"],
    trash: ["資源回收桶", "刪除的畫布會留在這部裝置，直到你還原或永久刪除。"],
    tags: ["標籤", "標籤只存在這部裝置，用來整理畫布。"],
    ask: ["提問", "筆記助手會在下一版推出。"],
    explore: ["探索", "先在主頁瀏覽和整理畫布。"],
  };
  const [title, subtitle] = headings[state.nav] || headings.home;
  const homeActive = state.nav === "home" && !state.activeTag;

  const navBtn = (id, ic, label, active) => `
    <button class="nav-item ${active ? "active" : ""}" type="button" data-nav="${id}" aria-current="${active ? "page" : "false"}" title="${label}">
      ${icon(ic, 22)}<span class="nav-text">${label}</span>
    </button>`;

  const searchField = state.searchOpen
    ? `<input id="searchInput" class="search-field" type="search" placeholder="搜尋標題或檔名" value="${escapeAttr(state.query)}" aria-label="搜尋標題或檔名" />`
    : "";

  const chipBar = library
    ? `<div class="home-bar">
        <div class="chips">
          ${state.nav === "home" ? `
            <button class="chip ${state.filter === "all" ? "active" : ""}" type="button" data-filter="all">全部</button>
            <button class="chip ${state.filter === "favorite" ? "active" : ""}" type="button" data-filter="favorite">${icon("star", 15)} 收藏</button>
          ` : ""}
        </div>
        <div class="bar-right">
          ${state.nav === "home" && state.activeTag ? `<button class="tag-clear" id="clearTag" type="button">標籤：${escapeHtml(state.activeTag)} ×</button>` : ""}
          <button class="sort-btn" id="sortBtn" type="button" aria-label="${sortAsc ? "依修改日期排序，目前由舊到新" : "依修改日期排序，目前由新到舊"}">
            ${icon(sortAsc ? "sortUp" : "sortDown", 16)} 修改日期
          </button>
          <button class="round-btn" id="layoutBtn" type="button" aria-label="${state.layout === "grid" ? "切換成列表" : "切換成網格"}" aria-pressed="${state.layout === "grid" ? "true" : "false"}">
            ${icon(state.layout === "grid" ? "grid" : "list", 18)}
          </button>
        </div>
      </div>`
    : "";

  let body = "";
  if (library) {
    body = `<div class="note-grid ${state.layout === "list" ? "list" : ""}" id="grid"></div>`;
  } else if (state.nav === "ask") {
    body = `<div class="placeholder">
      <div class="ph-mark">${icon("ask", 26)}</div>
      <h2>筆記助手尚未推出</h2>
      <p>這一版還沒有助手，也不會把筆記送到雲端。提問只是下一版的入口。</p>
      <ul>
        <li>之後在主頁提問，會搜尋並詢問你的所有筆記。</li>
        <li>之後在已打開的畫布裡提問，會用側欄圍繞該篇筆記。</li>
      </ul>
    </div>`;
  } else if (state.nav === "explore") {
    body = `<div class="placeholder">
      <div class="ph-mark">${icon("explore", 26)}</div>
      <h2>探索尚未推出</h2>
      <p>你可以先在主頁瀏覽、搜尋和整理畫布。</p>
    </div>`;
  } else {
    body = tags.length
      ? `<div class="tag-board">${tags.map((tag) => {
          const count = state.notes.filter((n) => !n.trashedAt && noteTags(n).includes(tag)).length;
          return `<div class="tag-card">
            <strong>${escapeHtml(tag)}</strong>
            <span>${count} 個畫布</span>
            <div class="tag-card-actions">
              <button type="button" data-open-tag="${escapeAttr(tag)}">查看</button>
              <button type="button" class="danger" data-remove-tag="${escapeAttr(tag)}">移除</button>
            </div>
          </div>`;
        }).join("")}</div>`
      : `<div class="empty-state"><h2>還沒有標籤</h2><p>按側欄的加號建立標籤，再從畫布選單指定。</p></div>`;
  }

  const showFab = state.nav === "home" || state.nav === "tags";

  $app.innerHTML = `
    <div class="home-shell ${state.sideNarrow ? "narrow" : ""}" aria-label="畫布">
      <aside class="side">
        <div class="side-top">
          <button class="icon-plain" id="collapseBtn" type="button" aria-label="${state.sideNarrow ? "展開側欄" : "收合側欄"}">${icon("panel", 20)}</button>
          <span class="wordmark">畫布</span>
        </div>
        <nav class="side-nav">
          ${navBtn("home", "home", "主頁", homeActive)}
          ${navBtn("ask", "ask", "提問", state.nav === "ask")}
          ${navBtn("explore", "explore", "探索", state.nav === "explore")}
          <div class="side-label-row">
            <button class="side-heading ${state.nav === "tags" ? "active" : ""}" type="button" data-nav="tags" title="標籤">標籤</button>
            <button class="plus-mini" id="addTagBtn" type="button" aria-label="新增標籤">${icon("plus", 16)}</button>
          </div>
          <div class="side-tags">
            ${tags.map((tag) => `<button class="side-tag ${state.nav === "home" && state.activeTag === tag ? "active" : ""}" type="button" data-tag="${escapeAttr(tag)}" title="${escapeAttr(tag)}">${escapeHtml(tag)}</button>`).join("")}
          </div>
        </nav>
        <div class="side-foot">
          ${navBtn("trash", "trash", trashCount ? `資源回收桶 (${trashCount})` : "資源回收桶", state.nav === "trash")}
        </div>
      </aside>
      <section class="home-main">
        <header class="home-head">
          <div>
            <h1 class="greet">${escapeHtml(title)}</h1>
            <p class="greet-sub">${escapeHtml(subtitle)}</p>
          </div>
          <div class="home-tools">
            ${searchField}
            <button class="round-btn" id="searchBtn" type="button" aria-label="搜尋標題或檔名" aria-expanded="${state.searchOpen ? "true" : "false"}">${icon("search", 20)}</button>
            <div class="avatar" aria-hidden="true">yc</div>
          </div>
        </header>
        ${chipBar}
        <div class="home-body">${body}</div>
        ${showFab ? `<button class="fab" id="fab" type="button" aria-label="新增" aria-haspopup="dialog" aria-expanded="false">${icon("plus", 28)}</button>` : ""}
      </section>
    </div>`;

  bindHome();
  if (library) mountCards(visibleNotes());
  if (focusSearch) {
    const input = document.getElementById("searchInput");
    if (input) {
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }
    focusSearch = false;
  }
}

function bindHome() {
  document.querySelectorAll("[data-nav]").forEach((btn) => {
    btn.onclick = () => {
      state.nav = btn.dataset.nav;
      state.activeTag = "";
      renderList();
    };
  });
  document.querySelectorAll("[data-tag]").forEach((btn) => {
    btn.onclick = () => {
      state.nav = "home";
      state.activeTag = btn.dataset.tag;
      renderList();
    };
  });
  const addTag = document.getElementById("addTagBtn");
  if (addTag) {
    addTag.onclick = (e) => {
      e.stopPropagation();
      askText({
        title: "新增標籤",
        placeholder: "標籤名稱",
        confirm: "新增",
        onConfirm: (name) => {
          const tag = normalizeTag(name);
          if (!tag) return;
          const catalog = loadTagCatalog();
          if (!catalog.includes(tag)) catalog.push(tag);
          saveTagCatalog(catalog);
          state.nav = "tags";
          state.activeTag = "";
          renderList();
        },
      });
    };
  }
  const collapse = document.getElementById("collapseBtn");
  if (collapse) {
    collapse.onclick = () => {
      state.sideNarrow = !state.sideNarrow;
      renderList();
    };
  }
  const searchBtn = document.getElementById("searchBtn");
  if (searchBtn) {
    searchBtn.onclick = () => {
      if (state.searchOpen) {
        state.searchOpen = false;
        state.query = "";
        renderList();
        return;
      }
      if (state.nav !== "home" && state.nav !== "trash") {
        state.nav = "home";
        state.activeTag = "";
      }
      state.searchOpen = true;
      focusSearch = true;
      renderList();
    };
  }
  const search = document.getElementById("searchInput");
  if (search) {
    search.oninput = () => {
      state.query = search.value;
      if (document.getElementById("grid")) refreshGrid();
    };
    search.onkeydown = (e) => {
      if (e.key === "Escape") {
        state.query = "";
        state.searchOpen = false;
        renderList();
      }
    };
  }
  document.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.onclick = () => {
      state.filter = btn.dataset.filter === "favorite" ? "favorite" : "all";
      renderList();
    };
  });
  const sortBtn = document.getElementById("sortBtn");
  if (sortBtn) {
    sortBtn.onclick = () => {
      state.sort = state.sort === "updatedDesc" ? "updatedAsc" : "updatedDesc";
      if (document.getElementById("grid")) {
        sortBtn.setAttribute("aria-label", state.sort === "updatedAsc" ? "依修改日期排序，目前由舊到新" : "依修改日期排序，目前由新到舊");
        sortBtn.innerHTML = `${icon(state.sort === "updatedAsc" ? "sortUp" : "sortDown", 16)} 修改日期`;
        refreshGrid();
      } else renderList();
    };
  }
  const layoutBtn = document.getElementById("layoutBtn");
  if (layoutBtn) {
    layoutBtn.onclick = () => {
      state.layout = state.layout === "grid" ? "list" : "grid";
      renderList();
    };
  }
  const clearTag = document.getElementById("clearTag");
  if (clearTag) clearTag.onclick = () => {
    state.activeTag = "";
    renderList();
  };
  const fab = document.getElementById("fab");
  if (fab) fab.onclick = () => openCreateSheet();
  document.querySelectorAll("[data-open-tag]").forEach((btn) => {
    btn.onclick = () => {
      state.nav = "home";
      state.activeTag = btn.dataset.openTag;
      renderList();
    };
  });
  document.querySelectorAll("[data-remove-tag]").forEach((btn) => {
    btn.onclick = () => {
      const tag = btn.dataset.removeTag;
      showDialog({
        title: "移除標籤？",
        body: `「${tag}」會從標籤清單和相關畫布移除。畫布本身會保留。`,
        confirm: "移除",
        danger: true,
        onConfirm: () => removeTag(tag),
      });
    };
  });
}

function refreshGrid() {
  if (!document.getElementById("grid")) {
    renderList();
    return;
  }
  mountCards(visibleNotes());
}

function mountCards(notes) {
  const grid = document.getElementById("grid");
  if (!grid) return;
  grid.classList.toggle("list", state.layout === "list");
  if (!notes.length) {
    const [heading, detail] = emptyCopy();
    grid.innerHTML = `<div class="empty-state"><h2>${escapeHtml(heading)}</h2><p>${escapeHtml(detail)}</p></div>`;
    return;
  }
  grid.replaceChildren();
  for (const n of notes) {
    const card = document.createElement("article");
    card.className = "note-card";
    const title = n.title || "未命名畫布";
    card.innerHTML = `
      <div class="note-main">
        <div class="note-top">
          <time>${escapeHtml(fmtCardDate(n.updatedAt || n.createdAt))}</time>
          <button class="more-btn" type="button" data-menu="${escapeAttr(n.id)}" aria-label="更多" aria-haspopup="menu">${icon("more", 18)}</button>
        </div>
        <h3 class="note-title" title="${escapeAttr(title)}">${n.favorite ? `<span class="star">${icon("starFill", 14)}</span>` : ""}${escapeHtml(title)}</h3>
      </div>
      <div class="note-thumb"></div>`;
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-menu]")) return;
      openNote(n.id);
    });
    card.querySelector("[data-menu]").addEventListener("click", (e) => {
      e.stopPropagation();
      openCardMenu(n, e.currentTarget);
    });
    grid.appendChild(card);
    paintThumb(card.querySelector(".note-thumb"), n.id);
  }
}

async function paintThumb(el, noteId) {
  try {
    const { pages } = await db.getNote(noteId);
    const page = pages && pages[0];
    if (!page || !el.isConnected) return;
    const w = el.clientWidth || 240;
    const h = el.clientHeight || Math.round((el.clientWidth || 240) * 0.72);
    const c = document.createElement("canvas");
    c.width = w * 2;
    c.height = h * 2;
    const ctx = c.getContext("2d");
    ctx.scale(2, 2);
    ctx.fillStyle = "#fffaf1";
    ctx.fillRect(0, 0, w, h);
    const rect = fitRect(page.aspect || 4 / 3, w, h);
    await drawPageToContext(ctx, page, rect.x, rect.y, rect.w, rect.h, true);
    if (!el.isConnected) return;
    el.replaceChildren(c);
  } catch (err) {
    console.error(err);
  }
}

function openCardMenu(note, btn) {
  closeMenus();
  btn.setAttribute("aria-expanded", "true");
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  const inTrash = !!note.trashedAt;
  menu.innerHTML = inTrash
    ? `<button type="button" data-act="open">打開</button>
       <button type="button" data-act="rename">重新命名</button>
       <button type="button" data-act="restore">還原</button>
       <button type="button" data-act="export">匯出 PDF</button>
       <button type="button" data-act="forever" class="danger">永久刪除</button>`
    : `<button type="button" data-act="open">打開</button>
       <button type="button" data-act="rename">重新命名</button>
       <button type="button" data-act="fav">${note.favorite ? "取消收藏" : "加入收藏"}</button>
       <button type="button" data-act="tags">標籤</button>
       <button type="button" data-act="export">匯出 PDF</button>
       <button type="button" data-act="trash" class="danger">移到資源回收桶</button>`;
  document.body.appendChild(menu);
  const rect = btn.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
  let left = rect.right - width;
  if (left < 8) left = 8;
  if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  menu.onclick = async (e) => {
    const button = e.target.closest("button");
    const act = button && button.dataset.act;
    if (!act) return;
    closeMenus();
    if (act === "open") openNote(note.id);
    if (act === "rename") renameNote(note);
    if (act === "fav") toggleFavorite(note);
    if (act === "tags") editNoteTags(note);
    if (act === "export") {
      const data = await db.getNote(note.id);
      if (data.note) await exportPdf(data.note, data.pages);
    }
    if (act === "trash") moveToTrash(note);
    if (act === "restore") restoreNote(note);
    if (act === "forever") confirmForeverDelete(note);
  };
  setTimeout(() => {
    const off = (ev) => {
      if (!menu.contains(ev.target)) {
        closeMenus();
        document.removeEventListener("pointerdown", off, true);
      }
    };
    document.addEventListener("pointerdown", off, true);
  }, 0);
}

function closeMenus() {
  document.querySelectorAll(".menu").forEach((m) => m.remove());
  document.querySelectorAll(".more-btn[aria-expanded='true']").forEach((el) => el.setAttribute("aria-expanded", "false"));
}

function openCreateSheet() {
  closeMenus();
  if (document.getElementById("createSheet")) return;
  const fab = document.getElementById("fab");
  if (fab) fab.setAttribute("aria-expanded", "true");
  const overlay = document.createElement("div");
  overlay.className = "overlay create-overlay";
  overlay.id = "createSheet";
  overlay.innerHTML = `
    <div class="create-sheet" role="dialog" aria-modal="true" aria-labelledby="createTitle" tabindex="-1">
      <div class="create-head">
        <h2 id="createTitle">開始使用吧</h2>
        <button class="create-close" type="button" data-close aria-label="關閉">${icon("x", 18)}</button>
      </div>
      <div class="create-tiles">
        <button class="create-tile" type="button" data-act="canvas">
          <span class="create-ico" aria-hidden="true">${icon("canvas", 36)}</span>
          <span class="create-copy"><span class="create-label">畫布</span></span>
        </button>
        <button class="create-tile" type="button" data-act="pdf">
          <span class="create-ico" aria-hidden="true">${icon("file", 36)}</span>
          <span class="create-copy">
            <span class="create-label">檔案與文件</span>
            <span class="create-sub">PDF</span>
          </span>
        </button>
      </div>
      <button class="create-row" type="button" data-act="photo">
        <span class="create-row-main">
          <span class="create-row-ico" aria-hidden="true">${icon("photo", 26)}</span>
          <span>照片</span>
        </span>
        <span class="create-row-sub">從裝置選擇照片</span>
      </button>
      <input id="createPdfInput" type="file" accept="application/pdf,.pdf" class="hidden" />
      <input id="createImageInput" type="file" accept="image/*" class="hidden" />
    </div>`;
  document.body.appendChild(overlay);
  const sheet = overlay.querySelector(".create-sheet");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeCreateSheet();
  });
  overlay.querySelector("[data-close]").onclick = () => closeCreateSheet();
  overlay.querySelector('[data-act="canvas"]').onclick = async () => {
    if (overlay.dataset.busy) return;
    overlay.dataset.busy = "1";
    closeCreateSheet();
    await createBlank();
  };
  const pdfInput = overlay.querySelector("#createPdfInput");
  const imageInput = overlay.querySelector("#createImageInput");
  overlay.querySelector('[data-act="pdf"]').onclick = () => {
    if (overlay.dataset.busy) return;
    pdfInput.click();
  };
  overlay.querySelector('[data-act="photo"]').onclick = () => {
    if (overlay.dataset.busy) return;
    imageInput.click();
  };
  pdfInput.onchange = () => takeCreateFile(pdfInput, "pdf");
  imageInput.onchange = () => takeCreateFile(imageInput, "image");
  sheet.focus();
}

function takeCreateFile(input, kind) {
  const file = input.files && input.files[0];
  input.value = "";
  if (!file) return;
  const overlay = document.getElementById("createSheet");
  if (overlay && overlay.dataset.busy) return;
  if (overlay) overlay.dataset.busy = "1";
  closeCreateSheet();
  createFromFile(file, kind);
}

function closeCreateSheet() {
  const overlay = document.getElementById("createSheet");
  if (!overlay) return false;
  overlay.remove();
  const fab = document.getElementById("fab");
  if (fab) fab.setAttribute("aria-expanded", "false");
  return true;
}

function isPdfFile(file) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
}

function isImageFile(file) {
  return file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|heic|heif)$/i.test(file.name || "");
}

async function createFromFile(file, kind) {
  if (kind === "pdf" && !isPdfFile(file)) {
    toast("請選擇 PDF 檔案");
    return;
  }
  if (kind === "image" && !isImageFile(file)) {
    toast("請選擇圖片");
    return;
  }
  if (kind === "pdf" && !window.pdfjsLib) {
    toast("PDF 元件載入失敗，請檢查網絡後再試。");
    return;
  }
  const created = newNote();
  state.note = created.note;
  state.pages = created.pages;
  state.pageIndex = 0;
  undoStack = [];
  redoStack = [];
  state.lasso = null;
  state.aiMessages = [];
  state.aiStatus = "";
  adoptedExcerpt = null;
  try {
    if (kind === "pdf") {
      toast("正在開啟 PDF…");
      await addPdf(file, true);
      if (!state.pages.length) throw new Error("empty pdf");
      state.note.sourceName = file.name;
      const title = file.name.replace(/\.pdf$/i, "").trim();
      state.note.title = title || "未命名畫布";
    } else {
      toast("正在開啟圖片…");
      await addImage(file, true);
      state.note.sourceName = file.name;
    }
    state.pageIndex = 0;
    state.note.updatedAt = Date.now();
    await db.putNote(state.note);
    await db.putPages(state.pages);
    state.view = "editor";
    state.save = "saved";
    state.lastSavedAt = state.note.updatedAt;
    viewZoom = 1;
    pinch = null;
    document.querySelectorAll(".toast").forEach((t) => t.remove());
    renderEditor();
  } catch (err) {
    console.error(err);
    state.note = null;
    state.pages = [];
    state.view = "list";
    toast(kind === "pdf" ? "無法讀取這份 PDF" : "無法讀取這張圖片");
    render();
  }
}

function renameNote(note) {
  askText({
    title: "重新命名",
    value: note.title || "",
    confirm: "儲存",
    onConfirm: async (title) => {
      note.title = title.trim() || "未命名畫布";
      note.updatedAt = Date.now();
      await db.putNote(note);
      renderList();
    },
  });
}

async function toggleFavorite(note) {
  note.favorite = !note.favorite;
  await db.putNote(note);
  refreshGrid();
}

async function moveToTrash(note) {
  note.trashedAt = Date.now();
  await db.putNote(note);
  toast("已移到資源回收桶");
  renderList();
}

async function restoreNote(note) {
  note.trashedAt = null;
  await db.putNote(note);
  toast("已還原");
  renderList();
}

function confirmForeverDelete(note) {
  showDialog({
    title: "永久刪除這塊畫布？",
    body: `「${note.title || "未命名畫布"}」會從這部裝置移除，無法還原。`,
    confirm: "永久刪除",
    danger: true,
    onConfirm: async () => {
      await db.deleteNote(note.id);
      toast("已永久刪除");
      await loadList();
    },
  });
}

async function removeTag(tag) {
  saveTagCatalog(loadTagCatalog().filter((t) => t !== tag));
  for (const note of state.notes) {
    if (noteTags(note).includes(tag)) {
      note.tags = noteTags(note).filter((t) => t !== tag);
      await db.putNote(note);
    }
  }
  if (state.activeTag === tag) state.activeTag = "";
  renderList();
}

function askText({ title, value = "", placeholder = "", confirm = "確定", onConfirm }) {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <form class="dialog">
      <h3>${escapeHtml(title)}</h3>
      <input class="text-input" id="textDialogInput" value="${escapeAttr(value)}" placeholder="${escapeAttr(placeholder)}" />
      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost" data-k="cancel">取消</button>
        <button type="submit" class="btn btn-primary">${escapeHtml(confirm)}</button>
      </div>
    </form>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector("#textDialogInput");
  input.focus();
  input.select();
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.dataset.k === "cancel") close();
  });
  overlay.querySelector("form").onsubmit = (e) => {
    e.preventDefault();
    const next = input.value;
    close();
    onConfirm(next);
  };
}

function editNoteTags(note) {
  const selected = new Set(noteTags(note));
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="dialog" role="dialog" aria-labelledby="tagDialogTitle">
      <h3 id="tagDialogTitle">標籤</h3>
      <p>只存在這部裝置上。</p>
      <div class="tag-checks"></div>
      <div class="tag-add-row">
        <input class="text-input" id="newTagInput" placeholder="新增標籤" />
        <button class="btn btn-ghost" id="addTagInline" type="button">加入</button>
      </div>
      <div class="dialog-actions">
        <button class="btn btn-ghost" type="button" data-k="cancel">取消</button>
        <button class="btn btn-primary" type="button" data-k="ok">完成</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const box = overlay.querySelector(".tag-checks");
  const extras = [];
  const renderChecks = () => {
    const tags = [...new Set([...allTags(), ...extras])];
    if (!tags.length) {
      box.innerHTML = `<p class="hint">還沒有標籤。可以在下面新增。</p>`;
      return;
    }
    box.innerHTML = tags.map((tag) => `
      <label class="tag-check">
        <input type="checkbox" value="${escapeAttr(tag)}" ${selected.has(tag) ? "checked" : ""} />
        <span>${escapeHtml(tag)}</span>
      </label>`).join("");
    box.querySelectorAll("input").forEach((input) => {
      input.onchange = () => {
        if (input.checked) selected.add(input.value);
        else selected.delete(input.value);
      };
    });
  };
  const addFromInput = () => {
    const tag = normalizeTag(overlay.querySelector("#newTagInput").value);
    if (!tag) return;
    if (!extras.includes(tag)) extras.push(tag);
    selected.add(tag);
    overlay.querySelector("#newTagInput").value = "";
    renderChecks();
  };
  renderChecks();
  overlay.querySelector("#addTagInline").onclick = addFromInput;
  overlay.querySelector("#newTagInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addFromInput();
    }
  });
  overlay.addEventListener("click", async (e) => {
    if (e.target === overlay || e.target.dataset.k === "cancel") {
      overlay.remove();
      return;
    }
    if (e.target.dataset.k === "ok") {
      try {
        note.tags = [...overlay.querySelectorAll(".tag-check input:checked")].map((input) => input.value);
        const catalog = loadTagCatalog();
        for (const tag of note.tags) if (!catalog.includes(tag)) catalog.push(tag);
        saveTagCatalog(catalog);
        await db.putNote(note);
      } catch (err) {
        console.error(err);
      }
      overlay.remove();
      renderList();
    }
  });
  overlay.querySelector("#newTagInput").focus();
}

function showDialog({ title, body, confirm, danger, onConfirm }) {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="dialog">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(body)}</p>
      <div class="dialog-actions">
        <button class="btn btn-ghost" data-k="cancel">取消</button>
        <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-k="ok">${escapeHtml(confirm)}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.dataset.k === "cancel") overlay.remove();
    if (e.target.dataset.k === "ok") {
      overlay.remove();
      onConfirm();
    }
  });
}

function toast(msg) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

/* ---------------- Editor ---------------- */
function renderEditor() {
  drawing = null;
  pinch = null;
  activeTouches.clear();
  scrollLock = null;
  const n = state.pages.length;
  const i = state.pageIndex + 1;
  const slots = state.pages.map((_, idx) => `
        <div class="page-slot" data-index="${idx}">
          <div class="paper">
            <canvas class="bg-canvas" draggable="false"></canvas>
            <canvas class="ink-canvas" draggable="false"></canvas>
            <div class="text-layer"></div>
            <svg class="lasso-layer" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"></svg>
            <button class="lasso-clear hidden" type="button">清除圈選</button>
          </div>
          <div class="page-caption">第 ${idx + 1} 頁</div>
        </div>`).join("");
  $app.innerHTML = `
    <div class="editor">
      <header class="topbar">
        <button class="page-btn" id="backBtn" aria-label="返回">${svg('<path d="M15 6l-6 6 6 6"/>', 20)}</button>
        <input class="title-input" id="titleInput" value="${escapeAttr(state.note.title || "")}" placeholder="未命名畫布" />
        <div class="save-status" id="saveStatus"></div>
        <button class="page-btn" id="uploadBtn">上載 PDF／圖片</button>
        <button class="page-btn" id="aiToggle" type="button" aria-expanded="${state.aiOpen ? "true" : "false"}" aria-controls="aiSide">助手</button>
        <button class="btn btn-primary" id="exportBtn">匯出 PDF</button>
        <input id="fileInput" type="file" accept="application/pdf,image/*" multiple class="hidden" />
      </header>
      <div class="stage${state.aiOpen ? " ai-open" : ""}">
        <aside class="tools" id="tools"></aside>
        <div class="board-wrap${state.fingerWrite ? " ink-lock" : ""}" id="boardWrap">
          <div class="page-list" id="pageList">${slots}</div>
        </div>
        ${aiSideMarkup()}
      </div>
      <footer class="statusbar">
        <div class="page-nav">
          <button class="page-btn" id="prevPage" ${state.pageIndex === 0 ? "disabled" : ""}>上一頁</button>
          <div class="page-indicator">第 ${i} / ${n} 頁</div>
          <button class="page-btn" id="nextPage" ${state.pageIndex >= n - 1 ? "disabled" : ""}>下一頁</button>
          <button class="page-btn" id="addPage">新增一頁</button>
        </div>
        <div class="lasso-hint" id="lassoHint"></div>
        <button class="page-btn lasso-clear-bar" id="clearLassoBtn" type="button">清除圈選</button>
      </footer>
    </div>
  `;
  renderTools();
  renderSaveStatus();
  bindEditor();
  layoutPages({ reveal: state.pageIndex });
}

function renderTools() {
  const tools = document.getElementById("tools");
  if (!tools) return;
  const items = [
    ["pen", "筆", '<path d="M4 20l3.5-1 11-11a2.1 2.1 0 0 0 0-3l-1.5-1.5a2.1 2.1 0 0 0-3 0l-11 11L4 20z"/>'],
    ["highlighter", "螢光筆", '<path d="M5 20h7l8-8-4-4-8 8v4z"/><path d="M13 8l4 4"/>'],
    ["eraser", "擦膠", '<path d="M5 15l7-7 6 6-7 7H8l-3-3z"/><path d="M10 10l6 6"/>'],
    ["lasso", "圈選", ICONS.lasso],
    ["text", "文字", '<path d="M5 6h14M12 6v14"/>'],
  ];
  const fingerOn = !!state.fingerWrite;
  const fingerBtn = `<button class="finger-toggle" id="fingerWriteBtn" type="button" aria-pressed="${fingerOn ? "true" : "false"}" aria-label="手指書寫，目前${fingerOn ? "開啟" : "關閉"}" title="手指書寫">
      ${svg(ICONS.hand, 26)}
      <span class="finger-name">手指書寫</span>
      <span class="finger-state">${fingerOn ? "開" : "關"}</span>
    </button><div class="sep"></div>`;
  tools.innerHTML = fingerBtn + items
    .map(
      ([id, label, path]) =>
        `<button class="tool ${state.tool === id ? "active" : ""}" data-tool="${id}" title="${label}" aria-label="${label}">${svg(path)}</button>`
    )
    .join("") + `<div class="sep"></div><div class="swatches">` +
    PEN_COLORS.map(
      (c) =>
        `<button class="swatch ${state.color === c.id ? "active" : ""}" data-color="${c.id}" style="background:${c.value}" title="${c.label}"></button>`
    ).join("") +
    `</div><div class="sep"></div><div class="widths">` +
    WIDTHS.map((w) => {
      const size = w.id === "s" ? 6 : w.id === "m" ? 10 : 14;
      return `<button class="width-dot ${state.width === w.id ? "active" : ""}" data-width="${w.id}" title="${w.label}"><span style="width:${size}px;height:${size}px"></span></button>`;
    }).join("") +
    `</div><div class="sep"></div>
     <button class="tool" id="undoBtn" title="復原">${svg('<path d="M8 8H4v4"/><path d="M4 12a8 8 0 1 0 2-5.3"/>')}</button>
     <button class="tool" id="redoBtn" title="重做">${svg('<path d="M16 8h4v4"/><path d="M20 12a8 8 0 1 1-2-5.3"/>')}</button>`;

  tools.querySelectorAll("[data-tool]").forEach((b) => {
    b.onclick = () => {
      state.tool = b.dataset.tool;
      renderTools();
      updateTextLayerPointer();
    };
  });
  tools.querySelectorAll("[data-color]").forEach((b) => {
    b.onclick = () => {
      state.color = b.dataset.color;
      if (state.tool === "eraser" || state.tool === "text") state.tool = "pen";
      renderTools();
    };
  });
  tools.querySelectorAll("[data-width]").forEach((b) => {
    b.onclick = () => {
      state.width = b.dataset.width;
      renderTools();
    };
  });
  document.getElementById("undoBtn").onclick = undo;
  document.getElementById("redoBtn").onclick = redo;
  document.getElementById("fingerWriteBtn").onclick = () => {
    state.fingerWrite = !state.fingerWrite;
    saveFingerWrite(state.fingerWrite);
    if (!state.fingerWrite && drawing && drawing.pointerType === "touch") {
      const prev = drawing;
      drawing = null;
      if (prev.mode === "lasso") paintLasso();
      else restoreInk(prev.index);
    }
    syncInkLock();
    renderTools();
  };
  updateLassoChrome();
}

function renderSaveStatus() {
  const el = document.getElementById("saveStatus");
  if (!el) return;
  el.className = "save-status " + state.save;
  if (state.save === "saving") el.textContent = "儲存中…";
  else if (state.save === "error") el.textContent = "儲存失敗";
  else el.textContent = state.lastSavedAt ? "已儲存 " + fmtTime(state.lastSavedAt).slice(11) : "已儲存";
}

function bindEditor() {
  document.getElementById("backBtn").onclick = async () => {
    if (drawing) commitDrawing();
    await saveCurrent();
    state.view = "list";
    penPointers.clear();
    activeTouches.clear();
    pinch = null;
    scrollLock = null;
    await loadList();
  };
  const title = document.getElementById("titleInput");
  title.onchange = title.onblur = () => {
    state.note.title = title.value.trim() || "未命名畫布";
    markDirty();
  };
  document.getElementById("uploadBtn").onclick = () => document.getElementById("fileInput").click();
  document.getElementById("fileInput").onchange = (e) => handleFiles(e.target.files);
  document.getElementById("exportBtn").onclick = () => exportPdf(state.note, state.pages);
  document.getElementById("prevPage").onclick = () => goPage(state.pageIndex - 1);
  document.getElementById("nextPage").onclick = () => goPage(state.pageIndex + 1);
  document.getElementById("addPage").onclick = () => {
    pushUndo();
    state.pages.push(blankPage(state.note.id, state.pages.length));
    state.pageIndex = state.pages.length - 1;
    markDirty();
    renderEditor();
  };
  document.getElementById("aiToggle").onclick = () => setAiOpen(!state.aiOpen);
  document.getElementById("clearLassoBtn").onclick = () => clearLasso();
  bindAiSide();
  setupDrawing();
}

function updatePageChrome() {
  const n = state.pages.length;
  const i = state.pageIndex;
  const ind = document.querySelector(".page-indicator");
  if (ind) ind.textContent = `第 ${i + 1} / ${n} 頁`;
  const prev = document.getElementById("prevPage");
  const next = document.getElementById("nextPage");
  if (prev) prev.disabled = i <= 0;
  if (next) next.disabled = i >= n - 1;
  updateAiScope();
}

function slotAt(index) {
  return document.querySelector(`.page-slot[data-index="${index}"]`);
}

function pageIndexFromScroll() {
  const wrap = document.getElementById("boardWrap");
  if (!wrap) return state.pageIndex;
  const slots = [...wrap.querySelectorAll(".page-slot")];
  if (!slots.length) return 0;
  const view = wrap.getBoundingClientRect();
  const mid = view.top + wrap.clientHeight * 0.35;
  let best = Number(slots[0].dataset.index) || 0;
  let bestDist = Infinity;
  for (const slot of slots) {
    const r = slot.getBoundingClientRect();
    if (r.bottom > view.top + 8 && r.top < mid && r.bottom > mid) return Number(slot.dataset.index);
    const dist = Math.abs(r.top + r.height * 0.35 - mid);
    if (dist < bestDist) {
      bestDist = dist;
      best = Number(slot.dataset.index);
    }
  }
  return best;
}

async function goPage(i) {
  if (i < 0 || i >= state.pages.length) return;
  state.pageIndex = i;
  updatePageChrome();
  const slot = slotAt(i);
  if (slot) slot.scrollIntoView({ block: "start" });
}

function boardFitWidth(wrap) {
  const cs = getComputedStyle(wrap);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  return Math.max(280, Math.floor(wrap.clientWidth - padX - 2));
}

function sizePages(resizeBitmap) {
  const wrap = document.getElementById("boardWrap");
  if (!wrap) return;
  const fitW = boardFitWidth(wrap);
  const screenDpr = Math.min(window.devicePixelRatio || 1, 2.5);
  document.querySelectorAll(".page-slot").forEach((slot) => {
    const index = Number(slot.dataset.index);
    const page = state.pages[index];
    const paper = slot.querySelector(".paper");
    if (!page || !paper) return;
    const aspect = page.aspect || 4 / 3;
    const w = Math.max(1, Math.round(fitW * viewZoom));
    const h = Math.max(1, Math.round(w / aspect));
    paper.style.width = w + "px";
    paper.style.height = h + "px";
    if (!resizeBitmap) return;
    let dpr = screenDpr;
    const longEdge = Math.max(w, h);
    if (longEdge * dpr > 3200) dpr = Math.max(1, 3200 / longEdge);
    for (const c of paper.querySelectorAll("canvas")) {
      const bw = Math.max(1, Math.round(w * dpr));
      const bh = Math.max(1, Math.round(h * dpr));
      if (c.width !== bw || c.height !== bh) {
        c.width = bw;
        c.height = bh;
      }
      c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  });
  wrap.classList.toggle("zoomed", viewZoom > 1.01);
}

function layoutPages(opts) {
  const wrap = document.getElementById("boardWrap");
  if (!wrap) return;
  sizePages(true);
  sizePages(true);
  const jobs = state.pages.map((_, index) => paintPaper(index));
  renderTextBoxes();
  syncInkLock();
  paintLasso();
  updateAiScope();
  if (opts && opts.reveal != null) {
    const slot = slotAt(opts.reveal);
    if (slot) slot.scrollIntoView({ block: "start" });
  }
  return Promise.all(jobs);
}

async function paintPaper(index) {
  const slot = slotAt(index);
  const page = state.pages[index];
  if (!slot || !page) return;
  const bg = slot.querySelector(".bg-canvas");
  const ink = slot.querySelector(".ink-canvas");
  if (!bg || !ink) return;
  const w = bg.clientWidth;
  const h = bg.clientHeight;
  if (w < 2 || h < 2) return;
  const token = (paintToken.get(index) || 0) + 1;
  paintToken.set(index, token);
  const bctx = bg.getContext("2d");
  const ictx = ink.getContext("2d");
  if (!(drawing && drawing.index === index && drawing.mode === "draw")) {
    ictx.clearRect(0, 0, w, h);
    drawStrokes(ictx, page.strokes, w, h);
  }
  bctx.clearRect(0, 0, w, h);
  await drawPageToContext(bctx, page, 0, 0, w, h, false);
  if (paintToken.get(index) !== token) return;
}

function restoreInk(index) {
  const slot = slotAt(index);
  const page = state.pages[index];
  if (!slot || !page) return;
  const ink = slot.querySelector(".ink-canvas");
  if (!ink) return;
  const ctx = ink.getContext("2d");
  const w = ink.clientWidth;
  const h = ink.clientHeight;
  ctx.clearRect(0, 0, w, h);
  drawStrokes(ctx, page.strokes, w, h);
}

async function redrawPage() {
  await paintPaper(state.pageIndex);
}

async function drawPageToContext(ctx, page, x, y, w, h, includeInk) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = "#fffaf1";
  ctx.fillRect(x, y, w, h);

  if (page.backgroundType === "image" && page.backgroundId) {
    const url = await getBgUrl(page);
    if (url) {
      const img = await loadImage(url);
      ctx.drawImage(img, x, y, w, h);
    }
  } else if (page.backgroundType === "pdf" && page.backgroundId != null) {
    const canvas = await renderPdfPage(page);
    if (canvas) ctx.drawImage(canvas, x, y, w, h);
  } else {
    // subtle ruling
    ctx.strokeStyle = "rgba(44,58,50,0.06)";
    ctx.lineWidth = 1;
    const step = h / 22;
    for (let yy = y + step * 2; yy < y + h; yy += step) {
      ctx.beginPath();
      ctx.moveTo(x + 16, yy);
      ctx.lineTo(x + w - 16, yy);
      ctx.stroke();
    }
  }

  if (includeInk) drawStrokes(ctx, page.strokes, w, h, x, y);
  if (includeInk && page.textBoxes) {
    ctx.fillStyle = "#1a1a1a";
    ctx.font = `${Math.max(14, w * 0.025)}px "Noto Sans TC", sans-serif`;
    for (const t of page.textBoxes) {
      const lines = String(t.text || "").split("\n");
      lines.forEach((line, i) => {
        ctx.fillStyle = t.color || "#1a1a1a";
        ctx.fillText(line, x + t.x * w, y + t.y * h + 20 + i * 24);
      });
    }
  }
  ctx.restore();
}

function drawStrokes(ctx, strokes, w, h, ox = 0, oy = 0) {
  if (!strokes) return;
  for (const s of strokes) {
    if (!s.points || s.points.length < 1) continue;
    ctx.save();
    if (s.tool === "highlighter") {
      ctx.globalCompositeOperation = "multiply";
      ctx.strokeStyle = s.color || "#ffe14a";
      ctx.globalAlpha = 0.45;
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = s.color || "#1a1a1a";
      ctx.globalAlpha = 1;
    }
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const pts = s.points;
    if (pts.length === 1) {
      const r = (s.width || 4) * (pts[0].p || 0.6) * 0.5;
      ctx.beginPath();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.arc(ox + pts[0].x * w, oy + pts[0].y * h, Math.max(0.8, r), 0, Math.PI * 2);
      ctx.fill();
    } else {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const width = (s.width || 4) * (((a.p || 0.6) + (b.p || 0.6)) / 2);
        ctx.lineWidth = Math.max(0.8, width);
        ctx.beginPath();
        ctx.moveTo(ox + a.x * w, oy + a.y * h);
        ctx.quadraticCurveTo(ox + a.x * w, oy + a.y * h, ox + midX * w, oy + midY * h);
        ctx.stroke();
      }
      // last segment to final point
      const a = pts[pts.length - 2];
      const b = pts[pts.length - 1];
      ctx.lineWidth = Math.max(0.8, (s.width || 4) * (b.p || 0.6));
      ctx.beginPath();
      ctx.moveTo(ox + ((a.x + b.x) / 2) * w, oy + ((a.y + b.y) / 2) * h);
      ctx.lineTo(ox + b.x * w, oy + b.y * h);
      ctx.stroke();
    }
    ctx.restore();
  }
}

async function getBgUrl(page) {
  if (page._url) return page._url;
  const blob = await getFileBlob(page.backgroundId);
  if (!blob) return null;
  page._url = URL.createObjectURL(blob);
  return page._url;
}

async function getFileBlob(id) {
  if (!id) return null;
  if (fileCache.has(id)) return fileCache.get(id);
  const blob = await db.getFile(id);
  if (blob) fileCache.set(id, blob);
  return blob;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

async function renderPdfPage(page) {
  const key = page.backgroundId + ":" + page.pdfPage;
  if (bgCache.has(key)) return bgCache.get(key);
  const blob = await getFileBlob(page.backgroundId);
  if (!blob || !window.pdfjsLib) return null;
  const buf = await blob.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const p = await pdf.getPage(page.pdfPage);
  const viewport = p.getViewport({ scale: 2 });
  const c = document.createElement("canvas");
  c.width = viewport.width;
  c.height = viewport.height;
  await p.render({ canvasContext: c.getContext("2d"), viewport }).promise;
  bgCache.set(key, c);
  return c;
}

/* ---------------- Drawing ---------------- */
function penGuardActive() {
  return penPointers.size > 0 || (lastPenAt > 0 && Date.now() - lastPenAt < PALM_MS);
}

function wantsInk(e) {
  if (!e) return false;
  if (e.pointerType === "pen") return true;
  if (e.pointerType === "mouse") return e.button === 0;
  if (e.pointerType === "touch") {
    if (penGuardActive()) return false;
    return !!state.fingerWrite;
  }
  return false;
}

function inBoard(e) {
  return !!(e.target && e.target.closest && e.target.closest("#boardWrap"));
}

function isFieldTarget(e) {
  return !!(e.target && e.target.closest && e.target.closest("textarea, input"));
}

function syncInkLock() {
  const wrap = document.getElementById("boardWrap");
  if (wrap) {
    const lock = !!state.fingerWrite || penGuardActive() || !!pinch;
    wrap.classList.toggle("ink-lock", lock);
    wrap.classList.toggle("zoomed", viewZoom > 1.01);
  }
  if (penPointers.size > 0) {
    const board = document.getElementById("boardWrap");
    if (board && !scrollLock) scrollLock = { top: board.scrollTop, left: board.scrollLeft };
  } else {
    scrollLock = null;
  }
  clearTimeout(palmTimer);
  if (penPointers.size === 0 && lastPenAt && Date.now() - lastPenAt < PALM_MS) {
    palmTimer = setTimeout(() => {
      if (state.view === "editor") syncInkLock();
    }, PALM_MS - (Date.now() - lastPenAt) + 40);
  }
}

function beginPinchIfReady() {
  if (pinch || state.fingerWrite || penGuardActive() || activeTouches.size < 2) return;
  const wrap = document.getElementById("boardWrap");
  if (!wrap) return;
  const pts = [...activeTouches.values()];
  const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  if (dist < 12) return;
  pinch = {
    dist0: dist,
    zoom0: viewZoom,
    midX0: (pts[0].x + pts[1].x) / 2,
    midY0: (pts[0].y + pts[1].y) / 2,
    scrollLeft0: wrap.scrollLeft,
    scrollTop0: wrap.scrollTop,
    holdLeft: wrap.scrollLeft,
    holdTop: wrap.scrollTop,
  };
  for (const id of activeTouches.keys()) {
    try { wrap.setPointerCapture(id); } catch { /* pointer already gone */ }
  }
  syncInkLock();
}

function applyPinch() {
  const wrap = document.getElementById("boardWrap");
  if (!wrap || !pinch || activeTouches.size < 2) return;
  const pts = [...activeTouches.values()];
  const dist = Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
  const midX = (pts[0].x + pts[1].x) / 2;
  const midY = (pts[0].y + pts[1].y) / 2;
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinch.zoom0 * (dist / pinch.dist0)));
  const rect = wrap.getBoundingClientRect();
  const localX = pinch.midX0 - rect.left;
  const localY = pinch.midY0 - rect.top;
  const contentX = (pinch.scrollLeft0 + localX) / (pinch.zoom0 || 1);
  const contentY = (pinch.scrollTop0 + localY) / (pinch.zoom0 || 1);
  viewZoom = next;
  sizePages(false);
  adjustingScroll = true;
  wrap.scrollLeft = contentX * next - localX - (midX - pinch.midX0);
  wrap.scrollTop = contentY * next - localY - (midY - pinch.midY0);
  adjustingScroll = false;
  pinch.holdLeft = wrap.scrollLeft;
  pinch.holdTop = wrap.scrollTop;
  wrap.classList.toggle("zoomed", viewZoom > 1.01);
}

function setupDrawing() {
  const wrap = document.getElementById("boardWrap");
  if (!wrap) return;
  ensureGlobalPointers();
  wrap.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest(".lasso-clear")) {
      e.preventDefault();
      clearLasso();
    }
  });
  wrap.addEventListener("pointerdown", onBoardPointerDown, { capture: true, passive: false });
  wrap.addEventListener("pointermove", onBoardPointerMove, { capture: true, passive: false });
  wrap.addEventListener("contextmenu", (e) => {
    if (isFieldTarget(e)) return;
    e.preventDefault();
  });
  wrap.addEventListener("selectstart", (e) => {
    if (isFieldTarget(e)) return;
    e.preventDefault();
  });
  wrap.addEventListener("dragstart", (e) => e.preventDefault());
  wrap.addEventListener("touchstart", onBoardTouchStart, { passive: false });
  wrap.addEventListener("scroll", onBoardScroll, { passive: true });
  updateTextLayerPointer();
}

function ensureGlobalPointers() {
  if (globalPointerBound) return;
  globalPointerBound = true;
  window.addEventListener("pointerup", onGlobalPointerEnd, true);
  window.addEventListener("pointercancel", onGlobalPointerEnd, true);
}

function onBoardScroll() {
  const wrap = document.getElementById("boardWrap");
  if (!wrap || adjustingScroll) return;
  if (penPointers.size > 0 && scrollLock) {
    if (wrap.scrollTop !== scrollLock.top || wrap.scrollLeft !== scrollLock.left) {
      adjustingScroll = true;
      wrap.scrollTop = scrollLock.top;
      wrap.scrollLeft = scrollLock.left;
      adjustingScroll = false;
    }
    return;
  }
  if (pinch && pinch.holdTop != null) {
    if (wrap.scrollTop !== pinch.holdTop || wrap.scrollLeft !== pinch.holdLeft) {
      adjustingScroll = true;
      wrap.scrollTop = pinch.holdTop;
      wrap.scrollLeft = pinch.holdLeft;
      adjustingScroll = false;
    }
    return;
  }
  const idx = pageIndexFromScroll();
  if (idx !== state.pageIndex) {
    state.pageIndex = idx;
    updatePageChrome();
  }
}

function onBoardTouchStart(e) {
  if (isFieldTarget(e)) return;
  const stylus = [...e.touches].some((t) => t.touchType === "stylus");
  if (stylus) {
    lastPenAt = Date.now();
    syncInkLock();
    if (e.cancelable) e.preventDefault();
    return;
  }
  if (state.fingerWrite || penGuardActive() || e.touches.length >= 2) {
    if (e.cancelable) e.preventDefault();
  }
}

function updateTextLayerPointer() {
  const textMode = state.tool === "text";
  document.querySelectorAll(".page-slot").forEach((slot) => {
    const layer = slot.querySelector(".text-layer");
    const canvas = slot.querySelector(".ink-canvas");
    if (!layer || !canvas) return;
    layer.style.pointerEvents = textMode ? "auto" : "none";
    canvas.style.pointerEvents = textMode ? "none" : "auto";
    layer.style.cursor = textMode ? "text" : "";
    canvas.style.cursor = state.tool === "lasso" ? "crosshair" : "";
  });
}

function canvasPoint(e, canvas) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) / r.width,
    y: (e.clientY - r.top) / r.height,
    p: e.pressure && e.pressure > 0 ? e.pressure : 0.6,
  };
}

function onBoardPointerDown(e) {
  if (state.view !== "editor" || !inBoard(e) || isFieldTarget(e)) return;
  if (e.target.closest && e.target.closest(".lasso-clear")) return;

  if (e.pointerType === "pen") {
    penPointers.add(e.pointerId);
    lastPenAt = Date.now();
    syncInkLock();
    if (e.cancelable) e.preventDefault();
  } else if (e.pointerType === "touch") {
    activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    beginPinchIfReady();
    if ((wantsInk(e) || pinch) && e.cancelable) e.preventDefault();
  } else if (e.pointerType === "mouse" && e.button === 0 && state.tool !== "text") {
    if (e.cancelable) e.preventDefault();
  }

  if (state.tool === "text") {
    if (e.target.classList && e.target.classList.contains("text-layer") && wantsInk(e)) {
      textGesture.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    return;
  }
  if (!wantsInk(e) || pinch) return;
  const canvas = e.target.closest && e.target.closest(".ink-canvas");
  if (!canvas) return;
  startInk(e, canvas);
}

function onBoardPointerMove(e) {
  if (e.pointerType === "touch" && activeTouches.has(e.pointerId)) {
    activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }
  if (e.pointerType === "pen" && (penPointers.has(e.pointerId) || e.buttons > 0)) {
    if (e.buttons > 0) penPointers.add(e.pointerId);
    if (penPointers.has(e.pointerId)) lastPenAt = Date.now();
  }
  if (!pinch && e.pointerType === "touch") beginPinchIfReady();
  if (pinch && activeTouches.size >= 2) {
    if (e.cancelable) e.preventDefault();
    applyPinch();
    return;
  }
  if (!drawing || drawing.pointerId !== e.pointerId || state.view !== "editor") return;
  extendInk(e);
}

function onGlobalPointerEnd(e) {
  const wasPen = penPointers.delete(e.pointerId);
  if (wasPen) lastPenAt = Date.now();
  activeTouches.delete(e.pointerId);
  const gesture = textGesture.get(e.pointerId);
  textGesture.delete(e.pointerId);
  if (pinch && activeTouches.size < 2) {
    pinch = null;
    if (state.view === "editor") {
      sizePages(true);
      state.pages.forEach((_, index) => paintPaper(index));
    }
  }
  if (state.view === "editor") syncInkLock();
  if (gesture && state.view === "editor" && state.tool === "text") maybePlaceText(e);
  if (!drawing || drawing.pointerId !== e.pointerId) return;
  commitDrawing();
}

function maybePlaceText(e) {
  if (!wantsInk(e)) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el || !el.classList || !el.classList.contains("text-layer")) return;
  const slot = el.closest(".page-slot");
  if (!slot) return;
  const index = Number(slot.dataset.index);
  const rec = el.getBoundingClientRect();
  if (!rec.width || !rec.height) return;
  state.pageIndex = index;
  updatePageChrome();
  addTextBox((e.clientX - rec.left) / rec.width, (e.clientY - rec.top) / rec.height, index);
}

function startInk(e, canvas) {
  if (state.tool === "lasso") {
    beginLasso(e, canvas);
    return;
  }
  if (drawing && drawing.pointerId !== e.pointerId) {
    if (e.pointerType !== "pen") return;
    const prev = drawing.index;
    drawing = null;
    restoreInk(prev);
  }
  const slot = canvas.closest(".page-slot");
  if (!slot) return;
  const index = Number(slot.dataset.index);
  const page = state.pages[index];
  if (!page) return;
  state.pageIndex = index;
  updatePageChrome();
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic or unsupported */ }
  const pt = canvasPoint(e, canvas);
  if (state.tool === "eraser") {
    drawing = {
      mode: "erase",
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      index,
      page,
      canvas,
      erased: false,
    };
    if (eraseAt(page, pt)) {
      drawing.erased = true;
      paintPaper(index);
    }
    return;
  }
  const color = state.tool === "highlighter" ? "#ffe14a" : PEN_COLORS.find((c) => c.id === state.color).value;
  const widthSpec = WIDTHS.find((w) => w.id === state.width) || WIDTHS[1];
  const width = state.tool === "highlighter" ? widthSpec.high : widthSpec.pen;
  drawing = {
    mode: "draw",
    pointerId: e.pointerId,
    pointerType: e.pointerType,
    index,
    page,
    canvas,
    stroke: { id: uid(), tool: state.tool, color, width, points: [pt] },
  };
  drawStrokes(canvas.getContext("2d"), [drawing.stroke], canvas.clientWidth, canvas.clientHeight);
}

function extendInk(e) {
  if (e.cancelable) e.preventDefault();
  if (drawing.mode === "lasso") {
    const pt = normPoint(canvasPoint(e, drawing.canvas));
    const pts = drawing.points;
    const last = pts[pts.length - 1];
    const dx = pt.x - last.x;
    const dy = pt.y - last.y;
    if (dx * dx + dy * dy < 0.00002) return;
    pts.push(pt);
    paintLasso({ index: drawing.index, points: pts });
    return;
  }
  const canvas = drawing.canvas;
  if (!canvas || !drawing.page) return;
  const pt = canvasPoint(e, canvas);
  if (drawing.mode === "erase") {
    if (eraseAt(drawing.page, pt)) {
      drawing.erased = true;
      paintPaper(drawing.index);
    }
    return;
  }
  const pts = drawing.stroke.points;
  const last = pts[pts.length - 1];
  const dx = pt.x - last.x;
  const dy = pt.y - last.y;
  if (dx * dx + dy * dy < 0.0000004) return;
  pts.push(pt);
  const ink = canvas.getContext("2d");
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ink.save();
  if (drawing.stroke.tool === "highlighter") {
    ink.globalCompositeOperation = "multiply";
    ink.strokeStyle = drawing.stroke.color;
    ink.globalAlpha = 0.45;
  } else {
    ink.strokeStyle = drawing.stroke.color;
  }
  ink.lineCap = "round";
  ink.lineJoin = "round";
  ink.lineWidth = Math.max(0.8, drawing.stroke.width * (((last.p || 0.6) + (pt.p || 0.6)) / 2));
  ink.beginPath();
  ink.moveTo(last.x * w, last.y * h);
  ink.lineTo(pt.x * w, pt.y * h);
  ink.stroke();
  ink.restore();
}

function commitDrawing() {
  const d = drawing;
  drawing = null;
  if (!d || state.view !== "editor") return;
  try { d.canvas.releasePointerCapture(d.pointerId); } catch { /* not captured */ }
  if (d.mode === "lasso") {
    finishLasso(d);
    return;
  }
  if (!d.page) return;
  if (d.mode === "erase") {
    if (d.erased) markDirty();
    return;
  }
  if (!d.stroke || !d.stroke.points.length) return;
  pushUndo();
  d.page.strokes = d.page.strokes.concat(d.stroke);
  markDirty();
  paintPaper(d.index);
}

function eraseAt(page, pt, radius = 0.018) {
  const hit = page.strokes.some((s) =>
    s.points.some((p) => {
      const dx = p.x - pt.x;
      const dy = p.y - pt.y;
      return dx * dx + dy * dy <= radius * radius;
    })
  );
  if (!hit) return false;
  if (drawing && !drawing.snapped) {
    pushUndo();
    drawing.snapped = true;
  }
  page.strokes = page.strokes.filter((s) => {
    return !s.points.some((p) => {
      const dx = p.x - pt.x;
      const dy = p.y - pt.y;
      return dx * dx + dy * dy <= radius * radius;
    });
  });
  return true;
}

function snapshot() {
  return JSON.parse(JSON.stringify({
    pages: state.pages,
    pageIndex: state.pageIndex,
    noteTitle: state.note && state.note.title,
  }));
}

function applySnap(s) {
  state.pages = s.pages;
  state.pageIndex = s.pageIndex;
  if (state.note) state.note.title = s.noteTitle;
  if (state.lasso && !state.pages[state.lasso.pageIndex]) state.lasso = null;
  renderEditor();
}

function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  applySnap(undoStack.pop());
  markDirty();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  applySnap(redoStack.pop());
  markDirty();
}

function renderTextBoxes(onlyIndex) {
  const indices = onlyIndex == null ? state.pages.map((_, i) => i) : [onlyIndex];
  for (const index of indices) {
    const slot = slotAt(index);
    const page = state.pages[index];
    if (!slot || !page) continue;
    const layer = slot.querySelector(".text-layer");
    if (!layer) continue;
    layer.innerHTML = "";
    for (const box of page.textBoxes || []) {
      const el = document.createElement("textarea");
      el.className = "text-box";
      el.value = box.text || "";
      el.style.left = box.x * 100 + "%";
      el.style.top = box.y * 100 + "%";
      el.style.width = (box.w || 0.28) * 100 + "%";
      el.style.color = box.color || "#1a1a1a";
      el.addEventListener("input", () => {
        box.text = el.value;
        markDirty();
      });
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      layer.appendChild(el);
    }
  }
  updateTextLayerPointer();
}

function addTextBox(x, y, index = state.pageIndex) {
  const page = state.pages[index];
  if (!page) return;
  if (!page.textBoxes) page.textBoxes = [];
  pushUndo();
  const color = PEN_COLORS.find((c) => c.id === state.color).value;
  page.textBoxes.push({ id: uid(), x, y, w: 0.3, text: "", color });
  markDirty();
  renderTextBoxes(index);
  const slot = slotAt(index);
  const boxes = slot ? slot.querySelectorAll("textarea") : [];
  const last = boxes[boxes.length - 1];
  if (last) last.focus();
}

/* ---------------- Files ---------------- */
async function handleFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  document.getElementById("fileInput").value = "";
  pushUndo();
  let firstNew = state.pages.length;
  const page = currentPage();
  const isEmpty =
    page &&
    page.backgroundType === "blank" &&
    !page.strokes.length &&
    !page.textBoxes.length &&
    state.pages.length === 1;

  for (const file of files) {
    if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
      await addPdf(file, isEmpty && file === files[0]);
      if (!state.note.sourceName) state.note.sourceName = file.name;
      if (state.note.title === "未命名畫布") state.note.title = file.name.replace(/\.pdf$/i, "");
    } else if (file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|heic)$/i.test(file.name)) {
      await addImage(file, isEmpty && file === files[0] && files.length === 1);
      if (!state.note.sourceName) state.note.sourceName = file.name;
    } else {
      toast("暫未支援呢種檔案：" + file.name);
    }
  }
  if (isEmpty) firstNew = 0;
  state.pageIndex = Math.min(firstNew, state.pages.length - 1);
  markDirty();
  await saveCurrent();
  renderEditor();
}

async function addPdf(file, replaceFirst) {
  const fileId = uid();
  await db.putFile(fileId, file);
  fileCache.set(fileId, file);
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const newPages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    const v = p.getViewport({ scale: 1 });
    newPages.push({
      ...blankPage(state.note.id, 0),
      aspect: v.width / v.height,
      backgroundType: "pdf",
      backgroundId: fileId,
      pdfPage: i,
    });
  }
  if (replaceFirst) state.pages = newPages;
  else {
    newPages.forEach((p, idx) => {
      p.index = state.pages.length + idx;
    });
    state.pages = state.pages.concat(newPages);
  }
  reindexPages();
}

async function addImage(file, replaceFirst) {
  const fileId = uid();
  await db.putFile(fileId, file);
  fileCache.set(fileId, file);
  const url = URL.createObjectURL(file);
  const img = await loadImage(url);
  const page = {
    ...blankPage(state.note.id, 0),
    aspect: img.width / img.height,
    backgroundType: "image",
    backgroundId: fileId,
  };
  page._url = url;
  if (replaceFirst) state.pages = [page];
  else {
    page.index = state.pages.length;
    state.pages.push(page);
  }
  reindexPages();
}

function reindexPages() {
  state.pages.forEach((p, i) => {
    p.index = i;
    p.noteId = state.note.id;
  });
}

/* ---------------- Export ---------------- */
async function exportPdf(note, pages) {
  if (!window.jspdf) {
    toast("匯出元件載入失敗，請檢查網絡後再試。");
    return;
  }
  toast("正在匯出 PDF…");
  try {
    const { jsPDF } = window.jspdf;
    let doc = null;
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const aspect = page.aspect || 4 / 3;
      // A-ish size in points; width 595 for portrait-ish, adapt
      const long = 842;
      const short = 595;
      const landscape = aspect >= 1;
      const wPt = landscape ? long : short;
      const hPt = landscape ? Math.round(wPt / aspect) : Math.round(wPt / aspect);
      const cssW = 1400;
      const cssH = Math.round(cssW / aspect);
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = cssW * scale;
      canvas.height = cssH * scale;
      const ctx = canvas.getContext("2d");
      ctx.scale(scale, scale);
      await drawPageToContext(ctx, page, 0, 0, cssW, cssH, true);
      const img = canvas.toDataURL("image/jpeg", 0.92);
      if (!doc) doc = new jsPDF({ orientation: landscape ? "landscape" : "portrait", unit: "pt", format: [wPt, hPt] });
      else doc.addPage([wPt, hPt], landscape ? "landscape" : "portrait");
      doc.addImage(img, "JPEG", 0, 0, wPt, hPt);
    }
    const name = (note.title || "畫布").replace(/[\\/:*?"<>|]/g, "_") + ".pdf";
    doc.save(name);
    toast("已匯出 PDF");
  } catch (err) {
    console.error(err);
    toast("匯出失敗，請再試一次。");
  }
}

/* ---------------- Lasso + assistant ---------------- */
const AI_SETTINGS_KEY = "huabu-ai-settings";
const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";
const DEEPSEEK_CHAT_URL = "https://api.deepseek.com/chat/completions";
const TESS_LANG_PATH = "https://tessdata.projectnaptha.com/4.0.0_fast";

let previewToken = 0;
let previewSession = null;
let previewOpening = false;
let ocrWorkerPromise = null;
let ocrStatus = () => {};
let aiBusy = false;
let adoptedExcerpt = null;

function normPoint(pt) {
  return {
    x: Math.min(1, Math.max(0, pt.x)),
    y: Math.min(1, Math.max(0, pt.y)),
  };
}

function boundsOf(points) {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    area += p.x * q.y - q.x * p.y;
  }
  return Math.abs(area) / 2;
}

function pointInPoly(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const yi = points[i].y;
    const yj = points[j].y;
    const intersect = yi > y !== yj > y && x < ((points[j].x - points[i].x) * (y - yi)) / ((yj - yi) || 1e-9) + points[i].x;
    if (intersect) inside = !inside;
  }
  return inside;
}

function simplifyPoints(points) {
  const out = [];
  for (const p of points) {
    const n = normPoint(p);
    const last = out[out.length - 1];
    if (!last || (n.x - last.x) ** 2 + (n.y - last.y) ** 2 >= 0.00004) out.push(n);
  }
  return out;
}

function currentScope() {
  if (state.lasso && state.pages[state.lasso.pageIndex]) {
    return { pageIndex: state.lasso.pageIndex, lasso: true, points: state.lasso.points };
  }
  if (!state.pages.length) return null;
  const pageIndex = Math.min(Math.max(state.pageIndex, 0), state.pages.length - 1);
  return { pageIndex, lasso: false, points: null };
}

function citationLabel(scope) {
  if (!scope) return "";
  return `第 ${scope.pageIndex + 1} 頁 · ${scope.lasso ? "圈選" : "整頁"}`;
}

function updateLassoChrome() {
  const btn = document.getElementById("clearLassoBtn");
  const hint = document.getElementById("lassoHint");
  const sideBtn = document.getElementById("aiClearLasso");
  const on = !!(state.lasso && state.pages[state.lasso.pageIndex]);
  if (btn) {
    btn.disabled = !on;
    btn.classList.toggle("is-hot", on);
    btn.title = on ? "清除圈選" : "目前沒有圈選";
  }
  if (sideBtn) {
    sideBtn.disabled = !on;
    sideBtn.classList.toggle("hot", on);
  }
  if (hint) {
    if (on) hint.textContent = `已圈選第 ${state.lasso.pageIndex + 1} 頁。按「清除圈選」即可取消。`;
    else if (state.tool === "lasso") hint.textContent = "用 S Pen 或滑鼠拖出範圍。手指仍可捲動，除非打開手指書寫。";
    else hint.textContent = "沒有圈選時，助手使用目前這一頁。";
  }
}

function paintLasso(live) {
  const liveIndex = live ? live.index : -1;
  document.querySelectorAll(".page-slot").forEach((slot) => {
    const index = Number(slot.dataset.index);
    const svg = slot.querySelector(".lasso-layer");
    const clearBtn = slot.querySelector(".lasso-clear");
    if (!svg) return;
    const livePoints = live && live.index === index ? live.points : null;
    const saved = state.lasso && state.lasso.pageIndex === index && index !== liveIndex ? state.lasso.points : null;
    const points = livePoints || saved;
    if (!points || points.length < 2) {
      svg.innerHTML = "";
      if (clearBtn) clearBtn.classList.add("hidden");
      return;
    }
    const pts = points.map((p) => `${(p.x * 100).toFixed(2)},${(p.y * 100).toFixed(2)}`).join(" ");
    svg.innerHTML = livePoints
      ? `<polyline points="${pts}" />`
      : `<polygon points="${pts}" />`;
    if (!clearBtn) return;
    if (!saved) {
      clearBtn.classList.add("hidden");
      return;
    }
    const bb = boundsOf(saved);
    clearBtn.classList.remove("hidden");
    clearBtn.style.left = `${Math.min(Math.max(bb.minX * 100, 1), 72)}%`;
    clearBtn.style.top = `${Math.min(Math.max(bb.minY * 100, 1), 86)}%`;
  });
  updateLassoChrome();
}

function beginLasso(e, canvas) {
  if (drawing && drawing.pointerId !== e.pointerId) {
    if (e.pointerType !== "pen") return;
    const prev = drawing;
    drawing = null;
    if (prev.mode === "lasso") paintLasso();
    else restoreInk(prev.index);
  }
  const slot = canvas.closest(".page-slot");
  if (!slot) return;
  const index = Number(slot.dataset.index);
  if (!state.pages[index]) return;
  state.pageIndex = index;
  updatePageChrome();
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic or unsupported */ }
  const pt = normPoint(canvasPoint(e, canvas));
  drawing = {
    mode: "lasso",
    pointerId: e.pointerId,
    pointerType: e.pointerType,
    index,
    canvas,
    points: [pt],
  };
  paintLasso({ index, points: drawing.points });
}

function finishLasso(d) {
  const pts = simplifyPoints(d.points || []);
  paintLasso();
  if (pts.length < 3 || polygonArea(pts) < 0.0015) {
    toast("圈選範圍太小，請再圈一次");
    paintLasso();
    return;
  }
  state.lasso = { pageIndex: d.index, points: pts };
  paintLasso();
  updateAiScope();
  setAiStatus(`已圈選${citationLabel(currentScope())}。按「清除圈選」可取消。`);
}

function clearLasso() {
  const had = !!(state.lasso || (drawing && drawing.mode === "lasso"));
  if (drawing && drawing.mode === "lasso") drawing = null;
  state.lasso = null;
  adoptedExcerpt = null;
  paintLasso();
  updateAiScope();
  if (had) setAiStatus("已清除圈選。沒有圈選時，助手使用目前這一頁。");
}

function scopeKey(scope) {
  const pts = scope && scope.lasso && scope.points
    ? scope.points.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(";")
    : "";
  return `${scope ? scope.pageIndex : -1}|${scope && scope.lasso ? "L" : "P"}|${pts}`;
}

function rememberedExcerpt(scope) {
  if (!adoptedExcerpt || adoptedExcerpt.key !== scopeKey(scope)) return "";
  return adoptedExcerpt.text || "";
}

function rememberExcerpt(scope, text) {
  const clean = String(text || "").trim();
  if (!clean) {
    adoptedExcerpt = null;
    return;
  }
  adoptedExcerpt = { key: scopeKey(scope), text: clean };
}

function boxHitsLasso(box, points) {
  const w = box.w || 0.28;
  const lines = Math.max(1, String(box.text || "").split("\n").length);
  const h = Math.min(0.5, Math.max(0.045, lines * 0.04));
  const rect = { x: box.x, y: box.y, w, h };
  const corners = [
    [rect.x, rect.y],
    [rect.x + rect.w, rect.y],
    [rect.x, rect.y + rect.h],
    [rect.x + rect.w, rect.y + rect.h],
    [rect.x + rect.w / 2, rect.y + rect.h / 2],
  ];
  if (corners.some(([x, y]) => pointInPoly(x, y, points))) return true;
  return points.some((p) => p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h);
}

function excerptForScope(scope) {
  const page = state.pages[scope.pageIndex];
  if (!page) return "";
  const parts = [];
  for (const box of page.textBoxes || []) {
    const text = String(box.text || "").trim();
    if (!text) continue;
    if (!scope.lasso || boxHitsLasso(box, scope.points)) parts.push(text);
  }
  return parts.join("\n");
}

function foldText(s) {
  return String(s || "").replace(/\s+/g, "").toLowerCase();
}

function composeExcerpt(typed, ocr) {
  const t = String(typed || "").trim();
  const o = String(ocr || "").trim();
  if (!o) return t;
  if (!t) return o;
  if (foldText(o).includes(foldText(t))) return o;
  const known = new Set(t.split(/\n+/).map(foldText).filter(Boolean));
  const extra = o.split(/\n+/).map((line) => line.trim()).filter((line) => {
    const key = foldText(line);
    return key && !known.has(key) && !foldText(t).includes(key);
  });
  return extra.length ? `${t}\n${extra.join("\n")}` : t;
}

function downscaleCanvas(src, maxEdge) {
  const edge = Math.max(src.width, src.height);
  if (edge <= maxEdge) return src;
  const scale = maxEdge / edge;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(src.width * scale));
  canvas.height = Math.max(1, Math.round(src.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fffaf1";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function captureScope(scope) {
  const page = state.pages[scope.pageIndex];
  if (!page) throw new Error("找不到這一頁");
  const aspect = page.aspect || 4 / 3;
  const cssW = 1200;
  const cssH = Math.max(1, Math.round(cssW / aspect));
  const canvas = document.createElement("canvas");
  canvas.width = cssW;
  canvas.height = cssH;
  const ctx = canvas.getContext("2d");
  await drawPageToContext(ctx, page, 0, 0, cssW, cssH, true);
  if (!scope.lasso || !scope.points || !scope.points.length) return downscaleCanvas(canvas, 1600);
  const bb = boundsOf(scope.points);
  const pad = 12;
  let x = Math.floor(bb.minX * cssW) - pad;
  let y = Math.floor(bb.minY * cssH) - pad;
  let w = Math.ceil((bb.maxX - bb.minX) * cssW) + pad * 2;
  let h = Math.ceil((bb.maxY - bb.minY) * cssH) + pad * 2;
  x = Math.max(0, x);
  y = Math.max(0, y);
  w = Math.max(1, Math.min(w, cssW - x));
  h = Math.max(1, Math.min(h, cssH - y));
  const crop = document.createElement("canvas");
  crop.width = w;
  crop.height = h;
  const cctx = crop.getContext("2d");
  cctx.fillStyle = "#fffaf1";
  cctx.fillRect(0, 0, w, h);
  cctx.save();
  cctx.beginPath();
  scope.points.forEach((p, i) => {
    const px = p.x * cssW - x;
    const py = p.y * cssH - y;
    if (i === 0) cctx.moveTo(px, py);
    else cctx.lineTo(px, py);
  });
  cctx.closePath();
  cctx.clip();
  cctx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
  cctx.restore();
  return downscaleCanvas(crop, 1600);
}

function aiSideMarkup() {
  return `
    <aside class="ai-side" id="aiSide" aria-label="筆記助手">
      <div class="ai-head">
        <h2>筆記助手</h2>
        <button class="page-btn" id="aiClose" type="button" aria-label="關閉助手">關閉</button>
      </div>
      <div class="ai-scroll">
        <p class="ai-scope" id="aiScope"></p>
        <p class="ai-privacy">筆記留在這部平板。辨識在本機進行。摘要、翻譯和問答都會先顯示預覽，確認後才送出圈選或本頁，不會自動上傳整本筆記。</p>
        <div class="ai-action-row">
          <button class="ai-btn" id="ocrBtn" type="button">辨識</button>
          <button class="ai-btn" id="sumBtn" type="button">摘要</button>
        </div>
        <div class="ai-translate">
          <select class="ai-select" id="translateDir" aria-label="翻譯方向">
            <option value="to-en">繁體中文 → English</option>
            <option value="to-zh">English → 繁體中文</option>
          </select>
          <button class="ai-btn" id="trBtn" type="button">翻譯</button>
        </div>
        <button class="ai-btn secondary" id="aiClearLasso" type="button">清除圈選</button>
        <label class="ai-ask-label" for="aiQuestion">問答</label>
        <textarea class="ai-question" id="aiQuestion" placeholder="問這段圈選或本頁…"></textarea>
        <button class="ai-btn" id="askBtn" type="button">送出問題</button>
        <div style="height:8px"></div>
        <button class="ai-btn secondary" id="aiSettingsBtn" type="button">設定</button>
        <p class="ai-status" id="aiStatus" role="status"></p>
        <div class="ai-log" id="aiLog"></div>
      </div>
    </aside>`;
}

function setAiOpen(open) {
  state.aiOpen = !!open;
  const wrap = document.getElementById("boardWrap");
  const top = wrap ? wrap.scrollTop : 0;
  const left = wrap ? wrap.scrollLeft : 0;
  const stage = document.querySelector(".editor .stage");
  if (stage) stage.classList.toggle("ai-open", state.aiOpen);
  const toggle = document.getElementById("aiToggle");
  if (toggle) toggle.setAttribute("aria-expanded", state.aiOpen ? "true" : "false");
  const jobs = layoutPages();
  Promise.resolve(jobs).then(() => {
    const board = document.getElementById("boardWrap");
    if (!board) return;
    board.scrollTop = top;
    board.scrollLeft = left;
  });
}

function setAiStatus(msg) {
  state.aiStatus = msg || "";
  const el = document.getElementById("aiStatus");
  if (el) el.textContent = state.aiStatus;
}

function updateAiScope() {
  const el = document.getElementById("aiScope");
  if (!el) return;
  const scope = currentScope();
  el.textContent = scope ? `目前範圍：${citationLabel(scope)}` : "沒有頁面";
}

function renderAiLog() {
  const log = document.getElementById("aiLog");
  if (!log) return;
  if (!state.aiMessages.length) {
    log.innerHTML = `<p class="ai-empty">摘要、翻譯、問答和辨識結果會出現在這裡，並標明頁碼與是否為圈選。</p>`;
    return;
  }
  log.innerHTML = state.aiMessages.map((m) => `
    <article class="ai-msg ${escapeAttr(m.role || "")}">
      <header>
        <span>${escapeHtml(m.title || "")}</span>
        <span class="ai-cite">${escapeHtml(m.citation || "")}</span>
      </header>
      <div class="ai-msg-body">${escapeHtml(m.body || "")}</div>
    </article>`).join("");
  log.scrollTop = log.scrollHeight;
}

function pushAiMessage(msg) {
  state.aiMessages.push({ id: uid(), ...msg });
  if (state.aiMessages.length > 40) state.aiMessages.splice(0, state.aiMessages.length - 40);
  renderAiLog();
}

function bindAiSide() {
  const close = document.getElementById("aiClose");
  if (close) close.onclick = () => setAiOpen(false);
  const ocr = document.getElementById("ocrBtn");
  if (ocr) ocr.onclick = () => openAiPreview({ kind: "ocr" });
  const sum = document.getElementById("sumBtn");
  if (sum) sum.onclick = () => openAiPreview({ kind: "summarize" });
  const tr = document.getElementById("trBtn");
  if (tr) tr.onclick = () => openAiPreview({ kind: "translate", dir: state.translateDir });
  const ask = document.getElementById("askBtn");
  if (ask) ask.onclick = () => askCurrent();
  const clear = document.getElementById("aiClearLasso");
  if (clear) clear.onclick = () => clearLasso();
  const settings = document.getElementById("aiSettingsBtn");
  if (settings) settings.onclick = () => openAiSettings();
  const dir = document.getElementById("translateDir");
  if (dir) {
    dir.value = state.translateDir === "to-zh" ? "to-zh" : "to-en";
    dir.onchange = () => {
      state.translateDir = dir.value === "to-zh" ? "to-zh" : "to-en";
    };
  }
  const question = document.getElementById("aiQuestion");
  if (question) {
    question.value = state.aiDraft || "";
    question.addEventListener("input", () => {
      state.aiDraft = question.value;
    });
    question.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        askCurrent();
      }
    });
  }
  const status = document.getElementById("aiStatus");
  if (status) status.textContent = state.aiStatus || "";
  renderAiLog();
  updateAiScope();
  updateLassoChrome();
}

function askCurrent() {
  const question = (state.aiDraft || "").trim();
  if (!question) {
    toast("請先輸入想問的問題");
    const el = document.getElementById("aiQuestion");
    if (el) el.focus();
    return;
  }
  openAiPreview({ kind: "ask", question });
}

function taskTitle(action) {
  if (action.kind === "ocr") return "辨識";
  if (action.kind === "summarize") return "摘要";
  if (action.kind === "translate") return "翻譯";
  return "問答";
}

async function openAiPreview(action) {
  if (aiBusy) {
    toast("上一個請求還在送出");
    return;
  }
  if (previewOpening || document.getElementById("aiPreview")) return;
  previewOpening = true;
  try {
    await openAiPreviewNow(action);
  } finally {
    previewOpening = false;
  }
}

async function openAiPreviewNow(action) {
  const scope = currentScope();
  if (!scope) {
    toast("沒有可使用的頁面");
    return;
  }
  const token = ++previewToken;
  setAiStatus("正在準備預覽…");
  let canvas;
  try {
    canvas = await captureScope(scope);
  } catch (err) {
    console.error(err);
    setAiStatus("無法準備預覽，沒有送出。");
    toast("無法準備預覽");
    return;
  }
  if (token !== previewToken) return;
  const remembered = rememberedExcerpt(scope);
  const typed = remembered || excerptForScope(scope);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
  const frozen = {
    pageIndex: scope.pageIndex,
    lasso: !!scope.lasso,
    points: scope.points ? scope.points.map((p) => ({ x: p.x, y: p.y })) : null,
  };
  previewSession = { token, action, scope: frozen, typed, canvas, dataUrl, dirty: false, keepRemembered: !!remembered };
  const cite = citationLabel(frozen);
  const isOcr = action.kind === "ocr";
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.id = "aiPreview";
  overlay.innerHTML = `
    <div class="dialog ai-preview" role="dialog" aria-modal="true" aria-labelledby="aiPreviewTitle">
      <h3 id="aiPreviewTitle">${isOcr ? "辨識預覽" : "確認送出"}</h3>
      <p class="ai-privacy" id="aiPreviewLead"></p>
      <div class="ai-cite" id="aiPreviewCite"></div>
      <p class="ai-ask-label" id="aiPreviewQuestionLabel">問題</p>
      <div class="ai-msg-body" id="aiPreviewQuestion"></div>
      <p class="ai-ask-label">範圍預覽</p>
      <img class="ai-thumb" id="aiPreviewImg" alt="將處理的範圍預覽" />
      <label class="ai-ask-label" id="aiPreviewTextLabel" for="aiPreviewText"></label>
      <textarea class="ai-preview-text" id="aiPreviewText"></textarea>
      <p class="ai-fate" id="aiImageFate"></p>
      <p class="ai-status" id="aiPreviewStatus" role="status"></p>
      <div class="dialog-actions">
        <button class="btn btn-ghost" type="button" data-act="cancel">取消</button>
        <button class="btn btn-ghost" type="button" data-act="again">重新辨識</button>
        <button class="btn btn-primary" type="button" data-act="ok" id="aiPreviewOk"></button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector("#aiPreviewLead").textContent = isOcr
    ? "下面是將在這部平板辨識的範圍。辨識不會上傳。你可以修改文字，再決定要不要留給助手。"
    : "還沒有送出。請核對下面的圈選或本頁，按下確認才會送到你選擇的服務。";
  overlay.querySelector("#aiPreviewCite").textContent = cite;
  const qLabel = overlay.querySelector("#aiPreviewQuestionLabel");
  const qBody = overlay.querySelector("#aiPreviewQuestion");
  if (action.kind === "ask") {
    qBody.textContent = action.question || "";
  } else if (action.kind === "translate") {
    qLabel.textContent = "翻譯方向";
    qBody.textContent = action.dir === "to-zh" ? "English → 繁體中文" : "繁體中文 → English";
  } else {
    qLabel.classList.add("hidden");
    qBody.classList.add("hidden");
  }
  overlay.querySelector("#aiPreviewImg").src = dataUrl;
  overlay.querySelector("#aiPreviewTextLabel").textContent = isOcr ? "辨識文字（可修改）" : "將送出的文字（可修改）";
  const textarea = overlay.querySelector("#aiPreviewText");
  textarea.value = typed;
  overlay.querySelector("#aiPreviewOk").textContent = isOcr ? "採用文字" : "確認送出";
  const refreshFate = () => {
    const fate = document.getElementById("aiImageFate");
    if (!fate) return;
    if (isOcr) {
      fate.textContent = "這張圖只在這部平板上辨識，不會上傳。";
      return;
    }
    if (textarea.value.trim()) {
      fate.textContent = "確認後只送出上面的文字，不送這張圖，也不送其他頁。";
      return;
    }
    fate.textContent = emptyTextSendsImage(loadAiSettings())
      ? "文字是空的。確認後會改送這張裁切圖，仍不會送其他頁。"
      : "文字是空的，而目前的 DeepSeek 模型不接受圖片。請先輸入文字；確認也不會送出。";
  };
  refreshFate();
  let fillingPreview = false;
  textarea.addEventListener("input", () => {
    if (fillingPreview) return;
    if (previewSession) previewSession.dirty = true;
    refreshFate();
  });
  previewSession.fillText = (value) => {
    fillingPreview = true;
    textarea.value = value;
    refreshFate();
    fillingPreview = false;
  };
  overlay.addEventListener("click", (e) => {
    const button = e.target.closest ? e.target.closest("button") : null;
    const act = button && button.dataset.act;
    if (e.target === overlay || act === "cancel") {
      cancelAiPreview();
      return;
    }
    if (act === "again") {
      if (!previewSession) return;
      previewSession.dirty = false;
      previewSession.keepRemembered = false;
      runPreviewOcr(previewSession.token, true);
      return;
    }
    if (act === "ok") confirmAiPreview();
  });
  textarea.focus();
  setAiStatus(isOcr ? "請確認辨識範圍。取消不會上傳。" : "請確認將送出的內容。取消不會送出。");
  runPreviewOcr(token, false);
}

function setPreviewStatus(msg) {
  const el = document.getElementById("aiPreviewStatus");
  if (el) el.textContent = msg || "";
}

function cancelAiPreview() {
  previewToken += 1;
  previewSession = null;
  ocrStatus = () => {};
  const overlay = document.getElementById("aiPreview");
  if (overlay) overlay.remove();
  setAiStatus("已取消，沒有送出。");
}

function confirmAiPreview() {
  const session = previewSession;
  if (!session) return;
  const textarea = document.getElementById("aiPreviewText");
  const text = textarea ? textarea.value.trim() : "";
  const action = session.action;
  const scope = session.scope;
  const dataUrl = session.dataUrl;
  const cite = citationLabel(scope);
  previewToken += 1;
  previewSession = null;
  const overlay = document.getElementById("aiPreview");
  if (overlay) overlay.remove();
  ocrStatus = () => {};
  rememberExcerpt(scope, text);
  if (action.kind === "ocr") {
    pushAiMessage({ role: "assistant", title: "辨識", citation: cite, body: text || "（沒有辨識到文字）" });
    setAiStatus("已採用辨識文字，留在這部平板，沒有送出。");
    return;
  }
  const settings = loadAiSettings();
  if (!hasActiveKey(settings)) {
    const message = missingKeyMessage(settings);
    pushAiMessage({ role: "error", title: "尚未送出", citation: cite, body: message });
    setAiStatus(message);
    showNeedKeyDialog(message);
    return;
  }
  if (!text && !emptyTextSendsImage(settings)) {
    const message = "沒有可送出的文字，而目前的 DeepSeek 模型不接受圖片。請輸入或辨識文字後再確認，或把模型改成 deepseek-flash。這次沒有送出。";
    pushAiMessage({ role: "error", title: "尚未送出", citation: cite, body: message });
    setAiStatus(message);
    toast("沒有送出");
    return;
  }
  sendConfirmed({ action, text, dataUrl: text ? "" : dataUrl, cite, settings });
}

async function runPreviewOcr(token, manual) {
  const session = previewSession;
  if (!session || session.token !== token) return;
  if (!window.Tesseract) {
    setPreviewStatus(`無法載入本機辨識（Tesseract.js）。你仍可手動輸入文字；${emptyTextFallbackSentence(loadAiSettings())}`);
    return;
  }
  if (session.keepRemembered && !manual) {
    setPreviewStatus("沿用你上次確認過的文字。可直接修改，或按「重新辨識」。");
    return;
  }
  setPreviewStatus(manual ? "正在這部平板重新辨識…（不會上傳）" : "正在這部平板辨識…（不會上傳）");
  ocrStatus = (msg) => {
    if (token !== previewToken) return;
    setPreviewStatus(msg);
  };
  try {
    const worker = await getOcrWorker();
    if (token !== previewToken || !previewSession) return;
    const result = await worker.recognize(session.canvas);
    if (token !== previewToken || !previewSession) return;
    const recognized = (result && result.data && result.data.text ? result.data.text : "").trim();
    if (previewSession.dirty && !manual) {
      setPreviewStatus("辨識完成，已保留你改過的文字。");
      return;
    }
    if (previewSession.fillText) {
      const base = manual ? excerptForScope(previewSession.scope) : previewSession.typed;
      previewSession.fillText(composeExcerpt(base, recognized));
      previewSession.dirty = false;
    }
    setPreviewStatus(recognized ? "辨識完成，可以先修改再確認。" : emptyRecognitionSentence(loadAiSettings()));
  } catch (err) {
    console.error(err);
    if (token !== previewToken) return;
    setPreviewStatus(`本機辨識失敗。你可以手動輸入文字；${emptyTextFallbackSentence(loadAiSettings())}`);
  }
}

function reportOcr(m) {
  if (!m || !m.status) return;
  const pct = typeof m.progress === "number" ? ` ${Math.round(m.progress * 100)}%` : "";
  if (m.status === "loading language traineddata") ocrStatus(`正在下載辨識語料${pct}（只存在這部平板）`);
  else if (m.status === "loading tesseract core") ocrStatus(`正在載入辨識元件${pct}`);
  else if (m.status === "recognizing text") ocrStatus(`正在這部平板辨識${pct}（不會上傳）`);
}

function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createOcrWorker().catch((err) => {
      ocrWorkerPromise = null;
      throw err;
    });
  }
  return ocrWorkerPromise;
}

async function createOcrWorker() {
  const cores = [
    "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-simd-lstm.wasm.js",
    "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-lstm.wasm.js",
  ];
  let lastErr = null;
  for (const corePath of cores) {
    try {
      return await Tesseract.createWorker("chi_tra+eng", 1, {
        workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js",
        corePath,
        langPath: TESS_LANG_PATH,
        workerBlobURL: true,
        logger: reportOcr,
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("無法建立辨識元件");
}

function defaultAiSettings() {
  return {
    provider: "gemini",
    geminiKey: "",
    geminiModel: DEFAULT_GEMINI_MODEL,
    deepseekKey: "",
    deepseekModel: DEFAULT_DEEPSEEK_MODEL,
    openaiBase: "",
    openaiKey: "",
    openaiModel: "gpt-4o-mini",
  };
}

function loadAiSettings() {
  const base = defaultAiSettings();
  try {
    const raw = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || "{}");
    if (!raw || typeof raw !== "object") return base;
    return {
      provider: normalizeProvider(raw.provider),
      geminiKey: typeof raw.geminiKey === "string" ? raw.geminiKey : "",
      geminiModel: cleanModel(raw.geminiModel, DEFAULT_GEMINI_MODEL),
      deepseekKey: typeof raw.deepseekKey === "string" ? raw.deepseekKey : "",
      deepseekModel: cleanModel(raw.deepseekModel, DEFAULT_DEEPSEEK_MODEL),
      openaiBase: typeof raw.openaiBase === "string" ? raw.openaiBase : "",
      openaiKey: typeof raw.openaiKey === "string" ? raw.openaiKey : "",
      openaiModel: cleanModel(raw.openaiModel, "gpt-4o-mini"),
    };
  } catch {
    return base;
  }
}

function normalizeProvider(value) {
  if (value === "openai" || value === "deepseek") return value;
  return "gemini";
}

function resolvedProvider(settings) {
  const choice = normalizeProvider(settings && settings.provider);
  if (choice === "openai") return "openai";
  const gemini = !!(settings.geminiKey && settings.geminiKey.trim());
  const deepseek = !!(settings.deepseekKey && settings.deepseekKey.trim());
  if (gemini && deepseek) return choice === "deepseek" ? "deepseek" : "gemini";
  if (deepseek) return "deepseek";
  if (gemini) return "gemini";
  return choice === "deepseek" ? "deepseek" : "gemini";
}

function deepseekModelAcceptsImages(model) {
  const name = String(model || DEFAULT_DEEPSEEK_MODEL).trim().toLowerCase();
  return name === "deepseek-flash"
    || name === "deepseek-v4-flash"
    || name === "deepseek-v4-flash-vision-exp";
}

function emptyTextSendsImage(settings) {
  if (resolvedProvider(settings) !== "deepseek") return true;
  return deepseekModelAcceptsImages(settings.deepseekModel);
}

function emptyTextFallbackSentence(settings) {
  if (emptyTextSendsImage(settings)) return "文字留空時，確認後只會送出裁切圖。";
  return "目前的 DeepSeek 模型不接受圖片，請輸入文字後再確認。";
}

function emptyRecognitionSentence(settings) {
  if (emptyTextSendsImage(settings)) return "沒有辨識到文字。你可以自己輸入，或在文字留空時改送裁切圖。";
  return "沒有辨識到文字。目前的 DeepSeek 模型不接受圖片，請自己輸入文字。";
}

function providerUsageNote(settings) {
  const active = resolvedProvider(settings);
  const gemini = !!(settings.geminiKey && settings.geminiKey.trim());
  const deepseek = !!(settings.deepseekKey && settings.deepseekKey.trim());
  if (settings.provider === "openai") {
    return settings.openaiKey.trim() && settings.openaiBase.trim()
      ? "目前會使用 OpenAI 相容位址。"
      : "已選擇 OpenAI 相容。請填寫位址和金鑰，否則確認後不會送出。";
  }
  if (gemini && deepseek) {
    return active === "deepseek"
      ? "Gemini 和 DeepSeek 都有金鑰。目前會使用 DeepSeek。"
      : "Gemini 和 DeepSeek 都有金鑰。目前會使用 Gemini。";
  }
  if (deepseek) return "目前只儲存了 DeepSeek 金鑰，送出時會使用 DeepSeek。";
  if (gemini) return "目前只儲存了 Gemini 金鑰，送出時會使用 Gemini。";
  if (active === "deepseek") return "尚未設定 DeepSeek API 金鑰。確認後不會送出。";
  return "尚未設定 API 金鑰。確認後不會送出。";
}

function saveAiSettings(settings) {
  localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(settings));
}

function cleanModel(name, fallback) {
  const model = String(name || "").trim();
  if (!model) return fallback;
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(model)) return fallback;
  return model;
}

function hasActiveKey(settings) {
  const provider = resolvedProvider(settings);
  if (provider === "openai") return !!(settings.openaiKey.trim() && settings.openaiBase.trim());
  if (provider === "deepseek") return !!settings.deepseekKey.trim();
  return !!settings.geminiKey.trim();
}

function missingKeyMessage(settings) {
  const provider = resolvedProvider(settings);
  if (provider === "openai") {
    return "尚未設定 OpenAI 相容位址和金鑰，所以沒有送出。請到設定填寫。金鑰只會留在這部平板。";
  }
  if (provider === "deepseek") {
    return "尚未設定 DeepSeek API 金鑰，所以沒有送出。請先到設定加入 DeepSeek API 金鑰。金鑰只會留在這部平板。";
  }
  return "尚未設定 API 金鑰，所以沒有送出。請先到設定加入 API 金鑰。金鑰只會留在這部平板。";
}

function showNeedKeyDialog(message) {
  if (document.getElementById("aiNeedKey")) return;
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.id = "aiNeedKey";
  overlay.innerHTML = `
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="aiNeedKeyTitle">
      <h3 id="aiNeedKeyTitle">請先加入 API 金鑰</h3>
      <p id="aiNeedKeyBody"></p>
      <div class="dialog-actions">
        <button class="btn btn-ghost" type="button" data-act="close">關閉</button>
        <button class="btn btn-primary" type="button" data-act="settings">前往設定</button>
      </div>
    </div>`;
  overlay.querySelector("#aiNeedKeyBody").textContent = message;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.dataset.act === "close") {
      overlay.remove();
      return;
    }
    if (e.target.dataset.act === "settings") {
      overlay.remove();
      openAiSettings();
    }
  });
  overlay.querySelector("[data-act='settings']").focus();
}

function storedKeySummary(settings) {
  const bits = [];
  if (settings.geminiKey) bits.push("Gemini 金鑰已在這部平板");
  if (settings.deepseekKey) bits.push("DeepSeek 金鑰已在這部平板");
  if (settings.openaiKey) bits.push("OpenAI 相容金鑰已在這部平板");
  return bits.length ? bits.join("。") + "。" : "這部平板尚未儲存金鑰。";
}

function openAiSettings() {
  if (document.getElementById("aiSettings")) return;
  const settings = loadAiSettings();
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.id = "aiSettings";
  overlay.innerHTML = `
    <form class="dialog ai-settings" role="dialog" aria-modal="true" aria-labelledby="aiSettingsTitle">
      <div class="ai-settings-body">
      <h3 id="aiSettingsTitle">助手設定</h3>
      <p>API 金鑰只存在這部平板的瀏覽器，不會寫進畫布，也不會放進程式碼或上傳到 GitHub。</p>
      <p>只有你在預覽裡按下確認後，圈選或本頁的文字才會送出。文字是空的時，才會改送該範圍的裁切圖。不會自動上傳整本筆記。</p>
      <p>辨識在這部平板上進行，不需要金鑰。</p>
      <div class="ai-legend">使用哪個服務</div>
      <div class="ai-choice">
        <label><input type="radio" name="aiProvider" value="gemini" ${settings.provider === "gemini" ? "checked" : ""} /> Gemini（預設）</label>
        <label><input type="radio" name="aiProvider" value="deepseek" ${settings.provider === "deepseek" ? "checked" : ""} /> DeepSeek</label>
        <label><input type="radio" name="aiProvider" value="openai" ${settings.provider === "openai" ? "checked" : ""} /> OpenAI 相容</label>
      </div>
      <p class="ai-privacy" id="aiProviderNote"></p>
      <label class="ai-field"><span>Gemini API 金鑰</span>
        <input class="text-input" id="geminiKeyInput" type="password" autocomplete="off" spellcheck="false" placeholder="${settings.geminiKey ? "已儲存，留空則保留原本的金鑰" : "貼上 Gemini API 金鑰"}" />
      </label>
      <label class="ai-field"><span>Gemini 模型</span>
        <input class="text-input" id="geminiModelInput" value="${escapeAttr(settings.geminiModel)}" autocomplete="off" />
      </label>
      <p class="ai-privacy">預設模型是 gemini-3.6-flash。若要改用較新的 Flash，可填 gemini-3.8-flash。若瀏覽器擋住跨來源請求，可改選 DeepSeek，或使用下面的 OpenAI 相容位址。</p>
      <div class="ai-legend">DeepSeek</div>
      <label class="ai-field"><span>DeepSeek API 金鑰</span>
        <input class="text-input" id="deepseekKeyInput" type="password" autocomplete="off" spellcheck="false" placeholder="${settings.deepseekKey ? "已儲存，留空則保留原本的金鑰" : "貼上 DeepSeek API 金鑰"}" />
      </label>
      <label class="ai-field"><span>DeepSeek 模型</span>
        <input class="text-input" id="deepseekModelInput" value="${escapeAttr(settings.deepseekModel)}" autocomplete="off" spellcheck="false" />
      </label>
      <p class="ai-privacy">預設模型是 deepseek-flash（目前由 DeepSeek-V4.1-Flash-1017 提供），可以讀取裁切圖。deepseek-v4-pro 只接受文字；文字是空的時不會送出。不需要填寫位址。</p>
      <div class="ai-legend">OpenAI 相容</div>
      <label class="ai-field"><span>OpenAI 相容位址</span>
        <input class="text-input" id="openaiBaseInput" value="${escapeAttr(settings.openaiBase)}" placeholder="https://example.com/v1" autocomplete="off" />
      </label>
      <label class="ai-field"><span>OpenAI 相容金鑰</span>
        <input class="text-input" id="openaiKeyInput" type="password" autocomplete="off" spellcheck="false" placeholder="${settings.openaiKey ? "已儲存，留空則保留原本的金鑰" : "選填"}" />
      </label>
      <label class="ai-field"><span>OpenAI 相容模型</span>
        <input class="text-input" id="openaiModelInput" value="${escapeAttr(settings.openaiModel)}" autocomplete="off" />
      </label>
      <p class="ai-status" id="aiSettingsStored"></p>
      </div>
      <div class="dialog-actions">
        <button class="btn btn-danger" type="button" id="aiClearKeys">清除金鑰</button>
        <button class="btn btn-ghost" type="button" data-act="close">關閉</button>
        <button class="btn btn-primary" type="submit">儲存</button>
      </div>
    </form>`;
  document.body.appendChild(overlay);
  const stored = overlay.querySelector("#aiSettingsStored");
  const note = overlay.querySelector("#aiProviderNote");
  const form = overlay.querySelector("form");
  const readFormSettings = () => {
    const next = loadAiSettings();
    const provider = form.querySelector("input[name='aiProvider']:checked");
    next.provider = normalizeProvider(provider && provider.value);
    const geminiTyped = form.querySelector("#geminiKeyInput").value.trim();
    if (geminiTyped) next.geminiKey = geminiTyped;
    next.geminiModel = cleanModel(form.querySelector("#geminiModelInput").value, DEFAULT_GEMINI_MODEL);
    const deepseekTyped = form.querySelector("#deepseekKeyInput").value.trim();
    if (deepseekTyped) next.deepseekKey = deepseekTyped;
    next.deepseekModel = cleanModel(form.querySelector("#deepseekModelInput").value, DEFAULT_DEEPSEEK_MODEL);
    next.openaiBase = form.querySelector("#openaiBaseInput").value.trim();
    const openaiTyped = form.querySelector("#openaiKeyInput").value.trim();
    if (openaiTyped) next.openaiKey = openaiTyped;
    next.openaiModel = cleanModel(form.querySelector("#openaiModelInput").value, "gpt-4o-mini");
    return next;
  };
  const refreshSettingsCopy = () => {
    stored.textContent = storedKeySummary(loadAiSettings());
    note.textContent = providerUsageNote(readFormSettings());
  };
  refreshSettingsCopy();
  form.addEventListener("change", refreshSettingsCopy);
  form.addEventListener("input", refreshSettingsCopy);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const next = readFormSettings();
    if (next.provider === "openai" && next.openaiBase && !/^https?:\/\//i.test(next.openaiBase)) {
      toast("位址須以 http:// 或 https:// 開頭");
      return;
    }
    try {
      saveAiSettings(next);
    } catch (err) {
      console.error(err);
      toast("無法寫入這部平板的儲存空間");
      return;
    }
    overlay.remove();
    toast("已儲存在這部平板");
    setAiStatus("設定已儲存在這部平板。");
  });
  overlay.querySelector("#aiClearKeys").onclick = () => {
    const next = loadAiSettings();
    next.geminiKey = "";
    next.deepseekKey = "";
    next.openaiKey = "";
    try {
      saveAiSettings(next);
    } catch (err) {
      console.error(err);
      toast("無法清除金鑰");
      return;
    }
    form.querySelector("#geminiKeyInput").value = "";
    form.querySelector("#deepseekKeyInput").value = "";
    form.querySelector("#openaiKeyInput").value = "";
    form.querySelector("#geminiKeyInput").placeholder = "貼上 Gemini API 金鑰";
    form.querySelector("#deepseekKeyInput").placeholder = "貼上 DeepSeek API 金鑰";
    form.querySelector("#openaiKeyInput").placeholder = "選填";
    stored.textContent = "已清除這部平板上的金鑰。";
    note.textContent = providerUsageNote(readFormSettings());
    toast("已清除這部平板上的金鑰");
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.dataset.act === "close") overlay.remove();
  });
  form.querySelector("#geminiKeyInput").focus();
}

function scrubSecrets(text, settings) {
  let out = String(text || "");
  for (const secret of [settings.geminiKey, settings.deepseekKey, settings.openaiKey]) {
    if (secret && secret.length > 4) out = out.split(secret).join("［金鑰］");
  }
  out = out.replace(/api key:\s*\S+/gi, "api key: ［金鑰］");
  return out.slice(0, 500);
}

function buildPrompt(action, text, cite, imageOnly) {
  const lines = [
    "你是畫布的筆記助手。使用者只確認了下面這一份內容，不要假設筆記本裡還有其他頁。",
    `來源：${cite}。`,
    `請在回答最後一行單獨寫上：來源：${cite}`,
  ];
  if (action.kind === "summarize") lines.push("請用繁體中文寫一段簡短摘要，只根據提供的內容。");
  else if (action.kind === "translate" && action.dir === "to-zh") lines.push("請把內容翻譯成繁體中文。若已經是繁體中文，整理成通順的繁體中文即可。");
  else if (action.kind === "translate") lines.push("請把內容翻譯成英文（English）。保留專有名詞，不要額外發揮。");
  else {
    lines.push("請用繁體中文回答問題，只根據提供的內容。若內容裡看不出答案，請直接說明。");
    lines.push(`問題：${action.question || ""}`);
  }
  if (imageOnly) lines.push("沒有可送出的文字。請只閱讀附上的這一張裁切圖。");
  else {
    lines.push("內容：");
    lines.push(text);
  }
  return lines.join("\n");
}

function friendlyAiError(err, settings) {
  const status = err && err.status;
  const raw = scrubSecrets(err && err.message, settings);
  const provider = resolvedProvider(settings);
  if (raw === "NETWORK" || (err && err.name === "TypeError")) {
    if (provider === "deepseek") {
      return "無法連上 DeepSeek。瀏覽器可能擋住了跨來源請求（CORS），或目前沒有網路。這次沒有改送其他服務，也沒有送出其他頁。";
    }
    return "無法連上服務。瀏覽器可能擋住了跨來源請求（CORS），或目前沒有網路。可到設定改用支援 CORS 的 OpenAI 相容位址。這次沒有送出其他頁。";
  }
  if (status === 401 || status === 403 || /api key|API_KEY|permission/i.test(raw)) return "金鑰被拒絕。請到設定檢查，金鑰只留在這部平板。";
  if (status === 404) return "找不到這個模型。請到設定修改模型名稱。";
  if (provider === "deepseek" && /image|vision|multimodal|image_url|圖片/i.test(raw)) {
    return "這個 DeepSeek 模型不接受圖片。請改送文字，或把模型改成 deepseek-flash。這次沒有改送其他服務。";
  }
  return `模型沒有完成回應。${raw ? raw : ""}`.trim();
}

async function sendConfirmed({ action, text, dataUrl, cite, settings }) {
  aiBusy = true;
  setAiStatus("送出中…只含已確認的文字或裁切圖。");
  if (action.kind === "ask") {
    pushAiMessage({ role: "user", title: "問題", citation: cite, body: action.question || "" });
    state.aiDraft = "";
    const box = document.getElementById("aiQuestion");
    if (box) box.value = "";
  }
  const imageOnly = !text;
  const prompt = buildPrompt(action, text, cite, imageOnly);
  const provider = resolvedProvider(settings);
  try {
    const image = imageOnly ? dataUrl : "";
    const answer = provider === "deepseek"
      ? await callDeepSeek(settings, prompt, image)
      : provider === "openai"
        ? await callOpenAI(settings, prompt, image)
        : await callGemini(settings, prompt, image);
    pushAiMessage({ role: "assistant", title: taskTitle(action), citation: cite, body: answer });
    setAiStatus(`已收到回覆。來源：${cite}`);
  } catch (err) {
    console.error(err && err.message ? scrubSecrets(err.message, settings) : err);
    const message = friendlyAiError(err, settings);
    pushAiMessage({ role: "error", title: taskTitle(action), citation: cite, body: message });
    setAiStatus(message);
  } finally {
    aiBusy = false;
  }
}

async function callGemini(settings, prompt, imageDataUrl) {
  const model = settings.geminiModel || DEFAULT_GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const parts = [{ text: prompt }];
  if (imageDataUrl) {
    const parsed = parseDataUrl(imageDataUrl);
    parts.push({ inlineData: { mimeType: parsed.mime, data: parsed.data } });
  }
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": settings.geminiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
      }),
    });
  } catch {
    const error = new Error("NETWORK");
    error.name = "TypeError";
    throw error;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error((data.error && data.error.message) || `HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  const partsOut = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const text = partsOut.map((part) => part.text || "").join("").trim();
  if (!text) {
    const reason = data.candidates && data.candidates[0] && data.candidates[0].finishReason;
    throw new Error(reason ? `模型沒有回傳文字（${reason}）` : "模型沒有回傳文字");
  }
  return text;
}

function chatCompletionsUrl(base) {
  let url = String(base || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) throw new Error("位址須以 http:// 或 https:// 開頭");
  if (/\/chat\/completions$/i.test(url)) return url;
  if (/\/v\d+$/i.test(url)) return `${url}/chat/completions`;
  return `${url}/v1/chat/completions`;
}

async function callDeepSeek(settings, prompt, imageDataUrl) {
  const model = settings.deepseekModel || DEFAULT_DEEPSEEK_MODEL;
  if (imageDataUrl && !deepseekModelAcceptsImages(model)) {
    throw new Error("這個 DeepSeek 模型不接受圖片，而且沒有可送出的文字。");
  }
  return callChatCompletions({
    url: DEEPSEEK_CHAT_URL,
    apiKey: settings.deepseekKey,
    model,
    prompt,
    imageDataUrl,
  });
}

async function callOpenAI(settings, prompt, imageDataUrl) {
  return callChatCompletions({
    url: chatCompletionsUrl(settings.openaiBase),
    apiKey: settings.openaiKey,
    model: settings.openaiModel || "gpt-4o-mini",
    prompt,
    imageDataUrl,
  });
}

async function callChatCompletions({ url, apiKey, model, prompt, imageDataUrl }) {
  const content = imageDataUrl
    ? [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ]
    : prompt;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [{ role: "user", content }],
      }),
    });
  } catch {
    const error = new Error("NETWORK");
    error.name = "TypeError";
    throw error;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error((data.error && (data.error.message || data.error)) || `HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  const contentOut = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  const text = Array.isArray(contentOut)
    ? contentOut.map((part) => (typeof part === "string" ? part : part.text || "")).join("").trim()
    : String(contentOut || "").trim();
  if (!text) throw new Error("模型沒有回傳文字");
  return text;
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl).match(/^data:(.*?);base64,(.+)$/);
  if (!match) throw new Error("無法讀取裁切圖");
  return { mime: match[1] || "image/jpeg", data: match[2] };
}

/* ---------------- Navigation ---------------- */
async function createBlank() {
  const { note, pages } = newNote();
  await db.putNote(note);
  await db.putPages(pages);
  await openNote(note.id);
}

async function openNote(id) {
  const data = await db.getNote(id);
  if (!data.note) return;
  state.view = "editor";
  state.note = data.note;
  state.pages = data.pages.length ? data.pages : [blankPage(id, 0)];
  state.pageIndex = 0;
  state.save = "saved";
  state.lastSavedAt = data.note.updatedAt;
  undoStack = [];
  redoStack = [];
  state.lasso = null;
  state.aiMessages = [];
  state.aiStatus = "";
  adoptedExcerpt = null;
  viewZoom = 1;
  pinch = null;
  penPointers.clear();
  activeTouches.clear();
  scrollLock = null;
  renderEditor();
}

async function loadList() {
  state.view = "list";
  state.notes = await db.allNotes();
  render();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escapeAttr(s) {
  return escapeHtml(s);
}

function fitRect(aspect, w, h) {
  let rw = w, rh = w / aspect;
  if (rh > h) {
    rh = h;
    rw = h * aspect;
  }
  return { x: (w - rw) / 2, y: (h - rh) / 2, w: rw, h: rh };
}

window.addEventListener("resize", () => {
  if (state.view === "editor") layoutPages();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("aiPreview")) {
    cancelAiPreview();
    return;
  }
  if (e.key === "Escape" && document.getElementById("aiSettings")) {
    document.getElementById("aiSettings").remove();
    return;
  }
  if (e.key === "Escape" && document.getElementById("aiNeedKey")) {
    document.getElementById("aiNeedKey").remove();
    return;
  }
  if (e.key === "Escape" && closeCreateSheet()) return;
  if (e.key === "Escape" && state.view === "editor" && state.lasso) {
    clearLasso();
    return;
  }
  if (e.key === "Escape" && state.view === "list") {
    closeMenus();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    const field = e.target && e.target.closest && e.target.closest("textarea, input");
    if (field && field.closest(".ai-side, .dialog")) return;
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  }
});

loadList().catch((err) => {
  console.error(err);
  $app.innerHTML = `<div class="empty-state"><h2>無法開啟本地儲存</h2><p>請用 Chrome 或 Samsung Internet 打開呢個網站，唔好用檔案直接開啟。</p></div>`;
});
