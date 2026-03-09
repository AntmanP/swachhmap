// ============================================================================
// SwachhMap — MunicipalityDashboard.jsx (Sprint 3)
//
// Who uses this: Municipal corporation officers, NGO field coordinators,
//                Swachh Bharat programme administrators.
//
// What it does:
//   - Shows all reports for their city, filterable by status/severity/type
//   - Lets them assign cleanups (marks report as cleanup_triggered)
//   - Lets them confirm completed cleanups (calls confirm-cleanup Edge Fn)
//   - Shows city-level analytics: total reports, cleaned %, top hotspots
//   - Real-time: new Critical reports flash in immediately via Supabase broadcast
//
// Design decisions:
//   1. Separate route (/municipality) — not embedded in the citizen app.
//      Municipality officers have a different mental model and workflow.
//   2. DEV_MODE seeds fake reports so the dashboard is usable before real data.
//   3. Confirm cleanup calls the Edge Function which fires the DB trigger
//      that auto-awards +50 bonus points to the original reporter.
//   4. No Mapbox/Leaflet here — the list view is faster for officers who need
//      to triage dozens of reports quickly. Map is in the citizen app.
// ============================================================================

import { useState, useEffect, useRef } from "react";
import { supabase } from "./lib/supabase.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const SEVERITY_COLOR = { Low: "#4ade80", Medium: "#fb923c", High: "#f87171", Critical: "#e11d48" };
const STATUS_COLOR   = { pending: "#fb923c", verified: "#60a5fa", cleanup_triggered: "#a78bfa", cleaned: "#4ade80", rejected: "#6b7280" };
const STATUS_LABEL   = { pending: "Pending", verified: "Verified", cleanup_triggered: "In Progress", cleaned: "Cleaned ✅", rejected: "Rejected" };
const WASTE_ICONS    = { "Plastic Waste":"🛍️","Food Waste":"🍱","E-Waste":"📱","Construction Debris":"🧱","Mixed Litter":"🗑️","Hazardous Waste":"⚠️","Organic Waste":"🌿","Medical Waste":"🧪" };

// ── Dev seed data ─────────────────────────────────────────────────────────────
const DEV_REPORTS = [
  { id:"r1", waste_type:"Hazardous Waste",   severity:"Critical", status:"pending",          location_label:"Dharavi, Mumbai",    city:"Mumbai", created_at: new Date(Date.now()-1000*60*8).toISOString(),  points_awarded:60, ai_confidence:91, reporter_name:"Amit K.",  tags:["industrial","drain"]   },
  { id:"r2", waste_type:"Plastic Waste",     severity:"High",     status:"pending",          location_label:"Andheri West",       city:"Mumbai", created_at: new Date(Date.now()-1000*60*22).toISOString(), points_awarded:30, ai_confidence:87, reporter_name:"Priya S.", tags:["roadside"]             },
  { id:"r3", waste_type:"E-Waste",           severity:"High",     status:"verified",         location_label:"Bandra Kurla Complex",city:"Mumbai",created_at: new Date(Date.now()-1000*60*60).toISOString(), points_awarded:50, ai_confidence:94, reporter_name:"Rahul M.", tags:["office-zone"]          },
  { id:"r4", waste_type:"Construction Debris",severity:"Medium",  status:"cleanup_triggered",location_label:"Powai, Mumbai",      city:"Mumbai", created_at: new Date(Date.now()-1000*60*120).toISOString(),points_awarded:35, ai_confidence:78, reporter_name:"Sneha P.", tags:["construction"]         },
  { id:"r5", waste_type:"Mixed Litter",      severity:"Medium",   status:"pending",          location_label:"Juhu Beach",         city:"Mumbai", created_at: new Date(Date.now()-1000*60*180).toISOString(),points_awarded:25, ai_confidence:82, reporter_name:"Dev T.",   tags:["beach","tourist"]      },
  { id:"r6", waste_type:"Food Waste",        severity:"Low",      status:"cleaned",          location_label:"Dadar Market",       city:"Mumbai", created_at: new Date(Date.now()-1000*60*300).toISOString(),points_awarded:20, ai_confidence:89, reporter_name:"Meena R.", tags:["market"]               },
  { id:"r7", waste_type:"Medical Waste",     severity:"Critical", status:"pending",          location_label:"Sion Hospital Road", city:"Mumbai", created_at: new Date(Date.now()-1000*60*5).toISOString(),  points_awarded:55, ai_confidence:96, reporter_name:"Kavita L.", tags:["hospital","hazardous"] },
  { id:"r8", waste_type:"Organic Waste",     severity:"Low",      status:"verified",         location_label:"Goregaon East",      city:"Mumbai", created_at: new Date(Date.now()-1000*60*400).toISOString(),points_awarded:15, ai_confidence:73, reporter_name:"Arjun B.", tags:["residential"]          },
];

