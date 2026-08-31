# -*- coding: utf-8 -*-
"""
每天下午 14:30 之后运行：按指定条件筛选 A 股。
"""
from __future__ import annotations

import argparse
import csv
from dataclasses import asdict, dataclass
from functools import lru_cache
import json
import math
from pathlib import Path
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from io import StringIO
from typing import Any, Callable

import pandas as pd
import requests

# ---------- 筛选参数（与需求一一对应）----------
PCT_MIN, PCT_MAX = 3.0, 5.0
TURNOVER_MIN, TURNOVER_MAX = 5.0, 10.0
VOLUME_RATIO_MIN = 1.5
CIRC_MV_YI_MIN, CIRC_MV_YI_MAX = 50.0, 200.0  # 原文：低于50亿或高于200亿剔除
HOT_BOARD_TOP_N = 10
# 统计/情绪结果板块，不算题材热点
HOT_BOARD_SKIP_WORDS = ("昨日", "涨停", "连板", "打板", "打二板", "历史新高", "跌停", "炸板", "题材股")
LIMIT_UP_LOOKBACK = 20
VOLUME_STAIR_DAYS = 5
ABOVE_VWAP_RATIO = 1.0  # 9:35 后全部分时收盘价都在均价线上方
SKIP_OPEN_MINUTES = 5
RAPID_RISE_WINDOW = 5
RAPID_RISE_PCT = 2.0
RAPID_VOLUME_MULTIPLE = 1.5
MONITOR_INTERVAL = 60
MAX_MA5_BIAS = 0.07  # 股价远离5日线不进：相对 MA5 偏离上限
NEAR_20D_HIGH = 0.97  # 上方无套牢压力：收盘不低于近20日高点的 97%
PLATFORM_LOOKBACK = 15  # 未跌破近15日平台低点

EASTMONEY_CLIST = "https://push2delay.eastmoney.com/api/qt/clist/get"
EASTMONEY_KLINE_HOSTS = (
    "https://push2his.eastmoney.com/api/qt/stock/kline/get",
    "https://push2delay.eastmoney.com/api/qt/stock/kline/get",
)
EASTMONEY_TREND_HOSTS = (
    "https://push2delay.eastmoney.com/api/qt/stock/trends2/get",
    "https://push2his.eastmoney.com/api/qt/stock/trends2/get",
)
TENCENT_KLINE_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"

SESSION = requests.Session()
SESSION.headers.update(
    {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Referer": "https://quote.eastmoney.com/center/gridlist.html",
        "Accept": "application/json, text/plain, */*",
    }
)

REQUEST_INTERVAL = 0.15
REQUEST_LOCK = threading.Lock()
LAST_REQUEST_AT = 0.0
CACHE_DIR = Path.cwd() / ".stock_cache"
HOT_BOARD_CACHE_TTL = 30 * 60
KLINE_CACHE_TTL = 24 * 60 * 60
SIMILAR_WINDOWS = (5, 10, 20, 60)
SIMILAR_HISTORY_LIMIT = 240
SIMILAR_FORWARD_DAYS = (1, 3, 5, 10)
SIMILAR_TOP_N = 10
SIMILAR_WORKERS = 12


@dataclass
class ScreenConfig:
    enable_pct: bool = True
    pct_min: float = PCT_MIN
    pct_max: float = PCT_MAX
    enable_turnover: bool = True
    turnover_min: float = TURNOVER_MIN
    turnover_max: float = TURNOVER_MAX
    enable_volume_ratio: bool = True
    volume_ratio_min: float = VOLUME_RATIO_MIN
    volume_ratio_max: float | None = None
    enable_circ_mv: bool = True
    circ_mv_min: float = CIRC_MV_YI_MIN
    circ_mv_max: float = CIRC_MV_YI_MAX
    enable_profitable: bool = True
    enable_main_inflow: bool = True
    enable_hot_board: bool = True
    hot_board_top_n: int = HOT_BOARD_TOP_N
    enable_limit_up_gene: bool = True
    limit_up_lookback: int = LIMIT_UP_LOOKBACK
    enable_volume_stair: bool = True
    volume_stair_days: int = VOLUME_STAIR_DAYS
    enable_ma_bullish: bool = True
    enable_ma5_bias: bool = True
    max_ma5_bias: float = MAX_MA5_BIAS
    enable_platform: bool = True
    platform_lookback: int = PLATFORM_LOOKBACK
    enable_near_high: bool = True
    near_20d_high: float = NEAR_20D_HIGH
    enable_vwap: bool = True
    above_vwap_ratio: float = ABOVE_VWAP_RATIO
    skip_open_minutes: int = SKIP_OPEN_MINUTES
    enable_stronger_than_index: bool = True
    enable_tail_high: bool = True
    enable_rapid_rise: bool = True
    rapid_rise_window: int = RAPID_RISE_WINDOW
    rapid_rise_pct: float = RAPID_RISE_PCT
    rapid_volume_multiple: float = RAPID_VOLUME_MULTIPLE
    monitor_interval: int = MONITOR_INTERVAL

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, values: dict[str, Any]) -> "ScreenConfig":
        defaults = cls().to_dict()
        defaults.update(values)
        return cls(**defaults)


def log(msg: str) -> None:
    print(msg, flush=True)


def _cache_path(key: str) -> Path:
    return CACHE_DIR / f"{key}.json"


def _load_disk_cache(key: str, ttl: int) -> Any | None:
    path = _cache_path(key)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if time.time() - float(payload["saved_at"]) <= ttl:
            return payload["data"]
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None
    return None


