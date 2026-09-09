# -*- coding: utf-8 -*-
"""T+1 次日开盘回测（对齐安卓 backtest.js）。"""
from __future__ import annotations

import math
import re
import threading
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
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


GAP_LOOKBACK = BACKTEST_LOOKBACK
GAP_MIN_SAMPLES = 8
GAP_TOP_N = 10
GAP_WORKERS = 8
GAP_K = 20
GAP_PRIOR = 4
GAP_FEATURE_START = 20
GAP_FEATURE_WEIGHTS = (1.6, 0.8, 1.0, 1.0, 0.6)
GAP_CONFIRM_LIMIT = 80
GAP_OWN_WEIGHT = 0.65
GAP_MARKET_WEIGHT = 0.35


def _clip(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _day_features(history: pd.DataFrame, index: int) -> tuple[float, ...] | None:
    if index < GAP_FEATURE_START:
        return None
    rows = history.iloc[: index + 1]
    day = rows.iloc[-1]
    close = float(day["收盘"])
    open_px = float(day["开盘"]) if "开盘" in day else close
    if close <= 0:
        return None
    if "涨跌幅" in day and pd.notna(day["涨跌幅"]):
        pct = float(day["涨跌幅"])
    elif len(rows) >= 2:
        prev = float(rows.iloc[-2]["收盘"])
        pct = (close / prev - 1) * 100 if prev > 0 else 0.0
    else:
        pct = 0.0
    volumes = (
        pd.to_numeric(rows["成交量"], errors="coerce").fillna(0.0)
        if "成交量" in rows
        else pd.Series([0.0] * len(rows))
    )
    vol = float(volumes.iloc[-1])
    vol_base = (
        float(volumes.iloc[-6:-1].mean())
        if len(volumes) >= 6
        else float(volumes.iloc[:-1].mean() or 0.0)
    )
    vol_rel = _clip(vol / vol_base if vol_base > 0 else 1.0, 0.2, 8.0)
    closes = pd.to_numeric(rows["收盘"], errors="coerce")
    ma5 = float(closes.iloc[-5:].mean())
    ma5_bias = (close - ma5) / ma5 * 100 if ma5 > 0 else 0.0
    highs = pd.to_numeric(rows["最高"], errors="coerce") if "最高" in rows else closes
    high20 = float(highs.iloc[-20:].max())
    near_high = close / high20 * 100 if high20 > 0 else 100.0
    body = (close - open_px) / close * 100
    return (pct, vol_rel, ma5_bias, near_high, body)


def _feature_scale(samples: list[tuple[float, ...]]) -> tuple[list[float], list[float]]:
    dim = len(samples[0])
    means: list[float] = []
    stds: list[float] = []
    for j in range(dim):
        col = [row[j] for row in samples]
        mean = sum(col) / len(col)
        var = sum((x - mean) ** 2 for x in col) / len(col)
        means.append(mean)
        stds.append(math.sqrt(var) if var > 1e-8 else 1.0)
    return means, stds


def _feature_distance(
    left: tuple[float, ...],
    right: tuple[float, ...],
    means: list[float],
    stds: list[float],
) -> float:
    total = 0.0
    for i, weight in enumerate(GAP_FEATURE_WEIGHTS):
        z1 = (left[i] - means[i]) / stds[i]
        z2 = (right[i] - means[i]) / stds[i]
        total += weight * (z1 - z2) ** 2
    return math.sqrt(total)


def _next_open_pct(history: pd.DataFrame, index: int) -> float | None:
    day = history.iloc[index]
    nxt = history.iloc[index + 1]
    day_close = float(day["收盘"])
    next_open = float(nxt["开盘"])
    if day_close <= 0 or next_open <= 0:
        return None
    return (next_open / day_close - 1) * 100


def _collect_gap_pool(
    history: pd.DataFrame,
    code: str,
    name: str,
) -> tuple[tuple[float, ...] | None, list[dict[str, Any]], str]:
    required = {"开盘", "收盘"}
    if history.empty or not required.issubset(history.columns):
        return None, [], "未取到日K线，可能停牌、退市或行情接口失败"
    if len(history) < GAP_FEATURE_START + 1:
        return None, [], f"日K只有 {len(history)} 根，至少需要 {GAP_FEATURE_START + 1} 根才能看今日形态"
    today_idx = len(history) - 1
    today_feat = _day_features(history, today_idx)
    if today_feat is None:
        return None, [], "今日形态无法计算"
    pool: list[dict[str, Any]] = []
    for i in range(GAP_FEATURE_START, today_idx):
        feat = _day_features(history, i)
        open_pct = _next_open_pct(history, i)
        if feat is None or open_pct is None:
            continue
        nxt = history.iloc[i + 1]
        day = history.iloc[i]
        high_pct = (
            (float(nxt["最高"]) / float(day["收盘"]) - 1) * 100
            if "最高" in nxt
            else open_pct
        )
        close_pct = (float(nxt["收盘"]) / float(day["收盘"]) - 1) * 100
        pool.append(
            {
                "index": i,
                "today_idx": today_idx,
                "feat": feat,
                "open_pct": open_pct,
                "sample": {
                    "代码": code,
                    "名称": name,
                    "日期": str(day.get("日期", "")),
                    "次日": str(nxt.get("日期", "")),
                    "当日涨幅": round(float(feat[0]), 2),
                    "次日开盘涨跌": round(open_pct, 2),
                    "次日最高涨跌": round(high_pct, 2),
                    "次日收盘涨跌": round(close_pct, 2),
                },
            }
        )
    return today_feat, pool, ""


def _score_gap_pool(
    today_feat: tuple[float, ...],
    pool: list[dict[str, Any]],
) -> dict[str, Any] | None:
    if len(pool) < GAP_MIN_SAMPLES:
        return None
    feature_rows = [item["feat"] for item in pool]
    means, stds = _feature_scale(feature_rows + [today_feat])
    for item in pool:
        dist = _feature_distance(item["feat"], today_feat, means, stds)
        age = int(item.get("today_idx", item["index"] + 1)) - int(item["index"])
        item["dist"] = dist
        item["weight"] = (1.0 / (dist + 0.15)) * math.exp(-age / 90.0)
    ranked = sorted(pool, key=lambda x: x["dist"])[:GAP_K]
    weight_sum = sum(float(x["weight"]) for x in ranked)
    if weight_sum <= 0:
        return None

    def weighted_rate(threshold: float) -> float:
        hit = sum(float(x["weight"]) for x in ranked if x["open_pct"] >= threshold)
        return hit / weight_sum * 100

    knn_p0 = weighted_rate(0)
    uncond = sum(1 for x in pool if x["open_pct"] >= 0) / len(pool) * 100
    n = len(ranked)
    next_p = (n * knn_p0 + GAP_PRIOR * uncond) / (n + GAP_PRIOR)
    return {
        "次日高开概率": round(next_p, 2),
        "相似样本": n,
        "高开≥1%": round(weighted_rate(1), 2),
        "高开≥2%": round(weighted_rate(2), 2),
        "平均开盘涨跌": round(
            sum(float(x["weight"]) * float(x["open_pct"]) for x in ranked) / weight_sum, 2
        ),
        "历史高开率": round(uncond, 2),
        "samples": [{**x["sample"], "形态距离": round(float(x["dist"]), 3)} for x in ranked],
    }


def predict_next_gap(
    history: pd.DataFrame,
    code: str,
    name: str,
    spot_pct: float | None = None,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    row, samples, _today_feat, _reason = predict_next_gap_detail(
        history, code, name, spot_pct
    )
    return row, samples


def predict_next_gap_detail(
    history: pd.DataFrame,
    code: str,
    name: str,
    spot_pct: float | None = None,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]], tuple[float, ...] | None, str]:
    today_feat, pool, reason = _collect_gap_pool(history, code, name)
    if today_feat is None:
        return None, [], None, reason or "今日形态无法计算"
    scored = _score_gap_pool(today_feat, pool)
    today_pct = float(today_feat[0])
    if spot_pct is not None and pd.notna(spot_pct):
        today_pct = float(spot_pct)
    if not scored:
        return (
            None,
            [],
            today_feat,
            f"本股可对比历史日只有 {len(pool)} 个，少于 {GAP_MIN_SAMPLES} 个",
        )
    row = {
        "代码": code,
        "名称": name,
        "当日涨跌幅": round(today_pct, 2),
        "次日高开概率": scored["次日高开概率"],
        "本股相似概率": scored["次日高开概率"],
        "相似样本": scored["相似样本"],
        "高开≥1%": scored["高开≥1%"],
        "高开≥2%": scored["高开≥2%"],
        "平均开盘涨跌": scored["平均开盘涨跌"],
        "历史高开率": scored["历史高开率"],
    }
    return row, scored["samples"], today_feat, ""


