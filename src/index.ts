import dnsPacket from 'dns-packet';

// 为环境变量定义类型接口，增强代码健壮性
export interface Env {
  UPSTREAMS: string; // 逗号分隔的上游 DoH 服务器
  EDNS_HK?: string;
  EDNS_JP?: string;
  EDNS_US?: string;
  // 可以根据需要添加更多区域
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (e) {
      console.error("未处理的错误:", e);
      return new Response(e instanceof Error ? e.message : "Internal Server Error", { status: 500 });
    }
  },
};

async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const { method, headers, url } = request;
  const { pathname } = new URL(url);

  // 1. 根据请求路径确定 EDNS IP
  const ednsIp = getEdnsIpForPath(pathname, env);
  if (!ednsIp) {
    return new Response(`路径 ${pathname} 未配置 EDNS。请使用 /hk-query, /jp-query, 或 /us-query。`, { status: 404 });
  }

  // 2. 从请求中获取原始 DNS 查询
  let queryBuffer: ArrayBuffer;
  if (method === 'POST' && headers.get('content-type') === 'application/dns-message') {
    queryBuffer = await request.arrayBuffer();
  } else if (method === 'GET') {
    const dnsQueryParam = new URL(url).searchParams.get('dns');
    if (!dnsQueryParam) {
      return new Response('GET 请求缺少 "dns" 查询参数。', { status: 400 });
    }
    // Base64URL 解码
    const base64 = dnsQueryParam.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const array = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      array[i] = raw.charCodeAt(i);
    }
    queryBuffer = array.buffer;
  } else {
    return new Response('不支持的请求方法或 Content-Type。请使用 GET 或 POST (application/dns-message)。', { status: 400 });
  }

  // 3. 优先检查缓存
  const cache = caches.default;
  // 基于查询内容和 EDNS IP 创建唯一的缓存键
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = `/cache${cacheUrl.pathname}`; // 添加前缀以避免冲突
  const cacheKey = new Request(cacheUrl.toString(), {
    headers: { 'Content-Type': 'application/dns-message' },
    method: 'POST',
    body: queryBuffer,
  });

  let response = await cache.match(cacheKey);
  if (response) {
    console.log(`缓存命中: ${pathname}`);
    const newHeaders = new Headers(response.headers);
    newHeaders.set('X-Dns-Cache', 'HIT');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  }
  console.log(`缓存未命中: ${pathname}`);

  // 4. 如果缓存未命中，修改 DNS 包以注入 EDNS 信息
  let modifiedQueryPacket: Buffer;
  try {
    const decodedPacket = dnsPacket.decode(Buffer.from(queryBuffer));

    // 查找或创建 OPT 记录
    let optRecord = decodedPacket.additionals?.find(r => r.type === 'OPT');
    if (!optRecord) {
      optRecord = { name: '.', type: 'OPT', udpPayloadSize: 4096, flags: 0, options: [] };
      decodedPacket.additionals = decodedPacket.additionals || [];
      decodedPacket.additionals.push(optRecord);
    }
    
    optRecord.options = optRecord.options || [];

    // 移除任何已存在的 ECS 选项
    optRecord.options = optRecord.options.filter(opt => opt.code !== 8);

    // 添加新的 ECS 选项 (为了隐私，通常使用 /24 子网掩码)
    optRecord.options.push({
      code: 8, // EDNS Client Subnet (ECS)
      ip: ednsIp,
      sourcePrefixLength: 24,
      scopePrefixLength: 0,
    });

    modifiedQueryPacket = dnsPacket.encode(decodedPacket);
  } catch (err) {
    console.error("DNS 包处理错误:", err);
    return new Response('解析或修改 DNS 查询包失败。', { status: 400 });
  }

  // 5. 并发查询所有上游服务器
  const upstreams = (env.UPSTREAMS || 'https://1.1.1.1/dns-query,https://8.8.8.8/dns-query').split(',').map(s => s.trim());
  
  const upstreamPromises = upstreams.map(upstreamUrl => 
    fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/dns-message',
        'Accept': 'application/dns-message',
      },
      body: modifiedQueryPacket,
    }).then(res => {
      if (!res.ok) {
        throw new Error(`上游 ${upstreamUrl} 响应失败，状态码: ${res.status}`);
      }
      return res;
    })
  );

  try {
    const firstSuccessfulResponse = await Promise.any(upstreamPromises);
    
    // 克隆响应头，以便我们可以安全地修改它
    const finalResponseHeaders = new Headers(firstSuccessfulResponse.headers);
    finalResponseHeaders.set('X-Dns-Cache', 'MISS'); // 明确是缓存未命中
    finalResponseHeaders.set('X-Dns-Upstream', firstSuccessfulResponse.url); // 记录实际使用的上游

    // 创建最终要返回给客户端的响应。
    // 注意：一个响应体 (ReadableStream) 只能被使用一次。
    const finalResponse = new Response(firstSuccessfulResponse.body, {
        status: firstSuccessfulResponse.status,
        statusText: firstSuccessfulResponse.statusText,
        headers: finalResponseHeaders,
    });

    // 将响应的克隆版本放入缓存，因为原始响应体即将被发送给客户端。
    // .clone() 是处理 "body used already" 错误的关键。
    ctx.waitUntil(cache.put(cacheKey, finalResponse.clone()));

    return finalResponse;

  } catch (error) {
    if (error instanceof AggregateError) {
      console.error("所有上游服务器均查询失败，具体错误如下:", error.errors);
    } else {
      console.error("查询上游服务器时发生未知错误:", error);
    }
    return new Response('所有上游 DNS 服务器均未能响应。', { status: 502 });
  }
}

const PATH_TO_ENV_MAP: { [key: string]: keyof Env } = {
  '/hk-query': 'EDNS_HK',
  '/jp-query': 'EDNS_JP',
  '/us-query': 'EDNS_US',
};

/**
 * 将请求路径映射到环境变量中配置的 EDNS IP 地址。
 * @param pathname 请求 URL 的路径 (例如, "/hk-query")。
 * @param env Worker 的环境变量。
 * @returns IP 地址字符串，如果未找到则返回 null。
 */
function getEdnsIpForPath(pathname: string, env: Env): string | null {
  const envVarName = PATH_TO_ENV_MAP[pathname];
  return envVarName ? (env[envVarName] || null) : null;
}