// Versioned, compressed, URL-safe signaling. No external I/O.
const PREFIX = "qrp1.";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SDP = 32_768;
const MAX_TOKEN = 16_384;
export const newId = () => crypto.randomUUID();

export function validateSignal(s, expected) {
  if (!s || s.v !== 1 || !["offer", "answer"].includes(s.kind) ||
      (expected && s.kind !== expected) ||
      ![s.room, s.pair, s.from].every(x => typeof x === "string" && ID.test(x)) ||
      (s.kind === "answer" && (typeof s.to !== "string" || !ID.test(s.to))) ||
      (s.kind === "offer" && s.to != null && (typeof s.to !== "string" || !ID.test(s.to))) ||
      typeof s.sdp !== "string" || !s.sdp.startsWith("v=0") || s.sdp.length > MAX_SDP) {
    throw new Error("Invalid or incompatible signaling message");
  }
  return s;
}

export async function encodeSignal(signal) {
  validateSignal(signal);
  const bytes = new TextEncoder().encode(JSON.stringify(signal));
  const compressed = new Uint8Array(await new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))
  ).arrayBuffer());
  return PREFIX + btoa(String.fromCharCode(...compressed))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function decodeSignal(input, expected) {
  let token = input.trim();
  if (!token.startsWith(PREFIX)) {
    const url = new URL(token);
    token = new URLSearchParams(url.hash.slice(1)).get("join") || "";
  }
  if (!token.startsWith(PREFIX) || token.length > MAX_TOKEN ||
      !/^[A-Za-z0-9_-]+$/.test(token.slice(PREFIX.length))) {
    throw new Error("Invalid QR token");
  }
  const bytes = Uint8Array.from(atob(token.slice(PREFIX.length)
    .replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  const reader = new Blob([bytes]).stream()
    .pipeThrough(new DecompressionStream("gzip")).getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let json = "", size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) throw new Error("Signaling payload too large");
      json += decoder.decode(value, { stream: true });
    }
    json += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return validateSignal(JSON.parse(json), expected);
}

export function inviteURL(base, token) {
  const url = new URL(base);
  url.hash = new URLSearchParams({ join: token }).toString();
  return url.href;
}
