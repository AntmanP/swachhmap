-- ============================================================================
-- SwachhMap — Migration 002: RPC Helper Functions
-- These functions are called by Edge Functions via supabase.rpc()
-- Design decision: keep spatial query logic in SQL (where PostGIS lives),
-- not in the Deno Edge Function (which has no PostGIS bindings).
-- ============================================================================

-- Find nearby reports for duplicate detection
-- Called by submit-report Edge Function
-- p_longitude, p_latitude: coordinates of new report
-- p_radius_m: detection radius in metres (default 50m)
-- p_waste_type: only match same waste type
-- p_since: only look within a time window
CREATE OR REPLACE FUNCTION find_nearby_reports(
  p_longitude  FLOAT,
  p_latitude   FLOAT,
  p_radius_m   INTEGER DEFAULT 50,
  p_waste_type TEXT    DEFAULT NULL,
  p_since      TIMESTAMPTZ DEFAULT NOW() - INTERVAL '24 hours'
)
RETURNS TABLE (
  id           UUID,
  waste_type   waste_type_enum,
  distance_m   FLOAT,
  created_at   TIMESTAMPTZ
)
LANGUAGE sql STABLE AS $$
  SELECT
    r.id,
    r.waste_type,
    -- ST_Distance on GEOGRAPHY returns metres (not degrees) — important!
    ST_Distance(
      r.location,
      ST_MakePoint(p_longitude, p_latitude)::geography
    ) AS distance_m,
    r.created_at
  FROM public.reports r
  WHERE
    r.location IS NOT NULL
    AND r.status <> 'rejected'
    AND r.created_at >= p_since
    AND (p_waste_type IS NULL OR r.waste_type::TEXT = p_waste_type)
    -- ST_DWithin uses the spatial GIST index — much faster than computing distance for all rows
    AND ST_DWithin(
      r.location,
      ST_MakePoint(p_longitude, p_latitude)::geography,
      p_radius_m
    )
  ORDER BY distance_m ASC
  LIMIT 5;
$$;

-- Heatmap cluster data — used by the Map view Edge Function / direct RPC
-- Returns PostGIS cluster IDs and centroids for Mapbox heatmap rendering
-- Design decision: clustering in SQL (ST_ClusterDBSCAN) not JavaScript.
-- ST_ClusterDBSCAN can cluster 100k points in ~200ms in Postgres. Doing the
-- same in JS would require loading all coordinates into memory and running
-- a clustering library — 10x slower and much more memory-hungry.
CREATE OR REPLACE FUNCTION get_heatmap_clusters(
  p_city        TEXT    DEFAULT NULL,
  p_waste_type  TEXT    DEFAULT NULL,
  p_days        INTEGER DEFAULT 30,
  p_eps_m       INTEGER DEFAULT 200  -- cluster radius in metres
)
RETURNS TABLE (
  cluster_id    INTEGER,
  centroid_lng  FLOAT,
  centroid_lat  FLOAT,
  report_count  BIGINT,
  dominant_type TEXT,
  max_severity  TEXT
)
LANGUAGE sql STABLE AS $$
  WITH clustered AS (
    SELECT
      id,
      location,
      waste_type::TEXT,
      severity::TEXT,
      -- FIX 1: ST_ClusterDBSCAN requires geometry (not geography).
      --        Cast location::geometry for the clustering function.
      -- FIX 2: eps is in degrees when using geometry (SRID 4326).
      --        Divide metres by 111320 to convert to degrees.
      --        111320 m ≈ 1 degree of latitude anywhere in India — accurate enough
      --        for clustering purposes (error < 1% across Indian latitudes).
      ST_ClusterDBSCAN(location::geometry, eps := p_eps_m::float / 111320.0, minpoints := 2)
        OVER () AS cid
    FROM public.reports
    WHERE
      status <> 'rejected'
      AND location IS NOT NULL
      AND created_at >= now() - (p_days || ' days')::INTERVAL
      AND (p_city IS NULL OR city = p_city)
      AND (p_waste_type IS NULL OR waste_type::TEXT = p_waste_type)
  ),
  -- FIX 3: MAX(x ORDER BY expr) is not valid SQL syntax.
  --        Use a subquery with ORDER BY + LIMIT to pick the highest severity per cluster.
  severity_ranked AS (
    SELECT
      cid,
      severity,
      CASE severity
        WHEN 'Critical' THEN 4
        WHEN 'High'     THEN 3
        WHEN 'Medium'   THEN 2
        ELSE 1
      END AS sev_rank
    FROM clustered
  ),
  max_severity_per_cluster AS (
    SELECT DISTINCT ON (cid)
      cid,
      severity AS max_severity
    FROM severity_ranked
    ORDER BY cid, sev_rank DESC
  )
  SELECT
    COALESCE(c.cid, -1)                                  AS cluster_id,
    ST_X(ST_Centroid(ST_Collect(c.location::geometry)))  AS centroid_lng,
    ST_Y(ST_Centroid(ST_Collect(c.location::geometry)))  AS centroid_lat,
    COUNT(*)                                             AS report_count,
    MODE() WITHIN GROUP (ORDER BY c.waste_type)          AS dominant_type,
    ms.max_severity
  FROM clustered c
  LEFT JOIN max_severity_per_cluster ms ON ms.cid = c.cid
  GROUP BY c.cid, ms.max_severity
  ORDER BY report_count DESC;
