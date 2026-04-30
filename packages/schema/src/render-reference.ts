import type { ExtractedPageSettings, ExtractedParagraphInfo, TemplateRoleBinding, TemplateSchemaDraft } from '@latex2docx/shared';

export interface RenderReferenceStyleBinding {
  role: string;
  styleId: string;
  styleName: string;
  sourceParagraphIndex?: number;
  sourceText?: string;
  evidence: string[];
}

export interface RenderReferenceManifest {
  generatedAt: string;
  schemaVersion: string;
  templateId: string;
  templateVersion: number;
  sourceDocxPath: string;
  outputPath: string;
  strategy: 'schema-driven-reference-docx';
  note: string;
  styleBindings: RenderReferenceStyleBinding[];
}

export interface RenderReferenceXmlParts {
  documentXml: string;
  stylesXml: string;
  manifest: RenderReferenceManifest;
}

interface ReferenceStyleSpec {
  role: string;
  styleId: string;
  styleName: string;
  binding?: TemplateRoleBinding;
  basedOn?: string;
  fallbackSize?: number;
  fixedSize?: number;
  fallbackBold?: boolean;
  fallbackAlignment?: string;
  fallbackIndentation?: ExtractedParagraphInfo['indentation'];
  fallbackSpacing?: ExtractedParagraphInfo['spacing'];
  asciiFont?: string;
  eastAsiaFont?: string;
  sampleText: string;
}

const WORD_NS =
  'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:o="urn:schemas-microsoft-com:office:office" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml" ' +
  'xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:w10="urn:schemas-microsoft-com:office:word" ' +
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ' +
  'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" ' +
  'xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" ' +
  'xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" ' +
  'xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" ' +
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" ' +
  'mc:Ignorable="w14 w15 wp14"';

export function ensureStylesContentType(contentTypesXml: string): string {
  if (contentTypesXml.includes('PartName="/word/styles.xml"')) {
    return contentTypesXml;
  }
  return contentTypesXml.replace(
    '</Types>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
  );
}

export function buildRenderReferenceXmlParts(input: {
  schema: TemplateSchemaDraft;
  sourceDocxPath: string;
  outputPath: string;
  existingStylesXml?: string;
}): RenderReferenceXmlParts {
  const specs = specsFromSchema(input.schema);
  return {
    documentXml: documentXml(specs, input.schema.document.page, input.schema.document.sectionPropertiesXml),
    stylesXml: stylesXml(specs, input.existingStylesXml),
    manifest: manifestFromSpecs(input, specs),
  };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeStyleId(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '') || 'Latex2DocxStyle';
}

function sizeFromSpec(spec: ReferenceStyleSpec): number {
  return (
    spec.fixedSize ??
    spec.binding?.formatting?.runSummary?.dominantFontSize ??
    spec.binding?.formatting?.runSummary?.maxFontSize ??
    spec.fallbackSize ??
    24
  );
}

function asciiFontFromSpec(spec: ReferenceStyleSpec): string {
  return spec.asciiFont ?? spec.binding?.formatting?.runSummary?.dominantFont ?? 'Times New Roman';
}

function eastAsiaFontFromSpec(spec: ReferenceStyleSpec): string {
  return spec.eastAsiaFont ?? spec.binding?.formatting?.runSummary?.eastAsiaFonts?.[0] ?? '宋体';
}

function alignmentFromBinding(binding: TemplateRoleBinding | undefined, fallbackAlignment = 'both'): string {
  return binding?.formatting?.alignment ?? fallbackAlignment;
}

function boldFromBinding(binding: TemplateRoleBinding | undefined, fallback: boolean): boolean {
  return binding?.formatting?.runSummary?.mostlyBold ?? binding?.formatting?.runSummary?.hasBold ?? fallback;
}

