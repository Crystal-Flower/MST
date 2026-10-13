import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { ethers } from "ethers";

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SERVER_DIR = path.join(ROOT_DIR, "server");
export const DATA_DIR = path.join(SERVER_DIR, "data");

// ASTRA_ENV lets you keep e.g. .env.local and .env (testnet) side by side.
dotenv.config({ path: process.env.ASTRA_ENV || path.join(ROOT_DIR, ".env") });

const str = (k: string, d = "") => process.env[k]?.trim() || d;
const num = (k: string, d: number) => (process.env[k]?.trim() ? Number(process.env[k]) : d);
const bool = (k: string, d: boolean) => {
  const v = process.env[k]?.trim().toLowerCase();
  return v ? ["1", "true", "yes", "on"].includes(v) : d;
};

type NetworkName = "localhost" | "testnet" | "mainnet";
const NETWORKS: Record<NetworkName, { rpcUrl: string; chainId: number; explorerUrl: string; label: string }> = {
  localhost: { rpcUrl: "http://127.0.0.1:8545", chainId: 31337, explorerUrl: "", label: "Local development chain" },
  testnet: {
    rpcUrl: "https://testnetrpc.mstblockchain.com",
    chainId: 91562037,
    explorerUrl: "https://testnet.mstscan.com",
    label: "MST Testnet",
  },
  mainnet: { rpcUrl: "https://mariorpc.mstblockchain.com", chainId: 4646, explorerUrl: "https://mstscan.com", label: "MST Mainnet" },
};

const requested = str("NETWORK", "localhost");
const network: NetworkName = requested in NETWORKS ? (requested as NetworkName) : "localhost";
const net = NETWORKS[network];
const isLocal = network === "localhost";

// Hardhat's public development keys and mnemonic. Only ever used on a local node.
const HARDHAT = {
  mnemonic: "test test test test test test test test test test test junk",
  keys: [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  ],
};

// One funded key is enough for a demo: it plays every role, and the device and
// worker identities are derived from it deterministically.
const MST_KEY = str("MST_PRIVATE_KEY");
const derived = (label: string) => (MST_KEY ? ethers.keccak256(ethers.toUtf8Bytes(`astra:${label}:${MST_KEY}`)) : "");
const derivedMnemonic = (label: string) => (MST_KEY ? ethers.Mnemonic.fromEntropy(ethers.dataSlice(derived(label), 0, 16)).phrase : "");

function key(name: string, localIndex: number): string {
  const v = str(name);
  if (v) return v;
  if (MST_KEY && !isLocal) return MST_KEY;
  return isLocal ? HARDHAT.keys[localIndex] : "";
}

function pairs(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of str(name).split(",")) {
    const [k, v] = part.split(":").map((s) => s?.trim());
    if (k && v) out[k.toUpperCase()] = v;
  }
  return out;
}

export const config = {
  productName: str("PRODUCT_NAME", "Astra Waste"),
  network,
  networkLabel: net.label,
  isLocal,
  rpcUrl: isLocal ? net.rpcUrl : str("MST_RPC_URL", net.rpcUrl),
  chainId: isLocal ? net.chainId : num("MST_CHAIN_ID", net.chainId),
  explorerUrl: isLocal ? "" : str("MST_EXPLORER_URL", net.explorerUrl),
  contractAddress: str("LEDGER_ADDRESS"),

  keys: {
    admin: key("ADMIN_PRIVATE_KEY", 0),
    gateway: key("GATEWAY_PRIVATE_KEY", 1),
    officer: key("OFFICER_PRIVATE_KEY", 2),
    verifier: key("VERIFIER_PRIVATE_KEY", 3),
    deviceMnemonic: str("DEVICE_MNEMONIC", isLocal ? HARDHAT.mnemonic : derivedMnemonic("devices")),
    workerMnemonic: str("WORKER_MNEMONIC", isLocal ? HARDHAT.mnemonic : derivedMnemonic("workers")),
    deviceMasterSecret: str("DEVICE_MASTER_SECRET", isLocal ? "local-dev-device-secret" : derived("device-secret")),
  },

  overrides: {
    workerWallets: pairs("WORKER_WALLET_OVERRIDES"),
    workerRfids: pairs("WORKER_RFID_OVERRIDES"),
    heroBin: str("HERO_BIN_LAT") && str("HERO_BIN_LNG") ? { lat: num("HERO_BIN_LAT", 0), lng: num("HERO_BIN_LNG", 0) } : null,
  },

  db: {
    get url() {
      return str("DATABASE_URL");
    },
    get dir() {
      return str("PGLITE_DIR", path.join(DATA_DIR, "pg"));
    },
  },

  ai: {
    provider: (str("AI_PROVIDER", "builtin") as "builtin" | "qwen" | "http"),
    qwenBaseUrl: str("QWEN_BASE_URL", "http://127.0.0.1:11434/v1"),
    qwenModel: str("QWEN_MODEL", "qwen2.5:7b-instruct"),
    qwenApiKey: str("QWEN_API_KEY"),
    httpUrl: str("AI_SERVICE_URL"),
    timeoutMs: num("AI_TIMEOUT_MS", 15000),
    minConfidence: num("AI_MIN_CONFIDENCE", 80),
  },

  sim: {
    mode: (str("MODE", "simulation") === "live" ? "live" : "simulation") as "live" | "simulation",
    tickMs: num("SIM_TICK_MS", 1000),
    organic: bool("SIM_ORGANIC_DETECTIONS", false),
    pace: num("SIM_PACE", 1),
  },

  verify: {
    // When true, a completion from a bin without a load cell reading is never verified.
    requireWeight: bool("REQUIRE_WEIGHT", false),
    // Minimum weight (grams) a genuine collection must remove when a load cell is present.
    minWeightRemovedG: num("MIN_WEIGHT_REMOVED_G", 300),
  },

  payment: {
    defaultMstc: str("DEFAULT_PAYOUT_MSTC", "0.05"),
    inrPerMstc: num("INR_PER_MSTC", 1000),
  },

  auth: {
    secret: str("SESSION_SECRET") || crypto.createHash("sha256").update(`astra:${str("ADMIN_PRIVATE_KEY", "local")}`).digest("hex"),
    officerPassword: str("OFFICER_PASSWORD", "demo1234"),
    workerPin: str("WORKER_PIN", "1234"),
    allowRoleGrants: bool("ALLOW_ROLE_GRANTS", true),
  },

  port: num("PORT", 8080),
};

