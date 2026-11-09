// PullBot review bodies as posted on sophos-education/studia-web PR #2640: the opening lines of its
// round-5 review at 5e40b28 (markers, heading and providers line, verbatim), and an approval body.
export const PULLBOT_SHA = '5e40b28428c51d81e7cb80ff312f6b8418ac4345';
export const PULLBOT_CLEAN_COUNTS = 'p0=0 p1=0 p2=0 deferred=0 gaps=0';

// The round-5 body with its marker's sha and counts replaceable, so one fixture gives every case.
export const pullbotRound = (sha = PULLBOT_SHA, counts = PULLBOT_CLEAN_COUNTS) => [
  '<!-- pullbot:local -->',
  `<!-- pullbot:verdict v=1 sha=${sha} ${counts} vendor=codex-cross rounds=5 -->`,
  '🌿 **Local review, round 5: no P0, P1 or P2 findings at `5e40b2842`** · 🔀 **cross-provider: Claude + Codex**',
  '<sub>providers: Claude — correctness, intent, security, tests, premises, states · trimmed: frontend · Codex — read the diff cold (no findings)</sub>',
].join('\n');

export const PULLBOT_APPROVAL = '🌿 Approved by PullBot: my local review at `5e40b28` found no P0, P1 or P2 findings and nothing deferred.';
