// SwachhMap.jsx — rename to exactly this (capital S, capital M) to match import
import { useState, useRef, useCallback, useEffect } from "react";
import MapView from "./MapView.jsx";
import StreakCard from "./components/StreakCard.jsx";
import { useFCM } from "./hooks/useFCM.js";
// ─── Supabase client ──────────────────────────────────────────────────────────
// Import the shared singleton — never call createClient() directly in components.
// Multiple GoTrueClient instances cause auth token lock conflicts.
import { supabase } from "./lib/supabase.js";

// ─── Vision API Config ────────────────────────────────────────────────────────
const VISION_PROVIDER = "mock"; // "claude" | "google" | "mock"

const WASTE_META = {
  "Plastic Waste":       { icon: "🛍️", points: 30, severityDefault: "High"     },
  "Food Waste":          { icon: "🍱", points: 20, severityDefault: "Medium"   },
  "E-Waste":             { icon: "📱", points: 50, severityDefault: "Critical" },
  "Construction Debris": { icon: "🧱", points: 35, severityDefault: "High"     },
  "Mixed Litter":        { icon: "🗑️", points: 25, severityDefault: "Medium"   },
  "Hazardous Waste":     { icon: "⚠️", points: 60, severityDefault: "Critical" },
  "Organic Waste":       { icon: "🌿", points: 15, severityDefault: "Low"      },
  "Medical Waste":       { icon: "🧪", points: 55, severityDefault: "Critical" },
};

const SEVERITY_COLORS = {
  Low: "#4ade80", Medium: "#fb923c", High: "#f87171", Critical: "#e11d48",
};

const RANK_BADGES = ["🏆", "🥈", "🥉", "⭐", "⭐", "⭐", "⭐", "⭐", "⭐", "⭐"];

// ─── Vision API (same swappable pattern as before) ────────────────────────────
async function analyzeWithClaude(base64Data, mediaType) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: `You are a waste classification engine for SwachhMap India. Respond ONLY with valid JSON:
{"type":"one of [Plastic Waste,Food Waste,E-Waste,Construction Debris,Mixed Litter,Hazardous Waste,Organic Waste,Medical Waste]","subtype":"brief label","severity":"Low|Medium|High|Critical","confidence":0-100,"quantity_estimate":"e.g. ~5kg","action_recommended":"e.g. Municipal pickup required","hazardous":true|false}
If no litter: {"type":"No Litter Detected","subtype":"Clean area","severity":"Low","confidence":95,"quantity_estimate":"none","action_recommended":"No action needed","hazardous":false}`,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
        { type: "text", text: "Analyze for litter. Return only JSON." }
      ]}]
    })
  });
  if (!response.ok) throw new Error(`Claude API error: ${response.status}`);
  const data = await response.json();
  return JSON.parse(data.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim());
}

async function analyzeWithMock() {
  await new Promise(r => setTimeout(r, 1800));
  const types = Object.keys(WASTE_META);
  const type = types[Math.floor(Math.random() * types.length)];
  return {
    type, subtype: "Mock detection — replace with real Vision API",
    severity: WASTE_META[type].severityDefault,
    confidence: 75 + Math.floor(Math.random() * 20),
    quantity_estimate: "~2–5kg", action_recommended: "Municipal pickup required",
    hazardous: type === "Hazardous Waste" || type === "Medical Waste",
  };
}

async function analyzeImage(imageDataUrl) {
  const [meta, base64Data] = imageDataUrl.split(",");
  const mediaType = meta.match(/data:(.*);base64/)?.[1] || "image/jpeg";
  let raw;
  try {
    raw = VISION_PROVIDER === "claude"
      ? await analyzeWithClaude(base64Data, mediaType)
      : await analyzeWithMock();
  } catch (err) {
    console.error("Vision API failed, using mock:", err);
    raw = await analyzeWithMock();
  }
  const m = WASTE_META[raw.type] || WASTE_META["Mixed Litter"];
  return { ...raw, points: m.points, icon: m.icon };
}

// ─── Accuracy formatter ──────────────────────────────────────────────────────
function formatAccuracy(metres) {
  if (metres < 50)   return `±${Math.round(metres)}m 🎯`;
  if (metres < 500)  return `±${Math.round(metres)}m`;
  if (metres < 5000) return `±${(metres/1000).toFixed(1)}km (use mobile for better accuracy)`;
  return `±${(metres/1000).toFixed(0)}km · IP-based, not GPS`;
}

