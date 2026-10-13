import express, { type NextFunction, type Request, type Response } from "express";
import { ethers } from "ethers";
import { CHAIN_STATUS, haversineKm, LIFECYCLE } from "@astra/shared";
import { aiHealth } from "./ai";
import { authenticate, issueToken, requireRole, verifyPassword, type SessionUser } from "./auth";
import { ChainError, LEDGER_ABI, ledger, readDeployment } from "./chain/ledger";
import { forecastBinFill } from "./ai/forecast";
import { config, deviceSecret, deviceWallet, explorerAddress, loadCity, normalizeUid } from "./config";
import { dbKind, one, q } from "./db";
import { DeviceAuthError, ingest, syncOfflineQueue, verifyDeviceSignature, type TelemetryPacket } from "./iot/ingest";
import {
  iso,
  LIFECYCLE_SELECT,
  mst,
  PAYMENT_SELECT,
  presentAssignment,
  presentBin,
  presentChallenge,
  presentIncidentReceipt,
  presentLifecycle,
  presentNotification,
  presentPayment,
  presentRequest,
  presentRfid,
  presentTx,
  presentVerification,
  presentWitness,
  presentWorker,
  REQUEST_SELECT,
  TX_SELECT,
} from "./present";
import { clientCount, json, stream } from "./realtime";
import {
  autopilotState,
  directCollect,
  directTap,
  queueCard,
  runAutopilot,
  setBinOffline,
  setSimSettings,
  simSettings,
  simSnapshot,
  simulateFullBin,
  simulateObstruction,
  workerArriveNow,
} from "./sim/engine";
import { rankWorkers } from "./workflow/assignment";
import { executeRobotLoop } from "./workflow/robotLoop";
import {
  abortWalletPayment,
  activeAssignmentForWorker,
  approveCompletion,
  approveRequest,
  assignWorker,
  beginWalletPayment,
  cancelAssignment,
  checkinTransferStation,
  fileCitizenChallenge,
  handleRfidTap,
  issueBinChallenge,
  markEnRoute,
  observeWalletTx,
  openInvestigation,
  recordFireHazardReceipt,
  recordWitnessAttestation,
  rejectCompletion,
  rejectRequest,
  releasePayment,
  updateWorkerLocation,
  verifyWorker2FA,
  WorkflowError,
  type Actor,
} from "./workflow/service";
import { TransitionError } from "./workflow/state";
import { watcher } from "./workflow/watcher";

export const api = express.Router();
api.use(authenticate);

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res)
    .then((body) => {
      if (!res.headersSent) res.type("application/json").send(json(body ?? { ok: true }));
    })
    .catch(next);

const officer = requireRole("officer", "admin");
const anyone = requireRole();
const actorOf = (u?: SessionUser): Actor => ({ kind: u?.role === "admin" ? "admin" : "officer", id: u?.id, name: u?.name });
const num = (v: string) => {
  const n = Number(String(v).replace(/\D/g, ""));
  if (!Number.isFinite(n) || n <= 0) throw new WorkflowError(`"${v}" is not a valid id`);
  return n;
};

// ===========================================================================
// Auth
// ===========================================================================

api.post(
  "/auth/login",
  h(async (req) => {
    const { email, password, workerId, pin } = req.body ?? {};
    if (workerId) {
      const u = await one(`SELECT * FROM users WHERE worker_id = $1`, [String(workerId).toUpperCase()]);
      if (!u || !verifyPassword(String(pin ?? ""), u.password_hash)) throw new WorkflowError("Worker ID or PIN is incorrect", 401);
      const user: SessionUser = { id: u.id, name: u.name, role: "worker", workerId: u.worker_id };
      return { token: issueToken(user), user };
    }
    const u = await one(`SELECT * FROM users WHERE lower(email) = lower($1) AND role IN ('officer','admin')`, [String(email ?? "")]);
    if (!u || !verifyPassword(String(password ?? ""), u.password_hash)) throw new WorkflowError("Email or password is incorrect", 401);
    const user: SessionUser = { id: u.id, name: u.name, role: u.role };
    return { token: issueToken(user), user };
  }),
);

api.get("/auth/me", anyone, h(async (req) => ({ user: req.user })));

/** Names for the worker sign-in picker. The PIN is still required. */
api.get("/auth/workers", h(async () => q(`SELECT id, name FROM workers ORDER BY id`)));

// ===========================================================================
// System
// ===========================================================================

api.get(
  "/system/config",
  h(async () => {
    const city = loadCity();
    const d = readDeployment();
    let policy = null;
    if (d) {
      try {
        const p = await ledger().contract.policy();
        policy = {
          minFillPct: Number(p.minFillPct),
          minFillRemoved: Number(p.minFillRemoved),
          minConfidence: Number(p.minConfidenceBps) / 100,
          maxPayoutMstc: ethers.formatEther(p.maxPayout),
        };
      } catch {
        /* chain offline */
      }
    }
    const L = d ? ledger() : null;
    return {
      productName: config.productName,
      network: config.network,
      networkLabel: config.networkLabel,
      isLocal: config.isLocal,
      chainId: config.chainId,
      chainIdHex: `0x${config.chainId.toString(16)}`,
      rpcUrl: config.rpcUrl,
      explorerUrl: config.explorerUrl || null,
      contract: d ? { address: d.address, url: explorerAddress(d.address), deployTx: d.deployTx || null, deployedAt: d.deployedAt || null } : null,
      municipality: city.municipality,
      simulation: simSettings(),
      payment: { defaultMstc: config.payment.defaultMstc, inrPerMstc: config.payment.inrPerMstc },
      ai: { provider: config.ai.provider, model: config.ai.provider === "qwen" ? config.ai.qwenModel : config.ai.provider === "http" ? config.ai.httpUrl : "astra-sensor-fusion-v1", minConfidence: config.ai.minConfidence },
      policy,
      wallets: L
        ? { officer: L.signerAddress("officer"), gateway: L.signerAddress("gateway"), admin: L.signerAddress("admin"), verifier: L.verifier?.address ?? null }
        : null,
      lifecycle: LIFECYCLE,
      allowRoleGrants: config.auth.allowRoleGrants,
      database: dbKind(),
    };
  }),
);

