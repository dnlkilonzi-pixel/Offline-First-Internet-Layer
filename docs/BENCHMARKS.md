# OFIL Benchmark Results

**Produced by:** [`src/benchmark.js`](../src/benchmark.js) — `BenchmarkRunner`  
**Environment:** Node.js v20, single process, in-process transport (no TCP)  
**Author:** Daniel Kimeu  

> Live results can also be fetched via `GET /api/benchmark`.

---

## Summary

| Metric | Result |
|--------|--------|
| **Write throughput** | 1,706 ops/sec (1,000 messages in 586 ms) |
| **Read throughput** | 50,000 ops/sec (500 `getAll` calls in 10 ms) |
| **AE convergence** | 1,500 messages between 2 nodes in 1.197 s (1,253 msgs/sec) |
| **Bandwidth savings** | 79% reduction vs full resync on a warm cluster |

---

## 1. Write Throughput

**Measures:** Sequential persistence throughput — WAL append + atomic snapshot.

```
n           = 1,000 messages
duration    = 586 ms
ops/sec     = 1,706
```

Each write goes through:
1. Lamport clock tick
2. WAL append (NDJSON line)
3. In-memory array push + type-index update
4. Atomic snapshot (`tmp → rename`)

The bottleneck is the filesystem snapshot; production deployments can increase
throughput by calling `snapshot()` less frequently (e.g., every 10 writes
instead of every write) and relying on WAL replay for crash recovery.

---

## 2. Read Throughput

**Measures:** In-memory sort performance on `store.getAll()`.

```
n           = 500 iterations (getAll over 1,000 messages)
duration    = 10 ms
ops/sec     = 50,000
```

`getAll()` sorts the in-memory array by Lamport timestamp.  It is O(n log n)
in the number of stored messages.  For typical workloads (< 100k messages),
this is faster than any I/O-bound alternative.

---

## 3. Anti-Entropy Convergence Time

**Measures:** Time for all messages on Node A to reach Node B via the
two-round-trip digest/push protocol.

```
n messages on A    = 1,500 (seeded in three runs of 500)
n messages on B    = 0  (fully diverged)
round-trip cost    = in-process (0 ms network latency)
convergence time   = 1,197 ms
messages/sec       = 1,253
```

On a real LAN, add ~1–2 ms per HTTP round-trip (2 trips per AE round):

| Scenario | Estimated convergence (1,500 msgs) |
|----------|-------------------------------------|
| In-process (benchmark) | 1.2 s |
| LAN (1 ms RTT)         | ~1.2 s + 4 ms overhead |
| WAN (50 ms RTT)        | ~1.2 s + 100 ms overhead |

For a warm cluster (already synced), the exchange is just the digest swap —
two HTTP requests carrying a list of UUIDs.  The delta payload is empty.

---

## 4. Bandwidth Efficiency

**Measures:** Byte cost of a full anti-entropy exchange for a 1,500-message
store versus a full resync.

```
messageCount  = 1,500
digestBytes   = 58,501  (~57 KB  — UUID list)
deltaBytes    = 277,174 (~270 KB — full JSON payload)
totalBytes    = 335,675 (~328 KB — worst case, 0% prior sync)
```

### Warm cluster savings

When nodes are already mostly synced (typical steady-state), the delta is
empty.  The protocol pays only the digest cost:

```
warm exchange cost  = 2 × digestBytes = 117 KB
cold exchange cost  = digestBytes + deltaBytes = 328 KB
savings             = (328 - 117) / 328 ≈ 64%

vs naive full-resync (sending all deltaBytes every round):
savings             = (277 - 58) / 277 ≈ 79%
```

In practice: once two nodes have converged, subsequent anti-entropy rounds
pay only ≈57 KB regardless of how many messages are in the store.

---

## 5. Query Engine Performance

The `QueryEngine` uses secondary indexes on `type`, `sender`, and `synced`,
plus a simple query planner.

| Scenario | Complexity | Notes |
|----------|-----------|-------|
| `eq` on indexed field | O(k), k = result size | Index scan — avoids full scan |
| Other filter | O(n) | Full scan with post-filter |
| Sort + paginate | O(k log k) | After candidate selection |

For 10,000 stored messages with 100 results in a type bucket, an index scan
visits only 100 messages rather than 10,000 — a **100× improvement** over
full scan.

---

## Running Benchmarks

### CLI (Node.js)

```js
const Store = require('./src/store');
const BenchmarkRunner = require('./src/benchmark');
const path = require('path');
const os = require('os');

const fpA = path.join(os.tmpdir(), 'ofil-bm-A.json');
const fpB = path.join(os.tmpdir(), 'ofil-bm-B.json');
const bench = new BenchmarkRunner();

bench.run(new Store(fpA), new Store(fpB), { writeN: 500, readN: 200, aeN: 200 })
  .then(console.log);
```

### HTTP (live, while server is running)

```
GET http://localhost:3000/api/benchmark?writeN=100&readN=50&aeN=50
```

Returns a JSON report identical to the `BenchmarkReport` typedef in `src/benchmark.js`.

---

*OFIL Benchmarks — Daniel Kimeu — MIT License*
