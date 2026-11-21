/**
 * Google Apps Script (GAS) から GitHub Actions (workflow_dispatch) を定期実行するトリガー
 *
 * 【特徴：GAS側の書き換え不要！】
 * - 公開サイト上の latest.json から「投開票日 (election_date)」と「開票ステータス (status)」を自動取得します。
 * - 「投開票日の 20:00〜翌2:59」かつ「まだ確定(final)していない選挙があるとき」だけ GitHub Actions を起動します。
 * - 選挙のない日（平日・週末問わず）や、全選挙区が確定した後は自動でスキップするため、
 *   トリガーを15分おきで付けっぱなしにしても無駄な実行が起きません（離島の平日投票日なども自動対応）。
 *
 * 【スクリプト プロパティ（プロジェクトの設定）】
 * - GITHUB_TOKEN : Fine-grained PAT (対象リポジトリの Actions: Read and write 権限)
 * - GITHUB_OWNER : GitHubユーザー名 (例: fkzwyuki)
 * - GITHUB_REPO  : リポジトリ名 (例: election-tracker)
 * - DATA_URL     : (任意) 公開サイトの latest.json URL
 *                  未設定時は https://election-tracker-dpfp.pages.dev/data/latest.json を使用
 */

const DEFAULT_DATA_URL = 'https://election-tracker-dpfp.pages.dev/data/latest.json';

function triggerElectionUpdate() {
  const now = new Date();
  const jstHour = Number(Utilities.formatDate(now, 'Asia/Tokyo', 'H'));

  // 1. 開票時間帯（20:00〜翌2:59）以外は通信すらせず即スキップ
  const isCountingHours = jstHour >= 20 || jstHour <= 2;
  if (!isCountingHours) {
    Logger.log('開票時間帯外のためスキップしました (JST ' + jstHour + '時)');
    return;
  }

  // 2. 判定対象の投開票日（0:00〜2:59は前日の選挙が継続中とみなす）
  const baseDate = new Date(now.getTime());
  if (jstHour <= 2) {
    baseDate.setDate(baseDate.getDate() - 1);
  }
  const targetDate = Utilities.formatDate(baseDate, 'Asia/Tokyo', 'yyyy-MM-dd');

  // 3. 公開サイトの latest.json を確認し、本日分の未確定選挙があるかチェック
  if (!hasPendingElectionOnDate(targetDate)) {
    Logger.log(targetDate + ' の未確定選挙がないためスキップしました');
    return;
  }

  Logger.log(targetDate + ' の開票対象を検知 → GitHub Actions を起動します');
  dispatchWorkflow(false);
}

/**
 * 公開サイトの latest.json から、指定日に未確定（final以外）の選挙があるか判定
 */
function hasPendingElectionOnDate(targetDate) {
  const props = PropertiesService.getScriptProperties();
  const dataUrl = props.getProperty('DATA_URL') || DEFAULT_DATA_URL;

  try {
    const res = UrlFetchApp.fetch(dataUrl + '?t=' + Date.now(), {
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('latest.json 取得失敗 (' + res.getResponseCode() + ') -> 念のためスキップ');
      return false;
    }
    const json = JSON.parse(res.getContentText());
    const elections = json.elections || [];

    return elections.some(function (e) {
      return e.election_date === targetDate && e.status !== 'final';
    });
  } catch (err) {
    Logger.log('latest.json 解析エラー: ' + err.message);
    return false;
  }
}

/**
 * 日付・時間帯に関係なく手動で1回実行したいとき用（テスト・緊急時）
 */
function manualTriggerNow() {
  dispatchWorkflow(false);
}

function dispatchWorkflow(includeAll) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('GITHUB_TOKEN');
  const owner = props.getProperty('GITHUB_OWNER');
  const repo = props.getProperty('GITHUB_REPO');
  const workflowFile = 'update.yml';
  const ref = 'main';

  if (!token || !owner || !repo) {
    throw new Error('スクリプトプロパティ (GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO) を設定してください。');
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;
  const payload = {
    ref: ref,
    inputs: {
      include_all: includeAll ? 'true' : 'false',
    },
  };

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  Logger.log('Status: ' + res.getResponseCode() + ' ' + res.getContentText());
}
