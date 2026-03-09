-- ============================================================================
-- SwachhMap — Migration 001: Initial Schema
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================================================

-- ── 0. Extensions ─────────────────────────────────────────────────────────────
-- PostGIS: enables GEOGRAPHY columns and spatial functions (ST_DWithin, ST_ClusterDBSCAN, etc.)
-- Design decision: enable at migration time, not later — retrofitting PostGIS on a populated
-- table requires a full table rewrite which is painful and risky.
CREATE EXTENSION IF NOT EXISTS postgis;

-- UUID generation for primary keys
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- ── 1. ENUMS ──────────────────────────────────────────────────────────────────
-- Using enums instead of CHECK constraints on TEXT columns.
-- Design decision: Postgres enums are enforced at the type level — a bad value can never
-- be inserted even if you forget a CHECK constraint. The tradeoff is that adding a new
-- enum value requires ALTER TYPE (a minor DDL operation), but for our controlled
-- categorisation sets this is acceptable.

CREATE TYPE waste_type_enum AS ENUM (
  'Plastic Waste',
  'Food Waste',
  'E-Waste',
  'Construction Debris',
  'Mixed Litter',
  'Hazardous Waste',
  'Organic Waste',
  'Medical Waste',
  'No Litter Detected'
);

CREATE TYPE severity_enum AS ENUM ('Low', 'Medium', 'High', 'Critical');

CREATE TYPE report_status_enum AS ENUM (
  'pending',           -- submitted, awaiting AI/human verification
  'verified',          -- confirmed as real litter by moderator or high-confidence AI
  'cleanup_triggered', -- alert sent to municipality / NGO
  'cleaned',           -- cleanup confirmed
  'rejected'           -- false report
);

CREATE TYPE actioned_by_type_enum AS ENUM ('municipality', 'ngo', 'volunteer');

CREATE TYPE point_reason_enum AS ENUM (
  'submission',
  'cleanup_bonus',
  'verification_bonus',
  'streak_bonus',
  'duplicate_corroboration',
  'admin_award',
  'false_report_penalty'
);

CREATE TYPE user_level_enum AS ENUM ('Spotter', 'Cleaner', 'Guardian', 'Champion');


-- ── 2. USERS ──────────────────────────────────────────────────────────────────
-- Design decision: the primary key is the Supabase Auth UID (uuid).
-- This means auth.users and public.users share the same PK, so JOINs are trivial
-- and we never need a separate "auth_id" foreign key column.