function paragraphProperties(spec: ReferenceStyleSpec): string {
  const binding = spec.binding;
  const fallbackAlignment = spec.fallbackAlignment;
  const alignment = alignmentFromBinding(binding, fallbackAlignment);
  const spacing = { ...spec.fallbackSpacing, ...binding?.formatting?.spacing };
  const indentation = { ...spec.fallbackIndentation, ...binding?.formatting?.indentation };
  const spacingXml = spacing
    ? `<w:spacing${spacing.before !== undefined ? ` w:before="${spacing.before}"` : ''}${spacing.after !== undefined ? ` w:after="${spacing.after}"` : ''}${spacing.line !== undefined ? ` w:line="${spacing.line}"` : ''}${spacing.lineRule ? ` w:lineRule="${xmlEscape(String(spacing.lineRule))}"` : ''}/>`
    : '';
  const firstLine = indentation?.firstLine;
  const hanging = indentation?.hanging ?? (typeof firstLine === 'number' && firstLine < 0 ? Math.abs(firstLine) : undefined);
  const positiveFirstLine = typeof firstLine === 'number' && firstLine >= 0 ? firstLine : undefined;
  const indentationXml = indentation
    ? `<w:ind${indentation.left !== undefined ? ` w:left="${indentation.left}"` : ''}${indentation.right !== undefined ? ` w:right="${indentation.right}"` : ''}${positiveFirstLine !== undefined ? ` w:firstLine="${positiveFirstLine}"` : ''}${hanging !== undefined ? ` w:hanging="${hanging}"` : ''}/>`
    : '';
  return `<w:pPr><w:jc w:val="${xmlEscape(alignment)}"/>${spacingXml}${indentationXml}</w:pPr>`;
}

function runProperties(spec: ReferenceStyleSpec): string {
  const size = sizeFromSpec(spec);
  const asciiFont = asciiFontFromSpec(spec);
  const eastAsiaFont = eastAsiaFontFromSpec(spec);
  const bold = boldFromBinding(spec.binding, spec.fallbackBold ?? false);
  return [
    '<w:rPr>',
    `<w:rFonts w:ascii="${xmlEscape(asciiFont)}" w:hAnsi="${xmlEscape(asciiFont)}" w:eastAsia="${xmlEscape(eastAsiaFont)}" w:cs="${xmlEscape(asciiFont)}"/>`,
    bold ? '<w:b/><w:bCs/>' : '',
    `<w:sz w:val="${size}"/>`,
    `<w:szCs w:val="${size}"/>`,
    '</w:rPr>',
  ].join('');
}

function styleXml(spec: ReferenceStyleSpec): string {
  const basedOn = spec.basedOn ? `<w:basedOn w:val="${normalizeStyleId(spec.basedOn)}"/>` : '';
  return [
    `<w:style w:type="paragraph" w:styleId="${normalizeStyleId(spec.styleId)}">`,
    `<w:name w:val="${xmlEscape(spec.styleName)}"/>`,
    basedOn,
    '<w:qFormat/>',
    paragraphProperties(spec),
    runProperties(spec),
    '</w:style>',
  ].join('');
}

function tableStylesXml(): string[] {
  return [
    '<w:style w:type="table" w:styleId="Table"><w:name w:val="Table"/><w:tblPr><w:jc w:val="center"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>',
    '<w:style w:type="table" w:styleId="FigureTable"><w:name w:val="Figure Table"/><w:tblPr><w:jc w:val="center"/><w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders></w:tblPr></w:style>',
  ];
}

