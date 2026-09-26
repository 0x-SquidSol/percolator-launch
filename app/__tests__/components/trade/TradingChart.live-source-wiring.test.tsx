import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const priceLine = {
    applyOptions: vi.fn(),
  };

  const seriesPriceScale = {
    applyOptions: vi.fn(),
  };

  const series = {
    setData: vi.fn(),
    update: vi.fn(),
    applyOptions: vi.fn(),
    createPriceLine: vi.fn(() => priceLine),
    priceScale: vi.fn(() => seriesPriceScale),
    dataByIndex: vi.fn(),
    coordinateToPrice: vi.fn(),
  };

  const chartPriceScale = {
    applyOptions: vi.fn(),
  };

  const timeScale = {
    fitContent: vi.fn(),
  };

  const pane = {
    setPreserveEmptyPane: vi.fn(),
  };

  const chart = {
    panes: vi.fn(() => [pane]),
    applyOptions: vi.fn(),
    remove: vi.fn(),
    removeSeries: vi.fn(),
    addSeries: vi.fn(() => series),
    priceScale: vi.fn(() => chartPriceScale),
    timeScale: vi.fn(() => timeScale),
    subscribeCrosshairMove: vi.fn(),
    unsubscribeCrosshairMove: vi.fn(),
    subscribeClick: vi.fn(),
    unsubscribeClick: vi.fn(),
  };

  const percolatorCandles = Array.from({ length: 10 }, (_, index) => ({
    time: 1_720_000_000 + index * 60,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 0,
  }));

  // Stable identities are required. TradingChart's structural series effect
  // depends on chartTheme and source arrays; returning fresh objects from mocks
  // on every render would repeatedly call setSeriesEpoch() and loop forever.
  const emptyCandles: never[] = [];

  const chartTheme = {
    bg: '#000000',
    textColor: '#ffffff',
    gridColor: '#222222',
    borderColor: '#333333',
    neutralLine: '#999999',
    upColor: '#00ff00',
    downColor: '#ff0000',
    entryLine: '#00ffff',
    volUpColor: '#00ff00',
    volDownColor: '#ff0000',
  };

  return {
    chart,
    series,
    priceLine,
    percolatorCandles,
    emptyCandles,
    chartTheme,
  };
});

vi.mock('lightweight-charts', () => ({
  createChart: vi.fn(() => harness.chart),
  LineStyle: {
    Solid: 0,
    Dashed: 2,
  },
  ColorType: {
    Solid: 'solid',
  },
  CrosshairMode: {
    Normal: 0,
  },
  CandlestickSeries: 'CandlestickSeries',
  HistogramSeries: 'HistogramSeries',
  BarSeries: 'BarSeries',
  LineSeries: 'LineSeries',
  AreaSeries: 'AreaSeries',
}));

vi.mock('@/lib/chart-live-tick', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chart-live-tick')>();

  return {
    ...actual,
    resolveChartDataSource: vi.fn(actual.resolveChartDataSource),
  };
});

vi.mock('@/components/providers/SlabProvider', () => ({
  useSlabState: () => ({
    config: {},
    params: {},
  }),
}));

vi.mock('@/hooks/useLivePrice', () => ({
  useLivePrice: () => ({
    priceUsd: 100,
  }),
}));

vi.mock('@/lib/chart-source-select', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chart-source-select')>();
  return { ...actual, selectChartSource: vi.fn(actual.selectChartSource) };
});

vi.mock('@/hooks/usePercolatorCandles', () => ({
  usePercolatorCandles: () => ({
    candles: harness.percolatorCandles,
    status: 'success',
  }),
}));

vi.mock('@/hooks/usePythChart', () => ({
  usePythChart: () => ({
    candles: harness.emptyCandles,
    status: 'success',
  }),
}));

vi.mock('@/hooks/useTokenChart', () => ({
  useTokenChart: () => ({
    candles: harness.emptyCandles,
    status: 'idle',
    poolAddress: null,
  }),
}));

vi.mock('@/hooks/useUserAccount', () => ({
  useUserAccount: () => null,
}));

vi.mock('@/hooks/useMarketConfig', () => ({
  useMarketConfig: () => ({}),
}));

vi.mock('@/hooks/useMarketInfo', () => ({
  useMarketInfo: () => ({
    market: {
      symbol: 'SOL',
    },
  }),
}));

vi.mock('@/hooks/useLiqPrice', () => ({
  useLiqPrice: () => null,
}));

