import { test, expect } from "@playwright/test";
test("v1.1 players, resource cards, workspace content, backup delete and settings", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const server = {
    id: "demo",
    name: "MK Friends",
    type: "PAPER",
    version: "1.21.1",
    status: "running",
    memory: 700 * 1024 ** 2,
    memoryLimit: 2,
    cpu: 5,
    players: 1,
    port: 25565,
    java: 21,
    motd: "Welcome",
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
    backupHours: 0,
    retention: 5,
    lastBackup: null,
  };
  let settings: any = {
    name: "MK Minecraft Panel",
    username: "admin",
    refreshSeconds: 5,
    defaultMemory: 2,
    defaultBackupHours: 0,
    defaultRetention: 5,
  };
  const alex = {
    id: "alex",
    uuid: null,
    name: "Alex",
    firstObserved: "2026-09-29T12:00:00Z",
    lastSeen: "2026-09-29T12:05:00Z",
  };
  const sam = { ...alex, id: "sam", name: "Sam" };
  let online = true;
  let unavailable = false;
  let backup = true;
  let deletedBackup = "";
  await page.route("**/api/auth/status", (r) =>
    r.fulfill({ json: { authenticated: true, setup: false } }),
  );
  await page.route("**/api/servers", (r) => r.fulfill({ json: [server] }));
  await page.route("**/api/jobs", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/system", (r) =>
    r.fulfill({
      json: {
        docker: true,
        cpus: 4,
        memory: 8 * 1024 ** 3,
        usedMemory: server.memory,
        allocated: 2,
        cpu: 5,
        diskTotal: 100 * 1024 ** 3,
        diskFree: 80 * 1024 ** 3,
        architecture: "x86_64",
      },
    }),
  );
  await page.route("**/api/workspace/settings", (r) => {
    if (r.request().method() === "PUT")
      settings = { ...settings, ...r.request().postDataJSON() };
    return r.fulfill({ json: settings });
  });
  await page.route("**/api/servers/demo/storage", (r) =>
    r.fulfill({
      json: {
        serverBytes: 2 * 1024 ** 3,
        backupBytes: 1024 ** 3,
        updatedAt: "2026-09-29T12:05:00Z",
      },
    }),
  );
  await page.route("**/api/servers/demo/players", (r) =>
    r.fulfill({
      json: {
        status: unavailable ? "unavailable" : "ready",
        error: unavailable ? "Connection lost" : null,
        online: online ? [alex] : [],
        history: [alex, sam],
        whitelist: [],
        ops: [],
        updatedAt: "2026-09-29T12:05:00Z",
      },
    }),
  );
  await page.route("**/api/workspace/content?*", (r) => {
    const kind = new URL(r.request().url()).searchParams.get("kind");
    return r.fulfill({
      json: {
        groups: [
          {
            serverId: server.id,
            serverName: server.name,
            type: server.type,
            status: server.status,
            items:
              kind === "worlds"
                ? [{ name: "world", bytes: 1024 ** 3 }]
                : kind === "mods"
                  ? [
                      {
                        name: "example-plugin.jar",
                        size: 2000,
                        kind: "Plugin",
                        enabled: true,
                        compatibility: "Unknown",
                      },
                    ]
                  : backup
                    ? [
                        {
                          name: "saved-world.zip",
                          size: 1024 ** 3,
                          createdAt: "2026-09-29T12:00:00Z",
                        },
                      ]
                    : [],
          },
        ],
      },
    });
  });
  await page.route("**/api/servers/demo/backup/saved-world.zip", (r) => {
    deletedBackup = r.request().method();
    backup = false;
    return r.fulfill({ json: { id: "backup-job", status: "queued" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open MK Friends" }).click();
  await expect(page.getByText("RAM in use", { exact: true })).toBeVisible();
  await expect(page.getByText("Server files", { exact: true })).toBeVisible();
  await page.screenshot({
    path: `docs/screenshots/resources-${info.project.name}.png`,
    animations: "disabled",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Players", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Online now/ })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Everyone who has joined/ }),
  ).toBeVisible();
  await expect(page.getByText("Sam", { exact: true })).toBeVisible();
  await page.screenshot({
    path: `docs/screenshots/players-${info.project.name}.png`,
    animations: "disabled",
    fullPage: true,
  });
  await page.getByLabel("Search players").fill("Sam");
  await expect(page.getByText("Alex", { exact: true })).toHaveCount(0);
  await page.getByLabel("Search players").fill("");
  online = false;
  await expect(page.getByText("Nobody is online right now.")).toBeVisible({
    timeout: 10000,
  });
  unavailable = true;
  await expect(
    page.getByText("Live player information is unavailable."),
  ).toBeVisible({ timeout: 10000 });
  const nav = async (name: string) => {
    if (info.project.name === "mobile")
      await page.getByRole("button", { name: "Open navigation" }).click();
    await page
      .locator("aside nav")
      .getByRole("button", { name, exact: true })
      .click();
  };
  for (const name of ["Worlds", "Mods & Plugins", "Backups"]) {
    await nav(name);
    await expect(page.locator(".server-card")).toHaveCount(0);
    await expect(page.getByLabel("Filter by server")).toBeVisible();
    await expect(page.locator(".content-item")).toHaveCount(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
  }
  await page.screenshot({
    path: `docs/screenshots/workspace-backups-${info.project.name}.png`,
    animations: "disabled",
    fullPage: true,
  });
  expect(await page.locator(".content-group").evaluate(el => el.getBoundingClientRect().right <= innerWidth)).toBeTruthy();
  await page
    .getByRole("button", {
      name: "Delete backup saved-world.zip from MK Friends",
    })
    .click();
  await page.getByRole("button", { name: "Delete this backup" }).click();
  await expect.poll(() => deletedBackup).toBe("DELETE");
  await expect(page.getByText("No backups yet.")).toBeVisible();
  await nav("Settings");
  await page.getByLabel("Workspace name", { exact: true }).fill("MK Updated");
  await page.getByLabel("Default RAM for new servers (GB)").fill("3");
  await page.getByRole("button", { name: "Save workspace settings" }).click();
  await expect.poll(() => settings.name).toBe("MK Updated");
  await expect(page.locator(".workspace-label")).toHaveText("MK Updated");
  await page.screenshot({
    path: `docs/screenshots/workspace-settings-${info.project.name}.png`,
    animations: "disabled",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});
