/* 开发者工具箱 —— 纯前端脚本，无后端、无追踪
 * 结构：工具函数 → 主题 → 标签页 → 各工具模块 → Service Worker
 */
"use strict";

/* ================= 工具函数 ================= */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/** 复制文本，clipboard 不可用时回退 execCommand（file:// 等非安全上下文） */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* 忽略 */ }
    ta.remove();
    return ok;
  }
}

/** 复制后给按钮一个可视反馈 */
function flashBtn(btn, text = "✓ 已复制") {
  if (btn.dataset.origText === undefined) btn.dataset.origText = btn.textContent;
  btn.textContent = text;
  btn.classList.add("copied");
  clearTimeout(btn._flashTimer);
  btn._flashTimer = setTimeout(() => {
    btn.textContent = btn.dataset.origText;
    btn.classList.remove("copied");
  }, 1500);
}

function bindCopyBtn(btn, getText) {
  btn.addEventListener("click", async () => {
    if (await copyText(getText())) flashBtn(btn);
  });
}

function setMsg(el, text, type) {
  el.textContent = text;
  el.className = "msg" + (type ? " " + type : "");
}

/** 动态按需加载脚本（首次用到才下载，失败可重试） */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("脚本加载失败：" + src));
    document.head.appendChild(s);
  });
}

/** 本地日期 YYYY-MM-DD（修复 UTC 时区导致的"晚上显示昨天"问题） */
function localDateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ================= 主题 ================= */
const themeBtn = $("#themeToggle");
const darkQuery = matchMedia("(prefers-color-scheme: dark)");

function applyTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "";
  themeBtn.textContent = theme === "dark" ? "☀️" : "🌙";
  if (persist) localStorage.setItem("toolbox-theme", theme);
}
applyTheme(localStorage.getItem("toolbox-theme") ?? (darkQuery.matches ? "dark" : "light"), false);

themeBtn.addEventListener("click", () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
// 系统主题变化时若用户未手动选过，则跟随
darkQuery.addEventListener("change", (e) => {
  if (!localStorage.getItem("toolbox-theme")) applyTheme(e.matches ? "dark" : "light", false);
});

/* ================= 标签页（ARIA tabs + 键盘导航） ================= */
const TOOL_NAMES = {
  json: "JSON 格式化", timestamp: "时间戳转换", qrcode: "二维码生成",
  password: "密码生成", markdown: "Markdown 预览", daily: "每日一签",
};
const tabs = $$('[role="tab"]');
const inited = { json: true, timestamp: true, daily: true }; // 懒初始化标记

function selectTool(name, focusTab = false) {
  if (!TOOL_NAMES[name]) return;
  tabs.forEach((tab) => {
    const on = tab.dataset.tool === name;
    tab.classList.toggle("active", on);
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focusTab) tab.focus();
  });
  $$('[role="tabpanel"]').forEach((p) => {
    const on = p.id === "tool-" + name;
    p.classList.toggle("active", on);
    p.toggleAttribute("hidden", !on);
  });
  document.title = `${TOOL_NAMES[name]} · 开发者工具箱`;
  history.replaceState(null, "", "#" + name);
  if (!inited[name]) {
    inited[name] = true;
    if (name === "markdown") initMarkdown();
    if (name === "qrcode") drawQrPlaceholder();
  }
}

tabs.forEach((tab) => tab.addEventListener("click", () => selectTool(tab.dataset.tool)));

// 键盘：左右方向键 / Home / End 在标签间移动（ARIA tabs 规范）
$(".tool-nav").addEventListener("keydown", (e) => {
  const idx = tabs.findIndex((t) => t.classList.contains("active"));
  let next = -1;
  if (e.key === "ArrowRight") next = (idx + 1) % tabs.length;
  else if (e.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = tabs.length - 1;
  if (next >= 0) { e.preventDefault(); selectTool(tabs[next].dataset.tool, true); }
});

// 全局快捷键 Alt+1~6
document.addEventListener("keydown", (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  const n = Number(e.key);
  if (n >= 1 && n <= tabs.length) { e.preventDefault(); selectTool(tabs[n - 1].dataset.tool); }
});

window.addEventListener("hashchange", () => {
  const name = location.hash.slice(1);
  if (name) selectTool(name);
});
selectTool(location.hash.slice(1) || "json");

/* 顶栏滚动阴影 */
addEventListener("scroll", () => {
  $("#siteHeader").classList.toggle("scrolled", scrollY > 4);
}, { passive: true });

/* ================= JSON 格式化 ================= */
const jsonInput = $("#jsonInput");
const jsonMsg = $("#jsonMsg");

/** 递归排序对象键 */
function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v).sort().map((k) => [k, sortKeysDeep(v[k])]));
  }
  return v;
}

