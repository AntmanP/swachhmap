// ============================================================================
// SwachhMap — lib/supabase.js
// Single source of truth for all Supabase interactions.
//
// Design decision: centralise ALL Supabase calls in this file.
// The React components never import @supabase/supabase-js directly.
// Benefits:
//   (1) Swap backend (e.g. Firebase) by changing only this file
//   (2) All error handling in one place
//   (3) Easy to add logging, retries, or caching layer here without touching UI
//   (4) TypeScript types can be added to all return values in one place
// ============================================================================

import { createClient } from "@supabase/supabase-js";

// ── Config ────────────────────────────────────────────────────────────────────
// Replace these with your actual Supabase project values.
// Find them in: Supabase Dashboard → Project Settings → API
// Design decision: these are PUBLIC keys — safe to commit.
// The anon key has no elevated privileges; RLS policies enforce all access control.
// NEVER put the service_role key here.
// These are read from your .env.local file.
// Vite exposes any variable prefixed with VITE_ to the browser via import.meta.env
export const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL;
export const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    persistSession:     true,
    autoRefreshToken:   true,
    detectSessionInUrl: true,
    storageKey:         "swachhmap-auth",
    // Disable Web Locks API — it causes indefinite hangs in some Chromium builds
    // and always causes issues when multiple Supabase clients exist in the same tab.
    // Safe to disable for a web app (locks are only critical for multi-tab token refresh race conditions).
    lock: (name, acquireTimeout, fn) => fn(),
  },
  realtime: {
    params: {
      eventsPerSecond: 10,  // throttle real-time events — mobile battery consideration
    },
  },
});

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function sendOTP(phone) {
  // phone must be E.164 format: +91XXXXXXXXXX
  const { error } = await supabase.auth.signInWithOtp({ phone });
  if (error) throw error;
}

export async function verifyOTP(phone, token) {
  const { data, error } = await supabase.auth.verifyOtp({
    phone,
    token,
    type: "sms",
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  await supabase.auth.signOut();
}

export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// ── Reports ───────────────────────────────────────────────────────────────────

// Submit a new report via Edge Function (not direct DB insert)
// Design decision: always go through the Edge Function for report submission.
// The Edge Function handles: image upload, points, duplicate detection, webhooks.
// A direct supabase.from('reports').insert() would bypass all of that.
export async function submitReport({
  imageBase64,
  imageMediaType,
  latitude,
  longitude,
  locationLabel,
  city,
  state,
  wasteType,
  subtype,
  severity,
  aiConfidence,
  hazardous,
  quantityEst,
  actionRec,
  tags,
  description,
}) {
  const { data, error } = await supabase.functions.invoke("submit-report", {
    body: {
      imageBase64, imageMediaType,
      latitude, longitude, locationLabel, city, state,
      wasteType, subtype, severity, aiConfidence, hazardous,
      quantityEst, actionRec, tags, description,
    },
  });
  if (error) throw error;
  return data;
}

// Fetch public feed (last 50 reports)
export async function getPublicFeed() {
  const { data, error } = await supabase
    .from("public_feed")   // uses the view defined in migration 001
    .select("*");
  if (error) throw error;
  return data ?? [];
}

// ── Leaderboard ───────────────────────────────────────────────────────────────

export async function getLeaderboard(city = null, limit = 20) {
  let query = supabase
    .from("leaderboard_monthly")
    .select("*")
    .limit(limit);

  if (city) query = query.eq("city", city);

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

// ── User profile ──────────────────────────────────────────────────────────────

export async function getUserStats(userId) {
  const { data, error } = await supabase.rpc("get_user_stats", {
    p_user_id: userId,
  });
  if (error) throw error;
  return data;
}

export async function onboardUser({ displayName, city, state }) {
  const { data, error } = await supabase.functions.invoke("onboard-user", {
    body: { displayName, city, state },
  });
  if (error) throw error;
  return data;
}

// ── Real-time subscriptions ───────────────────────────────────────────────────

// Subscribe to new reports in the public feed
// Design decision: Supabase Realtime broadcast (not postgres_changes).
// Postgres changes triggers on every DB write — expensive at scale.
// Broadcast is a lightweight pub/sub channel that the Edge Function
// explicitly pushes to. More control, lower overhead.
export function subscribeToFeed(onNewReport) {
  return supabase
    .channel("public-feed")
    .on("broadcast", { event: "new_report" }, ({ payload }) => {
      onNewReport(payload);
    })
    .subscribe();
}

// Subscribe to cleanup notifications for the current user
export function subscribeToCleanupNotifications(userId, onCleanup) {
  return supabase
    .channel(`user-${userId}`)
    .on("broadcast", { event: "cleanup_confirmed" }, ({ payload }) => {
      onCleanup(payload);
    })
    .subscribe();
}

// Unsubscribe from a channel
export function unsubscribe(channel) {
  supabase.removeChannel(channel);
}

// ── Impact stats ──────────────────────────────────────────────────────────────

export async function getImpactStats() {
  const [
    { count: totalReports },
    { count: cleanedReports },
    { count: totalUsers },
    { data: cityCount },
  ] = await Promise.all([
    supabase.from("reports").select("*", { count: "exact", head: true }),
    supabase.from("reports").select("*", { count: "exact", head: true }).eq("status", "cleaned"),
    supabase.from("users").select("*", { count: "exact", head: true }),
    supabase.from("reports").select("city").not("city", "is", null),
  ]);

  const uniqueCities = new Set((cityCount ?? []).map(r => r.city)).size;

  return {
    totalReports:   totalReports  ?? 0,
    cleanedReports: cleanedReports ?? 0,
    totalUsers:     totalUsers    ?? 0,
    citiesCovered:  uniqueCities,
  };
}