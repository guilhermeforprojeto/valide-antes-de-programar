// Publica o painel na internet com um túnel temporário da Cloudflare
// e só entrega o link depois de 5 verificações.
//
// Requisitos: Node.js 18+ e cloudflared instalado
//   Windows: winget install --id Cloudflare.cloudflared
//   macOS:   brew install cloudflared
//   Linux:   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
//
// Uso: node viewer/publicar.mjs          (porta 4173)
//      PORT=5000 node viewer/publicar.mjs
// Ctrl+C encerra o servidor e o túnel.

import { spawn } from "node:child_process";
import { Resolver } from "node:dns/promises";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT) || 4173;
const LOCAL = `http://localhost:${PORT}`;
const children = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (n, msg) => console.log(`✅ ${n}. ${msg}`);
const fail = (n, msg) => {
  console.error(`❌ ${n}. ${msg}`);
  shutdown(1);
};

function shutdown(code = 0) {
  for (const c of children) c.kill();
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function retry(times, intervalMs, fn) {
  let last;
  for (let i = 1; i <= times; i++) {
    try {
      return await fn(i);
    } catch (e) {
      last = e;
      await sleep(intervalMs);
    }
  }
  throw last;
}

// 1. Serviço local
async function verificarLocal() {
  const responde = async () => {
    const r = await fetch(`${LOCAL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  };
  try {
    await responde();
  } catch {
    const server = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: "inherit",
    });
    children.push(server);
    await retry(15, 500, responde).catch((e) => fail(1, `Servidor local não respondeu em ${LOCAL}/health (${e.message})`));
  }
  ok(1, `Serviço local respondendo em ${LOCAL}`);
}

// 2. Túnel cloudflared
function abrirTunel() {
  return new Promise((resolveTunnel) => {
    let url = null;
    let conectado = false;
    const tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", LOCAL], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(tunnel);

    const timer = setTimeout(() => fail(2, "O túnel não conectou em 60 s. Veja se o cloudflared está instalado e se a rede permite saída."), 60_000);

    const ler = (chunk) => {
      const txt = chunk.toString();
      url ??= txt.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? null;
      if (/Registered tunnel connection/i.test(txt)) conectado = true;
      if (url && conectado) {
        clearTimeout(timer);
        ok(2, `Túnel conectado à borda da Cloudflare: ${url}`);
        resolveTunnel(url);
      }
    };
    tunnel.stdout.on("data", ler);
    tunnel.stderr.on("data", ler);
    tunnel.on("error", () => fail(2, "cloudflared não encontrado. Instale e rode de novo."));
    tunnel.on("exit", (c) => { if (!url || !conectado) fail(2, `cloudflared saiu com código ${c}`); });
  });
}

// 3. Propagação DNS
async function verificarDNS(host) {
  const resolver = new Resolver();
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  const ips = await retry(30, 3000, () => resolver.resolve4(host)).catch(() =>
    fail(3, `${host} não resolveu em 90 s nos DNS 1.1.1.1 / 8.8.8.8`)
  );
  ok(3, `DNS propagado: ${host} → ${ips.join(", ")}`);
}

// 4. TLS na porta 443
async function verificarTLS(host) {
  const handshake = () =>
    new Promise((res, rej) => {
      const s = tls.connect({ host, port: 443, servername: host, timeout: 5000 }, () => {
        const authorized = s.authorized;
        const proto = s.getProtocol();
        s.end();
        authorized ? res(proto) : rej(new Error(s.authorizationError));
      });
      s.on("error", rej);
      s.on("timeout", () => { s.destroy(); rej(new Error("timeout")); });
    });
  const proto = await retry(10, 3000, handshake).catch((e) => fail(4, `Handshake TLS falhou em ${host}:443 (${e.message})`));
  ok(4, `TLS ok na porta 443 (${proto})`);
}

// 5. Health check ponta a ponta
async function verificarPontaAPonta(url) {
  await retry(20, 3000, async () => {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000)});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    if (body.status !== "ok") throw new Error("resposta inesperada");
  }).catch((e) => fail(5, `${url}/health não respondeu ok pelo túnel (${e.message})`));
  ok(5, "Health check ponta a ponta: tráfego atravessa o túnel e chega ao painel");
}

console.log("Publicando o painel do Relatório de Validação…\n");
await verificarLocal();
const publicUrl = await abrirTunel();
const host = new URL(publicUrl).hostname;
await verificarDNS(host);
await verificarTLS(host);
await verificarPontaAPonta(publicUrl);

console.log(`
──────────────────────────────────────────────
  Painel no ar: ${publicUrl}
  Local:        ${LOCAL}
──────────────────────────────────────────────
  Atenção: qualquer pessoa com o link consegue ver o painel.
  O link é temporário e some quando você apertar Ctrl+C.
`);
