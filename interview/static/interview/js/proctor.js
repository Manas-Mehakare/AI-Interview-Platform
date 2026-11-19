/**
 * Fires onSwitch() each time the tab becomes hidden (tab change / minimize).
 * Uses visibilitychange only: window.blur false-fires on permission prompts.
 */
export function createTabMonitor({ onSwitch }) {
  let active = false;
  let lastFire = 0;

  document.addEventListener("visibilitychange", () => {
    if (!active || document.visibilityState !== "hidden") return;
    const now = Date.now();
    if (now - lastFire < 1000) return;   // ignore double fires
    lastFire = now;
    onSwitch();
  });

  return {
    start() { active = true; },
    stop() { active = false; },
  };
}