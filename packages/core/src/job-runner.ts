import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppPaths, ConversionJob, QueueJobRequest, QueueJobResult } from '../../shared/src/index.js';

export class JobRunner {
  private readonly jobs = new Map<string, ConversionJob>();

  constructor(private readonly paths: AppPaths) {}

  async enqueue(request: QueueJobRequest): Promise<QueueJobResult> {
    const id = randomUUID();
    const workingDirectory = join(this.paths.jobsDir, id);
    await mkdir(workingDirectory, { recursive: true });

    const job: ConversionJob = {
      id,
      templateId: request.templateId,
      schemaVersionId: undefined,
      templateVersion: undefined,
      stage: request.stage,
      status: 'queued',
      inputPath: request.inputPath,
      workingDirectory,
      createdAt: new Date().toISOString(),
      toolVersions: {},
    };

    this.jobs.set(id, job);
    return { job };
  }

  markRunning(jobId: string): ConversionJob {
    const job = this.require(jobId);
    const next: ConversionJob = {
      ...job,
      status: 'running',
      startedAt: job.startedAt ?? new Date().toISOString(),
      errorMessage: undefined,
    };
    this.jobs.set(jobId, next);
    return next;
  }

  markSucceeded(jobId: string): ConversionJob {
    const job = this.require(jobId);
    const next: ConversionJob = {
      ...job,
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
      errorMessage: undefined,
    };
    this.jobs.set(jobId, next);
    return next;
  }

  markFailed(jobId: string, errorMessage: string): ConversionJob {
    const job = this.require(jobId);
    const next: ConversionJob = {
      ...job,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      errorMessage,
    };
    this.jobs.set(jobId, next);
    return next;
  }

  setToolVersion(jobId: string, toolName: keyof ConversionJob['toolVersions'], version: string | undefined): ConversionJob {
    const job = this.require(jobId);
    const next: ConversionJob = {
      ...job,
      toolVersions: {
        ...job.toolVersions,
        [toolName]: version,
      },
    };
    this.jobs.set(jobId, next);
    return next;
  }

  list(): ConversionJob[] {
    return Array.from(this.jobs.values()).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  get(jobId: string): ConversionJob | undefined {
    return this.jobs.get(jobId);
  }

  private require(jobId: string): ConversionJob {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found.`);
    }
    return job;
  }
}