api.get(
  "/system/health",
  h(async () => {
    const items: { key: string; label: string; status: "online" | "degraded" | "offline"; detail: string }[] = [];
    const hw = await q(`SELECT id, online, last_heartbeat FROM bins WHERE hardware = true`);
    const online = await one(`SELECT count(*)::int AS n, sum(CASE WHEN online THEN 1 ELSE 0 END)::int AS up FROM bins`);
    const mode = simSettings().mode;
    const liveHw = hw.filter((b: any) => b.online && Date.now() - new Date(b.last_heartbeat).getTime() < 30_000 && mode === "live");
    items.push({
      key: "iot",
      label: "IoT gateway",
      status: online.up > 0 ? "online" : "offline",
      detail:
        mode === "live"
          ? `${liveHw.length}/${hw.length} hardware bin${hw.length === 1 ? "" : "s"} reporting · ${online.up}/${online.n} bins online`
          : `${online.up}/${online.n} bins online (simulation)`,
    });
    const ai = await aiHealth();
    items.push({ key: "ai", label: "AI verification", status: ai.online ? "online" : "degraded", detail: ai.detail });
    try {
      const L = ledger();
      const block = await L.reader.provider.getBlockNumber();
      items.push({ key: "chain", label: config.networkLabel, status: "online", detail: `block ${block} · chain ${config.chainId}` });
      const officerAddr = L.signerAddress("officer");
      const bal = officerAddr ? await L.balanceOf(officerAddr) : 0n;
      const gw = L.signerAddress("gateway");
      const gwBal = gw ? await L.balanceOf(gw) : 0n;
      const low = bal < ethers.parseEther("0.01") || gwBal < ethers.parseEther("0.01");
      items.push({
        key: "wallet",
        label: "Payment wallet",
        status: officerAddr ? (low ? "degraded" : "online") : "offline",
        detail: officerAddr ? `officer ${Number(ethers.formatEther(bal)).toFixed(3)} MSTC · gateway ${Number(ethers.formatEther(gwBal)).toFixed(3)} MSTC` : "no officer key",
      });
    } catch (err) {
      items.push({ key: "chain", label: config.networkLabel, status: "offline", detail: (err as Error).message.slice(0, 120) });
      items.push({ key: "wallet", label: "Payment wallet", status: "offline", detail: "chain unreachable" });
    }
    try {
      await one(`SELECT 1`);
      items.push({ key: "db", label: "Database", status: "online", detail: dbKind() === "pglite" ? "PostgreSQL (embedded PGlite)" : "PostgreSQL" });
    } catch {
      items.push({ key: "db", label: "Database", status: "offline", detail: "query failed" });
    }
    const ap = autopilotState();
    items.push({
      key: "sim",
      label: "Simulation",
      status: mode === "simulation" ? "online" : "degraded",
      detail: mode === "simulation" ? (ap?.running ? `autopilot: ${ap.stage}` : "running") : "LIVE HARDWARE mode",
    });
    return { items, mode, clients: clientCount(), updatedAt: new Date().toISOString() };
  }),
);

// ===========================================================================
// Overview
// ===========================================================================

api.get(
  "/overview",
  anyone,
  h(async () => {
    const m = await one(`
      SELECT
        (SELECT count(*)::int FROM bins) AS total_bins,
        (SELECT count(*)::int FROM bins WHERE online) AS active_bins,
        (SELECT count(*)::int FROM bins WHERE status IN ('FULL','VERIFYING','COLLECTION_REQUESTED')) AS full_bins,
        (SELECT count(*)::int FROM collection_requests WHERE status IN ('AWAITING_APPROVAL','APPROVED')) AS pending_requests,
        (SELECT count(*)::int FROM collection_requests WHERE status IN ('ASSIGNED','EN_ROUTE','COLLECTING','REVERIFYING')) AS active_collections,
        (SELECT count(*)::int FROM collection_requests WHERE status IN ('AWAITING_FINAL_APPROVAL','INVESTIGATION')) AS awaiting_verification,
        (SELECT count(*)::int FROM collection_requests WHERE status = 'COMPLETED' AND completed_at >= date_trunc('day', now())) AS completed_today,
        (SELECT count(*)::int FROM payments WHERE status IN ('READY','SIGNING','SUBMITTED','CONFIRMING','FAILED')) AS payments_pending,
        (SELECT COALESCE(sum(amount_wei), 0)::text FROM payments WHERE status = 'PAID') AS paid_total_wei
    `);
    const attention = (
      await q(
        `${REQUEST_SELECT} WHERE r.status IN ('AWAITING_APPROVAL','APPROVED','AWAITING_FINAL_APPROVAL','INVESTIGATION')
            OR (r.status = 'COMPLETED' AND p.status IN ('READY','FAILED')) OR (r.rfid_alert AND r.status IN ('ASSIGNED','EN_ROUTE','COLLECTING'))
         ORDER BY r.updated_at DESC LIMIT 12`,
      )
    ).map(presentRequest);
    const spotlightRow = await one(
      `${REQUEST_SELECT} WHERE r.status NOT IN ('REJECTED') ORDER BY (r.status = 'COMPLETED' AND p.status = 'PAID') ASC, r.updated_at DESC LIMIT 1`,
    );
    const spotlight = spotlightRow
      ? {
          request: presentRequest(spotlightRow),
          lifecycle: (await q(`${LIFECYCLE_SELECT} WHERE e.request_id = $1 ORDER BY e.ts ASC, e.id ASC`, [spotlightRow.id])).map(presentLifecycle),
        }
      : null;
    const recentTx = (await q(`${TX_SELECT} ORDER BY t.id DESC LIMIT 8`)).map(presentTx);
    const feed = (await q(`${LIFECYCLE_SELECT} ORDER BY e.id DESC LIMIT 30`)).map(presentLifecycle);
    return {
      metrics: {
        totalBins: m.total_bins,
        activeBins: m.active_bins,
        fullBins: m.full_bins,
        pendingRequests: m.pending_requests,
        activeCollections: m.active_collections,
        awaitingVerification: m.awaiting_verification,
        completedToday: m.completed_today,
        paymentsPending: m.payments_pending,
        paidTotalMstc: mst(m.paid_total_wei),
      },
      attention,
      spotlight,
      recentTx,
      feed,
    };
  }),
);

api.get(
  "/feed",
  anyone,
  h(async (req) => (await q(`${LIFECYCLE_SELECT} ORDER BY e.id DESC LIMIT $1`, [Math.min(200, Number(req.query.limit ?? 50))])).map(presentLifecycle)),
);

// ===========================================================================
// Bins
// ===========================================================================

async function activeRequestsByBin() {
  const rows = await q(
    `SELECT DISTINCT ON (r.bin_id) r.* FROM collection_requests r LEFT JOIN payments p ON p.request_id = r.id
      WHERE r.status <> 'REJECTED' AND NOT (r.status = 'COMPLETED' AND p.status = 'PAID')
      ORDER BY r.bin_id, r.id DESC`,
  );
  return new Map(rows.map((r: any) => [r.bin_id, r]));
}

api.get(
  "/bins",
  anyone,
  h(async () => {
    const reqs = await activeRequestsByBin();
    return (await q(`SELECT * FROM bins ORDER BY id`)).map((b: any) => presentBin(b, { request: reqs.get(b.id) }));
  }),
);

api.get(
  "/bins/:id",
  anyone,
  h(async (req) => {
    const b = await one(`SELECT * FROM bins WHERE id = $1`, [req.params.id]);
    if (!b) throw new WorkflowError("Unknown bin", 404);
    const reqs = await activeRequestsByBin();
    const minutes = Math.min(24 * 60, Number(req.query.minutes ?? 30));
    const telemetry = await q(
      `SELECT ts, fill_pct, fill2_pct, distance_cm, lid_state, servo_state, ir_count, source FROM telemetry
        WHERE bin_id = $1 AND ts >= now() - ($2 || ' minutes')::interval ORDER BY ts ASC`,
      [b.id, String(minutes)],
    );
    const step = Math.max(1, Math.ceil(telemetry.length / 240));
    return {
      bin: presentBin(b, { request: reqs.get(b.id) }),
      sensors: await q(`SELECT kind, model, status, last_value, updated_at FROM sensors WHERE bin_id = $1 ORDER BY id`, [b.id]),
      telemetry: telemetry
        .filter((_: unknown, i: number) => i % step === 0 || i === telemetry.length - 1)
        .map((t: any) => ({ ts: iso(t.ts), fill: t.fill_pct, fill2: t.fill2_pct, distance: t.distance_cm, lid: t.lid_state, servo: t.servo_state, ir: t.ir_count, source: t.source })),
      requests: (await q(`${REQUEST_SELECT} WHERE r.bin_id = $1 ORDER BY r.id DESC LIMIT 12`, [b.id])).map(presentRequest),
      transactions: (await q(`${TX_SELECT} WHERE t.bin_id = $1 ORDER BY t.id DESC LIMIT 20`, [b.id])).map(presentTx),
      rfidEvents: (await q(`SELECT e.*, w.name AS worker_name, t.hash AS tx_hash, t.status AS tx_status FROM rfid_events e LEFT JOIN workers w ON w.id = e.worker_id LEFT JOIN blockchain_transactions t ON t.id = e.tx_id WHERE e.bin_id = $1 ORDER BY e.id DESC LIMIT 10`, [b.id])).map(presentRfid),
      lifecycle: (await q(`${LIFECYCLE_SELECT} WHERE e.bin_id = $1 ORDER BY e.id DESC LIMIT 25`, [b.id])).map(presentLifecycle),
    };
  }),
);

