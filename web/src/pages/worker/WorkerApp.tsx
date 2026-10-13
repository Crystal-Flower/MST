import clsx from "clsx";
import {
  Award,
  Check,
  CheckCircle2,
  CircleX,
  Clock,
  Fingerprint,
  KeyRound,
  LocateFixed,
  LogOut,
  Navigation,
  ShieldCheck,
  Trash2,
  Truck,
  Wallet,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { haversineKm } from "@astra/shared";
import { BinVisual } from "../../components/BinVisual";
import { MapView } from "../../components/MapView";
import { Logo } from "../../components/Shell";
import { Button, Hash, Pill, Skeleton } from "../../components/ui";
import { post } from "../../lib/api";
import { dateTime, inr, km, mstc } from "../../lib/format";
import { useLiveBin } from "../../lib/live";
import { useConfig, useMeJob } from "../../lib/queries";
import { useLive, useSession } from "../../lib/store";
import type { MeJob } from "../../lib/types";

const ACTIVE = ["ASSIGNED", "EN_ROUTE", "COLLECTING", "REVERIFYING"];

export function WorkerApp() {
  const { data, isLoading } = useMeJob();
  const { data: cfg } = useConfig();
  const session = useSession();
  const navigate = useNavigate();

  return (
    <div className="min-h-full bg-page">
      <header className="sticky top-0 z-[900] border-b border-line bg-page/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[460px] items-center gap-2.5 px-4">
          <Logo size={26} />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[14px] font-semibold">{session.user?.name ?? "Worker"}</div>
            <div className="text-[11.5px] text-ink-3">
              {session.user?.workerId} · {cfg?.productName ?? "Astra Waste"}
            </div>
          </div>
          <button
            aria-label="Sign out"
            className="rounded-md p-2 text-ink-3 hover:bg-hover hover:text-ink"
            onClick={() => {
              session.logout();
              navigate("/");
            }}
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[460px] space-y-4 px-4 pb-16 pt-4">
        {isLoading || !data ? (
          <>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-80 w-full" />
          </>
        ) : (
          <>
            <StatusCard data={data} rate={cfg?.payment.inrPerMstc ?? 0} />
            {data.job && ACTIVE.includes(data.job.request.status) ? <JobCard data={data} /> : <NoJob data={data} />}
            <Payments data={data} />
            <WalletCard data={data} explorer={cfg?.explorerUrl ?? null} />
          </>
        )}
      </main>
    </div>
  );
}

function StatusCard({ data, rate }: { data: MeJob; rate: number }) {
  const w = data.worker;
  const busy = ["ASSIGNED", "EN_ROUTE", "AT_BIN", "COLLECTING"].includes(w.status);
  return (
    <section className="panel grid grid-cols-4 divide-x divide-line-2 overflow-hidden text-center sm:text-left">
      <div className="px-3 py-3">
        <div className="text-[11px] text-ink-3">Status</div>
        <div className="mt-1">
          <Pill tone={busy ? "progress" : w.status === "AWAITING_VERIFICATION" ? "warning" : "success"} pulse={busy}>
            {w.statusLabel}
          </Pill>
        </div>
      </div>
      <div className="px-3 py-3">
        <div className="text-[11px] text-ink-3">Earned</div>
        <div className="mt-0.5 text-[16px] font-semibold tracking-[-0.01em] num">{inr(Number(w.earnedMstc) * rate)}</div>
      </div>
      <div className="px-3 py-3">
        <div className="text-[11px] text-ink-3">Jobs</div>
        <div className="mt-0.5 text-[16px] font-semibold tracking-[-0.01em] num">{w.completed}</div>
      </div>
      <div className="px-3 py-3">
        <div className="text-[11px] text-ink-3">Rep · Stake</div>
        <div className="mt-0.5 text-[13px] font-semibold tracking-[-0.01em] text-ink">
          {w.reputationScore ?? 100} <span className="text-[11px] font-normal text-ink-3">({w.stakeLockedMstc ?? "0.04"}M)</span>
        </div>
      </div>
    </section>
  );
}

function useGpsShare(enabled: boolean) {
  const [state, setState] = useState<{ on: boolean; error: string | null; accuracy: number | null }>({ on: false, error: null, accuracy: null });
  const last = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    if (!("geolocation" in navigator)) {
      setState({ on: false, error: "This browser has no GPS access", accuracy: null });
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setState({ on: true, error: null, accuracy: Math.round(p.coords.accuracy) });
        if (Date.now() - last.current < 3000) return;
        last.current = Date.now();
        post("/me/location", { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }).catch(() => undefined);
      },
      (err) =>
        setState({
          on: false,
          error: err.code === err.PERMISSION_DENIED ? (window.isSecureContext ? "Location permission denied" : "Location needs HTTPS (or localhost)") : err.message,
          accuracy: null,
        }),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [enabled]);
  return state;
}

