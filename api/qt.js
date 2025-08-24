// api/qt.js
// Robust Duranno QT proxy: handles UTF-8 / EUC-KR(CP949) pages and returns clean JSON.

import iconv from "iconv-lite";
import * as cheerio from "cheerio";

/** 헤더에서/메타태그에서 charset 추출 */
function sniffCharset(contentType = "", headSnippet = "") {
  const ctMatch = /charset\s*=\s*([^;]+)/i.exec(contentType);
  if (ctMatch) return ctMatch[1].trim().toLowerCase();

  const metaMatch = headSnippet.match(/charset=["']?\s*([\w-]+)\s*["']?/i);
  if (metaMatch) return metaMatch[1].trim().toLowerCase();

  return ""; // unknown
}

/** 버퍼를 charset에 맞춰 문자열로 디코딩 */
function decodeBuffer(buf, charsetGuess = "") {
  const guess = (charsetGuess || "").toLowerCase();

  const isUtf8 = guess === "utf-8" || guess === "utf8";
  const isKr =
    guess === "euc-kr" ||
    guess === "ks_c_5601-1987" ||
    guess === "ks_c_5601" ||
    guess === "x-windows-949" ||
    guess === "cp949";

  // 1) 명시된 경우 우선
  if (isUtf8) {
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  }
  if (isKr) {
    return iconv.decode(Buffer.from(buf), "cp949");
  }

  // 2) 추정 실패 → UTF-8 시도 후 깨짐 패턴이면 CP949 재시도
  let utf = "";
  try {
    utf = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  } catch {
    utf = "";
  }
  if (!utf) return iconv.decode(Buffer.from(buf), "cp949");

  // 깨짐 흔적(� 많이 포함/널/제어문자 과다) 검사
  const broken =
    /�/.test(utf) ||
    /\u0000/.test(utf) ||
    (utf.match(/�/g) || []).length > 5;

  return broken ? iconv.decode(Buffer.from(buf), "cp949") : utf;
}

/** cheerio로 .bible 섹션(또는 베스트 후보 컨테이너) 추출 */
function extractBibleFragment(html) {
  const $ = cheerio.load(html);

  // 1) 가장 정확: .bible
  const b = $(".bible");
  if (b.length) {
    return {
      title: $("h1 span").first().text().trim() || $("h1").first().text().trim(),
      html: b.first().prop("outerHTML"),
    };
  }

  // 2) 테이블과 p.title 이 많은 컨테이너를 점수로 선정
  const candidates = [];
  $("main, article, section, div, body").each((_, el) => {
    const node = $(el);
    const score = node.find("table").length * 2 + node.find("p.title").length;
    if (score >= 3) candidates.push({ node, score });
  });
  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length) {
    const node = candidates[0].node;
    return {
      title: $("h1 span").first().text().trim() || $("h1").first().text().trim(),
      html: node.prop("outerHTML"),
    };
  }

  // 3) 실패
  return { title: "", html: "" };
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
      // 중요: Vercel Node 런타임에서는 압축 자동 해제됨
      redirect: "follow",
    });

    const ab = await resp.arrayBuffer();
    const headSnippet = Buffer.from(ab).slice(0, 4096).toString("binary");
    const charset = sniffCharset(resp.headers.get("content-type") || "", headSnippet);

    const html = decodeBuffer(ab, charset);
    const { title, html: fragment } = extractBibleFragment(html);

    if (!fragment) {
      res.status(502).json({
        error: "bible fragment not found",
        source: url,
        note:
          "원문 페이지 구조가 변경되었거나 인코딩이 특수한 경우일 수 있습니다. 프론트는 data.html 전체를 파싱하도록 해도 됩니다.",
        html, // 참고를 위해 전체 원문도 내려 줌(디버그용)
      });
      return;
    }

    res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=600"); // 15분 캐시
    res.status(200).json({
      date,
      version: ver,
      title: title || "",
      html: fragment, // 프론트는 이 fragment를 파싱
      source: url,
    });
  } catch (err) {
    res
      .status(500)
      .json({ error: String(err && err.message ? err.message : err) });
  }
}
