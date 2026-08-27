# 白嫖 API 速查

每日验证 · 死链可见 · 额度横向比。免费 AI API 站点速查。

- 线上地址：https://free.eforge.xyz/
- 管理后台：https://free.eforge.xyz/admin.html
- 数据文件：`frontend/broadcast/data/sites.json`
- 公告文件：`frontend/broadcast/data/notice.md`

## 本地预览

```bash
cd frontend && npm run dev
# 访问 http://localhost:5173/_app/
```

## 构建部署

```bash
cd frontend && npm run build
# 产物在 frontend/dist/，按 Worker 部署流程上传
```

## 技术栈

- 前端：Vite + vanilla JS，模块化源码在 `frontend/src/broadcast/`
- 后端：Cloudflare Worker + D1
- 构建：`npm run build` 自动拼接 broadcast/*.js → main.js 并打包

