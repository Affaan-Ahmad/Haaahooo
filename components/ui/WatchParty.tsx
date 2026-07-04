"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type WatchState = {
  videoId: string | null;
  title: string | null;
  channelTitle: string | null;
  thumbnailUrl: string | null;
  durationMs: number;
  positionMs: number;
  isPlaying: boolean;
  changedAt: string;
  changedBy: string | null;
  currentQueueId: string | null;
};

export type WatchQueueItem = {
  id: string;
  videoId: string;
  title: string;
  channelTitle: string | null;
  thumbnailUrl: string | null;
  durationMs: number;
  addedBy: string | null;
};

export type WatchVideo = {
  videoId: string;
  title: string;
  channelTitle: string | null;
  thumbnailUrl: string | null;
  durationMs: number;
};

export type WatchControlAction =
  | "select"
  | "enqueue"
  | "play"
  | "pause"
  | "seek"
  | "next"
  | "previous"
  | "remove"
  | "advance"
  | "setduration";

export type WatchControlOpts = {
  video?: WatchVideo;
  positionMs?: number;
  durationMs?: number;
  queueId?: string;
  expectedChangedAt?: string;
};

export type WatchChatMessage = {
  id: string;
  sender_id: string | null;
  sender_name: string | null;
  body: string | null;
  is_bot: boolean;
  message_type: string;
};

type WatchPartyProps = {
  open: boolean;
  onClose: () => void;
  state: WatchState | null;
  queue: WatchQueueItem[];
  currentUserId: string;
  control: (action: WatchControlAction, opts?: WatchControlOpts) => Promise<void>;
  resolveUrl: (url: string) => Promise<WatchVideo>;
  search: (query: string) => Promise<WatchVideo[]>;
  messages: WatchChatMessage[];
  onSend: (text: string) => Promise<void> | void;
};

/* -------------------------------------------------------------------------- */
/* Minimal YouTube IFrame API typings                                          */
/* -------------------------------------------------------------------------- */

type YTPlayer = {
  loadVideoById: (opts: { videoId: string; startSeconds?: number }) => void;
  cueVideoById: (opts: { videoId: string; startSeconds?: number }) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
  mute: () => void;
  unMute: () => void;
  isMuted: () => boolean;
  setVolume: (volume: number) => void;
  getVolume: () => number;
  destroy: () => void;
};

type YTPlayerEvent = { target: YTPlayer; data: number };

type YTNamespace = {
  Player: new (
    el: HTMLElement,
    opts: {
      videoId?: string;
      width?: string | number;
      height?: string | number;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (e: YTPlayerEvent) => void;
        onStateChange?: (e: YTPlayerEvent) => void;
      };
    },
  ) => YTPlayer;
  PlayerState: {
    UNSTARTED: number;
    ENDED: number;
    PLAYING: number;
    PAUSED: number;
    BUFFERING: number;
    CUED: number;
  };
};

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

// Position tolerance before we re-seek to the shared clock (ms).
const DRIFT_MS = 1800;
// How long after a programmatic player change we ignore player events (ms).
const APPLY_GUARD_MS = 1200;

function expectedPosMs(s: WatchState) {
  if (!s.isPlaying) return s.positionMs;
  const elapsed = Date.now() - new Date(s.changedAt).getTime();
  const cap = s.durationMs > 0 ? s.durationMs : Number.MAX_SAFE_INTEGER;
  return Math.min(cap, s.positionMs + Math.max(0, elapsed));
}

/** Best-effort: force landscape while a fullscreen video is playing. Supported
 *  on Android Chrome; a silent no-op on iOS Safari (which lacks the API). */
function lockLandscape() {
  try {
    const orientation = window.screen?.orientation as unknown as {
      lock?: (o: string) => Promise<void>;
    } | undefined;
    void orientation?.lock?.("landscape").catch(() => {});
  } catch {
    /* unsupported */
  }
}

function unlockOrientation() {
  try {
    const orientation = window.screen?.orientation as unknown as {
      unlock?: () => void;
    } | undefined;
    orientation?.unlock?.();
  } catch {
    /* unsupported */
  }
}

