export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/proxy") {
      return handleProxy(request, url);
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleProxy(request, url) {
  const target = url.searchParams.get("url");
  if (!target) {
    return new Response("url パラメータが必要です (例: /proxy?url=https://example.com)", { status: 400 });
  }
  if (!/^https?:\/\//i.test(target)) {
    return new Response("url は http:// または https:// で始めてください", { status: 400 });
  }

  const init = {
    method: request.method,
    headers: {},
    redirect: "follow",
  };
  for (const [k, v] of request.headers.entries()) {
    const lk = k.toLowerCase();
    if (["host", "connection", "content-length", "transfer-encoding"].includes(lk)) continue;
    init.headers[k] = v;
  }
  init.headers["User-Agent"] =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method.toUpperCase())) {
    init.body = await request.arrayBuffer();
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (e) {
    return new Response("上流サーバへの接続に失敗しました: " + e.message, { status: 502 });
  }

  const contentType = upstream.headers.get("Content-Type") || "";
  const isHtml = contentType.includes("text/html");

  const outHeaders = new Headers(upstream.headers);
  outHeaders.delete("Content-Security-Policy");
  outHeaders.delete("X-Frame-Options");
  outHeaders.delete("Content-Security-Policy-Report-Only");
  outHeaders.set("Access-Control-Allow-Origin", "*");
  outHeaders.set("Cache-Control", "no-store");

  if (!isHtml) {
    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  }

  const rewriter = new HTMLRewriter()
    .on("a[href]", new ProxyAttrRewriter("href"))
    .on("link[href]", new ProxyAttrRewriter("href"))
    .on("script[src]", new ProxyAttrRewriter("src"))
    .on("img[src]", new ProxyAttrRewriter("src"))
    .on("iframe[src]", new ProxyAttrRewriter("src"))
    .on("form[action]", new ProxyFormRewriter())
    .on("base[href]", new ProxyAttrRewriter("href"));

  const transformed = rewriter.transform(upstream);
  return new Response(transformed.body, { status: upstream.status, headers: outHeaders });
}

class ProxyAttrRewriter {
  constructor(attrName) { this.attrName = attrName; }
  element(element) {
    const raw = element.getAttribute(this.attrName);
    if (!raw) return;
    if (raw.startsWith("/proxy?url=")) return;
    let absolute;
    try { absolute = new URL(raw, element.documentBaseURI).href; } catch (_) { return; }
    if (/^(javascript:|mailto:|tel:|#)/i.test(absolute)) return;
    element.setAttribute(this.attrName, "/proxy?url=" + encodeURIComponent(absolute));
  }
}

class ProxyFormRewriter {
  element(element) {
    const action = element.getAttribute("action") || "";
    const method = (element.getAttribute("method") || "GET").toUpperCase();
    let absoluteAction;
    try { absoluteAction = new URL(action || "/", element.documentBaseURI).href; } catch (_) { return; }
    if (/^(javascript:|mailto:|tel:|#)/i.test(absoluteAction)) return;
    element.setAttribute("action", "/proxy");
    element.setAttribute("method", "POST");
    const hiddenAction = `<input type="hidden" name="__proxy_target__" value="${escapeHtml(absoluteAction)}">`;
    const hiddenMethod = `<input type="hidden" name="__proxy_method__" value="${escapeHtml(method)}">`;
    element.prepend(hiddenAction + hiddenMethod, { html: true });
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
