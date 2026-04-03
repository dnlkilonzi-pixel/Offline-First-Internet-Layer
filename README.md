# Offline-First Internet Layer (OFIL)

> **Infrastructure-level innovation** — devices communicate without the internet, then
> sync automatically the moment a connection appears.

**Author:** [Daniel Kimeu](https://github.com/dnlkilonzi-pixel)  
**Protocol spec:** [docs/OFIL-RFC-001.md](docs/OFIL-RFC-001.md)  
**Changelog:** [CHANGELOG.md](CHANGELOG.md)  
**License:** MIT

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
| **Store** | `src/store.js` | WAL-durable file-backed store; atomic snapshot; type index |
| **WAL** | `src/wal.js` | NDJSON write-ahead log; crash-safe recovery |
| **Query Engine** | `src/query.js` | Secondary indexes; query planner; 6 filter operators |
| **Discovery** | `src/discovery.js` | UDP broadcast peer discovery on the LAN |
| **Messenger** | `src/messenger.js` | Ed25519-signed HTTP message delivery |
| **Router** | `src/router.js` | TTL-based gossip flood with deduplication |
| **Anti-entropy** | `src/antientropy.js` | Digest-based partition healing (2 HTTP round-trips) |
| **SyncEngine** | `src/sync.js` | Connectivity-aware remote sync |
| **EventBus** | `src/eventbus.js` | Typed events; LWW documents; causal graph |
| **Consistency** | `src/consistency.js` | Formal EC/AP/RYW/MR spec; session tracking |
| **FailureInjector** | `src/failureinject.js` | Crash, delay, drop, reorder fault decorators |
| **Benchmark** | `src/benchmark.js` | Write/read throughput, AE convergence time, bandwidth |
| **Server** | `src/server.js` | Express REST API + Socket.io real-time UI layer |

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

```bash
# Terminal 1
PORT=3000 NODE_ID=School-Server npm start

# Terminal 2
PORT=3001 NODE_ID=Student-Device npm start
```

Both nodes discover each other via UDP broadcast within ~5 seconds.
Messages sent on either node are delivered instantly to the other.

### 4. Enable remote sync

```bash
REMOTE_URL=https://my-server.example.com/api/sync npm start
```

Unsynced messages are pushed automatically when internet is detected.

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

### Core

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/status` | Node ID, connectivity tier, peer list |
| `GET`  | `/api/identity` | Ed25519 public key |
| `GET`  | `/api/messages` | All stored messages (Lamport-ordered) |
| `POST` | `/api/messages` | Send a signed message |
| `POST` | `/api/messages/receive` | Accept a peer message (rate-limited) |
| `GET`  | `/api/peers` | Current peer list |
| `POST` | `/api/sync` | Trigger remote sync |

### EventBus

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/events` | Publish a typed event |
| `GET`  | `/api/events/:type` | Event history (Lamport-ordered) |
| `GET`  | `/api/events/:type/causal` | Causal lineage graph |
| `GET`  | `/api/docs/:type/:docId` | Latest document state (LWW) |

### Anti-entropy

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/digest` | This node's message ID digest |
| `POST` | `/api/reconcile` | Return delta for a peer's digest |
| `POST` | `/api/push` | Accept messages from a peer |

### Storage & diagnostics

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/consistency` | Formal consistency model declaration |
| `POST` | `/api/snapshot` | Flush atomic snapshot + truncate WAL |
| `GET`  | `/api/query` | Secondary-index query engine |
| `GET`  | `/api/benchmark` | Live throughput / convergence benchmark |

### Query endpoint

`GET /api/query` accepts filter parameters in two forms:

**Shorthand** (single equality per field):
```
GET /api/query?type=chat&sender=Alice&limit=20
```

**Full JSON** (any operator, compound filters):
```
GET /api/query?q={"filter":[{"field":"lamport","op":"gt","value":10}],"orderBy":"lamport","order":"asc","limit":5}
```

Supported operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `contains`, `startsWith`.

Indexed fields (O(1) look-up): `type`, `sender`, `synced`.  Other fields fall back to a full scan.

Response:
```json
{
  "results": [...],
  "count": 3,
  "plan": { "strategy": "index", "field": "type", "estimatedCandidates": 3 }
}
```

### Benchmark endpoint

`GET /api/benchmark?writeN=100&readN=50&aeN=30`

Returns a live benchmark report:
```json
{
  "write":       { "n": 100, "durationMs": 42, "opsPerSec": 2381 },
  "read":        { "n": 50,  "durationMs": 8,  "opsPerSec": 6250 },
  "antiEntropy": { "n": 30,  "sent": 30, "durationMs": 5, "msgsPerSec": 6000 },
  "bandwidth":   { "messageCount": 130, "digestBytes": 4160, "deltaBytes": 38700, "totalBytes": 42860 },
  "timestamp":   "2026-04-03T08:00:00.000Z"
}
```

### Socket.io events (server → browser)

| Event | Payload | Description |
|-------|---------|-------------|
| `message:new` | message object | New message created or received |
| `peer:new` | peer object | Peer discovered |
| `peer:lost` | peer object | Peer timed out |
| `status:change` | `{ online: bool, tier? }` | Connectivity changed |
| `sync:done` | results array | Sync batch finished |
| `event:new` | event object | EventBus event published or ingested |

---

## Message object

```json
{
  "id":        "550e8400-e29b-41d4-a716-446655440000",
  "content":   "Q1: What is the capital of Kenya?",
  "sender":    "Teacher-Wanjiku",
  "type":      "exam",
  "timestamp": "2026-04-03T08:00:00.000Z",
  "lamport":   42,
  "synced":    false
}
```

`type` can be `general`, `exam`, `business`, `emergency`, or any custom string.

---

## Consistency model

OFIL is an **AP / Eventual Consistency** system.

| Guarantee | Scope | How |
|-----------|-------|-----|
| Eventual Consistency | Global | Anti-entropy on reconnect |
| Read Your Writes | Session | `ConsistencyMonitor.checkRead()` |
| Monotonic Reads | Session | Lamport high-watermark per session |
| Causal Ordering | Per type | Vector clock + `causalGraph()` |

`GET /api/consistency` returns the full formal spec.

See [docs/OFIL-RFC-001.md §8](docs/OFIL-RFC-001.md#8-consistency-model) for the complete model.

---

## Performance

Measured with `BenchmarkRunner` (in-process, no network overhead):

| Metric | Typical |
|--------|---------|
| Write throughput | > 1 000 ops/sec |
| Read throughput | > 5 000 ops/sec |
| Anti-entropy convergence (100 msgs) | < 50 ms |
| Digest per 1 000 messages | ≈ 38 KB |

---

## Tests

```bash
npm test
```

292 tests across 17 suites covering: Store + WAL, LamportClock, VectorClock, Identity, GCounter, ORSet, Router, AntiEntropy, Compaction, Connectivity, EventBus, SyncEngine, ConsistencyMonitor, FailureInjector, QueryEngine, BenchmarkRunner, and HTTP API.

---

## Protocol specification

[docs/OFIL-RFC-001.md](docs/OFIL-RFC-001.md) — A full RFC-style protocol document covering
message format, discovery, gossip, consistency model, anti-entropy, storage engine,
query engine, security model, performance, and deployment scenarios.

---

## Author

**Daniel Kimeu** — designer and implementer of the OFIL protocol.

> *"The internet should not be a prerequisite for communication."*

---

## License

MIT