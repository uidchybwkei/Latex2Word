/// <reference path="./sqljs.d.ts" />

import { readFile, rm, writeFile } from 'node:fs/promises';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import type {
  AppPaths,
  ImportedTemplateSummary,
  SchemaVersion,
  Template,
  TemplateAsset,
  TemplateSchemaDraft,
  UserSettings,
} from '../../shared/src/index.js';

export interface DatabaseContext {
  db: SqlJsDatabase;
  persist: () => Promise<void>;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    version INTEGER NOT NULL,
    active_schema_version_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schema_versions (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS template_assets (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    template_id TEXT,
    schema_version_id TEXT,
    template_version INTEGER,
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
    input_path TEXT,
    working_directory TEXT NOT NULL,
    error_message TEXT,
    tool_versions_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS issues (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    expected TEXT,
    actual TEXT,
    location TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_review_summaries (
    id TEXT PRIMARY KEY,
    job_id TEXT,
    template_id TEXT,
    task TEXT NOT NULL,
    model TEXT NOT NULL,
    summary TEXT NOT NULL,
    confidence REAL,
    prompt_digest TEXT,
    created_at TEXT NOT NULL
  );
`;

let sqlJsPromise: Promise<SqlJsStatic> | undefined;

function mapExecRows<T extends object>(db: SqlJsDatabase, sql: string, params: unknown[] = []): T[] {
  const [result] = db.exec(sql, params);
  if (!result) {
    return [];
  }

  return result.values.map((valueRow) => {
    const rowEntries = result.columns.map((column, index) => [column, valueRow[index]]);
    return Object.fromEntries(rowEntries) as T;
  });
}

function loadSqlJs(): Promise<SqlJsStatic> {
  const existingPromise = sqlJsPromise;
  if (existingPromise) {
    return existingPromise;
  }

  const createdPromise = initSqlJs({});
  sqlJsPromise = createdPromise;
  return createdPromise;
}

async function loadDatabaseFile(path: string): Promise<Uint8Array | undefined> {
  try {
    const file = await readFile(path);
    return new Uint8Array(file);
  } catch {
    return undefined;
  }
}

export async function initializeDatabase(paths: AppPaths, settings: UserSettings): Promise<DatabaseContext> {
  const SQL = await loadSqlJs();
  const fileBuffer = await loadDatabaseFile(paths.databasePath);
  const db = fileBuffer ? new SQL.Database(fileBuffer) : new SQL.Database();

  db.run(SCHEMA_SQL);
  db.run(
    `
      INSERT INTO settings (id, json, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        json = excluded.json,
        updated_at = excluded.updated_at
    `,
    [JSON.stringify(settings), settings.updatedAt],
  );

  const persist = async (): Promise<void> => {
    const data = db.export();
    await writeFile(paths.databasePath, Buffer.from(data));
  };

  await persist();

  return {
    db,
    persist,
  };
}

export async function saveImportedTemplate(context: DatabaseContext, summary: ImportedTemplateSummary): Promise<void> {
  const { template, schemaVersion, assets } = summary;

  context.db.run(
    `
      INSERT INTO templates (id, name, status, version, active_schema_version_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        status = excluded.status,
        version = excluded.version,
        active_schema_version_id = excluded.active_schema_version_id,
        updated_at = excluded.updated_at
    `,
    [
      template.id,
      template.name,
      template.status,
      template.version,
      template.activeSchemaVersionId ?? null,
      template.createdAt,
      template.updatedAt,
    ],
  );

  context.db.run(
    `
      INSERT INTO schema_versions (id, template_id, version, path, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        version = excluded.version,
        path = excluded.path,
        sha256 = excluded.sha256,
        created_at = excluded.created_at
    `,
    [
      schemaVersion.id,
      schemaVersion.templateId,
      schemaVersion.version,
      schemaVersion.path,
      schemaVersion.sha256,
      schemaVersion.createdAt,
    ],
  );

  for (const asset of assets) {
    context.db.run(
      `
        INSERT INTO template_assets (id, template_id, kind, path, sha256, version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          path = excluded.path,
          sha256 = excluded.sha256,
          version = excluded.version,
          created_at = excluded.created_at
      `,
      [asset.id, asset.templateId, asset.kind, asset.path, asset.sha256, asset.version, asset.createdAt],
    );
  }

  await context.persist();
}

export async function saveTemplateAsset(context: DatabaseContext, asset: TemplateAsset): Promise<void> {
  context.db.run(
    `
      INSERT INTO template_assets (id, template_id, kind, path, sha256, version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        path = excluded.path,
        sha256 = excluded.sha256,
        version = excluded.version,
        created_at = excluded.created_at
    `,
    [asset.id, asset.templateId, asset.kind, asset.path, asset.sha256, asset.version, asset.createdAt],
  );

  await context.persist();
}

async function safeDeleteFile(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // Best-effort cleanup. Missing files should not block record deletion.
  }
}

interface TemplateRow {
  id: string;
  name: string;
  status: Template['status'];
  version: number;
  active_schema_version_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SchemaVersionRow {
  id: string;
  template_id: string;
  version: number;
  path: string;
  sha256: string;
  created_at: string;
}

interface TemplateAssetRow {
  id: string;
  template_id: string;
  kind: TemplateAsset['kind'];
  path: string;
  sha256: string;
  version: number;
  created_at: string;
}

function mapTemplate(row: TemplateRow): Template {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    version: Number(row.version),
    activeSchemaVersionId: row.active_schema_version_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSchemaVersion(row: SchemaVersionRow): SchemaVersion {
  return {
    id: row.id,
    templateId: row.template_id,
    version: Number(row.version),
    path: row.path,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

function mapTemplateAsset(row: TemplateAssetRow): TemplateAsset {
  return {
    id: row.id,
    templateId: row.template_id,
    kind: row.kind,
    path: row.path,
    sha256: row.sha256,
    version: Number(row.version),
    createdAt: row.created_at,
  };
}

export async function listImportedTemplates(context: DatabaseContext): Promise<ImportedTemplateSummary[]> {
  const templateRows = mapExecRows<TemplateRow>(
    context.db,
    `
      SELECT id, name, status, version, active_schema_version_id, created_at, updated_at
      FROM templates
      ORDER BY updated_at DESC
    `,
  );

  const summaries: ImportedTemplateSummary[] = [];

  for (const templateRow of templateRows) {
    const template = mapTemplate(templateRow);
    const schemaVersionRow = mapExecRows<SchemaVersionRow>(
      context.db,
      `
        SELECT id, template_id, version, path, sha256, created_at
        FROM schema_versions
        WHERE template_id = ?
        ORDER BY version DESC
        LIMIT 1
      `,
      [template.id],
    )[0];

    if (!schemaVersionRow) {
      continue;
    }

    const assetRows = mapExecRows<TemplateAssetRow>(
      context.db,
      `
        SELECT id, template_id, kind, path, sha256, version, created_at
        FROM template_assets
        WHERE template_id = ?
        ORDER BY created_at ASC
      `,
      [template.id],
    );

    const schemaRaw = await readFile(schemaVersionRow.path, 'utf8');
    const schema = JSON.parse(schemaRaw) as TemplateSchemaDraft;

    summaries.push({
      template,
      assets: assetRows.map(mapTemplateAsset),
      schemaVersion: mapSchemaVersion(schemaVersionRow),
      schema,
    });
  }

  return summaries;
}

export async function deleteImportedTemplate(context: DatabaseContext, templateId: string): Promise<void> {
  const schemaVersionRows = mapExecRows<SchemaVersionRow>(
    context.db,
    `
      SELECT id, template_id, version, path, sha256, created_at
      FROM schema_versions
      WHERE template_id = ?
    `,
    [templateId],
  );

  const assetRows = mapExecRows<TemplateAssetRow>(
    context.db,
    `
      SELECT id, template_id, kind, path, sha256, version, created_at
      FROM template_assets
      WHERE template_id = ?
    `,
    [templateId],
  );

  context.db.run('DELETE FROM issues WHERE job_id IN (SELECT id FROM jobs WHERE template_id = ?)', [templateId]);
  context.db.run('DELETE FROM ai_review_summaries WHERE template_id = ?', [templateId]);
  context.db.run('DELETE FROM jobs WHERE template_id = ?', [templateId]);
  context.db.run('DELETE FROM template_assets WHERE template_id = ?', [templateId]);
  context.db.run('DELETE FROM schema_versions WHERE template_id = ?', [templateId]);
  context.db.run('DELETE FROM templates WHERE id = ?', [templateId]);

  await context.persist();

  await Promise.all([
    ...schemaVersionRows.map((row) => safeDeleteFile(row.path)),
    ...assetRows.map((row) => safeDeleteFile(row.path)),
  ]);
}

export async function clearImportedTemplateHistory(context: DatabaseContext): Promise<void> {
  const templateRows = mapExecRows<TemplateRow>(
    context.db,
    `
      SELECT id, name, status, version, active_schema_version_id, created_at, updated_at
      FROM templates
    `,
  );

  for (const templateRow of templateRows) {
    await deleteImportedTemplate(context, templateRow.id);
  }
}
