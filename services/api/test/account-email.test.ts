import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountLink, tokenDigest } from '../src/account-email.ts';

test('account links use the configured app and put the token only in the fragment', () => {
  const token = 'a'.repeat(64);
  const link = new URL(accountLink('https://geobook.example/app/?old=query#old', 'reset-password', token));
  assert.equal(link.origin, 'https://geobook.example');
  assert.equal(link.pathname, '/app/');
  assert.equal(link.search, '');
  assert.equal(link.hash, '#/reset-password/' + token);
  assert.equal(new URL(accountLink('http://localhost:8080/', 'verify-email', token)).hash, '#/verify-email/' + token);
});
test('rejects executable and credential-bearing link origins', () => {
  for (const base of ['javascript:alert(1)', 'file:///tmp', 'https://user:password@example.com/']) {
    assert.throws(() => accountLink(base, 'verify-email', 'token'));
  }
});
test('stored token digests cannot be used as the original bearer token', () => {
  const raw = '0123456789abcdef'.repeat(4), hash = tokenDigest(raw);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, raw);
  assert.notEqual(tokenDigest(hash), hash);
});
