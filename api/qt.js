// api/qt.js
// Duranno QT Proxy: UTF-8/EUC-KR 자동 디코딩 + 본문만 추출
// 큰제목(책/범위), 소제목(부제)을 메타로 분리해 반환

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

/* ---------- header/meta parse ---------- */
function normSpace(s=""){
  return s.replace(/\u00A0/g," ").replace(/\s+/g," ").trim(); // NBSP 처리
}
function parseHeader($) {
  const h1 = $("h1").first();

  const spanText = normSpace(h1.find("span").first().text()); // "에스겔  22 : 17~31"
  const emText   = normSpace(h1.find("em").first().text());   // 소제목
  const h1Text   = normSpace(h1.text());

  // 범위: "숫자:숫자(~숫자)" 유연 매칭
  const rangeRe = /(\d+\s*:\s*\d+(?:\s*[~–-]\s*\d+)?)/;
  // 책+범위 (문장 어디든 허용: ^ 제거)
  const bookRangeRe = /([가-힣A-Za-z·\s]+?)\s+(\d+\s*:\s*\d+(?:\s*[~–-]\s*\d+)?)/;

  let book="", range="";
  let base = spanText || h1Text || "";

  let m = base.match(bookRangeRe);
  if (m) {
    book  = normSpace(m[1]);
    range = m[2].replace(/\s+/g,"").replace(/-/g,"–").replace("~","–");
  } else {
    const r = (spanText || h1Text).match(rangeRe);
    range = r ? r[1].replace(/\s+/g,"").replace(/-/g,"–").replace("~","–") : "";
    book  = "";
  }

  const title = [spanText || (book && range ? `${book} ${range}` : book || ""), emText]
    .filter(Boolean).join(" — ");

  return { book, range, subtitle: emText || "", title: title || h1Text || "" };
}

/* ---------- sanitize helpers ---------- */
const JUNK_SEL = [
  ".song",      // 오늘의 찬송
  ".helper",    // 묵상 도우미
  ".amen",      // 아멘 카운트/버튼
  ".copyright",
  ".btn-area",
  ".bible-st",
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
