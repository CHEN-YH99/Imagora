import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("web exposes image detail workflow from history and favorites", async () => {
  const detailPage = await readFile(join(root, "apps/web/app/images/[imageId]/page.tsx"), "utf8");
  const historyPage = await readFile(join(root, "apps/web/app/history/page.tsx"), "utf8");
  const favoritesPage = await readFile(join(root, "apps/web/app/favorites/page.tsx"), "utf8");

  assert.match(detailPage, /\/api\/images\/\$\{imageId\}/);
  assert.match(detailPage, /\/api\/generation\/tasks\/\$\{(?:image|imageResult\.image)\.taskId\}/);
  assert.match(detailPage, /download-url/);
  assert.match(detailPage, /favorite/);
  assert.match(detailPage, /再次生成/);
  assert.match(detailPage, /删除图片/);
  assert.match(historyPage, /href=\{`\/images\/\$\{image\.id\}`\}/);
  assert.match(favoritesPage, /href=\{`\/images\/\$\{image\.id\}`\}/);
});

test("web auth pages validate inputs and registration does not ask for nickname", async () => {
  const loginPage = await readFile(join(root, "apps/web/app/login/page.tsx"), "utf8");
  const registerPage = await readFile(join(root, "apps/web/app/register/page.tsx"), "utf8");

  assert.match(loginPage, /validateLoginForm/);
  assert.match(registerPage, /validateRegisterForm/);
  assert.match(registerPage, /confirmPassword/);
  assert.doesNotMatch(registerPage, /昵称/);
  assert.doesNotMatch(registerPage, /nickname/);
});
