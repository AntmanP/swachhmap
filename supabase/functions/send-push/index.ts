// ============================================================================
// SwachhMap — Edge Function: send-push
//
// Sends a Firebase Cloud Messaging push notification to a specific user.
// Called internally by confirm-cleanup (and future triggers) when a report
// status changes or a bonus is awarded.
//
// Design decisions:
//   1. Uses FCM HTTP v1 API (not legacy) — authenticated via Service Account JWT.
//      The old server key approach is deprecated by Google as of June 2024.
//   2. Service account signs a short-lived JWT to get an OAuth2 access token,
//      then uses that to call FCM. This is fully server-side — no SDK needed.
//   3. Looks up FCM tokens from the fcm_tokens table. A user can have multiple
//      devices — we send to all of them in parallel.
//   4. Failed tokens (expired/unregistered) are deleted from the table to keep
//      it clean and avoid wasting FCM quota.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FCM_PROJECT_ID       = Deno.env.get("FCM_PROJECT_ID")!;
const FCM_CLIENT_EMAIL     = Deno.env.get("FCM_CLIENT_EMAIL")!;
const FCM_PRIVATE_KEY      = Deno.env.get("FCM_PRIVATE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { userId, title, body, data } = await req.json();
    if (!userId || !title) return errResp(400, "userId and title are required");

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Get all FCM tokens for this user
    const { data: tokens, error: tokErr } = await admin
      .from("fcm_tokens")
      .select("id, token")
      .eq("user_id", userId);

    if (tokErr)              return errResp(500, tokErr.message);
    if (!tokens?.length)     return jsonResp({ success: true, sent: 0, message: "No FCM tokens for user" });

    // Get OAuth2 access token from Google using Service Account JWT
    const accessToken = await getGoogleAccessToken();

    // Send to all devices in parallel
    const results = await Promise.allSettled(
      tokens.map(t => sendToDevice(t.token, title, body ?? "", data ?? {}, accessToken))
    );

    // Clean up expired/invalid tokens
    const expiredIds: string[] = [];
    results.forEach((r, i) => {
      if (r.status === "rejected" || (r.status === "fulfilled" && r.value?.expired)) {
        expiredIds.push(tokens[i].id);
      }
    });
    if (expiredIds.length) {
      await admin.from("fcm_tokens").delete().in("id", expiredIds);
    }

    const sent = results.filter(r => r.status === "fulfilled" && !r.value?.expired).length;
    return jsonResp({ success: true, sent, total: tokens.length });

  } catch (err) {
    console.error("send-push error:", err);
    return errResp(500, String(err));
  }
});

// ── Send notification to one FCM device token ─────────────────────────────────
async function sendToDevice(
  token: string,
  title: string,
  body: string,
  data: Record<string, string>,
  accessToken: string
): Promise<{ expired?: boolean }> {
  const resp = await fetch(
    `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send`,
    {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          data: Object.fromEntries(
            Object.entries(data).map(([k, v]) => [k, String(v)])
          ),
          webpush: {
            notification: {
              title, body,
              icon:  "/icons/icon-192.png",
              badge: "/icons/badge-72.png",
              vibrate: [200, 100, 200],
            },
            fcm_options: { link: "/" },
          },
        },
      }),
    }
  );

  const json = await resp.json();

  // UNREGISTERED or INVALID_ARGUMENT means the token is stale — mark for deletion
  if (!resp.ok) {
    const errCode = json?.error?.details?.[0]?.errorCode ?? "";
    if (errCode === "UNREGISTERED" || errCode === "INVALID_ARGUMENT") {
      return { expired: true };
    }
    throw new Error(`FCM error: ${JSON.stringify(json.error)}`);
  }

  return {};
}

// ── Get short-lived Google OAuth2 token via Service Account JWT ───────────────
// Design: manually construct and sign a JWT — no google-auth-library needed.
// Deno has built-in crypto.subtle for RSA-SHA256 signing.
async function getGoogleAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss:   FCM_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud:   "https://oauth2.googleapis.com/token",
    iat:   now,
    exp:   now + 3600,
  };

  // Encode JWT header + payload
  const header  = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" })).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const payload = btoa(JSON.stringify(claim)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const unsigned = `${header}.${payload}`;

  // Import the private key
  const pemBody = FCM_PRIVATE_KEY
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\n/g, "");
  const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );

  // Sign
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsigned)
  );
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const jwt = `${unsigned}.${sigB64}`;

  // Exchange JWT for access token
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion:  jwt,
    }),
  });

  const tokenJson = await tokenResp.json();
  if (!tokenResp.ok) throw new Error(`OAuth2 error: ${JSON.stringify(tokenJson)}`);
  return tokenJson.access_token;
}

function jsonResp(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function errResp(status: number, message: string) {
  return new Response(JSON.stringify({ success: false, error: message }), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
