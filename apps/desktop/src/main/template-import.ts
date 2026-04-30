import { basename, extname, join } from 'node:path';
import { appendFile, copyFile, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import JSZip from 'jszip';
import { buildRenderReferenceXmlParts, ensureStylesContentType } from '../../../../packages/schema/src/index.js';
import type {
  AppPaths,
  ExtractedPageMargins,
  ExtractedPageSettings,
  ExtractedParagraphInfo,
  ExtractedParagraphRunSummary,
  ExtractedStyleInfo,
  ExtractedTableInfo,
  ImportedTemplateSummary,
  SchemaVersion,
  Template,
  TemplateAsset,
  TemplateImportProgress,
  TemplateImportStage,
  TemplateRoleBinding,
  TemplateSchemaDraft,
} from '../../../../packages/shared/src/index.js';

interface ExtractedDocumentFacts {
  page?: ExtractedPageSettings;
  sectionPropertiesXml?: string;
  styles: ExtractedStyleInfo[];
  paragraphs: ExtractedParagraphInfo[];
  tables: ExtractedTableInfo[];
  sectionCount: number;
  headerFooterDetected: boolean;
  numberingDetected: boolean;
  packageFiles: string[];
}

export interface TemplateImportLogger {
  importId: string;
  logPath: string;
  mark: (
    stage: TemplateImportStage,
    status?: TemplateImportProgress['status'],
    details?: Partial<Omit<TemplateImportProgress, 'importId' | 'stage' | 'status' | 'timestamp' | 'elapsedMs'>>,
  ) => Promise<void>;
}

const DOC_CONVERSION_TIMEOUT_MS = 20000;
const TEXTUTIL_KILL_GRACE_MS = 3000;
const SOFFICE_KILL_GRACE_MS = 5000;

function sha256(content: Uint8Array | Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function sanitizeFileStem(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'template';
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function readAttr(block: string, attr: string): string | undefined {
  const escaped = attr.replace(':', ':');
  const match = block.match(new RegExp(`${escaped}="([^"]+)"`));
  return match?.[1];
}

function numberAttr(block: string, attr: string): number | undefined {
  const value = readAttr(block, attr);
  return value === undefined ? undefined : Number(value);
}

function normalizeSemanticText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[：﹕︰]/g, ':')
    .replace(/[，]/g, ',')
    .replace(/[．。]/g, '.')
    .replace(/[\t\r\n ]+/g, '')
    .replace(/第([0-9]+)章/g, '第$1章')
    .replace(/[xX]\s*$/g, '')
    .trim();
}

function visibleSemanticText(text: string): string {
  return text
    .replace(/TOC\s+\\o\s+"[^"]+"\s+\\h\s+\\z\s+\\u/gi, '')
    .replace(/HYPERLINK\s+\\l\s+"[^"]+"/gi, '')
    .replace(/PAGEREF\s+_[^\s]+/gi, '')
    .replace(/\t+\s*[0-9ivxlcdmIVXLCDM一二三四五六七八九十xX]+\s*$/g, '')
    .replace(/\s+x\s*$/i, '')
    .replace(/[ \r\n]+/g, ' ')
    .trim();
}

export async function createTemplateImportLogger(
  paths: AppPaths,
  onProgress?: (progress: TemplateImportProgress) => void,
): Promise<TemplateImportLogger> {
  await mkdir(paths.logsDir, { recursive: true });
  const importId = randomUUID();
  const startedAt = Date.now();
  const logPath = join(paths.logsDir, 'template-import.log');

  return {
    importId,
    logPath,
    mark: async (stage, status = 'finished', details = {}) => {
      const progress: TemplateImportProgress = {
        importId,
        stage,
        status,
        timestamp: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        logPath,
        ...details,
      };
      await appendFile(logPath, `${JSON.stringify(progress)}\n`, 'utf8');
      onProgress?.(progress);
    },
  };
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

function extractStyles(stylesXml: string): ExtractedStyleInfo[] {
  const matches = stylesXml.matchAll(/<w:style\b[^>]*w:type="([^"]+)"[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g);
  const styles: ExtractedStyleInfo[] = [];

  for (const match of matches) {
    const [, type, styleId, body] = match;
    const nameMatch = body.match(/<w:name\b[^>]*w:val="([^"]+)"/);
    styles.push({
      styleId,
      type,
      name: nameMatch?.[1],
    });
  }

  return styles;
}

function extractIndentation(block: string): ExtractedParagraphInfo['indentation'] | undefined {
  const match = block.match(/<w:ind\b([^>]*)\/>/);
  if (!match) {
    return undefined;
  }

  const attrs = match[1];
  const indentation = {
    left: numberAttr(attrs, 'w:left'),
    right: numberAttr(attrs, 'w:right'),
    firstLine: numberAttr(attrs, 'w:firstLine') ?? numberAttr(attrs, 'w:first-line'),
    hanging: numberAttr(attrs, 'w:hanging'),
  };

  return Object.values(indentation).some((value) => value !== undefined) ? indentation : undefined;
}

function extractSpacing(block: string): ExtractedParagraphInfo['spacing'] | undefined {
  const match = block.match(/<w:spacing\b([^>]*)\/>/);
  if (!match) {
    return undefined;
  }

  const attrs = match[1];
  const spacing = {
    before: numberAttr(attrs, 'w:before'),
    after: numberAttr(attrs, 'w:after'),
    line: numberAttr(attrs, 'w:line'),
    lineRule: readAttr(attrs, 'w:lineRule'),
  };

  return Object.values(spacing).some((value) => value !== undefined) ? spacing : undefined;
}

function mostCommon<T extends string | number>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function hasEnabledTag(block: string, tag: string): boolean {
  const matches = block.matchAll(new RegExp(`<${tag}\\b([^>]*)\\/?>(?:<\\/${tag}>)?`, 'g'));
  for (const match of matches) {
    const val = readAttr(match[1], 'w:val');
    if (val !== '0' && val !== 'false') {
      return true;
    }
  }
  return false;
}

function extractRunSummary(block: string): ExtractedParagraphRunSummary {
  const runs = [...block.matchAll(/<w:r\b[\s\S]*?<\/w:r>/g)];
  const fontSizes: number[] = [];
  const fonts: string[] = [];
  const eastAsiaFonts: string[] = [];
  let boldRunCount = 0;
  let italicRunCount = 0;
  let underlineRunCount = 0;
  let textRunCount = 0;

  for (const run of runs) {
    const runBlock = run[0];
    const hasText = /<w:t\b|<w:instrText\b/.test(runBlock);
    if (hasText) {
      textRunCount += 1;
    }
    if (hasEnabledTag(runBlock, 'w:b')) {
      boldRunCount += 1;
    }
    if (hasEnabledTag(runBlock, 'w:i')) {
      italicRunCount += 1;
    }
    if (hasEnabledTag(runBlock, 'w:u')) {
      underlineRunCount += 1;
    }

    for (const sizeMatch of runBlock.matchAll(/<w:sz\b[^>]*w:val="([^"]+)"/g)) {
      const value = Number(sizeMatch[1]);
      if (Number.isFinite(value)) {
        fontSizes.push(value);
      }
    }

    for (const fontsMatch of runBlock.matchAll(/<w:rFonts\b([^>]*)\/>/g)) {
      const ascii = readAttr(fontsMatch[1], 'w:ascii');
      const eastAsia = readAttr(fontsMatch[1], 'w:eastAsia');
      const hAnsi = readAttr(fontsMatch[1], 'w:hAnsi');
      const cs = readAttr(fontsMatch[1], 'w:cs');
      const font = eastAsia ?? ascii ?? hAnsi ?? cs;
      if (font) {
        fonts.push(font);
      }
      if (eastAsia) {
        eastAsiaFonts.push(eastAsia);
      }
    }
  }

  const uniqueSizes = [...new Set(fontSizes)];
  const uniqueFonts = [...new Set(fonts)];
  const runCount = runs.length;

  return {
    runs: runCount,
    runCount,
    textRunCount,
    boldRuns: boldRunCount,
    boldRunCount,
    italicRuns: italicRunCount,
    italicRunCount,
    underlineRunCount,
    sizes: uniqueSizes.map(String),
    fontSizes: uniqueSizes,
    maxFontSize: uniqueSizes.length ? Math.max(...uniqueSizes) : undefined,
    minFontSize: uniqueSizes.length ? Math.min(...uniqueSizes) : undefined,
    dominantFontSize: mostCommon(fontSizes),
    fonts: uniqueFonts,
    eastAsiaFonts: [...new Set(eastAsiaFonts)],
    dominantFont: mostCommon(fonts),
    hasBold: boldRunCount > 0,
    mostlyBold: runCount > 0 && boldRunCount >= Math.ceil(runCount / 2),
  };
}