function removeStyleById(styles: string, styleId: string): string {
  const escaped = normalizeStyleId(styleId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return styles.replace(new RegExp(`<w:style\\b(?=[^>]*w:styleId="${escaped}")[\\s\\S]*?<\\/w:style>`, 'g'), '');
}

function stylesXml(specs: ReferenceStyleSpec[], existingStylesXml?: string): string {
  const styleIds = new Set<string>();
  const uniqueSpecs = specs.filter((spec) => {
    const styleId = normalizeStyleId(spec.styleId);
    if (styleIds.has(styleId)) return false;
    styleIds.add(styleId);
    return true;
  });
  const generatedStyles = [...uniqueSpecs.map(styleXml), ...tableStylesXml()];

  if (existingStylesXml?.includes('</w:styles>')) {
    const generatedStyleIds = [
      ...uniqueSpecs.map((spec) => normalizeStyleId(spec.styleId)),
      'Table',
      'FigureTable',
    ];
    const mergedWithoutDuplicates = generatedStyleIds.reduce((styles, styleId) => removeStyleById(styles, styleId), existingStylesXml);
    return mergedWithoutDuplicates.replace('</w:styles>', `${generatedStyles.join('')}</w:styles>`);
  }

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<w:styles ${WORD_NS}>`,
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>',
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="0" w:line="360" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>',
    ...generatedStyles,
    '</w:styles>',
  ].join('');
}

function pageXml(page?: ExtractedPageSettings, sectionPropertiesXml?: string): string {
  if (sectionPropertiesXml?.trim()) {
    return sectionPropertiesXml;
  }

  const width = page?.widthTwips ?? 11906;
  const height = page?.heightTwips ?? 16838;
  const orientation = page?.orientation === 'landscape' ? ' w:orient="landscape"' : '';
  const margins = page?.margins;
  return [
    '<w:sectPr>',
    `<w:pgSz w:w="${width}" w:h="${height}"${orientation}/>`,
    `<w:pgMar w:top="${margins?.top ?? 1440}" w:right="${margins?.right ?? 1800}" w:bottom="${margins?.bottom ?? 1440}" w:left="${margins?.left ?? 1800}" w:header="${margins?.header ?? 851}" w:footer="${margins?.footer ?? 992}" w:gutter="${margins?.gutter ?? 0}"/>`,
    '</w:sectPr>',
  ].join('');
}

function paragraphXml(styleId: string, text: string): string {
  return `<w:p><w:pPr><w:pStyle w:val="${normalizeStyleId(styleId)}"/></w:pPr><w:r><w:t>${xmlEscape(text)}</w:t></w:r></w:p>`;
}

function documentXml(specs: ReferenceStyleSpec[], page?: ExtractedPageSettings, sectionPropertiesXml?: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<w:document ${WORD_NS}>`,
    '<w:body>',
    ...specs.map((spec) => paragraphXml(spec.styleId, spec.sampleText)),
    pageXml(page, sectionPropertiesXml),
    '</w:body>',
    '</w:document>',
  ].join('');
}

