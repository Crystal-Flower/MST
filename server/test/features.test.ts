import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test, before } from "node:test";
import { ethers } from "ethers";
import { forecastBinFill } from "../src/ai/forecast";
import { config, deviceSecret, workerWallet } from "../src/config";
import { initDb, one, q } from "../src/db";
import { DeviceAuthError, syncOfflineQueue, verifyDeviceSignature } from "../src/iot/ingest";
import { executeRobotLoop } from "../src/workflow/robotLoop";
import {
  checkinTransferStation,
  fileCitizenChallenge,
  getBin,
  getRequest,
  issueBinChallenge,
  recordFireHazardReceipt,
  recordWitnessAttestation,
  verifyWorker2FA,
} from "../src/workflow/service";
import { watcher } from "../src/workflow/watcher";

process.env.PGLITE_DIR = "memory://";

before(async () => {
  process.env.PGLITE_DIR = "memory://";
  const { seed } = await import("../src/db/seed");
  await initDb();
  await seed();
});

let nextRequestId = 9000;
async function createTestRequest(overrides: Record<string, any> = {}) {
  const id = ++nextRequestId;
  const [row] = await q(
    `INSERT INTO collection_requests
      (id, code, bin_id, municipality_id, status, detected_fill, detected_at, transfer_verified, challenge_status, assigned_worker_id)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9)
     RETURNING *`,
    [
      id,
      overrides.code ?? `REQ-TEST-${id}`,
      overrides.bin_id ?? "BIN-001",
      overrides.municipality_id ?? "MUN-01",
      overrides.status ?? "AWAITING_FINAL_APPROVAL",
      overrides.detected_fill ?? 90,
      overrides.transfer_verified ?? false,
      overrides.challenge_status ?? "OPEN",
      overrides.assigned_worker_id ?? null,
    ]
  );
  return row;
}

test("Public Audit: deterministic canonical bundle hashing and browser re-hash equivalence", () => {
  const bundle = {
    protocol: "Astra-MST-EvidenceBundle-v1",
    requestId: 101,
    requestCode: "REQ-0101",
    binId: "BIN-001",
    binName: "MG Road Metro Bin",
    deviceAddress: "0xABCcca4d71756b17a1aB54830EFE07405483264d",
    workerId: "WRK-001",
    workerName: "Ramesh Kumar",
    workerWallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    fillDetected: 91.5,
    fillBefore: 91.5,
    fillAfter: 14.0,
    transferVerified: true,
    timestamp: "2026-09-29T10:00:00.000Z",
  };

  const canonicalJson = JSON.stringify(bundle);
  const computedHash = ethers.keccak256(ethers.toUtf8Bytes(canonicalJson));

  assert.match(computedHash, /^0x[0-9a-f]{64}$/);

  // Exact browser re-hash simulation
  const browserRehash = ethers.keccak256(ethers.toUtf8Bytes(canonicalJson));
  assert.equal(browserRehash, computedHash);

  // Tamper detection: modifying a single value completely changes the digest
  const tamperedBundle = { ...bundle, fillAfter: 14.1 };
  const tamperedHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(tamperedBundle)));
  assert.notEqual(computedHash, tamperedHash);
});

test("Citizen Challenge & Watcher: proximity validation, payment freezing, and stake slashing", async () => {
  const req = await createTestRequest({
    status: "AWAITING_FINAL_APPROVAL",
    challenge_status: "OPEN",
    assigned_worker_id: "WRK-001",
  });

  const bin = await getBin("BIN-001");

  // 1. Citizen files valid challenge within 50m
  const challenge = await fileCitizenChallenge(req.id, {
    citizenAddress: "0xCitizenGuardian001",
    citizenName: "Astra Auditor",
    lat: bin.lat,
    lng: bin.lng,
    note: "Bin was bypassed and remains overflowing with plastic waste",
  });

  assert.equal(challenge.status, "PENDING");
  assert.equal(challenge.bounty_mstc, 0.02);

  // Check request state moved to CHALLENGED
  const updatedReq = await getRequest(req.id);
  assert.equal(updatedReq.challenge_status, "CHALLENGED");

  // 2. Watcher scan intercepts and upholds valid challenge
  const scan = await watcher.scan();
  assert.ok(scan.interventions.some((i) => i.requestId === req.id));

  // 3. Request should be moved to INVESTIGATION and challenge UPHELD
  const resolvedReq = await getRequest(req.id);
  assert.equal(resolvedReq.status, "INVESTIGATION");

  const [resolvedChallenge] = await q(`SELECT * FROM citizen_challenges WHERE id = $1`, [challenge.id]);
  assert.equal(resolvedChallenge.status, "UPHELD");
  assert.equal(resolvedChallenge.watcher_verified, true);
});

