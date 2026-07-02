import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/*.tsbuildinfo",
      "**/next-env.d.ts",
      "packages/database/prisma/generated/**",
      "packages/database/generated/**",
      "apps/web/.next/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module"
    },
    rules: {
      // 占位骨架里大量参数预留未用，统一用下划线前缀豁免，避免误报
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }
      ],
      // 业务里少量 unknown/any 边界（外部 payload、provider raw）先降级为告警，不阻断门禁
      "@typescript-eslint/no-explicit-any": "warn"
    }
  },
  {
    // 脚本和测试是纯 Node ESM，提供 node 运行时全局，放宽未用变量
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        fetch: "readonly",
        Buffer: "readonly",
        crypto: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        Response: "readonly"
      }
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "off"
    }
  },
  prettier
);