def _save_disk_cache(key: str, data: Any) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path = _cache_path(key)
        temp_path = path.with_suffix(".tmp")
        temp_path.write_text(
            json.dumps({"saved_at": time.time(), "data": data}, ensure_ascii=False),
            encoding="utf-8",
        )
        temp_path.replace(path)
    except (OSError, TypeError, ValueError):
        pass


def to_secid(code: str) -> str:
    code = str(code).zfill(6)
    if code.startswith(("6", "9")):
        return f"1.{code}"
    return f"0.{code}"


def limit_up_threshold(code: str, name: str) -> float:
    name = name or ""
    if "ST" in name.upper() or "退" in name:
        return 4.8
    if code.startswith(("300", "301", "688")):
        return 19.5
    if code.startswith(("8", "4")):
        return 29.5
    return 9.5


def get_json(url: str, params: dict[str, Any], retries: int = 3) -> dict[str, Any]:
    global LAST_REQUEST_AT
    last_err: Exception | None = None
    for i in range(retries):
        try:
            with REQUEST_LOCK:
                elapsed = time.monotonic() - LAST_REQUEST_AT
                if elapsed < REQUEST_INTERVAL:
                    time.sleep(REQUEST_INTERVAL - elapsed)
                LAST_REQUEST_AT = time.monotonic()
            resp = SESSION.get(url, params=params, timeout=15)
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            time.sleep(0.4 * (i + 1))
    raise RuntimeError(f"请求失败: {url} ({last_err})")


def get_json_hosts(urls: tuple[str, ...], params: dict[str, Any]) -> dict[str, Any]:
    last_err: Exception | None = None
    for url in urls:
        try:
            return get_json(url, params)
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            continue
    raise RuntimeError(f"请求失败: {urls[0]} ({last_err})")


def fetch_clist(fs: str, fields: str, extra: dict[str, str] | None = None) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    pn = 1
    pz = 100
    while True:
        params = {
            "pn": str(pn),
            "pz": str(pz),
            "po": "1",
            "np": "1",
            "fltt": "2",
            "invt": "2",
            "fid": "f3",
            "fs": fs,
            "fields": fields,
            "ut": "bd1d9ddb04089700cf9c27f6f7426281",
        }
        if extra:
            params.update(extra)
        data = get_json(EASTMONEY_CLIST, params)
        diff = ((data.get("data") or {}).get("diff")) or []
        if isinstance(diff, dict):
            diff = list(diff.values())
        rows.extend(diff)
        total = int((data.get("data") or {}).get("total") or 0)
        if len(rows) >= total or not diff:
            break
        pn += 1
        time.sleep(0.05)
    return rows


def fetch_spot() -> pd.DataFrame:
    fields = "f12,f14,f2,f3,f8,f9,f10,f15,f16,f17,f18,f20,f21,f23,f62"
    rows = fetch_clist(
        "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81,m:1+t:13",
        fields,
    )
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    rename = {
        "f12": "代码",
        "f14": "名称",
        "f2": "最新价",
        "f3": "涨跌幅",
        "f8": "换手率",
        "f9": "市盈率",
        "f10": "量比",
        "f15": "最高",
        "f16": "最低",
        "f17": "今开",
        "f18": "昨收",
        "f20": "总市值",
        "f21": "流通市值",
        "f23": "市净率",
        "f62": "主力净流入",
    }
    df = df.rename(columns=rename)
    numeric_cols = [
        "最新价",
        "涨跌幅",
        "换手率",
        "市盈率",
        "量比",
        "最高",
        "最低",
        "今开",
        "昨收",
        "总市值",
        "流通市值",
        "市净率",
        "主力净流入",
    ]
    for col in numeric_cols:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df["代码"] = df["代码"].astype(str).str.zfill(6)
    if df.empty:
        return df
    df["流通市值_亿"] = df["流通市值"] / 1e8
    return df


def _load_boards(fs: str, kind: str) -> pd.DataFrame:
    fields = "f12,f14,f2,f3,f20"
    rows = fetch_clist(fs, fields)
    boards = pd.DataFrame(rows).rename(columns={"f12": "板块代码", "f14": "板块名称", "f3": "涨跌幅"})
    if boards.empty:
        return boards
    boards["涨跌幅"] = pd.to_numeric(boards["涨跌幅"], errors="coerce")
    boards["类型"] = kind
    skip = "|".join(HOT_BOARD_SKIP_WORDS)
    boards = boards[~boards["板块名称"].astype(str).str.contains(skip, regex=True)]
    return boards


def fetch_hot_concepts(top_n: int) -> tuple[pd.DataFrame, set[str], dict[str, list[str]]]:
    cache_key = f"hot_boards_{datetime.now().strftime('%Y%m%d')}_{top_n}"
    cached = _load_disk_cache(cache_key, HOT_BOARD_CACHE_TTL)
    if (
        isinstance(cached, dict)
        and "boards" in cached
        and "hot_codes" in cached
        and "member_map" in cached
    ):
        return (
            pd.DataFrame(cached["boards"]),
            set(cached["hot_codes"]),
            cached["member_map"],
        )

    concept = _load_boards("m:90+t:3+f:!50", "概念")
    industry = _load_boards("m:90+t:2+f:!50", "行业")
    parts = []
    if not concept.empty:
        parts.append(concept.sort_values("涨跌幅", ascending=False).head(top_n))
    if not industry.empty:
        parts.append(industry.sort_values("涨跌幅", ascending=False).head(top_n))
    if not parts:
        return pd.DataFrame(), set(), {}
    boards = pd.concat(parts, ignore_index=True).drop_duplicates(subset=["板块代码"])

    member_map: dict[str, list[str]] = {}
    hot_codes: set[str] = set()
    cons_fields = "f12,f14"
    for _, board in boards.iterrows():
        bk = str(board["板块代码"])
        name = str(board["板块名称"])
        cons = fetch_clist(f"b:{bk}+f:!50", cons_fields)
        codes = [str(x.get("f12", "")).zfill(6) for x in cons if x.get("f12")]
        for code in codes:
            hot_codes.add(code)
            member_map.setdefault(code, []).append(name)
        time.sleep(0.05)
    _save_disk_cache(
        cache_key,
        {
            "boards": json.loads(boards.to_json(orient="records", force_ascii=False)),
            "hot_codes": sorted(hot_codes),
            "member_map": member_map,
        },
    )
    return boards, hot_codes, member_map


