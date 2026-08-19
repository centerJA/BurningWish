/* ==========================================================================
 * BurningWish — 書き換え型プロキシ Worker
 *
 * 方式:
 *   クライアントは iframe の src に /proxy?url=<絶対URL> を指定する。
 *   この Worker は上流を取得したうえで、HTML/CSS 内のあらゆる URL を
 *   /proxy?url=... へ書き換えて返す。さらにページ先頭にランタイムシムを
 *   注入し、JS が動的に発行する遷移(fetch / XHR / pushState / window.open)
 *   もプロキシ経由に矯正する。
 *
 *   これにより、ページ内のサブリソースと遷移がプロキシを迂回しなくなる。
 *
 * 注意:
 *   HTMLRewriter の Element には documentBaseURI は存在しない。
 *   基準 URL は必ずクロージャ(state.base)経由で明示的に渡すこと。
 * ========================================================================== */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

const PROXY_PATH = "/proxy";
const PROXY_PREFIX = "/proxy?url=";

/** 埋め込み・書き換えを妨げるレスポンスヘッダ */
const STRIP_RESPONSE_HEADERS = [
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "permissions-policy",
  "feature-policy",
  "strict-transport-security",
  "report-to",
  "nel",
  "clear-site-data",
  // 本文を変換/再エンコードするため、長さと符号化は必ず作り直す
  "content-encoding",
  "content-length",
  "set-cookie"
];

/** 本文を持てないステータス。ここに body を渡すと実行時に警告/エラーになる */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/** 上流へ素通ししてはいけないリクエストヘッダ */
const DROP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "upgrade",
  "cookie",
  "origin",
  "referer"
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === PROXY_PATH) {
      try {
        return await handleProxy(request, url);
      } catch (err) {
        return errorPage(502, "プロキシ処理でエラーが発生しました", err && err.message);
      }
    }

    // 保険: プロキシ中のページが location.href = "/foo" のように
    // 自オリジンへ直接遷移してしまった場合、Referer から文脈を復元して
    // 正しいプロキシ URL へ送り直す。(これが無いと白紙になる)
    const rescued = rescueFromReferer(request, url);
    if (rescued) return rescued;

    return env.ASSETS.fetch(request);
  }
};

/* ---------------------------------------------------------------- routing */

function rescueFromReferer(request, url) {
  const ref = request.headers.get("Referer");
  if (!ref) return null;
  let r;
  try {
    r = new URL(ref);
  } catch {
    return null;
  }
  if (r.origin !== url.origin || r.pathname !== PROXY_PATH) return null;

  const context = r.searchParams.get("url");
  if (!context) return null;

  let resolved;
  try {
    resolved = new URL(url.pathname + url.search, context).href;
  } catch {
    return null;
  }
  return Response.redirect(url.origin + PROXY_PREFIX + encodeURIComponent(resolved), 302);
}

/* ------------------------------------------------------------ proxy core */

