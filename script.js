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
  password: "密码生成", markdown: "Markdown 预览", color: "颜色工具",
  units: "单位换算", base: "进制转换", encode: "编码转换",
  regex: "正则测试", diff: "文本对比", cron: "Cron 解析",
  uuid: "UUID 生成", hash: "哈希计算", textstats: "文本统计", daily: "每日一签",
};
const tabs = $$('[role="tab"]');
const inited = {
  json: true, timestamp: true, daily: true, color: true, units: true,
  base: true, encode: true, regex: true, diff: true, cron: true,
  uuid: true, hash: true, textstats: true,
}; // 懒初始化标记（仅重依赖库的 markdown / qrcode 需要懒加载）

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

/* ================= 颜色工具 ================= */
function hexToRgb(hex) {
  const m = hex.replace("#", "").match(/^([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (v) => Math.round(255 * v).toString(16).padStart(2, "0");
  return "#" + toHex(f(0)) + toHex(f(8)) + toHex(f(4));
}

const colorPick = $("#colorPick");
const colorHex = $("#colorHex");
function renderColor(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return;
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  $("#cHex").textContent = hex.toLowerCase();
  $("#cRgb").textContent = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
  $("#cHsl").textContent = `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`;
  const shades = $("#colorShades");
  shades.replaceChildren();
  for (const delta of [-30, -15, 0, 15, 30]) {
    const l = Math.min(95, Math.max(5, hsl.l + delta));
    const shadeHex = hslToHex(hsl.h, hsl.s, l);
    const sw = document.createElement("div");
    sw.className = "swatch";
    const block = document.createElement("div");
    block.className = "block";
    block.style.background = shadeHex;
    const label = document.createElement("small");
    label.textContent = shadeHex;
    sw.append(block, label);
    sw.title = "点击复制 " + shadeHex;
    sw.addEventListener("click", () => { copyText(shadeHex); flashBtn(label, "已复制"); });
    shades.append(sw);
  }
}
colorPick.addEventListener("input", () => {
  colorHex.value = colorPick.value;
  renderColor(colorPick.value);
});
colorHex.addEventListener("input", () => {
  const v = colorHex.value.trim();
  if (hexToRgb(v)) {
    colorPick.value = v.length === 4
      ? "#" + [...v.slice(1)].map((c) => c + c).join("")
      : v;
    renderColor(v);
  }
});
$$("[data-copy-target]").forEach((btn) =>
  bindCopyBtn(btn, () => $("#" + btn.dataset.copyTarget).textContent));
renderColor("#2563eb");

/* ================= 单位换算 ================= */
const UNIT_TABLE = {
  length: { label: "长度", base: "m", units: { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, mi: 1609.344 } },
  weight: { label: "重量", base: "kg", units: { mg: 0.000001, g: 0.001, kg: 1, t: 1000, oz: 0.0283495, lb: 0.453592 } },
  data: { label: "数据大小", base: "B", units: { B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 } },
  temp: { label: "温度", base: "°C", units: { "°C": 1, "°F": 1, K: 1 } },
};
const unitCat = $("#unitCat"), unitFrom = $("#unitFrom"), unitTo = $("#unitTo"),
  unitVal = $("#unitVal"), unitOut = $("#unitOut");

function fillUnitSelects() {
  const cat = UNIT_TABLE[unitCat.value];
  const make = (sel) => {
    sel.replaceChildren();
    for (const u of Object.keys(cat.units)) {
      const opt = document.createElement("option");
      opt.value = u; opt.textContent = u;
      sel.append(opt);
    }
  };
  make(unitFrom); make(unitTo);
  unitFrom.selectedIndex = 0;
  unitTo.selectedIndex = Math.min(2, unitTo.children.length - 1);
}
function convertUnit() {
  const cat = unitCat.value;
  const v = parseFloat(unitVal.value);
  const from = unitFrom.value, to = unitTo.value;
  if (isNaN(v)) { unitOut.textContent = "请输入数字"; return; }
  let result;
  if (cat === "temp") {
    const toC = from === "°C" ? v : from === "°F" ? (v - 32) * 5 / 9 : v - 273.15;
    result = to === "°C" ? toC : to === "°F" ? toC * 9 / 5 + 32 : toC + 273.15;
  } else {
    const table = UNIT_TABLE[cat].units;
    result = v * table[from] / table[to];
  }
  const pretty = Math.abs(result) >= 1e9 || (Math.abs(result) < 1e-6 && result !== 0)
    ? result.toExponential(6) : parseFloat(result.toFixed(8)).toString();
  unitOut.textContent = `${v} ${from} = ${pretty} ${to}`;
}
unitCat.addEventListener("change", () => { fillUnitSelects(); convertUnit(); });
[unitVal, unitFrom, unitTo].forEach((el) => el.addEventListener("input", convertUnit));
fillUnitSelects();
convertUnit();

/* ================= 进制转换 ================= */
const baseInput = $("#baseInput"), baseFrom = $("#baseFrom"), baseOut = $("#baseOut");
function convertBase() {
  const raw = baseInput.value.trim();
  const from = Number(baseFrom.value);
  const num = parseInt(raw, from);
  baseOut.replaceChildren();
  const valid = /^[0-9a-z]+$/i.test(raw) && Number.isSafeInteger(num) &&
    raw.toLowerCase() === num.toString(from).toLowerCase();
  for (const b of [2, 8, 10, 16, 36]) {
    const row = document.createElement("div");
    row.className = "kv";
    const name = document.createElement("span");
    name.textContent = b + " 进制";
    const code = document.createElement("code");
    code.textContent = valid ? num.toString(b) : "—";
    const btn = document.createElement("button");
    btn.className = "btn mini";
    btn.textContent = "复制";
    bindCopyBtn(btn, () => code.textContent);
    row.append(name, code, btn);
    baseOut.append(row);
  }
}
baseInput.addEventListener("input", convertBase);
baseFrom.addEventListener("change", convertBase);
convertBase();

/* ================= 编码转换 ================= */
const encMode = $("#encMode"), encInput = $("#encInput"),
  encOutput = $("#encOutput"), encMsg = $("#encMsg");

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.trim());
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function runEncode() {
  encMsg.className = "msg";
  const text = encInput.value;
  try {
    let out = "";
    switch (encMode.value) {
      case "urlEnc": out = encodeURIComponent(text); break;
      case "urlDec": out = decodeURIComponent(text); break;
      case "b64Enc": out = b64encode(text); break;
      case "b64Dec": out = b64decode(text); break;
      case "uniEnc":
        out = [...text].map((c) =>
          c.codePointAt(0) > 126
            ? "\\u" + c.codePointAt(0).toString(16).padStart(4, "0")
            : c).join("");
        break;
      case "uniDec":
        out = text.replace(/\\u\{?([0-9a-f]{1,6})\}?/gi, (_, n) =>
          String.fromCodePoint(parseInt(n, 16)));
        break;
    }
    encOutput.value = out;
    setMsg(encMsg, "✓ 转换成功", "ok");
  } catch (e) {
    setMsg(encMsg, "✗ " + (e.message || "转换失败"), "err");
  }
}
encMode.addEventListener("change", runEncode);
encInput.addEventListener("input", runEncode);
$("#encRun").addEventListener("click", runEncode);
bindCopyBtn($("#encCopy"), () => encOutput.value);
encInput.value = "你好，Toolbox";
runEncode();

/* ================= 正则测试 ================= */
const rePattern = $("#rePattern"), reFlags = $("#reFlags"),
  reText = $("#reText"), reMsg = $("#reMsg"),
  rePreview = $("#rePreview"), reGroups = $("#reGroups");

function renderRegex() {
  reGroups.replaceChildren();
  rePreview.replaceChildren();
  const pattern = rePattern.value, flags = [...new Set(reFlags.value)].join("");
  if (!pattern) { setMsg(reMsg, ""); return; }
  let re;
  try {
    re = new RegExp(pattern, flags);
  } catch (e) {
    setMsg(reMsg, "✗ 正则无效：" + e.message, "err");
    return;
  }
  const text = reText.value;
  const frag = document.createDocumentFragment();
  let last = 0, count = 0;
  const matches = flags.includes("g")
    ? [...text.matchAll(new RegExp(pattern, flags))]
    : (text.match(new RegExp(pattern, flags)) ? [text.match(new RegExp(pattern, flags))] : []);
  for (const m of matches) {
    if (count > 999) break;
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[0].length === 0) { frag.append(text[m.index] ?? ""); last = m.index + 1; continue; }
    const span = document.createElement("span");
    span.className = "hl";
    span.textContent = m[0];
    frag.append(span);
    last = m.index + m[0].length;
    count++;
    if (m.length > 1) {
      const line = document.createElement("div");
      line.textContent = `匹配 ${count}：「${m[0].slice(0, 60)}」 捕获组：` +
        m.slice(1).map((g, i) => `$${i + 1}=${g === undefined ? "∅" : String(g).slice(0, 40)}`).join("  ");
      reGroups.append(line);
    }
  }
  frag.append(text.slice(last));
  rePreview.append(frag);
  setMsg(reMsg, count ? `✓ 命中 ${count} 处` : "没有匹配", count ? "ok" : "");
}
[rePattern, reFlags].forEach((el) => el.addEventListener("input", renderRegex));
reText.addEventListener("input", renderRegex);
renderRegex();

/* ================= 文本对比 ================= */
const diffA = $("#diffA"), diffB = $("#diffB"),
  diffView = $("#diffView"), diffStat = $("#diffStat");

function diffLines(aText, bText) {
  const a = aText.split("\n").slice(0, 500);
  const b = bText.split("\n").slice(0, 500);
  const n = a.length, m = b.length;
  // LCS 动态规划
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: "same", s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: "del", s: a[i] }); i++; }
    else { out.push({ t: "add", s: b[j] }); j++; }
  }
  while (i < n) out.push({ t: "del", s: a[i++] });
  while (j < m) out.push({ t: "add", s: b[j++] });
  return out;
}
function runDiff() {
  diffView.replaceChildren();
  const rows = diffLines(diffA.value, diffB.value);
  let add = 0, del = 0;
  for (const r of rows) {
    if (r.t !== "same") {
      if (r.t === "add") add++; else del++;
      const line = document.createElement("div");
      line.className = "diff-line " + r.t;
      line.textContent = r.s;
      diffView.append(line);
    }
  }
  if (!add && !del) {
    const line = document.createElement("div");
    line.className = "diff-line";
    line.textContent = "✓ 两段文本完全一致";
    diffView.append(line);
  }
  diffStat.textContent = `新增 ${add} 行 · 删除 ${del} 行`;
}
$("#diffRun").addEventListener("click", runDiff);
runDiff();

