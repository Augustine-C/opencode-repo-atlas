# opencode-repo-atlas

OpenCode 插件：为多仓库大项目提供统一的**相关仓库图谱**。在任一仓库打开 OpenCode 时，自动把关联仓库的本地 checkout 注入为 named references，并提供一个 Web 管理界面（仓库/分组/成对关联/单仓查询/全局关系图谱）。

## 特性

- **仓库身份**：以规范化 git remote URL 为 key（小写 host+path，去凭据/端口/`.git` 后缀），跨克隆、跨机器稳定
- **自动 references**：插件全局安装一次；在任一已注册仓库打开 OpenCode 时，自动把有效关联的仓库注入为 references（别名 = 仓库名），agent 上下文自动带上各仓库描述
- **两级关联粒度**：
  - 项目级分组（group）：组内仓库自动两两互连
  - 成对关联（edge）：仅 A↔B 生效，可带备注
- **单仓查询**：列出某仓库的有效关联及**关联来源**（来自哪个分组/哪条边）与本机路径状态
- **全局视图**：SVG 力导向节点图，分组着色，点击节点查看详情
- **全局注册表**：单一 JSON 文件（原子写入），本机 checkout 路径按主机名分桶，指向团队 meta-repo 内的文件即可提交共享
- **热更新**：注册表变化后 3s 内自动重算并 `reference.reload()`，新 prompt 立即生效

## 工作原理

```
在仓库 X 打开 OpenCode
  → git remote get-url origin → 规范化为 repo key
  → 若该 key 已注册：把本机路径登记进 checkouts[host]（幂等）
  → 有效关联 = 所在分组成员 ∪ 触及该仓库的成对边
  → 为每个有本机 checkout 的关联仓库注入一个 local reference
  → 未找到本机路径的关联仓库跳过（WebUI 顶部横幅提示）
```

references 通过 `ctx.reference.transform` 注入；transform 闭包每次重放时读取最新注册表，所以注册表变化后 `reference.reload()` 即可增删，无需重新注册。多个 OpenCode 实例通过轮询注册表文件 mtime 感知外部修改；WebUI 的修改在保存完成后触发同进程 references 即时刷新。

## 安装

```jsonc
// ~/.config/opencode/opencode.json —— 全局安装，所有项目生效
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-repo-atlas",
      "options": {
        "port": 4579,
        "registryPath": "~/.local/share/opencode/repo-atlas.json"
      }
    }
  ]
}
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `port` | `4579` | WebUI/API 端口；被占用时本实例让位（已有实例在服务，数据共享同一注册表，行为一致） |
| `registryPath` | `~/.local/share/opencode/repo-atlas.json`（遵循 `XDG_DATA_HOME`） | 注册表文件；指向团队 meta-repo 内的文件即可共享 |
| `roots` | `[]` | 约定根目录列表。注册表里没有某关联仓库的本机路径时，按 `<root>/<仓库名>` 兜底探测 |

## WebUI（图谱管理界面）

打开 `http://localhost:4579`：

- **仓库**：添加（粘贴 remote URL 或 `host/path`）、改名、描述（写给 agent 看）、本机 checkout 路径增删、删除（联动清理分组与边）
- **项目级关联（分组）**：创建分组、加入/移除成员、删除
- **成对关联**：选择两个仓库 + 备注，点对点互连
- **单仓查询**：按仓库列出有效关联，含来源与本机路径状态
- **全局视图**：节点图；分组着色，红圈 = 本机无 checkout；点击节点高亮邻居并显示详情，5s 自动刷新可关

顶部横幅会提示：当前仓库未注册（一键注册）、本机找不到 checkout 的关联仓库列表。

## HTTP API

| 方法 + 路径 | 说明 |
|---|---|
| `GET /api/state` | 注册表全量 + 当前实例身份（key/registered/missing）+ 主机名 |
| `GET /api/graph` | 节点/链路/分组（链路带聚合原因，用于图视图） |
| `GET /api/related?key=` | 单仓有效关联：name/description/via/本机 path |
| `POST /api/repos` | `{url}` / `{path}`（本机路径，自动探测 git remote 并登记 checkout）/ `{key}` + 可选 `name`、`description`；重复返回 409 |
| `PATCH /api/repos?key=` | 改 `name`/`description` |
| `DELETE /api/repos?key=` | 删除仓库并清理分组与边 |
| `POST /api/checkouts` | `{key, path}` 登记本机 checkout（路径必须存在，`~` 可用） |
| `DELETE /api/checkouts?key=&path=` | 移除本机 checkout |
| `POST /api/groups` | `{name, members?}` |
| `PATCH /api/groups?id=` | 改 `name`/`members` |
| `DELETE /api/groups?id=` | 删除分组 |
| `POST /api/edges` | `{a, b, note?}` |
| `DELETE /api/edges?index=` | 按下标删除边 |

错误统一为 `{ "error": "..." }` + 4xx/5xx。

## 注册表格式

```jsonc
{
  "version": 1,
  "repos": {
    "github.com/acme/billing": {
      "name": "billing",
      "description": "计费服务：发票、支付、对账",
      "checkouts": { "augustine-mbp": ["/Users/augustine/work/billing"] }
    }
  },
  "groups": [
    { "id": "payments", "name": "支付平台", "members": ["github.com/acme/billing", "github.com/acme/ledger"] }
  ],
  "edges": [
    { "a": "github.com/acme/billing", "b": "github.com/acme/docs", "note": "API 契约" }
  ]
}
```

损坏的注册表文件会被挪到 `*.corrupt-<ts>` 并从空注册表继续，不会丢盘。

## 团队共享

把 `registryPath` 指到一个 git 仓库里的文件（比如团队 meta-repo 的 `related.json`），正常提交推送即可。`checkouts` 按主机名分桶，成员各自维护各自的路径，互不冲突。

## 限制

- 只识别 `origin` remote；非 git / 无 origin 的目录不做 references 注入（WebUI 仍可用）
- key 小写化：依赖大小写区分路径的极端托管场景不适用
- 本地路径 / `file://` remote 不生成身份（身份必须是仓库级而非机器级）
- WebUI 的改名/改描述用 `prompt()` 对话框，checkout 管理仅针对当前主机（跨主机路径由各自主机登记）
- 分组是全互连：成员多了图会变密，点对点关系请用成对关联

## 开发

```sh
bun install
bun test          # 23 个测试：单测 + 集成（真实 git 仓库 + 假 ctx 跑完整 setup）
bun run typecheck
bun tests/smoke-server.ts   # 不依赖 OpenCode 单独起 WebUI 冒烟
```

MIT License.
