"""
DOUGHCON × US Equity Merger
===========================

``data/doughcon_raw.csv`` 의 30분 단위 원시 데이터를 일간 집계한 뒤
yfinance 로 가져온 S&P 500(^GSPC), Nasdaq(^IXIC) 일간 종가/수익률과 병합한다.

기획서 §4.3(merger 명세), §5.2(일간 집계 설계) 를 구현한다. 자동화 루프
외부에서 수동으로 1회 실행한다 (기획서 §3.1).

사용 예
-------
    python merger.py
    python merger.py --start 2026-06-01 --end 2026-09-01
    python merger.py --raw data/doughcon_raw.csv --out data/merged_final.csv

집계 규약 (기획서 §5.2)
-----------------------
    level_min     : 당일 최고 위험도(=가장 낮은 레벨). 이벤트 스터디 기준
    level_mean    : 일간 평균 긴장도. 추세 분석
    smoothed_mean : 회귀 분석 주력 변수
    n_obs         : 수집 횟수. 데이터 품질 지표 (정상 48)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Optional

import pandas as pd

try:
    import yfinance as yf
except ImportError as exc:  # 친절한 에러
    print(
        "yfinance 가 설치되어 있지 않습니다. `pip install -r requirements.txt` 후 다시 실행해 주세요.",
        file=sys.stderr,
    )
    raise SystemExit(1) from exc


DEFAULT_RAW = Path(__file__).resolve().parent / "data" / "doughcon_raw.csv"
DEFAULT_OUT = Path(__file__).resolve().parent / "data" / "merged_final.csv"

TICKERS = {
    "sp500": "^GSPC",
    "nasdaq": "^IXIC",
}


def load_raw(csv_path: Path) -> pd.DataFrame:
    if not csv_path.exists():
        raise FileNotFoundError(
            f"raw csv not found: {csv_path}. collector.py 를 먼저 실행하세요."
        )
    df = pd.read_csv(csv_path)
    if df.empty:
        raise ValueError(f"raw csv is empty: {csv_path}")

    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    df = df.dropna(subset=["timestamp", "doughcon_level"])
    df["doughcon_level"] = df["doughcon_level"].astype(int)
    for col in ("overall_index", "smoothed_index"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    return df.sort_values("timestamp").reset_index(drop=True)


def aggregate_daily(df: pd.DataFrame) -> pd.DataFrame:
    """기획서 §5.2 일간 집계.

    UTC 일자 기준으로 그룹화한다. (시장 데이터와의 정확한 시간대 정렬은
    분석 단계에서 lag(0/+1) 비교로 다룬다.)
    """
    df = df.copy()
    df["date"] = df["timestamp"].dt.tz_convert("UTC").dt.date

    grouped = df.groupby("date").agg(
        level_min=("doughcon_level", "min"),
        level_mean=("doughcon_level", "mean"),
        smoothed_mean=("smoothed_index", "mean"),
        overall_mean=("overall_index", "mean"),
        n_obs=("doughcon_level", "count"),
    )
    grouped.index = pd.to_datetime(grouped.index)
    return grouped


def fetch_market(
    start: pd.Timestamp,
    end: pd.Timestamp,
) -> pd.DataFrame:
    """yfinance 로 SPX, IXIC 일간 종가/로그수익률을 가져온다.

    end 는 inclusive 가 되도록 +1 일 패딩.
    """
    yf_end = (end + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    yf_start = start.strftime("%Y-%m-%d")

    raw = yf.download(
        list(TICKERS.values()),
        start=yf_start,
        end=yf_end,
        progress=False,
        auto_adjust=True,
        group_by="ticker",
    )

    if raw is None or raw.empty:
        raise RuntimeError("yfinance 가 빈 결과를 반환했습니다. 네트워크/티커를 확인하세요.")

    pieces = []
    for label, ticker in TICKERS.items():
        try:
            close = raw[ticker]["Close"]
        except KeyError:
            close = raw["Close"][ticker] if isinstance(raw.columns, pd.MultiIndex) else raw["Close"]
        s = close.rename(f"{label}_close").to_frame()
        s[f"{label}_ret"] = s[f"{label}_close"].pct_change()
        pieces.append(s)

    market = pd.concat(pieces, axis=1)
    market.index = pd.to_datetime(market.index).tz_localize(None)
    return market


def merge_all(daily: pd.DataFrame, market: pd.DataFrame) -> pd.DataFrame:
    """일간 DOUGHCON 집계와 시장 데이터를 날짜 기준 inner join."""
    market = market.copy()
    market.index.name = "date"

    daily_idx = pd.to_datetime(daily.index).tz_localize(None)
    daily = daily.copy()
    daily.index = daily_idx
    daily.index.name = "date"

    merged = daily.join(market, how="inner")
    return merged


def run(raw_path: Path, out_path: Path, start: Optional[str], end: Optional[str]) -> None:
    print(f"[merger] raw : {raw_path}")
    raw = load_raw(raw_path)
    print(f"[merger] rows: {len(raw):>6}  range: {raw['timestamp'].min()} ~ {raw['timestamp'].max()}")

    daily = aggregate_daily(raw)
    print(f"[merger] daily rows: {len(daily)}")

    if start:
        daily = daily.loc[daily.index >= pd.Timestamp(start)]
    if end:
        daily = daily.loc[daily.index <= pd.Timestamp(end)]
    if daily.empty:
        raise RuntimeError("필터링 후 남은 일간 데이터가 없습니다.")

    market = fetch_market(daily.index.min(), daily.index.max())
    print(f"[merger] market rows: {len(market)} (SPX/IXIC close+return)")

    merged = merge_all(daily, market)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    merged.to_csv(out_path, index_label="date")
    print(f"[merger] wrote {len(merged)} rows → {out_path}")


def main() -> int:
    p = argparse.ArgumentParser(description="DOUGHCON × US equity merger (manual one-shot)")
    p.add_argument("--raw", type=Path, default=DEFAULT_RAW, help="raw csv path")
    p.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output merged csv path")
    p.add_argument("--start", type=str, default=None, help="filter start date (YYYY-MM-DD)")
    p.add_argument("--end", type=str, default=None, help="filter end date (YYYY-MM-DD)")
    args = p.parse_args()

    try:
        run(args.raw, args.out, args.start, args.end)
    except Exception as exc:
        print(f"[merger][ERROR] {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
