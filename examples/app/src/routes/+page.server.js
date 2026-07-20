/** @type {import('./$types').PageServerLoad} */
export function load() {
	return {
		marker: `ssr-marker-${Date.now()}`,
		// keeps the rendered page above the 1 KiB on-demand compression threshold
		filler: 'lorem ipsum dolor sit amet '.repeat(48)
	};
}
