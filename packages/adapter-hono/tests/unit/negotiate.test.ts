import { describe, expect, it } from 'vitest';

import { parseEncodingHeader, selectEncoding } from '../../src/runtime/negotiate.js';

const ALL = ['zstd', 'br', 'gzip'] as const;

describe('parseEncodingHeader', () => {
	it('parses tokens with default q=1', () => {
		const table = parseEncodingHeader('gzip, br');
		expect(table.get('gzip')).toBe(1);
		expect(table.get('br')).toBe(1);
	});

	it('parses explicit q-values and clamps out-of-range values', () => {
		const table = parseEncodingHeader('gzip;q=0.5, br;q=2, zstd;q=-1');
		expect(table.get('gzip')).toBe(0.5);
		expect(table.get('br')).toBe(1);
		expect(table.get('zstd')).toBe(0);
	});

	it('treats malformed q-values as not acceptable', () => {
		expect(parseEncodingHeader('gzip;q=abc').get('gzip')).toBe(0);
	});

	it('lowercases tokens and tolerates whitespace', () => {
		const table = parseEncodingHeader('  GZip ; Q=0.8 ,BR ');
		expect(table.get('gzip')).toBe(0.8);
		expect(table.get('br')).toBe(1);
	});

	it('keeps the first occurrence of a duplicated token', () => {
		expect(parseEncodingHeader('gzip;q=0.1, gzip;q=0.9').get('gzip')).toBe(0.1);
	});

	it('ignores empty entries', () => {
		expect(parseEncodingHeader(',,gzip,').size).toBe(1);
	});
});

describe('selectEncoding', () => {
	it('returns identity for a missing header', () => {
		expect(selectEncoding(null, ALL)).toBe('identity');
		expect(selectEncoding(undefined, ALL)).toBe('identity');
		expect(selectEncoding('', ALL)).toBe('identity');
	});

	it('returns identity when nothing is available', () => {
		expect(selectEncoding('gzip, br, zstd', [])).toBe('identity');
	});

	it('picks the only acceptable available encoding', () => {
		expect(selectEncoding('gzip', ALL)).toBe('gzip');
	});

	it('breaks q-value ties in zstd > br > gzip order', () => {
		expect(selectEncoding('gzip, br, zstd', ALL)).toBe('zstd');
		expect(selectEncoding('gzip, br', ALL)).toBe('br');
		expect(selectEncoding('br, zstd', ['br', 'gzip'])).toBe('br');
	});

	it('respects q-value ordering over preference ordering', () => {
		expect(selectEncoding('zstd;q=0.1, gzip;q=0.9', ALL)).toBe('gzip');
		expect(selectEncoding('gzip;q=0.5, br;q=0.4', ALL)).toBe('gzip');
	});

	it('excludes encodings with q=0', () => {
		expect(selectEncoding('gzip;q=0', ['gzip'])).toBe('identity');
		expect(selectEncoding('zstd;q=0, br', ALL)).toBe('br');
	});

	it('applies the wildcard to unlisted encodings', () => {
		expect(selectEncoding('*', ALL)).toBe('zstd');
		expect(selectEncoding('*;q=0.1, gzip;q=0.9', ALL)).toBe('gzip');
		expect(selectEncoding('*;q=0', ALL)).toBe('identity');
		expect(selectEncoding('*;q=0, br', ALL)).toBe('br');
	});

	it('serves a compressed variant when identity is forbidden', () => {
		expect(selectEncoding('identity;q=0, gzip', ALL)).toBe('gzip');
	});

	it('falls back to identity when identity;q=0 but nothing else matches (pragmatic)', () => {
		expect(selectEncoding('identity;q=0', ALL)).toBe('identity');
	});

	it('ignores unknown encodings', () => {
		expect(selectEncoding('compress, deflate', ALL)).toBe('identity');
		expect(selectEncoding('compress, gzip;q=0.2', ALL)).toBe('gzip');
	});
});
