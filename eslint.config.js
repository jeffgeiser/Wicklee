// ESLint flat config.
//
// `npm run lint` had pointed at this file for months without it existing —
// eslint was not even a devDependency — so nothing enforced the hooks rules
// on a 40k-line, hooks-heavy frontend. This config is deliberately small:
//
//   - @eslint/js recommended        plain-JS correctness
//   - typescript-eslint recommended  TS-aware equivalents (no type-checked
//                                    rules: those need a tsconfig project and
//                                    roughly 10× the lint time; revisit if the
//                                    signal is worth it)
//   - react-hooks recommended        rules-of-hooks + exhaustive-deps — the one
//                                    rule class tsc cannot catch and the reason
//                                    this file exists
//
// Warnings fail CI (`--max-warnings 0`), so every rule here is one we mean.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'agent/frontend/dist/**',
      'dist-demo/**',
      'node_modules/**',
      'public/**',
      'cloud/**',
      'agent/**',
      'deploy/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Application source — browser globals.
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // ── Deferred, deliberately ───────────────────────────────────────────
      // eslint-plugin-react-hooks v7 "recommended" ships the React Compiler
      // rule set. Turning it on here produced 131 findings across the
      // dashboard (45 set-state-in-effect, 34 refs, 26 static-components,
      // 25 purity, 1 immutability, 1 preserve-manual-memoization). They are
      // real — static-components in particular means components defined
      // inside render, remounting every frame — but fixing them is a
      // refactor of the state model, not a lint pass. Tracked as roadmap
      // "Code Health" item 2 (Overview.tsx decomposition). Off, not warn:
      // 131 permanent warnings would train everyone to ignore the column.
      'react-hooks/set-state-in-effect':          'off',
      'react-hooks/refs':                         'off',
      'react-hooks/static-components':            'off',
      'react-hooks/purity':                       'off',
      'react-hooks/immutability':                 'off',
      'react-hooks/preserve-manual-memoization':  'off',

      // ── Warn: visible, not blocking ──────────────────────────────────────
      // 8 findings at time of writing. Two look like real bugs (AIInsights
      // missing `allNodeMetrics`, TracesView missing `fetchTraces`) and are
      // called out in the PR; blind auto-inclusion of deps can create render
      // loops, so each one is a judgment call. Promote to error once the 8
      // are triaged.
      'react-hooks/exhaustive-deps': 'warn',

      // 37 unused locals/params remain after the unused-*import* pass (49
      // specifiers removed, tsc-verified). Locals need reading, not a codemod.
      // An underscore prefix is the opt-out for intentionally-unused fields.
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],

      // 9 `any`s, all at JSON boundaries. New ones get a second look.
      '@typescript-eslint/no-explicit-any': 'warn',

      // 22 escapes in regex/strings that are harmless; 10 empty catch blocks
      // that are the intended "swallow and fall back" pattern.
      'no-useless-escape': 'warn',
      'no-empty':          ['warn', { allowEmptyCatch: true }],
    },
  },

  // Build scripts and config — Node globals, plain JS/TS.
  {
    files: ['scripts/**/*.mjs', 'vite.config.ts', 'eslint.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Tests — vitest injects its globals only when configured to; the test
  // files import from 'vitest' explicitly, so browser + node is enough.
  {
    files: ['src/**/__tests__/**/*.ts', 'src/**/*.test.ts'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
);
