# 🏛️ Task B: Page Pulse - System Architecture Document for Scale

## 1. Architecture Overview, Components & State Management

### System Objectives
To handle **10,000+ audits per day** with **bursts of 500 concurrent requests** while maintaining a strict customer-facing SLA (<500ms API response time for asynchronous job acceptance, <2s for cached synchronous reads), Page Pulse uses a decoupled, event-driven microservices architecture.

### Where State Lives
* **Stateless Layer:** API Ingestion Nodes (Express) hold zero persistent state.
* **Transient State:** Queue jobs, active worker locks, and rate-limiting sliding windows reside in **Redis**.
* **Persistent State:** Historical audit results, performance telemetry, and client API keys reside in **PostgreSQL / TimescaleDB**.

---

## 2. System Architecture & Diagram
[ Clients / Webhooks ]
│
▼
[ AWS ALB / NGINX Load Balancer ]
│
▼
[ Stateless API Gateway (Express) ] ──(Cache Hit <10ms)──► [ Redis Cluster ]
│                                                      ▲
(Cache Miss)                                                 │
│                                                      │
▼                                                      │
[ BullMQ Queue (Redis Backed) ]                                 │
│                                                      │
▼                                                      │
[ Worker Pool (Node.js Audit Workers) ] ────────────────────────┘
│
▼
[ PostgreSQL / TimescaleDB ]
### Data Flow
1. **Ingestion:** API Gateway receives `POST /api/audit`, validates input via Zod, and checks Redis for rate limits and cache hits.
2. **Enqueueing:** On cache miss, the API pushes an audit job to BullMQ and immediately responds to the client with `202 Accepted` and a `job_id` (ensuring fast SLA response time).
3. **Execution:** Background workers poll BullMQ, check domain circuit breakers, resolve target IPs (SSRF protection), execute performance audits, and cache results in Redis.
4. **Persistence:** Completed audit payloads and metrics are written asynchronously to PostgreSQL.

---

## 3. Technology Decision Record (TDR) & Rejected Alternatives

### 1. Job Queue: BullMQ (Redis) vs. Apache Kafka
* **Chosen:** **BullMQ (Redis)**
* **Why:** Provides low overhead, built-in delayed jobs, exponential backoff retries, and native support for concurrency limits per domain.
* **Rejected Alternative:** **Apache Kafka**
* **Why Rejected:** Overkill for 10,000 requests/day. Kafka introduces unnecessary operational complexity, consumer group partition management, and infrastructure overhead for this volume.

### 2. Primary Database: PostgreSQL (with TimescaleDB) vs. MongoDB
* **Chosen:** **PostgreSQL + TimescaleDB**
* **Why:** Offers strong ACID compliance, structured schemas for API metrics, and time-series optimizations for auditing performance over time.
* **Rejected Alternative:** **MongoDB**
* **Why Rejected:** Unstructured document storage lacks native time-series analytical capabilities and strong schema guarantees needed for multi-tenant billing/rate tracking.

### 3. Distributed Cache: Redis Cluster vs. Memcached
* **Chosen:** **Redis Cluster**
* **Why:** Supports complex data structures (sorted sets for sliding window rate-limiting), pub/sub for job notifications, and persistent cache storage.
* **Rejected Alternative:** **Memcached**
* **Why Rejected:** Limited to simple key-value pairs without built-in queueing, pub/sub, or data structure support needed for BullMQ.

---

## 4. Failure Mode Analysis (Top 3 Scale Failure Modes)

| Failure Mode | Root Cause at Scale | System Mitigation |
| :--- | :--- | :--- |
| **1. Target Domain Blocking / Tarpitting** | Performing 500 concurrent audits can trigger rate limits or web application firewalls (WAFs) on target sites, causing workers to hang. | **Mitigation:** Implement per-domain concurrency caps (max 2 concurrent audits per target host) and Opossum circuit breakers that trip after 50% failure rates. Set a hard 5-second HTTP timeout cap. |
| **2. Queue Backpressure & Memory Spikes** | Sudden burst of 500 concurrent requests fills worker queues faster than execution speed. | **Mitigation:** Scale worker nodes dynamically using Kubernetes HPA / Cloud Autoscaling triggered by BullMQ `queue_depth`. Reject incoming requests with `503 Service Unavailable` if queue exceeds max threshold (1,000 pending jobs). |
| **3. Worker Node Out-Of-Memory (OOM)** | Headless browsers or uncollected HTTP response buffers leak memory during long-running audit tasks. | **Mitigation:** Enforce strict process memory caps via PM2 / Docker (`--memory=512m`). Recycle worker processes automatically after processing 500 jobs (`max-jobs-per-worker`). |

---

## 5. Observability & Rollback Plan

### Monitoring Metrics & Alerting Thresholds
* **SLO Response Time:** Alert if API p99 latency exceeds **500ms** for job creation.
* **Queue Depth & Stagnation:** Alert if BullMQ waiting jobs remain **>200 for over 5 minutes**.
* **Audit Error Rate:** Alert if HTTP 5xx or worker execution error rate exceeds **5%** in a 5-minute window.
* **System Metrics:** Prometheus collection of CPU (>80%), Memory (>85%), and Redis evicted keys.

### Zero-Downtime Rollback Strategy
1. **Deployment Pipeline:** Deploy updates via **Blue/Green strategy** or **Canary deployments** (routing 10% traffic initially).
2. **Automated Health Checks:** Render / ALB runs `/health` checks verifying database connectivity and Redis ping for 60 seconds post-deploy.
3. **Automated Rollback Trigger:** If health checks fail or the HTTP 5xx error rate spikes >2% within 3 minutes of deployment, the load balancer automatically reroutes 100% of traffic back to the previous stable release container.