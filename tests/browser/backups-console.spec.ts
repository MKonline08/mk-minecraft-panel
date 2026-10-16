import { test, expect, type Page } from "@playwright/test";

const example = {
  id: "update-demo",
  name: "Update Demo",
  type: "VANILLA",
  version: "1.21.1",
  java: 21,
  status: "running",
  memory: 0,
  memoryLimit: 2,
  cpu: 0,
  port: 25565,
  motd: "Hello",
  banner: false,
  icon: false,
  backupHours: 24,
  retention: 5,
  lastBackup: null,
  settings: {},
};
async function setup(page: Page) {
  let polls = 0;
  let saved: any;
  let testMessage: any;
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      p = url.pathname;
    let value: any = {};
    if (p.endsWith("/auth/status"))
      value = { authenticated: true, setup: false };
    else if (p === "/api/servers") value = [example];
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
      value = { serverBytes: 4096, backupBytes: 2048, diskFree: 1024 ** 3 };
    else if (p.endsWith("/logs")) {
      polls++;
      const text =
        "[RCON Client /127.0.0.1/INFO]: There are 0 of a max of 20 players online:";
      value = {
        cursor: String(polls),
        reset: polls === 1,
        lines:
          polls === 1
            ? [
                { text },
                { text },
                { text: "[Server thread/ERROR]: real problem" },
                { text: "identical legitimate line" },
                { text: "identical legitimate line" },
              ]
            : [{ text: `new output ${polls}` }],
      };
    } else if (p.endsWith("/command"))
      value = { text: "There are 0 of a max of 20 players online:" };
    else if (p.endsWith("/backups/announce")) {
      testMessage = req.postDataJSON();
      value = { text: "sent" };
    } else if (p.endsWith("/backups")) {
      if (req.method() === "PUT") {
        saved = req.postDataJSON();
        value = { ...example, ...saved };
      } else
        value = [
          { name: "verified.zip", size: 2048, verification: "verified" },
          { name: "legacy.zip", size: 1024, verification: "unknown" },
        ];
    } else if (p.endsWith("/update-demo"))
      value = { ...example, nextBackupAt: "2026-12-01T09:00:00Z" };
    await route.fulfill({ json: value });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open Update Demo" }).click();
  return {
    get polls() {
      return polls;
    },
    get saved() {
      return saved;
    },
    get testMessage() {
      return testMessage;
    },
  };
}

test("console receives only new lines, collapses telemetry and pauses when hidden or closed", async ({
  page,
}) => {
  const state = await setup(page);
  await page.clock.install();
  await page.getByRole("button", { name: "Console", exact: true }).click();
  const output = page.getByLabel("Minecraft output");
  await expect(output).toContainText("real problem");
  expect(
    (await output.textContent())!.match(/identical legitimate line/g),
  ).toHaveLength(2);
  expect((await output.textContent())!.match(/There are/g)).toHaveLength(1);
  await page.getByLabel("Show repeated player checks").check();
  expect((await output.textContent())!.match(/There are/g)).toHaveLength(2);
  await page.getByLabel("Server command").fill("list");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(output).toContainText("[Command response] There are");
  await page.getByRole("button", { name: "Pause console" }).click();
  let before = state.polls;
  await page.clock.runFor(12000);
  expect(state.polls).toBe(before);
  await page.getByRole("button", { name: "Resume console" }).click();
  await expect.poll(() => state.polls).toBeGreaterThan(before);
  await page.getByLabel("Auto-scroll").uncheck();
  before = state.polls;
  await page.clock.runFor(4100);
  await expect(page.getByRole("button", { name: /new lines/ })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  before = state.polls;
  await page.clock.runFor(12000);
  expect(state.polls).toBe(before);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => state.polls).toBeGreaterThan(before);
  await page.getByRole("button", { name: "Clear display" }).click();
  await expect(output).not.toContainText("real problem");
  await page
    .getByRole("main")
    .getByRole("button", { name: "Backups", exact: true })
    .click();
  before = state.polls;
  await page.clock.runFor(12000);
  expect(state.polls).toBe(before);
});

test("backup settings expose schedules, editable announcements, previews and verification status", async ({
  page,
}) => {
  const state = await setup(page);
  await page
    .getByRole("main")
    .getByRole("button", { name: "Backups", exact: true })
    .click();
  await expect(
    page.getByText("Free: 1024.0 MB", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Schedule", { exact: true }).selectOption("weekly");
  await page.getByLabel("Backup time").fill("04:30");
  await page.getByLabel("Timezone", { exact: true }).fill("America/Chicago");
  await page.getByLabel("Day", { exact: true }).selectOption("2");
  await page
    .getByLabel("Warning message", { exact: true })
    .fill("{server} maintenance in {remaining}");
  await expect(
    page.getByText("Update Demo maintenance in 5 minute(s)", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Send test announcement" }).click();
  await expect
    .poll(() => state.testMessage?.announcements.warning)
    .toBe("{server} maintenance in {remaining}");
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect
    .poll(() => state.saved?.backupSchedule)
    .toEqual({
      mode: "weekly",
      time: "04:30",
      timezone: "America/Chicago",
      weekday: 2,
    });
  expect(state.saved.announcements.warnings).toEqual([300, 60, 10]);
  await expect(
    page.getByText("Verification unknown (older backup)", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Restore", exact: true })
    .first()
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "server will remain stopped",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
