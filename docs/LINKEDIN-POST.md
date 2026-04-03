# LinkedIn Post — Offline-First Internet Layer

*Copy, personalise, and post as-is or trim to your preferred length.*

---

## Option A — Full story (recommended)

I spent the last few months building something that's been living in my head
for years.

**What if your devices could communicate without the internet?**

Not "store and forward when connectivity returns" — I mean actually
communicate, in real time, over your local Wi-Fi, with no server, no DNS,
no cloud, no data plan.

I just shipped the Offline-First Internet Layer (OFIL): a peer-to-peer
protocol that lets devices discover each other on a LAN, exchange messages
directly, and then sync to the cloud automatically when internet returns.

Here's what makes it technically solid:

🔁 **Eventual consistency** — nodes converge to the same state regardless of
network partitions, using CRDTs (GCounter, ORSet) and Lamport clock ordering

🔒 **Ed25519 signatures** — every message is signed; forgeries are rejected
at the receiving node

📓 **WAL durability** — every write is append-only to a Write-Ahead Log
before the snapshot; crash-safe

🔍 **Query engine** — secondary indexes on sender, type, synced; query
planner that picks index scans over full scans automatically

⚡ **Benchmarked:**
- Write: 1,706 ops/sec
- Read: 50,000 ops/sec
- Anti-entropy convergence: 1,500 messages between two nodes in 1.2 seconds
- Bandwidth: 79% less traffic than full resync

And it has a formal protocol specification — OFIL-RFC-001 — covering message
format, discovery, gossip, consistency guarantees, security model, and
real-world deployment scenarios.

The three use cases I care most about:
🏫 Schools — exam papers distributed over classroom Wi-Fi, no SIM required
🏪 Rural businesses — inventory syncing to the cloud when mobile data is available
🚨 Disaster response — coordination when towers are down

292 tests. 17 modules. 1 mission: the internet should not be a prerequisite for communication.

📦 Open-source, MIT license:
👉 github.com/dnlkilonzi-pixel/Offline-First-Internet-Layer

#OfflineFirst #DistributedSystems #P2P #OpenSource #NodeJS #AfricanTech #BuildInPublic

---

## Option B — Short hook version

The internet goes down. Your devices stop talking.

That's a design flaw, not a law of physics.

I built OFIL — a P2P protocol where devices communicate over LAN first,
sync to the cloud second.

Disconnect your router. Open two browsers. Send a message. Watch it arrive.
Reconnect. Watch it sync.

No server. No DNS. No data plan.

1,706 writes/sec. 50k reads/sec. 1,500 messages converge in 1.2s.
Formal RFC. 292 tests. MIT.

👉 github.com/dnlkilonzi-pixel/Offline-First-Internet-Layer

#OfflineFirst #DistributedSystems #OpenSource

---

## Option C — Milestone / launch post

🚀 Shipping OFIL v1.0.0 today.

The Offline-First Internet Layer is a peer-to-peer communication protocol
that works without the internet:

✅ UDP broadcast peer discovery (no config, no DNS)
✅ Gossip routing with TTL flood control
✅ Ed25519 signed messages
✅ CRDTs: GCounter, ORSet
✅ Vector clock causal graph
✅ WAL + atomic snapshot (crash-safe)
✅ Secondary-index query engine
✅ Anti-entropy reconciliation (79% bandwidth savings)
✅ Formal consistency model (EC, AP, RYW, MR)
✅ Formal RFC protocol spec

Benchmark:
- 1,706 write ops/sec
- 50,000 read ops/sec
- 1,500-message convergence in 1.2 s
- 79% traffic reduction vs naive sync

292 tests. 17 suites. All green.

This is for the schools in Turkana with Wi-Fi but no internet.
The clinics in Marsabit with tablets but no data.
The emergency teams in disaster zones with laptops but no towers.

The internet should not be a prerequisite for communication.

📖 RFC: github.com/dnlkilonzi-pixel/Offline-First-Internet-Layer/blob/main/docs/OFIL-RFC-001.md
📦 Repo: github.com/dnlkilonzi-pixel/Offline-First-Internet-Layer

#OfflineFirst #CRDT #DistributedSystems #P2P #AfricanTech #OpenSource #BuildInPublic #NodeJS

---

*— Daniel Kimeu*
