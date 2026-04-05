#!/usr/bin/env bun
//
// Verifies the bot's matrix-bot-sdk device by signing it with the bot's
// own self-signing key (extracted from SSSS via recovery key).
//
// You must have set up cross-signing for the bot in Element first.
//
// Add to your .env:
//   MATRIX_RECOVERY_KEY  - the bot's recovery key from Element
//
// Existing .env vars used:
//   MATRIX_HOMESERVER_URL
//   MATRIX_ACCESS_TOKEN
//
// Usage: cd matrix && bun run verify-bot.ts

import crypto from "crypto";

// Bun auto-loads .env from cwd

const HOMESERVER = process.env.MATRIX_HOMESERVER_URL!;
const TOKEN = process.env.MATRIX_ACCESS_TOKEN!;
const RECOVERY_KEY = process.env.MATRIX_RECOVERY_KEY!;

for (const [k, v] of Object.entries({
  MATRIX_HOMESERVER_URL: HOMESERVER,
  MATRIX_ACCESS_TOKEN: TOKEN,
  MATRIX_RECOVERY_KEY: RECOVERY_KEY,
})) {
  if (!v) {
    console.error(`Missing env var: ${k}`);
    process.exit(1);
  }
}

// ── Base58 (Bitcoin alphabet) ───────────────────────────────────────────────

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function decodeBase58(s: string): Buffer {
  let num = 0n;
  for (const c of s) {
    const i = BASE58.indexOf(c);
    if (i < 0) throw new Error(`Invalid base58 char: '${c}'`);
    num = num * 58n + BigInt(i);
  }
  const hex = num.toString(16).padStart(2, "0");
  const bytes = Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
  let leading = 0;
  for (const c of s) {
    if (c === "1") leading++;
    else break;
  }
  return Buffer.concat([Buffer.alloc(leading), bytes]);
}

// ── Unpadded base64 (Matrix convention) ─────────────────────────────────────

function toUnpaddedB64(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "");
}
function fromUnpaddedB64(s: string): Buffer {
  return Buffer.from(s + "=".repeat((4 - (s.length % 4)) % 4), "base64");
}

// ── Recovery key → 32-byte SSSS key ─────────────────────────────────────────

function decodeRecoveryKey(key: string): Buffer {
  const raw = decodeBase58(key.replace(/\s+/g, ""));
  if (raw.length !== 35) {
    throw new Error(`Recovery key: expected 35 bytes, got ${raw.length}`);
  }
  if (raw[0] !== 0x8b || raw[1] !== 0x01) {
    throw new Error(
      `Recovery key: bad prefix 0x${raw[0].toString(16)} 0x${raw[1].toString(16)}`,
    );
  }
  let parity = 0;
  for (const b of raw) parity ^= b;
  if (parity !== 0) throw new Error("Recovery key: parity check failed");
  return raw.subarray(2, 34);
}

// ── SSSS ────────────────────────────────────────────────────────────────────

function ssssDerive(ssssKey: Buffer, info: string = "") {
  const derived = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      ssssKey,
      Buffer.alloc(32), // 32-byte zero salt
      info,             // secret name (empty for key verification)
      64,
    ),
  );
  return { aesKey: derived.subarray(0, 32), hmacKey: derived.subarray(32, 64) };
}

