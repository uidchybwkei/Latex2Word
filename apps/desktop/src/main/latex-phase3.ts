import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import * as coreModule from '../../../../packages/core/src/index.js';
import type { JobRunner } from '../../../../packages/core/src/index.js';
import type {
  ImportedTemplateSummary,
  LatexConversionResult,
  LatexTemplateGenerationResult,
  TemplateAsset,
  TemplateSchemaDraft,
  UserSettings,
} from '../../../../packages/shared/src/index.js';

const execFileAsync = promisify(execFile);
const PANDOC_TIMEOUT_MS = 60000;
const SAMPLE_FIGURE_FILENAME = 'latex2docx-sample-figure.png';
const SAMPLE_FIGURE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAoCAIAAADBrGu+AAAA+ElEQVR42tWZSQ6DMAxF32V6sh6/C3bdFqRKVdUUMtmOvxSEIPaXH5kcwu3++Cnb8yVUKAG0ME4BVDA4LmkG3rdrhswYfD8oYlC+0sLgrEIFg+vq/AxULZI3BY12aTHosk6IwYBPKgyGPZNgMOm/nIF5ibVNgZXQEoxDFnPFGIyPIE4fxgmjlMKvdxoyXOjgOsImm6LFnYCZrhejy56wJbMaVktxnEZdMSLWAQ+M0IVsSfQCY2A9QEuIGcfAQExjGMT3E1tyksQ9nIYglLf9VUYlbbZJ5lZtvmYBkuzfuwFy/syqA5hPKa4YaMVdMrApH89UDvkkTil3sUuVmXR14DkAAAAASUVORK5CYII=';

