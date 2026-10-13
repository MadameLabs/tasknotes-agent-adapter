// Dependencia no TaskNotes e uma lista de objetos `{ uid, reltype, gap? }` no
// campo `blockedBy` (o nome gravado vem do mapeamento do vault: `bloqueado_por`
// no ATELIE). O plugin grava `uid` como wikilink pelo nome da nota e `reltype`
// FINISHTOSTART quando ninguem escolhe outro. Aqui so se acrescenta e se tira
// item: reltype e gap ja gravados pelo plugin ficam como estao.
export const FINISH_TO_START = "FINISHTOSTART";

const noteName = (value) => value
  .replace(/^\[\[/, "").replace(/\]\]$/, "")
  .split("|")[0].split("#")[0]
  .split("/").pop()
  .replace(/\.md$/i, "")
  .trim();

export const dependencyUid = (taskPath) => `[[${noteName(taskPath)}]]`;

const refersTo = (item, taskPath) => noteName(typeof item === "string" ? item : item?.uid ?? "") === noteName(taskPath);

export function addBlockers(current, blockerPaths) {
  const next = [...(current ?? [])];
  for (const path of blockerPaths) {
    if (!next.some((item) => refersTo(item, path))) next.push({ uid: dependencyUid(path), reltype: FINISH_TO_START });
  }
  return next;
}

export function removeBlockers(current, blockerPaths) {
  return (current ?? []).filter((item) => !blockerPaths.some((path) => refersTo(item, path)));
}
