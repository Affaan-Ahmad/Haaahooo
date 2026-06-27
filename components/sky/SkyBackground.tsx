"use client";

import { useSyncExternalStore } from "react";

/**
 * SkyBackground
 * ------------------------------------------------------------------
 * A cozy, ambient day/night sky used behind the whole app and the chat
 * area. Drop-in replacement for the original inline component: it still
 * accepts `theme` and renders an absolutely-positioned, pointer-events-none
 * layer (`absolute inset-0`) so it sits behind `relative z-10` content.
 *
 * What's new vs the original:
 *   - Moon with craters + soft halo (night)
 *   - Sun with soft rays + glow (day)
 *   - Layered, slowly drifting soft clouds
 *   - Sunrise / sunset warm glow band on the horizon (dawn / dusk)
 *   - Twinkling stars + the occasional shooting star (night)
 *   - Subtle drifting fireflies (night) and optional rain / snow
 *
 * Performance notes:
 *   - All particle positions are precomputed deterministically at module
 *     scope (no Math.random in render) so server and client markup match
 *     and there is no hydration mismatch.
 *   - Every animation uses only `transform` / `opacity` (compositor-thread)
 *     and counts are capped for phones.
 *   - `prefers-reduced-motion` renders a calm, static scene.
 */

export type SkyTheme = "light" | "dark";
export type SkyPhase = "dawn" | "day" | "dusk" | "night";
export type Precip = "none" | "rain" | "snow";

type SkyBackgroundProps = {
  theme: SkyTheme;
  /** Force a phase. If omitted it is derived from `theme` + local time. */
  phase?: SkyPhase;
  /** Optional precipitation layer. Defaults to none (kept subtle). */
  precip?: Precip;
  /** Scales particle counts. 1 = default, lower for very weak devices. */
  density?: number;
};

/* ---------- deterministic pseudo-random (seeded, SSR-safe) ---------- */
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STARS = (() => {
  const rand = mulberry32(1337);
  return Array.from({ length: 70 }, () => ({
    left: rand() * 100,
    top: rand() * 70,
    size: 1 + Math.round(rand() * 2),
    opacity: 0.35 + rand() * 0.55,
    delay: rand() * 6,
    dur: 2.5 + rand() * 3.5,
  }));
})();

const FIREFLIES = (() => {
  const rand = mulberry32(7);
  return Array.from({ length: 12 }, () => ({
    left: 5 + rand() * 90,
    top: 35 + rand() * 55,
    delay: rand() * 8,
    dur: 7 + rand() * 7,
    drift: 12 + rand() * 26,
  }));
})();

const RAIN = (() => {
  const rand = mulberry32(99);
  return Array.from({ length: 46 }, () => ({
    left: rand() * 100,
    delay: rand() * 1.2,
    dur: 0.55 + rand() * 0.5,
    len: 14 + rand() * 16,
    opacity: 0.15 + rand() * 0.25,
  }));
})();

const SNOW = (() => {
  const rand = mulberry32(42);
  return Array.from({ length: 34 }, () => ({
    left: rand() * 100,
    delay: rand() * 6,
    dur: 7 + rand() * 7,
    size: 3 + rand() * 4,
    drift: 10 + rand() * 30,
    opacity: 0.45 + rand() * 0.4,
  }));
})();

const CLOUDS = [
  { top: 10, scale: 1.15, dur: 70, delay: 0, opacity: 0.9 },
  { top: 20, scale: 0.8, dur: 95, delay: -30, opacity: 0.75 },
  { top: 30, scale: 1.3, dur: 120, delay: -60, opacity: 0.8 },
  { top: 16, scale: 0.65, dur: 85, delay: -15, opacity: 0.6 },
];

function derivePhase(theme: SkyTheme): SkyPhase {
  if (theme === "dark") return "night";
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 8) return "dawn";
  if (hour >= 17 && hour < 20) return "dusk";
  return "day";
}

const GRADIENTS: Record<SkyPhase, string> = {
  night:
    "linear-gradient(160deg, #0b1026 0%, #131a3a 38%, #1c1140 70%, #05070f 100%)",
  dawn: "linear-gradient(160deg, #2a3a66 0%, #6d6aa6 30%, #e9a6a0 66%, #ffd9a8 100%)",
  day: "linear-gradient(160deg, #bfe3ff 0%, #dcefff 45%, #eaf6ff 75%, #fff3d6 100%)",
  dusk: "linear-gradient(160deg, #2a2350 0%, #6e4a7e 38%, #d98a78 70%, #ffc27a 100%)",
};

