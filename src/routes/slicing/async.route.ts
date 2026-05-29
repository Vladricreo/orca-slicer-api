import { Router } from "express";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import archiver from "archiver";
import { uploadFullPrint } from "../../middleware/upload";
import { AppError } from "../../middleware/error";
import type {
  SliceMetaData,
  SlicingSettings,
  UploadedProfiles,
} from "./models";
import { getMetaDataFromFile, sliceModel } from "./slicing.service";
import { generateMetaDataHeaders } from "./helpers";

type SliceJobStatus = "pending" | "processing" | "completed" | "failed";

interface SliceJob {
  id: string;
  status: SliceJobStatus;
  createdAt: string;
  updatedAt: string;
  // Nomi dei file di risultato salvati sotto <jobDir>/results
  resultFiles?: string[];
  metadata?: SliceMetaData;
  errorMessage?: string;
}

const router = Router();

// Gli ID validi sono UUID: serve anche a evitare path traversal sui percorsi su disco.
const JOB_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertValidJobId(id: string): void {
  if (!JOB_ID_REGEX.test(id)) {
    throw new AppError(400, "Invalid slice request id");
  }
}

const DEFAULT_JOB_RETENTION_MS = 60 * 60 * 1000; // 60 minutes
const parsedJobRetentionMs = Number(
  process.env.ASYNC_SLICE_RETENTION_MS ?? DEFAULT_JOB_RETENTION_MS.toString(),
);
const jobRetentionMs = Number.isNaN(parsedJobRetentionMs)
  ? DEFAULT_JOB_RETENTION_MS
  : parsedJobRetentionMs;

// I job sono persistiti su disco dentro il volume DATA_PATH, così sopravvivono
// a riavvii e redeploy del container (la vecchia Map in memoria li perdeva).
function getJobsBaseDir(): string {
  const basePath = process.env.DATA_PATH || path.join(process.cwd(), "data");
  return path.join(basePath, "jobs");
}

function getJobDir(id: string): string {
  return path.join(getJobsBaseDir(), id);
}

function getResultsDir(id: string): string {
  return path.join(getJobDir(id), "results");
}

function getJobFilePath(id: string): string {
  return path.join(getJobDir(id), "job.json");
}

async function writeJob(job: SliceJob): Promise<void> {
  const dir = getJobDir(job.id);
  await fs.mkdir(dir, { recursive: true });
  const filePath = getJobFilePath(job.id);
  // Scrittura atomica: scrivo su file temporaneo e poi rename, per evitare
  // letture di un job.json scritto a metà durante il polling.
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(job, null, 2), "utf-8");
  await fs.rename(tmpPath, filePath);
}

async function readJob(id: string): Promise<SliceJob | null> {
  try {
    const content = await fs.readFile(getJobFilePath(id), "utf-8");
    return JSON.parse(content) as SliceJob;
  } catch {
    return null;
  }
}

async function updateJob(
  id: string,
  update: Partial<SliceJob>,
): Promise<SliceJob | null> {
  const current = await readJob(id);
  if (!current) {
    return null;
  }

  const updated: SliceJob = {
    ...current,
    ...update,
    updatedAt: new Date().toISOString(),
  };
  await writeJob(updated);
  return updated;
}

async function listJobs(): Promise<SliceJob[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(getJobsBaseDir());
  } catch {
    return [];
  }

  const jobs: SliceJob[] = [];
  for (const entry of entries) {
    const job = await readJob(entry);
    if (job) {
      jobs.push(job);
    }
  }
  return jobs;
}

// Lo sweep gira spesso così la retention (default 60 min) viene rispettata
// con buona precisione, invece di rimuovere i job fino a un'ora dopo la scadenza.
const cleanupIntervalTimeMs = 5 * 60 * 1000; // 5 minutes
const cleanupInterval = setInterval(() => {
  void deleteFinishedJobs();
}, cleanupIntervalTimeMs);
cleanupInterval.unref();

// Pulizia iniziale all'avvio, per smaltire i job già scaduti dopo un riavvio.
void deleteFinishedJobs();

// All'avvio i job rimasti "pending"/"processing" appartengono a uno slicing
// interrotto da un riavvio: non possono riprendere, quindi li marchiamo come
// falliti invece di lasciarli appesi.
void markInterruptedJobsAsFailed();