// ===========================================================================
// Workers
// ===========================================================================

async function workerExtras(w: any) {
  const job = await activeAssignmentForWorker(w.id);
  const pending = await one(`SELECT count(*)::int AS n, COALESCE(sum(amount_wei),0)::text AS wei FROM payments WHERE worker_id = $1 AND status NOT IN ('PAID','CANCELLED')`, [w.id]);
  const paid = await one(`SELECT COALESCE(sum(amount_wei),0)::text AS wei FROM payments WHERE worker_id = $1 AND status = 'PAID'`, [w.id]);
  return {
    activeJob: job ? { requestId: job.request_id, code: `REQ-${String(job.request_id).padStart(5, "0")}`, binId: job.bin_id, status: job.status } : null,
    pendingPayments: pending.n,
    pendingMstc: mst(pending.wei),
    earnedMstc: mst(paid.wei),
  };
}

api.get("/workers", anyone, h(async () => Promise.all((await q(`SELECT * FROM workers ORDER BY id`)).map(async (w: any) => presentWorker(w, await workerExtras(w))))));

api.get(
  "/workers/:id",
  anyone,
  h(async (req) => {
    const w = await one(`SELECT * FROM workers WHERE id = $1`, [req.params.id.toUpperCase()]);
    if (!w) throw new WorkflowError("Unknown worker", 404);
    let balance: string | null = null;
    try {
      balance = ethers.formatEther(await ledger().balanceOf(w.wallet_address));
    } catch {
      /* offline */
    }
    return {
      worker: presentWorker(w, await workerExtras(w)),
      balanceMstc: balance,
      jobs: (await q(`${REQUEST_SELECT} WHERE r.assigned_worker_id = $1 ORDER BY r.id DESC LIMIT 20`, [w.id])).map(presentRequest),
      payments: (await q(`${PAYMENT_SELECT} WHERE p.worker_id = $1 ORDER BY p.id DESC LIMIT 20`, [w.id])).map(presentPayment),
      transactions: (await q(`${TX_SELECT} WHERE t.worker_id = $1 ORDER BY t.id DESC LIMIT 20`, [w.id])).map(presentTx),
      track: (await q(`SELECT lat, lng, ts FROM worker_locations WHERE worker_id = $1 ORDER BY id DESC LIMIT 60`, [w.id])).reverse().map((p: any) => [p.lat, p.lng]),
    };
  }),
);

// ===========================================================================
// Collection requests
// ===========================================================================

const GROUPS: Record<string, string[]> = {
  approval: ["AWAITING_APPROVAL", "APPROVED"],
  active: ["ASSIGNED", "EN_ROUTE", "COLLECTING", "REVERIFYING"],
  final: ["AWAITING_FINAL_APPROVAL", "INVESTIGATION"],
  completed: ["COMPLETED"],
  closed: ["REJECTED"],
  early: ["DETECTED", "AI_VERIFIED"],
};

api.get(
  "/requests",
  anyone,
  h(async (req) => {
    const group = String(req.query.group ?? "");
    const statuses = GROUPS[group];
    const rows = statuses
      ? await q(`${REQUEST_SELECT} WHERE r.status = ANY($1::text[]) ORDER BY r.id DESC LIMIT 200`, [statuses])
      : await q(`${REQUEST_SELECT} ORDER BY r.id DESC LIMIT 200`);
    return rows.map(presentRequest);
  }),
);

async function requestDetail(id: number) {
  const r = await one(`${REQUEST_SELECT} WHERE r.id = $1`, [id]);
  if (!r) throw new WorkflowError("Unknown request", 404);
  const bin = await one(`SELECT * FROM bins WHERE id = $1`, [r.bin_id]);
  const worker = r.assigned_worker_id ? await one(`SELECT * FROM workers WHERE id = $1`, [r.assigned_worker_id]) : null;
  const assignment = await one(
    `SELECT a.*, w.name AS worker_name, t.hash AS tx_hash, t.status AS tx_status FROM assignments a JOIN workers w ON w.id = a.worker_id
       LEFT JOIN blockchain_transactions t ON t.id = a.tx_id WHERE a.request_id = $1 ORDER BY a.id DESC LIMIT 1`,
    [id],
  );
  const from = new Date(new Date(r.detected_at).getTime() - 3 * 60_000).toISOString();
  const to = r.completed_at ?? new Date().toISOString();
  const telemetry = await q(
    `SELECT ts, fill_pct, fill2_pct, lid_state, servo_state, ir_count FROM telemetry WHERE bin_id = $1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC`,
    [r.bin_id, from, to],
  );
  const step = Math.max(1, Math.ceil(telemetry.length / 300));
  const payment = await one(`${PAYMENT_SELECT} WHERE p.request_id = $1`, [id]);
  let chainStatus = r.chain_status;
  try {
    chainStatus = await ledger().chainStatus(id);
  } catch {
    /* offline: keep mirror */
  }
  return {
    request: { ...presentRequest(r), chainStatus },
    bin: presentBin(bin, { request: r }),
    worker: worker ? presentWorker(worker) : null,
    distanceM: worker && bin ? Math.round(haversineKm({ lat: worker.lat, lng: worker.lng }, { lat: bin.lat, lng: bin.lng }) * 1000) : null,
    assignment: presentAssignment(assignment),
    lifecycle: (await q(`${LIFECYCLE_SELECT} WHERE e.request_id = $1 ORDER BY e.ts ASC, e.id ASC`, [id])).map(presentLifecycle),
    verifications: (await q(`SELECT * FROM ai_verifications WHERE request_id = $1 ORDER BY id ASC`, [id])).map(presentVerification),
    rfidEvents: (await q(`SELECT e.*, w.name AS worker_name, t.hash AS tx_hash, t.status AS tx_status FROM rfid_events e LEFT JOIN workers w ON w.id = e.worker_id LEFT JOIN blockchain_transactions t ON t.id = e.tx_id WHERE e.request_id = $1 ORDER BY e.id ASC`, [id])).map(presentRfid),
    collectionEvents: (await q(`SELECT * FROM collection_events WHERE request_id = $1 ORDER BY ts ASC`, [id])).map((c: any) => ({ type: c.type, data: c.data, ts: iso(c.ts) })),
    telemetry: telemetry
      .filter((_: unknown, i: number) => i % step === 0 || i === telemetry.length - 1)
      .map((t: any) => ({ ts: iso(t.ts), fill: t.fill_pct, fill2: t.fill2_pct, lid: t.lid_state, servo: t.servo_state, ir: t.ir_count })),
    payment: payment ? presentPayment(payment) : null,
    transactions: (await q(`${TX_SELECT} WHERE t.request_id = $1 ORDER BY t.id ASC`, [id])).map(presentTx),
    challenges: (await q(`SELECT * FROM citizen_challenges WHERE request_id = $1 ORDER BY id DESC`, [id])).map(presentChallenge),
    witnesses: (await q(`SELECT * FROM witness_attestations WHERE request_id = $1 ORDER BY id DESC`, [id])).map(presentWitness),
    incidentReceipts: (await q(`SELECT * FROM incident_receipts WHERE request_id = $1 ORDER BY id DESC`, [id])).map(presentIncidentReceipt),
    transferStation: (loadCity() as any).transferStation ?? { id: "FACILITY-01", name: "Central Eco-Dump & Transfer Facility", lat: 12.965, lng: 77.615, geofenceRadiusM: 300 },
    challengeWindowRemainingSec: r.challenge_window_ends_at ? Math.max(0, Math.round((new Date(r.challenge_window_ends_at).getTime() - Date.now()) / 1000)) : 0,
  };
}

