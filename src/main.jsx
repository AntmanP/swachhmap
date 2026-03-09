import { createRoot } from "react-dom/client";
import SwachhMap from "./SwachhMap.jsx";
import MunicipalityDashboard from "./MunicipalityDashboard.jsx";

// ── Simple path-based router ──────────────────────────────────────────────────
// /municipality  → Municipality admin dashboard
// anything else  → Citizen app
//
// NOTE: StrictMode intentionally removed — it double-invokes useEffect in dev
// which causes Supabase GoTrueClient auth token lock races ("steal" errors).
// The singleton supabase client in lib/supabase.js prevents multiple instances,
// but StrictMode's double-mount still triggers concurrent getSession() calls.

function App() {
  const path = window.location.pathname;
  if (path.startsWith("/municipality")) {
    return <MunicipalityDashboard devMode={true} />;
  }
  return <SwachhMap />;
}

createRoot(document.getElementById("root")).render(<App />);