def _gap_rank_key(row: dict[str, Any]) -> tuple[float, float, float, int]:
    return (
        float(row.get("次日高开概率") or 0),
        float(row.get("高开≥1%") or 0),
        float(row.get("平均开盘涨跌") or 0),
        int(row.get("相似样本") or 0),
    )


def _lookup_quote(code: str) -> dict[str, Any]:
    try:
        payload = screen.get_json(
            screen.QUOTE_URL,
            {
                "secid": screen.to_secid(code),
                "fields": "f57,f58",
                "ut": "bd1d9ddb04089700cf9c27f6f7426281",
            },
        )
        data = payload.get("data") or {}
        return {
            "名称": str(data.get("f58") or ""),
            "涨跌幅": None,
        }
    except Exception:  # noqa: BLE001
        return {}


def _gap_confirm_targets(code: str, limit: int = GAP_CONFIRM_LIMIT) -> list[dict[str, str]]:
    code = str(code).zfill(6)
    seen: set[str] = {code}
    targets: list[dict[str, str]] = []

    def add_rows(items: list[dict[str, Any]]) -> None:
        for item in items:
            other = str(item.get("代码") or item.get("f12") or "").zfill(6)
            name = str(item.get("名称") or item.get("f14") or "")
            if not other or other in seen or "ST" in name.upper() or "退" in name:
                continue
            seen.add(other)
            targets.append({"代码": other, "名称": name})

    try:
        info = screen.fetch_industry(code)
        industry_code = str(info.get("industry_code") or "")
        if industry_code:
            peers = screen.fetch_clist(
                f"b:{industry_code}+f:!50",
                "f12,f14,f6",
                extra={"fid": "f6", "pz": "100"},
            )
            peers = sorted(peers, key=lambda item: float(item.get("f6") or 0), reverse=True)
            add_rows(peers)
    except Exception:  # noqa: BLE001
        pass
    if len(targets) < limit:
        try:
            spot = screen.fetch_spot()
            if not spot.empty:
                ordered = spot.sort_values("成交额", ascending=False, na_position="last")
                add_rows(ordered.to_dict("records"))
        except Exception:  # noqa: BLE001
            pass
    return targets[:limit]


