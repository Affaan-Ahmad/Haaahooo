"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import {
  setupPushNotifications,
  sendPushNotification,
} from "@/lib/clientNotifications";
import { useVoiceCall } from "@/lib/useVoiceCall";

type MessageType = "text" | "image" | "video" | "audio";
type ThemeMode = "auto" | "light" | "dark";
type EffectiveTheme = "light" | "dark";
type SidebarView = "chats" | "friends";

type Profile = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
};

type Chat = {
  conversation_id: string;
  friend_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  last_message: string | null;
  last_message_at: string | null;
};

type FriendRequest = {
  request_id: string;
  sender_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  created_at: string;
};

type SearchResult = Profile & {
  relationship: "none" | "friends" | "sent" | "received";
};

type SpotifyConnection = {
  connected: boolean;
  displayName: string | null;
  product: string | null;
};

type SpotifyTrack = {
  id: string;
  uri: string;
  name: string;
  artists: string;
  album: string;
  imageUrl: string | null;
  durationMs: number;
  spotifyUrl: string | null;
};

type JukeboxState = {
  conversationId: string;
  trackId: string | null;
  trackUri: string | null;
  trackName: string | null;
  artistName: string | null;
  imageUrl: string | null;
  spotifyUrl: string | null;
  durationMs: number;
  positionMs: number;
  isPlaying: boolean;
  changedAt: string;
  changedBy: string;
};

type Message = {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  sender_name: string | null;
  is_bot: boolean;
  body: string | null;
  created_at: string;
  message_type: MessageType;
  file_path: string | null;
  file_name: string | null;
  file_mime: string | null;
  reply_to_message_id: string | null;
  file_url?: string | null;
};

type MessageReaction = {
  message_id: string;
  user_id: string;
  emoji: string;
};

type ConversationReadReceipt = {
  user_id: string;
  last_read_at: string;
};

type MessageActionMenu = {
  message: Message;
  x: number;
  y: number;
};

const THEME_STORAGE_KEY = "private-chat-theme-mode";
const MEDIA_BUCKET = "chat-media";
const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;
const CHAT_EMOJIS = [
  "😀", "😂", "🥰", "😍", "😊", "😉", "🥹", "😭",
  "😅", "😎", "🤔", "🙄", "😴", "😡", "❤️", "💕",
  "✨", "🔥", "👍", "👏", "🙏", "🎉", "☕", "🐮",
];
const QUICK_REACTIONS = ["❤️", "😂", "😮", "😢", "👍", "🙏"];

const STARS = Array.from({ length: 75 }, (_, index) => ({
  left: (index * 37) % 100,
  top: ((index * 53) % 78) + 3,
  size: (index % 3) + 1,
  opacity: 0.35 + (index % 5) * 0.12,
  delay: (index % 10) * 0.25,
  speed: 2 + (index % 4),
}));

const CLOUDS = [
  { left: 4, top: 12, scale: 1.1, duration: 28 },
  { left: 24, top: 22, scale: 0.8, duration: 35 },
  { left: 62, top: 14, scale: 1.25, duration: 40 },
  { left: 78, top: 32, scale: 0.9, duration: 32 },
];

function getTimeBasedTheme(): EffectiveTheme {
  const hour = new Date().getHours();
  return hour >= 6 && hour < 18 ? "light" : "dark";
}

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getMessageTypeFromFile(file: File): MessageType | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return null;
}

function getInitials(value: string) {
  return value
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "?";
}

function getMessagePreview(message: Message) {
  if (message.body) return message.body;
  if (message.message_type === "image") return "Photo";
  if (message.message_type === "video") return "Video";
  if (message.message_type === "audio") return "Voice note";
  return "Message";
}

function formatLastSeen(lastSeenAt: string | null, now: number) {
  if (!lastSeenAt) return "Offline";

  const lastSeenDate = new Date(lastSeenAt);
  const elapsed = now - lastSeenDate.getTime();
  if (elapsed <= 45_000) return "Online";

  const today = new Date(now);
  const sameDay = lastSeenDate.toDateString() === today.toDateString();
  if (sameDay) {
    return `Last seen today at ${lastSeenDate.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  }

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (lastSeenDate.toDateString() === yesterday.toDateString()) {
    return `Last seen yesterday at ${lastSeenDate.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  }

  return `Last seen ${lastSeenDate.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  })}`;
}

function formatCallDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const remainingSeconds = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainingSeconds}`;
}

function Avatar({
  name,
  isDark,
  size = "md",
}: {
  name: string;
  isDark: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const sizeClass =
    size === "sm" ? "h-9 w-9 text-xs" : size === "lg" ? "h-12 w-12" : "h-10 w-10 text-sm";

  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full font-black ${sizeClass} ${
        isDark
          ? "bg-violet-400 text-slate-950"
          : "bg-sky-500 text-white"
      }`}
    >
      {getInitials(name)}
    </div>
  );
}

function ThemeButton({
  label,
  value,
  selected,
  onClick,
  isDark,
}: {
  label: string;
  value: ThemeMode;
  selected: ThemeMode;
  onClick: (value: ThemeMode) => void;
  isDark: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(value)}
      className={`rounded-full px-3 py-2 text-sm font-semibold transition ${
        selected === value
          ? isDark
            ? "bg-white text-slate-950"
            : "bg-slate-950 text-white"
          : isDark
            ? "bg-white/10 hover:bg-white/20"
            : "bg-slate-100 hover:bg-slate-200"
      }`}
    >
      {label}
    </button>
  );
}

function MessageContent({ message }: { message: Message }) {
  if (message.message_type === "text") {
    return <p className="break-words leading-relaxed">{message.body}</p>;
  }

  if (!message.file_url) {
    return <p className="text-sm opacity-70">Loading media...</p>;
  }

  if (message.message_type === "image") {
    return (
      <img
        src={message.file_url}
        alt={message.file_name ?? "Shared image"}
        className="max-h-80 max-w-full rounded-2xl object-contain"
      />
    );
  }

  if (message.message_type === "video") {
    return (
      <video
        src={message.file_url}
        controls
        className="max-h-80 max-w-full rounded-2xl"
      />
    );
  }

  return <audio src={message.file_url} controls className="max-w-full" />;
}

