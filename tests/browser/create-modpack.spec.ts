import { test, expect } from "@playwright/test";
test("create a stopped server with an uploaded pack and review missing files", async ({
  page,
}) => {
  let created = false,
    uploadCount = 0,
    startCount = 0;
  const server = {
    id: "new-pack",
    name: "Pack server",
    type: "PAPER",
    version: "1.21.1",
    status: "stopped",
    memory: 0,
    memoryLimit: 2,
    cpu: 0,
    players: 0,
    port: 25565,
    java: 21,
    motd: "Hi",
    banner: false,
    icon: false,
    backupHours: 0,
    retention: 5,
    lastBackup: null,
    settings: {
      difficulty: "normal",
      gamemode: "survival",
      maxPlayers: 20,
      viewDistance: 10,
      pvp: true,
      whitelist: false,
    },
  };
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      p = url.pathname;
    let value: any = {};
    if (p.endsWith("/auth/status"))
      value = { authenticated: true, setup: false };
    else if (p === "/api/servers") {
      if (req.method() === "POST") {
        expect(req.postDataJSON().autoStart).toBe(false);
        created = true;
        value = { server };
      } else value = created ? [server] : [];
    } else if (p.endsWith("/workspace/settings"))
      value = {
        name: "MK Minecraft Panel",
        refreshSeconds: 5,
        defaultMemory: 2,
      };
    else if (p.endsWith("/system"))
      value = {
        docker: true,
        cpus: 4,
        memory: 8 * 1024 ** 3,
        usedMemory: 0,
        diskTotal: 100 * 1024 ** 3,
        diskFree: 80 * 1024 ** 3,
      };
    else if (p.endsWith("/jobs")) value = [];
    else if (p.endsWith("/catalog"))
      value = {
        versions: ["1.21.1"],
        types: [{ type: "PAPER", available: true }],
      };
    else if (p.endsWith("/imports")) {
      uploadCount++;
      value = {
        id: "staged",
        name: "Example pack",
        format: "mrpack",
        runtime: {
          type: "FABRIC",
          version: "1.21.1",
          loaderVersion: "0.16.10",
        },
        worlds: [],
        warnings: [],
        files: [
          { path: "mods/missing.jar", urls: [], optional: false },
          {
            path: "mods/available.jar",
            urls: ["https://cdn.modrinth.com/file"],
            optional: false,
          },
        ],
      };
    } else if (p.endsWith("/actions")) {
      startCount++;
      value = { ok: true };
    } else if (p.endsWith("/import-recovery")) value = { available: false };
    else if (p.endsWith("/modpack-settings"))
      value = { curseforgeConfigured: false };
    else if (p === "/api/servers/new-pack") value = server;
    await route.fulfill({ json: value });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Create your first server" }).click();
  await page.getByLabel("Server name", { exact: true }).fill("Pack server");
  await page.getByLabel("Set up for a modpack", { exact: false }).check();
  await page.getByLabel("Modpack archive for new server").setInputFiles({
    name: "pack.mrpack",
    mimeType: "application/zip",
    buffer: Buffer.from("fixture"),
  });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("I have read and accept the", { exact: false }).check();
  await page
    .getByRole("button", { name: "Create server", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review: Example pack" }),
  ).toBeVisible();
  expect(uploadCount).toBe(1);
  expect(startCount).toBe(0);
  await expect(page.getByText("Missing file: mods/missing.jar")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm import" }),
  ).toBeDisabled();
  await expect(
    page.getByText("Upload all selected missing files", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Optional replacement: mods/available.jar"),
  ).toBeHidden();
  await page
    .getByText("Manual replacement for downloadable files", { exact: false })
    .click();
  await expect(
    page.getByText("Optional replacement: mods/available.jar"),
  ).toBeVisible();
});
