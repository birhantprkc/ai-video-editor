import { inspectClip, inspectProject, inspectTrack, inspectTranscript } from "./projectCommandEngine.js";
import { browserProjectFingerprint, buildBrowserTimelineReview, getBrowserPlanningClips } from "./browserEditPlan.js";

const TRACKS = ["visuals", "overlays", "audio", "captions", "stickers", "music"];
const MAX_PAGE = 100;
const MAX_CLIPS = 500;
const ERROR_KEYS = {
  INVALID_ARGUMENT: "invalidInput", CLIP_NOT_FOUND: "notFound", TRACK_NOT_FOUND: "notFound",
  BROWSER_EDIT_INVALID_PLAN: "invalidPlan", BROWSER_EDIT_COMPLEX_TIMING: "complexTiming",
  BROWSER_EDIT_TRACK_LOCKED: "trackLocked", BROWSER_EDIT_STALE_PLAN: "stale",
  STALE_STATE: "stale", EDITOR_BUSY: "busy", PREVIEW_NOT_FOUND: "missingPreview",
  UNDO_NOT_AVAILABLE: "missingUndo", NO_CHANGES: "noChanges", CANCELLED: "cancelled",
  EMPTY_PROJECT: "emptyProject", SESSION_CLOSED: "unavailable",
};
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const object = (value, keys) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) fail("INVALID_ARGUMENT");
};
const text = (value, maximum = 256) => {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) fail("INVALID_ARGUMENT");
  return value;
};
const finite = (value, maximum = Infinity) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) fail("INVALID_ARGUMENT");
  return value;
};
function page(items, input) {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 50;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) fail("INVALID_ARGUMENT");
  return { items: items.slice(offset, offset + limit), total: items.length, nextOffset: offset + limit < items.length ? offset + limit : null };
}

// Expose metadata deliberately, never media bytes, blob URLs, model state, or credentials.
function properties(clip) {
  const fields = ["type", "name", "start", "end", "duration", "text", "volume", "muted", "playbackRate", "sourceKind", "layer", "hidden"];
  return {
    ...Object.fromEntries(fields.filter((key) => ["string", "boolean", "number"].includes(typeof clip[key])).map((key) => [key, clip[key]])),
    speedCurveEnabled: Boolean(clip.speedCurve?.enabled),
    reversed: Boolean(clip.reversed || clip.reverse),
    hasKeyframes: Boolean(clip.keyframes?.length || Object.values(clip.propertyKeyframes || {}).some((frames) => frames?.length)),
  };
}