$$;

-- User stats for profile page — single RPC call instead of 3 separate queries
CREATE OR REPLACE FUNCTION get_user_stats(p_user_id UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  result JSON;
BEGIN
  SELECT json_build_object(
    'profile',        row_to_json(u),
    'rank_global',    (SELECT COUNT(*) + 1 FROM public.users WHERE points_total > u.points_total),
    'rank_city',      (SELECT COUNT(*) + 1 FROM public.users WHERE city = u.city AND points_total > u.points_total),
    'points_this_month', (
      SELECT COALESCE(SUM(amount), 0)
        FROM public.points_ledger
       WHERE user_id = p_user_id
         AND created_at >= date_trunc('month', now())
    ),
    'recent_reports', (
      SELECT json_agg(r ORDER BY r.created_at DESC)
        FROM (
          SELECT id, waste_type, severity, status, points_awarded, city, created_at
            FROM public.reports
           WHERE user_id = p_user_id
           ORDER BY created_at DESC
           LIMIT 10
        ) r
    )
  )
  INTO result
  FROM public.users u
  WHERE u.id = p_user_id;

  RETURN result;
END;
$$;

-- ── Storage bucket setup ──────────────────────────────────────────────────────
-- Run this in the Supabase SQL editor OR via the Storage UI.
-- Design decision: one bucket for all report images.
-- Separate buckets per city or per user would complicate CDN caching policies
-- and make bulk operations (e.g. "delete all images for rejected reports") harder.

-- Note: bucket creation via SQL requires the storage schema.
-- If this fails, create the bucket manually in Supabase Dashboard → Storage.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'report-images',
  'report-images',
  true,                                              -- public: CDN-served without auth
  1048576,                                           -- 1MB max — client compresses before upload
  ARRAY['image/jpeg', 'image/png', 'image/webp']    -- no gifs, no SVGs, no executables
)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: anyone can read (public CDN), only authenticated users can upload,
-- and only to their own folder (user_id prefix enforced by path pattern)
CREATE POLICY "Public read access for report images"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'report-images');

CREATE POLICY "Authenticated users upload to own folder"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'report-images'
    AND auth.uid() IS NOT NULL
    AND (storage.foldername(name))[1] = 'reports'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );

-- Only service_role (Edge Functions) can delete images
-- Design decision: users cannot delete their own report images because:
-- (1) images are evidence — a user should not be able to delete a verified report image
-- (2) cleanup confirmation may reference the image
-- (3) admins handle deletion for rejected reports via service_role
