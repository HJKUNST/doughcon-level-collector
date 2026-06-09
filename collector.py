"""
DOUGHCON Collector
==================

Pentagon Pizza Index(DOUGHCON) 비공식 API를 30분 간격으로 호출하여
원시 데이터를 ``data/doughcon_raw.csv`` 에 append-only 로 누적한다.

기술기획서 §2(데이터 소스), §4.1(collector 명세), §7.3(스키마 변경 대응)을
구현한다. ``defcon_level`` 만 필수이고 나머지는 모두 optional 로 처리하여
비공식 API 스키마 변경에 대한 방어선을 둔다.

직접 실행도 가능하지만 운영상 호출 주체는 GitHub Actions 워크플로우다
(``.github/workflows/collect.yml``).
"""

from __future__ import annotations

import csv
import datetime as dt
import json
import os
import random
import sys
import time
from pathlib import Path
from typing import Optional

import requests


API_URL = "https://www.pizzint.watch/api/dashboard-data"

# 기획서 §2.3 캐시 우회: 봇 차단 회피용 Safari UA
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) "
    "Version/17.0 Safari/605.1.15"
)

# 기획서 §3.3 파일 구조
DATA_DIR = Path(__file__).resolve().parent / "data"
RAW_CSV = DATA_DIR / "doughcon_raw.csv"
# 스키마 변경/파싱 버그에 대비한 원본 JSON 백업 (월별 jsonl, append-only).
# 1행 ≈ 0.5KB, 하루 48행 ≈ 24KB, 한 달 ≈ 0.7MB 로 사이즈 부담 없음.
RAW_JSON_DIR = DATA_DIR / "_raw_json"

# CSV 스키마 (기획서 §4.1 출력 스키마)
CSV_HEADER = ["timestamp", "doughcon_level", "overall_index", "smoothed_index"]

REQUEST_TIMEOUT = 15  # seconds

# 일시적 네트워크/5xx 흡수용 재시도. 지수 백오프 + 약간의 jitter.
# GitHub Actions cron 한 슬롯이 30분 주기라 재시도가 실패해도 다음 슬롯에서 복구되지만,
# 30분 슬롯 손실 자체를 막는 것이 데이터 지속성에 가장 직접적이다.
MAX_ATTEMPTS = 3
BACKOFF_BASE_SECONDS = 1.0


class CollectError(RuntimeError):
    """Collector 단계에서 발생한 회복 불가능한 오류."""


def fetch_dashboard(now_ts: Optional[int] = None) -> dict:
    """pizzint.watch /api/dashboard-data 를 호출하여 JSON dict 를 반환한다.

    기획서 §2.3 의 캐시 우회 3단(URL cache buster, no-cache 헤더, 브라우저 UA)을
    모두 적용한다. 일시적 장애 흡수를 위해 최대 ``MAX_ATTEMPTS`` 회까지 지수
    백오프로 재시도한다. 4xx 는 재시도하지 않고 즉시 실패 (스키마/엔드포인트
    변경 가능성이 더 큼).
    """
    last_exc: Optional[Exception] = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return _fetch_once(now_ts=now_ts or int(time.time()))
        except CollectError as exc:
            last_exc = exc
            # 4xx 는 일시 장애가 아니므로 재시도 의미 없음.
            if isinstance(exc.__cause__, requests.HTTPError) and 400 <= exc.status_code < 500:
                raise
            # 마지막 시도였으면 그대로 전파.
            if attempt == MAX_ATTEMPTS:
                raise
            sleep_s = BACKOFF_BASE_SECONDS * (3 ** (attempt - 1)) + random.uniform(0, 0.5)
            print(
                f"[collector][RETRY {attempt}/{MAX_ATTEMPTS - 1}] {exc} → sleep {sleep_s:.1f}s",
                file=sys.stderr,
                flush=True,
            )
            time.sleep(sleep_s)
    # 도달 불가지만 타입체커용.
    raise last_exc or CollectError("unknown fetch failure")


