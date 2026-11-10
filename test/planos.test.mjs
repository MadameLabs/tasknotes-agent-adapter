import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TIPOS_PLANO, avaliarPlano, lerBaseToml, listarForaDoPadrao } from "../src/planos.mjs";

const TOML = (base) => `# comment line
base = "${base}"

# Destino de qualquer repositório que não esteja em [repos], relativo à base.
padrao = "13-engenharia/01-planejamento"

[repos]
"OFICINA_Madame-Labs" = "01-planejamento"
"financeiro" = "03-financeiro/01-planejamento"
`;

const nota = (type, extra = "") => `---\ntype: ${type}\n${extra}---\n\n# corpo\n`;
const COMPLETO = "tags:\n  - engenharia\n  - task\nbrand:\n  - '[[Madame_Labs]]'\nprojects:\n  - '[[gate-de-planos]]'\n";

async function tmp() {
  return mkdtemp(path.join(tmpdir(), "planos-"));
}

test("lê padrao e [repos] do base.toml como pastas absolutas", async () => {
  const dir = await tmp();
  const base = path.join(dir, "BIB");
  const f = path.join(dir, "base.toml");
  await writeFile(f, TOML(base));
  const r = await lerBaseToml(f);
  assert.equal(r.base, base);
  assert.deepEqual(r.pastas, [
    path.join(base, "13-engenharia/01-planejamento"),
    path.join(base, "01-planejamento"),
    path.join(base, "03-financeiro/01-planejamento"),
  ]);
  assert.deepEqual(r.proibidosExtra, []);
});

test("base.toml lê gate_planos_proibidos e literais com aspas simples", async () => {
  const dir = await tmp();
  const f = path.join(dir, "base.toml");
  await writeFile(f, `base = 'C:\\Users\\Arthur\\BIBLIOTECA'\npadrao = "p"\ngate_planos_proibidos = ["a/**", 'b/*.md'] # x\n`);
  const r = await lerBaseToml(f);
  assert.equal(r.base, "C:\\Users\\Arthur\\BIBLIOTECA");
  assert.deepEqual(r.proibidosExtra, ["a/**", "b/*.md"]);
});

test("base.toml ausente devolve null", async () => {
  const dir = await tmp();
  assert.equal(await lerBaseToml(path.join(dir, "nao-existe.toml")), null);
});

test("plano sem tag task falta task", () => {
  const pastas = ["/b/plan"];
  const r = avaliarPlano("/b/plan/a.md", nota("plano", "tags:\n  - engenharia\nbrand: '[[M]]'\nprojects: '[[p]]'\n"), pastas);
  assert.deepEqual(r, { ehPlano: true, noPadrao: false, faltando: ["task"] });
});

test("plano com task, projects e brand está no padrão", () => {
  const r = avaliarPlano("/b/plan/a.md", nota("plano", COMPLETO), ["/b/plan"]);
  assert.deepEqual(r, { ehPlano: true, noPadrao: true, faltando: [] });
  const r2 = avaliarPlano("/b/plan/a.md", nota("handoff", "tags: [x, task]\nbrand: '[[M]]'\nprojects:\n  - '[[p]]'\n"), ["/b/plan"]);
  assert.equal(r2.noPadrao, true);
  const r3 = avaliarPlano("/b/plan/a.md", nota("briefing", "tags: [x]\nbrand: ''\nprojects: []\n"), ["/b/plan"]);
  assert.deepEqual(r3.faltando, ["task", "projects", "brand"]);
  assert.deepEqual([...TIPOS_PLANO], ["plano", "handoff", "briefing"]);
});

test("design não é plano", () => {
  const r = avaliarPlano("/b/plan/a.md", nota("design"), ["/b/plan"]);
  assert.deepEqual(r, { ehPlano: false, noPadrao: true, faltando: [] });
});

test("nota em sdd/ não é plano", () => {
  const r = avaliarPlano("/b/plan/sdd/x/a.md", nota("plano"), ["/b/plan"]);
  assert.deepEqual(r, { ehPlano: false, noPadrao: true, faltando: [] });
});

test("sem frontmatter não é plano", () => {
  assert.equal(avaliarPlano("/b/plan/a.md", "# oi\n", ["/b/plan"]).ehPlano, false);
});

test("listarForaDoPadrao ignora subpastas", async () => {
  const dir = await tmp();
  const p = path.join(dir, "plan");
  await mkdir(path.join(p, "sdd"), { recursive: true });
  await writeFile(path.join(p, "ruim.md"), nota("plano"));
  await writeFile(path.join(p, "bom.md"), nota("plano", COMPLETO));
  await writeFile(path.join(p, "design.md"), nota("design"));
  await writeFile(path.join(p, "sdd", "x.md"), nota("plano"));
  const r = await listarForaDoPadrao({ pastas: [p, path.join(dir, "inexistente")] });
  assert.deepEqual(r, [{ caminho: path.join(p, "ruim.md"), faltando: ["task", "projects", "brand"] }]);
  const f = await listarForaDoPadrao({ pastas: [p], filtro: () => false });
  assert.deepEqual(f, []);
});
