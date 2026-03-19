// Shared helpers and constants
export const DRONE_FLY_HEIGHT = 6;
export const OBSTACLE_RADIUS = 1.5;
export const AVOIDANCE_LOOKAHEAD = 6;
export const AVOIDANCE_STRENGTH = 0.7;

export function getRandomDroneColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 70%, 60%)`;
}

export function hslWithAlpha(hslColor, alpha) {
  if (!hslColor) return `hsla(0, 0%, 50%, ${alpha})`;
  return hslColor.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`);
}

export function hazardOf(state, r, c) {
  const k = `S${r}_${c}`;
  if (state.FIRE.has(k)) return "fire";
  if (state.SMOKE.has(k)) return "smoke";
  return "clear";
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
