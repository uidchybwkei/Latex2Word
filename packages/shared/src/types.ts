export type ToolName = 'pandoc' | 'python' | 'latexmk';

export interface ToolVersionInfo {
  name: ToolName;
  detected: boolean;
  path?: string;
  version?: string;
  checkedAt: string;
  error?: string;
}

export interface UserSettings {
  storageRoot?: string;
  pandocPath?: string;
  pythonPath?: string;
  latexmkPath?: string;
  ai: {
    enabled: boolean;
    baseUrl?: string;
    apiKeyRef?: string;
    model?: string;
    timeoutMs: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface Template {
  id: string;
  name: string;
  version: number;
  activeSchemaVersionId?: string;
  status: 'draft' | 'validated' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface TemplateAsset {
  id: string;
  templateId: string;
  kind:
    | 'source-template-doc'
    | 'source-template-docx'
    | 'render-reference-docx'
    | 'render-reference-manifest-json'
    | 'schema-json'
    | 'latex-fixed-template';
  path: string;
  sha256: string;
  version: number;
  createdAt: string;
}

export interface SchemaVersion {
  id: string;
  templateId: string;
  version: number;
  path: string;
  sha256: string;
  createdAt: string;
}

export interface ExtractedPageMargins {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
  header?: number;
  footer?: number;
  gutter?: number;
}

export interface ExtractedPageSettings {
  widthTwips?: number;
  heightTwips?: number;
  orientation?: 'portrait' | 'landscape';
  margins?: ExtractedPageMargins;
}

export interface ExtractedStyleInfo {
  styleId: string;
  name?: string;
  type: string;
}

export interface ExtractedParagraphRunSummary {
  runs: number;
  runCount?: number;
  textRunCount?: number;
  boldRuns: number;
  boldRunCount?: number;
  italicRuns: number;
  italicRunCount?: number;
  underlineRunCount?: number;
  sizes: string[];
  fontSizes?: number[];
  maxFontSize?: number;
  minFontSize?: number;
  dominantFontSize?: number;
  fonts: string[];
  eastAsiaFonts?: string[];
  dominantFont?: string;
  hasBold?: boolean;
  mostlyBold?: boolean;
}

export interface ExtractedParagraphInfo {
  index: number;
  rawText?: string;
  normalizedText?: string;
  visibleText?: string;
  styleId?: string;
  alignment?: string;
  outlineLevel?: number;
  numbering?: {
    numId?: string;
    level?: string;
    ilvl?: string;
  };
  indentation?: {
    left?: number;
    right?: number;
    firstLine?: number;
    hanging?: number;
    [key: string]: number | undefined;
  };
  spacing?: {
    before?: number;
    after?: number;
    line?: number;
    lineRule?: string;
    [key: string]: number | string | undefined;
  };
  runSummary?: ExtractedParagraphRunSummary;
  pageBreakBefore?: boolean;
  containsPageBreak?: boolean;
  sectionBreak?: {
    type?: string;
    page?: ExtractedPageSettings;
  };
  isFieldCode?: boolean;
  isTocHyperlink?: boolean;
  text: string;
}

export interface ExtractedTableInfo {
  index: number;
  textSample?: string;
  styleId?: string;
  alignment?: string;
  width?: {
    value?: number;
    type?: string;
  };
  layout?: string;
  borders?: {
    top?: string;
    left?: string;
    bottom?: string;
    right?: string;
    insideH?: string;
    insideV?: string;
  };
  cellMargins?: {
    top?: number;
    left?: number;
    bottom?: number;
    right?: number;
  };
  gridColumnWidths?: number[];
  tblPrXml?: string;
}

export interface TemplateRoleBinding {
  styleId?: string;
  sampleText?: string;
  paragraphIndex?: number;
  paragraphIndexes?: number[];
  normalizedText?: string;
  confidence?: number;
  evidence?: string[];
  formatting?: {
    alignment?: string;
    outlineLevel?: number;
    numbering?: ExtractedParagraphInfo['numbering'];
    indentation?: ExtractedParagraphInfo['indentation'];
    spacing?: ExtractedParagraphInfo['spacing'];
    runSummary?: ExtractedParagraphRunSummary;
  };
  notes?: string;
}

export interface ChineseAbstractSemanticMapping {
  title?: TemplateRoleBinding;
  body?: TemplateRoleBinding;
  keywords?: {
    label?: TemplateRoleBinding;
    content?: TemplateRoleBinding;
  };
}

export interface TemplateSemanticMapping {
  titleStyleId?: string;
  heading1StyleId?: string;
  heading2StyleId?: string;
  abstractParagraphIndex?: number;
  referencesParagraphIndex?: number;
  language?: 'zh-CN' | 'en' | 'unknown' | string;
  confidence?: number;
  warnings?: string[];
  cover?: {
    titleField?: TemplateRoleBinding;
    authorField?: TemplateRoleBinding;
    studentIdField?: TemplateRoleBinding;
    schoolField?: TemplateRoleBinding;
    majorField?: TemplateRoleBinding;
    supervisorField?: TemplateRoleBinding;
  };
  abstracts?: {
    zh?: ChineseAbstractSemanticMapping;
    en?: ChineseAbstractSemanticMapping;
  };
  toc?: {
    title?: TemplateRoleBinding;
    entries?: TemplateRoleBinding[];
  };
  headings?: {
    level1?: TemplateRoleBinding;
    level2?: TemplateRoleBinding;
    level1Candidates?: TemplateRoleBinding[];
    level2Candidates?: TemplateRoleBinding[];
  };
  body?: TemplateRoleBinding;
  captions?: {
    figure?: TemplateRoleBinding;
    table?: TemplateRoleBinding;
  };
  references?: {
    title?: TemplateRoleBinding;
    firstItem?: TemplateRoleBinding;
  };
  acknowledgement?: {
    title?: TemplateRoleBinding;
    body?: TemplateRoleBinding;
  };
  appendix?: {
    title?: TemplateRoleBinding;
    body?: TemplateRoleBinding;
  };
}

export interface TemplateSchemaDraft {
  schemaVersion: string;
  generatedAt: string;
  templateId: string;
  templateVersion: number;
  sourceTemplateAssetId: string;
  rawExtraction: {
    styleCount: number;
    paragraphCount: number;
    tableCount?: number;
    sectionCount: number;
    page?: ExtractedPageSettings;
    styles: ExtractedStyleInfo[];
    paragraphSamples: ExtractedParagraphInfo[];
    tableSamples?: ExtractedTableInfo[];
  };
  semanticMapping: TemplateSemanticMapping;
  document: {
    page?: ExtractedPageSettings;
    sectionPropertiesXml?: string;
    headerFooter: {
      detected: boolean;
    };
    numbering: {
      detected: boolean;
    };
    tables?: {
      detected: boolean;
      count: number;
      bodyTable?: ExtractedTableInfo;
      samples: ExtractedTableInfo[];
    };
  };
  roles: {
    title: TemplateRoleBinding;
    authors: TemplateRoleBinding;
    abstract: TemplateRoleBinding;
    keywords: TemplateRoleBinding;
    body: TemplateRoleBinding;
    heading1: TemplateRoleBinding;
    heading2: TemplateRoleBinding;
    figureCaption: TemplateRoleBinding;
    tableCaption: TemplateRoleBinding;
    references: TemplateRoleBinding;
  };
  editableFields: string[];
}

export interface ImportedTemplateSummary {
  template: Template;
  assets: TemplateAsset[];
  schemaVersion: SchemaVersion;
  schema: TemplateSchemaDraft;
}

export interface ConversionJob {
  id: string;
  templateId?: string;
  schemaVersionId?: string;
  templateVersion?: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  stage: 'bootstrap' | 'analyze' | 'generate' | 'convert' | 'check';
  inputPath?: string;
  workingDirectory: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  errorMessage?: string;
  toolVersions: Partial<Record<ToolName, string>>;
}

export interface ConversionArtifact {
  id: string;
  jobId: string;
  kind: 'input-copy' | 'output-docx' | 'report-json' | 'job-log';
  path: string;
  sha256?: string;
  createdAt: string;
}

export interface FormatIssue {
  id: string;
  jobId: string;
  severity: 'info' | 'warning' | 'error';
  category: 'page' | 'font' | 'spacing' | 'heading' | 'caption' | 'reference' | 'header-footer' | 'numbering' | 'structure';
  message: string;
  expected?: string;
  actual?: string;
  location?: string;
  createdAt: string;
}

export interface AIReviewResult {
  id: string;
  jobId?: string;
  templateId?: string;
  task: 'schema-generation' | 'latex-template-generation' | 'format-review' | 'fix-suggestion';
  model: string;
  summary: string;
  confidence?: number;
  promptDigest?: string;
  createdAt: string;
}

export interface AppPaths {
  userDataDir: string;
  templatesDir: string;
  jobsDir: string;
  cacheDir: string;
  logsDir: string;
  databasePath: string;
}

export type TemplateImportStage =
  | 'import started'
  | 'source copied'
  | 'doc conversion started'
  | 'doc conversion finished'
  | 'docx zip read started'
  | 'document.xml read finished'
  | 'paragraphs extracted'
  | 'schema inferred'
  | 'schema written'
  | 'assets prepared'
  | 'database save started'
  | 'database save finished'
  | 'import finished';

export interface TemplateImportProgress {
  importId: string;
  stage: TemplateImportStage;
  status: 'started' | 'finished' | 'failed';
  timestamp: string;
  elapsedMs: number;
  filePath?: string;
  fileSizeBytes?: number;
  paragraphCount?: number;
  styleCount?: number;
  message?: string;
  error?: string;
  logPath?: string;
}

export interface AppBootstrapResult {
  paths: AppPaths;
  settings: UserSettings;
  tools: ToolVersionInfo[];
}

export interface QueueJobRequest {
  stage: ConversionJob['stage'];
  templateId?: string;
  schemaVersionId?: string;
  templateVersion?: number;
  inputPath?: string;
}

export interface QueueJobResult {
  job: ConversionJob;
}

export interface LatexTemplateGenerationResult {
  templateId: string;
  templateVersion: number;
  outputPath: string;
  asset: TemplateAsset;
}

export interface LatexConversionResult {
  job: ConversionJob;
  templateId: string;
  templateVersion: number;
  latexInputPath: string;
  latexInputCopyPath: string;
  referenceDocxPath: string;
  outputPath: string;
  logPath: string;
}
