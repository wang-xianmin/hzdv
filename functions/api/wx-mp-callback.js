import { pickKvBinding } from "../lib/kv-binding.js";

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function checkSignature(token, timestamp, nonce, signature) {
  const arr = [token, timestamp, nonce].sort();
  const str = arr.join("");
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  return safeEqual(hashHex, signature);
}

function parseWechatXml(xml) {
  const getTag = (tag) => {
    const re = new RegExp("<" + tag + ">\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*?))\\s*</" + tag + ">");
    const m = xml.match(re);
    return (m?.[1] ?? m?.[2] ?? "").trim();
  };
  return {
    FromUserName: getTag("FromUserName"),
    MsgType: getTag("MsgType"),
    Event: getTag("Event"),
    EventKey: getTag("EventKey"),
    CreateTime: getTag("CreateTime"),
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // 1. method guard
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // 2. token guard
  const token = String(env.WX_MP_TOKEN || "").trim();
  if (!token) {
    return new Response("Service Unavailable", { status: 503 });
  }

  // 3. signature params
  const signature = url.searchParams.get("signature");
  const timestamp = url.searchParams.get("timestamp");
  const nonce = url.searchParams.get("nonce");
  if (!signature || !timestamp || !nonce) {
    return new Response("Forbidden", { status: 403 });
  }

  // 4. verify signature
  const ok = await checkSignature(token, timestamp, nonce, signature);
  if (!ok) {
    return new Response("Forbidden", { status: 403 });
  }

  // 5. GET: echo echostr
  if (request.method === "GET") {
    const echostr = url.searchParams.get("echostr") || "";
    return new Response(echostr, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  // 6. POST: parse event, write KV, always return "success"
  try {
    const xml = await request.text();
    const parsed = parseWechatXml(xml);
    const { FromUserName: openid, MsgType, Event, EventKey } = parsed;

    let scene = "";
    if (MsgType === "event") {
      if (Event === "subscribe" && EventKey && EventKey.startsWith("qrscene_")) {
        scene = EventKey.slice("qrscene_".length);
      } else if (Event === "SCAN") {
        scene = EventKey;
      }
    }

    if (openid && scene && /^[A-Za-z0-9_-]{1,64}$/.test(scene)) {
      const kv = pickKvBinding(env);
      if (kv) {
        const kvKey = "wxscan:" + scene;
        const kvValue = JSON.stringify({
          openid,
          event: Event,
          at: Date.now(),
        });
        const job = kv.put(kvKey, kvValue, { expirationTtl: 600 })
          .catch(() => console.error("wx-mp-callback kv put failed"));
        if (typeof context.waitUntil === "function") {
          context.waitUntil(job);
        } else {
          job.catch(() => {});
        }
      }
    }
  } catch (e) {
    console.error("wx-mp-callback POST error:", e);
  }

  // 7. always success
  return new Response("success", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
