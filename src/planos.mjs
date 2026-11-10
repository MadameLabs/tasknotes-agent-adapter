import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const TIPOS_PLANO = Object.freeze(["plano", "handoff", "briefing"]);

// --- TOML minimo: chave = "valor" | 'valor' | ["a", 'b'], tabela [repos], comentarios # ---

function tirarComentario(linha) {
  let aspa = null;
  for (let i = 0; i < linha.length; i += 1) {
    const c = linha[i];
    if (aspa) {
      if (c === "\\" && aspa === '"') i += 1;
      else if (c === aspa) aspa = null;
    } else if (c === '"' || c === "'") aspa = c;
    else if (c === "#") return linha.slice(0, i);
  }
  return linha;
}

function textoToml(bruto) {
  const v = bruto.trim();
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\ntr])/g, (_, c) => ({ n: "\n", t: "\t", r: "\r" })[c] ?? c);
  }
  return v;
}

function listaToml(bruto) {
  const itens = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  for (const m of bruto.matchAll(re)) itens.push(m[2] !== undefined ? m[2] : textoToml(`"${m[1]}"`));
  return itens;
}

function parseToml(texto) {
  const raiz = {};
  let alvo = raiz;
  const linhas = texto.split(/\r?\n/);
  for (let i = 0; i < linhas.length; i += 1) {
    const linha = tirarComentario(linhas[i]).trim();
    if (!linha) continue;
    const tabela = linha.match(/^\[([^\[\]]+)\]$/);
    if (tabela) {
      const nome = textoToml(tabela[1]);
      alvo = raiz[nome] = raiz[nome] ?? {};
      continue;
    }
    const m = linha.match(/^("[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const chave = textoToml(m[1]);
    let valor = m[2].trim();
    if (valor.startsWith("[")) {
      while (!valor.includes("]") && i + 1 < linhas.length) {
        i += 1;
        valor += ` ${tirarComentario(linhas[i]).trim()}`;
      }
      alvo[chave] = listaToml(valor);
    } else alvo[chave] = textoToml(valor);
  }
  return raiz;
}

export async function lerBaseToml(caminho) {
  const arquivo = caminho ?? process.env.MADAMELABS_BASE_TOML ?? path.join(homedir(), ".config", "madamelabs", "base.toml");
  let texto;
  try {
    texto = await readFile(arquivo, "utf8");
  } catch (erro) {
    if (erro?.code === "ENOENT") return null;
    throw erro;
  }
  const t = parseToml(texto);
  const base = typeof t.base === "string" ? t.base : "";
  const destinos = [];
  if (typeof t.padrao === "string" && t.padrao) destinos.push(t.padrao);
  if (t.repos && typeof t.repos === "object") {
    for (const v of Object.values(t.repos)) if (typeof v === "string" && v) destinos.push(v);
  }
  const pastas = [...new Set(destinos.map((d) => path.resolve(base, d)))];
  const proibidosExtra = Array.isArray(t.gate_planos_proibidos) ? t.gate_planos_proibidos : [];
  return { base, pastas, proibidosExtra };
}

// --- Frontmatter ---

function semAspas(v) {
  const s = v.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) return s.slice(1, -1).trim();
  return s;
}

function tirarComentarioYaml(v) {
  return /^\s*['"]/.test(v) ? v : v.replace(/\s+#.*$/, "");
}

function lerFrontmatter(texto) {
  const linhas = texto.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (linhas[0]?.trim() !== "---") return null;
  const fim = linhas.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (fim < 0) return null;
  const campos = {};
  let atual = null;
  for (const linha of linhas.slice(1, fim)) {
    const item = linha.match(/^\s*-\s*(.*)$/);
    if (item && atual && Array.isArray(campos[atual])) {
      campos[atual].push(semAspas(tirarComentarioYaml(item[1])));
      continue;
    }
    const m = linha.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    atual = m[1];
    const valor = tirarComentarioYaml(m[2]).trim();
    if (valor === "") campos[atual] = [];
    else if (valor.startsWith("[") && valor.endsWith("]")) {
      campos[atual] = valor.slice(1, -1).split(",").map(semAspas);
    } else campos[atual] = [semAspas(valor)];
  }
  return campos;
}

const naoVazio = (valores) => (valores ?? []).some((v) => v.trim() !== "");

// --- Regra de plano ---

const mesmaPasta = (a, b) => {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
};

export function avaliarPlano(caminhoAbs, texto, pastas) {
  const naoPlano = { ehPlano: false, noPadrao: true, faltando: [] };
  const dir = path.dirname(caminhoAbs);
  if (!pastas.some((p) => mesmaPasta(p, dir))) return naoPlano;
  const fm = lerFrontmatter(texto);
  const tipo = fm?.type?.[0]?.toLowerCase();
  if (!tipo || !TIPOS_PLANO.includes(tipo)) return naoPlano;
  const faltando = [];
  if (!(fm.tags ?? []).some((t) => t.replace(/^#/, "").trim() === "task")) faltando.push("task");
  if (!naoVazio(fm.projects)) faltando.push("projects");
  if (!naoVazio(fm.brand)) faltando.push("brand");
  return { ehPlano: true, noPadrao: faltando.length === 0, faltando };
}

export async function listarForaDoPadrao({ pastas, filtro } = {}) {
  const fora = [];
  for (const pasta of pastas ?? []) {
    let entradas;
    try {
      entradas = await readdir(pasta, { withFileTypes: true });
    } catch (erro) {
      if (erro?.code === "ENOENT" || erro?.code === "ENOTDIR") continue;
      throw erro;
    }
    for (const e of entradas.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
      const caminho = path.join(pasta, e.name);
      if (filtro && !filtro(caminho)) continue;
      const r = avaliarPlano(caminho, await readFile(caminho, "utf8"), pastas);
      if (r.ehPlano && !r.noPadrao) fora.push({ caminho, faltando: r.faltando });
    }
  }
  return fora;
}
