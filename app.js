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
    note: { id, title, createdAt: now, updatedAt: now, sourceName: "" },
    pages: [blankPage(id, 0)],
  };
}

/* ---------------- App state ---------------- */
const state = {
  view: "list",
  notes: [],
  query: "",
  note: null,
  pages: [],
  pageIndex: 0,
  tool: "pen",
  color: "black",
  width: "m",
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

function renderList() {
  const q = state.query.trim().toLowerCase();
  const notes = state.notes.filter((n) => {
    const hay = `${n.title || ""} ${n.sourceName || ""}`.toLowerCase();
    return !q || hay.includes(q);
  });

  $app.innerHTML = `
    <div class="list-view">
      <header class="list-header">
        <div class="brand">
          <div class="brand-mark">畫</div>
          <div>
            <h1>畫布</h1>
            <p>喺平板上手寫、註解同整理筆記</p>
          </div>
        </div>
        <div class="search">
          ${svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>')}
          <input id="searchInput" type="search" placeholder="搜尋標題或檔名" value="${escapeAttr(state.query)}" />
        </div>
        <button class="btn btn-primary" id="newBtn">${svg('<path d="M12 5v14M5 12h14"/>', 18)} 新建畫布</button>
      </header>
      <div class="note-grid" id="grid"></div>
    </div>
  `;

  const grid = document.getElementById("grid");
  if (!notes.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <h2>${state.notes.length ? "搵唔到相符嘅畫布" : "尚未有畫布"}</h2>
        <p>${state.notes.length ? "試下用其他標題或檔名搜尋。" : "建立一塊空白畫布，或者上載 PDF／圖片開始註解。"}</p>
      </div>`;
  } else {
    for (const n of notes) {
      const card = document.createElement("article");
      card.className = "note-card";
      card.innerHTML = `
        <div class="note-thumb" data-id="${n.id}"></div>
        <div class="note-meta">
          <div class="info">
            <h3>${escapeHtml(n.title || "未命名畫布")}</h3>
            <time>${fmtTime(n.updatedAt)}</time>
          </div>
          <button class="icon-btn" data-menu="${n.id}" aria-label="更多">${svg('<circle cx="12" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="18" r="1.2" fill="currentColor" stroke="none"/>')}</button>
        </div>
      `;
      card.querySelector(".note-thumb").addEventListener("click", () => openNote(n.id));
      card.querySelector(".info").addEventListener("click", () => openNote(n.id));
      card.querySelector("[data-menu]").addEventListener("click", (e) => {
        e.stopPropagation();
        openCardMenu(n, e.currentTarget);
      });
      grid.appendChild(card);
      paintThumb(card.querySelector(".note-thumb"), n.id);
    }
  }

  document.getElementById("newBtn").onclick = createBlank;
  const search = document.getElementById("searchInput");
  search.oninput = () => {
    state.query = search.value;
    refreshGrid();
  };
}

function refreshGrid() {
  const grid = document.getElementById("grid");
  if (!grid) {
    renderList();
    return;
  }
  const q = state.query.trim().toLowerCase();
  const notes = state.notes.filter((n) => {
    const hay = `${n.title || ""} ${n.sourceName || ""}`.toLowerCase();
    return !q || hay.includes(q);
  });
  grid.innerHTML = "";
  if (!notes.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <h2>${state.notes.length ? "搵唔到相符嘅畫布" : "尚未有畫布"}</h2>
        <p>${state.notes.length ? "試下用其他標題或檔名搜尋。" : "建立一塊空白畫布，或者上載 PDF／圖片開始註解。"}</p>
      </div>`;
    return;
  }
  for (const n of notes) {
    const card = document.createElement("article");
    card.className = "note-card";
    card.innerHTML = `
      <div class="note-thumb" data-id="${n.id}"></div>
      <div class="note-meta">
        <div class="info">
          <h3>${escapeHtml(n.title || "未命名畫布")}</h3>
          <time>${fmtTime(n.updatedAt)}</time>
        </div>
        <button class="icon-btn" data-menu="${n.id}" aria-label="更多">${svg('<circle cx="12" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="18" r="1.2" fill="currentColor" stroke="none"/>')}</button>
      </div>
    `;
    card.querySelector(".note-thumb").addEventListener("click", () => openNote(n.id));
    card.querySelector(".info").addEventListener("click", () => openNote(n.id));
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
    const page = pages[0];
    if (!page) return;
    const c = document.createElement("canvas");
    const w = el.clientWidth || 240;
    const h = el.clientHeight || 190;
    c.width = w * 2;
    c.height = h * 2;
    const ctx = c.getContext("2d");
    ctx.scale(2, 2);
    ctx.fillStyle = "#fffaf1";
    ctx.fillRect(0, 0, w, h);
    const rect = fitRect(page.aspect || 4 / 3, w, h);
    await drawPageToContext(ctx, page, rect.x, rect.y, rect.w, rect.h, true);
    el.innerHTML = "";
    el.appendChild(c);
  } catch (e) {
    console.error(e);
  }
}

function openCardMenu(note, btn) {
  closeMenus();
  const r = btn.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.style.top = r.bottom + 6 + "px";
  menu.style.left = Math.min(r.right - 160, window.innerWidth - 180) + "px";
  menu.innerHTML = `
    <button data-act="open">打開</button>
    <button data-act="rename">重新命名</button>
    <button data-act="export">匯出 PDF</button>
    <button data-act="delete" class="danger">刪除</button>
  `;
  document.body.appendChild(menu);
  menu.onclick = async (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    closeMenus();
    if (act === "open") openNote(note.id);
    if (act === "rename") renameNote(note);
    if (act === "export") {
      const data = await db.getNote(note.id);
      await exportPdf(data.note, data.pages);
    }
    if (act === "delete") confirmDelete(note);
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
}

function renameNote(note) {
  const title = prompt("重新命名畫布", note.title || "未命名畫布");
  if (title == null) return;
  note.title = title.trim() || "未命名畫布";
  note.updatedAt = Date.now();
  db.putNote(note).then(loadList);
}

function confirmDelete(note) {
  showDialog({
    title: "刪除呢塊畫布？",
    body: `「${note.title || "未命名畫布"}」刪除之後就恢復唔到。`,
    confirm: "刪除",
    danger: true,
    onConfirm: async () => {
      await db.deleteNote(note.id);
      await loadList();
    },
  });
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
  const page = currentPage();
  const n = state.pages.length;
  const i = state.pageIndex + 1;
  $app.innerHTML = `
    <div class="editor">
      <header class="topbar">
        <button class="page-btn" id="backBtn" aria-label="返回">${svg('<path d="M15 6l-6 6 6 6"/>', 20)}</button>
        <input class="title-input" id="titleInput" value="${escapeAttr(state.note.title || "")}" placeholder="未命名畫布" />
        <div class="save-status" id="saveStatus"></div>
        <button class="page-btn" id="uploadBtn">上載 PDF／圖片</button>
        <button class="btn btn-primary" id="exportBtn">匯出 PDF</button>
        <input id="fileInput" type="file" accept="application/pdf,image/*" multiple class="hidden" />
      </header>
      <div class="stage">
        <aside class="tools" id="tools"></aside>
        <div class="board-wrap" id="boardWrap">
          <div class="paper" id="paper">
            <canvas id="bgCanvas"></canvas>
            <canvas id="inkCanvas"></canvas>
            <div class="text-layer" id="textLayer"></div>
          </div>
        </div>
      </div>
      <footer class="statusbar">
        <button class="page-btn" id="prevPage" ${state.pageIndex === 0 ? "disabled" : ""}>上一頁</button>
        <div class="page-indicator">第 ${i} / ${n} 頁</div>
        <button class="page-btn" id="nextPage" ${state.pageIndex >= n - 1 ? "disabled" : ""}>下一頁</button>
        <button class="page-btn" id="addPage">新增一頁</button>
      </footer>
    </div>
  `;
  renderTools();
  renderSaveStatus();
  bindEditor();
  layoutPaper();
}

function renderTools() {
  const tools = document.getElementById("tools");
  if (!tools) return;
  const items = [
    ["pen", "筆", '<path d="M4 20l3.5-1 11-11a2.1 2.1 0 0 0 0-3l-1.5-1.5a2.1 2.1 0 0 0-3 0l-11 11L4 20z"/>'],
    ["highlighter", "螢光筆", '<path d="M5 20h7l8-8-4-4-8 8v4z"/><path d="M13 8l4 4"/>'],
    ["eraser", "擦膠", '<path d="M5 15l7-7 6 6-7 7H8l-3-3z"/><path d="M10 10l6 6"/>'],
    ["text", "文字", '<path d="M5 6h14M12 6v14"/>'],
  ];
  tools.innerHTML = items
    .map(
      ([id, label, path]) =>
        `<button class="tool ${state.tool === id ? "active" : ""}" data-tool="${id}" title="${label}">${svg(path)}</button>`
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
    await saveCurrent();
    state.view = "list";
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
  setupDrawing();
}


async function goPage(i) {
  if (i < 0 || i >= state.pages.length) return;
  state.pageIndex = i;
  renderEditor();
}

function layoutPaper() {
  const wrap = document.getElementById("boardWrap");
  const paper = document.getElementById("paper");
  const page = currentPage();
  if (!wrap || !paper || !page) return;
  const aspect = page.aspect || 4 / 3;
  const maxW = wrap.clientWidth - 8;
  const maxH = wrap.clientHeight - 8;
  let w = maxW;
  let h = w / aspect;
  if (h > maxH) {
    h = maxH;
    w = h * aspect;
  }
  paper.style.width = w + "px";
  paper.style.height = h + "px";
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  for (const id of ["bgCanvas", "inkCanvas"]) {
    const c = document.getElementById(id);
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  redrawPage();
  renderTextBoxes();
}

async function redrawPage() {
  const page = currentPage();
  const bg = document.getElementById("bgCanvas");
  const ink = document.getElementById("inkCanvas");
  if (!page || !bg || !ink) return;
  const w = bg.clientWidth;
  const h = bg.clientHeight;
  const bctx = bg.getContext("2d");
  const ictx = ink.getContext("2d");
  bctx.clearRect(0, 0, w, h);
  ictx.clearRect(0, 0, w, h);
  await drawPageToContext(bctx, page, 0, 0, w, h, false);
  drawStrokes(ictx, page.strokes, w, h);
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
function acceptPointer(e) {
  if (e.pointerType === "pen") {
    lastPenAt = Date.now();
    return true;
  }
  if (e.pointerType === "touch" && Date.now() - lastPenAt < 1400) return false;
  return true;
}

function setupDrawing() {
  const canvas = document.getElementById("inkCanvas");
  if (!canvas) return;
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  updateTextLayerPointer();
}

function updateTextLayerPointer() {
  const layer = document.getElementById("textLayer");
  const canvas = document.getElementById("inkCanvas");
  if (!layer || !canvas) return;
  const textMode = state.tool === "text";
  layer.style.pointerEvents = textMode ? "auto" : "none";
  canvas.style.pointerEvents = textMode ? "none" : "auto";
  if (textMode) {
    layer.style.cursor = "text";
    layer.onclick = (e) => {
      if (e.target !== layer) return;
      const rec = layer.getBoundingClientRect();
      addTextBox((e.clientX - rec.left) / rec.width, (e.clientY - rec.top) / rec.height);
    };
  } else {
    layer.onclick = null;
  }
}

function canvasPoint(e, canvas) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) / r.width,
    y: (e.clientY - r.top) / r.height,
    p: e.pressure && e.pressure > 0 ? e.pressure : 0.6,
  };
}

function onPointerDown(e) {
  if (!acceptPointer(e)) return;
  if (state.tool === "text") return;
  e.preventDefault();
  const canvas = e.currentTarget;
  canvas.setPointerCapture(e.pointerId);
  const pt = canvasPoint(e, canvas);
  const page = currentPage();
  if (state.tool === "eraser") {
    drawing = { mode: "erase", erased: false };
    if (eraseAt(page, pt)) {
      drawing.erased = true;
      redrawPage();
    }
    return;
  }
  const color = state.tool === "highlighter" ? "#ffe14a" : PEN_COLORS.find((c) => c.id === state.color).value;
  const widthSpec = WIDTHS.find((w) => w.id === state.width);
  const width = state.tool === "highlighter" ? widthSpec.high : widthSpec.pen;
  drawing = {
    mode: "draw",
    stroke: { id: uid(), tool: state.tool, color, width, points: [pt] },
  };
  const ink = canvas.getContext("2d");
  // preview first point
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  drawStrokes(ink, [drawing.stroke], w, h);
}

function onPointerMove(e) {
  if (!drawing) return;
  if (!acceptPointer(e) && drawing.mode !== "draw") return;
  e.preventDefault();
  const canvas = e.currentTarget;
  const pt = canvasPoint(e, canvas);
  const page = currentPage();
  if (drawing.mode === "erase") {
    if (eraseAt(page, pt)) {
      drawing.erased = true;
      redrawPage();
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
  // draw last segment only
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

function onPointerUp(e) {
  if (!drawing) return;
  const page = currentPage();
  if (drawing.mode === "erase") {
    if (drawing.erased) markDirty();
    drawing = null;
    return;
  }
  pushUndo();
  page.strokes = page.strokes.concat(drawing.stroke);
  drawing = null;
  markDirty();
  redrawPage();
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

function renderTextBoxes() {
  const layer = document.getElementById("textLayer");
  const page = currentPage();
  if (!layer || !page) return;
  layer.innerHTML = "";
  const rec = layer.getBoundingClientRect();
  for (const box of page.textBoxes) {
    const el = document.createElement("textarea");
    el.className = "text-box";
    el.value = box.text || "";
    el.style.left = box.x * rec.width + "px";
    el.style.top = box.y * rec.height + "px";
    el.style.width = (box.w || 0.28) * rec.width + "px";
    el.style.color = box.color || "#1a1a1a";
    el.addEventListener("input", () => {
      box.text = el.value;
      markDirty();
    });
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    layer.appendChild(el);
  }
  updateTextLayerPointer();
}

function addTextBox(x, y) {
  const page = currentPage();
  pushUndo();
  const color = PEN_COLORS.find((c) => c.id === state.color).value;
  page.textBoxes.push({ id: uid(), x, y, w: 0.3, text: "", color });
  markDirty();
  renderTextBoxes();
  const layer = document.getElementById("textLayer");
  const boxes = layer.querySelectorAll("textarea");
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
  if (state.view === "editor") layoutPaper();
});

window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  }
});

loadList().catch((err) => {
  console.error(err);
  $app.innerHTML = `<div class="empty-state"><h2>無法開啟本地儲存</h2><p>請用 Chrome 或 Samsung Internet 打開呢個網站，唔好用檔案直接開啟。</p></div>`;
});
