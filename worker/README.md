# DOUGHCON Collector — Cloudflare Worker

GitHub Actions cron 의 신뢰성 문제(신규 레포 활성화 지연, 정시 부하 스킵 등)를
우회하기 위해 Cloudflare Workers Cron Triggers 가 직접 30분마다 동작한다.

`collector.py` 의 모든 로직(캐시 우회 3단, 재시도, 1~5 검증, 슬림 JSON 백업,
중복 timestamp 가드)을 TypeScript 로 포팅했으며, GitHub Actions 와 공존하며
충돌 없이 같은 CSV/JSONL 파일에 append 한다 (sha 기반 낙관적 동시성 재시도).

---

## 셋업 (최초 1회, ~10분)

### 0. 사전 요구사항

- Node.js (이미 설치됨: `v24.1.0`)
- Cloudflare 계정 (없으면 <https://dash.cloudflare.com/sign-up>, 이메일만)
- GitHub Fine-grained PAT 1개 (아래에서 발급)

### 1. PAT 발급 (worker 용, 기존 KEEPALIVE_PAT 과 분리)

다이렉트 URL: <https://github.com/settings/personal-access-tokens/new>

- **Token name**: `doughcon-worker`
- **Resource owner**: `HJKUNST`
- **Repository access**: `Only select repositories` → `doughcon-level-collector`
- **Repository permissions** → `Contents` = **Read and write**
- **Expiration**: 1 year
- `Generate token` → 토큰 복사 (한 번만 보임)

### 2. 의존성 설치

```bash
cd worker
npm install
```

### 3. Cloudflare 인증

```bash
npx wrangler login
```

브라우저가 열리며 Cloudflare 로 한 번 인증.

### 4. PAT 를 Worker secret 으로 등록

```bash
npx wrangler secret put GITHUB_TOKEN
```

프롬프트가 뜨면 1단계에서 복사한 PAT 붙여넣기 + Enter.

### 5. 배포

```bash
npx wrangler deploy
```

성공 시 `https://doughcon-collector.<your-subdomain>.workers.dev` URL 이 출력됨.

### 6. 즉시 동작 검증

배포된 URL 뒤에 `/__run` 을 붙여 브라우저로 열면 1회 수동 실행 + 결과 JSON 표시:

```text
https://doughcon-collector.<your-subdomain>.workers.dev/__run
```

성공하면 `{"ok":true, "csv":{"appended":true,"sha":"..."}, ...}` 와 같이 응답하고,
GitHub 레포에 `chore(data): collect doughcon @ ... [worker]` commit 이 들어와 있어야 함.

### 7. cron 첫 실행 확인 (~30분 후)

대시보드: <https://dash.cloudflare.com/?to=/:account/workers/services/view/doughcon-collector>

- `Logs` 탭 → `Live tail` 로 실시간 로그
- `Triggers` 탭 → cron 다음 실행 예정 시각 확인

매시 7/37분에 자동 실행되며, **Cloudflare cron 은 분 단위 정확도** 로 GitHub Actions
처럼 스킵되지 않는다.

---

## 운영

### 로그 보기

```bash
npx wrangler tail
```

실시간 로그 스트리밍 (Ctrl+C 로 종료).

### cron 주기 변경

`wrangler.toml` 의 `[triggers].crons` 수정 후 `npx wrangler deploy`.

### PAT 갱신 (만료 1년 전)

```bash
npx wrangler secret put GITHUB_TOKEN
```

새 PAT 입력하면 기존 값 덮어쓰기됨.

### 일시 비활성화

```bash
npx wrangler triggers deploy --triggers ''
# 다시 켜기:
npx wrangler deploy
```

---

## GitHub Actions 와의 공존

이 Worker 를 배포해도 `.github/workflows/collect.yml` 은 그대로 유지된다.

- **Worker (주력)**: 매 30분 자동 수집
- **GitHub Actions schedule**: 백업 (어차피 비정기적으로 도는 상태)
- **GitHub Actions workflow_dispatch**: 수동 점검용
- **monitor.yml**: 2시간 임계 stall 알림 (그대로)

같은 timestamp 가 중복 들어오지 않게 sha 기반 동시성 + 중복 timestamp 가드를
양쪽 모두 적용했다. Worker 가 안정적으로 1-2일 도는 것이 확인되면 Actions 의
`schedule` 트리거만 제거해 중복 commit 가능성을 완전 차단할 수 있다.

```yaml
# .github/workflows/collect.yml 에서 향후 schedule 제거 예시
on:
  workflow_dispatch: {}   # 수동만 남김
```