def fetch_index_pct() -> tuple[float, pd.DataFrame]:
    """使用东方财富获取上证指数涨跌幅和分时。"""
    params = {
        "secid": "1.000001",
        "fields1": "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58",
        "iscr": "0",
        "ndays": "1",
    }
    data = get_json_hosts(EASTMONEY_TREND_HOSTS, params).get("data") or {}
    pre = float(data.get("preClose") or 0)
    trends = data.get("trends") or []
    df = _parse_trends(trends)
    last = float(df["收盘"].iloc[-1]) if not df.empty else pre
    pct = (last / pre - 1) * 100 if pre else 0.0
    return pct, df


def _parse_trends(trends: list[str]) -> pd.DataFrame:
    rows = []
    for item in trends:
        p = item.split(",")
        if len(p) < 8:
            continue
        rows.append(
            {
                "时间": p[0],
                "开盘": float(p[1]),
                "收盘": float(p[2]),
                "最高": float(p[3]),
                "最低": float(p[4]),
                "成交量": float(p[5]),
                "成交额": float(p[6]),
                "均价": float(p[7]),
            }
        )
    return pd.DataFrame(rows)


def _fetch_tencent_kline(code: str, limit: int) -> pd.DataFrame:
    market = "sh" if code.startswith(("6", "9")) else "sz"
    start = (datetime.now() - timedelta(days=max(120, limit * 2))).strftime("%Y-%m-%d")
    params = {"param": f"{market}{code},day,{start},,{limit},qfq"}
    payload = get_json(TENCENT_KLINE_URL, params)
    data = payload.get("data") or {}
    stock = data.get(f"{market}{code}") or {}
    klines = stock.get("qfqday") or stock.get("day") or []
    rows = []
    previous_close: float | None = None
    for values in klines:
        if len(values) < 6:
            continue
        try:
            close = float(values[2])
            high = float(values[3])
            low = float(values[4])
            if close <= 0:
                continue
            pct = (
                (close / previous_close - 1) * 100
                if previous_close and previous_close > 0
                else 0.0
            )
            rows.append(
                {
                    "日期": values[0],
                    "开盘": float(values[1]),
                    "收盘": close,
                    "最高": high,
                    "最低": low,
                    "成交量": float(values[5]),
                    "成交额": 0.0,
                    "涨跌幅": pct,
                }
            )
            previous_close = close
        except (TypeError, ValueError):
            continue
    return pd.DataFrame(rows).tail(limit).reset_index(drop=True)


