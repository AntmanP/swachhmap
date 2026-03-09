// ============================================================================
// useFCM.js — Firebase Cloud Messaging React Hook
//
// Handles:
//   1. Requesting notification permission from the browser
//   2. Getting the FCM device token
//   3. Saving that token to Supabase (so the Edge Function can target this device)
//   4. Listening for foreground messages (app is open) and showing a toast
//
// Design decisions:
//   - This is a hook, not a component — it runs silently in the background.
//     SwachhMap.jsx calls it once and gets back { permission, requestPermission }.
//   - Token is saved to a new `fcm_tokens` table in Supabase (migration below).
//   - We refresh the token on each mount — FCM tokens can rotate.
//   - DEV_MODE skips the actual Firebase calls to avoid errors during development.
// ============================================================================

import { useEffect, useState, useCallback } from "react";
import { initializeApp, getApps }           from "firebase/app";
import { getMessaging, getToken, onMessage } from "firebase/messaging";
import { supabase } from "../lib/supabase.js";

const FIREBASE_CONFIG = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        `${import.meta.env.VITE_FIREBASE_PROJECT_ID}.firebaseapp.com`,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     `${import.meta.env.VITE_FIREBASE_PROJECT_ID}.firebasestorage.app`,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY;

// Singleton Firebase app — safe to call multiple times
function getFirebaseApp() {
  if (getApps().length) return getApps()[0];
  return initializeApp(FIREBASE_CONFIG);
}

export function useFCM({ userId, devMode = true }) {
  const [permission, setPermission] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "default"
  );
  const [fcmToken, setFcmToken]       = useState(null);
  const [foregroundMsg, setForegroundMsg] = useState(null); // latest foreground push

  // ── Request permission + get token ─────────────────────────────────────────
  const requestPermission = useCallback(async () => {
    if (devMode) {
      // Simulate granted in dev mode — no real Firebase calls
      setPermission("granted");
      setFcmToken("dev-fcm-token-mock");
      return "granted";
    }

    if (typeof Notification === "undefined") return "unsupported";

    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") return result;

      const app       = getFirebaseApp();
      const messaging = getMessaging(app);

      // Get device token — this is what FCM uses to target this specific browser
      const token = await getToken(messaging, {
        vapidKey:          VAPID_KEY,
        serviceWorkerRegistration: await navigator.serviceWorker.register(
          "/firebase-messaging-sw.js"
        ),
      });

      setFcmToken(token);

      // Save token to Supabase so the send-push Edge Function can find it
      // Design: upsert on (user_id, token) — handles token refresh gracefully
      if (userId) {
        await supabase.from("fcm_tokens").upsert({
          user_id:    userId,
          token,
          platform:   "web",
          updated_at: new Date().toISOString(),
        }, { onConflict: "token" });
      }

      return result;
    } catch (err) {
      console.error("FCM permission error:", err);
      return "error";
    }
  }, [userId, devMode]);

  // ── Listen for foreground messages (app tab is open) ─────────────────────
  useEffect(() => {
    if (devMode || !fcmToken) return;

    const app       = getFirebaseApp();
    const messaging = getMessaging(app);

    const unsub = onMessage(messaging, (payload) => {
      console.log("[FCM] Foreground message:", payload);
      setForegroundMsg({
        title: payload.notification?.title ?? "SwachhMap",
        body:  payload.notification?.body  ?? "",
        data:  payload.data ?? {},
        ts:    Date.now(),
      });
      // Auto-clear after 5s
      setTimeout(() => setForegroundMsg(null), 5000);
    });

    return () => unsub();
  }, [fcmToken, devMode]);

  // ── Auto-register service worker on mount (silent) ───────────────────────
  // This ensures the SW is active even before the user grants permission,
  // so we're ready to show notifications the moment they do.
  useEffect(() => {
    if (devMode) return;
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/firebase-messaging-sw.js")
        .catch(err => console.warn("SW registration failed:", err));
    }
  }, [devMode]);

  return { permission, fcmToken, foregroundMsg, requestPermission };
}
