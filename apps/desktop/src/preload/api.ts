import type {
  AppBootstrapResult,
  ConversionJob,
  ImportedTemplateSummary,
  LatexConversionResult,
  LatexTemplateGenerationResult,
  QueueJobResult,
  TemplateImportProgress,
  ToolVersionInfo,
  UserSettings,
} from '@latex2docx/shared';

export interface DesktopApi {
  bootstrap(): Promise<AppBootstrapResult>;
  getSettings(): Promise<UserSettings>;
  saveSettings(settings: UserSettings): Promise<UserSettings>;
  detectTools(): Promise<ToolVersionInfo[]>;
  queueBootstrapJob(): Promise<QueueJobResult>;
  listJobs(): Promise<ConversionJob[]>;
  importTemplate(): Promise<ImportedTemplateSummary | null>;
  onTemplateImportProgress(callback: (progress: TemplateImportProgress) => void): () => void;
  listTemplates(): Promise<ImportedTemplateSummary[]>;
  generateFixedLatexTemplate(templateId: string): Promise<LatexTemplateGenerationResult>;
  convertLatexWithTemplate(templateId: string): Promise<LatexConversionResult | null>;
  deleteTemplateHistory(templateId: string): Promise<void>;
  clearTemplateHistory(): Promise<void>;
}
