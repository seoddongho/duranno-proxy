// api/qt.js
// Duranno QT Proxy: UTF-8/EUC-KR 자동 디코딩 + 본문(.bible)만 추출
// 예비 케이스에서는 오늘의 찬송(.song) 등 잡영 제거 후 p.title/table만 남겨 반환

import iconv from "iconv-lite";
import * as cheerio from "cheerio";

/* ---------- charset sniff / decode ---------- */
function sniffCharset(contentType = "", headSnippet = "") {
  const ct = /charset\s*=\s*([^;]+)/i.exec(contentType || "");
  if (ct) return ct[1].trim().toLowerCase();
  const meta = headSnippet.match(/charset=["']?\s*([\w-]+)\s*["']?/i);
  if (meta) return meta[1].trim().toLowerCase();
  return "";
}
function decodeBuffer(ab, guess = "") {
  const buf = Buffer.from(ab);
  const g = (guess || "").toLowerCase();
  const isUtf8 = g === "utf-8" || g === "utf8";
  const isKr =
    g === "euc-kr" ||
    g === "ks_c_5601-1987" ||
    g === "ks_c_5601" ||
    g === "x-windows-949" ||
    g === "cp949";

  if (isUtf8) return new TextDecoder("utf-8", { fatal: false }).decode(ab);
  if (isKr) return iconv.decode(buf, "cp949");

  let utf = "";
  try { utf = new TextDecoder("utf-8", { fatal: false }).decode(ab); } catch {}
  if (!utf) return iconv.decode(buf, "cp949");
  const looksBroken = /�/.test(utf) || /\u0000/.test(utf) || (utf.match(/�/g)||[]).length>5;
  return looksBroken ? iconv.decode(buf, "cp949") : utf;
}

/* ---------- meta parse ---------- */
function parseHeader($) {
  const h1 = $("h1").first();
  const spanText = h1.find("span").first().text().trim();   // 예: "에스겔 22 : 17~31"
  const emText   = h1.find("em").first().text().trim();     // 예: "무너진 곳을 막아설 한 사람을 찾습니다"
  const raw      = spanText || h1.text().trim();

  let book = "", range = "";
  if (raw) {
    const cleaned = raw
      .replace(/\s+/g, " ")
      .replace(/\s*:\s*/g, ":")
      .replace(/\s*~\s*/g, "–")
      .trim();
    const m = cleaned.match(/^([가-힣A-Za-z·\s]+)\s+(\d+\s*:\s*\d+(?:[–-]\d+)?)$/);
    if (m) { book = m[1].trim(); range = m[2].replace(/\s+/g,"").replace(/-/g,"–"); }
    else   { book = cleaned; }
  }
  const title = [spanText || (book + (range ? ` ${range}` : "")), emText].filter(Boolean).join(" — ");
  return { book, range, subtitle: emText || "", title: title || raw || "" };
}

/* ---------- sanitize helpers ---------- */
const JUNK_SEL = [
  ".song",              // 오늘의 찬송
  ".helper",            // 묵상 도우미
  ".amen",              // 아멘 영역
  ".copyright",
  ".btn-area",
  ".bible-st",         // 역본 선택 버튼 바
  ".font-size > .song",// 특정 구조 대비
].join(",");

function keepOnlyVerses($root) {
  // p.title + table 만 남기고 나머지는 제거
  const $ = $root.cheerio || cheerio;
  const container = $("<div/>");
  const titles = $root.find("p.title");
  const tables = $root.find("table");
  // 순서를 유지하려면 원래 노드 순회
  const nodes = $root.find("p.title, table").toArray();
  nodes.forEach(n => container.append($(n)));
  return container.prop("outerHTML");
}

/* ---------- main extractor ---------- */
function extractCleanFragment(html) {
  const $ = cheerio.load(html, { decodeEntities:false });
  const meta = parseHeader($);

  // 1) .bible 우선
  const bible = $(".bible").first();
  if (bible.length) {
    return { meta, fragment: keepOnlyVerses(bible) };
  }

  // 2) 후보 컨테이너 중 점수 상위 하나 선택 후 잡영 제거 → verses만 남김
  const candidates = [];
  $("main, article, section, div, body").each((_, el) => {
    const node = $(el);
    const score = node.find("table").length * 2 + node.find("p.title").length;
    if (score >= 3) candidates.push({ node, score });
  });
  candidates.sort((a,b) => b.score - a.score);

  if (candidates.length) {
    const node = candidates[0].node.clone();
    node.find(JUNK_SEL).remove();                    // 찬송/도우미 등 제거
    return { meta, fragment: keepOnlyVerses(node) }; // p.title + table만
  }

  return { meta, fragment: "" };
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  try {
    const { date, d = "k" } = req.query || {};
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "invalid date. expected YYYY-MM-DD" });
      return;
    }
    const ver = d === "w" ? "w" : "k";
    const url = `https://www.duranno.com/qt/view/bible.asp?qtDate=${encodeURIComponent(date)}&d=${ver}`;

    const resp = await fetch(url, {
      headers: {
        "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        "Accept-Language":"ko,ko-KR;q=0.9,en;q=0.8",
        "Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect:"follow",
    });

    const ab = await resp.arrayBuffer();
    const head = Buffer.from(ab).slice(0,4096).toString("binary");
    const charset = sniffCharset(resp.headers.get("content-type")||"", head);
    const html = decodeBuffer(ab, charset);

    const { meta, fragment } = extractCleanFragment(html);
    if (!fragment) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.status(502).json({ error:"bible fragment not found", source:url });
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=600");
    res.status(200).json({
      date, version: ver,
      ...meta,         // book, range, subtitle, title
      html: fragment,  // p.title + table만
      source: url
    });
  } catch (err) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(500).json({ error:String(err?.message||err) });
  }
}
