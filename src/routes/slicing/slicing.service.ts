import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { AppError } from "../../middleware/error";
import type {
  SlicingSettings,
  SliceResult,
  SliceMetaData,
  UploadedProfiles,
} from "./models";
import { Open } from "unzipper";

export async function sliceModel(
  file: Buffer,
  filename: string,
  settings: SlicingSettings,
  tempProfiles?: UploadedProfiles,
): Promise<SliceResult> {
  let workdir: string;
  let inPath: string;
  let inputDir: string;
  let outputDir: string;
  try {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), "slice-"));
    inputDir = path.join(workdir, "input");
    outputDir = path.join(workdir, "output");
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });

    inPath = path.join(inputDir, filename);
    await fs.writeFile(inPath, file);

    if (tempProfiles) {
      await writeTempProfiles(tempProfiles, inputDir);
    }
  } catch (error) {
    throw new AppError(
      500,
      "Failed to prepare slicing",
      error instanceof Error ? error.message : String(error),
    );
  }

  const basePath = process.env.DATA_PATH || path.join(process.cwd(), "data");

  const args: string[] = [];

  if (settings.exportType === "3mf") {
    args.push("--export-3mf", "result.3mf");
  }

  const sliceArg = settings.plate === undefined ? "1" : settings.plate;
  args.push("--slice", sliceArg);

  if (settings.arrange !== undefined) {
    args.push("--arrange", settings.arrange ? "1" : "0");
  }

  if (settings.orient !== undefined) {
    args.push("--orient", settings.orient ? "1" : "0");
  }

  // I campi multi-nozzle arrivano come stringhe (multipart/form-data): li
  // normalizziamo in array/numeri prima di costruire gli argomenti CLI.
  const filamentMap = parseNumberArray(
    (settings as Record<string, unknown>).filamentMap,
  );
  const filamentMapModeRaw = (settings as Record<string, unknown>)
    .filamentMapMode;
  const filamentMapMode =
    typeof filamentMapModeRaw === "string" && filamentMapModeRaw.trim()
      ? filamentMapModeRaw.trim()
      : undefined;
  const filamentIds = parseNumberArray(
    (settings as Record<string, unknown>).filamentIds,
  );
  const filamentNames = parseStringArray(
    (settings as Record<string, unknown>).filaments,
  );

  // Percorso del profilo processo (preset): potrebbe dover essere riscritto
  // per iniettare filament_map / filament_map_mode.
  let printerSettingsPath: string | undefined;
  let processSettingsPath: string | undefined;

  if (tempProfiles?.printer && tempProfiles?.preset) {
    printerSettingsPath = `${inputDir}/printer.json`;
    processSettingsPath = `${inputDir}/preset.json`;
  } else if (settings.printer && settings.preset) {
    printerSettingsPath = `${basePath}/printers/${settings.printer}.json`;
    processSettingsPath = `${basePath}/presets/${settings.preset}.json`;
  }

  if (processSettingsPath && (filamentMap?.length || filamentMapMode)) {
    try {
      processSettingsPath = await injectFilamentMap(
        processSettingsPath,
        inputDir,
        filamentMap,
        filamentMapMode,
      );
    } catch (error) {
      await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
      throw new AppError(
        500,
        "Failed to apply filament map settings",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (printerSettingsPath && processSettingsPath) {
    args.push(
      "--load-settings",
      `${printerSettingsPath};${processSettingsPath}`,
    );
  }

  // Risoluzione dei filamenti: i profili multipli (multi-nozzle) hanno la
  // precedenza sul singolo filamento, sia per gli upload al volo che per i
  // profili salvati su disco.
  const filamentPaths: string[] = [];
  if (tempProfiles?.filaments && tempProfiles.filaments.length > 0) {
    tempProfiles.filaments.forEach((_, index) => {
      filamentPaths.push(`${inputDir}/filament-${index}.json`);
    });
  } else if (tempProfiles?.filament) {
    filamentPaths.push(`${inputDir}/filament.json`);
  } else if (filamentNames && filamentNames.length > 0) {
    for (const name of filamentNames) {
      filamentPaths.push(`${basePath}/filaments/${name}.json`);
    }
  } else if (settings.filament) {
    filamentPaths.push(`${basePath}/filaments/${settings.filament}.json`);
  }

  if (filamentPaths.length > 0) {
    args.push("--load-filaments", filamentPaths.join(";"));
  }

  if (filamentIds && filamentIds.length > 0) {
    args.push("--load-filament-ids", filamentIds.join(","));
  }

  if (settings.bedType) {
    args.push("--curr-bed-type", settings.bedType);
  }

  if (settings.multicolorOnePlate) {
    args.push("--allow-multicolor-oneplate");
  }

  args.push("--allow-newer-file");
  args.push("--outputdir", outputDir);

  args.push(inPath);

  if (!process.env.ORCASLICER_PATH) {
    throw new AppError(
      500,
      "Slicing is not configured properly on the server",
      "ORCASLICER_PATH environment variable is not defined",
    );
  }

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.env.ORCASLICER_PATH as string,
        args,
        {
          encoding: "utf-8",
        },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        },
      );
    });
  } catch (err) {
    const resultJsonPath = path.join(outputDir, "result.json");
    let json;
    try {
      const content = await fs.readFile(resultJsonPath, "utf-8");
      json = JSON.parse(content);
    } catch {
      await fs.rm(workdir, { recursive: true, force: true });

      throw new AppError(
        500,
        "Failed to slice the model",
        err instanceof Error ? err.message : String(err),
      );
    }

    if (json?.error_string) {
      await fs.rm(workdir, { recursive: true, force: true });

      throw new AppError(
        500,
        `Slicing failed with error from slicer: ${json.error_string}`,
      );
    }

    await fs.rm(workdir, { recursive: true, force: true });

    throw new AppError(
      500,
      "Failed to slice the model",
      err instanceof Error ? err.message : String(err),
    );
  }

  const files = await fs.readdir(outputDir);
  let resultFiles: string[];

  if (settings.exportType === "3mf") {
    resultFiles = files
      .filter((f) => f.toLowerCase().endsWith(".3mf"))
      .map((f) => path.join(outputDir, f));
  } else {
    resultFiles = files
      .filter((f) => f.toLowerCase().endsWith(".gcode"))
      .map((f) => path.join(outputDir, f));
  }

  return { gcodes: resultFiles, workdir };
}