function sha256(content: Uint8Array | Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function templateVersionDir(summary: ImportedTemplateSummary): string {
  return dirname(summary.schemaVersion.path);
}

function findAsset(summary: ImportedTemplateSummary, kind: TemplateAsset['kind']): TemplateAsset | undefined {
  return summary.assets.find((asset) => asset.kind === kind && asset.version === summary.template.version);
}

function buildLatexDocument(schema: TemplateSchemaDraft): string {
  return [
    '\\documentclass[12pt]{article}',
    '\\usepackage{graphicx}',
    '\\usepackage{booktabs}',
    '% LaTeX2Docx controlled input subset.',
    '% Fill content only inside the commands/environments shown here.',
    '% Do not copy Word template labels such as “题目：” or format notes such as “空一字距离”.',
    '\\title{论文题目}',
    '\\author{作者姓名}',
    '\\date{}',
    '\\begin{document}',
    '\\maketitle',
    '\\begin{abstract}',
    '这里填写中文摘要正文。摘要环境会映射到 schema 中的中文摘要样式。',
    '\\end{abstract}',
    '\\textbf{关键词：}关键词一；关键词二；关键词三',
    '',
    '\\section*{Abstract}',
    'Fill in the English abstract here. This paragraph maps to the English abstract style from schema.',
    '',
    '\\textbf{Key Words:} keyword one; keyword two; keyword three',
    '',
    '\\section{引言}',
    '这里填写正文内容。普通段落会映射到 schema 中的正文样式。',
    '',
    '\\subsection{研究背景}',
    '这里填写二级标题下的正文内容。',
    '',
    '\\subsection{公式示例}',
    '这里填写公式前后的说明文字。',
    '\\[',
    'E = mc^2',
    '\\]',
    '',
    '\\begin{figure}[htbp]',
    '\\centering',
    `\\includegraphics[width=0.55\\linewidth]{${SAMPLE_FIGURE_FILENAME}}`,
    '\\caption{图1-1 示例图题}',
    '\\end{figure}',
    '',
    '\\begin{table}[htbp]',
    '\\centering',
    '\\caption{表1-1 示例表题}',
    '\\begin{tabular}{ll}',
    '\\toprule',
    '列1 & 列2 \\\\',
    '\\midrule',
    '示例 & 内容 \\\\',
    '\\bottomrule',
    '\\end{tabular}',
    '\\end{table}',
    '',
    '\\section*{参考文献}',
    '\\begin{thebibliography}{9}',
    '\\bibitem{ref1} 作者. 文献题名[M]. 出版地：出版社，年份.',
    '\\end{thebibliography}',
    '\\end{document}',
    '',
  ].join('\n');
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function encodeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function paragraphText(paragraphXml: string): string {
  return [...paragraphXml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXmlText(match[1]))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function paragraphStyle(paragraphXml: string): string | undefined {
  return paragraphXml.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/)?.[1];
}

function setParagraphStyle(paragraphXml: string, styleId: string): string {
  if (/<w:pStyle\b/.test(paragraphXml)) {
    return paragraphXml.replace(/<w:pStyle\b[^>]*\/>/, `<w:pStyle w:val="${styleId}"/>`);
  }
  if (/<w:pPr\b[^>]*>/.test(paragraphXml)) {
    return paragraphXml.replace(/<w:pPr\b[^>]*>/, (match) => `${match}<w:pStyle w:val="${styleId}"/>`);
  }
  return paragraphXml.replace(/<w:p\b([^>]*)>/, `<w:p$1><w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>`);
}

function setTableCellParagraphProperties(paragraphXml: string, schema: TemplateSchemaDraft): string {
  const spacing = schema.semanticMapping.body?.formatting?.spacing ?? schema.roles.body?.formatting?.spacing;
  const spacingXml = `<w:spacing w:after="${spacing?.after ?? 0}" w:line="${spacing?.line ?? 360}" w:lineRule="${spacing?.lineRule ?? 'auto'}"/>`;
  const nextPPr = `<w:pPr><w:pStyle w:val="Compact"/>${spacingXml}<w:ind w:firstLine="0" w:firstLineChars="0"/><w:jc w:val="center"/></w:pPr>`;
  if (/<w:pPr\b[\s\S]*?<\/w:pPr>/.test(paragraphXml)) {
    return paragraphXml.replace(/<w:pPr\b[\s\S]*?<\/w:pPr>/, nextPPr);
  }
  return paragraphXml.replace(/<w:p\b([^>]*)>/, `<w:p$1>${nextPPr}`);
}

function defaultThesisTablePrXml(): string {
  return [
    '<w:tblPr>',
    '<w:tblStyle w:val="Table"/>',
    '<w:tblW w:w="0" w:type="auto"/>',
    '<w:jc w:val="center"/>',
    '<w:tblBorders>',
    '<w:top w:val="single" w:color="auto" w:sz="4" w:space="0"/>',
    '<w:left w:val="none" w:color="auto" w:sz="0" w:space="0"/>',
    '<w:bottom w:val="single" w:color="auto" w:sz="4" w:space="0"/>',
    '<w:right w:val="none" w:color="auto" w:sz="0" w:space="0"/>',
    '<w:insideH w:val="single" w:color="auto" w:sz="4" w:space="0"/>',
    '<w:insideV w:val="single" w:color="auto" w:sz="4" w:space="0"/>',
    '</w:tblBorders>',
    '<w:tblLayout w:type="fixed"/>',
    '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar>',
    '</w:tblPr>',
  ].join('');
}

function tablePropertiesFromSchema(schema: TemplateSchemaDraft): string {
  return schema.document.tables?.bodyTable?.tblPrXml ?? defaultThesisTablePrXml();
}

function mergeTableProperties(currentTablePrXml: string | undefined, schemaTablePrXml: string): string {
  const captionXml = currentTablePrXml?.match(/<w:tblCaption\b[^>]*\/>/)?.[0];
  if (captionXml && !schemaTablePrXml.includes('<w:tblCaption')) {
    return schemaTablePrXml.replace('</w:tblPr>', `${captionXml}</w:tblPr>`);
  }
  return schemaTablePrXml;
}

function applySchemaTableFormatting(tableXml: string, schema: TemplateSchemaDraft): string {
  const currentTablePrXml = tableXml.match(/<w:tblPr\b[\s\S]*?<\/w:tblPr>/)?.[0];
  const nextTablePrXml = mergeTableProperties(currentTablePrXml, tablePropertiesFromSchema(schema));
  const withTablePr = currentTablePrXml
    ? tableXml.replace(currentTablePrXml, nextTablePrXml)
    : tableXml.replace(/<w:tbl\b([^>]*)>/, `<w:tbl$1>${nextTablePrXml}`);
  return withTablePr.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraphXml) => setTableCellParagraphProperties(paragraphXml, schema));
}

