"use client";

import type { CSSProperties, FC } from "react";
import type { LiqPriceDisplay } from "@/lib/liq-price-display";

/**
 * Renders a liquidation-price cell from `describeLiqPrice`. Every surface that
 * shows a liquidation price must go through it (or use `describeLiqPrice`
 * directly where it needs a string) — enforced by
 * __tests__/components/margin-health-surfaces.test.ts, which scans the tree.
 */
export const LiqPriceValue: FC<{
  display: LiqPriceDisplay;
  className?: string;
  style?: CSSProperties;
}> = ({ display, className, style }) => (
  <span className={className} style={style} title={display.title} data-liq-kind={display.kind}>
    {display.text}
  </span>
);
