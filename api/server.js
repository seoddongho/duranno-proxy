const express = require('express');
const got = require('got');
const cheerio = require('cheerio');
const dayjs = require('dayjs');
const cron = require('node-cron');

const app = express();
app.set('trust proxy', true);

// 간단 CORS (원하면 도메인 제한)
app.use((_, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

// Duranno URL 빌더
const buildUrls = (dateStr) => ([
  // 1순위: view2 + qtDate (YYYY-MM-DD)
  `https://www.duranno.com/qt/view2/bible.asp?qtDate=${dateStr}`,
  // 2순위: view + qtDate (일부 환경에서 동작)
  `https://www.duranno.com/qt/view/bible.asp?qtDate=${dateStr}`,
  // 3순위: 오늘 기본 페이지
  `https://www.duranno.com/qt/view/bible.asp`
]);

async function fetchDuranno(date = dayjs()) {
  const qtDate = dayjs(date).format('YYYY-MM-DD');
  const urls = buildUrls(qtDate);

  let html = null, finalUrl = null, lastErr = null;
  for (const url of urls) {
    try {
      const res = await got(url, {
        timeout: { request: 15000 },
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept-Language': 'ko,en;q=0.9'
        }
      });
      if (res.statusCode >= 200 && res.statusCode < 300 && res.body) {
        html = res.body; finalUrl = url; break;
      }
    } catch (e) { lastErr = e; }
  }
  if (!html) throw lastErr || new Error('Duranno 페이지 수신 실패');

  // ------- 파싱 -------
  const $ = cheerio.load(html);

  // 1) “오늘의 말씀” 섹션 찾기
  let sectionRoot = null;
  $('*:contains("오늘의 말씀")').each((_, el) => {
    const t = $(el).text().trim();
    if (t.includes('오늘의 말씀') && !sectionRoot) {
      sectionRoot = $(el).closest('section,article,div');
    }
  });
  if (!sectionRoot || sectionRoot.length === 0) sectionRoot = $('body');

  // 2) 책제목 장절 (상단 제목/레퍼런스)
  const refRegex = /([가-힣A-Za-z.\s]+)\s+(\d+)\s*:\s*(\d+)(?:[-~]\s*\d+)?/;
  let title = null;
  sectionRoot.find('h1,h2,h3,strong,em,p').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    const m = t.match(refRegex);
    if (m && !title) title = `${m[1].trim()} ${m[2]}:${m[3]}`;
  });

  // 3) 부제목 (레퍼런스 근처의 짧은 헤드라인)
  let subtitle = null;
  sectionRoot.find('h1,h2,h3,strong,em').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (title && t.includes(title)) return;
    if (t.includes('오늘의 말씀')) return;
    if (t.length <= 60 && !subtitle) subtitle = t;
  });

  // 4) 오늘의 말씀 본문
  let collecting = false;
  const verseParts = [];
  sectionRoot.find('*').each((_, el) => {
    const tag = (el.tagName || '').toLowerCase();
    const t = $(el).text().trim();
    if (t.includes('오늘의 말씀')) { collecting = true; return; }
    if (collecting) {
      if (['h1','h2','h3'].includes(tag) && t.length <= 60) { collecting = false; return; }
      if (['p','li','blockquote'].includes(tag)) {
        const s = t.replace(/\s+/g, ' ').trim();
        if (s && !s.includes('묵상') && !s.includes('요약')) verseParts.push(s);
      }
    }
  });
  if (verseParts.length === 0) {
    sectionRoot.find('p').slice(0, 8).each((_, el) => {
      const s = $(el).text().replace(/\s+/g, ' ').trim();
      if (s) verseParts.push(s);
    });
  }
  const verse = verseParts.join('\n\n');

  return {
    title: title || '본문 참조 미확인',
    subtitle: subtitle || '제목 미확인',
    verse,
    sourceUrl: finalUrl,
    qtDate
  };
}

// (선택) 캐시: 새벽 00:10 KST에 미리 받아두기
let cache = {};
cron.schedule('10 0 * * *', async () => {
  try { cache = await fetchDuranno(dayjs()); }
  catch (e) { console.error('캐시 실패:', e.message); }
}, { timezone: 'Asia/Seoul' });

// API: /api/qt/today.json  (qtDate=YYYY-MM-DD 쿼리로 임의 날짜도 지원)
app.get('/api/qt/today.json', async (req, res) => {
  try {
    const d = req.query.qtDate ? dayjs(req.query.qtDate) : dayjs();
    const todayKey = d.format('YYYY-MM-DD');
    if (!cache.qtDate || cache.qtDate !== todayKey) {
      cache = await fetchDuranno(d);
    }
    if (!cache.verse) return res.status(503).json({ error: '본문 파싱 실패' });
    res.json({
      title: cache.title,
      subtitle: cache.subtitle,
      verse: cache.verse,
      sourceUrl: cache.sourceUrl
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`QT proxy on http://localhost:${PORT}`));
