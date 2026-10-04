// lois/guardian — the voice critic, an agent on the bus (D-091, D-113).
//
// deslop's real two-stage shape: a deterministic tripwire floor (checkVoice:
// dashes, filler, jargon, placeholders — mechanical, always-wrong things), then
// a MODEL critic that cold-reads the draft the way deslop's critic prompt does.
// A regex cannot say "this is in the organizer's voice"; only a reader can. The
// critic never sees the writer's intent — only the words and the voice evidence.
//
// Advisory, not blocking (D-111: soft inside the loop, hard at the gate). Its
// verdict lands on the trace so drift is visible before the organizer's yes.
// If the model is unavailable the critic says the draft is UNJUDGED — it never
// pretends a mechanical pass is an opinion.

import type { AgentSpec } from "./registry.js";
import type { LoisModel } from "./model.js";
import { parseJsonLoose } from "./model.js";
import { checkVoice, learnVoice, voiceBrief, type CalibrationPair } from "./voice.js";

const CRITIC_CONTRACT = [
  "You are a copy critic. You will be shown one outbound draft and the voice evidence for the",
  "world it belongs to. Judge only the words on the page. First write a literal paraphrase; if",
  "the paraphrase needs meaning that is not in the draft, the draft fails. Then the noun-swap:",
  "if another event could change one noun and keep the message, it says nothing specific. Then",
  "compare against the voice evidence: does this read like the SENT column, not the DRAFTED one?",
  "Return STRICT JSON only:",
  '{"verdict": "clean" | "revise", "notes": ["<each specific problem, or what carries the voice>"]}',
].join("\n");

export interface CriticOptions {
  calibration?: CalibrationPair[];
  voiceNotes?: string;
}

export function voiceCritic(model: LoisModel | null, opts: CriticOptions = {}): AgentSpec {
  // One cold-read per unique body: judging identical text twice wastes tokens
  // and produces inconsistent verdicts (observed live: 19 clean / 1 revise on
  // the same words). Digest equality is mechanical, so this determinism is
  // legitimate under the supple law. The verdict event refs the first judged
  // proposal; repeats get a pointer note.
  const judged = new Map<string, number>(); // content digest -> verdict event seq
  return {
    name: "critic",
    role: "worker",
    purpose: "cold-read every draft against the world's voice evidence (deslop critic over the tripwire floor)",
    triggersOn: (event) => event.kind === "proposed" && (event.detail?.kind as string | undefined) === "draft",
    run: async (ctx, event) => {
      const body = (event.detail?.body as string | undefined) ?? "";
      const subject = (event.detail?.subject as string | undefined) ?? "";
      if (!body) {
        ctx.trace.append({ actor: "critic", kind: "note", label: "draft proposal carries no body to judge", refs: [event.seq] });
        return;
      }
      const text = [subject, body].filter(Boolean).join("\n");
      const dg = (event.detail?.digest as string | undefined) ?? text;
      const prior = judged.get(dg);
      if (prior !== undefined) {
        ctx.trace.append({ actor: "critic", kind: "note", label: `same words as an earlier draft; verdict at #${prior} stands`, refs: [event.seq, prior] });
        return;
      }

      // The voice evidence for this draft's world/channel — derived per event,
      // not frozen at registration.
      const upcoming = ctx.world.gatherings.find((g) => g.upcoming);
      const voice = learnVoice(
        ctx.world,
        {
          context: upcoming?.context ?? "",
          channel: (event.detail?.channel as string | undefined) ?? "email",
          purpose: (event.detail?.purpose as string | undefined) ?? "invite",
        },
        opts.calibration ?? [],
        opts.voiceNotes,
      );

      // Stage 1 — the tripwire floor. Mechanical failures short-circuit: no
      // model spend on a draft with a dash or a placeholder in it.
      const flags = checkVoice(voice, text);
      if (flags.length > 0) {
        const v = ctx.trace.append({
          actor: "critic",
          kind: "note",
          label: `tripwires: ${flags.map((f) => `${f.rule} (${f.detail})`).join("; ")}`,
          detail: { flags },
          refs: [event.seq],
        });
        judged.set(dg, v.seq);
        return;
      }

      // Stage 2 — the cold read. A regex pass means nothing more than "allowed
      // to be judged"; without a model there is no judgment, and we say so.
      if (!model) {
        const v = ctx.trace.append({
          actor: "critic",
          kind: "note",
          label: "tripwires clear; no model connected, so the voice itself is UNJUDGED",
          refs: [event.seq],
        });
        judged.set(dg, v.seq);
        return;
      }

      try {
        const raw = await model.complete({
          system: [CRITIC_CONTRACT, "", "Voice evidence for this world:", voiceBrief(voice)].join("\n"),
          user: `The draft:\n${text}`,
          json: true,
        });
        const parsed = parseJsonLoose(raw) as Record<string, unknown> | undefined;
        const verdict = parsed && typeof parsed.verdict === "string" ? parsed.verdict : "unreadable";
        const notes = parsed && Array.isArray(parsed.notes) ? parsed.notes.filter((n): n is string => typeof n === "string") : [];
        const v = ctx.trace.append({
          actor: "critic",
          kind: "note",
          label: `cold read: ${verdict}${notes.length > 0 ? ` — ${notes[0]}` : ""}`,
          detail: { verdict, notes },
          refs: [event.seq],
        });
        judged.set(dg, v.seq);
      } catch (err) {
        ctx.trace.append({
          actor: "critic",
          kind: "note",
          label: `critic errored, draft UNJUDGED: ${err instanceof Error ? err.message : String(err)}`,
          refs: [event.seq],
        });
      }
    },
  };
}