function extractParagraphText(block: string): Pick<ExtractedParagraphInfo, 'rawText' | 'visibleText' | 'normalizedText' | 'text' | 'isFieldCode' | 'isTocHyperlink'> {
  const rawParts: string[] = [];
  const visibleParts: string[] = [];
  const tokens = block.matchAll(/<w:(t|instrText)\b[^>]*>([\s\S]*?)<\/w:\1>|<w:(tab|br)\b[^>]*\/>|<w:fldChar\b[^>]*w:fldCharType="([^"]+)"[^>]*\/>/g);
  let isFieldCode = false;

  for (const token of tokens) {
    const tag = token[1] ?? token[3];
    if (tag === 't') {
      const value = decodeXmlText(token[2] ?? '');
      rawParts.push(value);
      visibleParts.push(value);
    } else if (tag === 'instrText') {
      const value = decodeXmlText(token[2] ?? '');
      rawParts.push(value);
      isFieldCode = true;
    } else if (tag === 'tab') {
      rawParts.push('\t');
      visibleParts.push('\t');
    } else if (tag === 'br') {
      rawParts.push('\n');
      visibleParts.push('\n');
    }
  }

  const rawText = rawParts.join('').replace(/\u0000/g, '').trim();
  const visibleText = visibleSemanticText(visibleParts.join('').replace(/\u0000/g, '').trim());
  const text = visibleSemanticText(rawText);
  const normalizedText = normalizeSemanticText(visibleText || text);
  const isTocHyperlink = /(?:TOC\s+\\o|HYPERLINK\s+\\l)/i.test(rawText);

  return {
    rawText,
    visibleText,
    normalizedText,
    text,
    isFieldCode,
    isTocHyperlink,
  };
}

function extractSectionBreak(block: string): ExtractedParagraphInfo['sectionBreak'] | undefined {
  const sectionMatch = block.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/);
  if (!sectionMatch) {
    return undefined;
  }

  const type = sectionMatch[0].match(/<w:type\b[^>]*w:val="([^"]+)"/)?.[1];
  return {
    type,
    page: extractPageSettings(sectionMatch[0]),
  };
}

function extractParagraphs(documentXml: string): ExtractedParagraphInfo[] {
  const paragraphMatches = documentXml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g);
  const paragraphs: ExtractedParagraphInfo[] = [];
  let index = 0;

  for (const match of paragraphMatches) {
    const block = match[0];
    const styleMatch = block.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/);
    const alignmentMatch = block.match(/<w:jc\b[^>]*w:val="([^"]+)"/);
    const outlineMatch = block.match(/<w:outlineLvl\b[^>]*w:val="([^"]+)"/);
    const numIdMatch = block.match(/<w:numId\b[^>]*w:val="([^"]+)"/);
    const levelMatch = block.match(/<w:ilvl\b[^>]*w:val="([^"]+)"/);
    const textParts = extractParagraphText(block);

    paragraphs.push({
      index,
      ...textParts,
      styleId: styleMatch?.[1],
      alignment: alignmentMatch?.[1],
      outlineLevel: outlineMatch?.[1] === undefined ? undefined : Number(outlineMatch[1]),
      numbering: numIdMatch || levelMatch ? { numId: numIdMatch?.[1], level: levelMatch?.[1], ilvl: levelMatch?.[1] } : undefined,
      indentation: extractIndentation(block),
      spacing: extractSpacing(block),
      runSummary: extractRunSummary(block),
      pageBreakBefore: /<w:pageBreakBefore\b/.test(block),
      containsPageBreak: /<w:br\b[^>]*w:type="page"|<w:lastRenderedPageBreak\b/.test(block),
      sectionBreak: extractSectionBreak(block),
    });
    index += 1;
  }

  return paragraphs;
}

function extractTableTextSample(block: string): string {
  return [...block.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXmlText(match[1]))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function extractTableBorders(tblPrXml: string): ExtractedTableInfo['borders'] | undefined {
  const borderMatch = tblPrXml.match(/<w:tblBorders\b[\s\S]*?<\/w:tblBorders>/);
  if (!borderMatch) {
    return undefined;
  }
  const readBorder = (name: string) => borderMatch[0].match(new RegExp(`<w:${name}\\b[^>]*w:val="([^"]+)"`))?.[1];
  return {
    top: readBorder('top'),
    left: readBorder('left'),
    bottom: readBorder('bottom'),
    right: readBorder('right'),
    insideH: readBorder('insideH'),
    insideV: readBorder('insideV'),
  };
}

function extractTableCellMargins(tblPrXml: string): ExtractedTableInfo['cellMargins'] | undefined {
  const marginsMatch = tblPrXml.match(/<w:tblCellMar\b[\s\S]*?<\/w:tblCellMar>/);
  if (!marginsMatch) {
    return undefined;
  }
  const readMargin = (name: string) => numberAttr(marginsMatch[0].match(new RegExp(`<w:${name}\\b([^>]*)\\/>`))?.[1] ?? '', 'w:w');
  return {
    top: readMargin('top'),
    left: readMargin('left'),
    bottom: readMargin('bottom'),
    right: readMargin('right'),
  };
}

function extractTables(documentXml: string): ExtractedTableInfo[] {
  return [...documentXml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>/g)].map((match, index) => {
    const block = match[0];
    const tblPrXml = block.match(/<w:tblPr\b[\s\S]*?<\/w:tblPr>/)?.[0];
    const widthAttrs = tblPrXml?.match(/<w:tblW\b([^>]*)\/>/)?.[1] ?? '';
    return {
      index,
      textSample: extractTableTextSample(block),
      styleId: tblPrXml?.match(/<w:tblStyle\b[^>]*w:val="([^"]+)"/)?.[1],
      alignment: tblPrXml?.match(/<w:jc\b[^>]*w:val="([^"]+)"/)?.[1],
      width: widthAttrs
        ? {
            value: numberAttr(widthAttrs, 'w:w'),
            type: readAttr(widthAttrs, 'w:type'),
          }
        : undefined,
      layout: tblPrXml?.match(/<w:tblLayout\b[^>]*w:type="([^"]+)"/)?.[1],
      borders: tblPrXml ? extractTableBorders(tblPrXml) : undefined,
      cellMargins: tblPrXml ? extractTableCellMargins(tblPrXml) : undefined,
      gridColumnWidths: [...block.matchAll(/<w:gridCol\b[^>]*w:w="([^"]+)"/g)].map((gridMatch) => Number(gridMatch[1])).filter(Number.isFinite),
      tblPrXml,
    };
  });
}