/** 把 JSON.parse 的 position 转成 行:列，报错更直观 */
function locateJsonError(str, err) {
  const m = err.message.match(/position (\d+)/);
  if (!m) return err.message;
  const pos = Number(m[1]);
  const line = str.slice(0, pos).split("\n").length;
  const col = pos - str.lastIndexOf("\n", pos - 1);
  return `${err.message}（第 ${line} 行，第 ${col} 列）`;
}

function runJson(mode) {
  const src = jsonInput.value;
  if (!src.trim()) { setMsg(jsonMsg, "请先粘贴 JSON 内容"); return; }
  try {
    let obj = JSON.parse(src);
    if (mode === "sort") obj = sortKeysDeep(obj);
    jsonInput.value = mode === "minify" ? JSON.stringify(obj) : JSON.stringify(obj, null, 2);
    setMsg(jsonMsg, "✓ 转换成功", "ok");
  } catch (e) {
    setMsg(jsonMsg, "✗ JSON 无效：" + locateJsonError(src, e), "err");
  }
}
$("#jsonFormat").addEventListener("click", () => runJson("format"));
$("#jsonMinify").addEventListener("click", () => runJson("minify"));
$("#jsonSort").addEventListener("click", () => runJson("sort"));
jsonInput.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runJson("format"); }
});
bindCopyBtn($("#jsonCopy"), () => jsonInput.value);
$("#jsonSample").addEventListener("click", () => {
  jsonInput.value = JSON.stringify({
    name: "Toolbox", stars: 100, tags: ["json", "tools"],
    author: { name: "huqinyuan923-hue", site: "https://huqinyuan923-hue.github.io" },
  });
  setMsg(jsonMsg, "已填入示例，点「格式化」试试", "ok");
});
$("#jsonClear").addEventListener("click", () => { jsonInput.value = ""; setMsg(jsonMsg, ""); });

/* ================= 时间戳 ================= */
const tsNow = $("#tsNow");
setInterval(() => { tsNow.textContent = Math.floor(Date.now() / 1000); }, 1000);
tsNow.textContent = Math.floor(Date.now() / 1000);
bindCopyBtn($("#tsCopyNow"), () => tsNow.textContent);

const tsInput = $("#tsInput");
const tsOut = $("#tsOut");

/** 把毫秒差转成人类可读的相对时间 */
function relativeTime(ms) {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const units = [[31536000000, "年"], [2592000000, "个月"], [86400000, "天"],
    [3600000, "小时"], [60000, "分钟"], [1000, "秒"]];
  for (const [msPer, name] of units) {
    if (abs >= msPer || name === "秒") {
      const v = Math.round(abs / msPer);
      return diff >= 0 ? `${v} ${name}后` : `${v} ${name}前`;
    }
  }
}

$("#tsToDate").addEventListener("click", () => {
  const raw = tsInput.value.trim();
  if (!/^\d+$/.test(raw)) { setMsg(tsOut, "✗ 请输入纯数字时间戳", "err"); return; }
  const n = Number(raw);
  const ms = String(n).length >= 13 ? n : n * 1000; // 10 位视为秒，13 位以上视为毫秒
  const d = new Date(ms);
  if (isNaN(d)) { setMsg(tsOut, "✗ 数值超出日期范围", "err"); return; }
  setMsg(tsOut,
    `${d.toLocaleString("zh-CN", { hour12: false })}\n${relativeTime(ms)}`,
    "ok");
});

const dateInput = $("#dateInput");
const dateOut = $("#dateOut");
function setNow() {
  dateInput.value = localDateKey() + "T" +
    new Date().toTimeString().slice(0, 5);
}
setNow();
$("#dateNow").addEventListener("click", setNow);
$("#dateToTs").addEventListener("click", () => {
  const d = new Date(dateInput.value);
  if (isNaN(d)) { setMsg(dateOut, "✗ 请先选择日期时间", "err"); return; }
  setMsg(dateOut, `秒：${Math.floor(d.getTime() / 1000)}\n毫秒：${d.getTime()}`, "ok");
});

