import { test, expect } from "@playwright/test";

test("dashboard and capture pages load", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Timeline Dashboard")).toBeVisible();

  await page.goto("/capture/journal");
  await expect(page.getByText("Journal")).toBeVisible();

  await page.goto("/sync");
  await expect(page.getByText("Manual Sync Queue")).toBeVisible();
});
