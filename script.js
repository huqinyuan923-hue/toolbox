/* 开发者工具箱 —— 纯前端脚本，无后端、无追踪 */

/* ---------- 主题 ---------- */
const themeBtn = document.getElementById("themeToggle");
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "";
  themeBtn.textContent = theme === "dark" ? "☀️" : "🌙";
  localStorage.setItem("toolbox-theme", theme);
}
applyTheme(localStorage.getItem("toolbox-theme")
  || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
themeBtn.addEventListener("click", () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));

/* ---------- 标签页切换 ---------- */
const navBtns = document.querySelectorAll(".tool-btn");
const panels = document.querySelectorAll(".tool-panel");
function selectTool(name) {
  navBtns.forEach((b) => b.classList.toggle("active", b.dataset.tool === name));
  panels.forEach((p) =>
    p.classList.toggle("active", p.id === "tool-" + name));
}
navBtns.forEach((btn) => btn.addEventListener("click", () => {
  selectTool(btn.dataset.tool);
  history.replaceState(null, "", "#" + btn.dataset.tool);
}));
window.addEventListener("hashchange", () => {
  if (location.hash.slice(1)) selectTool(location.hash.slice(1));
});
// 支持 #json 这样的锚点直达
const hashTool = location.hash.slice(1);
if (hashTool) selectTool(hashTool);

/* ---------- JSON 格式化 ---------- */
const jsonInput = document.getElementById("jsonInput");
const jsonMsg = document.getElementById("jsonMsg");
function runJson(minify) {
  jsonMsg.className = "msg";
  try {
    const obj = JSON.parse(jsonInput.value);
    jsonInput.value = minify ? JSON.stringify(obj) : JSON.stringify(obj, null, 2);
    jsonMsg.textContent = "✓ 转换成功";
    jsonMsg.classList.add("ok");
  } catch (e) {
    jsonMsg.textContent = "✗ JSON 无效：" + e.message;
    jsonMsg.classList.add("err");
  }
}
document.getElementById("jsonFormat").addEventListener("click", () => runJson(false));
document.getElementById("jsonMinify").addEventListener("click", () => runJson(true));
document.getElementById("jsonCopy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(jsonInput.value);
    jsonMsg.textContent = "✓ 已复制到剪贴板";
    jsonMsg.className = "msg ok";
  } catch { jsonMsg.textContent = "✗ 复制失败，请手动全选复制"; jsonMsg.className = "msg err"; }
});
document.getElementById("jsonClear").addEventListener("click", () => {
  jsonInput.value = ""; jsonMsg.textContent = "";
});

/* ---------- 时间戳 ---------- */
const tsNow = document.getElementById("tsNow");
setInterval(() => { tsNow.textContent = Math.floor(Date.now() / 1000); }, 1000);
tsNow.textContent = Math.floor(Date.now() / 1000);

const tsInput = document.getElementById("tsInput");
const tsOut = document.getElementById("tsOut");
document.getElementById("tsToDate").addEventListener("click", () => {
  tsOut.className = "msg";
  const raw = tsInput.value.trim();
  if (!/^\d+$/.test(raw)) {
    tsOut.textContent = "✗ 请输入纯数字时间戳";
    tsOut.classList.add("err");
    return;
  }
  const n = Number(raw);
  // 10 位视为秒，13 位及以上视为毫秒
  const ms = String(n).length >= 13 ? n : n * 1000;
  const d = new Date(ms);
  tsOut.textContent = isNaN(d) ? "✗ 数值超出日期范围" : d.toLocaleString("zh-CN", { hour12: false });
  tsOut.classList.add(isNaN(d) ? "err" : "ok");
});

const dateInput = document.getElementById("dateInput");
const dateOut = document.getElementById("dateOut");
dateInput.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
  .toISOString().slice(0, 16);
document.getElementById("dateToTs").addEventListener("click", () => {
  dateOut.className = "msg";
  const d = new Date(dateInput.value);
  if (isNaN(d)) {
    dateOut.textContent = "✗ 请先选择日期时间";
    dateOut.classList.add("err");
    return;
  }
  dateOut.textContent = `秒：${Math.floor(d.getTime() / 1000)}\n毫秒：${d.getTime()}`;
  dateOut.classList.add("ok");
});

