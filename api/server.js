const express = require('express');
const got = require('got');
const cheerio = require('cheerio');
const cron = require('node-cron');
const dayjs = require('dayjs');
const tz = require('dayjs/plugin/timezone');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc); dayjs.extend(tz);
dayjs.tz.setDefault('Asia/Seoul');

const app = express();

// CORS 허용(원하면 도메인 제한 걸어도 됨)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// Duranno 오늘의말씀 URL 생성기 (영문 LivingLife는 OD=YYYY-MM-DD 파라미터가 확인됨)
const buildUrl = (d) => {
  const s = dayjs(d).format('YYYY-MM-DD');
  // 한국어 페이지도 OD 파라미터가 통하는 경우가 많아 우선 시도하고, 실패 시 기본 URL로 폴백
  return [
    `https://www.duranno.com/qt/view/bible.asp?OD=${s}`,
    `https://www.duranno.com/qt/view/bible.asp`
  ];
};

// 캐시(하루 1회 갱신)
let cache = {
  dateKey: null,   // 'YYYY-MM-DD'
  payload: null,   // 위 JSON
  fetchedAt: null
};

async function fetchAndParse(date = dayjs()) {
  const urls = buildUrl(date);
  let lastError = null, html = null, finalUrl = null;

  for (const url of urls) {
    try {
      const res = await got(url, {
        timeout: { request: 15000 },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
          'Accept-Language': 'ko,en;q=0.9'
        }
      });
      if (res.statusCode >= 200 && res.statusCode < 300 && res.body) {
        html = res.body;
        finalUrl = url;
        break;
      }
    } catch (e) {
      lastError = e;
    }
  }
  if (!html) throw lastError || new Error('Failed to fetch Duranno page.');

  const $ = cheerio.load(html);

  // --------- 파싱 로직(내구성 중심) ----------
  // 1) "오늘의 말씀" 섹션 루트 찾기
  //    - 텍스트가 "오늘의 말씀"인 요소를 찾고, 다음 형제/부모 영역의 본문을 긁어옴
  let sectionRoot = null;
  $('*:contains("오늘의 말씀")').each((_, el) => {
    const txt = $(el).text().trim();
    if (txt.includes('오늘의 말씀') && !sectionRoot) {
      // 본문은 보통 제목 요소의 다음 영역에 묶여 있음
      // 후보1: el의 부모 다음, 후보2: el 다음, 후보3: 섹션/아티클 조상
      sectionRoot = $(el).closest('section,article,div');
    }
  });
  if (!sectionRoot || sectionRoot.length === 0) sectionRoot = $('body');

  // 2) 책제목+장절(레퍼런스) 추출
  //    - 보통 상단 H 태그들에 "에스겔 21:1-17" 유사 문자열 존재
  const refRegex = /([가-힣A-Za-z.\s]+)\s+(\d+)\s*:\s*(\d+)(?:[-~]\s*\d+)?/;
  let title = null;
  sectionRoot.find('h1,h2,h3,strong,em,p').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    const m = t.match(refRegex);
    if (m && !title) title = `${m[1].trim()} ${m[2]}:${m[3]}`; // 간단화
  });

  // 3) 부제목 추출: "오늘의 말씀" 인근의 h2/h3/strong 줄에서 레퍼런스가 아닌 라인
  let subtitle = null;
  sectionRoot.find('h1,h2,h3,strong,em').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (title && t.includes(title)) return;
    if (t.includes('오늘의 말씀')) return;
    // 너무 긴 본문이 아니라 "표제"로 보이는 한두 줄
    if (t.length <= 60 && !subtitle) subtitle = t;
  });

  // 4) "오늘의 말씀" 본문 텍스트 모으기
  //    - "오늘의 말씀" 근처부터 다음 제목 전까지의 p/li 텍스트 집계
  let verseParts = [];
  let collecting = false;
  sectionRoot.find('*').each((_, el) => {
    const t = $(el).text().trim();
    const tag = (el.tagName || '').toLowerCase();
    if (t.includes('오늘의 말씀')) {
      collecting = true;
      return;
    }
    if (collecting) {
      // 다음 섹션 제목이 나오면 종료
      if (['h1','h2','h3'].includes(tag) && t.length <= 60) {
        collecting = false;
        return;
      }
      if (['p','li','blockquote'].includes(tag)) {
        const clean = t.replace(/\s+/g, ' ').trim();
        if (clean && !clean.includes('QT') && !clean.includes('묵상')) {
          verseParts.push(clean);
        }
      }
    }
  });

  // 폴백: "오늘의 말씀" 라벨을 못 찾았을 때, 본문으로 보이는 p 여러 개를 상단에서 수집
  if (verseParts.length === 0) {
    sectionRoot.find('p').slice(0, 8).each((_, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t) verseParts.push(t);
    });
  }

  const verse = verseParts.join('\n\n');

  // 최소 안전장치
  if (!title) title = '본문 참조 미확인';
  if (!subtitle) subtitle = '제목 미확인';
  if (!verse) throw new Error('본문(오늘의 말씀) 파싱 실패');

  return {
    title,
    subtitle,
    verse,
    sourceUrl: finalUrl
  };
}

// 첫 로드와 크론(매일 00:10 KST)
async function refresh() {
  const todayKey = dayjs().format('YYYY-MM-DD');
  try {
    const payload = await fetchAndParse(dayjs());
    cache = {
      dateKey: todayKey,
      payload,
      fetchedAt: new Date().toISOString()
    };
    console.log('[OK] QT cache updated:', todayKey);
  } catch (e) {
    console.error('[ERR] refresh failed:', e.message);
  }
}
cron.schedule('10 0 * * *', refresh, { timezone: 'Asia/Seoul' });

// 필요 시 수동 갱신
app.get('/api/qt/refresh', async (req, res) => {
  try {
    await refresh();
    res.json({ ok: true, refreshedAt: cache.fetchedAt, dateKey: cache.dateKey });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 오늘 JSON 제공 (요청 시 캐시 없으면 즉시 가져옴)
app.get('/api/qt/today.json', async (req, res) => {
  const todayKey = dayjs().format('YYYY-MM-DD');
  if (cache.dateKey !== todayKey || !cache.payload) {
    try { await refresh(); } catch (e) { /* 아래에서 에러 응답 */ }
  }
  if (!cache.payload) return res.status(503).json({ error: '현재 본문을 불러오지 못했습니다.' });
  res.json(cache.payload);
});

// 서버 기동
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Duranno QT proxy running on http://localhost:${PORT}`);
});
