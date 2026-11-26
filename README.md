# qr-p2p

A small browser-first peer-to-peer room library and test UI. Bidirectional QR-code signaling (variant B), no backend, no WebSocket, no STUN or TURN. The host introduces new peers over existing WebRTC DataChannels; application traffic goes directly to its destination.

## Run

Requires Node.js 22+ for the tests and a modern browser with WebRTC, CompressionStream and camera support.

```sh
npm install
npm test
npm run dev
npm run build
npm run preview
```

Localhost is suitable for testing two tabs. For separate phones/tablets, serve the contents of `dist/` on any **HTTPS static host** (e.g. GitHub Pages), not plain HTTP on a LAN IP. The app has no runtime CDN dependencies. Vite's relative base supports repository subpaths.

## Two-scan pairing

1. Open the same application on the host. Choose **Create room**.
2. Scan its invitation QR using the phone's normal camera and open the URL (or scan inside the already-loaded application). Tap **Join room**.
3. The phone generates an answer QR. On the host, choose **Scan answer** and scan the phone display.
4. Once the DataChannel opens, both devices show the peer and can send chat messages.
5. The host selects **Invite another peer** for each additional device. Existing links remain connected. New peers automatically negotiate direct links to earlier peers through the host.
6. Disable internet upstream while keeping the local WLAN and loaded pages active to test offline communication.

A QR is single-use, and the answer is bound to the room, host and invitation IDs. If a dense code cannot be scanned or exceeds QR capacity, copy/paste the token instead. Do not share invitation/answer tokens publicly: they contain connection metadata.

## Library API

```js
import { createRoom, joinRoom, inviteURL } from "./src/index.js";

// Host:
const host = createRoom();
const invite = await host.createInvite();
const url = inviteURL(location.href, invite);
// Display url as QR.

// Guest, after scanning:
const { room: guest, answer } = await joinRoom(url);
// Display answer as QR, then on host:
await host.acceptAnswer(answer);

// Both devices (register listeners as early as possible):
host.addEventListener("peerjoin", ({ detail }) => {
  host.send(detail.peer, { type: "hello" });
});
guest.addEventListener("message", ({ detail }) => {
  console.log(detail.peer, detail.data);
});
```

Use a bundler or native ES module import. The library itself has no npm runtime dependency; QR drawing and camera decoding belong to the demo.

| API | Meaning |
| --- | --- |
| `createRoom()` | Create host room |
| `joinRoom(tokenOrURL)` | Return guest room and answer token |
| `room.createInvite()` | Create a single outstanding offer |
| `room.acceptAnswer(token)` | Apply matching answer; connection opens asynchronously |
| `room.cancelInvite()` | Discard pending offer |
| `room.peers` | IDs of directly connected peers |
| `room.send(peerId, jsonValue)` | Direct message, throws on failure |
| `room.broadcast(jsonValue)` | Direct send to currently connected peers; returns failures |
| `room.disconnect(peerId)` | Close a single direct link |
| `room.close()` | Close the room and all links |

Events use EventTarget and CustomEvent.detail: peerjoin / peerleave {peer}; message {peer,data}; state {peer,state}; error {message}.

The two optical messages carry gzip-compressed, versioned SDP including gathered host ICE candidates. The invite is placed in the URL fragment (not included in normal HTTP requests). After the first direct connection, the host exchanges only control messages to introduce peers. With n fully connected participants, the mesh has n(n-1)/2 links.

## Limits / threat model

- This is a trusted-room MVP, not a production-ready library or npm publication. DTLS protects data on each link, but identities are ephemeral; no independent cryptographic verification of introductions, admission policy, anti-cheat or hostile-peer protection.
- Same mutually reachable local network required. Browser host-candidate privacy policies, mDNS restrictions, AP/client isolation, or firewall rules may prevent a direct link. No relay fallback by design. The app cannot guarantee connectivity on iOS or every Wi-Fi setup.
- Internet is not used for signaling or traffic; static hosting is needed to load the page initially. No offline service worker yet. Keep tabs open; mobile backgrounding can disrupt links.
- One pair of QR scans per new device, not a reusable invitation. QR capacity is finite. No automatic reconnect, host migration, or retries for failed mesh introductions; leave and join again with a fresh invite. Existing direct guest links can remain after host departure, but no new members can join.
- The room uses reliable ordered JSON messages, with a 16 KiB wire limit and bounded send buffer. Broadcast is not atomic; it reaches only currently connected direct peers. No replicated game state or delivery acknowledgment.
- Tests use mocked RTC and exercise the codec and room protocol, not actual browser ICE connectivity.

## Manual acceptance checklist

- Two tabs: create, exchange tokens, send in both directions.
- Two physical devices: scan both QR codes; repeat on Safari/iOS, iPadOS and Chromium.
- Three devices: verify each lists two direct peers; send guest-to-guest.
- Disable WAN without disconnecting Wi-Fi; exchange messages and join using already-loaded pages.
- Cancel an invite; reject its stale answer; attempt a wrong-room answer.
- Deny camera permission; paste tokens instead.
- Close a peer and confirm the remaining peers no longer list it once closure is detected.
