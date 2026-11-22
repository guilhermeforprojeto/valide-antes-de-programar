// Servidor local mínimo para o painel do Relatório de Validação.
// Sem dependências: só Node.js 18+.
//   node viewer/server.mjs            -> http://localhost:4173
//   PORT=5000 node viewer/server.mjs  -> outra porta
// Rotas: arquivos da pasta viewer/ e GET /health -> {"status":"ok"}

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number(process.env.PORT) || 4173;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ status: "ok" }));
  }

  // Bloqueia acesso a arquivos fora da pasta e aos próprios scripts.
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  const file = resolve(join(ROOT, rel || "index.html"));
  if ((file !== ROOT && !file.startsWith(ROOT + sep)) || /\.(mjs|ps1|sh)$/.test(file)) {
    res.writeHead(404);
    return res.end("Não encontrado");
  }

  try {
    const target = (await stat(file)).isDirectory() ? join(file, "index.html") : file;
    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": TYPES[extname(target)] || "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Não encontrado");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Painel rodando em http://localhost:${PORT}`);
});