/* ---------- 二维码 ---------- */
const qrInput = document.getElementById("qrInput");
const qrCanvas = document.getElementById("qrCanvas");
document.getElementById("qrGen").addEventListener("click", () => {
  const text = qrInput.value.trim();
  if (!text) return alert("请先输入内容");
  if (typeof qrcode === "undefined") return alert("二维码库加载失败，请检查网络后刷新");
  try {
    const qr = qrcode(0, "M"); // 0 = 自动选择版本
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const cell = 8, margin = 4 * cell;
    const size = count * cell + margin * 2;
    qrCanvas.width = qrCanvas.height = size;
    const ctx = qrCanvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#000";
    for (let r = 0; r < count; r++)
      for (let c = 0; c < count; c++)
        if (qr.isDark(r, c)) ctx.fillRect(margin + c * cell, margin + r * cell, cell, cell);
  } catch (e) {
    alert("生成失败（内容可能过长）：" + e.message);
  }
});
document.getElementById("qrDownload").addEventListener("click", () => {
  const a = document.createElement("a");
  a.download = "qrcode.png";
  a.href = qrCanvas.toDataURL("image/png");
  a.click();
});

/* ---------- 密码生成 ---------- */
const pwOut = document.getElementById("pwOut");
const pwLen = document.getElementById("pwLen");
const pwLenVal = document.getElementById("pwLenVal");
pwLen.addEventListener("input", () => { pwLenVal.textContent = pwLen.value; });

function generatePassword() {
  const sets = [
    [document.getElementById("pwUpper").checked, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"],
    [document.getElementById("pwLower").checked, "abcdefghijklmnopqrstuvwxyz"],
    [document.getElementById("pwDigit").checked, "0123456789"],
    [document.getElementById("pwSymbol").checked, "!@#$%^&*()-_=+[]{};:,.<>?"],
  ].filter(([on]) => on).map(([, set]) => set);
  if (!sets.length) { pwOut.textContent = "请至少选择一种字符"; return; }
  const all = sets.join("");
  const len = Number(pwLen.value);
  const rand = crypto.getRandomValues(new Uint32Array(len));
  // 至少保证每类字符出现一次，其余在合集里随机
  const chars = sets.map((set, i) => set[rand[i] % set.length]);
  for (let i = chars.length; i < len; i++) chars.push(all[rand[i] % all.length]);
  // Fisher-Yates 洗牌，避免固定位置规律
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rand[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  pwOut.textContent = chars.join("");
}
document.getElementById("pwGen").addEventListener("click", generatePassword);
document.getElementById("pwCopy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(pwOut.textContent); } catch {}
});
generatePassword();

/* ---------- Markdown 预览 ---------- */
const mdInput = document.getElementById("mdInput");
const mdPreview = document.getElementById("mdPreview");
function renderMd() {
  if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
    mdPreview.textContent = "Markdown 库加载中（需要联网加载 CDN）…";
    return;
  }
  mdPreview.innerHTML = DOMPurify.sanitize(marked.parse(mdInput.value));
}
mdInput.addEventListener("input", renderMd);
mdInput.value = "# 你好，Toolbox\n\n在左边输入 **Markdown**，这里会实时预览。\n\n- 支持 `代码` 与表格\n- 已用 DOMPurify 过滤 XSS";
renderMd();

/* ---------- 每日一签 ---------- */
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
];
const dailyDate = document.getElementById("dailyDate");
const dailyQuote = document.getElementById("dailyQuote");
const dailyAuthor = document.getElementById("dailyAuthor");
const dailyImg = document.getElementById("dailyImg");
const dailyWallLink = document.getElementById("dailyWallLink");

(function renderDaily() {
  const today = new Date();
  const key = today.toISOString().slice(0, 10); // YYYY-MM-DD，同一天结果稳定
  // 把日期字符串哈希成 0..N-1 的索引
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [text, author] = QUOTES[h % QUOTES.length];
  dailyDate.textContent = `${key} · ${today.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}`;
  dailyQuote.textContent = text;
  dailyAuthor.textContent = "—— " + author;
  dailyImg.src = `https://picsum.photos/seed/${key}/1200/500`;
  dailyWallLink.href = dailyImg.src;
  document.getElementById("dailyCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(`${text} —— ${author}（${key} · 每日一签）`); } catch {}
  });
})();
