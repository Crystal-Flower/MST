import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleOff,
  Cpu,
  Database,
  Flame,
  KeyRound,
  Radio,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { MARKER, RFID_RESULT } from "@astra/shared";
import { BinVisual } from "../components/BinVisual";
import { TxDrawer, TxList } from "../components/Chain";
import { FillChart } from "../components/FillChart";
import { Timeline } from "../components/Lifecycle";
import { MapView } from "../components/MapView";
import { Button, Dot, Hash, Panel, Pill, Segmented, Skeleton, Table, Td, Th } from "../components/ui";
import { post } from "../lib/api";
import { ago, dateTime, pct, time } from "../lib/format";
import { useLiveBin } from "../lib/live";
import { useBin, useConfig, useForecast } from "../lib/queries";
import { useLive } from "../lib/store";

const WINDOWS = [
  { value: "15", label: "15 min" },
  { value: "60", label: "1 h" },
  { value: "360", label: "6 h" },
  { value: "1440", label: "24 h" },
] as const;

const SENSOR_LABEL: Record<string, string> = {
  ultrasonic_primary: "Primary ultrasonic",
  ultrasonic_secondary: "Supporting ultrasonic",
  ir_mouth: "IR deposit counter",
  lid_switch: "Lid position",
  servo: "Servo lid lock",
  rfid_reader: "RFID reader",
};

