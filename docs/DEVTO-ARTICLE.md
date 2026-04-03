# I Built a Chat System That Works Without the Internet — Here's How

*By Daniel Kimeu*

---

What if your devices could still communicate when the internet goes down?

Not "send messages and hope they deliver later" — I mean: **open two browser
windows, disconnect your router, type a message, and watch it appear on the
other screen instantly.**

That's what the Offline-First Internet Layer (OFIL) does.

---

## The problem I was trying to solve

Internet access is not universal.  In rural Kenya (and most of the developing
world), connectivity is:

- **Unreliable** — towers go down; rain kills signal
- **Expensive** — data costs cut into incomes
- **Unavailable** — disaster zones, remote schools, bush clinics

But devices are everywhere.  Every student has a phone.  Every school has
Wi-Fi.  **The gap is the software layer between them.**

Existing solutions either require a central server (which requires internet)
or complex infrastructure (VPN, mesh networking hardware).

I wanted a system that:
1. Works out-of-the-box on any LAN or Wi-Fi hotspot — no configuration
2. Requires no central server or DNS
3. Syncs automatically to the cloud when internet returns
4. Is provably correct — not eventually-correct-by-hope, but with formal guarantees

---

## What I built

OFIL is a Node.js protocol implementation with 15 production modules and
292 tests.

Here's the architecture in one picture:

```
Node A (your laptop)         Node B (teacher's phone)
       │                            │
       │── UDP broadcast ──────────►│   (peer discovery)
       │◄── UDP broadcast ──────────│
       │                            │
       │── HTTP POST /receive ─────►│   (message delivery)
       │                            │
       │── /api/reconcile ─────────►│   (anti-entropy, round 1)
       │◄── { missing, peerIds } ───│
       │── /api/push ──────────────►│   (anti-entropy, round 2)
       │                            │
       ▼  internet available?       ▼
  ┌──────────────────────────────────────┐
  │        Remote sync endpoint          │
  │  (any HTTP server / cloud function)  │
  └──────────────────────────────────────┘
```

### The key insight: treat the cloud as optional

Most apps are designed cloud-first and bolt on offline support as an
afterthought.  OFIL inverts this: **LAN is the primary transport; cloud is
an opportunistic upgrade.**

---

## The demo (do this right now)

```bash
git clone https://github.com/dnlkilonzi-pixel/Offline-First-Internet-Layer
cd Offline-First-Internet-Layer
npm install

# Terminal 1
PORT=3000 NODE_ID=Alice npm start

# Terminal 2
PORT=3001 NODE_ID=Bob npm start
```

Open `http://localhost:3000` and `http://localhost:3001` in two browsers.

Now: **disconnect your Wi-Fi** (but keep both terminals running — they're on
the same machine, sharing loopback).  Send a message from Alice.  It appears
on Bob immediately.  No internet required.

Reconnect.  Click ⬆ Sync.  Messages push to whatever `REMOTE_URL` you set.

---

## The hard parts

### 1. Consistent ordering without a server

How do you order messages from two devices that don't share a clock?

Answer: **Lamport timestamps**.  Every device maintains a logical counter.
When it sends a message, it attaches its counter value.  When it receives a
message with a higher counter, it fast-forwards.  The result: a consistent
total order that doesn't depend on wall-clock sync.

```js
// src/clock.js
tick() { this._time += 1; return this._time; }
update(remote) { this._time = Math.max(this._time, remote) + 1; return this._time; }
```

### 2. Conflict-free data structures

What happens when two devices modify the same document offline and then
reconnect?

OFIL uses **CRDTs** — data structures designed for this exact problem:

- `GCounter`: grow-only counter, merge = max per partition.  Perfect for
  counting things (votes, inventory, page views).
- `ORSet`: observed-remove set with add-wins semantics.  If two nodes
  simultaneously add and remove the same element, the add wins.

### 3. Anti-entropy without flooding

Gossip protocols can send the same message O(n²) times across a network.
OFIL uses **digest-based anti-entropy** instead:

```
Round 1: Alice sends { ids: [all Alice's message IDs] } to Bob
         Bob replies: { missing: [msgs Bob has Alice doesn't], peerIds: [...] }

Round 2: Alice sends { messages: [msgs Alice has Bob doesn't] } to Bob
```

Two HTTP round-trips.  No flooding.  For a warm (already-synced) cluster,
the cost is just two UUID list exchanges — about 57 KB per 1,000 messages.

### 4. Crash safety

Every write goes to a Write-Ahead Log (NDJSON file) before the in-memory
state updates.  The snapshot is written atomically (`tmp → rename`).  On
restart, the WAL is replayed on top of the last snapshot.  **No write is
ever lost, even on a crash between WAL write and snapshot write.**

---

## The formal consistency model

OFIL is an **AP system** in the CAP sense:

| Guarantee | Scope | Mechanism |
|-----------|-------|-----------|
| Eventual Consistency | Global | Anti-entropy + CRDT merge |
| Read Your Writes | Session | Lamport high-watermark |
| Monotonic Reads | Session | `ConsistencyMonitor.checkRead()` |
| Causal Ordering | Per type | Vector clock + causal graph API |

The full spec is in [`docs/OFIL-RFC-001.md`](https://github.com/dnlkilonzi-pixel/Offline-First-Internet-Layer/blob/main/docs/OFIL-RFC-001.md).

---

## Benchmark results

These are real numbers from [`src/benchmark.js`](https://github.com/dnlkilonzi-pixel/Offline-First-Internet-Layer/blob/main/src/benchmark.js):

| Metric | Result |
|--------|--------|
| Write throughput | **1,706 ops/sec** (1k messages, WAL + snapshot) |
| Read throughput | **50,000 ops/sec** (in-memory sort) |
| AE convergence | **1,500 msgs in 1.2 s** between fully-diverged nodes |
| Bandwidth savings | **79% less traffic** than full resync on warm cluster |

You can run these live on any running OFIL node:

```
GET /api/benchmark?writeN=100&readN=50&aeN=50
```

---

## The query engine

The store now has secondary indexes on `type`, `sender`, and `synced`.  A
simple query planner selects index scans over full scans for equality
predicates:

```
GET /api/query?type=exam&sender=Teacher-Wanjiku&limit=20
```

Or with the full query DSL:

```json
GET /api/query?q={"filter":[{"field":"lamport","op":"gt","value":100}],"orderBy":"lamport","order":"desc","limit":10}
```

---

## What this could become

I built OFIL as a research prototype, but it's production-ready:

- **School exam distribution**: teachers publish exams over Wi-Fi; students
  submit answers on their phones.  No internet, no data costs.
- **Rural inventory systems**: POS devices sync to the cloud overnight.
- **Disaster response**: field teams coordinate over ad-hoc mesh when
  cellular infrastructure is destroyed.

The protocol is formally specified in
[OFIL-RFC-001](https://github.com/dnlkilonzi-pixel/Offline-First-Internet-Layer/blob/main/docs/OFIL-RFC-001.md).
I'd love for it to be implemented in other languages and environments.

---

## The code

GitHub: [dnlkilonzi-pixel/Offline-First-Internet-Layer](https://github.com/dnlkilonzi-pixel/Offline-First-Internet-Layer)

```
npm install
PORT=3000 NODE_ID=Alice npm start
PORT=3001 NODE_ID=Bob   npm start
```

If this resonated with you, or you want to use OFIL in a real project, reach
out.  The internet should not be a prerequisite for communication.

---

*Tags: `distributed-systems` `offline-first` `p2p` `nodejs` `crdt`*
