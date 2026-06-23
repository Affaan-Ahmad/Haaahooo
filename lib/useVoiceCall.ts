"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { sendPushNotification } from "@/lib/clientNotifications";
import { supabase } from "@/lib/supabaseClient";

type CallStatus = "ringing" | "accepted" | "rejected" | "ended" | "missed";
type CallPhase =
  | "idle"
  | "incoming"
  | "outgoing"
  | "connecting"
  | "active";

type VoiceCall = {
  id: string;
  conversation_id: string;
  caller_id: string;
  callee_id: string;
  status: CallStatus;
  created_at: string;
  answered_at: string | null;
  ended_at: string | null;
};

type VoiceSignal = {
  id: number;
  call_id: string;
  sender_id: string;
  signal_type: "offer" | "answer" | "ice";
  payload: RTCSessionDescriptionInit | RTCIceCandidateInit;
};

type ChatIdentity = {
  conversation_id: string;
  friend_id: string;
  display_name: string;
};

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export function useVoiceCall({
  userId,
  chats,
}: {
  userId: string | null;
  chats: ChatIdentity[];
}) {
  const [call, setCall] = useState<VoiceCall | null>(null);
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState("");
  const [durationSeconds, setDurationSeconds] = useState(0);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const signalChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(
    null,
  );
  const processedSignalsRef = useRef(new Set<number>());
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const callRef = useRef<VoiceCall | null>(null);

  useEffect(() => {
    callRef.current = call;
  }, [call]);

  const peerName =
    chats.find((chat) => chat.conversation_id === call?.conversation_id)
      ?.display_name ?? "Haaahooo user";

  const stopMedia = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
  }, []);

  const closePeer = useCallback(() => {
    peerRef.current?.close();
    peerRef.current = null;
    pendingCandidatesRef.current = [];
    processedSignalsRef.current.clear();
    stopMedia();
  }, [stopMedia]);

  const removeSignalChannel = useCallback(async () => {
    if (!signalChannelRef.current) return;
    await supabase.removeChannel(signalChannelRef.current);
    signalChannelRef.current = null;
  }, []);

  const resetCall = useCallback(async () => {
    closePeer();
    await removeSignalChannel();
    setCall(null);
    setPhase("idle");
    setMuted(false);
    setDurationSeconds(0);
  }, [closePeer, removeSignalChannel]);

  const sendSignal = useCallback(
    async (
      activeCall: VoiceCall,
      signalType: VoiceSignal["signal_type"],
      payload: VoiceSignal["payload"],
    ) => {
      if (!userId) return;
      const { error: signalError } = await supabase
        .from("voice_call_signals")
        .insert({
          call_id: activeCall.id,
          sender_id: userId,
          signal_type: signalType,
          payload,
        });
      if (signalError) throw signalError;
    },
    [userId],
  );

  const flushCandidates = useCallback(async () => {
    const peer = peerRef.current;
    if (!peer?.remoteDescription) return;
    for (const candidate of pendingCandidatesRef.current) {
      await peer.addIceCandidate(candidate);
    }
    pendingCandidatesRef.current = [];
  }, []);

  const handleSignal = useCallback(
    async (signal: VoiceSignal) => {
      if (!userId || signal.sender_id === userId) return;
      if (processedSignalsRef.current.has(signal.id)) return;
      processedSignalsRef.current.add(signal.id);

      const peer = peerRef.current;
      const activeCall = callRef.current;
      if (!peer || !activeCall || signal.call_id !== activeCall.id) return;

      try {
        if (signal.signal_type === "offer") {
          await peer.setRemoteDescription(
            signal.payload as RTCSessionDescriptionInit,
          );
          await flushCandidates();
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          await sendSignal(activeCall, "answer", answer);
        } else if (signal.signal_type === "answer") {
          if (!peer.remoteDescription) {
            await peer.setRemoteDescription(
              signal.payload as RTCSessionDescriptionInit,
            );
            await flushCandidates();
          }
        } else {
          const candidate = signal.payload as RTCIceCandidateInit;
          if (peer.remoteDescription) {
            await peer.addIceCandidate(candidate);
          } else {
            pendingCandidatesRef.current.push(candidate);
          }
        }
      } catch (signalError) {
        console.error("Voice signal failed:", signalError);
        setError("The voice connection could not be negotiated.");
      }
    },
    [flushCandidates, sendSignal, userId],
  );

  const subscribeToSignals = useCallback(
    async (activeCall: VoiceCall) => {
      await removeSignalChannel();
      processedSignalsRef.current.clear();

      const channel = supabase
        .channel(`voice-signals-${activeCall.id}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "voice_call_signals",
            filter: `call_id=eq.${activeCall.id}`,
          },
          (payload) => void handleSignal(payload.new as VoiceSignal),
        );
      signalChannelRef.current = channel;

      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error("Voice signaling timed out.")),
          10_000,
        );
        channel.subscribe((status) => {
          if (status === "SUBSCRIBED") {
            window.clearTimeout(timeout);
            resolve();
          } else if (
            status === "CHANNEL_ERROR" ||
            status === "TIMED_OUT" ||
            status === "CLOSED"
          ) {
            window.clearTimeout(timeout);
            reject(new Error("Voice signaling could not connect."));
          }
        });
      });

      const { data } = await supabase
        .from("voice_call_signals")
        .select("id, call_id, sender_id, signal_type, payload")
        .eq("call_id", activeCall.id)
        .order("id", { ascending: true });
      for (const signal of (data ?? []) as VoiceSignal[]) {
        await handleSignal(signal);
      }
    },
    [handleSignal, removeSignalChannel],
  );

  const createPeer = useCallback(
    async (activeCall: VoiceCall) => {
      closePeer();
      setError("");

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      localStreamRef.current = stream;

      const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      peerRef.current = peer;
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));

      peer.ontrack = (event) => {
        const [remoteStream] = event.streams;
        if (remoteAudioRef.current && remoteStream) {
          remoteAudioRef.current.srcObject = remoteStream;
          void remoteAudioRef.current.play().catch(() => undefined);
        }
      };

      peer.onicecandidate = (event) => {
        if (event.candidate) {
          void sendSignal(activeCall, "ice", event.candidate.toJSON());
        }
      };

      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "connected") {
          setPhase("active");
        } else if (peer.connectionState === "failed") {
          setError("The call connection failed. Try another network.");
          void supabase
            .from("voice_calls")
            .update({
              status: "ended",
              ended_at: new Date().toISOString(),
            })
            .eq("id", activeCall.id);
          void resetCall();
        }
      };

      await subscribeToSignals(activeCall);
      return peer;
    },
    [closePeer, resetCall, sendSignal, subscribeToSignals],
  );

  const startCall = useCallback(
    async (chat: ChatIdentity) => {
      if (!userId || phase !== "idle") return;
      setError("");
      let createdCall: VoiceCall | null = null;

      try {
        const { data, error: callError } = await supabase
          .from("voice_calls")
          .insert({
            conversation_id: chat.conversation_id,
            caller_id: userId,
            callee_id: chat.friend_id,
            status: "ringing",
          })
          .select("*")
          .single();
        if (callError) throw callError;

        const activeCall = data as VoiceCall;
        createdCall = activeCall;
        setCall(activeCall);
        callRef.current = activeCall;
        setPhase("outgoing");

        const peer = await createPeer(activeCall);
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await sendSignal(activeCall, "offer", offer);
        await sendPushNotification("call", chat.conversation_id);
      } catch (callError) {
        console.error("Start call failed:", callError);
        if (createdCall) {
          await supabase
            .from("voice_calls")
            .update({
              status: "ended",
              ended_at: new Date().toISOString(),
            })
            .eq("id", createdCall.id);
        }
        setError(
          callError instanceof DOMException &&
            callError.name === "NotAllowedError"
            ? "Microphone permission was denied."
            : "Could not start the voice call.",
        );
        await resetCall();
      }
    },
    [createPeer, phase, resetCall, sendSignal, userId],
  );

  const acceptCall = useCallback(async () => {
    const activeCall = callRef.current;
    if (!activeCall || !userId) return;

    try {
      setPhase("connecting");
      const answeredAt = new Date().toISOString();
      const { error: updateError } = await supabase
        .from("voice_calls")
        .update({ status: "accepted", answered_at: answeredAt })
        .eq("id", activeCall.id);
      if (updateError) throw updateError;

      const nextCall = {
        ...activeCall,
        status: "accepted" as const,
        answered_at: answeredAt,
      };
      setCall(nextCall);
      callRef.current = nextCall;
      await createPeer(nextCall);
    } catch (acceptError) {
      console.error("Accept call failed:", acceptError);
      await supabase
        .from("voice_calls")
        .update({
          status: "ended",
          ended_at: new Date().toISOString(),
        })
        .eq("id", activeCall.id);
      setError(
        acceptError instanceof DOMException &&
          acceptError.name === "NotAllowedError"
          ? "Microphone permission was denied."
          : "Could not answer the call.",
      );
      await resetCall();
    }
  }, [createPeer, resetCall, userId]);

  const finishCall = useCallback(
    async (status: "rejected" | "ended") => {
      const activeCall = callRef.current;
      if (activeCall) {
        await supabase
          .from("voice_calls")
          .update({
            status,
            ended_at: new Date().toISOString(),
          })
          .eq("id", activeCall.id);
      }
      await resetCall();
    },
    [resetCall],
  );

  const rejectCall = useCallback(
    () => finishCall("rejected"),
    [finishCall],
  );
  const endCall = useCallback(() => finishCall("ended"), [finishCall]);

  const toggleMute = useCallback(() => {
    const nextMuted = !muted;
    localStreamRef.current
      ?.getAudioTracks()
      .forEach((track) => (track.enabled = !nextMuted));
    setMuted(nextMuted);
  }, [muted]);

  useEffect(() => {
    if (!userId) return;

    function handleCallChange(nextCall: VoiceCall) {
      if (
        nextCall.caller_id !== userId &&
        nextCall.callee_id !== userId
      ) {
        return;
      }

      const current = callRef.current;
      if (
        nextCall.status === "ringing" &&
        nextCall.callee_id === userId &&
        !current
      ) {
        setCall(nextCall);
        callRef.current = nextCall;
        setPhase("incoming");
        return;
      }

      if (!current || current.id !== nextCall.id) return;
      setCall(nextCall);
      callRef.current = nextCall;

      if (
        nextCall.status === "rejected" ||
        nextCall.status === "ended" ||
        nextCall.status === "missed"
      ) {
        void resetCall();
      } else if (
        nextCall.status === "accepted" &&
        nextCall.caller_id === userId
      ) {
        setPhase((currentPhase) =>
          currentPhase === "active" ? "active" : "connecting",
        );
      }
    }

    const channel = supabase
      .channel(`voice-calls-${userId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "voice_calls" },
        (payload) => handleCallChange(payload.new as VoiceCall),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "voice_calls" },
        (payload) => handleCallChange(payload.new as VoiceCall),
      )
      .subscribe();

    void supabase
      .from("voice_calls")
      .select("*")
      .eq("callee_id", userId)
      .eq("status", "ringing")
      .gte("created_at", new Date(Date.now() - 60_000).toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (data && !callRef.current) handleCallChange(data as VoiceCall);
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [resetCall, userId]);

  useEffect(() => {
    if (phase !== "outgoing" || !call) return;

    const timeout = window.setTimeout(async () => {
      const activeCall = callRef.current;
      if (!activeCall || activeCall.status !== "ringing") return;
      await supabase
        .from("voice_calls")
        .update({
          status: "missed",
          ended_at: new Date().toISOString(),
        })
        .eq("id", activeCall.id);
      await resetCall();
    }, 45_000);

    return () => window.clearTimeout(timeout);
  }, [call, phase, resetCall]);

  useEffect(() => {
    if (phase !== "active") {
      setDurationSeconds(0);
      return;
    }
    const startedAt = call?.answered_at
      ? new Date(call.answered_at).getTime()
      : Date.now();
    const update = () =>
      setDurationSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [call?.answered_at, phase]);

  useEffect(() => {
    return () => {
      closePeer();
      void removeSignalChannel();
    };
  }, [closePeer, removeSignalChannel]);

  return {
    call,
    phase,
    peerName,
    muted,
    error,
    durationSeconds,
    remoteAudioRef,
    startCall,
    acceptCall,
    rejectCall,
    endCall,
    toggleMute,
  };
}
