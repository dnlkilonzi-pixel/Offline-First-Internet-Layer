# Changelog

All notable changes to **Offline-First Internet Layer** are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and [Semantic Versioning](https://semver.org/).

---

## [1.0.0] – 2026-04-03

### 🎉 Initial production release — authored by Daniel Kimeu

This release brings OFIL to **research-grade, real-world deployable
infrastructure**.  It ships 18 production modules, 297 Jest tests, a formal
protocol specification, a secondary-index query engine, and a multi-node
benchmark suite.

---

### Added

#### Core distributed systems primitives
- **`src/clock.js`** — Lamport logical clock.  Enables deterministic causal
  ordering of messages across nodes without synchronised wall clocks.
- **`src/vclock.js`** — Vector clock.  Tracks causal ancestry per node;
  exposes `buildCausalGraph()` for happened-before lineage queries.
- **`src/crdt.js`** — Conflict-free Replicated Data Types:
  - `GCounter` – grow-only counter; merge = max per partition.
  - `ORSet` – observed-remove set with add-wins semantics.

#### Identity and security
- **`src/identity.js`** — Persistent Ed25519 key pair.  All peer-to-peer
  messages are signed and verified; forgeries are rejected with HTTP 401.

#### Networking
- **`src/discovery.js`** — UDP broadcast peer discovery (default port 41234).
  Nodes announce themselves every 5 s; stale peers time out after 15 s.
- **`src/messenger.js`** — HTTP message delivery with signature attachment.
- **`src/router.js`** — TTL-based gossip flood with deduplication.
- **`src/connectivity.js`** — Connectivity tier monitor: `none`, `lan`,
  `hotspot`, `wan`.  Drives partition-heal anti-entropy on reconnection.

#### Storage engine
- **`src/wal.js`** — NDJSON Write-Ahead Log.  Every mutation is recorded
  before the snapshot; corrupt lines are silently skipped on replay.
- **`src/store.js`** — File-backed store with WAL durability, atomic snapshot
  (`tmp → rename`), in-memory type index (`Map<type, Set<id>>`),
  `getByType()`, `snapshot()` (persist + truncate WAL).

#### Synchronisation
- **`src/sync.js`** — Internet-connectivity-aware sync engine.  Pushes
  unsynced messages to a remote endpoint when online.
- **`src/antientropy.js`** — Digest-based anti-entropy reconciliation.
  Two HTTP round-trips per peer per round; transfers only the delta.
- **`src/compaction.js`** — Log compaction: document-level LWW pruning
  and count/age-based trimming.  Calls `store.snapshot()` after each pass.

#### Higher-level APIs
- **`src/eventbus.js`** — Typed event bus with document model (LWW), causal
  graph export, and vector-clock-backed history.
- **`src/server.js`** — Express REST API + Socket.io real-time layer.

  | Endpoint | Description |
  |----------|-------------|
  | `GET  /api/status` | Node info, tier, peer list |
  | `GET  /api/identity` | Ed25519 public key |
  | `GET  /api/messages` | All messages (Lamport-ordered) |
  | `POST /api/messages` | Send a signed message |
  | `POST /api/messages/receive` | Accept a peer message (rate-limited) |
  | `GET  /api/peers` | Current peer list |
  | `POST /api/sync` | Trigger remote sync |
  | `POST /api/events` | Publish EventBus event |
  | `GET  /api/events/:type` | Event history |
  | `GET  /api/events/:type/causal` | Causal lineage graph |
  | `GET  /api/docs/:type/:docId` | Latest document state |
  | `GET  /api/digest` | Anti-entropy digest |
  | `POST /api/reconcile` | Anti-entropy reconcile |
  | `POST /api/push` | Anti-entropy push |
  | `GET  /api/consistency` | Formal consistency model declaration |
  | `POST /api/snapshot` | Flush atomic snapshot + truncate WAL |
  | `GET  /api/query` | Secondary-index query engine |
  | `GET  /api/benchmark` | Live performance benchmark |

#### Formal consistency model
- **`src/consistency.js`** — `ConsistencyMonitor`:
  - Frozen `GUARANTEES` object (EC, AP, RYW, MR, LWW, ORSet, GCounter,
    anti-entropy convergence, WAL durability).
  - Per-session monotonic-read and read-your-writes enforcement.

#### Failure injection
- **`src/failureinject.js`** — `FailureInjector` with deterministic fault
  decorators: `crash()`, `delay(fn, ms)`, `drop(fn, p, rng)`,
  `reorder(fn, n)` (with `flush()`), `compose()`.

#### Query engine
- **`src/query.js`** — `QueryEngine` with secondary indexes on `sender` and
  `synced`; six filter operators; query planner (`index scan` vs `full scan`);
  `explain()` for introspection; `GET /api/query` HTTP endpoint.

#### Benchmarking
- **`src/benchmark.js`** — `BenchmarkRunner`:
  - `write(store, n)` — sequential write throughput (ops/sec).
  - `read(store, n)` — read throughput (ops/sec).
  - `antiEntropyRound(storeA, storeB, n)` — convergence time (ms, msgs/sec).
  - `bandwidth(messages)` — digest + delta byte cost.
  - `run(storeA, storeB, opts)` — consolidated benchmark report.
  - `GET /api/benchmark` HTTP endpoint for live reports.

#### Documentation
- **`docs/OFIL-RFC-001.md`** — Full RFC-style protocol specification.
  Abstract, Terminology, Message Format, Discovery, Gossip, Consistency
  Model, Anti-entropy, Storage Engine, Query Engine, Compaction, Security,
  Performance, Deployment Scenarios, Implementation Status.
- **`README.md`** — Comprehensive project README with quick-start, API
  reference, architecture diagram, and deployment examples.

---

### Test coverage

297 Jest tests across 17 test suites — all passing.

| Suite | Tests |
|-------|-------|
| `store.test.js` | 17 |
| `wal.test.js` | 18 |
| `clock.test.js` | 14 |
| `vclock.test.js` | 18 |
| `crdt.test.js` | 27 |
| `identity.test.js` | 12 |
| `router.test.js` | 14 |
| `antientropy.test.js` | 16 |
| `compaction.test.js` | 14 |
| `connectivity.test.js` | 12 |
| `eventbus.test.js` | 28 |
| `sync.test.js` | 8 |
| `consistency.test.js` | 24 |
| `resilience.test.js` | 25 |
| `query.test.js` | 32 |
| `benchmark.test.js` | 12 |
| `server.test.js` | 36 |

---

### Author

**Daniel Kimeu** — designer and implementer of the OFIL protocol and all
production modules.

*"The internet should not be a prerequisite for communication."*

---

[1.0.0]: https://github.com/dnlkilonzi-pixel/Offline-First-Internet-Layer/releases/tag/v1.0.0
