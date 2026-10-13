import clsx from "clsx";
import { ArrowUpRight, Cpu, SearchCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { RequestActions, SigningNote } from "../components/Actions";
import { BeforeAfter, EvidencePanel, RfidChain } from "../components/Evidence";
import { FillChart } from "../components/FillChart";
import { Drawer, Empty, PageHeader, Panel, Pill, Segmented, Skeleton, Table, Td, Th } from "../components/ui";
import { dateTime, duration, pct, time } from "../lib/format";
import { useRequest, useRequests, useVerifications } from "../lib/queries";
import type { Verification as V } from "../lib/types";

export function Verification() {
  const [params, setParams] = useSearchParams();
  const { data: queue } = useRequests("final");
  const { data: completions } = useVerifications("completion");
  const paramId = params.get("request") ? Number(params.get("request")) : null;
  const selectedId = paramId ?? queue?.[0]?.id ?? completions?.find((v) => v.requestId)?.requestId ?? null;

  return (
    <>
      <PageHeader
        title="Verification center"
        subtitle="Nothing is paid on a sensor's word alone. Every decision shows the raw readings, each check the AI ran, and why it passed or failed."
      />
      <div className="grid gap-6 xl:grid-cols-[290px_1fr]">
        <Panel title="Awaiting your decision" subtitle={queue ? `${queue.length} collection${queue.length === 1 ? "" : "s"}` : undefined} flush className="self-start">
          {!queue ? (
            <div className="p-4">
              <Skeleton className="h-16 w-full" />
            </div>
          ) : queue.length === 0 ? (
            <div className="px-5 py-8 text-center text-[13px] text-ink-3">All caught up. Verified collections appear here for final approval.</div>
          ) : (
            <ul className="divide-y divide-line-2">
              {queue.map((r) => (
                <li key={r.id}>
                  <button onClick={() => setParams({ request: String(r.id) })} className={clsx("relative w-full px-5 py-3 text-left transition-colors hover:bg-raised", r.id === selectedId && "bg-raised")}>
                    {r.id === selectedId && <span className="absolute inset-y-0 left-0 w-[3px] bg-ink" />}
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[12.5px] font-medium">{r.code}</span>
                      <Pill tone={r.tone}>{r.status === "INVESTIGATION" ? "Investigation" : "Ready"}</Pill>
                    </div>
                    <div className="mt-1 truncate text-[13px] text-ink-2">
                      {r.binId} · {r.workerName}
                    </div>
                    <div className="mt-1.5 flex items-center gap-2 text-[12px] text-ink-3">
                      <span className="num">
                        {pct(r.fillBefore)} → {pct(r.fillAfter)}
                      </span>
                      <span>·</span>
                      <span className={clsx("num", r.completionConfidence !== null && r.completionConfidence < 80 && "text-bad")}>AI {r.completionConfidence?.toFixed(1) ?? "–"}%</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {selectedId ? (
          <Showpiece id={selectedId} />
        ) : (
          <Panel>
            <Empty icon={<SearchCheck className="h-8 w-8" />} title="No collections verified yet" body="Once a worker empties a bin, the before and after readings, the RFID check and the AI verdict appear here." />
          </Panel>
        )}
      </div>

      <History />
    </>
  );
}

function Showpiece({ id }: { id: number }) {
  const { data: d } = useRequest(id);
  if (!d) return <Skeleton className="h-[560px] w-full" />;
  const r = d.request;
  const completion = d.verifications.filter((v) => v.kind === "completion").at(-1) ?? null;
  const fullness = d.verifications.filter((v) => v.kind === "fullness").at(-1) ?? null;
  const opened = d.collectionEvents.find((c) => c.type === "LID_OPENED")?.ts ?? null;
  const closed = [...d.collectionEvents].reverse().find((c) => c.type === "LID_CLOSED")?.ts ?? null;
  const rfid = d.rfidEvents.filter((e) => e.requestId === r.id);
  const readings = d.telemetry.filter((t) => !opened || new Date(t.ts).getTime() >= new Date(opened).getTime() - 60_000);
  const deciding = ["AWAITING_FINAL_APPROVAL", "INVESTIGATION"].includes(r.status);

  return (
    <div className="min-w-0 space-y-6">
      <Panel
        title={
          <span className="flex flex-wrap items-center gap-2">
            <Link to={`/app/requests/${r.id}`} className="font-mono hover:underline">
              {r.code}
            </Link>
            <span className="font-normal text-ink-3">·</span>
            <span>
              {r.binId} {r.binName}
            </span>
          </span>
        }
        subtitle={`Collected by ${r.workerName ?? "–"} · lid open ${opened ? time(opened, true) : "–"} → ${closed ? time(closed, true) : "–"} (${opened ? duration(opened, closed) : "–"})`}
        actions={<Pill tone={r.tone}>{r.statusLabel}</Pill>}
      >
        {completion ? (
          <BeforeAfter before={completion.summary.beforeLevel ?? r.fillBefore ?? r.detectedFill} after={completion.summary.afterLevel ?? r.fillAfter ?? 0} verification={completion} />
        ) : (
          <div className="py-10 text-center text-[13px] text-ink-3">{r.status === "REVERIFYING" ? "The AI is checking the collection now…" : "This request has not been collected yet."}</div>
        )}
        {(deciding || (r.status === "COMPLETED" && (r.paymentStatus === "READY" || r.paymentStatus === "FAILED"))) && (
          <div className="mt-5 border-t border-line-2 pt-4">
            <p className="text-[13px] text-ink-2">
              {r.status === "INVESTIGATION"
                ? "The AI could not confirm this collection. Approve only if you have independent proof; the ledger still refuses if the sensors show the bin was not emptied."
                : r.status === "COMPLETED"
                  ? "Approved. Release the escrowed payment to the worker's wallet."
                  : "Approving records your decision on-chain and makes the escrowed payment releasable."}
            </p>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <RequestActions r={r} />
              <SigningNote />
            </div>
          </div>
        )}
      </Panel>

      {r.investigationReason && r.status === "INVESTIGATION" && (
        <div className="rounded-lg border border-warn-line bg-warn-bg px-4 py-3 text-[13px] text-warn">
          <span className="font-medium">Investigation:</span> {r.investigationReason}
        </div>
      )}

      <div className="grid gap-6 2xl:grid-cols-2">
        {completion && (
          <Panel title="Completion evidence" subtitle="Was the bin emptied, by the right person, in the right way?">
            <EvidencePanel v={completion} />
          </Panel>
        )}
        <div className="min-w-0 space-y-6">
          {rfid.length > 0 && (
            <Panel title="Identity at the bin" subtitle="Card → worker → wallet → assignment → bin → location → time">
              <RfidChain event={rfid.at(-1)!} />
              {rfid.length > 1 && <div className="mt-3 border-t border-line-2 pt-3 text-[12.5px] text-bad">{rfid.length - 1} earlier tap{rfid.length > 2 ? "s were" : " was"} refused for this request.</div>}
            </Panel>
          )}
          <Panel title="Readings during collection" subtitle="Both ultrasonic sensors, with the lid-open window shaded">
            <FillChart data={readings} threshold={d.bin.thresholdPct} height={220} />
          </Panel>
        </div>
      </div>

      {fullness && (
        <Panel title="Why this collection was requested" subtitle={`Fullness verification · ${dateTime(fullness.createdAt)}`}>
          <EvidencePanel v={fullness} compact />
        </Panel>
      )}
    </div>
  );
}

function History() {
  const [kind, setKind] = useState<"" | "fullness" | "completion">("");
  const { data } = useVerifications(kind);
  const [open, setOpen] = useState<V | null>(null);
  const stats = useMemo(() => {
    const all = data ?? [];
    return { total: all.length, rejected: all.filter((v) => !v.verified).length };
  }, [data]);

  return (
    <Panel
      className="mt-6"
      title="Every AI decision"
      subtitle={data ? `${stats.total} decisions · ${stats.rejected} rejected or flagged` : undefined}
      actions={
        <Segmented
          size="sm"
          value={kind}
          onChange={setKind}
          items={[
            { value: "", label: "All" },
            { value: "fullness", label: "Fullness" },
            { value: "completion", label: "Completion" },
          ]}
        />
      }
      flush
    >
      {!data ? (
        <div className="p-5">
          <Skeleton className="h-24 w-full" />
        </div>
      ) : data.length === 0 ? (
        <Empty icon={<Cpu className="h-8 w-8" />} title="No AI decisions yet" />
      ) : (
        <Table className="max-h-[440px]">
          <thead>
            <tr>
              <Th>Time</Th>
              <Th>Check</Th>
              <Th>Bin</Th>
              <Th>Request</Th>
              <Th>Decision</Th>
              <Th align="right">Confidence</Th>
              <Th>Failed checks</Th>
              <Th>Model</Th>
            </tr>
          </thead>
          <tbody>
            {data.map((v) => {
              const failed = v.checks.filter((c) => !c.pass);
              return (
                <tr key={v.id} onClick={() => setOpen(v)} className="cursor-pointer transition-colors hover:bg-raised">
                  <Td>
                    <span className="num">{time(v.createdAt, true)}</span>
                  </Td>
                  <Td>{v.kind === "fullness" ? "Is it full?" : "Was it emptied?"}</Td>
                  <Td>{v.binId}</Td>
                  <Td>{v.requestCode ? <span className="font-mono text-[12.5px]">{v.requestCode}</span> : <span className="text-ink-4">–</span>}</Td>
                  <Td>
                    <Pill tone={v.verified ? "success" : "danger"}>{(v.decision ?? (v.verified ? "verified" : "rejected")).replace(/_/g, " ").toLowerCase()}</Pill>
                  </Td>
                  <Td align="right">{v.confidence.toFixed(1)}%</Td>
                  <Td className="max-w-[280px]">
                    <span className="block truncate text-[12.5px] text-ink-2" title={failed.map((c) => c.label).join(", ")}>
                      {failed.length ? failed.map((c) => c.label).join(", ") : <span className="text-ink-4">none</span>}
                    </span>
                  </Td>
                  <Td>
                    <span className="text-[12.5px] text-ink-3">{v.model}</span>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <Drawer
        open={!!open}
        onClose={() => setOpen(null)}
        width={640}
        title={open ? (open.kind === "fullness" ? "Fullness verification" : "Completion verification") : ""}
        subtitle={open ? `${open.binId}${open.requestCode ? ` · ${open.requestCode}` : ""} · ${dateTime(open.createdAt)}` : undefined}
        footer={
          open?.requestId ? (
            <Link to={`/app/requests/${open.requestId}`} className="inline-flex items-center gap-1 text-[13px] font-medium text-ink-2 hover:text-ink">
              Open request <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          ) : undefined
        }
      >
        {open && (
          <div className="px-6 py-5">
            <EvidencePanel v={open} />
            <div className="mt-5">
              <div className="mb-2 text-[12px] font-medium text-ink-3">Inputs the AI saw</div>
              <pre className="max-h-64 overflow-auto rounded-md border border-line-2 bg-raised p-3 font-mono text-[11.5px] leading-relaxed text-ink-2 scroll-thin">{JSON.stringify(open.inputs, null, 2)}</pre>
            </div>
          </div>
        )}
      </Drawer>
    </Panel>
  );
}