CREATE TABLE public.users (
  id               UUID         PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  phone            TEXT         UNIQUE,                        -- E.164 format (+91XXXXXXXXXX)
  display_name     TEXT         NOT NULL DEFAULT 'Anonymous',
  city             TEXT,
  state            TEXT,                                       -- Indian state — enables state-level leaderboards
  points_total     INTEGER      NOT NULL DEFAULT 0 CHECK (points_total >= 0),
  reports_count    INTEGER      NOT NULL DEFAULT 0 CHECK (reports_count >= 0),
  cleanups_count   INTEGER      NOT NULL DEFAULT 0,            -- reports that led to cleanup
  level            user_level_enum NOT NULL DEFAULT 'Spotter',
  streak_days      SMALLINT     NOT NULL DEFAULT 0,
  last_report_date DATE,                                       -- for streak calculation
  avatar_url       TEXT,
  is_moderator     BOOLEAN      NOT NULL DEFAULT false,
  is_municipality  BOOLEAN      NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_active      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.users IS 'SwachhMap user profiles. PK mirrors auth.users.id.';
COMMENT ON COLUMN public.users.points_total IS 'Denormalised for fast leaderboard queries. Kept in sync by update_user_stats trigger.';
COMMENT ON COLUMN public.users.level IS 'Computed from points_total by compute_user_level(). Updated by trigger.';


-- ── 3. REPORTS ────────────────────────────────────────────────────────────────
-- Design decision: location stored as PostGIS GEOGRAPHY(POINT, 4326).
-- SRID 4326 = WGS-84, the coordinate system used by all GPS devices and browser
-- Geolocation API. GEOGRAPHY (vs GEOMETRY) handles the curvature of the earth
-- correctly for distance calculations — important for India's large geographic spread.

CREATE TABLE public.reports (
  id                UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID                NOT NULL REFERENCES public.users(id) ON DELETE SET NULL,

  -- Image
  image_url         TEXT                NOT NULL,              -- Supabase Storage CDN URL
  image_path        TEXT                NOT NULL,              -- Storage path for deletion

  -- Location
  location          GEOGRAPHY(POINT, 4326),                   -- PostGIS point: ST_MakePoint(lng, lat)
  location_label    TEXT,                                      -- Human-readable: "Sector 12, Gurgaon"
  ward_id           TEXT,                                      -- Municipal ward code for routing alerts
  city              TEXT,
  state             TEXT,

  -- AI Classification (populated by Vision API via Edge Function)
  waste_type        waste_type_enum     NOT NULL DEFAULT 'Mixed Litter',
  subtype           TEXT,                                      -- e.g. "Single-use plastic bottles"
  severity          severity_enum       NOT NULL DEFAULT 'Medium',
  ai_confidence     SMALLINT            CHECK (ai_confidence BETWEEN 0 AND 100),
  hazardous         BOOLEAN             NOT NULL DEFAULT false,
  quantity_est      TEXT,                                      -- "~5kg", "scattered 10m"
  action_rec        TEXT,                                      -- "Municipal pickup required"

  -- User enrichment
  tags              TEXT[]              NOT NULL DEFAULT '{}', -- GIN-indexed for fast tag search
  description       TEXT,                                      -- Optional free-text from user

  -- Points & Status
  points_awarded    SMALLINT            NOT NULL DEFAULT 0,
  status            report_status_enum  NOT NULL DEFAULT 'pending',
  verified_by       UUID                REFERENCES public.users(id) ON DELETE SET NULL,
  verified_at       TIMESTAMPTZ,
  cleaned_at        TIMESTAMPTZ,
  cleanup_bonus_paid BOOLEAN            NOT NULL DEFAULT false, -- prevents double-paying bonus

  -- Metadata
  created_at        TIMESTAMPTZ         NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ         NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.reports IS 'Core litter reports submitted by users.';
COMMENT ON COLUMN public.reports.location IS 'PostGIS GEOGRAPHY point. Use ST_MakePoint(longitude, latitude)::geography.';
COMMENT ON COLUMN public.reports.tags IS 'Array column. GIN indexed. Query with: WHERE tags @> ARRAY[''school zone'']';
COMMENT ON COLUMN public.reports.cleanup_bonus_paid IS 'Guards against double-awarding cleanup bonus if confirm-cleanup is called twice.';


-- ── 4. POINTS LEDGER ─────────────────────────────────────────────────────────
-- Design decision: append-only event log (Event Sourcing pattern).
-- NEVER update or delete rows. users.points_total is the read-model.
-- This gives full audit trail, dispute resolution, and retroactive bonus capability.

CREATE TABLE public.points_ledger (
  id          UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID             NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  report_id   UUID             REFERENCES public.reports(id) ON DELETE SET NULL, -- NULL for non-report awards
  amount      SMALLINT         NOT NULL,                       -- positive = earned, negative = penalty
  reason      point_reason_enum NOT NULL,
  note        TEXT,                                            -- human-readable context
  created_at  TIMESTAMPTZ      NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.points_ledger IS 'Append-only event log of all point transactions. Never UPDATE or DELETE.';


-- ── 5. CLEANUPS ───────────────────────────────────────────────────────────────
CREATE TABLE public.cleanups (
  id               UUID                   PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id        UUID                   NOT NULL REFERENCES public.reports(id) ON DELETE CASCADE,
  actioned_by_name TEXT                   NOT NULL,            -- "NDMC Ward 12", "Goonj NGO"
  actioned_by_type actioned_by_type_enum  NOT NULL,
  confirmed_by     UUID                   REFERENCES public.users(id) ON DELETE SET NULL,
  before_photo_url TEXT,
  after_photo_url  TEXT,
  notes            TEXT,
  confirmed_at     TIMESTAMPTZ            NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cleanups IS 'Records confirmed cleanup events. Triggers bonus points for original reporter.';


-- ── 6. MUNICIPALITY WEBHOOKS ──────────────────────────────────────────────────
-- Design decision: store webhook config in DB, not env vars.
-- Different municipalities register different endpoints. Storing in DB means
-- adding a new municipality partner requires no code deploy — just a DB INSERT.

CREATE TABLE public.municipality_webhooks (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  city         TEXT    NOT NULL,
  state        TEXT    NOT NULL,
  endpoint_url TEXT    NOT NULL,
  secret_key   TEXT    NOT NULL,   -- HMAC signing key for webhook authenticity
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.municipality_webhooks IS 'Registered municipality alert endpoints. No code deploy needed to add new partners.';


-- ── 7. INDEXES ────────────────────────────────────────────────────────────────
-- Design decision: each index is justified by a specific query pattern.
-- Indexes slow down writes — only add what you can justify.

-- Spatial index on report locations → powers heatmap, radius queries, ward aggregation
CREATE INDEX idx_reports_location
  ON public.reports USING GIST (location);

-- User's own reports, newest first → powers profile page feed
CREATE INDEX idx_reports_user_created
  ON public.reports (user_id, created_at DESC);

-- Filtering by waste type and status → powers municipality dashboard
CREATE INDEX idx_reports_waste_status
  ON public.reports (waste_type, status);

-- Full-text tag search → powers "find all reports tagged X" queries
-- GIN is the correct index type for array columns — B-tree cannot handle this
CREATE INDEX idx_reports_tags
  ON public.reports USING GIN (tags);

-- City-filtered reports → powers city leaderboard and city heatmap
CREATE INDEX idx_reports_city_created
  ON public.reports (city, created_at DESC);

-- Leaderboard sort → avoids full table sort on every leaderboard load
CREATE INDEX idx_users_points
  ON public.users (points_total DESC);

-- City leaderboards → fast per-city rankings
CREATE INDEX idx_users_city_points
  ON public.users (city, points_total DESC);

-- Points ledger per user → powers user point history page
CREATE INDEX idx_points_ledger_user
  ON public.points_ledger (user_id, created_at DESC);


-- ── 8. FUNCTIONS ─────────────────────────────────────────────────────────────

-- Compute user level from points total
-- Design decision: pure SQL function, not application logic.
-- Level boundaries live in one place. Changing thresholds = one SQL update, not a frontend deploy.
CREATE OR REPLACE FUNCTION compute_user_level(points INTEGER)
RETURNS user_level_enum
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN points >= 3000 THEN 'Champion'::user_level_enum
    WHEN points >= 1500 THEN 'Guardian'::user_level_enum
    WHEN points >=  500 THEN 'Cleaner'::user_level_enum
    ELSE                     'Spotter'::user_level_enum
  END;
$$;

-- Compute points for a report based on severity
-- Design decision: centralised points table in SQL.
-- Business rule "Critical = 60 pts" is defined once, referenced everywhere.
CREATE OR REPLACE FUNCTION points_for_severity(sev severity_enum)
RETURNS SMALLINT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE sev
    WHEN 'Critical' THEN 60
    WHEN 'High'     THEN 35
    WHEN 'Medium'   THEN 25
    ELSE                 15   -- Low
  END::SMALLINT;
$$;

-- Update reports.updated_at on any row change
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Keep users.points_total, reports_count, and level in sync
-- Design decision: trigger-maintained denormalisation.
-- The trigger fires AFTER INSERT on points_ledger — the source of truth.
-- We sum the ledger and update the read-model. This keeps logic in the DB,
-- not scattered across Edge Functions and client code.
CREATE OR REPLACE FUNCTION sync_user_stats()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  new_total INTEGER;
BEGIN
  -- Recalculate points total from ledger (source of truth)
  SELECT COALESCE(SUM(amount), 0)
    INTO new_total
    FROM public.points_ledger
   WHERE user_id = NEW.user_id;

  UPDATE public.users
     SET points_total  = GREATEST(new_total, 0),
         level         = compute_user_level(GREATEST(new_total, 0)),
         last_active   = now()
   WHERE id = NEW.user_id;

  RETURN NEW;
END;
$$;

-- Increment users.reports_count on new report
CREATE OR REPLACE FUNCTION increment_report_count()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS NOT NULL THEN
    UPDATE public.users
       SET reports_count   = reports_count + 1,
           last_report_date = CURRENT_DATE,
           -- Streak: if last report was yesterday, increment; else reset to 1
           streak_days      = CASE
             WHEN last_report_date = CURRENT_DATE - 1 THEN streak_days + 1
             WHEN last_report_date = CURRENT_DATE     THEN streak_days  -- same day, no change
             ELSE 1
           END
     WHERE id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;

-- Auto-pay cleanup bonus when report status changes to 'cleaned'
-- Design decision: trigger-based business rule.
-- The bonus fires automatically when any process (Edge Function, admin SQL, future API)
-- sets status = 'cleaned'. No risk of forgetting to call the bonus function.
CREATE OR REPLACE FUNCTION auto_cleanup_bonus()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'cleaned'
     AND OLD.status <> 'cleaned'
     AND NEW.cleanup_bonus_paid = false
     AND NEW.user_id IS NOT NULL
  THEN
    -- Insert bonus into ledger (sync_user_stats trigger will update points_total)
    INSERT INTO public.points_ledger (user_id, report_id, amount, reason, note)
    VALUES (NEW.user_id, NEW.id, 50, 'cleanup_bonus', 'Report led to confirmed cleanup');

    -- Mark bonus as paid to prevent double-award
    NEW.cleanup_bonus_paid := true;
    NEW.cleaned_at := now();

    -- Increment user's cleanups_count
    UPDATE public.users
       SET cleanups_count = cleanups_count + 1
     WHERE id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;


-- ── 9. TRIGGERS ───────────────────────────────────────────────────────────────

CREATE TRIGGER trg_reports_updated_at
  BEFORE UPDATE ON public.reports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Fires after every points_ledger INSERT → keeps users.points_total current
CREATE TRIGGER trg_sync_user_stats
  AFTER INSERT ON public.points_ledger
  FOR EACH ROW EXECUTE FUNCTION sync_user_stats();

-- Fires after every new report → increments count, updates streak
CREATE TRIGGER trg_increment_report_count
  AFTER INSERT ON public.reports
  FOR EACH ROW EXECUTE FUNCTION increment_report_count();

-- Fires before UPDATE on reports → auto-pays cleanup bonus on status change
CREATE TRIGGER trg_auto_cleanup_bonus
  BEFORE UPDATE OF status ON public.reports
  FOR EACH ROW EXECUTE FUNCTION auto_cleanup_bonus();


-- ── 10. ROW-LEVEL SECURITY ────────────────────────────────────────────────────
-- Design decision: RLS is the last line of defence.
-- Even if Edge Functions have bugs, the DB refuses unauthorised operations.
-- auth.uid() returns the JWT subject — the logged-in user's UUID.
-- service_role bypasses RLS — used only by Edge Functions server-side.

ALTER TABLE public.users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.points_ledger       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cleanups            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.municipality_webhooks ENABLE ROW LEVEL SECURITY;

-- USERS
CREATE POLICY "Users can read all profiles (for leaderboard)"
  ON public.users FOR SELECT USING (true);

CREATE POLICY "Users can update only their own profile"
  ON public.users FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Edge Function creates user on onboard"
  ON public.users FOR INSERT WITH CHECK (auth.uid() = id);

-- REPORTS
CREATE POLICY "Reports are publicly readable"
  ON public.reports FOR SELECT USING (true);

CREATE POLICY "Authenticated users can submit reports"
  ON public.reports FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own pending reports (tags, label)"
  ON public.reports FOR UPDATE
  USING (auth.uid() = user_id AND status = 'pending')
  WITH CHECK (auth.uid() = user_id);

-- POINTS LEDGER
-- Design decision: NO client write access to ledger. Ever.
-- Only service_role (Edge Functions) can INSERT. Clients can only read their own history.
CREATE POLICY "Users can read own point history"
  ON public.points_ledger FOR SELECT USING (auth.uid() = user_id);

-- CLEANUPS
CREATE POLICY "Cleanups are publicly readable"
  ON public.cleanups FOR SELECT USING (true);

CREATE POLICY "Municipality users can insert cleanups"
  ON public.cleanups FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND is_municipality = true)
  );

-- MUNICIPALITY WEBHOOKS
-- Design decision: webhook secrets never exposed to non-moderators.
CREATE POLICY "Only moderators can manage webhooks"
  ON public.municipality_webhooks FOR ALL
  USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND is_moderator = true));


-- ── 11. HELPER VIEWS ──────────────────────────────────────────────────────────
-- Materialised queries the frontend uses frequently.
-- Design decision: views keep complex SQL out of client code.
-- If the underlying query needs optimising, change the view — not the frontend.

-- Public leaderboard (top 100 by city, this month)
CREATE OR REPLACE VIEW public.leaderboard_monthly AS
SELECT
  u.id,
  u.display_name,
  u.city,
  u.level,
  u.avatar_url,
  COUNT(r.id)          AS reports_this_month,
  COALESCE(SUM(l.amount), 0) AS points_this_month
FROM public.users u
LEFT JOIN public.reports r
  ON r.user_id = u.id AND r.created_at >= date_trunc('month', now())
LEFT JOIN public.points_ledger l
  ON l.user_id = u.id AND l.created_at >= date_trunc('month', now())
GROUP BY u.id, u.display_name, u.city, u.level, u.avatar_url
ORDER BY points_this_month DESC;

-- Recent public feed (last 50 reports, anonymised)
CREATE OR REPLACE VIEW public.public_feed AS
SELECT
  r.id,
  r.waste_type,
  r.subtype,
  r.severity,
  r.hazardous,
  r.tags,
  r.city,
  r.state,
  r.status,
  r.points_awarded,
  r.created_at,
  u.display_name AS reporter_name,
  u.level        AS reporter_level
FROM public.reports r
JOIN public.users u ON u.id = r.user_id
WHERE r.status <> 'rejected'
ORDER BY r.created_at DESC
LIMIT 50;

-- Heatmap source data (used by ST_ClusterDBSCAN in Edge Function)
CREATE OR REPLACE VIEW public.heatmap_source AS
SELECT
  id,
  location,
  waste_type,
  severity,
  city,
  created_at
FROM public.reports
WHERE location IS NOT NULL
  AND status <> 'rejected'
  AND created_at >= now() - INTERVAL '30 days';


-- ── 12. SEED DATA ─────────────────────────────────────────────────────────────
-- Municipality webhook registrations (placeholders — replace with real endpoints)
INSERT INTO public.municipality_webhooks (city, state, endpoint_url, secret_key, active)
VALUES
  ('Mumbai',    'Maharashtra', 'https://mcgm.gov.in/webhook/swachhmap',    'replace_with_real_secret', false),
  ('Delhi',     'Delhi',       'https://mcd.gov.in/webhook/swachhmap',     'replace_with_real_secret', false),
  ('Bengaluru', 'Karnataka',   'https://bbmp.gov.in/webhook/swachhmap',    'replace_with_real_secret', false),
  ('Chennai',   'Tamil Nadu',  'https://chennaicorp.gov.in/webhook/swachhmap', 'replace_with_real_secret', false),
  ('Hyderabad', 'Telangana',   'https://ghmc.gov.in/webhook/swachhmap',    'replace_with_real_secret', false)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- End of Migration 001
-- ============================================================================
