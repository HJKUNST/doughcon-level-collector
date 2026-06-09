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
├── collector.py              # API 호출 → CSV append (Actions 가 30분마다 실행)
├── merger.py                 # yfinance 와 병합 (수동 1회 실행)
├── requirements.txt
├── data/
│   ├── doughcon_raw.csv      # 누적 원시 데이터 (Actions 가 자동 커밋)
│   ├── _raw_json/            # 슬림 원본 응답 백업 (월별 .jsonl, 스키마 변경 보험)
│   └── merged_final.csv      # 분석용 병합 결과 (수동 생성, .gitignore)
├── debug/
│   └── index.html            # 디버깅용 정적 대시보드
└── .github/workflows/
    ├── collect.yml           # 30분 cron — 수집/커밋
    ├── monitor.yml           # 1시간 cron — last_ts age 검사 (2h+ 시 fail)
    └── keepalive.yml         # 주 1회 — 60일 룰 회피용 PAT push
```

---

## 수집 파이프라인 (기획서 §3.1)

```text
GitHub Actions cron (*/30 * * * *)
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
| 트리거        | `cron: */30 * * * *` + `workflow_dispatch`        |
| 런타임        | `ubuntu-latest`, `python-3.11`                    |
| 의존성 캐싱   | `actions/cache@v4` → `~/.cache/pip`               |
| 권한          | `contents: write` (CSV 자동 커밋)                 |
| 커밋 스킵     | `git diff --cached --quiet` 시 커밋 생략          |
| 동시성        | `concurrency: collect-doughcon` (직렬 실행)       |

월 사용량 (기획서 §3.2): **720분** (무료 한도 2,000 분의 36%).

---

## 데이터 지속성 보강 (운영 안정성)

기획서 본문 외에 "수집이 끊기지 않도록" 추가한 4가지 안전장치입니다.

### 1. 지수 백오프 재시도 (`collector.py`)

일시적 5xx / 네트워크 오류로 30분 슬롯이 통째로 손실되는 것을 방지합니다.
최대 3회 시도 (1s / 3s / 9s + jitter). 4xx 는 일시 장애가 아니므로 즉시 실패.

### 2. 원본 JSON 백업 (`data/_raw_json/YYYY-MM.jsonl`)

스키마 변경/파싱 버그 발견 시 raw 에서 재구축할 수 있는 보험입니다.
응답에서 가장 무거운 `data` 필드(약 45KB, 매장별 raw points) 만 제외하고
나머지(events, spike magnitude, breadth/intensity score 등)는 모두 보존.

- 사이즈: 1행 약 1KB → 1년 약 14MB (`data` 미슬림 시 720MB → 50배 절약)
- 제외된 키는 행마다 `dropped` 배열에 기록되어 스키마 변경 추적 가능

### 3. 자체 모니터링 워크플로우 (`.github/workflows/monitor.yml`)

매시 15분에 실행. `data/doughcon_raw.csv` 의 마지막 timestamp 가 2시간을 넘으면
워크플로우를 실패 처리합니다. GitHub 가 실패 워크플로우에 대해 기본 이메일을
보내므로 외부 서비스(Healthchecks 등) 없이 수집 중단을 인지할 수 있습니다.

### 4. 60일 룰 회피 (`.github/workflows/keepalive.yml`)

GitHub 는 레포에 60일간 "사용자 활동" 이 없으면 scheduled workflow 를
자동 비활성화합니다. **`github-actions[bot]` 의 커밋은 활동으로 카운트되지
않으므로**, 우리 cron 이 매일 push 해도 어느 날 갑자기 멈춥니다.

회피책: 사용자 계정 PAT 로 주 1회(`매주 월 07:37 UTC`) 빈 commit 을 push.
PAT secret 이 없으면 워크플로우는 안전하게 NO-OP 으로 종료됩니다.

#### PAT 셋업 절차 (최초 1회)

**1단계 — Fine-grained PAT 발급**

가장 빠른 방법: 다이렉트 URL 사용
👉 <https://github.com/settings/personal-access-tokens/new>

> ⚠️ 메뉴로 찾는다면: 우상단 **프로필 사진** → `Settings` (레포의 Settings 탭 아님,
> 계정 전역 Settings 입니다) → 좌측 사이드바를 **맨 아래까지 스크롤** →
> `Developer settings` → `Personal access tokens` → `Fine-grained tokens` →
> `Generate new token`. 레포의 Settings 탭에는 Developer settings 가 없습니다.

발급 페이지에서 다음과 같이 설정:

- **Token name**: `doughcon-keepalive` (식별용, 자유)
- **Resource owner**: 본인 계정 (`HJKUNST`)
- **Repository access**: `Only select repositories` → `doughcon-level-collector` 1개만 선택
- **Repository permissions** → `Contents` = **Read and write** (이것만 켜고 나머지는 둠)
- **Expiration**: 1 year 권장 (만료 1주일 전 이메일 알림이 옴)
- 하단의 `Generate token` 클릭 → 다음 화면의 토큰 문자열을 즉시 복사
  (한 번만 표시되므로 닫기 전에 반드시 복사)

**2단계 — 레포 Secret 으로 등록**

다이렉트 URL:
👉 <https://github.com/HJKUNST/doughcon-level-collector/settings/secrets/actions/new>

- Name : `KEEPALIVE_PAT`
- Secret : 위에서 복사한 토큰
- `Add secret`

**3단계 — 즉시 동작 검증**

다이렉트 URL:
👉 <https://github.com/HJKUNST/doughcon-level-collector/actions/workflows/keepalive.yml>

`Run workflow` 버튼 → `Run workflow` 한 번 더 클릭.
30초 후 새 commit (`chore: keepalive (YYYY-MM-DD)`) 이 main 에 들어오면 성공.

> Secret 없이 두면 30분 cron 은 정상 동작하지만 **60일 후 비활성화 위험**이
> 있으니, 사람 계정으로 60일에 한 번 이상 push 가 보장되지 않는다면
> PAT 셋업을 강력히 권장합니다.

---

## 한계 및 유의사항 (기획서 §6.3)

- DOUGHCON 은 엔터테인먼트 목적의 비공식 OSINT 지표입니다.
  분석 결과는 탐색적 연구 수준으로만 해석해야 합니다.
- 레벨 1~2 이벤트가 연간 수십 건에 불과해 이벤트 스터디의
  통계적 유의성 확보가 구조적으로 어렵습니다.
- `/api/dashboard-data` 는 비공식 내부 API 입니다.
  스키마 변경 또는 서비스 종료 시 수집이 중단됩니다.
- Correlation does not imply causation.
