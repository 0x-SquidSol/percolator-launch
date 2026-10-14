"use client";

/**
 * The growth ticket panel with its v2.2 tier badge and next-unlock line. A separate component so the cluster-slot poll
 * (`useClusterSlot`) exists only on a growth market, not on every order ticket.
 */
import { useMemo, type FC } from "react";
import { GrowthTicketPanel, type GrowthTicketPanelProps } from "@/components/trade/GrowthTicketPanel";
import { useClusterSlot } from "@/hooks/useClusterSlot";
import { growthRecordBytes, growthUnlockView } from "@/lib/v22/growth-unlock";

export interface GrowthTicketPanelLiveProps extends Omit<GrowthTicketPanelProps, "unlock"> {
  /** The market account bytes. */
  raw: Uint8Array | null;
  /** Engine `band_bps` of the asset; null when the band view is unavailable (no unlock is claimed). */
  bandBps: number | null;
  assetIndex?: number;
}

export const GrowthTicketPanelLive: FC<GrowthTicketPanelLiveProps> = ({ raw, bandBps, assetIndex = 0, ...panel }) => {
  const nowSlot = useClusterSlot();
  const unlock = useMemo(
    () => (bandBps === null ? null : growthUnlockView({ view: panel.view, bandBps, record: growthRecordBytes(raw, assetIndex), nowSlot })),
    [panel.view, bandBps, raw, assetIndex, nowSlot],
  );
  return <GrowthTicketPanel {...panel} unlock={unlock} />;
};
