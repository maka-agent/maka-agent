import { describe, test } from 'node:test';
import { expect } from '../../test-helpers.js';
import { matchesBypassList } from '../bypass-matcher.js';

describe('matchesBypassList', () => {
  const list = [
    'localhost',
    '*.local',
    '*.example.com',
    '192.168.*',
    '10.0.0.0/8',
    '127.0.0.1',
    '::1',
  ];

  test('matches exact, wildcard, and CIDR entries', () => {
    expect(matchesBypassList('localhost', list)).toBe(true);
    expect(matchesBypassList('api.example.com', list)).toBe(true);
    expect(matchesBypassList('example.com', list)).toBe(false);
    expect(matchesBypassList('192.168.1.1', list)).toBe(true);
    expect(matchesBypassList('10.5.5.5', list)).toBe(true);
    expect(matchesBypassList('11.0.0.0', list)).toBe(false);
  });

  test('is case-insensitive and supports global wildcard', () => {
    expect(matchesBypassList('LocalHost', list)).toBe(true);
    expect(matchesBypassList('anything', ['*'])).toBe(true);
  });
});
