/**
 * DOUGHCON Collector — Cloudflare Worker
 * =======================================
 *
 * GitHub Actions cron 의 신뢰성 문제(신규 레포 활성화 지연, 정시 부하 스킵 등)를
 * 우회하기 위해 Cloudflare Workers Cron Triggers 가 직접 30분마다 동작한다.
 * 커밋 수를 줄이기 위해 수집분은 KV 에 모아두고 하루 1번 1커밋으로 push 한다.
 *
 *  [7,37 * * * *] 수집
 *     pizzint.watch /api/dashboard-data fetch  (collector.py 와 동일 캐시 우회 3단)
 *       ↓ parse + 1~5 검증
 *     KV `row:<fetched_at>` 에 CSV 1행 + JSONL 1행 저장
 *
 *  [10 15 * * *] flush (= KST 00:10)
 *     KV 의 row:* 전부 → GitHub Git Data API 로 1커밋 (fast-forward, force 없음)
 *       - data/doughcon_raw.csv          ← 행 append (중복 timestamp 제외)
 *       - data/_raw_json/YYYY-MM.jsonl   ← 슬림 백업 append (BACKUP_DROP_KEYS 적용)
 *     커밋 성공 후에만 KV 삭제 → 실패하면 다음 날 다시 시도 (데이터 유실 없음)
 *
 * 모든 환경 값은 wrangler.toml [vars] 에서 주입. GITHUB_TOKEN 만 secret.
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
  /** 하루치 수집분 버퍼. wrangler.toml [[kv_namespaces]] binding */
  BUFFER: KVNamespace;
}

// collector.py 의 BACKUP_DROP_KEYS 와 동일. `data` 키 하나가 ~45KB 차지 → 50배 절약.
const BACKUP_DROP_KEYS = new Set(["data"]);

const API_URL = "https://www.pizzint.watch/api/dashboard-data";
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;

const CSV_HEADER = "timestamp,doughcon_level,overall_index,smoothed_index\n";
const FLUSH_CRON = "10 15 * * *"; // wrangler.toml 의 crons 와 같아야 함

// ---------- entrypoints ----------

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // ctx.waitUntil 로 비동기 작업이 끝까지 실행되도록 보장.
    ctx.waitUntil(event.cron === FLUSH_CRON ? flush(env) : runOnce(env, "scheduled"));
  },
  // 디버깅용: /__run 은 1회 수집(KV 저장), /__flush 는 즉시 GitHub 에 push.
  // 인증 없음 → 실행만 가능하고 둘 다 정상 동작을 앞당길 뿐이라 공격 표면 작음.
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/__run" || url.pathname === "/__flush") {
      const result = url.pathname === "/__run" ? await runOnce(env, "manual") : await flush(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return new Response(
      "DOUGHCON collector worker is alive.\nUse /__run to collect, /__flush to push buffered rows.\n",
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  },
};

// ---------- collect ----------

type Buffered = { ts: string; csvLine: string; jsonlLine: string; month: string };

type RunResult = {
  ok: boolean;
  trigger: string;
  fetchedAt: string;
  buffered?: string;
  error?: string;
};

