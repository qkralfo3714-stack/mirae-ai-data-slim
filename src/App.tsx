import { ChangeEvent, DragEvent, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import JSZip from "jszip";
import {
  Check,
  ChevronRight,
  Copy,
  Database,
  Download,
  FileArchive,
  FileSpreadsheet,
  Info,
  LoaderCircle,
  LockKeyhole,
  RefreshCcw,
  Rows3,
  Sparkles,
  UploadCloud,
  X,
} from "lucide-react";

type Cell = string | number | boolean | null;
type DataRow = Record<string, Cell>;
type RowLimit = 1000 | 5000 | "all";
type ExportMode = "standard" | "source";

const SPLIT_BYTES = 3 * 1024 * 1024;
const encoder = new TextEncoder();
const HISTORY_SOURCE_PROMPT = `아래 역사 자료를 읽고,
1. 한자 원문은 그대로 유지하고
2. 한글 독음을 확인·보완하고
3. 중학생이 이해할 수 있는 현대어 풀이를 작성해 줘.
표 형식으로 ‘원문 / 독음 / 현대어 풀이 / 핵심 역사 개념’ 순서로 정리해 줘.
확실하지 않은 독음이나 뜻은 추측하지 말고 ‘확인 필요’라고 표시해 줘.`;

function readableBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function safeBaseName(name: string) {
  return name.replace(/\.(csv|xlsx|xml|txt|json|jsonl|ndjson)$/i, "").replace(/[\\/:*?"<>|]/g, "_");
}

function cleanXmlText(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function uniqueXmlValues(elements: Element[]) {
  return [...new Set(elements.map((element) => cleanXmlText(element.textContent)).filter(Boolean))];
}

function parseHistoryXml(xmlText: string) {
  const xmlDocument = new DOMParser().parseFromString(xmlText, "application/xml");
  if (xmlDocument.querySelector("parsererror")) {
    throw new Error("XML 문법을 확인할 수 없습니다. 원본 파일이 손상되지 않았는지 확인해 주세요.");
  }

  const records = Array.from(xmlDocument.getElementsByTagName("level3")).filter((record) => record.hasAttribute("id"));
  if (!records.length) {
    throw new Error("이 XML에서는 사료 항목(level3)을 찾지 못했습니다.");
  }

  const documentTitle = cleanXmlText(
    xmlDocument.querySelector("level1 > front > biblioData > title > mainTitle")?.textContent,
  );
  const sectionTitle = cleanXmlText(
    xmlDocument.querySelector("level2 > front > biblioData > title > mainTitle")?.textContent,
  );

  const rows: DataRow[] = records.map((record) => {
    const title = cleanXmlText(
      record.querySelector("front biblioData > title > mainTitle")?.textContent,
    );
    const originalText = Array.from(record.querySelectorAll("text content paragraph"))
      .map((paragraph) => cleanXmlText(paragraph.textContent))
      .filter(Boolean)
      .join("\n");

    const sources = Array.from(record.querySelectorAll("front biblioData > source"))
      .map((source) => {
        const sourceTitle = cleanXmlText(source.querySelector("mainTitle")?.textContent);
        const page = source.querySelector("page")?.getAttribute("begin") ?? "";
        return [sourceTitle, page].filter(Boolean).join(" · ");
      })
      .filter(Boolean);

    const subjects = uniqueXmlValues(Array.from(record.querySelectorAll("front biblioData > subjectClass")));
    const people = uniqueXmlValues(Array.from(record.querySelectorAll('text index[type="이름"]')));
    const places = uniqueXmlValues(Array.from(record.querySelectorAll('text index[type="지명"]')));
    const eras = uniqueXmlValues(Array.from(record.querySelectorAll('text index[type="연호"]')));

    return {
      "사료 ID": record.getAttribute("id") ?? "",
      "문헌명": documentTitle,
      "편명": sectionTitle,
      "한국어 제목": title,
      "한문 원문": originalText,
      "출전": sources.join(" / "),
      "주제 분류": subjects.join(", "),
      "관련 인물": people.join(", "),
      "관련 지명": places.join(", "),
      "연호": eras.join(", "),
    };
  });

  return {
    rows,
    columns: ["사료 ID", "문헌명", "편명", "한국어 제목", "한문 원문", "출전", "주제 분류", "관련 인물", "관련 지명", "연호"],
  };
}

function flattenJsonRecord(value: unknown, prefix = "", target: DataRow = {}) {
  const key = prefix || "값";

  if (value === null || value === undefined) {
    target[key] = null;
    return target;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    target[key] = value;
    return target;
  }

  if (Array.isArray(value)) {
    const isSimpleArray = value.every(
      (item) => item === null || ["string", "number", "boolean"].includes(typeof item),
    );
    target[key] = isSimpleArray
      ? value.map((item) => item ?? "").join(", ")
      : JSON.stringify(value);
    return target;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) {
      target[key] = "";
      return target;
    }
    entries.forEach(([childKey, childValue]) => {
      flattenJsonRecord(childValue, prefix ? `${prefix}.${childKey}` : childKey, target);
    });
  }

  return target;
}

function parseJsonText(text: string) {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) throw new Error("JSON 파일에 내용이 없습니다.");

  let parsed: unknown;
  let sourceName = "JSON";

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    try {
      parsed = lines.map((line) => JSON.parse(line));
      sourceName = "JSON Lines";
    } catch {
      throw new Error("JSON 문법을 읽지 못했습니다. 괄호나 쉼표가 올바른지 확인해 주세요.");
    }
  }

  let items: unknown[];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed && typeof parsed === "object") {
    const arrayEntries = Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
      .sort((a, b) => b[1].length - a[1].length);
    if (arrayEntries.length) {
      items = arrayEntries[0][1];
      sourceName = `JSON · ${arrayEntries[0][0]}`;
    } else {
      items = [parsed];
    }
  } else {
    items = [parsed];
  }

  if (!items.length) throw new Error("JSON 파일에서 변환할 항목을 찾지 못했습니다.");

  const rows = items.map((item) => flattenJsonRecord(item));
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (!columns.length) throw new Error("JSON 파일에서 열 이름을 만들지 못했습니다.");

  return { rows, columns, sourceName };
}