function replaceParagraphText(paragraphXml: string, nextText: string): string {
  let replaced = false;
  return paragraphXml
    .replace(/<w:t\b([^>]*)>[\s\S]*?<\/w:t>/g, (match, attrs: string) => {
      if (replaced) {
        return '';
      }
      replaced = true;
      return `<w:t${attrs}>${encodeXmlText(nextText)}</w:t>`;
    })
    .replace(/<w:r\b[^>]*>\s*<\/w:r>/g, '');
}

function referencedGraphics(content: string): string[] {
  return [...content.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

async function copyLatexReferencedAssets(latexInputPath: string, latexInputCopyPath: string): Promise<void> {
  const content = await readFile(latexInputPath, 'utf8');
  const sourceDir = dirname(latexInputPath);
  const destinationDir = dirname(latexInputCopyPath);
  const destinationRoot = resolve(destinationDir);

  for (const reference of referencedGraphics(content)) {
    const sourcePath = isAbsolute(reference) ? reference : resolve(sourceDir, reference);
    const destinationPath = isAbsolute(reference) ? join(destinationDir, basename(reference)) : resolve(destinationDir, reference);
    if (destinationPath !== destinationRoot && !destinationPath.startsWith(`${destinationRoot}${sep}`)) {
      continue;
    }
    await mkdir(dirname(destinationPath), { recursive: true });
    try {
      await copyFile(sourcePath, destinationPath);
    } catch (error) {
      const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
      if (missing && basename(reference) === SAMPLE_FIGURE_FILENAME) {
        await writeFile(destinationPath, Buffer.from(SAMPLE_FIGURE_PNG_BASE64, 'base64'));
        continue;
      }
      if (missing) {
        throw new Error(`LaTeX image asset is missing: ${reference}. Expected at ${sourcePath}.`);
      }
      throw error;
    }
  }
}

function moveTableOfContentsAfterAbstracts(documentXml: string): string {
  const tocMatch = documentXml.match(/<w:sdt\b[\s\S]*?<w:docPartGallery\b[^>]*w:val="Table of Contents"[\s\S]*?<\/w:sdt>/);
  if (!tocMatch) {
    return documentXml;
  }

  const tocXml = tocMatch[0];
  const withoutToc = documentXml.replace(tocXml, '');
  const englishKeywordsMatch = withoutToc.match(
    /<w:p\b(?:(?!<\/w:p>)[\s\S])*?<w:pStyle\b[^>]*w:val="EnglishKeywords"(?:(?!<\/w:p>)[\s\S])*?<\/w:p>\s*(?:<w:bookmarkEnd\b[^>]*\/>\s*)?/,
  );
  if (englishKeywordsMatch?.[0]) {
    return withoutToc.replace(englishKeywordsMatch[0], `${englishKeywordsMatch[0]}${tocXml}`);
  }

  const keywordsMatch = withoutToc.match(/<w:p\b(?:(?!<\/w:p>)[\s\S])*?<w:pStyle\b[^>]*w:val="Keywords"(?:(?!<\/w:p>)[\s\S])*?<\/w:p>/);
  if (keywordsMatch?.[0]) {
    return withoutToc.replace(keywordsMatch[0], `${keywordsMatch[0]}${tocXml}`);
  }

  return documentXml;
}

async function postProcessPandocDocx(outputPath: string, schema: TemplateSchemaDraft): Promise<void> {
  const buffer = await readFile(outputPath);
  const zip = await JSZip.loadAsync(buffer);
  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (!documentXml) {
    throw new Error('Pandoc output is missing word/document.xml.');
  }

  let afterReferencesTitle = false;
  let seenChineseAbstractTitle = false;
  let inEnglishAbstract = false;
  const documentWithTables = documentXml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/g, (tableXml) => applySchemaTableFormatting(tableXml, schema));
  const nextDocumentXml = moveTableOfContentsAfterAbstracts(documentWithTables.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraphXml) => {
    if (/<m:oMath\b|<m:oMathPara\b/.test(paragraphXml)) {
      return setParagraphStyle(paragraphXml, 'Equation');
    }

    const text = paragraphText(paragraphXml);
    if (!text) {
      return paragraphXml;
    }

    const normalized = text.replace(/\s+/g, '');
    const style = paragraphStyle(paragraphXml);
    let next = paragraphXml;

    if (/^Abstract$/i.test(text)) {
      if (!seenChineseAbstractTitle) {
        seenChineseAbstractTitle = true;
        return setParagraphStyle(replaceParagraphText(next, '摘要'), 'AbstractTitle');
      }
      inEnglishAbstract = true;
      afterReferencesTitle = false;
      return setParagraphStyle(next, 'EnglishAbstractTitle');
    }

    if (inEnglishAbstract && /^Key\s*Words?\s*[:：]/i.test(text)) {
      inEnglishAbstract = false;
      return setParagraphStyle(next, 'EnglishKeywords');
    }

    if (inEnglishAbstract) {
      return setParagraphStyle(next, 'EnglishAbstract');
    }

    if (/^关键词[:：]/.test(normalized)) {
      return setParagraphStyle(next, 'Keywords');
    }

    if (/^图[\d一二三四五六七八九十Xx]+(?:[-－—.．][\d一二三四五六七八九十Xx]+)?/.test(normalized)) {
      return setParagraphStyle(next, 'ImageCaption');
    }

    if (/^表[\d一二三四五六七八九十Xx]+(?:[-－—.．][\d一二三四五六七八九十Xx]+)?/.test(normalized)) {
      return setParagraphStyle(next, 'TableCaption');
    }

    if (/^(Contents|Table of Contents)$/i.test(text)) {
      return setParagraphStyle(replaceParagraphText(next, '目 录'), 'TOCHeading');
    }

    if (style === 'Heading1' && /^\d+[\u4e00-\u9fa5A-Za-z]/.test(normalized)) {
      return replaceParagraphText(next, text.replace(/^(\d+)(\S)/, '$1.$2'));
    }

    if (normalized === '参考文献') {
      afterReferencesTitle = true;
      return setParagraphStyle(next, 'ReferencesTitle');
    }

    if (/^Heading[12]$/.test(style ?? '')) {
      afterReferencesTitle = false;
      return next;
    }

    if (afterReferencesTitle) {
      next = setParagraphStyle(replaceParagraphText(next, text.replace(/^\d+\s*/, '')), 'Bibliography');
    }

    return next;
  }));

  zip.file('word/document.xml', nextDocumentXml);
  const nextBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  await writeFile(outputPath, nextBuffer);
}

