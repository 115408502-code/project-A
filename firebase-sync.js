const SDK = "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
let firestoreApi;
let db;
let activeUid = "";
let unsubscribe = null;
let saveTimer;
let applyingRemote = false;
let lastPayload = "";
let syncStatus = "尚未登入";

function setStatus(text) {
  syncStatus = text;
  const note = document.querySelector(".storage-note");
  if (note) {
    const title = note.querySelector("b");
    const detail = note.querySelector("small");
    if (title) title.textContent = text;
    if (detail) detail.textContent = activeUid ? "已登入 Google 帳戶" : "登入後同步到 Firebase";
  }
}

function statePayload(state) { return JSON.stringify(state); }

async function connect(user) {
  clearTimeout(saveTimer);
  unsubscribe?.();
  unsubscribe = null;
  activeUid = user?.uid || "";
  lastPayload = "";
  if (!activeUid) { setStatus("尚未登入"); return; }
  setStatus("正在連線…");
  try {
    const app = window.taskflowAuth?.getFirebaseApp?.();
    if (!app) throw new Error("Firebase 尚未初始化");
    firestoreApi ||= await import(SDK);
    db = firestoreApi.getFirestore(app);
    const ref = firestoreApi.doc(db, "users", activeUid, "workspace", "state");
    const snapshot = await firestoreApi.getDoc(ref);
    if (activeUid !== user.uid) return;
    if (snapshot.exists()) {
      const data = snapshot.data();
      if (data.uid !== activeUid || typeof data.payload !== "string") throw new Error("雲端資料格式不正確");
      const remote = JSON.parse(data.payload);
      if (!window.taskflowWorkspace?.replace(remote)) throw new Error("雲端工作區資料無法讀取");
      lastPayload = data.payload;
    } else {
      const payload = statePayload(window.taskflowWorkspace?.getState?.() || {});
      await firestoreApi.setDoc(ref, { uid: activeUid, payload, updatedAt: firestoreApi.serverTimestamp() });
      lastPayload = payload;
    }
    unsubscribe = firestoreApi.onSnapshot(ref, docSnap => {
      if (activeUid !== user.uid || !docSnap.exists()) return;
      const data = docSnap.data();
      if (data.uid !== activeUid || typeof data.payload !== "string" || data.payload === lastPayload) return;
      try {
        const remote = JSON.parse(data.payload);
        applyingRemote = true;
        if (window.taskflowWorkspace?.replace(remote)) {
          lastPayload = data.payload;
          setStatus("已同步");
        }
      } catch (error) { console.error("無法套用 Firestore 工作區資料", error); }
      finally { applyingRemote = false; }
    }, error => { console.error("Firestore 即時同步失敗", error); setStatus("同步發生問題"); });
    setStatus("已同步");
  } catch (error) {
    console.error("Firestore 同步初始化失敗", error);
    setStatus("雲端同步未完成");
  }
}

window.taskflowCloudSync = {
  queueSave(state) {
    if (!activeUid || applyingRemote || !db || !firestoreApi) return;
    const uid = activeUid;
    const payload = statePayload(state);
    if (payload === lastPayload) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (activeUid !== uid) return;
      setStatus("正在同步…");
      try {
        const ref = firestoreApi.doc(db, "users", uid, "workspace", "state");
        await firestoreApi.setDoc(ref, { uid, payload, updatedAt: firestoreApi.serverTimestamp() });
        if (activeUid === uid) { lastPayload = payload; setStatus("已同步"); }
      } catch (error) { console.error("Firestore 儲存失敗", error); setStatus("雲端同步未完成"); }
    }, 500);
  },
  getStatus: () => syncStatus
};

window.addEventListener("taskflow:auth-state", event => { void connect(event.detail?.user || null); });
window.addEventListener("taskflow:auth-ready", () => {
  const user = window.taskflowAuth?.getCurrentUser?.();
  if (user) void connect(user);
});
document.addEventListener("DOMContentLoaded", () => {
  if (!window.taskflowAuth) setStatus("尚未登入");
});