function selectBodyTable(tables: ExtractedTableInfo[]): ExtractedTableInfo | undefined {
  return (
    tables.find((table) => Object.values(table.borders ?? {}).some((value) => value && value !== 'nil' && value !== 'none')) ??
    tables.find((table) => table.width?.type === 'dxa') ??
    tables[0]
  );
}

function extractPageSettings(documentXml: string): ExtractedPageSettings | undefined {
  const sectionMatch = extractLastSectionPropertiesXml(documentXml) ?? documentXml;
  if (!sectionMatch.includes('w:pgSz') && !sectionMatch.includes('w:pgMar')) {
    return undefined;
  }

  const pageSizeMatch = sectionMatch.match(/<w:pgSz\b([^>]*)\/>/);
  const pageMarginMatch = sectionMatch.match(/<w:pgMar\b([^>]*)\/>/);
  const page: ExtractedPageSettings = {};

  if (pageSizeMatch) {
    const attrs = pageSizeMatch[1];
    page.widthTwips = numberAttr(attrs, 'w:w');
    page.heightTwips = numberAttr(attrs, 'w:h');
    const orientation = readAttr(attrs, 'w:orient');
    page.orientation = orientation === 'landscape' ? 'landscape' : 'portrait';
  }

  if (pageMarginMatch) {
    const attrs = pageMarginMatch[1];
    const margins: ExtractedPageMargins = {
      top: numberAttr(attrs, 'w:top'),
      right: numberAttr(attrs, 'w:right'),
      bottom: numberAttr(attrs, 'w:bottom'),
      left: numberAttr(attrs, 'w:left'),
      header: numberAttr(attrs, 'w:header'),
      footer: numberAttr(attrs, 'w:footer'),
      gutter: numberAttr(attrs, 'w:gutter'),
    };
    page.margins = margins;
  }

  return page;
}

function extractLastSectionPropertiesXml(documentXml: string): string | undefined {
  return [...documentXml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].pop()?.[0];
}

async function extractDocumentFacts(filePath: string, logger?: TemplateImportLogger): Promise<ExtractedDocumentFacts> {
  await logger?.mark('docx zip read started', 'started', { filePath, fileSizeBytes: await fileSize(filePath) });
  const fileBuffer = await readFile(filePath);
  const zip = await JSZip.loadAsync(fileBuffer);
  const packageFiles = Object.keys(zip.files);
  const documentXml = await zip.file('word/document.xml')?.async('string');

  if (!documentXml) {
    throw new Error('The selected DOCX does not contain word/document.xml.');
  }

  await logger?.mark('document.xml read finished', 'finished', {
    filePath: 'word/document.xml',
    fileSizeBytes: Buffer.byteLength(documentXml, 'utf8'),
  });

  const stylesXml = (await zip.file('word/styles.xml')?.async('string')) ?? '';
  const styles = extractStyles(stylesXml);
  const paragraphs = extractParagraphs(documentXml);
  const tables = extractTables(documentXml);
  await logger?.mark('paragraphs extracted', 'finished', {
    filePath,
    paragraphCount: paragraphs.length,
    styleCount: styles.length,
  });

  return {
    page: extractPageSettings(documentXml),
    sectionPropertiesXml: extractLastSectionPropertiesXml(documentXml),
    styles,
    paragraphs,
    tables,
    sectionCount: (documentXml.match(/<w:sectPr\b/g) ?? []).length || 1,
    headerFooterDetected: packageFiles.some((file) => /^word\/(?:header|footer)\d*\.xml$/.test(file)),
    numberingDetected: packageFiles.includes('word/numbering.xml') || paragraphs.some((paragraph) => paragraph.numbering),
    packageFiles,
  };
}

async function buildRenderReferenceDocx(input: {
  schema: TemplateSchemaDraft;
  sourceDocxPath: string;
  outputPath: string;
  manifestPath: string;
}): Promise<void> {
  const sourceBuffer = await readFile(input.sourceDocxPath);
  const zip = await JSZip.loadAsync(sourceBuffer);
  const contentTypesXml = await zip.file('[Content_Types].xml')?.async('string');
  if (!contentTypesXml) {
    throw new Error('Cannot build render-reference.docx: source DOCX is missing [Content_Types].xml.');
  }

  const existingStylesXml = await zip.file('word/styles.xml')?.async('string');
  const parts = buildRenderReferenceXmlParts({ ...input, existingStylesXml });
  zip.file('word/document.xml', parts.documentXml);
  zip.file('word/styles.xml', parts.stylesXml);
  zip.file('[Content_Types].xml', ensureStylesContentType(contentTypesXml));

  const outputBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  await writeFile(input.outputPath, outputBuffer);
  await writeFile(input.manifestPath, JSON.stringify(parts.manifest, null, 2), 'utf8');
}

