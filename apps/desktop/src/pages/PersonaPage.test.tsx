import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanionProfile } from "../../../../src/profile/profileSchema.js";
import type { WhiteLilyTask5Api } from "../desktopApi.js";
import { PersonaPage } from "./PersonaPage.js";

const profile: CompanionProfile = {
  id: "8af32ca8-d1d7-4d87-b684-f6aaf04fb907",
  displayName: "White Lily",
  language: "en",
  tone: "Warm and concise",
  preferredTopics: ["building"],
  avoidedTopics: ["spoilers"],
  persona: "Offer calm, practical help.",
  mode: "friend",
  modeSettings: {
    friend: {
      idleMinutes: 120,
      allowProactiveChat: false,
      allowSuggestions: false,
      allowLowRiskMicroActions: false,
    },
    balanced: {
      idleMinutes: 2,
      allowProactiveChat: true,
      allowSuggestions: true,
      allowLowRiskMicroActions: false,
    },
    autonomous: {
      idleMinutes: 1,
      allowProactiveChat: true,
      allowSuggestions: true,
      allowLowRiskMicroActions: true,
    },
  },
  modelPreference: { mode: "automatic" },
};

function envelope(revision: number, value = profile) {
  return {
    schemaVersion: 1 as const,
    revision,
    updatedAt: "2026-07-29T00:00:00.000Z",
    value,
  };
}

function api(overrides: Partial<WhiteLilyTask5Api> = {}): WhiteLilyTask5Api {
  return {
    readProfile: vi.fn(async () => envelope(4)),
    updateProfile: vi.fn(async (input) => ({
      envelope: envelope(input.expectedRevision + 1, input.profile),
      liveStatus: "applied" as const,
    })),
    setBehaviorMode: vi.fn(async (input) => ({
      envelope: envelope(input.expectedRevision + 1, {
        ...profile,
        mode: input.mode,
        modeSettings: { ...profile.modeSettings, [input.mode]: input.settings },
      }),
      liveStatus: "applied" as const,
    })),
    ...overrides,
  } as WhiteLilyTask5Api;
}

describe("PersonaPage", () => {
  afterEach(cleanup);

  it("keeps the advanced persona collapsed while exposing guided fields", async () => {
    render(<PersonaPage api={api()} locale="en" />);

    expect(((await screen.findByLabelText("Companion name")) as HTMLInputElement).value).toBe(
      "White Lily",
    );
    expect((screen.getByLabelText("Tone") as HTMLInputElement).value).toBe("Warm and concise");
    expect((screen.getByLabelText("Preferred topics") as HTMLInputElement).value).toBe("building");
    expect((screen.getByLabelText("Avoided topics") as HTMLInputElement).value).toBe("spoilers");
    expect(screen.queryByLabelText("Advanced persona prompt")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Advanced persona prompt" }));
    expect((screen.getByLabelText("Advanced persona prompt") as HTMLTextAreaElement).value).toBe(
      "Offer calm, practical help.",
    );
  });

  it("keeps unsaved settings for all three editable modes while switching", async () => {
    render(<PersonaPage api={api()} locale="en" />);
    await screen.findByRole("button", { name: "Friend" });

    await userEvent.clear(screen.getByLabelText("Idle minutes"));
    await userEvent.type(screen.getByLabelText("Idle minutes"), "30");
    await userEvent.click(screen.getByRole("button", { name: "Balanced" }));
    await userEvent.clear(screen.getByLabelText("Idle minutes"));
    await userEvent.type(screen.getByLabelText("Idle minutes"), "8");
    await userEvent.click(screen.getByRole("button", { name: "Autonomous" }));
    await userEvent.clear(screen.getByLabelText("Idle minutes"));
    await userEvent.type(screen.getByLabelText("Idle minutes"), "3");

    await userEvent.click(screen.getByRole("button", { name: "Friend" }));
    expect((screen.getByLabelText("Idle minutes") as HTMLInputElement).valueAsNumber).toBe(30);
    await userEvent.click(screen.getByRole("button", { name: "Balanced" }));
    expect((screen.getByLabelText("Idle minutes") as HTMLInputElement).valueAsNumber).toBe(8);
    await userEvent.click(screen.getByRole("button", { name: "Autonomous" }));
    expect((screen.getByLabelText("Idle minutes") as HTMLInputElement).valueAsNumber).toBe(3);
  });

  it("reloads a conflicting server revision, lists changed fields, and preserves the draft for explicit reapply", async () => {
    const updateProfile = vi
      .fn<WhiteLilyTask5Api["updateProfile"]>()
      .mockRejectedValueOnce(new Error("DOCUMENT_CONFLICT: Profile revision conflict"))
      .mockImplementation(async (input) => ({
        envelope: envelope(input.expectedRevision + 1, input.profile),
        liveStatus: "applied",
      }));
    const serverProfile = { ...profile, tone: "Server changed tone" };
    const readProfile = vi
      .fn<WhiteLilyTask5Api["readProfile"]>()
      .mockResolvedValueOnce(envelope(4))
      .mockResolvedValueOnce(envelope(8, serverProfile));
    render(<PersonaPage api={api({ readProfile, updateProfile })} locale="en" />);

    const name = await screen.findByLabelText("Companion name");
    await userEvent.clear(name);
    await userEvent.type(name, "My local draft");
    await userEvent.click(screen.getByRole("button", { name: "Save companion" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Tone");
    expect((screen.getByLabelText("Companion name") as HTMLInputElement).value).toBe(
      "My local draft",
    );
    expect(updateProfile).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Reapply my draft" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(2));
    expect(updateProfile.mock.calls[1]?.[0]).toMatchObject({
      expectedRevision: 8,
      profile: { displayName: "My local draft", tone: "Warm and concise" },
    });
  });
});