function specsFromSchema(schema: TemplateSchemaDraft): ReferenceStyleSpec[] {
  const mapping = schema.semanticMapping;
  const zhBody = { asciiFont: 'Times New Roman', eastAsiaFont: '宋体' };
  const zhHeading = { asciiFont: 'Times New Roman', eastAsiaFont: '黑体' };
  const enBody = { asciiFont: 'Times New Roman', eastAsiaFont: 'Times New Roman' };
  const bodyParagraph = { fallbackSpacing: { before: 0, after: 0, line: 360, lineRule: 'auto' }, fallbackIndentation: { firstLine: 480 } };
  const plainParagraph = { fallbackSpacing: { before: 0, after: 0, line: 360, lineRule: 'auto' } };
  const titleParagraph = { fallbackSpacing: { before: 240, after: 240, line: 360, lineRule: 'auto' } };
  const captionParagraph = { fallbackSpacing: { before: 120, after: 120, line: 240, lineRule: 'auto' } };
  return [
    { role: 'title', styleId: 'Title', styleName: 'Title', binding: mapping.cover?.titleField ?? schema.roles.title, fixedSize: 36, fallbackBold: true, fallbackAlignment: 'center', sampleText: '论文题目', ...titleParagraph, ...zhHeading },
    { role: 'authors', styleId: 'Author', styleName: 'Author', binding: mapping.cover?.authorField ?? schema.roles.authors, fixedSize: 24, fallbackAlignment: 'center', sampleText: '作者姓名', ...plainParagraph, ...zhBody },
    { role: 'abstract-title', styleId: 'AbstractTitle', styleName: 'Abstract Title', binding: mapping.abstracts?.zh?.title, fixedSize: 32, fallbackBold: true, fallbackAlignment: 'center', sampleText: '摘要', ...titleParagraph, ...zhHeading },
    { role: 'abstract-body', styleId: 'Abstract', styleName: 'Abstract', binding: mapping.abstracts?.zh?.body ?? schema.roles.abstract, fixedSize: 24, fallbackAlignment: 'both', sampleText: '摘要正文样式。', ...bodyParagraph, ...zhBody },
    { role: 'keywords', styleId: 'Keywords', styleName: 'Keywords', binding: mapping.abstracts?.zh?.keywords?.label ?? schema.roles.keywords, fixedSize: 24, fallbackBold: true, sampleText: '关键词：关键词一；关键词二', ...plainParagraph, ...zhBody },
    { role: 'english-abstract-title', styleId: 'EnglishAbstractTitle', styleName: 'English Abstract Title', binding: mapping.abstracts?.en?.title, fixedSize: 32, fallbackBold: true, fallbackAlignment: 'center', sampleText: 'Abstract', ...titleParagraph, ...enBody },
    { role: 'english-abstract-body', styleId: 'EnglishAbstract', styleName: 'English Abstract', binding: mapping.abstracts?.en?.body, fixedSize: 24, fallbackAlignment: 'both', sampleText: 'English abstract body style.', ...bodyParagraph, ...enBody },
    { role: 'english-keywords', styleId: 'EnglishKeywords', styleName: 'English Keywords', binding: mapping.abstracts?.en?.keywords?.label, fixedSize: 24, fallbackBold: true, sampleText: 'Key Words: keyword one; keyword two', ...plainParagraph, ...enBody },
    { role: 'toc-title', styleId: 'TOCHeading', styleName: 'TOC Heading', binding: mapping.toc?.title, fixedSize: 32, fallbackBold: true, fallbackAlignment: 'center', sampleText: '目 录', ...titleParagraph, ...zhHeading },
    { role: 'toc-entry-level1', styleId: 'TOC1', styleName: 'TOC 1', binding: mapping.toc?.entries?.[0], fixedSize: 24, fallbackIndentation: { left: 0 }, sampleText: '1. 引言', ...plainParagraph, ...zhBody },
    { role: 'toc-entry-level2', styleId: 'TOC2', styleName: 'TOC 2', binding: mapping.toc?.entries?.[1], fixedSize: 24, fallbackIndentation: { left: 280 }, sampleText: '1.1 研究背景', ...plainParagraph, ...zhBody },
    { role: 'toc-entry-level3', styleId: 'TOC3', styleName: 'TOC 3', binding: mapping.toc?.entries?.[2], fixedSize: 24, fallbackIndentation: { left: 560 }, sampleText: '1.1.1 三级标题', ...plainParagraph, ...zhBody },
    { role: 'body-first-paragraph', styleId: 'FirstParagraph', styleName: 'First Paragraph', binding: mapping.body ?? schema.roles.body, basedOn: 'Normal', fixedSize: 24, sampleText: '正文段落样式。', ...bodyParagraph, ...zhBody },
    { role: 'body', styleId: 'BodyText', styleName: 'Body Text', binding: mapping.body ?? schema.roles.body, basedOn: 'Normal', fixedSize: 24, sampleText: '正文段落样式。', ...bodyParagraph, ...zhBody },
    { role: 'compact-body', styleId: 'Compact', styleName: 'Compact', binding: mapping.body ?? schema.roles.body, basedOn: 'Normal', fixedSize: 24, sampleText: '表格正文样式。', ...plainParagraph, ...zhBody },
    { role: 'heading1', styleId: 'Heading1', styleName: 'Heading 1', binding: mapping.headings?.level1 ?? schema.roles.heading1, basedOn: 'Normal', fixedSize: 32, fallbackBold: true, fallbackAlignment: 'center', sampleText: '1. 一级标题', ...titleParagraph, ...zhHeading },
    { role: 'heading2', styleId: 'Heading2', styleName: 'Heading 2', binding: mapping.headings?.level2 ?? schema.roles.heading2, basedOn: 'Normal', fixedSize: 28, fallbackBold: true, sampleText: '1.1 二级标题', ...titleParagraph, ...zhHeading },
    { role: 'equation', styleId: 'Equation', styleName: 'Equation', binding: mapping.body ?? schema.roles.body, basedOn: 'Normal', fixedSize: 24, fallbackAlignment: 'center', sampleText: 'E = mc^2', ...plainParagraph, ...zhBody },
    { role: 'captioned-figure', styleId: 'CaptionedFigure', styleName: 'Captioned Figure', binding: mapping.captions?.figure ?? schema.roles.figureCaption, basedOn: 'Normal', fixedSize: 24, fallbackAlignment: 'center', sampleText: '图片对象样式', ...plainParagraph, ...zhBody },
    { role: 'figure-caption', styleId: 'ImageCaption', styleName: 'Image Caption', binding: mapping.captions?.figure ?? schema.roles.figureCaption, fixedSize: 21, fallbackAlignment: 'center', sampleText: '图1-1 图题样式', ...captionParagraph, ...zhBody },
    { role: 'figure-caption-compat', styleId: 'FigureCaption', styleName: 'Figure Caption', binding: mapping.captions?.figure ?? schema.roles.figureCaption, fixedSize: 21, fallbackAlignment: 'center', sampleText: '图1-1 图题样式', ...captionParagraph, ...zhBody },
    { role: 'table-caption', styleId: 'TableCaption', styleName: 'Table Caption', binding: mapping.captions?.table ?? schema.roles.tableCaption, fixedSize: 21, fallbackAlignment: 'center', sampleText: '表1-1 表题样式', ...captionParagraph, ...zhBody },
    { role: 'references-title', styleId: 'ReferencesTitle', styleName: 'References Title', binding: mapping.references?.title ?? schema.roles.references, fixedSize: 32, fallbackBold: true, fallbackAlignment: 'center', sampleText: '参考文献', ...titleParagraph, ...zhHeading },
    { role: 'bibliography', styleId: 'Bibliography', styleName: 'Bibliography', binding: mapping.references?.firstItem, fixedSize: 24, fallbackIndentation: { left: 480, hanging: 480 }, sampleText: '[1] 参考文献条目样式。', ...plainParagraph, ...zhBody },
    { role: 'acknowledgement-title', styleId: 'AcknowledgementTitle', styleName: 'Acknowledgement Title', binding: mapping.acknowledgement?.title, fixedSize: 32, fallbackBold: true, fallbackAlignment: 'center', sampleText: '致谢', ...titleParagraph, ...zhHeading },
    { role: 'appendix-title', styleId: 'AppendixTitle', styleName: 'Appendix Title', binding: mapping.appendix?.title, fixedSize: 32, fallbackBold: true, fallbackAlignment: 'center', sampleText: '附录', ...titleParagraph, ...zhHeading },
    { role: 'header', styleId: 'Header', styleName: 'Header', fixedSize: 18, fallbackAlignment: 'center', sampleText: '页眉样式', ...plainParagraph, ...zhBody },
    { role: 'footer', styleId: 'Footer', styleName: 'Footer', fixedSize: 18, fallbackAlignment: 'center', sampleText: '页脚样式', ...plainParagraph, ...zhBody },
  ];
}

function manifestFromSpecs(
  input: { schema: TemplateSchemaDraft; sourceDocxPath: string; outputPath: string },
  specs: ReferenceStyleSpec[],
): RenderReferenceManifest {
  return {
    generatedAt: new Date().toISOString(),
    schemaVersion: input.schema.schemaVersion,
    templateId: input.schema.templateId,
    templateVersion: input.schema.templateVersion,
    sourceDocxPath: input.sourceDocxPath,
    outputPath: input.outputPath,
    strategy: 'schema-driven-reference-docx',
    note: 'render-reference.docx is generated from schema style bindings and uses the source DOCX only as an OOXML package shell.',
    styleBindings: specs.map((spec) => ({
      role: spec.role,
      styleId: normalizeStyleId(spec.styleId),
      styleName: spec.styleName,
      sourceParagraphIndex: spec.binding?.paragraphIndex,
      sourceText: spec.binding?.sampleText,
      evidence: spec.binding?.evidence ?? [],
    })),
  };
}
