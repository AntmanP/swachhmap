// ============================================================================
// SwachhMap — MapView.jsx (Sprint 2 — Leaflet Edition)
// 100% free. No account. No API key. No card.
//
// Stack:
//   Leaflet.js       — map rendering (CDN, 42kb)
//   leaflet-heat     — heatmap layer plugin (CDN)
//   OpenStreetMap    — free map tiles, no key needed
//
// Design decisions vs Mapbox:
// 1. Leaflet loads from CDN exactly like Mapbox did — same pattern, zero npm issues.
// 2. OpenStreetMap tiles are free forever with no rate limits for reasonable use.
//    Attribution required (Leaflet adds it automatically in the corner).
// 3. leaflet-heat takes [lat, lng, intensity] arrays — simpler than Mapbox GeoJSON.
// 4. Circle markers at high zoom — no extra clustering plugin needed.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { supabase } from "./lib/supabase.js";

const SEVERITY_COLOR  = { Low: "#4ade80", Medium: "#fb923c", High: "#f87171", Critical: "#e11d48" };

const DEV_CLUSTERS = [
  { centroid_lng: 72.8777, centroid_lat: 19.0760, report_count: 42, dominant_type: "Plastic Waste",       max_severity: "High"     },
  { centroid_lng: 72.8340, centroid_lat: 18.9647, report_count: 18, dominant_type: "Mixed Litter",        max_severity: "Medium"   },
  { centroid_lng: 72.9781, centroid_lat: 19.1136, report_count: 7,  dominant_type: "E-Waste",             max_severity: "Critical" },
  { centroid_lng: 77.2090, centroid_lat: 28.6139, report_count: 61, dominant_type: "Hazardous Waste",     max_severity: "Critical" },
  { centroid_lng: 77.1025, centroid_lat: 28.7041, report_count: 29, dominant_type: "Plastic Waste",       max_severity: "High"     },
  { centroid_lng: 77.3910, centroid_lat: 28.5355, report_count: 14, dominant_type: "Food Waste",          max_severity: "Medium"   },
  { centroid_lng: 77.5946, centroid_lat: 12.9716, report_count: 38, dominant_type: "E-Waste",             max_severity: "High"     },
  { centroid_lng: 77.6408, centroid_lat: 12.9352, report_count: 22, dominant_type: "Mixed Litter",        max_severity: "Medium"   },
  { centroid_lng: 80.2707, centroid_lat: 13.0827, report_count: 31, dominant_type: "Plastic Waste",       max_severity: "High"     },
  { centroid_lng: 80.2101, centroid_lat: 12.9941, report_count: 9,  dominant_type: "Organic Waste",       max_severity: "Low"      },
  { centroid_lng: 78.4867, centroid_lat: 17.3850, report_count: 25, dominant_type: "Construction Debris", max_severity: "High"     },
  { centroid_lng: 78.5480, centroid_lat: 17.4126, report_count: 11, dominant_type: "Plastic Waste",       max_severity: "Medium"   },
  { centroid_lng: 73.8567, centroid_lat: 18.5204, report_count: 19, dominant_type: "Food Waste",          max_severity: "Medium"   },
  { centroid_lng: 88.3639, centroid_lat: 22.5726, report_count: 33, dominant_type: "Mixed Litter",        max_severity: "High"     },
  { centroid_lng: 72.5714, centroid_lat: 23.0225, report_count: 15, dominant_type: "Plastic Waste",       max_severity: "Medium"   },
  { centroid_lng: 75.7873, centroid_lat: 26.9124, report_count: 12, dominant_type: "Hazardous Waste",     max_severity: "Critical" },
];

// clustersToHeatPoints removed — leaflet-heat replaced with circle markers

