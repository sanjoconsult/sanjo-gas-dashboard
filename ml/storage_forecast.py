"""Forecast the next EIA weekly natural gas storage change (Lower 48, Bcf).

Pipeline
  1. Data: EIA weekly working gas (2010 on) and daily temperatures for ten
     large US metro areas from Open-Meteo, turned into population-weighted
     heating and cooling degree days (HDD/CDD, base 65 F).
  2. Features for the week being forecast: its HDD and CDD, the five-year
     average change for that week of the year, last week's change, the
     storage surplus or deficit against the five-year average, and the
     season (sine and cosine of the day of the year).
  3. Models: the five-year average (baseline), ridge regression and gradient
     boosting, compared in a walk-forward backtest that refits every week
     and only ever uses data available at the time.
  4. Output: forecast.json with the forecast, an 80% range from backtest
     errors, backtest accuracy for every model, the last 26 weeks of
     backtest results and a running log of live forecasts.

Usage
  python ml/storage_forecast.py --out forecast.json [--prev prev.json]
         [--weather-cache weather_daily.csv] [--storage-csv file] [--today YYYY-MM-DD]
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

EIA_XLS = "https://www.eia.gov/dnav/ng/hist_xls/NW2_EPG0_SWO_R48_BCFw.xls"
EIA_WEEKLY = "https://ir.eia.gov/ngs/wngsr.json"
ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
FORECAST = "https://api.open-meteo.com/v1/forecast"

# Ten large metro areas; weights are metro populations in millions (US Census 2020, rounded).
CITIES = [
    ("New York", 40.71, -74.01, 20.1),
    ("Los Angeles", 34.05, -118.24, 13.2),
    ("Chicago", 41.88, -87.63, 9.6),
    ("Dallas", 32.78, -96.80, 7.6),
    ("Houston", 29.76, -95.37, 7.1),
    ("Philadelphia", 39.95, -75.17, 6.2),
    ("Atlanta", 33.75, -84.39, 6.1),
    ("Boston", 42.36, -71.06, 4.9),
    ("Detroit", 42.33, -83.05, 4.4),
    ("Minneapolis", 44.98, -93.27, 3.7),
]
FEATURES = ["hdd", "cdd", "avg5", "prev_change", "surplus", "season_sin", "season_cos"]
WEATHER_START = date(2014, 12, 1)
TEST_START = "2022-01-01"


# ---------------------------------------------------------------- data access
def _get(url: str, tries: int = 4) -> bytes:
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "sanjo-gas-dashboard (github.com/sanjoconsult)"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:  # network hiccups and rate limits: back off and retry
            if i == tries - 1:
                raise
            print(f"  retry {i + 1} for {url[:80]}: {e}", file=sys.stderr)
            time.sleep(5 * (i + 1))
    raise RuntimeError("unreachable")


def load_storage() -> pd.Series:
    """Weekly Lower 48 working gas, Bcf, indexed by week-ending Friday."""
    raw = pd.read_excel(io.BytesIO(_get(EIA_XLS)), sheet_name="Data 1", skiprows=2)
    s = pd.Series(raw.iloc[:, 1].values, index=pd.to_datetime(raw.iloc[:, 0]), name="bcf").dropna().astype(float)
    try:  # the weekly report JSON can be a few hours ahead of the spreadsheet
        j = json.loads(_get(EIA_WEEKLY))
        tot = next(x for x in j["series"] if x["name"].lower().startswith("total lower 48"))
        for d, v in tot["data"][:2]:
            s.loc[pd.Timestamp(d)] = float(v)
    except Exception as e:
        print(f"  weekly report JSON not used: {e}", file=sys.stderr)
    return s[~s.index.duplicated(keep="last")].sort_index()


def _fetch_temps(base: str, params: str) -> pd.DataFrame:
    lat = ",".join(str(c[1]) for c in CITIES)
    lon = ",".join(str(c[2]) for c in CITIES)
    url = f"{base}?latitude={lat}&longitude={lon}&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=America%2FChicago&{params}"
    data = json.loads(_get(url))
    data = data if isinstance(data, list) else [data]
    cols = {}
    for (name, *_), loc in zip(CITIES, data):
        d = loc["daily"]
        tmax = pd.Series(d["temperature_2m_max"], index=pd.to_datetime(d["time"]), dtype=float)
        tmin = pd.Series(d["temperature_2m_min"], index=pd.to_datetime(d["time"]), dtype=float)
        cols[name] = (tmax + tmin) / 2  # NOAA degree-day convention
    return pd.DataFrame(cols)


def load_weather(cache_path: str | None, today: date) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Daily mean temperature (F) per city: archive for history, forecast API for recent and coming days.
    Returns (all days including forecast, archive-only history for the cache)."""
    cached = None
    if cache_path:
        try:
            cached = pd.read_csv(cache_path, index_col=0, parse_dates=True)
        except FileNotFoundError:
            pass
    # Archive data lags by about five days; anything newer than 10 days comes from the forecast API
    archive_end = today - timedelta(days=10)
    start = WEATHER_START if cached is None or cached.empty else (cached.index.max() - pd.Timedelta(days=30)).date()
    parts = [cached] if cached is not None else []
    cur = start
    while cur <= archive_end:  # one request per year keeps each call small
        end = min(date(cur.year, 12, 31), archive_end)
        print(f"  weather archive {cur} to {end}", file=sys.stderr)
        parts.append(_fetch_temps(ARCHIVE, f"start_date={cur}&end_date={end}"))
        cur = end + timedelta(days=1)
    hist = pd.concat(parts)
    hist = hist[~hist.index.duplicated(keep="last")].sort_index().dropna()
    recent = _fetch_temps(FORECAST, "past_days=20&forecast_days=16")
    out = pd.concat([hist[hist.index < recent.index.min()], recent])
    out = out[~out.index.duplicated(keep="last")].sort_index()
    return out, hist


