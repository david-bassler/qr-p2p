import test from "node:test";
import assert from "node:assert/strict";
import { Room, gatherLocal } from "../src/room.js";
import { decodeSignal, encodeSignal } from "../src/signal.js";

const sdp = "v=0\r\na=candidate:1 1 udp 123 192.168.1.2 12345 typ host\r\n";
class FakeChannel extends EventTarget {
  constructor(label) { super(); this.label=label; this.readyState="connecting"; this.bufferedAmount=0; this.sent=[]; }
  send(data) { this.sent.push(data); }
  open() { this.readyState="open"; this.dispatchEvent(new Event("open")); }
  close() { this.readyState="closed"; this.dispatchEvent(new Event("close")); }
}
class FakePC extends EventTarget {
  constructor(config) { super(); assert.deepEqual(config,{iceServers:[]}); this.iceGatheringState="complete"; this.connectionState="new"; this.signalingState="stable"; }
  createDataChannel(label) { return this.channel=new FakeChannel(label); }
  async createOffer() { return {type:"offer",sdp}; }
  async createAnswer() { return {type:"answer",sdp}; }
  async setLocalDescription(d) { this.localDescription=d; this.signalingState=d.type==="offer"?"have-local-offer":"stable"; }
  async setRemoteDescription(d) { this.remoteDescription=d; this.signalingState=d.type==="offer"?"have-remote-offer":"stable"; }
  close() { this.connectionState="closed"; }
}
globalThis.RTCPeerConnection=FakePC;
test("one-use QR invitation and matching answer", async () => {
  const host=new Room();
  const invitation=await host.createInvite();
  await assert.rejects(host.createInvite(), /current invitation/);
  const {room:guest,answer}=await Room.join(invitation);
  assert.equal(guest.hostId,host.id);
  const wrong={...await decodeSignal(answer),pair:crypto.randomUUID()};
  await assert.rejects(host.acceptAnswer(await encodeSignal(wrong)), /does not match/);
  assert.equal(await host.acceptAnswer(answer),guest.id);
  await assert.rejects(host.acceptAnswer(answer), /No pending/);
  const link=host.links.get(guest.id);
  link.channel.open();
  assert.deepEqual(host.peers,[guest.id]);
  let received;
  host.addEventListener("message",e=>received=e.detail);
  await host.receive(link,JSON.stringify({t:"app",data:{x:1}}));
  assert.deepEqual(received,{peer:guest.id,data:{x:1}});
  host.send(guest.id,{x:2});
  assert.deepEqual(JSON.parse(link.channel.sent.at(-1)),{t:"app",data:{x:2}});
  host.close(); guest.close();
  assert.deepEqual(host.peers,[]);
});
test("roster introduces only previously opened peers; signaling is relayed but app messages are not", async () => {
  const host=new Room();
  const a=await Room.join(await host.createInvite());
  await host.acceptAnswer(a.answer);
  const b=await Room.join(await host.createInvite());
  await host.acceptAnswer(b.answer);
  const la=host.links.get(a.room.id), lb=host.links.get(b.room.id);
  la.channel.open(); lb.channel.open();
  assert.deepEqual(JSON.parse(la.channel.sent[0]),{t:"roster",peers:[]});
  assert.deepEqual(JSON.parse(lb.channel.sent[0]),{t:"roster",peers:[a.room.id]});
  const signal={v:1,kind:"offer",room:host.roomId,pair:crypto.randomUUID(),from:b.room.id,to:a.room.id,sdp};
  await host.receive(lb,JSON.stringify({t:"signal",signal}));
  assert.deepEqual(JSON.parse(la.channel.sent.at(-1)),{t:"signal",signal});
  const count=la.channel.sent.length;
  await host.receive(lb,JSON.stringify({t:"app",data:"private"}));
  assert.equal(la.channel.sent.length,count);
  await host.receive(lb,JSON.stringify({t:"signal",signal:{...signal,from:a.room.id,to:b.room.id}}));
  assert.equal(lb.channel.sent.length,1);
  host.close(); a.room.close(); b.room.close();
});
test("ICE gathering refuses incomplete descriptions without local candidates", async () => {
  const pc=new FakePC({iceServers:[]});
  await assert.rejects(gatherLocal(pc,{type:"offer",sdp:"v=0\r\n"}),/No local ICE candidate/);
});
test("cancelled invite cannot be used", async () => {
  const host=new Room();
  const guest=await Room.join(await host.createInvite());
  host.cancelInvite();
  await assert.rejects(host.acceptAnswer(guest.answer),/No pending/);
  host.close(); guest.room.close();
});