export async function generateDeterministicLatexTemplate(summary: ImportedTemplateSummary): Promise<LatexTemplateGenerationResult> {
  const versionDir = templateVersionDir(summary);
  const outputPath = join(versionDir, 'fixed-template.tex');
  const content = buildLatexDocument(summary.schema);
  await writeFile(outputPath, content, 'utf8');
  await writeFile(join(versionDir, SAMPLE_FIGURE_FILENAME), Buffer.from(SAMPLE_FIGURE_PNG_BASE64, 'base64'));

  const existingAsset = findAsset(summary, 'latex-fixed-template');
  const asset: TemplateAsset = {
    id: existingAsset?.id ?? randomUUID(),
    templateId: summary.template.id,
    kind: 'latex-fixed-template',
    path: outputPath,
    sha256: sha256(content),
    version: summary.template.version,
    createdAt: existingAsset?.createdAt ?? new Date().toISOString(),
  };

  return {
    templateId: summary.template.id,
    templateVersion: summary.template.version,
    outputPath,
    asset,
  };
}

function resolvePandocCommand(settings: UserSettings): string {
  return settings.pandocPath || 'pandoc';
}

async function ensurePandoc(settings: UserSettings): Promise<string> {
  const tool = await coreModule.detectTool('pandoc', settings);
  if (!tool.detected) {
    throw new Error(tool.error || 'Pandoc was not detected.');
  }
  return tool.version || 'unknown';
}

