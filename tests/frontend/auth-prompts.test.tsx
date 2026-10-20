import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";
const local = vi.hoisted(() => ({
  receive: null as null | ((event: unknown) => void),
  answer: vi.fn().mockResolvedValue(undefined),
  unsubscribe: vi.fn(),
}));
vi.mock("../../src/frontend/c2s-local-api", () => ({
  setLocalC2S: vi.fn(),
  localC2SAvailable: () => true,
  startLocalAutoStart: vi.fn().mockResolvedValue(undefined),
  answerLocalAuth: local.answer,
  onLocalAuthPrompt: (fn: (event: unknown) => void) => {
    local.receive = fn;
    return local.unsubscribe;
  },
}));

let rendered: RenderedPluginApp | null = null;
afterEach(async () => {
  await act(async () => {
    await rendered?.deactivate();
  });
  rendered = null;
  local.answer.mockClear();
  local.unsubscribe.mockClear();
});

describe("tunnel prompt overlay", () => {
  it("queues challenges, clears the previous code, and cancels on plugin disposal", async () => {
    const receive = (event: unknown) => local.receive!(event);
    rendered = await renderWithApp(plugin, {
      manifest: manifestJson as unknown as PluginManifest,
      locales,
    });
    rendered.renderSlot("shell.overlay");
    act(() => {
      receive({
        type: "auth-prompt",
        id: "one",
        tunnelName: "SOCKS",
        request: { kind: "totp", prompt: "Code:", retry: false },
      });
      receive({
        type: "auth-prompt",
        id: "two",
        tunnelName: "Other",
        request: { kind: "totp", prompt: "Code:", retry: true },
      });
    });
    const input = screen.getByLabelText("Authentication response");
    expect(input.getAttribute("type")).toBe("password");
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.click(screen.getByText("Continue"));
    expect(local.answer).toHaveBeenCalledWith("one", "123456");
    expect(
      (screen.getByLabelText("Authentication response") as HTMLInputElement)
        .value,
    ).toBe("");
    expect(screen.getByRole("alert").textContent).toContain("previous code");
    act(() => receive({ type: "auth-prompt-closed", id: "two" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() =>
      receive({
        type: "auth-prompt",
        id: "three",
        request: {
          kind: "input",
          prompt: "Password:",
          echo: false,
          isPush: false,
        },
      }),
    );
    await act(async () => {
      await rendered!.deactivate();
    });
    rendered = null;
    expect(local.answer).toHaveBeenCalledWith("three", null);
    expect(local.unsubscribe).toHaveBeenCalledOnce();
  });
});
