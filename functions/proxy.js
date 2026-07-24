

export async function onRequestGet(context) {
  const requestUrl = new URL(context.request.url);
  const target = requestUrl.searchParams.get("url");

  if (!target) {
    return new Response(
      "url パラメータが必要です(例: /proxy?url=https://example.com)",
      { status: 400 }
    );
  }
  if (!/^https?:\/\//i.test(target)) {
    return new Response(
      "url は http:// または https:// で始まる必要があります",
      { status: 400 }
    );
  }

  try {
    const upstream = await fetch(target, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
      },
      redirect: "follow"
    });

    const body = await upstream.arrayBuffer();
    const contentType = upstream.headers.get("Content-Type") || "text/html; charset=utf-8";

    return new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store"
      }
    });
  } catch (err) {
    return new Response("取得に失敗しました: " + err.message, { status: 502 });
  }
}