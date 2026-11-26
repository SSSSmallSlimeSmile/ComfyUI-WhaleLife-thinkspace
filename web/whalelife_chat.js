// 「问勘」面板：在 ComfyUI 里直接跟 WhaleLife 说话。
//
// 为什么不塞进 ComfyUI 自己的侧栏组件：那套 API 各版本在变，塞进去以后
// 一次前端升级就得重写。这里自己画一个浮窗，只依赖 registerExtension ——
// 那个是稳定接口，从很早就没变过。
//
// 为什么请求发给本机 Python 而不是直连 WhaleLife：跨 origin。WhaleLife 的
// 代理只认自己那个 origin，从 8188 发过去会被拦。让 Python 这层转发，
// 谁也不用放宽防护。
//
// 两种形态，跟思维画布那个许愿面板一致：
//   浮窗  —— 拖标题条移动，拖右下角改尺寸，位置尺寸记在 localStorage。
//   侧栏  —— 贴右边整高，拖左边缘那条改宽，同时给 #graph-canvas-container
//            加右边距，让画布真的让位（不是盖在画布上）。
//
// 行为上的取舍：
//   1. 面板关掉不丢对话 —— 记录留在内存里，再打开还在。刷新页面才清。
//   2. 一次只发一条 —— 上一句没回来，发按钮是灰的。
//   3. 「填进节点」只在真有选中的文本节点时可用；填不进去就明说原因，
//      不静默失败 —— 那会让人以为填好了，跑出来还是旧提示词。
import { app } from "../../scripts/app.js";

const OPEN_ID = "whalelife.chat.open";

const LS_MODE = "whalelife.chat.mode";
const LS_RECT = "whalelife.chat.rect";
const LS_DOCK = "whalelife.chat.dockw";
const LS_SYNC = "whalelife.chat.sync";

const DEFAULT_DOCK_W = 384;
const MIN_W = 280;
const MIN_H = 220;

/** 对话记录，面板关掉也留着。刷新页面才清。 */
const history = [];
let panel = null;
let busy = false;

// 要不要把这里的问话写进主会话历史。关（默认）= 插件那边收到 transient，不落历史，
// 主窗口看不到我们来过；开 = persistent，等价于你在主窗口亲手发的那一句。
// 为什么记在 localStorage：这是习惯，不是一次性的选择，刷新页面不该忘。
let syncOn = load(LS_SYNC) === "1";

let mode = load(LS_MODE) === "dock" ? "dock" : "float";
let rect = loadRect();
let dockW = clampNum(load(LS_DOCK), DEFAULT_DOCK_W, MIN_W, 2400);

// 建一次、之后只更新内容。原来每次 render 把整块 DOM 拆了重建，拖一半就断。
let view = null;
let dockedHost = null;
let savedHostState = null;

function load(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    /* 无痕模式写不进去就算了，本次有效 */
  }
}

function clampNum(n, fallback, min, max) {
  // 注意：Number(null) 是 0，不先挡掉的话「没存过」会被当成 0 再夹到最小值。
  if (n === null || n === undefined || n === "") return fallback;
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(Math.max(v, min), max);
}

function loadRect() {
  const raw = load(LS_RECT);
  if (!raw) return { x: null, y: null, w: 380, h: 520 };
  try {
    const p = JSON.parse(raw);
    return {
      x: Number.isFinite(p?.x) ? p.x : null,
      y: Number.isFinite(p?.y) ? p.y : null,
      w: clampNum(p?.w, 380, MIN_W, 2400),
      h: clampNum(p?.h, 520, MIN_H, 1600),
    };
  } catch {
    return { x: null, y: null, w: 380, h: 520 };
  }
}

function saveRect() {
  save(LS_RECT, JSON.stringify(rect));
}

