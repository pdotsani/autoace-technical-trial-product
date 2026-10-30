import type JSZip from "jszip";

/** A file waiting to be uploaded; `name` is what the API sees (no folders). */
export interface StagedFile {
  name: string;
  file: File;
}

interface Entry {
  path: string; // "/"-separated, relative to what the user picked
  file: File;
}

/** Hidden files, hidden folders and macOS zip metadata are never part of a batch. */
export function isHiddenPath(path: string): boolean {
  return path.split("/").some((part) => part.startsWith(".") || part === "__MACOSX");
}

/**
 * Turn picked paths into staged files: drop hidden entries, then strip one top-level folder
 * when everything is inside the same one ("batch/a.wav" -> "a.wav"). Deeper folders are kept
 * in the name ("sub/a.wav"), which validation reports as an invalid name.
 */
export function normalizeEntries(entries: Entry[]): StagedFile[] {
  const visible = entries
    .map((e) => ({ ...e, path: e.path.replace(/\\/g, "/").replace(/^\/+/, "") }))
    .filter((e) => e.path !== "" && !isHiddenPath(e.path));
  const firstParts = new Set(visible.map((e) => e.path.split("/")[0]));
  const nested = visible.every((e) => e.path.includes("/"));
  const strip = visible.length > 0 && nested && firstParts.size === 1;
  return visible.map((e) => ({ name: strip ? e.path.slice(e.path.indexOf("/") + 1) : e.path, file: e.file }));
}

export function isZip(file: File): boolean {
  return file.name.toLowerCase().endsWith(".zip");
}

/** Unpack a ZIP in the browser. */
export async function filesFromZip(zipFile: Blob): Promise<StagedFile[]> {
  const { default: JSZipLib } = await import("jszip"); // loaded only when a ZIP is picked
  let zip: JSZip;
  try {
    zip = await JSZipLib.loadAsync(await zipFile.arrayBuffer());
  } catch {
    throw new Error("This ZIP file could not be opened.");
  }
  const entries: Entry[] = [];
  const pending: Promise<void>[] = [];
  zip.forEach((path, entry) => {
    if (entry.dir || isHiddenPath(path)) return;
    pending.push(
      entry.async("uint8array").then((bytes) => {
        const base = path.split("/").pop() ?? path;
        entries.push({ path, file: new File([bytes as Uint8Array<ArrayBuffer>], base, { lastModified: entry.date.getTime() }) });
      }),
    );
  });
  await Promise.all(pending);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return normalizeEntries(entries);
}

/** Files from <input type="file"> (plain or webkitdirectory); a picked .zip is unpacked. */
export async function filesFromInput(files: Iterable<File>): Promise<StagedFile[]> {
  const list = [...files];
  const zips = list.filter(isZip);
  const plain = normalizeEntries(list.filter((f) => !isZip(f)).map((file) => ({ path: file.webkitRelativePath || file.name, file })));
  const unpacked = await Promise.all(zips.map(filesFromZip));
  return [...plain, ...unpacked.flat()];
}

/** Files and folders dropped on the page; dropped .zip files are unpacked. */
export async function filesFromDrop(dataTransfer: DataTransfer): Promise<StagedFile[]> {
  // Entries must be taken synchronously: DataTransfer items are cleared after the event
  const roots = [...dataTransfer.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.() ?? null);
  if (roots.length === 0 || roots.some((r) => r === null)) return filesFromInput(dataTransfer.files);

  const entries: Entry[] = [];
  await Promise.all(roots.map((root) => walk(root!, "", entries)));
  const zips = entries.filter((e) => isZip(e.file));
  const unpacked = await Promise.all(zips.map((z) => filesFromZip(z.file)));
  return [...normalizeEntries(entries.filter((e) => !isZip(e.file))), ...unpacked.flat()];
}

async function walk(entry: FileSystemEntry, prefix: string, out: Entry[]): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (isHiddenPath(path)) return;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ path, file });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns at most ~100 entries per call: keep reading until it returns none
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (batch.length === 0) break;
      await Promise.all(batch.map((child) => walk(child, path, out)));
    }
  }
}

/** Add files to the staging area; a file with the same name replaces the earlier one. */
export function mergeStaged(existing: StagedFile[], added: StagedFile[]): StagedFile[] {
  const byName = new Map(existing.map((f) => [f.name, f]));
  for (const f of added) byName.set(f.name, f);
  return [...byName.values()];
}
