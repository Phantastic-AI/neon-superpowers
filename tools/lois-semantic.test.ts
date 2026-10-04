import { describe, expect, it } from "vitest";
import {
  SemanticDownloadInputSchema,
  SemanticFollowInputSchema,
  SemanticPrepareInputSchema,
  createSemanticSession,
  type SemanticControlMetadata,
  type SemanticDownloadActivation,
  type SemanticFacts,
  type SemanticLocator,
  type SemanticPage,
} from "./lois-semantic.js";
import { semanticPrepareTrace } from "../packages/lois/hand-schemas.js";

class FakeLocator implements SemanticLocator {
  readonly calls: string[] = [];

  constructor(
    readonly metadata: SemanticControlMetadata,
    readonly options: {
      count?: number;
      visible?: boolean;
      enabled?: boolean;
      activation?: { blockedWrite: boolean; blockedCrossSiteNavigation: boolean };
      onActivate?: () => void;
      download?: SemanticDownloadActivation;
    } = {},
  ) {}

  async count(): Promise<number> {
    return this.options.count ?? 1;
  }

  async isVisible(): Promise<boolean> {
    return this.options.visible ?? true;
  }

  async isEnabled(): Promise<boolean> {
    return this.options.enabled ?? true;
  }

  async inspect(): Promise<SemanticControlMetadata> {
    return this.metadata;
  }

  async fill(text: string): Promise<void> {
    this.calls.push(`fill:${text}`);
  }

  async check(checked: boolean): Promise<void> {
    this.calls.push(`check:${checked}`);
  }

  async select(labels: string[]): Promise<void> {
    this.calls.push(`select:${labels.join("|")}`);
  }

  async activate(): Promise<{ blockedWrite: boolean; blockedCrossSiteNavigation: boolean }> {
    this.calls.push("activate");
    this.options.onActivate?.();
    return this.options.activation ?? { blockedWrite: false, blockedCrossSiteNavigation: false };
  }

  async download(destinationDir: string): Promise<SemanticDownloadActivation> {
    this.calls.push(`download:${destinationDir}`);
    return this.options.download ?? { ok: false, reason: "no-download" };
  }
}

class FakePage implements SemanticPage {
  readonly locators = new Map<string, FakeLocator>();
  snapshotReads = 0;
  onSnapshot?: () => void;
  readonly navigations: string[] = [];

  constructor(
    public rawUrl: string,
    public snapshot: string,
    public pageTitle = "Local event workspace",
  ) {}

  url(): string {
    return this.rawUrl;
  }

  async title(): Promise<string> {
    return this.pageTitle;
  }

  async ariaSnapshot(): Promise<string> {
    this.snapshotReads += 1;
    this.onSnapshot?.();
    return this.snapshot;
  }

  locator(ref: string): FakeLocator {
    const locator = this.locators.get(ref);
    if (!locator) {
      return new FakeLocator(
        { tag: "missing", type: "", role: "", readOnly: false, multiple: false, hidden: false, descriptor: "", options: [] },
        { count: 0 },
      );
    }
    return locator;
  }

  async navigate(url: string): Promise<void> {
    this.navigations.push(url);
    this.rawUrl = url;
  }
}

const token = {};

function facts(page: FakePage, overrides: Partial<SemanticFacts> = {}): SemanticFacts {
  return {
    pageToken: token,
    rawUrl: page.url(),
    navigationEpoch: 3,
    controlEpoch: 7,
    ...overrides,
  };
}

function current(value: SemanticFacts | null): () => Promise<SemanticFacts | null> {
  return async () => value;
}

const textControl = (descriptor = "invitation message"): SemanticControlMetadata => ({
  tag: "textarea",
  type: "",
  role: "textbox",
  readOnly: false,
  multiple: false,
  hidden: false,
  descriptor,
  options: [],
});

const checkboxControl = (descriptor = "guest"): SemanticControlMetadata => ({
  tag: "input",
  type: "checkbox",
  role: "checkbox",
  readOnly: false,
  multiple: false,
  hidden: false,
  descriptor,
  options: [],
});

