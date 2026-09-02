# -*- coding: utf-8 -*-
"""A 股尾盘选股 GUI。"""
from __future__ import annotations

import json
import math
import winsound
import queue
import threading
from datetime import datetime
from pathlib import Path
from tkinter import BooleanVar, END, StringVar, filedialog, messagebox
import tkinter as tk
from tkinter import ttk

import pandas as pd

import backtest
import screen


CONFIG_PATH = Path.cwd() / "screen_config.json"


class ScreenApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("A股选股与异动监控")
        self.geometry("1180x820")
        self.minsize(980, 680)
        self.value_vars: dict[str, StringVar] = {}
        self.bool_vars: dict[str, BooleanVar] = {}
        self.result = pd.DataFrame()
        self.backtest_summary = pd.DataFrame()
        self.backtest_samples = pd.DataFrame()
        self.news_rows: list[dict] = []
        self.messages: queue.Queue[tuple[str, object]] = queue.Queue()
        self.running = False
        self.monitoring = False
        self.screen_stop = threading.Event()
        self.monitor_stop = threading.Event()
        self.backtest_stop = threading.Event()
        self.monitor_alert_codes: set[str] = set()
        self.log_path = Path.cwd() / "runtime_log.txt"
        self.similarity_window: tk.Toplevel | None = None
        self._build()
        self._load_config()
        self._restore_log()
        self.after(100, self._poll_messages)

    def _build(self) -> None:
        self.columnconfigure(0, weight=1)
        self.rowconfigure(1, weight=1)

        buttons = ttk.Frame(self, padding=(10, 8))
        buttons.grid(row=0, column=0, sticky="ew")
        buttons.columnconfigure(8, weight=1)
        self.start_button = ttk.Button(buttons, text="开始选股", command=self._start)
        self.start_button.grid(row=0, column=0, padx=(0, 8))
        self.cancel_button = ttk.Button(
            buttons, text="取消任务", command=self._cancel_task, state="disabled"
        )
        self.cancel_button.grid(row=0, column=1, padx=8)
        ttk.Button(buttons, text="恢复默认", command=self._reset_defaults).grid(
            row=0, column=2, padx=8
        )
        ttk.Button(buttons, text="保存参数", command=self._save_config).grid(
            row=0, column=3, padx=8
        )
        self.save_result_button = ttk.Button(
            buttons, text="保存结果 CSV", command=self._save_result, state="disabled"
        )
        self.save_result_button.grid(row=0, column=4, padx=8)
        ttk.Button(buttons, text="相似走势", command=self._open_similarity).grid(
            row=0, column=5, padx=8
        )
        self.monitor_button = ttk.Button(
            buttons, text="实时监控", command=self._toggle_monitor
        )
        self.monitor_button.grid(row=0, column=6, padx=8)
        ttk.Button(buttons, text="复制日志", command=self._copy_log).grid(
            row=0, column=7, padx=8
        )
        self.status_var = StringVar(value="就绪")
        ttk.Label(buttons, textvariable=self.status_var).grid(
            row=0, column=8, sticky="e"
        )

        notebook = ttk.Notebook(self)
        notebook.grid(row=1, column=0, sticky="nsew", padx=10)
        basic_tab, basic_content = self._scrollable_tab(notebook)
        technical_tab, technical_content = self._scrollable_tab(notebook)
        backtest_tab, backtest_content = self._scrollable_tab(notebook)
        news_tab, news_content = self._scrollable_tab(notebook)
        notebook.add(basic_tab, text="基础条件")
        notebook.add(technical_tab, text="技术条件")
        notebook.add(backtest_tab, text="T+1 回测")
        notebook.add(news_tab, text="近期新闻")
        self._build_basic_tab(basic_content)
        self._build_technical_tab(technical_content)
        self._build_backtest_tab(backtest_content)
        self._build_news_tab(news_content)

        bottom = ttk.PanedWindow(self, orient="vertical")
        bottom.grid(row=2, column=0, sticky="nsew", padx=10, pady=(8, 10))
        log_frame = ttk.Labelframe(bottom, text="运行日志", padding=6)
        result_frame = ttk.Labelframe(bottom, text="筛选结果", padding=6)
        bottom.add(log_frame, weight=1)
        bottom.add(result_frame, weight=3)

        log_frame.rowconfigure(0, weight=1)
        log_frame.columnconfigure(0, weight=1)
        self.log_text = tk.Text(log_frame, height=8, wrap="none", state="disabled")
        self.log_text.grid(row=0, column=0, sticky="nsew")
        log_scroll = ttk.Scrollbar(log_frame, command=self.log_text.yview)
        log_scroll.grid(row=0, column=1, sticky="ns")
        self.log_text.configure(yscrollcommand=log_scroll.set)

        result_frame.rowconfigure(0, weight=1)
        result_frame.columnconfigure(0, weight=1)
        self.result_tree = ttk.Treeview(result_frame, show="headings")
        self.result_tree.grid(row=0, column=0, sticky="nsew")
        tree_y = ttk.Scrollbar(result_frame, orient="vertical", command=self.result_tree.yview)
        tree_y.grid(row=0, column=1, sticky="ns")
        tree_x = ttk.Scrollbar(result_frame, orient="horizontal", command=self.result_tree.xview)
        tree_x.grid(row=1, column=0, sticky="ew")
        self.result_tree.configure(yscrollcommand=tree_y.set, xscrollcommand=tree_x.set)

    def _scrollable_tab(
        self, notebook: ttk.Notebook
    ) -> tuple[ttk.Frame, ttk.Frame]:
        container = ttk.Frame(notebook)
        container.rowconfigure(0, weight=1)
        container.columnconfigure(0, weight=1)
        canvas = tk.Canvas(container, highlightthickness=0)
        scrollbar = ttk.Scrollbar(container, orient="vertical", command=canvas.yview)
        content = ttk.Frame(canvas, padding=10)
        window_id = canvas.create_window((0, 0), window=content, anchor="nw")
        canvas.configure(yscrollcommand=scrollbar.set)
        canvas.grid(row=0, column=0, sticky="nsew")
        scrollbar.grid(row=0, column=1, sticky="ns")
        content.bind(
            "<Configure>",
            lambda _event: canvas.configure(scrollregion=canvas.bbox("all")),
        )
        canvas.bind(
            "<Configure>",
            lambda event: canvas.itemconfigure(window_id, width=event.width),
        )
        return container, content

    def _build_basic_tab(self, parent: ttk.Frame) -> None:
        parent.columnconfigure(3, weight=1)
        row = 0
        row = self._range_row(parent, row, "enable_pct", "涨幅 (%)", "pct_min", "pct_max")
        row = self._range_row(
            parent, row, "enable_turnover", "换手率 (%)", "turnover_min", "turnover_max"
        )
        row = self._range_row(
            parent, row, "enable_volume_ratio", "量比", "volume_ratio_min", "volume_ratio_max"
        )
        row = self._range_row(
            parent, row, "enable_circ_mv", "流通市值 (亿)", "circ_mv_min", "circ_mv_max"
        )
        row = self._check_row(parent, row, "enable_profitable", "盈利企业（动态市盈率 > 0）")
        self._check_row(parent, row, "enable_main_inflow", "主力净流入 > 0")

    def _build_technical_tab(self, parent: ttk.Frame) -> None:
        parent.columnconfigure(3, weight=1)
        row = 0
        row = self._check_value_row(
            parent, row, "enable_hot_board", "热点板块筛选", "hot_board_top_n", "前 N 个板块"
        )
        row = self._check_value_row(
            parent, row, "enable_lhb_count", "近一年龙虎榜次数大于", "lhb_count_min", "次"
        )
        row = self._check_value_row(
            parent, row, "enable_limit_up_gene", "近 N 日有涨停", "limit_up_lookback", "交易日"
        )
        row = self._check_value_row(
            parent, row, "enable_volume_stair", "台阶式持续放量", "volume_stair_days", "交易日"
        )
        row = self._check_row(parent, row, "enable_ma_bullish", "5/10/20/60 日均线多头向上")
        row = self._check_value_row(
            parent, row, "enable_ma5_bias", "不远离 5 日均线", "max_ma5_bias", "最大偏离 (%)"
        )
        row = self._check_value_row(
            parent, row, "enable_platform", "未跌破平台支撑", "platform_lookback", "回看交易日"
        )
        row = self._check_value_row(
            parent, row, "enable_near_high", "接近近 20 日高点", "near_20d_high", "高点下限 (%)"
        )
        row = self._check_value_row(
            parent, row, "enable_vwap", "分时运行在均价线上方", "above_vwap_ratio", "水上比例 (%)"
        )
        row = self._value_row(parent, row, "skip_open_minutes", "跳过开盘前 N 根分时", "分钟")
        row = self._check_row(parent, row, "enable_stronger_than_index", "走势强于上证指数")
        row = self._check_row(parent, row, "enable_tail_high", "14:30 后创当日新高")
        row = self._check_value_row(
            parent, row, "enable_rapid_rise", "分时急速拉升", "rapid_rise_window", "分钟窗口"
        )
        row = self._value_row(parent, row, "rapid_rise_pct", "急拉最小涨幅", "%")
        row = self._value_row(
            parent, row, "rapid_volume_multiple", "急拉最小放量", "倍"
        )
        row = self._value_row(parent, row, "monitor_interval", "实时刷新间隔", "秒")
        row = self._check_row(parent, row, "enable_industry_top5", "仅查找行业龙头前五名")
        row = self._check_row(parent, row, "enable_us_sector", "美股相关行业隔夜上涨")
        self._check_row(parent, row, "enable_notify", "实时监控命中时提醒")

    def _check_var(self, key: str) -> BooleanVar:
        self.bool_vars[key] = BooleanVar(value=True)
        return self.bool_vars[key]

    def _value_var(self, key: str) -> StringVar:
        self.value_vars[key] = StringVar()
        return self.value_vars[key]

    def _check_row(self, parent: ttk.Frame, row: int, key: str, label: str) -> int:
        ttk.Checkbutton(parent, text=label, variable=self._check_var(key)).grid(
            row=row, column=0, columnspan=4, sticky="w", pady=5
        )
        return row + 1

    def _value_row(
        self, parent: ttk.Frame, row: int, key: str, label: str, suffix: str
    ) -> int:
        ttk.Label(parent, text=label, width=28).grid(row=row, column=0, sticky="w", pady=5)
        entry = ttk.Entry(parent, textvariable=self._value_var(key), width=12)
        entry.grid(row=row, column=1, sticky="w", pady=5)
        ttk.Label(parent, text=suffix).grid(row=row, column=2, sticky="w", padx=6)
        return row + 1

    def _range_row(
        self,
        parent: ttk.Frame,
        row: int,
        check_key: str,
        label: str,
        min_key: str,
        max_key: str,
    ) -> int:
        ttk.Checkbutton(parent, text=label, variable=self._check_var(check_key)).grid(
            row=row, column=0, sticky="w", pady=5
        )
        ttk.Label(parent, text="最小").grid(row=row, column=1, sticky="e", padx=4)
        ttk.Entry(parent, textvariable=self._value_var(min_key), width=10).grid(
            row=row, column=2, sticky="w"
        )
        ttk.Label(parent, text="最大（可留空）").grid(row=row, column=3, sticky="e", padx=4)
        ttk.Entry(parent, textvariable=self._value_var(max_key), width=10).grid(
            row=row, column=4, sticky="w"
        )
        return row + 1

    def _check_value_row(
        self,
        parent: ttk.Frame,
        row: int,
        check_key: str,
        label: str,
        value_key: str,
        suffix: str,
    ) -> int:
        ttk.Checkbutton(parent, text=label, variable=self._check_var(check_key)).grid(
            row=row, column=0, columnspan=2, sticky="w", pady=5
        )
        ttk.Entry(parent, textvariable=self._value_var(value_key), width=12).grid(
            row=row, column=2, sticky="w"
        )
        ttk.Label(parent, text=suffix).grid(row=row, column=3, sticky="w", padx=6)
        return row + 1

    def _load_config(self) -> None:
        config = screen.ScreenConfig()
        if CONFIG_PATH.exists():
            try:
                config = screen.ScreenConfig.from_dict(
                    json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
                )
            except (OSError, json.JSONDecodeError, TypeError, ValueError):
                self._append_log("配置文件无法读取，已使用默认参数。")
        self._set_form(config)

    def _set_form(self, config: screen.ScreenConfig) -> None:
        values = config.to_dict()
        percent_keys = {"max_ma5_bias", "near_20d_high", "above_vwap_ratio"}
        for key, value in values.items():
            if key in self.bool_vars:
                self.bool_vars[key].set(bool(value))
            elif key in self.value_vars:
                display = float(value) * 100 if key in percent_keys and value is not None else value
                self.value_vars[key].set("" if display is None else str(display))

    def _reset_defaults(self) -> None:
        self._set_form(screen.ScreenConfig())
        self.status_var.set("已恢复默认参数")

    def _read_float(self, key: str, label: str, optional: bool = False) -> float | None:
        text = self.value_vars[key].get().strip()
        if not text and optional:
            return None
        try:
            value = float(text)
        except ValueError as exc:
            raise ValueError(f"{label}必须是数字") from exc
        if not math.isfinite(value):
            raise ValueError(f"{label}必须是有限数字")
        return value

    def _read_int(self, key: str, label: str) -> int:
        value = self._read_float(key, label)
        assert value is not None
        if value != int(value):
            raise ValueError(f"{label}必须是整数")
        return int(value)

    def _read_config(self) -> screen.ScreenConfig:
        config = screen.ScreenConfig(
            enable_pct=self.bool_vars["enable_pct"].get(),
            pct_min=self._read_float("pct_min", "涨幅最小值") or 0,
            pct_max=self._read_float("pct_max", "涨幅最大值") or 0,
            enable_turnover=self.bool_vars["enable_turnover"].get(),
            turnover_min=self._read_float("turnover_min", "换手率最小值") or 0,
            turnover_max=self._read_float("turnover_max", "换手率最大值") or 0,
            enable_volume_ratio=self.bool_vars["enable_volume_ratio"].get(),
            volume_ratio_min=self._read_float("volume_ratio_min", "量比最小值") or 0,
            volume_ratio_max=self._read_float("volume_ratio_max", "量比最大值", True),
            enable_circ_mv=self.bool_vars["enable_circ_mv"].get(),
            circ_mv_min=self._read_float("circ_mv_min", "流通市值最小值") or 0,
            circ_mv_max=self._read_float("circ_mv_max", "流通市值最大值") or 0,
            enable_profitable=self.bool_vars["enable_profitable"].get(),
            enable_main_inflow=self.bool_vars["enable_main_inflow"].get(),
            enable_hot_board=self.bool_vars["enable_hot_board"].get(),
            hot_board_top_n=self._read_int("hot_board_top_n", "热点板块数量"),
            enable_lhb_count=self.bool_vars["enable_lhb_count"].get(),
            lhb_count_min=self._read_int("lhb_count_min", "近一年龙虎榜次数"),
            enable_limit_up_gene=self.bool_vars["enable_limit_up_gene"].get(),
            limit_up_lookback=self._read_int("limit_up_lookback", "涨停回看天数"),
            enable_volume_stair=self.bool_vars["enable_volume_stair"].get(),
            volume_stair_days=self._read_int("volume_stair_days", "放量回看天数"),
            enable_ma_bullish=self.bool_vars["enable_ma_bullish"].get(),
            enable_ma5_bias=self.bool_vars["enable_ma5_bias"].get(),
            max_ma5_bias=(self._read_float("max_ma5_bias", "5日线最大偏离") or 0) / 100,
            enable_platform=self.bool_vars["enable_platform"].get(),
            platform_lookback=self._read_int("platform_lookback", "平台回看天数"),
            enable_near_high=self.bool_vars["enable_near_high"].get(),
            near_20d_high=(self._read_float("near_20d_high", "近20日高点下限") or 0) / 100,
            enable_vwap=self.bool_vars["enable_vwap"].get(),
            above_vwap_ratio=(self._read_float("above_vwap_ratio", "分时水上比例") or 0) / 100,
            skip_open_minutes=self._read_int("skip_open_minutes", "跳过开盘分时"),
            enable_stronger_than_index=self.bool_vars["enable_stronger_than_index"].get(),
            enable_tail_high=self.bool_vars["enable_tail_high"].get(),
            enable_rapid_rise=self.bool_vars["enable_rapid_rise"].get(),
            rapid_rise_window=self._read_int("rapid_rise_window", "急拉分钟窗口"),
            rapid_rise_pct=self._read_float("rapid_rise_pct", "急拉最小涨幅") or 0,
            rapid_volume_multiple=self._read_float(
                "rapid_volume_multiple", "急拉最小放量"
            )
            or 0,
            enable_industry_top5=self.bool_vars["enable_industry_top5"].get(),
            enable_us_sector=self.bool_vars["enable_us_sector"].get(),
            enable_notify=self.bool_vars["enable_notify"].get(),
            monitor_interval=self._read_int("monitor_interval", "实时刷新间隔"),
        )
        if config.pct_min > config.pct_max or config.turnover_min > config.turnover_max:
            raise ValueError("范围的最小值不能大于最大值")
        if config.volume_ratio_max is not None and config.volume_ratio_min > config.volume_ratio_max:
            raise ValueError("量比最小值不能大于最大值")
        if config.hot_board_top_n < 1 or config.limit_up_lookback < 1:
            raise ValueError("板块数量和涨停回看天数必须大于 0")
        if config.lhb_count_min < 0:
            raise ValueError("近一年龙虎榜次数不能为负数")
        if config.volume_stair_days < 2 or config.platform_lookback < 1:
            raise ValueError("放量天数至少为 2，平台回看天数必须大于 0")
        if not 0 < config.above_vwap_ratio <= 1:
            raise ValueError("分时水上比例必须在 0 到 100% 之间")
        if not 0 < config.near_20d_high <= 1:
            raise ValueError("近20日高点下限必须在 0 到 100% 之间")
        if config.max_ma5_bias < 0:
            raise ValueError("5日线最大偏离不能为负数")
        if config.rapid_rise_window < 1:
            raise ValueError("急拉分钟窗口必须大于 0")
        if config.rapid_rise_pct < 0 or config.rapid_volume_multiple < 0:
            raise ValueError("急拉涨幅和放量倍数不能为负数")
        if config.monitor_interval < 15:
            raise ValueError("实时刷新间隔必须大于等于 15 秒")
        return config

    def _save_config(self) -> bool:
        try:
            config = self._read_config()
            CONFIG_PATH.write_text(
                json.dumps(config.to_dict(), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            self.status_var.set(f"参数已保存：{CONFIG_PATH.name}")
            return True
        except (ValueError, OSError) as exc:
            messagebox.showerror("参数错误", str(exc))
            return False

    def _start(self) -> None:
        if self.running:
            return
        try:
            config = self._read_config()
        except ValueError as exc:
            messagebox.showerror("参数错误", str(exc))
            return
        self._save_config()
        self._clear_log()
        self.result = pd.DataFrame()
        self._clear_result()
        self.running = True
        self.monitoring = False
        self.screen_stop.clear()
        self.monitor_stop.clear()
        self.start_button.configure(state="disabled")
        self.monitor_button.configure(state="disabled")
        self.cancel_button.configure(state="normal")
        self.save_result_button.configure(state="disabled")
        self.status_var.set("正在选股...")
        worker = threading.Thread(target=self._run_worker, args=(config,), daemon=True)
        worker.start()

    def _toggle_monitor(self) -> None:
        if self.monitoring:
            self.monitor_stop.set()
            self.screen_stop.set()
            self.monitor_button.configure(state="disabled")
            self.cancel_button.configure(state="disabled")
            self.status_var.set("正在停止实时监控...")
            return
        if self.running:
            return
        try:
            config = self._read_config()
        except ValueError as exc:
            messagebox.showerror("参数错误", str(exc))
            return
        self._save_config()
        self._clear_log()
        self.result = pd.DataFrame()
        self._clear_result()
        self.running = True
        self.monitoring = True
        self.monitor_alert_codes.clear()
        self.monitor_stop.clear()
        self.screen_stop.clear()
        self.start_button.configure(state="disabled")
        self.monitor_button.configure(text="停止监控")
        self.cancel_button.configure(state="normal")
        self.save_result_button.configure(state="disabled")
        self.status_var.set("正在实时监控...")
        worker = threading.Thread(
            target=self._run_monitor_worker, args=(config,), daemon=True
        )
        worker.start()

    def _run_worker(self, config: screen.ScreenConfig) -> None:
        try:
            result = screen.run_screen(
                config=config,
                workers=4,
                log_callback=lambda message: self.messages.put(("log", message)),
                stop_event=self.screen_stop,
            )
            self.messages.put(("result", result))
        except Exception as exc:  # noqa: BLE001
            self.messages.put(("error", str(exc)))
        finally:
            self.messages.put(("done", None))

    def _run_monitor_worker(self, config: screen.ScreenConfig) -> None:
        try:
            while not self.monitor_stop.is_set():
                self.screen_stop.clear()
                result = screen.run_screen(
                    config=config,
                    workers=4,
                    log_callback=lambda message: self.messages.put(("log", message)),
                    stop_event=self.screen_stop,
                    live=True,
                )
                self.messages.put(("result", result))
                if config.enable_notify and isinstance(result, pd.DataFrame):
                    self.messages.put(("notify", result))
                if self.monitor_stop.wait(max(15, int(config.monitor_interval))):
                    break
        except Exception as exc:  # noqa: BLE001
            self.messages.put(("error", str(exc)))
        finally:
            self.messages.put(("done", None))

    def _poll_messages(self) -> None:
        try:
            while True:
                kind, payload = self.messages.get_nowait()
                if kind == "log":
                    self._append_log(str(payload))
                elif kind == "result":
                    self.result = payload
                    self._show_result(self.result)
                elif kind == "error":
                    self._append_log(f"运行失败：{payload}")
                    messagebox.showerror("运行失败", str(payload))
                elif kind == "notify":
                    self._notify_monitor_hits(payload)
                elif kind == "backtest_result":
                    summary, samples = payload
                    self.backtest_summary = summary
                    self.backtest_samples = samples
                    self._show_backtest_result(summary)
                elif kind == "news":
                    self.news_rows = list(payload or [])
                    self._show_news(self.news_rows, all_rows=False)
                elif kind == "done":
                    self.running = False
                    self.monitoring = False
                    self.start_button.configure(state="normal")
                    self.monitor_button.configure(state="normal", text="实时监控")
                    self.cancel_button.configure(state="disabled")
                    if hasattr(self, "backtest_button"):
                        self.backtest_button.configure(state="normal", text="开始 T+1 回测")
                    self.save_result_button.configure(
                        state="normal" if not self.result.empty else "disabled"
                    )
                    self.status_var.set(
                        f"监控已停止，共 {len(self.result)} 只"
                        if self.monitor_stop.is_set()
                        else f"完成，共 {len(self.result)} 只"
                    )
        except queue.Empty:
            pass
        self.after(100, self._poll_messages)

    def _clear_log(self) -> None:
        self.log_text.configure(state="normal")
        self.log_text.delete("1.0", END)
        self.log_text.configure(state="disabled")

    def _append_log(self, message: str) -> None:
        self.log_text.configure(state="normal")
        self.log_text.insert(END, message + "\n")
        self.log_text.see(END)
        self.log_text.configure(state="disabled")
        try:
            with self.log_path.open("a", encoding="utf-8") as fh:
                fh.write(message + "\n")
        except OSError:
            pass

    def _clear_result(self) -> None:
        self.result_tree.delete(*self.result_tree.get_children())
        self.result_tree.configure(columns=())

    def _show_result(self, result: pd.DataFrame) -> None:
        self._clear_result()
        if result.empty:
            return
        columns = list(result.columns)
        self.result_tree.configure(columns=columns)
        for column in columns:
            self.result_tree.heading(column, text=column)
            self.result_tree.column(column, width=max(90, min(180, len(column) * 16)))
        for values in result.itertuples(index=False, name=None):
            self.result_tree.insert("", END, values=values)

    def _save_result(self) -> None:
        if self.result.empty:
            return
        path = filedialog.asksaveasfilename(
            title="保存筛选结果",
            defaultextension=".csv",
            initialfile=f"screen_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
            filetypes=[("CSV 文件", "*.csv"), ("所有文件", "*.*")],
        )
        if path:
            self.result.to_csv(path, index=False, encoding="utf-8-sig")
            self.status_var.set(f"结果已保存：{Path(path).name}")

    def _open_similarity(self) -> None:
        if self.similarity_window is not None and self.similarity_window.winfo_exists():
            self.similarity_window.lift()
            return

        window = tk.Toplevel(self)
        self.similarity_window = window
        window.title("相似走势分析")
        window.geometry("1500x720")
        window.minsize(1050, 560)
        window.columnconfigure(0, weight=1)
        window.rowconfigure(1, weight=1)

        controls = ttk.Frame(window, padding=10)
        controls.grid(row=0, column=0, sticky="ew")
        ttk.Label(controls, text="股票代码").grid(row=0, column=0, padx=(0, 5))
        code_var = StringVar()
        code_entry = ttk.Entry(controls, textvariable=code_var, width=12)
        code_entry.grid(row=0, column=1, padx=(0, 12))
        ttk.Label(controls, text="匹配窗口").grid(row=0, column=2, padx=(0, 5))
        window_var = StringVar(value="全部")
        ttk.Combobox(
            controls,
            textvariable=window_var,
            values=["全部", "5", "10", "20", "60"],
            state="readonly",
            width=8,
        ).grid(row=0, column=3, padx=(0, 12))
        ttk.Label(controls, text="每个窗口返回").grid(row=0, column=4, padx=(0, 5))
        top_n_var = StringVar(value="10")
        ttk.Entry(controls, textvariable=top_n_var, width=8).grid(
            row=0, column=5, padx=(0, 12)
        )
        ttk.Label(controls, text="候选数量(0=全部)").grid(
            row=0, column=6, padx=(0, 5)
        )
        candidate_limit_var = StringVar(value=str(screen.SIMILAR_CANDIDATE_LIMIT))
        ttk.Entry(controls, textvariable=candidate_limit_var, width=8).grid(
            row=0, column=7, padx=(0, 12)
        )

        result_frame = ttk.Frame(window, padding=(10, 0, 10, 10))
        result_frame.grid(row=1, column=0, sticky="nsew")
        result_frame.rowconfigure(0, weight=1)
        result_frame.columnconfigure(0, weight=1)
        tree = ttk.Treeview(result_frame, show="headings")
        tree.grid(row=0, column=0, sticky="nsew")
        tree_y = ttk.Scrollbar(result_frame, orient="vertical", command=tree.yview)
        tree_y.grid(row=0, column=1, sticky="ns")
        tree_x = ttk.Scrollbar(result_frame, orient="horizontal", command=tree.xview)
        tree_x.grid(row=1, column=0, sticky="ew")
        tree.configure(yscrollcommand=tree_y.set, xscrollcommand=tree_x.set)

        log_frame = ttk.Labelframe(window, text="分析日志", padding=6)
        log_frame.grid(row=2, column=0, sticky="ew", padx=10, pady=(0, 10))
        log_frame.columnconfigure(0, weight=1)
        log_text = tk.Text(log_frame, height=6, wrap="none", state="disabled")
        log_text.grid(row=0, column=0, sticky="ew")
        search_button = ttk.Button(controls, text="开始分析")
        search_button.grid(row=0, column=8, padx=(0, 8))
        save_button = ttk.Button(controls, text="保存 CSV", state="disabled")
        save_button.grid(row=0, column=9)

        messages: queue.Queue[tuple[str, object]] = queue.Queue()
        state = {
            "running": False,
            "result": pd.DataFrame(),
            "stop_event": threading.Event(),
        }

        def append_log(message: str) -> None:
            log_text.configure(state="normal")
            log_text.insert(END, message + "\n")
            log_text.see(END)
            log_text.configure(state="disabled")

        def save_similarity_result() -> None:
            result = state["result"]
            if not isinstance(result, pd.DataFrame) or result.empty:
                return
            path = filedialog.asksaveasfilename(
                title="保存相似走势结果",
                defaultextension=".csv",
                initialfile=f"similar_{code_var.get().strip()}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
                filetypes=[("CSV 文件", "*.csv"), ("所有文件", "*.*")],
                parent=window,
            )
            if path:
                result.to_csv(path, index=False, encoding="utf-8-sig")
                append_log(f"结果已保存：{Path(path).name}")

        def start_search() -> None:
            if state["running"]:
                state["stop_event"].set()
                search_button.configure(state="disabled")
                append_log("正在停止分析，等待当前请求结束...")
                return
            code = code_var.get().strip()
            if not code.isdigit() or len(code) > 6:
                messagebox.showerror("参数错误", "股票代码必须是 6 位数字", parent=window)
                return
            try:
                top_n = int(top_n_var.get().strip())
                selected_window = window_var.get()
                windows = (
                    screen.SIMILAR_WINDOWS
                    if selected_window == "全部"
                    else (int(selected_window),)
                )
                if top_n < 1:
                    raise ValueError
                candidate_limit = int(candidate_limit_var.get().strip())
                if candidate_limit < 0:
                    raise ValueError
            except ValueError:
                messagebox.showerror(
                    "参数错误", "返回数量必须大于 0，候选数量不能为负数", parent=window
                )
                return

            state["running"] = True
            state["result"] = pd.DataFrame()
            state["stop_event"].clear()
            search_button.configure(state="normal", text="停止分析")
            save_button.configure(state="disabled")
            tree.delete(*tree.get_children())
            scope = "全 A 股" if candidate_limit == 0 else f"活跃候选前 {candidate_limit} 只"
            append_log(f"开始分析（{scope}），匹配结果将实时显示...")

            def worker() -> None:
                try:
                    result = screen.find_similar_stocks(
                        code,
                        windows=windows,
                        top_n=top_n,
                        workers=screen.SIMILAR_WORKERS,
                        log_callback=lambda message: messages.put(("log", message)),
                        candidate_limit=candidate_limit,
                        stop_event=state["stop_event"],
                        result_callback=lambda result: messages.put(("result", result)),
                    )
                    messages.put(("result", result))
                except Exception as exc:  # noqa: BLE001
                    messages.put(("error", str(exc)))
                finally:
                    messages.put(("done", None))

            threading.Thread(target=worker, daemon=True).start()

        def poll_messages() -> None:
            if not window.winfo_exists():
                return
            try:
                while True:
                    kind, payload = messages.get_nowait()
                    if kind == "log":
                        append_log(str(payload))
                    elif kind == "result":
                        result = payload
                        if isinstance(result, pd.DataFrame):
                            state["result"] = result
                            self._show_similarity_result(tree, result)
                            save_button.configure(
                                state="normal" if not result.empty else "disabled"
                            )
                    elif kind == "error":
                        append_log(f"分析失败：{payload}")
                        messagebox.showerror("分析失败", str(payload), parent=window)
                    elif kind == "done":
                        state["running"] = False
                        search_button.configure(state="normal", text="开始分析")
                        save_button.configure(
                            state="normal"
                            if isinstance(state["result"], pd.DataFrame)
                            and not state["result"].empty
                            else "disabled"
                        )
            except queue.Empty:
                pass
            window.after(100, poll_messages)

        search_button.configure(command=start_search)
        save_button.configure(command=save_similarity_result)

        def close_window() -> None:
            state["stop_event"].set()
            self.similarity_window = None
            window.destroy()

        window.protocol("WM_DELETE_WINDOW", close_window)
        code_entry.focus_set()
        poll_messages()

    def _show_similarity_result(self, tree: ttk.Treeview, result: pd.DataFrame) -> None:
        tree.delete(*tree.get_children())
        if result.empty:
            tree.configure(columns=())
            return
        columns = list(result.columns)
        tree.configure(columns=columns)
        for column in columns:
            tree.heading(column, text=column)
            tree.column(column, width=max(90, min(180, len(column) * 16)))
        for values in result.itertuples(index=False, name=None):
            tree.insert("", END, values=values)


    def _cancel_task(self) -> None:
        self.screen_stop.set()
        self.monitor_stop.set()
        self.backtest_stop.set()
        self.cancel_button.configure(state="disabled")
        self.status_var.set("正在取消当前任务...")
        self._append_log("已发出取消请求")

    def _copy_log(self) -> None:
        content = self.log_text.get("1.0", END).strip()
        if not content:
            messagebox.showinfo("复制日志", "暂无日志可复制")
            return
        self.clipboard_clear()
        self.clipboard_append(content)
        self.status_var.set("运行日志已复制到剪贴板")

    def _restore_log(self) -> None:
        if not self.log_path.exists():
            return
        try:
            content = self.log_path.read_text(encoding="utf-8")
        except OSError:
            return
        lines = content.splitlines()[-80:]
        if not lines:
            return
        self.log_text.configure(state="normal")
        self.log_text.delete("1.0", END)
        self.log_text.insert(END, "\n".join(lines) + "\n")
        self.log_text.see(END)
        self.log_text.configure(state="disabled")

    def _notify_monitor_hits(self, result: object) -> None:
        if not isinstance(result, pd.DataFrame) or result.empty or "代码" not in result.columns:
            self.monitor_alert_codes.clear()
            return
        codes = {str(code).zfill(6) for code in result["代码"].tolist()}
        new_codes = codes - self.monitor_alert_codes
        self.monitor_alert_codes &= codes
        if not new_codes:
            return
        subset = result[result["代码"].astype(str).str.zfill(6).isin(new_codes)]
        names = []
        for _, row in subset.iterrows():
            code = str(row["代码"]).zfill(6)
            name = str(row.get("名称", ""))
            names.append(f"{code} {name}".strip())
            self.monitor_alert_codes.add(code)
        text = "、".join(names[:8])
        self._append_log(f"监控提醒：{text}")
        try:
            winsound.MessageBeep(winsound.MB_ICONEXCLAMATION)
        except Exception:  # noqa: BLE001
            pass
        try:
            messagebox.showinfo("实时监控命中", f"新命中：{text}")
        except Exception:  # noqa: BLE001
            pass

    def _build_backtest_tab(self, parent: ttk.Frame) -> None:
        parent.columnconfigure(3, weight=1)
        row = 0
        ttk.Label(parent, text="涨幅区间 (%)").grid(row=row, column=0, sticky="w", pady=5)
        ttk.Entry(parent, textvariable=self._value_var("bt_pct_min"), width=10).grid(
            row=row, column=1, sticky="w"
        )
        ttk.Entry(parent, textvariable=self._value_var("bt_pct_max"), width=10).grid(
            row=row, column=2, sticky="w"
        )
        self.value_vars["bt_pct_min"].set("3")
        self.value_vars["bt_pct_max"].set("5")
        row += 1
        row = self._check_row(parent, row, "bt_ma_bullish", "历史样本要求均线多头")
        self.bool_vars["bt_ma_bullish"].set(False)
        row = self._check_value_row(
            parent,
            row,
            "bt_near_high",
            "历史样本要求接近20日高点",
            "bt_near_high_pct",
            "高点下限 (%)",
        )
        self.bool_vars["bt_near_high"].set(False)
        self.value_vars["bt_near_high_pct"].set("97")
        row = self._check_value_row(
            parent,
            row,
            "bt_limit_up",
            "历史样本要求近 N 日涨停",
            "bt_limit_up_days",
            "交易日",
        )
        self.bool_vars["bt_limit_up"].set(False)
        self.value_vars["bt_limit_up_days"].set("20")
        row = self._value_row(parent, row, "bt_min_samples", "历史样本最少次数", "次")
        self.value_vars["bt_min_samples"].set("1")
        row = self._value_row(parent, row, "bt_stock_limit", "最多回测股票数", "只")
        self.value_vars["bt_stock_limit"].set("20")
        ttk.Label(parent, text="指定股票代码（可空）").grid(row=row, column=0, sticky="w", pady=5)
        ttk.Entry(parent, textvariable=self._value_var("bt_codes"), width=42).grid(
            row=row, column=1, columnspan=3, sticky="w"
        )
        row += 1
        actions = ttk.Frame(parent)
        actions.grid(row=row, column=0, columnspan=4, sticky="w", pady=8)
        self.backtest_button = ttk.Button(
            actions, text="开始 T+1 回测", command=self._start_backtest
        )
        self.backtest_button.grid(row=0, column=0, padx=(0, 8))
        ttk.Button(actions, text="导出回测结果", command=self._export_backtest).grid(
            row=0, column=1
        )
        row += 1
        frame = ttk.Labelframe(parent, text="回测汇总", padding=6)
        frame.grid(row=row, column=0, columnspan=4, sticky="nsew", pady=8)
        parent.rowconfigure(row, weight=1)
        frame.rowconfigure(0, weight=1)
        frame.columnconfigure(0, weight=1)
        self.backtest_tree = ttk.Treeview(frame, show="headings", height=10)
        self.backtest_tree.grid(row=0, column=0, sticky="nsew")
        scroll = ttk.Scrollbar(frame, orient="vertical", command=self.backtest_tree.yview)
        scroll.grid(row=0, column=1, sticky="ns")
        self.backtest_tree.configure(yscrollcommand=scroll.set)

    def _build_news_tab(self, parent: ttk.Frame) -> None:
        parent.columnconfigure(0, weight=1)
        parent.rowconfigure(2, weight=1)
        actions = ttk.Frame(parent)
        actions.grid(row=0, column=0, sticky="w", pady=6)
        ttk.Button(actions, text="刷新近12小时新闻", command=self._refresh_news).grid(
            row=0, column=0, padx=(0, 8)
        )
        ttk.Label(actions, text="双击新闻可查看详情").grid(row=0, column=1, padx=8)
        self.news_status = StringVar(value="等待加载…")
        ttk.Label(parent, textvariable=self.news_status).grid(row=1, column=0, sticky="w")

        self.news_category_tabs = ttk.Notebook(parent)
        self.news_category_tabs.grid(row=2, column=0, sticky="nsew", pady=8)
        self.news_trees: dict[str, ttk.Treeview] = {}
        self.news_item_map: dict[str, dict] = {}
        for category in ("全部", "可能利好", "风险提示", "待判断"):
            frame = ttk.Frame(self.news_category_tabs)
            self.news_category_tabs.add(frame, text=category)
            frame.rowconfigure(0, weight=1)
            frame.columnconfigure(0, weight=1)
            tree = ttk.Treeview(
                frame, show="headings", columns=("时间", "标签", "标题", "摘要"), height=14
            )
            tree.grid(row=0, column=0, sticky="nsew")
            for col, width in (("时间", 140), ("标签", 80), ("标题", 300), ("摘要", 380)):
                tree.heading(col, text=col)
                tree.column(col, width=width, anchor="w")
            scroll = ttk.Scrollbar(frame, orient="vertical", command=tree.yview)
            scroll.grid(row=0, column=1, sticky="ns")
            tree.configure(yscrollcommand=scroll.set)
            tree.bind("<Double-1>", self._on_news_double_click)
            self.news_trees[category] = tree

    def _start_backtest(self) -> None:
        if self.running:
            self.backtest_stop.set()
            self.backtest_button.configure(state="disabled")
            self._append_log("正在停止 T+1 回测...")
            return
        try:
            options = backtest.BacktestOptions(
                pct_min=self._read_float("bt_pct_min", "回测涨幅最小值") or 0,
                pct_max=self._read_float("bt_pct_max", "回测涨幅最大值") or 0,
                require_ma_bullish=self.bool_vars["bt_ma_bullish"].get(),
                require_near_high=self.bool_vars["bt_near_high"].get(),
                near_20d_high=(self._read_float("bt_near_high_pct", "回测高点下限") or 0) / 100,
                require_limit_up=self.bool_vars["bt_limit_up"].get(),
                limit_up_lookback=self._read_int("bt_limit_up_days", "回测涨停回看"),
                min_samples=self._read_int("bt_min_samples", "最少样本数"),
                stock_limit=self._read_int("bt_stock_limit", "回测股票数"),
            )
            if options.pct_min > options.pct_max:
                raise ValueError("回测涨幅最小值不能大于最大值")
            if not 0 < options.near_20d_high <= 1:
                raise ValueError("回测高点下限必须在 0 到 100% 之间")
        except ValueError as exc:
            messagebox.showerror("参数错误", str(exc))
            return
        self.running = True
        self.backtest_stop.clear()
        self.cancel_button.configure(state="normal")
        self.start_button.configure(state="disabled")
        self.monitor_button.configure(state="disabled")
        self.backtest_button.configure(text="停止回测")
        self.status_var.set("正在进行 T+1 回测...")
        self._append_log("===== 开始 T+1 历史回测 =====")
        codes = self.value_vars["bt_codes"].get()

        def worker() -> None:
            try:
                summary, samples = backtest.run_t1_backtest(
                    options,
                    codes_text=codes,
                    screen_rows=self.result,
                    log_callback=lambda message: self.messages.put(("log", message)),
                    stop_event=self.backtest_stop,
                )
                self.messages.put(("backtest_result", (summary, samples)))
            except Exception as exc:  # noqa: BLE001
                self.messages.put(("error", str(exc)))
            finally:
                self.messages.put(("done", None))

        threading.Thread(target=worker, daemon=True).start()

    def _show_backtest_result(self, summary: pd.DataFrame) -> None:
        self.backtest_tree.delete(*self.backtest_tree.get_children())
        if summary is None or summary.empty:
            self.backtest_tree.configure(columns=())
            return
        columns = list(summary.columns)
        self.backtest_tree.configure(columns=columns)
        for column in columns:
            self.backtest_tree.heading(column, text=column)
            self.backtest_tree.column(column, width=max(80, min(160, len(column) * 14)))
        for values in summary.itertuples(index=False, name=None):
            self.backtest_tree.insert("", END, values=values)

    def _export_backtest(self) -> None:
        if self.backtest_summary.empty and self.backtest_samples.empty:
            messagebox.showinfo("导出回测", "暂无回测结果")
            return
        path = filedialog.asksaveasfilename(
            title="导出回测结果",
            defaultextension=".csv",
            initialfile=f"backtest_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
            filetypes=[("CSV 文件", "*.csv"), ("所有文件", "*.*")],
        )
        if not path:
            return
        export_df = (
            self.backtest_summary if not self.backtest_summary.empty else self.backtest_samples
        )
        export_df.to_csv(path, index=False, encoding="utf-8-sig")
        self.status_var.set(f"回测结果已保存：{Path(path).name}")

    def _refresh_news(self) -> None:
        self.news_status.set("正在拉取近12小时快讯…")

        def worker() -> None:
            try:
                rows = screen.fetch_overnight_news(120)
                self.messages.put(("news", rows))
                self.messages.put(("log", f"近12小时新闻：获取 {len(rows)} 条"))
            except Exception as exc:  # noqa: BLE001
                self.messages.put(("error", str(exc)))

        threading.Thread(target=worker, daemon=True).start()

    def _show_all_news(self) -> None:
        self._show_news(self.news_rows, all_rows=True)

    def _news_groups(self, rows: list[dict]) -> dict[str, list[dict]]:
        groups = {
            "全部": list(rows),
            "可能利好": [],
            "风险提示": [],
            "待判断": [],
        }
        for item in rows:
            tag = str(item.get("标签") or "待判断")
            if tag not in groups:
                tag = "待判断"
            groups[tag].append(item)
        return groups

    def _fill_news_tree(self, tree: ttk.Treeview, rows: list[dict]) -> None:
        tree.delete(*tree.get_children())
        for item in rows:
            item_id = tree.insert(
                "",
                END,
                values=(
                    item.get("时间", ""),
                    item.get("标签", ""),
                    item.get("标题", ""),
                    item.get("摘要", ""),
                ),
            )
            self.news_item_map[(id(tree), item_id)] = item

    def _show_news(self, rows: list[dict], all_rows: bool = False) -> None:
        del all_rows  # 分类页签已展示全部，保留参数兼容旧调用
        self.news_item_map = {}
        groups = self._news_groups(rows)
        for category, tree in self.news_trees.items():
            subset = rows if category == "全部" else groups.get(category, [])
            self._fill_news_tree(tree, subset)
            count = len(subset)
            for tab_id in self.news_category_tabs.tabs():
                if self.news_category_tabs.nametowidget(tab_id) is tree.master:
                    self.news_category_tabs.tab(tab_id, text=f"{category} ({count})")
                    break
        good = len(groups["可能利好"])
        bad = len(groups["风险提示"])
        pending = len(groups["待判断"])
        self.news_status.set(
            f"近12小时共 {len(rows)} 条｜可能利好 {good}｜风险提示 {bad}｜待判断 {pending}"
            if rows
            else "近12小时暂无快讯"
        )

    def _on_news_double_click(self, event: tk.Event) -> None:
        tree = event.widget
        if not isinstance(tree, ttk.Treeview):
            return
        item_id = tree.focus() or tree.identify_row(event.y)
        if not item_id:
            return
        item = self.news_item_map.get((id(tree), item_id))
        if not item:
            return
        self._open_news_detail(item)

    def _open_news_detail(self, item: dict) -> None:
        win = tk.Toplevel(self)
        win.title("新闻详情")
        win.geometry("640x420")
        win.minsize(480, 320)
        win.transient(self)
        win.columnconfigure(0, weight=1)
        win.rowconfigure(3, weight=1)

        tag = str(item.get("标签") or "待判断")
        title = str(item.get("标题") or "")
        time_text = str(item.get("时间") or "")
        summary = str(item.get("摘要") or "暂无摘要")
        link = str(item.get("链接") or "")
        tag_color = {
            "可能利好": "#15803d",
            "风险提示": "#b91c1c",
            "待判断": "#1d4ed8",
        }.get(tag, "#1d4ed8")

        header = ttk.Frame(win, padding=12)
        header.grid(row=0, column=0, sticky="ew")
        header.columnconfigure(1, weight=1)
        ttk.Label(header, text=tag, foreground=tag_color).grid(row=0, column=0, sticky="w")
        ttk.Label(header, text=time_text, foreground="#64748b").grid(
            row=0, column=1, sticky="e"
        )

        ttk.Label(
            win,
            text=title,
            wraplength=600,
            font=("Microsoft YaHei UI", 12, "bold"),
            justify="left",
        ).grid(row=1, column=0, sticky="ew", padx=12, pady=(0, 8))

        ttk.Separator(win).grid(row=2, column=0, sticky="ew", padx=12)

        body = tk.Text(win, wrap="word", height=12, padx=8, pady=8)
        body.grid(row=3, column=0, sticky="nsew", padx=(12, 0), pady=8)
        body_scroll = ttk.Scrollbar(win, orient="vertical", command=body.yview)
        body_scroll.grid(row=3, column=1, sticky="ns", padx=(0, 12), pady=8)
        body.configure(yscrollcommand=body_scroll.set)
        body.insert("1.0", summary)
        if link:
            body.insert(END, f"\n\n原文链接：\n{link}")
        body.configure(state="disabled")

        actions = ttk.Frame(win, padding=(12, 0, 12, 12))
        actions.grid(row=4, column=0, sticky="ew")

        def open_link() -> None:
            if not link:
                messagebox.showinfo("新闻详情", "这条快讯没有原文链接", parent=win)
                return
            import webbrowser

            webbrowser.open(link)

        def copy_text() -> None:
            text_value = f"[{tag}] {time_text}\n{title}\n\n{summary}"
            if link:
                text_value += f"\n\n{link}"
            self.clipboard_clear()
            self.clipboard_append(text_value)
            self.status_var.set("新闻内容已复制")

        ttk.Button(actions, text="打开原文", command=open_link).grid(row=0, column=0, padx=(0, 8))
        ttk.Button(actions, text="复制内容", command=copy_text).grid(row=0, column=1, padx=(0, 8))
        ttk.Button(actions, text="关闭", command=win.destroy).grid(row=0, column=2)



if __name__ == "__main__":
    ScreenApp().mainloop()
