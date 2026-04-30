import type { AppBootstrapResult, AppPaths, UserSettings } from '../../../../packages/shared/src/index.js';
import * as coreModule from '../../../../packages/core/src/index.js';
import * as dbModule from '../../../../packages/db/src/index.js';

export interface RuntimeContext {
  paths: AppPaths;
  settings: UserSettings;
  database: dbModule.DatabaseContext;
  jobRunner: InstanceType<typeof coreModule.JobRunner>;
}

export async function bootstrapRuntime(userDataDir: string): Promise<{ runtime: RuntimeContext; result: AppBootstrapResult }> {
  const paths = await coreModule.ensureAppPaths(userDataDir);
  const settings = await coreModule.loadOrCreateSettings(userDataDir);
  const database = await dbModule.initializeDatabase(paths, settings);
  const tools = await coreModule.detectTools(settings);
  const jobRunner = new coreModule.JobRunner(paths);

  return {
    runtime: {
      paths,
      settings,
      database,
      jobRunner,
    },
    result: {
      paths,
      settings,
      tools,
    },
  };
}
