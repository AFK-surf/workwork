# Admin Job Cancel

## 目标

Admin 会话详情里的后台任务取消按钮必须真正取消对应 session 的后台 job，而不是只更新前端状态或显示成功文案。

## 现状

后台取消入口是 `POST /admin/api/sessions/:sessionKey/jobs/:jobId/cancel`。这个请求由 admin service 转发到 worker 的 `/jobs/:jobId/admin-cancel`，worker 再通过 job manager 更新 job 状态并停止运行中的进程树。

前端按钮必须显式发送 `POST`。如果误发 `GET`，后端不会进入取消逻辑，job 会继续运行。

## 验收标准

- 取消按钮点击后发送 `POST /admin/api/sessions/:sessionKey/jobs/:jobId/cancel`。
- session key 和 job id 按 URL segment 编码。
- 成功后刷新当前 session summary 和 timeline。
- 失败时显示错误，不显示“已取消 job”。
- 现有 admin control-plane cancel e2e 继续通过。
