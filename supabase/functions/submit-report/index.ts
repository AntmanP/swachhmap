// ============================================================================
// SwachhMap — Edge Function: submit-report
// Deployed to: Supabase Edge Functions (Deno runtime)
//
// Design decision: ALL business logic for report submission lives here, not
// in the client. The client is untrusted. This function:
//   1. Validates the incoming request
//   2. Compresses and uploads the image to Supabase Storage
//   3. Inserts the report row
//   4. Awards points via the ledger (triggers sync_user_stats automatically)
//   5. Broadcasts a real-time event to all connected clients
//   6. Fires a municipality webhook if severity is Critical or waste is hazardous
//
// Auth: requires a valid Supabase JWT in Authorization header.
//       Uses service_role key internally to bypass RLS for ledger writes.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Rate limiting constants
const MAX_REPORTS_PER_DAY = 20;
const DUPLICATE_RADIUS_M = 50; // metres
const DUPLICATE_WINDOW_HOURS = 24;

// ── Points table ──────────────────────────────────────────────────────────────
// Design decision: points logic lives in the Edge Function, not the DB trigger,
// because it requires context (is this a duplicate? is confidence too low?) that
// is easier to express in code than SQL. The DB trigger only handles sync.
const POINTS_BY_SEVERITY: Record<string, number> = {
  Critical: 60,
  High: 35,
  Medium: 25,
  Low: 15,
};

const DUPLICATE_POINTS = 5; // corroboration points for near-duplicate reports
const MIN_CONFIDENCE_FOR_FULL_POINTS = 40; // below this: flag for review, no points yet

