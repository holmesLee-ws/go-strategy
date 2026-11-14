#!/usr/bin/env node
// 리포 관리자용 검사기. 학습자에게는 필요 없다.
// 검사: 커리큘럼 형식·선수 관계(R2), 국내 근거·글로벌 비교(R10), 출처 키·URL·조회일·조문(R11),
// 경계 이웃(R13), 미리 만든 시각 자료 없음(R5), 설정 JSON 유효성.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const read = (p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

const LEVELS = ["Explain", "Apply", "Evaluate", "Develop"];
const FIELDS = ["선수", "핵심 질문", "목표", "만들어 볼 것", "국내 근거", "글로벌 비교", "근거"];
const LEGAL_KINDS = ["법률", "시행령", "고시", "기준"];
// R10: 국내 근거에 법령·고시·기준이 있어야 하는 모듈
const LEGAL_REQUIRED = (id) => /^G\d+$/.test(id) || id === "E3" || id === "E5";
// R13: spec.md 경계 표의 첫 열에서 이웃 목록을 읽는다
function parseNeighbors(spec) {
  const out = [];
  const i = spec.indexOf("| 이웃 |");
  if (i < 0) return out;
  for (const line of spec.slice(i).split("\n").slice(2)) {
    if (!line.startsWith("|")) break;
    for (const n of line.split("|")[1].split("·")) if (/^go-[a-z-]+$/.test(n.trim())) out.push(n.trim());
  }
  return out;
}
// R11(4): 금액·지정 기준·도입 일정이 자주 바뀌는 항목
const VOLATILE = (r) => ["법률", "시행령", "고시"].includes(r.kind) || /(억\s?원|조\s?원|만\s?엔|억\s?엔|엔|달러|유로|파운드|EUR|[$€£]|시행|의무화|적용|발효|이후 시작)/.test(r.fact);
// R11: 공식 출처로 인정하는 도메인(하위 도메인 포함)
const ALLOWED_DOMAINS = ["law.go.kr", "likms.assembly.go.kr", "ftc.go.kr", "egroup.go.kr", "fsc.go.kr", "fss.or.kr", "dart.fss.or.kr",
  "kasb.or.kr", "kai.or.kr", "krx.co.kr", "kind.krx.co.kr", "kostat.go.kr", "kosis.kr", "moef.go.kr", "alio.go.kr", "moleg.go.kr", "elaw.klri.re.kr",
  "ftc.gov", "justice.gov", "uscode.house.gov", "govinfo.gov", "ecfr.gov", "federalregister.gov", "sec.gov", "treasury.gov", "home.treasury.gov", "ca.gov", "leginfo.legislature.ca.gov", "arb.ca.gov",
  "eur-lex.europa.eu", "europa.eu", "competition-policy.ec.europa.eu", "efrag.org", "legislation.gov.uk", "gov.uk", "frc.org.uk",
  "jftc.go.jp", "japaneselawtranslation.go.jp", "e-gov.go.jp", "ifrs.org", "oecd.org", "doi.org", "hbr.org", "wwnorton.com", "penguinrandomhouse.com", "harpercollins.com", "hbsp.harvard.edu", "store.hbr.org", "simonandschuster.com", "som.yale.edu", "mods.go.kr", "openlibrary.org"];