async function runSofficeConversion(inputPath: string, outputDir: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'soffice',
      [
        `-env:UserInstallation=file://${join(outputDir, 'lo-profile')}`,
        '--headless',
        '--convert-to',
        'docx',
        '--outdir',
        outputDir,
        inputPath,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const forceKillTimeout = setTimeout(() => {
      if (!settled && timedOut) {
        child.kill('SIGKILL');
        settled = true;
        reject(new Error(`soffice did not exit within ${SOFFICE_KILL_GRACE_MS}ms after timeout.`));
      }
    }, DOC_CONVERSION_TIMEOUT_MS + SOFFICE_KILL_GRACE_MS);

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      }, 1000).unref();
    }, DOC_CONVERSION_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKillTimeout);
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKillTimeout);

      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (timedOut) {
        reject(new Error(`soffice conversion exceeded ${DOC_CONVERSION_TIMEOUT_MS / 1000} seconds and was terminated. signal=${signal ?? 'none'} stdout=${stdout} stderr=${stderr}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`soffice exited with code ${code ?? 'null'} signal=${signal ?? 'none'} stdout=${stdout} stderr=${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function runTextutilConversion(inputPath: string, outputPath: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('textutil', ['-convert', 'docx', inputPath, '-output', outputPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const forceKillTimeout = setTimeout(() => {
      if (!settled && timedOut) {
        child.kill('SIGKILL');
        settled = true;
        reject(new Error(`textutil did not exit within ${TEXTUTIL_KILL_GRACE_MS}ms after timeout.`));
      }
    }, DOC_CONVERSION_TIMEOUT_MS + TEXTUTIL_KILL_GRACE_MS);

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      }, 500).unref();
    }, DOC_CONVERSION_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKillTimeout);
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKillTimeout);

      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (timedOut) {
        reject(new Error(`textutil conversion exceeded ${DOC_CONVERSION_TIMEOUT_MS / 1000} seconds and was terminated. signal=${signal ?? 'none'} stdout=${stdout} stderr=${stderr}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`textutil exited with code ${code ?? 'null'} signal=${signal ?? 'none'} stdout=${stdout} stderr=${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function ensureAnalysisDocx(filePath: string, versionDir: string, logger?: TemplateImportLogger): Promise<{ analysisDocxPath: string; cleanupPaths: string[] }> {
  const extension = extname(filePath).toLowerCase();

  if (extension === '.docx') {
    return {
      analysisDocxPath: filePath,
      cleanupPaths: [],
    };
  }

  if (extension !== '.doc') {
    throw new Error('Only .doc and .docx files are supported for template import.');
  }

  const convertedPath = join(versionDir, 'converted-source-template.docx');
  await logger?.mark('doc conversion started', 'started', { filePath, fileSizeBytes: await fileSize(filePath) });
  let result: { stdout: string; stderr: string };
  let converter = 'soffice';
  try {
    const sofficeOutDir = join(versionDir, 'soffice-conversion');
    await mkdir(sofficeOutDir, { recursive: true });
    result = await runSofficeConversion(filePath, sofficeOutDir);
    const sofficeOutputPath = join(sofficeOutDir, `${basename(filePath, extname(filePath))}.docx`);
    const sofficeOutputSize = await fileSize(sofficeOutputPath);
    if (!sofficeOutputSize) {
      throw new Error(`soffice conversion finished but output is missing or empty. stdout=${result.stdout} stderr=${result.stderr}`);
    }
    await copyFile(sofficeOutputPath, convertedPath);
  } catch (sofficeError) {
    converter = 'textutil';
    result = await runTextutilConversion(filePath, convertedPath);
    result = {
      stdout: result.stdout,
      stderr: [result.stderr, `soffice fallback reason: ${sofficeError instanceof Error ? sofficeError.message : String(sofficeError)}`].filter(Boolean).join('\n'),
    };
  }
  const convertedSize = await fileSize(convertedPath);
  if (!convertedSize) {
    throw new Error(`${converter} conversion finished but output is missing or empty. stdout=${result.stdout} stderr=${result.stderr}`);
  }
  await logger?.mark('doc conversion finished', 'finished', {
    filePath: convertedPath,
    fileSizeBytes: convertedSize,
    message: [`converter=${converter}`, result.stdout, result.stderr].filter(Boolean).join('\n') || undefined,
  });

  return {
    analysisDocxPath: convertedPath,
    cleanupPaths: [],
  };
}

function findStyle(styles: ExtractedStyleInfo[], pattern: RegExp): ExtractedStyleInfo | undefined {
  return styles.find((style) => pattern.test(`${style.styleId} ${style.name ?? ''}`));
}

function formatSnapshot(paragraph?: ExtractedParagraphInfo): TemplateRoleBinding['formatting'] | undefined {
  if (!paragraph) {
    return undefined;
  }

  return {
    alignment: paragraph.alignment,
    outlineLevel: paragraph.outlineLevel,
    numbering: paragraph.numbering,
    indentation: paragraph.indentation,
    spacing: paragraph.spacing,
    runSummary: paragraph.runSummary,
  };
}

function bindParagraph(paragraph?: ExtractedParagraphInfo, notes?: string, confidence = 0, evidence: string[] = []): TemplateRoleBinding {
  return {
    styleId: paragraph?.styleId,
    sampleText: paragraph?.visibleText || paragraph?.text,
    normalizedText: paragraph?.normalizedText,
    paragraphIndex: paragraph?.index,
    paragraphIndexes: paragraph ? [paragraph.index] : undefined,
    confidence: paragraph ? confidence : 0,
    evidence,
    formatting: formatSnapshot(paragraph),
    notes,
  };
}

function bindParagraphs(paragraphs: ExtractedParagraphInfo[], notes: string, confidence: number, evidence: string[]): TemplateRoleBinding {
  return {
    sampleText: paragraphs.map((paragraph) => paragraph.visibleText || paragraph.text).join('\n').slice(0, 500),
    normalizedText: paragraphs.map((paragraph) => paragraph.normalizedText).join('|'),
    paragraphIndex: paragraphs[0]?.index,
    paragraphIndexes: paragraphs.map((paragraph) => paragraph.index),
    confidence: paragraphs.length ? confidence : 0,
    evidence,
    formatting: formatSnapshot(paragraphs[0]),
    notes,
  };
}

function maxRunSize(paragraph: ExtractedParagraphInfo): number {
  return paragraph.runSummary?.maxFontSize ?? Math.max(...(paragraph.runSummary?.fontSizes ?? paragraph.runSummary?.sizes.map(Number).filter(Number.isFinite) ?? [0]));
}

function isMostlyBold(paragraph: ExtractedParagraphInfo): boolean {
  return Boolean(paragraph.runSummary?.mostlyBold);
}

function semanticText(paragraph: ExtractedParagraphInfo): string {
  return paragraph.normalizedText ?? normalizeSemanticText(paragraph.visibleText || paragraph.text);
}

function isTocEntry(paragraph: ExtractedParagraphInfo): boolean {
  const text = paragraph.visibleText || paragraph.text;
  return (
    Boolean(paragraph.isTocHyperlink) ||
    /^TOC\d+$/i.test(paragraph.styleId ?? '') ||
    /TOC\s+\\o|HYPERLINK\s+\\l/i.test(paragraph.rawText ?? paragraph.text) ||
    /[.．。·…]{3,}\s*\d+\s*$/.test(text)
  );
}

function isCoverTitlePageHeading(paragraph: ExtractedParagraphInfo): boolean {
  return /^(本科生?毕业设计\(论文\)|本科毕业设计\(论文\)|毕业设计\(论文\))$/.test(semanticText(paragraph));
}

function coverFieldKind(paragraph: ExtractedParagraphInfo):
  | 'titleField'
  | 'authorField'
  | 'studentIdField'
  | 'schoolField'
  | 'majorField'
  | 'supervisorField'
  | undefined {
  const text = semanticText(paragraph).replace(/:.*$/, '');
  if (/^(题目|论文题目|毕业设计\(论文\)题目)$/.test(text) || /题目$/.test(text)) return 'titleField';
  if (/^(学生姓名|姓名|作者|研究生姓名)$/.test(text)) return 'authorField';
  if (/^学号$/.test(text)) return 'studentIdField';
  if (/^(学院|学院名称|系|培养单位|院系)$/.test(text)) return 'schoolField';
  if (/^(专业|专业年级|学科专业|专业名称)$/.test(text)) return 'majorField';
  if (/^(指导教师|导师|校内指导教师|企业指导教师)$/.test(text)) return 'supervisorField';
  return undefined;
}

function isCoverOrFrontMatter(paragraph: ExtractedParagraphInfo): boolean {
  const text = semanticText(paragraph);
  return (
    coverFieldKind(paragraph) !== undefined ||
    isCoverTitlePageHeading(paragraph) ||
    /^(学科门类|第一\/第二|年月日|承诺书)$/.test(text) ||
    /^(学位申请人|学位论文指导教师|本人向|在此本人郑重承诺|为确保本科毕业设计)/.test(text)
  );
}

function isChineseAbstractTitle(paragraph: ExtractedParagraphInfo): boolean {
  const text = semanticText(paragraph);
  return /^(年月日)?(中文)?摘要(?:[（(].*)?$/.test(text) || /^(摘)?要(?:[（(].*)?$/.test(text);
}

function isEnglishAbstractTitle(paragraph: ExtractedParagraphInfo): boolean {
  return /^abstract(?:[（(].*)?$/i.test(semanticText(paragraph));
}

function isChineseKeywords(paragraph: ExtractedParagraphInfo): boolean {
  return /^(关键词|关键字)(?:[（(].*)?(?::|$)/.test(semanticText(paragraph));
}

function isEnglishKeywords(paragraph: ExtractedParagraphInfo): boolean {
  return /^(keywords?|key\s*words?)(?:[（(].*)?(?::|$)/i.test(semanticText(paragraph));
}

function isKeywords(paragraph: ExtractedParagraphInfo): boolean {
  return isChineseKeywords(paragraph) || isEnglishKeywords(paragraph);
}

function isTocTitle(paragraph: ExtractedParagraphInfo): boolean {
  return /^(目录|contents)(?:[（(].*)?$/i.test(semanticText(paragraph));
}

function isPlainTextTocEntry(paragraph: ExtractedParagraphInfo): boolean {
  const text = semanticText(paragraph);
  const visible = paragraph.visibleText || paragraph.text;
  if (visible.length > 60) {
    return false;
  }
  return (
    /^(\d+(?:[.．]\d+)*|[一二三四五六七八九十]+)(?:[\u4e00-\u9fa5A-Za-z]|[.．]\d+)/.test(text) ||
    /^(参考文献|参考资料|致谢|致謝|附录|附錄)(?:[A-ZＡ-Ｚ])?$/.test(text)
  );
}

function collectPlainTextTocEntries(paragraphs: ExtractedParagraphInfo[], tocTitle: ExtractedParagraphInfo | undefined): ExtractedParagraphInfo[] {
  if (!tocTitle) {
    return [];
  }

  const entries: ExtractedParagraphInfo[] = [];
  let lastIndex = tocTitle.index;
  for (const paragraph of paragraphs) {
    if (paragraph.index <= tocTitle.index) {
      continue;
    }
    if (paragraph.index - lastIndex > 3) {
      break;
    }
    if (!isPlainTextTocEntry(paragraph)) {
      if ((paragraph.visibleText || paragraph.text).trim()) {
        break;
      }
      continue;
    }
    entries.push(paragraph);
    lastIndex = paragraph.index;
  }
  return entries;
}

function isReferencesTitle(paragraph: ExtractedParagraphInfo): boolean {
  return /^(参考文献|参考资料|references|bibliography)(?:[（(].*)?$/i.test(semanticText(paragraph));
}

function isReferenceItem(paragraph: ExtractedParagraphInfo): boolean {
  return /^(\[\d+\]|\d+\.)/.test((paragraph.visibleText || paragraph.text).trim()) && /\[[A-Z]\]|出版社|期刊|journal/i.test(paragraph.visibleText || paragraph.text);
}

function isAcknowledgementTitle(paragraph: ExtractedParagraphInfo): boolean {
  return /^(致谢|致謝|acknowledgements?)(?:[（(].*)?$/i.test(semanticText(paragraph));
}

function isAppendixTitle(paragraph: ExtractedParagraphInfo): boolean {
  return /^(附录|附錄|appendix)(?:[A-ZＡ-Ｚ])?(?:[（(].*)?$/i.test(semanticText(paragraph));
}

function isTemplateInstruction(paragraph: ExtractedParagraphInfo): boolean {
  const text = semanticText(paragraph);
  return /(宋体|黑体|小四|空半字距离|空一字距离|此处|填写|格式|要求|说明)/.test(text);
}

function isHeading1(paragraph: ExtractedParagraphInfo, heading1Style?: ExtractedStyleInfo): boolean {
  const text = semanticText(paragraph);
  if (isTocEntry(paragraph) || isCoverOrFrontMatter(paragraph) || isTocTitle(paragraph)) {
    return false;
  }
  if (paragraph.styleId && paragraph.styleId === heading1Style?.styleId) {
    return true;
  }
  if (paragraph.outlineLevel === 0) {
    return true;
  }

  const formatLooksStrong = isMostlyBold(paragraph) || paragraph.alignment === 'center' || maxRunSize(paragraph) >= 30;
  return (
    /^(绪论|引言|前言|结论与展望|结语)(?:[（(].*)?$/.test(text) && formatLooksStrong ||
    (/^\d+[\u4e00-\u9fa5A-Za-z]/.test(text) && text.length <= 30 && !/[，,。；;]/.test(text)) ||
    /^(第[一二三四五六七八九十\d]+[章节篇]|[一二三四五六七八九十]+、)/.test(text) ||
    (/^[一二三四五六七八九十]+(?:[\(（]|[\u4e00-\u9fa5])/.test(text) && paragraph.alignment === 'center') ||
    (/^\d+\s+[^\d.．]/.test(text) && formatLooksStrong) ||
    (/^\d+[.．、][^\d.．]/.test(text) && formatLooksStrong && !(paragraph.indentation?.firstLine && paragraph.alignment !== 'center'))
  );
}

function isHeading2(paragraph: ExtractedParagraphInfo, heading2Style?: ExtractedStyleInfo): boolean {
  const text = semanticText(paragraph);
  if (isTocEntry(paragraph) || isCoverOrFrontMatter(paragraph) || isTocTitle(paragraph)) {
    return false;
  }
  if (paragraph.styleId && paragraph.styleId === heading2Style?.styleId) {
    return true;
  }
  if (paragraph.outlineLevel !== undefined && paragraph.outlineLevel > 0 && paragraph.outlineLevel <= 2) {
    return true;
  }

  const formatLooksStrong = isMostlyBold(paragraph) || maxRunSize(paragraph) >= 24 || Boolean(paragraph.spacing?.before || paragraph.spacing?.after);
  if (/^\d+[.．][（(]/.test(text) && paragraph.alignment === 'center' && maxRunSize(paragraph) >= 30) {
    return false;
  }
  return (
    (/^\d+[.．]\d+(?:[.．]\d+)?[\u4e00-\u9fa5A-Za-z]/.test(text) && text.length <= 40 && !/[，,。；;]/.test(text)) ||
    /^(\d+[.．]\d+(?:[.．]\d+)?|[（(][一二三四五六七八九十]+[）)]|\d+[.．][（(])/.test(text) &&
    formatLooksStrong
  );
}

function isFigureCaption(paragraph: ExtractedParagraphInfo): boolean {
  return /^图(?:[\dXx一二三四五六七八九十]+(?:[-－—][\dXx一二三四五六七八九十]+)?)/.test(semanticText(paragraph)) || /^figure\s*\d+/i.test(paragraph.visibleText || paragraph.text);
}

function isTableCaption(paragraph: ExtractedParagraphInfo): boolean {
  return /^表(?:[\dXx一二三四五六七八九十]+(?:[-－—][\dXx一二三四五六七八九十]+)?)/.test(semanticText(paragraph)) || /^table\s*\d+/i.test(paragraph.visibleText || paragraph.text);
}

function firstAfterUntil(
  paragraphs: ExtractedParagraphInfo[],
  start: ExtractedParagraphInfo | undefined,
  stop: (paragraph: ExtractedParagraphInfo) => boolean,
  accept: (paragraph: ExtractedParagraphInfo) => boolean,
): ExtractedParagraphInfo | undefined {
  if (!start) {
    return undefined;
  }

  for (const paragraph of paragraphs) {
    if (paragraph.index <= start.index) {
      continue;
    }
    if (stop(paragraph)) {
      return undefined;
    }
    if (accept(paragraph)) {
      return paragraph;
    }
  }

  return undefined;
}

function collectAfterUntil(
  paragraphs: ExtractedParagraphInfo[],
  start: ExtractedParagraphInfo | undefined,
  stop: (paragraph: ExtractedParagraphInfo) => boolean,
  accept: (paragraph: ExtractedParagraphInfo) => boolean,
): ExtractedParagraphInfo[] {
  if (!start) {
    return [];
  }

  const collected: ExtractedParagraphInfo[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.index <= start.index) {
      continue;
    }
    if (stop(paragraph)) {
      break;
    }
    if (accept(paragraph)) {
      collected.push(paragraph);
    }
  }
  return collected;
}

function confidenceFromFound(...values: Array<unknown | undefined>): number {
  const found = values.filter(Boolean).length;
  return Math.min(0.98, 0.5 + found * 0.08);
}

function inferSchema(
  templateId: string,
  templateVersion: number,
  sourceTemplateAssetId: string,
  facts: ExtractedDocumentFacts,
): { schema: TemplateSchemaDraft; roleCandidates: Record<string, TemplateRoleBinding[]> } {
  const nonEmptyParagraphs = facts.paragraphs.filter((paragraph) => paragraph.visibleText || paragraph.text);
  const titleStyle = findStyle(facts.styles, /(^|\b)(title)(\b|$)/i);
  const heading1Style = findStyle(facts.styles, /heading\s*1|heading1|1st|标题\s*1|一级/i);
  const heading2Style = findStyle(facts.styles, /heading\s*2|heading2|2nd|标题\s*2|二级/i);
  const cover: NonNullable<TemplateSchemaDraft['semanticMapping']['cover']> = {};

  for (const paragraph of nonEmptyParagraphs) {
    const kind = coverFieldKind(paragraph);
    if (kind && !cover[kind]) {
      cover[kind] = bindParagraph(paragraph, `Detected Chinese cover field ${kind}.`, 0.92, ['normalized cover label match', `normalized=${semanticText(paragraph)}`]);
    }
  }

  const chineseAbstractTitle = nonEmptyParagraphs.find((paragraph) => !isTocEntry(paragraph) && isChineseAbstractTitle(paragraph));
  const chineseAbstractBody = collectAfterUntil(
    nonEmptyParagraphs,
    chineseAbstractTitle,
    (paragraph) => isChineseKeywords(paragraph) || isEnglishAbstractTitle(paragraph) || isTocTitle(paragraph),
    (paragraph) => !isTocEntry(paragraph) && !isTemplateInstruction(paragraph) && !isCoverOrFrontMatter(paragraph),
  );
  const chineseKeywords = nonEmptyParagraphs.find((paragraph) => !isTocEntry(paragraph) && isChineseKeywords(paragraph));
  const englishAbstractTitle = nonEmptyParagraphs.find((paragraph) => !isTocEntry(paragraph) && isEnglishAbstractTitle(paragraph));
  const englishAbstractBody = collectAfterUntil(
    nonEmptyParagraphs,
    englishAbstractTitle,
    (paragraph) => isEnglishKeywords(paragraph) || isTocTitle(paragraph),
    (paragraph) => !isTocEntry(paragraph) && !isTemplateInstruction(paragraph),
  );
  const englishKeywords = nonEmptyParagraphs.find((paragraph) => !isTocEntry(paragraph) && isEnglishKeywords(paragraph));
  const tocTitle = nonEmptyParagraphs.find((paragraph) => !isTocEntry(paragraph) && isTocTitle(paragraph));
  const fieldTocEntries = nonEmptyParagraphs.filter(isTocEntry);
  const plainTextTocEntries = collectPlainTextTocEntries(nonEmptyParagraphs, tocTitle);
  const tocEntries = fieldTocEntries.length ? fieldTocEntries : plainTextTocEntries;
  const contentStartIndex = tocEntries.length ? Math.max(...tocEntries.map((paragraph) => paragraph.index)) + 1 : (tocTitle?.index ?? -1) + 1;
  const heading1Candidates = nonEmptyParagraphs.filter((paragraph) => isHeading1(paragraph, heading1Style));
  const heading2Candidates = nonEmptyParagraphs.filter((paragraph) => isHeading2(paragraph, heading2Style));
  const figureCaptionParagraph = nonEmptyParagraphs.find((paragraph) => !isTocEntry(paragraph) && isFigureCaption(paragraph));
  const tableCaptionParagraph = nonEmptyParagraphs.find((paragraph) => !isTocEntry(paragraph) && isTableCaption(paragraph));
  const referencesParagraph = nonEmptyParagraphs.find((paragraph) => !isTocEntry(paragraph) && isReferencesTitle(paragraph));
  const referenceItem = firstAfterUntil(nonEmptyParagraphs, referencesParagraph, isAcknowledgementTitle, isReferenceItem);
  const acknowledgementParagraph = nonEmptyParagraphs.find((paragraph) => !isTocEntry(paragraph) && isAcknowledgementTitle(paragraph));
  const acknowledgementBody = firstAfterUntil(
    nonEmptyParagraphs,
    acknowledgementParagraph,
    isAppendixTitle,
    (paragraph) => !isTocEntry(paragraph) && !isTemplateInstruction(paragraph) && !isReferencesTitle(paragraph) && paragraph.visibleText !== '',
  );
  const appendixParagraph = nonEmptyParagraphs.find((paragraph) => !isTocEntry(paragraph) && isAppendixTitle(paragraph));
  const appendixBody = firstAfterUntil(nonEmptyParagraphs, appendixParagraph, () => false, (paragraph) => !isTocEntry(paragraph) && !isTemplateInstruction(paragraph));

  if (!cover.titleField) {
    const titleLikeParagraph = nonEmptyParagraphs.find((paragraph) => {
      const text = paragraph.visibleText || paragraph.text;
      return (
        paragraph.index < (chineseAbstractTitle?.index ?? tocTitle?.index ?? 80) &&
        !isCoverTitlePageHeading(paragraph) &&
        !coverFieldKind(paragraph) &&
        paragraph.alignment === 'center' &&
        maxRunSize(paragraph) >= 40 &&
        text.length >= 8
      );
    });
    if (titleLikeParagraph) {
      cover.titleField = bindParagraph(titleLikeParagraph, 'Detected cover title text from large centered title-like paragraph.', 0.72, ['large centered paragraph before abstract/TOC']);
    }
  }

  const heading1Paragraph = heading1Candidates.find((paragraph) => !tocTitle || paragraph.index >= contentStartIndex) ?? heading1Candidates[0];
  const heading2Paragraph = heading2Candidates.find((paragraph) => !tocTitle || paragraph.index >= contentStartIndex) ?? heading2Candidates[0];
  const bodyParagraph = firstAfterUntil(
    nonEmptyParagraphs,
    heading1Paragraph,
    (paragraph) => isReferencesTitle(paragraph) || isAcknowledgementTitle(paragraph) || isAppendixTitle(paragraph),
    (paragraph) =>
      !isTocEntry(paragraph) &&
      !isTocTitle(paragraph) &&
      !isCoverOrFrontMatter(paragraph) &&
      !isChineseAbstractTitle(paragraph) &&
      !isEnglishAbstractTitle(paragraph) &&
      !isKeywords(paragraph) &&
      !isHeading1(paragraph, heading1Style) &&
      !isHeading2(paragraph, heading2Style) &&
      !isFigureCaption(paragraph) &&
      !isTableCaption(paragraph) &&
      !isTemplateInstruction(paragraph) &&
      (paragraph.visibleText || paragraph.text).length > 6,
  );

  const warnings: string[] = [];
  const warnIfMissing = (value: unknown, label: string) => {
    if (!value) {
      warnings.push(`未识别到 ${label}。`);
    }
  };
  warnIfMissing(cover.titleField, '封面题目字段');
  warnIfMissing(cover.authorField, '封面作者/姓名字段');
  warnIfMissing(cover.studentIdField, '封面学号字段');
  warnIfMissing(cover.schoolField, '封面学院/系字段');
  warnIfMissing(cover.majorField, '封面专业字段');
  warnIfMissing(cover.supervisorField, '封面导师字段');
  warnIfMissing(chineseAbstractTitle, '中文摘要标题');
  warnIfMissing(chineseKeywords, '中文关键词');
  warnIfMissing(tocTitle, '目录标题');
  warnIfMissing(heading1Paragraph, '一级标题样例');
  warnIfMissing(heading2Paragraph, '二级标题样例');
  warnIfMissing(bodyParagraph, '正文样式样例');
  warnIfMissing(referencesParagraph, '参考文献标题');
  warnIfMissing(acknowledgementParagraph, '致谢标题');
  if (!facts.styles.length) {
    warnings.push('DOCX 包中未找到 word/styles.xml，已使用 document.xml 直接格式和中文文本规则推断。');
  }
  if (!facts.numberingDetected) {
    warnings.push('未检测到 numbering.xml 或段落编号信息，标题层级主要来自文本模式。');
  }
  if (!facts.headerFooterDetected) {
    warnings.push('未检测到 header/footer OOXML；当前模板不会生成可精确复刻的页眉页脚。');
  }

  const roleCandidates: Record<string, TemplateRoleBinding[]> = {
    coverTitleField: cover.titleField ? [cover.titleField] : [],
    coverAuthorField: cover.authorField ? [cover.authorField] : [],
    coverStudentIdField: cover.studentIdField ? [cover.studentIdField] : [],
    coverSchoolField: cover.schoolField ? [cover.schoolField] : [],
    coverMajorField: cover.majorField ? [cover.majorField] : [],
    coverSupervisorField: cover.supervisorField ? [cover.supervisorField] : [],
    chineseAbstractTitle: chineseAbstractTitle ? [bindParagraph(chineseAbstractTitle, 'Chinese abstract title candidate.', 0.9, ['matches 摘要/中文摘要'])] : [],
    chineseAbstractBody: chineseAbstractBody.map((paragraph) => bindParagraph(paragraph, 'Chinese abstract body candidate.', 0.82, ['between 摘要 and 关键词'])),
    chineseKeywords: chineseKeywords ? [bindParagraph(chineseKeywords, 'Chinese keywords candidate.', 0.94, ['matches 关键词/关键字 label'])] : [],
    tocTitle: tocTitle ? [bindParagraph(tocTitle, 'TOC title candidate.', 0.92, ['matches 目录/目 录'])] : [],
    tocEntries: tocEntries.slice(0, 80).map((paragraph) => bindParagraph(paragraph, 'TOC entry candidate.', 0.9, ['field code or hyperlink paragraph'])),
    heading1: heading1Candidates.slice(0, 20).map((paragraph) => bindParagraph(paragraph, 'Heading 1 candidate.', 0.85, ['Chinese heading 1 pattern plus direct formatting'])),
    heading2: heading2Candidates.slice(0, 30).map((paragraph) => bindParagraph(paragraph, 'Heading 2 candidate.', 0.85, ['Chinese heading 2 pattern plus direct formatting'])),
    body: bodyParagraph ? [bindParagraph(bodyParagraph, 'Body candidate.', 0.78, ['after heading and excluded front matter/TOC/instructions'])] : [],
    figureCaption: figureCaptionParagraph ? [bindParagraph(figureCaptionParagraph, 'Figure caption candidate.', 0.86, ['matches 图 caption pattern'])] : [],
    tableCaption: tableCaptionParagraph ? [bindParagraph(tableCaptionParagraph, 'Table caption candidate.', 0.86, ['matches 表 caption pattern'])] : [],
    references: referencesParagraph ? [bindParagraph(referencesParagraph, 'References title candidate.', 0.95, ['matches 参考文献/参考资料'])] : [],
    acknowledgement: acknowledgementParagraph ? [bindParagraph(acknowledgementParagraph, 'Acknowledgement title candidate.', 0.92, ['matches 致谢'])] : [],
    appendix: appendixParagraph ? [bindParagraph(appendixParagraph, 'Appendix title candidate.', 0.75, ['matches 附录'])] : [],
  };

  const semanticConfidence = confidenceFromFound(
    cover.titleField,
    cover.authorField,
    chineseAbstractTitle,
    chineseKeywords,
    tocTitle,
    heading1Paragraph,
    heading2Paragraph,
    bodyParagraph,
    referencesParagraph,
    acknowledgementParagraph,
  );

  const schema: TemplateSchemaDraft = {
    schemaVersion: '0.2.0',
    generatedAt: new Date().toISOString(),
    templateId,
    templateVersion,
    sourceTemplateAssetId,
    rawExtraction: {
      styleCount: facts.styles.length,
      paragraphCount: facts.paragraphs.length,
      tableCount: facts.tables.length,
      sectionCount: facts.sectionCount,
      page: facts.page,
      styles: facts.styles,
      paragraphSamples: nonEmptyParagraphs.slice(0, 120),
      tableSamples: facts.tables.slice(0, 12),
    },
    semanticMapping: {
      titleStyleId: titleStyle?.styleId ?? cover.titleField?.styleId,
      heading1StyleId: heading1Style?.styleId,
      heading2StyleId: heading2Style?.styleId,
      abstractParagraphIndex: chineseAbstractBody[0]?.index ?? englishAbstractBody[0]?.index,
      referencesParagraphIndex: referencesParagraph?.index,
      language: 'zh-CN',
      confidence: semanticConfidence,
      warnings,
      cover,
      abstracts: {
        zh: {
          title: bindParagraph(chineseAbstractTitle, 'Detected from Chinese 摘要 title text, allowing date contamination.', 0.92, ['matches 摘要/中文摘要 after normalization']),
          body: bindParagraphs(chineseAbstractBody, 'Paragraphs between Chinese abstract title and keywords.', 0.84, ['after 摘要', 'before 关键词']),
          keywords: {
            label: bindParagraph(chineseKeywords, 'Detected from 关键词/关键字 label.', 0.94, ['Chinese keyword label']),
          },
        },
        en: {
          title: bindParagraph(englishAbstractTitle, 'Detected from Abstract title.', englishAbstractTitle ? 0.65 : 0, ['English abstract is secondary for zh-CN templates']),
          body: bindParagraphs(englishAbstractBody, 'Paragraphs between Abstract and Key Words.', englishAbstractBody.length ? 0.6 : 0, ['English abstract secondary detection']),
          keywords: {
            label: bindParagraph(englishKeywords, 'Detected from Key Words label.', englishKeywords ? 0.65 : 0, ['English keywords are secondary for zh-CN templates']),
          },
        },
      },
      toc: {
        title: bindParagraph(tocTitle, 'Detected from 目录 title.', 0.92, ['matches 目录 after whitespace removal']),
        entries: tocEntries.slice(0, 80).map((paragraph) => bindParagraph(paragraph, 'TOC field/hyperlink paragraph. Excluded from body and headings.', 0.9, ['contains TOC/HYPERLINK field code'])),
      },
      headings: {
        level1: bindParagraph(heading1Paragraph, 'Detected from Chinese level 1 heading pattern and direct formatting.', 0.88, ['not TOC', 'heading1 regex', 'bold/center/large font evidence']),
        level2: bindParagraph(heading2Paragraph, 'Detected from Chinese level 2 heading pattern and direct formatting.', 0.88, ['not TOC', 'heading2 regex', 'bold/spacing/font evidence']),
        level1Candidates: roleCandidates.heading1,
        level2Candidates: roleCandidates.heading2,
      },
      body: bindParagraph(bodyParagraph, 'Detected after main heading while excluding cover, TOC, abstracts, keywords, captions, references, acknowledgements, appendix, and formatting instructions.', 0.8, ['after first heading1', 'front matter excluded', 'not a heading/caption']),
      captions: {
        figure: bindParagraph(figureCaptionParagraph, 'Detected from 图 caption pattern.', 0.86, ['Chinese figure caption pattern']),
        table: bindParagraph(tableCaptionParagraph, 'Detected from 表 caption pattern.', 0.86, ['Chinese table caption pattern']),
      },
      references: {
        title: bindParagraph(referencesParagraph, 'Detected from 参考文献/参考资料 title.', 0.95, ['Chinese references title pattern']),
        firstItem: bindParagraph(referenceItem, 'First likely reference item after references title.', referenceItem ? 0.7 : 0, ['reference item pattern']),
      },
      acknowledgement: {
        title: bindParagraph(acknowledgementParagraph, 'Detected from 致谢 title.', 0.92, ['Chinese acknowledgement title pattern']),
        body: bindParagraph(acknowledgementBody, 'First acknowledgement body paragraph after 致谢.', acknowledgementBody ? 0.72 : 0, ['after 致谢']),
      },
      appendix: {
        title: bindParagraph(appendixParagraph, 'Detected from 附录 title.', appendixParagraph ? 0.75 : 0, ['Chinese appendix title pattern']),
        body: bindParagraph(appendixBody, 'First appendix body paragraph after 附录.', appendixBody ? 0.65 : 0, ['after 附录']),
      },
    },
    document: {
      page: facts.page,
      sectionPropertiesXml: facts.sectionPropertiesXml,
      headerFooter: {
        detected: facts.headerFooterDetected,
      },
      numbering: {
        detected: facts.numberingDetected,
      },
      tables: {
        detected: facts.tables.length > 0,
        count: facts.tables.length,
        bodyTable: selectBodyTable(facts.tables),
        samples: facts.tables.slice(0, 12),
      },
    },
    roles: {
      title: cover.titleField ?? bindParagraph(undefined, 'No Chinese cover title field detected.'),
      authors: cover.authorField ?? bindParagraph(undefined, 'No Chinese cover author/name field detected.'),
      abstract: bindParagraph(chineseAbstractBody[0] ?? englishAbstractBody[0], 'Detected as body after Chinese abstract title and before keywords.', 0.84, ['abstract body range']),
      keywords: bindParagraph(chineseKeywords ?? englishKeywords, 'Detected from Keywords/关键词 marker.', 0.9, ['keyword label']),
      body: bindParagraph(bodyParagraph, 'Detected after main heading while excluding front matter, TOC, instructions, references, and acknowledgements.', 0.8, ['body exclusion rules']),
      heading1: bindParagraph(heading1Paragraph, 'Detected from Heading 1 style, outline level, or Chinese thesis heading pattern.', 0.88, ['heading1 candidate score']),
      heading2: bindParagraph(heading2Paragraph, 'Detected from Heading 2 style, outline level, or numbered secondary heading pattern.', 0.88, ['heading2 candidate score']),
      figureCaption: bindParagraph(figureCaptionParagraph, 'Detected from Chinese/English figure caption text.', 0.86, ['caption pattern']),
      tableCaption: bindParagraph(tableCaptionParagraph, 'Detected from Chinese/English table caption text.', 0.86, ['caption pattern']),
      references: bindParagraph(referencesParagraph, 'Detected from References/参考文献 heading text.', 0.95, ['references title pattern']),
    },
    editableFields: [
      'semanticMapping.cover',
      'semanticMapping.abstracts.zh',
      'semanticMapping.toc',
      'semanticMapping.headings',
      'semanticMapping.body',
      'semanticMapping.captions',
      'semanticMapping.references',
      'semanticMapping.acknowledgement',
      'semanticMapping.appendix',
      'roles.title',
      'roles.authors',
      'roles.abstract',
      'roles.keywords',
      'roles.body',
      'roles.heading1',
      'roles.heading2',
      'roles.figureCaption',
      'roles.tableCaption',
      'roles.references',
      'document.page',
    ],
  };

  return { schema, roleCandidates };
}

export async function importTemplateFromFile(paths: AppPaths, filePath: string, logger?: TemplateImportLogger): Promise<ImportedTemplateSummary> {
  const importLogger = logger ?? (await createTemplateImportLogger(paths));
  const templateId = randomUUID();
  const templateVersion = 1;
  const now = new Date().toISOString();
  const name = basename(filePath, extname(filePath));
  const safeName = sanitizeFileStem(name);
  const versionDir = join(paths.templatesDir, `${safeName}-${templateId}`, `v${templateVersion}`);
  const cleanupPaths: string[] = [];

  await importLogger.mark('import started', 'started', { filePath, fileSizeBytes: await fileSize(filePath) });

  try {
    await mkdir(versionDir, { recursive: true });

    const extension = extname(filePath).toLowerCase();
    const sourceFilename = extension === '.doc' ? 'source-template.doc' : 'source-template.docx';
    const sourcePath = join(versionDir, sourceFilename);
    await copyFile(filePath, sourcePath);
    await importLogger.mark('source copied', 'finished', { filePath: sourcePath, fileSizeBytes: await fileSize(sourcePath) });

    const analysis = await ensureAnalysisDocx(sourcePath, versionDir, importLogger);
    cleanupPaths.push(...analysis.cleanupPaths);
    const facts = await extractDocumentFacts(analysis.analysisDocxPath, importLogger);

    const renderReferencePath = join(versionDir, 'render-reference.docx');
    const renderReferenceManifestPath = join(versionDir, 'render-reference-manifest.json');
    const sourceAssetId = randomUUID();
    const { schema, roleCandidates } = inferSchema(templateId, templateVersion, sourceAssetId, facts);
    await importLogger.mark('schema inferred', 'finished', {
      paragraphCount: facts.paragraphs.length,
      styleCount: facts.styles.length,
      message: `confidence=${schema.semanticMapping.confidence ?? 0}`,
    });

    const schemaPath = join(versionDir, 'schema.json');
    const schemaJson = JSON.stringify(schema, null, 2);
    await writeFile(schemaPath, schemaJson, 'utf8');
    await writeFile(join(versionDir, 'extraction-debug.json'), JSON.stringify({ packageFiles: facts.packageFiles, paragraphs: facts.paragraphs, tables: facts.tables }, null, 2), 'utf8');
    await writeFile(join(versionDir, 'role-candidates.json'), JSON.stringify(roleCandidates, null, 2), 'utf8');
    await importLogger.mark('schema written', 'finished', {
      filePath: schemaPath,
      fileSizeBytes: await fileSize(schemaPath),
      paragraphCount: facts.paragraphs.length,
      styleCount: facts.styles.length,
    });

    await buildRenderReferenceDocx({
      schema,
      sourceDocxPath: analysis.analysisDocxPath,
      outputPath: renderReferencePath,
      manifestPath: renderReferenceManifestPath,
    });
    const sourceContent = await readFile(sourcePath);
    const renderReferenceContent = await readFile(renderReferencePath);
    const renderReferenceManifestContent = await readFile(renderReferenceManifestPath);

    const template: Template = {
      id: templateId,
      name,
      version: templateVersion,
      activeSchemaVersionId: undefined,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    };

    const schemaVersion: SchemaVersion = {
      id: randomUUID(),
      templateId,
      version: templateVersion,
      path: schemaPath,
      sha256: sha256(schemaJson),
      createdAt: now,
    };

    template.activeSchemaVersionId = schemaVersion.id;

    const assets: TemplateAsset[] = [
      {
        id: sourceAssetId,
        templateId,
        kind: extension === '.doc' ? 'source-template-doc' : 'source-template-docx',
        path: sourcePath,
        sha256: sha256(sourceContent),
        version: templateVersion,
        createdAt: now,
      },
      {
        id: randomUUID(),
        templateId,
        kind: 'render-reference-docx',
        path: renderReferencePath,
        sha256: sha256(renderReferenceContent),
        version: templateVersion,
        createdAt: now,
      },
      {
        id: randomUUID(),
        templateId,
        kind: 'render-reference-manifest-json',
        path: renderReferenceManifestPath,
        sha256: sha256(renderReferenceManifestContent),
        version: templateVersion,
        createdAt: now,
      },
      {
        id: randomUUID(),
        templateId,
        kind: 'schema-json',
        path: schemaPath,
        sha256: schemaVersion.sha256,
        version: templateVersion,
        createdAt: now,
      },
    ];

    await Promise.all(cleanupPaths.map(async (path) => unlink(path).catch(() => undefined)));
    await importLogger.mark('assets prepared', 'finished', {
      filePath: versionDir,
      paragraphCount: facts.paragraphs.length,
      styleCount: facts.styles.length,
    });

    return {
      template,
      assets,
      schemaVersion,
      schema,
    };
  } catch (error) {
    await Promise.all(cleanupPaths.map(async (path) => unlink(path).catch(() => undefined)));
    await writeFile(
      join(versionDir, 'import-failed.json'),
      JSON.stringify(
        {
          failedAt: new Date().toISOString(),
          source: filePath,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
      'utf8',
    ).catch(() => undefined);
    throw error;
  }
}