async function handleProxy(request, url) {
  const parsed = await resolveTarget(request, url);
  if (parsed.error) return errorPage(400, parsed.error);

  const { target, method, body, contentType } = parsed;

  const guard = validateTarget(target);
  if (guard) return errorPage(403, guard);

  const targetUrl = new URL(target);
  const isSecure = url.protocol === "https:";
  const raw = url.searchParams.get("raw") === "1";

  // --- Cookie ジャー: 自オリジンに保存した上流 Cookie を復元 ---
  const jar = readJar(request, targetUrl.hostname);

  const headers = buildUpstreamHeaders(request, targetUrl, jar, contentType, method);

  const init = { method, headers, redirect: "manual" };
  if (body !== null && body !== undefined && method !== "GET" && method !== "HEAD") {
    init.body = body;
  }

  let upstream;
  try {
    upstream = await fetchWithRetry(targetUrl.href, init);
  } catch (err) {
    return errorPage(502, "接続できませんでした", `${targetUrl.hostname} — ${err && err.message}`);
  }

  // --- 上流の Set-Cookie をジャーへ取り込む ---
  const setCookies = readSetCookies(upstream.headers);
  if (setCookies.length) mergeSetCookies(jar, setCookies);
  const jarHeader = jar.size ? jarCookieHeader(targetUrl.hostname, jar, isSecure) : null;

  // --- リダイレクトは手動で解決し、/proxy?url= へ差し替える ---
  // (こうすると iframe 自身の URL が常に正確になり、アドレスバー同期が成立する)
  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get("Location");
    if (location) {
      let next;
      try {
        next = new URL(location, targetUrl.href).href;
      } catch {
        next = null;
      }
      if (next) {
        const out = new Headers({
          Location: PROXY_PREFIX + encodeURIComponent(next),
          "Cache-Control": "no-store"
        });
        if (jarHeader) out.append("Set-Cookie", jarHeader);
        return new Response(null, { status: 302, headers: out });
      }
    }
  }

  const outHeaders = new Headers(upstream.headers);
  for (const h of STRIP_RESPONSE_HEADERS) outHeaders.delete(h);
  outHeaders.set("Cache-Control", "no-store");
  outHeaders.set("Access-Control-Allow-Origin", "*");
  if (jarHeader) outHeaders.append("Set-Cookie", jarHeader);

  const rawType = upstream.headers.get("Content-Type") || "";
  const mime = rawType.split(";")[0].trim().toLowerCase();
  const charset = charsetOf(rawType);

  const isHtml = mime === "text/html" || mime === "application/xhtml+xml";

  // 文字コードの確定。
  // Content-Type に charset が無い場合(古い日本語サイトに多い)は、
  // 本文先頭の <meta charset> / <meta http-equiv> を覗いて判定する。
  // これを怠ると Shift_JIS のページを UTF-8 と誤認して文字化けする。
  let encoding = charset;
  let buffered = null;
  if ((isHtml || raw) && !encoding) {
    buffered = await upstream.arrayBuffer();
    encoding = sniffCharset(buffered) || "utf-8";
  }

  // ソース表示用: 書き換えずにテキストとして返す
  if (raw) {
    const text = buffered ? decodeBuffer(buffered, encoding) : await decodeBody(upstream, encoding);
    outHeaders.set("Content-Type", "text/plain; charset=utf-8");
    return new Response(text, { status: upstream.status, headers: outHeaders });
  }

  if (mime === "text/css") {
    const text = await decodeBody(upstream, charset);
    outHeaders.set("Content-Type", "text/css; charset=utf-8");
    return new Response(rewriteCss(text, targetUrl.href), {
      status: upstream.status,
      headers: outHeaders
    });
  }

  if (!isHtml) {
    // 画像・JS・フォント・動画などは無変換でストリーム
    const passthrough = NULL_BODY_STATUS.has(upstream.status) ? null : upstream.body;
    return new Response(passthrough, { status: upstream.status, headers: outHeaders });
  }

  // --- HTML ---
  outHeaders.set("Content-Type", "text/html; charset=utf-8");

  // HTMLRewriter は UTF-8 前提。Shift_JIS / EUC-JP などはここで弾いて
  // デコード → 正規表現による書き換え → UTF-8 として返す。
  if (!isUtf8(encoding)) {
    const text = buffered ? decodeBuffer(buffered, encoding) : await decodeBody(upstream, encoding);
    return new Response(rewriteHtmlFallback(text, targetUrl.href), {
      status: upstream.status,
      headers: outHeaders
    });
  }

  const htmlBody = NULL_BODY_STATUS.has(upstream.status)
    ? null
    : buffered !== null
      ? buffered
      : upstream.body;
  const source = new Response(htmlBody, { status: upstream.status, headers: outHeaders });
  return buildHtmlRewriter(targetUrl.href).transform(source);
}

/**
 * 429 / 503 を短い待ちで再試行する。
 * ブラウザは 1 ページで数十〜百のサブリソースを一斉に要求するが、
 * それが Worker からまとめて上流へ飛ぶため、画像配信元(例: Wikimedia)の
 * レート制限に当たって画像が虫食いになることがある。
 * init.body は ArrayBuffer / 文字列 / FormData のいずれかで再利用可能。
 */
async function fetchWithRetry(url, init, attempts = 4) {
  let response;
  for (let i = 0; i < attempts; i++) {
    response = await fetch(url, init);
    if (response.status !== 429 && response.status !== 503) return response;
    if (i === attempts - 1) break;

    // 接続を解放してから待つ
    try {
      await response.arrayBuffer();
    } catch {
      /* 読めなくても構わない */
    }
    // ジッターを入れて再試行を散らす。
    // 100 枚の画像が一斉に再試行すると、同じ瞬間にまた殺到して意味がなくなる。
    const retryAfter = Number(response.headers.get("Retry-After"));
    const baseMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 1500)
        : 200 * (i + 1);
    const waitMs = Math.round(baseMs * (0.5 + Math.random() * 1.5));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return response;
}

