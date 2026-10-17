import { ADX, ATR, BollingerBands, EMA, RSI, SMA } from 'technicalindicators';
import type {
  ADXPoint,
  BollingerBandsPoint,
  Candle,
  DonchianChannelPoint,
} from '../types/index.js';

export class MathEngine {
  /**
   * Calculates Exponential Moving Average (EMA) series.
   */
  public static calculateEMA(values: number[], period: number): number[] {
    if (period <= 0 || values.length < period) {
      return [];
    }
    return EMA.calculate({ period, values });
  }

  /**
   * Returns the latest EMA value from a candle array using close prices.
   */
  public static getLatestEMA(candles: Candle[], period: number): number | null {
    if (candles.length < period) return null;
    const closes = candles.map((c) => c.close);
    const series = this.calculateEMA(closes, period);
    return series.length > 0 ? series[series.length - 1] : null;
  }

  /**
   * Calculates Simple Moving Average (SMA) series.
   */
  public static calculateSMA(values: number[], period: number): number[] {
    if (period <= 0 || values.length < period) {
      return [];
    }
    return SMA.calculate({ period, values });
  }

  /**
   * Returns the latest SMA value for an array of numbers.
   */
  public static getLatestSMA(values: number[], period: number): number | null {
    if (values.length < period) return null;
    const series = this.calculateSMA(values, period);
    return series.length > 0 ? series[series.length - 1] : null;
  }

  /**
   * Calculates Average True Range (ATR) series.
   */
  public static calculateATR(candles: Candle[], period: number): number[] {
    if (period <= 0 || candles.length < period + 1) {
      return [];
    }
    const high = candles.map((c) => c.high);
    const low = candles.map((c) => c.low);
    const close = candles.map((c) => c.close);

    return ATR.calculate({ high, low, close, period });
  }

  /**
   * Returns the latest ATR value from a candle array.
   */
  public static getLatestATR(candles: Candle[], period: number): number | null {
    const series = this.calculateATR(candles, period);
    return series.length > 0 ? series[series.length - 1] : null;
  }

  /**
   * Calculates Average Directional Index (ADX) series including +DI and -DI.
   * Uses `technicalindicators` ADX with a numerical guard against 0/0 NaN division on flat bars.
   */
  public static calculateADX(candles: Candle[], period: number): ADXPoint[] {
    if (period <= 0 || candles.length < period * 2) {
      return [];
    }
    const high = candles.map((c) => c.high);
    const low = candles.map((c) => c.low);
    const close = candles.map((c) => c.close);

    const raw = ADX.calculate({ high, low, close, period });
    const hasNaN = raw.some(
      (item) => Number.isNaN(item.adx) || Number.isNaN(item.pdi) || Number.isNaN(item.mdi)
    );

    if (!hasNaN && raw.length > 0) {
      return raw.map((item) => ({
        adx: item.adx,
        pdi: item.pdi,
        mdi: item.mdi,
      }));
    }

    // Fallback Wilder ADX calculation that safely handles zero directional movement (0/0 -> 0)
    return this.calculateSafeWilderADX(candles, period);
  }

