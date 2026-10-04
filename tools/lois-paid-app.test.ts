import { describe, expect, it, vi } from "vitest";
import { assertLoopbackPortsAvailable, isDirectPaidSmokeApp, paidSmokeAppPorts, quiescePaidSmokeApp } from "./lois-paid-app.js";
import { parsePaidSmokeCli } from "./lois-paid-smoke.js";
import * as runtime from "../sidecar/runtime.js";

describe("paid manual Lois app entry boundary", () => {
  it("does not ignite merely because another module imports the launcher", () => {
    const cli = "file:///repo/tools/lois-paid-app.ts";
    expect(isDirectPaidSmokeApp(cli, ["node", "/repo/tools/lois-paid-app.test.ts"])).toBe(false);
    expect(isDirectPaidSmokeApp(cli, ["node", "/repo/tools/lois-paid-app.ts"])).toBe(true);
  });

  it("shares the paid runner's explicit authorization gate", () => {
    expect(() => parsePaidSmokeCli([])).toThrow(/explicit --approve-paid authorization/i);
  });

  it("refuses occupied app ports before a stale server can satisfy readiness", async () => {
    await expect(assertLoopbackPortsAvailable([5175, 5199], async (port) => port === 5199))
      .rejects.toThrow(/5199 is already occupied/i);
    await expect(assertLoopbackPortsAvailable([5175, 5199], async () => false)).resolves.toBeUndefined();
  });

  it("keeps old ports by default and permits a separate exact app/sidecar pair", () => {
    expect(paidSmokeAppPorts()).toEqual({ sidecarPort: 5175, facePort: 5199, appUrl: "http://127.0.0.1:5199/pane/lois" });
    expect(paidSmokeAppPorts({ sidecarPort: 5185, facePort: 5209 })).toEqual({ sidecarPort: 5185, facePort: 5209, appUrl: "http://127.0.0.1:5209/pane/lois" });
    expect(() => paidSmokeAppPorts({ facePort: 5175 })).toThrow(/distinct/i);
    for (const facePort of [0, -1, 65536, 3.5]) expect(() => paidSmokeAppPorts({ facePort })).toThrow(/port/i);
  });

  it("checks only the chosen ports, leaving an occupied ordinary app alone", async () => {
    const checked: number[] = [];
    const { sidecarPort, facePort } = paidSmokeAppPorts({ sidecarPort: 5185, facePort: 5209 });
    await assertLoopbackPortsAvailable([sidecarPort, facePort], async port => {
      checked.push(port);
      return port === 5175 || port === 5199;
    });
    expect(checked).toEqual([5185, 5209]);
  });

  it("cancels then drains the owned background diver as well as mouth/cascade work", async () => {
    const events: string[] = [];
    let finishDiver!: () => void;
    const diver = vi.spyOn(runtime, "idleRuntimeDiver").mockImplementation(async () => {
      events.push("diver idle");
      await new Promise<void>(resolve => { finishDiver = resolve; });
    });
    try {
      const built = { system: { cancel: () => events.push("cancel"), idle: async () => { events.push("mouth idle"); } }, runtime: { diverStatePath: "owned" } };
      let drained = false;
      const pending = quiescePaidSmokeApp(built as unknown as Parameters<typeof quiescePaidSmokeApp>[0]).then(() => { drained = true; });
      await Promise.resolve();
      expect(events).toEqual(["cancel", "mouth idle", "diver idle"]);
      expect(drained).toBe(false);
      finishDiver(); await pending;
      expect(drained).toBe(true);
    } finally { diver.mockRestore(); }
  });
});
