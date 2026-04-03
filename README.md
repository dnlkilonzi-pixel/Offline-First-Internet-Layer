# 📡 Offline-First Internet Layer (OFIL)

> **The internet should not be a prerequisite for communication.**

Devices talk to each other directly over Wi-Fi.  
No router. No DNS. No data plan. No cloud required.  
When internet returns — they sync automatically.

**Author:** [Daniel Kimeu](https://github.com/dnlkilonzi-pixel) &nbsp;·&nbsp;
**License:** MIT &nbsp;·&nbsp;
**Tests:** ![292 passing](https://img.shields.io/badge/tests-292%20passing-4ade80?style=flat-square)

---

![OFIL demo UI — offline queue, live benchmarks, multi-type messages](https://github.com/user-attachments/assets/17e54aa6-672b-40a5-b2ad-325d3b2af766)

*Messages from a classroom session queued offline (dashed orange) · live benchmarks: 7.7k write/s, 50k read/s, 82% bandwidth savings · zero cloud required*

---

## ⚡ 60-second demo

```bash
git clone https://github.com/dnlkilonzi-pixel/Offline-First-Internet-Layer
cd Offline-First-Internet-Layer
npm install

# Open two terminals:
PORT=3000 NODE_ID=Alice npm start   # → http://localhost:3000
PORT=3001 NODE_ID=Bob   npm start   # → http://localhost:3001
```

1. Open both URLs in separate browser windows
2. **Disconnect your Wi-Fi** (the two Node.js processes still share loopback)
3. Send a message from Alice → it appears in Bob's window instantly
4. Reconnect Wi-Fi → click ⬆ Sync → messages push to the cloud

> **This is offline-first.** LAN is the primary transport. Cloud is optional.

---

## 📊 Benchmark results

Measured with `BenchmarkRunner` on a single machine (no network overhead).  
Full methodology: [docs/BENCHMARKS.md](docs/BENCHMARKS.md)

| Metric | Result |
|--------|--------|
| **Write throughput** | **1,706 ops/sec** — WAL append + atomic snapshot |
| **Read throughput** | **50,000 ops/sec** — in-memory Lamport sort |
| **AE convergence** | **1,500 msgs between 2 nodes in 1.2 s** — digest + delta |
| **Bandwidth savings** | **79% less traffic** than naive full resync (warm cluster) |

Run live benchmarks on any running node:

```
GET http://localhost:3000/api/benchmark?writeN=100&readN=50&aeN=50
```

---

## Why it exists

| Problem | Real-world impact |
|---------|-------------------|
| **Unreliable internet** | Messages lost, work interrupted mid-task |
| **Expensive data** | Per-MB costs exclude low-income users entirely |
| **No coverage** | Remote schools, clinics, disaster zones cut off |

Most apps are designed cloud-first and bolt on offline as an afterthought.  
OFIL inverts this: **LAN is primary; cloud is an opportunistic upgrade.**

### Use cases

| Scenario | How OFIL helps |
|----------|----------------|
| 🏫 **Schools** | Teachers share exam papers over classroom Wi-Fi — no SIM card needed |
| 🏪 **Rural businesses** | Orders and invoices flow between devices; sync to the cloud overnight |
| 🚨 **Disaster response** | Field teams coordinate over ad-hoc Wi-Fi when towers are down |

---

## Architecture

```
Node A (your laptop)              Node B (teacher's phone)
        │                                  │
        │◄────── UDP broadcast ───────────►│  peer discovery
        │                                  │
        │──── HTTP POST /receive ─────────►│  message delivery
        │                                  │
        │──── GET  /api/reconcile ────────►│  anti-entropy round 1
        │◄─── { missing, peerIds } ────────│
        │──── POST /api/push ─────────────►│  anti-entropy round 2
        │                                  │
        ▼   internet available?            ▼
   ┌──────────────────────────────────────────┐
   │          Remote sync endpoint            │
   │   (any HTTP server / cloud function)     │
   └──────────────────────────────────────────┘
```

### Module map

| Module | File | Responsibility |
|--------|------|----------------|
| **Store** | `src/store.js` | WAL-durable file-backed store; atomic snapshot; type index |
| **WAL** | `src/wal.js` | NDJSON write-ahead log; crash-safe replay on restart |
| **Query Engine** | `src/query.js` | Secondary indexes on `type`, `sender`, `synced`; 6 filter operators |
| **Discovery** | `src/discovery.js` | Zero-config UDP broadcast peer discovery on the LAN |
| **Messenger** | `src/messenger.js` | Ed25519-signed HTTP message delivery |
| **Router** | `src/router.js` | TTL-based gossip flood with deduplication |
| **Anti-entropy** | `src/antientropy.js` | Digest-based partition healing in 2 HTTP round-trips |
| **SyncEngine** | `src/sync.js` | Connectivity-aware opportunistic cloud sync |
| **EventBus** | `src/eventbus.js` | Typed events; Last-Write-Wins documents; causal graph |
| **Consistency** | `src/consistency.js` | Formal EC/AP/RYW/MR enforcement; session tracking |
| **Clocks** | `src/clock.js`, `src/vclock.js` | Lamport clock; vector clock |
| **CRDTs** | `src/crdt.js` | GCounter (grow-only); ORSet (add-wins) |
| **Identity** | `src/identity.js` | Ed25519 key generation; message signing/verification |
| **Compaction** | `src/compaction.js` | Tombstone GC; store pruning |
| **FailureInjector** | `src/failureinject.js` | Crash, delay, drop, reorder fault decorators for testing |
| **Benchmark** | `src/benchmark.js` | Write/read throughput; AE convergence; bandwidth efficiency |
| **Server** | `src/server.js` | Express REST API + Socket.io real-time push |

---

## Quick start

### Single node

```bash
npm install
npm start
# → http://localhost:3000
```

### Two-node offline demo (the "wow" flow)

```bash
# Terminal 1
PORT=3000 NODE_ID=Alice npm start

# Terminal 2
PORT=3001 NODE_ID=Bob npm start
```

Nodes discover each other via UDP within ~5 seconds.  
Open both in separate browsers. Disconnect Wi-Fi. Send messages. Reconnect. Watch them sync.

### With remote cloud sync

```bash
REMOTE_URL=https://your-server.example.com/api/sync npm start
```

Unsynced messages push automatically the moment internet is detected.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `NODE_ID` | auto UUID | Human-readable node name |
| `DISCOVERY_PORT` | `41234` | UDP port for peer discovery |
| `REMOTE_URL` | *(none)* | Remote sync endpoint |

---

## REST API

### Core

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/status` | Node ID, connectivity tier, peer list |
| `GET`  | `/api/identity` | Ed25519 public key |
| `GET`  | `/api/messages` | All messages (Lamport-ordered) |
| `POST` | `/api/messages` | Create a signed message |
| `POST` | `/api/messages/receive` | Receive a peer message (rate-limited) |
| `GET`  | `/api/peers` | Current peer list |
| `POST` | `/api/sync` | Trigger remote cloud sync |

### Anti-entropy

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/digest` | This node's message ID digest |
| `POST` | `/api/reconcile` | Return the delta for a peer's digest |
| `POST` | `/api/push` | Accept messages pushed by a peer |

### EventBus

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/events` | Publish a typed event |
| `GET`  | `/api/events/:type` | Event history (Lamport-ordered) |
| `GET`  | `/api/events/:type/causal` | Causal lineage graph |
| `GET`  | `/api/docs/:type/:docId` | Latest document state (LWW merge) |

### Storage & diagnostics

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/consistency` | Formal consistency model declaration |
| `POST` | `/api/snapshot` | Flush atomic snapshot + truncate WAL |
| `GET`  | `/api/query` | Secondary-index query engine |
| `GET`  | `/api/benchmark` | Live throughput / convergence benchmark |

### Query examples

**Shorthand** (equality on indexed fields — O(k) index scan):
```
GET /api/query?type=exam&sender=Teacher-Wanjiku&limit=20
```

**Full DSL** (any operator, compound filters, sort, paginate):
```
GET /api/query?q={"filter":[{"field":"lamport","op":"gt","value":100}],"orderBy":"lamport","order":"desc","limit":10}
```

Operators: `eq` `ne` `gt` `gte` `lt` `lte` `contains` `startsWith`  
Indexed fields (fast path): `type` · `sender` · `synced`

```json
{
  "results": [...],
  "count": 5,
  "plan": { "strategy": "index", "field": "type", "estimatedCandidates": 5 }
}
```

### Socket.io events (server → browser)

| Event | Payload | Fired when |
|-------|---------|------------|
| `message:new` | message object | Message created or received from peer |
| `peer:new` | peer object | New peer discovered on LAN |
| `peer:lost` | peer object | Peer timed out |
| `status:change` | `{ online, tier }` | Connectivity tier changed |
| `sync:done` | results array | Cloud sync batch finished |
| `event:new` | event object | EventBus event published |

---

## Message schema

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

`type` can be `general` · `exam` · `business` · `emergency` · or any custom string.

---

## Consistency model

OFIL is an **AP system** (available + partition-tolerant, per CAP theorem).

| Guarantee | Scope | Mechanism |
|-----------|-------|-----------|
| **Eventual Consistency** | Global | Anti-entropy reconciliation + CRDT merge |
| **Read Your Writes** | Session | Lamport high-watermark per session |
| **Monotonic Reads** | Session | `ConsistencyMonitor.checkRead()` |
| **Causal Ordering** | Per event type | Vector clock + `causalGraph()` API |

Full formal spec: [`GET /api/consistency`](http://localhost:3000/api/consistency)  
RFC section: [docs/OFIL-RFC-001.md §8](docs/OFIL-RFC-001.md#8-consistency-model)

---

## Tests

```bash
npm test
# 292 tests · 17 suites · all passing
```

Suites: Store · WAL · LamportClock · VectorClock · Identity · GCounter · ORSet · Router · AntiEntropy · Compaction · Connectivity · EventBus · SyncEngine · ConsistencyMonitor · FailureInjector · QueryEngine · BenchmarkRunner · HTTP API

---

## Docs

| Document | Description |
|----------|-------------|
| [docs/OFIL-RFC-001.md](docs/OFIL-RFC-001.md) | Full RFC-style protocol specification (message format, discovery, gossip, consistency, security, deployment) |
| [docs/BENCHMARKS.md](docs/BENCHMARKS.md) | Benchmark methodology and full results |
| [docs/DEVTO-ARTICLE.md](docs/DEVTO-ARTICLE.md) | Dev.to article — architecture deep-dive |
| [docs/LINKEDIN-POST.md](docs/LINKEDIN-POST.md) | LinkedIn post variants |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

---

## Author

**Daniel Kimeu** — protocol designer and implementer.

---

## License

MIT