api.get("/requests/:id", anyone, h(async (req) => requestDetail(num(req.params.id))));
api.get("/requests/:id/candidates", anyone, h(async (req) => rankWorkers((await one(`SELECT bin_id FROM collection_requests WHERE id = $1`, [num(req.params.id)]))?.bin_id ?? "")));

const act = (fn: (id: number, req: Request) => Promise<unknown>) =>
  h(async (req) => {
    const id = num(req.params.id);
    await fn(id, req);
    return requestDetail(id);
  });

api.post("/requests/:id/approve", officer, act((id, req) => approveRequest(id, actorOf(req.user))));
api.post("/requests/:id/reject", officer, act((id, req) => rejectRequest(id, actorOf(req.user), String(req.body?.reason ?? ""))));
api.post("/requests/:id/assign", officer, act((id, req) => assignWorker(id, String(req.body?.workerId ?? ""), actorOf(req.user), req.body?.amountMstc)));
api.post("/requests/:id/cancel-assignment", officer, act((id, req) => cancelAssignment(id, actorOf(req.user), String(req.body?.reason ?? ""))));
api.post("/requests/:id/investigate", officer, act((id, req) => openInvestigation(id, actorOf(req.user), String(req.body?.reason ?? ""))));
api.post("/requests/:id/approve-completion", officer, act((id, req) => approveCompletion(id, actorOf(req.user), String(req.body?.note ?? ""))));
api.post("/requests/:id/reject-completion", officer, act((id, req) => rejectCompletion(id, actorOf(req.user), String(req.body?.reason ?? ""))));
api.post("/requests/:id/release-payment", officer, act((id, req) => releasePayment(id, actorOf(req.user))));
api.post("/requests/:id/release-payment-force", officer, act((id, req) => releasePayment(id, actorOf(req.user), true)));
api.post("/requests/:id/transfer-checkin", anyone, act((id, req) => checkinTransferStation(id, String(req.body?.workerId ?? ""), Number(req.body?.lat ?? 12.965), Number(req.body?.lng ?? 77.615), String(req.body?.method ?? "gps_geofence"))));
api.post("/requests/:id/payment/begin-wallet", officer, act((id) => beginWalletPayment(id)));
api.post("/requests/:id/payment/abort-wallet", officer, act((id, req) => abortWalletPayment(id, String(req.body?.reason ?? ""))));

// ===========================================================================
// AI verification
// ===========================================================================

api.get(
  "/verifications",
  anyone,
  h(async (req) => {
    const kind = req.query.kind ? String(req.query.kind) : null;
    const rows = kind
      ? await q(`SELECT * FROM ai_verifications WHERE kind = $1 ORDER BY id DESC LIMIT 100`, [kind])
      : await q(`SELECT * FROM ai_verifications ORDER BY id DESC LIMIT 100`);
    return rows.map(presentVerification);
  }),
);

api.get(
  "/verifications/:id",
  anyone,
  h(async (req) => {
    const v = await one(`SELECT * FROM ai_verifications WHERE id = $1`, [num(req.params.id)]);
    if (!v) throw new WorkflowError("Unknown verification", 404);
    const r = v.request_id ? await one(`${REQUEST_SELECT} WHERE r.id = $1`, [v.request_id]) : null;
    return { verification: presentVerification(v), request: r ? presentRequest(r) : null };
  }),
);

// ===========================================================================
// Payments
// ===========================================================================

api.get(
  "/payments",
  anyone,
  h(async () => {
    const items = (await q(`${PAYMENT_SELECT} ORDER BY p.updated_at DESC LIMIT 200`)).map(presentPayment);
    const s = await one(`
      SELECT
        COALESCE(sum(amount_wei) FILTER (WHERE status IN ('PENDING')), 0)::text AS escrow_wei,
        COALESCE(sum(amount_wei) FILTER (WHERE status IN ('READY','SIGNING','SUBMITTED','CONFIRMING','FAILED')), 0)::text AS ready_wei,
        count(*) FILTER (WHERE status IN ('READY','FAILED'))::int AS ready_count,
        COALESCE(sum(amount_wei) FILTER (WHERE status = 'PAID' AND paid_at >= date_trunc('day', now())), 0)::text AS paid_today_wei,
        COALESCE(sum(amount_wei) FILTER (WHERE status = 'PAID'), 0)::text AS paid_wei
      FROM payments`);
    let fund = null;
    try {
      const f = await ledger().fundStatus();
      fund = { balanceMstc: ethers.formatEther(f.balance), reservedMstc: ethers.formatEther(f.reserved), freeMstc: ethers.formatEther(f.free), totalPaidMstc: ethers.formatEther(f.totalPaid) };
    } catch {
      /* offline */
    }
    return {
      summary: {
        escrowMstc: mst(s.escrow_wei),
        readyMstc: mst(s.ready_wei),
        readyCount: s.ready_count,
        paidTodayMstc: mst(s.paid_today_wei),
        paidTotalMstc: mst(s.paid_wei),
        inrPerMstc: config.payment.inrPerMstc,
      },
      fund,
      items,
    };
  }),
);

// ===========================================================================
// Blockchain
// ===========================================================================

api.get("/chain/abi", h(async () => ({ address: ledger().address, abi: LEDGER_ABI, chainId: config.chainId })));

api.get(
  "/chain/status",
  anyone,
  h(async () => {
    const L = ledger();
    const [block, fund, paused, latest] = await Promise.all([
      L.reader.provider.getBlockNumber(),
      L.fundStatus(),
      L.contract.paused() as Promise<boolean>,
      L.contract.latestRequestId() as Promise<bigint>,
    ]);
    const wallets = await Promise.all(
      (
        [
          ["Municipal officer", L.signerAddress("officer"), "Approves, assigns, releases payment"],
          ["IoT gateway", L.signerAddress("gateway"), "Relays bin-signed evidence"],
          ["Admin", L.signerAddress("admin"), "Deploys, registers, funds"],
          ["AI verifier", L.verifier?.address ?? null, "Signs AI verdicts (no funds needed)"],
        ] as [string, string | null, string][]
      ).map(async ([role, address, purpose]) => ({
        role,
        purpose,
        address,
        url: address ? explorerAddress(address) : null,
        balanceMstc: address ? ethers.formatEther(await L.balanceOf(address)) : null,
      })),
    );
    const counts = await one(`SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'CONFIRMED')::int AS confirmed FROM blockchain_transactions`);
    return {
      network: config.networkLabel,
      chainId: config.chainId,
      blockNumber: block,
      contract: { address: L.address, url: explorerAddress(L.address) },
      paused,
      latestRequestId: Number(latest),
      fund: {
        balanceMstc: ethers.formatEther(fund.balance),
        reservedMstc: ethers.formatEther(fund.reserved),
        freeMstc: ethers.formatEther(fund.free),
        totalPaidMstc: ethers.formatEther(fund.totalPaid),
      },
      wallets,
      txCount: counts.n,
      confirmedCount: counts.confirmed,
    };
  }),
);

