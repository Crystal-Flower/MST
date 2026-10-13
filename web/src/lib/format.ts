export const shortHash = (h?: string | null, a = 6, b = 4) => (h ? `${h.slice(0, a)}…${h.slice(-b)}` : "–");

export function time(iso?: string | null, seconds = false) {
  if (!iso) return "–";
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) });
}

export function dateTime(iso?: string | null) {
  if (!iso) return "–";
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${time(iso, true)}`;
}

export function ago(iso?: string | null, now = Date.now()) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function duration(fromIso?: string | null, toIso?: string | null) {
  if (!fromIso) return "–";
  const s = Math.max(0, Math.round(((toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function mstc(v?: string | number | null, digits = 4) {
  if (v === null || v === undefined || v === "") return "–";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const fixed = n === 0 ? "0" : n < 0.0001 ? n.toExponential(2) : n.toFixed(digits).replace(/\.?0+$/, "");
  return `${fixed} MSTC`;
}

export function inr(v?: number | null) {
  if (v === null || v === undefined) return "–";
  return `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: v % 1 ? 2 : 0 })}`;
}

export const pct = (v?: number | null, d = 0) => (v === null || v === undefined ? "–" : `${Number(v).toFixed(d)}%`);
export const km = (v?: number | null) => (v === null || v === undefined ? "–" : v < 1 ? `${Math.round(v * 1000)} m` : `${v.toFixed(1)} km`);
export const initials = (name?: string | null) =>
  (name ?? "?")
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
export const titleCase = (s?: string) => (s ?? "").toLowerCase().replace(/(^|[\s_])(\w)/g, (_m, a, b) => `${a === "_" ? " " : a}${b.toUpperCase()}`);