/** 浮窗的实际坐标：没存过、或者存过但已经出屏，就回到右下角。 */
function effRect() {
  const vw = window.innerWidth || 1400;
  const vh = window.innerHeight || 900;
  const w = clampNum(rect.w, 380, MIN_W, Math.max(MIN_W, vw - 40));
  const h = clampNum(rect.h, 520, MIN_H, Math.max(MIN_H, vh - 40));
  let x = rect.x;
  let y = rect.y;
  if (!Number.isFinite(x) || x < 0 || x > vw - 80) x = Math.max(8, vw - w - 18);
  if (!Number.isFinite(y) || y < 0 || y > vh - 60) y = Math.max(8, vh - h - 84);
  return { x, y, w, h };
}

function toast(message, bad) {
  try {
    if (app.extensionManager?.toast) {
      app.extensionManager.toast.add({
        severity: bad ? "error" : "success",
        summary: "WhaleLife",
        detail: message,
        life: bad ? 10000 : 4000,
      });
      return;
    }
  } catch {
    /* 老前端没有 toast */
  }
  window.alert("WhaleLife：" + message);
}

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.setAttribute("style", style);
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ---------------------------------------------------------------- 布局 */

/**
 * 侧栏模式让画布让位：给 #graph-canvas-container 加右边距，再喊一次 resize。
 * 为什么加边距而不是改宽度：它父级是 grid，margin 会自然把内容框挤窄，
 * canvas 是 absolute inset-0，跟着容器走。窗口尺寸变化时前端自己还会重算。
 */
function dockCanvas(on) {
  const host = document.getElementById("graph-canvas-container");
  if (!host) return;
  if (on) {
    if (!savedHostState) {
      savedHostState = {
        host,
        width: host.style.width || "",
        marginRight: host.style.marginRight || "",
      };
    }
    dockedHost = host;
    // 为什么改宽度而不是加 margin-right：这个容器已经有确定宽度（grid 里被撑满），
    // 再给 margin 只会溢出，画布一点不缩。实测过，margin 加了画布还是 1378 宽。
    const parent = host.parentElement;
    const avail = parent?.clientWidth || window.innerWidth || 1400;
    host.style.width = Math.max(240, avail - Math.round(dockW)) + "px";
    host.style.marginRight = "0";
  } else if (savedHostState) {
    savedHostState.host.style.width = savedHostState.width;
    savedHostState.host.style.marginRight = savedHostState.marginRight;
    savedHostState = null;
    dockedHost = null;
  } else {
    return;
  }
  try {
    app.canvas?.resize?.();
  } catch {
    /* 画布还没就绪就下次再说 */
  }
}

function applyLayout() {
  if (!panel || !view) return;
  const { bar, splitter, resizer } = view;
  if (mode === "dock") {
    panel.style.left = "auto";
    panel.style.top = "0";
    panel.style.right = "0";
    panel.style.bottom = "0";
    panel.style.width = Math.round(dockW) + "px";
    panel.style.height = "100vh";
    panel.style.borderRadius = "0";
    panel.style.borderTop = "0";
    panel.style.borderRight = "0";
    panel.style.borderBottom = "0";
    splitter.style.display = "block";
    resizer.style.display = "none";
    bar.style.cursor = "default";
    dockCanvas(true);
  } else {
    const r = effRect();
    rect = { ...rect, x: r.x, y: r.y, w: r.w, h: r.h };
    panel.style.left = r.x + "px";
    panel.style.top = r.y + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.width = r.w + "px";
    panel.style.height = r.h + "px";
    panel.style.borderRadius = "12px";
    panel.style.borderTop = "1px solid rgba(127,127,127,.35)";
    panel.style.borderRight = "1px solid rgba(127,127,127,.35)";
    panel.style.borderBottom = "1px solid rgba(127,127,127,.35)";
    splitter.style.display = "none";
    resizer.style.display = "block";
    bar.style.cursor = "move";
    dockCanvas(false);
  }
  updateModeButton();
  positionLauncher();
}

