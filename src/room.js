import { newId, validateSignal, encodeSignal, decodeSignal } from "./signal.js";

const CHANNEL = "qr-p2p-v1";
const MAX_MESSAGE = 16_384;
const MAX_BUFFER = 1_048_576;
const encoder = new TextEncoder();

export async function gatherLocal(pc, description, timeout = 12_000) {
  await pc.setLocalDescription(description);
  if (pc.iceGatheringState !== "complete") {
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", change);
        pc.removeEventListener("connectionstatechange", change);
        error ? reject(error) : resolve();
      };
      const change = () => {
        if (pc.connectionState === "closed" || pc.connectionState === "failed")
          finish(new Error("Connection closed during ICE gathering"));
        else if (pc.iceGatheringState === "complete") finish();
      };
      const timer = setTimeout(() => finish(new Error("ICE gathering timed out")), timeout);
      pc.addEventListener("icegatheringstatechange", change);
      pc.addEventListener("connectionstatechange", change);
      change();
    });
  }
  const sdp = pc.localDescription?.sdp;
  if (!sdp || !/^a=candidate:.* typ host(?: |\r?$)/m.test(sdp))
    throw new Error("No local ICE candidate. Check network and browser permissions.");
  return sdp;
}

/**
 * Small, in-memory, trusted-room mesh. The host introduces new peers.
 * All application messages are sent on direct DataChannels, never relayed.
 * Events: peerjoin, peerleave, message, error, state.
 */
export class Room extends EventTarget {
  constructor({ roomId = newId(), id = newId(), hostId = id } = {}) {
    super();
    this.roomId = roomId;
    this.id = id;
    this.hostId = hostId;
    this.links = new Map();
    this.pending = null;
    this.closed = false;
  }