/* ================= 二维码（按需加载库） ================= */
const QR_LIB = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js";
const qrInput = $("#qrInput");
const qrCanvas = $("#qrCanvas");
const qrMsg = $("#qrMsg");
let qrLibPromise = null;

function ensureQrLib() {
  if (window.qrcode) return Promise.resolve();
  qrLibPromise ??= loadScript(QR_LIB);
  return qrLibPromise;
}

function drawQrPlaceholder() {
  const ctx = qrCanvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, qrCanvas.width, qrCanvas.height);
  ctx.fillStyle = "#9aa7b5";
  ctx.font = "14px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("二维码预览", qrCanvas.width / 2, qrCanvas.height / 2);
}
drawQrPlaceholder();

$("#qrGen").addEventListener("click", async () => {
  const text = qrInput.value.trim();
  setMsg(qrMsg, "");
  if (!text) { setMsg(qrMsg, "请先输入内容", "err"); return; }
  try {
    await ensureQrLib();
  } catch {
    setMsg(qrMsg, "✗ 二维码库加载失败，请检查网络后点击「生成」重试", "err");
    return;
  }
  const ecc = $("#qrEcc").value;
  const cell = Number($("#qrCell").value);
  try {
    const qr = qrcode(0, ecc); // 0 = 按内容自动选择版本
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const margin = 4 * cell;
    const size = count * cell + margin * 2;
    qrCanvas.width = qrCanvas.height = size;
    const ctx = qrCanvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#000";
    for (let r = 0; r < count; r++)
      for (let c = 0; c < count; c++)
        if (qr.isDark(r, c)) ctx.fillRect(margin + c * cell, margin + r * cell, cell, cell);
    setMsg(qrMsg, `✓ 已生成（${count}×${count} 模块，容错 ${ecc}）`, "ok");
  } catch (e) {
    setMsg(qrMsg, "✗ 生成失败：" + (String(e.message || e).includes("code length")
      ? "内容太长，试试降低容错等级或缩短内容" : e.message), "err");
  }
});

$("#qrDownload").addEventListener("click", () => {
  if (qrCanvas.width <= 220) { setMsg(qrMsg, "请先生成二维码", "err"); return; }
  const a = document.createElement("a");
  a.download = `qrcode-${localDateKey()}.png`;
  a.href = qrCanvas.toDataURL("image/png");
  a.click();
});

/* ================= 密码生成 ================= */
const pwOut = $("#pwOut");
const pwLen = $("#pwLen");
const pwLenVal = $("#pwLenVal");
const pwStrengthFill = $("#pwStrengthFill");
const pwStrengthText = $("#pwStrengthText");
const AMBIGUOUS = "lI1O0o";

const pwOpts = JSON.parse(localStorage.getItem("toolbox-pw") || "{}");
for (const [id, val] of Object.entries({ pwUpper: true, pwLower: true, pwDigit: true, pwSymbol: true, pwNoAmbiguous: false })) {
  const el = $("#" + id);
  el.checked = pwOpts[id] !== undefined ? pwOpts[id] : val;
}
pwLen.value = pwOpts.len ?? 16;
pwLenVal.textContent = pwLen.value;

function savePwOpts() {
  localStorage.setItem("toolbox-pw", JSON.stringify({
    len: Number(pwLen.value),
    pwUpper: $("#pwUpper").checked, pwLower: $("#pwLower").checked,
    pwDigit: $("#pwDigit").checked, pwSymbol: $("#pwSymbol").checked,
    pwNoAmbiguous: $("#pwNoAmbiguous").checked,
  }));
}

function charsetOf(el, base) {
  if (!el.checked) return "";
  return $("#pwNoAmbiguous").checked
    ? [...base].filter((c) => !AMBIGUOUS.includes(c)).join("")
    : base;
}

function updateStrength(len, setSize) {
  if (!setSize) { pwStrengthText.textContent = "—"; pwStrengthFill.style.width = "0"; return; }
  const bits = Math.round(len * Math.log2(setSize));
  const [cls, label] = bits < 40 ? ["", "弱"] : bits < 60 ? ["mid", "中"] : bits < 80 ? ["good", "强"] : ["strong", "极强"];
  pwStrengthFill.className = cls;
  pwStrengthFill.style.width = Math.min(100, (bits / 128) * 100) + "%";
  pwStrengthText.textContent = `${label}（约 ${bits} 位熵）`;
}

