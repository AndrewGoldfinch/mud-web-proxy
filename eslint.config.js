import globals from 'globals';
import eslintJsonc from 'eslint-plugin-jsonc';
// Namespace import, not default: jsonc-eslint-parser v3 dropped its default
// export. ESLint only needs the parseForESLint/parse pair, which the module
// namespace exposes under both v2 and v3.
import * as eslintJsoncParser from 'jsonc-eslint-parser';
import prettier from 'eslint-plugin-prettier';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    // global ignores
    // folders can only be ignored at the global level, per-cfg you must do: '**/dist/**/*'
    ignores: [
      '**/public/',
      '**/dist/',
      '**/types/',
      '**/wsproxy.js',
      '**/.claude/**',
      '**/.agents/**',
      '**/.codex/**',
      '**/.cursor/**',
      '**/.continue/**',
      '**/.aider*',
      '**/CLAUDE.local.md',
    ],
  },
  // general defaults
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      'prettier/prettier': [
        'error',
        {},
        {
          usePrettierrc: true,
        },
      ],
      'no-console': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
    plugins: {
      prettier,
    },
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
      parserOptions: {
        // Lint-only project: same settings, plus tests. See tsconfig.eslint.json.
        project: './tsconfig.eslint.json',
      },
    },
  },
  {
    // CI scripts are command-line tools: their console output is the
    // interface, not a leftover debug statement. srv.log() is a server
    // concern and is not reachable from here.
    files: ['scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.json'],
    ignores: ['**/package.json', '**/package-lock.json'],
    plugins: {
      jsonc: eslintJsonc,
      prettier,
    },
    languageOptions: {
      parser: eslintJsoncParser,
      parserOptions: {
        jsonSyntax: 'JSON',
      },
    },
    rules: {
      'prettier/prettier': [
        'error',
        {},
        {
          usePrettierrc: true,
        },
      ],
      'no-console': 'warn',
    },
  },
  {
    // Test *harness* files are programs, not tests: mock MUD servers, the
    // proxy launcher, and the acceptance clients. Their console output is
    // the interface, exactly as for scripts/ above, and srv.log is not
    // reachable from any of them.
    //
    // Scoped to harness files rather than all of tests/. Review on #121
    // was right that blanketing tests/ would silently drop the repo-wide
    // policy AGENTS.md states, inside a PR whose whole point is widening
    // lint coverage. Real .test.ts files keep `no-console: warn`.
    files: ['tests/**/*.ts'],
    ignores: ['tests/**/*.test.ts'],
    rules: {
      'no-console': 'off',
    },
  },
];
