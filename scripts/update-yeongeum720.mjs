/**
 * 연금복권720+ (win720) 회차별 당첨번호 수집 → data/yeongeum720_winners.json 갱신
 * - 최신 회차: https://dhlottery.co.kr/common.do?method=main 에서 #drwNo720 파싱 :contentReference[oaicite:4]{index=4}
 * - 회차별 결과: https://dhlottery.co.kr/gameResult.do?method=win720 로 Round를 넘겨 조회(POST/GET) :contentReference[oaicite:5]{index=5}
 */

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DATA_PATH = path.join(ROOT, "data", "yeongeum720_winners.json");

const URL_MAIN = "https://dhlottery.co.kr/common.do?method=main";
const URL_WIN720 = "https://dhlottery.co.kr/gameResult.do?method=win720";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, options = {}, retries = 4) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        ...options,
        headers: {
          "User-Agent": "Mozilla/5.0 (GitHub Actions) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          ...(options.headers || {}),
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      // 지수 백오프
      await sleep(700 * (i + 1) * (i + 1));
    }
  }
  throw lastErr;
}

function parseLatestRoundFromMain(html) {
  const m = html.match(/id=["']drwNo720["']\s*>\s*(\d+)\s*</i);
  if (!m) throw new Error("최신 회차(#drwNo720) 파싱 실패");
  return Number(m[1]);
}

function parseRoundHtml(round, html) {
  // 추첨일: (2026년 02월 19일 추첨) 같은 패턴
  const dm = html.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*추첨/i);
  const date = dm ? `${dm[1]}-${String(dm[2]).padStart(2,"0")}-${String(dm[3]).padStart(2,"0")}` : null;

  // 조(그룹): class="group" 영역 안의 첫 숫자
  const gm = html.match(/class=["']group["'][\s\S]*?<span[^>]*>\s*<span>\s*(\d+)\s*<\/span>/i)
          || html.match(/class=["']group["'][\s\S]*?<span>\s*(\d+)\s*<\/span>/i);
  if (!gm) throw new Error(`${round}회: 조(group) 파싱 실패`);
  const group = Number(gm[1]);

  // 자리별 숫자: al720_color1~6가 회차 페이지에 각각 "1등/보너스" 두 번씩 등장하는 구조를 이용
  const digits = [];
  const bonusDigits = [];

  for (let i = 1; i <= 6; i++) {
    const re = new RegExp(
      `<span[^>]*class=["'][^"']*al720_color${i}[^"']*["'][^>]*>\\s*<span>\\s*(\\d)\\s*<\\/span>`,
      "gi"
    );
    const hits = [...html.matchAll(re)].map(m => Number(m[1]));
    if (hits.length < 1) throw new Error(`${round}회: al720_color${i} 숫자 파싱 실패`);
    digits.push(hits[0]);
    bonusDigits.push(hits.length >= 2 ? hits[1] : null);
  }

  if (digits.length !== 6 || digits.some(x => !Number.isFinite(x))) {
    throw new Error(`${round}회: 1등 6자리 파싱 실패`);
  }

  return {
    round,
    date,
    group,
    digits,
    bonusDigits: bonusDigits.every(v => v !== null) ? bonusDigits : null
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
      draws: []
    };
  }
}

async function saveJson(json) {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(json, null, 2) + "\n", "utf-8");
}

async function fetchRound(round) {
  // POST 방식
  const body = new URLSearchParams({ Round: String(round) });
  const html = await fetchText(URL_WIN720, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  // 사이트가 과부하/차단 페이지를 리턴할 때가 있어 간단 체크
  if (/ERROR\s*404|페이지를 찾을 수 없습니다/i.test(html)) {
    throw new Error(`${round}회: 404/에러 페이지 감지`);
  }

  return parseRoundHtml(round, html);
}

function getMaxHaveRound(draws) {
  let max = 0;
  for (const d of draws) {
    if (d && Number.isFinite(d.round)) max = Math.max(max, d.round);
  }
  return max;
}

async function main() {
  const json = await loadJsonSafe();

  const mainHtml = await fetchText(URL_MAIN);
  const latestRound = parseLatestRoundFromMain(mainHtml);

  const haveMax = getMaxHaveRound(json.draws);
  const start = haveMax + 1;

  console.log(`[win720] latestRound=${latestRound}, haveMax=${haveMax}, fetch=${start}..${latestRound}`);

  if (start > latestRound) {
    json.updatedAt = new Date().toISOString();
    await saveJson(json);
    console.log("[win720] no new rounds. updatedAt refreshed.");
    return;
  }

  // 누락 회차만 가져오기
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
  const dedup = [...map.values()].sort((a,b)=> a.round - b.round);

  json.draws = dedup;
  json.updatedAt = new Date().toISOString();
  json.source = `${URL_WIN720} (POST: Round=...)`;

  await saveJson(json);
  console.log(`[win720] done. draws=${json.draws.length}`);
}

main().catch(async (e) => {
  console.error("[win720] FAILED:", e);
  // workflow에서 이 파일을 이슈 본문으로 쓸 수 있게 남김
  try{
    await fs.writeFile(path.join(ROOT, "update-error.txt"), String(e?.stack || e), "utf-8");
  }catch{}
  process.exit(1);
});
