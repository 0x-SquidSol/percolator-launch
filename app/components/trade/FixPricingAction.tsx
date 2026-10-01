"use client";

import type { FC } from "react";
import { StatusLine } from "@/components/ui/StatusLine";
import { useFixPricing } from "@/hooks/useFixPricing";
import { FIX_PRICING_COPY } from "@/lib/fix-pricing";
import { resolveUserMessage } from "@/lib/limits/user-message";

/** Creator-only, self-hiding: renders nothing unless this wallet owns the LP and skew is on. */
export const FixPricingAction: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const { eligible, done, sending, error, fix } = useFixPricing(slabAddress);
  if (done) {
    return <StatusLine message={{ kind: "fix-pricing-done", variant: "info", title: FIX_PRICING_COPY.done, body: "Quotes now follow the market price more closely." }} />;
  }
  if (!eligible) return null;
  const failed = error ? resolveUserMessage(error, { surface: "any" }) : null;
  if (failed && !failed.quiet) {
    return (
      <StatusLine
        message={{ ...failed, action: { id: "improve-pricing", label: FIX_PRICING_COPY.button } }}
        onAction={() => void fix()}
      />
    );
  }
  return (
    <StatusLine
      message={{
        kind: "fix-pricing",
        variant: "info",
        title: FIX_PRICING_COPY.title,
        body: sending ? "Waiting for your approval…" : FIX_PRICING_COPY.body,
        action: sending ? undefined : { id: "improve-pricing", label: FIX_PRICING_COPY.button },
      }}
      onAction={() => void fix()}
    />
  );
};
