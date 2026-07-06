import { describe, expect, it } from 'vitest';

import { createEnv, parseBodySizeLimit } from '../../src/runtime/env-core.js';

describe('createEnv', () => {
	it('reads unprefixed variables', () => {
		const env = createEnv('', { PORT: '4000' });
		expect(env('PORT')).toBe('4000');
	});

	it('reads prefixed variables and ignores unprefixed ones', () => {
		const env = createEnv('MY_APP_', { MY_APP_PORT: '4000', PORT: '9999' });
		expect(env('PORT')).toBe('4000');
	});

	it('returns the fallback when the variable is absent', () => {
		const env = createEnv('MY_APP_', { PORT: '9999' });
		expect(env('PORT', '3000')).toBe('3000');
		expect(env('PORT')).toBeUndefined();
	});

	it('prefers a present-but-empty variable over the fallback', () => {
		const env = createEnv('', { HOST: '' });
		expect(env('HOST', '0.0.0.0')).toBe('');
	});

	it('defaults to process.env', () => {
		process.env.ADAPTER_HONO_TEST_VAR = 'yes';
		try {
			const env = createEnv('ADAPTER_HONO_');
			expect(env('TEST_VAR')).toBe('yes');
		} finally {
			delete process.env.ADAPTER_HONO_TEST_VAR;
		}
	});
});

describe('parseBodySizeLimit', () => {
	it('parses plain byte counts', () => {
		expect(parseBodySizeLimit('1024')).toBe(1024);
		expect(parseBodySizeLimit('0')).toBe(0);
	});

	it('parses K/M/G suffixes case-insensitively', () => {
		expect(parseBodySizeLimit('512K')).toBe(512 * 1024);
		expect(parseBodySizeLimit('512k')).toBe(512 * 1024);
		expect(parseBodySizeLimit('1M')).toBe(1024 * 1024);
		expect(parseBodySizeLimit('2G')).toBe(2 * 1024 ** 3);
		expect(parseBodySizeLimit('1.5M')).toBe(1.5 * 1024 * 1024);
	});

	it('parses Infinity', () => {
		expect(parseBodySizeLimit('Infinity')).toBe(Infinity);
		expect(parseBodySizeLimit('infinity')).toBe(Infinity);
	});

	it('tolerates surrounding whitespace', () => {
		expect(parseBodySizeLimit(' 512K ')).toBe(512 * 1024);
	});

	it('throws on invalid input', () => {
		expect(() => parseBodySizeLimit('abc')).toThrow(/Invalid body size limit/);
		expect(() => parseBodySizeLimit('-5')).toThrow(/Invalid body size limit/);
		expect(() => parseBodySizeLimit('10KB')).toThrow(/Invalid body size limit/);
		expect(() => parseBodySizeLimit('')).toThrow(/Invalid body size limit/);
	});
});
