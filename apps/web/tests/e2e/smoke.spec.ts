import { test, expect } from "@playwright/test";

test("dashboard shows inline capture form", async ({ page }) => {
  await page.goto("/");
  const topNav = page.getByRole("navigation").first();
  await expect(page.getByText("タイムライン")).toBeVisible();
  await expect(page.getByText("OpenAI API利用")).toHaveCount(0);
  await expect(topNav.getByRole("link", { name: "料金" })).toBeVisible();
  await expect(topNav.getByRole("link", { name: "解析履歴" })).toBeVisible();
  await expect(page.getByLabel("入力タイプ")).toBeVisible();
  await expect(page.getByLabel("入力内容")).toBeVisible();
  await expect(page.getByLabel("Sensitivity")).toHaveCount(0);
  await expect(page.getByText("タイトル")).toHaveCount(0);

  await page.goto("/capture");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByLabel("入力タイプ")).toBeVisible();

  await page.goto("/insights");
  await expect(page.getByText("OpenAI API利用")).toBeVisible();
  await expect(page.getByRole("button", { name: "解析履歴へ" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "解析履歴" })).toHaveCount(0);

  await page.goto("/analysis-history");
  await expect(page.getByRole("heading", { name: "解析履歴" })).toBeVisible();
});