function parsePlainText(text: string) {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) throw new Error("TXT 파일에 내용이 없습니다.");

  const normalized = trimmed.replace(/\r\n?/g, "\n");
  let blocks = normalized
    .split(/\n[\t ]*\n+/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length === 1) {
    blocks = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  return {
    rows: blocks.map((content, index) => ({ "번호": index + 1, "내용": content })),
    columns: ["번호", "내용"],
  };
}

function normalizeValue(value: Cell | undefined) {
  if (value === null || value === undefined || value === "") return "없음";
  return String(value).replace(/\r?\n|\r/g, " ").replace(/\s+/g, " ").trim() || "없음";
}

function normalizeHeaders(headers: string[]) {
  const counts = new Map<string, number>();
  return headers.map((header, index) => {
    const base = header.trim() || `열_${index + 1}`;
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

function splitByUtf8(text: string, maxBytes: number) {
  if (encoder.encode(text).length <= maxBytes) return [text];

  const pieces: string[] = [];
  let current = "";
  for (const character of text) {
    if (encoder.encode(current + character).length > maxBytes) {
      pieces.push(current);
      current = character;
    } else {
      current += character;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function makeTextParts(rows: DataRow[], columns: string[], exportMode: ExportMode) {
  const parts: string[] = [];
  const sourceIntro = exportMode === "source"
    ? "# 역사 사료 해석 자료\n\n아래 원문을 바탕으로 한글 독음, 현대어 풀이, 핵심 역사 개념을 작성해 주세요. 확실하지 않은 내용은 추측하지 말고 ‘확인 필요’로 표시해 주세요.\n\n"
    : "";
  let current = sourceIntro;
  let currentBytes = encoder.encode(current).length;

  rows.forEach((row, index) => {
    const line = exportMode === "source"
      ? `## 사료 ${index + 1}\n\n### 원문\n${columns.map((column) => `- ${column}: ${normalizeValue(row[column])}`).join("\n")}\n\n### 해석 보조 틀\n- 한글 독음: [ChatGPT가 확인]\n- 현대어 풀이: [ChatGPT가 작성]\n- 핵심 역사 개념: [ChatGPT가 정리]\n- 확인이 필요한 부분: [없음 또는 확인 필요]\n\n`
      : `${columns.map((column) => `${column}: ${normalizeValue(row[column])}`).join(", ")}\n`;
    const lineBytes = encoder.encode(line).length;

    if (lineBytes > SPLIT_BYTES) {
      if (current !== sourceIntro) {
        parts.push(current);
        current = sourceIntro;
        currentBytes = encoder.encode(current).length;
      }
      splitByUtf8(line, SPLIT_BYTES - currentBytes).forEach((piece) => parts.push(`${sourceIntro}${piece}`));
      return;
    }

    if (currentBytes + lineBytes > SPLIT_BYTES && current !== sourceIntro) {
      parts.push(current);
      current = `${sourceIntro}${line}`;
      currentBytes = encoder.encode(current).length;
    } else {
      current += line;
      currentBytes += lineBytes;
    }
  });

  if (current !== sourceIntro || !parts.length) parts.push(current);
  return parts;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<DataRow[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [selectedColumns, setSelectedColumns] = useState<Set<string>>(new Set());
  const [rowLimit, setRowLimit] = useState<RowLimit>(1000);
  const [exportMode, setExportMode] = useState<ExportMode>("standard");
  const [promptCopied, setPromptCopied] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [status, setStatus] = useState<"idle" | "reading" | "ready" | "converting">("idle");
  const [error, setError] = useState("");
  const [sheetName, setSheetName] = useState("");

  const chosenColumns = useMemo(
    () => columns.filter((column) => selectedColumns.has(column)),
    [columns, selectedColumns],
  );
  const outputRows = rowLimit === "all" ? rows : rows.slice(0, rowLimit);
  const previewRows = rows.slice(0, 5);

  function resetData() {
    setFile(null);
    setRows([]);
    setColumns([]);
    setSelectedColumns(new Set());
    setError("");
    setSheetName("");
    setStatus("idle");
    if (inputRef.current) inputRef.current.value = "";
  }

  function loadParsedRows(nextRows: DataRow[], nextColumns: string[], nextFile: File, nextSheet = "") {
    const usableColumns = nextColumns.filter((column) => column.trim());
    if (!usableColumns.length) throw new Error("열 이름을 찾을 수 없습니다. 첫 번째 행에 열 이름이 있는지 확인해 주세요.");
    setFile(nextFile);
    setRows(nextRows);
    setColumns(usableColumns);
    setSelectedColumns(new Set(usableColumns));
    setSheetName(nextSheet);
    setStatus("ready");
  }

  async function parseFile(nextFile: File) {
    const extension = nextFile.name.split(".").pop()?.toLowerCase();
    const supportedExtensions = ["csv", "xlsx", "xml", "txt", "json", "jsonl", "ndjson"];
    if (!extension || !supportedExtensions.includes(extension)) {
      setError("CSV, XLSX, XML, TXT 또는 JSON 파일만 올릴 수 있어요.");
      return;
    }

    setError("");
    setStatus("reading");

    try {
      if (extension === "csv") {
        Papa.parse<DataRow>(nextFile, {
          header: true,
          skipEmptyLines: "greedy",
          worker: false,
          complete: (result) => {
            try {
              if (result.errors.length && !result.data.length) {
                throw new Error(result.errors[0].message);
              }
              const sourceColumns = result.meta.fields ?? [];
              const normalizedColumns = normalizeHeaders(sourceColumns);
              const normalizedRows = result.data.map((row) =>
                Object.fromEntries(
                  sourceColumns.map((sourceColumn, index) => [
                    normalizedColumns[index],
                    row[sourceColumn],
                  ]),
                ),
              );
              loadParsedRows(normalizedRows, normalizedColumns, nextFile);
            } catch (parseError) {
              setError(parseError instanceof Error ? parseError.message : "CSV 파일을 읽지 못했습니다.");
              setStatus("idle");
            }
          },
          error: (parseError) => {
            setError(parseError.message || "CSV 파일을 읽지 못했습니다.");
            setStatus("idle");
          },
        });
      } else if (extension === "xml") {
        const xmlText = await nextFile.text();
        const parsed = parseHistoryXml(xmlText);
        loadParsedRows(parsed.rows, parsed.columns, nextFile, "역사 사료 XML");
      } else if (extension === "txt") {
        const parsed = parsePlainText(await nextFile.text());
        loadParsedRows(parsed.rows, parsed.columns, nextFile, "텍스트 문단");
      } else if (["json", "jsonl", "ndjson"].includes(extension)) {
        const parsed = parseJsonText(await nextFile.text());
        loadParsedRows(parsed.rows, parsed.columns, nextFile, parsed.sourceName);
      } else {
        const XLSX = await import("xlsx");
        const arrayBuffer = await nextFile.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
        const firstSheetName = workbook.SheetNames[0];
        if (!firstSheetName) throw new Error("엑셀 파일에 시트가 없습니다.");
        const worksheet = workbook.Sheets[firstSheetName];
        const jsonRows = XLSX.utils.sheet_to_json<DataRow>(worksheet, {
          defval: "",
          raw: false,
        });
        const headerRows = XLSX.utils.sheet_to_json<Cell[]>(worksheet, {
          header: 1,
          range: 0,
          blankrows: false,
        });
        const headers = (headerRows[0] ?? []).map((value, index) =>
          String(value ?? "").trim() || `열_${index + 1}`,
        );
        loadParsedRows(jsonRows, headers, nextFile, firstSheetName);
      }
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : "파일을 읽는 중 문제가 생겼습니다.");
      setStatus("idle");
    }
  }

  function handleFiles(fileList: FileList | null) {
    const nextFile = fileList?.[0];
    if (nextFile) void parseFile(nextFile);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    handleFiles(event.dataTransfer.files);
  }

  function handleInput(event: ChangeEvent<HTMLInputElement>) {
    handleFiles(event.target.files);
  }

  async function copyHistoryPrompt() {
    try {
      await navigator.clipboard.writeText(HISTORY_SOURCE_PROMPT);
      setPromptCopied(true);
      window.setTimeout(() => setPromptCopied(false), 1800);
    } catch {
      setError("프롬프트를 복사하지 못했습니다. 브라우저의 클립보드 권한을 확인해 주세요.");
    }
  }

  function toggleColumn(column: string) {
    setSelectedColumns((current) => {
      const next = new Set(current);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      return next;
    });
  }

  async function convertAndDownload() {
    if (!file || !chosenColumns.length) return;
    setStatus("converting");
    setError("");

    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      const parts = makeTextParts(outputRows, chosenColumns, exportMode);
      const baseName = `${safeBaseName(file.name)}_${exportMode === "source" ? "사료해석용" : "AI학습용"}`;

      if (parts.length === 1) {
        downloadBlob(new Blob([parts[0]], { type: "text/plain;charset=utf-8" }), `${baseName}.txt`);
      } else {
        const zip = new JSZip();
        parts.forEach((part, index) => {
          zip.file(`${baseName}_${String(index + 1).padStart(2, "0")}.txt`, part);
        });
        const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
        downloadBlob(blob, `${baseName}_${parts.length}개.zip`);
      }
      setStatus("ready");
    } catch {
      setError("변환 파일을 만드는 중 문제가 생겼습니다. 행 수를 줄여 다시 시도해 주세요.");
      setStatus("ready");
    }
  }

  return (
    <main>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#" aria-label="AI 데이터 슬림 처음으로">
            <span className="brand-mark"><Database size={19} strokeWidth={2.4} /></span>
            <span>AI 데이터 슬림</span>
          </a>
          <span className="privacy-chip"><LockKeyhole size={14} /> 서버 전송 없이 안전하게</span>
        </div>
      </header>

      <section className="hero">
        <div className="hero-inner">
          <div className="eyebrow"><Sparkles size={15} /> 교사를 위한 공공데이터 변환 도구</div>
          <h1>무거운 공공데이터를<br /><em>AI가 읽기 좋은 자료</em>로.</h1>
          <p>CSV·엑셀·XML·TXT·JSON 파일에서 필요한 열과 행만 골라 NotebookLM, ChatGPT, Gems용 텍스트로 가볍게 바꿔보세요.</p>
          <div className="flow" aria-label="사용 순서">
            <span className="active"><b>1</b> 파일 올리기</span><ChevronRight />
            <span className={file ? "active" : ""}><b>2</b> 데이터 고르기</span><ChevronRight />
            <span className={file ? "active" : ""}><b>3</b> 변환하기</span>
          </div>
        </div>
      </section>

      <section className="workspace">
        {!file ? (
          <div className="upload-panel">
            <div
              className={`drop-zone ${isDragging ? "dragging" : ""}`}
              onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => { if (event.currentTarget === event.target) setIsDragging(false); }}
              onDrop={handleDrop}
            >
              {status === "reading" ? (
                <>
                  <div className="upload-icon loading"><LoaderCircle size={34} /></div>
                  <h2>데이터를 읽고 있어요</h2>
                  <p>잠시만 기다려 주세요. 대용량 파일도 안정적으로 처리합니다.</p>
                </>
              ) : (
                <>
                  <div className="upload-icon"><UploadCloud size={34} /></div>
                  <h2>파일을 이곳에 끌어다 놓으세요</h2>
                  <p>또는 아래 버튼을 눌러 컴퓨터에서 파일을 선택하세요.</p>
                  <button className="primary-button" type="button" onClick={() => inputRef.current?.click()}>
                    <FileSpreadsheet size={18} /> 파일 선택하기
                  </button>
                  <small>지원 형식 · CSV, XLSX, XML, TXT, JSON</small>
                </>
              )}
              <input
                ref={inputRef}
                className="sr-only"
                type="file"
                accept=".csv,.xlsx,.xml,.txt,.json,.jsonl,.ndjson,text/csv,text/plain,application/json,application/x-ndjson,application/xml,text/xml,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={handleInput}
              />
            </div>
            <div className="reassurance">
              <span><LockKeyhole size={18} /></span>
              <div><strong>파일은 외부로 전송되지 않아요</strong><p>모든 작업은 지금 사용 중인 웹 브라우저 안에서만 처리됩니다.</p></div>
            </div>
          </div>
        ) : (
          <div className="data-layout">
            <div className="main-column">
              <section className="card file-card">
                <div className="file-badge"><FileSpreadsheet size={22} /></div>
                <div className="file-details">
                  <span className="section-kicker">업로드 완료</span>
                  <h2>{file.name}</h2>
                  <p>{readableBytes(file.size)} · {rows.length.toLocaleString()}개 행 · {columns.length}개 열{sheetName && ` · ${sheetName}`}</p>
                </div>
                <button className="icon-button" type="button" onClick={resetData} aria-label="파일 제거"><X size={20} /></button>
              </section>

              <section className="card">
                <div className="card-heading">
                  <div>
                    <span className="step-label">STEP 2</span>
                    <h2>AI에게 보여줄 열을 골라주세요</h2>
                    <p>질문에 필요하지 않은 정보는 빼면 자료가 훨씬 가벼워져요.</p>
                  </div>
                  <div className="selection-actions">
                    <button type="button" onClick={() => setSelectedColumns(new Set(columns))}>전체 선택</button>
                    <i />
                    <button type="button" onClick={() => setSelectedColumns(new Set())}>전체 해제</button>
                  </div>
                </div>

                <div className="column-list">
                  {columns.map((column) => (
                    <label className={selectedColumns.has(column) ? "column-option selected" : "column-option"} key={column}>
                      <input
                        type="checkbox"
                        checked={selectedColumns.has(column)}
                        onChange={() => toggleColumn(column)}
                      />
                      <span className="custom-check">{selectedColumns.has(column) && <Check size={14} strokeWidth={3} />}</span>
                      <span title={column}>{column}</span>
                    </label>
                  ))}
                </div>

                <div className="preview-heading">
                  <div><Rows3 size={17} /><strong>데이터 미리보기</strong><span>상위 5개 행</span></div>
                  <p>{chosenColumns.length}개 열 선택됨</p>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th className="row-number">#</th>
                        {chosenColumns.map((column) => <th key={column}>{column}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          <td className="row-number">{rowIndex + 1}</td>
                          {chosenColumns.map((column) => <td key={column} title={normalizeValue(row[column])}>{normalizeValue(row[column])}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!chosenColumns.length && <div className="empty-preview">미리 볼 열을 하나 이상 선택해 주세요.</div>}
                </div>
              </section>
            </div>

            <aside className="card settings-card">
              <span className="step-label">STEP 3</span>
              <h2>변환 범위를 정해요</h2>
              <p>AI가 빠르게 읽도록 필요한 만큼만 남겨보세요.</p>

              <fieldset className="export-mode">
                <legend>내보내기 방식</legend>
                <label className={exportMode === "standard" ? "radio-option selected" : "radio-option"}>
                  <input type="radio" name="exportMode" checked={exportMode === "standard"} onChange={() => setExportMode("standard")} />
                  <span className="radio-dot" />
                  <span><strong>기본 AI 학습용</strong><small>항목: 값 형식의 간단한 TXT</small></span>
                </label>
                <label className={exportMode === "source" ? "radio-option selected" : "radio-option"}>
                  <input type="radio" name="exportMode" checked={exportMode === "source"} onChange={() => setExportMode("source")} />
                  <span className="radio-dot" />
                  <span><strong>역사 사료 해석용</strong><small>원문과 해석 보조 틀을 함께 만들기</small></span>
                </label>
              </fieldset>

              {exportMode === "source" && (
                <div className="history-prompt-box">
                  <div className="history-prompt-heading">
                    <span><Sparkles size={15} /> ChatGPT 해석 프롬프트</span>
                    <button type="button" onClick={() => void copyHistoryPrompt()}>
                      {promptCopied ? <><Check size={14} /> 복사 완료</> : <><Copy size={14} /> 클립보드로 복사</>}
                    </button>
                  </div>
                  <pre>{HISTORY_SOURCE_PROMPT}</pre>
                </div>
              )}

              <fieldset>
                <legend>남길 행 수</legend>
                {[
                  { value: 1000, label: "상위 1,000개", hint: "빠른 분석에 추천" },
                  { value: 5000, label: "상위 5,000개", hint: "넉넉한 표본" },
                  { value: "all", label: "전체 데이터", hint: `${rows.length.toLocaleString()}개 행` },
                ].map((option) => (
                  <label className={rowLimit === option.value ? "radio-option selected" : "radio-option"} key={option.value}>
                    <input
                      type="radio"
                      name="rowLimit"
                      checked={rowLimit === option.value}
                      onChange={() => setRowLimit(option.value as RowLimit)}
                    />
                    <span className="radio-dot" />
                    <span><strong>{option.label}</strong><small>{option.hint}</small></span>
                  </label>
                ))}
              </fieldset>

              <div className="format-box">
                <span><Info size={16} /> 변환 예시</span>
                <code>{exportMode === "source" ? "원문: 大韓帝國 · 한글 독음: [확인] · 현대어 풀이: [작성]" : "지역: 서울, 학교급: 중학교, 학생수: 320"}</code>
              </div>

              <div className="summary-box">
                <div><span>내보내기 방식</span><strong>{exportMode === "source" ? "사료 해석용" : "기본 AI 학습용"}</strong></div>
                <div><span>변환할 데이터</span><strong>{outputRows.length.toLocaleString()}개 행</strong></div>
                <div><span>선택한 열</span><strong>{chosenColumns.length}개</strong></div>
                <div><span>파일 분할</span><strong>3MB 단위</strong></div>
              </div>

              <button
                className="download-button"
                type="button"
                disabled={!chosenColumns.length || status === "converting"}
                onClick={() => void convertAndDownload()}
              >
                {status === "converting" ? <><LoaderCircle className="spin" size={20} /> 변환하는 중...</> : <><Download size={20} /> {exportMode === "source" ? "사료 해석용 TXT 다운로드" : "TXT로 변환해 다운로드"}</>}
              </button>
              <p className="download-note"><FileArchive size={14} /> 파일이 3MB를 넘으면 ZIP으로 묶어드려요.</p>
              <button className="reset-button" type="button" onClick={resetData}><RefreshCcw size={15} /> 다른 파일로 시작하기</button>
            </aside>
          </div>
        )}

        {error && <div className="error-message" role="alert"><Info size={18} /><span>{error}</span><button onClick={() => setError("")} aria-label="오류 메시지 닫기"><X size={16} /></button></div>}
      </section>

      <footer>
        <span>교사의 시간을 아끼는 작은 도구</span>
        <strong>@miraehistory</strong>
      </footer>
    </main>
  );
}