async function runOnce(env: Env, trigger: string): Promise<RunResult> {
  const fetchedAt = new Date();
  const fetchedAtIso = isoUtcSeconds(fetchedAt);
  console.log(`[collector][${trigger}] fetch start at ${fetchedAt.toISOString()}`);

  try {
    const payload = await fetchDoughcon(env);
    const row = parsePayload(payload, fetchedAt);
    const item: Buffered = {
      ts: row.timestamp,
      csvLine: `${row.timestamp},${row.level},${row.overallStr},${row.smoothedStr}`,
      jsonlLine: slimRecord(payload, fetchedAt),
      month: fetchedAt.toISOString().slice(0, 7), // YYYY-MM
    };
    const key = `row:${fetchedAtIso}`;
    await env.BUFFER.put(key, JSON.stringify(item));
    console.log(`[collector][${trigger}] buffered ${key} ${item.csvLine}`);
    return { ok: true, trigger, fetchedAt: fetchedAtIso, buffered: key };
  } catch (e: any) {
    const err = String(e?.message ?? e);
    console.error(`[collector][ERROR] ${err}`);
    return { ok: false, trigger, fetchedAt: fetchedAtIso, error: err };
  }
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

function slimRecord(payload: any, fetchedAt: Date): string {
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
  return JSON.stringify({ fetched_at: isoUtcSeconds(fetchedAt), payload: slim, dropped });
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

// ---------- flush: KV → GitHub 1커밋 ----------

type FlushResult = { ok: boolean; rows: number; csvAppended?: number; sha?: string; error?: string };

async function flush(env: Env): Promise<FlushResult> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BUFFER.list({ prefix: "row:", cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  if (keys.length === 0) return { ok: true, rows: 0 };

  keys.sort(); // row:<ISO> 라서 사전순 = 시간순
  const items: Buffered[] = [];
  for (const k of keys) {
    const v = await env.BUFFER.get(k);
    if (v) items.push(JSON.parse(v));
  }

  try {
    // ref 가 사이에 움직이면 (사람 push 등) fast-forward 실패 → 한 번 더 시도.
    let res: { sha: string; csvAppended: number };
    try {
      res = await commitItems(env, items);
    } catch (e: any) {
      if (e?.status !== 422) throw e;
      console.warn(`[collector] ref moved during flush, retrying once ...`);
      res = await commitItems(env, items);
    }
    // 커밋이 끝난 뒤에만 지운다. 삭제가 중간에 실패해도 다음 flush 의 중복 가드가 걸러냄.
    for (const k of keys) await env.BUFFER.delete(k);
    console.log(`[collector][flush] rows=${items.length} csv+=${res.csvAppended} sha=${res.sha}`);
    return { ok: true, rows: items.length, ...res };
  } catch (e: any) {
    const err = String(e?.message ?? e);
    console.error(`[collector][ERROR] flush failed (KV kept for next flush): ${err}`);
    return { ok: false, rows: items.length, error: err };
  }
}

async function commitItems(env: Env, items: Buffered[]): Promise<{ sha: string; csvAppended: number }> {
  const repo = `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  const ref: any = await ghJson(env, `${repo}/git/ref/heads/${env.GITHUB_BRANCH}`);
  const headSha: string = ref.object.sha;
  const head: any = await ghJson(env, `${repo}/git/commits/${headSha}`);

  // CSV
  let csv = (await ghRaw(env, `${repo}/contents/${env.CSV_PATH}?ref=${headSha}`)) ?? CSV_HEADER;
  if (!csv.startsWith("timestamp,")) csv = CSV_HEADER + csv; // 헤더 없으면 prepend (안전망)
  const tail = new Set(csv.split("\n").slice(-200).map((l) => l.split(",")[0]));
  let csvAppended = 0;
  for (const it of items) {
    if (tail.has(it.ts)) continue; // 중복 timestamp 가드
    tail.add(it.ts);
    csv = appendLine(csv, it.csvLine);
    csvAppended++;
  }
  const tree: any[] = [];
  if (csvAppended > 0) tree.push({ path: env.CSV_PATH, mode: "100644", type: "blob", content: csv });

  // JSONL (월 경계에 걸치면 파일 2개)
  for (const month of [...new Set(items.map((it) => it.month))]) {
    const path = `${env.JSONL_DIR}/${month}.jsonl`;
    let text = (await ghRaw(env, `${repo}/contents/${path}?ref=${headSha}`)) ?? "";
    const before = text;
    for (const it of items) {
      if (it.month !== month) continue;
      const prefix = it.jsonlLine.slice(0, it.jsonlLine.indexOf(',"payload"'));
      if (!text.includes(prefix)) text = appendLine(text, it.jsonlLine); // 같은 fetched_at 중복 가드
    }
    if (text !== before) tree.push({ path, mode: "100644", type: "blob", content: text });
  }
  if (tree.length === 0) return { sha: headSha, csvAppended: 0 };

  const day = new Date(Date.now() + 9 * 3600_000 - 86400_000).toISOString().slice(0, 10); // 어제(KST)
  const newTree: any = await ghJson(env, `${repo}/git/trees`, "POST", { base_tree: head.tree.sha, tree });
  const commit: any = await ghJson(env, `${repo}/git/commits`, "POST", {
    message: `chore(data): daily collect ${day} (${items.length} rows) [worker]`,
    tree: newTree.sha,
    parents: [headSha],
  });
  await ghJson(env, `${repo}/git/refs/heads/${env.GITHUB_BRANCH}`, "PATCH", { sha: commit.sha, force: false });
  return { sha: commit.sha, csvAppended };
}

function appendLine(text: string, line: string): string {
  return (text.length === 0 || text.endsWith("\n") ? text : text + "\n") + line + "\n";
}

// ---------- GitHub API helpers ----------

async function ghJson(env: Env, path: string, method = "GET", body?: unknown): Promise<unknown> {
  const r = await ghApi(env, path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) {
    const err = new Error(`${method} ${path} → ${r.status}: ${(await r.text()).slice(0, 300)}`) as any;
    err.status = r.status;
    throw err;
  }
  return await r.json();
}

// Contents API 의 JSON 응답은 1MB 넘는 파일의 content 를 빈 값으로 준다 → 그대로 쓰면
// 파일을 1줄로 덮어쓰는 사고. raw 미디어 타입은 100MB 까지 본문을 준다.
async function ghRaw(env: Env, path: string): Promise<string | null> {
  const r = await ghApi(env, path, { headers: { "Accept": "application/vnd.github.raw" } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return await r.text();
}

async function ghApi(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  if (!env.GITHUB_TOKEN?.trim()) {
    throw new Error(
      "GITHUB_TOKEN secret is missing. Run: npx wrangler secret put GITHUB_TOKEN " +
      "(name must be exactly GITHUB_TOKEN, then paste PAT as the value when prompted)",
    );
  }
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

function sleepMs(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
