/**
 * Google Apps Script (GAS) から GitHub Actions (workflow_dispatch) を定期実行するトリガー
 *
 * 【セットアップ】
 * 1. GAS の「プロジェクトの設定」→「スクリプト プロパティ」に以下を登録:
 *    - GITHUB_TOKEN : Fine-grained PAT (対象リポジトリの Actions: Read and write 権限)
 *    - GITHUB_OWNER : GitHubユーザー名 (例: fkzwyuki)
 *    - GITHUB_REPO  : リポジトリ名 (例: election-tracker)
 * 2. トリガー設定:
 *    - 実行する関数: triggerElectionUpdate
 *    - イベントのソース: 時間主導型
 *    - 時間ベースのトリガーのタイプ: 分ベースのタイマー → 10分おき または 15分おき
 *      ※ 自治体選管の更新間隔は多くが30分おき（早くて15分おき）のため、10〜15分おきが最適です。
 */

function triggerElectionUpdate() {
  const now = new Date();
  const jstHour = Number(Utilities.formatDate(now, 'Asia/Tokyo', 'H'));

  // 開票時間帯（20:00〜翌2:59）以外は自動スキップ（手動テスト時はこの if をコメントアウト）
  const isCountingHours = jstHour >= 20 || jstHour <= 2;
  if (!isCountingHours) {
    Logger.log('開票時間帯外のためスキップしました (JST ' + jstHour + '時)');
    return;
  }

  dispatchWorkflow(false);
}

/**
 * 時間帯に関係なく手動で1回実行したいとき用
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
  const ref = 'main'; // master の場合は 'master' に変更

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
