/**
 * 연금복권720+ 회차별 당첨번호 JSON 생성기
 *
 * ✅ 동행복권(dhlottery) 사이트는 GitHub Actions 러너 IP에서 "접속대기/차단"이 자주 발생
 *    → 공식 사이트 직접 크롤링 대신, 회차별 당첨번호 표(미러)를 소스로 사용
 *
 * 출력: data/yeongeum720_winners.json
 * 형식: { updatedAt, source, draws:[{round,date,group,digits,bonusDigits}, ...] }
 */

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = process.cwd();
const DATA_PATH = path.join(ROOT, "data", "yeongeum720_winners.json");

// ✅ 미러 소스(회차별 표)
const SOURCE_URL = "https://signalfire85.tistory.com/277";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function looksBlocked(html) {
  // 사이트별 차단/캡차/대기 페이지 흔한 문구
  const signs = [
    "서비스 접근 대기",
    "서비스 접속이 차단",
    "접속이 불가능",
    "자동 접속",
    "captcha",
    "Cloudflare",
  ];
  const lower = String(html || "").toLowerCase();
  return signs.some((s) => lower.includes(s.toLowerCase()));
}

function isFetchFailedError(e) {
  const msg = String(e?.message || e).toLowerCase();
  return msg.includes("fetch failed") || msg.includes("network");
}

async function fetchTextViaFetch(url, options = {}) {
  const res = await fetch(url, {
    redirect: "follow",
    ...options,
    headers: {
      "User-Agent": UA,
      Accept: "text/html,*/*",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const html = await res.text();
  if (looksBlocked(html)) throw new Error(`차단/대기/캡차 감지: ${url}`);
  return html;
}

function buildCurlArgs(url) {
  return [
    "-4",
    "-L",
    "--fail",
    "--silent",
    "--show-error",
    "--compressed",
    "--retry",
    "6",
    "--retry-all-errors",
    "--connect-timeout",
    "20",
    "--max-time",
    "45",
    "-A",
    UA,
    "-H",
    "Accept: text/html,*/*",
    "-H",
    "Accept-Language: ko-KR,ko;q=0.9,en;q=0.8",
    "-H",
    "Cache-Control: no-cache",
    "-H",
    "Pragma: no-cache",
    url,
  ];
}

async function fetchTextViaCurl(url) {
  const { stdout } = await execFileAsync("curl", buildCurlArgs(url), {
    maxBuffer: 30 * 1024 * 1024,
  });
  if (looksBlocked(stdout)) throw new Error(`차단/대기/캡차 감지(curl): ${url}`);
  return stdout;
}

async function fetchText(url, retries = 4) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      return await fetchTextViaFetch(url);
    } catch (e) {
      lastErr = e;
      if (isFetchFailedError(e)) {
        try {
          return await fetchTextViaCurl(url);
        } catch (e2) {
          lastErr = e2;
        }
      }
      await sleep(700 * (i + 1) * (i + 1));
    }
  }
  throw lastErr;
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d|table|tbody|thead|section|article|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\r/g, "");
}

function dotDateToIso(dot) {
  // 2026.02.19 -> 2026-02-19
  const m = dot.match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function parseDrawsFromText(text) {
  // 예시 라인(본문 텍스트):
  // 303회 2026.02.19 1등 4 6 3 9 5 6 6 1
  // 보너스 각조 6 1 9 1 3 6 10

  const t = text;

  const firstRe =
    /(\d{1,4})\s*회\s+(\d{4}\.\d{2}\.\d{2})\s+1등\s+([0-9])\s+([0-9])\s+([0-9])\s+([0-9])\s+([0-9])\s+([0-9])\s+([0-9])(?:\s+(\d{1,3}))?/g;

  const bonusRe =
    /보너스\s*각조\s+([0-9])\s+([0-9])\s+([0-9])\s+([0-9])\s+([0-9])\s+([0-9])(?:\s+(\d{1,3}))?/g;

  const first = [];
  for (const m of t.matchAll(firstRe)) {
    first.push({
      idx: m.index ?? 0,
      round: Number(m[1]),
      date: dotDateToIso(m[2]) || m[2],
      group: Number(m[3]),
      digits: [m[4], m[5], m[6], m[7], m[8], m[9]].map((x) => Number(x)),
    });
  }

  const bonus = [];
  for (const m of t.matchAll(bonusRe)) {
    bonus.push({
      idx: m.index ?? 0,
      bonusDigits: [m[1], m[2], m[3], m[4], m[5], m[6]].map((x) => Number(x)),
    });
  }

  first.sort((a, b) => a.idx - b.idx);
  bonus.sort((a, b) => a.idx - b.idx);

  // 1등 구간마다 뒤따르는 보너스를 붙임(다음 1등 전까지의 첫 보너스)
  const draws = [];
  for (let i = 0; i < first.length; i++) {
    const cur = first[i];
    const nextIdx = i + 1 < first.length ? first[i + 1].idx : Infinity;

    const b = bonus.find((x) => x.idx > cur.idx && x.idx < nextIdx);
    draws.push({
      round: cur.round,
      date: cur.date,
      group: cur.group,
      digits: cur.digits,
      bonusDigits: b ? b.bonusDigits : null,
    });
  }

  // 중복 제거(라운드 기준)
  const map = new Map();
  for (const d of draws) map.set(d.round, d);
  return [...map.values()].sort((a, b) => a.round - b.round);
}

async function loadJsonSafe() {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf-8");
    const json = JSON.parse(raw);
    if (!json || !Array.isArray(json.draws)) throw new Error("형식 불일치");
    return json;
  } catch {
    return {
      game: "연금복권720+",
      updatedAt: null,
      source: SOURCE_URL,
      draws: [],
    };
  }
}

async function saveJson(json) {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(json, null, 2) + "\n", "utf-8");
}

async function main() {
  const prev = await loadJsonSafe();

  const html = await fetchText(SOURCE_URL);
  const text = htmlToText(html);

  const parsed = parseDrawsFromText(text);
  if (!parsed.length) {
    throw new Error("미러 소스에서 당첨번호를 파싱하지 못했습니다. (표 구조 변경 가능)");
  }

  // 기존 데이터와 병합(안전)
  const map = new Map();
  for (const d of prev.draws || []) map.set(d.round, d);
  for (const d of parsed) map.set(d.round, d);

  const draws = [...map.values()].sort((a, b) => a.round - b.round);

  const out = {
    game: "연금복권720+",
    updatedAt: new Date().toISOString(),
    source: SOURCE_URL,
    draws,
  };

  await saveJson(out);

  const latest = draws[draws.length - 1];
  console.log(`[win720] ok. draws=${draws.length}, latest=${latest.round}, date=${latest.date}`);
}

main().catch(async (e) => {
  console.error("[win720] FAILED:", e);
  try {
    await fs.writeFile(path.join(ROOT, "update-error.txt"), String(e?.stack || e), "utf-8");
  } catch {}
  process.exit(1);
});