/* ================= Cron 解析 ================= */
const cronInput = $("#cronInput"), cronDesc = $("#cronDesc"),
  cronNext = $("#cronNext"), cronExamples = $("#cronExamples");

const CRON_FIELDS = [
  { min: 0, max: 59, name: "分" },
  { min: 0, max: 23, name: "时" },
  { min: 1, max: 31, name: "日" },
  { min: 1, max: 12, name: "月" },
  { min: 0, max: 7, name: "周" },
];
function parseCronField(field, minV, maxV) {
  const allowed = new Set();
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    let a, b;
    if (range === "*") { a = minV; b = maxV; }
    else if (range.includes("-")) { [a, b] = range.split("-").map(Number); }
    else { a = b = Number(range); }
    if (!Number.isInteger(a) || !Number.isInteger(b) || step < 1) return null;
    if (a < minV || b > maxV || a > b) return null;
    for (let v = a; v <= b; v += step) allowed.add(v === 7 && maxV === 7 ? 0 : v);
  }
  return allowed;
}
function cronMatch(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((p, i) => parseCronField(p, CRON_FIELDS[i].min, CRON_FIELDS[i].max));
  if (sets.some((s) => s === null)) return null;
  return (d) =>
    sets[0].has(d.getMinutes()) && sets[1].has(d.getHours()) &&
    sets[2].has(d.getDate()) && sets[3].has(d.getMonth() + 1) &&
    (sets[4].has(d.getDay()) || (sets[4].has(7) && d.getDay() === 0));
}
function cronDescribe(expr) {
  const [min, hour, dom, mon, dow] = expr.trim().split(/\s+/);
  const partDesc = (f, unit) => {
    if (f === "*") return "每" + unit;
    if (f.startsWith("*/")) return "每 " + f.slice(2) + " " + unit;
    return f + " " + unit;
  };
  if (mon === "*" && dom === "*" && dow === "*") {
    if (hour === "*") return `每小时的第 ${partDesc(min, "分")}`;
    if (min === "*") return `每天的 ${hour} 时（每分钟）`;
    return `每天 ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  }
  const hh = hour.padStart(2, "0"), mm = min.padStart(2, "0");
  if (dow !== "*" && dom === "*" && mon === "*") return `每周 ${dow} 的 ${hh}:${mm}`;
  if (dom !== "*" && dow === "*" && mon === "*") return `每月 ${dom} 号的 ${hh}:${mm}`;
  return `${partDesc(mon, "月")} ${partDesc(dom, "日")} ${hh}:${mm}（周 ${dow}）`;
}
function renderCron() {
  const expr = cronInput.value.trim();
  const matcher = cronMatch(expr);
  cronNext.replaceChildren();
  if (!matcher) {
    setMsg(cronDesc, "✗ 表达式无效（需要 5 个字段：分 时 日 月 周，支持 * , - /）", "err");
    return;
  }
  setMsg(cronDesc, "✓ " + cronDescribe(expr), "ok");
  const cur = new Date();
  cur.setSeconds(0, 0);
  cur.setMinutes(cur.getMinutes() + 1);
  let found = 0;
  for (let i = 0; i < 366 * 24 * 60 && found < 5; i++) {
    if (matcher(cur)) {
      const row = document.createElement("div");
      row.className = "kv";
      const name = document.createElement("span");
      name.textContent = "第 " + (found + 1) + " 次";
      const code = document.createElement("code");
      code.textContent = cur.toLocaleString("zh-CN", { hour12: false });
      row.append(name, code);
      cronNext.append(row);
      found++;
    }
    cur.setMinutes(cur.getMinutes() + 1);
  }
  if (!found) {
    const row = document.createElement("div");
    row.className = "kv";
    row.textContent = "一年内没有匹配的执行时间";
    cronNext.append(row);
  }
}
const CRON_SAMPLES = [
  ["* * * * *", "每分钟"], ["*/5 * * * *", "每 5 分钟"], ["0 * * * *", "每小时"],
  ["0 9 * * 1-5", "工作日早 9 点"], ["30 8 1 * *", "每月 1 号 8:30"], ["0 3 * * *", "每天凌晨 3 点"],
];
for (const [expr, label] of CRON_SAMPLES) {
  const btn = document.createElement("button");
  btn.className = "btn mini";
  btn.textContent = label;
  btn.addEventListener("click", () => { cronInput.value = expr; renderCron(); });
  cronExamples.append(btn);
}
cronInput.addEventListener("input", renderCron);
renderCron();

/* ================= UUID / 短 ID ================= */
const uuidType = $("#uuidType"), uuidCount = $("#uuidCount"),
  uuidOut = $("#uuidOut");

function randomShortId(len = 12) {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => alphabet[b % 64]).join("");
}
function generateIds() {
  const n = Math.min(Math.max(Number(uuidCount.value) || 1, 1), 100);
  const list = [];
  for (let i = 0; i < n; i++) {
    list.push(uuidType.value === "v4"
      ? (crypto.randomUUID ? crypto.randomUUID()
        : randomShortId(32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5"))
      : randomShortId(12));
  }
  uuidOut.value = list.join("\n");
}
$("#uuidGen").addEventListener("click", generateIds);
bindCopyBtn($("#uuidCopy"), () => uuidOut.value);
generateIds();

/* ================= 哈希计算 ================= */
const hashInput = $("#hashInput"), hashOut = $("#hashOut");
const HASH_ALGOS = ["SHA-1", "SHA-256", "SHA-384", "SHA-512"];
async function renderHash() {
  hashOut.replaceChildren();
  const text = hashInput.value;
  if (!text) return;
  const data = new TextEncoder().encode(text);
  for (const algo of HASH_ALGOS) {
    try {
      const digest = await crypto.subtle.digest(algo, data);
      const hex = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      const row = document.createElement("div");
      row.className = "kv";
      const name = document.createElement("span");
      name.textContent = algo;
      const code = document.createElement("code");
      code.textContent = hex;
      const btn = document.createElement("button");
      btn.className = "btn mini";
      btn.textContent = "复制";
      bindCopyBtn(btn, () => hex);
      row.append(name, code, btn);
      hashOut.append(row);
    } catch { /* 安全上下文不可用时跳过 */ }
  }
}
hashInput.addEventListener("input", renderHash);
renderHash();

/* ================= 文本统计 ================= */
const textStatsInput = $("#tsInput"), textStatsOut = $("#tsStats");
function renderTextStats() {
  const t = textStatsInput.value;
  const chars = t.length;
  const charsNoSpace = t.replace(/\s/g, "").length;
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinWords = (t.replace(/[\u4e00-\u9fff]/g, " ").match(/[a-zA-Z0-9]+/g) || []).length;
  const lines = t ? t.split("\n").length : 0;
  const paras = t.trim() ? t.trim().split(/\n\s*\n/).length : 0;
  const minutes = (cjk + latinWords) / 400;
  const stats = [
    [chars, "字符数"], [charsNoSpace, "不含空白"], [cjk, "中文字数"],
    [latinWords, "英文单词"], [lines, "行数"], [paras, "段落数"],
    [minutes < 1 ? "不到 1" : Math.ceil(minutes), "预计阅读(分钟)"],
  ];
  textStatsOut.replaceChildren();
  for (const [v, label] of stats) {
    const box = document.createElement("div");
    box.className = "stat-box";
    const b = document.createElement("b");
    b.textContent = v;
    const s = document.createElement("span");
    s.textContent = label;
    box.append(b, s);
    tsStats.append(box);
  }
}
textStatsInput.addEventListener("input", renderTextStats);
renderTextStats();

/* ================= Service Worker（离线缓存） ================= */
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "127.0.0.1")) {
  addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => { /* SW 失败不影响功能 */ });
  });
}