// ─── Time formatter ───────────────────────────────────────────────────────────
function timeAgo(dateStr) {
  const diff = Math.floor((Date.now() - new Date(dateStr)) / 1000);
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function SwachhMap() {

  // ── Auth state ──────────────────────────────────────────────────────────────
  // authStep: loading | email | otp | onboard | done
  const [user, setUser]               = useState(null);
  const [authStep, setAuthStep]       = useState("loading");
  const [authMode, setAuthMode]       = useState("email");  // email | google
  const [email, setEmail]             = useState("");
  const [otp, setOtp]                 = useState("");
  const [displayName, setDisplayName] = useState("");
  const [city, setCity]               = useState("");
  const [authError, setAuthError]     = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [otpSent, setOtpSent]         = useState(false);

  // ── User profile (from DB) ──────────────────────────────────────────────────
  const [profile, setProfile] = useState(null);

  // ── FCM Push Notifications ──────────────────────────────────────────────────
  const { permission: notifPermission, foregroundMsg, requestPermission } = useFCM({
    userId:  user?.id,
    devMode: false,
  });

  // ── Report flow ─────────────────────────────────────────────────────────────
  const [tab, setTab]             = useState("report");
  const [step, setStep]           = useState("idle");
  const [preview, setPreview]     = useState(null);
  const [result, setResult]       = useState(null);
  const [tags, setTags]           = useState([]);
  const [tagInput, setTagInput]   = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted]   = useState(false);
  const [submitError, setSubmitError] = useState("");
  // GPS state — auto-captured when Report tab opens
  const [gpsCoords, setGpsCoords]   = useState(null);
  const [showUserMenu, setShowUserMenu] = useState(false);   // { lat, lng, accuracy }
  const [gpsStatus, setGpsStatus]   = useState("idle"); // idle | requesting | granted | denied | error
  const [cityFallback, setCityFallback] = useState(profile?.city ?? ""); // used if GPS denied
  const fileRef = useRef();

  // ── Feed, leaderboard, impact (from DB) ─────────────────────────────────────
  const [feed, setFeed]               = useState([]);
  const [leaderboard, setLeaderboard] = useState([]);
  const [impact, setImpact]           = useState(null);
  const [loading, setLoading]         = useState({ feed: true, leaderboard: true, impact: true });

  // ── 0. Keep Supabase awake — ping DB every 4 minutes to prevent cold starts ──
  useEffect(() => {
    const ping = () => supabase.from("users").select("id").limit(1).then(() => {});
    ping(); // immediate ping on mount
    const interval = setInterval(ping, 4 * 60 * 1000); // every 4 min
    return () => clearInterval(interval);
  }, []);

  // ── 1. Auth listener — single source of truth for session state ────────────
  // Fires on: page load (restores session from localStorage), sign in,
  // sign out, token refresh, and OAuth redirect callback.
  useEffect(() => {
    // Bootstrap: manually check session once on mount.
    // onAuthStateChange alone can hang if the Web Locks API stalls,
    // so we call getSession() directly as the primary path.
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      const u = session?.user ?? null;
      setUser(u);
      if (u) {
        const { data: prof } = await supabase
          .from("users").select("*").eq("id", u.id).single();
        if (prof) { setProfile(prof); setAuthStep("done"); }
        else {
          const meta = u.user_metadata ?? {};
          setDisplayName(meta.full_name ?? meta.name ?? "");
          setAuthStep("onboard");
        }
      } else {
        setAuthStep("email");
      }
    });

    // Also subscribe for future auth events (sign in, sign out, token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        // Ignore INITIAL_SESSION — already handled by getSession() above
        if (event === "INITIAL_SESSION") return;
        const u = session?.user ?? null;
        setUser(u);

        if (u) {
          const { data: prof } = await supabase
            .from("users").select("*").eq("id", u.id).single();
          if (prof) {
            setProfile(prof);
            setAuthStep("done");
          } else {
            const meta = u.user_metadata ?? {};
            setDisplayName(meta.full_name ?? meta.name ?? "");
            setAuthStep("onboard");
          }
        } else {
          setProfile(null);
          setAuthStep("email");
        }
      }
    );
    return () => subscription.unsubscribe();
  }, []);

  // ── 2. Load feed on mount + subscribe to real-time updates ───────────────────
  useEffect(() => {
    loadFeed();

    // Real-time: new reports appear instantly without refresh
    const channel = supabase
      .channel("public-feed")
      .on("broadcast", { event: "new_report" }, ({ payload }) => {
        setFeed(prev => [payload, ...prev].slice(0, 50));
      })
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, []);

  // ── 3. Reload leaderboard and impact every time those tabs are opened ─────────
  useEffect(() => {
    if (tab === "leaderboard") loadLeaderboard();
    if (tab === "impact")      loadImpact();
    if (tab === "feed")        loadFeed();
  }, [tab]);

  // ── 4. Subscribe to cleanup notifications for current user ───────────────────
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`user-${user.id}`)
      .on("broadcast", { event: "cleanup_confirmed" }, ({ payload }) => {
        // Refresh profile to get updated points
        refreshProfile();
        alert(`🎉 ${payload.message}`);
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [user]);

  // ── 5. Auto-capture GPS when Report tab opens ───────────────────────────────
  // Design decision: request GPS silently in the background the moment the user
  // opens the Report tab — by the time they finish photographing and AI analysis
  // (~2-3s), coordinates are already ready. Zero extra taps required.
  // Fallback: if denied, show city dropdown so the report is still useful.
  useEffect(() => {
    if (tab !== "report") return;
    // Always reset form when Report tab becomes active
    // This handles: first load, tab switch back, and post-submit navigation
    setStep("idle");
    setPreview(null);
    setResult(null);
    setTags([]);
    setTagInput("");
    setSubmitted(false);
    setSubmitError("");
    if (gpsStatus === "granted" || gpsStatus === "requesting") return;
    if (!("geolocation" in navigator)) { setGpsStatus("error"); return; }

    setGpsStatus("requesting");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
        setGpsStatus("granted");
      },
      (err) => {
        console.warn("[GPS] denied or error:", err.message);
        setGpsStatus(err.code === 1 ? "denied" : "error");
        // Pre-fill city fallback from profile
        setCityFallback(profile?.city ?? "");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }, [tab]);

  // ── Data loaders ─────────────────────────────────────────────────────────────

  // ── Reverse-geocode cache ────────────────────────────────────────────────────
  const geocodeCache = useRef({});

  async function reverseGeocode(location_label) {
    if (!location_label) return null;
    const parts = location_label.split(",").map(s => Number(s.trim()));
    if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;
    const [lat, lng] = parts;
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    if (geocodeCache.current[key]) return geocodeCache.current[key];
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=14&addressdetails=1`,
        { headers: { "Accept-Language": "en", "User-Agent": "SwachhMap/1.0" } }
      );
      const json = await res.json();
      const a = json.address ?? {};
      const area = a.suburb ?? a.neighbourhood ?? a.village ?? a.town ?? a.county ?? "";
      const cityName = a.city ?? a.town ?? a.state_district ?? a.state ?? "";
      const label = [area, cityName].filter(Boolean).join(", ") || null;
      geocodeCache.current[key] = label;
      return label;
    } catch { return null; }
  }

  async function loadFeed() {
    setLoading(l => ({ ...l, feed: true }));
    const timer = setTimeout(() => setLoading(l => ({ ...l, feed: false })), 8000);
    try {
      let { data, error } = await supabase
        .from("public_feed")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error || !data) {
        // Fallback: query reports directly
        ({ data } = await supabase
          .from("reports")
          .select("id, waste_type, severity, city, location_label, points_awarded, created_at, hazardous, users(display_name, level)")
          .order("created_at", { ascending: false })
          .limit(50));
      }
      const feedData = data ?? [];
      setFeed(feedData);
      // Enrich with real place names in background (1 req/sec — Nominatim TOS)
      feedData.forEach((item, i) => {
        if (!item.location_label) return;
        setTimeout(async () => {
          const place = await reverseGeocode(item.location_label);
          if (place) setFeed(prev => prev.map(f => f.id === item.id ? { ...f, _place: place } : f));
        }, i * 1100);
      });
    } catch (e) {
      console.warn("[feed]", e);
      setFeed([]);
    } finally {
      clearTimeout(timer);
      setLoading(l => ({ ...l, feed: false }));
    }
  }

  async function loadLeaderboard() {
    setLoading(l => ({ ...l, leaderboard: true }));
    // Safety timeout — never hang forever
    const timer = setTimeout(() => setLoading(l => ({ ...l, leaderboard: false })), 8000);
    try {
      let { data, error } = await supabase
        .from("leaderboard_monthly")
        .select("*")
        .limit(20);
      if (error || !data?.length) {
        ({ data } = await supabase
          .from("users")
          .select("id, display_name, city, points_total, reports_count, level")
          .order("points_total", { ascending: false })
          .limit(20));
      }
      setLeaderboard(data ?? []);
    } catch (e) {
      console.warn("[leaderboard]", e);
      setLeaderboard([]);
    } finally {
      clearTimeout(timer);
      setLoading(l => ({ ...l, leaderboard: false }));
    }
  }

  async function loadImpact() {
    setLoading(l => ({ ...l, impact: true }));
    const timer = setTimeout(() => setLoading(l => ({ ...l, impact: false })), 8000);
    try {
    // Run all queries in parallel — each result safely defaults on error
    const [r1, r2, r3, r4, r5] = await Promise.all([
      supabase.from("reports").select("*", { count: "exact", head: true }),
      supabase.from("reports").select("*", { count: "exact", head: true }).eq("status", "cleaned"),
      supabase.from("users").select("*",   { count: "exact", head: true }),
      supabase.from("reports").select("city").not("city", "is", null),
      supabase.from("reports").select("waste_type"),
    ]);
    const totalReports = r1.count;
    const cleaned = r2.count;
    const totalUsers = r3.count;
    const cities = r4.data;
    const wasteBreakdown = r5.data;

    // Count waste types client-side
    const typeCounts = {};
    (wasteBreakdown ?? []).forEach(r => {
      typeCounts[r.waste_type] = (typeCounts[r.waste_type] || 0) + 1;
    });
    const total = Object.values(typeCounts).reduce((a, b) => a + b, 0) || 1;
    const topTypes = Object.entries(typeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([type, count]) => ({
        type,
        pct: Math.round((count / total) * 100),
        color: { "Plastic Waste": "#f87171", "Food Waste": "#fb923c",
                 "Construction Debris": "#facc15", "E-Waste": "#60a5fa",
                 "Hazardous Waste": "#e11d48" }[type] || "#7dba5f",
      }));

    setImpact({
      totalReports:  totalReports  ?? 0,
      cleaned:       cleaned       ?? 0,
      totalUsers:    totalUsers    ?? 0,
      cities:        new Set((cities ?? []).map(r => r.city)).size,
      topTypes,
    });
    setLoading(l => ({ ...l, impact: false }));
    } catch (e) {
      console.warn("[impact]", e);
    } finally {
      clearTimeout(timer);
      setLoading(l => ({ ...l, impact: false }));
    }
  }

  async function refreshProfile() {
    if (!user) return;
    const { data } = await supabase.from("users").select("*").eq("id", user.id).single();
    if (data) setProfile(data);
  }

  // ── Auth handlers ─────────────────────────────────────────────────────────────

  // Email OTP — step 1: send magic link / OTP to email
  async function handleSendEmailOTP() {
    if (!email.trim()) { setAuthError("Please enter your email address"); return; }
    setAuthError("");
    setAuthLoading(true);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        // After clicking the magic link, redirect back to the app
        emailRedirectTo: window.location.origin,
        shouldCreateUser: true,  // auto-creates user on first sign-in
      },
    });
    if (error) setAuthError(error.message);
    else { setOtpSent(true); setAuthStep("otp"); }
    setAuthLoading(false);
  }

  // Email OTP — step 2: verify the 6-digit code from email
  async function handleVerifyEmailOTP() {
    if (!otp.trim()) { setAuthError("Please enter the code from your email"); return; }
    setAuthError("");
    setAuthLoading(true);
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: otp.trim(),
      type:  "email",
    });
    // onAuthStateChange fires automatically on success — no need to setUser here
    if (error) setAuthError(error.message);
    setAuthLoading(false);
  }

  // Google OAuth — opens Google sign-in popup, redirect handled by Supabase
  async function handleGoogleSignIn() {
    setAuthError("");
    setAuthLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin,
        queryParams: { prompt: "select_account" },
      },
    });
    if (error) { setAuthError(error.message); setAuthLoading(false); }
    // No setAuthLoading(false) on success — page redirects away
  }

  // Onboarding — direct DB upsert, no Edge Function needed.
  // The Edge Function was returning 401 due to JWT validation issues on cold start.
  // Direct insert works fine — RLS policy allows users to insert their own row
  // because auth.uid() === session.user.id at the time of the call.
  async function handleOnboard() {
    if (!displayName.trim()) { setAuthError("Please enter your name"); return; }
    setAuthError("");
    setAuthLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setAuthError("Session expired — please sign in again"); setAuthLoading(false); return; }

      const safeName = displayName.trim().replace(/[<>'"]/g, "").slice(0, 40) || "Anonymous";

      const { data: prof, error: dbErr } = await supabase
        .from("users")
        .upsert({
          id:           user.id,
          display_name: safeName,
          city:         city.trim().slice(0, 60) || null,
          email:        user.email ?? null,
        }, { onConflict: "id" })
        .select()
        .single();

      if (dbErr) {
        console.error("[onboard] DB error:", dbErr);
        // 406 means user already exists — just load their profile and proceed
        const { data: existing } = await supabase
          .from("users").select("*").eq("id", user.id).single();
        if (existing) {
          setProfile(existing);
          setAuthStep("done");
        } else {
          setAuthError(`Could not save profile: ${dbErr.message}`);
        }
      } else {
        setProfile(prof);
        setAuthStep("done");
      }
    } catch (err) {
      console.error("[onboard] unexpected error:", err);
      setAuthError(`Unexpected error: ${err.message}`);
    }
    setAuthLoading(false);
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    // Explicitly reset all state — don't rely on onAuthStateChange firing
    setUser(null);
    setProfile(null);
    setAuthStep("email");
    setEmail("");
    setOtp("");
    setGpsCoords(null);
    setGpsStatus("idle");
  }

  // Resend OTP
  async function handleResendOTP() {
    setOtp("");
    setOtpSent(false);
    setAuthStep("email");
  }

  // ── Report handlers ───────────────────────────────────────────────────────────

  const handleImage = useCallback(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      setPreview(ev.target.result);
      setStep("analyzing");
      setSubmitted(false);
      setResult(null);
      setSubmitError("");
      const analysis = await analyzeImage(ev.target.result);
      setResult(analysis);
      setStep("result");
    };
    reader.readAsDataURL(file);
  }, []);

  const addTag = () => {
    if (tagInput.trim() && !tags.includes(tagInput.trim())) {
      setTags(t => [...t, tagInput.trim()]);
      setTagInput("");
    }
  };

  async function handleSubmit() {
    if (!result || !user) return;
    setSubmitting(true);
    setSubmitError("");

    try {
      // Direct DB insert — Edge Function had persistent 401 JWT issues.
      // Points awarded via points_ledger insert; DB trigger syncs user totals.
      const pointsToAward = result.points ?? 25;

      // Reverse geocode GPS coords to get actual city name
      let resolvedCity = cityFallback || profile?.city || null;
      let locationLabel = null;
      if (gpsCoords) {
        locationLabel = `${gpsCoords.lat.toFixed(5)}, ${gpsCoords.lng.toFixed(5)}`;
        try {
          const geoRes = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${gpsCoords.lat}&lon=${gpsCoords.lng}&format=json&zoom=10&addressdetails=1`,
            { headers: { "Accept-Language": "en", "User-Agent": "SwachhMap/1.0" } }
          );
          const geoJson = await geoRes.json();
          const a = geoJson.address ?? {};
          resolvedCity = a.city ?? a.town ?? a.state_district ?? a.county ?? resolvedCity;
        } catch (e) { console.warn("Geocode failed:", e); }
      }

      const { data: report, error: reportErr } = await supabase
        .from("reports")
        .insert({
          user_id:        user.id,
          waste_type:     result.type,
          subtype:        result.subtype ?? null,
          severity:       result.severity,
          ai_confidence:  result.confidence,
          hazardous:      result.hazardous ?? false,
          quantity_est:   result.quantity_estimate ?? null,
          action_rec:     result.action_recommended ?? null,
          location_label: locationLabel ?? resolvedCity ?? null,
          city:           resolvedCity ?? null,
          status:         "pending",
          points_awarded: pointsToAward,
        })
        .select()
        .single();

      if (reportErr) throw new Error(reportErr.message);

      // Award points via secure server-side RPC — users cannot call this
      // directly to inflate their score. The function validates ownership.
      const { error: rpcErr } = await supabase.rpc("award_report_points", {
        p_report_id: report.id,
        p_points:    pointsToAward,
      });
      if (rpcErr) console.warn("[submit] points RPC failed:", rpcErr.message);

      // Update UI optimistically — reload profile to get authoritative value
      setProfile(p => ({
        ...p,
        points_total:  (p?.points_total  ?? 0) + pointsToAward,
        reports_count: (p?.reports_count ?? 0) + 1,
      }));
      // Reload from DB after short delay to confirm server-side value
      setTimeout(() => refreshProfile(), 1500);

      setSubmitted(true);
      // Auto-reset after 3 seconds so tapping another tab and back isn't needed
      setTimeout(() => {
        setStep("idle");
        setPreview(null);
        setResult(null);
        setTags([]);
        setTagInput("");
        setSubmitted(false);
        setSubmitError("");
      }, 3000);
    } catch (err) {
      console.error("[submit]", err);
      setSubmitError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  const reset = () => {
    setStep("idle");
    setPreview(null);
    setResult(null);
    setTags([]);
    setTagInput("");
    setSubmitted(false);
    setSubmitError("");
    // GPS coords intentionally kept — still valid for next report in same session
  };

  // ── Derived values ────────────────────────────────────────────────────────────
  const pts      = profile?.points_total ?? 0;
  // Use live report count from DB, fall back to profile cache
  const myReportCount = profile?.reports_count ?? 0;
  const level    = profile?.level ?? "Spotter";
  const levelNext = pts < 500 ? 500 : pts < 1500 ? 1500 : pts < 3000 ? 3000 : 5000;
  const progress  = Math.min((pts / levelNext) * 100, 100);
  const initials  = (profile?.display_name ?? "?").split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();

  // ── Auth + Loading screens ────────────────────────────────────────────────────
  if (authStep !== "done") {
    return (
      <div style={styles.root}>
        <div style={styles.bgNoise} />
        <div style={styles.authWrap}>

          {/* Loading — session restore on page load */}
          {authStep === "loading" && (
            <div style={{ textAlign:"center", color:"#4a6b4e" }}>
              <div style={{ fontSize:48, marginBottom:16 }}>🌿</div>
              <div style={{ fontSize:14, animation:"spin 1s linear infinite", display:"inline-block" }}>⟳</div>
            </div>
          )}

          {/* Email + Google sign-in card */}
          {(authStep === "email" || authStep === "otp") && (
            <div style={styles.authCard}>
              <div style={{ textAlign:"center", marginBottom:28 }}>
                <div style={{ fontSize:48 }}>🌿</div>
                <div style={styles.logo}>SwachhMap</div>
                <div style={{ fontSize:12, color:"#5a7d5e", marginTop:4 }}>Clean India, One Report at a Time</div>
              </div>

              {authStep === "email" && (
                <>
                  {/* Google OAuth button */}
                  <button style={styles.googleBtn} onClick={handleGoogleSignIn} disabled={authLoading}>
                    <svg width="18" height="18" viewBox="0 0 48 48" style={{ flexShrink:0 }}>
                      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                    </svg>
                    {authLoading && authMode === "google" ? "Redirecting…" : "Continue with Google"}
                  </button>

                  <div style={styles.dividerRow}>
                    <div style={styles.dividerLine}/><span style={styles.dividerText}>or use email</span><div style={styles.dividerLine}/>
                  </div>

                  {/* Email OTP */}
                  <label style={styles.label}>📧 Email Address</label>
                  <input style={{ ...styles.input, marginBottom: 8 }}
                    type="email" placeholder="you@example.com"
                    value={email} onChange={e => setEmail(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleSendEmailOTP()} />
                  {authError && <div style={styles.authError}>{authError}</div>}
                  <button style={{ ...styles.submitBtn, width:"100%", marginTop:8 }}
                    onClick={handleSendEmailOTP} disabled={authLoading}>
                    {authLoading && authMode === "email" ? "Sending…" : "Send Sign-in Code →"}
                  </button>
                  <div style={{ fontSize:11, color:"#3a5a3e", textAlign:"center", marginTop:10 }}>
                    We'll email you a sign-in link — no password needed
                  </div>
                </>
              )}

              {authStep === "otp" && (
                <>
                  <div style={{ fontSize:13, color:"#7dba5f", fontWeight:600, marginBottom:4 }}>
                    📧 Email sent to {email}
                  </div>
                  <div style={{ fontSize:11, color:"#4a6b4e", marginBottom:16 }}>
                    Check your inbox and click the sign-in link. Or enter the 6-digit code if you got one.
                  </div>
                  <label style={styles.label}>6-digit code (if shown in email)</label>
                  <input
                    style={{ ...styles.input, letterSpacing:10, fontSize:22, textAlign:"center", marginBottom:8 }}
                    placeholder="000000" maxLength={6} value={otp}
                    onChange={e => setOtp(e.target.value.replace(/\D/g,""))}
                    onKeyDown={e => e.key === "Enter" && handleVerifyEmailOTP()}
                    autoFocus />
                  {authError && <div style={styles.authError}>{authError}</div>}
                  <button style={{ ...styles.submitBtn, width:"100%", marginTop:8 }}
                    onClick={handleVerifyEmailOTP} disabled={authLoading || otp.length < 6}>
                    {authLoading ? "Verifying…" : "Verify & Sign In →"}
                  </button>
                  <button style={{ ...styles.resetBtn, width:"100%", marginTop:8 }}
                    onClick={handleResendOTP}>
                    ← Try a different email
                  </button>
                </>
              )}
            </div>
          )}

          {/* Onboarding — first time user, set name + city */}
          {authStep === "onboard" && (
            <div style={styles.authCard}>
              <div style={{ textAlign:"center", marginBottom:24 }}>
                <div style={{ fontSize:40 }}>👋</div>
                <div style={{ fontFamily:"'Syne',sans-serif", fontSize:20, fontWeight:800, color:"#7dba5f", marginTop:8 }}>
                  Welcome to SwachhMap!
                </div>
                <div style={{ fontSize:12, color:"#4a6b4e", marginTop:4 }}>
                  Just two quick things before you start reporting
                </div>
              </div>

              <label style={styles.label}>Your Name</label>
              <input style={{ ...styles.input, marginBottom:12 }}
                placeholder="e.g. Priya Sharma"
                value={displayName} onChange={e => setDisplayName(e.target.value)} />

              <label style={styles.label}>Your City</label>
              <select style={{ ...styles.input, marginBottom:16, cursor:"pointer" }}
                value={city} onChange={e => setCity(e.target.value)}>
                <option value="">Select your city…</option>
                {["Mumbai","Delhi","Bengaluru","Chennai","Hyderabad","Pune","Kolkata",
                  "Ahmedabad","Jaipur","Surat","Lucknow","Kanpur","Nagpur","Indore",
                  "Bhopal","Patna","Vadodara","Coimbatore","Agra","Other"].map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>

              {authError && <div style={styles.authError}>{authError}</div>}

              <button style={{ ...styles.submitBtn, width:"100%", opacity: displayName.trim() ? 1 : 0.5 }}
                onClick={handleOnboard} disabled={authLoading || !displayName.trim()}>
                {authLoading ? "Setting up your profile…" : "Start Reporting 🌿"}
              </button>

              <div style={{ fontSize:11, color:"#3a5a3e", textAlign:"center", marginTop:12 }}>
                You earn points for every report · Help keep India clean
              </div>
            </div>
          )}

        </div>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@300;400;500&display=swap');
          @keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
          select option { background: #131f14; color: #c8e6c0; }
        `}</style>
      </div>
    );
  }

  // ── Main app ──────────────────────────────────────────────────────────────────
  return (
    <div style={styles.root}>
      <div style={styles.bgNoise} />

      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={styles.logo}>🌿 SwachhMap</span>
          <span style={styles.tagline}>Clean India, One Report at a Time</span>
        </div>
        <div style={{ position: "relative" }}>
          <div style={styles.userBadge} onClick={() => setShowUserMenu(m => !m)}>
            <div style={styles.avatarCircle}>{initials}</div>
            <div>
              <div style={styles.userName}>{profile?.display_name ?? "…"}</div>
              <div style={styles.userLevel}>{level} · {pts} pts</div>
            </div>
          </div>
          {showUserMenu && (
            <>
              {/* Invisible overlay to catch outside clicks */}
              <div style={{ position:"fixed", inset:0, zIndex:99 }} onClick={() => setShowUserMenu(false)} />
              <div style={{ position:"absolute", right:0, top:"100%", marginTop:6, background:"#131f14", border:"1px solid #2a4a2e", borderRadius:12, padding:"6px 0", zIndex:100, minWidth:160, boxShadow:"0 4px 20px #00000088" }}>
                <div style={{ padding:"8px 16px", fontSize:12, color:"#4a6b4e", borderBottom:"1px solid #1f3322" }}>
                  {user?.email ?? ""}
                </div>
                <button
                  style={{ width:"100%", padding:"10px 16px", background:"none", border:"none", color:"#f87171", fontSize:13, cursor:"pointer", textAlign:"left", fontFamily:"'DM Sans',sans-serif" }}
                  onClick={handleSignOut}>
                  🚪 Sign out
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      {/* Level progress bar */}
      <div style={styles.progressBar}>
        <div style={{ ...styles.progressFill, width: `${progress}%` }} />
      </div>

      {/* Stats strip — all from real DB */}
      <div style={styles.statsStrip}>
        {[
          { label: "My Reports", val: myReportCount },
          { label: "Points",     val: pts },
          { label: "Level",      val: level },
          { label: "Streak",     val: `${profile?.streak_days ?? 0}d 🔥` },
        ].map(s => (
          <div key={s.label} style={styles.statItem}>
            <span style={styles.statVal}>{s.val}</span>
            <span style={styles.statLabel}>{s.label}</span>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <nav style={styles.tabs}>
        {["report", "map", "feed", "leaderboard", "impact", "streak"].map(t => (
          <button key={t}
            style={{ ...styles.tab, ...(tab === t ? styles.tabActive : {}) }}
            onClick={() => setTab(t)}>
            {{ report: "📸 Report", map: "🗺️ Map", feed: "🌍 Feed", leaderboard: "🏆 Leaders", impact: "📊 Impact", streak: "🔥 Streak" }[t]}
          </button>
        ))}
      </nav>

      <main style={styles.main}>

        {/* ── REPORT TAB ── */}
        {tab === "report" && (
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Report Litter Near You</h2>
            <p style={styles.cardSub}>Photograph it. Tag it. Earn points. Make change.</p>

            {step === "idle" && (
              <div style={styles.uploadZone} onClick={() => fileRef.current.click()}>
                <div style={styles.uploadIcon}>📷</div>
                <div style={styles.uploadText}>Tap to photograph litter</div>
                <div style={styles.uploadHint}>or drag & drop an image</div>
                <input ref={fileRef} type="file" accept="image/*" capture="environment"
                  style={{ display: "none" }} onChange={handleImage} />
              </div>
            )}

            {step === "analyzing" && (
              <div style={styles.analyzing}>
                <div style={styles.previewWrap}>
                  <img src={preview} alt="Uploaded" style={styles.previewImg} />
                  <div style={styles.scanOverlay}><div style={styles.scanLine} /></div>
                </div>
                <div style={styles.analyzingText}><span style={styles.spinner}>⟳</span> AI analyzing image…</div>
                <div style={styles.providerBadge}>powered by {VISION_PROVIDER === "claude" ? "Claude Vision" : "Mock AI (dev)"}</div>
              </div>
            )}

            {step === "result" && result && (
              <div>
                <div style={styles.resultGrid}>
                  <img src={preview} alt="Uploaded" style={styles.resultImg} />
                  <div style={styles.resultInfo}>
                    <div style={styles.resultType}>
                      <span style={styles.resultIcon}>{result.icon}</span>
                      <span style={styles.resultTypeName}>{result.type}</span>
                    </div>
                    <div style={styles.resultSubtype}>{result.subtype}</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                      <span style={{ ...styles.pill, background: SEVERITY_COLORS[result.severity] + "22", color: SEVERITY_COLORS[result.severity], border: `1px solid ${SEVERITY_COLORS[result.severity]}55` }}>
                        {result.severity} severity
                      </span>
                      <span style={{ ...styles.pill, background: "#84cc1622", color: "#84cc16", border: "1px solid #84cc1655" }}>
                        {result.confidence}% confident
                      </span>
                      {result.hazardous && (
                        <span style={{ ...styles.pill, background: "#e11d4822", color: "#e11d48", border: "1px solid #e11d4855" }}>⚠️ Hazardous</span>
                      )}
                    </div>
                    {result.quantity_estimate && result.quantity_estimate !== "none" && (
                      <div style={styles.resultMeta}>📦 <strong>{result.quantity_estimate}</strong></div>
                    )}
                    {result.action_recommended && (
                      <div style={styles.resultMeta}>🔧 {result.action_recommended}</div>
                    )}
                    <div style={styles.pointsEarn}>+{result.points} points on submit</div>
                  </div>
                </div>

                {/* ── GPS / Location block ── */}
                <div style={styles.fieldGroup}>
                  <label style={styles.label}>📍 Location</label>

                  {/* GPS granted — show coordinates, no user input needed */}
                  {gpsStatus === "granted" && gpsCoords && (
                    <div style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 14px", background:"#0d1f10", border:"1px solid #2a5a2e", borderRadius:10 }}>
                      <span style={{ fontSize:20 }}>✅</span>
                      <div>
                        <div style={{ fontSize:12, fontWeight:600, color:"#4ade80" }}>GPS locked</div>
                        <div style={{ fontSize:11, color:"#4a6b4e", marginTop:2 }}>
                          {gpsCoords.lat.toFixed(5)}°N, {gpsCoords.lng.toFixed(5)}°E · {formatAccuracy(gpsCoords.accuracy)}
                        </div>
                      </div>
                      <button style={{ marginLeft:"auto", background:"none", border:"none", color:"#3a5a3e", fontSize:11, cursor:"pointer" }}
                        onClick={() => { setGpsCoords(null); setGpsStatus("idle"); }}>
                        ↺ Retry
                      </button>
                    </div>
                  )}

                  {/* Requesting — spinner */}
                  {gpsStatus === "requesting" && (
                    <div style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 14px", background:"#131f14", border:"1px solid #2a4a2e", borderRadius:10 }}>
                      <span style={{ fontSize:16, animation:"spin 1s linear infinite", display:"inline-block" }}>⟳</span>
                      <div style={{ fontSize:12, color:"#7dba5f" }}>Getting your location…</div>
                    </div>
                  )}

                  {/* Denied or error — show city dropdown fallback */}
                  {(gpsStatus === "denied" || gpsStatus === "error") && (
                    <div>
                      <div style={{ fontSize:11, color:"#fb923c", marginBottom:8 }}>
                        {gpsStatus === "denied" ? "⚠️ Location access denied — select your city instead:" : "⚠️ GPS unavailable — select your city:"}
                      </div>
                      <select style={{ ...styles.input, cursor:"pointer" }}
                        value={cityFallback} onChange={e => setCityFallback(e.target.value)}>
                        <option value="">Select city…</option>
                        {["Mumbai","Delhi","Bengaluru","Chennai","Hyderabad","Pune","Kolkata",
                          "Ahmedabad","Jaipur","Surat","Lucknow","Kanpur","Nagpur","Indore",
                          "Bhopal","Patna","Vadodara","Coimbatore","Agra","Other"].map(c => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Idle — shouldn't show long but just in case */}
                  {gpsStatus === "idle" && (
                    <div style={{ fontSize:11, color:"#4a6b4e", padding:"10px 0" }}>Waiting for location…</div>
                  )}
                </div>

                <div style={styles.fieldGroup}>
                  <label style={styles.label}>🏷️ Add Tags</label>
                  <div style={styles.tagRow}>
                    <input style={{ ...styles.input, flex: 1 }}
                      placeholder="e.g. roadside, drain, school zone"
                      value={tagInput} onChange={e => setTagInput(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && addTag()} />
                    <button style={styles.addTagBtn} onClick={addTag}>+ Add</button>
                  </div>
                  <div style={styles.tagList}>
                    {tags.map(tag => (
                      <span key={tag} style={styles.tag}>
                        #{tag}
                        <button style={styles.tagX} onClick={() => setTags(t => t.filter(x => x !== tag))}>×</button>
                      </span>
                    ))}
                  </div>
                </div>

                {submitError && <div style={styles.authError}>{submitError}</div>}

                {!submitted ? (
                  <div style={{ display: "flex", gap: 10 }}>
                    <button style={{ ...styles.submitBtn, opacity: submitting ? 0.6 : 1 }}
                      onClick={handleSubmit} disabled={submitting}>
                      {submitting ? "⏳ Submitting…" : "✅ Submit Report"}
                    </button>
                    <button style={styles.resetBtn} onClick={reset}>↺ Retake</button>
                  </div>
                ) : (
                  <div style={styles.successBox}>
                    <div style={styles.successTitle}>🎉 Report Submitted!</div>
                    <div style={styles.successText}>
                      You earned <strong>+{result.points} points</strong>. Your report has been logged and sent to local partners.
                    </div>
                    <button style={styles.submitBtn} onClick={reset}>Report Another</button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── MAP TAB — litter heatmap + GPS ── */}
        {/* key prop forces full remount when switching to map tab — prevents HMR stale instances */}
        {tab === "map" && (
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>🗺️ Litter Heatmap</h2>
            <p style={styles.cardSub}>Live reports across India · Tap 📍 to find your location</p>
            <MapView
              key="map-view"
              devMode={false}
              onLocationCaptured={(coords) => {
                setGpsCoords(coords);
                setGpsStatus("granted");
              }}
            />
            {gpsCoords && (
              <div style={{ marginTop: 12, padding: "10px 14px", background: "#0d1f10", border: "1px solid #2a5a2e", borderRadius: 10 }}>
                <div style={{ fontSize: 12, color: "#7dba5f", fontWeight: 600 }}>✅ GPS captured for your next report</div>
                <div style={{ fontSize: 11, color: "#4a6b4e", marginTop: 2 }}>
                  {gpsCoords.lat.toFixed(5)}°N, {gpsCoords.lng.toFixed(5)}°E · {formatAccuracy(gpsCoords.accuracy)}
                </div>
                <div style={{ fontSize: 11, color: "#3a5a3e", marginTop: 4 }}>
                  Switch to 📸 Report tab — your location is pre-filled.
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── FEED TAB — real data from public_feed view ── */}
        {tab === "feed" && (
          <div>
            <div style={styles.feedHeader}>
              <h2 style={styles.cardTitle}>Live Reports Across India</h2>
              <span style={styles.liveTag}>● LIVE</span>
            </div>

            {loading.feed ? (
              <div style={styles.loadingMsg}>Loading feed…</div>
            ) : feed.length === 0 ? (
              <div style={styles.emptyMsg}>
                <div style={{ fontSize: 36 }}>📭</div>
                <div>No reports yet. Be the first!</div>
              </div>
            ) : feed.map((item, i) => (
              <div key={item.id ?? i} style={styles.feedCard}>
                <div style={styles.feedEmoji}>
                  {WASTE_META[item.waste_type]?.icon ?? "🗑️"}
                </div>
                <div style={styles.feedBody}>
                  <div style={styles.feedTop}>
                    <span style={styles.feedUser}>{item.reporter_name}</span>
                    {(item._place || item.city) && <span style={styles.feedCity}>📍 {item._place ?? item.city}</span>}
                    <span style={styles.feedTime}>{timeAgo(item.created_at)}</span>
                  </div>
                  <div style={styles.feedType}>{item.waste_type}</div>
                  <div style={styles.feedActions}>
                    <span style={{ ...styles.pill, background: SEVERITY_COLORS[item.severity] + "22", color: SEVERITY_COLORS[item.severity], border: `1px solid ${SEVERITY_COLORS[item.severity]}33` }}>
                      {item.severity}
                    </span>
                    <span style={styles.feedPoints}>+{item.points_awarded} pts</span>
                    {item.status === "cleaned" && <span style={{ fontSize: 12, color: "#4ade80" }}>✅ Cleaned</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── LEADERBOARD TAB — real data from leaderboard_monthly view ── */}
        {tab === "leaderboard" && (
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>🏆 Top Reporters This Month</h2>
            <p style={styles.cardSub}>India-wide rankings · Updated hourly</p>

            {loading.leaderboard ? (
              <div style={styles.loadingMsg}>Loading leaderboard…</div>
            ) : leaderboard.length === 0 ? (
              <div style={styles.emptyMsg}>
                <div style={{ fontSize: 36 }}>🏆</div>
                <div>No reports this month yet — you could be #1!</div>
              </div>
            ) : leaderboard.map((u, i) => (
              <div key={u.id}
                style={{ ...styles.leaderRow, ...(i === 0 ? styles.leaderFirst : {}),
                  ...(u.id === user?.id ? { background: "#1a3a1c", borderRadius: 10 } : {}) }}>
                <span style={styles.leaderRank}>{RANK_BADGES[i] ?? "·"}</span>
                <div style={styles.leaderAvatar}>
                  {(u.display_name ?? "?").split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase()}
                </div>
                <div style={styles.leaderInfo}>
                  <div style={styles.leaderName}>
                    {u.display_name} {u.id === user?.id && <span style={{ fontSize: 10, color: "#a3e635" }}>(you)</span>}
                  </div>
                  <div style={styles.leaderCity}>{u.city} · {(u.reports_this_month ?? u.reports_count ?? 0)} reports</div>
                </div>
                <div style={styles.leaderPoints}>
                  {(u.points_this_month ?? u.points_total ?? 0).toLocaleString()}
                  <span style={styles.ptLabel}> pts</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── IMPACT TAB — real aggregated data ── */}
        {tab === "impact" && (
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>📊 SwachhMap Impact</h2>
            <p style={styles.cardSub}>Real data driving real cleanups</p>

            {loading.impact || !impact ? (
              <div style={styles.loadingMsg}>Loading impact data…</div>
            ) : (
              <>
                <div style={styles.impactGrid}>
                  {[
                    { val: impact.totalReports.toLocaleString(), label: "Reports Filed",        icon: "📍" },
                    { val: impact.cleaned.toLocaleString(),      label: "Cleanups Confirmed",   icon: "🧹" },
                    { val: impact.totalUsers.toLocaleString(),   label: "Active Citizens",       icon: "👥" },
                    { val: impact.cities,                        label: "Cities Covered",        icon: "🏙️" },
                  ].map(item => (
                    <div key={item.label} style={styles.impactCard}>
                      <div style={styles.impactIcon}>{item.icon}</div>
                      <div style={styles.impactVal}>{item.val}</div>
                      <div style={styles.impactLabel}>{item.label}</div>
                    </div>
                  ))}
                </div>

                {impact.topTypes.length > 0 && (
                  <div style={styles.wasteBreakdown}>
                    <h3 style={styles.sectionTitle}>Top Reported Waste Types</h3>
                    {impact.topTypes.map(w => (
                      <div key={w.type} style={styles.wasteRow}>
                        <span style={styles.wasteType}>{w.type}</span>
                        <div style={styles.wasteBarBg}>
                          <div style={{ ...styles.wasteBarFill, width: `${w.pct}%`, background: w.color }} />
                        </div>
                        <span style={styles.wastePct}>{w.pct}%</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </main>

        {/* ── STREAK TAB ── */}
        {tab === "streak" && (
          <div>
            <StreakCard profile={profile} devMode={false} />

            {/* Push notification opt-in card */}
            <div style={styles.card}>
              <h2 style={styles.cardTitle}>🔔 Report Notifications</h2>
              <p style={styles.cardSub}>Get notified when your reports are cleaned up and bonus points are awarded.</p>

              {notifPermission === "granted" ? (
                <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 14px", background:"#0d1f10", border:"1px solid #2a5a2e", borderRadius:10 }}>
                  <span style={{ fontSize:24 }}>✅</span>
                  <div>
                    <div style={{ fontSize:13, fontWeight:600, color:"#4ade80" }}>Notifications enabled</div>
                    <div style={{ fontSize:11, color:"#4a6b4e", marginTop:2 }}>You'll hear when your report leads to a cleanup 🎉</div>
                  </div>
                </div>
              ) : notifPermission === "denied" ? (
                <div style={{ padding:"12px 14px", background:"#2d101044", border:"1px solid #e11d4844", borderRadius:10 }}>
                  <div style={{ fontSize:13, color:"#f87171", fontWeight:600 }}>Notifications blocked</div>
                  <div style={{ fontSize:11, color:"#5a7d5e", marginTop:4 }}>
                    To enable: click the 🔒 icon in your browser address bar → Notifications → Allow
                  </div>
                </div>
              ) : (
                <button style={{ ...styles.submitBtn, width:"100%" }} onClick={requestPermission}>
                  🔔 Enable Push Notifications
                </button>
              )}
            </div>
          </div>
        )}

      {/* FCM foreground message toast */}
      {foregroundMsg && (
        <div style={{ position:"fixed", top:16, left:"50%", transform:"translateX(-50%)", zIndex:9999, background:"#131f14", border:"1px solid #2a5a2e", borderRadius:14, padding:"14px 18px", maxWidth:340, boxShadow:"0 4px 20px #00000088", animation:"fadeIn 0.3s ease" }}>
          <div style={{ fontSize:14, fontWeight:700, color:"#a3e635", marginBottom:4 }}>{foregroundMsg.title}</div>
          <div style={{ fontSize:12, color:"#7dba5f" }}>{foregroundMsg.body}</div>
        </div>
      )}

      <footer style={styles.footer}>
        Built for Swachh Bharat · Open data for municipalities & NGOs · 🇮🇳
      </footer>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:wght@300;400;500&display=swap');
        @keyframes scanMove { 0%{top:0} 100%{top:100%} }
        @keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
      `}</style>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = {
  root: { minHeight: "100vh", background: "#0f1a10", color: "#e8f0e9", fontFamily: "'DM Sans', sans-serif", position: "relative", maxWidth: 480, margin: "0 auto", paddingBottom: 40, isolation: "isolate" },
  bgNoise: { position: "absolute", inset: 0, pointerEvents: "none", zIndex: 0, background: "radial-gradient(ellipse 80% 60% at 50% -10%, #1a3d1e44 0%, transparent 70%)" },
  authWrap: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, position: "relative", zIndex: 1 },
  googleBtn:   { width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, background: "#1a2e1c", border: "1px solid #2a4a2e", borderRadius: 10, color: "#c8e6c0", padding: "11px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans', sans-serif", marginBottom: 16 },
  dividerRow:  { display: "flex", alignItems: "center", gap: 10, margin: "4px 0 16px" },
  dividerLine: { flex: 1, height: 1, background: "#1f3322" },
  dividerText: { fontSize: 11, color: "#3a5a3e", whiteSpace: "nowrap" },
  authCard: { background: "#131f14", border: "1px solid #1f3322", borderRadius: 20, padding: 28, width: "100%", maxWidth: 360 },
  authError: { background: "#e11d4820", border: "1px solid #e11d4855", color: "#f87171", borderRadius: 8, padding: "8px 12px", fontSize: 12, marginTop: 8 },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px 10px", position: "relative", zIndex: 1 },
  headerLeft: { display: "flex", flexDirection: "column" },
  logo: { fontFamily: "'Syne', sans-serif", fontSize: 22, fontWeight: 800, color: "#7dba5f", letterSpacing: -0.5 },
  tagline: { fontSize: 11, color: "#6b8c6e", marginTop: 1 },
  userBadge: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" },
  avatarCircle: { width: 36, height: 36, borderRadius: "50%", background: "linear-gradient(135deg,#4d7c3a,#2d5a20)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: "#c8e6c0" },
  userName: { fontSize: 13, fontWeight: 600, color: "#c8e6c0" },
  userLevel: { fontSize: 11, color: "#6b8c6e" },
  progressBar: { height: 3, background: "#1e3320", margin: "0 20px" },
  progressFill: { height: "100%", background: "linear-gradient(90deg,#4d7c3a,#a3e635)", borderRadius: 2, transition: "width 0.5s ease" },
  statsStrip: { display: "flex", justifyContent: "space-around", padding: "10px 20px", background: "#131f14", borderBottom: "1px solid #1f3322" },
  statItem: { display: "flex", flexDirection: "column", alignItems: "center", gap: 2 },
  statVal: { fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 700, color: "#a3e635" },
  statLabel: { fontSize: 10, color: "#5a7d5e", textTransform: "uppercase", letterSpacing: 0.5 },
  tabs: { display: "flex", borderBottom: "1px solid #1f3322", background: "#0f1a10", position: "sticky", top: 0, zIndex: 10 },
  tab: { flex: 1, padding: "12px 4px", background: "none", border: "none", color: "#4a6b4e", fontSize: 12, cursor: "pointer", fontFamily: "'DM Sans', sans-serif", borderBottomWidth: 2, borderBottomStyle: "solid", borderBottomColor: "transparent", transition: "all 0.2s" },
  tabActive: { color: "#a3e635", borderBottomColor: "#a3e635" },
  main: { padding: "16px 16px 0", position: "relative", zIndex: 1 },
  card: { background: "#131f14", border: "1px solid #1f3322", borderRadius: 16, padding: "20px 18px", marginBottom: 16, animation: "fadeIn 0.3s ease" },
  cardTitle: { fontFamily: "'Syne', sans-serif", fontSize: 20, fontWeight: 700, color: "#c8e6c0", margin: "0 0 4px" },
  cardSub: { fontSize: 13, color: "#5a7d5e", margin: "0 0 18px" },
  uploadZone: { border: "2px dashed #2a4a2e", borderRadius: 14, padding: "36px 20px", textAlign: "center", cursor: "pointer", background: "#0d170e" },
  uploadIcon: { fontSize: 44, marginBottom: 10 },
  uploadText: { fontSize: 16, fontWeight: 600, color: "#8ab98a", marginBottom: 4 },
  uploadHint: { fontSize: 12, color: "#4a6b4e" },
  analyzing: { textAlign: "center" },
  previewWrap: { position: "relative", borderRadius: 12, overflow: "hidden", maxHeight: 200 },
  previewImg: { width: "100%", display: "block", maxHeight: 200, objectFit: "cover" },
  scanOverlay: { position: "absolute", inset: 0, background: "linear-gradient(180deg, transparent 40%, #a3e63520 60%, transparent 70%)" },
  scanLine: { position: "absolute", left: 0, right: 0, height: 2, background: "#a3e635", boxShadow: "0 0 12px #a3e63599", animation: "scanMove 1.5s linear infinite" },
  analyzingText: { marginTop: 14, fontSize: 14, color: "#7dba5f" },
  providerBadge: { fontSize: 10, color: "#2a4a2e", marginTop: 4, textTransform: "uppercase", letterSpacing: 1 },
  spinner: { display: "inline-block", animation: "spin 1s linear infinite", marginRight: 6 },
  resultGrid: { display: "flex", gap: 12, marginBottom: 16 },
  resultImg: { width: 110, height: 90, objectFit: "cover", borderRadius: 10, flexShrink: 0 },
  resultInfo: { flex: 1 },
  resultType: { display: "flex", alignItems: "center", gap: 6 },
  resultIcon: { fontSize: 22 },
  resultTypeName: { fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 16, color: "#c8e6c0" },
  resultSubtype: { fontSize: 12, color: "#6b8c6e", marginTop: 2 },
  pill: { fontSize: 11, padding: "2px 8px", borderRadius: 20, fontWeight: 500 },
  resultMeta: { fontSize: 11, color: "#5a7d5e", marginTop: 5, lineHeight: 1.5 },
  pointsEarn: { marginTop: 8, fontSize: 13, color: "#a3e635", fontWeight: 700 },
  fieldGroup: { marginBottom: 14 },
  label: { display: "block", fontSize: 12, color: "#6b8c6e", marginBottom: 6, fontWeight: 500 },
  input: { width: "100%", background: "#0d170e", border: "1px solid #2a4a2e", borderRadius: 8, color: "#c8e6c0", padding: "9px 12px", fontSize: 13, boxSizing: "border-box", outline: "none", fontFamily: "'DM Sans', sans-serif" },
  tagRow: { display: "flex", gap: 8 },
  addTagBtn: { background: "#2a4a2e", border: "none", color: "#a3e635", borderRadius: 8, padding: "9px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" },
  tagList: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 },
  tag: { background: "#1a3320", border: "1px solid #2a4a2e", color: "#7dba5f", borderRadius: 20, padding: "3px 10px", fontSize: 12, display: "flex", alignItems: "center", gap: 4 },
  tagX: { background: "none", border: "none", color: "#4a6b4e", cursor: "pointer", fontSize: 14, padding: 0 },
  submitBtn: { flex: 1, background: "linear-gradient(135deg,#4d7c3a,#2d5a20)", border: "none", color: "#c8e6c0", borderRadius: 10, padding: "12px 16px", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "'Syne', sans-serif" },
  resetBtn: { background: "#1a2e1c", border: "1px solid #2a4a2e", color: "#6b8c6e", borderRadius: 10, padding: "12px 16px", fontSize: 14, cursor: "pointer" },
  successBox: { background: "#0d1f10", border: "1px solid #2a5a2e", borderRadius: 12, padding: 16, animation: "fadeIn 0.3s ease" },
  successTitle: { fontFamily: "'Syne', sans-serif", fontSize: 18, fontWeight: 700, color: "#a3e635", marginBottom: 8 },
  successText: { fontSize: 13, color: "#6b8c6e", marginBottom: 14, lineHeight: 1.6 },
  feedHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  liveTag: { fontSize: 12, color: "#e11d48", fontWeight: 700 },
  feedCard: { display: "flex", gap: 12, background: "#131f14", border: "1px solid #1f3322", borderRadius: 14, padding: 14, marginBottom: 10, animation: "fadeIn 0.3s ease" },
  feedEmoji: { fontSize: 36, flexShrink: 0, lineHeight: 1 },
  feedBody: { flex: 1 },
  feedTop: { display: "flex", gap: 8, alignItems: "center", marginBottom: 4, flexWrap: "wrap" },
  feedUser: { fontWeight: 600, fontSize: 13, color: "#c8e6c0" },
  feedCity: { fontSize: 11, color: "#4a6b4e", background: "#1a2e1c", borderRadius: 10, padding: "1px 6px" },
  feedTime: { fontSize: 11, color: "#3a5a3e", marginLeft: "auto" },
  feedType: { fontSize: 13, color: "#7dba5f", marginBottom: 6 },
  feedActions: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  feedPoints: { fontSize: 12, color: "#a3e635", fontWeight: 700 },
  leaderRow: { display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "1px solid #1a2e1c" },
  leaderFirst: { background: "#1a2e1c22", borderRadius: 10, padding: "12px 8px" },
  leaderRank: { fontSize: 22, width: 28, textAlign: "center" },
  leaderAvatar: { width: 36, height: 36, borderRadius: "50%", background: "#2a4a2e", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: "#7dba5f" },
  leaderInfo: { flex: 1 },
  leaderName: { fontSize: 14, fontWeight: 600, color: "#c8e6c0" },
  leaderCity: { fontSize: 12, color: "#4a6b4e" },
  leaderPoints: { fontFamily: "'Syne', sans-serif", fontSize: 18, fontWeight: 700, color: "#a3e635" },
  ptLabel: { fontSize: 12, color: "#4a6b4e", fontWeight: 400 },
  impactGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 },
  impactCard: { background: "#0d170e", border: "1px solid #1f3322", borderRadius: 12, padding: "14px 12px", textAlign: "center" },
  impactIcon: { fontSize: 24, marginBottom: 6 },
  impactVal: { fontFamily: "'Syne', sans-serif", fontSize: 20, fontWeight: 700, color: "#a3e635" },
  impactLabel: { fontSize: 11, color: "#4a6b4e", marginTop: 2 },
  wasteBreakdown: { marginTop: 4 },
  sectionTitle: { fontFamily: "'Syne', sans-serif", fontSize: 15, fontWeight: 700, color: "#8ab98a", marginBottom: 12 },
  wasteRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10 },
  wasteType: { fontSize: 12, color: "#6b8c6e", width: 130, flexShrink: 0 },
  wasteBarBg: { flex: 1, height: 6, background: "#1a2e1c", borderRadius: 4, overflow: "hidden" },
  wasteBarFill: { height: "100%", borderRadius: 4, transition: "width 0.6s ease" },
  wastePct: { fontSize: 12, color: "#4a6b4e", width: 30, textAlign: "right" },
  loadingMsg: { textAlign: "center", color: "#4a6b4e", padding: "40px 20px", fontSize: 14 },
  emptyMsg: { textAlign: "center", color: "#4a6b4e", padding: "40px 20px", fontSize: 14, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 },
  footer: { textAlign: "center", padding: "20px 16px 10px", fontSize: 11, color: "#2a4a2e", borderTop: "1px solid #1a2e1c", marginTop: 10 },
};