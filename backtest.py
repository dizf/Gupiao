# -*- coding: utf-8 -*-
"""T+1 次日开盘回测（对齐安卓 backtest.js）。"""
from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from typing import Any, Callable

import pandas as pd

import screen

BACKTEST_LOOKBACK = 120


@dataclass
class BacktestOptions:
    pct_min: float = 3.0
    pct_max: float = 5.0
    require_ma_bullish: bool = False
    require_near_high: bool = False
    near_20d_high: float = 0.97
    require_limit_up: bool = False
    limit_up_lookback: int = 20
    min_samples: int = 1
    stock_limit: int = 20


def _match_day(
    history: pd.DataFrame,
    index: int,
    options: BacktestOptions,
    code: str,
    name: str,
) -> bool:
    rows = history.iloc[: index + 1]
    day = rows.iloc[-1]
    pct = float(day["涨跌幅"])
    if pct < options.pct_min or pct > options.pct_max:
        return False
    if options.require_ma_bullish and not screen.is_ma_bullish(rows):
        return False
    if options.require_near_high:
        cfg = screen.ScreenConfig(near_20d_high=options.near_20d_high)
        if not screen.near_20d_high(rows, cfg):
            return False
    if options.require_limit_up:
        cfg = screen.ScreenConfig(limit_up_lookback=options.limit_up_lookback)
        if not screen.has_limit_up_gene(rows, code, name, cfg):
            return False
    return True


def analyze_history(
    history: pd.DataFrame,
    code: str,
    name: str,
    options: BacktestOptions,
) -> list[dict[str, Any]]:
    if history.empty or len(history) < 63:
        return []
    samples: list[dict[str, Any]] = []
    start = max(62, 20)
    for i in range(start, len(history) - 1):
        if not _match_day(history, i, options, code, name):
            continue
        day = history.iloc[i]
        nxt = history.iloc[i + 1]
        day_close = float(day["收盘"])
        next_open = float(nxt["开盘"])
        if day_close <= 0 or next_open <= 0:
            continue
        open_pct = (next_open / day_close - 1) * 100
        high_pct = (float(nxt["最高"]) / day_close - 1) * 100
        close_pct = (float(nxt["收盘"]) / day_close - 1) * 100
        samples.append(
            {
                "代码": code,
                "名称": name,
                "日期": str(day.get("日期", "")),
                "次日": str(nxt.get("日期", "")),
                "当日涨幅": round(float(day["涨跌幅"]), 2),
                "次日开盘涨跌": round(open_pct, 2),
                "次日最高涨跌": round(high_pct, 2),
                "次日收盘涨跌": round(close_pct, 2),
            }
        )
    return samples


def summarize(samples: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not samples:
        return None
    opens = [float(x["次日开盘涨跌"]) for x in samples]
    highs = [float(x["次日最高涨跌"]) for x in samples]
    closes = [float(x["次日收盘涨跌"]) for x in samples]

    def avg(xs: list[float]) -> float:
        return sum(xs) / len(xs)

    def rate(xs: list[float], threshold: float) -> float:
        return sum(1 for x in xs if x >= threshold) / len(xs) * 100

    return {
        "样本数": len(samples),
        "次日高开率": round(rate(opens, 0), 2),
        "高开≥1%": round(rate(opens, 1), 2),
        "高开≥2%": round(rate(opens, 2), 2),
        "平均开盘涨跌": round(avg(opens), 2),
        "平均最高涨跌": round(avg(highs), 2),
        "平均收盘涨跌": round(avg(closes), 2),
    }


def split_codes(text: str) -> list[str]:
    return [c.zfill(6) for c in re.split(r"[\s,，、;；]+", text.strip()) if c]


def resolve_targets(
    codes_text: str,
    screen_rows: pd.DataFrame | None,
    options: BacktestOptions,
    log_callback: Callable[[str], None] = screen.log,
) -> list[dict[str, str]]:
    text = (codes_text or "").strip()
    if text:
        codes = split_codes(text)
        log_callback(f"已指定 {len(codes)} 只股票")
        return [{"代码": c, "名称": ""} for c in codes]
    if screen_rows is not None and not screen_rows.empty:
        code_col = "代码" if "代码" in screen_rows.columns else screen_rows.columns[0]
        name_col = "名称" if "名称" in screen_rows.columns else None
        rows = screen_rows.head(options.stock_limit)
        targets = [
            {
                "代码": str(row[code_col]).zfill(6),
                "名称": str(row[name_col]) if name_col else "",
            }
            for _, row in rows.iterrows()
        ]
        log_callback(f"使用当前选股结果前 {len(targets)} 只")
        return targets
    log_callback("未填写代码且无选股结果，按成交额取活跃股...")
    spot = screen.fetch_spot()
    if spot.empty:
        return []
    ordered = (
        spot.sort_values("成交额", ascending=False)
        if "成交额" in spot.columns
        else spot
    )
    ordered = ordered.head(options.stock_limit)
    return [
        {"代码": str(row["代码"]).zfill(6), "名称": str(row.get("名称", ""))}
        for _, row in ordered.iterrows()
    ]


def run_t1_backtest(
    options: BacktestOptions,
    codes_text: str = "",
    screen_rows: pd.DataFrame | None = None,
    log_callback: Callable[[str], None] = screen.log,
    stop_event: threading.Event | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    targets = resolve_targets(codes_text, screen_rows, options, log_callback)
    if not targets:
        raise RuntimeError("没有可回测的股票")
    log_callback(
        f"T+1 回测 {len(targets)} 只；每只最多读取 {BACKTEST_LOOKBACK} 根日K"
    )
    all_samples: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []
    for idx, target in enumerate(targets, start=1):
        if stop_event and stop_event.is_set():
            log_callback("T+1 回测已停止")
            break
        code, name = target["代码"], target["名称"]
        log_callback(f"回测 {idx}/{len(targets)}：{code} {name}".strip())
        history = screen.fetch_kline(code, limit=BACKTEST_LOOKBACK)
        if stop_event and stop_event.is_set():
            break
        samples = analyze_history(history, code, name, options)
        all_samples.extend(samples)
        log_callback(f"   {code}：命中 {len(samples)} 个历史样本")
        if len(samples) >= options.min_samples:
            summary = summarize(samples)
            if summary:
                summaries.append({"代码": code, "名称": name, **summary})
        else:
            log_callback(
                f"   {code}：样本少于最低要求 {options.min_samples}，不计入单股汇总"
            )
    aggregate = summarize(all_samples)
    if aggregate:
        summaries.insert(0, {"代码": "全部", "名称": "合计", **aggregate})
        log_callback(
            f"合计：次日高开率 {aggregate['次日高开率']}%，"
            f"高开≥1% {aggregate['高开≥1%']}%，高开≥2% {aggregate['高开≥2%']}%"
        )
    log_callback(f"T+1 回测完成：共 {len(all_samples)} 个历史触发样本")
    return pd.DataFrame(summaries), pd.DataFrame(all_samples)
