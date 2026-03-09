// ============================================================================
// firebase-messaging-sw.js — Firebase Cloud Messaging Service Worker
//
// MUST live at public/firebase-messaging-sw.js so Vite serves it from:
// http://localhost:5173/firebase-messaging-sw.js
// Firebase requires the SW to be at root scope — /firebase-messaging-sw.js
//
// Design decision: importScripts (not ES modules) because service workers
// don't support import.meta.env. Firebase compat builds support importScripts.
// ============================================================================

importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");

// These are PUBLIC values — safe to hardcode in SW (no VITE_ env available here)
firebase.initializeApp({
  apiKey:            "AIzaSyBo4KOY5LHhrauV9DshPxd2vYmeMcovURQ",
  authDomain:        "swachhmap-3a442.firebaseapp.com",
  projectId:         "swachhmap-3a442",
  storageBucket:     "swachhmap-3a442.firebasestorage.app",
  messagingSenderId: "310503591127",
  appId:             "1:310503591127:web:55e50ff321c1beefd93492",
});

const messaging = firebase.messaging();

// ── Background push handler ───────────────────────────────────────────────────
// Fires when push arrives and the app tab is NOT in the foreground.
// Foreground messages are handled in useFCM.js.
messaging.onBackgroundMessage((payload) => {
  const { title, body, icon, data } = payload.notification ?? {};
  self.registration.showNotification(title ?? "🌿 SwachhMap", {
    body:    body ?? "You have a new notification",
    icon:    icon ?? "/icons/icon-192.png",
    badge:   "/icons/badge-72.png",
    tag:     data?.reportId ?? "swachhmap",
    data:    data ?? {},
    actions: [
      { action: "view",    title: "View Report" },
      { action: "dismiss", title: "Dismiss"     },
    ],
    vibrate: [200, 100, 200],
  });
});

// ── Notification click → open/focus app ──────────────────────────────────────
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "dismiss") return;
  const url = event.notification.data?.reportId
    ? `/?report=${event.notification.data.reportId}`
    : "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && "focus" in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});