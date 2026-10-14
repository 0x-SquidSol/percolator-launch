import type { FC } from "react";

/** Shown on a market whose own config lets an account hold more than one asset (`max_portfolio_assets` > 1). */
export const MULTI_ASSET_NOTICE = {
  label: "Multi-asset (SDK only)",
  body: "This market holds more than one asset per account. This app trades only one asset per market, so trading it here isn't supported. Use the SDK for this market.",
} as const;

export const MultiAssetNotice: FC<{ show: boolean }> = ({ show }) =>
  show ? (
    <div data-testid="multi-asset-notice" className="border-b border-[var(--warning)]/30 bg-[var(--warning)]/5 px-4 py-2 text-center">
      <p className="text-[11px] text-[var(--warning)]">
        <span className="font-medium uppercase tracking-[0.1em]">{MULTI_ASSET_NOTICE.label}</span>
        {" · "}
        {MULTI_ASSET_NOTICE.body}
      </p>
    </div>
  ) : null;
