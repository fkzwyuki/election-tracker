#!/usr/bin/env node
/**
 * 地方選 開票速報 収集・解析スクリプト（Node.js 20+ 標準モジュールのみ・LLMコスト0円）
 *
 * 使い方:
 *   node scripts/collect.mjs              # config/elections.json の active な選挙を取得して docs/data/latest.json を更新
 *   node scripts/collect.mjs --all        # active=false の選挙も含めて取得を試行
 *   node scripts/collect.mjs --demo       # オフライン動作確認用のデモデータ（松戸11/15・鳥取11/22）を生成
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'config', 'elections.json');
const OUTPUT_PATH = path.join(ROOT_DIR, 'docs', 'data', 'latest.json');

const USER_AGENT =
  'LocalElectionTracker/1.0 (+https://github.com/; polite polling)';

// ---------------------------------------------------------------------------
// テキスト正規化・数値パースユーティリティ
// ---------------------------------------------------------------------------

function normalizeText(str) {
  if (!str) return '';
  return str
    .replace(/\u3000/g, ' ')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/％/g, '%')
    .replace(/．/g, '.')
    .replace(/，/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactName(str) {
  return normalizeText(str).replace(/\s+/g, '').toLowerCase();
}

function parseNumber(str) {
  if (typeof str === 'number') return str;
  if (!str) return null;
  const cleaned = normalizeText(String(str)).replace(/,/g, '');
  // 小数票（按分票）にも対応: 例 1234.567
  const match = cleaned.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const val = Number(match[1]);
  return Number.isFinite(val) ? val : null;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripTags(html) {
  return normalizeText(
    decodeHtmlEntities(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
    )
  );
}

// ---------------------------------------------------------------------------
// HTTP取得（Shift_JIS / EUC-JP / UTF-8 自動判定）
// ---------------------------------------------------------------------------

async function fetchHtml(url, encodingHint = 'auto') {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} (${url})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = crypto.createHash('sha256').update(buf).digest('hex');

  let encoding = encodingHint;
  if (!encoding || encoding === 'auto') {
    const contentType = res.headers.get('content-type') || '';
    const ctMatch = contentType.match(/charset=([^\s;]+)/i);
    if (ctMatch) {
      encoding = ctMatch[1].toLowerCase();
    } else {
      const headAscii = buf.subarray(0, 2048).toString('latin1');
      const metaMatch = headAscii.match(/charset=["']?([a-zA-Z0-9_-]+)/i);
      encoding = metaMatch ? metaMatch[1].toLowerCase() : 'utf-8';
    }
  }

  if (encoding.includes('shift') || encoding.includes('sjis') || encoding === 'ms932') {
    encoding = 'shift_jis';
  } else if (encoding.includes('euc')) {
    encoding = 'euc-jp';
  } else {
    encoding = 'utf-8';
  }

  const html = new TextDecoder(encoding, { fatal: false }).decode(buf);
  return { html, hash, finalUrl: res.url };
}

// ---------------------------------------------------------------------------
// 入口ページから最新の速報URLを自動探索
// ---------------------------------------------------------------------------

function discoverResultLink(html, baseUrl, keywords = ['開票', '速報', '結果']) {
  const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const candidates = [];
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    const href = m[1].trim();
    const text = stripTags(m[2]);
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;

    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) score += 3;
      if (href.toLowerCase().includes(kw.toLowerCase())) score += 1;
    }
    if (text.includes('開票速報') || text.includes('開票結果')) score += 5;
    if (href.toLowerCase().endsWith('.pdf')) score -= 1; // HTML表を優先

    if (score > 0) {
      try {
        const resolved = new URL(href, baseUrl).toString();
        candidates.push({ url: resolved, text, score });
      } catch {
        // ignore invalid URL
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

// ---------------------------------------------------------------------------
// ページ内の最新「開票速報」PDFリンクを探索（時刻・最終を優先判定）
// ---------------------------------------------------------------------------

function extractTimeSortKey(text) {
  const norm = normalizeText(text);
  if (/最終|確定/.test(norm)) return 99999;
  const m = norm.match(/([0-9]{1,2})\s*(?:時|:)\s*([0-9]{1,2})?/);
  if (!m) return 0;
  let hour = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  // 深夜 0:00〜5:59 は 24:00〜29:59 として扱い 23:45 より後に並べる
  if (hour < 6) hour += 24;
  return hour * 60 + min;
}

function discoverLatestPdfLink(html, baseUrl, keywords = ['開票速報', '開票結果']) {
  const linkRegex = /<a\s+[^>]*href=["']([^"']+\.pdf(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const hits = [];
  let m;
  let order = 0;
  while ((m = linkRegex.exec(html)) !== null) {
    order += 1;
    const href = m[1].trim();
    const text = stripTags(m[2]);
    // 投票速報のみ・公報・立候補届出一覧などは除外
    if (/投票速報|選挙公報|立候補|宣誓書|閉鎖時刻|事務所/.test(text) && !/開票/.test(text)) {
      continue;
    }
    const matched = keywords.some((kw) => text.includes(kw) || href.toLowerCase().includes(kw.toLowerCase()));
    if (!matched) continue;

    try {
      const resolved = new URL(href, baseUrl).toString();
      hits.push({
        url: resolved,
        text,
        timeKey: extractTimeSortKey(text),
        order,
      });
    } catch {
      // ignore invalid URL
    }
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.timeKey - a.timeKey || b.order - a.order);
  return hits[0];
}

// ---------------------------------------------------------------------------
// PDF取得 ＋ Gemini API（無料枠）による構造化JSON抽出（ハッシュ変更時のみ呼出）
// ---------------------------------------------------------------------------

async function fetchBinary(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} (${url})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  return { buf, hash, finalUrl: res.url };
}

async function parsePdfWithGemini(pdfBuf, electionCfg) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('画像PDFを検出しましたが GEMINI_API_KEY が未設定です（GitHub Secretsに設定してください）');
  }

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const prompt = [
    `これは日本の地方選挙（${electionCfg.name}）の開票速報PDFです。`,
    '以下のJSON形式のみを厳密に出力してください（マークダウンや説明文は不要）。',
    '{',
    '  "official_updated_at": "PDF記載の時刻や確定表記（例: 22時15分現在、最終など。不明ならnull）",',
    '  "progress_pct": 開票率の数値（%記号なし、例: 25.77。最終/確定なら100。不明ならnull）,',
    '  "total_votes_cast": 投票者総数または投票総数の整数（不明ならnull）,',
    '  "remaining_votes": 残票数の整数（記載があれば。なければnull）,',
    '  "is_final": 最終確定報であれば true、途中速報であれば false,',
    '  "candidates": [',
    '    { "name": "候補者氏名", "votes": 得票数(数値) }',
    '  ]',
    '}',
    '注意点:',
    '- 取り消し線が引かれている辞退候補・立候補取消の行は candidates に含めないでください。',
    '- 合計・無効票・按分切捨票などの集計行は candidates に含めないでください。',
    '- 得票数はカンマなしの数値（按分小数がある場合は小数）にしてください。',
  ].join('\n');

  const body = {
    contents: [
      {
        parts: [
          {
            inline_data: {
              mime_type: 'application/pdf',
              data: pdfBuf.toString('base64'),
            },
          },
          { text: prompt },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
    },
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const json = await res.json();
  const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!rawText) {
    throw new Error('Gemini API から空のレスポンスが返りました');
  }

  const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  const parsed = JSON.parse(cleaned);
  const candidates = (parsed.candidates || [])
    .map((c) => ({
      name: normalizeText(c.name),
      votes: parseNumber(c.votes),
    }))
    .filter((c) => c.name && c.votes !== null);

  return {
    candidates,
    progressPct: parsed.progress_pct !== undefined && parsed.progress_pct !== null ? Number(parsed.progress_pct) : null,
    totalVotesCast: parsed.total_votes_cast !== undefined && parsed.total_votes_cast !== null ? parseNumber(parsed.total_votes_cast) : null,
    officialRemainingVotes: parsed.remaining_votes !== undefined && parsed.remaining_votes !== null ? parseNumber(parsed.remaining_votes) : null,
    officialUpdatedAt: parsed.official_updated_at || null,
    isFinal: Boolean(parsed.is_final),
  };
}

// ---------------------------------------------------------------------------
// HTMLテーブルからの汎用抽出（候補者名・得票数）
// ---------------------------------------------------------------------------

function extractTables(html) {
  const tables = [];
  const tableRegex = /<table[\s\S]*?<\/table>/gi;
  let tm;
  while ((tm = tableRegex.exec(html)) !== null) {
    const rows = [];
    const rowRegex = /<tr[\s\S]*?<\/tr>/gi;
    let rm;
    while ((rm = rowRegex.exec(tm[0])) !== null) {
      const cells = [];
      const cellRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
      let cm;
      while ((cm = cellRegex.exec(rm[0])) !== null) {
        cells.push(stripTags(cm[1]));
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length > 0) tables.push(rows);
  }
  return tables;
}

function parseCandidatesFromTables(tables, parserCfg = {}) {
  const nameHints = parserCfg.name_column_hint || ['候補者', '氏名', '立候補者'];
  const voteHints = parserCfg.votes_column_hint || ['得票', '票数', '計'];

  let bestCandidates = [];

  for (const rows of tables) {
    if (rows.length < 3) continue;

    // ヘッダー行を探す（先頭3行以内）
    let headerIdx = -1;
    let nameCol = -1;
    let voteCol = -1;

    for (let i = 0; i < Math.min(3, rows.length); i++) {
      const row = rows[i];
      const nIdx = row.findIndex((c) => nameHints.some((h) => c.includes(h)));
      const vIdx = row.findIndex((c) => voteHints.some((h) => c.includes(h)));
      if (nIdx !== -1 && vIdx !== -1 && nIdx !== vIdx) {
        headerIdx = i;
        nameCol = nIdx;
        voteCol = vIdx;
        break;
      }
    }

    if (headerIdx === -1) continue;

    const extracted = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.length <= Math.max(nameCol, voteCol)) continue;
      const rawName = row[nameCol];
      const rawVotes = row[voteCol];

      if (!rawName || /^(合計|計|有効|無効|総計|小計)/.test(rawName)) continue;
      const votes = parseNumber(rawVotes);
      if (votes === null) continue;

      extracted.push({ name: rawName, votes });
    }

    if (extracted.length > bestCandidates.length) {
      bestCandidates = extracted;
    }
  }

  return bestCandidates;
}

function parseMetadataFromHtml(html, parserCfg = {}) {
  const plainText = stripTags(html);

  const progressRegex = new RegExp(
    parserCfg.progress_regex || '開票率[：:\\s]*([0-9]+(?:\\.[0-9]+)?)\\s*[%％]'
  );
  const progressMatch = plainText.match(progressRegex);
  const progressPct = progressMatch ? Number(progressMatch[1]) : null;

  const totalVotesRegex = new RegExp(
    parserCfg.total_votes_cast_regex || '(?:投票総数|投票者数|有効投票)[：:\\s]*([0-9,]+)'
  );
  const totalVotesMatch = plainText.match(totalVotesRegex);
  const totalVotesCast = totalVotesMatch ? parseNumber(totalVotesMatch[1]) : null;

  const updatedAtRegex = new RegExp(
    parserCfg.updated_at_regex || '((?:[0-9]{1,2}時[0-9]{1,2}分)|(?:[0-9]{1,2}:[0-9]{2}))\\s*現在'
  );
  const updatedAtMatch = plainText.match(updatedAtRegex);
  const officialUpdatedAt = updatedAtMatch ? updatedAtMatch[1] : null;

  return { progressPct, totalVotesCast, officialUpdatedAt };
}

// ---------------------------------------------------------------------------
// 順位・当落ライン・前後3名・残り見込み票数の計算
// ---------------------------------------------------------------------------

function matchWatchCandidate(candidateName, watchConfig) {
  const target = compactName(candidateName);
  const keys = [watchConfig.name, ...(watchConfig.aliases || [])].map(compactName);
  return keys.some((k) => k && (target === k || target.includes(k) || k.includes(target)));
}

function buildElectionReport(electionCfg, rawData) {
  const {
    candidates = [],
    progressPct = null,
    totalVotesCast = null,
    officialRemainingVotes = null,
    officialUpdatedAt = null,
    sourceUrl = electionCfg.results_url || electionCfg.portal_url,
    sourceHash = null,
    status = 'pre_count', // 'pre_count' | 'counting' | 'final' | 'error'
    errorMessage = null,
  } = rawData;

  const seats = electionCfg.seats;
  const totalCandidates = electionCfg.total_candidates || candidates.length;

  // 得票数降順ソート（同票は元の順序維持）
  const sorted = [...candidates].sort((a, b) => b.votes - a.votes);

  // 同率順位（1, 2, 2, 4 ...）を付与
  const ranked = sorted.map((c, idx) => {
    let rank = idx + 1;
    if (idx > 0 && sorted[idx - 1].votes === c.votes) {
      rank = null; // 下で埋める
    }
    const matchedWatch = (electionCfg.watch_candidates || []).find((w) =>
      matchWatchCandidate(c.name, w)
    );
    return {
      rank,
      name: c.name,
      votes: c.votes,
      is_watched: Boolean(matchedWatch),
      status_tag: matchedWatch?.status_tag || null,
      watch_display_name: matchedWatch?.name || null,
    };
  });
  for (let i = 1; i < ranked.length; i++) {
    if (ranked[i].rank === null) {
      ranked[i].rank = ranked[i - 1].rank;
    }
  }

  // 当落ラインの得票数（定数位 と 次点=定数+1位）
  const seatCutoffVotes = ranked.length >= seats ? ranked[seats - 1].votes : null;
  const runnerUpVotes = ranked.length > seats ? ranked[seats].votes : null;

  // 開票済総票数 & 残り見込み票数
  const countedVotes = ranked.reduce((sum, c) => sum + c.votes, 0);
  let remainingVotesEstimate = null;
  let remainingBasis = null;

  if (status === 'final' || progressPct === 100) {
    remainingVotesEstimate = 0;
    remainingBasis = '開票終了';
  } else if (officialRemainingVotes !== null && officialRemainingVotes >= 0) {
    remainingVotesEstimate = Math.round(officialRemainingVotes);
    remainingBasis = '選管公表の残票';
  } else if (totalVotesCast !== null && totalVotesCast >= countedVotes && countedVotes > 0) {
    remainingVotesEstimate = Math.max(0, Math.round(totalVotesCast - countedVotes));
    remainingBasis = '投票総数ベース（無効票含む概算）';
  } else if (progressPct !== null && progressPct > 0 && progressPct < 100 && countedVotes > 0) {
    remainingVotesEstimate = Math.round((countedVotes * (100 - progressPct)) / progressPct);
    remainingBasis = '開票率からの比例概算';
  }

  // 注目候補ごとのサマリー＆前後3名
  const watchedSummaries = (electionCfg.watch_candidates || []).map((w) => {
    const idx = ranked.findIndex((r) => matchWatchCandidate(r.name, w));
    if (idx === -1) {
      return {
        name: w.name,
        status_tag: w.status_tag || '',
        found: false,
        rank: null,
        votes: null,
        zone: 'unknown', // 'safe' | 'borderline' | 'outside' | 'unknown'
        diff_from_cutoff: null,
        cutoff_label: null,
        surrounding: [],
      };
    }

    const me = ranked[idx];
    const inSeats = me.rank <= seats;
    let diffFromCutoff = null;
    let cutoffLabel = null;
    let zone = 'unknown';

    if (inSeats) {
      if (runnerUpVotes !== null) {
        diffFromCutoff = Math.round((me.votes - runnerUpVotes) * 1000) / 1000;
        cutoffLabel = `次点(${seats + 1}位)との差`;
        zone = diffFromCutoff > 0 ? 'safe' : 'borderline';
      } else {
        zone = 'safe';
      }
    } else if (seatCutoffVotes !== null) {
      diffFromCutoff = Math.round((me.votes - seatCutoffVotes) * 1000) / 1000;
      cutoffLabel = `当選ライン(${seats}位)まで`;
      zone = 'outside';
    }

    const start = Math.max(0, idx - 3);
    const end = Math.min(ranked.length - 1, idx + 3);
    const surrounding = [];
    for (let i = start; i <= end; i++) {
      const item = ranked[i];
      surrounding.push({
        index: i + 1,
        rank: item.rank,
        name: item.name,
        votes: item.votes,
        diff_from_me: Math.round((item.votes - me.votes) * 1000) / 1000,
        is_self: i === idx,
        is_watched: item.is_watched,
        in_seats: item.rank <= seats,
        is_cutoff_border_after: i + 1 === seats, // この行の直後に当落線を引く
      });
    }

    return {
      name: w.name,
      official_name: me.name,
      status_tag: w.status_tag || '',
      found: true,
      rank: me.rank,
      votes: me.votes,
      zone,
      diff_from_cutoff: diffFromCutoff,
      cutoff_label: cutoffLabel,
      surrounding,
    };
  });

  return {
    id: electionCfg.id,
    event_id: electionCfg.event_id,
    prefecture: electionCfg.prefecture,
    municipality: electionCfg.municipality,
    name: electionCfg.name,
    election_date: electionCfg.election_date,
    seats,
    total_candidates: totalCandidates,
    portal_url: electionCfg.portal_url,
    source_url: sourceUrl,
    source_hash: sourceHash,
    status,
    error_message: errorMessage,
    official_updated_at: officialUpdatedAt,
    fetched_at: new Date().toISOString(),
    progress_pct: progressPct,
    counted_votes: countedVotes,
    total_votes_cast: totalVotesCast,
    remaining_votes_estimate: remainingVotesEstimate,
    remaining_basis: remainingBasis,
    seat_cutoff_votes: seatCutoffVotes,
    runner_up_votes: runnerUpVotes,
    watched_summaries: watchedSummaries,
    notes: electionCfg.notes || '',
  };
}

// ---------------------------------------------------------------------------
// デモデータ生成（オフライン検証＆プロトタイプ確認用）
// ---------------------------------------------------------------------------

function generateDemoData(config) {
  const matsudoCfg = config.elections.find((e) => e.id === '2026-11-15-matsudo-city');
  const tottoriCfg = config.elections.find((e) => e.id === '2026-11-22-tottori-city');

  // 松戸市議選（2026/11/15確定）の注目3候補の実得票をベースにしたリアルなサンプル配列（62名）
  const matsudoCandidates = [
    { name: '候補者A（トップ）', votes: 6120 },
    { name: '候補者B', votes: 5410 },
    { name: '候補者C', votes: 4890 },
    { name: '候補者D', votes: 4320 },
    { name: '候補者E', votes: 3980 },
    { name: '候補者F', votes: 3750 },
    { name: '候補者G', votes: 3540 },
    { name: '候補者H', votes: 3320 },
    { name: '候補者I', votes: 3180 },
    { name: '候補者J', votes: 3050 },
    { name: '候補者K', votes: 2940 },
    { name: '候補者L', votes: 2810 },
    { name: '候補者M', votes: 2740 },
    { name: '候補者N', votes: 2665 },
    { name: 'おさかべ 智弘', votes: 2602 },
    { name: '候補者O', votes: 2560 },
    { name: '候補者P', votes: 2495 },
    { name: '候補者Q', votes: 2430 },
    { name: '候補者R', votes: 2380 },
    { name: '候補者S', votes: 2310 },
    { name: '候補者T', votes: 2260 },
    { name: '候補者U', votes: 2205 },
    { name: '候補者V', votes: 2150 },
    { name: '候補者W', votes: 2110 },
    { name: '候補者X', votes: 2070 },
    { name: '候補者Y', votes: 2025 },
    { name: '候補者Z', votes: 1990 },
    { name: '候補者AA', votes: 1955 },
    { name: '候補者AB', votes: 1920 },
    { name: '候補者AC', votes: 1890 },
    { name: '候補者AD', votes: 1872 },
    { name: '成島 りょうた', votes: 1850 },
    { name: '候補者AE', votes: 1834 },
    { name: '候補者AF', votes: 1810 },
    { name: '候補者AG', votes: 1790 },
    { name: '候補者AH', votes: 1765 },
    { name: '候補者AI', votes: 1742 },
    { name: '候補者AJ', votes: 1720 },
    { name: '候補者AK', votes: 1705 },
    { name: '川井 きよまさ', votes: 1688 },
    { name: '候補者AL', votes: 1660 },
    { name: '候補者AM', votes: 1635 },
    { name: '候補者AN', votes: 1612 },
    { name: '候補者AO（44位・当選ライン）', votes: 1595 },
    { name: '候補者AP（45位・次点）', votes: 1572 },
    { name: '候補者AQ', votes: 1520 },
    { name: '候補者AR', votes: 1475 },
    { name: '候補者AS', votes: 1410 },
    { name: '候補者AT', votes: 1350 },
    { name: '候補者AU', votes: 1290 },
    { name: '候補者AV', votes: 1210 },
    { name: '候補者AW', votes: 1140 },
    { name: '候補者AX', votes: 1060 },
    { name: '候補者AY', votes: 980 },
    { name: '候補者AZ', votes: 910 },
    { name: '候補者BA', votes: 840 },
    { name: '候補者BB', votes: 760 },
    { name: '候補者BC', votes: 690 },
    { name: '候補者BD', votes: 610 },
    { name: '候補者BE', votes: 520 },
    { name: '候補者BF', votes: 430 },
    { name: '候補者BG', votes: 310 },
  ];

  // 鳥取市議選（明日 11/22）: 開票前待機状態
  const reports = [];
  if (tottoriCfg) {
    reports.push(
      buildElectionReport(tottoriCfg, {
        candidates: [],
        progressPct: 0,
        totalVotesCast: null,
        officialUpdatedAt: '開票開始前（11/22 21:00頃〜予定）',
        status: 'pre_count',
      })
    );
  }
  if (matsudoCfg) {
    reports.push(
      buildElectionReport(matsudoCfg, {
        candidates: matsudoCandidates,
        progressPct: 100,
        totalVotesCast: 143800,
        officialUpdatedAt: '確定（デモ表示：注目3候補は実得票・他候補はサンプル）',
        status: 'final',
      })
    );
  }

  return {
    generated_at: new Date().toISOString(),
    mode: 'demo',
    party: config.party,
    events: config.events,
    elections: reports,
  };
}

// ---------------------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------------------

async function collectSingleElection(electionCfg, prevReport) {
  let targetUrl = electionCfg.results_url;

  try {
    // 1. results_url 未設定なら入口ページから最新速報リンクを自動探索
    if (!targetUrl && electionCfg.portal_url) {
      const portal = await fetchHtml(electionCfg.portal_url, electionCfg.parser?.encoding);
      const discovered = discoverResultLink(
        portal.html,
        portal.finalUrl,
        electionCfg.discover_link_keywords
      );
      if (discovered) {
        targetUrl = discovered.url;
        console.log(`[${electionCfg.id}] 速報リンク検出: ${discovered.text} -> ${targetUrl}`);
      } else {
        // まだ速報リンクが出ていない（開票前）
        return buildElectionReport(electionCfg, {
          status: 'pre_count',
          progressPct: 0,
          officialUpdatedAt: '開票速報ページ未公開',
          sourceUrl: electionCfg.portal_url,
        });
      }
    }

    // 2. 速報ページを取得（差分検知）
    const fetched = await fetchHtml(targetUrl, electionCfg.parser?.encoding);
    if (prevReport && prevReport.source_hash === fetched.hash && prevReport.status !== 'error') {
      console.log(`[${electionCfg.id}] 変更なし（スキップ）`);
      return {
        ...prevReport,
        fetched_at: new Date().toISOString(),
      };
    }

    // 3. HTMLテーブル抽出＆メタデータ解析
    const tables = extractTables(fetched.html);
    const candidates = parseCandidatesFromTables(tables, electionCfg.parser);
    const meta = parseMetadataFromHtml(fetched.html, electionCfg.parser);

    // 4. HTMLテーブルが空なら、ページ内の最新「開票速報PDF」を探して解析（Gemini API無料枠フォールバック）
    if (candidates.length === 0) {
      const pdfLink = discoverLatestPdfLink(
        fetched.html,
        fetched.finalUrl,
        electionCfg.pdf_link_keywords || ['開票速報', '開票結果']
      );

      if (pdfLink) {
        console.log(`[${electionCfg.id}] 開票速報PDF検出: ${pdfLink.text} -> ${pdfLink.url}`);
        const pdf = await fetchBinary(pdfLink.url);

        if (prevReport && prevReport.source_hash === pdf.hash && prevReport.status !== 'error') {
          console.log(`[${electionCfg.id}] PDF変更なし（Gemini呼出スキップ）`);
          return {
            ...prevReport,
            fetched_at: new Date().toISOString(),
          };
        }

        const pdfData = await parsePdfWithGemini(pdf.buf, electionCfg);
        if (pdfData.candidates.length > 0) {
          const pdfStatus = pdfData.isFinal || pdfData.progressPct === 100 ? 'final' : 'counting';
          console.log(
            `[${electionCfg.id}] PDF解析成功: ${pdfData.candidates.length}名 / 開票率=${pdfData.progressPct ?? '不明'}%`
          );
          return buildElectionReport(electionCfg, {
            candidates: pdfData.candidates,
            progressPct: pdfData.progressPct,
            totalVotesCast: pdfData.totalVotesCast,
            officialRemainingVotes: pdfData.officialRemainingVotes,
            officialUpdatedAt: pdfData.officialUpdatedAt || pdfLink.text,
            sourceUrl: pdf.finalUrl,
            sourceHash: pdf.hash,
            status: pdfStatus,
          });
        }
      }

      return buildElectionReport(electionCfg, {
        status: 'pre_count',
        progressPct: meta.progressPct ?? 0,
        totalVotesCast: meta.totalVotesCast,
        officialUpdatedAt: meta.officialUpdatedAt || '開票データ待機中',
        sourceUrl: fetched.finalUrl,
        sourceHash: fetched.hash,
      });
    }

    const status = meta.progressPct === 100 ? 'final' : 'counting';
    console.log(
      `[${electionCfg.id}] 取得成功: ${candidates.length}名 / 開票率=${meta.progressPct ?? '不明'}%`
    );

    return buildElectionReport(electionCfg, {
      candidates,
      progressPct: meta.progressPct,
      totalVotesCast: meta.totalVotesCast,
      officialUpdatedAt: meta.officialUpdatedAt,
      sourceUrl: fetched.finalUrl,
      sourceHash: fetched.hash,
      status,
    });
  } catch (err) {
    console.error(`[${electionCfg.id}] 取得エラー: ${err.message}`);
    if (prevReport && prevReport.watched_summaries?.some((w) => w.found)) {
      // 前回データが有効なら画面を壊さず前回値＋エラー注記を保持
      return {
        ...prevReport,
        status: 'error',
        error_message: `最新取得に失敗（前回値を表示中）: ${err.message}`,
        fetched_at: new Date().toISOString(),
      };
    }
    return buildElectionReport(electionCfg, {
      status: 'error',
      errorMessage: err.message,
      sourceUrl: targetUrl || electionCfg.portal_url,
    });
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const isDemo = args.has('--demo');
  const includeAll = args.has('--all');

  const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf-8'));

  if (isDemo) {
    const demoPayload = generateDemoData(config);
    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await fs.writeFile(OUTPUT_PATH, JSON.stringify(demoPayload, null, 2), 'utf-8');
    console.log(`デモデータを生成しました: ${OUTPUT_PATH}`);
    return;
  }

  let prevData = { elections: [] };
  try {
    prevData = JSON.parse(await fs.readFile(OUTPUT_PATH, 'utf-8'));
  } catch {
    // 初回実行時は存在しない
  }
  const prevById = new Map((prevData.elections || []).map((e) => [e.id, e]));

  const results = [];
  for (const electionCfg of config.elections) {
    const prev = prevById.get(electionCfg.id);
    if (!electionCfg.active && !includeAll) {
      if (prev) results.push(prev);
      continue;
    }
    const report = await collectSingleElection(electionCfg, prev);
    results.push(report);
  }

  const payload = {
    generated_at: new Date().toISOString(),
    mode: 'live',
    party: config.party,
    events: config.events,
    elections: results,
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`集計データを出力しました: ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
