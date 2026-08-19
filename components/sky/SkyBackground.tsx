"use client";

import { memo } from "react";

/**
 * SkyBackground — static, soft-UI sky.
 *
 * One structure serves all three modes; the palette comes entirely from the
 * `data-sky` CSS variables on :root (see globals.css), so switching modes is
 * just a data-attribute swap. There is NO backdrop-filter anywhere in the
 * soft-UI shell, so this can animate cheaply (opacity twinkles + a very slow
 * cloud drift) without the re-rasterization that plagued the glass version.
 */

const TWINKLES = [
  { top: 9, left: 16, size: 3, dur: 3.4 },
  { top: 14, left: 74, size: 2, dur: 4.8 },
  { top: 22, left: 44, size: 3, dur: 5.6 },
  { top: 31, left: 88, size: 2, dur: 4.1 },
  { top: 38, left: 24, size: 2.5, dur: 6.2 },
  { top: 47, left: 62, size: 2, dur: 3.9 },
  { top: 8, left: 52, size: 2, dur: 5.1 },
  { top: 64, left: 12, size: 2.5, dur: 4.6 },
  { top: 72, left: 82, size: 2, dur: 5.9 },
  { top: 83, left: 37, size: 3, dur: 3.6 },
  { top: 88, left: 68, size: 2, dur: 6.6 },
  { top: 55, left: 33, size: 2, dur: 4.3 },
];

const CLOUDS = [
  { top: 12, dur: 210, scale: 1, opacity: 0.9 },
  { top: 30, dur: 280, scale: 0.8, opacity: 0.7 },
  { top: 6, dur: 340, scale: 1.25, opacity: 0.5 },
];

const STARFIELD =
  "radial-gradient(1.5px 1.5px at 20% 30%, var(--star-soft) 50%, transparent 52%)," +
  "radial-gradient(1px 1px at 65% 20%, var(--star) 50%, transparent 52%)," +
  "radial-gradient(1.5px 1.5px at 40% 70%, var(--star) 50%, transparent 52%)," +
  "radial-gradient(1px 1px at 85% 55%, var(--star-soft) 50%, transparent 52%)," +
  "radial-gradient(1px 1px at 12% 80%, var(--star) 50%, transparent 52%)," +
  "radial-gradient(1.5px 1.5px at 55% 92%, var(--star) 50%, transparent 52%)," +
  "radial-gradient(1px 1px at 92% 88%, var(--star-soft) 50%, transparent 52%)," +
  "radial-gradient(1px 1px at 30% 12%, var(--star) 50%, transparent 52%)";

const CLOUD_SHAPE =
  "radial-gradient(60px 44px at 30% 60%, var(--cloud) 0%, transparent 70%)," +
  "radial-gradient(70px 56px at 55% 45%, var(--cloud) 0%, transparent 72%)," +
  "radial-gradient(56px 42px at 74% 62%, var(--cloud) 0%, transparent 70%)";

function SkyBackgroundBase() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{
        background:
          "radial-gradient(110% 70% at 72% 104%, var(--glow) 0%, transparent 62%)," +
          "linear-gradient(165deg, var(--sky-a) 0%, var(--nm-ground) 55%, var(--sky-b) 100%)",
        transition: "background .6s ease",
      }}
    >
      {/* dense far starfield — zero DOM nodes, colour from vars */}
      <div
        className="absolute inset-[-10%]"
        style={{ backgroundImage: STARFIELD, opacity: 0.55 }}
      />

      {/* bright twinkling stars — opacity only (Stars mode) */}
      {TWINKLES.map((s, i) => (
        <span
          key={`tw-${i}`}
          className="absolute rounded-full"
          style={{
            top: `${s.top}%`,
            left: `${s.left}%`,
            width: s.size,
            height: s.size,
            background: "var(--star)",
            boxShadow: "0 0 6px 1px var(--star-soft)",
            animation: `nmTwinkle ${s.dur}s ease-in-out infinite`,
          }}
        />
      ))}

      {/* ultra-slow clouds — transform only (Clouds mode) */}
      {CLOUDS.map((c, i) => (
        <div
          key={`cl-${i}`}
          className="absolute"
          style={{
            top: `${c.top}%`,
            height: 90,
            width: 260,
            borderRadius: 100,
            opacity: c.opacity,
            backgroundImage: CLOUD_SHAPE,
            transform: `scale(${c.scale})`,
            animation: `nmDrift ${c.dur}s linear infinite`,
            willChange: "transform",
          }}
        />
      ))}
    </div>
  );
}

/** Memoized: depends on nothing, so it never needs to re-render. */
export const SkyBackground = memo(SkyBackgroundBase);

export default SkyBackground;