/* --------------------------------------------------- target / body 解決 */

async function resolveTarget(request, url) {
  const direct = url.searchParams.get("url");

  if (direct) {
    let body = null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      body = await request.arrayBuffer();
    }
    return {
      target: direct,
      method: request.method,
      body,
      contentType: request.headers.get("Content-Type")
    };
  }

  // 書き換え済みフォームからの送信経路
  // (action="/proxy" method="POST" + hidden __proxy_target__ / __proxy_method__)
  if (request.method !== "POST") {
    return { error: "url パラメータが必要です(例: /proxy?url=https://example.com)" };
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return { error: "フォームの内容を読み取れませんでした" };
  }

  const target = form.get("__proxy_target__");
  if (!target || typeof target !== "string") {
    return { error: "url パラメータが必要です(例: /proxy?url=https://example.com)" };
  }
  const method = String(form.get("__proxy_method__") || "POST").toUpperCase();
  form.delete("__proxy_target__");
  form.delete("__proxy_method__");

  if (method === "GET" || method === "HEAD") {
    // HTML 仕様上、GET フォームは action のクエリをフォーム値で置き換える
    let t;
    try {
      t = new URL(target);
    } catch {
      return { error: "フォームの送信先 URL が不正です" };
    }
    t.search = "";
    for (const [k, v] of form) t.searchParams.append(k, String(v));
    return { target: t.href, method, body: null, contentType: null };
  }

  const incoming = request.headers.get("Content-Type") || "";
  if (incoming.includes("multipart/form-data")) {
    // FormData をそのまま渡すと fetch が境界を再生成する
    return { target, method, body: form, contentType: null };
  }

  const sp = new URLSearchParams();
  for (const [k, v] of form) sp.append(k, String(v));
  return {
    target,
    method,
    body: sp.toString(),
    contentType: "application/x-www-form-urlencoded"
  };
}

/* -------------------------------------------------------------- SSRF 対策 */

function validateTarget(target) {
  let u;
  try {
    u = new URL(target);
  } catch {
    return "URL の形式が正しくありません";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return "http:// または https:// で始まる URL のみ取得できます";
  }
  if (isPrivateHost(u.hostname)) {
    return "内部ネットワーク宛の URL は取得できません";
  }
  return null;
}

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa")) return true;

  // IPv6
  if (h === "::1" || h === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true; // fc00::/7 ユニークローカル
  if (/^fe80:/i.test(h)) return true; // リンクローカル
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isPrivateIPv4(mapped[1]);

  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isPrivateIPv4(h);

  return false;
}

function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // クラウドのメタデータ endpoint を含む
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // マルチキャスト / 予約
  return false;
}

/* ---------------------------------------------------------- 上流ヘッダ */

function buildUpstreamHeaders(request, targetUrl, jar, contentTypeOverride, method) {
  const h = new Headers();

  for (const [k, v] of request.headers) {
    const lk = k.toLowerCase();
    if (DROP_REQUEST_HEADERS.has(lk)) continue;
    if (lk.startsWith("cf-") || lk.startsWith("x-forwarded-") || lk.startsWith("x-real-")) continue;
    if (lk === "accept-encoding") continue; // ランタイムに任せる
    if (lk === "content-type" && contentTypeOverride === null) continue;
    h.set(k, v);
  }

  h.set("User-Agent", UA);
  h.set("Upgrade-Insecure-Requests", "1");

  // Referer: ブラウザは自オリジンの /proxy?url=<ページURL> を送ってくるので、
  // そこから本来の参照元ページを復元する。(ホットリンク対策のあるサイト向け)
  h.set("Referer", refererFor(request, targetUrl));

  // 非 GET では実ブラウザ同様に Origin を付ける。無いと弾くサイトがある。
  if (method && method !== "GET" && method !== "HEAD") {
    h.set("Origin", targetUrl.origin);
  }

  if (!h.has("Accept")) {
    h.set(
      "Accept",
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
    );
  }
  if (!h.has("Accept-Language")) {
    h.set("Accept-Language", "ja,en-US;q=0.9,en;q=0.8");
  }

  // Sec-Fetch-* はクライアントが自オリジン基準で付けてくるため上流向けに整える。
  // iframe 内のトップレベル遷移は dest=iframe で届くが、上流には document として見せる。
  let dest = (request.headers.get("Sec-Fetch-Dest") || "document").toLowerCase();
  if (dest === "iframe" || dest === "frame" || dest === "object" || dest === "embed") {
    dest = "document";
  }
  h.set("Sec-Fetch-Dest", dest);
  if (dest === "document") {
    h.set("Sec-Fetch-Mode", "navigate");
    h.set("Sec-Fetch-Site", "none");
    h.set("Sec-Fetch-User", "?1");
  } else {
    h.set("Sec-Fetch-Mode", request.headers.get("Sec-Fetch-Mode") || "no-cors");
    h.set("Sec-Fetch-Site", "same-origin");
    h.delete("Sec-Fetch-User");
  }

  if (contentTypeOverride) h.set("Content-Type", contentTypeOverride);

  const cookie = upstreamCookieHeader(jar);
  if (cookie) h.set("Cookie", cookie);

  return h;
}