/** 侧栏占满右边的时候，那颗圆按钮让到面板左边，免得压着输入框。 */
function positionLauncher() {
  if (!launcher) return;
  launcher.style.right = (mode === "dock" ? Math.round(dockW) + 18 : 18) + "px";
}

function updateModeButton() {
  if (!view) return;
  view.modeBtn.textContent = mode === "dock" ? "浮出" : "收到旁边";
  view.modeBtn.title =
    mode === "dock" ? "变回可拖动的浮窗" : "收成贴右边的侧栏，画布会让出位置";
}

function setMode(next) {
  if (mode === next) return;
  // 从侧栏切回浮窗时，宽度沿用侧栏那份，免得突然变窄。
  if (next === "float" && mode === "dock") rect.w = Math.max(MIN_W, dockW);
  mode = next;
  save(LS_MODE, mode);
  applyLayout();
}

/* ---------------------------------------------------------------- 拖动 */

function beginDrag(event) {
  if (mode !== "float") return;
  if (!panel) return;
  if (event.target.closest("button")) return;
  event.preventDefault();
  const r = effRect();
  const dx = event.clientX - r.x;
  const dy = event.clientY - r.y;
  const move = (ev) => {
    const nx = Math.min(Math.max(0, ev.clientX - dx), (window.innerWidth || 1400) - 100);
    const ny = Math.min(Math.max(0, ev.clientY - dy), (window.innerHeight || 900) - 48);
    rect.x = nx;
    rect.y = ny;
    panel.style.left = nx + "px";
    panel.style.top = ny + "px";
  };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    saveRect();
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}

function beginResize(event) {
  if (mode !== "float") return;
  event.preventDefault();
  event.stopPropagation();
  const r = effRect();
  const sx = event.clientX;
  const sy = event.clientY;
  const move = (ev) => {
    rect.w = clampNum(r.w + (ev.clientX - sx), r.w, MIN_W, (window.innerWidth || 1400) - r.x - 8);
    rect.h = clampNum(r.h + (ev.clientY - sy), r.h, MIN_H, (window.innerHeight || 900) - r.y - 8);
    panel.style.width = rect.w + "px";
    panel.style.height = rect.h + "px";
  };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    saveRect();
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}

function beginDockResize(event) {
  if (mode !== "dock") return;
  event.preventDefault();
  const sx = event.clientX;
  const startW = dockW;
  const move = (ev) => {
    const maxW = Math.max(MIN_W, (window.innerWidth || 1400) * 0.65);
    dockW = clampNum(startW + (sx - ev.clientX), startW, MIN_W, maxW);
    panel.style.width = Math.round(dockW) + "px";
    positionLauncher();
    dockCanvas(true);
  };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    save(LS_DOCK, Math.round(dockW));
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}

/* ---------------------------------------------------------------- 外壳 */

