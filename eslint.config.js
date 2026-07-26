// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Builtins that must be imported with the `node:` prefix, so a specifier is
 * unambiguously a runtime module rather than something from `node_modules`.
 */
const NODE_BUILTINS_WITHOUT_PREFIX = [
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'events',
  'fs',
  'fs/promises',
  'http',
  'https',
  'net',
  'os',
  'path',
  'process',
  'readline',
  'readline/promises',
  'stream',
  'stream/promises',
  'timers',
  'timers/promises',
  'tty',
  'url',
  'util',
  'worker_threads',
  'zlib',
];

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'ui/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /* We use `node:` builtins everywhere; enforce the prefix.
         `paths` matches a specifier exactly. `patterns` would be gitignore-style
         globbing, which also matches `./util/fsx.js` because one of its segments is
         `util` — restricting the project's own modules by accident. */
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS_WITHOUT_PREFIX.map((name) => ({
            name,
            message: 'Use the `node:` protocol (e.g. `node:fs`) for builtin modules.',
          })),
        },
      ],

      /* Consistency */
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      /* Pragmatic relaxations, each justified. */
      // Template literals over `unknown` show up constantly in CLI output paths.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: false },
      ],
      // We intentionally use `void promise` to mark deliberately un-awaited work.
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreVoidOperator: true }],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  {
    files: ['*.config.js', '*.config.ts', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