def _fetch_once(now_ts: int) -> dict:
    params = {"_": str(now_ts)}
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    }

    try:
        resp = requests.get(
            API_URL,
            params=params,
            headers=headers,
            timeout=REQUEST_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise CollectError(f"network error: {exc}") from exc

    if resp.status_code != 200:
        # status code 를 외부에서 보고 4xx/5xx 분기할 수 있도록 attribute 로 노출.
        err = CollectError(
            f"unexpected status {resp.status_code}: {resp.text[:200]!r}"
        )
        err.status_code = resp.status_code  # type: ignore[attr-defined]
        try:
            resp.raise_for_status()
        except requests.HTTPError as http_exc:
            err.__cause__ = http_exc
        raise err

    try:
        return resp.json()
    except ValueError as exc:
        raise CollectError(f"invalid JSON body: {exc}") from exc


# 백업에서 제외할 무거운 필드. 현 실측상 `data` 키 하나가 응답의 ~98% (~45KB) 를
# 차지한다(매장/시계열 raw points 추정). 분석에는 집계값으로 충분하므로 제외해야
# 1년 720MB → 14MB 로 50배 절약된다. 새 무거운 필드가 추가될 경우 여기에 추가.
BACKUP_DROP_KEYS = frozenset({"data"})


def backup_raw_json(payload: dict, fetched_at: dt.datetime, base_dir: Path = RAW_JSON_DIR) -> Path:
    """원본 응답(슬림화) 을 월별 jsonl 파일에 한 줄 append.

    스키마가 바뀌거나 parse 단계에서 데이터를 손실시킨 버그가 발견됐을 때
    raw 에서 재구축할 수 있는 보험. ``BACKUP_DROP_KEYS`` 에 정의된 무거운
    필드는 제외하여 git 레포 비대화를 막는다.

    한 줄에 다음을 기록한다:
        fetched_at  : 클라이언트(GitHub Actions runner) 수집 시각
        payload     : 서버 응답(무거운 필드 제외, top-level 만 필터)
        dropped     : 제외된 키 목록 (스키마 변경 추적용)
    """
    base_dir.mkdir(parents=True, exist_ok=True)
    month = fetched_at.strftime("%Y-%m")
    out = base_dir / f"{month}.jsonl"

    if isinstance(payload, dict):
        slim = {k: v for k, v in payload.items() if k not in BACKUP_DROP_KEYS}
        dropped = sorted(set(payload.keys()) & BACKUP_DROP_KEYS)
    else:
        slim = payload
        dropped = []

    record = {
        "fetched_at": fetched_at.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "payload": slim,
        "dropped": dropped,
    }
    with out.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    return out


def parse_payload(payload: dict, fetched_at: dt.datetime) -> dict:
    """API 응답을 CSV 한 행 dict 로 정규화한다.

    필수: ``defcon_level`` 이 정수 1~5 범위. 나머지는 결측 허용.
    """
    level = payload.get("defcon_level")
    if not isinstance(level, int) or not (1 <= level <= 5):
        raise CollectError(
            f"defcon_level missing or out of range: {level!r}"
        )

    overall_index = _coerce_float(payload.get("overall_index"))

    smoothed_index: Optional[float] = None
    details = payload.get("defcon_details")
    if isinstance(details, dict):
        smoothed_index = _coerce_float(details.get("smoothed_index"))

    # API timestamp 가 있으면 우선 사용, 없으면 수집 시각으로 fallback.
    # 어느 쪽이든 ISO 8601 (UTC, 초 단위) 로 정규화한다.
    api_ts_raw = payload.get("timestamp")
    timestamp_iso = _normalize_timestamp(api_ts_raw, fallback=fetched_at)

    return {
        "timestamp": timestamp_iso,
        "doughcon_level": level,
        "overall_index": _format_number(overall_index),
        "smoothed_index": _format_number(smoothed_index),
    }


def append_row(row: dict, csv_path: Path = RAW_CSV) -> bool:
    """CSV 에 한 행 append. 파일이 없으면 헤더와 함께 새로 만든다.

    Returns:
        새로 append 된 경우 True, 동일 timestamp 가 이미 있어 중복 스킵된 경우 False.
    """
    csv_path.parent.mkdir(parents=True, exist_ok=True)

    is_new = not csv_path.exists()

    if not is_new and _has_timestamp(csv_path, row["timestamp"]):
        # 같은 timestamp 가 이미 적재되어 있으면 중복 행을 피한다.
        # (워크플로우가 재시도되거나 API 가 같은 timestamp 를 반환할 때 방어)
        return False

    with csv_path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_HEADER)
        if is_new:
            writer.writeheader()
        writer.writerow(row)
    return True


def _coerce_float(value) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _format_number(value: Optional[float]) -> str:
    """CSV 직렬화: None → "" (빈 셀), float → 소수 4자리."""
    if value is None:
        return ""
    return f"{value:.4f}"


def _normalize_timestamp(raw, *, fallback: dt.datetime) -> str:
    """API 가 주는 timestamp 를 신뢰하되, 결측/파싱 실패 시 fallback 사용.

    출력은 UTC 기준 ISO 8601 (e.g. "2026-06-09T01:30:00Z").
    """
    parsed: Optional[dt.datetime] = None
    if isinstance(raw, str) and raw:
        try:
            # Z 접미사를 +00:00 로 치환해서 fromisoformat 호환되게.
            parsed = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            parsed = None

    target = parsed or fallback
    if target.tzinfo is None:
        target = target.replace(tzinfo=dt.timezone.utc)
    else:
        target = target.astimezone(dt.timezone.utc)

    return target.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _has_timestamp(csv_path: Path, timestamp: str) -> bool:
    """CSV 마지막 ~50 행만 확인하여 동일 timestamp 존재 여부를 본다.

    전체 스캔하지 않아도 30분 간격 누적 + GitHub Actions 재실행 패턴에서는 충분하다.
    """
    try:
        with csv_path.open("r", encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return False

    tail = lines[-50:]
    return any(line.startswith(timestamp + ",") for line in tail)


def main() -> int:
    fetched_at = dt.datetime.now(dt.timezone.utc)
    print(f"[collector] fetch start at {fetched_at.isoformat()}", flush=True)

    try:
        payload = fetch_dashboard(now_ts=int(fetched_at.timestamp()))
    except CollectError as exc:
        print(f"[collector][ERROR] fetch failed: {exc}", file=sys.stderr, flush=True)
        return 1

    # 백업은 parse 실패와 무관하게 우선 보관 (스키마 변경 시 사후 복원용).
    try:
        backup_path = backup_raw_json(payload, fetched_at=fetched_at)
        print(f"[collector] raw json → {backup_path.name}", flush=True)
    except OSError as exc:
        # 백업 실패는 수집 자체를 막지 않는다.
        print(f"[collector][WARN] raw json backup failed: {exc}", file=sys.stderr, flush=True)

    try:
        row = parse_payload(payload, fetched_at=fetched_at)
    except CollectError as exc:
        print(f"[collector][ERROR] parse failed: {exc}", file=sys.stderr, flush=True)
        return 1

    appended = append_row(row)
    status = "APPENDED" if appended else "SKIPPED (duplicate timestamp)"
    print(
        f"[collector][{status}] ts={row['timestamp']} level={row['doughcon_level']} "
        f"overall={row['overall_index']!r} smoothed={row['smoothed_index']!r}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
