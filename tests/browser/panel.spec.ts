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

test("populated dashboard, appearance editor and console render on desktop and phone", async ({
  page,
}, testInfo) => {
  const example = {
    id: "example-server",
    name: "MK Survival · Demo",
    type: "PAPER",
    version: "1.21.1",
    status: "running",
    memory: 1.5 * 1024 ** 3,
    memoryLimit: 4,
    cpu: 12,
    players: 3,
    port: 25565,
    java: 21,
    motd: "§bMK Survival\n§dYour next adventure",
    banner: false,
    icon: false,
    settings: {
      difficulty: "normal",
      gamemode: "survival",
      maxPlayers: 20,
      viewDistance: 10,
      pvp: true,
      whitelist: false,
    },
    backupHours: 24,
    retention: 5,
    lastBackup: null,
  };
  const examples = [
    example,
    {
      ...example,
      id: "example-fabric",
      name: "Modded Adventure · Demo",
      type: "FABRIC",
      status: "stopped",
      memory: 0,
      cpu: 0,
      players: 0,
    },
    {
      ...example,
      id: "example-creative",
      name: "Creative · Demo",
      type: "PURPUR",
      port: 25567,
      players: 2,
    },
  ];
  await page.route("**/api/servers", (route) =>
    route.fulfill({ json: examples }),
  );
  await page.route("**/api/system", (route) =>
    route.fulfill({
      json: {
        docker: true,
        cpus: 8,
        memory: 16 * 1024 ** 3,
        usedMemory: 3 * 1024 ** 3,
        allocated: 12,
        cpu: 12,
        diskTotal: 256 * 1024 ** 3,
        diskFree: 180 * 1024 ** 3,
        architecture: "x86_64",
      },
    }),
  );
  await page.route("**/api/jobs", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/servers/example-server/logs", (route) =>
    route.fulfill({
      json: {
        text: 'Example console fixture\n[Server thread/INFO]: Done! For help, type "help"',
      },
    }),
  );
  let saved: any;
  await page.route("**/api/servers/example-server/appearance", (route) => {
    saved = route.request().postDataJSON();
    return route.fulfill({ json: { server: example, restartRequired: true } });
  });
  await page.goto("/");
  await page.getByLabel("Username").fill("browser-admin");
  await page
    .getByLabel("Password", { exact: true })
    .fill("browser-test-password-123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "MK Survival · Demo" }),
  ).toBeVisible();
  await page.screenshot({
    path: `docs/screenshots/example-dashboard-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Open MK Survival · Demo" }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page
    .getByLabel("Message of the day", { exact: true })
    .fill("§bWelcome to MK!\n§dBuild something great.");
  await page.getByRole("button", { name: "Save appearance" }).click();
  await expect.poll(() => saved?.motd).toContain("Welcome to MK!");
  await page.screenshot({
    path: `docs/screenshots/appearance-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Console", exact: true }).click();
  await expect(page.locator("pre.console")).toContainText("Done!");
  let savedSettings: any;
  await page.route("**/api/servers/example-fabric/settings", (route) => {
    savedSettings = route.request().postDataJSON();
    return route.fulfill({ json: examples[1] });
  });
  await page.getByRole("button", { name: "All servers" }).click();
  await page.getByRole("button", { name: "Open Modded Adventure · Demo" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).last().click();
  await expect(page.getByText("Server memory: 4 GB")).toBeVisible();
  await page.getByRole("slider").fill("2");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect.poll(() => savedSettings?.memory).toBe(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
