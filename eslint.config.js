// CRV · ESLint (PHASES E11). `npm run lint` corre esto; `npm run typecheck`
// sigue siendo tsc. Las reglas con información de tipos que se activan aquí
// apuntan a defectos reales de un backend con transacciones: una promesa sin
// await deja un COMMIT/ROLLBACK corriendo fuera de su cliente.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**", "**/dist/**", "build/**", "coverage/**",
      "data/**", "backups/**", "public/**", "tmp-analysis/**",
      "web/tests/artifacts/**", "docs/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // Parámetros y variables de desestructuración con _ son intencionales.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true }],
      "no-console": "off",
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: {
          // Configuración de herramientas que ningún tsconfig incluye.
          allowDefaultProject: ["vitest.config.ts", "web/vite.config.ts", "web/tests/visual/*.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
      "@typescript-eslint/await-thenable": "error",
    },
  },
  {
    // El código de biblioteca registra con pino (src/logger); solo la CLI
    // escribe en la terminal. Scripts y tests quedan libres.
    files: ["src/**/*.ts", "web/src/**/*.{ts,tsx}"],
    ignores: ["src/cli/**"],
    rules: { "no-console": "error" },
  },
  {
    files: ["web/src/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["web/tests/**/*.{js,mjs,ts}", "web/server.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
