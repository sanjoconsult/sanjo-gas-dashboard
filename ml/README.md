# Weekly storage forecast (model card)

Forecasts the next EIA *Weekly Natural Gas Storage Report*: the change in Lower 48 working gas for the week ending Friday, in Bcf (positive = injection). It runs every day in GitHub Actions (`.github/workflows/forecast.yml`), and the dashboard's Storage tab shows the result.

## Data
| Input | Source | Notes |
|---|---|---|
| Weekly working gas, Lower 48, 2010 on | EIA (`NW2_EPG0_SWO_R48_BCFw.xls`, plus `wngsr.json` for the newest week) | Free, no key |
| Daily high and low temperature, 10 metro areas, Dec 2014 on | Open-Meteo (ERA5 archive, plus the forecast model for the last 20 and next 16 days) | Free, no key; cached in the `forecast-data` branch |

Degree days use the NOAA convention: daily mean = (high + low) / 2, base 65 °F. The cities are weighted by metro population (New York, Los Angeles, Chicago, Dallas, Houston, Philadelphia, Atlanta, Boston, Detroit, Minneapolis).

## Features (for the week being forecast)
- `hdd`, `cdd`: population-weighted heating and cooling degree days, Saturday to Friday
- `avg5`: average change for the same week in the previous five years
- `prev_change`: last reported weekly change
- `surplus`: storage level last week minus its five-year average
- `season_sin`, `season_cos`: time of year

Every feature is known when the forecast is made (on Thursday, the target week's weather is about 6 days observed and 1 day forecast).

## Models and validation
- **Baseline:** the five-year average for the week (`avg5`), the usual rule of thumb.
- **Ridge regression** (standardized features) and **gradient boosting** (`HistGradientBoostingRegressor`), plus their average (**ensemble**).
- **Walk-forward backtest:** for every week from January 2022, refit on all earlier weeks and predict that week. Nothing from the test week or later is used for training.
- The model with the lowest backtest mean absolute error (MAE) is published. The 80% range comes from the 10th and 90th percentiles of its backtest errors over the last two years.

Results from the run on Oct 30, 2026 (251 test weeks, Jan 2022 to Oct 2026):

| Model | MAE, Bcf | RMSE, Bcf |
|---|---|---|
| Five-year average (baseline) | 31.4 | 45.5 |
| Ridge regression | 15.7 | 20.8 |
| Gradient boosting | 14.9 | 20.0 |
| **Ensemble (published)** | **13.7** | **18.6** |

## Limits
- The backtest uses observed weather for the whole target week. Live forecasts made earlier in the week rely more on weather forecasts, so their errors will be somewhat larger. `forecast.json` therefore keeps a **live track record**: each week's published forecast, scored against the EIA number when it comes out.
- Ten cities stand in for national weather-driven demand. Regional or industrial shifts and LNG feedgas outages aren't modelled directly.
- EIA reclassifications and revisions show up as unexplained errors.

## Run it
```bash
pip install -r ml/requirements.txt
python ml/storage_forecast.py --out forecast.json --weather-cache weather_daily.csv
python -m pytest -q ml   # synthetic-data tests: degree days, no look-ahead, model beats baseline, output format
```
