import QRCode from "qrcode";
import jsQR from "jsqr";
import { createRoom, joinRoom, inviteURL } from "./index.js";

const $ = id => document.getElementById(id);
let room = null, busy = false, scanGeneration = 0, stream = null, frame = 0;
const note = message => { $("notice").textContent = message || ""; };
const errorText = error => error instanceof Error ? error.message : String(error);
const short = id => id.slice(0, 8);
function log(message) {
  const li = document.createElement("li");
  li.textContent = message;
  $("log").append(li);
  while ($("log").children.length > 100) $("log").firstElementChild.remove();
  $("log").scrollTop = $("log").scrollHeight;
}
function updatePeers() {
  const peers = room?.peers || [];
  const selected = $("target").value;
  $("peers").replaceChildren(...peers.map(id => {
    const li = document.createElement("li");
    li.textContent = id === room.hostId ? id + " (host)" : id;
    return li;
  }));
  $("target").replaceChildren(new Option("All connected peers", ""), ...peers.map(id => new Option(short(id), id)));
  if (peers.includes(selected)) $("target").value = selected;
  $("peer-count").textContent = String(peers.length);
  $("send").disabled = !peers.length;
  $("network-status").textContent = peers.length ? "Connected directly to " + peers.length + " peer(s)." : "No direct connections yet.";
}
function bindRoom(value) {
  room = value;
  $("start").hidden = true;
  $("session").hidden = false;
  $("host-actions").hidden = !room.isHost;
  $("role").textContent = room.isHost ? "Host room" : "Joined room";
  $("identity").textContent = "Room: " + short(room.roomId) + " / You: " + short(room.id);
  for (const type of ["peerjoin", "peerleave", "state", "message", "error"]) {
    value.addEventListener(type, e => {
      if (room !== value) return;
      const d = e.detail;
      if (type === "peerjoin") {
        if (!room.isHost && d.peer === room.hostId) $("qr-panel").hidden = true;
        log("Connected: " + short(d.peer));
      } else if (type === "peerleave") log("Disconnected: " + short(d.peer));
      else if (type === "message") log(short(d.peer) + ": " + JSON.stringify(d.data));
      else if (type === "error") note(d.message);
      else if (type === "state" && ["failed", "disconnected"].includes(d.state)) {
        note("Connection " + d.state + ". Check local Wi-Fi and keep both pages open.");
      }
      updatePeers();
    });
  }
  updatePeers();
}
async function showQR(text, title, help) {
  // Dense SDP is compressed first. Prefer L capacity; never silently truncate.
  try { await QRCode.toCanvas($("qr"), text, { errorCorrectionLevel: "L", margin: 4, width: 720 }); }
  catch { throw new Error("Invitation is too large for one QR code. Copy/paste the token instead."); }
  $("qr-title").textContent = title;
  $("qr-help").textContent = help;
  $("qr-text").value = text;
  $("qr-panel").hidden = false;
}
async function presentQR(text, title, help) {
  $("qr-title").textContent = title;
  $("qr-help").textContent = help;
  $("qr-text").value = text;
  $("qr-panel").hidden = false;
  $("qr").hidden = false;
  try { await showQR(text, title, help); }
  catch (e) {
    $("qr").hidden = true;
    $("qr-help").textContent = errorText(e);
    $("qr-panel").querySelector("details").open = true;
  }
}
function clearInvite() {
  $("answer-entry").hidden = true;
  $("qr-panel").hidden = true;
  $("answer-input").value = "";
  $("new-invite").disabled = false;
}
async function invite() {
  const token = await room.createInvite();
  $("new-invite").disabled = true;
  $("answer-entry").hidden = false;
  await presentQR(inviteURL(location.href, token), "1 / Invitation QR", "Scan this with the joining device. Each QR is for one peer.");
}
async function join(token) {
  const { room: joined, answer } = await joinRoom(token);
  bindRoom(joined);
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  await presentQR(answer, "2 / Answer QR", "Show this QR code to the host. The host must scan it inside this web app.");
}
async function accept(token) {
  await room.acceptAnswer(token);
  clearInvite();
  note("Answer accepted. Waiting for the direct connection to open.");
}
async function run(action) {
  if (busy) return;
  busy = true;
  note("");
  const controls = [...document.querySelectorAll("button")].filter(b => !b.disabled && b.id !== "stop-scan");
  controls.forEach(b => b.disabled = true);
  try { await action(); }
  catch (e) { note(errorText(e)); }
  finally {
    controls.forEach(b => b.disabled = false);
    $("new-invite").disabled = !$("answer-entry").hidden;
    updatePeers();
    busy = false;
  }
}
function stopScan() {
  scanGeneration++;
  cancelAnimationFrame(frame);
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  $("video").srcObject = null;
  $("scanner").hidden = true;
}
async function scan(onResult) {
  if (busy) return;
  stopScan();
  const generation = scanGeneration;
  $("scanner").hidden = false;
  note("");
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera requires HTTPS or localhost.");
    const acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } } });
    if (generation !== scanGeneration) { acquired.getTracks().forEach(t => t.stop()); return; }
    stream = acquired;
    const video = $("video");
    video.srcObject = stream;
    await video.play();
    if (generation !== scanGeneration) return;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let last = 0;
    function tick(now) {
      if (generation !== scanGeneration) return;
      if (video.readyState >= 2 && video.videoWidth && now - last > 120) {
        last = now;
        const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const result = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
        if (result) {
          stopScan();
          run(() => onResult(result.data));
          return;
        }
      }
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
  } catch (e) {
    if (generation !== scanGeneration) return;
    stopScan();
    note(errorText(e) + " You can paste the token instead.");
  }
}
$("host").onclick = () => run(async () => { stopScan(); bindRoom(createRoom()); await invite(); });
$("join").onclick = () => run(async () => { stopScan(); await join($("invite-input").value); });
$("new-invite").onclick = () => run(invite);
$("accept").onclick = () => run(async () => { stopScan(); await accept($("answer-input").value); });
$("cancel").onclick = () => { stopScan(); room?.cancelInvite(); clearInvite(); note(""); };
$("scan-invite").onclick = () => scan(join);
$("scan-answer").onclick = () => scan(accept);
$("stop-scan").onclick = stopScan;
$("leave").onclick = () => {
  stopScan();
  room?.close();
  room = null;
  clearInvite();
  $("start").hidden = false;
  $("session").hidden = true;
  $("log").replaceChildren();
  $("invite-input").value = "";
  note("");
};
$("copy").onclick = () => run(async () => {
  await navigator.clipboard.writeText($("qr-text").value);
  note("Copied.");
});
$("chat").onsubmit = e => {
  e.preventDefault();
  if (!room) return;
  const data = { type: "chat", text: $("message").value };
  try {
    if ($("target").value) room.send($("target").value, data);
    else {
      const failed = room.broadcast(data);
      if (failed.length) note("Failed to send to " + failed.length + " peer(s).");
    }
    log("You: " + data.text);
    $("message").value = "";
  } catch (err) { note(errorText(err)); }
};
window.addEventListener("pagehide", stopScan);
if (new URLSearchParams(location.hash.slice(1)).has("join")) {
  $("invite-input").value = location.href;
  // Explicit tap lets the guest grant local-network permissions if requested.
  note("Invitation detected. Tap Join room to generate your answer QR.");
}