function fmt(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = (total % 60).toString().padStart(2, "0");
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${s}`
    : `${m}:${s}`;
}

/** Load the YouTube IFrame API script once; resolve when window.YT is ready. */
function useYouTubeApi() {
  const [ready, setReady] = useState(
    typeof window !== "undefined" && Boolean(window.YT?.Player),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Already loaded — the useState initializer will have set ready=true.
    if (window.YT?.Player) return;
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      setReady(true);
    };
    if (!document.getElementById("yt-iframe-api")) {
      const script = document.createElement("script");
      script.id = "yt-iframe-api";
      script.src = "https://www.youtube.com/iframe_api";
      document.body.appendChild(script);
    }
    // Fallback poll in case the global callback already fired.
    const poll = window.setInterval(() => {
      if (window.YT?.Player) {
        setReady(true);
        window.clearInterval(poll);
      }
    }, 300);
    return () => window.clearInterval(poll);
  }, []);

  return ready;
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export function WatchParty({
  open,
  onClose,
  state,
  queue,
  currentUserId,
  control,
  resolveUrl,
  search,
  messages,
  onSend,
}: WatchPartyProps) {
  const apiReady = useYouTubeApi();

  const mountRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const [playerReady, setPlayerReady] = useState(false);

  // Refs the async player callbacks read (avoid stale closures).
  const stateRef = useRef<WatchState | null>(state);
  useEffect(() => {
    stateRef.current = state;
  });
  const applyingRemoteRef = useRef(false);
  const localVideoIdRef = useRef<string | null>(null);
  const lastAdvanceRef = useRef<string | null>(null);
  const reportedDurationForRef = useRef<string | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [needsTap, setNeedsTap] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [chatVisible, setChatVisible] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Volume is per-viewer (local to this player), never synced to the other side.
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);

  // Track real (browser) fullscreen so the button reflects the current mode,
  // and drop any forced landscape orientation when leaving fullscreen.
  useEffect(() => {
    if (!open) return;
    const onChange = () => {
      const fs = Boolean(document.fullscreenElement);
      setIsFullscreen(fs);
      if (!fs) unlockOrientation();
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [open]);

  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
    } else {
      // Unsupported on iOS Safari for non-video elements — the CSS overlay is
      // already full-bleed there, so a no-op is fine. On Android, once we're
      // in fullscreen, force landscape (best-effort) so video fills the screen.
      const req = el.requestFullscreen?.();
      if (req) req.then(lockLandscape).catch(() => {});
      else lockLandscape();
    }
  }, []);

  const releaseGuardSoon = useCallback(() => {
    window.setTimeout(() => {
      applyingRemoteRef.current = false;
    }, APPLY_GUARD_MS);
  }, []);

  /* ---- core reconciliation: make the local player match the shared clock -- */
  const reconcile = useCallback(
    (hard: boolean) => {
      const player = playerRef.current;
      const s = stateRef.current;
      if (!player || !playerReady || !s?.videoId) return;

      applyingRemoteRef.current = true;
      try {
        const expectedS = expectedPosMs(s) / 1000;

        // Video changed → (re)load at the shared position.
        if (s.videoId !== localVideoIdRef.current) {
          localVideoIdRef.current = s.videoId;
          lastAdvanceRef.current = null;
          if (s.isPlaying) {
            player.loadVideoById({ videoId: s.videoId, startSeconds: expectedS });
          } else {
            player.cueVideoById({ videoId: s.videoId, startSeconds: expectedS });
          }
          releaseGuardSoon();
          return;
        }

        // Same video → correct drift + play/pause.
        const actualS = player.getCurrentTime?.() ?? 0;
        if (hard || Math.abs(actualS - expectedS) > DRIFT_MS / 1000) {
          player.seekTo(expectedS, true);
        }

        const YT = window.YT;
        const ytState = player.getPlayerState?.();
        if (YT) {
          if (s.isPlaying && ytState !== YT.PlayerState.PLAYING) {
            player.playVideo();
          } else if (!s.isPlaying && ytState === YT.PlayerState.PLAYING) {
            player.pauseVideo();
          }
        }
      } finally {
        releaseGuardSoon();
      }
    },
    [playerReady, releaseGuardSoon],
  );

  /* ---- create / destroy the player with the overlay ---------------------- */
  useEffect(() => {
    const mount = mountRef.current;
    if (!open || !apiReady || !mount || !window.YT) return;

    localVideoIdRef.current = null;

    // YT.Player REPLACES the element it's handed with an <iframe>. If we give it
    // our React-managed node, React later crashes removing a node that no longer
    // exists (dev StrictMode's mount→unmount→mount triggers this at once). So we
    // append a throwaway child for YT to replace and clean it up ourselves.
    const host = document.createElement("div");
    host.style.width = "100%";
    host.style.height = "100%";
    mount.appendChild(host);

    // Do NOT pass `videoId` here: YT throws "Invalid video id" when it's absent
    // (nothing playing yet). The reconcile effect loads the current video once
    // the player becomes ready.
    const player = new window.YT.Player(host, {
      width: "100%",
      height: "100%",
      playerVars: {
        controls: 0,
        disablekb: 1,
        modestbranding: 1,
        rel: 0,
        playsinline: 1,
        fs: 0,
        iv_load_policy: 3,
        origin: typeof window !== "undefined" ? window.location.origin : "",
      },
      events: {
        onReady: () => {
          // Flipping playerReady re-runs the reconcile effect, which loads the
          // current video (avoids calling reconcile here with a stale closure
          // where playerReady is still false).
          setPlayerReady(true);
          // If we expect to be playing but autoplay was blocked, prompt to tap.
          window.setTimeout(() => {
            const p = playerRef.current;
            const cur = stateRef.current;
            const YT = window.YT;
            if (!p || !cur?.isPlaying || !YT) return;
            if (p.getPlayerState?.() !== YT.PlayerState.PLAYING) {
              setNeedsTap(true);
            }
          }, 1800);
        },
        onStateChange: (e) => {
          const YT = window.YT;
          if (!YT) return;

          // Video ended → ask the server to advance (server dedupes by
          // changedAt, so both clients firing is harmless).
          if (e.data === YT.PlayerState.ENDED) {
            const s = stateRef.current;
            if (s && lastAdvanceRef.current !== s.changedAt) {
              lastAdvanceRef.current = s.changedAt;
              void control("advance", { expectedChangedAt: s.changedAt });
            }
            return;
          }

          // Backfill the true duration once (paste-link resolves have none).
          if (e.data === YT.PlayerState.PLAYING) {
            const s = stateRef.current;
            const dur = Math.round((e.target.getDuration?.() ?? 0) * 1000);
            if (
              s?.videoId &&
              s.durationMs <= 0 &&
              dur > 0 &&
              reportedDurationForRef.current !== s.videoId
            ) {
              reportedDurationForRef.current = s.videoId;
              void control("setduration", { durationMs: dur });
            }
            if (needsTap) setNeedsTap(false);
          }
        },
      },
    });
    playerRef.current = player;

    return () => {
      try {
        player.destroy();
      } catch {
        /* ignore */
      }
      // Remove whatever YT left behind (the iframe) — mount is React's node and
      // only ever held our manually-appended children, so clearing it is safe.
      try {
        mount.replaceChildren();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
      setPlayerReady(false);
      setNeedsTap(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, apiReady]);

  /* ---- reconcile whenever the shared state changes ----------------------- */
  useEffect(() => {
    if (!open) return;
    reconcile(true);
  }, [
    open,
    state?.videoId,
    state?.changedAt,
    state?.isPlaying,
    playerReady,
    reconcile,
  ]);

  /* ---- periodic soft drift correction ------------------------------------ */
  useEffect(() => {
    if (!open || !playerReady) return;
    const id = window.setInterval(() => {
      if (applyingRemoteRef.current) return;
      if (stateRef.current?.isPlaying) reconcile(false);
    }, 2500);
    return () => window.clearInterval(id);
  }, [open, playerReady, reconcile]);

  /* ---- adopt the player's real volume/mute once it's ready --------------- */
  useEffect(() => {
    const p = playerRef.current;
    if (!open || !playerReady || !p) return;
    try {
      setVolume(Math.round(p.getVolume()));
      setMuted(p.isMuted());
    } catch {
      /* ignore */
    }
  }, [open, playerReady]);

  /* ---- live progress bar (drives off the shared clock) ------------------- */
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [dragValue, setDragValue] = useState<number | null>(null);
  const draggingRef = useRef(false);
  useEffect(() => {
    if (!open || !state?.isPlaying) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [open, state?.isPlaying, state?.changedAt]);

  /* ---- auto-hide the chrome after idle ----------------------------------- */
  const hideTimerRef = useRef<number | null>(null);
  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false);
      setAddOpen(false);
    }, 3200);
  }, []);
  const showControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHide();
  }, [scheduleHide]);
  useEffect(() => {
    if (!open) return;
    scheduleHide();
    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, [open, scheduleHide]);

  if (!open) return null;

  const hasVideo = Boolean(state?.videoId);
  const durationMs = state?.durationMs ?? 0;
  const livePos = state ? expectedPosMs(state) : 0;
  void nowTick; // livePos recomputes each tick via nowTick dependency
  const shown = dragValue ?? livePos;
  const pct = durationMs > 0 ? Math.min(100, (shown / durationMs) * 100) : 0;

  const togglePlay = () => {
    if (!state?.isPlaying) setNeedsTap(false);
    void control(state?.isPlaying ? "pause" : "play");
  };

  const commitSeek = (value: number) => {
    draggingRef.current = false;
    setDragValue(null);
    void control("seek", { positionMs: Math.max(0, Math.round(value)) });
  };

  const handleTapStart = () => {
    setNeedsTap(false);
    const p = playerRef.current;
    const s = stateRef.current;
    if (!p || !s) return;
    applyingRemoteRef.current = true;
    try {
      p.unMute();
      setMuted(false);
      p.seekTo(expectedPosMs(s) / 1000, true);
      p.playVideo();
    } finally {
      releaseGuardSoon();
    }
  };

  const changeVolume = (value: number) => {
    const v = Math.max(0, Math.min(100, Math.round(value)));
    setVolume(v);
    const p = playerRef.current;
    if (!p) return;
    p.setVolume(v);
    if (v === 0) {
      p.mute();
      setMuted(true);
    } else if (muted) {
      p.unMute();
      setMuted(false);
    }
  };

  const toggleMute = () => {
    const p = playerRef.current;
    if (!p) return;
    if (muted) {
      p.unMute();
      setMuted(false);
      if (volume === 0) changeVolume(50);
    } else {
      p.mute();
      setMuted(true);
    }
  };

  const recentMessages = messages
    .filter((m) => (m.body ?? "").trim().length > 0 || m.message_type !== "text")
    .slice(-40);

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-[100] bg-black select-none"
      onMouseMove={showControls}
      onClick={showControls}
    >
      {/* ---- video layer ---- */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="relative h-full w-full">
          <div
            ref={mountRef}
            className="pointer-events-none h-full w-full [&>iframe]:h-full [&>iframe]:w-full"
          />
          {/* click-catcher: block the bare iframe; a tap just reveals the
              chrome (play/pause stays on the explicit button so a stray tap
              can't pause the video for BOTH viewers). */}
          <button
            type="button"
            aria-label="Show controls"
            onClick={(e) => {
              e.stopPropagation();
              showControls();
            }}
            className="absolute inset-0 h-full w-full cursor-default bg-transparent"
          />
        </div>
      </div>

      {/* ---- empty state: nothing playing ---- */}
      {!hasVideo && (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <AddVideoPanel
            centered
            control={control}
            resolveUrl={resolveUrl}
            search={search}
          />
        </div>
      )}

      {/* ---- tap-to-start (autoplay blocked on this device) ---- */}
      {needsTap && hasVideo && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleTapStart();
          }}
          className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/60 text-white"
        >
          <span className="flex h-20 w-20 items-center justify-center rounded-full bg-white/15 text-4xl">
            ▶
          </span>
          <span className="text-sm font-semibold">Tap to start watching together</span>
        </button>
      )}

      {/* ---- top gradient + title + close ---- */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-black/70 to-transparent p-4 transition-opacity duration-300 ${
          controlsVisible ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="pointer-events-auto flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-white drop-shadow md:text-base">
              {state?.title ?? "Watch party"}
            </p>
            {state?.channelTitle && (
              <p className="truncate text-xs text-white/70 drop-shadow">
                {state.channelTitle}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setChatVisible((v) => !v);
                showControls();
              }}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-base text-white hover:bg-white/25"
              title={chatVisible ? "Hide chat" : "Show chat"}
              aria-label="Toggle chat"
            >
              💬
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setAddOpen((v) => !v);
                showControls();
              }}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-lg text-white hover:bg-white/25"
              title="Add a video"
              aria-label="Add a video"
            >
              ＋
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleFullscreen();
                showControls();
              }}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-base text-white hover:bg-white/25"
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              aria-label="Toggle fullscreen"
            >
              {isFullscreen ? "⤡" : "⛶"}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-lg text-white hover:bg-white/25"
              title="Exit watch party"
              aria-label="Exit watch party"
            >
              ×
            </button>
          </div>
        </div>
      </div>

      {/* ---- add-video drawer (left, so it doesn't cover the right chat) ---- */}
      {addOpen && hasVideo && (
        <div
          className="absolute left-3 top-16 z-30 w-[min(92vw,26rem)]"
          onClick={(e) => e.stopPropagation()}
        >
          <AddVideoPanel
            control={control}
            resolveUrl={resolveUrl}
            search={search}
            queue={queue}
            onRemove={(id) => void control("remove", { queueId: id })}
          />
        </div>
      )}

      {/* ---- transparent live chat overlay (right side, above the controls) ---- */}
      {chatVisible && hasVideo && (
        <div
          className="absolute right-3 top-16 bottom-28 z-20 flex w-[min(85vw,20rem)] flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <ChatOverlay
            messages={recentMessages}
            currentUserId={currentUserId}
            onSend={onSend}
          />
        </div>
      )}

      {/* ---- bottom controls ---- */}
      {hasVideo && (
        <div
          className={`absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/80 to-transparent px-4 pb-4 pt-10 transition-opacity duration-300 ${
            controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* progress */}
          <input
            type="range"
            className="jukebox-range w-full"
            min={0}
            max={Math.max(1, durationMs)}
            step={1000}
            value={Math.round(shown)}
            disabled={durationMs <= 0}
            style={{
              background: `linear-gradient(to right, #ef4444 ${pct}%, rgba(255,255,255,0.25) ${pct}%)`,
            }}
            onPointerDown={() => {
              draggingRef.current = true;
            }}
            onChange={(e) => {
              if (draggingRef.current) setDragValue(Number(e.target.value));
            }}
            onPointerUp={(e) =>
              commitSeek(Number((e.target as HTMLInputElement).value))
            }
            aria-label="Seek"
          />
          <div className="mt-1 flex items-center justify-between text-[11px] tabular-nums text-white/80">
            <span>{fmt(shown)}</span>
            <span>{durationMs > 0 ? fmt(durationMs) : "live"}</span>
          </div>

          {/* transport + per-viewer volume */}
          <div className="mt-2 flex items-center gap-3 text-white">
            {/* volume (local to this viewer) */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={toggleMute}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-white/12 text-lg hover:bg-white/25"
                aria-label={muted ? "Unmute" : "Mute"}
                title={muted ? "Unmute" : "Mute"}
              >
                {muted || volume === 0 ? "🔇" : volume < 50 ? "🔉" : "🔊"}
              </button>
              <input
                type="range"
                className="jukebox-range w-16 sm:w-24"
                min={0}
                max={100}
                step={1}
                value={muted ? 0 : volume}
                style={{
                  background: `linear-gradient(to right, #fff ${
                    muted ? 0 : volume
                  }%, rgba(255,255,255,0.25) ${muted ? 0 : volume}%)`,
                }}
                onChange={(e) => changeVolume(Number(e.target.value))}
                aria-label="Volume"
              />
            </div>

            <div className="flex flex-1 items-center justify-center gap-5">
              <button
                type="button"
                onClick={() => void control("previous")}
                className="flex h-11 w-11 items-center justify-center rounded-full bg-white/12 text-lg hover:bg-white/25"
                aria-label="Previous"
                title="Previous"
              >
                ⏮
              </button>
              <button
                type="button"
                onClick={togglePlay}
                className="flex h-16 w-16 items-center justify-center rounded-full bg-red-600 text-2xl font-black text-white shadow-lg shadow-red-600/30 hover:bg-red-500"
                aria-label={state?.isPlaying ? "Pause" : "Play"}
              >
                {state?.isPlaying ? "❚❚" : "▶"}
              </button>
              <button
                type="button"
                disabled={queue.length === 0}
                onClick={() => void control("next")}
                className="flex h-11 w-11 items-center justify-center rounded-full bg-white/12 text-lg hover:bg-white/25 disabled:opacity-40"
                aria-label="Next"
                title={queue.length ? "Next" : "Nothing queued"}
              >
                ⏭
              </button>
            </div>

            {/* right spacer to keep transport visually centered on wider screens */}
            <div className="hidden w-[104px] sm:block" />
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Add-video panel (paste link + search + queue)                               */
/* -------------------------------------------------------------------------- */

function AddVideoPanel({
  centered = false,
  control,
  resolveUrl,
  search,
  queue,
  onRemove,
}: {
  centered?: boolean;
  control: WatchPartyProps["control"];
  resolveUrl: WatchPartyProps["resolveUrl"];
  search: WatchPartyProps["search"];
  queue?: WatchQueueItem[];
  onRemove?: (id: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WatchVideo[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const playFromUrl = async (mode: "select" | "enqueue") => {
    const value = url.trim();
    if (!value) return;
    setBusy(true);
    setStatus("");
    try {
      const video = await resolveUrl(value);
      await control(mode, { video });
      setUrl("");
      setStatus(mode === "select" ? "Now playing." : "Added to queue.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Couldn't add that link.");
    } finally {
      setBusy(false);
    }
  };

  const runSearch = async (e?: FormEvent) => {
    e?.preventDefault();
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setStatus("");
    try {
      const found = await search(q);
      setResults(found);
      if (found.length === 0) setStatus("No results.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setBusy(false);
    }
  };

  const pick = async (video: WatchVideo, mode: "select" | "enqueue") => {
    setBusy(true);
    try {
      await control(mode, { video });
      setStatus(mode === "select" ? "Now playing." : "Added to queue.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`w-full rounded-2xl border border-white/10 bg-neutral-900/85 p-3 text-white shadow-2xl ${
        centered ? "max-w-md" : ""
      }`}
    >
      {centered && (
        <p className="mb-2 text-center text-sm font-bold">
          Start a watch party 🎬
        </p>
      )}

      {/* paste a link */}
      <div className="flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void playFromUrl("select");
          }}
          placeholder="Paste a YouTube link…"
          className="min-w-0 flex-1 rounded-xl bg-white/10 px-3 py-2 text-sm outline-none placeholder:text-white/40"
        />
        <button
          type="button"
          disabled={busy || !url.trim()}
          onClick={() => void playFromUrl("select")}
          className="shrink-0 rounded-xl bg-red-600 px-3 py-2 text-sm font-semibold disabled:opacity-40"
        >
          Play
        </button>
        <button
          type="button"
          disabled={busy || !url.trim()}
          onClick={() => void playFromUrl("enqueue")}
          className="shrink-0 rounded-xl bg-white/10 px-3 py-2 text-sm font-semibold disabled:opacity-40"
          title="Add to queue"
        >
          ＋
        </button>
      </div>

      {/* search */}
      <form onSubmit={runSearch} className="mt-2 flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="…or search YouTube"
          className="min-w-0 flex-1 rounded-xl bg-white/10 px-3 py-2 text-sm outline-none placeholder:text-white/40"
        />
        <button
          type="submit"
          disabled={busy || !query.trim()}
          className="shrink-0 rounded-xl bg-white/10 px-3 py-2 text-sm font-semibold disabled:opacity-40"
        >
          Search
        </button>
      </form>

      {status && <p className="mt-2 text-xs text-white/60">{status}</p>}

      {/* results */}
      {results.length > 0 && (
        <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
          {results.map((v) => (
            <div
              key={v.videoId}
              className="flex items-center gap-2 rounded-xl p-1 hover:bg-white/5"
            >
              {v.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={v.thumbnailUrl}
                  alt=""
                  className="h-10 w-16 shrink-0 rounded-md object-cover"
                />
              ) : (
                <div className="h-10 w-16 shrink-0 rounded-md bg-white/10" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold">{v.title}</p>
                <p className="truncate text-[11px] text-white/50">
                  {v.channelTitle}
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void pick(v, "select")}
                className="shrink-0 rounded-lg bg-red-600 px-2 py-1 text-[11px] font-semibold disabled:opacity-40"
              >
                Play
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void pick(v, "enqueue")}
                className="shrink-0 rounded-lg bg-white/10 px-2 py-1 text-[11px] font-semibold disabled:opacity-40"
              >
                ＋
              </button>
            </div>
          ))}
        </div>
      )}

      {/* current queue */}
      {queue && queue.length > 0 && (
        <div className="mt-3 border-t border-white/10 pt-2">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/40">
            Up next
          </p>
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {queue.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-2 rounded-lg p-1 text-xs"
              >
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                {onRemove && (
                  <button
                    type="button"
                    onClick={() => onRemove(item.id)}
                    className="shrink-0 rounded-md bg-white/10 px-2 py-0.5 text-[11px]"
                    aria-label="Remove"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Transparent chat overlay                                                    */
/* -------------------------------------------------------------------------- */

function ChatOverlay({
  messages,
  currentUserId,
  onSend,
}: {
  messages: WatchChatMessage[];
  currentUserId: string;
  onSend: (text: string) => Promise<void> | void;
}) {
  const [text, setText] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setText("");
    await onSend(body);
  };

  // Live-stream style: newest hugs the bottom, older ones drift up and fade
  // out over the last handful. Only the most recent few are shown at all.
  const shown = messages.slice(-6);

  return (
    <div className="flex h-full min-h-0 flex-col justify-end gap-2">
      {/* Fade older messages via per-item opacity (NOT mask-image: a CSS mask
          over the playing video forces an offscreen recomposite every frame,
          which tanks iOS Safari to a few fps). */}
      <div className="flex flex-col justify-end gap-1 overflow-hidden">
        {shown.map((m, i) => {
          const mine = m.sender_id === currentUserId;
          const name = m.is_bot
            ? "🤖 swiggy"
            : mine
              ? "You"
              : m.sender_name ?? "Them";
          const label = (m.body ?? "").trim() || `[${m.message_type}]`;
          // Newest (bottom) fully opaque; older ones drift toward transparent.
          const opacity = Math.min(1, 0.3 + ((i + 1) / shown.length) * 0.9);
          return (
            <div key={m.id} className="flex" style={{ opacity }}>
              <span className="inline-block rounded-lg bg-black/60 px-2 py-1 text-[13px] leading-snug text-white shadow-sm">
                <span
                  className={`font-bold ${mine ? "text-red-300" : "text-sky-300"}`}
                >
                  {name}
                </span>
                : {label}
              </span>
            </div>
          );
        })}
        {shown.length === 0 && (
          <div className="flex">
            <p className="rounded-lg bg-black/45 px-2 py-1 text-[13px] text-white/70">
              Chat while you watch…
            </p>
          </div>
        )}
      </div>

      <form onSubmit={submit} className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Say something…"
          className="min-w-0 flex-1 rounded-full border border-white/15 bg-black/60 px-3 py-2 text-sm text-white outline-none placeholder:text-white/50"
        />
        <button
          type="submit"
          disabled={!text.trim()}
          className="shrink-0 rounded-full bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}

export default WatchParty;
