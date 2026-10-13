import clsx from "clsx";
import { motion } from "framer-motion";
import { BadgeCheck, CircleAlert, CircleCheck, CircleX, Cpu, Fingerprint, Link2, MapPin, ShieldCheck, Timer, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { RFID_RESULT } from "@astra/shared";
import { time } from "../lib/format";
import type { RfidEvent, Verification } from "../lib/types";
import { Hash, Pill, useTween } from "./ui";

// ------------------------------------------------------------ confidence

export function ConfidenceRing({ value, verified, size = 64 }: { value: number; verified: boolean; size?: number }) {
  const shown = useTween(value, { duration: 1 });
  const r = size / 2 - 5;
  const c = 2 * Math.PI * r;
  const color = verified ? "#3e9a62" : "#cc4a40";
  const track = verified ? "#eaf3ed" : "#fbeae7";
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={5} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={5} strokeLinecap="round" strokeDasharray={`${(shown / 100) * c} ${c}`} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-semibold leading-none tracking-[-0.02em] num" style={{ fontSize: Math.round(size * 0.21) }}>
          {shown.toFixed(size >= 60 ? 1 : 0)}
        </span>
        {size >= 60 && <span className="mt-0.5 text-[9px] font-medium uppercase tracking-[0.06em] text-ink-3">conf.</span>}
      </div>
    </div>
  );
}

// ------------------------------------------------------ AI evidence panel

