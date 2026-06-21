"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { setupPushNotifications, sendPushNotification, } from "@/lib/clientNotifications";

type MessageType = "text" | "image" | "video" | "audio";

type Message = {
  id: string;
  sender_id: string;
  body: string | null;
  created_at: string;
  message_type: MessageType;
  file_path: string | null;
  file_name: string | null;
  file_mime: string | null;
  file_url?: string | null;
};

type ThemeMode = "auto" | "light" | "dark";
type EffectiveTheme = "light" | "dark";

const THEME_STORAGE_KEY = "private-chat-theme-mode";
const MEDIA_BUCKET = "chat-media";

const STARS = Array.from({ length: 75 }, (_, i) => ({
  left: (i * 37) % 100,
  top: ((i * 53) % 78) + 3,
  size: (i % 3) + 1,
  opacity: 0.35 + (i % 5) * 0.12,
  delay: (i % 10) * 0.25,
  speed: 2 + (i % 4),
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

function SkyBackground({ theme }: { theme: EffectiveTheme }) {
  const isDark = theme === "dark";

  return (
    <div
      className={`pointer-events-none absolute inset-0 overflow-hidden transition-colors duration-700 ${
        isDark
          ? "bg-gradient-to-br from-slate-950 via-indigo-950 to-black"
          : "bg-gradient-to-br from-sky-200 via-blue-100 to-amber-100"
      }`}
    >
      <style>
        {`
          @keyframes floatCloud {
            0% { transform: translateX(0px); }
            50% { transform: translateX(22px); }
            100% { transform: translateX(0px); }
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

      {!isDark ? (
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
                transform: `scale(${cloud.scale})`,
                animation: `floatCloud ${cloud.duration}s ease-in-out infinite`,
              }}
            >
              <div className="relative h-16 w-40">
                <div className="absolute bottom-0 left-2 h-12 w-20 rounded-full bg-white/75 blur-[1px]" />
                <div className="absolute bottom-4 left-12 h-14 w-14 rounded-full bg-white/80 blur-[1px]" />
                <div className="absolute bottom-0 left-20 h-12 w-24 rounded-full bg-white/75 blur-[1px]" />
              </div>
            </div>
          ))}
        </>
      ) : (
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
      )}

      <div className={`absolute inset-0 ${isDark ? "bg-black/10" : "bg-white/10"}`} />
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
  const active = selected === value;

  return (
    <button
      onClick={() => onClick(value)}
      className={`rounded-full px-4 py-2 text-sm font-medium transition ${
        active
          ? isDark
            ? "bg-white text-slate-950"
            : "bg-slate-950 text-white"
          : isDark
            ? "bg-white/10 text-white hover:bg-white/20"
            : "bg-white/60 text-slate-700 hover:bg-white"
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
        className="max-h-80 rounded-2xl object-contain"
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

  if (message.message_type === "audio") {
    return <audio src={message.file_url} controls className="max-w-full" />;
  }

  return null;
}

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [notificationsOn, setNotificationsOn] = useState(false);

  const [themeMode, setThemeMode] = useState<ThemeMode>("auto");
  const [timeTheme, setTimeTheme] = useState<EffectiveTheme>("light");

  const [isRecording, setIsRecording] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioStreamRef = useRef<MediaStream | null>(null);

  const effectiveTheme: EffectiveTheme =
    themeMode === "auto" ? timeTheme : themeMode;

  const isDark = effectiveTheme === "dark";

  useEffect(() => {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY) as ThemeMode | null;

    if (savedTheme === "auto" || savedTheme === "light" || savedTheme === "dark") {
      setThemeMode(savedTheme);
    }

    setTimeTheme(getTimeBasedTheme());

    const timer = setInterval(() => {
      setTimeTheme(getTimeBasedTheme());
    }, 60 * 1000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [themeMode]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => {
      data.subscription.unsubscribe();
    };
  }, []);

  async function addSignedUrls(rows: Message[]): Promise<Message[]> {
    return Promise.all(
      rows.map(async (message) => {
        if (!message.file_path) return message;

        const { data, error } = await supabase.storage
          .from(MEDIA_BUCKET)
          .createSignedUrl(message.file_path, 60 * 60);

        if (error) {
          return { ...message, file_url: null };
        }

        return { ...message, file_url: data.signedUrl };
      })
    );
  }

  useEffect(() => {
    if (!session) return;

    async function loadMessages() {
      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .order("created_at", { ascending: true });

      if (error) {
        setError(error.message);
        return;
      }

      const rows = await addSignedUrls((data ?? []) as Message[]);
      setMessages(rows);
    }

    loadMessages();

    const channel = supabase
      .channel("private-chat-room")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
        },
        async (payload) => {
          const newMessage = payload.new as Message;
          const [messageWithUrl] = await addSignedUrls([newMessage]);

          setMessages((current) => [...current, messageWithUrl]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [session]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function signUp() {
    setError("");

    if (!email || !password) {
      setError("Please enter email and password.");
      return;
    }

    const { error } = await supabase.auth.signUp({
      email,
      password,
    });

    if (error) {
      setError(error.message);
      return;
    }

    alert("Signup done. Now add this user in Supabase allowed_users table.");
  }

  async function signIn() {
    setError("");

    if (!email || !password) {
      setError("Please enter email and password.");
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    setMessages([]);
  }

  async function enableNotifications() {
  setError("");

  try {
    await setupPushNotifications();
    setNotificationsOn(true);
    alert("Notifications enabled!");
  } catch (error) {
    setError(
      error instanceof Error
        ? error.message
        : "Could not enable notifications."
    );
  }
}

  async function sendMessage() {
    const body = text.trim();

    if (!body || !session?.user.id) return;

    setText("");

    const { error } = await supabase.from("messages").insert({
      body,
      sender_id: session.user.id,
      message_type: "text",
    });

    if (error) {
  setError(error.message);
  return;
}

await sendPushNotification("text");
  }

  async function uploadFile(file: File, forcedType?: MessageType) {
    setError("");

    if (!session?.user.id) {
      setError("You must be logged in.");
      return;
    }

    const messageType = forcedType ?? getMessageTypeFromFile(file);

    if (!messageType) {
      setError("Only image, video, and audio files are allowed.");
      return;
    }

    const maxSize = 50 * 1024 * 1024;

    if (file.size > maxSize) {
      setError("File is too large. Max size is 50MB.");
      return;
    }

    setUploading(true);

    const filePath = `${session.user.id}/${Date.now()}-${crypto.randomUUID()}-${safeFileName(
      file.name
    )}`;

    const { error: uploadError } = await supabase.storage
      .from(MEDIA_BUCKET)
      .upload(filePath, file, {
        contentType: file.type,
        upsert: false,
      });

    if (uploadError) {
      setUploading(false);
      setError(uploadError.message);
      return;
    }

    const { error: messageError } = await supabase.from("messages").insert({
      sender_id: session.user.id,
      body: null,
      message_type: messageType,
      file_path: filePath,
      file_name: file.name,
      file_mime: file.type,
    });

    setUploading(false);

    if (messageError) {
  setError(messageError.message);
  return;
}

await sendPushNotification(messageType);
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) return;

    await uploadFile(file);

    event.target.value = "";
  }

  async function startRecording() {
    setError("");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      audioStreamRef.current = stream;
      audioChunksRef.current = [];

      const recorder = new MediaRecorder(stream);

      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const mimeType = recorder.mimeType || "audio/webm";
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });

        const voiceFile = new File(
          [audioBlob],
          `voice-note-${Date.now()}.webm`,
          { type: mimeType }
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

  const glassPanel = isDark
    ? "border-white/10 bg-slate-950/60 text-white shadow-2xl shadow-indigo-950/40"
    : "border-white/70 bg-white/65 text-slate-950 shadow-2xl shadow-sky-200/60";

  const inputClass = isDark
    ? "border-white/10 bg-white/10 text-white placeholder:text-white/45 focus:border-violet-300"
    : "border-sky-100 bg-white/80 text-slate-950 placeholder:text-slate-400 focus:border-sky-400";

  return (
    <main className="relative min-h-screen overflow-hidden">
      <SkyBackground theme={effectiveTheme} />

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />

      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={handleFileChange}
      />

      <div className="relative z-10 flex min-h-screen items-center justify-center p-4">
        {!session ? (
          <div
            className={`w-full max-w-sm rounded-3xl border p-6 backdrop-blur-xl transition ${glassPanel}`}
          >
            <div className="mb-6 text-center">
              <div className="mb-3 text-5xl">{isDark ? "🌙" : "☀️"}</div>
              <h1 className="text-3xl font-black tracking-tight">Private Chat</h1>
              <p className={isDark ? "mt-2 text-white/60" : "mt-2 text-slate-600"}>
                A cozy chat space for two people.
              </p>
            </div>

            <div className="mb-5 flex justify-center gap-2">
              <ThemeButton label="Auto" value="auto" selected={themeMode} onClick={setThemeMode} isDark={isDark} />
              <ThemeButton label="Light" value="light" selected={themeMode} onClick={setThemeMode} isDark={isDark} />
              <ThemeButton label="Dark" value="dark" selected={themeMode} onClick={setThemeMode} isDark={isDark} />
            </div>

            <input
              className={`mb-3 w-full rounded-2xl border p-4 outline-none transition ${inputClass}`}
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />

            <input
              className={`mb-4 w-full rounded-2xl border p-4 outline-none transition ${inputClass}`}
              placeholder="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            <button
              onClick={signIn}
              className={`mb-3 w-full rounded-2xl p-4 font-bold transition ${
                isDark
                  ? "bg-violet-400 text-slate-950 hover:bg-violet-300"
                  : "bg-slate-950 text-white hover:bg-slate-800"
              }`}
            >
              Login
            </button>

            <button
              onClick={signUp}
              className={`w-full rounded-2xl border p-4 font-bold transition ${
                isDark
                  ? "border-white/15 bg-white/10 text-white hover:bg-white/20"
                  : "border-slate-200 bg-white/70 text-slate-900 hover:bg-white"
              }`}
            >
              Sign up
            </button>

            {error && (
              <p
                className={`mt-4 rounded-2xl p-3 text-sm ${
                  isDark ? "bg-red-500/15 text-red-200" : "bg-red-100 text-red-700"
                }`}
              >
                {error}
              </p>
            )}
          </div>
        ) : (
          <div
            className={`flex h-[94vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border backdrop-blur-xl transition ${glassPanel}`}
          >
            <div
              className={`flex flex-wrap items-center justify-between gap-3 border-b p-4 ${
                isDark ? "border-white/10" : "border-white/70"
              }`}
            >
              <div className="flex items-center gap-3">
                <div className="text-3xl">{isDark ? "🌙" : "☀️"}</div>
                <div>
                  <h1 className="text-2xl font-black tracking-tight">Private Chat</h1>
                  <p className={isDark ? "text-sm text-white/55" : "text-sm text-slate-500"}>
                    {session.user.email}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <ThemeButton label="Auto" value="auto" selected={themeMode} onClick={setThemeMode} isDark={isDark} />
                <ThemeButton label="Light" value="light" selected={themeMode} onClick={setThemeMode} isDark={isDark} />
                <ThemeButton label="Dark" value="dark" selected={themeMode} onClick={setThemeMode} isDark={isDark} />
                <button
                  onClick={enableNotifications}
                  className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                    isDark
                      ? "bg-white/10 text-white hover:bg-white/20"
                      : "bg-white/70 text-slate-700 hover:bg-white"
                  }`}
                >
                  {notificationsOn ? "🔔 On" : "🔔 Enable"}
                </button>
                <button
                  onClick={signOut}
                  className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                    isDark
                      ? "bg-red-400/20 text-red-100 hover:bg-red-400/30"
                      : "bg-red-100 text-red-700 hover:bg-red-200"
                  }`}
                >
                  Logout
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {messages.length === 0 && (
                <div
                  className={`mx-auto mt-20 max-w-sm rounded-3xl p-6 text-center ${
                    isDark ? "bg-white/10 text-white/60" : "bg-white/60 text-slate-500"
                  }`}
                >
                  <div className="mb-3 text-4xl">{isDark ? "✨" : "☁️"}</div>
                  <p>No messages yet. Send the first one.</p>
                </div>
              )}

              {messages.map((message) => {
                const mine = message.sender_id === session.user.id;

                return (
                  <div
                    key={message.id}
                    className={`mb-4 flex ${mine ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[78%] rounded-3xl px-4 py-3 shadow-sm ${
                        mine
                          ? isDark
                            ? "bg-violet-400 text-slate-950"
                            : "bg-sky-500 text-white"
                          : isDark
                            ? "border border-white/10 bg-white/10 text-white"
                            : "border border-white/80 bg-white/75 text-slate-900"
                      }`}
                    >
                      <MessageContent message={message} />

                      <p
                        className={`mt-2 text-xs ${
                          mine
                            ? isDark
                              ? "text-slate-800/60"
                              : "text-white/70"
                            : isDark
                              ? "text-white/45"
                              : "text-slate-500"
                        }`}
                      >
                        {new Date(message.created_at).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                    </div>
                  </div>
                );
              })}

              <div ref={bottomRef} />
            </div>

            <div className={`border-t p-4 ${isDark ? "border-white/10" : "border-white/70"}`}>
              <div className="mb-3 flex flex-wrap gap-2">
                <button
                  onClick={() => imageInputRef.current?.click()}
                  disabled={uploading}
                  className={`rounded-full px-4 py-2 text-sm font-bold transition ${
                    isDark ? "bg-white/10 hover:bg-white/20" : "bg-white/70 hover:bg-white"
                  }`}
                >
                  📷 Photo
                </button>

                <button
                  onClick={() => videoInputRef.current?.click()}
                  disabled={uploading}
                  className={`rounded-full px-4 py-2 text-sm font-bold transition ${
                    isDark ? "bg-white/10 hover:bg-white/20" : "bg-white/70 hover:bg-white"
                  }`}
                >
                  🎥 Video
                </button>

                {!isRecording ? (
                  <button
                    onClick={startRecording}
                    disabled={uploading}
                    className={`rounded-full px-4 py-2 text-sm font-bold transition ${
                      isDark ? "bg-white/10 hover:bg-white/20" : "bg-white/70 hover:bg-white"
                    }`}
                  >
                    🎙️ Voice
                  </button>
                ) : (
                  <button
                    onClick={stopRecording}
                    className="rounded-full bg-red-500 px-4 py-2 text-sm font-bold text-white"
                  >
                    ⏹ Stop Recording
                  </button>
                )}

                {uploading && (
                  <span className={isDark ? "text-sm text-white/60" : "text-sm text-slate-500"}>
                    Uploading...
                  </span>
                )}
              </div>

              <div className="flex gap-3">
                <input
                  className={`flex-1 rounded-2xl border p-4 outline-none transition ${inputClass}`}
                  placeholder="Type a message..."
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") sendMessage();
                  }}
                />

                <button
                  onClick={sendMessage}
                  className={`rounded-2xl px-6 font-bold transition ${
                    isDark
                      ? "bg-violet-400 text-slate-950 hover:bg-violet-300"
                      : "bg-slate-950 text-white hover:bg-slate-800"
                  }`}
                >
                  Send
                </button>
              </div>

              {error && (
                <p
                  className={`mt-3 rounded-2xl p-3 text-sm ${
                    isDark ? "bg-red-500/15 text-red-200" : "bg-red-100 text-red-700"
                  }`}
                >
                  {error}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}