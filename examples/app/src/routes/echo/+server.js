/**
 * Echoes the received body size; used by the BODY_SIZE_LIMIT e2e test.
 * @type {import('./$types').RequestHandler}
 */
export async function POST({ request }) {
	const body = await request.arrayBuffer();
	return new Response(String(body.byteLength));
}
