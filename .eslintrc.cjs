/**
 * ESLint Configuration for Delay Tracker
 *
 * TD-DELAY-TRACKER CI-green remediation: the `lint` script has existed since
 * the repo was created but no ESLint config was ever committed, so the Lint
 * job has failed on every CI run. This adopts the platform convention
 * established in services/eligibility-engine/.eslintrc.cjs (TD-ELIGIBILITY-001).
 *
 * Configures ESLint for TypeScript with:
 * - TypeScript parser and plugin
 * - Recommended TypeScript rules
 * - ES modules support
 * - Node.js environment
 */

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: './tsconfig.json',
  },
  env: {
    node: true,
    es2022: true,
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  rules: {
    // TypeScript-specific rules
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-non-null-assertion': 'warn',

    // General code quality rules
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'prefer-const': 'error',
    'no-var': 'error',
    'eqeqeq': ['error', 'always'],

    // Import rules
    'no-duplicate-imports': 'error',
  },
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'coverage/',
    'coverage-out/',
    '*.js',
    '*.cjs',
    'vitest.config.ts',
  ],
  overrides: [
    {
      // Test files have different requirements and don't need project-aware type checking
      files: ['tests/**/*.ts'],
      parserOptions: {
        project: null, // Disable project-aware linting for test files
      },
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unused-vars': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
        'no-console': 'off',
        'no-duplicate-imports': 'off',
      },
    },
  ],
};