router.post(
  "/",
  uploadFullPrint.fields([
    { name: "file", maxCount: 1 },
    { name: "printerProfile", maxCount: 1 },
    { name: "presetProfile", maxCount: 1 },
    { name: "filamentProfile", maxCount: 1 },
  ]),
  async (req, res) => {
    if (!req.files || Array.isArray(req.files)) {
      throw new AppError(
        400,
        "Invalid file upload format: files must be uploaded as named fields",
      );
    }

    const files = req.files as { [fieldname: string]: Express.Multer.File[] };

    if (!files["file"]) {
      throw new AppError(400, "Model file is required for slicing");
    }

    const requestId = randomUUID();
    const now = new Date().toISOString();
    const job: SliceJob = {
      id: requestId,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    await writeJob(job);

    const modelFile = files["file"][0];
    const settings = req.body as SlicingSettings;
    const tempProfiles = {
      printer: files["printerProfile"]?.[0]?.buffer,
      preset: files["presetProfile"]?.[0]?.buffer,
      filament: files["filamentProfile"]?.[0]?.buffer,
    } as UploadedProfiles;

    void processSliceJob(requestId, modelFile, settings, tempProfiles);

    res.status(202).json({
      requestId,
      status: job.status,
      statusUrl: `${req.baseUrl}/${requestId}`,
    });
  },
);

router.get("/:requestId", async (req, res) => {
  assertValidJobId(req.params.requestId);
  const job = await readJob(req.params.requestId);

  if (!job) {
    throw new AppError(404, "Slice request not found");
  }

  if (job.status === "pending" || job.status === "processing") {
    res.status(200).json({
      requestId: job.id,
      status: job.status,
    });
    return;
  }

  if (job.status === "failed") {
    res.status(200).json({
      requestId: job.id,
      status: job.status,
      message: job.errorMessage ?? "Failed to slice the model",
    });
    return;
  }

  if (!job.resultFiles || job.resultFiles.length === 0 || !job.metadata) {
    throw new AppError(500, "Completed slice job is missing result files");
  }

  return res.status(200).json({
    requestId: job.id,
    status: job.status,
    metadata: job.metadata,
    downloadUrl: `${req.baseUrl}/${job.id}/result`,
  });
});

router.get("/:requestId/result", async (req, res) => {
  assertValidJobId(req.params.requestId);
  const job = await readJob(req.params.requestId);

  if (!job) {
    throw new AppError(404, "Slice request not found");
  }

  if (job.status !== "completed") {
    res.status(400).json({
      message: "Slice job is not completed yet",
    });
    return;
  }

  if (!job.resultFiles || job.resultFiles.length === 0 || !job.metadata) {
    throw new AppError(500, "Completed slice job is missing result files");
  }

  res.set(generateMetaDataHeaders(job.metadata));

  const resultsDir = getResultsDir(job.id);

  if (job.resultFiles.length === 1) {
    res.download(path.join(resultsDir, job.resultFiles[0]));
    return;
  }

  res.attachment("result.zip");
  const archive = archiver("zip", { zlib: { level: 9 } });

  archive.on("error", (err) => {
    throw new AppError(500, `Error creating archive: ${err.message}`);
  });

  archive.pipe(res);
  job.resultFiles.forEach((fileName) => {
    archive.file(path.join(resultsDir, fileName), { name: fileName });
  });

  await archive.finalize();
});

router.delete("/:requestId", async (req, res) => {
  assertValidJobId(req.params.requestId);
  const job = await readJob(req.params.requestId);

  if (!job) {
    throw new AppError(404, "Slice request not found");
  }

  if (job.status === "pending" || job.status === "processing") {
    throw new AppError(
      400,
      "Cannot delete a slice job that is still in progress",
    );
  }

  await cleanupJob(job.id);

  res.status(204).send();
});

async function processSliceJob(
  requestId: string,
  modelFile: Express.Multer.File,
  settings: SlicingSettings,
  tempProfiles: UploadedProfiles,
) {
  const job = await updateJob(requestId, { status: "processing" });
  if (!job) {
    return;
  }

  let workdir: string | undefined;
  try {
    const result = await sliceModel(
      modelFile.buffer,
      modelFile.originalname,
      settings,
      tempProfiles,
    );
    workdir = result.workdir;
    const { gcodes } = result;

    if (gcodes.length === 0) {
      throw new AppError(500, "No files generated during slicing");
    }

    // Copia i risultati dalla workdir temporanea (/tmp) nel volume persistente.
    const resultsDir = getResultsDir(requestId);
    await fs.mkdir(resultsDir, { recursive: true });

    const resultFiles: string[] = [];
    for (const gcodePath of gcodes) {
      const fileName = path.basename(gcodePath);
      await fs.copyFile(gcodePath, path.join(resultsDir, fileName));
      resultFiles.push(fileName);
    }

    const metadata = await aggregateMetaData(gcodes);

    await updateJob(requestId, {
      status: "completed",
      resultFiles,
      metadata,
      errorMessage: undefined,
    });
  } catch (error) {
    await updateJob(requestId, {
      status: "failed",
      errorMessage:
        error instanceof AppError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Failed to slice the model",
    });
  } finally {
    // I risultati sono già copiati nel volume: la workdir temporanea può andare.
    if (workdir) {
      await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function aggregateMetaData(gcodes: string[]): Promise<SliceMetaData> {
  const metadata: SliceMetaData = {
    printTime: 0,
    filamentUsedG: 0,
    filamentUsedMm: 0,
  };

  for (const filePath of gcodes) {
    const fileMetadata = await getMetaDataFromFile(filePath);
    metadata.printTime += fileMetadata.printTime;
    metadata.filamentUsedG += fileMetadata.filamentUsedG;
    metadata.filamentUsedMm += fileMetadata.filamentUsedMm;
  }

  return metadata;
}

async function cleanupJob(requestId: string) {
  await fs.rm(getJobDir(requestId), { recursive: true, force: true });
}

async function deleteFinishedJobs() {
  const now = Date.now();
  const jobs = await listJobs();
  const jobsToClean = jobs.filter((job) => {
    if (job.status !== "completed" && job.status !== "failed") {
      return false;
    }

    const updatedAt = Date.parse(job.updatedAt);
    if (now - updatedAt < jobRetentionMs) {
      return false;
    }

    return true;
  });

  for (const job of jobsToClean) {
    await cleanupJob(job.id);
  }
}

async function markInterruptedJobsAsFailed() {
  const jobs = await listJobs();
  for (const job of jobs) {
    if (job.status === "pending" || job.status === "processing") {
      await updateJob(job.id, {
        status: "failed",
        errorMessage: "Slice job was interrupted by a server restart",
      });
    }
  }
}

export default router;