/** A page-scoped session. Callers provide the actual live editor actions, not reducers. */
export function createWebMcpEditorSession(getEditor, { publish = () => {}, commit = (action) => action(), makeId = () => crypto.randomUUID() } = {}) {
  let closed = false;
  let busy = false;
  let pointerActive = false;
  let observed = null;
  let pending = null;
  let undoReceipt = null;
  let lastApplied = null;
  const mediaIds = new WeakMap();
  let mediaSequence = 0;
  const identity = (value) => {
    if (!value || typeof value !== "object") return value ?? null;
    if (!mediaIds.has(value)) mediaIds.set(value, ++mediaSequence);
    return mediaIds.get(value);
  };
  const fingerprint = (editor, project) => JSON.stringify({
    project: browserProjectFingerprint(project, editor.rippleEditing, editor.visualSegments),
    historyVersion: editor.historyVersion,
    media: [...(editor.audioSegments || []), ...(editor.visualOverlaySegments || [])].map((clip) => [clip.id, identity(clip.blob), clip.url || clip.src]),
    sourceAudio: identity(editor.sourceAudioBlob), music: identity(editor.musicBlob), audio: identity(editor.audioBlob),
  });
  const capture = () => {
    if (closed) fail("SESSION_CLOSED");
    const editor = getEditor();
    const project = editor.getProjectSnapshot();
    const signature = fingerprint(editor, project);
    if (!observed || observed.fingerprint !== signature) observed = { stateToken: makeId(), fingerprint: signature };
    return { editor, project, ...observed };
  };
  const guard = (signal, editing = false) => {
    if (closed) fail("SESSION_CLOSED");
    if (signal?.aborted) fail("CANCELLED");
    if (editing && (pointerActive || getEditor().isBusy?.())) fail("EDITOR_BUSY");
  };
  const requireState = (state, token) => {
    if (text(token) !== state.stateToken) fail("STALE_STATE");
  };
  const planningClips = (editor) => getBrowserPlanningClips(editor.visualSegments);
  const readProject = (state) => {
    const { duration: _duration, warnings: _warnings, appliedOperationIds: _ids, revision: _revision, ...summary } = inspectProject(state.project);
    return {
      ...summary, stateToken: state.stateToken, duration: state.editor.duration,
      playhead: state.editor.currentTime, rippleEditing: Boolean(state.editor.rippleEditing),
      trackLocks: state.project.trackLocks, trackVisibility: state.project.trackVisibility,
      sourceAudio: { present: Boolean(state.editor.sourceAudioBlob), linked: state.project.sourceAudioLinked, start: state.project.sourceAudioStart, duration: state.project.sourceAudioDuration },
      capabilities: { edit: ["visual.reorder", "visual.trim"], maxPlanClips: MAX_CLIPS, requiresPreview: true, projectSave: "download-timeline-archive", videoExport: false },
    };
  };
  const previewSummary = (draft) => ({
    previewId: draft.id, stateToken: draft.stateToken, hasChanges: draft.review.hasChanges,
    beforeDuration: draft.review.beforeDuration, afterDuration: draft.review.duration,
    rows: draft.review.rows, diff: draft.review.diff,
  });
  const run = async (name, input = {}, { signal } = {}) => {
    const editor = getEditor();
    if (busy) return { ok: false, error: { code: "EDITOR_BUSY", message: editor.t("busy") } };
    busy = true;
    try {
      guard(signal);
      const state = capture();
      let result;
      switch (name) {
        case "timeline_project_inspect":
          object(input, []);
          result = readProject(state);
          break;
        case "timeline_track_inspect": {
          object(input, ["track", "offset", "limit"]);
          if (!TRACKS.includes(input.track)) fail("INVALID_ARGUMENT");
          const track = inspectTrack(state.project, input.track);
          const planning = input.track === "visuals" ? planningClips(state.editor) : [];
          const entries = track.clips.map((clip, index) => ({ ...clip, ...(planning[index] || {}) }));
          const { clips: _clips, revision: _revision, ...metadata } = track;
          result = { ...metadata, stateToken: state.stateToken, ...page(entries, input) };
          break;
        }
        case "timeline_clip_inspect": {
          object(input, ["clipId"]);
          const clip = inspectClip(state.project, text(input.clipId));
          const { revision: _revision, properties: raw, ...metadata } = clip;
          const planning = clip.track === "visuals" ? planningClips(state.editor).find((item) => (item.clipId || item.id) === input.clipId) : null;
          result = { ...metadata, stateToken: state.stateToken, properties: properties(raw), ...(planning ? { editing: planning } : {}) };
          break;
        }
        case "timeline_transcript_inspect": {
          object(input, ["audioClipId", "offset", "limit"]);
          const transcript = inspectTranscript(state.project, input.audioClipId === undefined ? "" : text(input.audioClipId));
          const { revision: _revision, segments: _segments, text: _text, ...metadata } = transcript;
          result = { ...metadata, stateToken: state.stateToken, ...page(transcript.segments, input) };
          break;
        }
        case "timeline_edit_preview": {
          object(input, ["stateToken", "clips", "summary"]);
          guard(signal, true);
          requireState(state, input.stateToken);
          if (!Array.isArray(input.clips) || !input.clips.length || input.clips.length > MAX_CLIPS) fail("INVALID_ARGUMENT");
          for (const clip of input.clips) {
            object(clip, ["clipId", "sourceIn", "sourceOut"]);
            text(clip.clipId);
            if (clip.sourceIn !== undefined) finite(clip.sourceIn);
            if (clip.sourceOut !== undefined) finite(clip.sourceOut);
            if ((clip.sourceIn === undefined) !== (clip.sourceOut === undefined)) fail("INVALID_ARGUMENT");
          }
          if (input.summary !== undefined && (typeof input.summary !== "string" || input.summary.length > 2000)) fail("INVALID_ARGUMENT");
          const review = buildBrowserTimelineReview(state.project, input, {
            visualSegments: state.editor.visualSegments, rippleEditing: state.editor.rippleEditing,
            hasMusic: Boolean(state.editor.musicBlob), hasSourceAudio: Boolean(state.editor.sourceAudioBlob),
          });
          pending = { id: makeId(), stateToken: state.stateToken, fingerprint: state.fingerprint, review };
          publish({ status: "pending", preview: previewSummary(pending), summary: input.summary || "" });
          result = previewSummary(pending);
          break;
        }
        case "timeline_edit_apply": {
          object(input, ["previewId"]);
          text(input.previewId);
          guard(signal, true);
          // Retrying a completed call acknowledges that edit without applying it twice.
          if (lastApplied?.previewId === input.previewId) {
            result = { ...lastApplied.result, alreadyApplied: true, currentStateToken: state.stateToken };
            break;
          }
          if (!pending || input.previewId !== pending.id) fail("PREVIEW_NOT_FOUND");
          if (pending.fingerprint !== state.fingerprint) fail("STALE_STATE");
          if (!pending.review.hasChanges) fail("NO_CHANGES");
          const draft = pending;
          guard(signal, true);
          commit(() => state.editor.applyReview(draft.review, state.editor.t("applied")));
          const after = capture();
          if (after.fingerprint === state.fingerprint) fail("NO_CHANGES");
          undoReceipt = { id: makeId(), fingerprint: after.fingerprint };
          pending = null;
          result = { transactionId: undoReceipt.id, stateToken: after.stateToken, changed: true };
          lastApplied = { previewId: draft.id, result };
          publish({ status: "applied", transactionId: undoReceipt.id, preview: previewSummary(draft) });
          break;
        }
        case "timeline_edit_undo": {
          object(input, ["transactionId"]);
          text(input.transactionId);
          guard(signal, true);
          if (!undoReceipt || input.transactionId !== undoReceipt.id) fail("UNDO_NOT_AVAILABLE");
          if (undoReceipt.fingerprint !== state.fingerprint) fail("STALE_STATE");
          commit(() => state.editor.undo());
          undoReceipt = null;
          pending = null;
          result = { stateToken: capture().stateToken, undone: true };
          publish(null);
          break;
        }
        case "timeline_preview_seek": {
          object(input, ["time"]);
          guard(signal, true);
          finite(input.time, state.editor.duration);
          commit(() => state.editor.seek(input.time));
          result = { time: getEditor().currentTime, stateToken: capture().stateToken };
          break;
        }
        case "timeline_project_save": {
          object(input, ["stateToken"]);
          guard(signal, true);
          requireState(state, input.stateToken);
          if (!["visualSegments", "visualOverlaySegments", "audioSegments", "captionSegments", "stickerSegments", "musicSegments", "timelineMarkers"].some((key) => state.project[key]?.length)
            && !state.editor.audioBlob && !state.editor.musicBlob && !state.editor.sourceAudioBlob) fail("EMPTY_PROJECT");
          const archive = await state.editor.createArchive();
          guard(signal, true);
          if (capture().fingerprint !== state.fingerprint) fail("STALE_STATE");
          const filename = `Timeline-Studio-${new Date().toISOString().replace(/[:.]/g, "-")}.timeline`;
          state.editor.download(archive, filename);
          result = { stateToken: state.stateToken, filename, bytes: archive.size, downloaded: true };
          state.editor.notify(state.editor.t("saved"));
          break;
        }
        default: fail("INVALID_ARGUMENT");
      }
      return { ok: true, ...result };
    } catch (error) {
      const code = error?.name === "AbortError" ? "CANCELLED" : error?.code || "FAILED";
      const message = getEditor().t(ERROR_KEYS[code] || "failed");
      return { ok: false, error: { code, message } };
    } finally { busy = false; }
  };
  return {
    run,
    setPointerActive(value) { pointerActive = value; },
    dismiss() { pending = null; publish(null); },
    isCurrentPreview() { return Boolean(pending && pending.fingerprint === capture().fingerprint); },
    canUndo() { return Boolean(undoReceipt && undoReceipt.fingerprint === capture().fingerprint); },
    close() { closed = true; pending = null; undoReceipt = null; },
  };
}

