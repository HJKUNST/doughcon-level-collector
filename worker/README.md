# DOUGHCON Collector — Cloudflare Worker

Cloudflare Workers Cron Triggers를 이용한 DOUGHCON 지수 30분 주기 수집기.
GitHub Actions cron의 알려진 신뢰성 문제(신규 레포 활성화 지연, 정시 부하로 인한
스킵)를 우회하기 위해 도입했다.

`collector.py`의 로직(캐시 우회 3단 재시도, 1~5 범위 검증, 슬림 JSON 백업,
중복 timestamp 가드)을 TypeScript로 포팅했다. GitHub Actions와 공존하며 동일한
CSV/JSONL 파일에 sha 기반 낙관적 동시성 재시도로 안전하게 append한다.

## 아키텍처

| 구성 요소 | 역할 |
|---|---|
| `src/index.ts` | Worker 엔트리포인트 — `scheduled` (cron) / `fetch` (`/__run` 수동 실행) |
| Cron Trigger | 매시 7분, 37분 (`wrangler.toml` → `[triggers].crons`) |
| GitHub Contents API | 대상 레포에 직접 commit (git clone 없이 REST로 append) |
| `GITHUB_TOKEN` secret | Contents: Read/Write 권한의 fine-grained PAT |

## 사전 요구사항

- Node.js 18+
- Cloudflare 계정 (무료 플랜으로 충분 — 월 1,440 invocation, 무료 한도 100,000/day의 0.05%)
- GitHub fine-grained PAT (아래 1단계에서 발급, 기존 `KEEPALIVE_PAT`과는 별도로 분리)

## 최초 설정

### 1. GitHub PAT 발급

[github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)

| 항목 | 값 |
|---|---|
| Token name | `doughcon-worker` |
| Resource owner | `HJKUNST` |
| Repository access | Only select repositories → `doughcon-level-collector` |
| Repository permissions | Contents: **Read and write** |
| Expiration | 1 year |

`Generate token` 클릭 후 토큰 값을 복사한다 (재확인 불가).

### 2. 의존성 설치

```bash
cd worker
npm install
```

### 3. Cloudflare 인증

```bash
npx wrangler login
```

브라우저가 열리며 Cloudflare 계정 인증을 진행한다.

### 4. GITHUB_TOKEN secret 등록

```bash
npx wrangler secret put GITHUB_TOKEN
```

`GITHUB_TOKEN`은 secret의 **이름**이며 이미 명령에 포함돼 있다. 프롬프트가 뜨면
1단계에서 발급한 PAT 값(`github_pat_...`)을 붙여넣는다.

> **흔한 실수:** PAT 문자열 자체를 secret 이름 자리에 넣으면
> (`wrangler secret put github_pat_...`) Worker가 `env.GITHUB_TOKEN`을 찾지
> 못해 401로 실패한다. 등록 후 아래 명령으로 이름을 확인한다.

```bash
npx wrangler secret list
# → [{"name":"GITHUB_TOKEN","type":"secret_text"}]
```

### 5. 배포

```bash
npx wrangler deploy
```

성공 시 `https://doughcon-collector.<subdomain>.workers.dev`가 출력된다.

### 6. 동작 검증

배포 URL 뒤에 `/__run`을 붙여 열면 1회 수동 실행 후 결과가 JSON으로 반환된다.

```
https://doughcon-collector.<subdomain>.workers.dev/__run
```

`{"ok":true,"csv":{"appended":true,"sha":"..."}, ...}`가 반환되면 성공이며,
레포에 `chore(data): collect doughcon @ ... [worker]` commit이 생성된다.
`{"ok":false,"error":"GITHUB_TOKEN secret is missing..."}`가 반환되면 4단계를
다시 확인한다.

### 7. Cron 첫 실행 확인

[Cloudflare 대시보드](https://dash.cloudflare.com/?to=/:account/workers/services/view/doughcon-collector) →

- **Logs → Live tail**: 실시간 로그
- **Triggers**: 다음 cron 실행 예정 시각

매시 7분/37분에 자동 실행되며, 분 단위 정확도로 GitHub Actions cron처럼
스킵되지 않는다.

## 운영

**실시간 로그**

```bash
npx wrangler tail
```

**Cron 주기 변경**

`wrangler.toml`의 `[triggers].crons` 수정 후 `npx wrangler deploy`.

**PAT 갱신** (만료 1년 전 권장)

```bash
npx wrangler secret put GITHUB_TOKEN
```
기존 값을 덮어쓴다.

**일시 비활성화 / 재활성화**

```bash
npx wrangler triggers deploy --triggers ''   # 비활성화
npx wrangler deploy                          # 재활성화
```

## GitHub Actions와의 공존

이 Worker를 배포해도 `.github/workflows/collect.yml`은 그대로 유지된다.

| 트리거 | 역할 |
|---|---|
| Worker cron | 주력 — 30분 주기 자동 수집 |
| Actions `schedule` | 백업 |
| Actions `workflow_dispatch` | 수동 점검용 |
| `monitor.yml` | 2시간 무갱신 시 stall 알림 |

동일 timestamp의 중복 commit을 막기 위해 sha 기반 동시성 재시도와 중복
timestamp 가드를 양쪽에 동일하게 적용했다. Worker가 1~2일 안정적으로 동작함이
확인되면 Actions의 `schedule` 트리거만 제거해 중복 가능성을 완전히 없앨 수 있다.

```yaml
# .github/workflows/collect.yml — schedule 제거 시
on:
  workflow_dispatch: {}   # 수동만 남김
```
