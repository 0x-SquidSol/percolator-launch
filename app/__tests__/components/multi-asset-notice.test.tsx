/** Copy QA item 1: a multi-asset market's trade page carries a clear "Multi-asset (SDK only)" notice; a single-asset one carries none. */
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { MultiAssetNotice, MULTI_ASSET_NOTICE } from "@/components/trade/MultiAssetNotice";

describe("MultiAssetNotice", () => {
  it("labels the market and says the app trades one asset", () => {
    render(<MultiAssetNotice show />);
    const n = screen.getByTestId("multi-asset-notice");
    expect(n).toHaveTextContent("Multi-asset (SDK only)");
    expect(n).toHaveTextContent(MULTI_ASSET_NOTICE.body);
    expect(n.textContent).not.toMatch(/another asset/i);
  });
  it("negative control: shows nothing for a single-asset market", () => {
    render(<MultiAssetNotice show={false} />);
    expect(screen.queryByTestId("multi-asset-notice")).toBeNull();
  });
});