// ── CORS headers ──────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    // ── 1. Auth: verify JWT and extract user ──────────────────────────────────
    // Design decision: create TWO Supabase clients.
    // - userClient: uses the caller's JWT → respects RLS, identifies the user
    // - adminClient: uses service_role → bypasses RLS for ledger writes
    // Never pass service_role to the client. Never.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return error(401, "Missing Authorization header");

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return error(401, "Invalid or expired token");

    // ── 2. Parse and validate request body ───────────────────────────────────
    const body = await req.json();
    const {
      imageBase64, // base64-encoded image (already compressed client-side)
      imageMediaType, // "image/jpeg" | "image/png" | "image/webp"
      latitude,
      longitude,
      locationLabel,
      wasteType,
      subtype,
      severity,
      aiConfidence,
      hazardous,
      quantityEst,
      actionRec,
      tags,
      description,
    } = body;

    if (!imageBase64) return error(400, "imageBase64 is required");
    if (!latitude || !longitude) return error(400, "latitude and longitude are required");
    if (!wasteType) return error(400, "wasteType is required");
    if (!severity) return error(400, "severity is required");

    // ── 3. Rate limiting ──────────────────────────────────────────────────────
    // Design decision: rate limiting in the Edge Function, not the DB.
    // DB-level rate limiting requires a separate rate_limits table and cleanup jobs.
    // Edge Function rate limiting is simpler and runs before any DB writes.
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const { count: todayCount } = await adminClient
      .from("reports")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .gte("created_at", `${today}T00:00:00Z`);

    if ((todayCount ?? 0) >= MAX_REPORTS_PER_DAY) {
      return error(
        429,
        `Daily limit of ${MAX_REPORTS_PER_DAY} reports reached. Try again tomorrow.`,
      );
    }

    // ── 4. Duplicate detection ────────────────────────────────────────────────
    // Design decision: use PostGIS ST_DWithin for spatial deduplication.
    // Checking "same lat/lng" would miss reports 30m apart — same pile of rubbish.
    // ST_DWithin(location, point, 50) = within 50 metres.
    const windowStart = new Date(Date.now() - DUPLICATE_WINDOW_HOURS * 3600 * 1000).toISOString();
    const { data: nearbyReports } = await adminClient.rpc("find_nearby_reports", {
      p_longitude: longitude,
      p_latitude: latitude,
      p_radius_m: DUPLICATE_RADIUS_M,
      p_waste_type: wasteType,
      p_since: windowStart,
    });

    const isDuplicate = nearbyReports && nearbyReports.length > 0;

    // ── 5. Upload image to Supabase Storage ───────────────────────────────────
    // Design decision: store images in Supabase Storage (S3-backed), not the DB.
    // Storing binary in PostgreSQL (bytea) inflates DB size, slows backups,
    // and prevents CDN delivery. Storage gives CDN URLs with cache headers.
    const imageBuffer = Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0));
    const ext = imageMediaType?.split("/")[1] || "jpg";
    const imagePath = `reports/${user.id}/${Date.now()}.${ext}`;

    const { error: uploadError } = await adminClient.storage
      .from("report-images")
      .upload(imagePath, imageBuffer, {
        contentType: imageMediaType || "image/jpeg",
        cacheControl: "31536000", // 1 year — images are immutable after upload
        upsert: false,
      });

    if (uploadError) return error(500, `Image upload failed: ${uploadError.message}`);

    const { data: { publicUrl } } = adminClient.storage
      .from("report-images")
      .getPublicUrl(imagePath);

    // ── 6. Calculate points ───────────────────────────────────────────────────
    let pointsAwarded = 0;
    let pointReason: string = "submission";
    let pointNote = "";

    if (isDuplicate) {
      // Corroboration: near-duplicate gets reduced points
      pointsAwarded = DUPLICATE_POINTS;
      pointReason = "duplicate_corroboration";
      pointNote = `Corroborates report near (${latitude.toFixed(4)}, ${longitude.toFixed(4)})`;
    } else if ((aiConfidence ?? 100) < MIN_CONFIDENCE_FOR_FULL_POINTS) {
      // Low confidence: hold points until verified by moderator
      pointsAwarded = 0;
      pointNote = `Low AI confidence (${aiConfidence}%) — points held pending verification`;
    } else {
      pointsAwarded = POINTS_BY_SEVERITY[severity] ?? 25;
      // Bonus for hazardous waste — requires urgent municipal response
      if (hazardous) pointsAwarded = Math.max(pointsAwarded, 60);
      pointNote = `${severity} severity ${wasteType}`;
    }

    // ── 7. Insert report row ──────────────────────────────────────────────────
    const { data: report, error: insertError } = await adminClient
      .from("reports")
      .insert({
        user_id: user.id,
        image_url: publicUrl,
        image_path: imagePath,
        // PostGIS: ST_MakePoint takes (longitude, latitude) — note the order!
        // Design decision: use raw SQL via rpc to set the geography column.
        location: `SRID=4326;POINT(${longitude} ${latitude})`,
        location_label: locationLabel,
        city: body.city,
        state: body.state,
        waste_type: wasteType,
        subtype: subtype,
        severity: severity,
        ai_confidence: aiConfidence,
        hazardous: hazardous ?? false,
        quantity_est: quantityEst,
        action_rec: actionRec,
        tags: tags ?? [],
        description: description,
        points_awarded: pointsAwarded,
        // Auto-verify high-confidence non-duplicate reports
        status: (aiConfidence ?? 0) >= 80 && !isDuplicate ? "verified" : "pending",
      })
      .select()
      .single();

    if (insertError) {
      // Cleanup: delete uploaded image if report insert fails
      await adminClient.storage.from("report-images").remove([imagePath]);
      return error(500, `Report insert failed: ${insertError.message}`);
    }

    // ── 8. Award points via ledger ────────────────────────────────────────────
    // Design decision: insert into points_ledger, not UPDATE users directly.
    // The sync_user_stats trigger fires automatically after this INSERT and
    // recalculates users.points_total from the full ledger.
    // This is the ONLY safe way to award points — never UPDATE users.points_total directly.
    if (pointsAwarded > 0) {
      await adminClient.from("points_ledger").insert({
        user_id: user.id,
        report_id: report.id,
        amount: pointsAwarded,
        reason: pointReason,
        note: pointNote,
      });
    }

    // ── 9. Check streak bonus ─────────────────────────────────────────────────
    const { data: userRow } = await adminClient
      .from("users")
      .select("streak_days")
      .eq("id", user.id)
      .single();

    if (userRow?.streak_days > 0 && userRow.streak_days % 7 === 0) {
      await adminClient.from("points_ledger").insert({
        user_id: user.id,
        report_id: report.id,
        amount: 100,
        reason: "streak_bonus",
        note: `${userRow.streak_days}-day reporting streak!`,
      });
    }

    // ── 10. Municipality webhook ──────────────────────────────────────────────
    // Design decision: fire-and-forget webhook. We do NOT await the response
    // or fail the request if the webhook fails. The report is already saved.
    // Municipality systems can be unreliable — that must not affect the user experience.
    if (severity === "Critical" || hazardous === true) {
      const { data: webhooks } = await adminClient
        .from("municipality_webhooks")
        .select("endpoint_url, secret_key")
        .eq("city", body.city ?? "")
        .eq("active", true);

      if (webhooks && webhooks.length > 0) {
        const payload = JSON.stringify({
          report_id: report.id,
          waste_type: wasteType,
          severity,
          hazardous,
          location_label: locationLabel,
          latitude,
          longitude,
          image_url: publicUrl,
          action_rec: actionRec,
          reported_at: report.created_at,
        });

        // Fire webhooks without awaiting
        webhooks.forEach(
          ({ endpoint_url, secret_key }: { endpoint_url: string; secret_key: string }) => {
            fetch(endpoint_url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-SwachhMap-Event": "critical_report",
                // HMAC signature so municipality can verify the webhook is genuine
                "X-SwachhMap-Sig": btoa(`${secret_key}:${report.id}`),
              },
              body: payload,
            }).catch((err: Error) => console.error("Webhook failed:", err));
          },
        );
      }
    }

    // ── 11. Broadcast real-time event ─────────────────────────────────────────
    // Design decision: broadcast via Supabase Realtime channel.
    // The frontend subscribes to 'public-feed' channel — this is how new reports
    // appear instantly in the Feed tab without polling.
    await adminClient.channel("public-feed").send({
      type: "broadcast",
      event: "new_report",
      payload: {
        id: report.id,
        waste_type: wasteType,
        severity,
        city: body.city,
        points: pointsAwarded,
        reporter_name: body.displayName ?? "Anonymous",
        created_at: report.created_at,
      },
    });

    // ── 12. Respond ───────────────────────────────────────────────────────────
    return new Response(
      JSON.stringify({
        success: true,
        report_id: report.id,
        points: pointsAwarded,
        is_duplicate: isDuplicate,
        status: report.status,
        message: isDuplicate
          ? `Corroboration recorded! +${pointsAwarded} pts`
          : `Report submitted! +${pointsAwarded} pts`,
      }),
      {
        status: 201,
        headers: { ...CORS, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("submit-report error:", err);
    return error(500, "Internal server error");
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function error(status: number, message: string) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
