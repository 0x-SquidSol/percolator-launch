import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

const m = vi.hoisted(() => ({ login: vi.fn(), available: true, connected: false }));
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyAvailable: () => m.available, usePrivyLogin: () => m.login }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ connected: m.connected }) }));
import { AutoSignIn } from "@/components/wallet/AutoSignIn";

describe("AutoSignIn — after the waitlist hand-off, open Privy sign-in once (same embedded wallet)", () => {
  beforeEach(() => { m.login.mockReset(); m.available = true; m.connected = false; });
  it("/?signin=1 opens the sign-in once and strips the flag", () => {
    window.history.replaceState(null, "", "/?signin=1");
    const { rerender } = render(<AutoSignIn />);
    rerender(<AutoSignIn />);
    expect(m.login).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("");
  });
  it("CONTROL: no flag → nothing opens", () => {
    window.history.replaceState(null, "", "/trade");
    render(<AutoSignIn />);
    expect(m.login).not.toHaveBeenCalled();
  });
  it("already connected → no prompt", () => {
    m.connected = true;
    window.history.replaceState(null, "", "/?signin=1");
    render(<AutoSignIn />);
    expect(m.login).not.toHaveBeenCalled();
  });
});