export function EvidencePanel({ v, compact }: { v: Verification; compact?: boolean }) {
  const label =
    v.kind === "fullness" ? (v.verified ? "Fullness verified" : "Fullness rejected") : v.verified ? "Collection verified" : "Collection not verified";
  const failed = v.checks.filter((c) => !c.pass);
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-4">
        <ConfidenceRing value={v.confidence} verified={v.verified} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={v.verified ? "success" : "danger"} icon={v.verified ? <CircleCheck className="h-3.5 w-3.5" /> : <CircleX className="h-3.5 w-3.5" />}>
              {(v.decision ?? (v.verified ? "VERIFIED" : "REJECTED")).replace(/_/g, " ")}
            </Pill>
            <span className="text-[13px] text-ink-2">{label}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3">
            <span className="inline-flex items-center gap-1">
              <Cpu className="h-3.5 w-3.5" /> {v.model}
            </span>
            {v.latencyMs !== null && <span>{v.latencyMs} ms</span>}
            <span>{time(v.createdAt, true)}</span>
            <span>
              {v.checks.filter((c) => c.pass).length}/{v.checks.length} checks passed
            </span>
            {v.summary?.measurementUncertaintyPct !== undefined && <span>±{v.summary.measurementUncertaintyPct}% measurement uncertainty</span>}
          </div>
        </div>
      </div>

      {failed.length > 0 && (
        <div className="mt-4 rounded-md border border-bad-line bg-bad-bg px-3.5 py-2.5 text-[13px] text-bad">
          <div className="font-medium">Why it was {v.verified ? "flagged" : "rejected"}</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {failed.slice(0, 4).map((c) => (
              <li key={c.id}>{c.reason}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 overflow-hidden rounded-md border border-line-2">
        <table className="w-full text-[13px]">
          <thead className="bg-raised text-[11.5px] text-ink-3">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Evidence</th>
              <th className="px-3 py-2 text-left font-medium">Observed</th>
              {!compact && <th className="hidden px-3 py-2 text-left font-medium md:table-cell">Expected</th>}
              <th className="w-[92px] px-3 py-2 text-left font-medium">Score</th>
            </tr>
          </thead>
          <tbody>
            {v.checks.map((c, i) => (
              <motion.tr
                key={c.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: i * 0.03 }}
                className="border-t border-line-2 align-top"
              >
                <td className="px-3 py-2">
                  <div className="flex items-start gap-2">
                    {c.pass ? <CircleCheck className="mt-[1px] h-4 w-4 shrink-0 text-good-dot" /> : <CircleX className="mt-[1px] h-4 w-4 shrink-0 text-bad-dot" />}
                    <div>
                      <div className="font-medium text-ink">
                        {c.label}
                        {c.critical && <span className="ml-1.5 rounded bg-sunken px-1 py-[1px] text-[10px] font-semibold uppercase tracking-[0.04em] text-ink-3">critical</span>}
                      </div>
                      {!compact && <div className="text-[12px] text-ink-3">{c.reason}</div>}
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2 text-ink-2 num">{c.observed}</td>
                {!compact && <td className="hidden px-3 py-2 text-ink-3 md:table-cell">{c.expected}</td>}
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-12 overflow-hidden rounded-full bg-sunken">
                      <div className={clsx("h-full rounded-full", c.pass ? "bg-good-dot" : "bg-bad-dot")} style={{ width: `${Math.round(c.score * 100)}%` }} />
                    </div>
                    <span className="text-[11.5px] text-ink-3 num">{Math.round(c.score * 100)}</span>
                  </div>
                </td>
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>

      {v.secondOpinion && (
        <div className="mt-3 rounded-md border border-line-2 bg-raised px-3.5 py-2.5 text-[12.5px]">
          <div className="flex items-center gap-2 font-medium text-ink">
            <Cpu className="h-3.5 w-3.5" /> Second opinion · {v.secondOpinion.model}
            {v.secondOpinion.available ? (
              <Pill tone={v.secondOpinion.verified ? "success" : "danger"}>
                {v.secondOpinion.verified ? "agrees" : "disagrees"} · {v.secondOpinion.confidence}%
              </Pill>
            ) : (
              <Pill tone="warning">unavailable</Pill>
            )}
          </div>
          {v.secondOpinion.available ? (
            <ul className="mt-1 list-disc pl-5 text-ink-2">
              {(v.secondOpinion.reasons ?? []).map((r: string, i: number) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : (
            <div className="mt-1 text-ink-3">{v.secondOpinion.error} Sensor fusion decided alone.</div>
          )}
        </div>
      )}

      <div className="mt-3 grid gap-2 text-[12px] text-ink-3 sm:grid-cols-2">
        <div className="flex items-center gap-2">
          <span className="w-[92px] shrink-0">Evidence hash</span>
          <Hash value={v.evidenceHash} />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-[92px] shrink-0">Report hash</span>
          <Hash value={v.reportHash} />
        </div>
      </div>
      <p className="mt-1.5 text-[11.5px] text-ink-3">Both hashes are signed by the bin and the AI verifier and checked by the MST contract.</p>
    </div>
  );
}

// ------------------------------------------------------- before / after

export function BeforeAfter({ before, after, verification, lidOpened, lidClosed, rfidVerified }: { before: number; after: number; verification?: Verification | null; lidOpened?: boolean; lidClosed?: boolean; rfidVerified?: boolean }) {
  const shownAfter = useTween(after, { duration: 1.6 });
  const drop = before - after;
  const checks = verification?.checks ?? [];
  const pick = (id: string) => checks.find((c) => c.id === id);
  const items: { label: string; ok: boolean | undefined; icon: ReactNode }[] = [
    { label: "RFID verified", ok: pick("RFID_VERIFIED")?.pass ?? rfidVerified, icon: <Fingerprint className="h-4 w-4" /> },
    { label: "Lid opened", ok: pick("LID_OPENED")?.pass ?? lidOpened, icon: <ShieldCheck className="h-4 w-4" /> },
    { label: "Collection duration valid", ok: pick("DURATION_VALID")?.pass, icon: <Timer className="h-4 w-4" /> },
    { label: "Sensor change detected", ok: pick("LEVEL_DROPPED")?.pass, icon: <BadgeCheck className="h-4 w-4" /> },
    { label: "Lid closed", ok: pick("LID_CLOSED")?.pass ?? lidClosed, icon: <ShieldCheck className="h-4 w-4" /> },
    { label: "Location consistent", ok: pick("LOCATION_CONSISTENT")?.pass, icon: <MapPin className="h-4 w-4" /> },
  ];
  const verified = verification?.verified;
  return (
    <div className="min-w-0">
      <div className="space-y-4">
        {[
          { label: "Before", value: before, shown: before, color: "#9ec5f4" },
          { label: "After", value: after, shown: shownAfter, color: "#2a78d6" },
        ].map((row) => (
          <div key={row.label} className="grid grid-cols-[64px_64px_1fr] items-center gap-3">
            <span className="eyebrow">{row.label}</span>
            <span className="text-[26px] font-semibold leading-none tracking-[-0.02em]">{Math.round(row.shown)}%</span>
            <div className="relative h-5 overflow-hidden rounded-[5px] bg-sunken">
              <div className="absolute inset-y-0 left-0 rounded-[5px]" style={{ width: `${Math.max(0, Math.min(100, row.shown))}%`, background: row.color }} />
            </div>
          </div>
        ))}
        <div className="grid grid-cols-[64px_64px_1fr] items-center gap-3 text-[12.5px] text-ink-3">
          <span />
          <span className="num">−{Math.max(0, Math.round(drop))} pts</span>
          <span>waste removed, measured by both ultrasonic sensors</span>
        </div>
      </div>

      <div className="mt-5 grid gap-x-6 gap-y-2.5 border-t border-line-2 pt-4 sm:grid-cols-2">
        {items.map((it, i) => (
          <motion.div key={it.label} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.15 + i * 0.07 }} className="flex items-center gap-2.5 text-[13.5px]">
            {it.ok === undefined ? (
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-sunken text-ink-4">{it.icon}</span>
            ) : it.ok ? (
              <CircleCheck className="h-5 w-5 text-good-dot" />
            ) : (
              <CircleX className="h-5 w-5 text-bad-dot" />
            )}
            <span className={clsx(it.ok === false ? "text-bad" : it.ok ? "text-ink" : "text-ink-3")}>{it.label}</span>
          </motion.div>
        ))}
      </div>

      {verification && (
        <div className={clsx("mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3", verified ? "border-good-line bg-good-bg" : "border-bad-line bg-bad-bg")}>
          <div className="flex items-center gap-3">
            <ConfidenceRing value={verification.confidence} verified={!!verified} size={52} />
            <div>
              <div className="text-[12px] text-ink-2">AI confidence</div>
              <div className="text-[18px] font-semibold tracking-[-0.01em]">{verification.confidence.toFixed(1)}%</div>
            </div>
          </div>
          <div className={clsx("flex items-center gap-2 text-[15px] font-semibold tracking-[0.02em]", verified ? "text-good" : "text-bad")}>
            {verified ? <CircleCheck className="h-5 w-5" /> : <CircleAlert className="h-5 w-5" />}
            {verified ? "COLLECTION VERIFIED" : "COLLECTION NOT VERIFIED"}
          </div>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------- RFID

const RFID_ICON: Record<string, ReactNode> = {
  CARD: <Fingerprint className="h-4 w-4" />,
  WALLET: <Wallet className="h-4 w-4" />,
  ASSIGNMENT: <BadgeCheck className="h-4 w-4" />,
  BIN: <ShieldCheck className="h-4 w-4" />,
  LOCATION: <MapPin className="h-4 w-4" />,
  TIMESTAMP: <Timer className="h-4 w-4" />,
};

export function RfidChain({ event }: { event: RfidEvent }) {
  const meta = RFID_RESULT[event.result as keyof typeof RFID_RESULT] ?? { label: event.result, tone: "neutral" as const };
  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Pill tone={meta.tone} pulse={event.result === "VERIFICATION_PENDING"}>
          {meta.label.toUpperCase()}
        </Pill>
        <span className="text-[12px] text-ink-3">
          Card <span className="font-mono text-ink-2">{event.tagUid}</span> · {time(event.ts, true)} · {event.source}
        </span>
      </div>
      <ol className="relative">
        {event.checks.map((c, i) => (
          <li key={c.id} className="relative flex gap-3 pb-3 last:pb-0">
            {i < event.checks.length - 1 && <span className="absolute left-[13px] top-7 h-[calc(100%-18px)] w-px bg-line" />}
            <span className={clsx("relative flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full border", c.pass ? "border-good-line bg-good-bg text-good" : "border-bad-line bg-bad-bg text-bad")}>
              {RFID_ICON[c.id] ?? <ShieldCheck className="h-4 w-4" />}
            </span>
            <div className="min-w-0 pt-[3px]">
              <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
                {c.label}
                {c.pass ? <CircleCheck className="h-3.5 w-3.5 text-good-dot" /> : <CircleX className="h-3.5 w-3.5 text-bad-dot" />}
              </div>
              <div className="truncate text-[12.5px] text-ink-2">{c.observed}</div>
            </div>
          </li>
        ))}
      </ol>
      {event.tx && (
        <div className="mt-3 flex items-center gap-2 border-t border-line-2 pt-3 text-[12px] text-ink-3">
          <Link2 className="h-3.5 w-3.5" /> Recorded on-chain
          <Hash value={event.tx.hash} url={event.tx.url} />
        </div>
      )}
    </div>
  );
}
