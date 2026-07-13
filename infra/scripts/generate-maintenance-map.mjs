#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..");
const outputDir = join(repoRoot, "docs", "maintenance", "generated");
const generatedNotice = "> 自动生成文件。运行 `npm run docs:maintenance` 更新，不要手工编辑本目录内容。\n";

const ignoredDirs = new Set([
  ".git",
  ".next",
  ".turbo",
  "dist",
  "generated",
  "node_modules",
  "coverage",
  "__pycache__"
]);

await mkdir(outputDir, { recursive: true });

const apiRoutes = await collectApiRoutes();
const webPages = await collectWebPages();
const packages = await collectPackages();
const envVars = await collectEnvVars();

await writeFile(join(outputDir, "api-routes.md"), renderApiRoutes(apiRoutes), "utf8");
await writeFile(join(outputDir, "web-pages.md"), renderWebPages(webPages), "utf8");
await writeFile(join(outputDir, "package-map.md"), renderPackageMap(packages), "utf8");
await writeFile(join(outputDir, "env-vars.md"), renderEnvVars(envVars), "utf8");

process.stdout.write(
  `[maintenance-map] generated ${apiRoutes.length} api routes, ${webPages.length} pages, ${packages.length} packages, ${envVars.length} env vars\n`
);

async function collectApiRoutes() {
  const apiMain = join(repoRoot, "apps", "api", "src", "main.ts");
  const source = await readFile(apiMain, "utf8");
  const lines = source.split(/\r?\n/);
  const routes = [];
  const routePattern = /app\.(get|post|patch|delete)\("([^"]+)"/g;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const match of line.matchAll(routePattern)) {
      routes.push({
        method: match[1].toUpperCase(),
        path: match[2],
        file: toRepoPath(apiMain),
        line: index + 1
      });
    }
  }

  return routes.sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method));
}

async function collectWebPages() {
  const appDir = join(repoRoot, "apps", "web", "app");
  const pageFiles = (await walk(appDir)).filter((file) => file.endsWith(`${sep}page.tsx`));

  return pageFiles
    .map((file) => ({
      route: pageRouteFromFile(file, appDir),
      file: toRepoPath(file)
    }))
    .sort((left, right) => left.route.localeCompare(right.route));
}

async function collectPackages() {
  const packagesDir = join(repoRoot, "packages");
  const packageDirs = await readdir(packagesDir, { withFileTypes: true });
  const results = [];

  for (const entry of packageDirs) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageJsonPath = join(packagesDir, entry.name, "package.json");
    const raw = await readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(raw);
    results.push({
      name: pkg.name ?? entry.name,
      version: pkg.version ?? "-",
      main: pkg.main ?? "-",
      packagePath: toRepoPath(packageJsonPath),
      sourcePath: toRepoPath(join(packagesDir, entry.name, "src", "index.ts"))
    });
  }

  return results.sort((left, right) => left.name.localeCompare(right.name));
}

async function collectEnvVars() {
  const roots = ["apps", "packages", "infra"].map((name) => join(repoRoot, name));
  const files = [];
  for (const root of roots) {
    files.push(...(await walk(root)));
  }

  const envMap = new Map();
  const envPatterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /env(?:String|Number|Bool)\("([A-Z][A-Z0-9_]*)"/g,
    /requireProductionSetting\("([A-Z][A-Z0-9_]*)"/g
  ];

  for (const file of files.filter((item) => /\.(ts|tsx|mjs|js)$/.test(item))) {
    const source = await readFile(file, "utf8");
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      for (const pattern of envPatterns) {
        pattern.lastIndex = 0;
        for (const match of lines[index].matchAll(pattern)) {
          const name = match[1];
          if (!envMap.has(name)) {
            envMap.set(name, []);
          }
          envMap.get(name).push({ file: toRepoPath(file), line: index + 1 });
        }
      }
    }
  }

  return [...envMap.entries()]
    .map(([name, refs]) => ({
      name,
      refs: dedupeRefs(refs).sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function renderApiRoutes(routes) {
  const rows = routes.map((route) => `| ${route.method} \`${route.path}\` | \`${route.file}:${route.line}\` |`);
  return ["# API 路由地图", "", generatedNotice, "| 路由 | 定义位置 |", "| --- | --- |", ...rows, ""].join("\n");
}

function renderWebPages(pages) {
  const rows = pages.map((page) => `| \`${page.route}\` | \`${page.file}\` |`);
  return ["# Web 页面地图", "", generatedNotice, "| 页面路由 | 文件 |", "| --- | --- |", ...rows, ""].join("\n");
}

function renderPackageMap(packages) {
  const rows = packages.map(
    (pkg) => `| \`${pkg.name}\` | \`${pkg.version}\` | \`${pkg.main}\` | \`${pkg.sourcePath}\` |`
  );
  return [
    "# Workspace 包地图",
    "",
    generatedNotice,
    "| 包 | 版本 | 入口 | 源码入口 |",
    "| --- | --- | --- | --- |",
    ...rows,
    ""
  ].join("\n");
}

function renderEnvVars(envVars) {
  const rows = envVars.map((envVar) => {
    const refs = envVar.refs.map((ref) => `\`${ref.file}:${ref.line}\``).join("<br>");
    return `| \`${envVar.name}\` | ${refs} |`;
  });
  return ["# 环境变量引用地图", "", generatedNotice, "| 变量 | 引用位置 |", "| --- | --- |", ...rows, ""].join("\n");
}

async function walk(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) {
      continue;
    }
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function pageRouteFromFile(file, appDir) {
  const relativePath = relative(appDir, file);
  const segments = relativePath.split(sep).slice(0, -1);
  if (segments.length === 0) {
    return "/";
  }
  return `/${segments.join("/")}`;
}

function dedupeRefs(refs) {
  const seen = new Set();
  const result = [];
  for (const ref of refs) {
    const key = `${ref.file}:${ref.line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function toRepoPath(file) {
  return relative(repoRoot, file).split(sep).join("/");
}
