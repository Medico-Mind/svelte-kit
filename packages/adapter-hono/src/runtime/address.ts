/**
 * Client IP resolution, mirroring `adapter-node`'s `ADDRESS_HEADER` /
 * `XFF_DEPTH` semantics.
 */
export interface AddressConfig {
	/** Lowercased header name to read the client address from. */
	addressHeader?: string | undefined;
	/**
	 * When `addressHeader` is `x-forwarded-for`: how many proxies deep to look,
	 * counting from the right. Defaults to 1 (the address appended by the proxy
	 * closest to this server).
	 */
	xffDepth?: number | undefined;
}

/**
 * Validates an `XFF_DEPTH`-style value; throws unless it is a positive integer.
 */
export function validateXffDepth(depth: number): number {
	if (!Number.isInteger(depth) || depth < 1) {
		throw new Error(`XFF_DEPTH must be a positive integer, got '${depth}'`);
	}
	return depth;
}

/**
 * Resolves the client address for a request.
 *
 * When `addressHeader` is configured the header must be present; for
 * `x-forwarded-for` the address `xffDepth` entries from the right is used.
 * Without a configured header, `socketAddress()` (the TCP peer address) is
 * consulted.
 */
export function resolveClientAddress(
	headers: Headers,
	config: AddressConfig,
	socketAddress: () => string | undefined
): string {
	const { addressHeader, xffDepth = 1 } = config;

	if (addressHeader) {
		const value = headers.get(addressHeader);
		if (!value) {
			throw new Error(
				`Address header '${addressHeader}' was configured but is missing from the request`
			);
		}

		if (addressHeader === 'x-forwarded-for') {
			const addresses = value.split(',');
			validateXffDepth(xffDepth);
			if (xffDepth > addresses.length) {
				throw new Error(
					`XFF_DEPTH is ${xffDepth}, but only found ${addresses.length} address${
						addresses.length === 1 ? '' : 'es'
					}`
				);
			}
			return addresses[addresses.length - xffDepth]!.trim();
		}

		return value;
	}

	const address = socketAddress();
	if (!address) {
		throw new Error('Could not determine client address');
	}
	return address;
}