function decryptSecret(
  encrypted: { iv: string; ciphertext: string; mac: string },
  ssssKey: Buffer,
  secretName: string,
): Buffer {
  const { aesKey, hmacKey } = ssssDerive(ssssKey, secretName);
  const iv = fromUnpaddedB64(encrypted.iv);
  const ct = fromUnpaddedB64(encrypted.ciphertext);

  const mac = crypto.createHmac("sha256", hmacKey).update(ct).digest();
  if (!crypto.timingSafeEqual(mac, fromUnpaddedB64(encrypted.mac))) {
    throw new Error("SSSS HMAC mismatch — wrong recovery key?");
  }

  const decipher = crypto.createDecipheriv("aes-256-ctr", aesKey, iv);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function verifySsssKey(
  keyDesc: { iv?: string; mac?: string },
  ssssKey: Buffer,
): boolean {
  if (!keyDesc.iv || !keyDesc.mac) return true; // no check possible
  const { aesKey, hmacKey } = ssssDerive(ssssKey);
  const iv = fromUnpaddedB64(keyDesc.iv);
  const cipher = crypto.createCipheriv("aes-256-ctr", aesKey, iv);
  const ct = Buffer.concat([cipher.update(Buffer.alloc(32)), cipher.final()]);
  const mac = crypto.createHmac("sha256", hmacKey).update(ct).digest();
  return crypto.timingSafeEqual(mac, fromUnpaddedB64(keyDesc.mac));
}

// ── Ed25519 ─────────────────────────────────────────────────────────────────

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function ed25519Sign(message: Buffer, seed: Buffer): Buffer {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  return crypto.sign(null, message, key);
}

function ed25519PubKey(seed: Buffer): Buffer {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const spki = crypto.createPublicKey(key).export({
    type: "spki",
    format: "der",
  });
  return (spki as Buffer).subarray(-32);
}

// ── Canonical JSON ──────────────────────────────────────────────────────────

function canonicalJson(val: any): string {
  if (val === null || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return "[" + val.map(canonicalJson).join(",") + "]";
  return (
    "{" +
    Object.keys(val)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(val[k]))
      .join(",") +
    "}"
  );
}

// ── Matrix API ──────────────────────────────────────────────────────────────

async function api(method: string, path: string, body?: any): Promise<any> {
  const res = await fetch(`${HOMESERVER}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(
      `${method} ${path} → ${res.status}: ${JSON.stringify(json)}`,
    );
  }
  return json;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Identify bot
  const whoami = await api("GET", "/_matrix/client/v3/account/whoami");
  const userId: string = whoami.user_id;
  const sdkDeviceId: string = whoami.device_id;
  console.log(`Bot account: ${userId}`);
  console.log(`SDK device:  ${sdkDeviceId}`);

  // 2. Query all devices and cross-signing keys
  const keysResp = await api("POST", "/_matrix/client/v3/keys/query", {
    device_keys: { [userId]: [] },
  });

  const devices = keysResp.device_keys?.[userId] || {};
  const selfSigningKey = keysResp.self_signing_keys?.[userId];

  console.log(`All devices: ${Object.keys(devices).join(", ")}`);
  console.log(`Cross-signing set up: ${selfSigningKey ? "yes" : "no"}`);

  if (!selfSigningKey) {
    console.error(
      "\nThe bot account has no cross-signing keys.",
      "\nSet up cross-signing first: log into Element as the bot and go through",
      "Security & Privacy setup. Then re-run this script.",
    );
    process.exit(1);
  }

  // 3. Decode recovery key
  const ssssKey = decodeRecoveryKey(RECOVERY_KEY);
  console.log("\nRecovery key decoded OK");

  // 4. Verify recovery key against SSSS key description
  const defaultKeyData = await api(
    "GET",
    `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/m.secret_storage.default_key`,
  );
  const ssssKeyId: string = defaultKeyData.key;

  const keyDesc = await api(
    "GET",
    `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/m.secret_storage.key.${ssssKeyId}`,
  );
  if (!verifySsssKey(keyDesc, ssssKey)) {
    console.error("Recovery key does not match SSSS — wrong key?");
    process.exit(1);
  }
  console.log("Recovery key verified OK");

  // 5. Decrypt self-signing key from SSSS
  const sskData = await api(
    "GET",
    `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/m.cross_signing.self_signing`,
  );
  const sskEncrypted = sskData.encrypted?.[ssssKeyId];
  if (!sskEncrypted) {
    console.error("Self-signing key not found in SSSS");
    process.exit(1);
  }

  const sskSeed = fromUnpaddedB64(
    decryptSecret(sskEncrypted, ssssKey, "m.cross_signing.self_signing").toString("utf8"),
  );
  const sskPubKey = toUnpaddedB64(ed25519PubKey(sskSeed));

  // Verify against published self-signing key
  const publishedSskPub = Object.values(selfSigningKey.keys)[0] as string;
  if (sskPubKey !== publishedSskPub) {
    console.error(`Self-signing key mismatch:`);
    console.error(`  Published: ${publishedSskPub}`);
    console.error(`  Derived:   ${sskPubKey}`);
    process.exit(1);
  }
  console.log(`Self-signing key decrypted and verified (${sskPubKey.slice(0, 8)}...)`);

  // 6. Find which devices need signing
  const sdkDevice = devices[sdkDeviceId];
  if (!sdkDevice) {
    console.error(`SDK device ${sdkDeviceId} not found in key query results`);
    process.exit(1);
  }

  // Check if already signed
  const existingSigs = sdkDevice.signatures?.[userId] || {};
  const sskSigKey = `ed25519:${sskPubKey}`;
  if (existingSigs[sskSigKey]) {
    console.log(`\nDevice ${sdkDeviceId} is already signed by the self-signing key!`);
    console.log("If Element still shows it as unverified, try restarting Element.");
    return;
  }

  // 7. Sign the device
  console.log(`\nSigning device ${sdkDeviceId}...`);

  const toSign = { ...sdkDevice };
  delete toSign.signatures;
  delete toSign.unsigned;

  const sig = toUnpaddedB64(
    ed25519Sign(Buffer.from(canonicalJson(toSign)), sskSeed),
  );

  const signedDevice = {
    ...sdkDevice,
    signatures: {
      ...sdkDevice.signatures,
      [userId]: {
        ...(sdkDevice.signatures?.[userId] || {}),
        [sskSigKey]: sig,
      },
    },
  };

  // 8. Upload
  const result = await api(
    "POST",
    "/_matrix/client/v3/keys/signatures/upload",
    {
      [userId]: {
        [sdkDeviceId]: signedDevice,
      },
    },
  );

  const failures = result.failures;
  if (failures && Object.keys(failures).length > 0) {
    console.error("Upload had failures:", JSON.stringify(failures, null, 2));
    process.exit(1);
  }

  console.log("\nDone! Device signed successfully.");
  console.log("Element should now show the SDK session as verified (after a sync/refresh).");
}

main().catch((err) => {
  console.error("\nFatal:", err.message || err);
  process.exit(1);
});
