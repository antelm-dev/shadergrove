import { execFileSync } from 'node:child_process';
const pr = process.env.PR_NUMBER;
if (!/^[1-9]\d*$/.test(pr)) throw new Error('Invalid PR number');
const marker = '<!-- shadergrove-pr-preview -->';
const url = `https://pr-${pr}.45-155-170-120.sslip.io/`;
let body;
if (process.env.PREVIEW_ACTION === 'deploy' && process.env.DEPLOY_RESULT === 'success') {
  body = `Preview ready: [Open Studio](${url})\n\nTested merge commit: \`${process.env.COMMIT_SHA}\`. This environment has its own database and test email capture.`;
} else if (process.env.PREVIEW_ACTION === 'delete' && process.env.CLEANUP_RESULT === 'success') {
  body = 'Preview removed. Its temporary database and test emails have been deleted.';
} else if (process.env.PREVIEW_ACTION === 'none') {
  body = `${process.env.PREVIEW_REASON}\n\nAny previous preview still represents its last successfully deployed commit.`;
} else {
  body = `Preview deployment or cleanup failed. [View workflow](${process.env.WORKFLOW_URL}). A previous preview may still represent an older commit.`;
}
const comments = JSON.parse(
  execFileSync(
    'gh',
    [
      'api',
      '--paginate',
      '--slurp',
      `repos/${process.env.GITHUB_REPOSITORY}/issues/${pr}/comments`,
    ],
    { encoding: 'utf8' },
  ),
).flat();
const previous = comments.find(
  (comment) => comment.user.login === 'github-actions[bot]' && comment.body.includes(marker),
);
const endpoint = previous ? `issues/comments/${previous.id}` : `issues/${pr}/comments`;
const response = await fetch(
  `${process.env.GITHUB_API_URL || 'https://api.github.com'}/repos/${process.env.GITHUB_REPOSITORY}/${endpoint}`,
  {
    method: previous ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body: `${marker}\n${body}` }),
    signal: AbortSignal.timeout(15_000),
  },
);
if (!response.ok) throw new Error(`Preview comment failed: HTTP ${response.status}`);
