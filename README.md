# Offline-First Internet Layer

> **Infrastructure-level innovation** — devices communicate without the internet, then
> sync automatically the moment a connection appears.

---

## Why it exists

Internet access in many communities is:

| Problem | Real-world impact |
|---------|-------------------|
| **Unreliable** | Messages are lost, work is interrupted |
| **Expensive** | Data costs exclude low-income users |
| **Unavailable** | Remote areas, disaster zones have no coverage |

This system solves all three by treating local-network (LAN / Wi-Fi) communication
as the primary transport and cloud sync as an optional, opportunistic upgrade.

---

## Use cases

| Scenario | How OFIL helps |
|----------|----------------|
| 🏫 **Schools** | Teachers share exam papers; students submit answers — all over Wi-Fi, no SIM card needed |
| 🏪 **Rural businesses** | Inventory updates, orders, and invoices flow between devices in a shop; totals sync to the cloud at night |
| 🚨 **Disaster communication** | Emergency teams coordinate over ad-hoc Wi-Fi when cellular towers are down |

---

## Architecture

```
┌──────────────┐   UDP broadcast   ┌──────────────┐
│   Node A     │ ◄───────────────► │   Node B     │
│  (store.js)  │                   │  (store.js)  │
│  (server.js) │ ◄── HTTP POST ──► │  (server.js) │
└──────┬───────┘                   └──────┬───────┘
       │  internet available?             │
       ▼                                  ▼
  ┌────────────────────────────────────────┐
  │          Remote sync endpoint          │
  │   (any HTTP server / cloud function)   │
  └────────────────────────────────────────┘
```

| Component | File | Responsibility |
|-----------|------|----------------|
| **Store** | `src/store.js` | File-backed JSON message store; tracks sync state |
| **Discovery** | `src/discovery.js` | UDP broadcast peer discovery on the LAN |
| **Messenger** | `src/messenger.js` | HTTP delivery of messages to discovered peers |
| **SyncEngine** | `src/sync.js` | Monitors internet connectivity; pushes unsynced messages when online |
| **Server** | `src/server.js` | Express REST API + Socket.io real-time UI layer |
| **UI** | `public/index.html` | Browser dashboard (peer list, chat, manual sync) |

---

## Quick start

### 1. Install

```bash
npm install
```

### 2. Run (single node)

```bash
npm start
# Opens http://localhost:3000
```

### 3. Run multiple nodes (simulates mesh network)

Open two terminal windows on the same machine (or two machines on the same LAN):

```bash
# Terminal 1
PORT=3000 NODE_ID=School-Server npm start

# Terminal 2
PORT=3001 NODE_ID=Student-Device npm start
```

Both nodes will discover each other via UDP broadcast within ~5 seconds.
A message sent on either node is delivered instantly to the other.

### 4. Enable remote sync

Set `REMOTE_URL` to any HTTP/HTTPS endpoint that accepts `POST` with a JSON body:

```bash
REMOTE_URL=https://my-server.example.com/api/sync npm start
```

Unsynced messages are pushed automatically when internet is detected.
You can also trigger sync manually via the **⬆ Sync Now** button in the UI.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `NODE_ID` | auto UUID | Human-readable name for this node |
| `DISCOVERY_PORT` | `41234` | UDP port used for peer discovery |
| `REMOTE_URL` | *(none)* | Remote sync endpoint URL |

---

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/status` | Node ID, online status, peer list |
| `GET`  | `/api/messages` | All stored messages (newest first) |
| `POST` | `/api/messages` | Send a new message (body: `{ content, sender, type? }`) |
| `POST` | `/api/messages/receive` | Internal – receive a message from a peer |
| `GET`  | `/api/peers` | Current peer list |
| `POST` | `/api/sync` | Manually trigger remote sync |

### Socket.io events (server → browser)

| Event | Payload | Description |
|-------|---------|-------------|
| `message:new` | message object | New message created or received |
| `peer:new` | peer object | Peer discovered |
| `peer:lost` | peer object | Peer timed out |
| `status:change` | `{ online: bool }` | Connectivity changed |
| `sync:done` | results array | Sync batch finished |

---

## Message object

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "content": "Q1: What is the capital of Kenya?",
  "sender": "Teacher-Wanjiku",
  "type": "exam",
  "timestamp": "2026-04-03T08:00:00.000Z",
  "synced": false
}
```

`type` can be `general`, `exam`, `business`, `emergency`, or any custom string.

---

## Tests

```bash
npm test
```

27 tests covering the Store, SyncEngine, and HTTP API.

---

## License

MIT