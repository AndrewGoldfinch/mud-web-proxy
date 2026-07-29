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
      '**/tests/',
      '**/types/',
      '**/wsproxy.js',
      '**/*.test.ts',
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
        project: './tsconfig.json',
      },
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
];
