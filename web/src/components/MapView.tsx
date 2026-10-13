import L from "leaflet";
import { useEffect, useMemo, useRef } from "react";
import { MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";
import { MARKER, type MarkerState } from "@astra/shared";
import { useLive } from "../lib/store";
import { MARKER_STYLE } from "../lib/tone";
import type { Bin, Worker } from "../lib/types";

export type MapBin = Pick<Bin, "id" | "name" | "lat" | "lng" | "marker" | "fillPct" | "online">;
export type MapWorker = Pick<Worker, "id" | "name" | "lat" | "lng" | "status">;

const iconCache = new Map<string, L.DivIcon>();

function binIcon(marker: MarkerState, selected: boolean) {
  const key = `${marker}:${selected}`;
  const hit = iconCache.get(key);
  if (hit) return hit;
  const s = MARKER_STYLE[marker];
  const size = selected ? 24 : 17;
  const pulse = s.pulse ? `<span class="pulse-ring" style="position:absolute;inset:0;border-radius:9999px;background:${s.fill}"></span>` : "";
  const ring = selected ? `<span style="position:absolute;inset:-5px;border-radius:9999px;border:2px solid #17181b"></span>` : "";
  const html = `<div style="position:relative;width:${size}px;height:${size}px">${pulse}${ring}<span style="position:absolute;inset:0;border-radius:9999px;background:${s.hollow ? "#ffffff" : s.fill};border:2px solid ${s.hollow ? s.ring : "#ffffff"};box-shadow:0 1px 3px rgba(23,24,27,.28);display:flex;align-items:center;justify-content:center;color:#fff;font:700 ${selected ? 10 : 8.5}px/1 'Inter Variable',sans-serif">${s.glyph}</span></div>`;
  const icon = L.divIcon({ html, className: "astra-marker", iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  iconCache.set(key, icon);
  return icon;
}

function workerIcon(initials: string, moving: boolean, highlighted: boolean) {
  const key = `w:${initials}:${moving}:${highlighted}`;
  const hit = iconCache.get(key);
  if (hit) return hit;
  const size = highlighted ? 30 : 26;
  const html = `<div style="width:${size}px;height:${size}px;border-radius:9999px;background:#17181b;color:#fff;display:flex;align-items:center;justify-content:center;font:600 ${size * 0.38}px/1 'Inter Variable',sans-serif;border:2px solid ${moving ? "#2a78d6" : "#ffffff"};box-shadow:0 2px 6px rgba(23,24,27,.3)">${initials}</div>`;
  const icon = L.divIcon({ html, className: "astra-worker", iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  iconCache.set(key, icon);
  return icon;
}

function FitBounds({ points, focus, fit }: { points: [number, number][]; focus?: [number, number] | null; fit?: [number, number][] | null }) {
  const map = useMap();
  const done = useRef(false);
  const focusKey = fit?.length ? fit.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join("|") : focus ? `${focus[0].toFixed(6)},${focus[1].toFixed(6)}` : null;
  const lastFocus = useRef<string | null>(null);
  useEffect(() => {
    if (fit?.length && focusKey) {
      if (lastFocus.current === focusKey) return;
      lastFocus.current = focusKey;
      done.current = true;
      map.flyToBounds(L.latLngBounds(fit), { padding: [56, 56], maxZoom: 16, duration: 0.8 });
      return;
    }
    if (focus && focusKey) {
      // Fly only when the focus actually moves, so live updates don't fight the user's panning.
      if (lastFocus.current === focusKey) return;
      lastFocus.current = focusKey;
      done.current = true;
      map.flyTo(focus, Math.max(map.getZoom(), 15), { duration: 0.8 });
      return;
    }
    lastFocus.current = null;
    if (done.current || points.length === 0) return;
    done.current = true;
    map.fitBounds(L.latLngBounds(points), { padding: [36, 36], maxZoom: 15, animate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, points, focusKey]);
  return null;
}

function TileFallback() {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    let loaded = false;
    const onLoad = () => {
      loaded = true;
      el.classList.remove("tiles-offline");
    };
    map.on("tileload", onLoad);
    const t = setTimeout(() => !loaded && el.classList.add("tiles-offline"), 2500);
    return () => {
      clearTimeout(t);
      map.off("tileload", onLoad);
    };
  }, [map]);
  return null;
}

/**
 * The municipal map. Bins and workers come from the API; live telemetry and
 * GPS positions stream in over SSE and move markers without refetching.
 */
export function MapView({
  bins,
  workers = [],
  selectedBin,
  onSelectBin,
  highlightWorker,
  routes = [],
  track,
  focus,
  fit,
  height = 420,
  className,
  zoomControl = true,
}: {
  bins: MapBin[];
  workers?: MapWorker[];
  selectedBin?: string | null;
  onSelectBin?: (id: string) => void;
  highlightWorker?: string | null;
  routes?: { from: [number, number]; to: [number, number]; tone?: "progress" | "neutral" }[];
  /** A GPS trail, oldest first. */
  track?: [number, number][];
  focus?: [number, number] | null;
  /** Frame these points (e.g. a worker and their bin); re-frames when they change. */
  fit?: [number, number][] | null;
  height?: number | string;
  className?: string;
  zoomControl?: boolean;
}) {
  const liveWorkers = useLive((s) => s.workers);
  const points = useMemo(
    () => [...bins.map((b) => [b.lat, b.lng] as [number, number]), ...workers.map((w) => [w.lat, w.lng] as [number, number]), ...(track ?? [])],
    [bins, workers, track],
  );
  const center: [number, number] = points[0] ?? [12.9716, 77.5946];

  return (
    <div className={className} style={{ height }}>
      <MapContainer center={center} zoom={13} zoomControl={zoomControl} scrollWheelZoom attributionControl className="h-full w-full rounded-[inherit]">
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          maxZoom={19}
        />
        <TileFallback />
        <FitBounds points={points} focus={focus} fit={fit} />
        {routes.map((r, i) => (
          <Polyline key={i} positions={[r.from, r.to]} pathOptions={{ color: r.tone === "neutral" ? "#8a8883" : "#2a78d6", weight: 2, opacity: 0.7, dashArray: "4 6" }} />
        ))}
        {track && track.length > 1 && <Polyline positions={track} pathOptions={{ color: "#17181b", weight: 2, opacity: 0.55 }} />}
        {bins.map((b) => (
          <Marker key={b.id} position={[b.lat, b.lng]} icon={binIcon(b.marker, b.id === selectedBin)} eventHandlers={{ click: () => onSelectBin?.(b.id) }} zIndexOffset={b.id === selectedBin ? 800 : b.marker === "NORMAL" ? 0 : 400}>
            <Tooltip className="astra-tip" direction="top" offset={[0, -10]}>
              <div className="font-medium">
                {b.id} · {b.name}
              </div>
              <div className="opacity-80">
                {MARKER[b.marker].label} · {Math.round(b.fillPct)}%
              </div>
            </Tooltip>
          </Marker>
        ))}
        {workers.map((w) => {
          const live = liveWorkers[w.id];
          const pos: [number, number] = live ? [live.lat, live.lng] : [w.lat, w.lng];
          const initials = w.name
            .split(" ")
            .map((p) => p[0])
            .join("")
            .slice(0, 2);
          const moving = w.status === "EN_ROUTE" || w.status === "ASSIGNED";
          return (
            <Marker key={w.id} position={pos} icon={workerIcon(initials, moving, w.id === highlightWorker)} zIndexOffset={1000}>
              <Tooltip className="astra-tip" direction="top" offset={[0, -14]}>
                <div className="font-medium">{w.name}</div>
                <div className="opacity-80">{(w.status ?? "offline").replace(/_/g, " ").toLowerCase()}</div>
              </Tooltip>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}

export function MapLegend({ counts }: { counts?: Partial<Record<MarkerState, number>> }) {
  const order: MarkerState[] = ["NORMAL", "MONITORING", "FULL", "AI_VERIFICATION", "AWAITING_ASSIGNMENT", "EN_ROUTE", "COLLECTING", "AWAITING_APPROVAL", "INVESTIGATION", "COMPLETED", "OFFLINE"];
  return (
    <ul className="space-y-1.5">
      {order.map((m) => {
        const s = MARKER_STYLE[m];
        return (
          <li key={m} className="flex items-center justify-between gap-3 text-[12.5px]">
            <span className="flex items-center gap-2 text-ink-2">
              <span
                className="flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-bold text-white"
                style={{ background: s.hollow ? "#fff" : s.fill, border: `2px solid ${s.hollow ? s.ring : "#fff"}`, boxShadow: "0 0 0 1px rgba(23,24,27,.12)" }}
              >
                {s.glyph}
              </span>
              {MARKER[m].label}
            </span>
            {counts && <span className="text-ink-3 num">{counts[m] ?? 0}</span>}
          </li>
        );
      })}
    </ul>
  );
}
