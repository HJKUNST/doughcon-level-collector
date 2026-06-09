/**
 * DOUGHCON Collector — Cloudflare Worker
 * =======================================
 *
 * GitHub Actions cron 의 신뢰성 문제(신규 레포 활성화 지연, 정시 부하 스킵 등)를
 * 우회하기 위해 Cloudflare Workers Cron Triggers 가 직접 30분마다 동작한다.
 *
 *  Cloudflare cron (분 단위 정확)
 *     ↓
 *  scheduled() 호출
 *     ↓
 *  pizzint.watch /api/dashboard-data fetch  (collector.py 와 동일 캐시 우회 3단)
 *     ↓
 *  parse + 1~5 검증
 *     ↓
 *  GitHub Contents API:
 *    - data/doughcon_raw.csv     ← 1행 append
 *    - data/_raw_json/YYYY-MM.jsonl  ← 슬림 백업 1행 append (BACKUP_DROP_KEYS 적용)
 *
 * 모든 환경 값은 wrangler.toml [vars] 에서 주입. GITHUB_TOKEN 만 secret.
 *
 * collector.py 와 의도적으로 동일한 동작 (필드 검증/슬림 키/timestamp 정규화/
 * 중복 timestamp 가드) 을 가지며, GitHub Actions 의 workflow_dispatch 가 같이
 * 도는 동안에도 충돌 없이 공존한다 (sha 기반 낙관적 동시성 재시도).
 */

export interface Env {
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  CSV_PATH: string;
  JSONL_DIR: string;
  USER_AGENT: string;
  /** Fine-grained PAT (Contents: read+write). `wrangler secret put GITHUB_TOKEN` 으로 주입 */
  GITHUB_TOKEN: string;
}

// collector.py 의 BACKUP_DROP_KEYS 와 동일. `data` 키 하나가 ~45KB 차지 → 50배 절약.
const BACKUP_DROP_KEYS = new Set(["data"]);

const API_URL = "https://www.pizzint.watch/api/dashboard-data";
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;

const CSV_HEADER = "timestamp,doughcon_level,overall_index,smoothed_index\n";

// ---------- entrypoints ----------

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // ctx.waitUntil 로 비동기 작업이 끝까지 실행되도록 보장.
    ctx.waitUntil(runOnce(env, "scheduled"));
  },
  // 디버깅용: 브라우저로 직접 호출하면 1회 수집 후 결과를 텍스트로 반환.
  // (배포 URL/__run 으로만 트리거. 인증 없음 → 공격 표면 작음. 실행만 가능)
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/__run") {
      const result = await runOnce(env, "manual");
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return new Response(
      "DOUGHCON collector worker is alive.\nUse /__run to trigger manually.\n",
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  },
};

// ---------- core ----------

type RunResult = {
  ok: boolean;
  trigger: string;
  fetchedAt: string;
  csv?: { appended: boolean; sha?: string; reason?: string };
  jsonl?: { appended: boolean; sha?: string; path?: string };
  error?: string;
};

async function runOnce(env: Env, trigger: string): Promise<RunResult> {
  const fetchedAt = new Date();
  const fetchedAtIso = isoUtcSeconds(fetchedAt);
  console.log(`[collector][${trigger}] fetch start at ${fetchedAt.toISOString()}`);

  let payload: any;
  try {
    payload = await fetchDoughcon(env);
  } catch (e: any) {
    const err = String(e?.message ?? e);
    console.error(`[collector][ERROR] fetch failed: ${err}`);
    return { ok: false, trigger, fetchedAt: fetchedAtIso, error: err };
  }

  let row: CsvRow;
  try {
    row = parsePayload(payload, fetchedAt);
  } catch (e: any) {
    const err = String(e?.message ?? e);
    console.error(`[collector][ERROR] parse failed: ${err}`);
    return { ok: false, trigger, fetchedAt: fetchedAtIso, error: err };
  }

  // CSV append + JSONL backup append 는 독립적으로. JSONL 실패가 CSV 를 막지 않게.
  const csvResult = await safeAppendCsv(env, row);
  const jsonlResult = await safeAppendJsonl(env, payload, fetchedAt);

  console.log(
    `[collector][${trigger}] csv=${JSON.stringify(csvResult)} jsonl=${JSON.stringify(jsonlResult)}`,
  );

  return {
    ok: csvResult.appended || csvResult.reason === "duplicate",
    trigger,
    fetchedAt: fetchedAtIso,
    csv: csvResult,
    jsonl: jsonlResult,
  };
}