const selectControl = (labels: string[]): SemanticControlMetadata => ({
  tag: "select",
  type: "",
  role: "listbox",
  readOnly: false,
  multiple: true,
  hidden: false,
  descriptor: "people",
  options: labels.map((label) => ({ label, disabled: false })),
});

const linkControl = (url: string): SemanticControlMetadata => ({
  tag: "a",
  type: "",
  role: "link",
  readOnly: false,
  multiple: false,
  hidden: false,
  descriptor: "past event",
  options: [],
  href: url,
});

describe("Lois semantic browser observation", () => {
  it("publishes a typed sanitized snapshot with a host-unique numeric prefix", async () => {
    const captured: unknown[] = [];
    const page = new FakePage(
      "https://example.test/profile?session=private#contact",
      '- textbox "Contact" [ref=e1]: hidden value\n- heading "Ada" [ref=e2]',
      "Profile?token=private",
    );
    const state = facts(page);
    const session = createSemanticSession({
      observationIdPrefix: "987654",
      observationOwner: () => "job-one:100",
      onObservation: snapshot => { captured.push(snapshot); },
    });

    const result = await session.observe(page, state, current(state));

    expect(result).toMatchObject({ ok: true });
    expect(result.note).toContain("Observation obs-9876541");
    expect(captured).toEqual([{
      observationId: "obs-9876541",
      sourceUrl: "https://example.test/profile",
      text: result.note,
    }]);
    expect(JSON.stringify(captured)).not.toMatch(/session=private|#contact|hidden value|token=private|pageToken|navigationEpoch|controlEpoch/);
  });

  it("does not advertise an observation when capture fails or its owner changes", async () => {
    const page = new FakePage("https://example.test/profile", '- heading "Ada" [ref=e1]');
    const state = facts(page);
    let owner = "job-one:100";
    const failed = createSemanticSession({
      observationOwner: () => owner,
      onObservation: () => { throw new Error("disk full"); },
    });
    expect(await failed.observe(page, state, current(state))).toEqual({
      ok: false,
      note: "Could not retain the browser observation safely. Observe it again.",
    });
    await expect(failed.evidence(page, state, "obs-1", current(state))).resolves.toMatchObject({ ok: false });

    const raced = createSemanticSession({
      observationOwner: () => owner,
      onObservation: () => undefined,
    });
    page.onSnapshot = () => { owner = "job-two:200"; };
    const result = await raced.observe(page, state, current(state));
    expect(result).toEqual({
      ok: false,
      note: "Could not retain the browser observation safely. Observe it again.",
    });
    expect(result.note).not.toContain("Observation obs-");
  });

  it("licenses a vault fact only from the current observation and exposes a public URL", async () => {
    const page = new FakePage(
      "https://luma.com/event/evt-3cs?access_token=private#guests",
      '- heading "3Cs" [ref=e1]',
    );
    const session = createSemanticSession();
    const state = facts(page);
    await session.observe(page, state, current(state));

    await expect(
      session.evidence(page, state, "obs-1", current(state)),
    ).resolves.toEqual({
      ok: true,
      note: "The current browser observation still matches the live page.",
      url: "https://luma.com/event/evt-3cs",
    });

    await expect(
      session.evidence(
        page,
        state,
        "obs-1",
        current({ ...state, navigationEpoch: state.navigationEpoch + 1 }),
      ),
    ).resolves.toEqual({
      ok: false,
      note: "That browser observation is stale. Observe the page again.",
    });
  });

  it("refuses stale live facts before reading the semantic snapshot", async () => {
    const page = new FakePage("http://127.0.0.1:4319/event", '- textbox "Note" [ref=e1]');
    const state = facts(page);
    const session = createSemanticSession();

    const result = await session.observe(
      page,
      state,
      current({ ...state, controlEpoch: state.controlEpoch + 1 }),
    );

    expect(result).toMatchObject({ ok: false });
    expect(page.snapshotReads).toBe(0);
  });

  it("bounds the snapshot and removes URLs, control values, and credential-shaped lines", async () => {
    const page = new FakePage(
      "http://127.0.0.1:4319/event/3cs?shape=v2#people",
      [
        '- textbox "Password" [ref=e1]: hunter2',
        '- textbox "Invitation note" [ref=e2]: private draft value',
        '- link "Details" [ref=e3]:',
        '  - /url: https://example.test/event?secret=one#token',
        '- text: Visit https://example.test/agenda?invite=private#evening',
        '- text: Authorization: Bearer very-secret-token',
        `- paragraph: ${"garden ".repeat(4_000)}`,
      ].join("\n"),
      "3Cs?private=yes#fragment",
    );
    const session = createSemanticSession();
    const state = facts(page);

    const result = await session.observe(page, state, current(state));

    expect(result.ok).toBe(true);
    expect(result.note.length).toBeLessThan(8_000);
    expect(result.note).toContain("Observation obs-1");
    expect(result.note).toContain("Semantic view:");
    expect(result.note).toContain("http://127.0.0.1:4319/event/3cs");
    expect(result.note).not.toMatch(/shape=v2|#people|hunter2|private draft value|Bearer|very-secret|secret=one|invite=private|#evening/);
    expect(result.note).not.toContain("[ref=e1]");
    expect(result.note).toContain("[ref=e2]");
    expect(result.note).toContain("[ref=e3]");
  });

  it("removes structural noise before applying the bound so late useful controls survive", async () => {
    const structuralNoise = Array.from(
      { length: 1_200 },
      (_, index) => `  - generic [ref=e${index + 1}]:\n    - generic: "${index % 31}"`,
    ).join("\n");
    const page = new FakePage(
      "http://127.0.0.1:4319/events",
      `${structuralNoise}\n- link "Past 3Cs Dinner" [ref=e9999]:\n  - /url: http://127.0.0.1:4319/event/past`,
    );
    page.locators.set("e9999", new FakeLocator(linkControl("http://127.0.0.1:4319/event/past")));
    const session = createSemanticSession();
    const state = facts(page);

    const observed = await session.observe(page, state, current(state));

    expect(observed.ok).toBe(true);
    expect(observed.note.length).toBeLessThan(8_000);
    expect(observed.note).toContain('link "Past 3Cs Dinner" [ref=e9999]');
    expect(observed.note).not.toContain('generic: "30"');
  });

  it("makes a previous observation stale after a newer observation", async () => {
    const page = new FakePage("http://127.0.0.1:4319/event", '- textbox "Note" [ref=e1]');
    page.locators.set("e1", new FakeLocator(textControl()));
    const session = createSemanticSession();
    const state = facts(page);

    await session.observe(page, state, current(state));
    await session.observe(page, state, current(state));
    const stale = await session.prepare(
      page,
      state,
      { observationId: "obs-1", operations: [{ kind: "fill", ref: "e1", text: "hello" }] },
      current(state),
    );

    expect(stale).toMatchObject({ ok: false, note: expect.stringMatching(/stale/i) });
    expect(page.locators.get("e1")?.calls).toEqual([]);
  });

  it.each([
    ["page", { pageToken: {} }],
    ["URL", { rawUrl: "http://127.0.0.1:4319/elsewhere" }],
    ["navigation", { navigationEpoch: 4 }],
    ["control", { controlEpoch: 8 }],
  ])("refuses preparation after %s drift and consumes the observation", async (_label, drift) => {
    const page = new FakePage("http://127.0.0.1:4319/event", '- textbox "Note" [ref=e1]');
    const locator = new FakeLocator(textControl());
    page.locators.set("e1", locator);
    const session = createSemanticSession();
    const state = facts(page);
    await session.observe(page, state, current(state));

    const first = await session.prepare(
      page,
      { ...state, ...drift },
      { observationId: "obs-1", operations: [{ kind: "fill", ref: "e1", text: "hello" }] },
      current({ ...state, ...drift }),
    );
    const second = await session.prepare(
      page,
      state,
      { observationId: "obs-1", operations: [{ kind: "fill", ref: "e1", text: "hello" }] },
      current(state),
    );

    expect(first).toMatchObject({ ok: false, note: expect.stringMatching(/stale/i) });
    expect(second).toMatchObject({ ok: false, note: expect.stringMatching(/stale/i) });
    expect(locator.calls).toEqual([]);
  });

  it("rejects ARIA-role lookalikes that are not native controls", async () => {
    const page = new FakePage(
      "http://127.0.0.1:4319/event",
      '- textbox "Pretend field" [ref=e1]\n- checkbox "Pretend box" [ref=e2]',
    );
    const pretendText = new FakeLocator({ ...textControl(), tag: "div" });
    const pretendCheck = new FakeLocator({ ...checkboxControl(), tag: "div", type: "" });
    page.locators.set("e1", pretendText);
    page.locators.set("e2", pretendCheck);
    const session = createSemanticSession();
    const state = facts(page);

    await session.observe(page, state, current(state));
    const fill = await session.prepare(
      page,
      state,
      { observationId: "obs-1", operations: [{ kind: "fill", ref: "e1", text: "hello" }] },
      current(state),
    );
    await session.observe(page, state, current(state));
    const check = await session.prepare(
      page,
      state,
      { observationId: "obs-2", operations: [{ kind: "check", ref: "e2", checked: true }] },
      current(state),
    );

    expect(fill).toMatchObject({ ok: false });
    expect(check).toMatchObject({ ok: false });
    expect(pretendText.calls).toEqual([]);
    expect(pretendCheck.calls).toEqual([]);
  });
});

describe("Lois semantic browser download", () => {
  it("saves only the file emitted by one exact observed control", async () => {
    const page = new FakePage("https://luma.com/calendar/people", '- button "Download as CSV" [ref=e9]');
    const locator = new FakeLocator(
      {
        tag: "button",
        type: "button",
        role: "",
        readOnly: false,
        multiple: false,
        hidden: false,
        formAssociated: false,
        descriptor: "Download as CSV",
        options: [],
      },
      {
        download: {
          ok: true,
          filename: "hacker-garage-people.csv",
          path: "/owned/captures/downloads/hacker-garage-people.csv",
          bytes: 4096,
        },
      },
    );
    page.locators.set("e9", locator);
    const session = createSemanticSession();
    const state = facts(page);
    await session.observe(page, state, current(state));

    const result = await session.download(
      page,
      state,
      { observationId: "obs-1", ref: "e9" },
      current(state),
      "/owned/captures/downloads",
    );

    expect(result).toEqual({
      ok: true,
      note: "Downloaded hacker-garage-people.csv (4096 bytes) to /owned/captures/downloads/hacker-garage-people.csv.",
    });
    expect(locator.calls).toEqual(["download:/owned/captures/downloads"]);
  });

  it("reports that an observed control asked for more confirmation instead of calling it human-only", async () => {
    const page = new FakePage("https://luma.com/calendar/people", '- button "Download as CSV" [ref=e9]');
    const locator = new FakeLocator(
      {
        tag: "button",
        type: "button",
        role: "",
        readOnly: false,
        multiple: false,
        hidden: false,
        formAssociated: false,
        descriptor: "Download as CSV",
        options: [],
      },
      { download: { ok: false, reason: "no-download" } },
    );
    page.locators.set("e9", locator);
    const session = createSemanticSession();
    const state = facts(page);
    await session.observe(page, state, current(state));

    const result = await session.download(
      page,
      state,
      { observationId: "obs-1", ref: "e9" },
      current(state),
      "/owned/captures/downloads",
    );

    expect(result).toEqual({
      ok: false,
      note: "That observed control did not start a download. Observe the page for a confirmation or error.",
    });
  });

  it("refuses stale or model-invented refs before attempting a download", async () => {
    const page = new FakePage("https://luma.com/calendar/people", '- button "Download as CSV" [ref=e9]');
    const locator = new FakeLocator({
      tag: "button",
      type: "button",
      role: "",
      readOnly: false,
      multiple: false,
      hidden: false,
      formAssociated: false,
      descriptor: "Download as CSV",
      options: [],
    });
    page.locators.set("e9", locator);
    const session = createSemanticSession();
    const state = facts(page);
    await session.observe(page, state, current(state));

    const invented = await session.download(
      page,
      state,
      { observationId: "obs-1", ref: "e99" },
      current(state),
      "/owned/captures/downloads",
    );

    expect(invented.ok).toBe(false);
    expect(locator.calls).toEqual([]);
  });

  it("refuses form submission even when the model asks for it through the download hand", async () => {
    const page = new FakePage("https://luma.com/calendar/people", '- button "Delete" [ref=e9]');
    const locator = new FakeLocator({
      tag: "button",
      type: "submit",
      role: "",
      readOnly: false,
      multiple: false,
      hidden: false,
      formAssociated: true,
      descriptor: "Delete",
      options: [],
    });
    page.locators.set("e9", locator);
    const session = createSemanticSession();
    const state = facts(page);
    await session.observe(page, state, current(state));

    const result = await session.download(
      page,
      state,
      { observationId: "obs-1", ref: "e9" },
      current(state),
      "/owned/captures/downloads",
    );

    expect(result).toEqual({
      ok: false,
      note: "Refused browser download: the observed control submits a form rather than standing alone.",
    });
    expect(locator.calls).toEqual([]);
  });

  it("keeps the destination host-owned rather than model-authored", () => {
    expect(SemanticDownloadInputSchema.safeParse({ observationId: "obs-3", ref: "e9" }).success).toBe(true);
    expect(
      SemanticDownloadInputSchema.safeParse({
        observationId: "obs-3",
        ref: "e9",
        path: "/tmp/neon-demo-downloads/people.csv",
      }).success,
    ).toBe(false);
  });
});

describe("Lois semantic browser preparation", () => {
  it("projects preparation evidence without tracing drafted text or option labels", () => {
    const traced = semanticPrepareTrace({
      observationId: "obs-4",
      operations: [
        { kind: "fill", ref: "e1", text: "private invitation draft" },
        { kind: "select", ref: "e2", labels: ["Private Person"] },
      ],
    });

    expect(traced).toEqual({
      observationId: "obs-4",
      operations: [
        { kind: "fill", ref: "e1", textLength: 24 },
        { kind: "select", ref: "e2", optionCount: 1 },
      ],
    });
    expect(JSON.stringify(traced)).not.toMatch(/private invitation draft|Private Person/);
  });

  it("prevalidates every target before performing the first operation", async () => {
    const page = new FakePage(
      "http://127.0.0.1:4319/event",
      '- textbox "Note" [ref=e1]\n- checkbox "Guest" [ref=e2]',
    );
    const valid = new FakeLocator(textControl());
    const ambiguous = new FakeLocator(checkboxControl(), { count: 2 });
    page.locators.set("e1", valid);
    page.locators.set("e2", ambiguous);
    const session = createSemanticSession();
    const state = facts(page);
    await session.observe(page, state, current(state));

    const result = await session.prepare(
      page,
      state,
      {
        observationId: "obs-1",
        operations: [
          { kind: "fill", ref: "e1", text: "hello" },
          { kind: "check", ref: "e2", checked: true },
        ],
      },
      current(state),
    );

    expect(result).toMatchObject({ ok: false });
    expect(valid.calls).toEqual([]);
    expect(ambiguous.calls).toEqual([]);
  });

  it.each([
    ["password", { ...textControl("password"), tag: "input", type: "password" }],
    ["OTP", { ...textControl("one-time verification code"), tag: "input", type: "text" }],
    ["hidden", { ...textControl(), tag: "input", type: "hidden", hidden: true }],
    ["file", { ...textControl(), tag: "input", type: "file" }],
  ])("rejects a %s control without acting", async (_label, metadata) => {
    const page = new FakePage("http://127.0.0.1:4319/event", '- textbox "Field" [ref=e1]');
    const locator = new FakeLocator(metadata);
    page.locators.set("e1", locator);
    const session = createSemanticSession();
    const state = facts(page);
    await session.observe(page, state, current(state));

    const result = await session.prepare(
      page,
      state,
      { observationId: "obs-1", operations: [{ kind: "fill", ref: "e1", text: "secret" }] },
      current(state),
    );

    expect(result).toMatchObject({ ok: false });
    expect(locator.calls).toEqual([]);
  });

  it("prepares checkbox-shaped and multi-select-shaped pages through the same ref operations", async () => {
    const v1 = new FakePage(
      "http://127.0.0.1:4319/event?shape=v1",
      '- checkbox "Maya Chen" [ref=e1]\n- textbox "Invitation note" [ref=e2]',
    );
    v1.locators.set("e1", new FakeLocator(checkboxControl("Maya Chen")));
    v1.locators.set("e2", new FakeLocator(textControl()));
    const v2 = new FakePage(
      "http://127.0.0.1:4319/event?shape=v2",
      '- textbox "Message for the invitation" [ref=e8]\n- listbox "People" [ref=e9]',
    );
    v2.locators.set("e8", new FakeLocator(textControl()));
    v2.locators.set("e9", new FakeLocator(selectControl(["Maya Chen", "Idris Bello"])));

    for (const [page, operations] of [
      [
        v1,
        [
          { kind: "check", ref: "e1", checked: true },
          { kind: "fill", ref: "e2", text: "Come through" },
        ],
      ],
      [
        v2,
        [
          { kind: "fill", ref: "e8", text: "Come through" },
          { kind: "select", ref: "e9", labels: ["Maya Chen"] },
        ],
      ],
    ] as const) {
      const session = createSemanticSession();
      const state = facts(page, { pageToken: page });
      await session.observe(page, state, current(state));

      const result = await session.prepare(
        page,
        state,
        { observationId: "obs-1", operations },
        current(state),
      );

      expect(result).toEqual({ ok: true, note: "Prepared 2 controls. Nothing was submitted." });
    }

    expect(v1.locators.get("e1")?.calls).toEqual(["check:true"]);
    expect(v1.locators.get("e2")?.calls).toEqual(["fill:Come through"]);
    expect(v2.locators.get("e8")?.calls).toEqual(["fill:Come through"]);
    expect(v2.locators.get("e9")?.calls).toEqual(["select:Maya Chen"]);
  });

  it("has no click or submit operation and caps batches at twelve", () => {
    const tooMany = Array.from({ length: 13 }, (_, index) => ({
      kind: "fill" as const,
      ref: `e${index + 1}`,
      text: "x",
    }));

    expect(
      SemanticPrepareInputSchema.safeParse({ observationId: "obs-1", operations: tooMany }).success,
    ).toBe(false);
    expect(
      SemanticPrepareInputSchema.safeParse({
        observationId: "obs-1",
        operations: [{ kind: "click", ref: "e1" }],
      }).success,
    ).toBe(false);
    expect(
      SemanticPrepareInputSchema.safeParse({
        observationId: "obs-1",
        operations: [{ kind: "submit", ref: "e1" }],
      }).success,
    ).toBe(false);
  });
});

describe("Lois semantic browser following", () => {
  it("follows one exact same-site anchor without dispatching a click", async () => {
    const page = new FakePage(
      "https://luma.com/home?private=one",
      '- link "3Cs Dinner" [ref=e7]',
    );
    page.locators.set("e7", new FakeLocator({
      tag: "a",
      type: "",
      role: "link",
      readOnly: false,
      multiple: false,
      hidden: false,
      href: "https://luma.com/event/3cs?tk=private#guests",
      descriptor: "3Cs Dinner",
      options: [],
    }));
    const session = createSemanticSession();
    const state = facts(page);
    await session.observe(page, state, current(state));

    const result = await session.follow(
      page,
      state,
      { observationId: "obs-1", ref: "e7" },
      current(state),
    );

    expect(result).toEqual({
      ok: true,
      note: "Followed the observed link to https://luma.com/event/3cs.",
    });
    expect(page.navigations).toEqual(["https://luma.com/event/3cs?tk=private#guests"]);
  });

  it("activates one exact native view button under the page's read-only fence", async () => {
    const page = new FakePage("https://luma.com/calendar", '- button "Past" [ref=e8]');
    const locator = new FakeLocator({
      tag: "button",
      type: "button",
      role: "",
      readOnly: false,
      multiple: false,
      hidden: false,
      formAssociated: false,
      descriptor: "Past",
      options: [],
    });
    page.locators.set("e8", locator);
    const session = createSemanticSession();
    const state = facts(page);
    await session.observe(page, state, current(state));

    const result = await session.follow(
      page,
      state,
      { observationId: "obs-1", ref: "e8" },
      current(state),
    );

    expect(result).toEqual({
      ok: true,
      note: "Activated the observed view control behind the read-only browser fence.",
    });
    expect(locator.calls).toEqual(["activate"]);
  });

  it("reports a write attempt stopped by the browser fence", async () => {
    const page = new FakePage("https://luma.com/calendar", '- button "Past" [ref=e8]');
    const locator = new FakeLocator(
      {
        tag: "button",
        type: "button",
        role: "",
        readOnly: false,
        multiple: false,
        hidden: false,
        formAssociated: false,
        descriptor: "Past",
        options: [],
      },
      { activation: { blockedWrite: true, blockedCrossSiteNavigation: false } },
    );
    page.locators.set("e8", locator);
    const session = createSemanticSession();
    const state = facts(page);
    await session.observe(page, state, current(state));

    const result = await session.follow(
      page,
      state,
      { observationId: "obs-1", ref: "e8" },
      current(state),
    );

    expect(result).toEqual({
      ok: false,
      note: "The observed control tried to make a write request, so the browser fence stopped it.",
    });
  });

  it("keeps a changed view when its incidental write request was stopped", async () => {
    const page = new FakePage("https://luma.com/calendar", '- button "Past" [ref=e8]');
    const locator = new FakeLocator(
      {
        tag: "button",
        type: "button",
        role: "",
        readOnly: false,
        multiple: false,
        hidden: false,
        formAssociated: false,
        descriptor: "Past",
        options: [],
      },
      {
        activation: { blockedWrite: true, blockedCrossSiteNavigation: false },
        onActivate: () => {
          page.rawUrl = "https://luma.com/calendar?period=past";
        },
      },
    );
    page.locators.set("e8", locator);
    const session = createSemanticSession();
    const state = facts(page);
    await session.observe(page, state, current(state));

    const result = await session.follow(
      page,
      state,
      { observationId: "obs-1", ref: "e8" },
      async () => ({ ...state, rawUrl: page.rawUrl }),
    );

    expect(result).toEqual({
      ok: true,
      note: "Activated the observed view control behind the read-only browser fence. An incidental write request was stopped.",
    });
  });

  it.each([
    ["form submitter", { tag: "button", type: "submit", role: "", formAssociated: true }],
    ["role look-alike", { tag: "div", type: "", role: "button", formAssociated: false }],
  ])("refuses a %s without activating it", async (_label, override) => {
    const page = new FakePage("https://luma.com/calendar", '- button "Continue" [ref=e8]');
    const locator = new FakeLocator({
      ...override,
      readOnly: false,
      multiple: false,
      hidden: false,
      descriptor: "Continue",
      options: [],
    });
    page.locators.set("e8", locator);
    const session = createSemanticSession();
    const state = facts(page);
    await session.observe(page, state, current(state));

    const result = await session.follow(
      page,
      state,
      { observationId: "obs-1", ref: "e8" },
      current(state),
    );

    expect(result.ok).toBe(false);
    expect(locator.calls).toEqual([]);
  });

  it.each([
    ["cross-site link", { tag: "a", href: "https://example.test/event" }],
    ["script link", { tag: "a", href: "javascript:alert(1)" }],
  ])("refuses a %s without navigating", async (_label, override) => {
    const page = new FakePage("https://luma.com/home", '- link "Thing" [ref=e2]');
    page.locators.set("e2", new FakeLocator({
      tag: override.tag,
      type: "",
      role: "link",
      readOnly: false,
      multiple: false,
      hidden: false,
      href: override.href,
      descriptor: "Thing",
      options: [],
    }));
    const session = createSemanticSession();
    const state = facts(page);
    await session.observe(page, state, current(state));

    const result = await session.follow(
      page,
      state,
      { observationId: "obs-1", ref: "e2" },
      current(state),
    );

    expect(result.ok).toBe(false);
    expect(page.navigations).toEqual([]);
  });

  it("keeps the follow input to an observed ref rather than a model-written URL", () => {
    expect(
      SemanticFollowInputSchema.safeParse({ observationId: "obs-3", ref: "e9" }).success,
    ).toBe(true);
    expect(
      SemanticFollowInputSchema.safeParse({
        observationId: "obs-3",
        ref: "e9",
        url: "https://luma.com/private",
      }).success,
    ).toBe(false);
  });
});
