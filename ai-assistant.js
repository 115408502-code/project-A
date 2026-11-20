const AI_SDK = "https://www.gstatic.com/firebasejs/12.9.0/firebase-ai.js";
const toggle = document.querySelector("#aiAssistantToggle");
const panel = document.querySelector("#aiAssistantWindow");
const form = document.querySelector("#aiAssistantForm");
const input = document.querySelector("#aiAssistantInput");
const messages = document.querySelector("#aiAssistantMessages");
const sendButton = document.querySelector("#aiAssistantSend");
let aiApi;
let model;
let chat;
let busy = false;

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
    .map(item => ({ task: item.title, due: item.due || "未設定", project: projects.get(item.projectId) || "未分類", priority: item.priority || "未設定" }));
  const schedules = (state.schedules || []).filter(item => item.date >= today && item.date <= until)
    .sort((a, b) => `${a.date} ${a.startTime || ""}`.localeCompare(`${b.date} ${b.startTime || ""}`))
    .map(item => ({ event: item.title, date: item.date, start: item.startTime || "", end: item.endTime || "" }));
  return JSON.stringify({ today, timezone: "Asia/Taipei", upcomingTasks: tasks, upcomingSchedule: schedules });
}

async function initAI() {
  if (model) return model;
  const user = window.taskflowAuth?.getCurrentUser?.();
  const app = window.taskflowAuth?.getFirebaseApp?.();
  if (!user || !app) throw new Error("請先使用 Google 登入，再使用 AI 行程助理。");
  aiApi ||= await import(AI_SDK);
  const ai = aiApi.getAI(app, { backend: new aiApi.GoogleAIBackend(), useLimitedUseAppCheckTokens: true });
  model = aiApi.getGenerativeModel(ai, {
    model: "gemini-4-hydrogen",
    systemInstruction: "你是 Taskflow 的繁體中文 AI 行程助理。根據使用者提供的任務與行程提出可執行的時間安排、優先順序和空檔建議。清楚列出日期與時間；資料不足時先說明假設或詢問。不要聲稱已經修改行程或任務，也不要要求或輸出個人敏感資料。"
  });
  chat = model.startChat();
  return model;
}

async function send(text) {
  const prompt = text.trim();
  if (!prompt || busy) return;
  if (!window.taskflowAuth?.getCurrentUser?.()) {
    addMessage("請先按左側「Google 登入」，登入後就能使用 AI 行程助理。");
    return;
  }
  addMessage(prompt, "user");
  busy = true;
  sendButton.disabled = true;
  input.disabled = true;
  const pending = addMessage("正在整理你的任務與行程…");
  try {
    await initAI();
    const result = await chat.sendMessage(`以下是目前工作區未完成任務及未來七天行程（僅用來回答本次規劃，不要假設已變更資料）：\n${getAgendaContext()}\n\n使用者問題：${prompt}`);
    pending.textContent = result.response.text() || "目前沒有可顯示的建議，請換個方式詢問。";
  } catch (error) {
    console.error("Firebase AI Logic request failed", error);
    const code = error?.code || "";
    pending.textContent = code.includes("app-check") || code.includes("appCheck")
      ? "AI 安全驗證尚未設定完成，管理員需在 Firebase App Check 啟用此網站後再試。"
      : "目前無法連線 AI 助理。請確認 Firebase AI Logic 已啟用、條款已接受，且已完成 App Check 設定。";
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
