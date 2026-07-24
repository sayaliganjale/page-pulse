# ⚡ Page Pulse - Production-Grade URL Audit Microservice

A resilient Node.js / Express microservice for URL performance auditing featuring strict input validation, SSRF protection, configurable caching, rate limiting, and structured logging.

> Built for [Digital Heroes Training Task](https://digitalheroesco.com)

---

## 🛠️ Tech Stack & Key Features

- **Input Validation & SSRF Guard:** Blocks malformed inputs, private IPv4 subnets (`127.x.x.x`, `10.x.x.x`, `192.168.x.x`), and `localhost` hostnames using **Zod**.
- **Configurable Caching:** Prevents redundant refetches via `node-cache` with configurable TTL via environment variables (`CACHE_TTL_SECONDS`).
- **Rate & Concurrency Control:** Safeguarded by `express-rate-limit` (20 req/min/IP) and concurrency cap guards (`503 Service Unavailable`).
- **Structured JSON Logging:** Powered by **Winston** with correlation IDs (`X-Request-ID`) attached to every request.
- **Automated Test Suite & CI:** Integrated unit/integration tests with **Jest** and **Supertest**, wired up to run on GitHub Actions.

---

## 📑 API Contract

### `POST /api/audit`
Audits the target URL and returns standard metadata.

#### Request Body:
```json
{
  "url": "[https://example.com](https://example.com)"
}
