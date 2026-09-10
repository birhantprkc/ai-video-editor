import { ArrowCounterClockwise, CheckCircle, CircleNotch, Robot, X } from "@phosphor-icons/react";
import { createTranslator } from "../i18n.js";
import "./WebMcpReview.css";

export function WebMcpReview({ agent, language }) {
  const { t, view, working, error, stale } = agent;
  if (!view) return null;
  const applied = view.status === "applied";
  const preview = view.preview;
  const ui = createTranslator(language);
  const time = (seconds) => new Intl.NumberFormat(language, { style: "unit", unit: "second", unitDisplay: "narrow", maximumFractionDigits: 2 }).format(seconds);
  const changedRows = preview.rows.filter((row) => row.changed);
  const trackLabels = { overlays: "overlayTrack", audio: "voiceTrack", captions: "caption", stickers: "stickerTrack", music: "musicTrack" };
  const linkedChanges = Object.entries(preview.diff.tracks).filter(([track]) => track !== "visuals");
  const startChanges = preview.diff.projectFields.filter(({ field }) => field === "musicStart" || field === "sourceAudioStart");
  return (
    <aside className="webmcp-review" aria-label={t("panelTitle")}>
      <header>
        <Robot size={19} weight="duotone" aria-hidden="true" />
        <strong>{t("panelTitle")}</strong>
        <button type="button" className="webmcp-review-close" aria-label={t("close")} onClick={agent.dismiss} disabled={working}><X size={17} /></button>
      </header>
      <div className="webmcp-review-body">
        <p className={applied ? "webmcp-review-success" : "webmcp-review-status"} role="status">
          {applied ? <CheckCircle size={16} aria-hidden="true" /> : null}{t(applied ? "applied" : "pending")}
        </p>
        {view.summary ? <p className="webmcp-review-summary">{view.summary}</p> : null}
        <p className="webmcp-review-duration">{t("duration", { before: time(preview.beforeDuration), after: time(preview.afterDuration) })}</p>
        <ol className="webmcp-review-clips" aria-label={t("changes", { count: changedRows.length })}>
          {changedRows.map((row) => (
            <li key={row.id}>
              <span className="webmcp-review-name">{row.name || row.id}</span>
              <span className="webmcp-review-detail">
                {row.reordered ? <span>{t("order")}: {row.beforeIndex + 1} → {row.index + 1}</span> : null}
                {row.trimmed ? <span>{t("trim")}: {time(row.beforeSourceStart)}–{time(row.beforeSourceStart + row.beforeDuration)} → {time(row.sourceStart)}–{time(row.sourceStart + row.duration)}</span> : null}
              </span>
            </li>
          ))}
        </ol>
        {linkedChanges.length || startChanges.length ? (
          <ul className="webmcp-review-linked">
            {linkedChanges.map(([track, changes]) => (
              <li key={track}><span>{ui(trackLabels[track])}</span><span>{t("changes", { count: new Set([...changes.added, ...changes.removed, ...changes.modified.map(({ id }) => id)]).size })}</span></li>
            ))}
            {startChanges.map(({ field, before, after }) => (
              <li key={field}><span>{ui(field === "musicStart" ? "musicTrack" : "sourceTrack")}</span><span>{time(before || 0)} → {time(after || 0)}</span></li>
            ))}
          </ul>
        ) : null}
        {!preview.hasChanges ? <p className="webmcp-review-status">{t("noChanges")}</p> : null}
        {error || stale ? <p className="webmcp-review-error" role="alert">{error || t("stale")}</p> : null}
      </div>
      <footer>
        <button type="button" className="panel-secondary" onClick={agent.dismiss} disabled={working}>{t(applied ? "close" : "dismiss")}</button>
        {applied ? (
          <button type="button" className="panel-secondary" onClick={agent.undo} disabled={working || !agent.canUndo}><ArrowCounterClockwise size={15} />{t("undo")}</button>
        ) : (
          <button type="button" className="panel-primary" onClick={agent.apply} disabled={working || stale || !preview.hasChanges}>
            {working ? <CircleNotch size={15} className="webmcp-review-spinner" /> : null}{t("apply")}
          </button>
        )}
      </footer>
    </aside>
  );
}