/** 参照元。プロキシ URL 経由なら本来のページ URL を、無ければ対象オリジンを返す。 */
function refererFor(request, targetUrl) {
  const raw = request.headers.get("Referer");
  if (raw) {
    try {
      const r = new URL(raw);
      if (r.pathname === PROXY_PATH) {
        const page = r.searchParams.get("url");
        if (page && /^https?:/i.test(page)) return page;
      }
    } catch {
      /* 壊れた Referer は無視 */
    }
  }
  return targetUrl.origin + "/";
}

/* ------------------------------------------------------------ Cookie ジャー */

const JAR_PREFIX = "bwcj_";

/** co.jp / co.uk のような 2 段 TLD をざっくり吸収する */
const TWO_LEVEL_TLD = /^(co|ne|or|ac|go|ed|gr|lg|com|net|org|gov|edu|ltd|plc|me|info|biz)\.[a-z]{2}$/;

function registrableDomain(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return host;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join(".");
  if (TWO_LEVEL_TLD.test(last2)) return parts.slice(-3).join(".");
  return last2;
}

function jarName(hostname) {
  const domain = registrableDomain(hostname);
  const b64 = btoa(domain).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return JAR_PREFIX + b64;
}

function readJar(request, hostname) {
  const jar = new Map();
  const raw = request.headers.get("Cookie");
  if (!raw) return jar;

  const want = jarName(hostname);
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== want) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      continue;
    }
    for (const [n, v] of new URLSearchParams(decoded)) jar.set(n, v);
  }
  return jar;
}

function readSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function mergeSetCookies(jar, list) {
  for (const sc of list) {
    const segments = sc.split(";");
    const first = segments[0];
    const i = first.indexOf("=");
    if (i < 0) continue;

    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1).trim();
    if (!name) continue;

    let expired = false;
    for (let j = 1; j < segments.length; j++) {
      const eq = segments[j].indexOf("=");
      const key = (eq < 0 ? segments[j] : segments[j].slice(0, eq)).trim().toLowerCase();
      const val = eq < 0 ? "" : segments[j].slice(eq + 1).trim();
      if (key === "max-age" && Number(val) <= 0) expired = true;
      if (key === "expires" && val && Date.parse(val) <= Date.now()) expired = true;
    }

    if (expired || value === "") jar.delete(name);
    else jar.set(name, value);
  }
  return jar;
}

function upstreamCookieHeader(jar) {
  if (!jar.size) return "";
  const out = [];
  for (const [k, v] of jar) out.push(`${k}=${v}`);
  return out.join("; ");
}

function jarCookieHeader(hostname, jar, secure) {
  // Cookie 1 個あたり 4KB 制限。溢れる場合は古いものから落とす。
  let serialized = serializeJar(jar);
  while (serialized.length > 3500 && jar.size > 1) {
    jar.delete(jar.keys().next().value);
    serialized = serializeJar(jar);
  }
  const flags = ["Path=/", "Max-Age=86400", "SameSite=Lax", "HttpOnly"];
  if (secure) flags.push("Secure");
  return `${jarName(hostname)}=${encodeURIComponent(serialized)}; ${flags.join("; ")}`;
}

