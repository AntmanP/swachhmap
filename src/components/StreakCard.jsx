// ============================================================================
// StreakCard.jsx — Streak System UI (Sprint 4)
//
// Shows:
//   - Current streak with fire animation
//   - 7-day dot calendar (filled = reported that day)
//   - Progress to next 7-day bonus (+100 pts)
//   - "Streak at risk" warning if no report today
//   - Milestone celebration animation when streak hits 7, 14, 30
//
// Design decisions:
//   - Pure display component — all data comes from props (profile from DB)
//   - The actual streak logic lives in the DB trigger (trg_increment_report_count)
//     which updates streak_days on every report insert. This component just reads it.
//   - We derive "reported today" from last_report_date in the profile.
//   - DEV_MODE cycles through streak values so you can see all states.
// ============================================================================

import { useState, useEffect } from "react";

const MILESTONES  = [7, 14, 30, 60, 100];
const BONUS_EVERY = 7; // +100 pts every 7th day (matches DB trigger)

export default function StreakCard({ profile, devMode = true }) {
  const [celebrating, setCelebrating] = useState(false);
  const [devStreak, setDevStreak]     = useState(3); // cycle through in dev

  // Cycle dev streak to show all states
  useEffect(() => {
    if (!devMode) return;
    const t = setInterval(() => setDevStreak(s => (s % 10) + 1), 3000);
    return () => clearInterval(t);
  }, [devMode]);

  const streak      = devMode ? devStreak : (profile?.streak_days ?? 0);
  const lastReport  = profile?.last_report_date ? new Date(profile.last_report_date) : null;
  const today       = new Date();
  const reportedToday = lastReport
    ? lastReport.toDateString() === today.toDateString()
    : false;
  const streakAtRisk = !reportedToday && streak > 0;

  // Days until next 7-day bonus
  const daysToNextBonus  = BONUS_EVERY - (streak % BONUS_EVERY);
  const bonusThisCycle   = Math.floor(streak / BONUS_EVERY);
  const progressToBonus  = ((streak % BONUS_EVERY) / BONUS_EVERY) * 100;

  // Trigger celebration on milestone
  useEffect(() => {
    if (MILESTONES.includes(streak)) {
      setCelebrating(true);
      setTimeout(() => setCelebrating(false), 2000);
    }
  }, [streak]);

  // Build 7-day dot row — last 7 days, filled if within streak
  const dots = Array.from({ length: 7 }, (_, i) => {
    const dayOffset = 6 - i; // 0 = today, 6 = 6 days ago
    const filled    = dayOffset < streak && (dayOffset > 0 || reportedToday);
    const isToday   = dayOffset === 0;
    const d         = new Date(today);
    d.setDate(d.getDate() - dayOffset);
    return { filled, isToday, label: ["S","M","T","W","T","F","S"][d.getDay()] };
  });

  // Flame size/intensity scales with streak
  const flameSize = Math.min(32 + streak * 2, 56);
  const flameGlow = streak >= 7  ? "#fb923c" :
                    streak >= 3  ? "#fbbf24" : "#4ade80";

  return (
    <div style={{ ...S.card, ...(celebrating ? S.cardCelebrate : {}), ...(streakAtRisk ? S.cardAtRisk : {}) }}>

      {/* Celebration overlay */}
      {celebrating && (
        <div style={S.confetti}>
          {["🎉","⭐","🔥","✨","🏆"].map((e,i) => (
            <span key={i} style={{ ...S.confettiItem, animationDelay:`${i*0.1}s`, left:`${10+i*18}%` }}>{e}</span>
          ))}
        </div>
      )}

      {/* Header row */}
      <div style={S.header}>
        <div style={S.left}>
          <div style={S.title}>Daily Streak</div>
          {streakAtRisk && (
            <div style={S.atRisk}>⚠️ Report today to keep your streak!</div>
          )}
          {!streakAtRisk && streak > 0 && (
            <div style={S.subtext}>
              {daysToNextBonus === 1
                ? "🎁 Report today for +100 bonus pts!"
                : `${daysToNextBonus} more days for +100 bonus pts`}
            </div>
          )}
          {streak === 0 && (
            <div style={S.subtext}>Start your streak — report litter today!</div>
          )}
        </div>
        <div style={S.flameWrap}>
          <span style={{ fontSize: flameSize, filter: `drop-shadow(0 0 8px ${flameGlow})`, transition: "all 0.5s ease", lineHeight: 1 }}>
            🔥
          </span>
          <div style={{ ...S.streakNum, color: flameGlow }}>{streak}</div>
          <div style={S.streakLabel}>day{streak !== 1 ? "s" : ""}</div>
        </div>
      </div>

      {/* 7-day dot calendar */}
      <div style={S.dotRow}>
        {dots.map((d, i) => (
          <div key={i} style={S.dotCol}>
            <div style={{
              ...S.dot,
              background:   d.filled ? flameGlow : "#1a2e1c",
              border:       d.isToday ? `2px solid ${flameGlow}` : "2px solid #2a4a2e",
              boxShadow:    d.filled ? `0 0 8px ${flameGlow}88` : "none",
              transform:    d.filled && d.isToday ? "scale(1.2)" : "scale(1)",
            }} />
            <div style={{ ...S.dotLabel, color: d.isToday ? "#a3e635" : "#3a5a3e" }}>
              {d.label}
            </div>
          </div>
        ))}
      </div>

      {/* Progress bar to next bonus */}
      <div style={S.progressWrap}>
        <div style={S.progressTrack}>
          <div style={{ ...S.progressFill, width: `${progressToBonus}%`, background: `linear-gradient(90deg, ${flameGlow}88, ${flameGlow})` }} />
        </div>
        <div style={S.progressLabel}>
          {bonusThisCycle > 0 && <span style={{ color: "#a3e635" }}>🏆 ×{bonusThisCycle} bonus earned</span>}
          <span style={{ color: "#3a5a3e" }}>{streak % BONUS_EVERY}/{BONUS_EVERY} to next +100pts</span>
        </div>
      </div>

      {/* Milestone badges */}
      <div style={S.milestoneRow}>
        {MILESTONES.map(m => (
          <div key={m} style={{ ...S.milestoneBadge, ...(streak >= m ? S.milestoneDone : {}) }}>
            <div style={S.milestoneNum}>{m}d</div>
            <div style={S.milestoneIcon}>{streak >= m ? "🏆" : "🔒"}</div>
          </div>
        ))}
      </div>

      {devMode && (
        <div style={S.devNote}>DEV: streak auto-cycling every 3s to show all states</div>
      )}

      <style>{`
        @keyframes float {
          0%,100% { transform: translateY(0); }
          50%      { transform: translateY(-8px); }
        }
        @keyframes confettiFall {
          0%   { transform: translateY(-10px) rotate(0deg); opacity: 1; }
          100% { transform: translateY(60px) rotate(360deg); opacity: 0; }
        }
        @keyframes riskPulse {
          0%,100% { border-color: #e11d4844; }
          50%     { border-color: #e11d48cc; }
        }
      `}</style>
    </div>
  );
}