function buildShell() {
  panel = el(
    "div",
    [
      "position:fixed",
      "display:flex",
      "flex-direction:column",
      "z-index:9000",
      "overflow:hidden",
      "background:var(--comfy-menu-bg,#202124)",
      "color:var(--fg-color,#eee)",
      "border:1px solid rgba(127,127,127,.35)",
      "box-shadow:0 12px 40px rgba(0,0,0,.45)",
      "font-size:13px",
      "box-sizing:border-box",
    ].join(";"),
  );
  panel.id = "whalelife-chat-panel";

  // 侧栏模式：左边缘那条，拖它改宽度。
  const splitter = el(
    "div",
    [
      "position:absolute",
      "left:0",
      "top:0",
      "bottom:0",
      "width:6px",
      "cursor:col-resize",
      "z-index:2",
      "touch-action:none",
      "display:none",
    ].join(";"),
  );
  splitter.id = "whalelife-chat-splitter";
  splitter.title = "拖这里改宽度";
  splitter.onmousedown = beginDockResize;
  panel.appendChild(splitter);

  const bar = el(
    "div",
    "display:flex;align-items:center;gap:6px;padding:9px 12px;border-bottom:1px solid rgba(127,127,127,.28);flex-shrink:0;user-select:none",
  );
  bar.onmousedown = beginDrag;
  bar.appendChild(el("strong", "font-size:13px;flex:1", "问勘"));

  const modeBtn = el(
    "button",
    "cursor:pointer;border:1px solid rgba(127,127,127,.35);border-radius:7px;background:transparent;color:inherit;font-size:12px;padding:3px 8px;font-family:inherit",
    "收到旁边",
  );
  modeBtn.onclick = () => setMode(mode === "dock" ? "float" : "dock");
  bar.appendChild(modeBtn);

  const close = el(
    "button",
    "cursor:pointer;border:0;background:transparent;color:inherit;font-size:16px;line-height:1;padding:0 2px",
    "×",
  );
  close.title = "收起（记录还在）";
  close.onclick = unmount;
  bar.appendChild(close);
  panel.appendChild(bar);

  const list = el(
    "div",
    "flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px;min-height:0",
  );
  panel.appendChild(list);

  const foot = el(
    "div",
    "padding:9px 12px;border-top:1px solid rgba(127,127,127,.28);display:flex;flex-direction:column;gap:8px;flex-shrink:0",
  );
  const input = el(
    "textarea",
    "width:100%;box-sizing:border-box;min-height:56px;max-height:30vh;padding:8px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font-family:inherit;font-size:13px;line-height:1.5;resize:none",
  );
  input.placeholder = "说点什么。Ctrl+Enter 发送。";
  input.onkeydown = (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      send();
    }
  };
  foot.appendChild(input);

  const row = el("div", "display:flex;gap:8px;align-items:center");
  const sendBtn = el(
    "button",
    [
      "padding:6px 14px",
      "border-radius:8px",
      "border:1px solid rgba(124,92,255,.5)",
      "background:rgba(124,92,255,.22)",
      "color:inherit",
      "cursor:pointer",
      "font-size:13px",
      "font-family:inherit",
    ].join(";"),
    "发送",
  );
  sendBtn.onclick = send;
  const fillBtn = el(
    "button",
    "padding:6px 12px;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;cursor:pointer;font-size:13px;font-family:inherit",
    "填进选中节点",
  );
  fillBtn.title = "把最后一条回复写进画布上选中的文本节点";
  fillBtn.onclick = fillSelectedNode;
  row.appendChild(sendBtn);
  row.appendChild(fillBtn);
  foot.appendChild(row);

  const syncLabel = el(
    "label",
    "display:flex;align-items:center;gap:6px;cursor:pointer;color:#9a9ea8;font-size:12px",
  );
  const syncBox = document.createElement("input");
  syncBox.type = "checkbox";
  syncBox.checked = syncOn;
  syncBox.style.cssText = "margin:0;cursor:pointer";
  syncBox.onchange = () => {
    syncOn = syncBox.checked;
    save(LS_SYNC, syncOn ? "1" : "0");
    toast(syncOn ? "之后这里问的话会写进主对话历史" : "之后这里问的话不进主对话历史");
  };
  syncLabel.appendChild(syncBox);
  syncLabel.appendChild(document.createTextNode("同步到主对话"));
  syncLabel.title =
    "勾上：这里的问话等于你在主窗口亲手发的，会留在历史里；不勾：只在面板里，主窗口看不见。";
  foot.appendChild(syncLabel);
  panel.appendChild(foot);

  // 浮窗模式：右下角那个抓手。
  const resizer = el(
    "button",
    [
      "position:absolute",
      "right:2px",
      "bottom:2px",
      "width:18px",
      "height:18px",
      "padding:0",
      "border:0",
      "background:transparent",
      "color:#8b8f9a",
      "cursor:nwse-resize",
      "z-index:3",
      "display:none",
    ].join(";"),
  );
  resizer.id = "whalelife-chat-resizer";
  resizer.title = "拖这里改大小";
  resizer.onmousedown = beginResize;
  resizer.textContent = "◢";
  resizer.style.fontSize = "11px";
  resizer.style.lineHeight = "18px";
  panel.appendChild(resizer);

  view = { bar, list, input, sendBtn, fillBtn, splitter, resizer, modeBtn };

  function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = "";
    void ask(text);
  }
}

