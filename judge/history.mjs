// Independent synthetic history oracle. Request expectations are authored from
// the scenario, never inferred from successful product output or its cache.
export function historyScenarios({ runNode, runCli, check, fixture, initPath, matrixPath, invokeCli, cliBin, root, spawnSync, resolve, readFileSync, writeFileSync }) {
  const codes = ["10", "20", "30", "40", "50", "60", "70", "80"];
  const tenors = ["3M", "6M", "9M", "1Y", "1.5Y", "2Y", "2.5Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y", "50Y"];
  const keys = ["m3", "m6", "m9", "y1", "y15a", "y2", "y25", "y3", "y5", "y7", "y10", "y15", "y20", "y30", "y50"];
  const xml = rows => `<Root xmlns="http://www.nexacroplatform.com/platform/dataset"><Parameters><Parameter id="ErrorCode">0</Parameter></Parameters><Dataset id="output1"><Rows>${rows}</Rows></Dataset></Root>`;
  const catalog = extra => xml(`<Row><Col id="divCode">10</Col><Col id="divName">국채</Col></Row>${extra ? `<Row><Col id="divCode">${extra}</Col><Col id="divName">추가 ${extra}</Col></Row>` : ""}`);
  const matrix = xml(`<Row><Col id="pricingGroupCode">001</Col><Col id="pricingGroupName">=한글</Col>${keys.map((key, index) => `<Col id="${key}">${index === 0 ? "-0.500" : index === 1 ? "0.000" : "-"}</Col>`).join("")}</Row>`);
  const init = (date, body = catalog()) => ({ path: initPath, body, expectedCells: { calBaseDt: date } });
  const pair = (date, code, body = matrix) => ({ path: matrixPath, body, expectedCells: { calBaseDt: date, cboYtmSort: code } });
  const day = (date, extra) => [init(date, catalog(extra)), ...[...codes, ...(extra ? [extra] : [])].map(code => pair(date, code))];
  const cases = [
    { name: "dynamic-catalog", input: { baseDates: ["20260609", "2026.06.08", "2026-06-09"] }, steps: [...day("20260608", "090"), ...day("20260609", "091")], available: 18, unavailable: 0, dates: ["2026-06-08", "2026-06-09"] },
    { name: "partial", input: { startDate: "2026-06-08", endDate: "2026-06-09" }, steps: [...day("20260608"), init("20260609"), ...codes.map(code => pair("20260609", code, code === "80" ? xml("") : matrix))], available: 15, unavailable: 1, dates: ["2026-06-08", "2026-06-09"] },
    { name: "discovery-unavailable", input: { baseDates: ["20260608", "20260609"] }, steps: [init("20260608", xml("")), init("20260609", xml(""))], available: 0, unavailable: 16, dates: ["2026-06-08", "2026-06-09"] },
    { name: "fallback-reuse", input: { baseDates: ["20260608", "20260609"], fallback: "previous-available", lookbackDays: 2 }, steps: [...day("20260608"), init("20260609"), ...codes.map(code => pair("20260609", code, xml("")))], available: 16, unavailable: 0, dates: ["2026-06-08", "2026-06-09"] },
    { name: "fallback-discovery", input: { baseDates: ["20260609"], fallback: "previous-available", lookbackDays: 2 }, steps: [init("20260609", xml("")), ...day("20260608")], available: 8, unavailable: 0, dates: ["2026-06-09"] },
    { name: "fallback-exhausted", input: { baseDates: ["20260609"], fallback: "previous-available", lookbackDays: 1 }, steps: [init("20260609", xml("")), init("20260608", xml(""))], available: 0, unavailable: 8, dates: ["2026-06-09"] },
    { name: "leap-range", input: { startDate: "2024-02-28", endDate: "2024-03-01" }, steps: ["20240228", "20240229", "20240301"].flatMap(date => day(date)), available: 24, unavailable: 0, dates: ["2024-02-28", "2024-02-29", "2024-03-01"] }
  ];
  function args(input) {
    return ["history", ...(input.baseDates ? input.baseDates.flatMap(date => ["--base-date", date]) : ["--start-date", input.startDate, "--end-date", input.endDate]), ...(input.fallback ? ["--fallback", input.fallback, "--lookback-days", String(input.lookbackDays)] : [])];
  }
  function resultCheck(value, c, label) {
    check(value?.availableCount === c.available && value?.unavailableCount === c.unavailable && value?.dataRowCount === c.available, `${label} pair/data counts`);
    check(JSON.stringify(value?.requestedDates) === JSON.stringify(c.dates), `${label} normalized ordered dates`);
    check(value?.entries?.length === c.available + c.unavailable, `${label} every pair represented once`);
    for (const date of c.dates) {
      const entries = value?.entries?.filter(e => (e.matrix?.requestedBaseDate || e.requestedBaseDate) === date) || [];
      check(codes.every(code => entries.some(e => (e.matrix?.kind || e.kind)?.code === code)), `${label} canonical omissions retained including 80`);
    }
    for (const entry of value?.entries || []) {
      if (entry.availability === "unavailable") {
        check(!entry.matrix && entry.reason.includes("source_data_unavailable"), `${label} missingness is tagged without observations`);
        continue;
      }
      const m = entry.matrix;
      check(m.rows.length === 1 && m.rows[0].pricingGroupCode === "001" && m.rows[0].pricingGroupName === "=한글", `${label} source identity`);
      check(m.rows[0].yields["3M"] === -0.5 && m.rows[0].yields["6M"] === 0 && m.rows[0].yields["9M"] === null && m.rows[0].yieldText["3M"] === "-0.500", `${label} numeric and raw values`);
      if (c.name.startsWith("fallback")) check(m.baseDate === "2026-06-08", `${label} actual date preserved`);
    }
    if (c.name === "dynamic-catalog") check(value.entries.map(e => e.matrix.kind.code).join(",") === [...codes,"090",...codes,"091"].join(","), `${label} live-only membership stays date-local`);
    if (c.name === "fallback-discovery") check(value.discovery[0].available === false, `${label} fallback does not relabel discovery`);
    if (c.name === "fallback-reuse") check(value.entries.slice(8).every(e => e.matrix.dateResolution.attemptedDates.join(",") === "2026-06-09,2026-06-08"), `${label} cache retains logical attempts`);
  }
  for (const c of cases) {
    const config = fixture(c.steps);
    runNode(`history:${c.name}`, { action: "execute", operation: "history", input: c.input }, config, (result, label) => { check(result.ok, `${label} succeeds`); if (result.ok) resultCheck(result.value, c, label); });
    runCli(`history:${c.name}`, [...args(c.input), "--format=json"], config, (result, label) => { check(result.status === 0, `${label} succeeds`); if (result.status === 0) resultCheck(JSON.parse(result.stdout).result, c, label); }, { isolated: true, requestPayload: { operation: "history", input: c.input } });
    for (const format of ["csv", "tsv"]) runCli(`history:${c.name}:${format}`, [...args(c.input), `--format=${format}`], config, (result,label) => {
      check(result.status === 0 && result.stdout.split("\n").length === c.available + c.unavailable + 2, `${label} text retains unavailable pairs`);
      check(result.stdout.includes("availability") && (c.unavailable === 0 || result.stdout.includes("unavailable")), `${label} explicit availability`);
    });
    runCli(`history:${c.name}:xlsx`, cwd => [...args(c.input), "--format=xlsx", `--output=${resolve(cwd,"history.xlsx")}`], config, (result, label, cwd) => {
      check(result.status === 0, `${label} export succeeds`);
      if (result.status !== 0) return;
      const receipt = JSON.parse(result.stdout).result;
      check(receipt.rowCount === c.available && receipt.availableCount === c.available && receipt.unavailableCount === c.unavailable && receipt.dataRowCount === c.available, `${label} complete receipt`);
      const reference = JSON.parse(invokeCli(cliBin, [...args(c.input), "--format=json"], config).stdout).result;
      const inspected = spawnSync(process.env.PYO3_PYTHON || "python3", [resolve(root,"judge/inspect-xlsx.py"), resolve(cwd,"history.xlsx")], { encoding:"utf8", timeout:15000, maxBuffer:8*1024*1024 });
      check(inspected.status === 0, `${label} independent OOXML parser: ${inspected.stderr}`);
      if (inspected.status === 0) workbook(JSON.parse(inspected.stdout), reference, label);
      check(readFileSync(resolve(cwd,"history.xlsx")).subarray(0,2).toString() === "PK", `${label} published ZIP`);
    }, { isolated:true, golden:false, requestPayload:{ operation:"history", input:c.input } });
  }
  function workbook(w, expected, label) {
    check(w.sheets.map(s=>s.name).join(",") === "History,Availability,Metadata", `${label} exactly three sheets`);
    const [data, availability, metadata] = w.sheets;
    if (!data || !availability || !metadata) return;
    const col = i => i < 26 ? String.fromCharCode(65+i) : `A${String.fromCharCode(65+i-26)}`;
    const cell = (sheet,r,c,value) => {
      const actual = sheet.cells[`${col(c)}${r}`];
      const type = value === null ? "empty" : typeof value === "string" ? "text" : typeof value;
      check(actual?.type === type && actual?.value === value, `${label} ${sheet.name}!${col(c)}${r} typed value`);
      if (sheet === data && type === "number") check(actual.format === "0.000", `${label} unscaled yield format`);
    };
    const columns = ["requestedBaseDate","baseDate","usedFallback","kindCode","kindName","pricingGroupCode","pricingGroupName",...tenors];
    columns.forEach((v,c)=>cell(data,1,c,v));
    let r=2;
    for (const e of expected.entries) if (e.availability === "available") for (const row of e.matrix.rows) {
      const m=e.matrix;
      [m.requestedBaseDate,m.baseDate,m.dateResolution.usedFallback,m.kind.code,m.kind.name,row.pricingGroupCode,row.pricingGroupName,...tenors.map(t=>row.yields[t])].forEach((v,c)=>cell(data,r,c,v)); r++;
    }
    check(Object.keys(data.cells).length === columns.length*r - columns.length, `${label} exact data dimensions`);
    check(data.pane?.xSplit === "7" && data.pane.ySplit === "1" && data.pane.state === "frozen", `${label} freeze identities and header`);
    check(data.filter === `A1:V${r-1}`, `${label} data filter`);
    expected.entries.forEach((e,index) => {
      const m=e.matrix, requested=m?.requestedBaseDate || e.requestedBaseDate, kind=m?.kind || e.kind;
      [requested,kind.code,kind.name,e.availability,m?.baseDate || null,m ? m.dateResolution.usedFallback : null,m?.rows.length || 0,e.reason || null,expected.discovery.find(d=>d.requestedBaseDate===requested).available].forEach((v,c)=>cell(availability,index+2,c,v));
    });
    check(availability.filter === `A1:I${expected.entries.length+1}`, `${label} complete availability filter`);
    const fields={};
    for(let i=2;metadata.cells[`A${i}`];i++) fields[metadata.cells[`A${i}`].value]=metadata.cells[`B${i}`]?.value;
    check(fields.operation === "history" && fields.availableCount === String(expected.availableCount) && fields.unavailableCount === String(expected.unavailableCount), `${label} metadata counts`);
    expected.discovery.forEach((d,i)=>check(fields[`discovery[${i}].available`]===String(d.available), `${label} discovery provenance`));
    expected.entries.forEach((e,i)=> {
      const m=e.matrix;
      (m?.dateResolution.attemptedDates || e.attemptedDates).forEach((date,j)=>check(fields[`entries[${i}].attemptedDates[${j}]`] === date, `${label} attempted dates`));
      if(m) check(fields[`entries[${i}].source.request.parameters.cboYtmSort`] === m.kind.code, `${label} source code provenance`);
    });
  }
  for (const input of [{}, {baseDates:[]}, {baseDates:["2026-02-30"]}, {baseDates:["20260608"],startDate:"2026-06-08",endDate:"2026-06-09"}, {startDate:"2026-06-09",endDate:"2026-06-08"}, {startDate:"2020-01-01",endDate:"2026-01-01"}, {baseDates:["20260608"],lookbackDays:1}]) {
    runNode(`history:invalid-${JSON.stringify(input)}`, {action:"execute",operation:"history",input}, fixture([]), (r,label)=>check(!r.ok && r.error?.code === "invalid_parameter",`${label} invalid before source`));
  }
  runNode("history:sparse-input", {action:"history-sparse-input"}, fixture([]), (r,label)=>check(!r.ok && r.error?.code === "invalid_parameter", `${label} rejects holes before native serialization`));
  const fatal = fixture([init("20260608"), pair("20260608","10"), {...pair("20260608","20"), body:undefined, transportError:"synthetic failure"}]);
  runNode("history:fatal",{action:"execute",operation:"history",input:{baseDates:["20260608","20260609"]}},fatal,(r,label)=>check(!r.ok && r.error?.actual?.kind?.code === "20" && r.error?.operationName === "history",`${label} fatal pair context`));
  runCli("history:fatal-preserves-file", ["history","--base-date","20260608","--format=xlsx","--output=history.xlsx","--overwrite"], fatal, (r,label,cwd)=> {
    check(r.status !== 0 && JSON.parse(r.stdout).error.actual.kind.code === "20", `${label} reports fatal pair`);
    check(readFileSync(resolve(cwd,"history.xlsx"),"utf8") === "prior workbook", `${label} preserves destination`);
  }, { isolated:true, requestPayload:{operation:"history",input:{baseDates:["20260608"]}}, setup:cwd=>writeFileSync(resolve(cwd,"history.xlsx"),"prior workbook") });
  runCli("history:preflight", ["history","--base-date","20260608","--format=xlsx","--output=history.xlsx"], fixture([]), (r,label)=>check(r.status !== 0 && JSON.parse(r.stdout).error.code === "output_exists", `${label} destination validation precedes requests`), {isolated:true,setup:cwd=>writeFileSync(resolve(cwd,"history.xlsx"),"prior workbook")});
  runNode("history:abort",{action:"abort-handler-preservation",operation:"history",input:{baseDates:["20260608"]}},fixture([{path:initPath,waitForCancellation:true,expectedCells:{calBaseDt:"20260608"}}]),(r,label)=>check(r.ok && r.value?.cancellationCode === "source_transport_error",`${label} abort reaches history`));
  runCli("history:help",["history","--help"],fixture([]),(r,label)=>check(r.status===0 && r.stdout.includes("2000") && r.stdout.includes("Availability"),`${label} offline help`));
}
