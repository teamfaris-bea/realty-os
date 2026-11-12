// D5a: the photos and videos of a text, under the compose box (phone first: one 44 px button that opens the camera
// and library on iOS, the file picker on a desktop).
//
// Shown for Text only, and not while Text is blocked (the box's ReasonCaption says why) or an assistant draft is open
// (`canAttach`). Items already attached stay visible with Remove when that changes, and when the agent chooses Email
// or Web chat the tray says "Photos and videos go only by text." and Send waits (mediaHold).
//
// Every tile is in a real state: Preparing, Uploading, Ready, or why it failed. One polite live region announces
// each tile's change once ("Photo 2 ready"); refusals before upload are an alert, mounted only with its words.
//
// Phone first (b8 texting ui/F10): before anything is picked the only thing drawn is the camera button in the text
// field's row (MediaAddButton), so the sticky compose bar is no taller on a text thread; the tray, with the limits and
// location lines, appears once a file is picked.
import { type RefObject, useRef } from 'react';
import { Button, Spinner } from '../../design/index.js';
import { formatSize } from './prepareMedia.js';
import { type ComposeMedia, type TrayItem, itemLabel } from './useComposeMedia.js';

export const ACCEPT = 'image/*,video/mp4,video/quicktime';
export const LIMITS_LINE = 'Up to 10 photos or videos, 5 MB in all; videos up to 500 KB.';
export const LOCATION_LINE = "Location is removed from photos and videos before they're sent.";

const STATE_WORDS: Record<TrayItem['state'], string> = { preparing: 'Preparing', uploading: 'Uploading', ready: 'Ready', failed: "Couldn't be uploaded" };

function CameraIcon() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13.5" r="3.5" />
    </svg>
  );
}

function VideoIcon() {
  return (
    <svg width={28} height={28} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round">
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="M16 10.5 21 7.5v9l-5-3z" />
    </svg>
  );
}

export interface MediaAddButtonProps {
  media: ComposeMedia;
  /** the Photo or video button is offered (Text chosen, not blocked, no draft open) */
  canAttach: boolean;
  buttonRef: RefObject<HTMLButtonElement>;
  /** the id of the limits and location lines (screen readers hear them with the button before anything is picked) */
  describedById: string;
}

/**
 * The Photo or video button, a 44 px camera icon beside the text field. It sits in the field's own row, so the phone's
 * sticky compose bar does not grow on a text thread before a photo is attached (b8 texting ui/F10). Its screen-reader
 * description and the tray's polite live region are visually hidden and take no room in the row.
 */
export function MediaAddButton({ media, canAttach, buttonRef, describedById }: MediaAddButtonProps) {
  const input = useRef<HTMLInputElement>(null);
  if (!canAttach && media.count === 0) return null;
  return (
    <>
      {canAttach ? (
        <>
          <Button ref={buttonRef} variant="secondary" className="shrink-0 px-0" aria-label="Photo or video" aria-describedby={describedById} onClick={() => input.current?.click()}>
            <CameraIcon />
          </Button>
          <input
            ref={input}
            data-testid="media-input"
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            tabIndex={-1}
            onChange={(e) => {
              const files = e.currentTarget.files;
              if (files && files.length > 0) media.add([...files]);
              // the same file can be picked again after it was removed
              e.currentTarget.value = '';
            }}
          />
          {media.count === 0 ? (
            <span id={describedById} className="sr-only">
              {LIMITS_LINE} {LOCATION_LINE}
            </span>
          ) : null}
        </>
      ) : null}
      <p data-testid="media-live" aria-live="polite" className="sr-only">
        {media.announcement}
      </p>
    </>
  );
}

export interface MediaTrayProps {
  media: ComposeMedia;
  /** why Send waits because of the media (mediaHold), said under the tray with this id */
  hold: string | null;
  holdId: string;
  /** the Photo or video button (focus goes back to it after Remove) */
  addButtonRef: RefObject<HTMLButtonElement>;
  /** the id the button's description points at, once the lines are shown here */
  describedById: string;
}

/**
 * What was picked: refusals, tiles, why Send waits, and the limits and location lines. Nothing is drawn (no empty
 * container, no empty alert: b8 texting ui/F3) until a file is picked.
 */
export function MediaTray({ media, hold, holdId, addButtonRef, describedById }: MediaTrayProps) {
  if (media.count === 0 && media.refusals.length === 0 && !hold) return null;
  const remove = (key: string) => {
    media.remove(key);
    // focus stays with the photos: on the button that adds another one (or the box's next control when it is not offered)
    requestAnimationFrame(() => addButton.current?.focus());
  };
  const addButton = addButtonRef;
  return (
    <div data-testid="media-tray" className="flex flex-col gap-2">
      {media.refusals.length > 0 ? (
        // an alert is announced when it is inserted with its words (WCAG 4.1.3), so it is mounted only with a refusal
        <div role="alert" className="flex flex-col gap-1">
          {media.refusals.map((r) => (
            <p key={r} className="text-[14px] font-medium leading-snug text-danger">
              {r}
            </p>
          ))}
        </div>
      ) : null}
      {media.count > 0 ? (
        <ul aria-label="Photos and videos in this text" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {media.items.map((it, i) => (
            <Tile key={it.key} item={it} position={i + 1} onRemove={() => remove(it.key)} />
          ))}
        </ul>
      ) : null}
      {hold ? (
        <p id={holdId} data-reason="media" className="text-[13px] font-medium leading-snug text-ink">
          {hold}
        </p>
      ) : null}
      <div id={media.count > 0 ? describedById : undefined} className="flex flex-col text-[13px] leading-snug text-ink-muted">
        <p>{LIMITS_LINE}</p>
        <p>{LOCATION_LINE}</p>
      </div>
    </div>
  );
}

function Tile({ item, position, onRemove }: { item: TrayItem; position: number; onRemove: () => void }) {
  const label = itemLabel(item.kind, position);
  const failed = item.state === 'failed';
  return (
    <li data-state={item.state} className={`flex w-44 shrink-0 flex-col gap-1 rounded-xl border bg-surface p-1.5 ${failed ? 'border-dashed border-danger' : 'border-line'}`}>
      <div className="flex items-center gap-2">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-2 text-ink-muted">
          {item.kind === 'photo' && item.url ? <img src={item.url} alt="" className="h-full w-full object-cover" /> : item.kind === 'video' ? <VideoIcon /> : <Spinner size={22} />}
        </div>
        <div className="flex min-w-0 flex-col text-[13px] leading-snug">
          <p className="font-medium text-ink">{label}</p>
          {item.byteSize !== null ? <p className="text-ink-muted">{formatSize(item.byteSize)}</p> : null}
          {failed ? null : <p className="text-ink-muted">{STATE_WORDS[item.state]}</p>}
        </div>
      </div>
      {failed ? <p className="text-[13px] font-medium leading-snug text-danger">{item.error}</p> : null}
      <Button variant="quiet" className="px-2 text-[15px]" aria-label={`Remove ${label.toLowerCase()}`} onClick={onRemove}>
        Remove
      </Button>
    </li>
  );
}
