const MAX_RECORD_MS = 120000;   // safety cap: 2 minutes per recording
const MIN_RECORD_MS = 700;      // ignore accidental taps
const SILENT_PEAK = 0.01;       // below this the mic is effectively silent (normal speech peaks ~0.2+)

function pickMime() {
  if (!window.MediaRecorder) return "";
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

function pickVoice() {
  const voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  return (
    voices.find((v) => v.lang === "en-IN") ||
    voices.find((v) => v.lang === "en-GB") ||
    voices.find((v) => v.lang.startsWith("en")) ||
    null
  );
}

// Loudest sample in the recording (0..1). Returns null if the browser can't decode it.
async function measurePeak(blob) {
  let ctx;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const data = buf.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    return peak;
  } catch (_) {
    return null;
  } finally {
    if (ctx) ctx.close();
  }
}

/**
 * Two-way voice helper.
 * Speech in : records the mic, sends audio to Django (Groq Whisper), returns text.
 * Speech out: browser speechSynthesis.
 *
 * onTranscript(fullText)    -> typed base text + newly transcribed text
 * onListening(bool)         -> recording started / stopped
 * onBusy(bool)              -> checking / transcribing in progress
 * onError(message, fatal)   -> user-facing error (fatal = mic blocked)
 */
export function createVoice({ transcribeUrl, csrf, onTranscript, onListening, onBusy, onError }) {
  const supported = !!(navigator.mediaDevices && window.MediaRecorder);

  let stream = null;
  let recorder = null;
  let chunks = [];
  let startedAt = 0;
  let base = "";
  let discard = false;
  let listening = false;
  let starting = false;
  let busyCount = 0;
  let capTimer = null;
  let stopped = Promise.resolve();
  let resolveStopped = () => {};
  let chain = Promise.resolve();

  function setListening(on) {
    if (listening !== on) {
      listening = on;
      onListening(on);
    }
  }

  async function ensureStream() {
    if (stream && stream.getAudioTracks().some((t) => t.readyState === "live")) return stream;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    return stream;
  }

  async function startListening(baseText = "") {
    if (!supported || listening || starting) return;
    starting = true;
    try {
      await ensureStream();
    } catch (_) {
      starting = false;
      onError("Microphone access is blocked. You can still type your answer.", true);
      return;
    }
    starting = false;

    base = baseText.trim();
    chunks = [];
    discard = false;
    const mime = pickMime();
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = handleStop;
    stopped = new Promise((res) => { resolveStopped = res; });
    recorder.start();
    startedAt = Date.now();
    setListening(true);
    capTimer = setTimeout(() => stopListening(), MAX_RECORD_MS);
  }

  // abort=true throws the recording away (used after submit / while AI speaks)
  function stopListening(abort = false) {
    if (!listening) return;
    discard = abort;
    clearTimeout(capTimer);
    setListening(false);
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }

  function handleStop() {
    const blob = new Blob(chunks, { type: (recorder && recorder.mimeType) || "audio/webm" });
    const tooShort = Date.now() - startedAt < MIN_RECORD_MS;
    const track = stream && stream.getAudioTracks()[0];
    const label = track ? track.label : "unknown device";
    chunks = [];

    if (!discard && !tooShort && blob.size > 1000) {
      const myBase = base;
      busyCount += 1;                       // busy from the moment Stop is pressed
      onBusy(true);
      chain = chain.then(() => checkAndTranscribe(blob, myBase, label));
    } else if (!discard && tooShort) {
      onError("Recording too short. Press Speak, talk, then press Stop.", false);
    }
    resolveStopped();
  }

  async function checkAndTranscribe(blob, myBase, label) {
    try {
      const peak = await measurePeak(blob);
      console.log(`[voice] mic="${label}" bytes=${blob.size} peak=${peak === null ? "n/a" : peak.toFixed(3)}`);
      if (peak !== null && peak < SILENT_PEAK) {
        onError(
          `Your microphone ("${label}") is picking up almost no sound. ` +
          "Check the input device and volume in your system sound settings.",
          false
        );
        return;
      }
      await transcribe(blob, myBase);
    } finally {
      busyCount -= 1;
      if (busyCount === 0) onBusy(false);
    }
  }

  async function transcribe(blob, myBase) {
    try {
      const ext = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "mp4" : "webm";
      const fd = new FormData();
      fd.append("audio", blob, `answer.${ext}`);
      const r = await fetch(transcribeUrl, { method: "POST", headers: { "X-CSRFToken": csrf }, body: fd });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "Transcription failed. Please type your answer.");
      const text = (data.text || "").trim();
      if (!text) {
        onError("Didn't catch that. Speak a bit closer to the mic and try again.", false);
        return;
      }
      onTranscript((myBase + " " + text).trim());
    } catch (e) {
      onError(e.message || "Transcription failed. Please type your answer.", false);
    }
  }

  // Stop any recording and wait until its text has arrived
  async function settle() {
    if (listening) {
      stopListening();
      await stopped;
    }
    await chain;
  }

  function speak(text) {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return resolve();
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }

  return {
    supported,
    startListening,
    stopListening,
    isListening: () => listening,
    isBusy: () => busyCount > 0,
    settle,
    speak,
  };
}