const AI_SDK = "https://www.gstatic.com/firebasejs/12.9.0/firebase-ai.js";
const PRIMARY_MODEL = "gemini-3.5-flash-lite";
const BACKUP_MODEL = "gemini-3.8-flash";
const QUICK_REPLY_CONFIG = {
  maxOutputTokens: 500,
  thinkingConfig: { thinkingLevel: "MINIMAL" }
};
const SYSTEM_INSTRUCTION = "你是 Taskflow 的繁體中文 AI 行程助理。以資料中的 today、dueLabel 和 Asia/Taipei 時區為準，不要自行推算星期或相對日期。只根據列出的任務與行程提供安排；沒有固定行程時，標明時段是假設。回覆以繁體中文簡短列出優先順序和可執行安排，最多 5 點；不要聲稱已修改資料。";
const toggle = document.querySelector("#aiAssistantToggle");
const panel = document.querySelector("#aiAssistantWindow");
const form = document.querySelector("#aiAssistantForm");
const input = document.querySelector("#aiAssistantInput");
const messages = document.querySelector("#aiAssistantMessages");
const sendButton = document.querySelector("#aiAssistantSend");
let aiApi;
let aiService;
let model;
let chat;
let busy = false;

async function waitForSignedInFirebase(timeoutMs = 15000) {
  const ready = () => window.taskflowAuth?.getCurrentUser?.() && window.taskflowAuth?.getFirebaseApp?.();
  if (ready()) return { user: ready(), app: window.taskflowAuth.getFirebaseApp() };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const user = window.taskflowAuth?.getCurrentUser?.();
    const app = window.taskflowAuth?.getFirebaseApp?.();
    if (user && app) return { user, app };
  }
  throw new Error("登入狀態尚未就緒。請重新整理頁面後再試。");
}

function addMessage(text, role = "assistant") {
  const node = document.createElement("div");
  node.className = `ai-message ${role}`;
  node.textContent = text;
  messages.append(node);
  messages.scrollTop = messages.scrollHeight;
  return node;
}

