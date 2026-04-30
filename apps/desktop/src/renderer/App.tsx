import { useEffect, useMemo, useState } from 'react';
import type {
  AppBootstrapResult,
  ConversionJob,
  ImportedTemplateSummary,
  TemplateImportProgress,
  TemplateRoleBinding,
  ToolVersionInfo,
  UserSettings,
} from '@latex2docx/shared';

const emptySettings = (): UserSettings => ({
  ai: {
    enabled: false,
    timeoutMs: 30000,
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

export function App() {
  const [bootstrap, setBootstrap] = useState<AppBootstrapResult | null>(null);
  const [settings, setSettings] = useState<UserSettings>(emptySettings);
  const [tools, setTools] = useState<ToolVersionInfo[]>([]);
  const [jobs, setJobs] = useState<ConversionJob[]>([]);
  const [templates, setTemplates] = useState<ImportedTemplateSummary[]>([]);
  const [lastGeneratedLatexPath, setLastGeneratedLatexPath] = useState<string | null>(null);
  const [lastConvertedDocxPath, setLastConvertedDocxPath] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<TemplateImportProgress | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>('Bootstrapping application...');

  useEffect(() => {
    void initialize();
  }, []);

  useEffect(() => {
    if (typeof window.api.onTemplateImportProgress !== 'function') {
      setImportError('Preload API is stale: onTemplateImportProgress is missing. Restart pnpm dev after rebuilding preload.cjs.');
      return undefined;
    }

    if (
      typeof window.api.deleteTemplateHistory !== 'function'
      || typeof window.api.clearTemplateHistory !== 'function'
    ) {
      setImportError('Preload API is stale: deleteTemplateHistory / clearTemplateHistory is missing. Restart pnpm dev so preload.cjs is reloaded.');
      return undefined;
    }

    return window.api.onTemplateImportProgress((progress) => {
      setImportProgress(progress);
      if (progress.error) {
        setImportError(progress.error);
      }
      setMessage(`${progress.stage} (${progress.status})`);
    });
  }, []);

  const pandoc = useMemo(
    () => tools.find((tool) => tool.name === 'pandoc'),
    [tools],
  );
  const detectedToolsCount = tools.filter((tool) => tool.detected).length;

  async function refreshTemplates() {
    setTemplates(await window.api.listTemplates());
  }

  async function refreshJobs() {
    setJobs(await window.api.listJobs());
  }

  async function initialize() {
    setBusy(true);
    try {
      const result = await window.api.bootstrap();
      setBootstrap(result);
      setSettings(result.settings);
      setTools(result.tools);
      setJobs(await window.api.listJobs());
      setTemplates(await window.api.listTemplates());
      setMessage('Runtime initialized.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to initialize runtime.');
    } finally {
      setBusy(false);
    }
  }

  async function handleImportTemplate() {
    setBusy(true);
    setImportError(null);
    setImportProgress(null);
    try {
      const imported = await window.api.importTemplate();
      if (!imported) {
        setMessage('Template import cancelled.');
        return;
      }

      await refreshTemplates();
      setMessage(`Imported template \"${imported.template.name}\" and generated schema.json.`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to import template.';
      setImportError(errorMessage);
      setMessage(errorMessage);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveSettings() {
    setBusy(true);
    try {
      const next = await window.api.saveSettings(settings);
      setSettings(next);
      const nextTools = await window.api.detectTools();
      setTools(nextTools);
      setMessage('Settings saved.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to save settings.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDetectTools() {
    setBusy(true);
    try {
      const nextTools = await window.api.detectTools();
      setTools(nextTools);
      setMessage('Tool detection finished.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to detect tools.');
    } finally {
      setBusy(false);
    }
  }

  async function handleQueueBootstrapJob() {
    setBusy(true);
    try {
      await window.api.queueBootstrapJob();
      await refreshJobs();
      setMessage('Bootstrap job queued.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to queue job.');
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerateFixedLatex(summary: ImportedTemplateSummary) {
    setBusy(true);
    try {
      const result = await window.api.generateFixedLatexTemplate(summary.template.id);
      setLastGeneratedLatexPath(result.outputPath);
      await refreshTemplates();
      setMessage(`Generated fixed LaTeX template for "${summary.template.name}".`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to generate fixed LaTeX template.');
    } finally {
      setBusy(false);
    }
  }

  async function handleConvertLatex(summary: ImportedTemplateSummary) {
    setBusy(true);
    try {
      const result = await window.api.convertLatexWithTemplate(summary.template.id);
      if (!result) {
        setMessage('LaTeX conversion cancelled.');
        return;
      }

      setLastConvertedDocxPath(result.outputPath);
      await refreshJobs();
      setMessage(`Converted LaTeX manuscript for "${summary.template.name}".`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to convert LaTeX manuscript.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteTemplate(summary: ImportedTemplateSummary) {
    const confirmed = window.confirm(`Delete history for "${summary.template.name}"? This removes the imported template, generated schema, assets, and related job history.`);
    if (!confirmed) {
      return;
    }

    setBusy(true);
    try {
      await window.api.deleteTemplateHistory(summary.template.id);
      await Promise.all([refreshTemplates(), refreshJobs()]);
      setMessage(`Deleted history for "${summary.template.name}".`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to delete template history.');
    } finally {
      setBusy(false);
    }
  }

  async function handleClearTemplateHistory() {
    if (templates.length === 0) {
      setMessage('No template history to delete.');
      return;
    }

    const confirmed = window.confirm(`Delete all template history entries? This removes ${templates.length} template record${templates.length === 1 ? '' : 's'} and their generated assets.`);
    if (!confirmed) {
      return;
    }

    setBusy(true);
    try {
      await window.api.clearTemplateHistory();
      await Promise.all([refreshTemplates(), refreshJobs()]);
      setMessage('Cleared all template history.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to clear template history.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="hero-card">
        <div className="hero-copy">
          <p className="eyebrow">LaTeX2Docx</p>
          <h1>Phase 2 / Phase 3 Desktop Workflow</h1>
          <p className="subcopy">
            macOS-first Electron shell with template schema extraction, deterministic fixed LaTeX generation, Pandoc conversion, and local metadata storage.
          </p>
        </div>
        <div className="hero-meta">
          <div className="status-pill">{busy ? 'Working' : 'Ready'}</div>
          <div className="hero-stats">
            <div>
              <span>Templates</span>
              <strong>{templates.length}</strong>
            </div>
            <div>
              <span>Jobs</span>
              <strong>{jobs.length}</strong>
            </div>
            <div>
              <span>Tools</span>
              <strong>{detectedToolsCount}/{tools.length}</strong>
            </div>
          </div>
        </div>
      </header>

      <main className="grid">
        <section className="card">
          <h2>Runtime</h2>
          <div className="kv-list">
            <div>
              <span>User data</span>
              <strong>{bootstrap?.paths.userDataDir ?? '—'}</strong>
            </div>
            <div>
              <span>Templates dir</span>
              <strong>{bootstrap?.paths.templatesDir ?? '—'}</strong>
            </div>
            <div>
              <span>Jobs dir</span>
              <strong>{bootstrap?.paths.jobsDir ?? '—'}</strong>
            </div>
            <div>
              <span>SQLite</span>
              <strong>{bootstrap?.paths.databasePath ?? '—'}</strong>
            </div>
          </div>
          <button onClick={handleQueueBootstrapJob} disabled={busy}>
            Queue bootstrap job
          </button>
        </section>

        <section className="card">
          <div className="section-header">
            <h2>Tool detection</h2>
            <button onClick={handleDetectTools} disabled={busy}>
              Re-check
            </button>
          </div>
          <div className="tool-list">
            {tools.map((tool) => (
              <article key={tool.name} className="tool-card">
                <div className="tool-card-header">
                  <h3>{tool.name}</h3>
                  <span className={tool.detected ? 'ok' : 'warn'}>
                    {tool.detected ? 'Detected' : 'Missing'}
                  </span>
                </div>
                <p>{tool.version ?? tool.error ?? 'No version information'}</p>
                <small>{tool.path ?? 'Using PATH lookup'}</small>
              </article>
            ))}
          </div>
          <p className="hint">
            Pandoc is the only blocker for the next conversion spike. Current status: {pandoc?.detected ? 'ready' : 'needs installation'}.
          </p>
        </section>

        <section className="card settings-card">
          <h2>Settings</h2>
          <label>
            <span>Pandoc path</span>
            <input
              value={settings.pandocPath ?? ''}
              onChange={(event) => setSettings((current) => ({ ...current, pandocPath: event.target.value || undefined }))}
              placeholder="pandoc or /opt/homebrew/bin/pandoc"
            />
          </label>
          <label>
            <span>Python path</span>
            <input
              value={settings.pythonPath ?? ''}
              onChange={(event) => setSettings((current) => ({ ...current, pythonPath: event.target.value || undefined }))}
              placeholder="python3"
            />
          </label>
          <label>
            <span>Storage root override</span>
            <input
              value={settings.storageRoot ?? ''}
              onChange={(event) => setSettings((current) => ({ ...current, storageRoot: event.target.value || undefined }))}
              placeholder="Optional override"
            />
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.ai.enabled}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  ai: {
                    ...current.ai,
                    enabled: event.target.checked,
                  },
                }))
              }
            />
            <span>Enable AI features later</span>
          </label>
          <button onClick={handleSaveSettings} disabled={busy}>
            Save settings
          </button>
        </section>

        <section className="card">
          <h2>Jobs</h2>
          <div className="jobs-list">
            {jobs.length === 0 ? (
              <p>No jobs queued yet.</p>
            ) : (
              jobs.map((job) => (
                <article key={job.id} className="job-card">
                  <div>
                    <strong>{job.stage}</strong>
                    <span>{job.status}</span>
                  </div>
                  <small>{job.workingDirectory}</small>
                </article>
              ))
            )}
          </div>
        </section>

        <section className="card template-card">
          <div className="section-header">
            <div>
              <h2>Template import</h2>
              <p className="section-note">Imported templates, generated schema, and conversion artifacts live here.</p>
            </div>
            <div className="section-actions">
              <button className="secondary-button" onClick={handleClearTemplateHistory} disabled={busy || templates.length === 0}>
                Clear history
              </button>
              <button onClick={handleImportTemplate} disabled={busy}>
                Import .doc/.docx template
              </button>
            </div>
          </div>
          <p className="hint">
            Phase 2 imports Chinese thesis Word templates, extracts direct OOXML formatting, generates `schema.json`, and writes debug artifacts beside the template version.
          </p>
          <div className="template-meta-grid">
            <div>
              <span>Last fixed LaTeX</span>
              <strong>{lastGeneratedLatexPath ?? '—'}</strong>
            </div>
            <div>
              <span>Last converted .docx</span>
              <strong>{lastConvertedDocxPath ?? '—'}</strong>
            </div>
          </div>
          <div className="template-meta-grid">
            <div>
              <span>Data dir</span>
              <strong>{bootstrap?.paths.userDataDir ?? '—'}</strong>
            </div>
            <div>
              <span>Current stage</span>
              <strong>{importProgress ? `${importProgress.stage} · ${importProgress.status}` : '—'}</strong>
            </div>
            <div>
              <span>Elapsed</span>
              <strong>{importProgress ? `${importProgress.elapsedMs} ms` : '—'}</strong>
            </div>
            <div>
              <span>Log</span>
              <strong>{importProgress?.logPath ?? (bootstrap ? `${bootstrap.paths.logsDir}/template-import.log` : '—')}</strong>
            </div>
          </div>
          {importError ? <p className="error-box">{importError}</p> : null}
          <div className="template-list">
            {templates.length === 0 ? (
              <p>No templates imported yet.</p>
            ) : (
              templates.map((summary) => (
                <article key={summary.template.id} className="template-summary-card">
                  <div className="template-summary-header">
                    <div>
                      <strong>{summary.template.name}</strong>
                      <small>{summary.template.id}</small>
                    </div>
                    <span className="ok">v{summary.template.version}</span>
                  </div>
                  <div className="template-meta-grid">
                    <div>
                      <span>Schema path</span>
                      <strong>{summary.schemaVersion.path}</strong>
                    </div>
                    <div>
                      <span>Styles</span>
                      <strong>{summary.schema.rawExtraction.styleCount}</strong>
                    </div>
                    <div>
                      <span>Paragraphs</span>
                      <strong>{summary.schema.rawExtraction.paragraphCount}</strong>
                    </div>
                    <div>
                      <span>Sections</span>
                      <strong>{summary.schema.rawExtraction.sectionCount}</strong>
                    </div>
                  </div>
                  <div className="template-action-row">
                    <button onClick={() => handleGenerateFixedLatex(summary)} disabled={busy}>
                      Generate fixed LaTeX
                    </button>
                    <button className="secondary-button" onClick={() => handleConvertLatex(summary)} disabled={busy || !pandoc?.detected}>
                      Convert .tex with Pandoc
                    </button>
                    <button className="destructive-button" onClick={() => handleDeleteTemplate(summary)} disabled={busy}>
                      Delete
                    </button>
                  </div>
                  <div className="template-meta-grid">
                    <div>
                      <span>Fixed template</span>
                      <strong>{findAsset(summary, 'latex-fixed-template')?.path ?? '—'}</strong>
                    </div>
                    <div>
                      <span>Reference docx</span>
                      <strong>{findAsset(summary, 'render-reference-docx')?.path ?? '—'}</strong>
                    </div>
                  </div>
                  <div className="schema-role-grid">
                    <RoleCell label="题目字段" binding={summary.schema.semanticMapping.cover?.titleField ?? summary.schema.roles.title} />
                    <RoleCell label="姓名字段" binding={summary.schema.semanticMapping.cover?.authorField ?? summary.schema.roles.authors} />
                    <RoleCell label="学号字段" binding={summary.schema.semanticMapping.cover?.studentIdField} />
                    <RoleCell label="学院/系" binding={summary.schema.semanticMapping.cover?.schoolField} />
                    <RoleCell label="专业" binding={summary.schema.semanticMapping.cover?.majorField} />
                    <RoleCell label="导师" binding={summary.schema.semanticMapping.cover?.supervisorField} />
                    <RoleCell label="中文摘要" binding={summary.schema.semanticMapping.abstracts?.zh?.title} />
                    <RoleCell label="摘要正文" binding={summary.schema.semanticMapping.abstracts?.zh?.body ?? summary.schema.roles.abstract} />
                    <RoleCell label="关键词" binding={summary.schema.semanticMapping.abstracts?.zh?.keywords?.label ?? summary.schema.roles.keywords} />
                    <RoleCell label="目录" binding={summary.schema.semanticMapping.toc?.title} />
                    <RoleCell label="Heading 1" binding={summary.schema.semanticMapping.headings?.level1 ?? summary.schema.roles.heading1} />
                    <RoleCell label="Heading 2" binding={summary.schema.semanticMapping.headings?.level2 ?? summary.schema.roles.heading2} />
                    <RoleCell label="正文" binding={summary.schema.semanticMapping.body ?? summary.schema.roles.body} />
                    <RoleCell label="图题" binding={summary.schema.semanticMapping.captions?.figure ?? summary.schema.roles.figureCaption} />
                    <RoleCell label="表题" binding={summary.schema.semanticMapping.captions?.table ?? summary.schema.roles.tableCaption} />
                    <RoleCell label="参考文献" binding={summary.schema.semanticMapping.references?.title ?? summary.schema.roles.references} />
                    <RoleCell label="致谢" binding={summary.schema.semanticMapping.acknowledgement?.title} />
                  </div>
                  <div className="warnings-box">
                    <span>Warnings</span>
                    {(summary.schema.semanticMapping.warnings ?? []).length === 0 ? (
                      <strong>—</strong>
                    ) : (
                      <ul>
                        {summary.schema.semanticMapping.warnings?.map((warning) => <li key={warning}>{warning}</li>)}
                      </ul>
                    )}
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      </main>

      <footer className="footer-bar">{message}</footer>
    </div>
  );
}

function RoleCell({ label, binding }: { label: string; binding?: TemplateRoleBinding }) {
  const evidence = binding?.evidence?.slice(0, 2).join(' · ');
  return (
    <div>
      <span>
        {label}
        {typeof binding?.confidence === 'number' ? ` · ${(binding.confidence * 100).toFixed(0)}%` : ''}
      </span>
      <strong>{binding?.sampleText ?? '—'}</strong>
      {evidence ? <small>{evidence}</small> : null}
    </div>
  );
}

function findAsset(summary: ImportedTemplateSummary, kind: ImportedTemplateSummary['assets'][number]['kind']) {
  return summary.assets.find((asset) => asset.kind === kind && asset.version === summary.template.version);
}