/** Re-check the time-of-day phase once a minute. */
function subscribePhase(callback: () => void) {
  const id = window.setInterval(callback, 60_000);
  return () => window.clearInterval(id);
}

export function SkyBackground({
  theme,
  phase: phaseProp,
  precip = "none",
  density = 1,
}: SkyBackgroundProps) {
  // Client reads the time-of-day phase; server falls back to a deterministic
  // value that matches `theme`, so the first paint matches the markup and
  // there is no hydration mismatch. Strings compare by value, so the snapshot
  // is referentially stable between renders.
  const livePhase = useSyncExternalStore(
    subscribePhase,
    () => derivePhase(theme),
    () => (theme === "dark" ? "night" : "day"),
  );
  const phase: SkyPhase = phaseProp ?? livePhase;

  const isNight = phase === "night";
  const warmGlow = phase === "dawn" || phase === "dusk";
  const cap = (n: number) => Math.max(0, Math.round(n * density));

  const stars = isNight || warmGlow ? STARS.slice(0, cap(isNight ? 70 : 22)) : [];
  const fireflies = isNight ? FIREFLIES.slice(0, cap(12)) : [];
  const clouds = !isNight ? CLOUDS : [];
  const rain = precip === "rain" ? RAIN.slice(0, cap(46)) : [];
  const snow = precip === "snow" ? SNOW.slice(0, cap(34)) : [];

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{
        background: GRADIENTS[phase],
        transition: "background 1200ms ease",
      }}
    >
      <style>{skyKeyframes}</style>

      {/* sunrise / sunset horizon glow */}
      {warmGlow && (
        <div
          className="absolute inset-x-0 bottom-0 h-2/3"
          style={{
            background:
              phase === "dawn"
                ? "radial-gradient(120% 90% at 75% 100%, rgba(255,196,140,0.85) 0%, rgba(255,170,150,0.35) 35%, rgba(255,170,150,0) 70%)"
                : "radial-gradient(120% 90% at 25% 100%, rgba(255,150,90,0.8) 0%, rgba(214,120,150,0.32) 38%, rgba(214,120,150,0) 72%)",
          }}
        />
      )}

      {/* MOON */}
      {isNight && (
        <div
          className="absolute right-[12%] top-[12%]"
          style={{ animation: "sky-glow 7s ease-in-out infinite" }}
        >
          <div
            className="absolute -inset-10 rounded-full"
            style={{
              background:
                "radial-gradient(circle, rgba(226,232,240,0.45) 0%, rgba(226,232,240,0) 70%)",
            }}
          />
          <div className="relative h-24 w-24 overflow-hidden rounded-full bg-[#e8edf6] shadow-[0_0_60px_rgba(226,232,240,0.55)]">
            <span className="absolute left-4 top-5 h-4 w-4 rounded-full bg-black/5" />
            <span className="absolute left-12 top-10 h-6 w-6 rounded-full bg-black/5" />
            <span className="absolute left-7 top-14 h-3 w-3 rounded-full bg-black/5" />
          </div>
        </div>
      )}

      {/* SUN */}
      {!isNight && (
        <div
          className={`absolute ${warmGlow ? "bottom-[18%]" : "top-[12%]"} ${
            phase === "dusk" ? "left-[14%]" : "right-[14%]"
          }`}
          style={{ animation: "sky-glow 6s ease-in-out infinite" }}
        >
          <div
            className="absolute -inset-12 rounded-full"
            style={{
              background:
                "radial-gradient(circle, rgba(255,224,130,0.85) 0%, rgba(255,224,130,0) 70%)",
            }}
          />
          <div className="relative h-24 w-24 rounded-full bg-gradient-to-br from-amber-200 to-yellow-400 shadow-[0_0_80px_rgba(253,224,71,0.9)]" />
        </div>
      )}

      {/* STARS */}
      {stars.map((s, i) => (
        <span
          key={`star-${i}`}
          className="absolute rounded-full bg-white"
          style={{
            left: `${s.left}%`,
            top: `${s.top}%`,
            width: s.size,
            height: s.size,
            opacity: warmGlow ? s.opacity * 0.5 : s.opacity,
            animation: `sky-twinkle ${s.dur}s ease-in-out ${s.delay}s infinite`,
          }}
        />
      ))}

      {/* SHOOTING STAR (night only, single, slow loop) */}
      {isNight && (
        <span
          className="absolute left-[8%] top-[14%] h-[2px] w-24 rounded-full bg-gradient-to-r from-white to-transparent"
          style={{ animation: "sky-shoot 11s ease-in 3s infinite" }}
        />
      )}

      {/* CLOUDS */}
      {clouds.map((c, i) => (
        <div
          key={`cloud-${i}`}
          className="absolute left-[-30%]"
          style={{
            top: `${c.top}%`,
            opacity: c.opacity,
            transform: `scale(${c.scale})`,
            animation: `sky-drift ${c.dur}s linear ${c.delay}s infinite`,
          }}
        >
          <div className="relative h-16 w-44">
            <div className="absolute bottom-0 left-2 h-12 w-24 rounded-full bg-white/85 blur-[2px]" />
            <div className="absolute bottom-4 left-14 h-16 w-16 rounded-full bg-white/90 blur-[2px]" />
            <div className="absolute bottom-0 left-24 h-12 w-28 rounded-full bg-white/85 blur-[2px]" />
          </div>
        </div>
      ))}

      {/* FIREFLIES */}
      {fireflies.map((f, i) => (
        <span
          key={`fly-${i}`}
          className="absolute h-1.5 w-1.5 rounded-full bg-amber-200"
          style={{
            left: `${f.left}%`,
            top: `${f.top}%`,
            boxShadow: "0 0 8px 2px rgba(253,230,138,0.7)",
            ["--drift" as string]: `${f.drift}px`,
            animation: `sky-firefly ${f.dur}s ease-in-out ${f.delay}s infinite`,
          }}
        />
      ))}

      {/* RAIN */}
      {rain.map((r, i) => (
        <span
          key={`rain-${i}`}
          className="absolute top-[-10%] w-px bg-gradient-to-b from-white/0 via-white/60 to-white/0"
          style={{
            left: `${r.left}%`,
            height: r.len,
            opacity: r.opacity,
            animation: `sky-rain ${r.dur}s linear ${r.delay}s infinite`,
          }}
        />
      ))}

      {/* SNOW */}
      {snow.map((s, i) => (
        <span
          key={`snow-${i}`}
          className="absolute top-[-5%] rounded-full bg-white"
          style={{
            left: `${s.left}%`,
            width: s.size,
            height: s.size,
            opacity: s.opacity,
            ["--drift" as string]: `${s.drift}px`,
            animation: `sky-snow ${s.dur}s linear ${s.delay}s infinite`,
          }}
        />
      ))}

      {/* gentle vignette so foreground panels stay readable */}
      <div
        className="absolute inset-0"
        style={{
          background: isNight
            ? "radial-gradient(120% 120% at 50% 30%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.28) 100%)"
            : "radial-gradient(120% 120% at 50% 30%, rgba(255,255,255,0) 60%, rgba(255,255,255,0.18) 100%)",
        }}
      />
    </div>
  );
}

