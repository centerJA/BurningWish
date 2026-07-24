export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/proxy") return handleProxy(request, url);
    return env.ASSETS.fetch(request);
  },
};

async function handleProxy(request, url) {
  const target = url.searchParams.get("url");
  if (!target) return new Response("url パラメータが必要です", { status: 400 });
  if (!/^https?:\/\//i.test(target)) return new Response("http/https で指定してください", { status: 400 });

  const init = { method: request.method, headers: {}, redirect: "follow" };
  for (const [k, v] of request.headers.entries()) {
    const lk = k.toLowerCase();
    if (["host", "connection", "content-length", "transfer-encoding", "cookie"].includes(lk)) continue;
    init.headers[k] = v;
  }
  init.headers["User-Agent"] =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
  init.headers["Accept"] = "*/*";
  init.headers["Referer"] = target;

  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method.toUpperCase())) {
    init.body = await request.arrayBuffer();
  }

  let upstream;
  try { upstream = await fetch(target, init); }
  catch (e) { return new Response("上流接続失敗: " + e.message, { status: 502 }); }

  const ct = upstream.headers.get("Content-Type") || "";
  const isHtml = ct.includes("text/html");

  const outHeaders = new Headers(upstream.headers);
  outHeaders.delete("Content-Security-Policy");
  outHeaders.delete("X-Frame-Options");
  outHeaders.delete("Content-Security-Policy-Report-Only");
  outHeaders.set("Access-Control-Allow-Origin", "*");
  outHeaders.set("Cache-Control", "no-store");

  if (!isHtml) return new Response(upstream.body, { status: upstream.status, headers: outHeaders });

  const rewriter = new HTMLRewriter()
    .on("a[href]", new AttrRewriter("href"))
    .on("link[href]", new AttrRewriter("href"))
    .on("script[src]", new AttrRewriter("src"))
    .on("img[src]", new AttrRewriter("src"))
    .on("img[srcset]", new SrcsetRewriter())
    .on("iframe[src]", new AttrRewriter("src"))
    .on("form[action]", new FormRewriter())
    .on("base[href]", new AttrRewriter("href"))
    .on("meta[http-equiv='refresh']", new MetaRefreshRewriter());

  return new Response(rewriter.transform(upstream).body, { status: upstream.status, headers: outHeaders });
}

/* ---------- rewriters ---------- */
class AttrRewriter {
  constructor(name) { this.name = name; }
  element(el) {
    const v = el.getAttribute(this.name);
    if (!v || v.startsWith("/proxy?url=")) return;
    let abs;
    try { abs = new URL(v, el.documentBaseURI).href; } catch { return; }
    if (/^(javascript:|mailto:|tel:|#)/i.test(abs)) return;
    el.setAttribute(this.name, "/proxy?url=" + encodeURIComponent(abs));
  }
}
class SrcsetRewriter {
  element(el) {
    const v = el.getAttribute("srcset");
    if (!v) return;
    const parts = v.split(",").map(p => {
      const [url, ...rest] = p.trim().split(/\s+/);
      let abs;
      try { abs = new URL(url, el.documentBaseURI).href; } catch { return p; }
      if (/^(javascript:|mailto:|tel:|#)/i.test(abs)) return p;
      return "/proxy?url=" + encodeURIComponent(abs) + (rest.length ? " " + rest.join(" ") : "");
    });
    el.setAttribute("srcset", parts.join(", "));
  }
}
class FormRewriter {
  element(el) {
    const action = el.getAttribute("action") || "";
    const method = (el.getAttribute("method") || "GET").toUpperCase();
    let abs;
    try { abs = new URL(action || "/", el.documentBaseURI).href; } catch { return; }
    if (/^(javascript:|mailto:|tel:|#)/i.test(abs)) return;
    el.setAttribute("action", "/proxy");
    el.setAttribute("method", "POST");
    const h1 = `<input type="hidden" name="__proxy_target__" value="${esc(abs)}">`;
    const h2 = `<input type="hidden" name="__proxy_method__" value="${esc(method)}">`;
    el.prepend(h1 + h2, { html: true });
  }
}
class MetaRefreshRewriter {
  element(el) {
    const content = el.getAttribute("content") || "";
    const m = content.match(/^\s*\d+\s*;\s*url\s*=\s*(.+)$/i);
    if (!m) return;
    let abs;
    try { abs = new URL(m[1].replace(/^["']|["']$/g, ""), el.documentBaseURI).href; } catch { return; }
    el.setAttribute("content", content.replace(m[1], "/proxy?url=" + encodeURIComponent(abs)));
  }
}
function esc(s) {
  return s.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/'/g,"&#039;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