function mount() {
  if (panel) return;
  buildShell();
  document.body.appendChild(panel);
  applyLayout();
  renderMessages();
}

function unmount() {
  if (!panel) return;
  dockCanvas(false);
  panel.remove();
  panel = null;
  view = null;
}

/* ---------------------------------------------------------------- 内容 */

function renderMessages() {
  if (!panel || !view) return;
  const { list, sendBtn } = view;
  list.textContent = "";
  if (!history.length) {
    list.appendChild(
      el(
        "div",
        "color:#8b8f9a;line-height:1.7",
        "问一句试试。默认不写进主会话历史；要它留痕，勾下面那个「同步到主对话」。",
      ),
    );
  }
  for (const item of history) {
    const mine = item.role === "me";
    const bad = item.role === "bad";
    const bubble = el(
      "div",
      [
        "padding:8px 10px",
        "border-radius:10px",
        "line-height:1.65",
        "white-space:pre-wrap",
        "word-break:break-word",
        "max-width:88%",
        mine ? "align-self:flex-end" : "align-self:flex-start",
        mine
          ? "background:rgba(124,92,255,.20);border:1px solid rgba(124,92,255,.35)"
          : bad
            ? "background:rgba(220,38,38,.14);border:1px solid rgba(220,38,38,.35)"
            : "background:rgba(127,127,127,.14);border:1px solid rgba(127,127,127,.28)",
      ].join(";"),
      item.text,
    );
    list.appendChild(bubble);
  }
  if (busy) list.appendChild(el("div", "color:#8b8f9a;align-self:flex-start", "…等回话"));
  // 新内容进来滚到底。放在 append 之后才量得到真实高度。
  list.scrollTop = list.scrollHeight;

  sendBtn.textContent = busy ? "等回话…" : "发送";
  sendBtn.style.opacity = busy ? ".45" : "1";
  sendBtn.style.cursor = busy ? "default" : "pointer";
}

/* ---------------------------------------------------------------- 收发 */

async function ask(text) {
  if (busy) return;
  busy = true;
  history.push({ role: "me", text });
  renderMessages();
  try {
    const response = await fetch("/whalelife/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        graph: collectGraph(),
        mode: syncOn ? "persistent" : "transient",
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      history.push({ role: "bad", text: data.error || `没成（HTTP ${response.status}）` });
    } else {
      history.push({ role: "her", text: String(data.reply || "") });
    }
  } catch (error) {
    history.push({ role: "bad", text: "连不上 ComfyUI 后端：" + (error?.message || error) });
  } finally {
    busy = false;
    renderMessages();
  }
}

/**
 * 把画布上「看得见的东西」打包成一份纯文本摘要：选中的节点全量、整图只给计数。
 * 为什么整图不给全量：三十个节点的完整参数塞进去就是几万字，把真正要看的那几个淹掉。
 */