# ---------------------------------------------------------------- features
def degree_days(temps: pd.DataFrame) -> pd.DataFrame:
    w = np.array([c[3] for c in CITIES])
    w = w / w.sum()
    t = temps[[c[0] for c in CITIES]]
    hdd = (65 - t).clip(lower=0).mul(w).sum(axis=1, min_count=len(CITIES))
    cdd = (t - 65).clip(lower=0).mul(w).sum(axis=1, min_count=len(CITIES))
    return pd.DataFrame({"hdd": hdd, "cdd": cdd}).dropna()


def weekly_degree_days(daily: pd.DataFrame) -> pd.DataFrame:
    """Sum Saturday through Friday, labelled by the Friday (the EIA report week)."""
    wk = daily.resample("W-FRI").agg(["sum", "count"])
    full = (wk[("hdd", "count")] == 7)
    return pd.DataFrame({"hdd": wk[("hdd", "sum")], "cdd": wk[("cdd", "sum")]})[full]


def _same_week_avg(series: pd.Series, when: pd.Timestamp, years: int = 5) -> float:
    """Average of the value for the closest week in each of the previous five years."""
    vals = []
    for k in range(1, years + 1):
        target = when - pd.DateOffset(years=k)
        i = series.index.get_indexer([target], method="nearest")[0]
        if i >= 0 and abs((series.index[i] - target).days) <= 3:
            vals.append(series.iloc[i])
    return float(np.mean(vals)) if len(vals) == years else np.nan


