const express = require('express');
const axios = require('axios');
const { z } = require('zod');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const winston = require('winston');

const uuidv4 = () => crypto.randomUUID();

const app = express();

// Parse JSON request body
app.use(express.json());

// 1. Configurable Cache TTL (default: 300 seconds)
const CACHE_TTL = parseInt(process.env.CACHE_TTL_SECONDS || '300', 10);
const cache = new NodeCache({ stdTTL: CACHE_TTL, checkperiod: 120 });

// 2. Structured JSON Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

// 3. Correlation ID & Logging Middleware
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || uuidv4();
  res.setHeader('X-Request-ID', req.id);

  logger.info('Incoming Request', {
    requestId: req.id,
    method: req.method,
    url: req.url,
    ip: req.ip,
  });
  next();
});

// 4. Rate Limiter (max 20 requests per minute per IP)
const auditLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: {
    status: 'error',
    error: 'Too many audit requests from this IP, please try again after a minute.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// 5. Concurrency Limiter
const MAX_CONCURRENT_AUDITS = parseInt(process.env.MAX_CONCURRENT_AUDITS || '5', 10);
let activeAudits = 0;

// URL Validation Schema (Prevents SSRF & Invalid Formats)
const urlSchema = z.string().url().refine((val) => {
  try {
    const parsed = new URL(val);
    const hostname = parsed.hostname;
    return (
      !hostname.startsWith('127.') &&
      !hostname.startsWith('10.') &&
      !hostname.startsWith('192.168.') &&
      hostname !== 'localhost'
    );
  } catch (e) {
    return false;
  }
}, { message: 'Invalid or restricted URL target (Private IPs forbidden)' });

// API Endpoint: /api/audit
app.post('/api/audit', auditLimiter, (req, res) => {
  const { url } = req.body || {};

  // Safeguard: Check if URL exists and is a valid string
  if (!url || typeof url !== 'string') {
    logger.warn('Validation Failed: Missing or invalid URL in body', { requestId: req.id });
    return res.status(400).json({
      status: 'error',
      requestId: req.id,
      error: 'Invalid URL provided',
      details: ['URL string is required in request body'],
    });
  }

  // Input Validation with Zod
  const validation = urlSchema.safeParse(url);
  if (!validation.success) {
    const errorDetails = validation.error?.issues 
      ? validation.error.issues.map((i) => i.message) 
      : ['Invalid URL format'];

    logger.warn('Validation Failed', { requestId: req.id, url, errors: errorDetails });
    return res.status(400).json({
      status: 'error',
      requestId: req.id,
      error: 'Invalid URL provided',
      details: errorDetails,
    });
  }

  const targetUrl = validation.data;

  // Check Cache
  const cachedData = cache.get(targetUrl);
  if (cachedData) {
    logger.info('Cache Hit', { requestId: req.id, url: targetUrl });
    return res.status(200).json({
      status: 'success',
      requestId: req.id,
      cached: true,
      data: cachedData,
    });
  }

  // Concurrency Check
  if (activeAudits >= MAX_CONCURRENT_AUDITS) {
    logger.warn('Concurrency Limit Exceeded', { requestId: req.id, activeAudits });
    return res.status(503).json({
      status: 'error',
      requestId: req.id,
      error: 'Service busy. Concurrency limit reached. Try again shortly.',
    });
  }

  activeAudits++;
  const startTime = Date.now();

  axios.get(targetUrl, {
    timeout: 5000,
    headers: { 'User-Agent': 'PagePulse-AuditService/1.0' },
    validateStatus: () => true,
  })
  .then((response) => {
    const responseTime = Date.now() - startTime;
    const result = {
      targetUrl,
      statusCode: response.status,
      responseTimeMs: responseTime,
      contentLength: response.headers['content-length'] || (response.data ? response.data.length : 0),
      contentType: response.headers['content-type'] || 'unknown',
      auditedAt: new Date().toISOString(),
    };

    cache.set(targetUrl, result);
    logger.info('Audit Completed Successfully', { requestId: req.id, targetUrl, statusCode: response.status });

    return res.status(200).json({
      status: 'success',
      requestId: req.id,
      cached: false,
      data: result,
    });
  })
  .catch((err) => {
    logger.error('Audit Execution Failed', { requestId: req.id, url: targetUrl, error: err.message });
    return res.status(502).json({
      status: 'error',
      requestId: req.id,
      error: 'Failed to reach or audit target URL',
      details: err.message,
    });
  })
  .finally(() => {
    activeAudits--;
  });
});

// Health Endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', activeAudits, cacheKeys: cache.getStats().keys });
});

// Root / UI Route (With Digital Heroes Co Credit Link)
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Page Pulse - Production URL Audit Service</title>
      <style>
        body { 
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; 
          max-width: 800px; 
          margin: 40px auto; 
          padding: 0 20px; 
          line-height: 1.6; 
          color: #333;
        }
        .card { 
          border: 1px solid #e1e4e8; 
          padding: 24px; 
          border-radius: 8px; 
          box-shadow: 0 2px 4px rgba(0,0,0,0.05); 
          background-color: #fff;
        }
        .input-group { display: flex; gap: 10px; margin-bottom: 20px; }
        input[type="text"] { 
          flex: 1; 
          padding: 10px 14px; 
          font-size: 16px; 
          border: 1px solid #ccc; 
          border-radius: 6px; 
        }
        button { 
          padding: 10px 20px; 
          font-size: 16px; 
          background-color: #0066cc; 
          color: white; 
          border: none; 
          border-radius: 6px; 
          cursor: pointer; 
          font-weight: 600;
        }
        button:hover { background-color: #0052a3; }
        pre { 
          background: #f6f8fa; 
          padding: 16px; 
          border-radius: 6px; 
          overflow-x: auto; 
          border: 1px solid #e1e4e8;
          font-family: monospace;
        }
        footer { 
          margin-top: 40px; 
          padding-top: 20px; 
          border-top: 1px solid #eaeaea; 
          text-align: center; 
          color: #666; 
          font-size: 14px; 
        }
        footer a { color: #0066cc; text-decoration: none; font-weight: 600; }
        footer a:hover { text-decoration: underline; }
      </style>
    </head>
    <body>
      <h1>⚡ Page Pulse</h1>
      <p>Production-Grade URL Audit Microservice</p>
      
      <div class="card">
        <h3>Audit a Target URL</h3>
        <div class="input-group">
          <input type="text" id="urlInput" placeholder="https://example.com" />
          <button onclick="runAudit()">Audit URL</button>
        </div>
        <h4>Audit Result:</h4>
        <pre id="output">// JSON response will appear here...</pre>
      </div>

      <footer>
        Built for <a href="https://digitalheroesco.com" target="_blank" rel="noopener noreferrer">Digital Heroes Training Task</a>
      </footer>

      <script>
        async function runAudit() {
          const urlInput = document.getElementById('urlInput').value.trim();
          const output = document.getElementById('output');
          if (!urlInput) {
            output.textContent = 'Please enter a valid URL.';
            return;
          }
          output.textContent = 'Auditing target URL...';

          try {
            const res = await fetch('/api/audit', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: urlInput })
            });
            const data = await res.json();
            output.textContent = JSON.stringify(data, null, 2);
          } catch (err) {
            output.textContent = 'Error executing request: ' + err.message;
          }
        }
      </script>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    logger.info(`Page Pulse service running on port ${PORT}`);
  });
}

module.exports = app;
