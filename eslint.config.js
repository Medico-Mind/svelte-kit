import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import ts from 'typescript-eslint';

export default ts.config(
	{
		ignores: [
			'**/node_modules/**',
			'**/dist/**',
			'**/build/**',
			'**/coverage/**',
			'**/.svelte-kit/**',
			'**/.test-tmp/**',
			'**/*.svelte'
		]
	},
	js.configs.recommended,
	...ts.configs.recommended,
	prettier,
	{
		rules: {
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
			'@typescript-eslint/consistent-type-imports': 'error'
		}
	},
	{
		files: ['**/*.js'],
		rules: {
			'@typescript-eslint/no-require-imports': 'off'
		}
	},
	{
		// SvelteKit runtime files run on Node ≥ 20 with web globals available
		files: ['examples/**/*.js'],
		languageOptions: {
			globals: {
				Response: 'readonly',
				Request: 'readonly',
				Headers: 'readonly',
				URL: 'readonly',
				fetch: 'readonly',
				setTimeout: 'readonly',
				clearTimeout: 'readonly',
				console: 'readonly',
				process: 'readonly'
			}
		}
	}
);
