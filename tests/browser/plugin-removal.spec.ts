import { test, expect } from "@playwright/test";

test("remove a plugin with confirmation on desktop and mobile", async ({
  page,
}) => {
  const server = {
    id: "remove-demo",
    name: "MK Plugins",
    type: "PAPER",
    version: "1.21.1",
    status: "stopped",
    memory: 0,
    memoryLimit: 2,
    cpu: 0,
    players: 0,
    port: 25565,
    java: 21,
    motd: "Welcome",
    banner: false,
    icon: false,
    backupHours: 0,
    retention: 5,
    lastBackup: null,
    settings: {},
  };
  let files = [
    "FastLogin.jar",
    "AuthMe.jar",
    "VeryLongPluginFilename-to-check-the-mobile-layout.jar.disabled",
  ];
  let deletes = 0;
  await page.route("**/api/**", async (r) => {
    const url = new URL(r.request().url());
    let value: any = {};
    if (url.pathname.endsWith("/auth/status"))
      value = { authenticated: true, setup: false };
    else if (url.pathname === "/api/servers") value = [server];
    else if (url.pathname.endsWith("/workspace/settings"))
      value = {
        name: "MK Minecraft Panel",
        username: "admin",
        refreshSeconds: 5,
      };
    else if (url.pathname.endsWith("/jobs")) value = [];
    else if (url.pathname.endsWith("/system"))
      value = {
        docker: true,
        cpus: 4,
        memory: 8 * 1024 ** 3,
        diskTotal: 100,
        diskFree: 80,
        usedMemory: 0,
        allocated: 0,
        cpu: 0,
      };
    else if (url.pathname.endsWith("/mods")) {
      if (r.request().method() === "DELETE") {
        expect(url.pathname).toBe("/api/servers/remove-demo/mods");
        files = files.filter((f) => f !== url.searchParams.get("name"));
        deletes++;
        value = { ok: true };
      } else value = files;
    }
    await r.fulfill({ json: value });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open MK Plugins" }).click();
  await page.getByRole("button", { name: "Mods/Plugins", exact: true }).click();
  const remove = page.getByRole("button", {
    name: "Remove FastLogin.jar",
    exact: true,
  });
  page.once("dialog", async (d) => {
    expect(d.message()).toContain("MK Plugins");
    await d.dismiss();
  });
  await remove.click();
  expect(deletes).toBe(0);
  page.once("dialog", async (d) => {
    expect(d.message()).toContain("saved data folders will stay");
    await d.accept();
  });
  await remove.click();
  await expect(remove).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Remove AuthMe.jar", exact: true }),
  ).toBeVisible();
  expect(deletes).toBe(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