  get isHost() { return this.id === this.hostId; }
  get peers() {
    return [...this.links.values()].filter(l => l.channel?.readyState === "open").map(l => l.peer);
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  fail(error) { this.emit("error", { message: error instanceof Error ? error.message : String(error) }); }
  assertOpen() { if (this.closed) throw new Error("Room is closed"); }

  makeLink(peer, pair, initiator) {
    this.assertOpen();
    // Intentionally no STUN, TURN, or signaling server.
    const pc = new RTCPeerConnection({ iceServers: [] });
    const link = { pc, peer, pair, channel: null, opened: false, accepting: false };
    if (peer) this.links.set(peer, link);
    pc.addEventListener("connectionstatechange", () => {
      this.emit("state", { peer: link.peer, state: pc.connectionState });
      if (["failed", "closed"].includes(pc.connectionState)) this.drop(link);
    });
    pc.addEventListener("datachannel", e => {
      if (initiator || link.channel || e.channel.label !== CHANNEL) e.channel.close();
      else this.attach(link, e.channel);
    });
    if (initiator) this.attach(link, pc.createDataChannel(CHANNEL, { ordered: true }));
    return link;
  }

  attach(link, channel) {
    link.channel = channel;
    channel.binaryType = "arraybuffer";
    const open = () => {
      if (link.opened || this.closed || !link.peer || this.links.get(link.peer) !== link) return;
      link.opened = true;
      if (this.isHost) {
        try {
          this.wire(link, { t: "roster", peers: [...this.links.values()].filter(l => l.opened && l !== link && l.channel?.readyState === "open").map(l => l.peer) });
        } catch (e) { this.fail(e); }
      }
      this.emit("peerjoin", { peer: link.peer });
    };
    channel.addEventListener("open", open);
    channel.addEventListener("close", () => this.drop(link));
    channel.addEventListener("error", () => this.fail(new Error("DataChannel error")));
    channel.addEventListener("message", e => {
      Promise.resolve(this.receive(link, e.data)).catch(err => this.fail(err));
    });
    if (channel.readyState === "open") open();
  }

  drop(link) {
    if (link.dropped) return;
    link.dropped = true;
    if (this.pending === link) this.pending = null;
    if (this.links.get(link.peer) === link) this.links.delete(link.peer);
    link.channel?.close();
    link.pc.close();
    if (link.opened) this.emit("peerleave", { peer: link.peer });
  }

  cancelInvite() {
    if (this.pending) this.drop(this.pending);
  }

  signal(link, kind, sdp) {
    return { v: 1, kind, room: this.roomId, pair: link.pair, from: this.id,
      ...(link.peer ? { to: link.peer } : {}), sdp };
  }

  async createInvite() {
    this.assertOpen();
    if (!this.isHost) throw new Error("Only the host can invite");
    if (this.pending) throw new Error("Finish or cancel the current invitation first");
    const link = this.makeLink(null, newId(), true);
    this.pending = link;
    try {
      const sdp = await gatherLocal(link.pc, await link.pc.createOffer());
      if (this.pending !== link) throw new Error("Invitation cancelled");
      return await encodeSignal(this.signal(link, "offer", sdp));
    } catch (e) { this.drop(link); throw e; }
  }

  async acceptAnswer(token) {
    this.assertOpen();
    const link = this.pending;
    if (!this.isHost || !link || link.accepting) throw new Error("No pending invitation");
    link.accepting = true;
    try {
      const s = await decodeSignal(token, "answer");
      if (this.pending !== link || s.room !== this.roomId || s.pair !== link.pair ||
          s.to !== this.id || s.from === this.id || this.links.has(s.from))
        throw new Error("Answer does not match the current invitation");
      link.peer = s.from;
      this.links.set(link.peer, link);
      try {
        await link.pc.setRemoteDescription({ type: "answer", sdp: s.sdp });
      } catch (e) { this.drop(link); throw e; }
      if (this.pending === link) this.pending = null;
      return link.peer;
    } finally { link.accepting = false; }
  }

  static async join(token) {
    const s = await decodeSignal(token, "offer");
    if (s.to != null) throw new Error("Not a public room invitation");
    const room = new Room({ roomId: s.room, hostId: s.from });
    const link = room.makeLink(s.from, s.pair, false);
    try {
      await link.pc.setRemoteDescription({ type: "offer", sdp: s.sdp });
      const sdp = await gatherLocal(link.pc, await link.pc.createAnswer());
      return { room, answer: await encodeSignal(room.signal(link, "answer", sdp)) };
    } catch (e) { room.close(); throw e; }
  }

  wire(link, packet) {
    if (link?.channel?.readyState !== "open") throw new Error("Peer not connected");
    const data = JSON.stringify(packet);
    if (encoder.encode(data).byteLength > MAX_MESSAGE) throw new Error("Message too large");
    if (link.channel.bufferedAmount > MAX_BUFFER) throw new Error("Peer send buffer is full");
    link.channel.send(data);
  }

  send(peer, data) {
    this.assertOpen();
    if (data === undefined) throw new Error("Expected a JSON value");
    this.wire(this.links.get(peer), { t: "app", data });
  }

  broadcast(data) {
    const failed = [];
    for (const peer of this.peers) {
      try { this.send(peer, data); }
      catch (error) { failed.push({ peer, error }); }
    }
    return failed;
  }

  relay(signal) {
    this.wire(this.links.get(this.hostId), { t: "signal", signal });
  }

  async introduce(peer) {
    if (this.closed || peer === this.id || peer === this.hostId || this.links.has(peer)) return;
    const link = this.makeLink(peer, newId(), true);
    try {
      const sdp = await gatherLocal(link.pc, await link.pc.createOffer());
      this.relay(this.signal(link, "offer", sdp));
    } catch (e) { this.drop(link); throw e; }
  }

  async receive(link, raw) {
    if (this.closed || !link.peer || this.links.get(link.peer) !== link ||
        typeof raw !== "string" || encoder.encode(raw).byteLength > MAX_MESSAGE) return;
    const packet = JSON.parse(raw);
    if (!packet || typeof packet !== "object") return;
    if (packet.t === "app" && Object.hasOwn(packet, "data")) {
      this.emit("message", { peer: link.peer, data: packet.data });
    } else if (packet.t === "roster" && !this.isHost && link.peer === this.hostId &&
               Array.isArray(packet.peers)) {
      for (const peer of new Set(packet.peers)) {
        if (typeof peer !== "string" || !/^[0-9a-f-]{36}$/i.test(peer)) continue;
        this.introduce(peer).catch(e => this.fail(e));
      }
    } else if (packet.t === "signal") {
      const s = validateSignal(packet.signal);
      if (s.room !== this.roomId || !s.to || s.from === s.to) return;
      if (this.isHost) {
        if (s.from !== link.peer || s.to === this.id) return;
        this.wire(this.links.get(s.to), { t: "signal", signal: s });
      } else if (link.peer === this.hostId && s.to === this.id && s.from !== this.hostId) {
        await this.handleMeshSignal(s);
      }
    }
  }

  async handleMeshSignal(s) {
    if (s.kind === "offer") {
      // Only a newly introduced peer initiates, so glare is not expected.
      if (this.links.has(s.from)) return;
      const link = this.makeLink(s.from, s.pair, false);
      try {
        await link.pc.setRemoteDescription({ type: "offer", sdp: s.sdp });
        const sdp = await gatherLocal(link.pc, await link.pc.createAnswer());
        this.relay(this.signal(link, "answer", sdp));
      } catch (e) { this.drop(link); throw e; }
    } else {
      const link = this.links.get(s.from);
      if (!link || link.pair !== s.pair || link.pc.signalingState !== "have-local-offer") return;
      try { await link.pc.setRemoteDescription({ type: "answer", sdp: s.sdp }); }
      catch (e) { this.drop(link); throw e; }
    }
  }

  disconnect(peer) {
    const link = this.links.get(peer);
    if (link) this.drop(link);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.cancelInvite();
    for (const link of [...this.links.values()]) this.drop(link);
  }
}

export const createRoom = () => new Room();
export const joinRoom = token => Room.join(token);