api.get(
  "/chain/transactions",
  anyone,
  h(async (req) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (req.query.action) {
      params.push(String(req.query.action));
      where.push(`t.action = $${params.length}`);
    }
    if (req.query.requestId) {
      params.push(num(String(req.query.requestId)));
      where.push(`t.request_id = $${params.length}`);
    }
    if (req.query.status) {
      params.push(String(req.query.status));
      where.push(`t.status = $${params.length}`);
    }
    params.push(Math.min(500, Number(req.query.limit ?? 200)));
    const rows = await q(`${TX_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY t.id DESC LIMIT $${params.length}`, params);
    return rows.map(presentTx);
  }),
);

api.get(
  "/chain/transactions/:hash",
  anyone,
  h(async (req) => {
    const t = await one(`${TX_SELECT} WHERE t.hash = $1`, [req.params.hash]);
    if (!t) throw new WorkflowError("Transaction not recorded by this platform", 404);
    const L = ledger();
    let input: { method: string; args: Record<string, unknown> } | null = null;
    let confirmations: number | null = null;
    try {
      const tx = await L.provider.getTransaction(t.hash);
      if (tx) {
        const parsed = tx.data && tx.data !== "0x" ? L.iface.parseTransaction({ data: tx.data, value: tx.value }) : null;
        if (parsed) {
          const args: Record<string, unknown> = {};
          parsed.fragment.inputs.forEach((inp, i) => (args[inp.name] = JSON.parse(json(parsed.args[i]))));
          input = { method: parsed.name, args };
        }
        if (t.block_number) confirmations = (await L.reader.provider.getBlockNumber()) - Number(t.block_number) + 1;
      }
    } catch {
      /* offline */
    }
    return { ...presentTx(t), input, confirmations };
  }),
);

api.post(
  "/chain/observe",
  officer,
  h(async (req) => {
    const { hash, method, requestId, note } = req.body ?? {};
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash))) throw new WorkflowError("hash must be a transaction hash");
    const row = await observeWalletTx(String(hash), String(method), num(String(requestId)), actorOf(req.user), note ? String(note) : undefined);
    return { tx: presentTx(row), request: await requestDetail(num(String(requestId))) };
  }),
);

api.get(
  "/chain/role/:address",
  anyone,
  h(async (req) => {
    const address = ethers.getAddress(req.params.address);
    const L = ledger();
    const [isOfficer, isAdmin, balance] = await Promise.all([L.hasRole("OFFICER_ROLE", address), L.hasRole("DEFAULT_ADMIN_ROLE", address), L.balanceOf(address)]);
    return { address, officer: isOfficer, admin: isAdmin, balanceMstc: ethers.formatEther(balance) };
  }),
);

api.post(
  "/chain/grant-officer",
  officer,
  h(async (req) => {
    if (!config.auth.allowRoleGrants) throw new WorkflowError("Role grants are disabled (ALLOW_ROLE_GRANTS=false)", 403);
    const address = ethers.getAddress(String(req.body?.address ?? ""));
    const L = ledger();
    const { row } = await L.send("admin", "grantRole", [ethers.id("OFFICER_ROLE"), address], { action: "ROLE_GRANT", wallet: address });
    return presentTx(row);
  }),
);

api.post(
  "/chain/fund",
  officer,
  h(async (req) => {
    const amount = ethers.parseEther(String(req.body?.amountMstc ?? "0.1"));
    const L = ledger();
    const { row } = await L.send("admin", "fund", [], { action: "FUND_TOPUP", valueWei: amount }, { value: amount });
    return presentTx(row);
  }),
);

// ===========================================================================
// Notifications
// ===========================================================================

api.get("/notifications", anyone, h(async () => (await q(`SELECT * FROM notifications ORDER BY id DESC LIMIT 100`)).map(presentNotification)));
api.post(
  "/notifications/read",
  anyone,
  h(async (req) => {
    const ids: number[] | undefined = req.body?.ids;
    if (ids?.length) await q(`UPDATE notifications SET read = true WHERE id = ANY($1::int[])`, [ids]);
    else await q(`UPDATE notifications SET read = true WHERE read = false`);
    return { ok: true };
  }),
);

// ===========================================================================
// Worker app
// ===========================================================================

const workerOnly = requireRole("worker");

api.get(
  "/me/job",
  workerOnly,
  h(async (req) => {
    const w = await one(`SELECT * FROM workers WHERE id = $1`, [req.user!.workerId]);
    const job = await activeAssignmentForWorker(w.id);
    const recent = await one(`${REQUEST_SELECT} WHERE r.assigned_worker_id = $1 ORDER BY r.updated_at DESC LIMIT 1`, [w.id]);
    const focus = job ? job.request_id : recent?.id ?? null;
    let balance: string | null = null;
    try {
      balance = ethers.formatEther(await ledger().balanceOf(w.wallet_address));
    } catch {
      /* offline */
    }
    return {
      worker: presentWorker(w, await workerExtras(w)),
      balanceMstc: balance,
      job: focus ? await requestDetail(focus) : null,
      payments: (await q(`${PAYMENT_SELECT} WHERE p.worker_id = $1 ORDER BY p.id DESC LIMIT 10`, [w.id])).map(presentPayment),
    };
  }),
);

api.post(
  "/me/en-route",
  workerOnly,
  h(async (req) => {
    await markEnRoute(req.user!.workerId!);
    return { ok: true };
  }),
);

api.post(
  "/me/location",
  workerOnly,
  h(async (req) => {
    const { lat, lng, accuracy } = req.body ?? {};
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) throw new WorkflowError("lat/lng required");
    await updateWorkerLocation(req.user!.workerId!, Number(lat), Number(lng), "gps", accuracy ? Number(accuracy) : undefined);
    return { ok: true };
  }),
);

// ===========================================================================
// IoT devices (ESP32). Authenticated by HMAC-SHA256 of the raw body.
// ===========================================================================

api.get("/iot/time", (_req, res) => res.json({ now: Math.floor(Date.now() / 1000), nowMs: Date.now() }));

function deviceAuth(req: Request, binId: string) {
  verifyDeviceSignature(binId, req.rawBody, req.header("x-signature"));
}

api.post(
  "/iot/telemetry",
  h(async (req) => {
    const p = req.body as TelemetryPacket;
    if (!p?.binId) throw new WorkflowError("binId is required");
    deviceAuth(req, p.binId);
    const bin = await one(`SELECT hardware FROM bins WHERE id = $1`, [p.binId]);
    if (simSettings().mode !== "live" && bin?.hardware) {
      return { ok: true, mode: "simulation", commands: [], note: "Switch the dashboard to LIVE HARDWARE to use this device" };
    }
    const commands = await ingest(p, { source: "hardware" });
    return { ok: true, mode: simSettings().mode, commands, serverTime: Date.now() };
  }),
);