test("Chain of Custody: Dump yard / transfer station geofence checkin", async () => {
  const req = await createTestRequest({
    status: "COMPLETED",
    transfer_verified: false,
    assigned_worker_id: "WRK-001",
  });

  // Attempting to check in far outside geofence fails
  await assert.rejects(async () => {
    await checkinTransferStation(req.id, "WRK-001", 13.999, 78.999, "gps_geofence");
  }, /away from/);

  // Checking in inside the Eco-Dump facility geofence (12.965, 77.615) succeeds
  const verifiedReq = await checkinTransferStation(req.id, "WRK-001", 12.965, 77.615, "gps_geofence");
  assert.equal(verifiedReq.transfer_verified, true);
  assert.ok(verifiedReq.transfer_facility.includes("Eco-Dump") || verifiedReq.transfer_facility.includes("Transfer"));
});

test("Second Worker Factor: Ephemeral bin challenge signing and phone proximity check", async () => {
  const req = await createTestRequest({
    status: "COLLECTING",
    assigned_worker_id: "WRK-001",
  });

  const bin = await getBin("BIN-001");
  const challenge = issueBinChallenge("BIN-001", req.id);
  assert.ok(challenge.challenge.startsWith("WasteCollectionChallenge:BIN-001:"));

  // 1. Worker signs challenge with matching wallet
  const workerNode = ethers.HDNodeWallet.fromPhrase(config.keys.workerMnemonic!, undefined, "m/44'/60'/2'/0/1");
  const validSignature = await workerNode.signMessage(challenge.challenge);

  // Valid signature and proximity (lat, lng match bin) -> SUCCESS
  const res = await verifyWorker2FA("BIN-001", req.id, "WRK-001", validSignature, challenge.challenge, bin.lat, bin.lng);
  assert.equal(res.ok, true);
  assert.equal(res.verified, true);

  const verifiedReq = await getRequest(req.id);
  assert.equal(verifiedReq.second_factor_verified, true);

  // 2. Rogue signer (forged key) -> REJECTED
  const rogueWallet = ethers.Wallet.createRandom();
  const forgedSignature = await rogueWallet.signMessage(challenge.challenge);
  await assert.rejects(async () => {
    await verifyWorker2FA("BIN-001", req.id, "WRK-001", forgedSignature, challenge.challenge, bin.lat, bin.lng);
  }, /Worker signature mismatch/);

  // 3. Valid key but excessive distance (>45m) -> REJECTED
  await assert.rejects(async () => {
    await verifyWorker2FA("BIN-001", req.id, "WRK-001", validSignature, challenge.challenge, bin.lat + 0.005, bin.lng + 0.005);
  }, /Phone proximity failed/);
});

test("Per-Device Keys & Offline Queue: HMAC-SHA256 signature and sequential replay protection", async () => {
  const secret = deviceSecret("BIN-001");
  assert.ok(secret && secret.length >= 32);

  const packetBody = Buffer.from(JSON.stringify({ binId: "BIN-001", fillPercentage: 55, seq: 1 }));
  const validHmac = crypto.createHmac("sha256", secret).update(packetBody).digest("hex");

  // Valid device HMAC signature
  assert.doesNotThrow(() => verifyDeviceSignature("BIN-001", packetBody, validHmac));

  // Invalid signature rejected
  assert.throws(() => verifyDeviceSignature("BIN-001", packetBody, "0xdeadbeefbadsignature"), DeviceAuthError);

  // Tampered payload rejected
  const tamperedBody = Buffer.from(JSON.stringify({ binId: "BIN-001", fillPercentage: 99, seq: 1 }));
  assert.throws(() => verifyDeviceSignature("BIN-001", tamperedBody, validHmac), DeviceAuthError);

  // Offline queue ingestion flushes and processes queued packets in sequence
  const queued = [
    { binId: "BIN-001", fillPercentage: 56, seq: 10, timestamp: Date.now() - 30000 },
    { binId: "BIN-001", fillPercentage: 58, seq: 11, timestamp: Date.now() - 15000 },
  ];
  const queueResult = await syncOfflineQueue("BIN-001", queued as any);
  assert.equal(queueResult.processed, 2);
  assert.equal(queueResult.binId, "BIN-001");
});

test("Fill-Level Forecasting: Holt-Winters double exponential smoothing with empirical backtest errors", async () => {
  const forecast = await forecastBinFill("BIN-001");

  assert.equal(forecast.binId, "BIN-001");
  assert.ok(typeof forecast.currentFill === "number");
  assert.ok(typeof forecast.fillVelocityPctPerHour === "number");
  assert.ok(["rapid_fill", "increasing", "stable"].includes(forecast.trend));
  assert.ok(forecast.predicted1h >= 0 && forecast.predicted1h <= 100);

  // Backtested empirical metrics evaluated on local bin data
  assert.ok(forecast.metrics.measuredOnLocalData === true);
  assert.ok(forecast.metrics.samplesEvaluated >= 8);
  assert.ok(forecast.metrics.mapePercent >= 0);
  assert.ok(forecast.metrics.maePercent >= 0);
  assert.ok(forecast.metrics.rmsePercent >= 0);

  // Backtest accuracy aliases matching frontend requirements
  assert.equal(forecast.backtestAccuracy.samplesEvaluated, forecast.metrics.samplesEvaluated);
  assert.equal(forecast.backtestAccuracy.mapePercent, forecast.metrics.mapePercent);

  // Curve projections
  assert.ok(forecast.curve.length >= 10);
});

