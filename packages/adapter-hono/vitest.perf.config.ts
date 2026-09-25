import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		fileParallelism: false,
		include: ['tests/perf/**/*.test.ts'],
		testTimeout: 60_000,
		hookTimeout: 120_000
	}
});
