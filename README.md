# DNS-Proxy on Cloudflare Workers

[![Deploy with Wrangler](https://img.shields.io/badge/deploy-wrangler-f38020?logo=cloudflare)](https://developers.cloudflare.com/workers/wrangler/get-started/)

这是一个部署在 Cloudflare Workers 上的高性能 DNS-over-HTTPS (DoH) 代理。

它的核心功能是接收来自客户端的 DoH 请求，根据请求的 URL 路径（如 `/hk-query`），为该 DNS 查询**附加一个指定的 EDNS 客户端子网 (ECS) 信息**，然后将请求并发地发送给多个上游 DoH 服务器，并最终返回最快的结果。

这使得你可以“伪装”在特定地理位置（如香港、日本、美国）发起 DNS 查询，从而获取针对该地区优化的 CDN 节点 IP 或访问有地理限制的服务。

## ✨ 功能特性

- **地理位置解析**: 通过 `/hk-query`, `/jp-query`, `/us-query` 等不同路径，轻松获取不同地区的 DNS 解析结果。
- **智能 ECS 注入**: 自动解析并修改 DNS 请求包，添加或覆盖 EDNS Client Subnet 信息。
- **并发竞速**: 同时向上游多个 DoH 服务器发送请求，并采用最快返回的结果，极大提升解析速度和可用性。
- **高效缓存**: 利用 Cloudflare 的原生 Cache API 缓存 DNS 结果，重复查询响应迅速，并可通过 `X-Dns-Cache` 响应头查看缓存状态。
- **配置简单**: 所有上游服务器和 EDNS IP 均在 `wrangler.toml` 中通过环境变量配置，无需修改代码。
- **一键部署**: 使用 Cloudflare 官方的 Wrangler CLI 可轻松部署和管理。

## 🚀 部署指南 (使用 Wrangler 本地部署)

这是最推荐的部署方式，可以轻松管理配置和更新。

### 准备工作

1.  一个 Cloudflare 账户。
2.  Node.js (建议 v18 或更高版本) 和 npm。
3.  安装 Cloudflare Wrangler CLI：
    ```bash
    npm install -g wrangler
    ```

### 部署步骤

1.  **克隆本项目**
    ```bash
    git clone https://github.com/your-username/your-repo-name.git
    cd your-repo-name
    ```

2.  **安装依赖**
    ```bash
    npm install
    ```

3.  **登录 Cloudflare**
    此命令会打开浏览器，让你授权 Wrangler 访问你的 Cloudflare 账户。
    ```bash
    wrangler login
    ```

4.  **配置 `wrangler.toml`**
    打开 `wrangler.toml` 文件，根据你的需求进行修改：
    - **`name`**: 将 `dns-proxy` 修改为你想要的 Worker 名称，它将成为你 Worker URL 的一部分。
      ```toml
      name = "my-geo-dns"
      ```
    - **`[vars]`**: (可选) 你可以修改 `UPSTREAMS` 列表或各个地区的 `EDNS_*` IP 地址。

5.  **部署到 Cloudflare**
    ```bash
    wrangler deploy
    ```
    部署成功后，Wrangler 会在终端输出你的 Worker URL，例如 `https://my-geo-dns.your-username.workers.dev`。请记下这个地址。

## 💡 如何使用

部署成功后，你就可以在支持 DoH 的客户端（如 Clash.Meta, Sing-box）中使用了。

### URL 格式

`https://<你的Worker名称>.<你的子域名>.workers.dev/<地区>-query`

例如：
- 香港解析: `https://my-geo-dns.xxx.workers.dev/hk-query`
- 日本解析: `https://my-geo-dns.xxx.workers.dev/jp-query`
- 美国解析: `https://my-geo-dns.xxx.workers.dev/us-query`

### 使用 `curl` 测试

你可以使用 `curl` 来验证 Worker 是否正常工作。

```bash
# 测试香港解析 www.google.com
# URL中的 "dns" 参数是 DNS 查询包的 Base64URL 编码
curl -v "https://my-geo-dns.xxx.workers.dev/hk-query?dns=q80BAAABAAAAAAAAA3d3dwdnb29nbGUDY29tAAABAAE"
```

在响应头中，你应该能看到 `X-Dns-Cache: MISS` (首次) 或 `HIT` (后续)，以及 `X-Dns-Upstream` (实际响应的上游)。

## 🔧 扩展与自定义

### 如何增加一个新的区域 (例如：新加坡)

1.  **修改 `wrangler.toml`**
    在 `[vars]` 部分添加一个新的环境变量，并为其指定一个新加坡的 IP 地址。
    ```toml
    EDNS_SG = "1.16.0.0"
    ```

2.  **修改 `src/index.ts`**
    在 `PATH_TO_ENV_MAP` 对象中添加新的路径和变量的映射关系。
    ```typescript
    const PATH_TO_ENV_MAP: { [key: string]: keyof Env } = {
      '/hk-query': 'EDNS_HK',
      '/jp-query': 'EDNS_JP',
      '/us-query': 'EDNS_US',
      '/sg-query': 'EDNS_SG', // <-- 添加此行
    };
    ```

3.  **重新部署**
    ```bash
    wrangler deploy
    ```
    现在你就可以通过 `/sg-query` 路径来获取新加坡的 DNS 解析结果了。
