import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { createTemplateImportLogger, importTemplateFromFile } from '../dist-electron/apps/desktop/src/main/template-import.js';
import { convertLatexToDocx, generateDeterministicLatexTemplate } from '../dist-electron/apps/desktop/src/main/latex-phase3.js';
import { JobRunner } from '../dist-electron/packages/core/src/index.js';

const execFileAsync = promisify(execFile);
const rootDir = resolve('../..');
const examplesDir = join(rootDir, 'examples');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const verificationDir = join(rootDir, '.latex2docx-data/dev/verification', runId);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fileSize(path) {
  return (await stat(path)).size;
}

function settings() {
  const now = new Date().toISOString();
  return {
    ai: {
      enabled: false,
      timeoutMs: 30000,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function verificationPaths() {
  return {
    userDataDir: verificationDir,
    templatesDir: join(verificationDir, 'templates'),
    jobsDir: join(verificationDir, 'jobs'),
    cacheDir: join(verificationDir, 'cache'),
    logsDir: join(verificationDir, 'logs'),
    databasePath: join(verificationDir, 'metadata.sqlite'),
  };
}

async function convertToPdf(inputPath, outputDir) {
  await mkdir(outputDir, { recursive: true });
  await execFileAsync(
    'soffice',
    [
      `-env:UserInstallation=file://${join(outputDir, 'lo-profile')}`,
      '--headless',
      '--convert-to',
      'pdf',
      '--outdir',
      outputDir,
      inputPath,
    ],
    {
      timeout: 60000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    },
  );

  const pdfPath = join(outputDir, `${basename(inputPath, extname(inputPath))}.pdf`);
  await fileSize(pdfPath);
  return pdfPath;
}

async function renderPdfToPng(pdfPath, outputDir) {
  const prefix = join(outputDir, basename(pdfPath, '.pdf'));
  await execFileAsync('pdftoppm', [pdfPath, prefix], {
    timeout: 60000,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
  });
  const files = (await readdir(outputDir)).filter((file) => file.startsWith(basename(pdfPath, '.pdf')) && /\.(ppm|pgm|pbm)$/i.test(file));
  return files.map((file) => join(outputDir, file)).sort();
}

async function renderDocument(inputPath, outputDir) {
  try {
    const pdfPath = await convertToPdf(inputPath, outputDir);
    const pages = await renderPdfToPng(pdfPath, outputDir);
    return {
      ok: true,
      pdfPath,
      pageImages: pages,
      pageCount: pages.length,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      pageImages: [],
      pageCount: 0,
    };
  }
}

async function analyzeDocx(docxPath) {
  const zip = await JSZip.loadAsync(await readFile(docxPath));
  const documentXml = await zip.file('word/document.xml')?.async('string');
  const stylesXml = await zip.file('word/styles.xml')?.async('string');
  if (!documentXml) {
    throw new Error(`Missing word/document.xml: ${docxPath}`);
  }
  const packageFiles = Object.keys(zip.files).sort();
  const styleIds = stylesXml ? [...stylesXml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"/g)].map((match) => match[1]) : [];
  return {
    packageFileCount: packageFiles.length,
    hasStylesXml: Boolean(stylesXml),
    hasNumberingXml: packageFiles.includes('word/numbering.xml'),
    hasHeaderFooter: packageFiles.some((file) => /^word\/(?:header|footer)\d*\.xml$/.test(file)),
    mediaFiles: packageFiles.filter((file) => file.startsWith('word/media/')),
    hasMath: /<m:oMath\b|<m:oMathPara\b/.test(documentXml),
    hasImage: /<w:drawing\b|<v:imagedata\b/.test(documentXml) || packageFiles.some((file) => file.startsWith('word/media/')),
    hasTable: /<w:tbl\b/.test(documentXml),
    hasToc: /Table of Contents|TOC \\o/.test(documentXml),
    hasEquationStyle: /w:val="Equation"/.test(documentXml) && styleIds.includes('Equation'),
    requiredStylesPresent: [
      'Title',
      'Author',
      'AbstractTitle',
      'Abstract',
      'Keywords',
      'EnglishAbstractTitle',
      'EnglishAbstract',
      'EnglishKeywords',
      'TOCHeading',
      'Heading1',
      'Heading2',
      'FirstParagraph',
      'Equation',
      'CaptionedFigure',
      'ImageCaption',
      'TableCaption',
      'Bibliography',
    ].filter((styleId) => styleIds.includes(styleId)),
  };
}

function summarizeSchema(schema) {
  return {
    confidence: schema.semanticMapping?.confidence,
    warnings: schema.semanticMapping?.warnings ?? [],
    paragraphCount: schema.rawExtraction?.paragraphCount,
    styleCount: schema.rawExtraction?.styleCount,
    sectionCount: schema.rawExtraction?.sectionCount,
    headerFooterDetected: schema.document?.headerFooter?.detected,
    numberingDetected: schema.document?.numbering?.detected,
    roles: {
      titleField: schema.semanticMapping?.cover?.titleField?.sampleText,
      authorField: schema.semanticMapping?.cover?.authorField?.sampleText,
      chineseAbstract: schema.semanticMapping?.abstracts?.zh?.title?.sampleText,
      englishAbstract: schema.semanticMapping?.abstracts?.en?.title?.sampleText,
      toc: schema.semanticMapping?.toc?.title?.sampleText,
      heading1: schema.semanticMapping?.headings?.level1?.sampleText,
      heading2: schema.semanticMapping?.headings?.level2?.sampleText,
      body: schema.semanticMapping?.body?.sampleText,
      figureCaption: schema.semanticMapping?.captions?.figure?.sampleText,
      tableCaption: schema.semanticMapping?.captions?.table?.sampleText,
      references: schema.semanticMapping?.references?.title?.sampleText,
      acknowledgement: schema.semanticMapping?.acknowledgement?.title?.sampleText,
    },
  };
}

async function verifyExample(filePath) {
  const paths = verificationPaths();
  await Promise.all([mkdir(paths.templatesDir, { recursive: true }), mkdir(paths.jobsDir, { recursive: true }), mkdir(paths.cacheDir, { recursive: true }), mkdir(paths.logsDir, { recursive: true })]);
  const logger = await createTemplateImportLogger(paths);
  const summary = await importTemplateFromFile(paths, filePath, logger);
  const latexResult = await generateDeterministicLatexTemplate(summary);
  summary.assets.push(latexResult.asset);
  const conversion = await convertLatexToDocx({
    summary,
    latexInputPath: latexResult.outputPath,
    settings: settings(),
    jobRunner: new JobRunner(paths),
  });
  const sourceRender = await renderDocument(filePath, join(verificationDir, 'renders', sha256(filePath).slice(0, 12), 'source'));
  const outputRender = await renderDocument(conversion.outputPath, join(verificationDir, 'renders', sha256(filePath).slice(0, 12), 'output'));
  const outputAnalysis = await analyzeDocx(conversion.outputPath);

  return {
    example: filePath,
    templateId: summary.template.id,
    schemaPath: summary.schemaVersion.path,
    renderReferencePath: summary.assets.find((asset) => asset.kind === 'render-reference-docx')?.path,
    fixedLatexPath: latexResult.outputPath,
    outputDocxPath: conversion.outputPath,
    pandocLogPath: conversion.logPath,
    schema: summarizeSchema(summary.schema),
    outputAnalysis,
    render: {
      source: sourceRender,
      output: outputRender,
    },
  };
}

async function main() {
  await mkdir(verificationDir, { recursive: true });
  const examples = (await readdir(examplesDir))
    .filter((file) => /\.(docx?|DOCX?)$/.test(file))
    .map((file) => join(examplesDir, file))
    .sort();

  const results = [];
  for (const example of examples) {
    console.log(`Verifying ${example}`);
    try {
      results.push(await verifyExample(example));
    } catch (error) {
      results.push({
        example,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const reportPath = join(verificationDir, 'verification-report.json');
  await writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), verificationDir, results }, null, 2), 'utf8');

  const markdown = [
    '# Example Verification Report',
    '',
    `Generated at: ${new Date().toISOString()}`,
    `Verification dir: ${verificationDir}`,
    '',
    ...results.flatMap((result) => [
      `## ${basename(result.example)}`,
      '',
      result.error
        ? `ERROR: ${result.error}`
        : [
            `Schema: ${result.schemaPath}`,
            `Output: ${result.outputDocxPath}`,
            `Source render pages: ${result.render.source.pageCount} (${result.render.source.ok ? 'ok' : result.render.source.error})`,
            `Output render pages: ${result.render.output.pageCount} (${result.render.output.ok ? 'ok' : result.render.output.error})`,
            `Math/Image/Table/TOC: ${result.outputAnalysis.hasMath}/${result.outputAnalysis.hasImage}/${result.outputAnalysis.hasTable}/${result.outputAnalysis.hasToc}`,
            `HeaderFooter source detected: ${result.schema.headerFooterDetected}`,
            `Warnings: ${(result.schema.warnings ?? []).join(' | ') || 'none'}`,
          ].join('\n'),
      '',
    ]),
  ].join('\n');
  await writeFile(join(verificationDir, 'verification-report.md'), markdown, 'utf8');
  console.log(`Report written: ${reportPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