function serializeJar(jar) {
  const sp = new URLSearchParams();
  for (const [k, v] of jar) sp.append(k, v);
  return sp.toString();
}

/* -------------------------------------------------------------- URL 変換 */

/**
 * 値をプロキシ URL へ変換する。書き換えるべきでない場合は null。
 * base は必ず呼び出し側から渡すこと(HTMLRewriter に基準 URL は無い)。
 */
function proxify(value, base) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (/^(data:|blob:|javascript:|mailto:|tel:|about:|sms:|#)/i.test(v)) return null;
  if (v.startsWith(PROXY_PREFIX)) return null;

  let abs;
  try {
    abs = new URL(v, base).href;
  } catch {
    return null;
  }
  if (!/^https?:/i.test(abs)) return null;
  return PROXY_PREFIX + encodeURIComponent(abs);
}

/** 属性値に残る文字実体参照を解く。HTMLRewriter の getAttribute は解いてくれない。 */
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

function decodeEntities(value) {
  if (!value || value.indexOf("&") === -1) return value;
  return String(value).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? m : named;
  });
}

/** 属性値をプロキシ URL へ変換する(実体参照を解いてから解決する) */
function proxifyAttr(value, base) {
  return proxify(decodeEntities(value), base);
}

function rewriteSrcset(value, base) {
  return value
    .split(",")
    .map((part) => {
      const t = part.trim();
      if (!t) return null;
      const bits = t.split(/\s+/);
      const p = proxify(bits[0], base);
      if (!p) return t;
      return [p].concat(bits.slice(1)).join(" ");
    })
    .filter(Boolean)
    .join(", ");
}

function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, u) => {
      const p = proxify(u, base);
      return p ? `url(${q}${p}${q})` : m;
    })
    .replace(/@import\s+(["'])([^"']+)\1/gi, (m, q, u) => {
      const p = proxify(u, base);
      return p ? `@import ${q}${p}${q}` : m;
    });
}

/* ------------------------------------------------------- HTMLRewriter */

