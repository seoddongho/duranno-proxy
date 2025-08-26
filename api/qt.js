// Duranno QT Proxy (Node.js 22.x)
// - EUC-KR/UTF-8 자동 디코딩
// - 본문(.bible)만 추출
// - 큰제목(책 + 범위), 소제목 분리

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

/* ---------- helpers ---------- */
const norm = (s="") => s.replace(/\u00A0/g," ").replace(/\s+/g," ").trim();

/** “에스겔 22:17–22” 같은 패턴 찾기 */
function findBookRange(s=""){
  s = norm(s);
  const m = s.match(/([가-힣A-Za-z·]+)\s+(\d+\s*:\s*\d+(?:\s*[~–-]\s*\d+)?)/);
  if (!m) return { book:"", range:"" };
  return {
    book: norm(m[1]),
    range: m[2].replace(/\s+/g,"").replace(/-/g,"–").replace("~","–")
  };
}

/* ---------- header/meta ---------- */
function parseHeader($) {
  // 본문 컨테이너 내부의 h1을 우선 사용
  let $h1 = $(".font-size h1").first();
  if (!$h1.length) $h1 = $("h1").first();

  const spanText = norm($h1.find("span").first().text());
  const emText   = norm($h1.find("em").first().text());
  const h1Text   = norm($h1.text());

  let { book, range } = findBookRange(spanText || h1Text);

  if (!book || !range) {
    const all = norm($(".font-size").first().text() || $("body").text());
    const br = findBookRange(all);
    if (br.book && br.range) { book = br.book; range = br.range; }
  }

  const title = [spanText || (book && range ? `${book} ${range}` : book || ""), emText]
    .filter(Boolean).join(" — ");

  return { book, range, subtitle: emText || "", title: title || h1Text || "" };
}

/* ---------- sanitize ---------- */
const JUNK_SEL = [
  ".song",".helper",".amen",".copyright",".btn-area",".bible-st"
].join(",");

function keepOnlyVerses($root) {
  const $ = $root.cheerio || cheerio;
  const out = $("<div/>");
  $root.find("p.title, table").each((_, el) => out.append($(el)));
  return out.prop("outerHTML");
}

/* ---------- extractor ---------- */
function extractCleanFragment(html) {
  const $ = cheerio.load(html, { decodeEntities:false });
  const meta = parseHeader($);

  const bible = $(".bible").first();
  if (bible.length) return { meta, fragment: keepOnlyVerses(bible) };

  const candidates = [];
  $("main, article, section, div, body").each((_, el) => {
    const node = $(el);
    const score = node.find("table").length * 2 + node.find("p.title").length;
    if (score >= 3) candidates.push({ node, score });
  });
  candidates.sort((a,b)=>b.score-a.score);

  if (candidates.length) {
    const node = candidates[0].node.clone();
    node.find(JUNK_SEL).remove();
    return { meta, fragment: keepOnlyVerses(node) };
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
        "Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
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
    res.setHeader("Cache-Control","public, s-maxage=900, stale-while-revalidate=600");
    res.status(200).json({
      date, version: ver,
      ...meta,
      html: fragment,
      source: url
    });
  } catch (err) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(500).json({ error:String(err?.message||err) });
  }
}