export type Config = typeof config;

export function explorerTx(hash: string): string | null {
  return config.explorerUrl ? `${config.explorerUrl.replace(/\/$/, "")}/tx/${hash}` : null;
}
export function explorerAddress(address: string): string | null {
  return config.explorerUrl ? `${config.explorerUrl.replace(/\/$/, "")}/address/${address}` : null;
}

// ---------------------------------------------------------------------------
// City seed + derived identities
// ---------------------------------------------------------------------------

export type SeedBin = {
  id: string;
  name: string;
  address: string;
  zone: string;
  lat: number;
  lng: number;
  capacityLitres: number;
  depthCm: number;
  hardware?: boolean;
  startFill: number;
  offline?: boolean;
};
export type SeedWorker = { id: string; name: string; phone: string; zone: string; rfidUid: string; lat: number; lng: number };
export type City = {
  municipality: { id: string; name: string; city: string; ward: string; center: { lat: number; lng: number } };
  bins: SeedBin[];
  workers: SeedWorker[];
  users: { id: string; name: string; email: string; role: "officer" | "admin" }[];
};

export function loadCity(): City {
  const city: City = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "config", "city.json"), "utf8"));
  const hero = config.overrides.heroBin;
  if (hero) {
    const bin = city.bins.find((b) => b.hardware) ?? city.bins[0];
    bin.lat = hero.lat;
    bin.lng = hero.lng;
  }
  for (const w of city.workers) {
    const rfid = config.overrides.workerRfids[w.id];
    if (rfid) w.rfidUid = rfid;
  }
  return city;
}

const indexOf = (id: string) => Number(id.replace(/\D/g, "")) || 0;

/** Each bin's secp256k1 identity (what the contract checks bin signatures against). */
export function deviceWallet(binId: string): ethers.HDNodeWallet {
  if (!config.keys.deviceMnemonic) throw new Error("DEVICE_MNEMONIC is not set (npm run keys)");
  return ethers.HDNodeWallet.fromPhrase(config.keys.deviceMnemonic, undefined, `m/44'/60'/1'/0/${indexOf(binId)}`);
}

/** Shared secret an ESP32 uses to authenticate its HTTP packets (HMAC-SHA256). */
export function deviceSecret(binId: string): string {
  if (!config.keys.deviceMasterSecret) throw new Error("DEVICE_MASTER_SECRET is not set (npm run keys)");
  return crypto.createHmac("sha256", config.keys.deviceMasterSecret).update(binId).digest("hex");
}

/** Worker payout wallet: an override (e.g. a BridgeKey address) or derived from WORKER_MNEMONIC. */
export function workerWallet(workerId: string): string {
  const override = config.overrides.workerWallets[workerId.toUpperCase()];
  if (override) return ethers.getAddress(override);
  if (!config.keys.workerMnemonic) throw new Error("WORKER_MNEMONIC is not set (npm run keys)");
  return ethers.HDNodeWallet.fromPhrase(config.keys.workerMnemonic, undefined, `m/44'/60'/2'/0/${indexOf(workerId)}`).address;
}

/**
 * On-chain identifier of a worker's RFID card. Card UIDs are only 4 bytes, so a
 * plain keccak(uid) published in a contract event can be brute-forced in
 * seconds. The hash is therefore keyed with a server-held secret: the chain
 * still binds a card to a worker, but nobody can recover the UID from it.
 * (This hides the UID from chain observers; it does not stop someone who
 * physically reads a card from cloning it. That needs the worker's wallet
 * signature as a second factor, see docs/THREAT_MODEL.md.)
 */
export function rfidHash(uid: string): string {
  const clean = uid.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (!config.keys.deviceMasterSecret) throw new Error("DEVICE_MASTER_SECRET is not set (npm run keys)");
  const salt = crypto.createHmac("sha256", config.keys.deviceMasterSecret).update("astra:rfid-salt:v1").digest();
  return ethers.keccak256(ethers.concat([salt, ethers.toUtf8Bytes(clean)]));
}

export function normalizeUid(uid: string): string {
  return uid.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}