const stringSchema = { type: "string", minLength: 1, maxLength: 256 };
const pagination = { offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: MAX_PAGE } };
const schema = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });

export function createWebMcpTools(session, t) {
  const tools = [
    ["timeline_project_inspect", "Project", schema(), true],
    ["timeline_track_inspect", "Track", schema({ track: { type: "string", enum: TRACKS }, ...pagination }, ["track"]), true],
    ["timeline_clip_inspect", "Clip", schema({ clipId: stringSchema }, ["clipId"]), true],
    ["timeline_transcript_inspect", "Transcript", schema({ audioClipId: stringSchema, ...pagination }), true],
    ["timeline_edit_preview", "Preview", schema({ stateToken: stringSchema, summary: { type: "string", maxLength: 2000 }, clips: { type: "array", minItems: 1, maxItems: MAX_CLIPS, items: schema({ clipId: stringSchema, sourceIn: { type: "number", minimum: 0, description: t("sourceInDescription") }, sourceOut: { type: "number", minimum: 0, description: t("sourceOutDescription") } }, ["clipId"]) } }, ["stateToken", "clips"]), false],
    ["timeline_edit_apply", "Apply", schema({ previewId: stringSchema }, ["previewId"]), false],
    ["timeline_preview_seek", "Seek", schema({ time: { type: "number", minimum: 0, description: t("seekTimeDescription") } }, ["time"]), false],
    ["timeline_edit_undo", "Undo", schema({ transactionId: stringSchema }, ["transactionId"]), false],
    ["timeline_project_save", "Save", schema({ stateToken: stringSchema }, ["stateToken"]), false],
  ];
  return tools.map(([name, key, inputSchema, readOnlyHint]) => ({
    name, title: t(`tool${key}Title`), description: t(`tool${key}Description`), inputSchema,
    annotations: { readOnlyHint, untrustedContentHint: true },
    execute: (input, options) => session.run(name, input, options),
  }));
}

