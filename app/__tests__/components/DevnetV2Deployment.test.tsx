import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
import { DevnetV2Deployment } from "@/components/DevnetV2Deployment";
import { DEVNET_PROGRAM_IDS } from "@/lib/program-ids";

describe("Devnet V2 deployment section", () => {
  it("shows exactly the app's configured devnet program IDs, linked to the devnet explorer", () => {
    render(<DevnetV2Deployment />);
    for (const id of Object.values(DEVNET_PROGRAM_IDS)) {
      const a = screen.getByText(id).closest("a")!;
      expect(a.getAttribute("href")).toBe(`https://explorer.solana.com/address/${id}?cluster=devnet`);
    }
  });
  it("lists no market addresses (the live list is /markets; unfinished setups never appear here)", () => {
    const { container } = render(<DevnetV2Deployment />);
    expect(container.innerHTML).not.toMatch(/A9u1KkM9|8WC8vALs/);
    expect(screen.getByText("Markets").closest("a")?.getAttribute("href")).toBe("/markets");
  });
});
