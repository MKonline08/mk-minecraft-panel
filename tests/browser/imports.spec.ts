import { test, expect } from "@playwright/test";
test("world and modpack uploads require review and backup uploads do not restore", async ({
  page,
}) => {
  const server = {
    id: "imports",
    name: "Import test",
    type: "FABRIC",
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
  let inspected = "",
    applied: any = null,
    restores = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      p = url.pathname;
    let value: any = {};
    if (p.endsWith("/auth/status"))
      value = { authenticated: true, setup: false };
    else if (p === "/api/servers") value = [server];
    else if (p.endsWith("/workspace/settings"))
      value = { name: "MK Minecraft Panel", refreshSeconds: 5 };
    else if (p.endsWith("/system"))
      value = {
        docker: true,
        cpus: 4,
        memory: 8 * 1024 ** 3,
        usedMemory: 0,
        diskTotal: 100 * 1024 ** 3,
        diskFree: 80 * 1024 ** 3,
      };
    else if (p.endsWith("/jobs") || p.endsWith("/backups")) value = [];
    else if (p.endsWith("/import-recovery")) value = { available: false };
    else if (p.endsWith("/imports")) {
      inspected = url.searchParams.get("kind")!;
      value = {
        id: "staged",
        name: "Fixture pack",
        kind: inspected,
        format: inspected === "modpack" ? "mrpack" : "server-zip",
        runtime:
          inspected === "world"
            ? undefined
            : { type: "FABRIC", version: "1.21.1", loaderVersion: "0.16.10" },
        worlds: ["world"],
        files: [],
        warnings: [],
      };
    } else if (p.endsWith("/imports/staged/apply")) {
      applied = request.postDataJSON();
      value = { ok: true };
    } else if (p.endsWith("/restore")) {
      restores++;
      value = { ok: true };
    } else if (p === "/api/servers/imports") value = server;
    await route.fulfill({ json: value });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open Import test" }).click();
  await page.getByRole("button", { name: "World", exact: true }).click();
  await page
    .getByLabel("Choose world ZIP")
    .setInputFiles({
      name: "world.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("fixture"),
    });
  await expect(
    page.getByRole("heading", { name: "Review: Fixture pack" }),
  ).toBeVisible();
  expect(applied).toBeNull();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Confirm import" }).click();
  await expect.poll(() => applied?.world).toBe("world");
  await page.getByRole("button", { name: "Modpacks", exact: true }).click();
  applied = null;
  await page
    .getByLabel("Upload .mrpack or server / CurseForge ZIP")
    .setInputFiles({
      name: "pack.mrpack",
      mimeType: "application/zip",
      buffer: Buffer.from("fixture"),
    });
  await expect(page.getByLabel("Import loader version")).toHaveValue("0.16.10");
  await expect(
    page.getByLabel("Keep current world", { exact: false }),
  ).not.toBeChecked();
  expect(applied).toBeNull();
  await page
    .getByRole("main")
    .getByRole("button", { name: "Backups", exact: true })
    .click();
  await page
    .getByLabel("Choose backup ZIP")
    .setInputFiles({
      name: "backup.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("fixture"),
    });
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Add to backups" }).click();
  await expect.poll(() => applied?.confirm).toBe(true);
  expect(inspected).toBe("backup");
  expect(restores).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
