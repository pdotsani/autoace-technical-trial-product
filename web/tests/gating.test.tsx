import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { analyzeBlockers } from "../src/staging/report";
import { CSV_TEXT, file, renderApp, testApi } from "./helpers";

const report = { blocking: [], matched: ["a.wav"], skipped: [], warnings: [], labeled: false, summary: "", analyzable: true, csvName: "x.csv" };
const base = { stagedCount: 2, csvCount: 1, csvReady: true, report, previous: null, confirmedDelete: false };

describe("analyzeBlockers", () => {
  it("allows a batch with one CSV and a matched audio file", () => {
    expect(analyzeBlockers(base)).toEqual([]);
  });

  it("explains what is missing", () => {
    expect(analyzeBlockers({ ...base, stagedCount: 0 })).toEqual(["Add a CSV file and the audio files it lists."]);
    expect(analyzeBlockers({ ...base, csvCount: 0 })).toEqual(["Add one CSV file listing the audio files."]);
    expect(analyzeBlockers({ ...base, csvCount: 2 })[0]).toMatch(/exactly one/);
    expect(analyzeBlockers({ ...base, report: { ...report, matched: [] } })[0]).toMatch(/No audio file matches/);
    expect(analyzeBlockers({ ...base, report: { ...report, blocking: ["duplicate"] } })[0]).toMatch(/blocking errors/);
  });

  it("needs confirmation to replace a previous batch, and refuses while it is processing", () => {
    const done = { runId: "r", createdAt: "", validated: true as const, labeled: false, submitted: true, complete: true, counts: { total: 1, done: 1, failed: 0, skipped: 0, processing: 0 } };
    expect(analyzeBlockers({ ...base, previous: done })).toEqual(["Confirm that your previous results will be deleted."]);
    expect(analyzeBlockers({ ...base, previous: done, confirmedDelete: true })).toEqual([]);
    expect(analyzeBlockers({ ...base, previous: { ...done, complete: false } })[0]).toMatch(/still processing/);
  });
});