@lru_cache(maxsize=512)
def fetch_kline(code: str, limit: int = 80, secid: str | None = None) -> pd.DataFrame:
    identity = (secid or code).replace(".", "_")
    cache_key = f"kline_{identity}_{datetime.now().strftime('%Y%m%d')}_{limit}"
    cached = _load_disk_cache(cache_key, KLINE_CACHE_TTL)
    if cached is not None:
        cached_df = pd.DataFrame(cached)
        required = {"收盘", "最高", "最低", "成交量", "涨跌幅"}
        if not cached_df.empty and required.issubset(cached_df.columns):
            return cached_df.tail(limit).reset_index(drop=True)

    try:
        result = _fetch_tencent_kline(code, limit)
    except Exception:
        result = pd.DataFrame()
    if result.empty:
        params = {
            "secid": secid or to_secid(code),
            "klt": "101",
            "fqt": "1",
            "beg": "0",
            "lmt": str(limit),
            "end": "20500101",
            "fields1": "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        }
        klines = (
            get_json_hosts(EASTMONEY_KLINE_HOSTS, params).get("data") or {}
        ).get("klines") or []
        rows = []
        for item in klines:
            values = item.split(",")
            if len(values) < 11:
                continue
            rows.append(
                {
                    "日期": values[0],
                    "开盘": float(values[1]),
                    "收盘": float(values[2]),
                    "最高": float(values[3]),
                    "最低": float(values[4]),
                    "成交量": float(values[5]),
                    "成交额": float(values[6]),
                    "涨跌幅": float(values[8]),
                }
            )
        result = pd.DataFrame(rows)
    if not result.empty:
        _save_disk_cache(cache_key, result.to_dict("records"))
    return result


def _zscore(values: pd.Series) -> pd.Series:
    values = pd.to_numeric(values, errors="coerce").fillna(0.0)
    std = float(values.std(ddof=0))
    if std <= 1e-12:
        return pd.Series(0.0, index=values.index)
    return (values - float(values.mean())) / std


def _similarity_score(target: pd.DataFrame, candidate: pd.DataFrame) -> float:
    target_close = target["收盘"].astype(float).reset_index(drop=True)
    candidate_close = candidate["收盘"].astype(float).reset_index(drop=True)
    target_base = float(target_close.iloc[0])
    candidate_base = float(candidate_close.iloc[0])
    if target_base <= 0 or candidate_base <= 0:
        return 0.0

    target_path = target_close / target_base
    candidate_path = candidate_close / candidate_base
    price_rmse = float(((target_path - candidate_path) ** 2).mean() ** 0.5)
    price_similarity = math.exp(-8.0 * price_rmse)

    target_returns = target_close.pct_change().fillna(0.0)
    candidate_returns = candidate_close.pct_change().fillna(0.0)
    return_rmse = float(((target_returns - candidate_returns) ** 2).mean() ** 0.5)
    return_similarity = math.exp(-12.0 * return_rmse)

    target_volume = _zscore(target["成交量"].astype(float).apply(lambda value: math.log1p(max(value, 0.0))))
    candidate_volume = _zscore(
        candidate["成交量"].astype(float).apply(lambda value: math.log1p(max(value, 0.0)))
    )
    volume_rmse = float(((target_volume - candidate_volume) ** 2).mean() ** 0.5)
    volume_similarity = math.exp(-0.35 * volume_rmse)

    target_range = _zscore(
        ((target["最高"] - target["最低"]) / target["收盘"].replace(0, math.nan))
        .fillna(0.0)
        .astype(float)
    )
    candidate_range = _zscore(
        ((candidate["最高"] - candidate["最低"]) / candidate["收盘"].replace(0, math.nan))
        .fillna(0.0)
        .astype(float)
    )
    range_rmse = float(((target_range - candidate_range) ** 2).mean() ** 0.5)
    range_similarity = math.exp(-0.35 * range_rmse)
    score = 100 * (
        0.60 * price_similarity
        + 0.25 * return_similarity
        + 0.10 * volume_similarity
        + 0.05 * range_similarity
    )
    return round(max(0.0, min(100.0, score)), 2)


def _pattern_label(hist: pd.DataFrame, code: str, name: str) -> str:
    if hist.empty or len(hist) < 2:
        return "数据不足"
    close = hist["收盘"].astype(float)
    first = float(close.iloc[0])
    middle = float(close.iloc[len(close) // 2])
    last = float(close.iloc[-1])
    if first <= 0 or middle <= 0:
        return "数据不足"
    limit_up = limit_up_threshold(code, name)
    if "涨跌幅" in hist.columns and bool((hist["涨跌幅"] >= limit_up).any()):
        return "涨停"
    first_return = middle / first - 1
    second_return = last / middle - 1
    total_return = last / first - 1
    if first_return <= -0.03 and second_return >= 0.03:
        return "反弹"
    if total_return >= 0.05 and second_return > 0:
        return "上涨"
    if total_return <= -0.05:
        return "下跌"
    return "震荡"


def _forward_returns(hist: pd.DataFrame, end: int) -> dict[int, float | None]:
    base = float(hist["收盘"].iloc[end])
    if base <= 0:
        return {days: None for days in SIMILAR_FORWARD_DAYS}
    result: dict[int, float | None] = {}
    for days in SIMILAR_FORWARD_DAYS:
        future_index = end + days
        if future_index >= len(hist):
            result[days] = None
        else:
            result[days] = round(
                (float(hist["收盘"].iloc[future_index]) / base - 1) * 100, 2
            )
    return result


def _future_direction(forward: dict[int, float | None]) -> str:
    values = [value for value in forward.values() if value is not None]
    if not values:
        return "无后续数据"
    positive_ratio = sum(value > 0 for value in values) / len(values)
    average = sum(values) / len(values)
    if positive_ratio >= 0.75 and average >= 2:
        return "偏上涨"
    if positive_ratio <= 0.25 and average <= -2:
        return "偏下跌"
    return "震荡"


def _similarity_windows(value: int | str | tuple[int, ...] | None) -> tuple[int, ...]:
    if isinstance(value, tuple):
        windows = tuple(int(item) for item in value)
        if windows and all(window in SIMILAR_WINDOWS for window in windows):
            return windows
        raise ValueError("相似走势窗口必须是 5、10、20 或 60")
    if value is None or str(value).strip() in {"", "全部"}:
        return SIMILAR_WINDOWS
    try:
        window = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("相似走势窗口必须是 5、10、20 或 60") from exc
    if window not in SIMILAR_WINDOWS:
        raise ValueError("相似走势窗口必须是 5、10、20 或 60")
    return (window,)


def _best_similarity_matches(
    target_hist: pd.DataFrame,
    candidate_hist: pd.DataFrame,
    target_code: str,
    candidate_code: str,
    candidate_name: str,
    windows: tuple[int, ...],
) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    for window in windows:
        target = target_hist.tail(window).reset_index(drop=True)
        target_label = _pattern_label(target, target_code, "")
        if len(target_hist) < window:
            continue
        if len(candidate_hist) < window + max(SIMILAR_FORWARD_DAYS) + 1:
            continue
        last_end = len(candidate_hist) - max(SIMILAR_FORWARD_DAYS) - 1
        best: dict[str, Any] | None = None
        for end in range(window - 1, last_end + 1):
            start = end - window + 1
            segment = candidate_hist.iloc[start : end + 1].reset_index(drop=True)
            score = _similarity_score(target, segment)
            if best is None or score > best["相似度"]:
                forward = _forward_returns(candidate_hist, end)
                best = {
                    "窗口": f"{window}日",
                    "代码": candidate_code,
                    "名称": candidate_name,
                    "相似度": score,
                    "匹配区间": (
                        f"{candidate_hist['日期'].iloc[start]} 至 "
                        f"{candidate_hist['日期'].iloc[end]}"
                    ),
                    "当前形态": target_label,
                    "历史形态": _pattern_label(
                        segment, candidate_code, candidate_name
                    ),
                    "后1日涨跌%": forward[1],
                    "后3日涨跌%": forward[3],
                    "后5日涨跌%": forward[5],
                    "后10日涨跌%": forward[10],
                    "历史后续方向": _future_direction(forward),
                }
        if best is not None:
            matches.append(best)
    return matches


def find_similar_stocks(
    code: str,
    windows: tuple[int, ...] = SIMILAR_WINDOWS,
    top_n: int = SIMILAR_TOP_N,
    workers: int = 4,
    log_callback: Callable[[str], None] = log,
) -> pd.DataFrame:
    """查找全 A 股中与目标股票近期走势最相似的历史片段。"""
    code = str(code).strip().zfill(6)
    if not code.isdigit() or len(code) != 6:
        raise ValueError("股票代码必须是 6 位数字")
    windows = _similarity_windows(windows)
    if top_n < 1:
        raise ValueError("返回数量必须大于 0")

    target_hist = fetch_kline(code, limit=SIMILAR_HISTORY_LIMIT)
    required = {"日期", "收盘", "最高", "最低", "成交量", "涨跌幅"}
    if target_hist.empty or not required.issubset(target_hist.columns):
        raise RuntimeError(f"{code} 历史 K 线数据不完整")
    usable_windows = tuple(window for window in windows if len(target_hist) >= window)
    if not usable_windows:
        raise RuntimeError(f"{code} 历史 K 线不足 {min(windows)} 个交易日")

    spot = fetch_spot()
    if spot.empty:
        raise RuntimeError("未取到股票列表")
    candidates = spot.copy()
    candidates["名称"] = candidates["名称"].fillna("").astype(str)
    candidates = candidates[
        (candidates["代码"] != code)
        & ~candidates["名称"].str.contains("ST|退", regex=True, case=False)
        & (pd.to_numeric(candidates["最新价"], errors="coerce") > 0)
    ][["代码", "名称"]].drop_duplicates("代码")
    if candidates.empty:
        raise RuntimeError("没有可搜索的股票")

    log_callback(
        f"目标 {code} 当前形态："
        + "、".join(
            f"{window}日 {_pattern_label(target_hist.tail(window), code, '')}"
            for window in usable_windows
        )
    )
    log_callback(f"开始扫描全A股历史日K，共 {len(candidates)} 只...")

    top_matches: dict[int, list[dict[str, Any]]] = {
        window: [] for window in usable_windows
    }
    completed = 0
    available = 0
    failed = 0
    rows = list(candidates.itertuples(index=False, name=None))
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {
            pool.submit(fetch_kline, candidate_code, SIMILAR_HISTORY_LIMIT): (
                candidate_code,
                candidate_name,
            )
            for candidate_code, candidate_name in rows
        }
        for future in as_completed(futures):
            candidate_code, candidate_name = futures[future]
            completed += 1
            try:
                hist = future.result()
                if not hist.empty and required.issubset(hist.columns):
                    candidate_matches = _best_similarity_matches(
                        target_hist,
                        hist,
                        code,
                        candidate_code,
                        candidate_name,
                        usable_windows,
                    )
                    if candidate_matches:
                        available += 1
                    for match in candidate_matches:
                        window = int(match["窗口"].removesuffix("日"))
                        top_matches[window].append(match)
                        top_matches[window].sort(
                            key=lambda item: item["相似度"], reverse=True
                        )
                        del top_matches[window][top_n:]
                else:
                    failed += 1
            except Exception:  # noqa: BLE001
                failed += 1
            if completed % 100 == 0 or completed == len(rows):
                log_callback(
                    f"历史K线进度 {completed}/{len(rows)}，已比较 {available}，失败 {failed}"
                )

    matches = [
        match
        for window in usable_windows
        for match in top_matches[window]
    ]

    result = pd.DataFrame(matches)
    if result.empty:
        log_callback("没有找到足够历史数据的相似股票。")
        return result
    result = (
        result.sort_values(["窗口", "相似度"], ascending=[True, False])
        .groupby("窗口", sort=False, group_keys=False)
        .head(top_n)
        .reset_index(drop=True)
    )
    for window in usable_windows:
        mask = result["窗口"] == f"{window}日"
        count = int(mask.sum())
        summary_parts = []
        for days in SIMILAR_FORWARD_DAYS:
            values = pd.to_numeric(
                result.loc[mask, f"后{days}日涨跌%"], errors="coerce"
            ).dropna()
            if values.empty:
                continue
            average = float(values.mean())
            positive_ratio = float((values > 0).mean() * 100)
            summary_parts.append(
                f"{days}日均值 {average:+.2f}%/上涨{positive_ratio:.0f}%"
            )
        result.loc[mask, "匹配样本后续统计"] = "；".join(summary_parts) or "无后续数据"
        if summary_parts:
            log_callback(f"{window}日匹配样本后续统计：" + "；".join(summary_parts))
        log_callback(f"{window}日窗口返回 {count} 条相似结果")
    return result


@lru_cache(maxsize=512)
def fetch_trends(code: str, security: str | None = None) -> pd.DataFrame:
    params = {
        "secid": security or to_secid(code),
        "fields1": "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58",
        "iscr": "0",
        "ndays": "1",
    }
    trends = (get_json_hosts(EASTMONEY_TREND_HOSTS, params).get("data") or {}).get("trends") or []
    return _parse_trends(trends)


def has_limit_up_gene(
    hist: pd.DataFrame, code: str, name: str, config: ScreenConfig
) -> bool:
    if hist.empty:
        return False
    recent = hist.tail(config.limit_up_lookback)
    th = limit_up_threshold(code, name)
    return bool((recent["涨跌幅"] >= th).any())


def is_volume_stair(hist: pd.DataFrame, config: ScreenConfig) -> bool:
    if len(hist) < config.volume_stair_days:
        return False
    vols = hist["成交量"].tail(config.volume_stair_days).tolist()
    return all(vols[i] > vols[i - 1] for i in range(1, len(vols)))


def _ma_series(hist: pd.DataFrame) -> tuple[pd.Series, pd.Series, pd.Series, pd.Series] | None:
    if len(hist) < 62:
        return None
    close = hist["收盘"]
    ma5 = close.rolling(5).mean()
    ma10 = close.rolling(10).mean()
    ma20 = close.rolling(20).mean()
    ma60 = close.rolling(60).mean()
    if pd.isna(ma60.iloc[-1]) or pd.isna(ma60.iloc[-2]):
        return None
    return ma5, ma10, ma20, ma60


def is_ma_bullish(hist: pd.DataFrame) -> bool:
    mas = _ma_series(hist)
    if mas is None:
        return False
    ma5, ma10, ma20, ma60 = mas
    close = float(hist["收盘"].iloc[-1])
    stacked = ma5.iloc[-1] > ma10.iloc[-1] > ma20.iloc[-1] > ma60.iloc[-1]
    above = close > ma5.iloc[-1]
    sloping = (
        ma5.iloc[-1] > ma5.iloc[-2]
        and ma10.iloc[-1] > ma10.iloc[-2]
        and ma20.iloc[-1] > ma20.iloc[-2]
        and ma60.iloc[-1] > ma60.iloc[-2]
    )
    return bool(stacked and above and sloping)


def not_far_from_ma5(hist: pd.DataFrame, price: float, config: ScreenConfig) -> bool:
    mas = _ma_series(hist)
    if mas is None:
        return False
    ma5 = float(mas[0].iloc[-1])
    if ma5 <= 0:
        return False
    if price < ma5:
        return False
    return (price - ma5) / ma5 <= config.max_ma5_bias


def held_platform(hist: pd.DataFrame, config: ScreenConfig) -> bool:
    if len(hist) < config.platform_lookback + 1:
        return False
    support = float(
        hist["最低"].iloc[-(config.platform_lookback + 1) : -1].min()
    )
    today_low = float(hist["最低"].iloc[-1])
    return today_low >= support


def near_20d_high(hist: pd.DataFrame, config: ScreenConfig) -> bool:
    if len(hist) < 20:
        return False
    hh = float(hist["最高"].tail(20).max())
    close = float(hist["收盘"].iloc[-1])
    return hh > 0 and close >= hh * config.near_20d_high


def made_high_after_1430(trends: pd.DataFrame) -> bool:
    if trends.empty or "时间" not in trends.columns:
        return False
    day_high = float(trends["最高"].max())
    if day_high <= 0:
        return False
    times = pd.to_datetime(trends["时间"], errors="coerce")
    after = trends.loc[times.dt.hour * 60 + times.dt.minute >= 14 * 60 + 30]
    if after.empty:
        return False
    after_high = float(after["最高"].max())
    last = float(trends["收盘"].iloc[-1])
    return after_high >= day_high * 0.999 and last >= day_high * 0.992


def is_above_vwap(trends: pd.DataFrame, config: ScreenConfig) -> bool:
    if trends.empty or len(trends) <= config.skip_open_minutes:
        return False
    body = trends.iloc[config.skip_open_minutes:]
    above = body["收盘"] >= body["均价"]
    ratio = float(above.mean())
    now_above = bool(trends["收盘"].iloc[-1] >= trends["均价"].iloc[-1])
    return now_above and ratio >= ABOVE_VWAP_RATIO


def rapid_rise_metrics(
    trends: pd.DataFrame, config: ScreenConfig
) -> dict[str, Any] | None:
    if trends.empty or len(trends) <= config.skip_open_minutes + config.rapid_rise_window:
        return None
    body = trends.iloc[config.skip_open_minutes:].reset_index(drop=True)
    close = pd.to_numeric(body["收盘"], errors="coerce")
    volume = pd.to_numeric(body["成交量"], errors="coerce").fillna(0).clip(lower=0)
    window = config.rapid_rise_window
    best: dict[str, Any] | None = None
    for end in range(window, len(body)):
        start = end - window
        start_close = float(close.iloc[start])
        end_close = float(close.iloc[end])
        if start_close <= 0 or end_close <= 0:
            continue
        outside = pd.concat([volume.iloc[:start], volume.iloc[end + 1 :]])
        baseline = float(outside[outside > 0].median())
        if not math.isfinite(baseline) or baseline <= 0:
            baseline = float(volume[volume > 0].median())
        segment_volume = float(volume.iloc[start + 1 : end + 1].mean())
        multiple = segment_volume / baseline if baseline > 0 else 0.0
        item = {
            "涨幅%": (end_close / start_close - 1) * 100,
            "放量倍数": multiple,
            "开始时间": str(body["时间"].iloc[start]),
            "结束时间": str(body["时间"].iloc[end]),
        }
        if best is None or item["涨幅%"] > best["涨幅%"]:
            best = item
    return best


def is_stronger_than_index(stock_pct: float, index_pct: float) -> bool:
    return stock_pct > index_pct


def warn_if_before_1430() -> None:
    now = datetime.now()
    if now.weekday() >= 5:
        log("提示：今天是周末，将使用最近一个交易日数据。")
        return
    cutoff = now.replace(hour=14, minute=30, second=0, microsecond=0)
    if now < cutoff:
        log("提示：未到 14:30，量能/换手/分时仍会变化，结果仅供预览。")


def filter_basic(df: pd.DataFrame, config: ScreenConfig) -> pd.DataFrame:
    name = df["名称"].fillna("")
    mask = pd.Series(True, index=df.index)
    if config.enable_pct:
        mask &= df["涨跌幅"].between(config.pct_min, config.pct_max)
    if config.enable_turnover:
        mask &= df["换手率"].between(config.turnover_min, config.turnover_max)
    if config.enable_volume_ratio:
        mask &= df["量比"] > config.volume_ratio_min
        if config.volume_ratio_max is not None:
            mask &= df["量比"] <= config.volume_ratio_max
    if config.enable_circ_mv:
        mask &= df["流通市值_亿"].between(config.circ_mv_min, config.circ_mv_max)
    if config.enable_profitable:
        mask &= df["市盈率"] > 0
    mask &= ~name.str.contains("ST|退", regex=True, case=False)
    if config.enable_main_inflow and "主力净流入" in df.columns:
        mask = mask & (df["主力净流入"].fillna(0) > 0)
    return df.loc[mask].copy()


def inspect_one(
    row: pd.Series,
    config: ScreenConfig,
    log_callback: Callable[[str], None],
) -> dict[str, Any] | None:
    code, name = row["代码"], row["名称"]
    needs_hist = any(
        (
            config.enable_limit_up_gene,
            config.enable_volume_stair,
            config.enable_ma_bullish,
            config.enable_ma5_bias,
            config.enable_platform,
            config.enable_near_high,
        )
    )
    try:
        hist = fetch_kline(code, limit=80) if needs_hist else pd.DataFrame()
        trends = (
            fetch_trends(code)
            if config.enable_vwap or config.enable_tail_high or config.enable_rapid_rise
            else pd.DataFrame()
        )
    except Exception as exc:  # noqa: BLE001
        log_callback(f"  跳过 {code} {name}（数据失败: {exc}）")
        return None

    required_hist = {"收盘", "最高", "最低", "成交量", "涨跌幅"}
    if needs_hist and (hist.empty or not required_hist.issubset(hist.columns)):
        log_callback(f"  跳过 {code} {name}（历史 K 线数据不完整）")
        return None

    price = float(row["最新价"])
    if config.enable_limit_up_gene and not has_limit_up_gene(hist, code, name, config):
        log_callback(f"   排除 {code} {name}：{config.limit_up_lookback} 日内无涨停")
        return None
    if config.enable_volume_stair and not is_volume_stair(hist, config):
        log_callback(f"   排除 {code} {name}：量能非台阶式放量")
        return None
    if config.enable_ma_bullish and not is_ma_bullish(hist):
        log_callback(f"   排除 {code} {name}：均线非 5/10/20/60 多头向上")
        return None
    if config.enable_ma5_bias and not not_far_from_ma5(hist, price, config):
        log_callback(f"   排除 {code} {name}：股价远离5日均线")
        return None
    if config.enable_platform and not held_platform(hist, config):
        log_callback(f"   排除 {code} {name}：已跌破近期平台支撑")
        return None
    if config.enable_near_high and not near_20d_high(hist, config):
        log_callback(f"   排除 {code} {name}：上方仍有套牢压力")
        return None
    rapid = rapid_rise_metrics(trends, config) if config.enable_rapid_rise else None
    if config.enable_rapid_rise and (
        rapid is None
        or rapid["涨幅%"] < config.rapid_rise_pct
        or rapid["放量倍数"] < config.rapid_volume_multiple
    ):
        if rapid is None:
            detail = "数据不足"
        else:
            detail = (
                f"最大{config.rapid_rise_window}分钟涨幅 "
                f"{rapid['涨幅%']:.2f}% / 放量 {rapid['放量倍数']:.2f}倍"
            )
        log_callback(f"   排除 {code} {name}：未满足急速拉升（{detail}）")
        return None
    if config.enable_vwap and not is_above_vwap(trends, config):
        log_callback(f"   排除 {code} {name}：分时未全程在均价线上方")
        return None
    if config.enable_tail_high and not made_high_after_1430(trends):
        log_callback(f"   排除 {code} {name}：14:30 后未创当日新高")
        return None

    vols = (
        hist["成交量"].tail(config.volume_stair_days).tolist()
        if not hist.empty
        else []
    )
    mas = _ma_series(hist)
    ma5_value = ma10_value = ma20_value = ma60_value = None
    if mas is not None:
        ma5, ma10, ma20, ma60 = mas
        ma5_value = float(ma5.iloc[-1])
        ma10_value = float(ma10.iloc[-1])
        ma20_value = float(ma20.iloc[-1])
        ma60_value = float(ma60.iloc[-1])
    vwap = float(trends["均价"].iloc[-1]) if not trends.empty else 0.0
    vwap_bias = (price / vwap - 1) * 100 if vwap else 0.0
    ma5_bias = (price / ma5_value - 1) * 100 if ma5_value else None
    inflow = row.get("主力净流入")
    inflow_yi = round(float(inflow) / 1e8, 3) if pd.notna(inflow) else None
    return {
        "代码": code,
        "名称": name,
        "涨跌幅": round(float(row["涨跌幅"]), 2),
        "换手率": round(float(row["换手率"]), 2),
        "量比": round(float(row["量比"]), 2),
        "流通市值_亿": round(float(row["流通市值_亿"]), 2),
        "市盈率": round(float(row["市盈率"]), 2),
        "主力净流入_亿": inflow_yi,
        "热点板块": "、".join(row.get("热点板块") or []),
        "MA5": round(ma5_value, 3) if ma5_value is not None else None,
        "MA10": round(ma10_value, 3) if ma10_value is not None else None,
        "MA20": round(ma20_value, 3) if ma20_value is not None else None,
        "MA60": round(ma60_value, 3) if ma60_value is not None else None,
        "偏离MA5%": round(ma5_bias, 2) if ma5_bias is not None else None,
        "距均价%": round(vwap_bias, 2),
        "急拉涨幅%": round(float(rapid["涨幅%"]), 2) if rapid else None,
        "急拉放量倍数": round(float(rapid["放量倍数"]), 2) if rapid else None,
        "急拉时段": (
            f"{rapid['开始时间']}至{rapid['结束时间']}" if rapid else ""
        ),
        "近5日量": "-".join(str(int(v)) for v in vols),
        "最新价": round(price, 3),
    }


def save_csv(rows: list[dict[str, Any]], path: str) -> None:
    if not rows:
        return
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def clear_data_cache() -> None:
    fetch_kline.cache_clear()
    fetch_trends.cache_clear()


def run_screen(
    config: ScreenConfig | None = None,
    workers: int = 2,
    log_callback: Callable[[str], None] = log,
) -> pd.DataFrame:
    config = config or ScreenConfig()
    clear_data_cache()
    log_callback(f"本地缓存：历史日K按天缓存，热点板块 {HOT_BOARD_CACHE_TTL // 60} 分钟缓存")
    log_callback("1/4 使用东方财富拉取行情，过滤基础条件...")
    spot = fetch_spot()
    if spot.empty:
        raise RuntimeError("未取到行情")
    basic = filter_basic(spot, config)
    log_callback(f"   基础条件剩余 {len(basic)} 只")
    if not basic.empty:
        preview_cols = [
            c for c in ["代码", "名称", "涨跌幅", "换手率", "量比", "流通市值_亿"]
            if c in basic.columns
        ]
        log_callback(basic[preview_cols].to_string(index=False))

    if config.enable_hot_board:
        log_callback(f"2/4 取涨幅前 {config.hot_board_top_n} 的热点板块...")
        boards, hot_codes, member_map = fetch_hot_concepts(config.hot_board_top_n)
        if not boards.empty:
            show_cols = [c for c in ["类型", "板块名称", "涨跌幅"] if c in boards.columns]
            log_callback("   热点板块：")
            log_callback(boards[show_cols].to_string(index=False))
        basic["热点板块"] = basic["代码"].map(lambda c: member_map.get(c, []))
        hot = basic[basic["代码"].isin(hot_codes)].copy()
        log_callback(f"   落在热点板块内 {len(hot)} 只")
    else:
        log_callback("2/4 已关闭热点板块筛选")
        basic["热点板块"] = [[] for _ in range(len(basic))]
        hot = basic
    if hot.empty:
        log_callback("没有符合当前基础条件的股票。")
        return pd.DataFrame()

    if config.enable_stronger_than_index:
        log_callback("3/4 拉取上证指数，用于比较分时强弱...")
        index_pct, _ = fetch_index_pct()
        log_callback(f"   上证涨跌幅 {index_pct:.2f}%")
        hot = hot[hot["涨跌幅"] > index_pct].copy()
        log_callback(f"   强于大盘剩余 {len(hot)} 只")
        if hot.empty:
            log_callback("没有强于大盘的候选。")
            return pd.DataFrame()
    else:
        log_callback("3/4 已关闭强于大盘筛选")

    log_callback("4/4 复检涨停基因 / 台阶放量 / 均线 / 平台 / 分时...")
    picked: list[dict[str, Any]] = []
    rows = [r for _, r in hot.iterrows()]
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {
            pool.submit(inspect_one, row, config, log_callback): row["代码"]
            for row in rows
        }
        for future in as_completed(futures):
            item = future.result()
            if item:
                picked.append(item)
                log_callback(f"   命中 {item['代码']} {item['名称']}")
    picked.sort(key=lambda x: x["涨跌幅"], reverse=True)
    result = pd.DataFrame(picked)
    log_callback(f"===== 最终结果 {len(result)} 只 =====")
    if result.empty:
        log_callback("无符合全部条件的股票。")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="A 股条件选股与分时异动监控")
    parser.add_argument("--hot-n", type=int, default=HOT_BOARD_TOP_N, help="热点概念板块取前 N 个")
    parser.add_argument("--workers", type=int, default=2, help="个股复检并发数")
    parser.add_argument("--out", default="", help="结果 CSV 路径，默认按日期生成")
    parser.add_argument("--similar-code", default="", help="查找相似走势的股票代码")
    parser.add_argument(
        "--similar-window",
        choices=["全部", "5", "10", "20", "60"],
        default="全部",
        help="相似走势匹配窗口",
    )
    parser.add_argument(
        "--similar-top-n", type=int, default=SIMILAR_TOP_N, help="每个窗口返回数量"
    )
    parser.add_argument(
        "--similar-workers",
        type=int,
        default=SIMILAR_WORKERS,
        help="相似走势历史K线并发请求数",
    )
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    if args.similar_code:
        try:
            out_df = find_similar_stocks(
                args.similar_code,
                windows=_similarity_windows(args.similar_window),
                top_n=args.similar_top_n,
                workers=args.similar_workers,
            )
        except Exception as exc:  # noqa: BLE001
            log(f"相似走势分析失败：{exc}")
            return 1
        if not out_df.empty:
            log(out_df.to_string(index=False))
            out_path = args.out or (
                f"similar_{str(args.similar_code).zfill(6)}_"
                f"{datetime.now().strftime('%Y%m%d')}.csv"
            )
            save_csv(out_df.to_dict("records"), out_path)
            log(f"已保存 {out_path}")
        return 0

    warn_if_before_1430()
    config = ScreenConfig(hot_board_top_n=args.hot_n)
    try:
        out_df = run_screen(config, workers=args.workers)
    except Exception as exc:  # noqa: BLE001
        log(f"运行失败：{exc}")
        return 1
    if not out_df.empty:
        buf = StringIO()
        out_df.to_string(buf, index=False)
        log(buf.getvalue())
        out_path = args.out or f"screen_{datetime.now().strftime('%Y%m%d')}.csv"
        save_csv(out_df.to_dict("records"), out_path)
        log(f"已保存 {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
