# 资源导航站模板

适用于：AI 工具导航、设计资源导航、开源项目导航、学习资源收集等。

## 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| name | text | ✅ | 资源名称（唯一） |
| url | url | ✅ | 资源链接（自动健康检查） |
| tags | tags | | 分类标签 |
| summary | textarea | | 简短描述（≤200字） |
| rating | rating | | 1-5星评分 |

## 快速开始

1. 将 `schema.json` 部署到 Worker 的 KV 中
2. 或通过 Admin 后台 → Schema 标签页导入
3. 通过 Admin 后台导入初始数据

## 自定义

编辑 `schema.json` 可以：
- 修改 `fields` 增减字段
- 修改 `tags` 调整标签选项
- 修改 `display` 调整展示布局
- 修改 `theme` 调整主题配色
