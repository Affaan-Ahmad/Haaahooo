"use client";

import { useEffect } from "react";

/**
 * App error boundary. If something throws during render, the user gets a
 * recover screen instead of a blank page. "Try again" re-renders; "Reload"
 * does a full reload (which also picks up a newer deploy).
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Haaahooo render error:", error);
  }, [error]);

  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: 24,
        textAlign: "center",
        background: "#0b1120",
        color: "#e2e8f0",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <div style={{ fontSize: 40 }}>🌀</div>
      <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
        Something went wrong
      </h2>
      <p style={{ fontSize: 14, opacity: 0.8, maxWidth: 320, margin: 0 }}>
        Haaahooo hit an unexpected error. Your messages are safe — try again or
        reload.
      </p>
      <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
        <button
          onClick={() => reset()}
          style={{
            padding: "8px 18px",
            borderRadius: 999,
            border: "none",
            background: "#1DB954",
            color: "#000",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: "8px 18px",
            borderRadius: 999,
            border: "1px solid rgba(255,255,255,0.2)",
            background: "transparent",
            color: "#e2e8f0",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Reload
        </button>
      </div>
    </div>
  );
}
