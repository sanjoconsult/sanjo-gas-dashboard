"""Tests for the storage forecast, on synthetic data with a known weather effect (no network)."""
import numpy as np
import pandas as pd
import pytest

import storage_forecast as sf


def synthetic(seed=0, start="2014-12-01", end="2026-10-29"):
    """Daily temperatures with seasons and noise; storage changes driven by heating and cooling demand."""
    rng = np.random.default_rng(seed)
    days = pd.date_range(start, end, freq="D")
    doy = days.dayofyear.values
    temps = {}
    for name, lat, *_ in sf.CITIES:
        base = 75 - 0.9 * (lat - 30) - (22 + 0.4 * (lat - 30)) * np.cos((doy - 15) / 365.25 * 2 * np.pi)
        temps[name] = base + rng.normal(0, 6, len(days))
    temps = pd.DataFrame(temps, index=days)
    wdd = sf.weekly_degree_days(sf.degree_days(temps))
    fridays = pd.date_range("2010-01-01", end, freq="W-FRI")
    change = pd.Series(0.0, index=fridays)
    # Before weather exists: a seasonal pattern; after: driven by degree days
    seas = 60 - 140 * np.clip(np.cos((fridays.dayofyear - 20) / 365.25 * 2 * np.pi), 0, None)
    change[:] = seas + rng.normal(0, 8, len(fridays))
    has = change.index.isin(wdd.index)
    change[has] = 110 - 0.9 * wdd.loc[change.index[has], "hdd"].values - 0.6 * wdd.loc[change.index[has], "cdd"].values + rng.normal(0, 6, has.sum())
    storage = 2000 + change.cumsum()
    return storage, temps


def test_degree_days_are_weighted_and_weekly_sums_need_seven_days():
    days = pd.date_range("2026-10-03", "2026-10-16", freq="D")  # Sat to Fri, two weeks
    temps = pd.DataFrame({c[0]: 55.0 for c in sf.CITIES}, index=days)
    w = sf.weekly_degree_days(sf.degree_days(temps))
    assert list(w.index.strftime("%Y-%m-%d")) == ["2026-10-09", "2026-10-16"]
    assert w["hdd"].iloc[0] == pytest.approx(70.0)  # 10 HDD a day for 7 days
    assert w["cdd"].iloc[0] == 0
    partial = sf.weekly_degree_days(sf.degree_days(temps.iloc[:-1]))
    assert list(partial.index.strftime("%Y-%m-%d")) == ["2026-10-09"], "a week with missing days is dropped"


def test_features_have_no_look_ahead():
    storage, temps = synthetic()
    wdd = sf.weekly_degree_days(sf.degree_days(temps))
    df = sf.build_features(storage, wdd)
    t = pd.Timestamp("2024-03-01")
    assert df.at[t, "prev_change"] == pytest.approx(storage[t - pd.Timedelta(weeks=1)] - storage[t - pd.Timedelta(weeks=2)])
    # The five-year average uses only earlier years
    prior = [storage.diff().iloc[storage.index.get_indexer([t - pd.DateOffset(years=k)], method="nearest")[0]] for k in range(1, 6)]
    assert df.at[t, "avg5"] == pytest.approx(np.mean(prior))
    # The extra row is the week after the last report, with no actual yet
    assert df.index[-1] == storage.index[-1] + pd.Timedelta(weeks=1)
    assert np.isnan(df["change"].iloc[-1])


def test_models_learn_the_weather_effect_and_beat_the_baseline():
    storage, temps = synthetic()
    wdd = sf.weekly_degree_days(sf.degree_days(temps))
    bt = sf.walk_forward(sf.build_features(storage, wdd), test_start="2025-06-01", refit_every=8)
    s = sf.score(bt)
    assert len(bt) > 40
    assert s["ridge"]["mae"] < s["baseline"]["mae"] * 0.8
    assert s["ensemble"]["mae"] < s["baseline"]["mae"]


def test_run_produces_a_forecast_with_range_and_log():
    storage, temps = synthetic(end="2026-11-12")  # temperatures include the forecast days
    storage = storage[storage.index <= "2026-10-23"]
    now = pd.Timestamp("2026-10-29T17:00:00Z").to_pydatetime()
    prev = {"log": [{"week_ending": storage.index[-1].date().isoformat(), "forecast_bcf": 50, "actual_bcf": None}]}
    out = sf.run(storage, temps, prev, now)
    f = out["forecast"]
    assert f["week_ending"] == "2026-10-30"
    assert f["low_bcf"] <= f["forecast_bcf"] <= f["high_bcf"]
    assert f["weather_days_observed"] == 5  # Sat Oct 24 to Wed Oct 28
    assert len(out["recent"]) == 26
    assert out["live_track_record"]["weeks"] == 1, "last week's logged forecast gets its actual"
    assert {r["week_ending"] for r in out["log"]} == {"2026-10-23", "2026-10-30"}
