import adapter from '@medicomind/svelte-adapter-hono';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter({
			out: 'build',
			precompress: true
		})
	}
};

export default config;