function generatePassword() {
  const sets = [
    charsetOf($("#pwUpper"), "ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
    charsetOf($("#pwLower"), "abcdefghijklmnopqrstuvwxyz"),
    charsetOf($("#pwDigit"), "0123456789"),
    charsetOf($("#pwSymbol"), "!@#$%^&*()-_=+[]{};:,.<>?"),
  ].filter(Boolean);
  if (!sets.length) { pwOut.textContent = "请至少选择一种字符"; updateStrength(0, 0); return; }
  const all = sets.join("");
  const len = Number(pwLen.value);
  const rand = crypto.getRandomValues(new Uint32Array(len));
  // 每类字符至少出现一次，其余在合集里随机取
  const chars = sets.map((set, i) => set[rand[i] % set.length]);
  for (let i = chars.length; i < len; i++) chars.push(all[rand[i] % all.length]);
  // Fisher-Yates 洗牌，打散固定位置
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rand[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  pwOut.textContent = chars.join("");
  updateStrength(len, all.length);
}
pwLen.addEventListener("input", () => { pwLenVal.textContent = pwLen.value; savePwOpts(); generatePassword(); });
$$('.opt input[type="checkbox"]').forEach((cb) =>
  cb.addEventListener("change", () => { savePwOpts(); generatePassword(); }));
$("#pwGen").addEventListener("click", generatePassword);
bindCopyBtn($("#pwCopy"), () => pwOut.textContent);
generatePassword();

/* ================= Markdown 预览（按需加载库） ================= */
const MARKED_LIB = "https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js";
const PURIFY_LIB = "https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js";
const mdInput = $("#mdInput");
const mdPreview = $("#mdPreview");
const mdCount = $("#mdCount");
const MD_DRAFT_KEY = "toolbox-md-draft";
let mdLibsPromise = null;
let mdReady = false;

function ensureMdLibs() {
  if (window.marked && window.DOMPurify) return Promise.resolve();
  mdLibsPromise ??= Promise.all([loadScript(MARKED_LIB), loadScript(PURIFY_LIB)])
    .then(() => {
      // 预览里的链接一律新窗口打开并加 noopener
      DOMPurify.addHook("afterSanitizeAttributes", (node) => {
        if (node.tagName === "A" && node.getAttribute("href")) {
          node.setAttribute("target", "_blank");
          node.setAttribute("rel", "noopener noreferrer");
        }
      });
    });
  return mdLibsPromise;
}

function renderMd() {
  if (!mdReady) return;
  mdPreview.innerHTML = DOMPurify.sanitize(marked.parse(mdInput.value));
  const chars = mdInput.value.replace(/\s/g, "").length;
  const words = mdInput.value.trim() ? mdInput.value.trim().split(/\s+/).length : 0;
  mdCount.textContent = `${chars} 字 · ${words} 词`;
}

function initMarkdown() {
  mdInput.value = localStorage.getItem(MD_DRAFT_KEY) ||
    "# 你好，Toolbox\n\n在左边输入 **Markdown**，这里会实时预览，草稿会自动保存。\n\n- 支持 `代码`、表格、引用\n- 工具栏可快捷插入语法";
  mdInput.placeholder = "# 标题\n\n正文…";
  mdPreview.textContent = "正在加载渲染库…";
  ensureMdLibs().then(() => {
    mdReady = true;
    renderMd();
  }).catch(() => {
    mdPreview.textContent = "✗ 渲染库加载失败，请检查网络后切换一次标签重试。";
  });
  mdInput.addEventListener("input", () => {
    localStorage.setItem(MD_DRAFT_KEY, mdInput.value.slice(0, 100000));
    renderMd();
  });
  $("#mdClear").addEventListener("click", () => {
    localStorage.removeItem(MD_DRAFT_KEY);
    mdInput.value = "";
    renderMd();
  });
  // 工具栏：包裹选中文本 / 行首插入 / 插入链接
  $$(".md-toolbar [data-md-wrap], .md-toolbar [data-md-line], .md-toolbar [data-md-link]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const { selectionStart: s, selectionEnd: e, value: v } = mdInput;
      const sel = v.slice(s, e);
      if (btn.dataset.mdLink !== undefined) {
        mdInput.setRangeText(`[${sel || "链接文字"}](https://)`, s, e, "end");
      } else if (btn.dataset.mdLine !== undefined) {
        const lineStart = v.lastIndexOf("\n", s - 1) + 1;
        mdInput.setRangeText(btn.dataset.mdLine, lineStart, lineStart, "end");
      } else {
        const before = btn.dataset.mdWrap.replace("\\n", "\n");
        const after = btn.dataset.mdSuffix ? btn.dataset.mdSuffix.replace("\\n", "\n") : before;
        mdInput.setRangeText(before + (sel || "") + after, s, e, "end");
      }
      mdInput.focus();
      renderMd();
      localStorage.setItem(MD_DRAFT_KEY, mdInput.value.slice(0, 100000));
    }));
}

