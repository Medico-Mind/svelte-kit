/**
 * Slow endpoint used by the graceful-shutdown e2e test.
 * @type {import('./$types').RequestHandler}
 */
export async function GET() {
	await new Promise((resolve) => setTimeout(resolve, 1500));
	return new Response('slow-done');
}
