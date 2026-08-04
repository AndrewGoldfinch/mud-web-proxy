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
    // Tests are linted, but they are not production source.
    //
    // They were excluded entirely until now, which left CodeQL as the only
    // thing checking them — and CodeQL and ESLint each catch unused code the
    // other misses, so neither alone was enough. Four tests that could not
    // fail reached main behind this gap.
    //
    // `no-console` is off rather than warned: test helpers and the mock MUD
    // log deliberately, and 64 warnings nobody can action is how a linter
    // gets ignored. The `srv.log` convention it enforces is about production
    // logging, which tests do not do.
    files: ['tests/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
];