function parseCurriculum(text) {
  const modules = new Map();
  const meta = new Map();
  const problems = [];
  // 모듈이 자기 영역 제목 아래 있는지 본다
  let area = null;
  for (const line of text.split("\n")) {
    const am = line.match(/^## ([APGEX]) · /);
    if (am) area = am[1];
    else if (/^## /.test(line)) area = null;
    const mm = line.match(/^### ([APGEX])\d+ · /);
    if (mm && mm[1] !== area) problems.push(`${line.slice(4, 8)}: 영역 ${mm[1]} 제목 아래에 있지 않음`);
  }
  const blocks = text.split(/^### /m).slice(1).map((b) => b.split(/^## /m)[0]);
  for (const block of blocks) {
    const head = block.split("\n")[0];
    const m = head.match(/^([APGEX]\d+) · (.+)$/);
    if (!m) { problems.push(`모듈 제목 형식 오류: ${head}`); continue; }
    const id = m[1];
    if (modules.has(id)) problems.push(`${id}: 중복 id`);
    const fields = {};
    for (const line of block.split("\n").slice(1)) {
      const f = line.match(/^- ([^:]+): (.+)$/);
      if (f) fields[f[1]] = f[2];
    }
    for (const name of FIELDS) if (!fields[name]) problems.push(`${id}: 「${name}」 없음`);
    for (const line of block.split("\n").slice(1)) {
      if (!line.trim() || line.startsWith("## ")) continue;
      const f = line.match(/^- ([^:]+): (.+)$/);
      if (!f || ![...FIELDS, "경계·연결"].includes(f[1])) problems.push(`${id}: 허용되지 않은 줄 「${line.slice(0, 30)}」`);
    }
    const rawKeys = (v) => [...(v || "").matchAll(/`([a-z0-9-]+)`/g)].map((x) => x[1]);
    for (const name of ["국내 근거", "글로벌 비교"]) {
      const ks = rawKeys(fields[name]);
      if (ks.length && ks.every((k) => k === "none") && !(fields[name] || "").replace(/`[^`]+`/g, "").trim()) problems.push(`${id}: 「${name}」 none의 이유 없음`);
    }
    if (fields["목표"] && !LEVELS.some((l) => fields["목표"].startsWith(`${l} — `))) problems.push(`${id}: 목표 수준 형식 오류`);
    const keys = (v) => [...(v || "").matchAll(/`([a-z0-9-]+)`/g)].map((x) => x[1]);
    for (const name of ["국내 근거", "글로벌 비교", "근거"]) if (fields[name] && keys(fields[name]).length === 0) problems.push(`${id}: 「${name}」에 출처 키 없음`);
    meta.set(id + "#keys", { domestic: keys(fields["국내 근거"]), all: ["국내 근거", "글로벌 비교", "근거"].flatMap((n) => keys(fields[n])) });
    meta.set(id + "#boundary", fields["경계·연결"] || "");
    const prereq = !fields["선수"] || fields["선수"] === "없음" ? [] : fields["선수"].split(",").map((s) => s.trim());
    modules.set(id, prereq);
  }
  for (const a of ["A", "P", "G", "E", "X"]) if (!new RegExp(`^## ${a} · `, "m").test(text)) problems.push(`영역 ${a} 제목 없음`);
  for (const [id, prereq] of modules) for (const p of prereq) if (!modules.has(p)) problems.push(`${id}: 없는 선수 ${p}`);
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 2 || !modules.has(id)) return;
    if (state.get(id) === 1) { problems.push(`선수 순환: ${[...path, id].join(" → ")}`); return; }
    state.set(id, 1);
    for (const p of modules.get(id)) visit(p, [...path, id]);
    state.set(id, 2);
  };
  for (const id of modules.keys()) visit(id, []);
  return { modules, meta, problems };
}

// sources.md 표: | 키 | 종류 | 명칭 | 확인한 사실 | 조문 | URL | 조회일 | 다시 확인 |
function parseSources(text) {
  const rows = new Map();
  const problems = [];
  for (const line of text.split("\n")) {
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length !== 8) { if (/^\|\s*`[a-z0-9-]+`\s*\|/.test(line)) problems.push(`sources: 칸 수 오류 ${line.slice(0, 40)}`); continue; }
    const km = (cells[0] || "").match(/^`([a-z0-9-]+)`$/);
    if (!km) continue;
    const [, kind, name, fact, articles, url, date, recheck] = cells;
    const key = km[1];
    if (rows.has(key)) problems.push(`sources: ${key} 중복`);
    if (!name || !fact) problems.push(`sources: ${key} 명칭·확인한 사실 없음`);
    if (/^미확인/.test(fact)) problems.push(`sources: ${key} 확인한 사실이 아직 미확인`);
    if (key !== "none") {
      const um = url.match(/https?:\/\/([^/\s>)]+)/);
      if (!um) problems.push(`sources: ${key} URL 없음`);
      else if (!ALLOWED_DOMAINS.some((d) => um[1] === d || um[1].endsWith("." + d))) problems.push(`sources: ${key} 허용되지 않은 도메인 ${um[1]}`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push(`sources: ${key} 조회일 형식 오류`);
    }
    rows.set(key, { kind, articles, recheck, fact });
  }
  return { rows, problems };
}

function findVisualAssets(files) {
  const allowedJs = /^tools\/.*\.m?js$/;
  return files.filter((f) => /\.(html?|css|svg|png|jpe?g|gif|webp|avif|ico|bmp|tiff?)$/i.test(f) || (/\.m?js$/i.test(f) && !allowedJs.test(f)));
}

function findTemplateMarkup(name, text) {
  const hits = [];
  for (const m of text.matchAll(/(```|~~~)[\s\S]*?\1/g)) if (/<(!doctype|html|svg|style|canvas|script)\b/i.test(m[0])) hits.push(name);
  return hits;
}

function main() {
  const { modules, meta, problems } = parseCurriculum(read("curriculum/map.md"));
  errors.push(...problems);
  if (modules.size === 0) errors.push("모듈을 찾지 못함");

  const src = parseSources(read("curriculum/sources.md"));
  errors.push(...src.problems);
  const KINDS = [...LEGAL_KINDS, "공시자료", "통계", "문헌", "없음"];
  for (const [k, r] of src.rows) if (!KINDS.includes(r.kind)) errors.push(`sources: ${k} 종류 「${r.kind}」 오류`);
  for (const id of modules.keys()) {
    const { domestic, all } = meta.get(id + "#keys");
    for (const k of all) if (!src.rows.has(k)) errors.push(`${id}: sources.md에 없는 키 ${k}`);
    if (LEGAL_REQUIRED(id) && !domestic.some((k) => LEGAL_KINDS.includes(src.rows.get(k)?.kind))) errors.push(`${id}: 국내 근거에 법령·고시·기준 없음`);
  }
  // R11(4): 개정이 잦은 항목은 「다시 확인」 칸이 채워져 있어야 한다
  for (const [k, r] of src.rows) if (VOLATILE(r) && !/다시 확인/.test(r.recheck)) errors.push(`sources: ${k} 「다시 확인」 표시 없음`);
  const boundaryText = [...modules.keys()].map((id) => meta.get(id + "#boundary")).join("\n");
  const NEIGHBORS = parseNeighbors(read("docs/build/spec.md"));
  if (NEIGHBORS.length < 10) errors.push("spec.md 경계 표를 읽지 못함");
  for (const n of NEIGHBORS) if (!new RegExp(`${n}(?![a-z-])`).test(boundaryText)) errors.push(`경계·연결에 ${n} 없음`);
  for (const m of new Set([...read("curriculum/map.md").matchAll(/go-[a-z-]+[a-z]/g)].map((x) => x[0]))) {
    if (!NEIGHBORS.includes(m)) errors.push(`지도의 ${m}이 경계 목록에 없음`);
  }


  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const f of findVisualAssets(files)) errors.push(`미리 만든 시각 자료 금지: ${f}`);
  for (const f of files.filter((x) => x.endsWith(".md") && existsSync(join(root, x)))) for (const n of findTemplateMarkup(f, read(f))) errors.push(`복사용 마크업 금지: ${n}`);

  // R11(3): 지도·튜터 지침의 「제N조」는 sources.md 조문 칸에 있어야 한다
  const articleCells = [...src.rows.values()].map((r) => r.articles).join(" ");
  for (const f of ["curriculum/map.md", "CLAUDE.md", ...files.filter((x) => x.startsWith("tutor/") && x.endsWith(".md"))]) {
    if (!existsSync(join(root, f))) continue;
    for (const m of read(f).matchAll(/제\d+조(의\d+)?/g)) if (!articleCells.includes(m[0])) errors.push(`${f}: 출처 조문 칸에 없는 ${m[0]}`);
  }
  // R11(1): 튜터 지침의 출처 키도 sources.md에 있어야 한다
  for (const f of files.filter((x) => x.startsWith("tutor/") && x.endsWith(".md"))) {
    for (const m of read(f).matchAll(/`src:([a-z0-9-]+)`/g)) if (!src.rows.has(m[1])) errors.push(`${f}: sources.md에 없는 키 ${m[1]}`);
  }

  for (const p of [".claude/settings.json", "learner-template/state.json"]) {
    try { JSON.parse(read(p)); } catch (e) { errors.push(`${p}: JSON 오류 ${e.constructor.name}`); }
  }
  if (!existsSync(join(root, "learner-template/log.md"))) errors.push("learner-template/log.md 없음");
  for (const s of readdirSync(join(root, ".claude/skills"))) {
    if (statSync(join(root, ".claude/skills", s)).isDirectory() && !existsSync(join(root, ".claude/skills", s, "SKILL.md"))) errors.push(`스킬 ${s}: SKILL.md 없음`);
  }
  if (!read(".gitignore").split("\n").includes("learner/")) errors.push(".gitignore에 learner/ 없음");

  if (errors.length) { console.error(errors.map((e) => `FAIL ${e}`).join("\n")); process.exit(1); }
  console.log(`OK 모듈 ${modules.size}개, 출처 ${src.rows.size}개, 파일 ${files.length}개 검사`);
}

main();