const DEV_STATS = {
  total: 847, pending: 143, cleaned: 512, critical: 28,
  cleanRate: 60, avgResponseHours: 14,
  topHotspots: [
    { area: "Dharavi",       count: 89, severity: "Critical" },
    { area: "Andheri West",  count: 67, severity: "High"     },
    { area: "Kurla",         count: 54, severity: "High"     },
    { area: "Bandra East",   count: 41, severity: "Medium"   },
    { area: "Juhu",          count: 38, severity: "Medium"   },
  ],
  byType: [
    { type: "Plastic Waste",    count: 312, pct: 37 },
    { type: "Mixed Litter",     count: 186, pct: 22 },
    { type: "Food Waste",       count: 143, pct: 17 },
    { type: "Construction Debris", count: 102, pct: 12 },
    { type: "Hazardous Waste",  count: 104, pct: 12 },
  ],
};

// ── Time formatter ─────────────────────────────────────────────────────────────
function timeAgo(d) {
  const s = Math.floor((Date.now() - new Date(d)) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

// ── Main Component ─────────────────────────────────────────────────────────────
export default function MunicipalityDashboard({ devMode = true }) {
  const [activeTab, setActiveTab]     = useState("reports");   // reports | analytics | alerts
  const [reports, setReports]         = useState([]);
  const [stats, setStats]             = useState(null);
  const [loading, setLoading]         = useState(true);
  const [filterStatus, setFilterStatus]     = useState("all");
  const [filterSeverity, setFilterSeverity] = useState("all");
  const [searchQuery, setSearchQuery]       = useState("");
  const [selectedReport, setSelectedReport] = useState(null);
  const [actionLoading, setActionLoading]   = useState("");   // reportId being actioned
  const [actionNote, setActionNote]         = useState("");
  const [toast, setToast]                   = useState(null); // { msg, type }
  const [newAlerts, setNewAlerts]           = useState([]);   // real-time Critical reports
  const toastTimer = useRef(null);

  // ── Load data ────────────────────────────────────────────────────────────────
  useEffect(() => { loadAll(); setupRealtime(); }, []);

  async function loadAll() {
    setLoading(true);
    if (devMode) {
      await new Promise(r => setTimeout(r, 600));
      setReports(DEV_REPORTS);
      setStats(DEV_STATS);
    } else {
      const [{ data: reps }, { data: counts }] = await Promise.all([
        supabase.from("public_feed").select("*").order("created_at", { ascending: false }).limit(100),
        supabase.from("reports").select("status, severity, waste_type, city, created_at, location_label"),
      ]);
      setReports(reps ?? []);
      if (counts) computeStats(counts);
    }
    setLoading(false);
  }

  function computeStats(rows) {
    const total   = rows.length;
    const cleaned = rows.filter(r => r.status === "cleaned").length;
    const pending = rows.filter(r => r.status === "pending").length;
    const critical= rows.filter(r => r.severity === "Critical").length;
    const typeCounts = {};
    rows.forEach(r => { typeCounts[r.waste_type] = (typeCounts[r.waste_type]||0)+1; });
    const byType = Object.entries(typeCounts).sort((a,b)=>b[1]-a[1]).slice(0,5)
      .map(([type,count])=>({ type, count, pct: Math.round(count/total*100) }));
    setStats({ total, cleaned, pending, critical, cleanRate: Math.round(cleaned/total*100)||0, avgResponseHours: 18, byType, topHotspots: [] });
  }

  // ── Real-time: listen for new Critical reports ───────────────────────────────
  function setupRealtime() {
    const ch = supabase.channel("public-feed")
      .on("broadcast", { event: "new_report" }, ({ payload }) => {
        if (payload.severity === "Critical" || payload.hazardous) {
          setNewAlerts(a => [payload, ...a].slice(0, 10));
          showToast(`🚨 New Critical report: ${payload.waste_type} in ${payload.city ?? "unknown"}`, "critical");
        }
        setReports(prev => [payload, ...prev]);
      })
      .subscribe();
    return () => supabase.removeChannel(ch);
  }

  function showToast(msg, type = "info") {
    setToast({ msg, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }

  // ── Actions ──────────────────────────────────────────────────────────────────
  async function handleMarkInProgress(reportId) {
    setActionLoading(reportId);
    if (devMode) {
      await new Promise(r => setTimeout(r, 600));
      setReports(rs => rs.map(r => r.id === reportId ? { ...r, status: "cleanup_triggered" } : r));
      if (selectedReport?.id === reportId) setSelectedReport(s => ({ ...s, status: "cleanup_triggered" }));
      showToast("✅ Marked as In Progress — cleanup team notified", "success");
    } else {
      const { error } = await supabase.from("reports").update({ status: "cleanup_triggered" }).eq("id", reportId);
      if (error) showToast(`Error: ${error.message}`, "error");
      else { await loadAll(); showToast("✅ Marked as In Progress", "success"); }
    }
    setActionLoading("");
  }

  async function handleConfirmCleanup(reportId) {
    setActionLoading(reportId);
    if (devMode) {
      await new Promise(r => setTimeout(r, 800));
      setReports(rs => rs.map(r => r.id === reportId ? { ...r, status: "cleaned" } : r));
      if (selectedReport?.id === reportId) setSelectedReport(s => ({ ...s, status: "cleaned" }));
      showToast("🎉 Cleanup confirmed! +50 bonus points sent to reporter", "success");
    } else {
      const { error } = await supabase.functions.invoke("confirm-cleanup", {
        body: { reportId, actionedByName: "Municipality Officer", actionedByType: "municipality", notes: actionNote },
      });
      if (error) showToast(`Error: ${error.message}`, "error");
      else { await loadAll(); showToast("🎉 Cleanup confirmed! +50 bonus points sent to reporter", "success"); }
    }
    setActionNote("");
    setActionLoading("");
  }

  async function handleReject(reportId) {
    setActionLoading(reportId);
    if (devMode) {
      await new Promise(r => setTimeout(r, 500));
      setReports(rs => rs.map(r => r.id === reportId ? { ...r, status: "rejected" } : r));
      if (selectedReport?.id === reportId) setSelectedReport(s => ({ ...s, status: "rejected" }));
      showToast("Report marked as rejected", "info");
    } else {
      await supabase.from("reports").update({ status: "rejected" }).eq("id", reportId);
      await loadAll();
      showToast("Report rejected", "info");
    }
    setActionLoading("");
  }

  // ── Filtering ────────────────────────────────────────────────────────────────
  const filtered = reports.filter(r => {
    if (filterStatus   !== "all" && r.status   !== filterStatus)   return false;
    if (filterSeverity !== "all" && r.severity !== filterSeverity) return false;
    if (searchQuery && !`${r.waste_type} ${r.location_label} ${r.reporter_name}`.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const pendingCritical = reports.filter(r => r.severity === "Critical" && r.status === "pending").length;

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div style={D.root}>
      {/* Background */}
      <div style={D.bg} />

      {/* Toast notification */}
      {toast && (
        <div style={{ ...D.toastBox, background: toast.type === "critical" ? "#2d1010" : toast.type === "success" ? "#0d1f10" : "#131f14", borderColor: toast.type === "critical" ? "#e11d4888" : toast.type === "success" ? "#2d5a2e" : "#2a4a2e" }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <header style={D.header}>
        <div>
          <div style={D.logo}>🏛️ SwachhMap</div>
          <div style={D.logoSub}>Municipality Dashboard · Mumbai</div>
        </div>
        <div style={D.headerRight}>
          {pendingCritical > 0 && (
            <div style={D.alertBadge}>
              🚨 {pendingCritical} Critical
            </div>
          )}
          {devMode && <div style={D.devChip}>DEV MODE</div>}
          <div style={D.officerBadge}>
            <div style={D.officerAvatar}>MC</div>
            <div>
              <div style={D.officerName}>Municipal Corp.</div>
              <div style={D.officerRole}>Administrator</div>
            </div>
          </div>
        </div>
      </header>

      {/* Stats strip */}
      {stats && (
        <div style={D.statsStrip}>
          {[
            { label:"Total Reports", val: stats.total,         color:"#a3e635" },
            { label:"Pending",       val: stats.pending,       color:"#fb923c" },
            { label:"Cleaned",       val: stats.cleaned,       color:"#4ade80" },
            { label:"Critical",      val: stats.critical,      color:"#e11d48" },
            { label:"Clean Rate",    val: `${stats.cleanRate}%`,color:"#60a5fa" },
            { label:"Avg Response",  val: `${stats.avgResponseHours}h`, color:"#a78bfa" },
          ].map(s => (
            <div key={s.label} style={D.statItem}>
              <span style={{ ...D.statVal, color: s.color }}>{s.val}</span>
              <span style={D.statLabel}>{s.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <nav style={D.tabs}>
        {[
          { id:"reports",   label:"📋 Reports" },
          { id:"analytics", label:"📊 Analytics" },
          { id:"alerts",    label:`🚨 Alerts${newAlerts.length ? ` (${newAlerts.length})` : ""}` },
        ].map(t => (
          <button key={t.id} style={{ ...D.tab, ...(activeTab===t.id ? D.tabActive : {}) }} onClick={() => setActiveTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <main style={D.main}>

        {/* ── REPORTS TAB ── */}
        {activeTab === "reports" && (
          <div style={D.twoCol}>

            {/* Left: filters + list */}
            <div style={D.listCol}>
              {/* Filter bar */}
              <div style={D.filterBar}>
                <input style={D.searchBox} placeholder="🔍 Search by type, location, reporter…"
                  value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
                <div style={D.filterRow}>
                  <select style={D.select} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
                    <option value="all">All Status</option>
                    {Object.entries(STATUS_LABEL).map(([v,l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <select style={D.select} value={filterSeverity} onChange={e => setFilterSeverity(e.target.value)}>
                    <option value="all">All Severity</option>
                    {["Critical","High","Medium","Low"].map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <button style={D.refreshBtn} onClick={loadAll}>↺</button>
                </div>
              </div>

              <div style={D.resultCount}>{filtered.length} reports</div>

              {/* Report list */}
              {loading ? (
                <div style={D.centreMsg}><div style={D.spinner}>⟳</div>Loading reports…</div>
              ) : filtered.length === 0 ? (
                <div style={D.centreMsg}>No reports match your filters</div>
              ) : (
                <div style={D.reportList}>
                  {filtered.map(r => (
                    <div key={r.id}
                      style={{ ...D.reportCard, ...(selectedReport?.id === r.id ? D.reportCardActive : {}), ...(r.severity === "Critical" && r.status === "pending" ? D.reportCardCritical : {}) }}
                      onClick={() => setSelectedReport(r)}>
                      <div style={D.reportCardTop}>
                        <span style={D.reportIcon}>{WASTE_ICONS[r.waste_type] ?? "🗑️"}</span>
                        <div style={D.reportCardMid}>
                          <div style={D.reportType}>{r.waste_type}</div>
                          <div style={D.reportLocation}>📍 {r.location_label ?? r.city ?? "Unknown"}</div>
                        </div>
                        <div style={D.reportCardRight}>
                          <span style={{ ...D.pill, background: (SEVERITY_COLOR[r.severity]??"#888")+"22", color: SEVERITY_COLOR[r.severity]??"#888", border:`1px solid ${SEVERITY_COLOR[r.severity]??"#888"}44` }}>
                            {r.severity}
                          </span>
                          <span style={{ fontSize:11, color:"#3a5a3e", marginTop:2 }}>{timeAgo(r.created_at)}</span>
                        </div>
                      </div>
                      <div style={D.reportCardBottom}>
                        <span style={{ ...D.statusPill, background:(STATUS_COLOR[r.status]??"#888")+"22", color:STATUS_COLOR[r.status]??"#888" }}>
                          {STATUS_LABEL[r.status] ?? r.status}
                        </span>
                        {r.reporter_name && <span style={D.reporterName}>by {r.reporter_name}</span>}
                        {r.tags?.length > 0 && r.tags.slice(0,2).map(t => (
                          <span key={t} style={D.tag}>#{t}</span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Right: detail panel */}
            <div style={D.detailCol}>
              {!selectedReport ? (
                <div style={{ ...D.centreMsg, height: "100%" }}>
                  <div style={{ fontSize: 36 }}>👈</div>
                  <div>Select a report to take action</div>
                </div>
              ) : (
                <div style={D.detailPanel}>
                  {/* Header */}
                  <div style={D.detailHeader}>
                    <span style={{ fontSize: 28 }}>{WASTE_ICONS[selectedReport.waste_type] ?? "🗑️"}</span>
                    <div>
                      <div style={D.detailTitle}>{selectedReport.waste_type}</div>
                      <div style={D.detailSub}>Report ID: {selectedReport.id?.slice(0,8) ?? "dev-id"}</div>
                    </div>
                    <button style={D.closeBtn} onClick={() => setSelectedReport(null)}>×</button>
                  </div>

                  {/* Pills */}
                  <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:16 }}>
                    <span style={{ ...D.pill, background:(SEVERITY_COLOR[selectedReport.severity]??"#888")+"22", color:SEVERITY_COLOR[selectedReport.severity]??"#888", border:`1px solid ${SEVERITY_COLOR[selectedReport.severity]??"#888"}44` }}>
                      {selectedReport.severity} severity
                    </span>
                    <span style={{ ...D.statusPill, background:(STATUS_COLOR[selectedReport.status]??"#888")+"22", color:STATUS_COLOR[selectedReport.status]??"#888" }}>
                      {STATUS_LABEL[selectedReport.status] ?? selectedReport.status}
                    </span>
                    {selectedReport.ai_confidence && (
                      <span style={{ ...D.pill, background:"#84cc1622", color:"#84cc16", border:"1px solid #84cc1644" }}>
                        {selectedReport.ai_confidence}% AI confidence
                      </span>
                    )}
                  </div>

                  {/* Info rows */}
                  {[
                    ["📍 Location",  selectedReport.location_label ?? selectedReport.city ?? "—"],
                    ["🕐 Reported",  timeAgo(selectedReport.created_at)],
                    ["👤 Reporter",  selectedReport.reporter_name ?? "Anonymous"],
                    ["⭐ Points",    `${selectedReport.points_awarded ?? 0} pts awarded`],
                  ].map(([label, val]) => (
                    <div key={label} style={D.infoRow}>
                      <span style={D.infoLabel}>{label}</span>
                      <span style={D.infoVal}>{val}</span>
                    </div>
                  ))}

                  {selectedReport.tags?.length > 0 && (
                    <div style={D.infoRow}>
                      <span style={D.infoLabel}>🏷️ Tags</span>
                      <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
                        {selectedReport.tags.map(t => <span key={t} style={D.tag}>#{t}</span>)}
                      </div>
                    </div>
                  )}

                  <div style={D.divider} />

                  {/* Action note */}
                  {selectedReport.status !== "cleaned" && selectedReport.status !== "rejected" && (
                    <div style={{ marginBottom:12 }}>
                      <label style={D.noteLabel}>📝 Note (optional)</label>
                      <textarea style={D.noteInput} rows={2}
                        placeholder="e.g. Ward 42 cleanup crew dispatched, ETA 2 hours…"
                        value={actionNote} onChange={e => setActionNote(e.target.value)} />
                    </div>
                  )}

                  {/* Action buttons — shown based on current status */}
                  <div style={D.actionBtns}>
                    {selectedReport.status === "pending" && (
                      <>
                        <button style={D.btnPrimary}
                          disabled={actionLoading === selectedReport.id}
                          onClick={() => handleMarkInProgress(selectedReport.id)}>
                          {actionLoading === selectedReport.id ? "⏳ Updating…" : "🚛 Mark In Progress"}
                        </button>
                        <button style={D.btnDanger}
                          disabled={actionLoading === selectedReport.id}
                          onClick={() => handleReject(selectedReport.id)}>
                          ✕ Reject
                        </button>
                      </>
                    )}
                    {selectedReport.status === "verified" && (
                      <button style={D.btnPrimary}
                        disabled={actionLoading === selectedReport.id}
                        onClick={() => handleMarkInProgress(selectedReport.id)}>
                        {actionLoading === selectedReport.id ? "⏳ Updating…" : "🚛 Dispatch Cleanup Team"}
                      </button>
                    )}
                    {selectedReport.status === "cleanup_triggered" && (
                      <button style={{ ...D.btnPrimary, background:"linear-gradient(135deg,#166534,#14532d)" }}
                        disabled={actionLoading === selectedReport.id}
                        onClick={() => handleConfirmCleanup(selectedReport.id)}>
                        {actionLoading === selectedReport.id ? "⏳ Confirming…" : "✅ Confirm Cleanup Done"}
                      </button>
                    )}
                    {selectedReport.status === "cleaned" && (
                      <div style={D.cleanedBadge}>✅ Cleanup confirmed · Reporter earned +50 bonus pts</div>
                    )}
                    {selectedReport.status === "rejected" && (
                      <div style={{ ...D.cleanedBadge, background:"#2d101044", color:"#6b7280" }}>✕ Report rejected</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── ANALYTICS TAB ── */}
        {activeTab === "analytics" && stats && (
          <div style={D.analyticsGrid}>

            {/* Clean rate ring */}
            <div style={D.analyticsCard}>
              <div style={D.analyticsCardTitle}>Cleanup Rate</div>
              <div style={D.ringWrap}>
                <svg width="120" height="120" viewBox="0 0 120 120">
                  <circle cx="60" cy="60" r="50" fill="none" stroke="#1a2e1c" strokeWidth="12"/>
                  <circle cx="60" cy="60" r="50" fill="none" stroke="#4ade80" strokeWidth="12"
                    strokeDasharray={`${stats.cleanRate * 3.14} 314`}
                    strokeLinecap="round" transform="rotate(-90 60 60)"/>
                </svg>
                <div style={D.ringLabel}>
                  <div style={D.ringPct}>{stats.cleanRate}%</div>
                  <div style={D.ringLblTxt}>cleaned</div>
                </div>
              </div>
              <div style={{ fontSize:12, color:"#4a6b4e", textAlign:"center" }}>
                {stats.cleaned} of {stats.total} reports resolved
              </div>
            </div>

            {/* Waste type breakdown */}
            <div style={{ ...D.analyticsCard, gridColumn:"span 2" }}>
              <div style={D.analyticsCardTitle}>Top Waste Types</div>
              {stats.byType.map((w,i) => (
                <div key={w.type} style={D.barRow}>
                  <span style={D.barLabel}>{WASTE_ICONS[w.type]??""} {w.type}</span>
                  <div style={D.barBg}>
                    <div style={{ ...D.barFill, width:`${w.pct}%`, background:["#e11d48","#f87171","#fb923c","#60a5fa","#4ade80"][i]??"#7dba5f" }} />
                  </div>
                  <span style={D.barPct}>{w.pct}%</span>
                  <span style={D.barCount}>{w.count}</span>
                </div>
              ))}
            </div>

            {/* Top hotspots */}
            {stats.topHotspots.length > 0 && (
              <div style={{ ...D.analyticsCard, gridColumn:"span 3" }}>
                <div style={D.analyticsCardTitle}>Top Hotspots</div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))", gap:10 }}>
                  {stats.topHotspots.map((h,i) => (
                    <div key={h.area} style={D.hotspotCard}>
                      <div style={D.hotspotRank}>#{i+1}</div>
                      <div style={D.hotspotArea}>{h.area}</div>
                      <div style={{ ...D.pill, background:(SEVERITY_COLOR[h.severity]??"#888")+"22", color:SEVERITY_COLOR[h.severity]??"#888", border:`1px solid ${SEVERITY_COLOR[h.severity]??"#888"}44`, marginTop:4, display:"inline-block" }}>{h.severity}</div>
                      <div style={D.hotspotCount}>{h.count} reports</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Status breakdown */}
            <div style={{ ...D.analyticsCard, gridColumn:"span 3" }}>
              <div style={D.analyticsCardTitle}>Status Breakdown</div>
              <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
                {Object.entries(STATUS_LABEL).map(([status, label]) => {
                  const count = reports.filter(r => r.status === status).length;
                  return (
                    <div key={status} style={{ ...D.statusChip, background:(STATUS_COLOR[status]??"#888")+"18", border:`1px solid ${STATUS_COLOR[status]??"#888"}44` }}>
                      <span style={{ fontSize:20, fontWeight:700, color:STATUS_COLOR[status]??"#888" }}>{count}</span>
                      <span style={{ fontSize:11, color:"#5a7d5e" }}>{label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ── ALERTS TAB ── */}
        {activeTab === "alerts" && (
          <div>
            <div style={D.alertsHeader}>
              <div style={D.sectionTitle}>🚨 Real-time Critical Alerts</div>
              <div style={{ fontSize:12, color:"#4a6b4e" }}>New Critical & Hazardous reports appear here instantly via live connection</div>
            </div>
            {newAlerts.length === 0 ? (
              <div style={D.centreMsg}>
                <div style={{ fontSize: 36 }}>📡</div>
                <div>Listening for critical reports…</div>
                <div style={{ fontSize:11, color:"#3a5a3e", marginTop:4 }}>New Critical severity reports will appear here in real-time</div>
              </div>
            ) : newAlerts.map((a, i) => (
              <div key={i} style={D.alertCard}>
                <div style={D.alertTop}>
                  <span style={{ fontSize:24 }}>🚨</span>
                  <div style={{ flex:1 }}>
                    <div style={D.alertType}>{a.waste_type}</div>
                    <div style={D.alertLoc}>📍 {a.location_label ?? a.city ?? "Unknown location"}</div>
                  </div>
                  <span style={{ fontSize:11, color:"#e11d48" }}>{timeAgo(a.created_at)}</span>
                </div>
                <div style={{ display:"flex", gap:8, marginTop:8 }}>
                  <button style={{ ...D.btnPrimary, fontSize:12, padding:"6px 14px", flex:1 }}
                    onClick={() => { setActiveTab("reports"); setSelectedReport(a); }}>
                    View & Act →
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@300;400;500&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #0f1a10; }
        ::-webkit-scrollbar-thumb { background: #2a4a2e; border-radius: 2px; }
        select option { background: #131f14; color: #c8e6c0; }
        @keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
      `}</style>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const D = {
  root:            { minHeight:"100vh", background:"#0f1a10", color:"#e8f0e9", fontFamily:"'DM Sans',sans-serif", position:"relative" },
  bg:              { position:"fixed", inset:0, pointerEvents:"none", background:"radial-gradient(ellipse 80% 40% at 50% 0%, #1a3d1e33 0%, transparent 60%)", zIndex:0 },
  toastBox:        { position:"fixed", top:16, right:16, zIndex:9999, background:"#131f14", border:"1px solid #2a4a2e", borderRadius:12, padding:"10px 18px", fontSize:13, color:"#c8e6c0", maxWidth:360, boxShadow:"0 4px 20px #00000066", animation:"fadeIn 0.3s ease" },
  header:          { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"16px 24px", borderBottom:"1px solid #1f3322", position:"relative", zIndex:1 },
  logo:            { fontFamily:"'Syne',sans-serif", fontSize:20, fontWeight:800, color:"#7dba5f" },
  logoSub:         { fontSize:11, color:"#4a6b4e", marginTop:2 },
  headerRight:     { display:"flex", alignItems:"center", gap:12 },
  alertBadge:      { background:"#e11d4822", border:"1px solid #e11d4866", borderRadius:8, padding:"4px 12px", fontSize:12, color:"#e11d48", fontWeight:700, animation:"fadeIn 1s infinite alternate" },
  devChip:         { fontSize:10, color:"#fb923c", border:"1px solid #fb923c55", borderRadius:6, padding:"2px 8px", background:"#fb923c11" },
  officerBadge:    { display:"flex", alignItems:"center", gap:8 },
  officerAvatar:   { width:34, height:34, borderRadius:"50%", background:"linear-gradient(135deg,#1e5799,#1a3d6e)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, color:"#93c5fd" },
  officerName:     { fontSize:13, fontWeight:600, color:"#c8e6c0" },
  officerRole:     { fontSize:11, color:"#4a6b4e" },
  statsStrip:      { display:"flex", justifyContent:"space-around", padding:"10px 24px", background:"#0d170e", borderBottom:"1px solid #1a2e1c", position:"relative", zIndex:1, flexWrap:"wrap", gap:8 },
  statItem:        { display:"flex", flexDirection:"column", alignItems:"center", gap:2 },
  statVal:         { fontFamily:"'Syne',sans-serif", fontSize:18, fontWeight:700 },
  statLabel:       { fontSize:10, color:"#4a6b4e", textTransform:"uppercase", letterSpacing:0.5 },
  tabs:            { display:"flex", borderBottom:"1px solid #1f3322", background:"#0f1a10", position:"sticky", top:0, zIndex:10 },
  tab:             { flex:1, maxWidth:200, padding:"12px 16px", background:"none", border:"none", color:"#4a6b4e", fontSize:13, cursor:"pointer", fontFamily:"'DM Sans',sans-serif", borderBottom:"2px solid transparent", transition:"all 0.2s" },
  tabActive:       { color:"#a3e635", borderBottomColor:"#a3e635" },
  main:            { padding:"20px 24px", position:"relative", zIndex:1 },
  twoCol:          { display:"grid", gridTemplateColumns:"1fr 420px", gap:20, minHeight:"calc(100vh - 200px)" },
  listCol:         { display:"flex", flexDirection:"column", gap:12 },
  detailCol:       { position:"sticky", top:56, alignSelf:"start" },
  filterBar:       { display:"flex", flexDirection:"column", gap:8 },
  searchBox:       { background:"#131f14", border:"1px solid #2a4a2e", borderRadius:10, color:"#c8e6c0", padding:"9px 14px", fontSize:13, outline:"none", fontFamily:"'DM Sans',sans-serif", width:"100%" },
  filterRow:       { display:"flex", gap:8 },
  select:          { flex:1, background:"#131f14", border:"1px solid #2a4a2e", borderRadius:8, color:"#c8e6c0", padding:"7px 10px", fontSize:12, outline:"none", fontFamily:"'DM Sans',sans-serif", cursor:"pointer" },
  refreshBtn:      { background:"#1a2e1c", border:"1px solid #2a4a2e", color:"#7dba5f", borderRadius:8, padding:"7px 12px", cursor:"pointer", fontSize:16 },
  resultCount:     { fontSize:12, color:"#3a5a3e", paddingLeft:2 },
  reportList:      { display:"flex", flexDirection:"column", gap:8, maxHeight:"calc(100vh - 320px)", overflowY:"auto", paddingRight:4 },
  reportCard:      { background:"#131f14", border:"1px solid #1f3322", borderRadius:12, padding:"12px 14px", cursor:"pointer", transition:"all 0.15s", animation:"fadeIn 0.3s ease" },
  reportCardActive:{ border:"1px solid #4d7c3a", background:"#1a2e1c" },
  reportCardCritical:{ borderLeft:"3px solid #e11d48", background:"#1f1010" },
  reportCardTop:   { display:"flex", alignItems:"flex-start", gap:10, marginBottom:8 },
  reportIcon:      { fontSize:22, flexShrink:0, lineHeight:1, marginTop:2 },
  reportCardMid:   { flex:1 },
  reportType:      { fontSize:14, fontWeight:600, color:"#c8e6c0" },
  reportLocation:  { fontSize:12, color:"#4a6b4e", marginTop:2 },
  reportCardRight: { display:"flex", flexDirection:"column", alignItems:"flex-end", gap:4, flexShrink:0 },
  reportCardBottom:{ display:"flex", gap:6, flexWrap:"wrap", alignItems:"center" },
  pill:            { fontSize:11, padding:"2px 8px", borderRadius:20, fontWeight:500 },
  statusPill:      { fontSize:11, padding:"2px 8px", borderRadius:20, fontWeight:500 },
  reporterName:    { fontSize:11, color:"#3a5a3e" },
  tag:             { fontSize:10, color:"#4a6b4e", background:"#1a2e1c", border:"1px solid #2a4a2e", borderRadius:10, padding:"1px 6px" },
  detailPanel:     { background:"#131f14", border:"1px solid #1f3322", borderRadius:16, padding:"20px", animation:"fadeIn 0.2s ease" },
  detailHeader:    { display:"flex", alignItems:"center", gap:12, marginBottom:16 },
  detailTitle:     { fontFamily:"'Syne',sans-serif", fontSize:18, fontWeight:700, color:"#c8e6c0" },
  detailSub:       { fontSize:11, color:"#3a5a3e", marginTop:2 },
  closeBtn:        { marginLeft:"auto", background:"none", border:"none", color:"#4a6b4e", fontSize:22, cursor:"pointer", lineHeight:1 },
  infoRow:         { display:"flex", justifyContent:"space-between", alignItems:"flex-start", padding:"7px 0", borderBottom:"1px solid #1a2e1c", gap:16 },
  infoLabel:       { fontSize:12, color:"#4a6b4e", flexShrink:0 },
  infoVal:         { fontSize:13, color:"#c8e6c0", textAlign:"right" },
  divider:         { height:1, background:"#1a2e1c", margin:"16px 0" },
  noteLabel:       { display:"block", fontSize:12, color:"#4a6b4e", marginBottom:6 },
  noteInput:       { width:"100%", background:"#0d170e", border:"1px solid #2a4a2e", borderRadius:8, color:"#c8e6c0", padding:"8px 12px", fontSize:12, resize:"none", outline:"none", fontFamily:"'DM Sans',sans-serif" },
  actionBtns:      { display:"flex", gap:10, flexWrap:"wrap" },
  btnPrimary:      { flex:1, background:"linear-gradient(135deg,#4d7c3a,#2d5a20)", border:"none", color:"#c8e6c0", borderRadius:10, padding:"10px 16px", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"'Syne',sans-serif" },
  btnDanger:       { background:"#2d101044", border:"1px solid #e11d4866", color:"#f87171", borderRadius:10, padding:"10px 16px", fontSize:13, cursor:"pointer" },
  cleanedBadge:    { width:"100%", background:"#0d1f1044", border:"1px solid #2d5a2e", borderRadius:10, padding:"10px 16px", fontSize:13, color:"#4ade80", textAlign:"center" },
  analyticsGrid:   { display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:16 },
  analyticsCard:   { background:"#131f14", border:"1px solid #1f3322", borderRadius:14, padding:"18px" },
  analyticsCardTitle:{ fontFamily:"'Syne',sans-serif", fontSize:14, fontWeight:700, color:"#8ab98a", marginBottom:14 },
  ringWrap:        { position:"relative", width:120, height:120, margin:"0 auto 12px" },
  ringLabel:       { position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center" },
  ringPct:         { fontFamily:"'Syne',sans-serif", fontSize:22, fontWeight:700, color:"#4ade80" },
  ringLblTxt:      { fontSize:10, color:"#4a6b4e" },
  barRow:          { display:"flex", alignItems:"center", gap:10, marginBottom:10 },
  barLabel:        { fontSize:12, color:"#6b8c6e", width:160, flexShrink:0 },
  barBg:           { flex:1, height:6, background:"#1a2e1c", borderRadius:3, overflow:"hidden" },
  barFill:         { height:"100%", borderRadius:3, transition:"width 0.6s ease" },
  barPct:          { fontSize:12, color:"#4a6b4e", width:30, textAlign:"right" },
  barCount:        { fontSize:11, color:"#3a5a3e", width:36, textAlign:"right" },
  hotspotCard:     { background:"#0d170e", border:"1px solid #1a2e1c", borderRadius:10, padding:"12px" },
  hotspotRank:     { fontSize:11, color:"#3a5a3e", marginBottom:4 },
  hotspotArea:     { fontSize:14, fontWeight:600, color:"#c8e6c0" },
  hotspotCount:    { fontSize:12, color:"#4a6b4e", marginTop:4 },
  statusChip:      { display:"flex", flexDirection:"column", alignItems:"center", padding:"10px 16px", borderRadius:10, minWidth:100 },
  alertsHeader:    { marginBottom:16 },
  sectionTitle:    { fontFamily:"'Syne',sans-serif", fontSize:16, fontWeight:700, color:"#c8e6c0", marginBottom:4 },
  alertCard:       { background:"#1f1010", border:"1px solid #e11d4844", borderRadius:12, padding:"14px", marginBottom:10, animation:"fadeIn 0.3s ease" },
  alertTop:        { display:"flex", alignItems:"flex-start", gap:12 },
  alertType:       { fontSize:14, fontWeight:600, color:"#f87171" },
  alertLoc:        { fontSize:12, color:"#4a6b4e", marginTop:2 },
  centreMsg:       { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:10, padding:"60px 20px", color:"#4a6b4e", fontSize:13 },
  spinner:         { fontSize:24, animation:"spin 1s linear infinite", marginBottom:4 },
};