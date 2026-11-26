import test from "node:test";
import assert from "node:assert/strict";
import { encodeSignal, decodeSignal, inviteURL, validateSignal } from "../src/signal.js";
const id = () => crypto.randomUUID();
const offer = {v:1,kind:"offer",room:id(),pair:id(),from:id(),sdp:"v=0\r\na=candidate:1 1 udp 123 192.168.1.2 12345 typ host\r\n"};

test("compressed token round-trips and is URL safe", async () => {
  const token = await encodeSignal(offer);
  assert.match(token, /^qrp1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(await decodeSignal(token, "offer"), offer);
  const url = inviteURL("https://example.com/qr-p2p/?demo=1#old", token);
  assert.deepEqual(await decodeSignal(url), offer);
  assert.equal(new URL(url).search, "?demo=1");
});
test("rejects malformed, oversized and wrong-kind tokens", async () => {
  await assert.rejects(decodeSignal("qrp1.!!!"));
  await assert.rejects(decodeSignal("qrp1." + "a".repeat(17000)));
  await assert.rejects(decodeSignal(await encodeSignal(offer), "answer"));
  assert.throws(() => validateSignal({...offer, v:2}));
  assert.throws(() => validateSignal({...offer, kind:"answer"}));
  assert.throws(() => validateSignal({...offer, sdp:"x"}));
});
test("answer is bound to the invitation identifiers", async () => {
  const answer = {...offer,kind:"answer",from:id(),to:offer.from};
  assert.deepEqual(await decodeSignal(await encodeSignal(answer), "answer"), answer);
});