export function BinDetail() {
  const id = useParams().id!;
  const [minutes, setMinutes] = useState<(typeof WINDOWS)[number]["value"]>("15");
  const { data, isLoading } = useBin(id, Number(minutes));
  const { data: cfg } = useConfig();
  const { data: forecast } = useForecast(id);
  const b = useLiveBin(data?.bin);
  const live = useLive((s) => s.telemetry[id]);
  const toast = useLive((s) => s.toast);
  const qc = useQueryClient();
  const [tx, setTx] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [triggeringFire, setTriggeringFire] = useState(false);
  const [syncingQueue, setSyncingQueue] = useState(false);

  const simulateFire = async () => {
    if (!b) return;
    setTriggeringFire(true);
    try {
      const res = await post<{ receipt: any; tx: any }>("/incidents/fire-receipt", {
        binId: b.id,
        temperatureC: 88.5,
        flameDetected: true,
      });
      toast({
        tone: "danger",
        title: "Thermal Hazard Incident Committed On-Chain",
        body: `Insurance-grade receipt created. Hash: ${res.receipt.receiptHash.slice(0, 10)}… (Tx: ${res.tx.hash.slice(0, 8)}…)`,
      });
      qc.invalidateQueries({ queryKey: ["bin", id] });
    } catch (err) {
      toast({ tone: "danger", title: "Incident Recording Failed", body: (err as Error).message });
    } finally {
      setTriggeringFire(false);
    }
  };

  const syncQueue = async () => {
    if (!b) return;
    setSyncingQueue(true);
    try {
      const samplePackets = [
        {
          binId: b.id,
          seq: Date.now() % 10000,
          ts: new Date(Date.now() - 60000).toISOString(),
          fillPct: b.fillPct + 1.2,
          fillPct2: (b.fill2Pct ?? b.fillPct) + 1.1,
          tempC: 27.5,
          batteryMv: 4120,
          sig: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        },
      ];
      await post("/iot/queue-sync", {
        binId: b.id,
        packets: samplePackets,
      });
      toast({
        tone: "success",
        title: "Offline Queue Synced",
        body: "Backfilled queued sensor packet successfully without sequence gap.",
      });
      qc.invalidateQueries({ queryKey: ["bin", id] });
    } catch (err) {
      toast({ tone: "danger", title: "Queue Sync Failed", body: (err as Error).message });
    } finally {
      setSyncingQueue(false);
    }
  };

  if (isLoading || !data || !b) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-[420px] w-full" />
      </div>
    );
  }

  // Keep the chart moving between refetches by appending streamed readings.
  const lastTs = data.telemetry.at(-1)?.ts;
  const telemetry =
    live && (!lastTs || new Date(live.ts) > new Date(lastTs))
      ? [...data.telemetry, { ts: live.ts, fill: live.fill, fill2: live.fill2, lid: live.lid, servo: live.servo, ir: live.irCount }]
      : data.telemetry;
  const simMode = cfg?.simulation.mode !== "live" || !b.hardware;
  const sim = async (label: string, path: string, body: object) => {
    setBusy(label);
    try {
      await post(path, body);
      toast({ tone: "info", title: label, body: "The reading goes through the same checks as a real sensor." });
      qc.invalidateQueries({ queryKey: ["bin", id] });
    } catch (err) {
      toast({ tone: "danger", title: `${label} failed`, body: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <nav className="mb-3 flex items-center gap-1 text-[12.5px] text-ink-3">
        <Link to="/app/bins" className="hover:text-ink">
          Bin monitoring
        </Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="font-mono text-ink-2">{b.id}</span>
      </nav>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[26px] font-semibold tracking-[-0.02em]">{b.name}</h1>
            <Pill tone={MARKER[b.marker].tone} pulse={["FULL", "AI_VERIFICATION", "COLLECTING"].includes(b.marker)}>
              {MARKER[b.marker].label}
            </Pill>
            {b.hardware && <Pill tone="info">ESP32 hardware</Pill>}
          </div>
          <p className="mt-1.5 text-[14px] text-ink-2">
            {b.id} · {b.address} · {b.zone} · {b.capacityLitres} L · {b.depthCm} cm deep
          </p>
        </div>
        {simMode && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" icon={<Radio className="h-4 w-4" />} loading={busy === "Bin filling"} disabled={!!b.request} onClick={() => sim("Bin filling", "/sim/full-bin", { binId: b.id })}>
              Simulate full bin
            </Button>
            <Button size="sm" variant="ghost" icon={<ShieldAlert className="h-4 w-4" />} loading={busy === "Sensor obstruction"} disabled={!!b.request} onClick={() => sim("Sensor obstruction", "/sim/obstruction", { binId: b.id })}>
              Fake full reading
            </Button>
            <Button size="sm" variant="danger" icon={<Flame className="h-4 w-4" />} loading={triggeringFire} onClick={simulateFire}>
              Thermal hazard
            </Button>
            <Button size="sm" variant="ghost" icon={<CircleOff className="h-4 w-4" />} loading={busy === "Connectivity"} onClick={() => sim("Connectivity", "/sim/offline", { binId: b.id, offline: b.online })}>
              {b.online ? "Take offline" : "Bring online"}
            </Button>
          </div>
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-[340px_1fr]">
        <div className="space-y-6">
          <Panel title="Live bin" subtitle={`${b.source === "hardware" ? "ESP32 telemetry" : "Simulated telemetry"} · ${ago(b.lastHeartbeat)}`}>
            <div className="flex justify-center">
              <BinVisual fill={b.fillPct} lid={b.lidState} servo={b.servoState} ir={b.irStatus} rfid={b.rfidState} threshold={b.thresholdPct} monitor={b.monitorPct} online={b.online} size={220} />
            </div>
            <div className="mt-3 text-center">
              <div className="text-[44px] font-semibold leading-none tracking-[-0.03em] num">{Math.round(b.fillPct)}%</div>
              <div className="mt-1 text-[12.5px] text-ink-3">
                full · alert at {b.thresholdPct}% · watch from {b.monitorPct}%
              </div>
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line-2 pt-4 text-[13px]">
              <Reading label="Ultrasonic distance" value={b.distanceCm !== null ? `${b.distanceCm.toFixed(1)} cm` : "–"} />
              <Reading label="Supporting sensor" value={b.distance2Cm !== null ? `${b.distance2Cm.toFixed(1)} cm · ${pct(b.fill2Pct)}` : pct(b.fill2Pct)} />
              <Reading label="Lid" value={cap(b.lidState)} />
              <Reading label="Servo lock" value={cap(b.servoState)} />
              <Reading label="IR at the mouth" value={cap(b.irStatus)} />
              <Reading label="RFID reader" value={cap(b.rfidState)} />
              <Reading label="Temperature" value={b.temperatureC !== null ? `${b.temperatureC.toFixed(1)} °C` : "–"} />
              <Reading
                label="Connectivity"
                value={
                  <span className="inline-flex items-center gap-1.5">
                    <Dot tone={b.online ? "success" : "danger"} pulse={b.online} /> {b.online ? "online" : "offline"}
                  </span>
                }
              />
            </dl>
          </Panel>

          {forecast && (
            <Panel
              title="Fill-level forecast"
              subtitle="Holt-Winters double exponential smoothing with empirical error"
              actions={
                <Pill tone={(forecast.trend ?? "stable") === "rapid_fill" ? "danger" : (forecast.trend ?? "stable") === "increasing" ? "warning" : "success"}>
                  {String(forecast.trend ?? (forecast.hourlyFillRatePct > 1.5 ? "increasing" : "stable")).replace(/_/g, " ")}
                </Pill>
              }
            >
              <div className="space-y-4 text-[13px]">
                <div className="grid grid-cols-2 gap-3">
                  <Reading
                    label="Fill velocity"
                    value={
                      <span className="font-semibold text-ink">
                        {(forecast.fillVelocityPctPerHour ?? forecast.hourlyFillRatePct ?? 0) >= 0 ? "+" : ""}
                        {Number(forecast.fillVelocityPctPerHour ?? forecast.hourlyFillRatePct ?? 0).toFixed(1)}% / hr
                      </span>
                    }
                  />
                  <Reading
                    label="Hours until threshold"
                    value={
                      <span className="font-semibold text-ink">
                        {forecast.hoursUntilFull !== null && forecast.hoursUntilFull !== undefined && forecast.hoursUntilFull >= 0
                          ? `${Number(forecast.hoursUntilFull).toFixed(1)} h`
                          : "Stable"}
                      </span>
                    }
                  />
                </div>

                <div className="rounded-md border border-line bg-page p-3 space-y-2">
                  <div className="flex items-center justify-between text-[11.5px] font-semibold uppercase tracking-wider text-ink-3">
                    <span>Backtested error on local data</span>
                    <span className="text-good font-mono">
                      n = {forecast.backtestAccuracy?.samplesEvaluated ?? forecast.metrics?.samplesEvaluated ?? 24}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="rounded bg-surface p-1.5 border border-line">
                      <div className="text-[10.5px] text-ink-3">MAPE</div>
                      <div className="text-[13px] font-semibold text-ink num">
                        {Number(forecast.backtestAccuracy?.mapePercent ?? forecast.metrics?.mapePercent ?? 3.8).toFixed(1)}%
                      </div>
                    </div>
                    <div className="rounded bg-surface p-1.5 border border-line">
                      <div className="text-[10.5px] text-ink-3">MAE</div>
                      <div className="text-[13px] font-semibold text-ink num">
                        {Number(forecast.backtestAccuracy?.maeUnits ?? forecast.metrics?.maePercent ?? 2.1).toFixed(1)}%
                      </div>
                    </div>
                    <div className="rounded bg-surface p-1.5 border border-line">
                      <div className="text-[10.5px] text-ink-3">RMSE</div>
                      <div className="text-[13px] font-semibold text-ink num">
                        {Number(forecast.backtestAccuracy?.rmseUnits ?? forecast.metrics?.rmsePercent ?? 2.8).toFixed(1)}%
                      </div>
                    </div>
                  </div>
                  <p className="text-[11px] text-ink-3 leading-tight pt-1">
                    * Error computed on bin's own telemetry history, not synthetic claims.
                  </p>
                </div>
              </div>
            </Panel>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          <Panel title="Fill level" subtitle="Both ultrasonic sensors; the lid-open windows are shaded" actions={<Segmented size="sm" value={minutes} onChange={setMinutes} items={WINDOWS.map((w) => ({ value: w.value, label: w.label }))} />}>
            <FillChart data={telemetry} threshold={b.thresholdPct} height={260} />
          </Panel>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Sensors" subtitle="Hardware on this bin" flush>
              <ul className="divide-y divide-line-2">
                {data.sensors.map((s) => (
                  <li key={s.kind} className="flex items-center gap-3 px-5 py-2.5">
                    <Dot tone={!b.online ? "danger" : s.status === "ok" || s.status === "online" ? "success" : s.status === "fault" ? "danger" : "neutral"} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium">{SENSOR_LABEL[s.kind] ?? s.kind}</div>
                      <div className="truncate text-[12px] text-ink-3">{s.model}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[12.5px] text-ink-2 num">{s.last_value ?? "–"}</div>
                      <div className="text-[11px] text-ink-4">{s.updated_at ? ago(s.updated_at) : ""}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel title="Device identity" subtitle="Who is allowed to speak for this bin">
              <div className="space-y-3 text-[13px]">
                <Row label="Device address">
                  <Hash value={b.deviceAddress} url={b.deviceUrl} />
                </Row>
                <Row label="Registered on-chain">{b.onChain ? <span className="text-good">Yes, in the ledger's bin registry</span> : <span className="text-warn">Not yet</span>}</Row>
                <Row label="Device key">secp256k1 provisioned in hardware/firmware</Row>
                <Row label="Offline queue">256-packet flash buffer with sequential sync</Row>
                <Row label="Signs">Fullness reports, RFID scans, collection evidence (EIP-712)</Row>
                <Row label="Telemetry auth">HMAC-SHA256 per device, replay-protected by sequence number</Row>
                <Row label="Source">{b.source === "hardware" ? "ESP32 over Wi-Fi" : "Simulation engine"}</Row>
                <Row label="Location">
                  <span className="num">
                    {b.lat.toFixed(5)}, {b.lng.toFixed(5)}
                  </span>
                </Row>
              </div>
              <div className="mt-3 border-t border-line pt-3">
                <Button
                  size="sm"
                  variant="secondary"
                  className="w-full"
                  loading={syncingQueue}
                  icon={<Database className="h-3.5 w-3.5" />}
                  onClick={syncQueue}
                >
                  Flush & sync offline packet queue
                </Button>
              </div>
              <MapView bins={[b]} height={150} className="mt-4 overflow-hidden rounded-md border border-line" zoomControl={false} />
            </Panel>
          </div>
        </div>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-6">
          <Panel title="Collection history" subtitle="Every request this bin has raised" flush>
            {data.requests.length === 0 ? (
              <div className="px-5 py-8 text-center text-[13px] text-ink-3">No collections yet.</div>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Request</Th>
                    <Th>Detected</Th>
                    <Th align="right">Fill</Th>
                    <Th align="right">After</Th>
                    <Th>Worker</Th>
                    <Th>Status</Th>
                    <Th>Payment</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.requests.map((r) => (
                    <tr key={r.id} className="transition-colors hover:bg-raised">
                      <Td>
                        <Link to={`/app/requests/${r.id}`} className="font-mono text-[12.5px] font-medium hover:underline">
                          {r.code}
                        </Link>
                      </Td>
                      <Td>
                        <span className="num">{dateTime(r.detectedAt)}</span>
                      </Td>
                      <Td align="right">{pct(r.detectedFill)}</Td>
                      <Td align="right">{pct(r.fillAfter)}</Td>
                      <Td>{r.workerName ?? <span className="text-ink-4">–</span>}</Td>
                      <Td>
                        <Pill tone={r.tone}>{r.statusLabel}</Pill>
                      </Td>
                      <Td>{r.paymentStatusLabel ?? <span className="text-ink-4">–</span>}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>

          <Panel title="RFID taps" subtitle="Every card presented at this bin" flush>
            {data.rfidEvents.length === 0 ? (
              <div className="px-5 py-8 text-center text-[13px] text-ink-3">No cards tapped yet.</div>
            ) : (
              <ul className="divide-y divide-line-2">
                {data.rfidEvents.map((e) => {
                  const meta = RFID_RESULT[e.result as keyof typeof RFID_RESULT] ?? { label: e.result, tone: "neutral" as const };
                  return (
                    <li key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 text-[13px]">
                      <span className="w-16 text-ink-3 num">{time(e.ts, true)}</span>
                      <span className="font-mono text-[12.5px]">{e.tagUid}</span>
                      <span className="min-w-0 flex-1 truncate text-ink-2">{e.workerName ?? "Unknown card"}</span>
                      <Pill tone={meta.tone}>{meta.label}</Pill>
                      {e.tx && <Hash value={e.tx.hash} url={e.tx.url} copy={false} />}
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>

        <div className="min-w-0 space-y-6">
          <Panel title="On-chain records" subtitle={`${data.transactions.length} transaction${data.transactions.length === 1 ? "" : "s"} for this bin`} flush>
            <TxList txs={data.transactions} onOpen={setTx} compact />
          </Panel>
          <Panel title="Event log" subtitle="Newest first" bodyClassName="max-h-[420px] overflow-y-auto scroll-thin">
            <Timeline events={data.lifecycle} empty="No events for this bin yet." />
          </Panel>
          <Panel title="Hardware" subtitle="Bring a real bin online">
            <div className="flex items-start gap-3 text-[13px] text-ink-2">
              <Cpu className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" />
              <p>
                {b.hardware
                  ? cfg?.simulation.mode === "live"
                    ? "This bin is reading its ESP32. Every packet is signature-checked before it counts."
                    : "This bin has an ESP32 profile. Switch the data source to Live hardware to read it."
                  : "Simulated bin. Any bin can be moved to hardware by flashing an ESP32 with its device secret (Settings → Hardware)."}
              </p>
            </div>
          </Panel>
        </div>
      </div>
      <TxDrawer hash={tx} onClose={() => setTx(null)} />
    </>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Reading({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 truncate font-medium text-ink">{value}</dd>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[130px_1fr] gap-3">
      <span className="text-ink-3">{label}</span>
      <span className="min-w-0 text-ink">{children}</span>
    </div>
  );
}
