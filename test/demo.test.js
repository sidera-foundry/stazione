// The public demo: made-up data in memory, the visitor is the owner, the admin console stays open, every change is
// refused, and every answer says it is the demo.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('demo: reads work as the owner, changes are refused', async () => {
  delete process.env.DATABASE_URL;
  process.env.STAZIONE_DEMO = '1';
  const { demoHandler } = await import('../lib/demo.js');
  const get = async (p, ip) => {
    const res = await demoHandler(new Request(`http://demo.example${p}`, { headers: ip ? { 'x-real-ip': ip } : {} }));
    return { status: res.status, demo: res.headers.get('x-stazione-demo'), body: res.headers.get('content-type')?.startsWith('application/json') ? await res.json() : await res.text() };
  };
  const me = await get('/api/me', '198.51.100.1');
  assert.equal(me.status, 200);
  assert.equal(me.demo, '1');
  assert.equal(me.body.username, 'clara');
  const state = await get('/api/state', '198.51.100.2'); // any visitor, from any network
  assert.equal(state.status, 200);
  assert.ok(state.body.claudes.length >= 8);
  assert.equal((await get('/api/admin/overview')).status, 200, 'the console is open to look at');

  for (const [method, p] of [['POST', '/api/tasks'], ['PUT', '/api/admin/modules/ideas'], ['DELETE', '/api/tokens/x'], ['POST', '/api/auth/logout']]) {
    const res = await demoHandler(new Request(`http://demo.example${p}`, { method, headers: { 'content-type': 'application/json' }, body: '{}' }));
    assert.equal(res.status, 403, `${method} ${p}`);
    assert.equal((await res.json()).code, 'demo');
  }
});
