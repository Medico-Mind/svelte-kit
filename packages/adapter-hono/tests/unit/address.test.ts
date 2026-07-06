import { describe, expect, it } from 'vitest';

import { resolveClientAddress, validateXffDepth } from '../../src/runtime/address.js';

const socket = (address?: string) => () => address;

describe('validateXffDepth', () => {
	it('accepts positive integers', () => {
		expect(validateXffDepth(1)).toBe(1);
		expect(validateXffDepth(3)).toBe(3);
	});

	it('rejects zero, negatives and non-integers', () => {
		expect(() => validateXffDepth(0)).toThrow(/positive integer/);
		expect(() => validateXffDepth(-1)).toThrow(/positive integer/);
		expect(() => validateXffDepth(1.5)).toThrow(/positive integer/);
		expect(() => validateXffDepth(Number.NaN)).toThrow(/positive integer/);
	});
});

describe('resolveClientAddress', () => {
	it('uses the socket address when no header is configured', () => {
		expect(resolveClientAddress(new Headers(), {}, socket('10.0.0.1'))).toBe('10.0.0.1');
	});

	it('throws when no header is configured and the socket address is unknown', () => {
		expect(() => resolveClientAddress(new Headers(), {}, socket(undefined))).toThrow(
			/Could not determine client address/
		);
	});

	it('reads a configured plain header verbatim', () => {
		const headers = new Headers({ 'x-real-ip': '203.0.113.9' });
		expect(resolveClientAddress(headers, { addressHeader: 'x-real-ip' }, socket('10.0.0.1'))).toBe(
			'203.0.113.9'
		);
	});

	it('throws when the configured header is missing', () => {
		expect(() =>
			resolveClientAddress(new Headers(), { addressHeader: 'x-real-ip' }, socket('10.0.0.1'))
		).toThrow(/missing from the request/);
	});

	describe('x-forwarded-for', () => {
		const headers = new Headers({ 'x-forwarded-for': '203.0.113.9, 198.51.100.2 , 10.0.0.1' });
		const config = { addressHeader: 'x-forwarded-for' };

		it('takes the rightmost address at depth 1 (default)', () => {
			expect(resolveClientAddress(headers, config, socket())).toBe('10.0.0.1');
		});

		it('walks left as depth increases and trims whitespace', () => {
			expect(resolveClientAddress(headers, { ...config, xffDepth: 2 }, socket())).toBe(
				'198.51.100.2'
			);
			expect(resolveClientAddress(headers, { ...config, xffDepth: 3 }, socket())).toBe(
				'203.0.113.9'
			);
		});

		it('throws when depth exceeds the number of addresses', () => {
			expect(() => resolveClientAddress(headers, { ...config, xffDepth: 4 }, socket())).toThrow(
				/XFF_DEPTH is 4, but only found 3 addresses/
			);
		});

		it('throws on an invalid depth', () => {
			expect(() => resolveClientAddress(headers, { ...config, xffDepth: 0 }, socket())).toThrow(
				/positive integer/
			);
		});

		it('handles a single-address header', () => {
			const single = new Headers({ 'x-forwarded-for': '203.0.113.9' });
			expect(resolveClientAddress(single, config, socket())).toBe('203.0.113.9');
			expect(() => resolveClientAddress(single, { ...config, xffDepth: 2 }, socket())).toThrow(
				/only found 1 address(?!e)/
			);
		});
	});
});
