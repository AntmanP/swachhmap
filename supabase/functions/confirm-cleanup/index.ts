// ============================================================================
// SwachhMap — Edge Function: confirm-cleanup
// Deployed to: Supabase Edge Functions (Deno runtime)
//
// Purpose: Confirms that a report location has been cleaned up.
// Updates the cleanup_confirmed date and awards confirmation points.
//
// Auth: requires a valid Supabase JWT in Authorization header.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CONFIRMATION_POINTS = 30;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return error(401, "Missing Authorization header");

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return error(401, "Invalid or expired token");

    const body = await req.json();
    const { report_id, image_base64, notes } = body;

    if (!report_id) return error(400, "report_id is required");

    // Update report with cleanup confirmation
    const { data: report, error: updateError } = await adminClient
      .from("reports")
      .update({
        cleanup_confirmed: new Date().toISOString(),
        cleanup_notes: notes,
      })
      .eq("id", report_id)
      .select()
      .single();

    if (updateError) return error(500, `Update failed: ${updateError.message}`);

    // Award confirmation points
    await adminClient.from("points_ledger").insert({
      user_id: user.id,
      report_id: report_id,
      amount: CONFIRMATION_POINTS,
      reason: "cleanup_confirmation",
      note: "Confirmed cleanup completion",
    });

    return new Response(
      JSON.stringify({
        success: true,
        report_id: report.id,
        points: CONFIRMATION_POINTS,
        message: `Cleanup confirmed! +${CONFIRMATION_POINTS} pts`,
      }),
      {
        status: 200,
        headers: { ...CORS, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("confirm-cleanup error:", err);
    return error(500, "Internal server error");
  }
});

function error(status: number, message: string) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