describe("New batch page", () => {
  it("enables Analyze only once there is one valid CSV and a matched audio file", async () => {
    const user = userEvent.setup();
    const { api } = testApi();
    renderApp(api, "/new");

    const analyze = await screen.findByRole("button", { name: "Analyze" });
    expect(analyze).toBeDisabled();
    expect(screen.getByText("Add a CSV file and the audio files it lists.")).toBeInTheDocument();

    await user.upload(screen.getByLabelText("Choose files"), [file("labels.csv", CSV_TEXT)]);
    expect(await screen.findByText("0 matched · 3 missing audio")).toBeInTheDocument();
    expect(analyze).toBeDisabled();
    expect(analyze).toHaveAccessibleDescription(/No audio file matches/);

    await user.upload(screen.getByLabelText("Choose folder"), [file("call_001.ogg"), file("call_002.ogg"), file("notes.txt")]);
    expect(await screen.findByText("2 matched · 1 missing audio · 1 ignored")).toBeInTheDocument();
    expect(analyze).toBeEnabled();

    await user.upload(screen.getByLabelText("Choose files"), [file("other.csv", "name\n")]);
    await waitFor(() => expect(analyze).toBeDisabled());
    expect(screen.getByText(/2 CSV files/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove other.csv" }));
    await waitFor(() => expect(analyze).toBeEnabled());
  });

  it("uploads, validates, analyzes and opens the run page", async () => {
    const user = userEvent.setup();
    const { api } = testApi();
    renderApp(api, "/new");

    await user.upload(await screen.findByLabelText("Choose files"), [
      file("labels.csv", CSV_TEXT),
      file("call_001.ogg"),
      file("call_002.ogg"),
      file("call_003.ogg"),
    ]);
    await user.click(await screen.findByRole("button", { name: "Analyze" }));

    expect(await screen.findByRole("heading", { name: "Batch results" })).toBeInTheDocument();
    expect(screen.getByText("0 of 3 finished")).toBeInTheDocument();
    expect(screen.getAllByText("processing")).toHaveLength(3);
  });

  it("shows the CSV's labels in an Expected table on the run page", async () => {
    const label = {
      emotional_tone: "upset",
      emotional_intensity: "high",
      background_noise_present: false,
      background_noise_type: "",
      background_noise_severity: "none",
      audio_quality: "clear",
      speaker_overlap_present: false,
      long_silence_present: false,
    };
    const csv = `name,result_json\ncall_001.ogg,"${JSON.stringify(label).replace(/"/g, '""')}"\ncall_002.ogg,\n`;
    const { api } = testApi();
    const created = await api.createRun({ files: [{ name: "labels.csv", size: csv.length }, { name: "call_001.ogg", size: 10 }, { name: "call_002.ogg", size: 10 }] });
    for (const t of created.uploads) await api.upload(t, t.name.endsWith(".csv") ? file(t.name, csv) : file(t.name));
    await api.validateRun(created.runId);
    await api.analyzeRun(created.runId);

    renderApp(api, `/runs/${created.runId}`);
    const expected = await screen.findByRole("region", { name: "Expected results" });
    const rows = within(expected).getAllByRole("row");
    expect(within(rows[1]!).getByRole("rowheader")).toHaveTextContent("call_001.ogg");
    expect(within(rows[1]!).getByText("Upset")).toBeInTheDocument();
    expect(within(rows[2]!).getByRole("rowheader")).toHaveTextContent("call_002.ogg (no label)");
  });

  it("highlights results that match or differ from the label, and shades confidence", async () => {
    // The mock's result for call_001 matches this label except speaker overlap (Yes, labeled No)
    const label = {
      emotional_tone: "upset",
      emotional_intensity: "high",
      background_noise_present: false,
      background_noise_type: "",
      background_noise_severity: "none",
      audio_quality: "clear",
      speaker_overlap_present: false,
      long_silence_present: false,
    };
    const csv = `name,result_json\ncall_001.ogg,"${JSON.stringify(label).replace(/"/g, '""')}"\ncall_002.ogg,\n`;
    const { api, clock } = testApi();
    const created = await api.createRun({ files: [{ name: "labels.csv", size: csv.length }, { name: "call_001.ogg", size: 10 }, { name: "call_002.ogg", size: 10 }] });
    for (const t of created.uploads) await api.upload(t, t.name.endsWith(".csv") ? file(t.name, csv) : file(t.name));
    await api.validateRun(created.runId);
    await api.analyzeRun(created.runId);
    clock.advance(30_000); // past every file's finish time

    renderApp(api, `/runs/${created.runId}`);
    const results = await screen.findByRole("region", { name: "Files and results" });
    const [, labeled, unlabeled, totals] = within(results).getAllByRole("row");
    const cells = within(labeled!).getAllByRole("cell"); // Status, Reason, Matches, then the result columns
    expect(cells[2]).toHaveTextContent("7/8");
    expect(cells[3]).toHaveClass("cell-match"); // Tone: Upset
    expect(cells[9]).toHaveClass("cell-mismatch"); // Speaker overlap
    expect(cells[9]).toHaveTextContent("Yesexpected No");
    expect(cells[11]).toHaveClass("cell-confidence");
    expect(cells[11]).toHaveTextContent("90%");
    expect(cells[11]!.style.getPropertyValue("--confidence")).toBe("0.898");

    // call_002 fails in the mock (last file) and has no label: nothing to compare
    expect(within(unlabeled!).getAllByRole("cell")[2]).toHaveTextContent("");
    expect(within(totals!).getByRole("rowheader")).toHaveTextContent("Matched (1 labeled file)");
    expect(within(totals!).getAllByRole("cell")[0]).toHaveTextContent("7/8");
    expect(screen.getByText("Matches the expected label")).toBeInTheDocument();
  });

  it("asks before replacing a previous batch", async () => {
    const user = userEvent.setup();
    const { api, clock } = testApi();
    const created = await api.createRun({ files: [{ name: "labels.csv", size: 10 }, { name: "call_001.ogg", size: 10 }] });
    for (const t of created.uploads) await api.upload(t, t.name.endsWith(".csv") ? file(t.name, "name\ncall_001.ogg\n") : file(t.name));
    await api.validateRun(created.runId);
    await api.analyzeRun(created.runId);
    clock.advance(30_000);

    renderApp(api, "/new");
    expect(await screen.findByText(/permanently deletes your previous results/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeEnabled();
    await user.upload(screen.getByLabelText("Choose files"), [file("labels.csv", "name\ncall_002.ogg\n"), file("call_002.ogg")]);
    const analyze = await screen.findByRole("button", { name: "Analyze" });
    expect(analyze).toBeDisabled();
    await user.click(screen.getByLabelText(/will be deleted/));
    expect(analyze).toBeEnabled();
  });
});