export async function convertLatexToDocx(options: {
  summary: ImportedTemplateSummary;
  latexInputPath: string;
  settings: UserSettings;
  jobRunner: JobRunner;
}): Promise<LatexConversionResult> {
  const { summary, latexInputPath, settings, jobRunner } = options;
  const queueResult = await jobRunner.enqueue({
    stage: 'convert',
    templateId: summary.template.id,
    schemaVersionId: summary.schemaVersion.id,
    templateVersion: summary.template.version,
    inputPath: latexInputPath,
  });
  const jobId = queueResult.job.id;
  const workingDirectory = queueResult.job.workingDirectory;
  const inputFilename = basename(latexInputPath);
  const latexInputCopyPath = join(workingDirectory, inputFilename);
  const outputPath = join(workingDirectory, `${basename(inputFilename, extname(inputFilename)) || 'output'}.docx`);
  const logPath = join(workingDirectory, 'pandoc.log');
  const referenceAsset = findAsset(summary, 'render-reference-docx');

  if (!referenceAsset) {
    throw new Error('render-reference.docx is missing for this template.');
  }

  await mkdir(workingDirectory, { recursive: true });
  await copyFile(latexInputPath, latexInputCopyPath);
  await copyLatexReferencedAssets(latexInputPath, latexInputCopyPath);
  jobRunner.markRunning(jobId);

  try {
    const pandocVersion = await ensurePandoc(settings);
    jobRunner.setToolVersion(jobId, 'pandoc', pandocVersion);

    const command = resolvePandocCommand(settings);
    const args = [
      latexInputCopyPath,
      '--from=latex',
      '--to=docx',
      '--number-sections',
      '--toc',
      '--toc-depth=3',
      `--reference-doc=${referenceAsset.path}`,
      `--output=${outputPath}`,
    ];

    const result = await execFileAsync(command, args, {
      cwd: workingDirectory,
      timeout: PANDOC_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    });

    const logBody = [
      `command: ${command}`,
      `args: ${JSON.stringify(args)}`,
      `referenceDocx: ${referenceAsset.path}`,
      `stdout:\n${result.stdout ?? ''}`,
      `stderr:\n${result.stderr ?? ''}`,
    ].join('\n\n');
    await writeFile(logPath, logBody, 'utf8');

    const outputStats = await stat(outputPath);
    if (outputStats.size <= 0) {
      throw new Error('Pandoc finished but output .docx is empty.');
    }
    await postProcessPandocDocx(outputPath, summary.schema);

    const job = jobRunner.markSucceeded(jobId);
    return {
      job,
      templateId: summary.template.id,
      templateVersion: summary.template.version,
      latexInputPath,
      latexInputCopyPath,
      referenceDocxPath: referenceAsset.path,
      outputPath,
      logPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeFile(logPath, message, 'utf8');
    const job = jobRunner.markFailed(jobId, message);
    throw new Error(`Failed to convert LaTeX with pandoc for job ${job.id}: ${message}`);
  }
}