// ---------- fetch with retry ----------

async function fetchDoughcon(env: Env): Promise<any> {
  let lastErr: any;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchOnce(env);
    } catch (e: any) {
      lastErr = e;
      // 4xx 는 재시도 의미 없음 (스키마/엔드포인트 변경 가능성)
      if (e?.status && e.status >= 400 && e.status < 500) throw e;
      if (attempt === MAX_ATTEMPTS) throw e;
      const sleep = BACKOFF_BASE_MS * Math.pow(3, attempt - 1) + Math.random() * 500;
      console.warn(`[collector][RETRY ${attempt}/${MAX_ATTEMPTS - 1}] ${e?.message ?? e} → sleep ${sleep | 0}ms`);
      await sleepMs(sleep);
    }
  }
  throw lastErr;
}

async function fetchOnce(env: Env): Promise<any> {
  const url = new URL(API_URL);
  url.searchParams.set("_", String(Math.floor(Date.now() / 1000)));

  const r = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "User-Agent": env.USER_AGENT,
      "Accept": "application/json",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    const err = new Error(`unexpected status ${r.status}: ${body.slice(0, 200)}`) as any;
    err.status = r.status;
    throw err;
  }
  return await r.json();
}

// ---------- parse ----------

type CsvRow = {
  timestamp: string;
  level: number;
  overallStr: string;
  smoothedStr: string;
};

function parsePayload(payload: any, fetchedAt: Date): CsvRow {
  const level = payload?.defcon_level;
  if (typeof level !== "number" || !Number.isInteger(level) || level < 1 || level > 5) {
    throw new Error(`defcon_level missing or out of range: ${JSON.stringify(level)}`);
  }
  const overall = coerceFloat(payload?.overall_index);
  const smoothed = coerceFloat(payload?.defcon_details?.smoothed_index);
  const ts = normalizeTimestamp(payload?.timestamp, fetchedAt);
  return {
    timestamp: ts,
    level,
    overallStr: fmtNum(overall),
    smoothedStr: fmtNum(smoothed),
  };
}

function coerceFloat(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function fmtNum(v: number | null): string {
  return v === null ? "" : v.toFixed(4);
}
function normalizeTimestamp(raw: any, fallback: Date): string {
  if (typeof raw === "string" && raw.length > 0) {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return isoUtcSeconds(d);
  }
  return isoUtcSeconds(fallback);
}
function isoUtcSeconds(d: Date): string {
  // "2026-06-09T05:07:53Z" (초 단위 UTC)
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------- GitHub Contents API helpers ----------

type ContentResult = { sha: string; text: string } | { sha: null; text: null };

async function ghGetFile(env: Env, path: string): Promise<ContentResult> {
  const r = await ghApi(env, `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`);
  if (r.status === 404) return { sha: null, text: null };
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}: ${await r.text()}`);
  const j: any = await r.json();
  // base64 → utf-8
  const text = b64Decode(String(j.content ?? "").replace(/\n/g, ""));
  return { sha: String(j.sha), text };
}

async function ghPutFile(env: Env, path: string, text: string, sha: string | null, message: string): Promise<string> {
  const body: any = {
    message,
    content: b64Encode(text),
    branch: env.GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;
  const r = await ghApi(env, `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (r.status === 409 || r.status === 422) {
    const err = new Error(`PUT conflict ${r.status}: ${await r.text()}`) as any;
    err.status = r.status;
    err.conflict = true;
    throw err;
  }
  if (!r.ok) throw new Error(`PUT ${path} → ${r.status}: ${await r.text()}`);
  const j: any = await r.json();
  return String(j.content?.sha ?? "");
}

async function ghApi(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "doughcon-collector-worker",
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

// 409/422 충돌(다른 commit 이 사이에 들어옴) 시 한 번 재시도. collect.yml workflow_dispatch
// 가 동시에 도는 경우 등을 흡수.
async function withConflictRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e?.conflict) {
      console.warn(`[collector] conflict detected, retrying once after 1s ...`);
      await sleepMs(1000);
      return await fn();
    }
    throw e;
  }
}

