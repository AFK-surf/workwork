# Feishu Smoke Evidence

- source: environment-preflight
- checked_at: 2026-05-30T07:47:46.534Z
- status: PASS

## Checks

| Status | Required | Check | Evidence |
| --- | --- | --- | --- |
| pass | yes | preflight.slack_credentials_present: Slack credentials are present for same-process regression smoke | SLACK_APP_TOKEN=set<br>SLACK_BOT_TOKEN=set |
| pass | yes | preflight.feishu_enabled: Feishu is enabled for rollout smoke | FEISHU_ENABLED=true |
| pass | yes | preflight.feishu_credentials_present: Feishu app credentials are present | FEISHU_APP_ID=set<br>FEISHU_APP_SECRET=set |
| pass | yes | preflight.feishu_bot_identity_present: Feishu bot identity is present for @bot mention detection | FEISHU_BOT_OPEN_ID=set<br>FEISHU_BOT_USER_ID=missing<br>FEISHU_BOT_UNION_ID=missing |
| pass | yes | scope.china_feishu: China Feishu is the configured Feishu-family target | FEISHU_DOMAIN=feishu |
| pass | yes | preflight.feishu_api_base_china: Feishu API base points at China Feishu Open Platform | FEISHU_API_BASE_URL=https://open.feishu.cn/open-apis<br>normalized_domain=https://open.feishu.cn |
| pass | yes | preflight.group_message_mode_all: All-group-message mode is selected for production parity smoke | FEISHU_GROUP_MESSAGE_MODE=all |
| pass | yes | preflight.startup_required: Feishu startup is strict for production rollout | FEISHU_STARTUP_REQUIRED=true |
| pass | yes | preflight.raw_feishu_events_disabled: Raw Feishu event logging is disabled | LOG_RAW_FEISHU_EVENTS=false |
| pass | no | preflight.admin_token_present: Broker admin token is present for protected evidence collection | BROKER_ADMIN_TOKEN=set |
| pass | no | preflight.all_message_delivery_flag: All-message delivery verification flag matches saved smoke evidence | FEISHU_ALL_MESSAGE_DELIVERY_VERIFIED=false |