/* ================= 每日一签 ================= */
const QUOTES = [
  ["种一棵树最好的时间是十年前，其次是现在。", "谚语"],
  ["纸上得来终觉浅，绝知此事要躬行。", "陆游"],
  ["千里之行，始于足下。", "老子"],
  ["不积跬步，无以至千里。", "荀子"],
  ["学而不思则罔，思而不学则殆。", "孔子"],
  ["宝剑锋从磨砺出，梅花香自苦寒来。", "《警世贤文》"],
  ["路漫漫其修远兮，吾将上下而求索。", "屈原"],
  ["逝者如斯夫，不舍昼夜。", "孔子"],
  ["业精于勤，荒于嬉；行成于思，毁于随。", "韩愈"],
  ["明日复明日，明日何其多。", "《明日歌》"],
  ["博观而约取，厚积而薄发。", "苏轼"],
  ["问渠那得清如许？为有源头活水来。", "朱熹"],
  ["山重水复疑无路，柳暗花明又一村。", "陆游"],
  ["长风破浪会有时，直挂云帆济沧海。", "李白"],
  ["会当凌绝顶，一览众山小。", "杜甫"],
  ["沉舟侧畔千帆过，病树前头万木春。", "刘禹锡"],
  ["不畏浮云遮望眼，自缘身在最高层。", "王安石"],
  ["落红不是无情物，化作春泥更护花。", "龚自珍"],
  ["苟日新，日日新，又日新。", "《礼记》"],
  ["天行健，君子以自强不息。", "《周易》"],
  ["Where there is a will, there is a way.", "Proverb"],
  ["The best way out is always through.", "Robert Frost"],
  ["Stay hungry, stay foolish.", "Steve Jobs"],
  ["Talk is cheap. Show me the code.", "Linus Torvalds"],
  ["Simplicity is the ultimate sophistication.", "Leonardo da Vinci"],
  ["Programs must be written for people to read.", "Harold Abelson"],
  ["The journey of a thousand miles begins with one step.", "Lao Tzu"],
  ["What we know is a drop, what we don't know is an ocean.", "Isaac Newton"],
  ["Make it work, make it right, make it fast.", "Kent Beck"],
  ["Done is better than perfect.", "Sheryl Sandberg"],
  ["First, solve the problem. Then, write the code.", "John Johnson"],
  ["Any fool can write code that a computer can understand.", "Martin Fowler"],
  ["Simplicity is prerequisite for reliability.", "Edsger W. Dijkstra"],
  ["The only way to learn a new programming language is by writing programs in it.", "Dennis Ritchie"],
  ["Premature optimization is the root of all evil.", "Donald Knuth"],
  ["Well begun is half done.", "Aristotle"],
  ["Little by little, one travels far.", "J. R. R. Tolkien"],
  ["Energy and persistence conquer all things.", "Benjamin Franklin"],
  ["It always seems impossible until it's done.", "Nelson Mandela"],
  ["The secret of getting ahead is getting started.", "Mark Twain"],
];

(function renderDaily() {
  const today = new Date();
  const key = localDateKey(today); // 本地日期，修复时区问题
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [text, author] = QUOTES[h % QUOTES.length];
  $("#dailyDate").textContent = `${key} · ${today.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}`;
  $("#dailyQuote").textContent = text;
  $("#dailyAuthor").textContent = "—— " + author;
  const img = $("#dailyImg");
  img.src = `https://picsum.photos/seed/${key}/1200/500`;
  $("#dailyWallLink").href = img.src;
  img.addEventListener("error", () => $("#dailyCard").classList.add("img-failed"));
  img.addEventListener("load", () => $("#dailyCard").classList.remove("img-failed"));
  bindCopyBtn($("#dailyCopy"), () => `${text} —— ${author}（${key} · 每日一签）`);
})();

/* ================= Service Worker（离线缓存） ================= */
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "127.0.0.1")) {
  addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => { /* SW 失败不影响功能 */ });
  });
}
