import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerIdentitySnapshot } from "../../../../src/identity/ownerIdentity.js";
import type { WhiteLilyAppApi } from "../desktopApi.js";
import { WorldSafetyPage } from "./WorldSafetyPage.js";

const boundWorld = {
  schemaVersion: 1 as const,
  revision: 3,
  updatedAt: "2026-07-29T00:00:00.000Z",
  value: {
    id: "8af32ca8-d1d7-4d87-b684-f6aaf04fb907",
    label: "Creative test world",
    instanceFingerprint: "a".repeat(43),
    ownerUsername: "Owner",
    safetyPreset: "conservative" as const,
  },
};

const liveOwner: OwnerIdentitySnapshot = {
  revision: 8,
  ownerUsername: "LiveExactOwner",
  configured: true,
  presence: "online",
};

function api(overrides: Partial<WhiteLilyAppApi> = {}): WhiteLilyAppApi {
  return {
    bindConfirmedWorld: vi.fn(async () => boundWorld),
    detectLanCandidates: vi.fn(async () => []),
    confirmLanCandidate: vi.fn(async () => ({
      status: "confirmed" as const,
      port: 25565,
      version: "1.21.5",
      confirmedAt: 1,
    })),
    readWorldProfile: vi.fn(async () => boundWorld),
    updateSafetyProfile: vi.fn(async (input) => ({
      ...boundWorld,
      revision: input.expectedRevision + 1,
      value: { ...boundWorld.value, safetyPreset: input.safetyPreset },
    })),
    ...overrides,
  } as WhiteLilyAppApi;
}

describe("WorldSafetyPage", () => {
  afterEach(cleanup);

  it("shows only the confirmed bound world, immutable hard caps, and permanent denies", async () => {
    render(<WorldSafetyPage api={api()} locale="en" ownerIdentity={liveOwner} />);

    expect(await screen.findByText("Creative test world")).toBeTruthy();
    expect(screen.getByText("Owner: LiveExactOwner")).toBeTruthy();
    expect(screen.queryByText("Owner: Owner")).toBeNull();
    expect(screen.getByText("64 tool calls")).toBeTruthy();
    expect(screen.getByText("256 block changes")).toBeTruthy();
    expect(screen.getByText("1,024 blocks travel")).toBeTruthy();
    expect(screen.getByText("10 minutes")).toBeTruthy();
    expect(
      screen.getByText(/TNT, lava, and destructive fire are permanently denied/i),
    ).toBeTruthy();
    expect(screen.queryByText(/high-risk/i)).toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  it("requires fresh LAN detection and explicit candidate confirmation before reapplying a bind conflict", async () => {
    const unbound = { ...boundWorld, revision: 0, value: null };
    const latest = { ...unbound, revision: 2 };
    const readWorldProfile = vi.fn().mockResolvedValueOnce(unbound).mockResolvedValueOnce(latest);
    const bindConfirmedWorld = vi
      .fn()
      .mockRejectedValueOnce(new Error("DOCUMENT_CONFLICT: stale"))
      .mockResolvedValueOnce(boundWorld);
    const detectLanCandidates = vi.fn(async () => [
      {
        id: "lan_candidate_1234",
        port: 25565,
        version: "1.21.5",
        observedAt: 1,
        expiresAt: 60_001,
      },
    ]);
    const confirmLanCandidate = vi.fn(async () => ({
      status: "confirmed" as const,
      port: 25565,
      version: "1.21.5",
      confirmedAt: 2,
    }));
    render(
      <WorldSafetyPage
        api={api({
          readWorldProfile,
          bindConfirmedWorld,
          detectLanCandidates,
          confirmLanCandidate,
        })}
        locale="en"
        ownerIdentity={liveOwner}
      />,
    );

    await userEvent.type(await screen.findByLabelText("World label"), "Survival");
    await userEvent.click(screen.getByRole("button", { name: "Bind confirmed world" }));
    await userEvent.click(await screen.findByRole("button", { name: "Reapply my draft" }));
    expect(detectLanCandidates).toHaveBeenCalledOnce();
    expect(bindConfirmedWorld).toHaveBeenCalledTimes(1);

    await userEvent.click(
      await screen.findByRole("button", {
        name: /Confirm and connect: port 25565, Minecraft 1\.21\.5/,
      }),
    );
    expect(confirmLanCandidate).toHaveBeenCalledWith("lan_candidate_1234");
    expect(bindConfirmedWorld).toHaveBeenLastCalledWith({
      expectedRevision: 2,
      label: "Survival",
    });
  });

  it("switches between conservative and standard using the last observed world revision", async () => {
    const updateSafetyProfile = vi.fn<WhiteLilyAppApi["updateSafetyProfile"]>(async (input) => ({
      ...boundWorld,
      revision: 4,
      value: { ...boundWorld.value, safetyPreset: input.safetyPreset },
    }));
    render(
      <WorldSafetyPage api={api({ updateSafetyProfile })} locale="en" ownerIdentity={liveOwner} />,
    );
    await screen.findByText("Creative test world");

    await userEvent.click(screen.getByRole("radio", { name: "Standard" }));
    await userEvent.click(screen.getByRole("button", { name: "Save safety preset" }));
    await waitFor(() =>
      expect(updateSafetyProfile).toHaveBeenCalledWith({
        expectedRevision: 3,
        safetyPreset: "standard",
      }),
    );
  });

  it("does not present the historical world owner as current authority without a live owner", async () => {
    render(<WorldSafetyPage api={api()} locale="en" ownerIdentity={null} />);

    expect(await screen.findByText("Creative test world")).toBeTruthy();
    expect(screen.queryByText("Owner: Owner")).toBeNull();
  });
});
