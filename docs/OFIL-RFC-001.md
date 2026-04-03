# OFIL-RFC-001: Offline-First Internet Layer Protocol v1

**Status:** Implemented  
**Author:** Daniel Kimeu  
**Repository:** https://github.com/dnlkilonzi-pixel/Offline-First-Internet-Layer  
**Date:** 2026-04-03  
**License:** MIT

---

## Abstract

This document specifies the Offline-First Internet Layer (OFIL) protocol: a
peer-to-peer communication system designed for environments where internet
access is unreliable, expensive, or unavailable.  OFIL nodes communicate
directly over a local-area network (LAN) using UDP-based peer discovery and
HTTP-based message delivery.  When internet access becomes available, nodes
opportunistically synchronise their state to a remote endpoint.

The protocol guarantees **eventual consistency** across all replicas while
providing **Read-Your-Writes** and **Monotonic Reads** session guarantees
within a named client session.  Conflict resolution follows deterministic
**Last-Write-Wins** (LWW) semantics via Lamport clock ordering, with
**Add-Wins ORSet** semantics for set-valued data structures.

---

## Table of Contents

1. [Motivation](#1-motivation)
2. [Terminology](#2-terminology)
3. [Protocol Overview](#3-protocol-overview)
4. [Message Format](#4-message-format)
5. [Identity and Authentication](#5-identity-and-authentication)
6. [Peer Discovery Protocol](#6-peer-discovery-protocol)
7. [Gossip / Message Routing](#7-gossip--message-routing)
8. [Consistency Model](#8-consistency-model)
9. [Anti-Entropy Reconciliation Protocol](#9-anti-entropy-reconciliation-protocol)
10. [Storage Engine](#10-storage-engine)
11. [Query Engine](#11-query-engine)
12. [Compaction](#12-compaction)
13. [Security Model](#13-security-model)
14. [Performance Characteristics](#14-performance-characteristics)
15. [Deployment Scenarios](#15-deployment-scenarios)
16. [Implementation Status](#16-implementation-status)

---

## 1. Motivation

Internet infrastructure is not uniformly available.  In schools, rural
businesses, and disaster-response environments, devices must communicate
reliably without a central server or internet connection.  Existing solutions
either require constant connectivity (cloud-first apps) or complex
infrastructure (VPN, dedicated servers).

OFIL provides a zero-infrastructure-required communication layer that:

- Works out-of-the-box on any LAN or Wi-Fi hotspot
- Requires no configuration, no DNS, no central server
- Synchronises to the cloud automatically when internet returns
- Converges to the same state on all nodes regardless of the order in which
  messages arrive or nodes reconnect

---

## 2. Terminology

| Term | Definition |
|------|-----------|
| **Node** | A single OFIL process.  Identified by a UUID (`nodeId`). |
| **Peer** | Any other node discovered on the local network. |
| **Message** | The atomic unit of data.  Has a unique `id`, `content`, `sender`, `type`, `lamport` timestamp, and `synced` flag. |
| **Lamport Clock** | A logical clock that assigns a monotonically-increasing integer to each event, enabling consistent causal ordering. |
| **Vector Clock** | Per-node counter map.  Tracks causal ancestry across multiple writers. |
| **Anti-entropy** | The protocol by which two nodes exchange digests and push the delta to each other, healing divergence after a network partition. |
| **Session** | A named client identity (e.g. a browser tab).  Session guarantees (RYW, MR) are scoped to a session. |
| **Digest** | The set of all message IDs a node currently holds.  Transmitted as a JSON array of UUIDs. |
| **WAL** | Write-Ahead Log.  An NDJSON file of ordered mutation records.  Guarantees no write is lost on crash. |
| **Snapshot** | An atomic, consistent full dump of the in-memory message array to disk (`tmp → rename`). |

---

## 3. Protocol Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                         OFIL Node                                    │
│                                                                      │
│  ┌─────────────┐  UDP beacon   ┌─────────────┐                       │
│  │  Discovery  │ ◄───────────► │  Discovery  │  (peer nodes)         │
│  └──────┬──────┘               └─────────────┘                       │
│         │ peer list                                                   │
│         ▼                                                             │
│  ┌─────────────┐  HTTP POST    ┌─────────────┐                       │
│  │  Messenger  │ ──────────── ►│  /receive   │  (peer HTTP server)   │
│  └─────────────┘               └─────────────┘                       │
│         │                            │                               │
│         ▼                            ▼                               │
│  ┌─────────────┐              ┌─────────────┐                        │
│  │    Store    │              │  Anti-Entropy│  reconcile / push     │
│  │  (WAL +     │ ◄──────────► │  (digest)   │ ◄──────────────────── │
│  │  snapshot)  │              └─────────────┘                        │
│  └──────┬──────┘                                                      │
│         │ internet available?                                         │
│         ▼                                                             │
│  ┌─────────────┐  HTTP POST                                           │
│  │ SyncEngine  │ ──────────── ► Remote endpoint (cloud / HTTPS)      │
│  └─────────────┘                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 4. Message Format

Every message is a JSON object with the following fields:

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

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID v4 | Globally unique message identifier.  Used for deduplication. |
| `content` | string | Arbitrary UTF-8 payload (plain text or JSON-serialised object). |
| `sender` | string | Human-readable or UUID node identifier. |
| `type` | string | Application-defined category (`general`, `exam`, `business`, `emergency`, …). |
| `timestamp` | ISO 8601 | Wall-clock time at the originating node.  Advisory only; do not use for ordering. |
| `lamport` | integer ≥ 1 | Lamport logical timestamp.  Use this for causal ordering. |
| `synced` | boolean | `true` after the message has been acknowledged by the remote endpoint. |

### EventBus events (extended message)

When messages are published via the EventBus, the `content` field holds the
JSON-serialised event envelope:

```json
{
  "id":        "<type>:<docId> or UUID",
  "type":      "inventory:update",
  "payload":   { "item": "pencils", "count": 50 },
  "docId":     "item-1",
  "version":   42,
  "lamport":   42,
  "vclock":    { "NodeA": 3, "NodeB": 1 },
  "timestamp": "2026-04-03T08:00:00.000Z",
  "sender":    "NodeA",
  "synced":    false
}
```

---

## 5. Identity and Authentication

Each node generates a persistent **Ed25519** key pair on first start (`src/identity.js`).
The private key is stored on disk; the public key is advertised via `GET /api/identity`.

Messages are signed before delivery to peers:

```
signature = Ed25519Sign(privateKey, SHA-256(content + sender + timestamp))
```

Receiving nodes verify the signature before accepting a message
(`POST /api/messages/receive`).  Messages with invalid signatures are rejected
with HTTP 401.

---

## 6. Peer Discovery Protocol

Discovery uses **UDP broadcast** on a configurable port (default 41234).

### Beacon format

Every node broadcasts a JSON beacon every 5 seconds:

```json
{ "nodeId": "Node-A", "apiPort": 3000, "timestamp": "…" }
```

Nodes listen on the same UDP port and add new peers to their peer table
upon receiving a beacon from an unknown `nodeId`.

### Peer table

```
Peer: { nodeId, ip, apiPort, lastSeen }
```

Peers that have not sent a beacon for 15 seconds are marked as lost and
removed from the peer table.

### Connectivity tiers

| Tier | Condition |
|------|-----------|
| `none` | No peers discovered |
| `lan` | ≥ 1 peer on the same LAN (UDP-reachable) |
| `hotspot` | ≥ 1 peer via mobile hotspot |
| `wan` | Remote endpoint reachable |

The tier is advertised via `GET /api/status` and drives behaviour:
- Partition heal: anti-entropy fires when tier changes from `none` to any.

---

## 7. Gossip / Message Routing

Messages are forwarded using an **eager-push gossip protocol** with
**TTL-based flood control** (`src/router.js`).

### Routing algorithm

1. Node A sends message M to each known peer via `POST /api/messages/receive`.
2. Each recipient node checks its router: if M has already been seen, it is
   dropped.  Otherwise it is stored and forwarded to the recipient's peers
   (with TTL decremented by 1).
3. When TTL reaches 0 the message is not forwarded further.

Default TTL: 7 (sufficient for networks with diameter ≤ 7 hops).

### Deduplication

The router maintains a `Set<id>` of seen message IDs.  The set is pruned
periodically to prevent unbounded memory growth.

---

## 8. Consistency Model

OFIL is an **AP system** (Available + Partition-tolerant) in the CAP sense.
During a network partition, nodes remain available and accept writes; they
diverge, then converge automatically when the partition heals.

### Guarantees

| Property | Scope | Mechanism |
|----------|-------|-----------|
| **Eventual Consistency** | Global | Anti-entropy; CRDT merge |
| **Read Your Writes (RYW)** | Session | `ConsistencyMonitor.checkRead()` |
| **Monotonic Reads (MR)** | Session | Lamport high-watermark per session |
| **Causal Ordering** | Per type | Vector clock events; `causalGraph()` |
| **Convergent Conflict Resolution** | Documents | LWW via Lamport + sender tie-break |
| **Convergent Conflict Resolution** | Sets | Add-Wins ORSet |
| **Convergent Conflict Resolution** | Counters | GCounter (max per partition) |

### Boundary of eventual consistency

Two nodes A and B that have **both received** the same set of writes will
hold **identical state** (same messages, same CRDT values, same document
versions) after anti-entropy completes.  The convergence time is bounded by
the anti-entropy interval and is typically < 100 ms in-process and < 1 s on
a LAN.

### Session guarantees

Within a named session (e.g. browser tab identified by a UUID):

- **RYW**: A read will always include all writes the session has submitted.
  `ConsistencyMonitor.checkRead(sessionId, events)` returns
  `{ readYourWrites: false }` if a pending write is not yet visible.

- **MR**: Once a session has observed events up to Lamport time T, no
  subsequent read will return a set whose maximum Lamport value is < T.
  `checkRead` returns `{ monotonic: false }` on a regression.

---

## 9. Anti-Entropy Reconciliation Protocol

Anti-entropy runs in two HTTP round-trips:

```
A                                    B
│                                    │
│── POST /api/reconcile ────────────►│
│   { ids: A's message IDs }         │
│                                    │
│◄── { missing: [...],  ────────────│
│      peerIds: B's IDs }            │
│                                    │
│  A ingests missing messages        │
│  A computes diff(A IDs, B IDs)     │
│                                    │
│── POST /api/push ─────────────────►│
│   { messages: [A's delta] }        │
│                                    │
│◄── { accepted, skipped } ─────────│
```

### Complexity

| Operation | Time | Space |
|-----------|------|-------|
| Digest computation | O(n) | O(n) |
| Reconcile (find missing) | O(n) | O(n) |
| Push | O(k) where k = |delta| | O(k) |

For a fully-synced cluster (k ≈ 0), the cost reduces to:
- 2 × digestBytes ≈ 2 × n × 38 bytes (UUID length)

Bandwidth is therefore sublinear in the message count for well-connected
peers.

---

## 10. Storage Engine

### Architecture

```
Write path:
  save(msg) → WAL.append({op:'save', message}) → _messages.push → _persist(tmp→rename)

Delete path:
  deleteMessages(ids) → WAL.append({op:'delete', ids}) → filter → _persist

Recovery (on startup):
  load snapshot → replay WAL delta → seed Lamport clock → rebuild type index

Snapshot on demand:
  snapshot() → _persist(tmp→rename) → WAL.truncate()
```

### WAL format (NDJSON)

Each line is a JSON object:

```json
{"op":"save","message":{...}}
{"op":"delete","ids":["id1","id2"]}
```

Corrupt lines are silently skipped during replay (best-effort recovery).

### Snapshot atomicity

The snapshot is written to `<path>.tmp`, then renamed to `<path>`.
On POSIX filesystems `rename(2)` is atomic.  No reader ever sees a
partial snapshot.

### Indexes

| Index | Structure | Maintained by |
|-------|-----------|--------------|
| Type (primary) | `Map<type, Set<id>>` | `Store._index` |
| Sender | `Map<sender, Set<id>>` | `QueryEngine._senderIndex` |
| Synced | `Map<'true'/'false', Set<id>>` | `QueryEngine._syncedIndex` |

---

## 11. Query Engine

`QueryEngine` (`src/query.js`) provides a simple query planner and secondary
indexes for efficient filtered reads.

### Query shape

```json
{
  "filter":  [{ "field": "sender", "op": "eq", "value": "Alice" },
              { "field": "lamport", "op": "gt", "value": 10 }],
  "orderBy": "lamport",
  "order":   "desc",
  "limit":   20,
  "offset":  0
}
```

### Supported operators

| Operator | Meaning |
|----------|---------|
| `eq` | Strict equality |
| `ne` | Strict inequality |
| `gt` / `gte` | Greater-than / greater-or-equal |
| `lt` / `lte` | Less-than / less-or-equal |
| `contains` | Substring match (string fields) |
| `startsWith` | Prefix match (string fields) |

### Planner

1. Scan predicates left-to-right for the first `eq` on an indexed field.
2. If found → **index scan** on that field's secondary index.
3. Otherwise → **full scan**.
4. Post-filter remaining predicates on the candidate set.

`GET /api/query?q=<URL-encoded JSON>` exposes this over HTTP.

---

## 12. Compaction

Unbounded log growth is prevented by two passes scheduled every 5 minutes:

1. **Compact** – For EventBus document events (events with a `docId`), keep
   only the latest version per `(type, docId)` pair.  CRDT events are
   exempt.

2. **Trim** – Remove messages older than `maxAge` milliseconds OR keep only
   the `maxCount` most-recent non-CRDT messages.

Both passes call `store.snapshot()` after completion, truncating the WAL.

---

## 13. Security Model

| Threat | Mitigation |
|--------|-----------|
| Forged messages | Ed25519 signature verification on `POST /receive` |
| Replay attacks | Message deduplication by ID in router and store |
| Flood / DoS | Rate limiter: max 60 requests/min per IP on `POST /receive` |
| Eavesdropping | Transport-layer: deploy behind HTTPS; OFIL does not encrypt at rest |
| Peer impersonation | Public key is tied to `nodeId`; advertised via `GET /api/identity` |

### Known limitations

- OFIL does not provide end-to-end encryption.  All message content is
  stored in plaintext.  For sensitive use cases, encrypt `content` before
  passing it to the store.
- The UDP discovery beacon is unauthenticated.  Rogue nodes can inject
  themselves into the peer table.  Mitigate by restricting UDP port access
  at the network layer.

---

## 14. Performance Characteristics

Measured on a single process (in-process transport) — see `src/benchmark.js`.

| Metric | Typical value |
|--------|---------------|
| Write throughput | > 1 000 ops/sec |
| Read throughput (getAll) | > 5 000 ops/sec |
| Anti-entropy convergence (100 msgs) | < 50 ms |
| Digest size (1 000 msgs) | ≈ 38 KB |
| Delta size per missing message | ≈ 250–400 bytes (JSON) |

All figures are for in-process measurements.  LAN TCP round-trip overhead
adds 0.5–2 ms per HTTP call; WAN adds 20–200 ms.

---

## 15. Deployment Scenarios

### Scenario 1: School without internet

```
School-Server (PORT=3000)  ◄── UDP ──►  Student-1 (PORT=3001)
                           ◄── UDP ──►  Student-2 (PORT=3002)
                           ◄── UDP ──►  Student-3 (PORT=3003)
```

Teacher runs `NODE_ID=School-Server npm start`.  Students run OFIL on their
own devices.  Exam papers are published as messages of type `exam`.  Student
answers are collected as `exam-answer` messages.

When the school's internet connection recovers, all messages are pushed to
a cloud endpoint (`REMOTE_URL`) automatically.

### Scenario 2: Rural business

```
Shop-POS (register)  ◄── Wi-Fi hotspot ──►  Shop-Inventory
                     ◄── Wi-Fi hotspot ──►  Shop-Manager's phone
```

Inventory updates published as EventBus document events (`inventory:update`).
LWW conflict resolution ensures the latest count wins.  All events sync to
a central accounting system when mobile data is available.

### Scenario 3: Disaster response

Field teams run OFIL on laptops connected to an ad-hoc Wi-Fi mesh.
Incident reports are messages of type `emergency`.  GCounter CRDTs track
total affected-person counts without coordination.  All data is replicated
to every device; no single point of failure.

---

## 16. Implementation Status

| Module | File | Status |
|--------|------|--------|
| Lamport clock | `src/clock.js` | ✅ Complete |
| Vector clock | `src/vclock.js` | ✅ Complete |
| GCounter, ORSet | `src/crdt.js` | ✅ Complete |
| Ed25519 identity | `src/identity.js` | ✅ Complete |
| Gossip router | `src/router.js` | ✅ Complete |
| UDP discovery | `src/discovery.js` | ✅ Complete |
| HTTP messenger | `src/messenger.js` | ✅ Complete |
| SyncEngine | `src/sync.js` | ✅ Complete |
| Connectivity tiers | `src/connectivity.js` | ✅ Complete |
| EventBus | `src/eventbus.js` | ✅ Complete |
| Anti-entropy | `src/antientropy.js` | ✅ Complete |
| Compaction | `src/compaction.js` | ✅ Complete |
| WAL | `src/wal.js` | ✅ Complete |
| Store + indexes | `src/store.js` | ✅ Complete |
| Consistency monitor | `src/consistency.js` | ✅ Complete |
| Failure injector | `src/failureinject.js` | ✅ Complete |
| Query engine | `src/query.js` | ✅ Complete |
| Benchmark runner | `src/benchmark.js` | ✅ Complete |
| HTTP server | `src/server.js` | ✅ Complete |

**Test coverage:** 292 Jest tests across 17 test suites (100% pass rate).

---

*OFIL-RFC-001 — Daniel Kimeu — MIT License*
