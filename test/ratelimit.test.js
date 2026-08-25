const { test } = require('node:test');
const assert = require('node:assert');
const { createRateLimiter } = require('../lib/ratelimit');

function fakeReqRes(ip) {
  const headers = new Map();
  const req = { ip, socket: { remoteAddress: 'x' } };
  const res = {
    statusCode: null,
    setHeader: (k, v) => headers.set(k, v),
    status: (c) => { res.statusCode = c; return res; },
    json: (body) => { res.body = body; return res; },
    headers,
  };
  return { req, res };
}

test('allows up to max requests in a window, then 429 with Retry-After', () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 3 });
  const { req, res } = fakeReqRes('1.2.3.4');
  for (let i = 0; i < 3; i++) limiter(req, res, () => {});
  assert.strictEqual(res.statusCode, null, 'should not have answered 429 yet');
  limiter(req, res, () => {});
  assert.strictEqual(res.statusCode, 429);
  assert.ok(Number(res.headers.get('Retry-After')) > 0, 'Retry-After present');
  assert.ok(res.body.message.includes('Rate limit'));
});

test('different IPs are independent', () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 2 });
  const a = fakeReqRes('1.1.1.1');
  const b = fakeReqRes('2.2.2.2');
  limiter(a.req, a.res, () => {}); limiter(a.req, a.res, () => {});
  limiter(a.req, a.res, () => {}); // a exceeded
  limiter(b.req, b.res, () => {}); // b fine
  assert.strictEqual(a.res.statusCode, 429);
  assert.strictEqual(b.res.statusCode, null);
});