/**
 * Extract metadata (print time, filament used) from a G-code or 3MF file.
 * @param filePath The path to the file.
 * @returns The extracted metadata.
 */
export async function getMetaDataFromFile(
  filePath: string,
): Promise<SliceMetaData> {
  let data = {
    printTime: 0,
    filamentUsedG: 0,
    filamentUsedMm: 0,
  };

  if (filePath.endsWith(".gcode")) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      data = parseMetaDataFromString(content);
    } catch (error) {
      console.error(
        "Failed to read G-code file for metadata extraction:",
        error,
      );
    }
  } else if (filePath.endsWith(".3mf")) {
    try {
      const dir = await Open.file(filePath);
      for (const file of dir.files.filter((f) => f.path.endsWith(".gcode"))) {
        const content = (await file.buffer()).toString("utf-8");
        const metaData = parseMetaDataFromString(content);
        data.printTime += metaData.printTime;
        data.filamentUsedG += metaData.filamentUsedG;
        data.filamentUsedMm += metaData.filamentUsedMm;
      }
    } catch (error) {
      console.error("Failed to read 3MF file for metadata extraction:", error);
    }
  }

  return data;
}

function parseMetaDataFromString(content: string): SliceMetaData {
  const data: SliceMetaData = {
    printTime: 0,
    filamentUsedG: 0,
    filamentUsedMm: 0,
  };

  try {
    // Extract print time
    const timeIndex = content.indexOf("total estimated time");
    if (timeIndex !== -1) {
      const timeSlice = content.slice(timeIndex, timeIndex + 80);
      const timeMatch = timeSlice.match(
        /total estimated time:\s*((?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?)/i,
      );
      if (timeMatch) {
        const days = parseInt(timeMatch[2] || "0");
        const hours = parseInt(timeMatch[3] || "0");
        const minutes = parseInt(timeMatch[4] || "0");
        const seconds = parseInt(timeMatch[5] || "0");
        data.printTime = days * 86400 + hours * 3600 + minutes * 60 + seconds;
      }
    }

    if (timeIndex === -1) {
      const altTimeIndex = content.indexOf(
        "; estimated printing time (normal mode)",
      );
      if (altTimeIndex !== -1) {
        const timeSlice = content.slice(altTimeIndex, altTimeIndex + 100);
        const timeMatch = timeSlice.match(
          /; estimated printing time \(normal mode\) = \s*((?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?)/i,
        );
        if (timeMatch) {
          const days = parseInt(timeMatch[2] || "0");
          const hours = parseInt(timeMatch[3] || "0");
          const minutes = parseInt(timeMatch[4] || "0");
          const seconds = parseInt(timeMatch[5] || "0");
          data.printTime = days * 86400 + hours * 3600 + minutes * 60 + seconds;
        }
      }
    }

    // Extract filament used [mm]
    const filamentMmIndex = content.indexOf("; filament used [mm]");
    if (filamentMmIndex !== -1) {
      const filamentMmSlice = content.slice(
        filamentMmIndex,
        filamentMmIndex + 50,
      );
      const mmMatch = filamentMmSlice.match(
        /; filament used \[mm\] = \s*(\d+(\.\d+)?)/,
      );
      if (mmMatch) {
        data.filamentUsedMm = parseFloat(mmMatch[1]);
      }
    }

    // Extract filament used [g]
    const filamentGIndex = content.indexOf("; filament used [g]");
    if (filamentGIndex !== -1) {
      const filamentGSlice = content.slice(filamentGIndex, filamentGIndex + 50);
      const gMatch = filamentGSlice.match(
        /; filament used \[g\] = \s*(\d+(\.\d+)?)/,
      );
      if (gMatch) {
        data.filamentUsedG = parseFloat(gMatch[1]);
      }
    }
  } catch (err) {
    console.error("Failed to parse metadata from string:", err);
  }

  return data;
}

async function writeTempProfiles(
  profiles: UploadedProfiles,
  inputDir: string,
): Promise<void> {
  try {
    const printerPath = path.join(inputDir, "printer.json");
    const presetPath = path.join(inputDir, "preset.json");
    const filamentPath = path.join(inputDir, "filament.json");

    const writes: Promise<void>[] = [];

    if (profiles.printer && profiles.printer.length > 0) {
      writes.push(fs.writeFile(printerPath, profiles.printer));
    }
    if (profiles.preset && profiles.preset.length > 0) {
      writes.push(fs.writeFile(presetPath, profiles.preset));
    }

    // Multi-nozzle: scrive un file per ogni filamento (filament-0.json, ...).
    // Altrimenti, retrocompatibilità con il singolo filament.json.
    if (profiles.filaments && profiles.filaments.length > 0) {
      profiles.filaments.forEach((buffer, index) => {
        if (buffer && buffer.length > 0) {
          writes.push(
            fs.writeFile(path.join(inputDir, `filament-${index}.json`), buffer),
          );
        }
      });
    } else if (profiles.filament && profiles.filament.length > 0) {
      writes.push(fs.writeFile(filamentPath, profiles.filament));
    }

    await Promise.all(writes);
  } catch (error) {
    throw new AppError(
      500,
      "Failed to write temporary profiles",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Inietta filament_map / filament_map_mode in una copia scrivibile del profilo
 * di processo. In modalità CLI queste chiavi non vengono inizializzate da
 * OrcaSlicer (le imposta normalmente la GUI), quindi le aggiungiamo al JSON
 * caricato con --load-settings. I valori vettoriali sono salvati come array di
 * stringhe, coerentemente con il formato dei profili OrcaSlicer.
 * @returns Il percorso del profilo di processo da caricare.
 */
async function injectFilamentMap(
  sourcePath: string,
  inputDir: string,
  filamentMap?: number[],
  filamentMapMode?: string,
): Promise<string> {
  const content = await fs.readFile(sourcePath, "utf-8");
  const json = JSON.parse(content) as Record<string, unknown>;

  if (filamentMap && filamentMap.length > 0) {
    json.filament_map = filamentMap.map((value) => value.toString());
  }
  if (filamentMapMode) {
    json.filament_map_mode = filamentMapMode;
  }

  const outPath = path.join(inputDir, "process-merged.json");
  await fs.writeFile(outPath, JSON.stringify(json));
  return outPath;
}

/**
 * Normalizza un valore proveniente da multipart/form-data in un array di
 * stringhe. Accetta array, JSON (es. ["A","B"]) o liste separate da virgola.
 */
function parseStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const arr = value.map((v) => String(v).trim()).filter(Boolean);
    return arr.length > 0 ? arr : undefined;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          const arr = parsed.map((v) => String(v).trim()).filter(Boolean);
          return arr.length > 0 ? arr : undefined;
        }
      } catch {
        // Non è JSON valido: ricade sul parsing per virgole.
      }
    }

    const arr = trimmed
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    return arr.length > 0 ? arr : undefined;
  }

  return undefined;
}

/**
 * Come parseStringArray, ma converte i valori in numeri scartando quelli non
 * numerici.
 */
function parseNumberArray(value: unknown): number[] | undefined {
  const arr = parseStringArray(value);
  if (!arr) {
    return undefined;
  }

  const numbers = arr.map(Number).filter((n) => !Number.isNaN(n));
  return numbers.length > 0 ? numbers : undefined;
}
