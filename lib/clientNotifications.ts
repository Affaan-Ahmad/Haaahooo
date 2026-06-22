"use client";

import { supabase } from "@/lib/supabaseClient";

type MessageType = "text" | "image" | "video" | "audio";

const APP_VERSION_STORAGE_KEY = "haaahooo-app-version";

type AppVersionResponse = {
  version?: string;
};

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}

export function setupAutomaticAppUpdates() {
  if (!("serviceWorker" in navigator)) {
    return () => {};
  }

  let registration: ServiceWorkerRegistration | null = null;
  let disposed = false;
  let reloading = false;
  let updateInProgress = false;
  const hadControllerWhenOpened = Boolean(navigator.serviceWorker.controller);

  async function checkDeploymentVersion() {
    if (disposed || updateInProgress || reloading) return;

    updateInProgress = true;

    try {
      const response = await fetch(`/api/version?t=${Date.now()}`, {
        cache: "no-store",
      });

      if (!response.ok) return;

      const result = (await response.json()) as AppVersionResponse;
      const latestVersion = result.version;

      if (!latestVersion || latestVersion === "development") return;

      const installedVersion = localStorage.getItem(APP_VERSION_STORAGE_KEY);

      if (!installedVersion) {
        localStorage.setItem(APP_VERSION_STORAGE_KEY, latestVersion);
        return;
      }

      if (installedVersion !== latestVersion) {
        reloading = true;
        localStorage.setItem(APP_VERSION_STORAGE_KEY, latestVersion);
        window.location.reload();
      }
    } catch {
      // Stay on the current version while offline or during a deployment.
    } finally {
      updateInProgress = false;
    }
  }

  function activateWaitingWorker() {
    registration?.waiting?.postMessage({ type: "SKIP_WAITING" });
  }

  function handleUpdateFound() {
    const installingWorker = registration?.installing;

    if (!installingWorker) return;

    installingWorker.addEventListener("statechange", () => {
      if (
        installingWorker.state === "installed" &&
        navigator.serviceWorker.controller
      ) {
        activateWaitingWorker();
      }
    });
  }

  function handleControllerChange() {
    if (disposed || reloading || !hadControllerWhenOpened) return;

    reloading = true;
    window.location.reload();
  }

  function checkForUpdates() {
    if (document.visibilityState !== "visible") return;

    if (registration) {
      void registration.update().catch(() => {});
    }

    void checkDeploymentVersion();
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "visible") {
      checkForUpdates();
    }
  }

  navigator.serviceWorker.addEventListener(
    "controllerchange",
    handleControllerChange,
  );
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("focus", checkForUpdates);
  window.addEventListener("pageshow", checkForUpdates);

  void navigator.serviceWorker
    .register("/sw.js", { updateViaCache: "none" })
    .then((workerRegistration) => {
      if (disposed) return;

      registration = workerRegistration;
      registration.addEventListener("updatefound", handleUpdateFound);
      activateWaitingWorker();
      checkForUpdates();
    })
    .catch(() => {});

  const interval = window.setInterval(checkForUpdates, 10 * 60 * 1000);

  return () => {
    disposed = true;
    window.clearInterval(interval);
    registration?.removeEventListener("updatefound", handleUpdateFound);
    navigator.serviceWorker.removeEventListener(
      "controllerchange",
      handleControllerChange,
    );
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("focus", checkForUpdates);
    window.removeEventListener("pageshow", checkForUpdates);
  };
}

export async function setupPushNotifications() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service workers are not supported in this browser.");
  }

  if (!("PushManager" in window)) {
    throw new Error("Push notifications are not supported in this browser.");
  }

  if (!("Notification" in window)) {
    throw new Error("Notifications are not supported in this browser.");
  }

  const permission = await Notification.requestPermission();

  if (permission !== "granted") {
    throw new Error("Notifications were not allowed.");
  }

  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

  if (!publicKey) {
    throw new Error("Missing NEXT_PUBLIC_VAPID_PUBLIC_KEY.");
  }

  const registration = await navigator.serviceWorker.register("/sw.js", {
    updateViaCache: "none",
  });
  await navigator.serviceWorker.ready;

  let subscription = await registration.pushManager.getSubscription();

  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    throw new Error("Please login first.");
  }

  const response = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      subscription: subscription.toJSON(),
    }),
  });

  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(result?.error ?? "Could not save notification subscription.");
  }

  return true;
}

export async function sendPushNotification(messageType: MessageType) {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) return;

  await fetch("/api/push/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      messageType,
    }),
  });
}
