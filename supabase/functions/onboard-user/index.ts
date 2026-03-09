// ============================================================================
// SwachhMap — Edge Function: onboard-user
// Deployed to: Supabase Edge Functions (Deno runtime)
//
// Purpose: Called when a new user signs up. Initializes user profile
// and awards welcome bonus points.
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

const WELCOME_BONUS_POINTS = 50;

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
    const { display_name, avatar_url, city, state } = body;

    // Check if user profile already exists
    const { data: existingUser } = await adminClient
      .from("users")
      .select("id")
      .eq("id", user.id)
      .single();

    if (existingUser) {
      return error(409, "User profile already exists");
    }

    // Create user profile
    const { data: profile, error: insertError } = await adminClient
      .from("users")
      .insert({
        id: user.id,
        email: user.email,
        display_name: display_name || "Anonymous",
        avatar_url: avatar_url,
        city: city,
        state: state,
        points_total: WELCOME_BONUS_POINTS,
        streak_days: 0,
      })
      .select()
      .single();

    if (insertError) return error(500, `Profile creation failed: ${insertError.message}`);

    // Award welcome bonus points
    await adminClient.from("points_ledger").insert({
      user_id: user.id,
      amount: WELCOME_BONUS_POINTS,
      reason: "welcome_bonus",
      note: "Welcome to SwachhMap!",
    });

    return new Response(
      JSON.stringify({
        success: true,
        user_id: profile.id,
        points: WELCOME_BONUS_POINTS,
        message: `Welcome to SwachhMap! +${WELCOME_BONUS_POINTS} pts bonus`,
      }),
      {
        status: 201,
        headers: { ...CORS, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("onboard-user error:", err);
    return error(500, "Internal server error");
  }
});

function error(status: number, message: string) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
