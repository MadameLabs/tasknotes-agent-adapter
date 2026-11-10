import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TIPOS_PLANO, avaliarPlano, caminhoProibido, lerBaseToml, listarForaDoPadrao } from "../src/planos.mjs";

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

test("tag com comentário após valor entre aspas lê como task", () => {
  const fm = "tags:\n  - 'task' # nota\n  - \"x\" # y\nbrand: '[[M]]' # c\nprojects: \"[[p]]\"   # c\n";
  const r = avaliarPlano("/b/plan/a.md", nota("plano", fm), ["/b/plan"]);
  assert.deepEqual(r, { ehPlano: true, noPadrao: true, faltando: [] });
});

test("base vazia ou ausente no base.toml devolve pastas vazias", async () => {
  const dir = await tmp();
  const f = path.join(dir, "base.toml");
  await writeFile(f, 'padrao = "p"\n[repos]\n"x" = "q"\n');
  assert.deepEqual((await lerBaseToml(f)).pastas, []);
  await writeFile(f, 'base = ""\npadrao = "p"\n');
  assert.deepEqual((await lerBaseToml(f)).pastas, []);
});

const HOME = "/home/u";
const ctx = (extra = {}) => ({ raizGit: "/home/u/repos/x", home: HOME, extras: [], ...extra });

test("docs/superpowers/plans/x.md num clone é proibido", () => {
  assert.equal(caminhoProibido("/home/u/repos/x/docs/superpowers/plans/x.md", ctx()), "docs/superpowers/**");
});

test("plans/a.md é proibido", () => {
  assert.equal(caminhoProibido("/home/u/repos/x/plans/a.md", ctx()), "plans/**");
  assert.equal(caminhoProibido("/home/u/repos/x/specs/a.md", ctx()), "specs/**");
  assert.equal(caminhoProibido("/home/u/repos/x/docs/plans/a.md", ctx()), "docs/plans/**");
  assert.equal(caminhoProibido("/home/u/repos/x/docs/specs/a.md", ctx()), "docs/specs/**");
});

test("~/.claude/plans/b.md é proibido", () => {
  assert.equal(caminhoProibido("/home/u/.claude/plans/b.md", ctx()), "~/.claude/plans/**");
});

test("docs/guia.md passa", () => {
  assert.equal(caminhoProibido("/home/u/repos/x/docs/guia.md", ctx()), null);
  assert.equal(caminhoProibido("/home/u/repos/x/README.md", ctx()), null);
});

test("src/plans.ts passa", () => {
  assert.equal(caminhoProibido("/home/u/repos/x/src/plans.ts", ctx()), null);
  assert.equal(caminhoProibido("/home/u/repos/x/plans/a.ts", ctx()), null);
});

test("arquivo fora de Git só cai no padrão do Plan Mode", () => {
  const c = ctx({ raizGit: null });
  assert.equal(caminhoProibido("/home/u/outro/plans/a.md", c), null);
  assert.equal(caminhoProibido("/home/u/outro/docs/plans/a.md", c), null);
  assert.equal(caminhoProibido("/home/u/.claude/plans/b.md", c), "~/.claude/plans/**");
});

test("caminho Windows com barra invertida é normalizado", () => {
  const c = { raizGit: "C:\\Users\\Arthur\\repos\\x", home: "C:\\Users\\Arthur", extras: [] };
  assert.equal(caminhoProibido("C:\\Users\\Arthur\\repos\\x\\docs\\plans\\a.md", c), "docs/plans/**");
  assert.equal(caminhoProibido("c:\\users\\arthur\\repos\\x\\docs\\plans\\a.md", c), "docs/plans/**");
  assert.equal(caminhoProibido("C:\\Users\\Arthur\\repos\\x\\docs\\guia.md", c), null);
  assert.equal(caminhoProibido("C:\\Users\\Arthur\\.claude\\plans\\b.md", c), "~/.claude/plans/**");
});

test("glob extra do base.toml é respeitado", () => {
  const c = ctx({ extras: ["rascunhos/**"] });
  assert.equal(caminhoProibido("/home/u/repos/x/rascunhos/a.md", c), "rascunhos/**");
  assert.equal(caminhoProibido("/home/u/repos/x/outro/a.md", c), null);
  assert.equal(caminhoProibido("/home/u/repos/x/rascunhos/a.md", ctx({ raizGit: null, extras: ["rascunhos/**"] })), null);
});

test("só .md é proibido", () => {
  assert.equal(caminhoProibido("/home/u/repos/x/plans/a.txt", ctx()), null);
  assert.equal(caminhoProibido("/home/u/.claude/plans/b.json", ctx()), null);
  assert.equal(caminhoProibido("/home/u/repos/x/plans/A.MD", ctx()), "plans/**");
});
