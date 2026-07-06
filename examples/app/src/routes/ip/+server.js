/**
 * Returns the resolved client address; used by the e2e tests.
 * @type {import('./$types').RequestHandler}
 */
export function GET({ getClientAddress }) {
	return new Response(getClientAddress());
}