def build_features(storage: pd.Series, weekly_dd: pd.DataFrame, extra_weeks: int = 1) -> pd.DataFrame:
    """One row per report week; also adds `extra_weeks` future rows with no actual change yet."""
    storage = storage.sort_index()
    change = storage.diff()
    weeks = list(storage.index) + [storage.index[-1] + pd.Timedelta(weeks=k) for k in range(1, extra_weeks + 1)]
    rows = []
    for t in weeks:
        prev = t - pd.Timedelta(weeks=1)
        if prev not in storage.index:
            continue
        doy = t.dayofyear / 365.25 * 2 * np.pi
        rows.append({
            "week_ending": t,
            "change": change.get(t, np.nan),
            "avg5": _same_week_avg(change.dropna(), t),
            "prev_change": change.get(prev, np.nan),
            "surplus": storage[prev] - _same_week_avg(storage, prev),
            "season_sin": np.sin(doy),
            "season_cos": np.cos(doy),
        })
    df = pd.DataFrame(rows).set_index("week_ending")
    return df.join(weekly_dd[["hdd", "cdd"]], how="left")


# ---------------------------------------------------------------- models
def make_models() -> dict:
    return {
        "ridge": make_pipeline(StandardScaler(), Ridge(alpha=1.0)),
        "gbm": HistGradientBoostingRegressor(max_iter=300, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=10, l2_regularization=1.0, random_state=0),
    }


def walk_forward(df: pd.DataFrame, test_start: str = TEST_START, refit_every: int = 1) -> pd.DataFrame:
    """Refit on everything before each test week, predict that week. No look-ahead."""
    data = df.dropna(subset=FEATURES + ["change"])
    test_idx = data.index[data.index >= pd.Timestamp(test_start)]
    out, models = [], None
    for n, t in enumerate(test_idx):
        train = data[data.index < t]
        if models is None or n % refit_every == 0:
            models = make_models()
            for m in models.values():
                m.fit(train[FEATURES], train["change"])
        x = data.loc[[t], FEATURES]
        p = {k: float(m.predict(x)[0]) for k, m in models.items()}
        out.append({"week_ending": t, "actual": float(data.at[t, "change"]), "baseline": float(data.at[t, "avg5"]), **p, "ensemble": (p["ridge"] + p["gbm"]) / 2})
    return pd.DataFrame(out).set_index("week_ending")


def score(bt: pd.DataFrame) -> dict:
    res = {}
    for k in ["baseline", "ridge", "gbm", "ensemble"]:
        e = bt[k] - bt["actual"]
        res[k] = {"mae": round(float(e.abs().mean()), 1), "rmse": round(float(np.sqrt((e ** 2).mean())), 1), "bias": round(float(e.mean()), 1)}
    return res


