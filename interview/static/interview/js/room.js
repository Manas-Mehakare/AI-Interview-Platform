import { createFaceMonitor } from "./face.js";
import { createVoice } from "./voice.js";
import { createTabMonitor } from "./proctor.js";

const $ = (id) => document.getElementById(id);
const app = $("app");
const cfg = {
  answerUrl: app.dataset.answerUrl,
  eventUrl: app.dataset.eventUrl,
  csrf: app.dataset.csrf,
  total: Number(app.dataset.total),
  transcribeUrl: app.dataset.transcribeUrl,
};
const firstQuestion = JSON.parse($("first-question").textContent);

const el = {
  log: $("log"), answer: $("answer"), mic: $("micBtn"), send: $("sendBtn"), aiState: $("aiState"),
  cam: $("cam"), camPre: $("camPre"), faceBadge: $("faceBadge"),
  progress: $("progress"), warnBadge: $("warnBadge"),
  precheck: $("precheck"), enable: $("enableBtn"), start: $("startBtn"), precheckErr: $("precheckErr"),
  chkMedia: $("chkMedia").querySelector("span"), chkFace: $("chkFace").querySelector("span"),
  warnModal: $("warnModal"), warnOk: $("warnOk"),
};

let started = false;
let busy = false;
let micPreferred = false;   
let usedVoice = false;
let okStreak = 0;
let faceMonitor = null;


async function post(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRFToken": cfg.csrf },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, data };
}

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  el.log.appendChild(div);
  el.log.scrollTop = el.log.scrollHeight;
  return div;
}

const setState = (t) => { el.aiState.textContent = t; };

function setComposer(on) {
  el.answer.disabled = !on;
  el.send.disabled = !on;
  el.mic.disabled = !on || !voice.supported;
  if (on) el.answer.focus();
}

function goToReport(url) {
  faceMonitor && faceMonitor.stop();
  window.location.href = url;
}


const voice = createVoice({
  transcribeUrl: cfg.transcribeUrl,
  csrf: cfg.csrf,
  onTranscript: (t) => { el.answer.value = t; usedVoice = true; },
  onListening: (on) => {
    el.mic.textContent = on ? "⏹ Stop" : "🎤 Speak";
    el.mic.classList.toggle("active", on);
    if (on) setState("Recording... press Stop when done");
  },
  onBusy: (b) => setState(b ? "Transcribing..." : "Your turn"),
  onError: (msg, fatal) => { if (fatal) micPreferred = false; addMessage("sys", msg); },
});

if (!voice.supported) {
  el.mic.title = "Speech input needs Chrome or Edge. You can type instead.";
}

function startMic() { voice.startListening(el.answer.value); }

el.mic.addEventListener("click", () => {
  if (voice.isListening()) {
    micPreferred = false;
    voice.stopListening();
    setState("Your turn");
  } else {
    micPreferred = true;
    startMic();
  }
});

async function aiSay(text) {
  addMessage("ai", text);
  voice.stopListening(true);          
  setState("AI is speaking...");
  await voice.speak(text);
  setState("Your turn");
  if (micPreferred) startMic();
}


const FACE_TEXT = { ok: "Face detected", no_face: "No face detected", multi_face: "Multiple faces detected" };

function onFaceStatus(kind) {
  el.faceBadge.textContent = FACE_TEXT[kind];
  el.faceBadge.className = "badge " + (kind === "ok" ? "good" : "bad");
  if (!started) {
    okStreak = kind === "ok" ? okStreak + 1 : 0;
    const ready = okStreak >= 3;
    el.chkFace.textContent = ready ? "ready ✓" : "looking for your face...";
    el.start.disabled = !ready;
  }
}

async function onFaceViolation(kind) {
  if (!started) return;
  addMessage("sys", kind === "no_face" ? "No face detected. Please stay in frame." : "Multiple faces detected.");
  const { data } = await post(cfg.eventUrl, { kind });
  if (data.terminated) goToReport(data.report_url);
}

const tabs = createTabMonitor({
  onSwitch: async () => {
    const { data } = await post(cfg.eventUrl, { kind: "tab_switch" });
    if (data.terminated) return goToReport(data.report_url);
    if (data.warning) {
      el.warnBadge.textContent = `Tab warnings: ${data.warning}/2`;
      el.warnModal.classList.remove("hidden");
    }
  },
});

el.warnOk.addEventListener("click", () => el.warnModal.classList.add("hidden"));


el.enable.addEventListener("click", async () => {
  el.precheckErr.textContent = "";
  el.enable.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: true });
    stream.getAudioTracks().forEach((t) => t.stop());   // free mic for speech recognition
    el.cam.srcObject = stream;
    el.camPre.srcObject = stream;
    el.camPre.classList.remove("hidden");
    await el.cam.play();
    el.chkMedia.textContent = "ready ✓";
  } catch (_) {
    el.precheckErr.textContent = "Camera or mic is blocked. Allow access in the address bar and try again.";
    el.enable.disabled = false;
    return;
  }

  el.chkFace.textContent = "loading detector...";
  try {
    faceMonitor = await createFaceMonitor(el.cam, { onStatus: onFaceStatus, onViolation: onFaceViolation });
    faceMonitor.start();
  } catch (_) {
    el.precheckErr.textContent = "Couldn't load face detection. Check your internet and reload.";
    el.enable.disabled = false;
  }
});

el.start.addEventListener("click", async () => {
  started = true;                     
  el.precheck.classList.add("hidden");
  tabs.start();
  setComposer(true);
  await aiSay(firstQuestion);
});


async function submit() {
  if (busy) return;
  busy = true;
  if (voice.isListening() || voice.isBusy()) {
    setState("Transcribing...");
    await voice.settle();
  }
  const text = el.answer.value.trim();
  if (!text) { busy = false; setState("Your turn"); return; }

  voice.stopListening(true);
  setComposer(false);
  setState("AI is thinking...");
  const node = addMessage("me", text);
  const mode = usedVoice ? "voice" : "typed";
  el.answer.value = "";

  let res;
  try {
    res = await post(cfg.answerUrl, { text, input_mode: mode });
  } catch (_) {
    res = { ok: false, data: { error: "Network error. Please resubmit." } };
  }

  if (!res.ok) {                        // restore the answer so nothing is lost
    node.remove();
    addMessage("sys", res.data.error || "Something went wrong. Please resubmit.");
    el.answer.value = text;
    setComposer(true);
    setState("Your turn");
    busy = false;
    return;
  }

  usedVoice = false;
  if (res.data.done || res.data.terminated) return goToReport(res.data.report_url);

  el.progress.textContent = `Question ${res.data.number} / ${cfg.total}`;
  await aiSay(res.data.question);
  setComposer(true);
  busy = false;
}

el.send.addEventListener("click", submit);
el.answer.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
});