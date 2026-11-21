# dsh-sidebar-usage

Sidebar usage HUD for **DeepSeek Harness** — a balance/quota card pinned to the sidebar footer, plus a hover-out drawer that collects the other footer entries.

侧栏用量看板插件：在看板里显示余额 / 订阅额度 / 累计 token / 调用次数，并带一个贴边隐藏、鼠标移入滑出的入口抽屉。

## 特性 / Features

- **多提供商余额**：DeepSeek 官方、`new-api` 系中转（OpenAI 计费接口）、`/user/balance` 形态、任意自研网关（通用 JSON + 点路径取值）。
- **订阅卡 / 余额两种口径**：给 `totalPath` + `usedPath` 时算"已用 %"，给 `expiresPath` 时显示"剩 N 天"，卡片上标注类型。
- **站点口径统计**：中转站支持 `new-api` 的 `refresh` 会话时，可读「累计使用 token / 累计调用次数」，与站点后台同源（10 分钟缓存，轮换 cookie 自动回写）。
- **看板可调**：拖底部横条改高度、右键金额数字改字号，内容随高度缩放。
- **入口抽屉**：底栏其它按钮被收进左侧贴边抽屉，鼠标移入滑出、移出落回；每行几个可调（默认 3）。
- **自动识别**：模型设置里已添加的 provider（带 `baseURL`）会自动出现在看板右键菜单里，不用重复手填。
- **多账号**：自定义 provider 支持"余额接口"与"订阅接口"两套路径并存，设置页一键切换类型。

## 安装 / Install

```bash
# 从 npm
npm install dsh-sidebar-usage

# 或本地 tgz
npm install ./dsh-sidebar-usage-1.0.0.tgz
```

装完后在 DSH 插件设置里启用 `dsh-sidebar-usage`，重启 DSH web。首次使用在「设置 → 用量」里添加提供商：

| 字段 | 说明 |
|---|---|
| provider id | 必须与模型设置里的 provider id 一致 |
| 接口地址 | **只到域名**，例如 `https://your-relay.example.com` |
| 接口类型 | `OpenAI 计费接口`（new-api 系）/ `DeepSeek /user/balance` / `通用 JSON` |
| 凭据引用 | 可以是环境变量名（`MY_RELAY_KEY`）或直接粘贴密钥 |

`通用 JSON` 需要自己填接口路径与字段路径（点路径，数组用 `.0` 或 `[0]`，例如 `data.balance`）。

## 配置示例

```yaml
- id: deepseek-usage
  name: "dsh-sidebar-usage"
  config:
    customProviders:
      - provider: my-relay
        label: 我的中转
        baseUrl: https://relay.example.com
        preset: newapi            # newapi | openai-billing | deepseek-balance | jichuanai | json
        currency: CNY
        apiKeyRef: MY_RELAY_KEY
```

## 说明 / Notes

- 站点口径的「累计 token / 调用次数」需要中转站登录态（cookie 或 token）。凭证只存在本机 `.credentials.yaml`，不会随包分发。
- 该插件通过"代理磁贴"的方式把底栏其它按钮收进抽屉：原按钮仍挂载，点击转调，弹层功能不受影响。

## License

MIT