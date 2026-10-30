import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { filesFromInput, filesFromZip, mergeStaged, normalizeEntries } from "../src/staging/files";
import { file } from "./helpers";

async function zipOf(entries: Record<string, string>): Promise<File> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) zip.file(path, content);
  return new File([await zip.generateAsync({ type: "uint8array" }) as BlobPart], "batch.zip");
}

describe("ZIP unpacking", () => {
  it("flattens a single top-level folder and skips __MACOSX and hidden files", async () => {
    const zip = await zipOf({
      "batch/labels.csv": "name\na.wav\n",
      "batch/a.wav": "RIFF",
      "batch/.DS_Store": "junk",
      "batch/.hidden/b.wav": "RIFF",
      "__MACOSX/batch/._a.wav": "junk",
    });
    const staged = await filesFromZip(zip);
    expect(staged.map((f) => f.name).sort()).toEqual(["a.wav", "labels.csv"]);
    expect(await staged.find((f) => f.name === "a.wav")!.file.text()).toBe("RIFF");
  });

  it("keeps names as they are when files are at the top level", async () => {
    const staged = await filesFromZip(await zipOf({ "labels.csv": "name\n", "a.wav": "RIFF" }));
    expect(staged.map((f) => f.name).sort()).toEqual(["a.wav", "labels.csv"]);
  });

  it("does not flatten when there are several top-level folders", async () => {
    const staged = await filesFromZip(await zipOf({ "one/a.wav": "RIFF", "two/b.wav": "RIFF" }));
    expect(staged.map((f) => f.name).sort()).toEqual(["one/a.wav", "two/b.wav"]);
  });

  it("keeps deeper folders in the name, so validation reports them", async () => {
    const staged = await filesFromZip(await zipOf({ "batch/labels.csv": "name\n", "batch/sub/a.wav": "RIFF" }));
    expect(staged.map((f) => f.name).sort()).toEqual(["labels.csv", "sub/a.wav"]);
  });

  it("reports a file that is not a ZIP", async () => {
    await expect(filesFromZip(file("broken.zip", "not a zip"))).rejects.toThrow("could not be opened");
  });

  it("unpacks a ZIP picked with the file inputs", async () => {
    const staged = await filesFromInput([await zipOf({ "batch/a.wav": "RIFF" }), file("labels.csv")]);
    expect(staged.map((f) => f.name).sort()).toEqual(["a.wav", "labels.csv"]);
  });
});

describe("folder picking", () => {
  it("strips the picked folder from webkitRelativePath", () => {
    const entries = ["calls/a.wav", "calls/labels.csv", "calls/.DS_Store"].map((path) => ({ path, file: file(path.split("/").pop()!) }));
    expect(normalizeEntries(entries).map((f) => f.name)).toEqual(["a.wav", "labels.csv"]);
  });

  it("replaces a staged file with a newer one of the same name", () => {
    const first = { name: "a.wav", file: file("a.wav", "old") };
    const second = { name: "a.wav", file: file("a.wav", "new!") };
    const merged = mergeStaged([first, { name: "b.wav", file: file("b.wav") }], [second]);
    expect(merged.map((f) => [f.name, f.file.size])).toEqual([
      ["a.wav", 4],
      ["b.wav", 100],
    ]);
  });
});