def _confirm_with_market(
    today_feat: tuple[float, ...],
    code: str,
    lookback: int,
    log_callback: Callable[[str], None],
    stop_event: threading.Event | None,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    targets = _gap_confirm_targets(code)
    if not targets:
        return None, []
    log_callback(f"   市场确认：扫描 {len(targets)} 只相关/活跃股的相似历史日")
    market_pool: list[dict[str, Any]] = []
    completed = 0
    workers = min(GAP_WORKERS, max(1, len(targets)))
    pool = ThreadPoolExecutor(max_workers=workers)
    futures = {
        pool.submit(screen.fetch_kline, item["代码"], lookback): item
        for item in targets
    }
    try:
        while futures:
            if stop_event and stop_event.is_set():
                break
            done, _ = wait(futures, timeout=0.2, return_when=FIRST_COMPLETED)
            for future in done:
                item = futures.pop(future)
                completed += 1
                try:
                    history = future.result()
                except Exception:  # noqa: BLE001
                    continue
                _feat, days, _reason = _collect_gap_pool(history, item["代码"], item["名称"])
                market_pool.extend(days)
                if completed % 20 == 0 or completed == len(targets):
                    log_callback(
                        f"   市场确认进度 {completed}/{len(targets)}，已收集 {len(market_pool)} 个历史日"
                    )
    finally:
        for future in futures:
            future.cancel()
        pool.shutdown(wait=False, cancel_futures=True)
    scored = _score_gap_pool(today_feat, market_pool)
    if not scored:
        log_callback(f"   市场确认：相似历史日不足（{len(market_pool)}）")
        return None, []
    log_callback(
        f"   市场确认概率 {scored['次日高开概率']}%（相似 {scored['相似样本']} 日）"
    )
    return scored, scored["samples"]


def _merge_own_and_market(
    row: dict[str, Any] | None,
    own_samples: list[dict[str, Any]],
    market: dict[str, Any] | None,
    market_samples: list[dict[str, Any]],
    code: str,
    name: str,
    today_feat: tuple[float, ...] | None,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    if row is None and not market:
        return None, own_samples
    if row is None and market and today_feat is not None:
        row = {
            "代码": code,
            "名称": name,
            "当日涨跌幅": round(float(today_feat[0]), 2),
            "次日高开概率": market["次日高开概率"],
            "本股相似概率": None,
            "相似样本": 0,
            "高开≥1%": market["高开≥1%"],
            "高开≥2%": market["高开≥2%"],
            "平均开盘涨跌": market["平均开盘涨跌"],
            "历史高开率": None,
        }
    assert row is not None
    if market:
        own_p = row.get("本股相似概率")
        if own_p is None:
            combined = float(market["次日高开概率"])
        else:
            combined = (
                GAP_OWN_WEIGHT * float(own_p)
                + GAP_MARKET_WEIGHT * float(market["次日高开概率"])
            )
        row["市场确认概率"] = market["次日高开概率"]
        row["市场相似样本"] = market["相似样本"]
        row["次日高开概率"] = round(combined, 2)
        if abs(float(own_p or market["次日高开概率"]) - float(market["次日高开概率"])) >= 15:
            row["确认"] = "分歧"
        else:
            row["确认"] = "接近"
        samples = own_samples + market_samples[:10]
    else:
        row["市场确认概率"] = None
        row["确认"] = "仅本股"
        samples = own_samples
    return row, samples


def run_gap_probability(
    codes_text: str,
    lookback: int = GAP_LOOKBACK,
    log_callback: Callable[[str], None] = screen.log,
    stop_event: threading.Event | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    codes = split_codes(codes_text)
    if not codes:
        raise RuntimeError("请输入股票代码")
    log_callback(
        f"计算次日高开概率：{len(codes)} 只；先按本股相似日估计，"
        "再用行业/活跃股的相似历史日做市场确认。"
    )
    rows: list[dict[str, Any]] = []
    all_samples: list[dict[str, Any]] = []
    for idx, code in enumerate(codes, start=1):
        if stop_event and stop_event.is_set():
            log_callback("高开概率计算已停止")
            break
        info = _lookup_quote(code)
        name = str(info.get("名称") or "")
        log_callback(f"计算 {idx}/{len(codes)}：{code} {name}".strip())
        try:
            history = screen.fetch_kline(code, limit=lookback)
            row, samples, today_feat, reason = predict_next_gap_detail(
                history, code, name, info.get("涨跌幅")
            )
            if row:
                log_callback(
                    f"   本股相似概率 {row['本股相似概率']}%（相似 {row['相似样本']} 日，"
                    f"历史高开率 {row['历史高开率']}%）"
                )
            elif reason:
                log_callback(f"   {code}：{reason}")
            market = None
            market_samples: list[dict[str, Any]] = []
            if today_feat is not None and not (stop_event and stop_event.is_set()):
                market, market_samples = _confirm_with_market(
                    today_feat, code, lookback, log_callback, stop_event
                )
            row, samples = _merge_own_and_market(
                row, samples, market, market_samples, code, name, today_feat
            )
        except Exception as exc:  # noqa: BLE001
            log_callback(f"   {code}：读取失败 {exc}")
            continue
        if not row:
            log_callback(f"   {code}：无法估计次日高开概率")
            continue
        all_samples.extend(samples)
        rows.append(row)
        extra = ""
        if row.get("市场确认概率") is not None:
            extra = f"，市场确认 {row['市场确认概率']}%（{row.get('确认') or ''}）"
        log_callback(
            f"   {code} {name}：次日高开概率 {row['次日高开概率']}%{extra}".strip()
        )
    if not rows:
        raise RuntimeError("没有可计算高开概率的股票")
    return pd.DataFrame(rows), pd.DataFrame(all_samples)


def _eval_gap_stock(
    code: str,
    name: str,
    lookback: int,
    spot_pct: float | None = None,
    keep_samples: bool = True,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    history = screen.fetch_kline(code, limit=lookback)
    row, samples = predict_next_gap(history, code, name, spot_pct)
    return row, (samples if keep_samples else [])


def run_gap_scan_top(
    top_n: int = GAP_TOP_N,
    lookback: int = GAP_LOOKBACK,
    min_samples: int = GAP_MIN_SAMPLES,
    workers: int = GAP_WORKERS,
    log_callback: Callable[[str], None] = screen.log,
    stop_event: threading.Event | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    if top_n < 1:
        raise RuntimeError("排名数量必须大于 0")
    log_callback("拉取全市场行情...")
    spot = screen.fetch_spot()
    if spot.empty:
        raise RuntimeError("未取到股票列表")
    candidates = spot.copy()
    candidates["名称"] = candidates["名称"].fillna("").astype(str)
    candidates = candidates[
        ~candidates["名称"].str.contains("ST|退", regex=True, case=False)
        & (pd.to_numeric(candidates["最新价"], errors="coerce") > 0)
    ].drop_duplicates("代码")
    if candidates.empty:
        raise RuntimeError("没有可扫描的股票")
    rows = [
        (str(row["代码"]).zfill(6), str(row["名称"]), row.get("涨跌幅"))
        for _, row in candidates.iterrows()
    ]
    log_callback(
        f"全盘扫描次日高开概率：{len(rows)} 只，排除 ST/退市；"
        f"按今日形态匹配历史相似日，相似样本少于 {min_samples} 不进榜。"
        "首次扫描较慢，当天再次运行会使用缓存。"
    )
    summaries: list[dict[str, Any]] = []
    completed = 0
    failed = 0
    pool = ThreadPoolExecutor(max_workers=max(1, workers))
    futures = {
        pool.submit(_eval_gap_stock, code, name, lookback, pct, False): (code, name)
        for code, name, pct in rows
    }
    stopped = False
    try:
        while futures:
            if stop_event and stop_event.is_set():
                stopped = True
                break
            done, _ = wait(futures, timeout=0.2, return_when=FIRST_COMPLETED)
            for future in done:
                code, name = futures.pop(future)
                completed += 1
                try:
                    row, _samples = future.result()
                except Exception as exc:  # noqa: BLE001
                    failed += 1
                    if completed <= 8 or completed % 200 == 0:
                        log_callback(f"   {code}：读取失败 {exc}")
                    continue
                if row and int(row["相似样本"]) >= min_samples:
                    summaries.append(row)
                if completed % 100 == 0 or completed == len(rows):
                    log_callback(
                        f"进度 {completed}/{len(rows)}，有效 {len(summaries)} 只"
                        + (f"，失败 {failed}" if failed else "")
                    )
    finally:
        if stopped:
            for future in futures:
                future.cancel()
        pool.shutdown(wait=False, cancel_futures=True)
    if stopped:
        log_callback(f"全盘扫描已停止：已完成 {completed}/{len(rows)}")
    if not summaries:
        raise RuntimeError("没有满足最少样本数的股票")
    summaries.sort(key=_gap_rank_key, reverse=True)
    top = summaries[:top_n]
    ranked: list[dict[str, Any]] = []
    for idx, row in enumerate(top, start=1):
        ranked.append({"排名": idx, **row})
        log_callback(
            f"前十 {idx}. {row['代码']} {row['名称']}  次日高开概率 {row['次日高开概率']}%"
            f"（相似 {row['相似样本']} 日）"
        )
    log_callback(f"全盘次日高开概率扫描完成：有效 {len(summaries)} 只，已列出前 {len(ranked)}")
    return pd.DataFrame(ranked), pd.DataFrame()
