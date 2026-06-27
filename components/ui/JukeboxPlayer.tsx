"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";

type JukeboxPlayerState = {
  trackName: string | null;
  artistName: string | null;
  imageUrl: string | null;
  durationMs: number;
  positionMs: number;
  isPlaying: boolean;
  changedAt: string;
};

type JukeboxPlayerProps = {
  state: JukeboxPlayerState;
  busy: boolean;
  isDark: boolean;
  onPlayPause: () => void;
  /** Commit an absolute seek position (ms) from the progress bar. */
  onSeek: (positionMs: number) => void;
  onNext: () => void;
  onPrevious: () => void;
  canNext: boolean;
};

const GREEN = "#1DB954";

function fmt(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export function JukeboxPlayer({
  state,
  busy,
  isDark,
  onPlayPause,
  onSeek,
  onNext,
  onPrevious,
  canNext,
}: JukeboxPlayerProps) {
  const { durationMs, positionMs, isPlaying, changedAt } = state;

  // Live position: advance from the server snapshot while playing.
  const [now, setNow] = useState(() => Date.now());
  const [dragValue, setDragValue] = useState<number | null>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (!isPlaying) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [isPlaying, changedAt]);

  const elapsed = isPlaying ? Math.max(0, now - new Date(changedAt).getTime()) : 0;
  const livePos = Math.min(durationMs, Math.max(0, positionMs + elapsed));
  const shown = dragValue ?? livePos;
  const pct = durationMs > 0 ? Math.min(100, (shown / durationMs) * 100) : 0;

  const commitSeek = (value: number) => {
    draggingRef.current = false;
    setDragValue(null);
    onSeek(Math.min(durationMs, Math.max(0, value)));
  };

  const subtle = isDark ? "text-white/55" : "text-slate-500";
  const ctrlBtn = `flex h-10 w-10 items-center justify-center rounded-full text-lg transition-colors disabled:opacity-40 ${
    isDark ? "bg-white/10 hover:bg-white/20" : "bg-slate-200/80 hover:bg-slate-300"
  }`;

  return (
    <div
      className={`mb-3 rounded-2xl p-3 ${
        isDark ? "bg-white/10" : "bg-slate-100"
      }`}
    >
      <div className="flex items-center gap-3">
        {/* album art */}
        <motion.div
          className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl"
          animate={isPlaying ? { scale: [1, 1.04, 1] } : { scale: 1 }}
          transition={{ duration: 2.4, repeat: isPlaying ? Infinity : 0, ease: "easeInOut" }}
        >
          {state.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={state.imageUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-[#1DB954] text-2xl text-black">
              ♫
            </div>
          )}
        </motion.div>

        {/* track info */}
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold">{state.trackName}</p>
          <p className={`truncate text-xs ${subtle}`}>{state.artistName}</p>
          <p className={`mt-0.5 text-[11px] font-semibold ${isPlaying ? "text-[#1DB954]" : subtle}`}>
            {isPlaying ? "Playing" : "Paused"}
          </p>
        </div>
      </div>

      {/* progress bar */}
      <div className="mt-3">
        <input
          type="range"
          className="jukebox-range w-full"
          min={0}
          max={Math.max(1, durationMs)}
          step={1000}
          value={Math.round(shown)}
          style={{
            background: `linear-gradient(to right, ${GREEN} ${pct}%, ${
              isDark ? "rgba(255,255,255,0.18)" : "rgba(148,163,184,0.35)"
            } ${pct}%)`,
          }}
          onPointerDown={() => {
            draggingRef.current = true;
          }}
          onChange={(e) => {
            if (draggingRef.current) setDragValue(Number(e.target.value));
          }}
          onPointerUp={(e) => commitSeek(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => commitSeek(Number((e.target as HTMLInputElement).value))}
          aria-label="Seek"
        />
        <div className={`mt-1 flex justify-between text-[11px] tabular-nums ${subtle}`}>
          <span>{fmt(shown)}</span>
          <span>{fmt(durationMs)}</span>
        </div>
      </div>

      {/* transport controls */}
      <div className="mt-2 flex items-center justify-center gap-4">
        <button
          type="button"
          disabled={busy}
          onClick={onPrevious}
          className={ctrlBtn}
          aria-label="Previous track"
          title="Previous"
        >
          ⏮
        </button>

        <motion.button
          type="button"
          disabled={busy}
          onClick={onPlayPause}
          whileTap={{ scale: 0.88 }}
          className="relative flex h-14 w-14 items-center justify-center rounded-full bg-[#1DB954] text-xl font-black text-black shadow-lg shadow-[#1DB954]/30 disabled:opacity-50"
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying && (
            <motion.span
              className="absolute inset-0 rounded-full"
              style={{ border: "2px solid rgba(29,185,84,0.6)" }}
              animate={{ scale: [1, 1.35], opacity: [0.6, 0] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
            />
          )}
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={isPlaying ? "pause" : "play"}
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.5, opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {isPlaying ? "❚❚" : "▶"}
            </motion.span>
          </AnimatePresence>
        </motion.button>

        <button
          type="button"
          disabled={busy || !canNext}
          onClick={onNext}
          className={ctrlBtn}
          aria-label="Next track"
          title={canNext ? "Next" : "Nothing queued"}
        >
          ⏭
        </button>
      </div>
    </div>
  );
}

export default JukeboxPlayer;
