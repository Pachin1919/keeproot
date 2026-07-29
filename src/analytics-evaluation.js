import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isPathInside } from './paths.js';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertSafeName(value, label) {
  if (!value || !SAFE_NAME.test(value)) {
    throw new Error(`${label} must use 1-80 letters, numbers, dot, underscore, or hyphen.`);
  }
}

export function locateAnalyticsPython({ installationRoot, configuredPath = process.env.ATLAS_PYTHON } = {}) {
  const candidates = [
    configuredPath,
    installationRoot && path.join(installationRoot, 'python', 'venv', 'Scripts', 'python.exe'),
    installationRoot && path.join(installationRoot, 'python', 'venv', 'bin', 'python'),
  ].filter(Boolean).map((item) => path.resolve(item));
  return candidates.find((item) => {
    try {
      return fs.lstatSync(item).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

function readEvaluation(outputDir) {
  const manifestPath = path.join(outputDir, 'manifest.json');
  const gapsPath = path.join(outputDir, 'measurement-gaps.json');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(gapsPath)) {
    throw new Error(`Analytics evaluation is incomplete: ${path.basename(outputDir)}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.evaluation_schema !== 'atlas.analytics.evaluation.v1') {
    throw new Error(`Unsupported analytics evaluation schema: ${manifest.evaluation_schema}`);
  }
  for (const [filename, detail] of Object.entries(manifest.files ?? {})) {
    const filePath = path.resolve(outputDir, filename);
    if (path.dirname(filePath) !== path.resolve(outputDir) || !fs.existsSync(filePath)) {
      throw new Error(`Analytics evaluation file is missing or escapes its directory: ${filename}`);
    }
    if (!detail.sha256 || sha256File(filePath) !== detail.sha256) {
      throw new Error(`Analytics evaluation file does not match its manifest Hash: ${filename}`);
    }
  }
  const measurementGaps = JSON.parse(fs.readFileSync(gapsPath, 'utf8'));
  const qualityPath = path.join(outputDir, 'quality.json');
  const quality = fs.existsSync(qualityPath) ? JSON.parse(fs.readFileSync(qualityPath, 'utf8')) : null;
  const metricsPath = path.join(outputDir, 'metrics.json');
  const metrics = fs.existsSync(metricsPath) ? JSON.parse(fs.readFileSync(metricsPath, 'utf8')) : null;
  const anomaliesPath = path.join(outputDir, 'anomalies.jsonl');
  const anomalies = fs.existsSync(anomaliesPath)
    ? fs.readFileSync(anomaliesPath, 'utf8').split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    : [];
  return {
    manifest, measurementGaps, quality, metrics, anomalies,
  };
}

export function evaluateAnalytics({
  stateDir: stateDirInput,
  projectRoot,
  installationRoot,
  exportName,
  evaluationName = null,
  pythonPath = null,
} = {}) {
  assertSafeName(exportName, 'Analytics export name');
  const stateDir = path.resolve(stateDirInput);
  const exportsRoot = path.join(stateDir, 'analytics', 'exports');
  const exportDir = path.join(exportsRoot, exportName);
  if (!isPathInside(exportsRoot, exportDir) || !fs.existsSync(path.join(exportDir, 'manifest.json'))) {
    throw new Error(`Analytics export does not exist: ${exportName}`);
  }

  const evaluationId = evaluationName
    ?? `EVAL-${new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14)}`;
  assertSafeName(evaluationId, 'Analytics evaluation name');
  const evaluationsRoot = path.join(stateDir, 'analytics', 'evaluations');
  const outputDir = path.join(evaluationsRoot, evaluationId);
  if (!isPathInside(evaluationsRoot, outputDir)) {
    throw new Error('Analytics evaluation path escapes its state directory.');
  }
  if (fs.existsSync(outputDir)) throw new Error(`Analytics evaluation already exists: ${evaluationId}`);

  const executable = pythonPath ?? locateAnalyticsPython({ installationRoot });
  if (!executable) {
    const error = new Error(
      'Atlas analytics Python component is unavailable. Configure ATLAS_PYTHON or install the analytics component.',
    );
    error.code = 'ATLAS_CAPABILITY_UNAVAILABLE';
    throw error;
  }
  const pythonSourceRoot = path.join(projectRoot, 'python', 'src');
  if (!fs.existsSync(path.join(pythonSourceRoot, 'atlas_analytics', '__main__.py'))) {
    throw new Error('Atlas analytics Python source is missing from the Runtime.');
  }

  const stageParent = path.join(stateDir, 'tmp');
  const stageDir = path.join(stageParent, `analytics-evaluation-${crypto.randomUUID()}`);
  fs.mkdirSync(stageParent, { recursive: true });
  fs.mkdirSync(evaluationsRoot, { recursive: true });
  try {
    const result = spawnSync(executable, [
      '-m',
      'atlas_analytics',
      'evaluate',
      exportDir,
      '--output-dir',
      stageDir,
      '--evaluation-id',
      evaluationId,
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PYTHONPATH: [
          pythonSourceRoot,
          process.env.PYTHONPATH,
        ].filter(Boolean).join(path.delimiter),
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `Atlas analytics evaluator failed: ${result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`}`,
      );
    }
    const pythonReceipt = JSON.parse(result.stdout.trim());
    const {
      manifest, measurementGaps, quality, metrics, anomalies,
    } = readEvaluation(stageDir);
    if (manifest.evaluation_id !== evaluationId
        || pythonReceipt.measurement_gaps_hash !== manifest.measurement_gaps_hash
        || (manifest.metrics_hash && pythonReceipt.metrics_hash !== manifest.metrics_hash)) {
      throw new Error('Atlas analytics evaluator returned an inconsistent receipt.');
    }
    fs.renameSync(stageDir, outputDir);
    return {
      evaluation_id: evaluationId,
      status: manifest.status,
      complete: manifest.complete,
      output_dir: outputDir,
      source_export: exportName,
      source_content_hash: manifest.source_export.content_hash,
      measurement_gaps_hash: manifest.measurement_gaps_hash,
      quality_hash: manifest.quality_hash ?? null,
      quality_status: quality?.status ?? null,
      fact_counts: quality?.fact_counts ?? null,
      metrics_hash: manifest.metrics_hash ?? null,
      metric_count: metrics?.metrics?.length ?? 0,
      anomaly_count: anomalies.length,
      report_path: manifest.files?.['report.md'] ? path.join(outputDir, 'report.md') : null,
      availability_counts: measurementGaps.availability_counts,
    };
  } catch (error) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }
}

export function showAnalyticsEvaluation({ stateDir: stateDirInput, evaluationId } = {}) {
  assertSafeName(evaluationId, 'Analytics evaluation ID');
  const stateDir = path.resolve(stateDirInput);
  const evaluationsRoot = path.join(stateDir, 'analytics', 'evaluations');
  const outputDir = path.join(evaluationsRoot, evaluationId);
  if (!isPathInside(evaluationsRoot, outputDir) || !fs.existsSync(outputDir)) {
    throw new Error(`Analytics evaluation not found: ${evaluationId}`);
  }
  const {
    manifest, measurementGaps, quality, metrics, anomalies,
  } = readEvaluation(outputDir);
  return {
    evaluation_id: evaluationId,
    status: manifest.status,
    complete: manifest.complete,
    source_export: manifest.source_export,
    measurement_gaps_hash: manifest.measurement_gaps_hash,
    quality_hash: manifest.quality_hash ?? null,
    metrics_hash: manifest.metrics_hash ?? null,
    quality: quality ? {
      status: quality.status,
      critical_errors: quality.critical_errors,
      warnings: quality.warnings,
      fact_counts: quality.fact_counts,
      checks: quality.checks,
    } : null,
    availability_counts: measurementGaps.availability_counts,
    measurement_candidates: measurementGaps.metrics,
    official_metrics: metrics?.metrics ?? [],
    anomalies,
    report_path: manifest.files?.['report.md'] ? path.join(outputDir, 'report.md') : null,
    analysis_context_path: manifest.files?.['analysis_context.md']
      ? path.join(outputDir, 'analysis_context.md')
      : null,
    pandas_version: manifest.pandas_version ?? null,
    pandas_cross_check: manifest.pandas_cross_check ?? null,
    next_required: manifest.next_required,
  };
}
