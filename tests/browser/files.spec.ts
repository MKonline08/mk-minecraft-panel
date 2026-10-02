import { test, expect } from "@playwright/test";

test("server files edit properties, upload replacements and create nested files on desktop and phone", async ({
  page,
}, info) => {
  const server = {
    id: "file-demo",
    name: "MK Files · Demo",
    type: "VANILLA",
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
    settings: {
      difficulty: "normal",
      gamemode: "survival",
      maxPlayers: 20,
      viewDistance: 10,
      pvp: true,
      whitelist: false,
    },
  };
  const files: Record<string, string> = {
    "server.properties": "online-mode=true\nmax-players=20\n",
    ".custom": "hidden=value",
    "plugin.jar": "",
  };
  let uploaded = "";
  await page.route("**/api/**", async (r) => {
    const url = new URL(r.request().url());
    const p = url.pathname;
    let value: any = {};
    if (p.endsWith("/auth/status"))
      value = { authenticated: true, setup: false };
    else if (p === "/api/servers") value = [server];
    else if (p.endsWith("/workspace/settings"))
      value = {
        name: "MK Minecraft Panel",
        username: "admin",
        refreshSeconds: 5,
        defaultMemory: 2,
        defaultBackupHours: 0,
        defaultRetention: 5,
      };
    else if (p.endsWith("/jobs")) value = [];
    else if (p.endsWith("/system"))
      value = {
        docker: true,
        cpus: 4,
        memory: 8 * 1024 ** 3,
        usedMemory: 0,
        cpu: 0,
        diskTotal: 100 * 1024 ** 3,
        diskFree: 80 * 1024 ** 3,
      };
    else if (p.endsWith("/storage"))
      value = {
        serverBytes: 3000,
        backupBytes: 0,
        updatedAt: new Date().toISOString(),
      };
    else if (p.endsWith("/files"))
      value = Object.keys(files).map((name) => ({ name, directory: false }));
    else if (p.endsWith("/files/upload")) {
      uploaded = r.request().postData() || "";
      value = { ok: true };
    } else if (p.endsWith("/file")) {
      if (r.request().method() === "PUT") {
        const b = r.request().postDataJSON();
        files[b.path] = b.text;
        value = { ok: true };
      } else {
        const name = url.searchParams.get("path")!;
        value =
          name === "plugin.jar"
            ? {
                text: "",
                readOnly: true,
                reason:
                  "This is a binary file. Download it to edit, then upload its replacement.",
              }
            : { text: files[name], readOnly: false };
      }
    }
    await r.fulfill({ json: value });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open MK Files · Demo" }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page
    .getByRole("button", { name: "server.properties", exact: true })
    .click();
  await page
    .getByLabel("File contents")
    .fill("online-mode=false\nmax-players=42\n");
  await page.getByRole("button", { name: "Save file", exact: true }).click();
  await expect
    .poll(() => files["server.properties"])
    .toContain("online-mode=false");
  await page.screenshot({
    path: `docs/screenshots/files-editor-${info.project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Close file" }).click();
  await page
    .getByLabel("Upload files", { exact: true })
    .setInputFiles({
      name: "plugin.jar",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("arbitrary upload"),
    });
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("MK Files · Demo");
    expect(dialog.message()).toContain("plugin.jar");
    await dialog.accept();
  });
  await page
    .getByRole("button", { name: "Upload 1 file", exact: true })
    .click();
  await expect.poll(() => uploaded).toContain("arbitrary upload");
  await page.getByLabel("New file or folder name").fill("config/custom.xyz");
  await page.getByRole("button", { name: "Create file", exact: true }).click();
  await expect(page.getByLabel("File contents")).toHaveValue("");
  await page.getByRole("button", { name: "Close file" }).click();
  await page.getByRole("button", { name: "plugin.jar", exact: true }).click();
  await expect(
    page.getByText("This is a binary file.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Download file" }),
  ).toHaveAttribute("href", /path=plugin.jar/);
  await page.getByRole("button", { name: "Close file" }).click();
  await expect(
    page.getByRole("button", { name: ".custom", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: `docs/screenshots/files-manager-${info.project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
});
