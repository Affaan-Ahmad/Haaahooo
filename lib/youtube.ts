/**
 * YouTube Data API helpers (server-side).
 *
 * Search needs YOUTUBE_API_KEY (search.list = 100 quota units/call).
 * Resolving a pasted link uses videos.list (1 unit) when a key is present, and
 * falls back to the free, keyless oEmbed endpoint otherwise (no duration — the
 * client fills that from the player once the video loads).
 */

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export type YoutubeVideo = {
  videoId: string;
  title: string;
  channelTitle: string | null;
  thumbnailUrl: string | null;
  durationMs: number;
};

export function getYoutubeApiKey() {
  return process.env.YOUTUBE_API_KEY ?? null;
}

/** Extract an 11-char video id from any common YouTube URL form (or a bare id). */
export function parseVideoId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (VIDEO_ID_RE.test(raw)) return raw;

  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const isYt =
    host === "youtube.com" ||
    host === "m.youtube.com" ||
    host === "music.youtube.com" ||
    host === "youtube-nocookie.com" ||
    host === "youtu.be";
  if (!isYt) return null;

  // youtu.be/<id>
  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    return id && VIDEO_ID_RE.test(id) ? id : null;
  }

  // youtube.com/watch?v=<id>
  const v = url.searchParams.get("v");
  if (v && VIDEO_ID_RE.test(v)) return v;

  // /shorts/<id>, /embed/<id>, /live/<id>, /v/<id>
  const segments = url.pathname.split("/").filter(Boolean);
  const marker = segments.findIndex((s) =>
    ["shorts", "embed", "live", "v"].includes(s),
  );
  if (marker !== -1 && segments[marker + 1]) {
    const id = segments[marker + 1];
    if (VIDEO_ID_RE.test(id)) return id;
  }
  return null;
}

/** ISO-8601 duration (e.g. "PT3M4S") -> milliseconds. */
export function iso8601ToMs(iso: string | undefined | null): number {
  if (!iso) return 0;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return 0;
  const [, h, min, s] = m;
  return (
    (Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0)) * 1000
  );
}

function pickThumb(thumbs: Record<string, { url?: string }> | undefined) {
  const t =
    thumbs?.medium ?? thumbs?.high ?? thumbs?.standard ?? thumbs?.default;
  const url = t?.url ?? null;
  return url && url.startsWith("https://i.ytimg.com/") ? url : null;
}

type VideosListResponse = {
  items?: Array<{
    id?: string;
    snippet?: {
      title?: string;
      channelTitle?: string;
      thumbnails?: Record<string, { url?: string }>;
    };
    contentDetails?: { duration?: string };
  }>;
  error?: { message?: string };
};

/** Fetch full metadata (incl. duration) for a video id via the Data API. */
export async function fetchVideoMeta(
  videoId: string,
  apiKey: string,
): Promise<YoutubeVideo | null> {
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.search = new URLSearchParams({
    part: "snippet,contentDetails",
    id: videoId,
    key: apiKey,
  }).toString();

  const res = await fetch(url, { cache: "no-store" });
  const json = (await res.json().catch(() => null)) as VideosListResponse | null;
  const item = json?.items?.[0];
  if (!res.ok || !item?.id || !item.snippet?.title) return null;

  return {
    videoId: item.id,
    title: item.snippet.title,
    channelTitle: item.snippet.channelTitle ?? null,
    thumbnailUrl: pickThumb(item.snippet.thumbnails),
    durationMs: iso8601ToMs(item.contentDetails?.duration),
  };
}

type OEmbedResponse = {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
};

/** Keyless fallback: title + channel + thumbnail (no duration). */
export async function fetchVideoOEmbed(
  videoId: string,
): Promise<YoutubeVideo | null> {
  const url = new URL("https://www.youtube.com/oembed");
  url.search = new URLSearchParams({
    url: `https://www.youtube.com/watch?v=${videoId}`,
    format: "json",
  }).toString();

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as OEmbedResponse | null;
  if (!json?.title) return null;

  // oEmbed thumbnails are on i.ytimg.com; prefer a stable hqdefault URL.
  return {
    videoId,
    title: json.title,
    channelTitle: json.author_name ?? null,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    durationMs: 0,
  };
}

type SearchListResponse = {
  items?: Array<{
    id?: { videoId?: string };
    snippet?: {
      title?: string;
      channelTitle?: string;
      thumbnails?: Record<string, { url?: string }>;
    };
  }>;
  error?: { message?: string };
};

/** Search videos. Returns metadata WITHOUT duration (search.list omits it);
 *  the client fills duration from the player when the video starts. */
export async function searchVideos(
  query: string,
  apiKey: string,
  max = 8,
): Promise<{ ok: boolean; status: number; videos: YoutubeVideo[]; error?: string }> {
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.search = new URLSearchParams({
    part: "snippet",
    type: "video",
    maxResults: String(max),
    q: query,
    key: apiKey,
  }).toString();

  const res = await fetch(url, { cache: "no-store" });
  const json = (await res.json().catch(() => null)) as SearchListResponse | null;
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      videos: [],
      error: json?.error?.message ?? "YouTube search failed.",
    };
  }

  const videos = (json?.items ?? [])
    .map((item) => {
      const videoId = item.id?.videoId;
      const title = item.snippet?.title;
      if (!videoId || !VIDEO_ID_RE.test(videoId) || !title) return null;
      return {
        videoId,
        title,
        channelTitle: item.snippet?.channelTitle ?? null,
        thumbnailUrl: pickThumb(item.snippet?.thumbnails),
        durationMs: 0,
      } satisfies YoutubeVideo;
    })
    .filter((v): v is YoutubeVideo => v !== null);

  return { ok: true, status: 200, videos };
}
