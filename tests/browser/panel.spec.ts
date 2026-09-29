import { test, expect } from "@playwright/test";
test("onboarding, dashboard, responsive navigation, and wizard", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByLabel("Username")).toBeVisible();
  await page.getByLabel("Username").fill("browser-admin");
  await page
    .getByLabel("Password", { exact: true })
    .fill("browser-test-password-123");
  await page
    .getByRole("button", { name: /Create administrator|Sign in/, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Dashboard", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create your first server" }),
  ).toBeVisible();
  await page.screenshot({
    path: `docs/screenshots/dashboard-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Create your first server" }).click();
  await expect(
    page.getByRole("heading", { name: "Create your server" }),
  ).toBeVisible();
  await page.getByLabel("Server name", { exact: true }).fill("MK Survival");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByLabel("Minecraft version", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `docs/screenshots/create-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  if (testInfo.project.name === "mobile")
    await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Workspace settings" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});