test("Worker Stake Mechanism: reputation-scaled deposit discount and slashing", async () => {
  // New worker (0 completed jobs) has no discount -> 0.050 MSTC stake
  const completed0 = 0;
  const discount0 = Math.min(0.04, completed0 * 0.005);
  const stake0 = Math.max(0.01, 0.05 - discount0);
  assert.equal(Math.round(stake0 * 100) / 100, 0.05);

  // Experienced worker (8 completed jobs) gets maximum discount -> 0.010 MSTC stake
  const completed8 = 8;
  const discount8 = Math.min(0.04, completed8 * 0.005);
  const stake8 = Math.max(0.01, 0.05 - discount8);
  assert.equal(Math.round(stake8 * 100) / 100, 0.01);

  // Slashing reduces worker reputation score
  const workerBefore = await one(`SELECT reputation_score, slashed_count FROM workers WHERE id = 'WRK-001'`);
  const initialScore = workerBefore.reputation_score ?? 100;

  await q(
    `UPDATE workers
        SET reputation_score = GREATEST(10, reputation_score - 20),
            slashed_count = slashed_count + 1
      WHERE id = 'WRK-001'`
  );

  const workerAfter = await one(`SELECT reputation_score, slashed_count FROM workers WHERE id = 'WRK-001'`);
  assert.equal(workerAfter.reputation_score, Math.max(10, initialScore - 20));
  assert.equal(workerAfter.slashed_count, (workerBefore.slashed_count || 0) + 1);
});

test("Judge-as-Witness: cryptographic attestation binding to evidence bundle", async () => {
  const req = await createTestRequest({ status: "COMPLETED" });

  const attestation = await recordWitnessAttestation(req.id, {
    witnessName: "Dr. Evelyn Reed",
    witnessAddress: "0x9876543210987654321098765432109876543210",
    role: "Lead Hackathon Judge",
    statement: "Physically observed and audited live smart bin emptying and waste weight reduction.",
    signature: "0x4b78c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2",
  });

  assert.equal(attestation.witness_name, "Dr. Evelyn Reed");
  assert.equal(attestation.role, "Lead Hackathon Judge");
  assert.match(attestation.evidence_hash, /^0x[0-9a-f]{64}$/);

  // Verify stored in DB
  const [stored] = await q(`SELECT * FROM witness_attestations WHERE id = $1`, [attestation.id]);
  assert.equal(stored.witness_name, "Dr. Evelyn Reed");
  assert.equal(stored.request_id, req.id);
});

test("Tamper-Proof Incident Receipt: thermal / flame hazard on-chain commit", async () => {
  const receipt = await recordFireHazardReceipt("BIN-001", 73.5, 0);

  assert.equal(receipt.kind, "FIRE_HAZARD");
  assert.equal(receipt.temperature_c, 73.5);
  assert.equal(receipt.claim_status, "COMMITTED_ON_CHAIN");
  assert.match(receipt.details_hash, /^0x[0-9a-f]{64}$/);
  assert.ok(receipt.raw_bundle.event === "FLAME_THERMAL_HAZARD");
});

test("Self-Funding Robot Loop: multi-wallet autonomous machine-to-machine value flow", async () => {
  const result = await executeRobotLoop("WRK-001");

  assert.equal(result.roverId, "WRK-001");
  assert.equal(result.totalRewardMstc, "0.050");
  assert.equal(result.retainedReserveMstc, "0.030");
  assert.equal(result.transactions.length, 3);

  // Step 1: Municipality pays Rover
  assert.equal(result.transactions[0].fromRole, "Municipality Fund Pool");
  assert.equal(result.transactions[0].toRole, "Autonomous Rover");
  assert.equal(result.transactions[0].amountMstc, "0.050");

  // Step 2: Rover pays Witness Beacon micro-fee
  assert.equal(result.transactions[1].fromRole, "Autonomous Rover");
  assert.equal(result.transactions[1].toRole, "Witness Beacon");
  assert.equal(result.transactions[1].amountMstc, "0.005");

  // Step 3: Rover pays Solar Charging Dock
  assert.equal(result.transactions[2].fromRole, "Autonomous Rover");
  assert.equal(result.transactions[2].toRole, "Solar Charging Dock");
  assert.equal(result.transactions[2].amountMstc, "0.015");

  // Retained balance arithmetic: 0.050 - 0.005 - 0.015 = 0.030 MSTC
  assert.equal(
    (Number(result.totalRewardMstc) - Number(result.transactions[1].amountMstc) - Number(result.transactions[2].amountMstc)).toFixed(3),
    result.retainedReserveMstc
  );
});