function collectGraph() {
  const nodes = app.graph?._nodes ?? [];
  const selected = nodes.filter((node) => node?.is_selected || node?.selected);
  const brief = (node) => {
    const widgets = {};
    for (const widget of node?.widgets ?? []) {
      const key = String(widget?.name ?? "?");
      let value = widget?.value;
      if (value === undefined || value === null) continue;
      if (typeof value === "string" && value.length > 200) value = value.slice(0, 200) + "…";
      if (typeof value === "object") continue; // 连接类的值，不是参数
      widgets[key] = value;
    }
    const inputs = (node?.inputs ?? []).map((slot) => slot?.name).filter(Boolean);
    return {
      id: node?.id,
      type: node?.type ?? node?.comfyClass ?? "?",
      title: node?.title && node.title !== node.type ? node.title : undefined,
      widgets,
      inputs,
    };
  };
  const counts = {};
  for (const node of nodes) {
    const type = String(node?.type ?? "?");
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return {
    total: nodes.length,
    links: app.graph?.links?.size ?? app.graph?._links?.length ?? 0,
    counts,
    selected: selected.slice(0, 8).map(brief),
    selectedCount: selected.length,
  };
}

/** 把最后一条回复写进当前选中的文本节点。 */
function fillSelectedNode() {
  const last = [...history].reverse().find((item) => item.role === "her");
  if (!last) {
    toast("还没有她的回复。", true);
    return;
  }
  const nodes = app.graph?._nodes ?? [];
  const selected = nodes.filter((node) => node?.is_selected || node?.selected);
  if (!selected.length) {
    toast("先在画布上点一个节点（CLIPTextEncode 之类）。", true);
    return;
  }
  let ok = 0;
  for (const node of selected) {
    const widgets = node.widgets ?? [];
    const target =
      widgets.find((widget) => widget.name === "text") ??
      widgets.find((widget) => widget.name === "string") ??
      widgets.find((widget) => typeof widget.value === "string");
    if (!target) continue;
    target.value = last.text;
    // 有的节点换了 value 不重画，手动喊一声；没有这个回调也不影响。
    try {
      target.callback?.(last.text);
      node.setDirtyCanvas?.(true, true);
    } catch {
      /* 忽略 */
    }
    ok += 1;
  }
  if (ok) toast(`填进 ${ok} 个节点了。`);
  else toast("选中的节点没有能填文字的控件。", true);
}

/* ---------------------------------------------------------------- 入口 */

let launcher = null;

function togglePanel() {
  if (panel) unmount();
  else mount();
}

/**
 * 右下角常驻小按钮。
 * 为什么非要它：0.46 的前端把原来那排文字菜单换掉了，没有「编辑」这条，
 * 只挂 menuCommands 的话入口就没了。按钮是固定定位在 body 上的，
 * 不受前端根节点重绘影响。
 */
function mountLauncher() {
  if (launcher || !document.body) return;
  launcher = el(
    "button",
    [
      "position:fixed",
      "right:18px",
      "bottom:18px",
      "width:56px",
      "height:56px",
      "border-radius:28px",
      "z-index:9001",
      "border:1px solid rgba(124,92,255,.55)",
      "background:rgba(124,92,255,.3)",
      "color:inherit",
      "font-size:14px",
      "font-family:inherit",
      "cursor:pointer",
      "box-shadow:0 8px 24px rgba(0,0,0,.45)",
    ].join(";"),
    "问勘",
  );
  launcher.id = "whalelife-chat-launcher";
  launcher.title = "问勘（在 ComfyUI 里跟勘说话）";
  launcher.onclick = togglePanel;
  document.body.appendChild(launcher);
}

// 窗口尺寸变了：侧栏要重算画布边距，浮窗要防止跑到屏幕外。
window.addEventListener("resize", () => {
  if (!panel) return;
  if (mode === "dock") {
    panel.style.width = Math.round(dockW) + "px";
    positionLauncher();
    dockCanvas(true);
  } else {
    const r = effRect();
    rect = { ...rect, ...r };
    panel.style.left = r.x + "px";
    panel.style.top = r.y + "px";
    panel.style.width = r.w + "px";
    panel.style.height = r.h + "px";
  }
});

app.registerExtension({
  name: "WhaleLife.ThinkSpace.Chat",
  commands: [{ id: OPEN_ID, label: "问勘（打开对话面板）", function: togglePanel }],
  // 老前端有「编辑」菜单，挂那儿；新前端没有这条菜单，真入口是下面那个按钮。
  menuCommands: [{ path: ["Edit"], commands: [OPEN_ID] }],
  setup() {
    mountLauncher();
    // 前端是异步挂载的，body 有时还没就绪，隔一会儿补一次。
    setTimeout(mountLauncher, 800);
  },
});
