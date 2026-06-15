// Flat ESLint config for MeshMind (ESLint 9 + typescript-eslint).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["build/**", "node_modules/**", "graphify/**", "headroom/**", "last30days-skill/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // The MCP SDK + external JSON responses are dynamically typed; `any` is
      // pragmatic at those boundaries. Keep it as a warning, not an error.
      "@typescript-eslint/no-explicit-any": "off",
      // Allow intentionally-unused args when prefixed with `_`.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
);