  /**
   * Safe Wilder ADX calculation when flat bars cause 0/0 in technicalindicators.
   */
  private static calculateSafeWilderADX(candles: Candle[], period: number): ADXPoint[] {
    const trList: number[] = [];
    const plusDmList: number[] = [];
    const minusDmList: number[] = [];

    for (let i = 1; i < candles.length; i++) {
      const curr = candles[i];
      const prev = candles[i - 1];

      const upMove = curr.high - prev.high;
      const downMove = prev.low - curr.low;

      const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
      const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;

      const tr = Math.max(
        curr.high - curr.low,
        Math.abs(curr.high - prev.close),
        Math.abs(curr.low - prev.close)
      );

      trList.push(tr);
      plusDmList.push(plusDm);
      minusDmList.push(minusDm);
    }

    if (trList.length < period * 2 - 1) {
      return [];
    }

    let smoothedTr = 0;
    let smoothedPlusDm = 0;
    let smoothedMinusDm = 0;

    for (let i = 0; i < period; i++) {
      smoothedTr += trList[i];
      smoothedPlusDm += plusDmList[i];
      smoothedMinusDm += minusDmList[i];
    }

    const dxSeries: { dx: number; pdi: number; mdi: number }[] = [];

    const computeDiAndDx = (trSum: number, pDm: number, mDm: number) => {
      const pdi = trSum > 0 ? (pDm / trSum) * 100 : 0;
      const mdi = trSum > 0 ? (mDm / trSum) * 100 : 0;
      const diSum = pdi + mdi;
      const dx = diSum > 0 ? (Math.abs(pdi - mdi) / diSum) * 100 : 0;
      return { dx, pdi, mdi };
    };

    dxSeries.push(computeDiAndDx(smoothedTr, smoothedPlusDm, smoothedMinusDm));

    for (let i = period; i < trList.length; i++) {
      smoothedTr = smoothedTr - smoothedTr / period + trList[i];
      smoothedPlusDm = smoothedPlusDm - smoothedPlusDm / period + plusDmList[i];
      smoothedMinusDm = smoothedMinusDm - smoothedMinusDm / period + minusDmList[i];
      dxSeries.push(computeDiAndDx(smoothedTr, smoothedPlusDm, smoothedMinusDm));
    }

    if (dxSeries.length < period) {
      return [];
    }

    const results: ADXPoint[] = [];
    let adx = 0;
    for (let i = 0; i < period; i++) {
      adx += dxSeries[i].dx;
    }
    adx /= period;

    results.push({
      adx,
      pdi: dxSeries[period - 1].pdi,
      mdi: dxSeries[period - 1].mdi,
    });

    for (let i = period; i < dxSeries.length; i++) {
      adx = (adx * (period - 1) + dxSeries[i].dx) / period;
      results.push({
        adx,
        pdi: dxSeries[i].pdi,
        mdi: dxSeries[i].mdi,
      });
    }

    return results;
  }

  /**
   * Returns the latest ADX point from a candle array.
   */
  public static getLatestADX(candles: Candle[], period: number): ADXPoint | null {
    const series = this.calculateADX(candles, period);
    return series.length > 0 ? series[series.length - 1] : null;
  }

  /**
   * Calculates Relative Strength Index (RSI) series.
   */
  public static calculateRSI(values: number[], period: number): number[] {
    if (period <= 0 || values.length < period + 1) {
      return [];
    }
    return RSI.calculate({ period, values });
  }

  /**
   * Returns the latest RSI value from a candle array using close prices.
   */
  public static getLatestRSI(candles: Candle[], period: number): number | null {
    if (candles.length < period + 1) return null;
    const closes = candles.map((c) => c.close);
    const series = this.calculateRSI(closes, period);
    return series.length > 0 ? series[series.length - 1] : null;
  }

  /**
   * Calculates Bollinger Bands series including normalized width: (Upper - Lower) / Middle.
   */
  public static calculateBollingerBands(
    values: number[],
    period: number,
    stdDev: number
  ): BollingerBandsPoint[] {
    if (period <= 0 || values.length < period) {
      return [];
    }
    const raw = BollingerBands.calculate({
      period,
      stdDev,
      values,
    });

    return raw.map((item) => {
      const width = item.middle !== 0 ? (item.upper - item.lower) / item.middle : 0;
      return {
        upper: item.upper,
        middle: item.middle,
        lower: item.lower,
        pb: item.pb,
        width,
      };
    });
  }

  /**
   * Returns the latest Bollinger Bands point from a candle array.
   */
  public static getLatestBollingerBands(
    candles: Candle[],
    period: number,
    stdDev: number
  ): BollingerBandsPoint | null {
    if (candles.length < period) return null;
    const closes = candles.map((c) => c.close);
    const series = this.calculateBollingerBands(closes, period, stdDev);
    return series.length > 0 ? series[series.length - 1] : null;
  }

  /**
   * Calculates the Donchian Channel over the lookback window.
   * By default, `excludeCurrent = true` computes Max(High) and Min(Low) over the `lookback`
   * candles immediately preceding the last candle, enabling clean breakout detection.
   */
  public static getDonchianChannel(
    candles: Candle[],
    lookback: number,
    excludeCurrent = true
  ): DonchianChannelPoint | null {
    const minRequired = excludeCurrent ? lookback + 1 : lookback;
    if (lookback <= 0 || candles.length < minRequired) {
      return null;
    }

    const endIndex = excludeCurrent ? candles.length - 1 : candles.length;
    const startIndex = endIndex - lookback;
    const windowSlice = candles.slice(startIndex, endIndex);

    let upper = -Infinity;
    let lower = Infinity;

    for (const c of windowSlice) {
      if (c.high > upper) upper = c.high;
      if (c.low < lower) lower = c.low;
    }

    return {
      upper,
      lower,
      middle: (upper + lower) / 2,
    };
  }
}
