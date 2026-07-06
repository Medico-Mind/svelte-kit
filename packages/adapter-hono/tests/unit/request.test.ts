import { describe, expect, it } from 'vitest';

import { BodySizeLimitError, limitStream, prepareSsrRequest } from '../../src/runtime/request.js';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		}
	});
}

describe('limitStream', () => {
	it('passes chunks through unchanged when under the limit', async () => {
		const limited = limitStream(streamOf('hello ', 'world'), 100);
		const text = await new Response(limited).text();
		expect(text).toBe('hello world');
	});

	it('errors the stream once the limit is exceeded', async () => {
		const limited = limitStream(streamOf('hello ', 'world'), 8);
		await expect(new Response(limited).text()).rejects.toBeInstanceOf(BodySizeLimitError);
	});
});

describe('prepareSsrRequest', () => {
	it('returns the original request object when nothing needs changing', () => {
		const request = new Request('http://internal:3000/path');
		expect(prepareSsrRequest(request, {})).toBe(request);
		expect(prepareSsrRequest(request, { bodySizeLimit: 1024 })).toBe(request);
	});

	it('rewrites the URL to the configured ORIGIN, preserving path and query', () => {
		const request = new Request('http://internal:3000/path?q=1');
		const prepared = prepareSsrRequest(request, { origin: 'https://example.com' });
		expect(prepared).toBeInstanceOf(Request);
		expect((prepared as Request).url).toBe('https://example.com/path?q=1');
	});

	it('keeps the original object when the URL already matches ORIGIN', () => {
		const request = new Request('https://example.com/path');
		expect(prepareSsrRequest(request, { origin: 'https://example.com' })).toBe(request);
	});

	it('applies protocol, host and port headers', () => {
		const request = new Request('http://internal:3000/path', {
			headers: {
				'x-forwarded-proto': 'https',
				'x-forwarded-host': 'example.com',
				'x-forwarded-port': '8443'
			}
		});
		const prepared = prepareSsrRequest(request, {
			protocolHeader: 'x-forwarded-proto',
			hostHeader: 'x-forwarded-host',
			portHeader: 'x-forwarded-port'
		}) as Request;
		expect(prepared.url).toBe('https://example.com:8443/path');
	});

	it('takes the first element of comma-separated forwarded headers', () => {
		const request = new Request('http://internal:3000/', {
			headers: { 'x-forwarded-proto': 'https, http' }
		});
		const prepared = prepareSsrRequest(request, {
			protocolHeader: 'x-forwarded-proto'
		}) as Request;
		expect(new URL(prepared.url).protocol).toBe('https:');
	});

	it('understands host headers that carry a port', () => {
		const request = new Request('http://internal:3000/', {
			headers: { 'x-forwarded-host': 'example.com:8080' }
		});
		const prepared = prepareSsrRequest(request, { hostHeader: 'x-forwarded-host' }) as Request;
		expect(prepared.url).toBe('http://example.com:8080/');
	});

	it('drops the internal port when the forwarded host has none', () => {
		const request = new Request('http://internal:3000/', {
			headers: { 'x-forwarded-host': 'example.com' }
		});
		const prepared = prepareSsrRequest(request, { hostHeader: 'x-forwarded-host' }) as Request;
		expect(prepared.url).toBe('http://example.com/');
	});

	it('ORIGIN wins over forwarded headers', () => {
		const request = new Request('http://internal:3000/', {
			headers: { 'x-forwarded-host': 'attacker.example' }
		});
		const prepared = prepareSsrRequest(request, {
			origin: 'https://example.com',
			hostHeader: 'x-forwarded-host'
		}) as Request;
		expect(prepared.url).toBe('https://example.com/');
	});

	it('responds 413 when the declared content-length exceeds the limit', () => {
		const request = new Request('http://internal/upload', {
			method: 'POST',
			body: 'x'.repeat(100),
			headers: { 'content-length': '100' }
		});
		const result = prepareSsrRequest(request, { bodySizeLimit: 10 });
		expect(result).toBeInstanceOf(Response);
		expect((result as Response).status).toBe(413);
	});

	it('wraps streaming bodies so exceeding the limit errors mid-stream', async () => {
		const request = new Request('http://internal/upload', {
			method: 'POST',
			body: streamOf('a'.repeat(64), 'b'.repeat(64)),
			duplex: 'half'
		});
		const prepared = prepareSsrRequest(request, { bodySizeLimit: 100 }) as Request;
		expect(prepared).toBeInstanceOf(Request);
		await expect(prepared.text()).rejects.toBeInstanceOf(BodySizeLimitError);
	});

	it('streams allowed bodies through untouched', async () => {
		const request = new Request('http://internal/upload', {
			method: 'POST',
			body: streamOf('hello ', 'world'),
			duplex: 'half'
		});
		const prepared = prepareSsrRequest(request, { bodySizeLimit: 1024 }) as Request;
		expect(await prepared.text()).toBe('hello world');
	});

	it('treats 0 and Infinity as "no limit"', () => {
		const make = () =>
			new Request('http://internal/upload', { method: 'POST', body: 'x'.repeat(100) });
		expect(prepareSsrRequest(make(), { bodySizeLimit: 0 })).toBeInstanceOf(Request);
		const unlimited = prepareSsrRequest(make(), { bodySizeLimit: Infinity });
		expect(unlimited).toBeInstanceOf(Request);
	});
});