const S = {
  card:           { background:"#131f14", border:"1px solid #1f3322", borderRadius:16, padding:"18px 16px", marginBottom:16, position:"relative", overflow:"hidden", transition:"all 0.3s ease" },
  cardCelebrate:  { border:"1px solid #a3e63588", background:"#1a3320", boxShadow:"0 0 24px #a3e63522" },
  cardAtRisk:     { animation:"riskPulse 2s infinite", borderColor:"#e11d4844" },
  confetti:       { position:"absolute", top:0, left:0, right:0, height:60, pointerEvents:"none", zIndex:10 },
  confettiItem:   { position:"absolute", top:0, fontSize:18, animation:"confettiFall 1.5s ease-out forwards" },
  header:         { display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:16 },
  left:           { flex:1 },
  title:          { fontFamily:"'Syne',sans-serif", fontSize:16, fontWeight:700, color:"#c8e6c0", marginBottom:4 },
  atRisk:         { fontSize:11, color:"#f87171", fontWeight:600 },
  subtext:        { fontSize:11, color:"#5a7d5e" },
  flameWrap:      { display:"flex", flexDirection:"column", alignItems:"center", gap:2, animation:"float 2s ease-in-out infinite" },
  streakNum:      { fontFamily:"'Syne',sans-serif", fontSize:24, fontWeight:800, lineHeight:1 },
  streakLabel:    { fontSize:10, color:"#4a6b4e", textTransform:"uppercase", letterSpacing:1 },
  dotRow:         { display:"flex", justifyContent:"space-between", marginBottom:14 },
  dotCol:         { display:"flex", flexDirection:"column", alignItems:"center", gap:4 },
  dot:            { width:28, height:28, borderRadius:"50%", transition:"all 0.4s ease" },
  dotLabel:       { fontSize:9, textTransform:"uppercase", letterSpacing:0.5 },
  progressWrap:   { marginBottom:14 },
  progressTrack:  { height:6, background:"#1a2e1c", borderRadius:3, overflow:"hidden", marginBottom:6 },
  progressFill:   { height:"100%", borderRadius:3, transition:"width 0.6s ease" },
  progressLabel:  { display:"flex", justifyContent:"space-between", fontSize:11 },
  milestoneRow:   { display:"flex", gap:8, justifyContent:"space-between" },
  milestoneBadge: { flex:1, background:"#0d170e", border:"1px solid #1a2e1c", borderRadius:10, padding:"8px 4px", textAlign:"center", opacity:0.5, transition:"all 0.3s" },
  milestoneDone:  { opacity:1, border:"1px solid #2d5a2e", background:"#1a2e1c" },
  milestoneNum:   { fontSize:11, fontWeight:700, color:"#7dba5f", fontFamily:"'Syne',sans-serif" },
  milestoneIcon:  { fontSize:16, marginTop:2 },
  devNote:        { fontSize:9, color:"#2a4a2e", textAlign:"center", marginTop:10, fontStyle:"italic" },
};
