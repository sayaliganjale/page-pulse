const request = require('supertest');
const app = require('./server');

describe('Page Pulse API Endpoint Tests', () => {

  test('GET /health - Should return HTTP 200 and health payload', async () => {
    const response = await request(app).get('/health');
    
    expect(response.statusCode).toBe(200);
    expect(response.body).toHaveProperty('status', 'OK');
  });

  test('POST /api/audit - Should fail on missing or malformed URL', async () => {
    const response = await request(app)
      .post('/api/audit')
      .send({ url: 'not-a-valid-url' });

    expect(response.statusCode).toBe(400);
    expect(response.body).toHaveProperty('status', 'error');
    expect(response.body.error).toBe('Invalid URL provided');
  });

  test('POST /api/audit - Should reject SSRF attempt to local network', async () => {
    const response = await request(app)
      .post('/api/audit')
      .send({ url: 'http://localhost:3000' });

    expect(response.statusCode).toBe(400);
    expect(response.body).toHaveProperty('status', 'error');
    expect(response.body.error).toBe('Invalid URL provided');
  });

  test('POST /api/audit - Should successfully audit a valid public URL and cache it', async () => {
    const testUrl = 'https://example.com';

    // First request - initial audit (uncached)
    const res1 = await request(app)
      .post('/api/audit')
      .send({ url: testUrl });

    expect(res1.statusCode).toBe(200);
    expect(res1.body.status).toBe('success');
    expect(res1.body.cached).toBe(false);
    expect(res1.body.data).toHaveProperty('statusCode', 200);

    // Second request - should return from cache
    const res2 = await request(app)
      .post('/api/audit')
      .send({ url: testUrl });

    expect(res2.statusCode).toBe(200);
    expect(res2.body.status).toBe('success');
    expect(res2.body.cached).toBe(true);
  });
});