export default function MapView({ devMode = false, onLocationCaptured, mapActive = false }) {
  const mapContainer  = useRef(null);
  const mapRef        = useRef(null);
  const markersRef    = useRef([]);
  const hasLoaded     = useRef(false); // prevent re-fetch on parent re-renders

  // Fix white tiles when map container becomes visible after being hidden
  useEffect(() => {
    const handleVisibility = () => {
      if (mapRef.current && document.visibilityState === "visible") {
        setTimeout(() => mapRef.current?.invalidateSize(), 100);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    // Also fix on window resize
    const handleResize = () => mapRef.current?.invalidateSize();
    window.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("resize", handleResize);
    };
  }, []);
  const userMarkerRef = useRef(null);

  const [leafletReady, setLeafletReady]           = useState(false);
  const [gpsStatus, setGpsStatus]                 = useState("idle");
  const [userCoords, setUserCoords]               = useState(null);
  const [selectedCluster, setSelectedCluster]     = useState(null);
  const [filterSeverity, setFilterSeverity]       = useState("all");
  const [statsBar, setStatsBar]                   = useState({ total: 0, critical: 0, zones: 0 });
  const [loadingData, setLoadingData]             = useState(false);

  // Load Leaflet + leaflet-heat from CDN
  useEffect(() => {
    if (!mapActive) return;
    if (window.L) { setLeafletReady(true); return; }
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(css);
    const s1 = document.createElement("script");
    s1.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    s1.onload  = () => setLeafletReady(true);
    s1.onerror = () => setLeafletReady(true);
    document.head.appendChild(s1);
  }, [mapActive]);

  // Init map once Leaflet is ready
  useEffect(() => {
    if (!leafletReady || !mapContainer.current || mapRef.current) return;
    const L = window.L;
    mapRef.current = L.map(mapContainer.current, { center: [20.5937, 78.9629], zoom: 4, zoomControl: false, preferCanvas: true });
    window._leafletMap = mapRef.current; // expose for parent invalidateSize calls
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '© <a href="https://openstreetmap.org/copyright" style="color:#4a6b4e">OpenStreetMap</a>',
      maxZoom: 18, minZoom: 3,
      keepBuffer: 1,
      updateWhenIdle: true,
      updateWhenZooming: false,
      crossOrigin: true,
      errorTileUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    }).addTo(mapRef.current);
    L.control.zoom({ position: "bottomright" }).addTo(mapRef.current);
    // No leaflet-heat — use circle markers only (avoids canvas width=0 crash)
    mapRef.current.on("zoomend", () => {
      const z = mapRef.current.getZoom();
      markersRef.current.forEach(m => z >= 8 ? m.addTo(mapRef.current) : m.remove());
    });
    // Start data fetch once — skip if already loaded (tab switch)
    if (!hasLoaded.current) {
      hasLoaded.current = true;
      loadData("all");
    }

    // Ensure map knows its real size (fixes blank tile corners)
    const fixSize = () => { if (mapRef.current) mapRef.current.invalidateSize(); };
    if (mapContainer.current && mapContainer.current.offsetWidth > 0) {
      setTimeout(fixSize, 0);
    } else {
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.contentRect.width > 0) { observer.disconnect(); fixSize(); break; }
        }
      });
      if (mapContainer.current) observer.observe(mapContainer.current);
      const fallback = setTimeout(() => { observer.disconnect(); fixSize(); }, 500);
      return () => { observer.disconnect(); clearTimeout(fallback); };
    }
  }, [leafletReady]);

  // Refresh data every time the map tab is opened (component remounts due to key prop)
  // Removed — loadData is already called inside the leafletReady effect above.
  // Having two callers caused double-fetch and race conditions.

  async function loadData(severity = "all") {
    setLoadingData(true);
    const safetyTimer = setTimeout(() => {
      setLoadingData(false);
      console.warn("MapView: loadData safety timeout — showing empty map");
    }, 45000); // covers 3 retry attempts with waits
    let data;
    try {
    if (devMode) {
      await new Promise(r => setTimeout(r, 400));
      data = DEV_CLUSTERS;
    } else {
      // Lightweight query — only fetch what we need, with retry for cold starts
      let rows = null, rowsError = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const queryPromise = supabase
          .from("reports")
          .select("severity, waste_type, location_label, city")
          .not("location_label", "is", null)
          .limit(300);
        const timeoutMs = attempt === 1 ? 8000 : 12000;
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("query timeout")), timeoutMs)
        );
        try {
          const result = await Promise.race([queryPromise, timeoutPromise]);
          rows = result.data;
          rowsError = result.error;
          break;
        } catch (e) {
          console.warn(`MapView: query attempt ${attempt} failed:`, e.message);
          if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
          else throw e;
        }
      }
      {

        // Group by city into pseudo-clusters with approximate coords
        const CITY_COORDS = {
          Mumbai: [19.076, 72.877], Delhi: [28.614, 77.209], Bengaluru: [12.972, 77.595],
          Chennai: [13.083, 80.271], Hyderabad: [17.385, 78.487], Pune: [18.520, 73.857],
          Kolkata: [22.573, 88.364], Ahmedabad: [23.023, 72.571], Jaipur: [26.912, 75.787],
          Nagpur: [21.145, 79.082], Indore: [22.719, 75.857], Bhopal: [23.259, 77.413],
          Surat: [21.170, 72.831], Lucknow: [26.847, 80.947],
        };
        const grouped = {};
        (rows ?? []).forEach(r => {
          const k = r.city ?? "Unknown";
          if (!grouped[k]) grouped[k] = { city: k, reports: [] };
          grouped[k].reports.push(r);
        });
        // Parse all reports with valid GPS coords
        const parsed = (rows ?? []).flatMap(r => {
          if (!r.location_label) return [];
          const parts = r.location_label.split(",").map(s => Number(s.trim()));
          if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) return [];
          const [lat, lng] = parts;
          // Validate coords are within real world bounds
          if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return [];
          if (lat === 0 && lng === 0) return []; // skip null island
          return [{ lat, lng, severity: r.severity, waste_type: r.waste_type }];
        });

        // Cluster nearby GPS reports — group within ~500m grid cells
        // Grid cell size: 0.005 degrees ≈ 500m
        const GRID = 0.005;
        const cells = {};
        parsed.forEach(r => {
          const key = `${Math.round(r.lat / GRID)},${Math.round(r.lng / GRID)}`;
          if (!cells[key]) cells[key] = { lats: [], lngs: [], reports: [] };
          cells[key].lats.push(r.lat);
          cells[key].lngs.push(r.lng);
          cells[key].reports.push(r);
        });

        const gpsReports = Object.values(cells).map(cell => {
          const avgLat = cell.lats.reduce((a,b) => a+b, 0) / cell.lats.length;
          const avgLng = cell.lngs.reduce((a,b) => a+b, 0) / cell.lngs.length;
          if (isNaN(avgLat) || isNaN(avgLng)) return null;
          const severities = cell.reports.map(r => r.severity);
          const maxSev = ["Critical","High","Medium","Low"].find(s => severities.includes(s)) ?? "Low";
          const types = cell.reports.map(r => r.waste_type);
          const dominant = Object.entries(types.reduce((a,t) => { a[t]=(a[t]||0)+1; return a; }, {}))
            .sort((a,b) => b[1]-a[1])[0]?.[0] ?? "Mixed Litter";
          return { centroid_lat: avgLat, centroid_lng: avgLng,
            report_count: cell.reports.length, dominant_type: dominant, max_severity: maxSev };
        }).filter(Boolean);

        // Add city-based clusters for reports without GPS coords
        const cityData = Object.values(grouped)
          .filter(g => CITY_COORDS[g.city])
          .map(g => {
            const [lat, lng] = CITY_COORDS[g.city];
            const severities = g.reports.map(r => r.severity);
            const maxSev = ["Critical","High","Medium","Low"].find(s => severities.includes(s)) ?? "Low";
            const types = g.reports.map(r => r.waste_type);
            const dominant = Object.entries(types.reduce((a,t)=>{a[t]=(a[t]||0)+1;return a},{}))
              .sort((a,b)=>b[1]-a[1])[0]?.[0] ?? "Mixed Litter";
            return { centroid_lat: lat + (Math.random()-0.5)*0.02, centroid_lng: lng + (Math.random()-0.5)*0.02,
              report_count: g.reports.length, dominant_type: dominant, max_severity: maxSev };
          });

        // Only use cityData for reports that had NO valid GPS coords
        // to avoid double-counting the same reports
        const gpsRowCount = parsed.length;
        const noGpsRows = (rows ?? []).length - gpsRowCount;
        // If all reports had GPS, skip cityData entirely
        const mergedData = noGpsRows > 0 ? [...gpsReports, ...cityData] : gpsReports;
        data = mergedData.length ? mergedData : DEV_CLUSTERS;
        if (rowsError) console.error("MapView query error:", rowsError);
      }
    }
    } catch (err) {
      console.error("MapView loadData error:", err);
      data = DEV_CLUSTERS;
    }
    const filtered = severity === "all" ? data : data.filter(c => c.max_severity === severity);
    clearTimeout(safetyTimer);
    setLoadingData(false);
    renderOnMap(filtered);
    const totalReports = filtered.reduce((s, c) => s + c.report_count, 0);
    const criticalReports = filtered
      .filter(c => c.max_severity === "Critical")
      .reduce((s, c) => s + c.report_count, 0);
    setStatsBar({
      total:    totalReports,
      critical: criticalReports,
      zones:    filtered.length,  // number of distinct location clusters
    });

    // On first load only: if there's exactly one cluster, fly to it
    // If multiple clusters, stay at India overview so user sees all of them
    if (!devMode && filtered.length === 1 && mapRef.current) {
      const first = filtered[0];
      mapRef.current.flyTo([first.centroid_lat, first.centroid_lng], 13, { duration: 1.2 });
    }
  }

  function renderOnMap(data) {
    const L = window.L;
    if (!mapRef.current || !L) return;
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];
    const currentZoom = mapRef.current.getZoom();
    // Filter out any clusters with invalid coords before rendering
    const valid = data.filter(c =>
      c.centroid_lat != null && c.centroid_lng != null &&
      !isNaN(c.centroid_lat) && !isNaN(c.centroid_lng) &&
      Math.abs(c.centroid_lat) <= 90 && Math.abs(c.centroid_lng) <= 180
    );
    valid.forEach(c => {
      const color  = SEVERITY_COLOR[c.max_severity] ?? "#7dba5f";
      // Outer glow ring — simulates heatmap density
      const glowRadius = Math.max(18, Math.min(60, Math.sqrt(c.report_count) * 8));
      const glow = L.circleMarker([c.centroid_lat, c.centroid_lng], {
        radius: glowRadius, fillColor: color, fillOpacity: 0.12,
        color: color, weight: 0.5, opacity: 0.3,
      });
      // Inner solid dot
      const dot = L.circleMarker([c.centroid_lat, c.centroid_lng], {
        radius: Math.max(6, Math.min(18, Math.sqrt(c.report_count) * 2.5)),
        fillColor: color, fillOpacity: 0.9,
        color: "#ffffff44", weight: 1.5,
      });
      dot.on("click", () => {
        setSelectedCluster(c);
        mapRef.current.flyTo([c.centroid_lat, c.centroid_lng], Math.max(mapRef.current.getZoom(), 13), { duration: 0.8 });
      });
      dot.bindTooltip(`<b>${c.dominant_type}</b><br/>${c.report_count} reports · ${c.max_severity}`, { className: "swachh-tooltip", direction: "top" });
      glow.addTo(mapRef.current);
      dot.addTo(mapRef.current);
      markersRef.current.push(glow, dot);
    });
  }

  function locateMe() {
    if (!navigator.geolocation) { setGpsStatus("denied"); return; }
    setGpsStatus("locating");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        setUserCoords({ lat, lng, accuracy });
        setGpsStatus("found");
        const L = window.L;
        if (!mapRef.current || !L) return;
        mapRef.current.flyTo([lat, lng], 14, { duration: 1.5 });
        if (userMarkerRef.current) userMarkerRef.current.remove();
        const icon = L.divIcon({
          className: "",
          html: `<div style="width:18px;height:18px;border-radius:50%;background:#a3e635;border:3px solid white;box-shadow:0 0 0 6px #a3e63544;animation:gps-pulse 2s infinite;"></div>`,
          iconSize: [18, 18], iconAnchor: [9, 9],
        });
        userMarkerRef.current = L.marker([lat, lng], { icon }).addTo(mapRef.current)
          .bindPopup(`<b>You are here</b><br/>±${Math.round(accuracy)}m accuracy`).openPopup();
        onLocationCaptured?.({ lat, lng, accuracy });
      },
      (err) => setGpsStatus(err.code === 1 ? "denied" : "error"),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  function handleFilter(sev) { setFilterSeverity(sev); setSelectedCluster(null); loadData(sev); }

  return (
    <div style={S.wrap}>
      <div style={S.statsBar}>
        <div style={S.chip}><span style={S.chipNum}>{statsBar.total}</span><span style={S.chipLbl}>Reports</span></div>
        <div style={{ ...S.chip, borderColor: "#e11d4855" }}><span style={{ ...S.chipNum, color: "#e11d48" }}>{statsBar.critical}</span><span style={S.chipLbl}>Critical</span></div>
        <div style={S.chip}><span style={S.chipNum}>{statsBar.zones}</span><span style={S.chipLbl}>Clusters</span></div>
        {devMode && <div style={S.devBadge}>DEV DATA</div>}
      </div>

      <div style={S.filterRow}>
        {["all","Critical","High","Medium","Low"].map(sev => (
          <button key={sev} style={{ ...S.pill, background: filterSeverity === sev ? (sev==="all"?"#2d5a20":SEVERITY_COLOR[sev]+"33") : "transparent", color: filterSeverity === sev ? (sev==="all"?"#a3e635":SEVERITY_COLOR[sev]) : "#4a6b4e", borderColor: sev==="all"?"#2d5a20":(SEVERITY_COLOR[sev]??"#2a4a2e")+"66" }} onClick={() => handleFilter(sev)}>
            {sev === "all" ? "All" : sev}
          </button>
        ))}
      </div>

      <div style={S.mapWrap}>
        {(loadingData) && (
          <div style={S.loadOverlay}>
            <div style={S.loadSpinner}>⟳</div>
            <div style={{ fontSize: 13, color: "#4a6b4e" }}>Loading reports…</div>
          </div>
        )}
        <div ref={mapContainer} style={S.map} />
        <button style={S.gpsBtn} onClick={locateMe} title="Find my location">
          {{ idle:"📍", locating:"⏳", found:"✅", denied:"🚫", error:"❌" }[gpsStatus]}
        </button>
        {gpsStatus === "locating" && <div style={S.toast}>Getting your location…</div>}
        {gpsStatus === "found" && userCoords && <div style={{ ...S.toast, background:"#1a3320dd", borderColor:"#2d5a20" }}>📍 Located · ±{Math.round(userCoords.accuracy)}m</div>}
        {gpsStatus === "denied" && <div style={{ ...S.toast, background:"#2d1010dd", borderColor:"#e11d4866" }}>Location blocked — enable in browser settings</div>}
        {selectedCluster && (
          <div style={S.popup}>
            <button style={S.popupClose} onClick={() => setSelectedCluster(null)}>×</button>
            <div style={S.popupTitle}>{selectedCluster.dominant_type}</div>
            <div style={{ display:"flex", gap:6, margin:"8px 0", flexWrap:"wrap" }}>
              <span style={{ ...S.popupPill, background:(SEVERITY_COLOR[selectedCluster.max_severity]??"#888")+"22", color:SEVERITY_COLOR[selectedCluster.max_severity]??"#888" }}>{selectedCluster.max_severity} severity</span>
              <span style={{ ...S.popupPill, background:"#a3e63522", color:"#a3e635" }}>{selectedCluster.report_count} reports</span>
            </div>
            <div style={S.popupAction}>{selectedCluster.max_severity==="Critical"?"⚠️ Municipality alert triggered":"🧹 Cleanup recommended"}</div>
          </div>
        )}

      </div>

      {userCoords && (
        <div style={S.coordsBox}>
          <span style={{ color:"#4a6b4e" }}>📍 Your GPS:</span>
          <span style={{ color:"#7dba5f" }}>{userCoords.lat.toFixed(5)}°N, {userCoords.lng.toFixed(5)}°E</span>
          <span style={{ color:"#3a5a3e" }}>±{Math.round(userCoords.accuracy)}m</span>
        </div>
      )}

      <style>{`
        .swachh-tooltip { background:#131f14ee!important;border:1px solid #2a4a2e!important;border-radius:8px!important;color:#c8e6c0!important;font-family:'DM Sans',sans-serif!important;font-size:12px!important;padding:6px 10px!important;box-shadow:0 4px 12px #00000066!important; }
        .swachh-tooltip::before { display:none!important; }
        .leaflet-popup-content-wrapper { background:#131f14!important;border:1px solid #2a4a2e!important;border-radius:10px!important;color:#c8e6c0!important; }
        .leaflet-popup-tip { background:#131f14!important; }
        .leaflet-popup-close-button { color:#4a6b4e!important; }
        .leaflet-control-zoom a { background:#131f14!important;color:#7dba5f!important;border-color:#2a4a2e!important; }
        .leaflet-control-attribution { background:#0f1a10aa!important;color:#3a5a3e!important;font-size:9px!important; }
        .leaflet-control-attribution a { color:#4a6b4e!important; }
        .leaflet-tile { filter: brightness(0.65) saturate(0.35) hue-rotate(55deg); }
        @keyframes gps-pulse { 0%{box-shadow:0 0 0 0 #a3e63588}70%{box-shadow:0 0 0 14px #a3e63500}100%{box-shadow:0 0 0 0 #a3e63500} }
        @keyframes spin { from{transform:rotate(0deg)}to{transform:rotate(360deg)} }
      `}</style>
    </div>
  );
}

