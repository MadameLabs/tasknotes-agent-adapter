import assert from "node:assert/strict";
import test from "node:test";
import { addBlockers, dependencyUid, removeBlockers } from "../src/dependencies.mjs";

test("dependency uid is the wikilink to the note name, as the plugin writes it", () => {
  assert.equal(dependencyUid("06-tarefas/Etapa 3 — registrar no DS v3.md"), "[[Etapa 3 — registrar no DS v3]]");
});

test("adding a blocker keeps existing items and does not duplicate written forms", () => {
  const current = [{ uid: "[[Etapa 3|apelido]]", reltype: "STARTTOSTART" }, "[[Outra]]"];
  assert.deepEqual(addBlockers(current, ["06-tarefas/Etapa 3.md", "Outra.md", "Nova.md"]), [
    ...current,
    { uid: "[[Nova]]", reltype: "FINISHTOSTART" },
  ]);
  assert.deepEqual(addBlockers(undefined, ["A.md"]), [{ uid: "[[A]]", reltype: "FINISHTOSTART" }]);
});

test("removing a blocker matches by note name whatever the written form", () => {
  const current = [{ uid: "[[06-tarefas/Etapa 3]]", reltype: "FINISHTOSTART" }, { uid: "[[Fica]]" }];
  assert.deepEqual(removeBlockers(current, ["Etapa 3.md"]), [{ uid: "[[Fica]]" }]);
});
