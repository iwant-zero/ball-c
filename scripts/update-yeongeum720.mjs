/**
 * 연금복권720+ (win720) 회차별 당첨번호 수집 → data/yeongeum720_winners.json 갱신
 *
 * ✅ 변경점(중요):
 * - 최신 회차를 메인(common.do?method=main)의 #drwNo720에서 찾지 않고,
 *   /pt720/result 페이지의 "NNN회" 목록에서 max 회차로 판별 (더 안정적)
 *   (메인 페이지는 동적 로딩/구조 변경으로 drwNo720가 없을 수 있음)
 */

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DATA_PATH = path.join(ROOT, "data", "yeongeum720_winners.json");

const URL_PT720_RESULT = "https://www.dhlottery.co.kr/pt720/result";
const URL_MAIN_OLD = "https://www.dhlottery.co.kr/common.do?method=main"; // (구버전 fallback)
const URL_WIN720 = "https://www.dhlottery.co.kr/gameResult.do?method=win720";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function looksBlocked(html) {
  // 동행복권이 트래픽/봇 차단 시 내보내는 문구들
  const signs = [
    "서비스 접근 대기",
    "서비스 접속이 차단",
    "현재 접속하신 아이피에서는 접속이 불가능",
    "접속량이 많아 접속이 불가능",
    "잠시만 기다리시면 자동 접속",
  ];
  return signs.some((s) => html.includes(s));
}

async function fetchText(url, options = {}, retries = 5) {
  let lastErr = null;

  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        ...options,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          ...(options.headers || {}),
        },
      });

      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const html = await res.text();

      if (looksBlocked(html)) {
        throw new Error(
          `동행복권 차단/대기 페이지 감지됨: ${url}\n(깃허브 러너 IP가 차단될 수 있음)`
        );
      }

      return html;
    } catch (e) {
      lastErr = e;
      // 지수 백오프
      await sleep(600 * (i + 1) * (i + 1));
    }
  }

  throw lastErr;
}

function parseLatestRoundFromPt720Result(html) {
  // 페이지에 "303회 302회 ... 1회"가 들어있음 → max가 최신
  const matches = [...html.matchAll(/(\d+)\s*회/g)].map((m) => Number(m[1]));
  const latest = Math.max(...matches);

  if (!Number.isFinite(latest) || latest <= 0) {
    throw new Error("최신 회차(/pt720/result) 파싱 실패");
  }
  return latest;
}

function parseLatestRoundFromMainOld(html) {
  // 과거 방식(혹시 남아있을 때만 fallback)
  const m = html.match(/id=["']drwNo720["']\s*>\s*(\d+)\s*</i);
  if (!m) throw new Error("최신 회차(#drwNo720) 파싱 실패");
  return Number(m[1]);
}

async function getLatestRound() {
  // 1) 추천: pt720/result
  try {
    const html = await fetchText(URL_PT720_RESULT);
    return parseLatestRoundFromPt720Result(html);
  } catch (e) {
    console.warn("[win720] pt720/result latest parse failed:", e?.message || e);
  }

  // 2) fallback: 구 메인 페이지 drwNo720
  try {
    const html = await fetchText(URL_MAIN_OLD);
    return parseLatestRoundFromMainOld(html);
  } catch (e) {
    console.warn("[win720] main(old) latest parse failed:", e?.message || e);
  }

  throw new Error(
    "최신 회차를 판별할 수 없습니다. (pt720/result / main 모두 파싱 실패)"
  );
}

function parseRoundHtml(round, html) {
  // 추첨일: (2026년 02월 19일 추첨) 같은 패턴
  const dm = html.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*추첨/i);
  const date = dm
    ? `${dm[1]}-${String(dm[2]).padStart(2, "0")}-${String(dm[3]).padStart(
        2,
        "0"
      )}`
    : null;

  // 조(그룹) 파싱 강화: "3조" 같은 문자열을 먼저 찾고, 실패하면 기존 group 블록 정규식 시도
  let group = null;

  // 1) "n조" 직접 매칭(너무 많이 잡지 않도록 '1등' 근처를 약간만 잘라서 검색)
  const aroundFirst = html.slice(0, Math.min(html.length, 20000)); // 상단 영역에 보통 결과 있음
  const gm1 = aroundFirst.match(/(\d)\s*조/);
  if (gm1) group = Number(gm1[1]);

  // 2) 기존 group 블록 패턴들
  if (!Number.isFinite(group)) {
    const gm =
      html.match(/class=["']group["'][\s\S]*?<span[^>]*>\s*<span>\s*(\d+)\s*<\/span>/i) ||
      html.match(/class=["']group["'][\s\S]*?<span>\s*(\d+)\s*<\/span>/i);
    if (gm) group = Number(gm[1]);
  }

  if (!Number.isFinite(group)) {
    throw new Error(`${round}회: 조(group) 파싱 실패`);
  }

  // 자리별 숫자: al720_color1~6
  const digits = [];
  const bonusDigits = [];

  for (let i = 1; i <= 6; i++) {
    const re = new RegExp(
      `<span[^>]*class=["'][^"']*al720_color${i}[^"']*["'][^>]*>\\s*<span>\\s*(\\d)\\s*<\\/span>`,
      "gi"
    );
    const hits = [...html.matchAll(re)].map((m) => Number(m[1]));
    if (hits.length < 1) {
      throw new Error(`${round}회: al720_color${i} 숫자 파싱 실패`);
    }
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
  for (const d of draws) {
    if (d && Number.isFinite(d.round)) max = Math.max(max, d.round);
  }
  return max;
}

async function fetchRound(round) {
  // POST 방식 (Round=...)
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

  // round가 없을 때/비정상일 때의 키워드(최소한의 가드)
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

  console.log(
    `[win720] latestRound=${latestRound}, haveMax=${haveMax}, fetch=${start}..${latestRound}`
  );

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

    // 너무 빠르면 차단될 수 있어서 텀
    await sleep(350);
  }

  // 정렬/중복 제거(안전)
  const map = new Map();
  for (const d of json.draws) {
    if (!d || !Number.isFinite(d.round)) continue;
    map.set(d.round, d);
  }
  const dedup = [...map.values()].sort((a, b) => a.round - b.round);

  json.draws = dedup;
  json.updatedAt = new Date().toISOString();
  json.source = `${URL_WIN720} (POST: Round=...)`;

  await saveJson(json);
  console.log(`[win720] done. draws=${json.draws.length}`);
}

main().catch(async (e) => {
  console.error("[win720] FAILED:", e);

  try {
    await fs.writeFile(
      path.join(ROOT, "update-error.txt"),
      String(e?.stack || e),
      "utf-8"
    );
  } catch {}

  process.exit(1);
});