const S = {
  wrap:        { display:"flex", flexDirection:"column", gap:10 },
  statsBar:    { display:"flex", gap:8, alignItems:"center" },
  chip:        { display:"flex", flexDirection:"column", alignItems:"center", background:"#131f14", border:"1px solid #1f3322", borderRadius:10, padding:"6px 14px", flex:1 },
  chipNum:     { fontFamily:"'Syne',sans-serif", fontSize:18, fontWeight:700, color:"#a3e635" },
  chipLbl:     { fontSize:10, color:"#4a6b4e", textTransform:"uppercase", letterSpacing:0.5 },
  devBadge:    { fontSize:9, color:"#fb923c", border:"1px solid #fb923c55", borderRadius:6, padding:"2px 6px", background:"#fb923c11" },
  filterRow:   { display:"flex", gap:6, flexWrap:"wrap" },
  pill:        { fontSize:11, padding:"4px 12px", borderRadius:20, border:"1px solid", cursor:"pointer", fontWeight:500, transition:"all 0.15s", fontFamily:"'DM Sans',sans-serif" },
  mapWrap:     { position:"relative", borderRadius:16, overflow:"hidden", height:420, background:"#0d170e", border:"1px solid #1f3322" },
  map:         { width:"100%", height:"100%" },
  loadOverlay: { position:"absolute", inset:0, zIndex:999, background:"#0d170eee", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:12 },
  loadSpinner: { fontSize:28, animation:"spin 1s linear infinite", color:"#4a6b4e" },
  gpsBtn:      { position:"absolute", top:12, right:12, zIndex:500, width:40, height:40, borderRadius:10, background:"#131f14ee", border:"1px solid #2a4a2e", fontSize:18, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" },
  toast:       { position:"absolute", bottom:52, left:"50%", transform:"translateX(-50%)", zIndex:500, background:"#131f14dd", border:"1px solid #2a4a2e", borderRadius:10, padding:"6px 14px", fontSize:12, color:"#7dba5f", whiteSpace:"nowrap" },
  popup:       { position:"absolute", bottom:52, left:12, right:12, zIndex:500, background:"#131f14f2", border:"1px solid #2a4a2e", borderRadius:14, padding:"14px 16px", backdropFilter:"blur(8px)" },
  popupClose:  { position:"absolute", top:10, right:12, background:"none", border:"none", color:"#4a6b4e", fontSize:20, cursor:"pointer", lineHeight:1 },
  popupTitle:  { fontFamily:"'Syne',sans-serif", fontSize:16, fontWeight:700, color:"#c8e6c0" },
  popupPill:   { fontSize:11, padding:"2px 8px", borderRadius:20, fontWeight:500 },
  popupAction: { fontSize:12, color:"#5a7d5e", marginTop:6 },
  legend:      { position:"absolute", bottom:12, left:12, zIndex:500, background:"#131f14cc", border:"1px solid #1f3322", borderRadius:8, padding:"6px 10px" },
  legendTitle: { fontSize:9, color:"#4a6b4e", textTransform:"uppercase", letterSpacing:1, marginBottom:4 },
  legendBar:   { width:80, height:6, borderRadius:3, background:"linear-gradient(90deg,#1a3320,#2d7a3a,#a3e635,#fb923c,#e11d48)" },
  legendLbls:  { display:"flex", justifyContent:"space-between", fontSize:9, color:"#3a5a3e", marginTop:2 },
  coordsBox:   { display:"flex", gap:10, background:"#131f14", border:"1px solid #1f3322", borderRadius:10, padding:"8px 12px", fontSize:11, flexWrap:"wrap" },
};
