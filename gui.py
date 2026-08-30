# -*- coding: utf-8 -*-
"""A 股尾盘选股 GUI。"""
from __future__ import annotations

import json
import math
import queue
import threading
from datetime import datetime
from pathlib import Path
from tkinter import BooleanVar, END, StringVar, filedialog, messagebox
import tkinter as tk
from tkinter import ttk

import pandas as pd

import screen


CONFIG_PATH = Path.cwd() / "screen_config.json"


class ScreenApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("A股尾盘选股")
        self.geometry("1120x760")
        self.minsize(960, 620)
        self.value_vars: dict[str, StringVar] = {}
        self.bool_vars: dict[str, BooleanVar] = {}
        self.result = pd.DataFrame()
        self.messages: queue.Queue[tuple[str, object]] = queue.Queue()
        self.running = False
        self._build()
        self._load_config()
        self.after(100, self._poll_messages)

    def _build(self) -> None:
        self.columnconfigure(0, weight=1)
        self.rowconfigure(1, weight=1)

        buttons = ttk.Frame(self, padding=(10, 8))
        buttons.grid(row=0, column=0, sticky="ew")
        buttons.columnconfigure(5, weight=1)
        self.start_button = ttk.Button(buttons, text="开始选股", command=self._start)
        self.start_button.grid(row=0, column=0, padx=(0, 8))
        ttk.Button(buttons, text="恢复默认", command=self._reset_defaults).grid(
            row=0, column=1, padx=8
        )
        ttk.Button(buttons, text="保存参数", command=self._save_config).grid(
            row=0, column=2, padx=8
        )
        self.save_result_button = ttk.Button(
            buttons, text="保存结果 CSV", command=self._save_result, state="disabled"
        )
        self.save_result_button.grid(row=0, column=3, padx=8)
        self.status_var = StringVar(value="就绪")
        ttk.Label(buttons, textvariable=self.status_var).grid(
            row=0, column=5, sticky="e"
        )

        notebook = ttk.Notebook(self)
        notebook.grid(row=1, column=0, sticky="nsew", padx=10)
        basic_tab, basic_content = self._scrollable_tab(notebook)
        technical_tab, technical_content = self._scrollable_tab(notebook)
        notebook.add(basic_tab, text="基础条件")
        notebook.add(technical_tab, text="技术条件")
        self._build_basic_tab(basic_content)
        self._build_technical_tab(technical_content)

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
        self._check_row(parent, row, "enable_tail_high", "14:30 后创当日新高")

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
        )
        if config.pct_min > config.pct_max or config.turnover_min > config.turnover_max:
            raise ValueError("范围的最小值不能大于最大值")
        if config.volume_ratio_max is not None and config.volume_ratio_min > config.volume_ratio_max:
            raise ValueError("量比最小值不能大于最大值")
        if config.hot_board_top_n < 1 or config.limit_up_lookback < 1:
            raise ValueError("板块数量和涨停回看天数必须大于 0")
        if config.volume_stair_days < 2 or config.platform_lookback < 1:
            raise ValueError("放量天数至少为 2，平台回看天数必须大于 0")
        if not 0 < config.above_vwap_ratio <= 1:
            raise ValueError("分时水上比例必须在 0 到 100% 之间")
        if not 0 < config.near_20d_high <= 1:
            raise ValueError("近20日高点下限必须在 0 到 100% 之间")
        if config.max_ma5_bias < 0:
            raise ValueError("5日线最大偏离不能为负数")
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
        self.start_button.configure(state="disabled")
        self.save_result_button.configure(state="disabled")
        self.status_var.set("正在选股...")
        worker = threading.Thread(target=self._run_worker, args=(config,), daemon=True)
        worker.start()

    def _run_worker(self, config: screen.ScreenConfig) -> None:
        try:
            result = screen.run_screen(
                config=config,
                workers=2,
                log_callback=lambda message: self.messages.put(("log", message)),
            )
            self.messages.put(("result", result))
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
                elif kind == "done":
                    self.running = False
                    self.start_button.configure(state="normal")
                    self.save_result_button.configure(
                        state="normal" if not self.result.empty else "disabled"
                    )
                    self.status_var.set(f"完成，共 {len(self.result)} 只")
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


if __name__ == "__main__":
    ScreenApp().mainloop()
