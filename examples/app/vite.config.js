import adapter from '@medicomind/svelte-adapter-hono';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			adapter: adapter({
				out: 'build',
				precompress: true
			})
		})
	]
});