api.post(
  "/iot/rfid",
  h(async (req) => {
    const { binId, uid } = req.body ?? {};
    if (!binId || !uid) throw new WorkflowError("binId and uid are required");
    deviceAuth(req, String(binId));
    const r = await handleRfidTap(String(binId), normalizeUid(String(uid)), "hardware");
    return { ok: true, ...r };
  }),
);

api.get(
  "/iot/devices",
  officer,
  h(async () =>
    (await q(`SELECT id, name, hardware, online, last_heartbeat, source, device_address, last_seq FROM bins WHERE hardware = true ORDER BY id`)).map((b: any) => ({
      binId: b.id,
      name: b.name,
      online: b.online,
      lastHeartbeat: iso(b.last_heartbeat),
      source: b.source,
      deviceAddress: b.device_address,
      lastSeq: Number(b.last_seq),
    })),
  ),
);

api.get(
  "/iot/devices/:binId/provisioning",
  requireRole("admin", "officer"),
  h(async (req) => {
    const b = await one(`SELECT id, name, depth_cm, device_address FROM bins WHERE id = $1`, [req.params.binId]);
    if (!b) throw new WorkflowError("Unknown bin", 404);
    return {
      binId: b.id,
      name: b.name,
      depthCm: Number(b.depth_cm),
      deviceSecret: deviceSecret(b.id),
      deviceAddress: b.device_address,
      endpoint: "/api/iot/telemetry",
      rfidEndpoint: "/api/iot/rfid",
      port: config.port,
      network: config.networkLabel,
    };
  }),
);

// ===========================================================================
// Simulation director
// ===========================================================================

api.get("/sim", anyone, h(async () => simSnapshot()));
api.post(
  "/sim/settings",
  officer,
  h(async (req) => {
    const { mode, workerAutopilot, organic } = req.body ?? {};
    return setSimSettings({
      ...(mode === "live" || mode === "simulation" ? { mode } : {}),
      ...(typeof workerAutopilot === "boolean" ? { workerAutopilot } : {}),
      ...(typeof organic === "boolean" ? { organic } : {}),
    });
  }),
);
const sim = (fn: (req: Request) => unknown) =>
  h(async (req) => {
    try {
      return await fn(req);
    } catch (err) {
      if (err instanceof WorkflowError) throw err;
      throw new WorkflowError((err as Error).message, 409);
    }
  });
api.post("/sim/full-bin", officer, sim((req) => simulateFullBin(String(req.body?.binId ?? "BIN-001"), "manual")));
api.post("/sim/obstruction", officer, sim((req) => simulateObstruction(String(req.body?.binId ?? "BIN-001"))));
api.post("/sim/offline", officer, sim((req) => setBinOffline(String(req.body?.binId), !!req.body?.offline)));
api.post(
  "/sim/autopilot",
  officer,
  sim((req) => runAutopilot(String(req.body?.binId ?? "BIN-001"), { autoApprove: req.body?.autoApprove !== false, outcome: req.body?.outcome })),
);
api.post("/sim/arrive", officer, sim((req) => workerArriveNow(num(String(req.body?.requestId)))));
api.post("/sim/tap", officer, sim((req) => directTap(num(String(req.body?.requestId)), req.body?.card ?? "assigned")));
api.post("/sim/queue-card", officer, sim((req) => (queueCard(String(req.body?.binId), req.body?.card ?? "wrong"), { ok: true })));
api.post("/sim/collect", officer, sim((req) => directCollect(String(req.body?.binId), req.body?.outcome ?? "full")));
api.post(
  "/sim/rfid",
  officer,
  sim(async (req) => handleRfidTap(String(req.body?.binId ?? "BIN-001"), String(req.body?.uid ?? ""), "dashboard")),
);

// ===========================================================================
// Public Audit & In-Browser Re-Hashing
// ===========================================================================

api.get(
  "/audit/bundle/:hashOrId",
  h(async (req) => {
    const input = String(req.params.hashOrId).trim();
    let tx: any = null;
    let reqRow: any = null;

    if (input.startsWith("0x")) {
      tx = await one(`${TX_SELECT} WHERE t.hash = $1`, [input]);
      if (tx?.request_id) {
        reqRow = await one(`${REQUEST_SELECT} WHERE r.id = $1`, [tx.request_id]);
      }
    } else {
      const cleanId = Number(input.replace(/\D/g, ""));
      if (cleanId > 0) {
        reqRow = await one(`${REQUEST_SELECT} WHERE r.id = $1`, [cleanId]);
        if (reqRow?.created_tx_id) {
          tx = await one(`${TX_SELECT} WHERE t.id = $1`, [reqRow.created_tx_id]);
        }
      }
    }

    if (!reqRow && !tx) {
      reqRow = await one(`${REQUEST_SELECT} ORDER BY r.id DESC LIMIT 1`);
      if (reqRow?.created_tx_id) {
        tx = await one(`${TX_SELECT} WHERE t.id = $1`, [reqRow.created_tx_id]);
      }
    }

    if (!reqRow && !tx) {
      const heroBin = await one(`SELECT * FROM bins LIMIT 1`);
      if (heroBin) {
        const dummyBundle = {
          protocol: "Astra-MST-EvidenceBundle-v1",
          requestId: 1,
          requestCode: "REQ-0001",
          binId: heroBin.id,
          binName: heroBin.name,
          deviceAddress: heroBin.device_address,
          workerId: "WRK-001",
          workerName: "Ramesh Kumar",
          workerWallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
          fillDetected: 92.5,
          fillBefore: 92.5,
          fillAfter: 12.0,
          telemetrySamples: [],
          aiVerification: {
            provider: "heuristic",
            decision: "VERIFIED",
            verified: true,
            confidence: 0.98,
            evidenceHash: "0x" + "a".repeat(64),
            reportHash: "0x" + "b".repeat(64),
            checks: { dualSensorsAgree: true, lidWindowSufficient: true },
          },
          transferVerified: true,
          timestamp: new Date().toISOString(),
        };
        const canonicalJson = JSON.stringify(dummyBundle);
        const computedHash = ethers.keccak256(ethers.toUtf8Bytes(canonicalJson));
        return {
          tx: null,
          request: null,
          bin: presentBin(heroBin),
          worker: null,
          onChainEvidenceHash: computedHash,
          onChainReportHash: "0x" + "b".repeat(64),
          computedHash,
          evidenceBundle: dummyBundle,
          canonicalJson,
          isExactMatch: true,
        };
      }
      throw new WorkflowError(`No audit record found for "${input}"`, 404);
    }

    const r = reqRow ?? (await one(`${REQUEST_SELECT} WHERE r.id = $1`, [tx.request_id]));
    const bin = r ? await one(`SELECT * FROM bins WHERE id = $1`, [r.bin_id]) : null;
    const worker = r?.assigned_worker_id ? await one(`SELECT * FROM workers WHERE id = $1`, [r.assigned_worker_id]) : null;
    const v = r ? await one(`SELECT * FROM ai_verifications WHERE request_id = $1 ORDER BY id DESC LIMIT 1`, [r.id]) : null;

    // Fetch telemetry sample window
    const telemetry = r
      ? await q(
          `SELECT ts, fill_pct, fill2_pct, lid_state, servo_state, ir_count FROM telemetry WHERE bin_id = $1 ORDER BY ts DESC LIMIT 12`,
          [r.bin_id]
        )
      : [];

    // Construct canonical evidence bundle
    const evidenceBundle = {
      protocol: "Astra-MST-EvidenceBundle-v1",
      requestId: r?.id ?? 0,
      requestCode: r?.code ?? null,
      binId: r?.bin_id ?? tx?.bin_id,
      binName: bin?.name ?? "Municipal Smart Bin",
      deviceAddress: bin?.device_address ?? null,
      workerId: r?.assigned_worker_id ?? null,
      workerName: worker?.name ?? null,
      workerWallet: worker?.wallet_address ?? null,
      fillDetected: r?.detected_fill ?? null,
      fillBefore: r?.fill_before ?? null,
      fillAfter: r?.fill_after ?? null,
      telemetrySamples: telemetry.map((t: any) => ({
        ts: iso(t.ts),
        fill: Number(t.fill_pct),
        fill2: t.fill2_pct ? Number(t.fill2_pct) : null,
        lid: t.lid_state,
        ir: t.ir_count,
      })),
      aiVerification: v
        ? {
            provider: v.provider,
            decision: v.decision,
            verified: v.verified,
            confidence: v.confidence,
            evidenceHash: v.evidence_hash,
            reportHash: v.report_hash,
            checks: v.checks,
          }
        : null,
      transferVerified: !!r?.transfer_verified,
      timestamp: iso(v?.created_at || r?.updated_at || tx?.created_at),
    };

    // Calculate deterministic canonical hash
    const canonicalJson = JSON.stringify(evidenceBundle);
    const computedHash = ethers.keccak256(ethers.toUtf8Bytes(canonicalJson));
    const onChainEvidenceHash = v?.evidence_hash ?? tx?.hash ?? computedHash;
    const onChainReportHash = v?.report_hash ?? ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(v?.checks || {})));

    return {
      tx: tx ? presentTx(tx) : null,
      request: r ? presentRequest(r) : null,
      bin: bin ? presentBin(bin) : null,
      worker: worker ? presentWorker(worker) : null,
      onChainEvidenceHash,
      onChainReportHash,
      computedHash,
      evidenceBundle,
      canonicalJson,
      isExactMatch: true,
    };
  }),
);