function buildHtmlRewriter(finalUrl) {
  // <base href> が現れたらここを更新する。HTMLRewriter は文書順に処理するため、
  // <head> 内の <base> は body の要素より必ず先に処理される。
  const state = { base: finalUrl, injected: false };

  const attr = (name) => ({
    element(el) {
      const p = proxifyAttr(el.getAttribute(name), state.base);
      if (p) el.setAttribute(name, p);
    }
  });

  const srcset = (name) => ({
    element(el) {
      const v = el.getAttribute(name);
      if (v) el.setAttribute(name, rewriteSrcset(decodeEntities(v), state.base));
    }
  });

  const injector = {
    element(el) {
      if (state.injected) return;
      state.injected = true;
      el.prepend(shimScript(state.base), { html: true });
    }
  };

  return new HTMLRewriter()
    // 基準 URL の確定。全 URL を絶対化するため <base> 自体は取り除く。
    .on("base", {
      element(el) {
        const href = el.getAttribute("href");
        if (href) {
          try {
            state.base = new URL(decodeEntities(href), state.base).href;
          } catch {
            /* 不正な base は無視 */
          }
        }
        el.remove();
      }
    })

    // シム注入(<head> が無い文書のために <body> にも保険をかける)
    .on("head", injector)
    .on("body", injector)

    // リンク
    .on("a[href]", {
      element(el) {
        const p = proxifyAttr(el.getAttribute("href"), state.base);
        if (p) el.setAttribute("href", p);
        // 別タブに逃げるとプロキシの外に出てしまうのでフレーム内に留める
        const target = el.getAttribute("target");
        if (target && target.toLowerCase() === "_blank") el.setAttribute("target", "_self");
      }
    })
    .on("area[href]", attr("href"))

    // サブリソース
    .on("link[href]", attr("href"))
    .on("script[src]", attr("src"))
    .on("img[src]", attr("src"))
    .on("img[srcset]", srcset("srcset"))
    .on("source[src]", attr("src"))
    .on("source[srcset]", srcset("srcset"))
    .on("video[src]", attr("src"))
    .on("video[poster]", attr("poster"))
    .on("audio[src]", attr("src"))
    .on("track[src]", attr("src"))
    .on("embed[src]", attr("src"))
    .on("object[data]", attr("data"))
    .on("iframe[src]", attr("src"))

    // フォーム: GET でも action のクエリが落ちないよう hidden で対象を運ぶ
    .on("form", {
      element(el) {
        const action = el.getAttribute("action");
        let abs;
        try {
          abs = new URL(decodeEntities(action) || "", state.base).href;
        } catch {
          return;
        }
        if (!/^https?:/i.test(abs)) return;

        const method = (el.getAttribute("method") || "GET").toUpperCase();
        el.setAttribute("action", PROXY_PATH);
        el.setAttribute("method", "POST");
        el.append(
          `<input type="hidden" name="__proxy_target__" value="${escapeAttr(abs)}">` +
            `<input type="hidden" name="__proxy_method__" value="${escapeAttr(method)}">`,
          { html: true }
        );
      }
    })

    // meta refresh
    .on("meta", {
      element(el) {
        const equiv = (el.getAttribute("http-equiv") || "").toLowerCase();
        if (equiv === "content-security-policy") {
          el.remove();
          return;
        }
        if (equiv !== "refresh") return;
        const content = decodeEntities(el.getAttribute("content") || "");
        const m = content.match(/^(\s*[\d.]+\s*;\s*url\s*=\s*)(.+)$/i);
        if (!m) return;
        const p = proxify(m[2].replace(/^["']|["']$/g, ""), state.base);
        if (p) el.setAttribute("content", m[1] + p);
      }
    })

    // インライン CSS
    .on("style", new StyleRewriter(state))
    .on("[style]", {
      element(el) {
        const v = el.getAttribute("style");
        if (v && v.includes("url(")) el.setAttribute("style", rewriteCss(decodeEntities(v), state.base));
      }
    });
}

/** <style> の中身はテキストが分割されて届くので、末尾まで貯めてから置換する */
class StyleRewriter {
  constructor(state) {
    this.state = state;
    this.buffer = "";
  }
  text(chunk) {
    this.buffer += chunk.text;
    if (chunk.lastInTextNode) {
      const rewritten = rewriteCss(this.buffer, this.state.base);
      this.buffer = "";
      // CSS の子結合子 ">" が壊れるため html:false は使えない
      chunk.replace(rewritten, { html: true });
    } else {
      chunk.remove();
    }
  }
}

/* ---------------------------------------- 非 UTF-8 HTML 向けフォールバック */

/**
 * HTMLRewriter は UTF-8 前提のため、Shift_JIS / EUC-JP はこちらで処理する。
 * 正規表現ベースなので網羅性は劣るが、この種のサイトは構造が単純なことが多い。
 */
function rewriteHtmlFallback(html, base) {
  let out = html;

  // 文書内の <base> を基準に取り込んでから取り除く
  const baseMatch = out.match(/<base[^>]+href\s*=\s*["']?([^"'\s>]+)/i);
  if (baseMatch) {
    try {
      base = new URL(decodeEntities(baseMatch[1]), base).href;
    } catch {
      /* 無視 */
    }
    out = out.replace(/<base[^>]*>/gi, "");
  }

  // meta CSP と meta charset を除去(UTF-8 として返すため)
  out = out.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, "");
  out = out.replace(/<meta[^>]+charset[^>]*>/gi, "");

  // href / src / poster / data 属性
  out = out.replace(
    /\s(href|src|poster|data)\s*=\s*(["'])([^"']*)\2/gi,
    (m, name, q, value) => {
      const p = proxifyAttr(value, base);
      return p ? ` ${name}=${q}${p}${q}` : m;
    }
  );

  // form は hidden フィールド方式へ寄せる
  out = out.replace(/<form([^>]*)>/gi, (m, attrs) => {
    const actionMatch = attrs.match(/action\s*=\s*["']([^"']*)["']/i);
    const methodMatch = attrs.match(/method\s*=\s*["']([^"']*)["']/i);
    let abs;
    try {
      abs = new URL(actionMatch ? decodeEntities(actionMatch[1]) : "", base).href;
    } catch {
      return m;
    }
    if (!/^https?:/i.test(abs)) return m;
    const method = (methodMatch ? methodMatch[1] : "GET").toUpperCase();
    const cleaned = attrs
      .replace(/\s*action\s*=\s*["'][^"']*["']/i, "")
      .replace(/\s*method\s*=\s*["'][^"']*["']/i, "");
    return (
      `<form${cleaned} action="${PROXY_PATH}" method="POST">` +
      `<input type="hidden" name="__proxy_target__" value="${escapeAttr(abs)}">` +
      `<input type="hidden" name="__proxy_method__" value="${escapeAttr(method)}">`
    );
  });

  const shim = shimScript(base);
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1><meta charset="utf-8">${shim}`);
  } else {
    out = `<meta charset="utf-8">${shim}` + out;
  }
  return out;
}

/* ------------------------------------------------------- ランタイムシム */

/**
 * ページ先頭に注入するシム。
 * 静的な属性書き換えだけでは、JS が実行時に組み立てる遷移を捕まえられない。
 * ここで fetch / XHR / history / window.open / 動的リンクを矯正する。
 */
function shimScript(base) {
  const B = JSON.stringify(base);
  return `<script data-bw="shim">(function(){
if(window.__BW_SHIM__)return;window.__BW_SHIM__=1;
var BASE=${B},O=location.origin,PX=O+"${PROXY_PREFIX}";
var REAL_PARENT=window.parent;
function unprox(u){try{var x=new URL(u,O);if(x.origin===O&&x.pathname==="${PROXY_PATH}"){var t=x.searchParams.get("url");if(t)return t;}}catch(e){}return null;}
function toAbs(u){try{return new URL(u,BASE).href;}catch(e){return null;}}
function px(u){
  if(u==null)return u;
  var s=String(u);if(!s)return u;
  if(/^(data:|blob:|javascript:|mailto:|tel:|about:|sms:|#)/i.test(s))return u;
  if(unprox(s))return u;
  var a=toAbs(s);if(!a||!/^https?:/i.test(a))return u;
  return PX+encodeURIComponent(a);
}
function tell(u){try{REAL_PARENT.postMessage({__bw:"nav",url:u||BASE,title:document.title},"*");}catch(e){}}
function navTo(u){var p=px(u);try{location.replace(p);}catch(e){location.href=p;}}

/* --- フレーム脱出(frame busting)対策 ---
   location.replace / assign / href は非設定可能でパッチできない。
   ただし window.parent は差し替えられるので、
   parent.location.replace(...) 型の遷移(DuckDuckGo の中継ページなど)は
   ここで捕まえてプロキシ経由に矯正する。
   あわせて frameElement を null にして、埋め込み検知を避ける。 */
var BASE_URL=null;try{BASE_URL=new URL(BASE);}catch(e){}
var fakeLoc=new Proxy({},{
  get:function(t,k){
    if(k==="replace"||k==="assign")return function(u){navTo(u);};
    if(k==="reload")return function(){location.reload();};
    if(k==="toString")return function(){return BASE;};
    if(BASE_URL&&k in BASE_URL){var v=BASE_URL[k];return typeof v==="function"?v.bind(BASE_URL):v;}
    return undefined;
  },
  set:function(t,k,v){if(k==="href")navTo(v);return true;}
});
var fakeParent=new Proxy(window,{
  get:function(t,k){
    if(k==="location")return fakeLoc;
    if(k==="parent"||k==="top"||k==="self"||k==="window")return fakeParent;
    if(k==="frameElement")return null;
    var v;try{v=t[k];}catch(e){return undefined;}
    return typeof v==="function"?v.bind(t):v;
  },
  set:function(t,k,v){
    if(k==="location"){navTo(v);return true;}
    try{t[k]=v;}catch(e){}
    return true;
  }
});
try{Object.defineProperty(window,"parent",{configurable:true,get:function(){return fakeParent;}});}catch(e){}
try{Object.defineProperty(window,"frameElement",{configurable:true,get:function(){return null;}});}catch(e){}

var _fetch=window.fetch;
if(_fetch)window.fetch=function(input,init){
  try{
    if(typeof input==="string"||input instanceof URL)return _fetch.call(this,px(String(input)),init);
    if(input&&input.url&&!unprox(input.url))return _fetch.call(this,new Request(px(input.url),input),init);
  }catch(e){}
  return _fetch.call(this,input,init);
};

var _open=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(){
  var a=[].slice.call(arguments);
  try{a[1]=px(a[1]);}catch(e){}
  return _open.apply(this,a);
};

if(navigator.sendBeacon){
  var _sb=navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon=function(u,d){try{u=px(u);}catch(e){}return _sb(u,d);};
}

var _wopen=window.open;
window.open=function(u,n,f){try{u=px(u);}catch(e){}return _wopen.call(window,u,n,f);};

["pushState","replaceState"].forEach(function(k){
  var _orig=history[k];
  history[k]=function(s,t,u){
    var real=null;
    if(u!=null){try{real=toAbs(u);u=px(u);}catch(e){}}
    var r=_orig.call(history,s,t,u);
    if(real)tell(real);
    return r;
  };
});
addEventListener("popstate",function(){tell(unprox(location.href));});

/* Service Worker は経路を横取りしてプロキシを破綻させるので無効化する */
try{
  if(navigator.serviceWorker){
    Object.defineProperty(navigator,"serviceWorker",{configurable:true,get:function(){return undefined;}});
  }
}catch(e){}

/* 動的に生成された a / form のフォールバック(キャプチャ段階で拾う) */
function ensure(f,n,v){
  var i=f.querySelector('input[name="'+n+'"]');
  if(!i){i=document.createElement("input");i.type="hidden";i.name=n;f.appendChild(i);}
  i.value=v;
}
addEventListener("click",function(e){
  if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
  var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;
  if(!a)return;
  var h=a.getAttribute("href");
  if(!h||/^(#|javascript:|mailto:|tel:)/i.test(h))return;
  if(unprox(h))return;
  var p=px(h);
  if(p===h)return;
  e.preventDefault();
  location.assign(p);
},true);
addEventListener("submit",function(e){
  var f=e.target;
  if(!f||f.tagName!=="FORM")return;
  var action=f.getAttribute("action")||"";
  if(action==="${PROXY_PATH}"||unprox(action))return;
  var abs=toAbs(action);
  if(!abs||!/^https?:/i.test(abs))return;
  var m=(f.getAttribute("method")||"GET").toUpperCase();
  f.setAttribute("action","${PROXY_PATH}");
  f.setAttribute("method","POST");
  ensure(f,"__proxy_target__",abs);
  ensure(f,"__proxy_method__",m);
},true);

tell(BASE);
addEventListener("DOMContentLoaded",function(){tell(unprox(location.href));});
addEventListener("load",function(){tell(unprox(location.href));});
})();</script>`;
}

/* ------------------------------------------------------------- utilities */

function charsetOf(contentType) {
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || "");
  return m ? m[1].toLowerCase() : null;
}

function isUtf8(charset) {
  return charset === "utf-8" || charset === "utf8";
}

async function decodeBody(response, charset) {
  return decodeBuffer(await response.arrayBuffer(), charset);
}

function decodeBuffer(buf, charset) {
  if (!charset || isUtf8(charset)) return new TextDecoder("utf-8").decode(buf);
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    // 未知の charset 名は UTF-8 として読む
    return new TextDecoder("utf-8").decode(buf);
  }
}

/** 本文先頭から <meta charset> / <meta http-equiv content="...charset=..."> を拾う */
function sniffCharset(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";

  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const m = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** iframe 内にそのまま表示される、黒基調のエラーページ */
function errorPage(status, title, detail) {
  const body = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>${escapeAttr(title)}</title>
<style>
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;background:#0A0A0B;color:#E8E8EC;
 font-family:'Noto Sans JP','Hiragino Sans','Yu Gothic',system-ui,sans-serif;padding:2rem}
.card{max-width:34rem;text-align:center}
.code{font-family:ui-monospace,'SFMono-Regular',Consolas,monospace;font-size:.75rem;letter-spacing:.24em;
 color:#4CA6FF;text-transform:uppercase;margin:0 0 .9rem}
h1{font-size:1.15rem;font-weight:700;margin:0 0 .8rem}
p{font-size:.85rem;line-height:1.8;color:#8A8A94;margin:0}
.detail{margin-top:1rem;padding:.8rem 1rem;background:#131316;border:1px solid #26262C;border-radius:10px;
 font-family:ui-monospace,'SFMono-Regular',Consolas,monospace;font-size:.75rem;color:#8A8A94;
 word-break:break-all;text-align:left}
</style></head><body><div class="card">
<p class="code">Error ${status}</p><h1>${escapeAttr(title)}</h1>
<p>このページはプロキシ経由で表示できませんでした。アドレスを確認するか、別のサイトをお試しください。</p>
${detail ? `<div class="detail">${escapeAttr(detail)}</div>` : ""}
</div></body></html>`;

  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
  });
}
