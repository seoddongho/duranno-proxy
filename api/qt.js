// api/qt.js
// Robust Duranno QT proxy: UTF-8 / EUC-KR(CP949) 처리 + 본문/제목 메타 추출(JSON)

import iconv from "iconv-lite";
import * as cheerio from "cheerio";

/** content-type / meta charset 스니핑 */
function sniffCharset(contentType = "", headSnippet = "") {
  const ct = /charset\s*=\s*([^;]+)/i.exec(contentType || "");
  if (ct) return ct[1].trim().toLowerCase();

  const meta = headSnippet.match(/charset=["']?\s*([\w-]+)\s*["']?/i);
  if (meta) return meta[1].trim().toLowerCase();

  return "";
}

/** Buffer(ArrayBuffer) → 텍스트 (UTF-8 우선, 깨짐 흔적 시 CP949) */
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

  // 추정 실패 → UTF-8 시도 후 깨짐 흔적 있으면 CP949
  let utf = "";
  try { utf = new TextDecoder("utf-8", { fatal: false }).decode(ab); } catch {}
  if (!utf) return iconv.decode(buf, "cp949");

  const looksBroken =
    /�/.test(utf) || /\u0000/.test(utf) || (utf.match(/�/g) || []).length > 5;
  return looksBroken ? iconv.decode(buf, "cp949") : utf;
}

/** H1 파서: 책/범위/부제/표시용 제목 */
function parseHeader($) {
  const h1 = $("h1").first();
  const spanText = h1.find("span").first().text().trim();
  const emText = h1.find("em").first().text().trim();
  const raw = spanText || h1.text().trim();

  let book = "", range = "";

  if (raw) {
    const cleaned = raw
      .replace(/\s+/g, " ")
      .replace(/\s*:\s*/g, ":")
      .replace(/\s*~\s*/g, "–")
      .trim();
    // 예: "에스겔 21:1–17" / "에스겔 21:1-17"
    const m = cleaned.match(/^([가-힣A-Za-z·\s]+)\s+(\d+\s*:\s*\d+(?:[–-]\d+)?)$/);
    if (m) {
      book = m[1].trim();
      range = m[2].replace(/\s+/g, "");
      range = range.replace(/-/g, "–");
    } else {
      book = cleaned;
    }
  }

  const combinedTitle = [spanText || (book + (range ? ` ${range}` : "")), emText]
    .filter(Boolean)
    .join(" — ");

  return {
    book,
    range,
    subtitle: emText || "",
    title: combinedTitle || raw || "",
  };
}

/** 본문 조각 추출(.bible 우선, 후보 점수식) */
function extractBibleFragment(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const meta = parseHeader($);

  const b = $(".bible");
  if (b.length) {
    return { meta, fragment: b.first().prop("outerHTML") };
  }

  const candidates = [];
  $("main, article, section, div, body").each((_, el) => {
    const node = $(el);
    const score = node.find("table").length * 2 + node.find("p.title").length;
    if (score >= 3) candidates.push({ node, score });
  });
  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length) {
    return { meta, fragment: candidates[0].node.prop("outerHTML") };
  }
  return { meta, fragment: "" };
}

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
    const headSnippet = Buffer.from(ab).slice(0, 4096).toString("binary");
    const charset = sniffCharset(resp.headers.get("content-type") || "", headSnippet);

    const html = decodeBuffer(ab, charset);
    const { meta, fragment } = extractBibleFragment(html);

    if (!fragment) {
      res.status(502).json({
        error: "bible fragment not found",
        source: url,
        note: "페이지 구조/인코딩 특수 케이스일 수 있습니다.",
        html, // 디버그 참고용
      });
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=600");
    res.status(200).json({
      date,
      version: ver,
      ...meta,     // book, range, subtitle, title
      html: fragment,
      source: url,
    });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
}