function JobCard({ data }: { data: MeJob }) {
  const d = data.job!;
  const r = d.request;
  const bin = useLiveBin(d.bin)!;
  const me = useLive((s) => s.workers[data.worker.id]);
  const qc = useQueryClient();
  const [share, setShare] = useState(false);
  const gps = useGpsShare(share);
  const [busy, setBusy] = useState(false);
  const pos = me ?? { lat: data.worker.lat, lng: data.worker.lng };
  const distKm = haversineKm(pos, { lat: bin.lat, lng: bin.lng });
  const atBin = distKm * 1000 <= 40;
  const lastRfid = d.rfidEvents.at(-1);
  const refused = lastRfid && !["RFID_VERIFIED", "VERIFICATION_PENDING"].includes(lastRfid.result);
  const [signing2FA, setSigning2FA] = useState(false);
  const [checkingTransfer, setCheckingTransfer] = useState(false);

  const sign2FA = async () => {
    setSigning2FA(true);
    try {
      await post("/worker/verify-2fa", {
        requestId: r.id,
        workerId: data.worker.id,
        binId: bin.id,
        workerLat: pos.lat,
        workerLng: pos.lng,
      });
      qc.invalidateQueries({ queryKey: ["me-job"] });
    } finally {
      setSigning2FA(false);
    }
  };

  const checkinTransfer = async () => {
    setCheckingTransfer(true);
    try {
      await post("/transfer-station/checkin", {
        requestId: r.id,
        facilityId: "TRANSFER-ECODUMP-NORTH",
      });
      qc.invalidateQueries({ queryKey: ["me-job"] });
    } finally {
      setCheckingTransfer(false);
    }
  };

  const step = r.status === "ASSIGNED" || r.status === "EN_ROUTE" ? (atBin || data.worker.status === "AT_BIN" ? 1 : 0) : r.status === "COLLECTING" ? 2 : 3;
  const steps = [
    { title: "Go to the bin", body: `${bin.name}, ${bin.address}` },
    { title: "Tap your RFID card", body: "Hold your card on the reader at the front of the bin. The lid unlocks for you only." },
    { title: "Empty the bin and close the lid", body: "Both sensors record the level before and after. Close the lid when you're done." },
    { title: "Verification", body: "The AI checks the readings, then the municipality approves and your payment is released." },
  ];

  const enRoute = async () => {
    setBusy(true);
    try {
      await post("/me/en-route");
      qc.invalidateQueries({ queryKey: ["me-job"] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-4">
        <div className="min-w-0">
          <div className="text-[11.5px] font-medium text-ink-3">Current job · {r.code}</div>
          <div className="mt-0.5 truncate text-[17px] font-semibold tracking-[-0.01em]">{bin.name}</div>
          <div className="truncate text-[12.5px] text-ink-3">
            {bin.id} · {bin.address}
          </div>
        </div>
        <Pill tone={r.tone} pulse>
          {r.statusLabel}
        </Pill>
      </div>

      <MapView
        bins={[bin]}
        workers={[{ ...data.worker, ...pos }]}
        highlightWorker={data.worker.id}
        routes={["ASSIGNED", "EN_ROUTE"].includes(r.status) ? [{ from: [pos.lat, pos.lng], to: [bin.lat, bin.lng] }] : []}
        height={210}
        zoomControl={false}
      />

      <div className="grid grid-cols-3 divide-x divide-line-2 border-y border-line-2">
        <Mini label="Distance" value={atBin ? "Here" : km(distKm)} />
        <Mini label="Bin fill" value={`${Math.round(bin.fillPct)}%`} />
        <Mini label="You earn" value={inr(r.amountInr)} />
      </div>

      <div className="flex gap-2 px-4 py-3">
        <a
          href={`https://www.google.com/maps/dir/?api=1&destination=${bin.lat},${bin.lng}&travelmode=driving`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg border border-line bg-surface text-[13.5px] font-medium shadow-panel hover:bg-raised"
        >
          <Navigation className="h-4 w-4" /> Navigate
        </a>
        {r.status === "ASSIGNED" && (
          <Button className="flex-1" size="lg" variant="primary" loading={busy} icon={<Truck className="h-4 w-4" />} onClick={enRoute}>
            I'm on my way
          </Button>
        )}
      </div>

      <div className="border-t border-line-2 px-4 py-3">
        <button onClick={() => setShare((s) => !s)} className="flex w-full items-center justify-between gap-3 text-left">
          <span className="flex items-center gap-2 text-[13px]">
            <LocateFixed className={clsx("h-4 w-4", gps.on ? "text-good" : "text-ink-3")} />
            <span>
              <span className="block font-medium text-ink">{gps.on ? "Sharing live location" : "Share my location"}</span>
              <span className="block text-[12px] text-ink-3">{gps.error ?? (gps.on ? `±${gps.accuracy} m · the office sees you on the map` : "Uses this phone's GPS while the job is open")}</span>
            </span>
          </span>
          <span className={clsx("relative h-5 w-9 shrink-0 rounded-full transition-colors", share ? "bg-ink" : "bg-line")}>
            <span className={clsx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left]", share ? "left-[18px]" : "left-0.5")} />
          </span>
        </button>
      </div>

      <ol className="border-t border-line-2 px-4 py-4">
        {steps.map((s, i) => {
          const done = i < step;
          const current = i === step;
          return (
            <li key={s.title} className="relative flex gap-3 pb-4 last:pb-0">
              {i < steps.length - 1 && <span className={clsx("absolute left-[11px] top-7 h-[calc(100%-20px)] w-px", done ? "bg-ink/70" : "bg-line")} />}
              <span
                className={clsx(
                  "relative flex h-[23px] w-[23px] shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
                  done ? "border-ink bg-ink text-white" : current ? "border-prog-dot bg-prog-bg text-prog" : "border-line bg-surface text-ink-4",
                )}
              >
                {done ? <Check className="h-3 w-3" strokeWidth={3} /> : i + 1}
              </span>
              <div className="min-w-0 pt-[2px]">
                <div className={clsx("text-[14px]", current ? "font-semibold text-ink" : done ? "text-ink-2" : "text-ink-3")}>{s.title}</div>
                {current && <div className="mt-0.5 text-[12.5px] text-ink-2">{s.body}</div>}
                {current && i === 1 && refused && (
                  <div className="mt-2 flex items-center gap-1.5 rounded-md border border-bad-line bg-bad-bg px-2.5 py-1.5 text-[12.5px] text-bad">
                    <CircleX className="h-3.5 w-3.5" /> Last card refused: {(lastRfid?.result ?? "refused").replace(/_/g, " ").toLowerCase()}
                  </div>
                )}
                {current && i === 2 && (
                  <div className="mt-3 flex items-center gap-3">
                    <BinVisual fill={bin.fillPct} lid={bin.lidState} servo={bin.servoState} ir={bin.irStatus} rfid={bin.rfidState} threshold={bin.thresholdPct} monitor={bin.monitorPct} online={bin.online} size={70} />
                    <div className="text-[12.5px] text-ink-2">
                      <div className="text-[22px] font-semibold text-ink num">{Math.round(bin.fillPct)}%</div>
                      lid {bin.lidState} · {bin.servoState}
                    </div>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {lastRfid?.result === "RFID_VERIFIED" && (
        <div className="flex items-center gap-2 border-t border-line-2 bg-good-bg px-4 py-2.5 text-[12.5px] text-good">
          <Fingerprint className="h-4 w-4" /> Card verified at {new Date(lastRfid.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
          {lastRfid.tx && <span className="text-ink-3">· recorded on-chain</span>}
        </div>
      )}

      {/* 2FA Section */}
      <div className="border-t border-line-2 px-4 py-3 space-y-2">
        <div className="flex items-center justify-between text-[12.5px]">
          <span className="flex items-center gap-2 font-medium text-ink">
            <KeyRound className="h-4 w-4 text-prog" /> Second Worker Factor (2FA)
          </span>
          {r.secondFactorVerified ? (
            <span className="flex items-center gap-1 text-[12px] text-good font-medium">
              <CheckCircle2 className="h-3.5 w-3.5" /> Verified
            </span>
          ) : (
            <span className="text-[11.5px] text-warn font-medium">Pending 2FA</span>
          )}
        </div>
        {!r.secondFactorVerified && (
          <Button
            size="sm"
            variant="secondary"
            className="w-full text-[12.5px]"
            loading={signing2FA}
            icon={<ShieldCheck className="h-4 w-4" />}
            onClick={sign2FA}
          >
            Sign 2FA Proximity Challenge (BridgeKey)
          </Button>
        )}
      </div>

      {/* Transfer Station Section */}
      <div className="border-t border-line-2 px-4 py-3 space-y-2">
        <div className="flex items-center justify-between text-[12.5px]">
          <span className="flex items-center gap-2 font-medium text-ink">
            <Truck className="h-4 w-4 text-prog" /> Transfer Station Delivery
          </span>
          {r.transferVerified ? (
            <span className="flex items-center gap-1 text-[12px] text-good font-medium">
              <CheckCircle2 className="h-3.5 w-3.5" /> Check-in Verified
            </span>
          ) : (
            <span className="text-[11.5px] text-warn font-medium">Delivery Required</span>
          )}
        </div>
        {!r.transferVerified && (
          <Button
            size="sm"
            variant="secondary"
            className="w-full text-[12.5px]"
            loading={checkingTransfer}
            icon={<Truck className="h-4 w-4" />}
            onClick={checkinTransfer}
          >
            Check In at Eco-Dump Transfer Station
          </Button>
        )}
      </div>
    </section>
  );
}

function NoJob({ data }: { data: MeJob }) {
  const last = data.job;
  const r = last?.request;
  const qc = useQueryClient();
  const [checkingTransfer, setCheckingTransfer] = useState(false);
  return (
    <section className="panel px-4 py-5">
      {!r ? (
        <div className="py-6 text-center">
          <Trash2 className="mx-auto h-8 w-8 text-ink-4" />
          <div className="mt-2 text-[15px] font-semibold">No job right now</div>
          <div className="mt-1 text-[13px] text-ink-3">When the municipality assigns you a bin, it appears here with directions.</div>
        </div>
      ) : (
        <>
          <div className="text-[11.5px] font-medium text-ink-3">Last job · {r.code}</div>
          <div className="mt-0.5 text-[16px] font-semibold tracking-[-0.01em]">{r.binName}</div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Pill tone={r.tone}>{r.statusLabel}</Pill>
            {r.paymentStatusLabel && <Pill tone={r.paymentStatus === "PAID" ? "success" : r.paymentStatus === "CANCELLED" ? "neutral" : "warning"}>Payment: {r.paymentStatusLabel}</Pill>}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="rounded-md bg-raised px-3 py-2">
              <div className="text-[11.5px] text-ink-3">Before → after</div>
              <div className="text-[15px] font-semibold num">
                {r.fillBefore !== null ? `${Math.round(r.fillBefore)}%` : "–"} → {r.fillAfter !== null ? `${Math.round(r.fillAfter)}%` : "–"}
              </div>
            </div>
            <div className="rounded-md bg-raised px-3 py-2">
              <div className="text-[11.5px] text-ink-3">AI check</div>
              <div className="text-[15px] font-semibold num">{r.completionConfidence !== null ? `${r.completionConfidence.toFixed(1)}%` : "–"}</div>
            </div>
          </div>
          {r.status === "AWAITING_FINAL_APPROVAL" && <p className="mt-3 text-[12.5px] text-ink-2">The collection was verified. Waiting for the municipality to approve it.</p>}
          {r.status === "AWAITING_FINAL_APPROVAL" && !r.transferVerified && (
            <div className="mt-3 rounded-md border border-warn-line bg-warn-bg p-3 text-[12.5px] text-warn space-y-2">
              <div className="font-semibold">Chain of Custody Checkpoint Required</div>
              <p className="text-ink-2">Deliver waste to the Eco-Dump facility to finalize collection and release your payment.</p>
              <Button
                size="sm"
                variant="primary"
                className="w-full"
                loading={checkingTransfer}
                icon={<Truck className="h-4 w-4" />}
                onClick={async () => {
                  setCheckingTransfer(true);
                  try {
                    await post("/transfer-station/checkin", {
                      requestId: r.id,
                      facilityId: "TRANSFER-ECODUMP-NORTH",
                    });
                    qc.invalidateQueries({ queryKey: ["me-job"] });
                  } finally {
                    setCheckingTransfer(false);
                  }
                }}
              >
                Register Eco-Dump Delivery
              </Button>
            </div>
          )}
          {r.status === "INVESTIGATION" && <p className="mt-3 text-[12.5px] text-warn">The readings didn't confirm the bin was emptied or citizen filed a challenge. The municipality is reviewing it.</p>}
          {r.status === "REJECTED" && <p className="mt-3 text-[12.5px] text-bad">{r.rejectionReason ?? "The collection was rejected."}</p>}
        </>
      )}
    </section>
  );
}

function Payments({ data }: { data: MeJob }) {
  if (!data.payments.length) return null;
  return (
    <section className="panel overflow-hidden">
      <div className="border-b border-line-2 px-4 py-3 text-[13.5px] font-semibold">Payments</div>
      <ul className="divide-y divide-line-2">
        {data.payments.map((p) => (
          <li key={p.requestId} className="px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[15px] font-semibold num">{inr(p.amountInr)}</div>
                <div className="text-[12px] text-ink-3">
                  {mstc(p.amountMstc)} · {p.requestCode}
                </div>
              </div>
              <Pill tone={p.status === "PAID" ? "success" : p.status === "FAILED" ? "danger" : p.status === "CANCELLED" || p.status === "PENDING" ? "neutral" : "warning"} pulse={["SIGNING", "SUBMITTED", "CONFIRMING"].includes(p.status)}>
                {p.status === "PENDING" ? "Held in escrow" : p.statusLabel}
              </Pill>
            </div>
            {p.tx && (
              <div className="mt-1.5 flex items-center gap-2 text-[12px] text-ink-3">
                {p.status === "PAID" ? `Paid ${p.paidAt ? dateTime(p.paidAt) : ""}` : "Transaction"} <Hash value={p.tx.hash} url={p.tx.url} copy={false} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function WalletCard({ data, explorer }: { data: MeJob; explorer: string | null }) {
  return (
    <section className="panel px-4 py-4">
      <div className="flex items-center gap-2 text-[13.5px] font-semibold">
        <Wallet className="h-4 w-4 text-ink-3" /> My wallet
      </div>
      <div className="mt-2 break-all font-mono text-[12px] text-ink-2">{data.worker.wallet}</div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[12px] text-ink-3">Balance on chain</span>
        <span className="text-[15px] font-semibold num">{data.balanceMstc !== null ? mstc(data.balanceMstc) : "–"}</span>
      </div>
      {explorer && (
        <a className="mt-2 inline-block text-[12.5px] font-medium text-ink-2 underline decoration-line underline-offset-4" href={`${explorer}/address/${data.worker.wallet}`} target="_blank" rel="noreferrer">
          View on MSTScan
        </a>
      )}
    </section>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3.5 py-2.5">
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className="mt-0.5 text-[15px] font-semibold num">{value}</div>
    </div>
  );
}