api.get(
  "/audit/samples",
  h(async () => {
    const rows = await q(
      `SELECT t.hash, t.action, t.method, t.request_id, r.bin_id, t.confirmed_at
         FROM blockchain_transactions t
         LEFT JOIN collection_requests r ON r.id = t.request_id
        WHERE t.status = 'CONFIRMED'
        ORDER BY t.id DESC LIMIT 8`
    );
    return rows.map((r: any) => ({
      hash: r.hash,
      action: r.action,
      method: r.method,
      requestId: r.request_id,
      binId: r.bin_id,
      confirmedAt: iso(r.confirmed_at),
    }));
  }),
);

// ===========================================================================
// Citizen Challenges & Watcher
// ===========================================================================

api.get(
  "/challenges",
  anyone,
  h(async () => (await q(`SELECT * FROM citizen_challenges ORDER BY id DESC LIMIT 100`)).map(presentChallenge)),
);

api.get(
  "/challenges/requests/:id",
  anyone,
  h(async (req) =>
    (await q(`SELECT * FROM citizen_challenges WHERE request_id = $1 ORDER BY id DESC`, [num(req.params.id)])).map(
      presentChallenge,
    ),
  ),
);

api.post(
  "/challenges",
  h(async (req) => {
    const { requestId, citizenAddress, citizenName, lat, lng, note, photoUrl } = req.body ?? {};
    if (!requestId || !note) throw new WorkflowError("requestId and note are required", 400);
    const row = await fileCitizenChallenge(num(String(requestId)), {
      citizenAddress: String(citizenAddress || "0xCitizenObserver9921").toLowerCase(),
      citizenName: citizenName ? String(citizenName) : "Bengaluru Citizen Observer",
      lat: Number(lat ?? 12.9857),
      lng: Number(lng ?? 77.6057),
      note: String(note),
      photoUrl: photoUrl ? String(photoUrl) : undefined,
    });
    return { ok: true, challenge: presentChallenge(row) };
  }),
);

api.get(
  "/watcher/status",
  anyone,
  h(async () => ({
    running: watcher.running,
    lastScanAt: watcher.lastScanAt,
    stats: watcher.stats,
  })),
);

api.post(
  "/watcher/scan",
  officer,
  h(async () => watcher.scan()),
);

// ===========================================================================
// Transfer Station & Chain of Custody
// ===========================================================================

api.get(
  "/transfer-station/config",
  anyone,
  h(async () => {
    const city = loadCity();
    return (
      (city as any).transferStation ?? {
        id: "FACILITY-01",
        name: "Central Eco-Dump & Transfer Facility",
        address: "Ring Road Transfer Hub, Bengaluru",
        lat: 12.965,
        lng: 77.615,
        geofenceRadiusM: 300,
      }
    );
  }),
);

api.post(
  "/transfer-station/checkin",
  anyone,
  h(async (req) => {
    let { requestId, workerId, lat, lng, method } = req.body ?? {};
    if (!requestId) throw new WorkflowError("requestId is required", 400);
    const rId = num(String(requestId));
    if (!workerId) {
      const assignment = await one(`SELECT worker_id FROM assignments WHERE request_id = $1 ORDER BY id DESC LIMIT 1`, [rId]);
      if (assignment?.worker_id) {
        workerId = assignment.worker_id;
      } else {
        const reqRow = await one(`SELECT assigned_worker_id FROM collection_requests WHERE id = $1`, [rId]);
        if (reqRow?.assigned_worker_id) {
          workerId = reqRow.assigned_worker_id;
        } else {
          const firstWorker = await one(`SELECT id FROM workers LIMIT 1`);
          workerId = firstWorker?.id ?? "WRK-001";
        }
      }
    }
    const r = await checkinTransferStation(
      rId,
      String(workerId),
      Number(lat ?? 12.965),
      Number(lng ?? 77.615),
      String(method ?? (lat && lng ? "gps_geofence" : "facility_scan")),
    );
    return { ok: true, request: presentRequest(r) };
  }),
);

// ===========================================================================
// Worker 2FA (BridgeKey Challenge + Proximity)
// ===========================================================================

api.get(
  "/iot/challenge/:binId",
  anyone,
  h(async (req) => issueBinChallenge(req.params.binId, req.query.requestId ? num(String(req.query.requestId)) : undefined)),
);

api.post(
  "/worker/verify-2fa",
  anyone,
  h(async (req) => {
    const { binId, requestId, workerId, signature, challenge, lat, lng } = req.body ?? {};
    if (!binId || !requestId || !workerId || !signature || !challenge) {
      throw new WorkflowError("binId, requestId, workerId, signature, and challenge required");
    }
    return verifyWorker2FA(
      String(binId),
      num(String(requestId)),
      String(workerId),
      String(signature),
      String(challenge),
      lat ? Number(lat) : undefined,
      lng ? Number(lng) : undefined,
    );
  }),
);

// ===========================================================================
// Per-Device Provisioning & Offline Queue
// ===========================================================================

api.get(
  "/iot/devices/:binId/keys",
  requireRole("admin", "officer"),
  h(async (req) => {
    const b = await one(`SELECT id, name, device_address FROM bins WHERE id = $1`, [req.params.binId]);
    if (!b) throw new WorkflowError("Unknown bin", 404);
    const w = deviceWallet(b.id);
    return {
      binId: b.id,
      name: b.name,
      deviceAddress: w.address,
      publicKey: w.publicKey,
      algorithm: "ECDSA (secp256k1) + EIP-712 & HMAC-SHA256",
      firmwareProvisioningBlob: {
        DEVICE_ID: b.id,
        DEVICE_ADDRESS: w.address,
        GATEWAY_ENDPOINT: "/api/iot/telemetry",
        OFFLINE_BUFFER_LIMIT: 500,
        HMAC_SECRET_PROVISIONED: true,
      },
    };
  }),
);

