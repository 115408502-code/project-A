import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";

const CONFIG_KEY = "taskflow-firebase-config-v1";
const DEFAULT_CONFIG = {
  apiKey: "YOUR_FIREBASE_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  appId: "YOUR_FIREBASE_APP_ID"
};
const root = document.documentElement;
let app = null;
let auth = null;
let provider = null;
let currentUser = null;
let authError = "";
let initializedConfig = "";
let appCheckNeeded = false;

const readConfig = () => {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}") }; }
  catch { return { ...DEFAULT_CONFIG }; }
};
const isConfigured = (config) => config.apiKey && config.projectId && config.appId &&
  !Object.values(config).some(v => String(v).startsWith("YOUR_"));
const emit = (name, detail = {}) => window.dispatchEvent(new CustomEvent(`taskflow:${name}`, { detail }));

function renderAuthDialog(error = authError) {
  const backdrop = document.querySelector("#authBackdrop");
  const modal = document.querySelector("#authModal");
  if (!backdrop || !modal) return;
  const config = readConfig();
  modal.innerHTML = `
    <div class="auth-brand"><span class="brand-mark"><svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg></span><span>taskflow</span></div>
    <h2 style="font-size:18px;margin:0 0 6px">${currentUser ? "帳戶資訊" : "登入 Taskflow"}</h2>
    <p class="auth-subtitle">${currentUser ? "目前已使用 Google 帳戶登入。" : "使用 Google 帳戶安全登入，繼續管理你的專案與任務。"}</p>
    ${currentUser ? `<div class="notice-item"><div class="auth-user-chip"><img src="${escapeAttr(currentUser.photoURL || "")}" alt=""><div><b>${escapeHtml(currentUser.displayName || "Google 使用者")}</b><small>${escapeHtml(currentUser.email || "")}</small></div></div></div><div class="modal-actions"><button class="danger-btn" id="authSignOut">登出</button><div class="modal-actions-right"><button class="cancel-btn" id="authClose">關閉</button></div></div>` : `
      <button class="google-signin" id="googleSignIn"><span class="google-g">G</span><span>使用 Google 帳戶登入</span></button>
      ${error ? `<p class="auth-error">${escapeHtml(error)}</p>` : ""}
      <div class="auth-divider">安全驗證</div>
      ${!isConfigured(config) ? `<p class="auth-config-note">尚未設定 Firebase。請到 Firebase Console 建立 Web App、啟用 Authentication 的 Google 提供者，將 Web App 設定填入 Firebase Console 的 Project settings → Your apps → SDK setup and configuration；此示範會從 firebase-auth.js 同目錄的 firebase-config.json 載入設定。</p>` : ""}
      <div class="modal-actions"><span class="auth-disclaimer">登入後任務仍儲存在此瀏覽器；跨裝置同步需另接 Firestore。</span><div class="modal-actions-right"><button class="cancel-btn" id="authCancel">取消</button></div></div>`}`;
  backdrop.classList.add("open");
  modal.querySelector("#authClose")?.addEventListener("click", closeAuthDialog);
  modal.querySelector("#authCancel")?.addEventListener("click", closeAuthDialog);
  modal.querySelector("#authSignOut")?.addEventListener("click", async () => {
    try { await signOut(auth); closeAuthDialog(); }
    catch (e) { authError = describeError(e); renderAuthDialog(authError); }
  });
  modal.querySelector("#googleSignIn")?.addEventListener("click", beginSignIn);
}
function closeAuthDialog() { document.querySelector("#authBackdrop")?.classList.remove("open"); }
function escapeHtml(s) { return String(s ?? "").replace(/[&<>\"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
function escapeAttr(s) { return escapeHtml(s); }
function describeError(error) {
  const code = error?.code || "";
  if (code === "auth/unauthorized-domain") return `此網域未授權（${location.hostname}）。請在 Firebase Authentication → Settings → Authorized domains 加入此網域。`;
  if (code === "auth/operation-not-allowed") return "Firebase 尚未啟用 Google 登入提供者。";
  if (code === "auth/popup-blocked") return "登入視窗遭瀏覽器封鎖，將改用重新導向登入。";
  if (code === "auth/popup-closed-by-user") return "登入視窗已關閉，請重試。";
  if (code === "auth/network-request-failed") return "網路連線失敗，請確認連線後重試。";
  return `Google 登入失敗${code ? `（${code}）` : ""}。請檢查 Firebase 設定與瀏覽器 Console。`;
}
async function ensureFirebase() {
  let config = readConfig();
  if (!isConfigured(config)) {
    try {
      const response = await fetch(new URL("./firebase-config.json", import.meta.url), { cache: "no-store" });
      if (response.ok) config = { ...config, ...await response.json() };
    } catch { /* configuration file is optional for local preview */ }
  }
  if (!isConfigured(config)) throw Object.assign(new Error("Firebase config missing"), { code: "taskflow/config-missing" });
  const key = JSON.stringify(config);
  if (auth && initializedConfig === key) return auth;
  app = initializeApp(config, `taskflow-${Date.now()}`);
  auth = getAuth(app);
  provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  initializedConfig = key;
  onAuthStateChanged(auth, user => {
    currentUser = user;
    root.dataset.authState = user ? "signed-in" : "signed-out";
    emit("auth-state", { user: user ? publicUser(user) : null });
    updateAuthButtons();
  }, error => {
    authError = describeError(error);
    emit("auth-error", { message: authError });
  });
  try { await getRedirectResult(auth); } catch (error) { authError = describeError(error); }
  return auth;
}
function publicUser(user) { return { uid: user.uid, displayName: user.displayName, email: user.email, photoURL: user.photoURL }; }
function updateAuthButtons() {
  const action = document.querySelector("#authActionBtn");
  const name = document.querySelector("#profileName");
  const status = document.querySelector("#accountStatus");
  const avatar = document.querySelector("#profileAvatar");
  const topAvatar = document.querySelector("#topAvatar");
  if (action) action.textContent = currentUser ? "帳戶" : "Google 登入";
  if (name) name.textContent = currentUser?.displayName || "沛欣";
  if (status) status.textContent = currentUser?.email || "尚未登入";
  if (avatar) avatar.textContent = (currentUser?.displayName || "沛欣").slice(0, 1);
  if (topAvatar) topAvatar.textContent = (currentUser?.displayName || "沛").slice(0, 1);
}
async function beginSignIn() {
  const config = readConfig();
  if (!isConfigured(config)) {
    renderAuthDialog("請先在 Firebase Console 建立 Web App，並填入 Firebase Web 設定。");
    return;
  }
  try {
    await ensureFirebase();
    await signInWithPopup(auth, provider);
    closeAuthDialog();
  } catch (error) {
    if (error?.code === "auth/popup-blocked" || error?.code === "auth/operation-not-supported-in-this-environment") {
      try { await signInWithRedirect(auth, provider); return; }
      catch (redirectError) { error = redirectError; }
    }
    authError = error?.code === "taskflow/config-missing" ? "Firebase 設定尚未完成。" : describeError(error);
    renderAuthDialog(authError);
  }
}
window.taskflowAuth = {
  open: () => renderAuthDialog(""),
  signOut: async () => { if (!auth) return; await signOut(auth); },
  getCurrentUser: () => currentUser ? publicUser(currentUser) : null,
  configure: async config => {
    if (!config || !isConfigured(config)) throw new Error("需要完整的 Firebase Web App 設定。");
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    auth = null; app = null; initializedConfig = "";
    await ensureFirebase();
    closeAuthDialog();
  }
};
window.dispatchEvent(new CustomEvent("taskflow:auth-ready"));
document.addEventListener("DOMContentLoaded", () => {
  document.querySelector("#authActionBtn")?.addEventListener("click", async () => {
    try { await ensureFirebase(); renderAuthDialog(""); }
    catch (error) { renderAuthDialog(error?.code === "taskflow/config-missing" ? "" : describeError(error)); }
  });
  document.querySelector("#authBackdrop")?.addEventListener("click", e => { if (e.target === e.currentTarget) closeAuthDialog(); });
  const params = new URLSearchParams(location.search);
  if (params.has("auth") || params.has("authError")) {
    history.replaceState(null, "", location.pathname + location.hash);
    void ensureFirebase().then(() => renderAuthDialog(authError)).catch(() => renderAuthDialog(authError));
  }
});
