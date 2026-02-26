/**
 * 연금복권720+ (win720) 회차별 당첨번호 수집 → data/yeongeum720_winners.json 갱신
 *
 * ✅ 이번 수정 핵심
 * - GitHub Actions 러너에서 node fetch(undici)가 DNS/IPv6 문제로 "fetch failed"가 날 수 있음
 *   → NODE_OPTIONS로 IPv4 우선 + 스크립트에서 curl(-4)로 폴백
 *   (러너 이슈/보고 사례 존재)
 *
 * - 최신 회차는 /pt720/result의 "NNN회" 목록에서 max로 판별 (메인 페이지 구조 변경 영향 최소)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = process.cwd();
const DATA_PATH = path.join(ROOT, "data", "yeongeum720_winners.json");

const URL_PT720_RESULT = "https://www.dhlottery.co.kr/pt720/result";
const URL_MAIN_OLD = "https://www.dhlottery.co.kr/common.do?method=main";
const URL_WIN720 = "https://www.dhlottery.co.kr/gameResult.do?method=win720";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function looksBlocked(html) {
  // 트래픽/봇 차단/대기 페이지 흔한 문구들
  const signs = [
    "서비스 접근 대기",
    "서비스 접속이 차단",
    "현재 접속하신 아이피에서는 접속이 불가능",
    "접속량이 많아 접속이 불가능",
    "잠시만 기다리시면 자동 접속",
    "접속대기",
  ];
  return signs.some((s) => html.includes(s));
}

function isFetchFailedError(e) {
  const msg = String(e?.message || e);
  // Node fetch(undici)에서 네트워크 문제면 흔히 "fetch failed"로 뭉뚱그려짐
  return msg.toLowerCase().includes("fetch failed");
}

async function fetchTextViaFetch(url, options = {}) {
  const res = await fetch(url, {
    redirect: "follow",
    ...options,
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const html = await res.text();
  if (looksBlocked(html)) {
    throw new Error(`동행복권 차단/대기 페이지 감지됨: ${url}\n(러너 IP가 차단될 수 있음)`);
  }
  return html;
}

function buildCurlArgs(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = options.headers || {};
  const args = [
    "-4", // ✅ IPv4 강제
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
    "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "-H",
    "Accept-Language: ko-KR,ko;q=0.9,en;q=0.8",
    "-H",
    "Cache-Control: no-cache",
    "-H",
    "Pragma: no-cache",
  ];

  // 추가 헤더 반영
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }

  if (method !== "GET") args.push("-X", method);

  // POST body 지원(URLSearchParams/string)
  if (options.body) {
    let bodyStr = "";
    if (typeof options.body === "string") bodyStr = options.body;
    else if (options.body instanceof URLSearchParams) bodyStr = options.body.toString();
    else bodyStr = String(options.body);
    args.push("--data-raw", bodyStr);
  }

  args.push(url);
  return args;
}

async function fetchTextViaCurl(url, options = {}) {
  try {
    const args = buildCurlArgs(url, options);
    const { stdout } = await execFileAsync("curl", args, {
      maxBuffer: 20 * 1024 * 1024,
    });
    if (looksBlocked(stdout)) {
      throw new Error(`동행복권 차단/대기 페이지 감지됨(curl): ${url}\n(러너 IP가 차단될 수 있음)`);
    }
    return stdout;
  } catch (e) {
    // curl이 없거나 실패한 경우
    const msg = String(e?.message || e);
    throw new Error(`curl 요청 실패: ${msg}`);
  }
}

async function fetchText(url, options = {}, retries = 4) {
  let lastErr = null;

  for (let i = 0; i < retries; i++) {
    try {
      // 1) node fetch 시도
      return await fetchTextViaFetch(url, options);
    } catch (e) {
      lastErr = e;

      // fetch failed면 curl 폴백
      if (isFetchFailedError(e)) {
        try {
          return await fetchTextViaCurl(url, options);
        } catch (e2) {
          lastErr = e2;
        }
      }

      // 백오프
      await sleep(700 * (i + 1) * (i + 1));
    }
  }

  throw lastErr;
}

function parseLatestRoundFromPt720Result(html) {
  // /pt720/result에는 "NNN회"가 목록/본문에 존재 → max가 최신
  const matches = [...html.matchAll(/(\d+)\s*회/g)].map((m) => Number(m[1]));
  const latest = Math.max(...matches);
  if (!Number.isFinite(latest) || latest <= 0) {
    throw new Error("최신 회차(/pt720/result) 파싱 실패");
  }
  return latest;
}

function parseLatestRoundFromMainOld(html) {
  const m = html.match(/id=["']drwNo720["']\s*>\s*(\d+)\s*</i);
  if (!m) throw new Error("최신 회차(#drwNo720) 파싱 실패");
  return Number(m[1]);
}

async function getLatestRound() {
  // 1) pt720/result 우선 (권장)
  try {
    const html = await fetchText(URL_PT720_RESULT);
    return parseLatestRoundFromPt720Result(html);
  } catch (e) {
    console.warn("[win720] pt720/result latest parse failed:", e?.message || e);
  }

  // 2) fallback: 메인(old)
  try {
    const html = await fetchText(URL_MAIN_OLD);
    return parseLatestRoundFromMainOld(html);
  } catch (e) {
    console.warn("[win720] main(old) latest parse failed:", e?.message || e);
  }

  throw new Error("최신 회차를 판별할 수 없습니다. (pt720/result / main 모두 파싱 실패)");
}

function parseRoundHtml(round, html) {
  // 추첨일
  const dm = html.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*추첨/i);
  const date = dm
    ? `${dm[1]}-${String(dm[2]).padStart(2, "0")}-${String(dm[3]).padStart(2, "0")}`
    : null;

  // 조(그룹)
  let group = null;

  // 1) 상단 일부에서 "n조" 우선 탐색
  const head = html.slice(0, Math.min(html.length, 25000));
  const gm1 = head.match(/(\d)\s*조/);
  if (gm1) group = Number(gm1[1]);

  // 2) 기존 group 블록 패턴
  if (!Number.isFinite(group)) {
    const gm =
      html.match(/class=["']group["'][\s\S]*?<span[^>]*>\s*<span>\s*(\d+)\s*<\/span>/i) ||
      html.match(/class=["']group["'][\s\S]*?<span>\s*(\d+)\s*<\/span>/i);
    if (gm) group = Number(gm[1]);
  }

  if (!Number.isFinite(group)) throw new Error(`${round}회: 조(group) 파싱 실패`);

  // 6자리: al720_color1~6
  const digits = [];
  const bonusDigits = [];

  for (let i = 1; i <= 6; i++) {
    const re = new RegExp(
      `<span[^>]*class=["'][^"']*al720_color${i}[^"']*["'][^>]*>\\s*<span>\\s*(\\d)\\s*<\\/span>`,
      "gi"
    );
    const hits = [...html.matchAll(re)].map((m) => Number(m[1]));
    if (hits.length < 1) throw new Error(`${round}회: al720_color${i} 숫자 파싱 실패`);
    digits.push(hits[0]);
    bonusDigits.push(hits.length >= 2 ? hits[1] : null);
  }

  return {
    round,
    date,
    group,
    digits,
    bonusDigits: bonusDigits.every((v) => v !== null) ? bonusDigits : null,
  };
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
      source: `${URL_WIN720} (POST: Round=...)`,
      draws: [],
    };
  }
}

async function saveJson(json) {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(json, null, 2) + "\n", "utf-8");
}

function getMaxHaveRound(draws) {
  let max = 0;
  for (const d of draws) if (d && Number.isFinite(d.round)) max = Math.max(max, d.round);
  return max;
}

async function fetchRound(round) {
  const body = new URLSearchParams({ Round: String(round) });

  const html = await fetchText(URL_WIN720, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://www.dhlottery.co.kr",
      Referer: URL_PT720_RESULT,
    },
    body,
  });

  if (/조회된\s*결과가\s*없습니다|잘못된\s*접근/i.test(html)) {
    throw new Error(`${round}회: 결과 없음(페이지 메시지 감지)`);
  }

  return parseRoundHtml(round, html);
}

async function main() {
  const json = await loadJsonSafe();

  const latestRound = await getLatestRound();
  const haveMax = getMaxHaveRound(json.draws);
  const start = haveMax + 1;

  console.log(`[win720] latestRound=${latestRound}, haveMax=${haveMax}, fetch=${start}..${latestRound}`);

  if (start > latestRound) {
    json.updatedAt = new Date().toISOString();
    await saveJson(json);
    console.log("[win720] no new rounds. updatedAt refreshed.");
    return;
  }

  for (let r = start; r <= latestRound; r++) {
    console.log(`[win720] fetching round ${r}...`);
    const item = await fetchRound(r);
    json.draws.push(item);
    await sleep(350);
  }

  // 중복 제거 + 정렬
  const map = new Map();
  for (const d of json.draws) if (d && Number.isFinite(d.round)) map.set(d.round, d);
  json.draws = [...map.values()].sort((a, b) => a.round - b.round);

  json.updatedAt = new Date().toISOString();
  json.source = `${URL_WIN720} (POST: Round=...)`;

  await saveJson(json);
  console.log(`[win720] done. draws=${json.draws.length}`);
}

main().catch(async (e) => {
  console.error("[win720] FAILED:", e);
  try {
    await fs.writeFile(path.join(ROOT, "update-error.txt"), String(e?.stack || e), "utf-8");
  } catch {}
  process.exit(1);
});