function getAgendaContext() {
  const state = window.taskflowWorkspace?.getState?.() || {};
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(new Date());
  const end = new Date(`${today}T00:00:00+08:00`);
  end.setDate(end.getDate() + 7);
  const until = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(end);
  const projects = new Map((state.projects || []).map(item => [item.id, item.name]));
  const tasks = (state.tasks || []).filter(item => !item.completed && (!item.due || item.due <= until))
    .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"))
    .map(item => {
      const days = item.due ? Math.round((Date.parse(`${item.due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000) : null;
      const dueLabel = days === null ? "未設定" : days < 0 ? `已逾期${Math.abs(days)}天` : days === 0 ? "今天" : days === 1 ? "明天" : `${days}天後`;
      return { task: item.title, due: item.due || "未設定", dueLabel, project: projects.get(item.projectId) || "未分類", priority: item.priority || "未設定" };
    });
  const schedules = (state.schedules || []).filter(item => item.date >= today && item.date <= until)
    .sort((a, b) => `${a.date} ${a.startTime || ""}`.localeCompare(`${b.date} ${b.startTime || ""}`))
    .map(item => ({ event: item.title, date: item.date, start: item.startTime || "", end: item.endTime || "" }));
  return JSON.stringify({ today, timezone: "Asia/Taipei", upcomingTasks: tasks, upcomingSchedule: schedules });
}

async function initAI() {
  if (model) return model;
  const { app } = await waitForSignedInFirebase();
  aiApi ||= await import(AI_SDK);
  aiService = aiApi.getAI(app, { backend: new aiApi.GoogleAIBackend(), useLimitedUseAppCheckTokens: true });
  model = aiApi.getGenerativeModel(aiService, {
    model: PRIMARY_MODEL,
    systemInstruction: SYSTEM_INSTRUCTION,
    generationConfig: QUICK_REPLY_CONFIG
  });
  chat = model.startChat();
  return model;
}

async function streamReply(targetChat, request, node, firstChunkTimeoutMs = 15000) {
  const deadline = Date.now() + firstChunkTimeoutMs;
  const untilDeadline = promise => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("Model did not start streaming"), { code: "taskflow/primary-timeout" })), Math.max(1, deadline - Date.now()));
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  const result = await untilDeadline(targetChat.sendMessageStream(request));
  const iterator = result.stream[Symbol.asyncIterator]();
  const first = await untilDeadline(iterator.next());
  let fullText = "";
  const append = chunk => {
    const text = chunk?.text?.() || "";
    if (!text) return;
    fullText += text;
    node.textContent = fullText;
    messages.scrollTop = messages.scrollHeight;
  };
  if (!first.done) append(first.value);
  for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) append(chunk);
  return fullText;
}

async function send(text) {
  const prompt = text.trim();
  if (!prompt || busy) return;
  addMessage(prompt, "user");
  busy = true;
  sendButton.disabled = true;
  input.disabled = true;
  const pending = addMessage("正在連線，AI 會逐段顯示規劃…");
  try {
    await initAI();
    const request = `以下是目前工作區未完成任務及未來七天行程（僅用來回答本次規劃，不要假設已變更資料）：\n${getAgendaContext()}\n\n使用者問題：${prompt}`;
    const result = await Promise.race([
      (async () => {
        try {
          return await streamReply(chat, request, pending);
        } catch (error) {
          const status = Number(error?.customData?.httpStatus || error?.status || 0);
          const message = String(error?.message || "");
          const transient = [429, 500, 502, 503, 504].includes(status) || /\[(429|500|502|503|504)\s*\]/.test(message);
          if (!transient && error?.code !== "taskflow/primary-timeout") throw error;
          pending.textContent = "主模型較忙，正在切換備援並逐段回覆…";
          const fallback = aiApi.getGenerativeModel(aiService, {
            model: BACKUP_MODEL,
            systemInstruction: SYSTEM_INSTRUCTION,
            generationConfig: { maxOutputTokens: QUICK_REPLY_CONFIG.maxOutputTokens }
          });
          const fallbackChat = fallback.startChat();
          const fallbackResult = await streamReply(fallbackChat, request, pending, 30000);
          model = fallback;
          chat = fallbackChat;
          return fallbackResult;
        }
      })(),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("AI request timed out"), { code: "taskflow/ai-timeout" })), 45000))
    ]);
    if (!result) pending.textContent = "目前沒有可顯示的建議，請換個方式詢問。";
  } catch (error) {
    console.error("Firebase AI Logic request failed", error);
    const code = error?.code || "";
    const detail = String(error?.message || error?.name || "未知錯誤")
      .replace(/AIza[\w-]{20,}/g, "[已隱藏]")
      .replace(/https?:\/\/\S+/g, "[服務端點]")
      .slice(0, 180);
    pending.textContent = code === "taskflow/ai-timeout"
      ? "AI 服務暫時沒有回覆，主模型與備援模型都逾時了。請稍後再試。"
      : code.includes("app-check") || code.includes("appCheck") || code.includes("app check")
        ? "Firebase App Check 尚未設定完成，AI 請求因此遭到阻擋。"
        : code === "taskflow/auth-not-ready"
          ? "登入狀態還沒準備好，請重新整理頁面後再試。"
          : `AI 連線失敗${code ? `（${code}）` : ""}：${detail}`;
  } finally {
    busy = false;
    sendButton.disabled = false;
    input.disabled = false;
    input.focus();
    messages.scrollTop = messages.scrollHeight;
  }
}

function setOpen(open) {
  panel.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  if (open) input.focus();
}

toggle?.addEventListener("click", () => setOpen(panel.hidden));
document.querySelector("#aiAssistantClose")?.addEventListener("click", () => setOpen(false));
document.querySelector("#aiAssistantPrompts")?.addEventListener("click", event => {
  const button = event.target.closest("[data-ai-prompt]");
  if (button) void send(button.dataset.aiPrompt);
});
form?.addEventListener("submit", event => {
  event.preventDefault();
  const text = input.value;
  input.value = "";
  void send(text);
});
document.addEventListener("keydown", event => { if (event.key === "Escape" && !panel.hidden) setOpen(false); });