// Registrations share a queue per real browser context so StrictMode cleanup or
// a language change cannot race an unfinished legacy registration.
const webMcpRegistrationContexts = new WeakMap();

// Progressive enhancement: use a real browser API; never simulate agent connectivity.
export function registerEditorWebMcpTools(documentObject, navigatorObject, tools) {
  const current = documentObject?.modelContext;
  const context = current?.registerTool ? current : navigatorObject?.modelContext;
  const legacy = context !== current && typeof context?.unregisterTool === "function";
  if (typeof context?.registerTool !== "function") {
    return { supported: false, ready: Promise.resolve(false), dispose() {} };
  }
  let shared = webMcpRegistrationContexts.get(context);
  if (!shared) {
    shared = { tail: Promise.resolve(), owners: new Map() };
    webMcpRegistrationContexts.set(context, shared);
  }
  const enqueue = (action) => {
    const result = shared.tail.then(action);
    shared.tail = result.then(() => {}, () => {});
    return result;
  };
  const controller = new AbortController();
  const owner = Symbol("webmcp-registration");
  const registered = new Set();
  let disposed = false;
  const cleanup = async () => {
    let complete = true;
    for (const name of [...registered]) {
      if (shared.owners.get(name) !== owner) {
        registered.delete(name);
        continue;
      }
      try {
        if (legacy) await context.unregisterTool(name);
        if (shared.owners.get(name) === owner) shared.owners.delete(name);
        registered.delete(name);
      } catch {
        // Keep ownership when removal failed: a later setup must not mistake
        // this old tool for an available name or remove another setup's tool.
        complete = false;
      }
    }
    return complete;
  };
  const dispose = () => {
    disposed = true;
    controller.abort();
    // Enqueue cleanup behind this setup, including a still-pending legacy call,
    // and ahead of the next setup. It is safe to request cleanup more than once.
    void enqueue(cleanup);
  };
  const ready = enqueue(async () => {
    try {
      for (const tool of tools) {
        if (disposed) { await cleanup(); return false; }
        if (shared.owners.has(tool.name)) throw new Error("WebMCP tool is already registered");
        await context.registerTool(tool, { signal: controller.signal });
        registered.add(tool.name);
        shared.owners.set(tool.name, owner);
        if (disposed) { await cleanup(); return false; }
      }
      return true;
    } catch {
      disposed = true;
      controller.abort();
      await cleanup();
      return false;
    }
  });
  return { supported: true, ready, dispose };
}