const skyKeyframes = `
@keyframes sky-twinkle {
  0%, 100% { transform: scale(1); opacity: 0.35; }
  50% { transform: scale(1.7); opacity: 1; }
}
@keyframes sky-glow {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.05); }
}
@keyframes sky-drift {
  0% { transform: translateX(0) scale(var(--s,1)); }
  100% { transform: translateX(160vw) scale(var(--s,1)); }
}
@keyframes sky-firefly {
  0%, 100% { transform: translate(0, 0); opacity: 0; }
  20% { opacity: 0.9; }
  50% { transform: translate(var(--drift, 18px), calc(var(--drift, 18px) * -0.6)); opacity: 0.7; }
  80% { opacity: 0.85; }
}
@keyframes sky-shoot {
  0% { transform: translate(0, 0) rotate(18deg); opacity: 0; }
  3% { opacity: 1; }
  12% { transform: translate(60vw, 30vh) rotate(18deg); opacity: 0; }
  100% { transform: translate(60vw, 30vh) rotate(18deg); opacity: 0; }
}
@keyframes sky-rain {
  0% { transform: translateY(0); }
  100% { transform: translateY(120vh); }
}
@keyframes sky-snow {
  0% { transform: translate(0, 0); }
  100% { transform: translate(var(--drift, 20px), 110vh); }
}
@media (prefers-reduced-motion: reduce) {
  [aria-hidden] [style*="animation"] { animation: none !important; }
}
`;

export default SkyBackground;