function SkyBackground({ theme }: { theme: EffectiveTheme }) {
  const dark = theme === "dark";

  return (
    <div
      className={`pointer-events-none absolute inset-0 overflow-hidden transition-colors duration-700 ${
        dark
          ? "bg-gradient-to-br from-slate-950 via-indigo-950 to-black"
          : "bg-gradient-to-br from-sky-200 via-blue-100 to-amber-100"
      }`}
    >
      <style>
        {`
          @keyframes floatCloud {
            0%, 100% { transform: translateX(0); }
            50% { transform: translateX(22px); }
          }
          @keyframes twinkle {
            0%, 100% { transform: scale(1); opacity: 0.35; }
            50% { transform: scale(1.8); opacity: 1; }
          }
          @keyframes glowPulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.06); }
          }
        `}
      </style>

      {dark ? (
        <>
          <div className="absolute right-12 top-10 h-28 w-28 rounded-full bg-slate-100 shadow-[0_0_70px_rgba(226,232,240,0.65)]">
            <div className="absolute -right-4 -top-2 h-28 w-28 rounded-full bg-indigo-950" />
          </div>
          {STARS.map((star, index) => (
            <span
              key={index}
              className="absolute rounded-full bg-white"
              style={{
                left: `${star.left}%`,
                top: `${star.top}%`,
                width: star.size,
                height: star.size,
                opacity: star.opacity,
                animation: `twinkle ${star.speed}s ease-in-out infinite`,
                animationDelay: `${star.delay}s`,
              }}
            />
          ))}
        </>
      ) : (
        <>
          <div
            className="absolute right-10 top-10 h-28 w-28 rounded-full bg-yellow-300 shadow-[0_0_80px_rgba(253,224,71,0.9)]"
            style={{ animation: "glowPulse 5s ease-in-out infinite" }}
          />
          {CLOUDS.map((cloud, index) => (
            <div
              key={index}
              className="absolute"
              style={{
                left: `${cloud.left}%`,
                top: `${cloud.top}%`,
                animation: `floatCloud ${cloud.duration}s ease-in-out infinite`,
              }}
            >
              <div
                className="relative h-16 w-40"
                style={{ transform: `scale(${cloud.scale})` }}
              >
                <div className="absolute bottom-0 left-2 h-12 w-20 rounded-full bg-white/75 blur-[1px]" />
                <div className="absolute bottom-4 left-12 h-14 w-14 rounded-full bg-white/80 blur-[1px]" />
                <div className="absolute bottom-0 left-20 h-12 w-24 rounded-full bg-white/75 blur-[1px]" />
              </div>
            </div>
          ))}
        </>
      )}
      <div className={`absolute inset-0 ${dark ? "bg-black/10" : "bg-white/10"}`} />
    </div>
  );
}

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signupUsername, setSignupUsername] = useState("");
  const [signupDisplayName, setSignupDisplayName] = useState("");
  const [showSignup, setShowSignup] = useState(false);

  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileUsername, setProfileUsername] = useState("");
  const [profileDisplayName, setProfileDisplayName] = useState("");
  const [profileStatus, setProfileStatus] = useState("");
  const [chats, setChats] = useState<Chat[]>([]);
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [sidebarView, setSidebarView] = useState<SidebarView>("chats");
  const [mobileChatOpen, setMobileChatOpen] = useState(false);

  const [friendSearch, setFriendSearch] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messageRefreshKey, setMessageRefreshKey] = useState(0);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [messageReactions, setMessageReactions] = useState<
    Record<string, MessageReaction[]>
  >({});
  const [messageActionMenu, setMessageActionMenu] =
    useState<MessageActionMenu | null>(null);
  const [friendLastReadAt, setFriendLastReadAt] = useState<string | null>(null);
  const [friendLastSeenAt, setFriendLastSeenAt] = useState<string | null>(null);
  const [presenceClock, setPresenceClock] = useState(Date.now());
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [notificationsOn, setNotificationsOn] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [spotifyConnection, setSpotifyConnection] =
    useState<SpotifyConnection | null>(null);
  const [spotifyBusy, setSpotifyBusy] = useState(false);
  const [spotifyStatus, setSpotifyStatus] = useState("");
  const [jukeboxOpen, setJukeboxOpen] = useState(false);
  const [jukeboxState, setJukeboxState] = useState<JukeboxState | null>(null);
  const [jukeboxQuery, setJukeboxQuery] = useState("");
  const [jukeboxResults, setJukeboxResults] = useState<SpotifyTrack[]>([]);
  const [jukeboxSearching, setJukeboxSearching] = useState(false);
  const [jukeboxBusy, setJukeboxBusy] = useState(false);
  const [jukeboxStatus, setJukeboxStatus] = useState("");
  const [mediaOpen, setMediaOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  const [themeMode, setThemeMode] = useState<ThemeMode>("auto");
  const [timeTheme, setTimeTheme] = useState<EffectiveTheme>("light");

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const messageCacheRef = useRef<Map<string, Message[]>>(new Map());
  const deepLinkHistoryPreparedRef = useRef(false);
  const gestureRef = useRef<{
    message: Message;
    startX: number;
    startY: number;
    pointerId: number;
  } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioStreamRef = useRef<MediaStream | null>(null);

  const effectiveTheme: EffectiveTheme =
    themeMode === "auto" ? timeTheme : themeMode;
  const isDark = effectiveTheme === "dark";
  const panel = isDark
    ? "border-white/10 bg-slate-950/85 text-white"
    : "border-white/80 bg-white/85 text-slate-950";
  const muted = isDark ? "text-white/55" : "text-slate-500";
  const inputClass = isDark
    ? "border-white/10 bg-white/10 text-white placeholder:text-white/40 focus:border-violet-300"
    : "border-slate-200 bg-white text-slate-950 placeholder:text-slate-400 focus:border-sky-400";
  const friendPresenceText = formatLastSeen(friendLastSeenAt, presenceClock);
  const friendIsOnline = friendPresenceText === "Online";
  const latestOwnMessageId =
    [...messages]
      .reverse()
      .find(
        (message) =>
          !message.is_bot && message.sender_id === session?.user.id,
      )?.id ?? null;
  const voiceCall = useVoiceCall({
    userId: session?.user.id ?? null,
    chats,
  });

  useEffect(() => {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY) as ThemeMode | null;
    if (savedTheme === "auto" || savedTheme === "light" || savedTheme === "dark") {
      setThemeMode(savedTheme);
    }

    setTimeTheme(getTimeBasedTheme());
    const timer = window.setInterval(() => setTimeTheme(getTimeBasedTheme()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [themeMode]);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;

    async function touchPresence() {
      if (document.visibilityState !== "visible") return;
      await supabase.rpc("touch_my_presence");
      setPresenceClock(Date.now());
    }

    void touchPresence();
    const heartbeat = window.setInterval(() => void touchPresence(), 30_000);
    const clock = window.setInterval(
      () => setPresenceClock(Date.now()),
      15_000,
    );
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void touchPresence();
    };

    window.addEventListener("focus", touchPresence);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.clearInterval(heartbeat);
      window.clearInterval(clock);
      window.removeEventListener("focus", touchPresence);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [session]);

  useEffect(() => {
    if (!session) {
      setSpotifyConnection(null);
      return;
    }

    void loadSpotifyConnection();

    const spotifyResult = new URLSearchParams(window.location.search).get(
      "spotify",
    );
    if (!spotifyResult) return;

    setSettingsOpen(true);
    setSpotifyStatus(
      spotifyResult === "connected"
        ? "Spotify connected."
        : spotifyResult === "denied"
          ? "Spotify connection was cancelled."
          : "Spotify could not be connected. Check the Vercel logs.",
    );

    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("spotify");
    window.history.replaceState(
      window.history.state,
      "",
      `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`,
    );
  }, [session]);

  async function addSignedUrls(rows: Message[]) {
    return Promise.all(
      rows.map(async (message) => {
        if (!message.file_path) return message;
        const { data, error: signedUrlError } = await supabase.storage
          .from(MEDIA_BUCKET)
          .createSignedUrl(message.file_path, 60 * 60);
        return {
          ...message,
          file_url: signedUrlError ? null : data.signedUrl,
        };
      }),
    );
  }

  async function loadProfile() {
    if (!session) return;
    const { data, error: profileError } = await supabase
      .from("profiles")
      .select("id, username, display_name, avatar_url")
      .eq("id", session.user.id)
      .single();

    if (profileError) {
      setError(profileError.message);
      return;
    }

    const nextProfile = data as Profile;
    setProfile(nextProfile);
    setProfileUsername(nextProfile.username);
    setProfileDisplayName(nextProfile.display_name);
  }

  async function loadChats(preferredConversationId?: string) {
    if (!session) return;
    const { data, error: chatsError } = await supabase.rpc("get_my_chats");

    if (chatsError) {
      setError(chatsError.message);
      return;
    }

    const nextChats = (data ?? []) as Chat[];
    setChats(nextChats);
    const linkedConversationId =
      typeof window === "undefined"
        ? undefined
        : new URLSearchParams(window.location.search).get("conversation") ??
          undefined;

    if (
      linkedConversationId &&
      window.matchMedia("(max-width: 767px)").matches &&
      !window.history.state?.haaahoooChat &&
      !deepLinkHistoryPreparedRef.current
    ) {
      const chatUrl = new URL(window.location.href);
      const listUrl = new URL(window.location.href);
      listUrl.searchParams.delete("conversation");
      window.history.replaceState(
        { haaahoooList: true },
        "",
        `${listUrl.pathname}${listUrl.search}${listUrl.hash}`,
      );
      window.history.pushState(
        { haaahoooChat: linkedConversationId },
        "",
        `${chatUrl.pathname}${chatUrl.search}${chatUrl.hash}`,
      );
      deepLinkHistoryPreparedRef.current = true;
    }

    setSelectedChat((current) => {
      const targetId =
        preferredConversationId ??
        linkedConversationId ??
        current?.conversation_id;
      return (
        nextChats.find((chat) => chat.conversation_id === targetId) ??
        nextChats[0] ??
        null
      );
    });

    if (
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("conversation")
    ) {
      setMobileChatOpen(true);
    }
  }

  async function loadRequests() {
    if (!session) return;
    const { data, error: requestsError } = await supabase.rpc(
      "get_incoming_friend_requests",
    );
    if (requestsError) {
      setError(requestsError.message);
      return;
    }
    setRequests((data ?? []) as FriendRequest[]);
  }

  useEffect(() => {
    if (!session) {
      setProfile(null);
      setChats([]);
      setRequests([]);
      setSelectedChat(null);
      return;
    }

    void Promise.all([loadProfile(), loadChats(), loadRequests()]);

    const socialChannel = supabase
      .channel(`social-${session.user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "friend_requests" },
        () => void loadRequests(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "friendships" },
        () => void loadChats(),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(socialChannel);
    };
  }, [session]);

  useEffect(() => {
    if (!session || !selectedChat) {
      setMessages([]);
      setMessagesLoading(false);
      setReplyingTo(null);
      setMessageReactions({});
      return;
    }

    let active = true;
    const conversationId = selectedChat.conversation_id;
    const cachedMessages = messageCacheRef.current.get(conversationId);

    if (cachedMessages) {
      setMessages(cachedMessages);
    } else {
      setMessages([]);
      setMessagesLoading(true);
    }

    async function loadMessages() {
      if (!cachedMessages) setMessagesLoading(true);

      const { data, error: messagesError } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });

      if (messagesError) {
        if (active) {
          setError(`Could not load message history: ${messagesError.message}`);
          setMessagesLoading(false);
        }
        return;
      }

      const rows = await addSignedUrls((data ?? []) as Message[]);
      if (active) {
        messageCacheRef.current.set(conversationId, rows);
        setMessages(rows);
        setMessagesLoading(false);
        void loadMessageReactions(rows.map((message) => message.id));
      }
    }

    void loadMessages();

    const channel = supabase
      .channel(`conversation-${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        async (payload) => {
          const [messageWithUrl] = await addSignedUrls([payload.new as Message]);
          if (!active) return;
          setMessages((current) => {
            const nextMessages = current.some(
              (message) => message.id === messageWithUrl.id,
            )
              ? current
              : [...current, messageWithUrl];
            messageCacheRef.current.set(conversationId, nextMessages);
            return nextMessages;
          });
          const cachedIds =
            messageCacheRef.current
              .get(conversationId)
              ?.map((message) => message.id) ?? [];
          void loadMessageReactions([...cachedIds, messageWithUrl.id]);
          void loadChats(conversationId);
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void loadMessages();
      });

    function refreshAfterResume() {
      if (document.visibilityState === "visible") void loadMessages();
    }

    window.addEventListener("focus", refreshAfterResume);
    window.addEventListener("pageshow", refreshAfterResume);
    document.addEventListener("visibilitychange", refreshAfterResume);

    return () => {
      active = false;
      window.removeEventListener("focus", refreshAfterResume);
      window.removeEventListener("pageshow", refreshAfterResume);
      document.removeEventListener("visibilitychange", refreshAfterResume);
      void supabase.removeChannel(channel);
    };
  }, [session, selectedChat?.conversation_id, messageRefreshKey]);

  useEffect(() => {
    if (!session || !selectedChat) return;

    const reactionChannel = supabase
      .channel(`reactions-${selectedChat.conversation_id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "message_reactions",
        },
        () => void loadMessageReactions(messages.map((message) => message.id)),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(reactionChannel);
    };
  }, [session, selectedChat?.conversation_id, messages]);

  useEffect(() => {
    if (!session || !selectedChat) {
      setFriendLastReadAt(null);
      setFriendLastSeenAt(null);
      return;
    }

    const conversationId = selectedChat.conversation_id;
    const friendId = selectedChat.friend_id;
    void Promise.all([
      loadReadReceipts(conversationId, friendId),
      loadFriendPresence(friendId),
    ]);

    const presencePoll = window.setInterval(
      () => void loadFriendPresence(friendId),
      20_000,
    );
    const receiptChannel = supabase
      .channel(`read-receipts-${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "conversation_reads",
          filter: `conversation_id=eq.${conversationId}`,
        },
        () => void loadReadReceipts(conversationId, selectedChat.friend_id),
      )
      .subscribe();

    function refreshVisibleConversation() {
      if (document.visibilityState !== "visible") return;
      void loadFriendPresence(friendId);
      if (
        mobileChatOpen ||
        window.matchMedia("(min-width: 768px)").matches
      ) {
        void markConversationRead(conversationId);
      }
    }

    window.addEventListener("focus", refreshVisibleConversation);
    document.addEventListener(
      "visibilitychange",
      refreshVisibleConversation,
    );

    return () => {
      window.clearInterval(presencePoll);
      window.removeEventListener("focus", refreshVisibleConversation);
      document.removeEventListener(
        "visibilitychange",
        refreshVisibleConversation,
      );
      void supabase.removeChannel(receiptChannel);
    };
  }, [
    session,
    selectedChat?.conversation_id,
    selectedChat?.friend_id,
    mobileChatOpen,
  ]);

  useEffect(() => {
    if (!session || !selectedChat || messages.length === 0) return;

    const chatIsVisible =
      document.visibilityState === "visible" &&
      (mobileChatOpen || window.matchMedia("(min-width: 768px)").matches);
    if (!chatIsVisible) return;

    void markConversationRead(selectedChat.conversation_id);
  }, [
    session,
    selectedChat?.conversation_id,
    messages.length,
    mobileChatOpen,
  ]);

  useEffect(() => {
    if (!session || !selectedChat) {
      setJukeboxState(null);
      setJukeboxOpen(false);
      return;
    }

    const conversationId = selectedChat.conversation_id;
    void loadJukebox(conversationId);

    const channel = supabase
      .channel(`jukebox-${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "conversation_jukebox",
          filter: `conversation_id=eq.${conversationId}`,
        },
        () => void loadJukebox(conversationId),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session, selectedChat?.conversation_id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    function handlePhoneBack() {
      const conversationId = new URLSearchParams(window.location.search).get(
        "conversation",
      );

      if (!conversationId) {
        setMobileChatOpen(false);
        setMediaOpen(false);
        setEmojiOpen(false);
        setSettingsOpen(false);
        return;
      }

      const matchingChat = chats.find(
        (chat) => chat.conversation_id === conversationId,
      );
      if (!matchingChat) return;

      setSelectedChat(matchingChat);
      setMessages(
        messageCacheRef.current.get(matchingChat.conversation_id) ?? [],
      );
      setMessagesLoading(
        !messageCacheRef.current.has(matchingChat.conversation_id),
      );
      setMobileChatOpen(true);
    }

    window.addEventListener("popstate", handlePhoneBack);
    return () => window.removeEventListener("popstate", handlePhoneBack);
  }, [chats]);

  async function signUp() {
    setError("");
    const username = signupUsername.trim().toLowerCase();
    const displayName = signupDisplayName.trim();

    if (!email || !password || !username || !displayName) {
      setError("Complete all signup fields.");
      return;
    }

    if (!USERNAME_PATTERN.test(username)) {
      setError("Username must be 3-24 lowercase letters, numbers, or underscores.");
      return;
    }

    const { error: signupError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          username,
          display_name: displayName,
        },
      },
    });

    if (signupError) {
      setError(signupError.message);
      return;
    }

    alert("Account created. Check your email if confirmation is enabled, then log in.");
    setShowSignup(false);
  }

  async function signIn() {
    setError("");
    if (!email || !password) {
      setError("Please enter email and password.");
      return;
    }
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) setError(signInError.message);
  }

  async function signOut() {
    setSettingsOpen(false);
    await supabase.auth.signOut();
  }

  async function saveProfile() {
    if (!profile) return;
    setProfileStatus("");
    const username = profileUsername.trim().toLowerCase();
    const displayName = profileDisplayName.trim();

    if (!USERNAME_PATTERN.test(username)) {
      setProfileStatus(
        "Username must be 3-24 lowercase letters, numbers, or underscores.",
      );
      return;
    }

    if (!displayName) {
      setProfileStatus("Display name cannot be empty.");
      return;
    }

    const { data: updatedProfiles, error: updateError } = await supabase.rpc(
      "update_my_profile",
      {
        new_username: username,
        new_display_name: displayName,
      },
    );

    if (updateError) {
      setProfileStatus(updateError.message);
      return;
    }

    const nextProfile = (updatedProfiles as Profile[] | null)?.[0];

    if (!nextProfile) {
      setProfileStatus("Profile was not updated.");
      return;
    }

    setProfile(nextProfile);
    setProfileUsername(nextProfile.username);
    setProfileDisplayName(nextProfile.display_name);
    setProfileStatus("Profile saved.");
  }

  async function enableNotifications() {
    setError("");
    try {
      await setupPushNotifications();
      setNotificationsOn(true);
    } catch (notificationError) {
      setError(
        notificationError instanceof Error
          ? notificationError.message
          : "Could not enable notifications.",
      );
    }
  }

  async function loadSpotifyConnection() {
    const {
      data: { session: currentSession },
    } = await supabase.auth.getSession();
    if (!currentSession) return;

    const response = await fetch("/api/spotify/connection", {
      headers: {
        Authorization: `Bearer ${currentSession.access_token}`,
      },
      cache: "no-store",
    });
    const result = (await response.json().catch(() => null)) as
      | (SpotifyConnection & { error?: string })
      | null;

    if (!response.ok) {
      setSpotifyStatus(result?.error ?? "Could not check Spotify connection.");
      return;
    }

    setSpotifyConnection(result);
  }

  async function connectSpotify() {
    setSpotifyBusy(true);
    setSpotifyStatus("");

    const {
      data: { session: currentSession },
    } = await supabase.auth.getSession();
    if (!currentSession) {
      setSpotifyBusy(false);
      setSpotifyStatus("Please log in again.");
      return;
    }

    const response = await fetch("/api/spotify/connect", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${currentSession.access_token}`,
      },
    });
    const result = (await response.json().catch(() => null)) as
      | { url?: string; error?: string }
      | null;

    if (!response.ok || !result?.url) {
      setSpotifyBusy(false);
      setSpotifyStatus(result?.error ?? "Could not start Spotify login.");
      return;
    }

    window.location.assign(result.url);
  }

  async function disconnectSpotify() {
    setSpotifyBusy(true);
    setSpotifyStatus("");

    const {
      data: { session: currentSession },
    } = await supabase.auth.getSession();
    if (!currentSession) {
      setSpotifyBusy(false);
      return;
    }

    const response = await fetch("/api/spotify/connection", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${currentSession.access_token}`,
      },
    });

    setSpotifyBusy(false);
    if (!response.ok) {
      const result = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      setSpotifyStatus(result?.error ?? "Could not disconnect Spotify.");
      return;
    }

    setSpotifyConnection({
      connected: false,
      displayName: null,
      product: null,
    });
    setSpotifyStatus("Spotify disconnected.");
  }

  async function spotifyApiHeaders() {
    const {
      data: { session: currentSession },
    } = await supabase.auth.getSession();
    return currentSession
      ? { Authorization: `Bearer ${currentSession.access_token}` }
      : null;
  }

  async function loadJukebox(conversationId: string) {
    const headers = await spotifyApiHeaders();
    if (!headers) return;

    const response = await fetch(
      `/api/spotify/jukebox?conversationId=${encodeURIComponent(conversationId)}`,
      { headers, cache: "no-store" },
    );
    const result = (await response.json().catch(() => null)) as
      | { state?: JukeboxState | null; error?: string }
      | null;

    if (response.ok) {
      setJukeboxState(result?.state ?? null);
    } else {
      setJukeboxStatus(result?.error ?? "Could not load the jukebox.");
    }
  }

  async function searchSpotify() {
    const query = jukeboxQuery.trim();
    if (!query) {
      setJukeboxResults([]);
      return;
    }

    const headers = await spotifyApiHeaders();
    if (!headers) return;

    setJukeboxSearching(true);
    setJukeboxStatus("");
    const response = await fetch(
      `/api/spotify/search?q=${encodeURIComponent(query)}`,
      { headers, cache: "no-store" },
    );
    const result = (await response.json().catch(() => null)) as
      | { tracks?: SpotifyTrack[]; error?: string }
      | null;
    setJukeboxSearching(false);

    if (!response.ok) {
      setJukeboxStatus(result?.error ?? "Spotify search failed.");
      return;
    }

    setJukeboxResults(result?.tracks ?? []);
  }

  async function controlJukebox(
    action: "select" | "play" | "pause",
    track?: SpotifyTrack,
  ) {
    if (!selectedChat) return;
    const headers = await spotifyApiHeaders();
    if (!headers) return;

    setJukeboxBusy(true);
    setJukeboxStatus("");

    const response = await fetch("/api/spotify/jukebox", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        conversationId: selectedChat.conversation_id,
        action,
        ...(track ? { track } : {}),
      }),
    });
    const result = (await response.json().catch(() => null)) as
      | {
          state?: JukeboxState;
          error?: string;
          playback?: { connected: number; total: number };
        }
      | null;
    setJukeboxBusy(false);

    if (!response.ok || !result?.state) {
      setJukeboxStatus(result?.error ?? "The jukebox command failed.");
      return;
    }

    setJukeboxState(result.state);
    if (track) {
      setJukeboxResults([]);
      setJukeboxQuery("");
    }

    const connected = result.playback?.connected ?? 0;
    const total = result.playback?.total ?? 0;
    setJukeboxStatus(
      connected === total && total > 0
        ? `Spotify updated for ${connected} listener${connected === 1 ? "" : "s"}.`
        : `Updated ${connected} of ${total}. Open Spotify on each phone or computer first.`,
    );
  }

  async function loadMessageReactions(messageIds: string[]) {
    const uniqueIds = [...new Set(messageIds)];
    if (uniqueIds.length === 0) {
      setMessageReactions({});
      return;
    }

    const { data, error: reactionError } = await supabase
      .from("message_reactions")
      .select("message_id, user_id, emoji")
      .in("message_id", uniqueIds);

    if (reactionError) {
      setError(`Could not load reactions: ${reactionError.message}`);
      return;
    }

    const grouped: Record<string, MessageReaction[]> = {};
    for (const reaction of (data ?? []) as MessageReaction[]) {
      grouped[reaction.message_id] ??= [];
      grouped[reaction.message_id].push(reaction);
    }
    setMessageReactions(grouped);
  }

  async function loadFriendPresence(friendId: string) {
    const { data, error: presenceError } = await supabase.rpc(
      "get_friend_presence",
      { target_user_id: friendId },
    );

    if (presenceError) {
      setError(`Could not load online status: ${presenceError.message}`);
      return;
    }

    setFriendLastSeenAt(
      typeof data === "string" ? data : data ? String(data) : null,
    );
    setPresenceClock(Date.now());
  }

  async function loadReadReceipts(
    conversationId: string,
    friendId: string,
  ) {
    const { data, error: receiptError } = await supabase.rpc(
      "get_conversation_read_receipts",
      { target_conversation_id: conversationId },
    );

    if (receiptError) {
      setError(`Could not load read receipts: ${receiptError.message}`);
      return;
    }

    const friendReceipt = (
      (data ?? []) as ConversationReadReceipt[]
    ).find((receipt) => receipt.user_id === friendId);
    setFriendLastReadAt(friendReceipt?.last_read_at ?? null);
  }

  async function markConversationRead(conversationId: string) {
    const { error: readError } = await supabase.rpc("mark_conversation_read", {
      target_conversation_id: conversationId,
    });

    if (readError) {
      setError(`Could not mark messages as read: ${readError.message}`);
    }
  }

  function startReply(message: Message) {
    setReplyingTo(message);
    setMessageActionMenu(null);
    window.setTimeout(() => {
      document.querySelector<HTMLInputElement>("#message-composer")?.focus();
    }, 0);
  }

  function openMessageActions(message: Message, clientX: number, clientY: number) {
    const menuWidth = 300;
    const menuHeight = 120;
    setMessageActionMenu({
      message,
      x: Math.max(8, Math.min(clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(clientY, window.innerHeight - menuHeight - 8)),
    });
  }

  function handleMessageContextMenu(
    event: ReactMouseEvent<HTMLDivElement>,
    message: Message,
  ) {
    event.preventDefault();
    openMessageActions(message, event.clientX, event.clientY);
  }

  function clearLongPressTimer() {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function handleMessagePointerDown(
    event: ReactPointerEvent<HTMLDivElement>,
    message: Message,
  ) {
    if (event.pointerType === "mouse") return;
    clearLongPressTimer();
    gestureRef.current = {
      message,
      startX: event.clientX,
      startY: event.clientY,
      pointerId: event.pointerId,
    };

    longPressTimerRef.current = setTimeout(() => {
      if (!gestureRef.current) return;
      openMessageActions(
        message,
        window.innerWidth / 2,
        Math.min(event.clientY, window.innerHeight - 140),
      );
      gestureRef.current = null;
      if (navigator.vibrate) navigator.vibrate(35);
    }, 550);
  }

  function handleMessagePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const movedX = event.clientX - gesture.startX;
    const movedY = event.clientY - gesture.startY;
    if (Math.abs(movedX) > 10 || Math.abs(movedY) > 10) {
      clearLongPressTimer();
    }
  }

  function handleMessagePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    clearLongPressTimer();
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    const movedX = event.clientX - gesture.startX;
    const movedY = event.clientY - gesture.startY;
    if (movedX > 55 && Math.abs(movedY) < 40) {
      startReply(gesture.message);
      if (navigator.vibrate) navigator.vibrate(20);
    }
  }

  function cancelMessageGesture() {
    clearLongPressTimer();
    gestureRef.current = null;
  }

  async function toggleReaction(message: Message, emoji: string) {
    if (!session) return;
    setMessageActionMenu(null);
    const currentReaction = (messageReactions[message.id] ?? []).find(
      (reaction) => reaction.user_id === session.user.id,
    );

    if (currentReaction?.emoji === emoji) {
      const { error: deleteError } = await supabase
        .from("message_reactions")
        .delete()
        .eq("message_id", message.id)
        .eq("user_id", session.user.id);
      if (deleteError) {
        setError(deleteError.message);
        return;
      }
    } else {
      const { error: reactionError } = await supabase
        .from("message_reactions")
        .upsert(
          {
            message_id: message.id,
            user_id: session.user.id,
            emoji,
          },
          { onConflict: "message_id,user_id" },
        );
      if (reactionError) {
        setError(reactionError.message);
        return;
      }
    }

    await loadMessageReactions(messages.map((item) => item.id));
  }

  async function searchFriends() {
    const query = friendSearch.trim();
    if (!query) {
      setSearchResults([]);
      return;
    }

    setSearching(true);
    const { data, error: searchError } = await supabase.rpc("search_profiles", {
      search_text: query,
    });
    setSearching(false);

    if (searchError) {
      setError(searchError.message);
      return;
    }
    setSearchResults((data ?? []) as SearchResult[]);
  }

  async function sendFriendRequest(username: string) {
    const { error: requestError } = await supabase.rpc("send_friend_request", {
      target_username: username,
    });
    if (requestError) {
      setError(requestError.message);
      return;
    }
    await searchFriends();
  }

  async function respondToRequest(requestId: string, accept: boolean) {
    const { data, error: responseError } = await supabase.rpc(
      "respond_to_friend_request",
      { request_id: requestId, accept_request: accept },
    );
    if (responseError) {
      setError(responseError.message);
      return;
    }

    await Promise.all([loadRequests(), loadChats(data ?? undefined)]);
    if (accept && data) {
      setSidebarView("chats");
      setMobileChatOpen(true);
    }
  }

  async function sendMessage() {
    const body = text.trim();
    if (!body || !session || !selectedChat) return;
    const replyToMessageId = replyingTo?.id ?? null;
    setText("");
    setError("");

    const { error: messageError } = await supabase.from("messages").insert({
      conversation_id: selectedChat.conversation_id,
      body,
      sender_id: session.user.id,
      message_type: "text",
      is_bot: false,
      reply_to_message_id: replyToMessageId,
    });

    if (messageError) {
      setError(messageError.message);
      setText(body);
      return;
    }

    setReplyingTo(null);
    await sendPushNotification("text", selectedChat.conversation_id);

    if (/(^|\s)@swiggy\b/i.test(body)) {
      const {
        data: { session: currentSession },
      } = await supabase.auth.getSession();
      const response = await fetch("/api/swiggy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${currentSession?.access_token ?? ""}`,
        },
        body: JSON.stringify({
          message: body,
          conversationId: selectedChat.conversation_id,
        }),
      });

      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as
          | { message?: string }
          | null;
        setError(result?.message ?? "Swiggy could not reply right now.");
      }
    }
  }

  async function uploadFile(file: File, forcedType?: MessageType) {
    if (!session || !selectedChat) return;
    const replyToMessageId = replyingTo?.id ?? null;
    const messageType = forcedType ?? getMessageTypeFromFile(file);
    if (!messageType) {
      setError("Only image, video, and audio files are allowed.");
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setError("File is too large. Max size is 50MB.");
      return;
    }

    setUploading(true);
    const filePath = `${selectedChat.conversation_id}/${session.user.id}/${Date.now()}-${crypto.randomUUID()}-${safeFileName(file.name)}`;
    const { error: uploadError } = await supabase.storage
      .from(MEDIA_BUCKET)
      .upload(filePath, file, { contentType: file.type, upsert: false });

    if (uploadError) {
      setUploading(false);
      setError(uploadError.message);
      return;
    }

    const { error: messageError } = await supabase.from("messages").insert({
      conversation_id: selectedChat.conversation_id,
      sender_id: session.user.id,
      body: null,
      message_type: messageType,
      file_path: filePath,
      file_name: file.name,
      file_mime: file.type,
      is_bot: false,
      reply_to_message_id: replyToMessageId,
    });
    setUploading(false);

    if (messageError) {
      setError(messageError.message);
      return;
    }
    setReplyingTo(null);
    await sendPushNotification(messageType, selectedChat.conversation_id);
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) await uploadFile(file);
    event.target.value = "";
  }

  async function startRecording() {
    setMediaOpen(false);
    setEmojiOpen(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = stream;
      audioChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        const mimeType = recorder.mimeType || "audio/webm";
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        const voiceFile = new File(
          [audioBlob],
          `voice-note-${Date.now()}.webm`,
          { type: mimeType },
        );
        audioStreamRef.current?.getTracks().forEach((track) => track.stop());
        audioStreamRef.current = null;
        await uploadFile(voiceFile, "audio");
      };
      recorder.start();
      setIsRecording(true);
    } catch {
      setError("Microphone permission was blocked or unavailable.");
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  }

  function openChat(chat: Chat) {
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 767px)").matches
    ) {
      const chatUrl = new URL(window.location.href);
      const currentConversationId = chatUrl.searchParams.get("conversation");

      if (currentConversationId !== chat.conversation_id) {
        chatUrl.searchParams.set("conversation", chat.conversation_id);
        window.history.pushState(
          { haaahoooChat: chat.conversation_id },
          "",
          `${chatUrl.pathname}${chatUrl.search}${chatUrl.hash}`,
        );
      }
    }

    setSelectedChat(chat);
    setMobileChatOpen(true);
    setMessages(messageCacheRef.current.get(chat.conversation_id) ?? []);
    setMessagesLoading(!messageCacheRef.current.has(chat.conversation_id));
    setReplyingTo(null);
    setMessageActionMenu(null);
    setError("");
  }

  function closeMobileChat() {
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 767px)").matches &&
      new URLSearchParams(window.location.search).has("conversation")
    ) {
      window.history.back();
      return;
    }

    setMobileChatOpen(false);
    setReplyingTo(null);
    setMessageActionMenu(null);
  }

  if (!session) {
    return (
      <main className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden p-4">
        <SkyBackground theme={effectiveTheme} />
        <section className={`relative z-10 w-full max-w-sm rounded-3xl border p-6 shadow-2xl backdrop-blur-xl ${panel}`}>
          <div className="mb-6 text-center">
            <div className="mb-3 text-5xl">🐮</div>
            <h1 className="text-3xl font-black">Haaahooo</h1>
            <p className={`mt-2 ${muted}`}>Private chats with the people you choose.</p>
          </div>

          <div className="mb-5 flex justify-center gap-2">
            <ThemeButton label="Auto" value="auto" selected={themeMode} onClick={setThemeMode} isDark={isDark} />
            <ThemeButton label="Light" value="light" selected={themeMode} onClick={setThemeMode} isDark={isDark} />
            <ThemeButton label="Dark" value="dark" selected={themeMode} onClick={setThemeMode} isDark={isDark} />
          </div>

          {showSignup && (
            <>
              <input
                className={`mb-3 w-full rounded-2xl border p-4 outline-none ${inputClass}`}
                placeholder="Display name"
                value={signupDisplayName}
                onChange={(event) => setSignupDisplayName(event.target.value)}
              />
              <input
                className={`mb-3 w-full rounded-2xl border p-4 outline-none ${inputClass}`}
                placeholder="Username (e.g. affaan_24)"
                value={signupUsername}
                onChange={(event) => setSignupUsername(event.target.value.toLowerCase())}
              />
            </>
          )}

          <input
            className={`mb-3 w-full rounded-2xl border p-4 outline-none ${inputClass}`}
            placeholder="Email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <input
            className={`mb-4 w-full rounded-2xl border p-4 outline-none ${inputClass}`}
            placeholder="Password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void (showSignup ? signUp() : signIn());
            }}
          />

          <button
            onClick={() => void (showSignup ? signUp() : signIn())}
            className={`mb-3 w-full rounded-2xl p-4 font-bold ${
              isDark ? "bg-violet-400 text-slate-950" : "bg-slate-950 text-white"
            }`}
          >
            {showSignup ? "Create account" : "Login"}
          </button>
          <button
            onClick={() => {
              setShowSignup((current) => !current);
              setError("");
            }}
            className={`w-full rounded-2xl border p-4 font-bold ${
              isDark ? "border-white/15 bg-white/10" : "border-slate-200 bg-white"
            }`}
          >
            {showSignup ? "Back to login" : "Create an account"}
          </button>
          {error && <p className="mt-4 rounded-2xl bg-red-500/15 p-3 text-sm text-red-500">{error}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="relative min-h-[100dvh] overflow-hidden p-0 md:p-4">
      <SkyBackground theme={effectiveTheme} />
      <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
      <input ref={videoInputRef} type="file" accept="video/*" className="hidden" onChange={handleFileChange} />
      <audio ref={voiceCall.remoteAudioRef} autoPlay playsInline className="hidden" />

      {voiceCall.phase !== "idle" && voiceCall.call && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md">
          <section
            className={`mobile-safe-top mobile-safe-bottom flex min-h-[28rem] w-full max-w-sm flex-col items-center justify-between rounded-3xl border p-6 text-center shadow-2xl ${panel}`}
            role="dialog"
            aria-modal="true"
            aria-label="Voice call"
          >
            <div className="w-full">
              <p className={`text-sm font-bold uppercase tracking-wide ${muted}`}>
                {voiceCall.phase === "incoming"
                  ? "Incoming voice call"
                  : voiceCall.phase === "outgoing"
                    ? "Calling"
                    : voiceCall.phase === "connecting"
                      ? "Connecting"
                      : "Voice call"}
              </p>
              {voiceCall.error && (
                <p className="mt-3 rounded-xl bg-red-500/15 p-2 text-sm text-red-500">
                  {voiceCall.error}
                </p>
              )}
            </div>

            <div className="flex flex-col items-center">
              <Avatar name={voiceCall.peerName} isDark={isDark} size="lg" />
              <h2 className="mt-4 max-w-full truncate text-2xl font-black">
                {voiceCall.peerName}
              </h2>
              <p className={`mt-2 text-sm ${muted}`}>
                {voiceCall.phase === "incoming"
                  ? "Tap answer to connect"
                  : voiceCall.phase === "outgoing"
                    ? "Waiting for them to answer..."
                    : voiceCall.phase === "connecting"
                      ? "Securing audio connection..."
                      : formatCallDuration(voiceCall.durationSeconds)}
              </p>
            </div>

            <div className="flex w-full items-center justify-center gap-5">
              {voiceCall.phase === "incoming" ? (
                <>
                  <button
                    type="button"
                    onClick={() => void voiceCall.rejectCall()}
                    className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500 text-2xl text-white"
                    aria-label="Reject call"
                    title="Reject"
                  >
                    ×
                  </button>
                  <button
                    type="button"
                    onClick={() => void voiceCall.acceptCall()}
                    className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 text-2xl text-white"
                    aria-label="Answer call"
                    title="Answer"
                  >
                    ☎
                  </button>
                </>
              ) : (
                <>
                  {voiceCall.phase === "active" && (
                    <button
                      type="button"
                      onClick={voiceCall.toggleMute}
                      className={`flex h-14 w-14 items-center justify-center rounded-full text-xl ${
                        voiceCall.muted
                          ? "bg-amber-400 text-slate-950"
                          : isDark
                            ? "bg-white/15 text-white"
                            : "bg-slate-200 text-slate-950"
                      }`}
                      aria-label={voiceCall.muted ? "Unmute microphone" : "Mute microphone"}
                      title={voiceCall.muted ? "Unmute" : "Mute"}
                    >
                      {voiceCall.muted ? "M" : "μ"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void voiceCall.endCall()}
                    className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500 text-2xl text-white"
                    aria-label="End call"
                    title="End call"
                  >
                    ×
                  </button>
                </>
              )}
            </div>
          </section>
        </div>
      )}

      {messageActionMenu && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-[80] cursor-default bg-transparent"
            onClick={() => setMessageActionMenu(null)}
            aria-label="Close message actions"
          />
          <div
            className={`fixed z-[90] w-[min(18.75rem,calc(100vw-1rem))] rounded-2xl border p-2 shadow-2xl ${panel}`}
            style={{
              left: messageActionMenu.x,
              top: messageActionMenu.y,
            }}
            role="menu"
          >
            <div className="grid grid-cols-6 gap-1">
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  type="button"
                  key={emoji}
                  onClick={() =>
                    void toggleReaction(messageActionMenu.message, emoji)
                  }
                  className={`flex h-10 items-center justify-center rounded-xl text-xl ${
                    isDark ? "hover:bg-white/15" : "hover:bg-slate-100"
                  }`}
                  aria-label={`React with ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => startReply(messageActionMenu.message)}
              className={`mt-1 w-full rounded-xl px-3 py-2.5 text-left text-sm font-bold ${
                isDark ? "hover:bg-white/10" : "hover:bg-slate-100"
              }`}
              role="menuitem"
            >
              ↩ Reply
            </button>
          </div>
        </>
      )}

      <div className={`relative z-10 mx-auto grid h-[100dvh] w-full max-w-6xl grid-cols-[minmax(0,1fr)] overflow-hidden border backdrop-blur-xl md:h-[calc(100dvh-2rem)] md:grid-cols-[320px_minmax(0,1fr)] md:rounded-3xl ${panel}`}>
        <aside
          className={`${mobileChatOpen ? "hidden md:flex" : "flex"} min-h-0 min-w-0 w-full max-w-full flex-col overflow-hidden border-r ${
            isDark ? "border-white/10" : "border-slate-200"
          }`}
        >
          <header className={`mobile-safe-top relative z-50 flex items-center justify-between border-b px-3 py-2.5 md:p-4 ${isDark ? "border-white/10" : "border-slate-200"}`}>
            <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
              <Avatar name={profile?.display_name ?? "H"} isDark={isDark} size="lg" />
              <div className="min-w-0 flex-1 overflow-hidden">
                <h1 className="truncate text-base font-black md:text-lg">{profile?.display_name ?? "Haaahooo"}</h1>
                <p className={`truncate text-xs ${muted}`}>@{profile?.username}</p>
              </div>
            </div>
            <button
              onClick={() => setSettingsOpen((current) => !current)}
              className={`ml-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xl ${isDark ? "bg-white/10" : "bg-slate-100"}`}
              aria-label="Open settings"
            >
              ⚙
            </button>

            {settingsOpen && (
              <div className={`absolute right-3 top-[calc(100%+0.5rem)] z-[60] max-h-[calc(100dvh-6.5rem)] w-[calc(100vw-1.5rem)] max-w-72 overflow-y-auto overscroll-contain rounded-2xl border p-3 shadow-2xl ${panel}`}>
                <p className={`mb-2 text-xs font-bold uppercase ${muted}`}>Profile</p>
                <input className={`mb-2 w-full rounded-xl border px-3 py-2 outline-none ${inputClass}`} value={profileDisplayName} onChange={(event) => setProfileDisplayName(event.target.value)} placeholder="Display name" />
                <input className={`mb-3 w-full rounded-xl border px-3 py-2 outline-none ${inputClass}`} value={profileUsername} onChange={(event) => setProfileUsername(event.target.value.toLowerCase())} placeholder="Username" />
                <button type="button" onClick={() => void saveProfile()} className={`mb-2 w-full rounded-xl py-2 font-bold ${isDark ? "bg-violet-400 text-slate-950" : "bg-slate-950 text-white"}`}>Save profile</button>
                {profileStatus && (
                  <p
                    className={`mb-3 rounded-xl p-2 text-xs ${
                      profileStatus === "Profile saved."
                        ? "bg-emerald-500/15 text-emerald-500"
                        : "bg-red-500/15 text-red-500"
                    }`}
                  >
                    {profileStatus}
                  </p>
                )}
                <p className={`mb-2 text-xs font-bold uppercase ${muted}`}>Theme</p>
                <div className="mb-3 grid grid-cols-3 gap-2">
                  <ThemeButton label="Auto" value="auto" selected={themeMode} onClick={setThemeMode} isDark={isDark} />
                  <ThemeButton label="Light" value="light" selected={themeMode} onClick={setThemeMode} isDark={isDark} />
                  <ThemeButton label="Dark" value="dark" selected={themeMode} onClick={setThemeMode} isDark={isDark} />
                </div>
                <button onClick={() => void enableNotifications()} className={`mb-2 w-full rounded-xl px-3 py-3 text-left font-semibold ${isDark ? "bg-white/10" : "bg-slate-100"}`}>
                  {notificationsOn ? "Notifications enabled" : "Enable notifications"}
                </button>
                <div className={`mb-2 rounded-xl p-3 ${isDark ? "bg-white/10" : "bg-slate-100"}`}>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold">Spotify</p>
                      <p className={`truncate text-xs ${muted}`}>
                        {spotifyConnection?.connected
                          ? `${spotifyConnection.displayName ?? "Connected"}${
                              spotifyConnection.product
                                ? ` · ${spotifyConnection.product}`
                                : ""
                            }`
                          : "Not connected"}
                      </p>
                    </div>
                    <span className="text-xl" aria-hidden="true">♫</span>
                  </div>
                  <button
                    type="button"
                    disabled={spotifyBusy}
                    onClick={() =>
                      void (spotifyConnection?.connected
                        ? disconnectSpotify()
                        : connectSpotify())
                    }
                    className={`w-full rounded-lg px-3 py-2 text-sm font-bold disabled:opacity-50 ${
                      spotifyConnection?.connected
                        ? isDark
                          ? "bg-white/10 text-white"
                          : "bg-white text-slate-950"
                        : "bg-[#1DB954] text-black"
                    }`}
                  >
                    {spotifyBusy
                      ? "Please wait..."
                      : spotifyConnection?.connected
                        ? "Disconnect Spotify"
                        : "Connect Spotify"}
                  </button>
                  {spotifyStatus && (
                    <p className={`mt-2 text-xs ${muted}`}>{spotifyStatus}</p>
                  )}
                </div>
                <button onClick={() => void signOut()} className="w-full rounded-xl bg-red-500/15 px-3 py-3 text-left font-semibold text-red-500">Logout</button>
              </div>
            )}
          </header>

          <nav className="grid w-full min-w-0 grid-cols-2 gap-2 px-3 py-2 md:p-3" aria-label="Messenger sections">
            <button onClick={() => setSidebarView("chats")} className={`min-w-0 rounded-xl px-2 py-2.5 text-center text-sm font-bold ${sidebarView === "chats" ? isDark ? "bg-violet-400 text-slate-950" : "bg-slate-950 text-white" : isDark ? "bg-white/10" : "bg-slate-100"}`}>Chats</button>
            <button onClick={() => setSidebarView("friends")} className={`relative min-w-0 rounded-xl px-2 py-2.5 text-center text-sm font-bold ${sidebarView === "friends" ? isDark ? "bg-violet-400 text-slate-950" : "bg-slate-950 text-white" : isDark ? "bg-white/10" : "bg-slate-100"}`}>
              Friends
              {requests.length > 0 && <span className="ml-2 rounded-full bg-red-500 px-2 py-0.5 text-xs text-white">{requests.length}</span>}
            </button>
          </nav>

          <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3 pb-3">
            {sidebarView === "chats" ? (
              chats.length > 0 ? chats.map((chat) => (
                <button
                  key={chat.conversation_id}
                  onClick={() => openChat(chat)}
                  className={`mb-2 flex w-full min-w-0 max-w-full items-center gap-3 overflow-hidden rounded-2xl p-3 text-left transition ${
                    selectedChat?.conversation_id === chat.conversation_id
                      ? isDark ? "bg-white/15" : "bg-sky-100"
                      : isDark ? "hover:bg-white/10" : "hover:bg-white"
                  }`}
                >
                  <Avatar name={chat.display_name} isDark={isDark} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-bold">{chat.display_name}</p>
                    <p className={`truncate text-xs ${muted}`}>{chat.last_message ?? `@${chat.username}`}</p>
                  </div>
                  {chat.last_message_at && <span className={`hidden shrink-0 text-[10px] min-[360px]:block ${muted}`}>{new Date(chat.last_message_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
                </button>
              )) : (
                <div className={`mt-12 text-center text-sm ${muted}`}>
                  <p className="mb-2 text-3xl">💬</p>
                  <p>No chats yet.</p>
                  <button onClick={() => setSidebarView("friends")} className="mt-3 font-bold text-sky-500">Add a friend</button>
                </div>
              )
            ) : (
              <>
                <div className="mb-4 flex gap-2">
                  <input
                    className={`min-w-0 flex-1 rounded-xl border px-3 py-2 outline-none ${inputClass}`}
                    placeholder="Search username"
                    value={friendSearch}
                    onChange={(event) => setFriendSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void searchFriends();
                    }}
                  />
                  <button onClick={() => void searchFriends()} className={`rounded-xl px-3 font-bold ${isDark ? "bg-violet-400 text-slate-950" : "bg-slate-950 text-white"}`}>Find</button>
                </div>

                {requests.length > 0 && (
                  <section className="mb-5">
                    <p className={`mb-2 text-xs font-bold uppercase ${muted}`}>Requests</p>
                    {requests.map((request) => (
                      <div key={request.request_id} className={`mb-2 rounded-2xl p-3 ${isDark ? "bg-white/10" : "bg-white"}`}>
                        <div className="mb-3 flex items-center gap-3">
                          <Avatar name={request.display_name} isDark={isDark} size="sm" />
                          <div className="min-w-0">
                            <p className="truncate font-bold">{request.display_name}</p>
                            <p className={`text-xs ${muted}`}>@{request.username}</p>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <button onClick={() => void respondToRequest(request.request_id, true)} className="rounded-xl bg-emerald-500 py-2 text-sm font-bold text-white">Accept</button>
                          <button onClick={() => void respondToRequest(request.request_id, false)} className={`rounded-xl py-2 text-sm font-bold ${isDark ? "bg-white/10" : "bg-slate-100"}`}>Reject</button>
                        </div>
                      </div>
                    ))}
                  </section>
                )}

                {searching && <p className={`text-sm ${muted}`}>Searching...</p>}
                {searchResults.map((result) => (
                  <div key={result.id} className={`mb-2 flex items-center gap-3 rounded-2xl p-3 ${isDark ? "bg-white/10" : "bg-white"}`}>
                    <Avatar name={result.display_name} isDark={isDark} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-bold">{result.display_name}</p>
                      <p className={`truncate text-xs ${muted}`}>@{result.username}</p>
                    </div>
                    <button
                      disabled={result.relationship !== "none"}
                      onClick={() => void sendFriendRequest(result.username)}
                      className={`rounded-xl px-3 py-2 text-xs font-bold disabled:opacity-50 ${
                        isDark ? "bg-violet-400 text-slate-950" : "bg-slate-950 text-white"
                      }`}
                    >
                      {result.relationship === "friends" ? "Friends" : result.relationship === "sent" ? "Sent" : result.relationship === "received" ? "Pending" : "Add"}
                    </button>
                  </div>
                ))}
              </>
            )}
          </div>
        </aside>

        <section className={`${mobileChatOpen ? "flex" : "hidden md:flex"} relative min-h-0 min-w-0 w-full max-w-full flex-col overflow-hidden`}>
          {selectedChat ? (
            <>
              <header className={`mobile-safe-top flex min-h-14 items-center gap-2 border-b px-2.5 py-2 md:gap-3 md:p-4 ${isDark ? "border-white/10" : "border-slate-200"}`}>
                <button onClick={closeMobileChat} className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-2xl md:hidden ${isDark ? "bg-white/10" : "bg-slate-100"}`} aria-label="Back to chats">‹</button>
                <Avatar name={selectedChat.display_name} isDark={isDark} />
                <div className="min-w-0 flex-1">
                  <h2 className="truncate font-black">{selectedChat.display_name}</h2>
                  <p
                    className={`truncate text-xs ${
                      friendIsOnline ? "font-semibold text-emerald-500" : muted
                    }`}
                  >
                    {friendPresenceText}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={voiceCall.phase !== "idle"}
                  onClick={() => void voiceCall.startCall(selectedChat)}
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg disabled:cursor-not-allowed disabled:opacity-40 ${
                    isDark ? "bg-white/10" : "bg-slate-100"
                  }`}
                  aria-label={`Call ${selectedChat.display_name}`}
                  title="Voice call"
                >
                  ☎
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setJukeboxOpen((current) => !current);
                    setMediaOpen(false);
                    setEmojiOpen(false);
                  }}
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg ${jukeboxOpen ? "bg-[#1DB954] text-black" : isDark ? "bg-white/10" : "bg-slate-100"}`}
                  aria-label="Open shared jukebox"
                  title="Shared jukebox"
                >
                  ♫
                </button>
                <button
                  type="button"
                  onClick={() => {
                    messageCacheRef.current.delete(selectedChat.conversation_id);
                    setMessagesLoading(true);
                    setMessageRefreshKey((current) => current + 1);
                  }}
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg ${isDark ? "bg-white/10" : "bg-slate-100"}`}
                  aria-label="Refresh messages"
                  title="Refresh messages"
                >
                  ↻
                </button>
              </header>

              {jukeboxOpen && (
                <div className={`absolute inset-x-2 top-[calc(env(safe-area-inset-top)+4.25rem)] z-50 max-h-[calc(100dvh-8.5rem)] overflow-y-auto overscroll-contain rounded-2xl border p-3 shadow-2xl md:left-auto md:right-4 md:top-20 md:w-96 ${panel}`}>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <p className="font-black">Shared jukebox</p>
                      <p className={`text-xs ${muted}`}>Controls Spotify for both listeners</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setJukeboxOpen(false)}
                      className={`flex h-9 w-9 items-center justify-center rounded-full ${isDark ? "bg-white/10" : "bg-slate-100"}`}
                      aria-label="Close jukebox"
                    >
                      ×
                    </button>
                  </div>

                  {jukeboxState?.trackName ? (
                    <div className={`mb-3 flex items-center gap-3 rounded-xl p-3 ${isDark ? "bg-white/10" : "bg-slate-100"}`}>
                      {jukeboxState.imageUrl ? (
                        <img
                          src={jukeboxState.imageUrl}
                          alt=""
                          className="h-14 w-14 shrink-0 rounded-lg object-cover"
                        />
                      ) : (
                        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-[#1DB954] text-2xl text-black">♫</div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-bold">{jukeboxState.trackName}</p>
                        <p className={`truncate text-xs ${muted}`}>{jukeboxState.artistName}</p>
                        <p className={`mt-1 text-[11px] font-semibold ${jukeboxState.isPlaying ? "text-[#1DB954]" : muted}`}>
                          {jukeboxState.isPlaying ? "Playing" : "Paused"}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={jukeboxBusy}
                        onClick={() => void controlJukebox(jukeboxState.isPlaying ? "pause" : "play")}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#1DB954] font-black text-black disabled:opacity-50"
                        aria-label={jukeboxState.isPlaying ? "Pause" : "Play"}
                      >
                        {jukeboxState.isPlaying ? "Ⅱ" : "▶"}
                      </button>
                    </div>
                  ) : (
                    <p className={`mb-3 rounded-xl p-3 text-sm ${isDark ? "bg-white/10" : "bg-slate-100"} ${muted}`}>
                      Search for a song to start the jukebox.
                    </p>
                  )}

                  <div className="mb-2 flex gap-2">
                    <input
                      value={jukeboxQuery}
                      onChange={(event) => setJukeboxQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void searchSpotify();
                      }}
                      placeholder="Search Spotify"
                      className={`min-w-0 flex-1 rounded-xl border px-3 py-2 outline-none ${inputClass}`}
                    />
                    <button
                      type="button"
                      disabled={jukeboxSearching}
                      onClick={() => void searchSpotify()}
                      className="rounded-xl bg-[#1DB954] px-3 text-sm font-bold text-black disabled:opacity-50"
                    >
                      {jukeboxSearching ? "..." : "Search"}
                    </button>
                  </div>

                  {jukeboxResults.map((track) => (
                    <button
                      type="button"
                      key={track.id}
                      disabled={jukeboxBusy}
                      onClick={() => void controlJukebox("select", track)}
                      className={`mb-1.5 flex w-full min-w-0 items-center gap-3 rounded-xl p-2 text-left disabled:opacity-50 ${isDark ? "hover:bg-white/10" : "hover:bg-slate-100"}`}
                    >
                      {track.imageUrl ? (
                        <img src={track.imageUrl} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover" />
                      ) : (
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[#1DB954] text-black">♫</div>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold">{track.name}</span>
                        <span className={`block truncate text-xs ${muted}`}>{track.artists}</span>
                      </span>
                      <span className="shrink-0 text-[#1DB954]">▶</span>
                    </button>
                  ))}

                  {jukeboxStatus && (
                    <p className={`mt-2 rounded-xl p-2 text-xs ${isDark ? "bg-white/10" : "bg-slate-100"} ${muted}`}>
                      {jukeboxStatus}
                    </p>
                  )}
                  <p className={`mt-2 text-[11px] ${muted}`}>
                    Each listener must connect Spotify Premium and keep Spotify open on a device.
                  </p>
                </div>
              )}

              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 py-3 md:p-4" onClick={() => { setMediaOpen(false); setEmojiOpen(false); }}>
                {messagesLoading && messages.length === 0 && (
                  <div className={`mx-auto mt-20 max-w-sm text-center text-sm ${muted}`}>
                    Loading message history...
                  </div>
                )}
                {!messagesLoading && messages.length === 0 && (
                  <div className={`mx-auto mt-20 max-w-sm text-center ${muted}`}>
                    <p className="mb-3 text-4xl">👋</p>
                    <p>This chat is empty. Say hello to {selectedChat.display_name}.</p>
                  </div>
                )}
                {messages.map((message) => {
                  const bot = message.is_bot;
                  const mine = message.sender_id === session.user.id;
                  const repliedMessage = message.reply_to_message_id
                    ? messages.find(
                        (item) => item.id === message.reply_to_message_id,
                      )
                    : null;
                  const reactions = messageReactions[message.id] ?? [];
                  const seen =
                    mine &&
                    Boolean(friendLastReadAt) &&
                    new Date(friendLastReadAt!).getTime() >=
                      new Date(message.created_at).getTime();
                  const reactionSummary = reactions.reduce<
                    Record<string, number>
                  >((summary, reaction) => {
                    summary[reaction.emoji] =
                      (summary[reaction.emoji] ?? 0) + 1;
                    return summary;
                  }, {});
                  return (
                    <div key={message.id} className={`mb-2.5 flex md:mb-3 ${mine && !bot ? "justify-end" : "justify-start"}`}>
                      <div className={`flex max-w-[88%] flex-col md:max-w-[72%] ${mine && !bot ? "items-end" : "items-start"}`}>
                        <div
                          onContextMenu={(event) =>
                            handleMessageContextMenu(event, message)
                          }
                          onPointerDown={(event) =>
                            handleMessagePointerDown(event, message)
                          }
                          onPointerMove={handleMessagePointerMove}
                          onPointerUp={handleMessagePointerUp}
                          onPointerCancel={cancelMessageGesture}
                          className={`select-none rounded-3xl px-3.5 py-2.5 shadow-sm md:px-4 md:py-3 ${
                            bot
                              ? isDark ? "rounded-tl-md border border-amber-300/40 bg-amber-300/20 text-amber-50" : "rounded-tl-md border border-amber-300 bg-amber-100 text-amber-950"
                              : mine
                                ? isDark ? "bg-violet-400 text-slate-950" : "bg-sky-500 text-white"
                                : isDark ? "border border-white/10 bg-white/10" : "border border-slate-200 bg-white"
                          }`}
                          style={{ touchAction: "pan-y" }}
                        >
                          {bot && <p className={`mb-1 text-xs font-black uppercase ${isDark ? "text-amber-300" : "text-amber-700"}`}>{message.sender_name ?? "Swiggy"}</p>}
                          {message.reply_to_message_id && (
                            <button
                              type="button"
                              className="mb-2 block w-full min-w-0 rounded-xl border-l-4 border-current bg-black/10 px-3 py-2 text-left"
                              onClick={() => {
                                const target = document.getElementById(
                                  `message-${message.reply_to_message_id}`,
                                );
                                target?.scrollIntoView({
                                  behavior: "smooth",
                                  block: "center",
                                });
                              }}
                            >
                              <span className="block truncate text-xs font-black opacity-75">
                                {repliedMessage
                                  ? repliedMessage.is_bot
                                    ? repliedMessage.sender_name ?? "Swiggy"
                                    : repliedMessage.sender_id === session.user.id
                                      ? "You"
                                      : selectedChat.display_name
                                  : "Original message"}
                              </span>
                              <span className="block max-w-full truncate text-xs opacity-65">
                                {repliedMessage
                                  ? getMessagePreview(repliedMessage)
                                  : "Message unavailable"}
                              </span>
                            </button>
                          )}
                          <div id={`message-${message.id}`}>
                            <MessageContent message={message} />
                          </div>
                          <div className="mt-2 flex items-center justify-end gap-1.5 text-xs opacity-50">
                            <span>
                              {new Date(message.created_at).toLocaleTimeString(
                                [],
                                { hour: "2-digit", minute: "2-digit" },
                              )}
                            </span>
                            {mine &&
                              !bot &&
                              message.id === latestOwnMessageId && (
                                <span
                                  className={
                                    seen ? "font-bold text-cyan-700" : ""
                                  }
                                >
                                  {seen ? "✓✓ Seen" : "✓ Sent"}
                                </span>
                              )}
                          </div>
                        </div>
                        {Object.keys(reactionSummary).length > 0 && (
                          <div className={`-mt-1 flex flex-wrap gap-1 rounded-full border px-1.5 py-0.5 text-sm shadow-sm ${isDark ? "border-white/10 bg-slate-900" : "border-slate-200 bg-white"}`}>
                            {Object.entries(reactionSummary).map(
                              ([emoji, count]) => (
                                <button
                                  type="button"
                                  key={emoji}
                                  onClick={() => void toggleReaction(message, emoji)}
                                  className="rounded-full px-1"
                                  title={`${count} reaction${count === 1 ? "" : "s"}`}
                                >
                                  {emoji}
                                  {count > 1 && (
                                    <span className="ml-0.5 text-[10px] opacity-60">
                                      {count}
                                    </span>
                                  )}
                                </button>
                              ),
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>

              <footer className={`mobile-safe-bottom relative border-t px-2.5 py-2 md:p-4 ${isDark ? "border-white/10" : "border-slate-200"}`}>
                {replyingTo && (
                  <div className={`mb-2 flex items-center gap-3 rounded-xl border-l-4 px-3 py-2 ${isDark ? "border-violet-300 bg-white/10" : "border-sky-500 bg-slate-100"}`}>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-black">
                        Replying to{" "}
                        {replyingTo.is_bot
                          ? replyingTo.sender_name ?? "Swiggy"
                          : replyingTo.sender_id === session.user.id
                            ? "yourself"
                            : selectedChat.display_name}
                      </p>
                      <p className={`truncate text-xs ${muted}`}>
                        {getMessagePreview(replyingTo)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setReplyingTo(null)}
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${isDark ? "bg-white/10" : "bg-white"}`}
                      aria-label="Cancel reply"
                    >
                      ×
                    </button>
                  </div>
                )}
                <div className="flex items-end gap-1.5 md:gap-2">
                  <div className="relative">
                    <button
                      disabled={uploading || isRecording}
                      onClick={() => { setMediaOpen((current) => !current); setEmojiOpen(false); }}
                      className={`flex h-11 w-11 items-center justify-center rounded-full text-2xl disabled:opacity-50 md:h-12 md:w-12 ${isDark ? "bg-white/10" : "bg-white"}`}
                      aria-label="Open media menu"
                    >
                      +
                    </button>
                    {mediaOpen && (
                      <div className={`absolute bottom-[calc(100%+0.75rem)] left-0 z-40 w-[min(16rem,calc(100vw-1.25rem))] rounded-2xl border p-2 shadow-2xl ${panel}`}>
                        <button onClick={() => { setMediaOpen(false); imageInputRef.current?.click(); }} className={`w-full rounded-xl px-3 py-3 text-left text-sm font-semibold ${isDark ? "hover:bg-white/10" : "hover:bg-slate-100"}`}>📷 Photo</button>
                        <button onClick={() => { setMediaOpen(false); videoInputRef.current?.click(); }} className={`w-full rounded-xl px-3 py-3 text-left text-sm font-semibold ${isDark ? "hover:bg-white/10" : "hover:bg-slate-100"}`}>🎥 Video</button>
                        <button onClick={() => void startRecording()} className={`w-full rounded-xl px-3 py-3 text-left text-sm font-semibold ${isDark ? "hover:bg-white/10" : "hover:bg-slate-100"}`}>🎙 Voice note</button>
                        <button onClick={() => setEmojiOpen((current) => !current)} className={`w-full rounded-xl px-3 py-3 text-left text-sm font-semibold ${isDark ? "hover:bg-white/10" : "hover:bg-slate-100"}`}>😊 Emojis</button>
                        {emojiOpen && (
                          <div className={`mt-1 grid grid-cols-6 gap-1 border-t pt-2 ${isDark ? "border-white/10" : "border-slate-200"}`}>
                            {CHAT_EMOJIS.map((emoji) => (
                              <button key={emoji} onClick={() => { setText((current) => `${current}${emoji}`); setMediaOpen(false); setEmojiOpen(false); }} className={`h-9 w-9 rounded-lg text-xl ${isDark ? "hover:bg-white/15" : "hover:bg-slate-100"}`}>{emoji}</button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  {isRecording && <button onClick={stopRecording} className="h-12 rounded-full bg-red-500 px-4 text-sm font-bold text-white">Stop</button>}
                  <input
                    id="message-composer"
                    className={`h-11 min-w-0 flex-1 rounded-2xl border px-3 py-2 outline-none md:h-14 md:px-4 md:py-3 ${inputClass}`}
                    placeholder={`Message ${selectedChat.display_name}`}
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void sendMessage();
                    }}
                  />
                  <button onClick={() => void sendMessage()} className={`h-11 min-w-[4.5rem] shrink-0 rounded-2xl px-3 font-bold md:h-14 md:px-6 ${isDark ? "bg-violet-400 text-slate-950" : "bg-slate-950 text-white"}`}>Send</button>
                </div>
                {uploading && <p className={`mt-2 text-xs ${muted}`}>Uploading...</p>}
                {error && <p className="mt-2 rounded-xl bg-red-500/15 p-2 text-sm text-red-500">{error}</p>}
              </footer>
            </>
          ) : (
            <div className={`flex h-full items-center justify-center text-center ${muted}`}>
              <div>
                <p className="mb-3 text-5xl">🐮</p>
                <h2 className="text-xl font-black">Welcome to Haaahooo</h2>
                <p className="mt-2">Choose a chat or add a friend.</p>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
