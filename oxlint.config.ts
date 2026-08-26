import { defineConfig } from "oxlint";

/**
 * Mirrors infralytics-cfe's oxlint config, minus the parts that only make sense
 * in a turborepo (workspace ignore paths, the testing-library and
 * you-might-not-need-an-effect JS plugins this package has no use for).
 *
 * `--type-check` runs tsgolint, so `npm run lint` is the type check too; there
 * is no separate tsc/tsgo step in CI, same as cfe.
 */
export default defineConfig({
  categories: {
    correctness: "error",
    suspicious: "error",
    restriction: "warn",
    perf: "warn",
  },
  env: {
    browser: true,
    builtin: true,
    vitest: true,
  },
  ignorePatterns: ["dist/", "node_modules/", "package-lock.json"],
  options: {
    maxWarnings: 0,
    typeAware: true,
    typeCheck: true,
  },
  plugins: ["eslint", "oxc", "typescript", "unicorn", "react", "vitest"],
  rules: {
    complexity: "off",
    "default-case": "off",
    "no-array-for-each": "off",
    "no-array-reduce": "off",
    "no-async-await": "off",
    // cfe allows only `console.error`. This package also warns — exactly once,
    // when a batch is dropped because the server rejected its schema. That is a
    // bug on the client's side and a silent drop would be worse than the log.
    "no-console": ["warn", { allow: ["error", "warn"] }],
    "no-map-spread": "off",
    "no-optional-chaining": "off",
    "no-plusplus": ["warn", { allowForLoopAfterthoughts: true }],
    "no-rest-spread-properties": "off",
    "no-undefined": "off",
    "no-underscore-dangle": "off",
    "no-unused-vars": [
      "warn",
      {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      },
    ],
    "no-use-before-define": [
      "warn",
      {
        allowNamedExports: false,
        classes: true,
        enums: true,
        // Mimics the old ESLint "nofunc" option.
        functions: false,
        ignoreTypeReferences: true,
        typedefs: true,
        variables: true,
      },
    ],
    "no-void": "off",
    "react/forbid-component-props": "off",
    "react/jsx-filename-extension": ["warn", { extensions: [".tsx"] }],
    "react/no-multi-comp": "off",
    // Fast Refresh boundaries are a concern for application code. This is a
    // published library: consumers import it from node_modules, where Fast
    // Refresh does not apply, and splitting `useTraffic` into its own module
    // purely to satisfy the rule would buy nothing.
    "react/only-export-components": "off",
    "react/react-in-jsx-scope": "off",
    "typescript/explicit-function-return-type": "off",
    "typescript/explicit-member-accessibility": "off",
    "typescript/explicit-module-boundary-types": "off",
    "typescript/no-explicit-any": "warn",
    "typescript/no-unsafe-type-assertion": "off",
    "typescript/non-nullable-type-assertion-style": "off",
    "typescript/restrict-template-expressions": ["error", { allowArray: true }],
    "vitest/require-test-timeout": "off",
  },
  settings: {
    react: {
      version: "19.2.0",
    },
  },
});
