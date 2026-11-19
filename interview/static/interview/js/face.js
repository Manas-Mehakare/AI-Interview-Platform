import { FaceDetector, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

/**
 * Watches a <video> for faces.
 * onStatus(kind, count)  -> every tick, kind: "ok" | "no_face" | "multi_face"
 * onViolation(kind)      -> when a bad state lasts longer than graceMs (repeats every repeatMs)
 */
export async function createFaceMonitor(
  video,
  { onStatus, onViolation, intervalMs = 400, graceMs = 3000, repeatMs = 10000 }
) {
  const vision = await FilesetResolver.forVisionTasks(WASM);
  const detector = await FaceDetector.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL },
    runningMode: "VIDEO",
    minDetectionConfidence: 0.5,
  });

  let timer = null;
  let badKind = null;
  let badSince = 0;
  let lastFired = 0;

  function tick() {
    if (video.readyState < 2) return;
    const count = detector.detectForVideo(video, performance.now()).detections.length;
    const kind = count === 0 ? "no_face" : count > 1 ? "multi_face" : "ok";
    onStatus(kind, count);

    const now = Date.now();
    if (kind === "ok") {
      badKind = null;
      return;
    }
    if (kind !== badKind) {
      badKind = kind;
      badSince = now;
      lastFired = 0;
      return;
    }
    if (now - badSince >= graceMs && now - lastFired >= repeatMs) {
      lastFired = now;
      onViolation(kind);
    }
  }

  return {
    start() {
      if (!timer) timer = setInterval(tick, intervalMs);
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}