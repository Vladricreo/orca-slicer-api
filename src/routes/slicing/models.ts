export interface SlicingSettings {
  printer?: string;
  preset?: string;
  filament?: string;
  // Lista di nomi di profili filamento già caricati, uno per estrusore/nozzle
  // (slicing multi-estrusore, es. Bambu H2D). Ha precedenza su "filament".
  filaments?: string[];
  // Mappa filamento -> nozzle (1 = primario, 2 = secondario). Un valore per
  // filamento. Corrisponde alla chiave "filament_map" di OrcaSlicer.
  filamentMap?: number[];
  // Modalità di raggruppamento filamento (es. "Manual" per la modalità
  // Personalizza, "Auto For Flush", "Auto For Quality"). Chiave
  // "filament_map_mode" di OrcaSlicer.
  filamentMapMode?: string;
  // ID filamento passati a OrcaSlicer tramite --load-filament-ids.
  filamentIds?: number[];
  bedType?: string;
  plate?: string;
  multicolorOnePlate?: boolean;
  arrange?: boolean;
  orient?: boolean;
  exportType?: "gcode" | "3mf";
}

export interface SliceResult {
  gcodes: string[];
  workdir: string;
}

export interface SliceMetaData {
  printTime: number; //print time in seconds
  filamentUsedG: number; // filament used in grams
  filamentUsedMm: number; // total length of filament used in millimeters
}

export type Category = "printers" | "presets" | "filaments";

export interface UploadedProfiles {
  printer?: Buffer;
  preset?: Buffer;
  filament?: Buffer;
  // Più profili filamento caricati al volo (uno per estrusore/nozzle).
  // Ha precedenza su "filament" quando presente.
  filaments?: Buffer[];
}
