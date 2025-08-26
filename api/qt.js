// api/qt.js
// Duranno QT Proxy: UTF-8 / EUC-KR(CP949) 자동 디코딩 + 본문(.bible) 추출 + 제목 메타(book/range/subtitle/title)

import iconv from "iconv-lite";
import * as cheerio from "cheerio";

/* ---------- helpers: charset sniff / decode ---------- */
function sniffCharset(contentType = "", headSnippet = "") {
  const ct = /charset\s*=\s*([^;]+)/i.exec(contentType || "");
  if (ct) return ct[1].trim().toLowerCase();

  const meta = headSnippet.match(/charset=["']?\s*([\w-]+)\s*["']?/i);
  if (meta) return meta[1].trim().toLowerCase();

  return "";
}

function decodeBuffer(ab, charsetGuess = "") {
  const buf = Buffer.from(ab);
  const guess = (charsetGuess || "").toLowerCase();
  const isUtf8 = guess === "utf-8" || guess === "utf8";
  const isKr =
    guess === "euc-kr" ||
    guess === "ks_c_5601-1987" ||
    guess === "ks_c_5601" ||
    guess === "x-windows-949" ||
    guess === "cp949";

  if (isUtf8) return new TextDecoder("utf-8", { fatal: false }).decode(ab);
  if (isKr) return iconv.decode(buf, "cp949");

  let utf = "";
  try { utf = new TextDecoder("utf-8", { fatal: false }).decode(ab); } catch {}
  if (!utf) return iconv.decode(buf, "cp949");

  const looksBroken =
    /�/.test(utf) || /\u0000/.test(utf) || (utf.match(/�/g) || []).length > 5;
  return looksBroken ? iconv.decode(buf, "cp949") : utf;
}

/* ---------- helpers: title parser / fragment extractor ---------- */
function parseHeader($) {
  const h1 = $("h1").first();
  const spanText = h1.find("span").first().text().trim();   // 예: "에스겔 21:1~17"
  const emText   = h1.find("em").first().text().trim();     // 예: "찌꺼기가 된 족속"
  const raw      = spanText || h1.text().trim();

  let book = "", range = "";

  if (raw) {
    const cleaned = raw
      .replace(/\s+/g, " ")
      .replace(/\s*:\s*/g, ":")
      .replace(/\s*~\s*/g, "–")
      .trim();
    // "에스겔 21:1–17" 또는 "에스겔 21:1-17"
    const m = cleaned.match(/^([가-힣A-Za-z·\s]+)\s+(\d+\s*:\s*\d+(?:[–-]\d+)?)$/);
    if (m) {
      book  = m[1].trim();
      range = m[2].replace(/\s+/g, "").replace(/-/g, "–");
    } else {
      book = cleaned;
    }
  }

  const combinedTitle = [spanText || (book + (range ? ` ${range}` : "")), emText]
    .filter(Boolean)
    .join(" — ");

  return { book, range, subtitle: emText || "", title: combinedTitle || raw || "" };
}

function extractBibleFragment(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const meta = parseHeader($);

  // 1) 가장 확실: .bible
  const b = $(".bible");
  if (b.length) return { meta, fragment: b.first().prop("outerHTML") };

  // 2) 후보 점수식: table(×2) + p.title
  const candidates = [];
  $("main, article, section, div, body").each((_, el) => {
    const node  = $(el);
    const score = node.find("table").length * 2 + node.find("p.title").length;
    if (score >= 3) candidates.push({ node, score });
  });
  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length) return { meta, fragment: candidates[0].node.prop("outerHTML") };

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

    const url = `https://www.duranno.com/qt/view/bible.asp?qtDate=${encodeURIComponent(
      date
    )}&d=${ver}`;

    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        "Accept-Language": "ko,ko-KR;q=0.9,en;q=0.8",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });

    const ab = await resp.arrayBuffer();
    const headSnippet = Buffer.from(ab).slice(0, 4096).toString("binary"); // meta charset 추출용
    const charset = sniffCharset(resp.headers.get("content-type") || "", headSnippet);

    const html = decodeBuffer(ab, charset);
    const { meta, fragment } = extractBibleFragment(html);

    if (!fragment) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.status(502).json({
        error: "bible fragment not found",
        source: url,
        html // 디버그용(원문 전체)
      });
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=600"); // 15분 캐시
    res.status(200).json({
      date,
      version: ver,
      ...meta,             // book, range, subtitle, title
      html: fragment,      // 본문 조각(.bible)
      source: url
    });
  } catch (err) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(500).json({ error: String(err?.message || err) });
  }
}