vi.mock('@/hooks/useChartTheme', () => ({
  useChartTheme: () => harness.chartTheme,
}));

vi.mock('@/hooks/useChartStylePref', () => ({
  useChartStylePref: () => ['candle-solid', vi.fn()],
}));

vi.mock('@/hooks/useChartOverlayPrefs', () => ({
  useChartOverlayPrefs: () => [
    {
      liq: false,
      entry: false,
      position: false,
      pnl: false,
    },
    vi.fn(),
  ],
}));

vi.mock('@/hooks/useChartIndicatorPrefs', () => ({
  useChartIndicatorPrefs: () => ({
    indicators: [],
    addIndicator: vi.fn(),
    removeIndicator: vi.fn(),
    updateIndicator: vi.fn(),
    clearAll: vi.fn(),
  }),
}));

vi.mock('@/hooks/useChartDrawingTool', () => ({
  useChartDrawingTool: () => ({
    tool: 'pointer',
    setTool: vi.fn(),
  }),
}));

vi.mock('@/hooks/useChartDrawings', () => ({
  useChartDrawings: () => ({
    drawings: [],
    addDrawing: vi.fn(),
    deleteDrawing: vi.fn(),
    clearAll: vi.fn(),
  }),
}));

vi.mock('@/components/trade/useIndicatorOverlays', () => ({
  useIndicatorOverlays: vi.fn(),
}));

vi.mock('@/components/trade/useIndicatorOscillatorPane', () => ({
  useIndicatorOscillatorPane: vi.fn(),
}));

vi.mock('@/lib/priceStore/priceStore', () => ({
  subscribeSlab: vi.fn(() => vi.fn()),
  getSnapshot: vi.fn(() => ({
    priceUsd: 100,
  })),
}));

vi.mock('@/lib/perf/perfTiming', () => ({
  startPerfSpan: vi.fn(() => vi.fn()),
}));

vi.mock('@/lib/pollWhenVisible', () => ({
  pollWhenVisible: vi.fn(() => vi.fn()),
}));

vi.mock('@/lib/mock-mode', () => ({
  isMockMode: vi.fn(() => false),
}));

vi.mock('@/lib/mock-trade-data', () => ({
  isMockSlab: vi.fn(() => false),
  getMockUserAccount: vi.fn(() => null),
}));

vi.mock('@/lib/entry-price', () => ({
  getEntryPrice: vi.fn(() => 0n),
}));

vi.mock('@/components/ui/ShimmerSkeleton', () => ({
  ShimmerSkeleton: () => null,
}));

vi.mock('@/components/trade/ChartStyleMenu', () => ({
  ChartStyleMenu: () => null,
}));

vi.mock('@/components/trade/ChartDisplayMenu', () => ({
  ChartDisplayMenu: () => null,
}));

vi.mock('@/components/trade/ChartPnlBadge', () => ({
  ChartPnlBadge: () => null,
}));

vi.mock('@/components/trade/ChartIndicatorMenu', () => ({
  ChartIndicatorMenu: () => null,
}));

vi.mock('@/components/trade/ChartDrawingOverlay', () => ({
  ChartDrawingOverlay: () => null,
}));

vi.mock('@/components/trade/ChartDrawingToolbar', () => ({
  ChartDrawingToolbar: () => null,
}));

import { TradingChart } from '@/components/trade/TradingChart';
import { selectChartSource } from '@/lib/chart-source-select';

describe('TradingChart live-source wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          prices: [],
        }),
      })),
    );
  });

  it("forwards each source's status and PRICED bar count to the selector", async () => {
    render(
      <TradingChart
        slabAddress="TestSlab1111111111111111111111111111111111"
        mintAddress="TestMint1111111111111111111111111111111111"
      />,
    );

    // The selector receives source STATE, not pre-collapsed booleans — the
    // booleans are what hid #2579, because the component decided precedence
    // before anything testable saw the inputs.
    await waitFor(() => {
      expect(vi.mocked(selectChartSource)).toHaveBeenLastCalledWith({
        percolator: { status: 'success', pricedBars: harness.percolatorCandles.length },
        // `applicable` tells the selector a source can never answer, as opposed
        // to not having answered yet. Symbol is 'SOL' (mapped) and a mint is
        // passed, so both apply here; the distinction is exercised in
        // __tests__/lib/chart-source-select.test.ts.
        pyth: { status: 'success', pricedBars: 0, applicable: true },
        dex: { status: 'idle', pricedBars: 0, applicable: true },
      });
    });
  });
});
