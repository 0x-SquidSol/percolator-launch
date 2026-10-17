import { QUARANTINED_FILES, QUARANTINED_TESTS, LOT0_TESTS } from './v21-contract-pins';

// Printed once at the start of every flag-on run, so the quarantine can never be silently green.
export default function setup(): void {
  const on = process.env.NEXT_PUBLIC_DEVNET_V22 === '1' || process.env.NEXT_PUBLIC_DEVNET_V22 === 'true';
  if (!on) return;
  console.warn(
    `[v2.2 flag-on] QUARANTINE: ${QUARANTINED_TESTS.length} tests + ${QUARANTINED_FILES.length} files rerun with the flag OFF (they need a v2.2 fixture rewrite, see __tests__/v21-contract-pins.ts); ` +
      `${LOT0_TESTS.length} tests run flag-on with lot exponent 0 seeded. Any other failure in this run is a real flag-on regression.`,
  );
}
