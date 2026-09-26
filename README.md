# opencode-related

OpenCode 插件：为多仓库大项目提供统一的相关仓库注册表，自动注入 references，并提供 Web 管理界面。

> 构建中 — 详见下方里程碑。

## 特性（规划）

- **仓库身份**：以规范化 git remote URL 为 key，跨克隆、跨机器稳定
- **自动 references**：在任一仓库打开 OpenCode 时，自动把关联仓库的本地 checkout 注入为 named references
- **两级关联粒度**：项目级分组（组内自动两两互连）+ 成对边（仅 A↔B）
- **Web UI**：仓库/分组/成对边管理、单仓关联查询（含关联来源）、全局节点图视图
- **全局注册表**：单一 JSON 文件，可指向团队 meta-repo 提交共享；本机 checkout 路径按主机名分桶

## 安装（规划）

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugins": [
    {
      "package": "opencode-related",
      "options": {
        "port": 4579,
        "registryPath": "~/.local/share/opencode/related-repos.json"
      }
    }
  ]
}
```