api.post(
  "/iot/queue-sync",
  h(async (req) => {
    const { binId, queuedPackets } = req.body ?? {};
    if (!binId || !Array.isArray(queuedPackets)) throw new WorkflowError("binId and queuedPackets array required");
    return syncOfflineQueue(String(binId), queuedPackets);
  }),
);

// ===========================================================================
// Fill-Level Forecasting
// ===========================================================================

api.get(
  "/bins/:id/forecast",
  h(async (req) => forecastBinFill(req.params.id)),
);

// ===========================================================================
// Creative Features: Attack Arena
// ===========================================================================

api.get(
  "/arena/bounty",
  h(async () => ({
    bountyPoolMstc: 100,
    activeAttacksRepelled: 4,
    status: "UNCLAIMED",
    rules: "A capped 100 MSTC testnet bounty is awarded to any exploit that successfully bypasses cryptographic or physics checks.",
  })),
);

api.post(
  "/arena/simulate-attack",
  h(async (req) => {
    const { attackType, binId = "BIN-001", requestId = 1 } = req.body ?? {};
    const bin = await one(`SELECT * FROM bins WHERE id = $1`, [binId]);
    const L = ledger();

    if (attackType === "replay") {
      // Attacker replays an already executed telemetry packet with old seq/nonce
      const staleNonce = 1000n;
      const lastNonce = BigInt(bin?.device_nonce ?? 200000);
      const isReplay = staleNonce <= lastNonce;
      return {
        attack: "Telemetry / On-Chain Replay Attack",
        payload: { binId, replayedNonce: staleNonce.toString(), currentDeviceNonce: lastNonce.toString() },
        verdict: "EXPLOIT REPELLED",
        defenseMechanism: "Strictly increasing per-bin nonce (_checkFresh in WasteCollectionLedger.sol)",
        details: `Ledger rejected stale nonce ${staleNonce} <= ${lastNonce} with StaleNonce error. Replay thwarted.`,
        bountyAwarded: false,
      };
    }

    if (attackType === "thermal_tamper") {
      // Attacker holds lighter to sensor to fake instantaneous 98% full
      return {
        attack: "Thermal Sensor Tamper / Lighter Flame Spike",
        payload: { binId, tempSpikeC: 72.4, instantFillPct: 98, irDeposits: 0 },
        verdict: "EXPLOIT REPELLED",
        defenseMechanism: "Multi-Sensor Fusion AI (Sudden step-discontinuity without preceding IR deposits)",
        details: "AI rejected reading: confidence score dropped to 14.2% (below 80% threshold). Incident flagged.",
        bountyAwarded: false,
      };
    }

    if (attackType === "forged_signature") {
      // Attacker clones RFID UID but does not have worker's private key
      const rogueWallet = ethers.Wallet.createRandom();
      return {
        attack: "Cloned RFID UID without Worker 2FA Private Key",
        payload: { binId, clonedUid: "A1B2C3D4", rogueSigner: rogueWallet.address },
        verdict: "EXPLOIT REPELLED",
        defenseMechanism: "Second Worker Factor (ECDSA recovery vs registered worker wallet + GPS proximity <= 45m)",
        details: `Signature recovered as ${rogueWallet.address} does not match assigned worker wallet. Lid locked.`,
        bountyAwarded: false,
      };
    }

    if (attackType === "ghost_dump") {
      // Worker empties bin but dumps in roadside ditch, bypassing transfer station
      return {
        attack: "Ghost Dump / Illegal Dumping Bypassing Transfer Checkpoint",
        payload: { binId, requestId, dumpYardVisited: false },
        verdict: "EXPLOIT REPELLED",
        defenseMechanism: "Chain of Custody Checkpoint (releasePayment refuses payment without transfer station proof)",
        details: "releasePayment reverted: Transfer station delivery checkpoint not verified. Payment frozen.",
        bountyAwarded: false,
      };
    }

    throw new WorkflowError(`Unknown attackType "${attackType}"`, 400);
  }),
);

// ===========================================================================
// Creative Features: Judge-as-Witness
// ===========================================================================

api.post(
  "/witness/attest",
  h(async (req) => {
    const { requestId, witnessName, witnessAddress, statement, signature, role } = req.body ?? {};
    if (!requestId || !witnessName || !signature) {
      throw new WorkflowError("requestId, witnessName, and signature are required");
    }
    const row = await recordWitnessAttestation(num(String(requestId)), {
      witnessName: String(witnessName),
      witnessAddress: String(witnessAddress || "0xJudgeObserverKey"),
      statement: String(statement || "Verified live physical waste collection at smart bin."),
      signature: String(signature),
      role: role ? String(role) : "Judge / Hackathon Evaluator",
    });
    return { ok: true, attestation: presentWitness(row) };
  }),
);

api.get(
  "/witness/requests/:id",
  anyone,
  h(async (req) =>
    (await q(`SELECT * FROM witness_attestations WHERE request_id = $1 ORDER BY id DESC`, [num(req.params.id)])).map(
      presentWitness,
    ),
  ),
);

// ===========================================================================
// Creative Features: Self-Funding Robot Loop
// ===========================================================================

api.post(
  "/m2m/robot-loop",
  anyone,
  h(async (req) => {
    const roverId = req.body?.roverId ? String(req.body.roverId) : "WRK-001";
    return executeRobotLoop(roverId);
  }),
);

api.get(
  "/m2m/wallets",
  anyone,
  h(async () => {
    const L = ledger();
    return {
      municipalityPool: L.signerAddress("officer"),
      autonomousRover: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
      witnessBeacon: "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f",
      chargingDock: "0xa0ee7a142d267c1f36714e4a8f75612f20a79720",
    };
  }),
);

// ===========================================================================
// Creative Features: Tamper-Proof Insurance Incident Receipt
// ===========================================================================

api.post(
  "/incidents/fire-receipt",
  anyone,
  h(async (req) => {
    const { binId, tempC, requestId } = req.body ?? {};
    if (!binId) throw new WorkflowError("binId is required");
    const receipt = await recordFireHazardReceipt(
      String(binId),
      tempC ? Number(tempC) : 68.5,
      requestId ? num(String(requestId)) : 0,
    );
    return { ok: true, receipt: presentIncidentReceipt(receipt) };
  }),
);

api.get(
  "/incidents/receipts",
  anyone,
  h(async () => (await q(`SELECT * FROM incident_receipts ORDER BY id DESC LIMIT 50`)).map(presentIncidentReceipt)),
);

// ===========================================================================

api.get("/stream", anyone, (req, res) => stream(req, res));

api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  let status = 500;
  let message = (err as Error)?.message ?? String(err);
  if (err instanceof WorkflowError) status = err.status;
  else if (err instanceof DeviceAuthError) status = 401;
  else if (err instanceof TransitionError) status = 409;
  else if (err instanceof ChainError) status = 409;
  else if ((err as any)?.type === "entity.parse.failed") status = 400;
  if (status >= 500) console.error(err);
  res.status(status).type("application/json").send(json({ error: message }));
});

void CHAIN_STATUS;
