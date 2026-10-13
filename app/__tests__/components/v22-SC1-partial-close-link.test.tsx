/** v2.2 QA SC-1: a partial close leaves the position open; its tx link must still be shown (words it as "Partly closed"). */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { LastCloseTxLink } from "@/components/trade/LastCloseTxLink";
import { __clearCloseTxs, recordCloseTx } from "@/lib/last-close-tx";

const SIG = "5NVB49mmZ5mhFJSnnGmH6CnKGiS4CQvYpQVqQuodiRaEL5PeK85Cyic5gzdFZLgvzFNqy9eMjMXLhH9gUyoDQyoh";
describe("LastCloseTxLink", () => {
  afterEach(() => { cleanup(); __clearCloseTxs(); });
  it("full close: 'Position closed.' with the link; partial close: 'Partly closed.' with the link", () => {
    const { getByTestId } = render(<LastCloseTxLink slabAddress="S" />);
    act(() => recordCloseTx("S", SIG, Date.now(), false));
    expect(getByTestId("last-close-tx").textContent).toContain("Position closed.");
    expect(getByTestId("last-close-tx").querySelector("a")?.getAttribute("href")).toContain(SIG);
    act(() => recordCloseTx("S", SIG, Date.now(), true));
    expect(getByTestId("last-close-tx").textContent).toContain("Partly closed.");
  });
});
