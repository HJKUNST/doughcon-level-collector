# DOUGHCON Collector

Pentagon Pizza Index(DOUGHCON) 비공식 API 를 30분 간격으로 수집하여
미국 증시와의 상관관계 분석을 위한 장기 시계열 데이터셋을 구축합니다.

> 본 구현은 `DOUGHCON_Collector_기술기획서.docx` v1.0 (2026.06) 의 사양을
> 그대로 따릅니다. 모듈/스키마/스케줄/집계 규약은 모두 기획서 §1–§7 의
> 명세를 인용 구현한 것입니다.

---

## 디렉토리 구조

```text
doughcon-data/
├── collector.py              # 동일 로직의 Python 구현 (Actions 백업/로컬 점검용)
├── merger.py                 # yfinance 와 병합 (수동 1회 실행)
├── requirements.txt
├── data/
│   ├── doughcon_raw.csv      # 누적 원시 데이터 (Worker 가 자동 커밋)
│   ├── _raw_json/            # 슬림 원본 응답 백업 (월별 .jsonl, 스키마 변경 보험)
│   └── merged_final.csv      # 분석용 병합 결과 (수동 생성, .gitignore)
├── debug/
│   └── index.html            # 디버깅용 정적 대시보드
├── worker/                   # ★ 주력 수집 엔진 (Cloudflare Worker, TypeScript)
│   ├── src/index.ts          # scheduled handler — 30분마다 fetch + GitHub Contents API commit
│   ├── wrangler.toml         # cron: 7,37 * * * *
│   └── README.md             # 셋업/배포/검증 가이드
└── .github/workflows/
    ├── collect.yml           # (백업/수동) Actions 도 같은 collector.py 실행
    ├── monitor.yml           # 1시간 cron — last_ts age 검사 (2h+ 시 fail)
    └── keepalive.yml         # 주 1회 — 60일 룰 회피용 PAT push
```

> **왜 Cloudflare Worker 가 주력인가**: GitHub Actions cron 은 신규 레포에서
> "활성화 지연"(수 시간~수십 시간) 과 "정시 부하 스킵" 이라는 본질적 신뢰성
> 문제가 있어 30분 간격 정확 수집에 부적합. Cloudflare Workers Cron Triggers 는
> 분 단위 정확도를 제공하며 무료 한도 안에 충분히 들어온다. 자세한 셋업은
> [`worker/README.md`](worker/README.md) 참조.

---

## 수집 파이프라인 (기획서 §3.1)

```text
GitHub Actions cron (7,37 * * * *)  ← 30분 간격 + 정시 부하 회피
        │
        ▼
collector.py
  ├─ fetch_dashboard()   pizzint.watch/api/dashboard-data 호출
  │     - URL cache buster ?_={unix}
  │     - Cache-Control: no-cache / Pragma: no-cache
  │     - Safari User-Agent
  ├─ parse_payload()     defcon_level 1~5 검증, 나머지는 optional
  └─ append_row()        data/doughcon_raw.csv 에 한 행 append
        │
        ▼
git add → commit if changed → push
```

CSV 스키마 (기획서 §4.1):

```text
timestamp, doughcon_level, overall_index, smoothed_index
```

---

## 로컬 실행

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 1회 수집 (data/doughcon_raw.csv 에 한 행 추가됨)
python collector.py
```

출력 예:

```text
[collector] fetch start at 2026-06-09T03:55:01+00:00
[collector][APPENDED] ts=2026-06-09T03:55:00Z level=4 overall='18.2400' smoothed='18.0100'
```

---

## merger.py (수동 1회 실행)

기획서 §4.3 기준: **수집 1,000건 이상(약 3주)** 또는
**레벨 1~2 이벤트 10건 이상** 확보된 시점에 실행합니다.

```bash
python merger.py
# 또는 기간 지정
python merger.py --start 2026-06-01 --end 2026-12-01
```

산출물 `data/merged_final.csv` 컬럼 (기획서 §5.2):

| 컬럼            | 의미                                    |
| --------------- | --------------------------------------- |
| `level_min`     | 당일 최고 위험도 (이벤트 스터디 기준)   |
| `level_mean`    | 일간 평균 긴장도 (추세 분석)            |
| `smoothed_mean` | 회귀 분석 주력 변수                     |
| `overall_mean`  | 원시 지수 일간 평균                     |
| `n_obs`         | 당일 수집 횟수 (정상 48)                |
| `sp500_close`   | ^GSPC 종가 (yfinance, auto_adjust)      |
| `sp500_ret`     | ^GSPC 일간 로그수익률                   |
| `nasdaq_close`  | ^IXIC 종가                              |
| `nasdaq_ret`    | ^IXIC 일간 로그수익률                   |

---

## 디버깅용 대시보드 (`debug/index.html`)

의존성 없이 정적 파일 하나로 동작합니다 (Chart.js CDN 만 사용).
브라우저가 `file://` fetch 를 차단하므로 정적 서버로 띄워서 엽니다.

```bash
python3 -m http.server -d . 8000
# 브라우저
open http://localhost:8000/debug/
```

다른 CSV (예: GitHub raw URL) 로 보고 싶다면 쿼리 파라미터로 전달:

```text
http://localhost:8000/debug/?csv=https://raw.githubusercontent.com/<user>/<repo>/main/data/doughcon_raw.csv
```

포함된 패널:

1. **Latest** — 마지막 DOUGHCON 레벨/지수, 수집 후 경과 시간
2. **Collection health** — 총 행수, 일별 평균 수집 횟수, **누락률 추정**
3. **Level distribution** — DC1~DC5 히스토그램
4. **Time series** — `doughcon_level` (계단형, 우축) +
   `overall_index` / `smoothed_index` (좌축) 동시 표시
5. **Level 1–2 events** — 이벤트 스터디 후보 (최근 100건)
6. **Recent 50 rows** — 원시 행 검사

데이터 품질 점검 가이드 (기획서 §7.2):

- `last ts` 와 현재 시각 차이가 1시간 이상 → 수집 중단 의심
- `est. missing rate` 가 5% 초과 → Actions 실패 워크플로우 확인
- `avg rows / day` 가 40 미만인 날짜 → 분석 시 가중치 조정 고려

---

## GitHub Actions 설정 (`.github/workflows/collect.yml`)

| 항목          | 값                                                |
| ------------- | ------------------------------------------------- |
| 트리거        | `cron: 7,37 * * * *` + `workflow_dispatch` (정시 부하 회피용 7분 오프셋) |
| 런타임        | `ubuntu-latest`, `python-3.11`                    |
| 의존성 캐싱   | `actions/cache@v4` → `~/.cache/pip`               |
| 권한          | `contents: write` (CSV 자동 커밋)                 |
| 커밋 스킵     | `git diff --cached --quiet` 시 커밋 생략          |
| 동시성        | `concurrency: collect-doughcon` (직렬 실행)       |

월 사용량 (기획서 §3.2): **720분** (무료 한도 2,000 분의 36%).

---

## 한계 및 유의사항 (기획서 §6.3)

- DOUGHCON 은 엔터테인먼트 목적의 비공식 OSINT 지표입니다.
  분석 결과는 탐색적 연구 수준으로만 해석해야 합니다.
- 레벨 1~2 이벤트가 연간 수십 건에 불과해 이벤트 스터디의
  통계적 유의성 확보가 구조적으로 어렵습니다.
- `/api/dashboard-data` 는 비공식 내부 API 입니다.
  스키마 변경 또는 서비스 종료 시 수집이 중단됩니다.
- Correlation does not imply causation.
