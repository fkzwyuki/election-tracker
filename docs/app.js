const DATA_URL = './data/latest.json';
const PIN_STORAGE_KEY = 'election_tracker_pins_v1';

const PREF_ORDER = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

function getPrefRank(pref) {
  const idx = PREF_ORDER.indexOf(pref);
  return idx === -1 ? 999 : idx;
}

function loadPinnedIds() {
  try {
    const raw = localStorage.getItem(PIN_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function savePinnedIds(set) {
  try {
    localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // ignore storage quota/privacy errors
  }
}

let state = {
  payload: null,
  selectedEventId: 'TODAY',
  statusFilter: 'all', // 'all' | 'counting' | 'final'
  initializedSelection: false,
  query: '',
  expandedIds: new Set(),
  pinnedIds: loadPinnedIds(),
};

/**
 * 追う対象の日付（JST基準・0:00〜2:59は前日の選挙が継続中とみなす）
 */
function getTargetElectionDateJst() {
  const now = new Date();
  // UTC時刻に+9時間してJST相当のUTCフィールドで計算（端末のタイムゾーンに依存しない）
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  if (jst.getUTCHours() <= 2) {
    jst.setUTCDate(jst.getUTCDate() - 1);
  }
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fmtNum(n) {
  if (n === null || n === undefined) return '--';
  return Number(n).toLocaleString('ja-JP');
}

function fmtSigned(n) {
  if (n === null || n === undefined) return '--';
  const sign = n > 0 ? '+' : '';
  return `${sign}${Number(n).toLocaleString('ja-JP')}票`;
}

function fmtIso(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusBadge(status) {
  switch (status) {
    case 'counting':
      return '<span class="badge badge-counting">開票中</span>';
    case 'final':
      return '<span class="badge badge-final">確定</span>';
    case 'error':
      return '<span class="badge badge-error">取得エラー</span>';
    default:
      return '<span class="badge badge-pre">開票前</span>';
  }
}

function renderSurrounding(w, seats) {
  if (!w.found || !w.surrounding || w.surrounding.length === 0) {
    return `
      <div class="surrounding-wrap">
        <p class="surrounding-title"><span>開票データ待機中（速報が発表されると前後3名が表示されます）</span></p>
      </div>
    `;
  }

  const rowsHtml = w.surrounding
    .map((r) => {
      const classes = [];
      if (r.is_self) classes.push('row-self');
      if (r.is_cutoff_border_after) classes.push('row-cutoff-after');

      const diffText = r.is_self ? '本人' : fmtSigned(r.diff_from_me);
      let html = `
        <tr class="${classes.join(' ')}">
          <td>${r.rank}位</td>
          <td>${escapeHtml(r.name)}${r.is_watched && !r.is_self ? ' ★' : ''}</td>
          <td class="num">${fmtNum(r.votes)}</td>
          <td class="num">${diffText}</td>
        </tr>
      `;
      if (r.is_cutoff_border_after) {
        html += `
          <tr class="cutoff-note-row">
            <td colspan="4">▲ 当落ライン（定数 ${seats}位 / 次点 ${seats + 1}位）▼</td>
          </tr>
        `;
      }
      return html;
    })
    .join('');

  return `
    <div class="surrounding-wrap">
      <p class="surrounding-title">
        <span>前後3名の得票状況</span>
        <span>※ ★は同一政党の他注目候補</span>
      </p>
      <table class="surrounding-table">
        <thead>
          <tr>
            <th>順位</th>
            <th>候補者</th>
            <th class="num">得票数</th>
            <th class="num">本人との差</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

/**
 * 候補者1名の戦況区分を判定（サマリ集計と候補者カード表示で共通利用）
 * - confirmed : 当確（開票確定で定数内、または開票率50%以上かつ 次点との差 > 残り見込み票×1.15）
 * - likely    : 見込み〇（定数内で一定の余裕あり）
 * - borderline: 当落線上（定数付近の接戦・同票タイ）
 * - outside   : 圏外（定数外で距離あり、または確定落選）
 * - pending   : 開票前・未集計
 */
function classifyCandidateBattle(w, election) {
  if (!w.found || w.rank === null) return 'pending';

  const isFinal = election.status === 'final' || election.progress_pct === 100;
  const inSeats = w.rank <= election.seats;
  const rem = election.remaining_votes_estimate;
  const progress = election.progress_pct ?? 0;

  if (isFinal) {
    return inSeats ? 'confirmed' : 'outside';
  }

  // 序盤の丸め誤差による誤当確を防ぐため、開票率50%以上かつ1.15倍の安全マージンで判定
  if (
    inSeats &&
    progress >= 50 &&
    rem !== null &&
    rem !== undefined &&
    w.diff_from_cutoff !== null &&
    w.diff_from_cutoff > rem * 1.15
  ) {
    return 'confirmed';
  }

  const rankGap = election.seats - w.rank; // >= 0: 定数内, < 0: 圏外
  const absDiff = w.diff_from_cutoff !== null ? Math.abs(w.diff_from_cutoff) : null;
  const cutoffBase = election.seat_cutoff_votes || 1000;
  const closeVoteThreshold = Math.max(50, Math.round(cutoffBase * 0.03));

  if (inSeats) {
    // 同票タイ、または定数ギリギリ（下位2位以内・僅差）は当落線上
    if (
      w.diff_from_cutoff === 0 ||
      rankGap <= 1 ||
      (absDiff !== null && absDiff <= closeVoteThreshold)
    ) {
      return 'borderline';
    }
    return 'likely';
  } else {
    // 圏外で残り票より大幅に離れていれば明確に圏外
    if (progress >= 50 && rem !== null && rem !== undefined && absDiff !== null && absDiff > rem * 1.15) {
      return 'outside';
    }
    // 定数直下（2位以内）または僅差なら当落線上
    if (rankGap >= -2 || (absDiff !== null && absDiff <= closeVoteThreshold * 1.5)) {
      return 'borderline';
    }
    return 'outside';
  }
}

const BATTLE_META = {
  confirmed: { label: '当確', zoneClass: 'zone-safe', pillClass: 'diff-safe' },
  likely: { label: '見込み〇', zoneClass: 'zone-likely', pillClass: 'diff-likely' },
  borderline: { label: '当落線上', zoneClass: 'zone-borderline', pillClass: 'diff-borderline' },
  outside: { label: '圏外', zoneClass: 'zone-outside', pillClass: 'diff-outside' },
  pending: { label: '', zoneClass: 'zone-unknown', pillClass: '' },
};

function getElectionMascots(election) {
  const total = (election.watched_summaries || []).length;
  const c = summarizeBattle(election);
  const progress = election.progress_pct ?? 0;
  const isFinal = election.status === 'final' || progress >= 100;

  // 開票率100%（確定）: 1人以上当選なら万歳、0人当選なら拍手
  if (isFinal) {
    if (c.confirmed > 0) {
      return [{ src: './assets/usagi-banzai.png', alt: 'こくみんうさぎ（当選・万歳）' }];
    }
    return [{ src: './assets/usagi-clap.png', alt: 'こくみんうさぎ（拍手）' }];
  }

  // 開票が始まるまで（開票前・未集計）
  if (election.status === 'pre_count' || (progress === 0 && (election.counted_votes || 0) === 0)) {
    return [{ src: './assets/usagi-pray.png', alt: 'こくみんうさぎ（祈願）' }];
  }

  // 開票率70%超〜100%未満は終盤の祈願に戻す
  if (progress > 70) {
    return [{ src: './assets/usagi-pray.png', alt: 'こくみんうさぎ（祈願）' }];
  }

  // 開票開始〜開票率50%まで
  if (progress <= 50) {
    return [{ src: './assets/usagi-otsukare.png', alt: 'こくみんうさぎ（おつかれさまです）' }];
  }

  // 開票率50%超〜70%まで
  return [{ src: './assets/usagi-cheer.png', alt: 'こくみんうさぎ（フレッフレッ）' }];
}

function renderWatchedCandidate(w, election) {
  const battle = classifyCandidateBattle(w, election);
  const meta = BATTLE_META[battle] || BATTLE_META.pending;
  let diffHtml = '<span class="diff-label">集計待ち</span>';

  if (w.found && w.diff_from_cutoff !== null) {
    diffHtml = `
      <span class="diff-pill ${meta.pillClass}">${fmtSigned(w.diff_from_cutoff)}</span>
      <span class="diff-label">${escapeHtml(w.cutoff_label || '')}</span>
    `;
  }

  const candMascotHtml =
    battle === 'confirmed'
      ? `<img src="./assets/usagi-clap.png" alt="当確拍手" class="cand-mascot">`
      : battle === 'pending'
      ? `<img src="./assets/usagi-pray.png" alt="開票待機" class="cand-mascot">`
      : '';

  const seatGapText = w.found
    ? w.rank <= election.seats
      ? `定数まで余裕 ${election.seats - w.rank}人`
      : `定数まであと ${w.rank - election.seats}人`
    : '';

  const rankLine = w.found
    ? `
      <div class="cand-rank-hero">
        <span class="cand-rank-num zone-text-${battle}">${w.rank}<small>位</small></span>
        <span class="cand-seats-denom">/ 定数<strong>${election.seats}</strong></span>
        ${meta.label ? `<span class="zone-chip ${meta.pillClass}">${meta.label}</span>` : ''}
      </div>
      <div class="cand-sub-metrics">
        <strong>${fmtNum(w.votes)}票</strong> ・ 立候補${election.total_candidates}人中 ・ ${seatGapText}
      </div>
    `
    : `
      <div class="cand-rank-hero">
        <span class="cand-seats-denom">定数<strong>${election.seats}</strong> / 立候補${election.total_candidates}人</span>
      </div>
      <div class="cand-sub-metrics">開票待ち</div>
    `;

  return `
    <div class="candidate-block">
      <div class="candidate-summary ${meta.zoneClass}">
        <div class="cand-left">
          ${candMascotHtml}
          <div class="cand-main">
            <div class="cand-name">
              ${escapeHtml(w.name)}
              ${w.status_tag ? `<span class="cand-tag">${escapeHtml(w.status_tag)}</span>` : ''}
            </div>
            ${rankLine}
          </div>
        </div>
        <div class="cand-diff">${diffHtml}</div>
      </div>
      ${renderSurrounding(w, election.seats)}
    </div>
  `;
}

function summarizeBattle(election) {
  const counts = {
    confirmed: 0,
    likely: 0,
    borderline: 0,
    outside: 0,
    pending: 0,
  };
  for (const w of election.watched_summaries || []) {
    const k = classifyCandidateBattle(w, election);
    counts[k] += 1;
  }
  return counts;
}

const CRITERIA_TOOLTIP =
  '当確: 確定で定数内、または開票率50%以上かつ次点との差＞残り見込み票×1.15 / 見込み〇: 定数内で余裕あり / 当落線上: 定数付近の接戦 / 圏外: 定数外（クリックで詳細）';

function renderBattleSummaryBox(election) {
  const total = (election.watched_summaries || []).length;
  const c = summarizeBattle(election);
  const helpBtn = `<button type="button" class="help-btn" data-open-criteria="true" title="${CRITERIA_TOOLTIP}" aria-label="判定条件を表示">?</button>`;

  if (total === 0) {
    return `
      <div class="kpi-box kpi-battle">
        <div class="kpi-label kpi-label-row"><span>戦況サマリ</span>${helpBtn}</div>
        <div class="battle-pending">注目候補未登録</div>
      </div>
    `;
  }

  if (c.pending === total) {
    return `
      <div class="kpi-box kpi-battle">
        <div class="kpi-label kpi-label-row"><span>戦況サマリ（対象${total}名）</span>${helpBtn}</div>
        <div class="battle-pending">開票待機中（${total}名）</div>
      </div>
    `;
  }

  return `
    <div class="kpi-box kpi-battle">
      <div class="kpi-label kpi-label-row"><span>戦況サマリ（対象${total}名）</span>${helpBtn}</div>
      <div class="battle-chips">
        <span class="b-chip b-confirmed ${c.confirmed === 0 ? 'b-zero' : ''}">当確 ${c.confirmed}</span>
        <span class="b-chip b-likely ${c.likely === 0 ? 'b-zero' : ''}">見込み〇 ${c.likely}</span>
        <span class="b-chip b-border ${c.borderline === 0 ? 'b-zero' : ''}">当落線上 ${c.borderline}</span>
        <span class="b-chip b-struggle ${c.outside === 0 ? 'b-zero' : ''}">圏外 ${c.outside}</span>
      </div>
    </div>
  `;
}

function renderElectionCard(e, showPinButton = false) {
  const progressText = e.progress_pct !== null && e.progress_pct !== undefined ? `${e.progress_pct}%` : '--';
  const progressWidth = e.progress_pct !== null && e.progress_pct !== undefined ? Math.min(100, Math.max(0, e.progress_pct)) : 0;
  const remainingText =
    e.remaining_votes_estimate !== null && e.remaining_votes_estimate !== undefined
      ? `約 ${fmtNum(e.remaining_votes_estimate)}票`
      : '--';

  const isExpanded = state.expandedIds.has(e.id);
  const isPinned = state.pinnedIds.has(e.id);
  const watchCount = (e.watched_summaries || []).length;
  const watchedHtml = isExpanded
    ? (e.watched_summaries || []).map((w) => renderWatchedCandidate(w, e)).join('')
    : '';

  const mascotsHtml = getElectionMascots(e)
    .map((m) => `<img src="${m.src}" alt="${escapeHtml(m.alt)}" class="election-mascot">`)
    .join('');

  const pinBtnHtml = showPinButton
    ? `<button type="button" class="pin-btn ${isPinned ? 'is-pinned' : ''}" data-pin-id="${escapeHtml(e.id)}" title="${isPinned ? 'ピン留め解除' : '最上部にピン留め'}" aria-label="ピン留め">${isPinned ? '★' : '☆'}</button>`
    : '';

  return `
    <article class="election-card ${e.status === 'final' ? 'card-final' : ''}">
      <div class="election-head">
        <div class="election-title-row">
          <div class="election-title-left">
            <div class="election-mascots">${mascotsHtml}</div>
            <div>
              <h2 class="election-name">${escapeHtml(e.prefecture)} ${escapeHtml(e.name)}</h2>
              <p class="election-meta">
                投開票日: ${escapeHtml(e.election_date)} / 選管発表: ${escapeHtml(e.official_updated_at || '未取得')}
              </p>
            </div>
          </div>
          <div class="title-right-actions">
            ${pinBtnHtml}
            ${statusBadge(e.status)}
          </div>
        </div>

        <div class="kpi-grid">
          <div class="kpi-box">
            <div class="kpi-label">定数 / 立候補</div>
            <div class="kpi-value">${e.seats} / ${e.total_candidates}人</div>
            <div class="kpi-sub">落選 ${Math.max(0, e.total_candidates - e.seats)}人</div>
          </div>
          <div class="kpi-box">
            <div class="kpi-label">開票率</div>
            <div class="kpi-value">${progressText}</div>
            <div class="kpi-sub">開票済 ${fmtNum(e.counted_votes)}票</div>
          </div>
          <div class="kpi-box">
            <div class="kpi-label">残り見込み票</div>
            <div class="kpi-value">${remainingText}</div>
            <div class="kpi-sub">${escapeHtml(e.remaining_basis || '発表待ち')}</div>
          </div>
          ${renderBattleSummaryBox(e)}
        </div>

        <div class="progress-track" aria-label="開票率バー">
          <div class="progress-fill" style="width: ${progressWidth}%"></div>
        </div>

        ${e.error_message ? `<div class="error-banner">${escapeHtml(e.error_message)}</div>` : ''}

        <button
          type="button"
          class="toggle-detail-btn ${isExpanded ? 'is-open' : ''}"
          data-toggle-id="${escapeHtml(e.id)}"
          aria-expanded="${isExpanded ? 'true' : 'false'}"
        >
          <span>${isExpanded ? '候補者・前後3名を閉じる' : `候補者・前後3名の詳細を開く（${watchCount}名）`}</span>
          <span class="toggle-chevron">${isExpanded ? '▲' : '▼'}</span>
        </button>
      </div>

      ${
        isExpanded
          ? `<div class="watched-list">${watchedHtml || '<div class="empty-box">注目候補が登録されていません</div>'}</div>`
          : ''
      }

      <div class="card-foot">
        <span>取得: ${fmtIso(e.fetched_at)}</span>
        <div>
          ${e.source_url ? `<a class="official-link" href="${escapeHtml(e.source_url)}" target="_blank" rel="noopener noreferrer">選管公式ページを開く ↗</a>` : ''}
        </div>
      </div>
    </article>
  `;
}

function sortElections(list) {
  return [...list].sort((a, b) => {
    // 1. ピン留め最優先
    const ap = state.pinnedIds.has(a.id) ? 0 : 1;
    const bp = state.pinnedIds.has(b.id) ? 0 : 1;
    if (ap !== bp) return ap - bp;

    // 2. 投開票日 降順（新しい選挙を常に上へ）
    const dateDiff = (b.election_date || '').localeCompare(a.election_date || '');
    if (dateDiff !== 0) return dateDiff;

    // 3. 同日内: 未確定を上段、確定済み(final)を下段
    const af = a.status === 'final' ? 1 : 0;
    const bf = b.status === 'final' ? 1 : 0;
    if (af !== bf) return af - bf;

    // 4. 同日・同ステータス内: 都道府県コード順（北→南）＞ 自治体名順で固定
    const prefDiff = getPrefRank(a.prefecture) - getPrefRank(b.prefecture);
    if (prefDiff !== 0) return prefDiff;
    return (a.municipality || a.name || '').localeCompare(b.municipality || b.name || '', 'ja');
  });
}

function renderStatusFilterBar(baseList) {
  const totalCount = baseList.length;
  const countingCount = baseList.filter((e) => e.status !== 'final').length;
  const finalCount = baseList.filter((e) => e.status === 'final').length;

  const chips = [
    { id: 'all', label: `すべて (${totalCount})` },
    { id: 'counting', label: `未確定のみ (${countingCount})` },
    { id: 'final', label: `確定済み (${finalCount})` },
  ];

  return `
    <div class="status-filter-bar" role="tablist" aria-label="開票状況絞り込み">
      ${chips
        .map(
          (c) => `
            <button
              type="button"
              class="filter-chip ${state.statusFilter === c.id ? 'is-active' : ''}"
              data-status-filter="${c.id}"
            >${c.label}</button>
          `
        )
        .join('')}
    </div>
  `;
}

function render() {
  const app = document.getElementById('app');
  if (!state.payload) return;

  const targetDate = getTargetElectionDateJst();
  const q = state.query.trim().toLowerCase();
  const baseList = (state.payload.elections || []).filter((e) => {
    if (state.selectedEventId === 'TODAY') {
      if (e.election_date !== targetDate) return false;
    } else if (state.selectedEventId !== 'ALL' && e.event_id !== state.selectedEventId) {
      return false;
    }
    if (!q) return true;
    const hay = [
      e.prefecture,
      e.municipality,
      e.name,
      ...(e.watched_summaries || []).map((w) => w.name),
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });

  if (baseList.length === 0) {
    app.innerHTML =
      state.selectedEventId === 'TODAY'
        ? `<div class="empty-box">本日（${escapeHtml(targetDate)}）の開票対象選挙はありません。<br>上のプルダウンから過去の選挙イベントを選択できます。</div>`
        : '<div class="empty-box">該当する選挙データがありません。</div>';
    return;
  }

  const showMultiControls = baseList.length >= 2;
  const filtered = sortElections(
    baseList.filter((e) => {
      if (!showMultiControls || state.statusFilter === 'all') return true;
      if (state.statusFilter === 'counting') return e.status !== 'final';
      if (state.statusFilter === 'final') return e.status === 'final';
      return true;
    })
  );

  const filterBarHtml = showMultiControls ? renderStatusFilterBar(baseList) : '';
  const cardsHtml =
    filtered.length > 0
      ? filtered.map((e) => renderElectionCard(e, showMultiControls)).join('')
      : '<div class="empty-box">この条件に該当する選挙はありません。</div>';

  app.innerHTML = filterBarHtml + cardsHtml;
}

function populateEvents(events) {
  const sel = document.getElementById('event-select');
  const targetDate = getTargetElectionDateJst();
  const options = [
    `<option value="TODAY">本日の開票対象（${escapeHtml(targetDate)}）</option>`,
    '<option value="ALL">すべての選挙イベント</option>',
  ];
  for (const ev of events || []) {
    options.push(`<option value="${escapeHtml(ev.id)}">${escapeHtml(ev.name)}</option>`);
  }
  sel.innerHTML = options.join('');
  sel.value = state.selectedEventId;
}

async function loadData() {
  const btn = document.getElementById('reload-btn');
  btn.disabled = true;
  btn.textContent = '読込中...';

  try {
    const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    state.payload = payload;

    document.getElementById('party-label').textContent = payload.party?.name
      ? `対象: ${payload.party.name}（公認・推薦候補）`
      : '地方選トラッカー';
    document.getElementById('generated-at').textContent = `データ生成: ${fmtIso(payload.generated_at)}`;

    const modeBadge = document.getElementById('mode-badge');
    if (payload.mode === 'demo') {
      modeBadge.classList.remove('hidden');
    } else {
      modeBadge.classList.add('hidden');
    }

    if (!state.initializedSelection) {
      const targetDate = getTargetElectionDateJst();
      const hasToday = (payload.elections || []).some((e) => e.election_date === targetDate);
      state.selectedEventId = hasToday ? 'TODAY' : 'ALL';
      state.initializedSelection = true;
    }

    populateEvents(payload.events);
    render();
  } catch (err) {
    document.getElementById('app').innerHTML = `
      <div class="empty-box">
        データの読み込みに失敗しました (${escapeHtml(err.message)})。<br>
        ローカルで直接ファイルを開いた場合は簡易サーバー経由でご覧ください。
      </div>
    `;
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ 更新';
  }
}

document.getElementById('reload-btn').addEventListener('click', loadData);
document.getElementById('event-select').addEventListener('change', (ev) => {
  state.selectedEventId = ev.target.value;
  state.statusFilter = 'all';
  render();
});
document.getElementById('search-input').addEventListener('input', (ev) => {
  state.query = ev.target.value;
  render();
});
document.getElementById('app').addEventListener('click', (ev) => {
  const filterBtn = ev.target.closest('[data-status-filter]');
  if (filterBtn) {
    state.statusFilter = filterBtn.getAttribute('data-status-filter');
    render();
    return;
  }
  const pinBtn = ev.target.closest('[data-pin-id]');
  if (pinBtn) {
    const pinId = pinBtn.getAttribute('data-pin-id');
    if (state.pinnedIds.has(pinId)) {
      state.pinnedIds.delete(pinId);
    } else {
      state.pinnedIds.add(pinId);
    }
    savePinnedIds(state.pinnedIds);
    render();
    return;
  }
  if (ev.target.closest('[data-open-criteria]')) {
    document.getElementById('criteria-modal').classList.remove('hidden');
    return;
  }
  const btn = ev.target.closest('[data-toggle-id]');
  if (!btn) return;
  const id = btn.getAttribute('data-toggle-id');
  if (state.expandedIds.has(id)) {
    state.expandedIds.delete(id);
  } else {
    state.expandedIds.add(id);
  }
  render();
});

const criteriaModal = document.getElementById('criteria-modal');
document.getElementById('criteria-close').addEventListener('click', () => {
  criteriaModal.classList.add('hidden');
});
criteriaModal.addEventListener('click', (ev) => {
  if (ev.target === criteriaModal) {
    criteriaModal.classList.add('hidden');
  }
});

loadData();