# ---------------------------------------------------------------- main
def run(storage: pd.Series, daily_temps: pd.DataFrame, prev: dict | None, now: datetime) -> dict:
    wdd = weekly_degree_days(degree_days(daily_temps))
    df = build_features(storage, wdd, extra_weeks=1)
    bt = walk_forward(df)
    scores = score(bt)
    best = min(["ridge", "gbm", "ensemble"], key=lambda k: scores[k]["mae"])

    target = df.index[-1]  # the week after the last report
    row = df.loc[[target]]
    if row[FEATURES].isna().any(axis=None):
        raise RuntimeError(f"missing features for {target.date()}: {row[FEATURES].to_dict('records')}")
    train = df.dropna(subset=FEATURES + ["change"])
    models = make_models()
    for m in models.values():
        m.fit(train[FEATURES], train["change"])
    p = {k: float(m.predict(row[FEATURES])[0]) for k, m in models.items()}
    p["ensemble"] = (p["ridge"] + p["gbm"]) / 2
    recent_err = (bt[best] - bt["actual"]).iloc[-104:]  # last two years of backtest errors
    lo, hi = np.quantile(recent_err, [0.1, 0.9])
    fc = p[best]

    week_start = target - pd.Timedelta(days=6)  # Saturday
    days_observed = int((pd.Timestamp(now.date()) - week_start).days)
    entry = {
        "week_ending": target.date().isoformat(),
        "forecast_bcf": round(fc),
        "low_bcf": round(fc - hi),
        "high_bcf": round(fc - lo),
        "baseline_bcf": round(float(row["avg5"].iloc[0])),
        "model": best,
        "made": now.isoformat(timespec="minutes"),
        "weather_days_observed": max(0, min(7, days_observed)),
    }
    log = {r["week_ending"]: r for r in (prev or {}).get("log", [])}
    for wk, r in log.items():  # fill in actuals as reports come out
        ts = pd.Timestamp(wk)
        if r.get("actual_bcf") is None and ts in storage.index and ts - pd.Timedelta(weeks=1) in storage.index:
            r["actual_bcf"] = round(float(storage[ts] - storage[ts - pd.Timedelta(weeks=1)]))
    # Keep the first forecast made for a week with full information, but update it until the week has ended
    old = log.get(entry["week_ending"])
    if old is None or old.get("actual_bcf") is None:
        log[entry["week_ending"]] = {**entry, "actual_bcf": None}
    live = [r for r in log.values() if r.get("actual_bcf") is not None]

    last = bt.iloc[-26:]
    return {
        "updated": now.isoformat(timespec="minutes"),
        "target": "EIA weekly net change in Lower 48 working gas, Bcf (positive = injection)",
        "forecast": entry,
        "models": {k: round(v) for k, v in p.items()},
        "latest_report": {"week_ending": storage.index[-1].date().isoformat(), "working_gas_bcf": round(float(storage.iloc[-1])), "change_bcf": round(float(storage.iloc[-1] - storage.iloc[-2]))},
        "backtest": {
            "method": "Walk-forward: refit every week on all earlier weeks, predict the next; observed weather.",
            "from": bt.index[0].date().isoformat(), "to": bt.index[-1].date().isoformat(), "weeks": len(bt),
            "scores": scores, "chosen": best,
        },
        "recent": [{"week_ending": t.date().isoformat(), "actual": round(r["actual"]), "forecast": round(r[best]), "baseline": round(r["baseline"])} for t, r in last.iterrows()],
        "live_track_record": {"weeks": len(live), "mae": round(float(np.mean([abs(r["forecast_bcf"] - r["actual_bcf"]) for r in live])), 1) if live else None},
        "log": sorted(log.values(), key=lambda r: r["week_ending"])[-104:],
        "weather": {"source": "Open-Meteo (ERA5 archive and forecast)", "cities": [c[0] for c in CITIES], "weighting": "metro population"},
        "features": FEATURES,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="forecast.json")
    ap.add_argument("--prev")
    ap.add_argument("--weather-cache")
    ap.add_argument("--storage-csv", help="offline: CSV with week_ending,bcf")
    ap.add_argument("--today")
    a = ap.parse_args(argv)
    now = datetime.now(timezone.utc) if not a.today else datetime.fromisoformat(a.today).replace(tzinfo=timezone.utc)

    storage = (pd.read_csv(a.storage_csv, index_col=0, parse_dates=True).iloc[:, 0] if a.storage_csv else load_storage())
    print(f"storage: {len(storage)} weeks, {storage.index[0].date()} to {storage.index[-1].date()}", file=sys.stderr)
    temps, hist = load_weather(a.weather_cache, now.date())
    if a.weather_cache:
        hist.round(2).to_csv(a.weather_cache)
    print(f"weather: {temps.index[0].date()} to {temps.index[-1].date()}", file=sys.stderr)

    prev = None
    if a.prev:
        try:
            prev = json.load(open(a.prev))
        except Exception:
            prev = None
    out = run(storage, temps, prev, now)
    json.dump(out, open(a.out, "w"), indent=1)
    f, s = out["forecast"], out["backtest"]["scores"]
    print(f"forecast week ending {f['week_ending']}: {f['forecast_bcf']:+} Bcf (80% range {f['low_bcf']:+} to {f['high_bcf']:+}); 5-yr avg {f['baseline_bcf']:+}")
    print("backtest MAE (Bcf): " + ", ".join(f"{k} {v['mae']}" for k, v in s.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
