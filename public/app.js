import { Avatar, mouthOpenFor } from "./avatar.js";

const $ = (id) => document.getElementById(id);
const EMOTIONS = ["normal", "happy", "sad", "angry", "surprised", "shy"];
const TAG_RE = new RegExp(`\\[(${EMOTIONS.join("|")})\\]\\s*`, "g");

const state = {
  characters: [],
  current: null,
  busy: false,
  tts: loadPref("tts", false),
};

const avatar = new Avatar($("stageCanvas"));

// ---------- utils ----------

function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem(`oshi:${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function savePref(key, value) {
  try {
    localStorage.setItem(`oshi:${key}`, JSON.stringify(value));
  } catch {}
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body && !(options.body instanceof FormData)
      ? { "Content-Type": "application/json", ...options.headers }
      : options.headers,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

/** POST して Server-Sent Events を1件ずつ返す */
async function* postSse(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message", data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      yield { event, data: data ? JSON.parse(data) : null };
    }
  }
}

const stripTags = (text) => text.replace(TAG_RE, "");
const leadingEmotion = (text) => text.match(/^\s*\[(\w+)\]/)?.[1];

// ---------- character list ----------

async function refreshList(selectId) {
  state.characters = await api("/api/characters");
  const list = $("charList");
  list.innerHTML = "";
  for (const c of state.characters) {
    const li = document.createElement("li");
    li.dataset.id = c.id;
    li.className = state.current?.id === c.id ? "active" : "";
    const img = document.createElement("img");
    img.src = `/api/characters/${c.id}/image`;
    img.alt = "";
    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("div");
    name.textContent = c.persona?.displayName || c.name;
    const sub = document.createElement("small");
    sub.textContent = c.persona ? c.persona.source || c.series : "未分析";
    meta.append(name, sub);
    li.append(img, meta);
    li.addEventListener("click", () => selectCharacter(c.id));
    list.append(li);
  }
  $("emptyState").classList.toggle("hidden", state.characters.length > 0 || !!state.current);
  if (selectId) await selectCharacter(selectId);
}

async function selectCharacter(id) {
  window.speechSynthesis?.cancel();
  const c = await api(`/api/characters/${id}`);
  state.current = c;
  for (const li of $("charList").children) li.classList.toggle("active", li.dataset.id === id);
  $("emptyState").classList.add("hidden");
  $("talkView").classList.remove("hidden");
  $("charName").textContent = c.persona?.displayName || c.name;
  $("charSource").textContent = c.persona?.source || c.series || "";
  $("mouthSize").value = c.rig.mouthSize;
  $("motion").value = c.rig.motion;
  updateRigButton();

  avatar.setRig(c.rig);
  await avatar.setImage(`/api/characters/${id}/image?v=${encodeURIComponent(c.createdAt)}`);
  avatar.setEmotion("normal");

  const history = c.persona ? await api(`/api/characters/${id}/history`) : [];
  renderMessages(history);
  if (!c.persona) {
    addMessage("error", "まだ人格が分析されていません。「人格」→「ネットで再分析」を押してください。");
  }
}

function updateRigButton() {
  const set = !!state.current?.rig.mouth;
  $("rigBtn").textContent = set ? "口の位置を設定し直す" : "口の位置を設定（未設定）";
  $("rigBtn").classList.toggle("active", !set);
}

// ---------- messages ----------

function renderMessages(history) {
  $("messages").innerHTML = "";
  for (const m of history) addMessage(m.role, stripTags(m.content));
}

function addMessage(role, text) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  $("messages").append(el);
  scrollToBottom();
  return el;
}

function scrollToBottom() {
  const box = $("messages");
  box.scrollTop = box.scrollHeight;
}

// ---------- typewriter + lip sync ----------

class Typewriter {
  constructor(el) {
    this.el = el;
    this.queue = "";
    this.closed = false;
    this.timer = null;
    this.finished = new Promise((r) => (this.resolve = r));
    this.tick();
  }
  push(text) {
    this.queue += text;
  }
  close() {
    this.closed = true;
  }
  tick() {
    if (this.queue.length) {
      const ch = this.queue[0];
      this.queue = this.queue.slice(1);
      this.el.textContent += ch;
      scrollToBottom();
      const backlog = this.queue.length;
      const delay = backlog > 60 ? 25 : backlog > 25 ? 45 : 70;
      if (!state.tts) avatar.pulse(mouthOpenFor(ch), delay * 0.75);
      this.timer = setTimeout(() => this.tick(), /[、。！？!?…\n]/.test(ch) ? delay * 3 : delay);
    } else if (this.closed) {
      this.resolve();
    } else {
      this.timer = setTimeout(() => this.tick(), 30);
    }
  }
}

// ---------- text to speech ----------

class Speaker {
  constructor() {
    this.pending = "";
  }
  get enabled() {
    return state.tts && "speechSynthesis" in window;
  }
  push(text) {
    if (!this.enabled) return;
    this.pending += text;
    const m = this.pending.match(/^[\s\S]*[。！？!?…\n]/);
    if (m) {
      this.say(m[0]);
      this.pending = this.pending.slice(m[0].length);
    }
  }
  flush() {
    if (!this.enabled) return;
    this.say(this.pending);
    this.pending = "";
  }
  say(text) {
    const clean = text.replace(/（[^）]*）|\([^)]*\)/g, "").trim();
    if (!clean) return;
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = "ja-JP";
    const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith("ja"));
    if (voice) u.voice = voice;
    u.rate = 1.05;
    u.pitch = 1.15;
    speechSynthesis.speak(u);
  }
}

setInterval(() => {
  avatar.setFlapping(state.tts && "speechSynthesis" in window && speechSynthesis.speaking);
}, 80);

// ---------- chat ----------

async function sendMessage(text) {
  if (state.busy || !state.current?.persona) return;
  state.busy = true;
  $("chatForm").querySelector("button").disabled = true;
  addMessage("user", text);

  const bubble = addMessage("assistant", "");
  bubble.classList.add("typing");
  const typer = new Typewriter(bubble);
  const speaker = new Speaker();
  let raw = "";
  let tagResolved = false;

  const feed = (visible) => {
    typer.push(visible);
    speaker.push(visible);
  };

  try {
    for await (const { event, data } of postSse(`/api/characters/${state.current.id}/chat`, { message: text })) {
      if (event === "delta") {
        raw += data.text;
        if (!tagResolved) {
          // 先頭の [happy] などの感情タグがそろうまで待つ
          if (/^\s*\[[^\]]{0,12}$/.test(raw)) continue;
          tagResolved = true;
          const emo = leadingEmotion(raw);
          if (emo && EMOTIONS.includes(emo)) avatar.setEmotion(emo);
          feed(stripTags(raw));
        } else {
          feed(stripTags(data.text));
        }
      } else if (event === "replace") {
        typer.queue = "";
        bubble.textContent = "";
        raw = data.text;
        feed(stripTags(raw));
      } else if (event === "error") {
        throw new Error(data.message);
      }
    }
    speaker.flush();
    typer.close();
    await typer.finished;
    bubble.textContent = stripTags(raw).trim();
  } catch (err) {
    typer.close();
    if (!raw) bubble.remove();
    addMessage("error", err.message);
  } finally {
    bubble.classList.remove("typing");
    state.busy = false;
    $("chatForm").querySelector("button").disabled = false;
  }
}

$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("chatInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  autoGrow();
  sendMessage(text);
});

const autoGrow = () => {
  const el = $("chatInput");
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
};
$("chatInput").addEventListener("input", autoGrow);
$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("chatForm").requestSubmit();
  }
});

$("resetChatBtn").addEventListener("click", async () => {
  if (!state.current || !confirm("会話の履歴を消しますか？")) return;
  await api(`/api/characters/${state.current.id}/history`, { method: "DELETE" });
  renderMessages([]);
  if (state.current.persona) addMessage("assistant", state.current.persona.greeting);
});

// ---------- stage controls ----------

$("rigBtn").addEventListener("click", () => {
  avatar.rigging = !avatar.rigging;
  $("stage").classList.toggle("rigging", avatar.rigging);
  $("rigHint").classList.toggle("hidden", !avatar.rigging);
});

$("stageCanvas").addEventListener("click", async (e) => {
  if (!avatar.rigging || !state.current) return;
  const p = avatar.toImageCoords(e.clientX, e.clientY);
  if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return;
  avatar.rigging = false;
  $("stage").classList.remove("rigging");
  $("rigHint").classList.add("hidden");
  await saveRig({ mouth: { x: p.x, y: p.y } });
  avatar.flapFor(1200);
});

async function saveRig(patch) {
  avatar.setRig(patch);
  state.current = await api(`/api/characters/${state.current.id}`, {
    method: "PATCH",
    body: JSON.stringify({ rig: patch }),
  });
  updateRigButton();
}

for (const key of ["mouthSize", "motion"]) {
  $(key).addEventListener("input", (e) => {
    avatar.setRig({ [key]: Number(e.target.value) });
    if (key === "mouthSize") avatar.flapFor(400);
  });
  $(key).addEventListener("change", (e) => saveRig({ [key]: Number(e.target.value) }));
}

$("testMouthBtn").addEventListener("click", () => {
  if (!state.current?.rig.mouth) {
    alert("先に「口の位置を設定」で、立ち絵の口をクリックしてください。");
    return;
  }
  avatar.flapFor(1800);
});

$("ttsToggle").checked = state.tts;
$("ttsToggle").addEventListener("change", (e) => {
  state.tts = e.target.checked;
  savePref("tts", state.tts);
  if (!state.tts) window.speechSynthesis?.cancel();
});

// ---------- dialogs ----------

for (const btn of document.querySelectorAll("[data-close]")) {
  btn.addEventListener("click", () => btn.closest("dialog").close());
}

$("newCharBtn").addEventListener("click", () => {
  $("newCharForm").reset();
  $("newCharPreview").classList.add("hidden");
  $("newCharDialog").showModal();
});

$("newCharForm").image.addEventListener("change", (e) => {
  const file = e.target.files[0];
  const img = $("newCharPreview");
  if (!file) return img.classList.add("hidden");
  img.src = URL.createObjectURL(file);
  img.classList.remove("hidden");
});

$("newCharForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const submit = form.querySelector("[type=submit]");
  submit.disabled = true;
  try {
    const c = await api("/api/characters", { method: "POST", body: new FormData(form) });
    $("newCharDialog").close();
    await refreshList();
    await runAnalyze(c.id);
  } catch (err) {
    alert(err.message);
  } finally {
    submit.disabled = false;
  }
});

async function runAnalyze(id) {
  const log = $("analyzeLog");
  log.innerHTML = "";
  $("analyzeCloseBtn").classList.add("hidden");
  $("analyzeDialog").showModal();
  const addLog = (text, cls) => {
    const li = document.createElement("li");
    li.textContent = text;
    if (cls) li.className = cls;
    log.append(li);
    log.scrollTop = log.scrollHeight;
  };
  try {
    for await (const { event, data } of postSse(`/api/characters/${id}/analyze`)) {
      if (event === "progress") addLog(data.message);
      else if (event === "error") throw new Error(data.message);
      else if (event === "done") {
        addLog("完了しました！");
        $("analyzeDialog").close();
        await refreshList(id);
        avatar.setEmotion("happy");
        if (!data.rig.mouth) {
          addMessage("error", "立ち絵の下の「口の位置を設定」で口をクリックすると、口パクするようになります。");
        }
        return;
      }
    }
  } catch (err) {
    addLog(`エラー: ${err.message}`, "error");
    $("analyzeCloseBtn").classList.remove("hidden");
    await refreshList(id);
  }
}

// 人格プロフィール
const LIST_FIELDS = ["catchphrases", "sampleLines"];
const TEXT_FIELDS = ["firstPerson", "secondPerson", "summary", "personality", "speechStyle"];

$("personaBtn").addEventListener("click", () => {
  const c = state.current;
  if (!c) return;
  const form = $("personaForm");
  const p = c.persona || {};
  for (const f of TEXT_FIELDS) form[f].value = p[f] || "";
  for (const f of LIST_FIELDS) form[f].value = (p[f] || []).join("\n");
  form.customInstructions.value = c.customInstructions || "";
  const conf = { high: "高い", medium: "ふつう", low: "低い（情報が少なめ・要確認）" }[p.confidence];
  $("personaConfidence").textContent = c.persona
    ? `ネット検索で作成したプロフィールです。調査の確からしさ: ${conf || "不明"}。違うところは自由に直してください。`
    : "まだ分析されていません。";
  const sources = $("sourceList");
  sources.innerHTML = "";
  for (const s of c.sources || []) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = s.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = s.title || s.url;
    li.append(a);
    sources.append(li);
  }
  $("personaDialog").showModal();
});

$("personaForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = { customInstructions: form.customInstructions.value };
  if (state.current.persona) {
    body.persona = {};
    for (const f of TEXT_FIELDS) body.persona[f] = form[f].value;
    for (const f of LIST_FIELDS) body.persona[f] = form[f].value.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  state.current = await api(`/api/characters/${state.current.id}`, { method: "PATCH", body: JSON.stringify(body) });
  $("personaDialog").close();
});

$("reanalyzeBtn").addEventListener("click", async () => {
  if (!confirm("ネットで調べ直します。今のプロフィールと会話履歴は上書きされます。よろしいですか？")) return;
  $("personaDialog").close();
  await runAnalyze(state.current.id);
});

$("deleteCharBtn").addEventListener("click", async () => {
  const c = state.current;
  if (!confirm(`「${c.persona?.displayName || c.name}」を削除しますか？`)) return;
  await api(`/api/characters/${c.id}`, { method: "DELETE" });
  $("personaDialog").close();
  state.current = null;
  $("talkView").classList.add("hidden");
  await refreshList();
  $("emptyState").classList.remove("hidden");
});

// ---------- boot ----------

window.speechSynthesis?.getVoices(); // 一部ブラウザは最初の呼び出しで音声一覧を読み込む
await refreshList();
if (state.characters[0]) await selectCharacter(state.characters[0].id);
