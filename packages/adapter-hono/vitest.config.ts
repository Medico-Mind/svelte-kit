import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: [
			'tests/unit/**/*.test.ts',
			'tests/integration/**/*.test.ts',
			'tests/e2e/**/*.test.ts'
		],
		testTimeout: 30_000,
		hookTimeout: 300_000,
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			// templates are thin wiring around src/runtime, exercised end-to-end
			// in child processes (tests/integration, tests/e2e) where v8 coverage
			// cannot observe them
			exclude: ['src/files/**'],
			thresholds: {
				lines: 90,
				statements: 90
			},
			reporter: ['text', 'html', 'lcov']
		}
	}
});
