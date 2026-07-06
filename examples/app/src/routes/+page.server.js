/** @type {import('./$types').PageServerLoad} */
export function load() {
	return {
		marker: `ssr-marker-${Date.now()}`
	};
}