// ---------- CSV append ----------

async function safeAppendCsv(env: Env, row: CsvRow): Promise<{ appended: boolean; sha?: string; reason?: string }> {
  try {
    return await withConflictRetry(async () => {
      const cur = await ghGetFile(env, env.CSV_PATH);
      const oldText = cur.text ?? CSV_HEADER;

      // 중복 timestamp 가드 (마지막 50줄만 확인)
      if (hasTimestampInTail(oldText, row.timestamp, 50)) {
        return { appended: false, reason: "duplicate" };
      }

      // 헤더 없으면 prepend (안전망)
      const base = oldText.startsWith("timestamp,") ? oldText : CSV_HEADER + oldText;
      const newLine = `${row.timestamp},${row.level},${row.overallStr},${row.smoothedStr}\n`;
      const newText = base.endsWith("\n") ? base + newLine : base + "\n" + newLine;

      const sha = await ghPutFile(
        env,
        env.CSV_PATH,
        newText,
        cur.sha,
        `chore(data): collect doughcon @ ${row.timestamp} [worker]`,
      );
      return { appended: true, sha };
    });
  } catch (e: any) {
    return { appended: false, reason: String(e?.message ?? e) };
  }
}

function hasTimestampInTail(text: string, ts: string, tailLines: number): boolean {
  const lines = text.split("\n");
  const start = Math.max(0, lines.length - tailLines);
  for (let i = start; i < lines.length; i++) {
    if (lines[i].startsWith(ts + ",")) return true;
  }
  return false;
}

// ---------- JSONL backup append ----------

async function safeAppendJsonl(env: Env, payload: any, fetchedAt: Date): Promise<{ appended: boolean; sha?: string; path?: string }> {
  try {
    const month = fetchedAt.toISOString().slice(0, 7); // YYYY-MM
    const path = `${env.JSONL_DIR}/${month}.jsonl`;
    return await withConflictRetry(async () => {
      const cur = await ghGetFile(env, path);
      const oldText = cur.text ?? "";

      // 슬림화 (collector.py 의 BACKUP_DROP_KEYS 와 동일)
      const slim: Record<string, any> = {};
      const dropped: string[] = [];
      if (payload && typeof payload === "object") {
        for (const [k, v] of Object.entries(payload)) {
          if (BACKUP_DROP_KEYS.has(k)) dropped.push(k);
          else slim[k] = v;
        }
      }
      dropped.sort();

      const record = {
        fetched_at: isoUtcSeconds(fetchedAt),
        payload: slim,
        dropped,
      };
      const newLine = JSON.stringify(record) + "\n";
      const newText = (oldText.length === 0 || oldText.endsWith("\n")) ? oldText + newLine : oldText + "\n" + newLine;

      const sha = await ghPutFile(
        env,
        path,
        newText,
        cur.sha,
        `chore(data): raw json @ ${record.fetched_at} [worker]`,
      );
      return { appended: true, sha, path };
    });
  } catch (e: any) {
    console.warn(`[collector][WARN] jsonl backup failed: ${e?.message ?? e}`);
    return { appended: false };
  }
}

// ---------- base64 (utf-8 safe) ----------

function b64Encode(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}
function b64Decode(s: string): string {
  return decodeURIComponent(escape(atob(s)));
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
